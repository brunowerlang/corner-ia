"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Busboy = require("busboy");
const path = require("path");

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { analyzeGarmentWithGemini } = require("./garment_analyzer");
const { buildVirtualTryOnPrompt, buildModelGenerationPrompt } = require("./prompt_builder");

const db = admin.firestore();
const bucket = admin.storage().bucket();

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const FUNCTION_URL = "https://shopifyproxy-zmkvlf752a-uc.a.run.app";

/* =========================================
   VERIFY SHOPIFY APP PROXY (HMAC/SIGNATURE)
========================================= */
function verifyShopifyProxy(req) {
  const signature = req.query.signature || req.query.hmac;
  if (!signature || !process.env.SHOPIFY_SECRET) return false;

  const rawUrl = req.originalUrl || req.url || "";
  const queryIndex = rawUrl.indexOf("?");
  const rawQuery = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : "";

  const pairs = rawQuery
    .split("&")
    .filter((p) => p && !p.startsWith("signature=") && !p.startsWith("hmac="))
    .map((p) => {
      const [key, value = ""] = p.split("=");
      return { key, value };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const message = pairs
    .map((p) => `${p.key}=${decodeURIComponent(p.value)}`)
    .join("");

  const generated = crypto
    .createHmac("sha256", process.env.SHOPIFY_SECRET)
    .update(message)
    .digest("hex");

  try {
    const a = Buffer.from(generated, "utf8");
    const b = Buffer.from(String(signature), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* =========================================
   HELPERS
========================================= */
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function uploadGarmentAndGetUrl({ customerId, file }) {
  if (!file || !file.buffer) throw new Error("Arquivo invalido.");

  const ext = (() => {
    const orig = file.originalname || "";
    const e = path.extname(orig).toLowerCase();
    if (e && e.length <= 6) return e;
    if (file.mimetype === "image/jpeg") return ".jpg";
    if (file.mimetype === "image/webp") return ".webp";
    return ".png";
  })();

  const fileName = `garments/${customerId}-${Date.now()}${ext}`;
  const gcsFile = bucket.file(fileName);

  await gcsFile.save(file.buffer, {
    metadata: { contentType: file.mimetype || "image/png" },
    resumable: false,
  });

  const [signedUrl] = await gcsFile.getSignedUrl({
    action: "read",
    version: "v4",
    expires: Date.now() + 60 * 60 * 1000,
  });

  return signedUrl;
}

function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers["content-type"] || "");
    if (!ct.toLowerCase().includes("multipart/form-data")) {
      // Non-multipart form (e.g. model creation with only text fields)
      const fields = typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
      return resolve({ fields, files: {}, error: null });
    }

    const body = req.rawBody || req.body;
    if (!body || !Buffer.isBuffer(body)) {
      return resolve({ fields: req.body || {}, files: {}, error: new Error("No rawBody") });
    }

    const fields = {};
    const files = {};
    let limitHit = false;

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 } });

    busboy.on("field", (name, val) => { fields[name] = val; });

    busboy.on("file", (fieldname, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => { limitHit = true; });
      stream.on("end", () => {
        if (!limitHit) {
          files[fieldname] = {
            originalname: filename || "upload",
            mimetype: mimeType || "application/octet-stream",
            buffer: Buffer.concat(chunks),
          };
        }
      });
    });

    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (limitHit) {
        const e = new Error("LIMIT_FILE_SIZE");
        e.code = "LIMIT_FILE_SIZE";
        return resolve({ fields, files: {}, error: e });
      }
      resolve({ fields, files, error: null });
    });

    busboy.end(body);
  });
}

/* =========================================
   SESSION TOKEN
========================================= */
function generateSessionToken(customerId) {
  const secret = process.env.SHOPIFY_SECRET || "fallback";
  const payload = `${customerId}:${Math.floor(Date.now() / 3600000)}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function verifySessionToken(customerId, token) {
  if (!customerId || !token) return false;
  const secret = process.env.SHOPIFY_SECRET || "fallback";
  const h = Math.floor(Date.now() / 3600000);
  for (let i = h; i >= h - 1; i--) {
    const exp = crypto.createHmac("sha256", secret).update(`${customerId}:${i}`).digest("hex");
    try {
      const a = Buffer.from(exp, "utf8");
      const b = Buffer.from(String(token), "utf8");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {}
  }
  return false;
}

/* =========================================
   CORS
========================================= */
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

/* =========================================
   PAGE RENDERER
========================================= */
function renderPage({ customerEmail = "Cliente", credits = 0, customerId = "", sessionToken = "", generations = [], userModel = null }) {
  const safeEmail = escapeHtml(customerEmail);
  const hasModel = !!userModel;

  const modelAttrsDesc = hasModel && userModel.attributes ? [
    userModel.attributes.age ? `${escapeHtml(userModel.attributes.age)} anos` : "",
    userModel.attributes.ethnicity ? escapeHtml(userModel.attributes.ethnicity) : "",
    userModel.attributes.bodyType ? escapeHtml(userModel.attributes.bodyType) : "",
    userModel.attributes.hairColor ? `cabelo ${escapeHtml(userModel.attributes.hairColor)}` : "",
  ].filter(Boolean).join(" • ") : "";

  const galleryItems = (generations || []).map((g) => `
    <div class="gallery-item">
      <img src="${escapeHtml(g.imageUrl)}" alt="Gerada" loading="lazy" />
      <div class="gallery-date">${escapeHtml(g.date || "")}</div>
    </div>
  `).join("");

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Corner IA - Prova Virtual</title>
      <style>
        :root { --p:#7c3aed; --p-light:#ede9fe; --p-dark:#5b21b6; --bg:#f5f6fa; --card:#fff; --muted:#6b7280; --border:#e5e7eb; --success:#059669; --danger:#dc2626; }
        * { box-sizing: border-box; }
        body { font-family: Inter, -apple-system, sans-serif; background: var(--bg); margin: 0; padding: 24px 16px; color: #111827; }
        .container { max-width: 780px; margin: 0 auto; }
        .card { background: var(--card); padding: 28px; border-radius: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); margin-bottom: 20px; }
        h1 { margin: 0 0 6px; font-size: 24px; font-weight: 800; }
        h2 { margin: 0 0 16px; font-size: 20px; font-weight: 700; }
        .subtitle { color: var(--muted); font-size: 14px; margin-bottom: 20px; }
        .header-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
        .pills { display: flex; gap: 10px; flex-wrap: wrap; }
        .pill { background: var(--p-light); color: var(--p-dark); padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; }
        .pill-neutral { background: #f3f4f6; color: #374151; }

        /* Drop zone */
        .drop-zone { border: 2px dashed var(--border); border-radius: 16px; padding: 40px 20px; text-align: center; cursor: pointer; transition: all 0.2s; background: #fafafa; position: relative; }
        .drop-zone:hover, .drop-zone.dragover { border-color: var(--p); background: var(--p-light); }
        .drop-zone input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
        .drop-icon { font-size: 40px; margin-bottom: 10px; display: block; }
        .drop-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
        .drop-hint { font-size: 13px; color: var(--muted); }
        .drop-preview { max-height: 260px; border-radius: 12px; margin-top: 14px; display: none; }

        /* Model display */
        .model-display { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 20px; }
        .model-photo { width: 180px; height: 240px; object-fit: cover; border-radius: 14px; border: 3px solid var(--p); flex-shrink: 0; }
        .model-info { flex: 1; min-width: 200px; }
        .model-info h3 { margin: 0 0 6px; font-size: 18px; }
        .model-info p { margin: 0; color: var(--muted); font-size: 14px; }
        .btn-change-model { margin-top: 12px; background: none; border: 1.5px solid var(--border); color: var(--muted); padding: 8px 16px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.2s; }
        .btn-change-model:hover { border-color: var(--p); color: var(--p); }

        /* Buttons */
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: var(--p); color: #fff; border: none; padding: 14px 24px; border-radius: 14px; font-weight: 700; font-size: 15px; cursor: pointer; transition: all 0.2s; width: 100%; }
        .btn:hover { background: var(--p-dark); transform: translateY(-1px); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .btn-outline { background: transparent; border: 2px solid var(--p); color: var(--p); }
        .btn-outline:hover { background: var(--p-light); }
        .btn-sm { padding: 10px 18px; font-size: 14px; width: auto; }

        /* Messages */
        .msg { padding: 14px 16px; border-radius: 12px; font-size: 14px; font-weight: 500; margin-bottom: 16px; display: none; }
        .msg-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
        .msg-success { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }

        /* Loading */
        .loading { display: none; text-align: center; padding: 36px 20px; }
        .loading.active { display: block; }
        .spinner { display: inline-block; width: 44px; height: 44px; border: 4px solid var(--border); border-top-color: var(--p); border-radius: 50%; animation: spin 0.7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .loading-text { margin-top: 14px; color: var(--muted); font-size: 15px; }

        /* Result */
        .result { display: none; margin-top: 20px; }
        .result img { width: 100%; border-radius: 16px; border: 1px solid var(--border); }

        /* Gallery */
        .gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; }
        .gallery-item { border-radius: 14px; overflow: hidden; border: 1px solid var(--border); background: #fff; transition: transform 0.2s; }
        .gallery-item:hover { transform: translateY(-2px); }
        .gallery-item img { width: 100%; display: block; }
        .gallery-date { padding: 8px; font-size: 12px; color: var(--muted); text-align: center; }
        .empty-state { color: var(--muted); font-size: 14px; text-align: center; padding: 20px; }
        .buy { margin-top: 12px; font-size: 13px; color: var(--muted); text-align: center; }
        .buy a { color: var(--p); text-decoration: none; font-weight: 700; }

        .divider { height: 1px; background: var(--border); margin: 24px 0; }
        .step-label { display: inline-block; background: var(--p); color: #fff; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; margin-bottom: 10px; }

        /* Form grid for model attributes */
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .form-field { display: flex; flex-direction: column; gap: 4px; }
        .form-field span { font-size: 13px; font-weight: 600; color: #374151; }
        .form-field input, .form-field select { padding: 10px 12px; border: 1.5px solid var(--border); border-radius: 10px; font-size: 14px; color: #111827; background: #fff; transition: border-color 0.2s; appearance: none; -webkit-appearance: none; }
        .form-field select { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px; }
        .form-field input:focus, .form-field select:focus { outline: none; border-color: var(--p); }

        @media (max-width: 600px) {
          .model-photo { width: 120px; height: 160px; }
          .card { padding: 20px; }
          .form-grid { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- Header Card -->
        <div class="card">
          <div class="header-row">
            <h1>Corner IA</h1>
            <div class="pills">
              <span class="pill pill-neutral">${safeEmail}</span>
              <span class="pill"><span id="creditCount">${Number(credits) || 0}</span> créditos</span>
            </div>
          </div>
          <div id="errorBox" class="msg msg-error"></div>
          <div id="statusBox" class="msg msg-success"></div>

          ${hasModel ? `
          <!-- ========== STATE: HAS MODEL — show generation UI ========== -->
          <div id="modelSection">
            <div class="model-display">
              <img src="${escapeHtml(userModel.imageUrl)}" alt="Sua modelo" class="model-photo" id="currentModelImg" />
              <div class="model-info">
                <h3>Sua Modelo IA</h3>
                <p>${modelAttrsDesc || "Modelo gerada por IA."}</p>
                <button type="button" class="btn-change-model" id="changeModelBtn">Trocar modelo</button>
              </div>
            </div>
            <div class="divider"></div>
            <form id="generateForm" enctype="multipart/form-data" method="POST" action="${FUNCTION_URL}">
              <input type="hidden" name="customerId" value="${escapeHtml(customerId)}" />
              <input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}" />
              <input type="hidden" name="action" value="generate" />
              <input type="hidden" name="modelId" value="${escapeHtml(userModel.id || "")}" />
              <input type="hidden" name="model" value="${escapeHtml(userModel.imageUrl)}" />
              <div>
                <span class="step-label">Envie a roupa</span>
                <h2>Arraste a imagem da peça</h2>
              </div>
              <div class="drop-zone" id="garmentDrop">
                <input type="file" name="garment" accept="image/*" id="garmentInput" />
                <span class="drop-icon">👗</span>
                <div class="drop-title">Solte a imagem aqui</div>
                <div class="drop-hint">ou clique para selecionar • JPG, PNG, WEBP até 12MB</div>
                <img class="drop-preview" id="garmentPreview" alt="Preview" />
              </div>
              <div style="height:16px"></div>
              <button type="submit" class="btn" id="submitBtn">✨ Gerar prova virtual (1 crédito)</button>
              <div class="buy">Sem créditos? <a href="/collections/all" target="_blank">Comprar pacotes</a></div>
            </form>
          </div>

          <!-- Change model (hidden by default) -->
          <div id="changeModelSection" style="display:none;">
            <form id="changeModelForm" method="POST" action="${FUNCTION_URL}">
              <input type="hidden" name="customerId" value="${escapeHtml(customerId)}" />
              <input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}" />
              <input type="hidden" name="action" value="createModel" />
              <div>
                <span class="step-label">Trocar modelo</span>
                <h2>Descreva a nova modelo</h2>
                <p class="subtitle">A modelo anterior será substituída.</p>
              </div>
              <div class="form-grid">
                <label class="form-field"><span>Idade</span><input type="number" name="age" value="25" min="16" max="80" /></label>
                <label class="form-field"><span>Etnia</span><select name="ethnicity"><option value="branca">Branca</option><option value="negra">Negra</option><option value="asiatica">Asiática</option><option value="latina" selected>Latina</option><option value="indiana">Indiana</option><option value="arabe">Árabe</option></select></label>
                <label class="form-field"><span>Biotipo</span><select name="bodyType"><option value="magra">Magra</option><option value="media" selected>Média</option><option value="atletica">Atlética</option><option value="plus">Plus Size</option></select></label>
                <label class="form-field"><span>Cor do cabelo</span><select name="hairColor"><option value="preto">Preto</option><option value="castanho" selected>Castanho</option><option value="loiro">Loiro</option><option value="ruivo">Ruivo</option><option value="platinado">Platinado</option><option value="rosa">Rosa</option></select></label>
                <label class="form-field"><span>Comprimento do cabelo</span><select name="hairLength"><option value="curto">Curto</option><option value="medio">Médio</option><option value="longo" selected>Longo</option></select></label>
                <label class="form-field"><span>Cor dos olhos</span><select name="eyeColor"><option value="castanhos" selected>Castanhos</option><option value="azuis">Azuis</option><option value="verdes">Verdes</option><option value="pretos">Pretos</option><option value="mel">Mel</option></select></label>
                <label class="form-field"><span>Altura</span><select name="height"><option value="baixa">Baixa</option><option value="media" selected>Média</option><option value="alta">Alta</option></select></label>
                <label class="form-field"><span>Tom de pele</span><select name="skinTone"><option value="clara">Clara</option><option value="media" selected>Média</option><option value="morena">Morena</option><option value="escura">Escura</option></select></label>
              </div>
              <div style="display:flex; gap:10px; margin-top:16px;">
                <button type="button" class="btn btn-outline btn-sm" id="cancelChangeBtn">Cancelar</button>
                <button type="submit" class="btn btn-sm" id="changeModelSubmitBtn" style="flex:1;">✨ Gerar nova modelo</button>
              </div>
            </form>
          </div>
          ` : `
          <!-- ========== STATE: NO MODEL — show creation UI ========== -->
          <div id="createModelSection">
            <form id="createModelForm" method="POST" action="${FUNCTION_URL}">
              <input type="hidden" name="customerId" value="${escapeHtml(customerId)}" />
              <input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}" />
              <input type="hidden" name="action" value="createModel" />
              <div style="text-align:center; margin-bottom:20px;">
                <span class="step-label">Passo 1 de 2</span>
                <h2 style="margin-top:10px;">Crie sua Modelo IA</h2>
                <p class="subtitle">Descreva como deve ser sua modelo virtual. A IA vai gerar uma imagem realista para você experimentar roupas.</p>
              </div>
              <div class="form-grid">
                <label class="form-field"><span>Idade</span><input type="number" name="age" value="25" min="16" max="80" /></label>
                <label class="form-field"><span>Etnia</span><select name="ethnicity"><option value="branca">Branca</option><option value="negra">Negra</option><option value="asiatica">Asiática</option><option value="latina" selected>Latina</option><option value="indiana">Indiana</option><option value="arabe">Árabe</option></select></label>
                <label class="form-field"><span>Biotipo</span><select name="bodyType"><option value="magra">Magra</option><option value="media" selected>Média</option><option value="atletica">Atlética</option><option value="plus">Plus Size</option></select></label>
                <label class="form-field"><span>Cor do cabelo</span><select name="hairColor"><option value="preto">Preto</option><option value="castanho" selected>Castanho</option><option value="loiro">Loiro</option><option value="ruivo">Ruivo</option><option value="platinado">Platinado</option><option value="rosa">Rosa</option></select></label>
                <label class="form-field"><span>Comprimento do cabelo</span><select name="hairLength"><option value="curto">Curto</option><option value="medio">Médio</option><option value="longo" selected>Longo</option></select></label>
                <label class="form-field"><span>Cor dos olhos</span><select name="eyeColor"><option value="castanhos" selected>Castanhos</option><option value="azuis">Azuis</option><option value="verdes">Verdes</option><option value="pretos">Pretos</option><option value="mel">Mel</option></select></label>
                <label class="form-field"><span>Altura</span><select name="height"><option value="baixa">Baixa</option><option value="media" selected>Média</option><option value="alta">Alta</option></select></label>
                <label class="form-field"><span>Tom de pele</span><select name="skinTone"><option value="clara">Clara</option><option value="media" selected>Média</option><option value="morena">Morena</option><option value="escura">Escura</option></select></label>
              </div>
              <div style="height:16px"></div>
              <button type="submit" class="btn" id="createModelBtn">✨ Gerar minha modelo</button>
            </form>
          </div>
          `}

          <div id="loading" class="loading">
            <div class="spinner"></div>
            <div class="loading-text" id="loadingText">Processando...</div>
          </div>

          <div id="latestResult" class="result">
            <h2>Resultado</h2>
            <img id="latestImg" src="" alt="Resultado gerado" />
          </div>
        </div>

        <!-- Gallery Card -->
        ${(generations && generations.length > 0) || hasModel ? `
        <div class="card">
          <h2>Imagens Geradas</h2>
          <div id="galleryGrid" class="gallery-grid">
            ${galleryItems || '<div class="empty-state">Nenhuma imagem gerada ainda.</div>'}
          </div>
        </div>
        ` : ''}
      </div>

      <div id="appConfig" data-api="${FUNCTION_URL}" style="display:none;"></div>
      <script>${getClientJS()}</script>
    </body>
  </html>
  `;
}

/* =========================================
   CLIENT JAVASCRIPT
========================================= */
function getClientJS() {
  return `(function(){
  var cfg = document.getElementById("appConfig");
  if (!cfg) return;
  var API_URL = cfg.getAttribute("data-api");

  var errorBox = document.getElementById("errorBox");
  var statusBox = document.getElementById("statusBox");
  var loading = document.getElementById("loading");
  var loadingText = document.getElementById("loadingText");
  var latestResult = document.getElementById("latestResult");
  var latestImg = document.getElementById("latestImg");
  var creditCount = document.getElementById("creditCount");
  var galleryGrid = document.getElementById("galleryGrid");

  function showError(msg) { errorBox.textContent = msg; errorBox.style.display = "block"; statusBox.style.display = "none"; }
  function showStatus(msg) { statusBox.textContent = msg; statusBox.style.display = "block"; errorBox.style.display = "none"; }
  function hideMessages() { errorBox.style.display = "none"; statusBox.style.display = "none"; }

  /* --- Drag & Drop setup --- */
  function setupDropZone(zoneId, inputId, previewId) {
    var zone = document.getElementById(zoneId);
    var input = document.getElementById(inputId);
    var preview = document.getElementById(previewId);
    if (!zone || !input) return;

    zone.addEventListener("dragover", function(e) { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", function() { zone.classList.remove("dragover"); });
    zone.addEventListener("drop", function(e) {
      e.preventDefault();
      zone.classList.remove("dragover");
      if (e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        showPreview(input.files[0], preview, zone);
      }
    });
    input.addEventListener("change", function() {
      if (input.files.length) showPreview(input.files[0], preview, zone);
    });
  }

  function showPreview(file, preview, zone) {
    if (!preview || !file) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      preview.src = e.target.result;
      preview.style.display = "block";
      var texts = zone.querySelectorAll(".drop-icon, .drop-title, .drop-hint");
      for (var i = 0; i < texts.length; i++) texts[i].style.display = "none";
    };
    reader.readAsDataURL(file);
  }

  setupDropZone("garmentDrop", "garmentInput", "garmentPreview");

  /* --- Change model toggle --- */
  var changeBtn = document.getElementById("changeModelBtn");
  var cancelBtn = document.getElementById("cancelChangeBtn");
  var modelSection = document.getElementById("modelSection");
  var changeSection = document.getElementById("changeModelSection");
  if (changeBtn) changeBtn.addEventListener("click", function() { modelSection.style.display = "none"; changeSection.style.display = "block"; hideMessages(); });
  if (cancelBtn) cancelBtn.addEventListener("click", function() { changeSection.style.display = "none"; modelSection.style.display = "block"; hideMessages(); });

  /* --- Create Model form (attribute-based, no upload) --- */
  function handleModelForm(formId, btnId) {
    var form = document.getElementById(formId);
    var btn = document.getElementById(btnId);
    if (!form) return;
    form.addEventListener("submit", function(e) {
      e.preventDefault();
      hideMessages();
      var formData = new FormData(form);

      btn.disabled = true;
      btn.textContent = "Gerando modelo...";
      loading.classList.add("active");
      loadingText.textContent = "Gerando sua modelo IA... pode levar ate 60 segundos.";

      fetch(API_URL, { method: "POST", body: formData })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          if (!res.ok || res.data.error) { showError(res.data.error || "Erro ao gerar modelo."); return; }
          showStatus("Modelo gerada com sucesso! Recarregando...");
          setTimeout(function() { location.reload(); }, 1200);
        })
        .catch(function() { showError("Erro de conexao. Tente novamente."); })
        .finally(function() { btn.disabled = false; btn.textContent = "\\u2728 Gerar minha modelo"; loading.classList.remove("active"); });
    });
  }
  handleModelForm("createModelForm", "createModelBtn");
  handleModelForm("changeModelForm", "changeModelSubmitBtn");

  /* --- Generate form --- */
  var genForm = document.getElementById("generateForm");
  var submitBtn = document.getElementById("submitBtn");
  if (genForm) {
    genForm.addEventListener("submit", function(e) {
      e.preventDefault();
      hideMessages();
      var formData = new FormData(genForm);
      var garment = formData.get("garment");
      if (!garment || !garment.size) { showError("Envie a imagem da roupa."); return; }
      if (garment.size > 12 * 1024 * 1024) { showError("Arquivo muito grande. Maximo 12MB."); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "Gerando...";
      loading.classList.add("active");
      loadingText.textContent = "Gerando imagem com IA... pode levar ate 60 segundos.";
      latestResult.style.display = "none";

      fetch(API_URL, { method: "POST", body: formData })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          var data = res.data;
          if (!res.ok || data.error) {
            showError(data.error || "Erro ao gerar imagem.");
            if (typeof data.credits === "number") creditCount.textContent = data.credits;
            return;
          }
          showStatus("Imagem gerada com sucesso!");
          creditCount.textContent = data.credits;
          latestImg.src = data.imageUrl;
          latestResult.style.display = "block";
          if (galleryGrid) {
            var empty = galleryGrid.querySelector(".empty-state");
            if (empty) empty.remove();
            var item = document.createElement("div"); item.className = "gallery-item";
            var img = document.createElement("img"); img.src = data.imageUrl; img.alt = "Gerada";
            var dt = document.createElement("div"); dt.className = "gallery-date"; dt.textContent = data.date || "Agora";
            item.appendChild(img); item.appendChild(dt);
            galleryGrid.insertBefore(item, galleryGrid.firstChild);
          }
          var fileInput = genForm.querySelector('input[name="garment"]');
          if (fileInput) fileInput.value = "";
          var prev = document.getElementById("garmentPreview");
          if (prev) { prev.style.display = "none"; prev.src = ""; }
          var zone = document.getElementById("garmentDrop");
          if (zone) { var t = zone.querySelectorAll(".drop-icon, .drop-title, .drop-hint"); for (var i=0;i<t.length;i++) t[i].style.display = ""; }
        })
        .catch(function() { showError("Erro de conexao. Tente novamente."); })
        .finally(function() { submitBtn.disabled = false; submitBtn.textContent = "\\u2728 Gerar prova virtual (1 credito)"; loading.classList.remove("active"); });
    });
  }
})();`;
}

/* =========================================
   RESPONSE HTML (non-AJAX fallback)
========================================= */
function renderResponseHtml({ title = "", icon = "✅", message = "", imageUrl = "", backLabel = "Voltar", autoBack = false } = {}) {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:Inter,-apple-system,sans-serif;background:#f5f6fa;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px}.box{background:#fff;padding:40px;border-radius:20px;text-align:center;max-width:520px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{font-size:48px;margin-bottom:16px}h2{margin:0 0 8px;font-size:22px}p{color:#6b7280;margin:0 0 20px;font-size:15px}img.result{max-width:100%;border-radius:14px;margin:16px 0;border:1px solid #e5e7eb}a.btn{display:inline-block;padding:14px 28px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:14px;font-weight:700;font-size:15px}a.btn:hover{background:#5b21b6}</style></head><body><div class="box"><div class="icon">${icon}</div><h2>${escapeHtml(title)}</h2>
${imageUrl ? '<img class="result" src="' + escapeHtml(imageUrl) + '" alt="Resultado" />' : ''}<p>${escapeHtml(message)}</p>
<a class="btn" href="javascript:history.back()">${escapeHtml(backLabel)}</a></div>${autoBack ? '<script>setTimeout(function(){history.back()},2000)</script>' : ''}</body></html>`;
}

/* =========================================
   MAIN FUNCTION (SHOPIFY APP PROXY)
========================================= */
exports.shopifyProxy = onRequest(
  {
    secrets: ["SHOPIFY_SECRET", "GEMINI_API_KEY"],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      /* ========== Serve client JS as external file ========== */
      if (req.method === "GET" && req.query._resource === "js") {
        res.set("Content-Type", "application/javascript; charset=utf-8");
        res.set("Cache-Control", "public, max-age=300");
        return res.send(getClientJS());
      }

      /* ========== POST (JS fetch direto) ========== */
      if (req.method === "POST") {
        /* Detect native form navigation vs AJAX fetch */
        const _isFormNav = (req.headers.accept || "").includes("text/html");
        const _referer = req.headers.referer || req.headers.origin || "";
        if (_isFormNav) {
          res.json = function(data) {
            // For model creation success, redirect back to the page so the browser does a fresh GET
            if (data && data.success && _referer) {
              return res.redirect(303, _referer);
            }
            res.set("Content-Type", "text/html; charset=utf-8");
            if (data && data.error) return res.send(renderResponseHtml({ title: "Erro", icon: "⚠️", message: data.error }));
            if (data && data.success) return res.send(renderResponseHtml({ title: "Modelo gerada!", icon: "✅", message: "Sua modelo IA foi gerada com sucesso.", autoBack: true }));
            if (data && data.imageUrl) return res.send(renderResponseHtml({ title: "Imagem gerada!", icon: "✨", message: "Créditos restantes: " + (data.credits || 0), imageUrl: data.imageUrl }));
            return res.send(renderResponseHtml({ title: "Sucesso", icon: "✅", message: "Operação realizada.", autoBack: true }));
          };
        } else {
          res.set("Content-Type", "application/json");
        }

        let parsed;
        try {
          parsed = await parseMultipartForm(req);
        } catch (e) {
          console.error("Parse error:", e);
          return res.status(400).json({ error: "Erro ao processar upload." });
        }

        if (parsed.error) {
          const tooLarge = parsed.error.code === "LIMIT_FILE_SIZE";
          return res.status(400).json({
            error: tooLarge ? "Arquivo muito grande. Maximo 12MB." : "Formato de upload invalido.",
          });
        }

        const customerId = String(parsed.fields?.customerId || "");
        const sessionToken = String(parsed.fields?.sessionToken || "");
        const action = String(parsed.fields?.action || "generate");

        console.log("POST action:", action, "customerId:", customerId, "fields:", JSON.stringify(parsed.fields));

        if (!customerId || !verifySessionToken(customerId, sessionToken)) {
          return res.status(403).json({ error: "Sessao expirada. Recarregue a pagina." });
        }

        /* ========== ACTION: CREATE MODEL ========== */
        if (action === "createModel") {
          const modelAttrs = {
            age: String(parsed.fields?.age || "25"),
            ethnicity: String(parsed.fields?.ethnicity || "latina"),
            bodyType: String(parsed.fields?.bodyType || "media"),
            hairColor: String(parsed.fields?.hairColor || "castanho"),
            hairLength: String(parsed.fields?.hairLength || "longo"),
            eyeColor: String(parsed.fields?.eyeColor || "castanhos"),
            height: String(parsed.fields?.height || "media"),
            skinTone: String(parsed.fields?.skinTone || "media"),
          };

          try {
            const modelPrompt = buildModelGenerationPrompt(modelAttrs);

            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const imageModel = genAI.getGenerativeModel({
              model: "gemini-2.5-flash-image",
              generationConfig: {
                responseModalities: ["image", "text"],
              },
            });

            const result = await imageModel.generateContent([modelPrompt]);

            const parts = result.response.candidates?.[0]?.content?.parts || [];
            let imageBase64 = null;
            let imageMimeType = "image/png";

            for (const part of parts) {
              if (part.inlineData) {
                imageBase64 = part.inlineData.data;
                imageMimeType = part.inlineData.mimeType || "image/png";
                break;
              }
            }

            if (!imageBase64) {
              throw new Error("Gemini did not return a model image");
            }

            const imgBuf = Buffer.from(imageBase64, "base64");
            const ext = imageMimeType.includes("jpeg") ? ".jpg" : imageMimeType.includes("webp") ? ".webp" : ".png";
            const fileName = `models/${customerId}-${Date.now()}${ext}`;
            const gcsFile = bucket.file(fileName);

            await gcsFile.save(imgBuf, {
              metadata: { contentType: imageMimeType },
              resumable: false,
            });

            const [signedUrl] = await gcsFile.getSignedUrl({
              action: "read",
              version: "v4",
              expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
            });

            // Delete previous models
            const prevModels = await db.collection("users").doc(customerId).collection("models").get();
            const batch = db.batch();
            prevModels.forEach((doc) => batch.delete(doc.ref));
            if (!prevModels.empty) await batch.commit();

            // Save new model with attributes
            await db.collection("users").doc(customerId).collection("models").add({
              referenceImageUrl: signedUrl,
              gcsPath: fileName,
              attributes: modelAttrs,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            console.log("Model created successfully for customer:", customerId, "gcsPath:", fileName);
            return res.status(200).json({ success: true, imageUrl: signedUrl });
          } catch (e) {
            console.error("Create model error:", e);
            return res.status(500).json({ error: "Erro ao gerar a modelo. Tente novamente." });
          }
        }

        /* ========== ACTION: GENERATE ========== */
        const modelUrl = String(parsed.fields?.model || "");
        const garmentFile = parsed.files?.garment;

        if (!modelUrl) return res.status(400).json({ error: "Modelo não encontrada. Recarregue a página." });
        if (!garmentFile) return res.status(400).json({ error: "Envie a imagem da roupa." });

        const userRef = db.collection("users").doc(customerId);

        const txResult = await db.runTransaction(async (tx) => {
          const s = await tx.get(userRef);
          const current = Number(s.data()?.credits || 0);
          if (current < 1) return { ok: false, credits: current };
          tx.update(userRef, { credits: current - 1 });
          return { ok: true, credits: current - 1 };
        });

        if (!txResult.ok) {
          return res.status(402).json({
            error: "Sem creditos. Compre mais creditos para continuar.",
            credits: txResult.credits,
          });
        }

        /* --- Passo A: Analisar a roupa com Gemini Vision --- */
        let garmentAnalysis;
        try {
          garmentAnalysis = await analyzeGarmentWithGemini(garmentFile.buffer, garmentFile.mimetype);
        } catch (e) {
          console.warn("Garment analysis failed, using fallback:", e.message);
          garmentAnalysis = { full_description: "fashion clothing item" };
        }

        /* --- Passo B: Buscar dados da modelo selecionada --- */
        const modelId = String(parsed.fields?.modelId || "");
        let modelImageUrl = modelUrl;
        let modelAttributes = {};

        if (modelId) {
          try {
            const modelDoc = await db
              .collection("users")
              .doc(customerId)
              .collection("models")
              .doc(modelId)
              .get();

            if (modelDoc.exists) {
              const modelData = modelDoc.data();
              modelImageUrl = modelData.referenceImageUrl || modelUrl;
              modelAttributes = modelData.attributes || {};
            }
          } catch (e) {
            console.warn("Failed to fetch model data, using fallback:", e.message);
          }
        }

        /* --- Passo C: Upload da roupa para GCS --- */
        let garmentUrl;
        try {
          garmentUrl = await uploadGarmentAndGetUrl({ customerId, file: garmentFile });
        } catch (e) {
          console.error("Upload error:", e);
          await userRef.update({ credits: admin.firestore.FieldValue.increment(1) });
          return res.status(500).json({
            error: "Erro ao enviar imagem. Tente outro arquivo.",
            credits: txResult.credits + 1,
          });
        }

        /* --- Passo D: Montar o prompt de texto --- */
        const textPrompt = buildVirtualTryOnPrompt({
          garmentAnalysis,
          modelAttributes,
        });

        /* --- Passo E: Gerar imagem com Gemini 2.5 Flash Image --- */
        let finalImage;
        let finalGcsPath;
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const imageModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-image",
            generationConfig: {
              responseModalities: ["image", "text"],
            },
          });

          // Fetch model reference image as buffer
          const modelImgResp = await fetch(modelImageUrl);
          if (!modelImgResp.ok) throw new Error(`Failed to fetch model image: ${modelImgResp.status}`);
          const modelImgBuffer = Buffer.from(await modelImgResp.arrayBuffer());
          const modelImgMime = modelImgResp.headers.get("content-type") || "image/png";

          // Build contextual label for the garment image
          const garmentHasHuman = garmentAnalysis.has_human_model === true;
          const garmentLabel = garmentHasHuman
            ? "Garment reference image (WARNING: a human model is wearing this garment — IGNORE the person, extract ONLY the clothing design, preserve exact number of buttons/pockets/details):"
            : "Garment to dress the model in (preserve exact design, color, fabric, button count, pocket count, and ALL details):";

          const result = await imageModel.generateContent([
            "Reference model image (preserve this person's identity, face, hair, and body proportions — this is the ONLY person to use):",
            {
              inlineData: {
                data: modelImgBuffer.toString("base64"),
                mimeType: modelImgMime,
              },
            },
            garmentLabel,
            {
              inlineData: {
                data: garmentFile.buffer.toString("base64"),
                mimeType: garmentFile.mimetype || "image/png",
              },
            },
            textPrompt,
          ]);

          // Extract generated image from response
          const parts = result.response.candidates?.[0]?.content?.parts || [];
          let imageBase64 = null;
          let imageMimeType = "image/png";

          for (const part of parts) {
            if (part.inlineData) {
              imageBase64 = part.inlineData.data;
              imageMimeType = part.inlineData.mimeType || "image/png";
              break;
            }
          }

          if (!imageBase64) {
            throw new Error("Gemini did not return an image in the response");
          }

          // Upload generated image to GCS
          const imgBuf = Buffer.from(imageBase64, "base64");
          const ext = imageMimeType.includes("jpeg") ? ".jpg" : imageMimeType.includes("webp") ? ".webp" : ".png";
          const genFileName = `generations/${customerId}-${Date.now()}${ext}`;
          const genFile = bucket.file(genFileName);

          await genFile.save(imgBuf, {
            metadata: { contentType: imageMimeType },
            resumable: false,
          });

          const [genSignedUrl] = await genFile.getSignedUrl({
            action: "read",
            version: "v4",
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
          });
          finalImage = genSignedUrl;
          finalGcsPath = genFileName;
        } catch (e) {
          console.error("Gemini image generation error:", e);
          await userRef.update({ credits: admin.firestore.FieldValue.increment(1) });
          return res.status(500).json({
            error: "Erro ao gerar imagem com IA. Tente novamente.",
            credits: txResult.credits + 1,
          });
        }

        /* --- Passo F: Verificar imagem final --- */
        if (!finalImage) {
          await userRef.update({ credits: admin.firestore.FieldValue.increment(1) });
          return res.status(500).json({
            error: "A IA nao retornou uma imagem valida. Tente outra foto.",
            credits: txResult.credits + 1,
          });
        }

        const now = new Date();
        const dateStr = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

        /* --- Passo G: Salvar a geração no Firestore --- */
        await db.collection("users").doc(customerId).collection("generations").add({
          imageUrl: finalImage,
          gcsPath: finalGcsPath || null,
          modelId: parsed.fields?.modelId || null,
          modelUrl: modelImageUrl,
          garmentUrl,
          garmentAnalysis,
          promptSnapshot: textPrompt,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          date: dateStr,
        });

        /* --- Passo H: Transação de débito no histórico --- */
        await db.collection("users").doc(customerId).collection("creditTransactions").add({
          type: "usage",
          credits: -1,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(200).json({
          imageUrl: finalImage,
          credits: txResult.credits,
          date: dateStr,
        });
      }

      /* ========== GET (via Shopify App Proxy) ========== */
      if (!verifyShopifyProxy(req)) {
        return res.status(403).send("Unauthorized");
      }

      const customerId = req.query.logged_in_customer_id || req.query.customer_id || null;
      const customerEmail = req.query.logged_in_customer_email || req.query.customer_email || "Cliente";

      if (!customerId) {
        return res.send(`
          <!doctype html>
          <html><head><meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            body{font-family:Inter,Arial,sans-serif;background:#f5f6fa;margin:0;padding:60px 16px;}
            .box{max-width:720px;margin:0 auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center;}
            a{display:inline-block;margin-top:14px;padding:14px 22px;background:#000;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;}
            p{color:#374151}
          </style></head>
          <body>
            <div class="box">
              <h1>Acesso restrito</h1>
              <p>Voce precisa estar logado para usar a ferramenta de IA.</p>
              <a href="/account/login">Fazer login na loja</a>
            </div>
          </body></html>
        `);
      }

      const userRef = db.collection("users").doc(String(customerId));

      let snap = await userRef.get();
      if (!snap.exists) {
        await userRef.set({
          customerId: String(customerId),
          email: String(customerEmail || ""),
          credits: 5,
          freeCreditsGranted: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await userRef.collection("creditTransactions").add({
          type: "free_signup",
          credits: 5,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        snap = await userRef.get();
      }

      const credits = Number(snap.data()?.credits || 0);
      const sessionToken = generateSessionToken(String(customerId));

      // Fetch user's custom model
      const modelsSnap = await userRef.collection("models")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      let userModel = null;
      if (!modelsSnap.empty) {
        const modelDoc = modelsSnap.docs[0];
        const modelData = modelDoc.data();
        let modelImageUrl = modelData.referenceImageUrl || "";
        if (modelData.gcsPath) {
          try {
            const [freshUrl] = await bucket.file(modelData.gcsPath).getSignedUrl({
              action: "read",
              version: "v4",
              expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
            });
            modelImageUrl = freshUrl;
          } catch (e) {
            console.warn("Failed to regenerate model signed URL:", e.message);
          }
        }
        userModel = {
          id: modelDoc.id,
          imageUrl: modelImageUrl,
          attributes: modelData.attributes || {},
        };
      }

      const gensSnap = await userRef.collection("generations")
        .orderBy("createdAt", "desc")
        .limit(20)
        .get();

      const generations = [];
      for (const doc of gensSnap.docs) {
        const d = doc.data();
        if (d.imageUrl || d.gcsPath) {
          let imgUrl = d.imageUrl;
          if (d.gcsPath) {
            try {
              const [freshUrl] = await bucket.file(d.gcsPath).getSignedUrl({
                action: "read",
                version: "v4",
                expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
              });
              imgUrl = freshUrl;
            } catch (e) {
              console.warn("Failed to regenerate generation signed URL:", e.message);
            }
          }
          if (imgUrl) generations.push({ imageUrl: imgUrl, date: d.date || "" });
        }
      }

      return res.send(
        renderPage({
          customerEmail,
          credits,
          customerId: String(customerId),
          sessionToken,
          generations,
          userModel,
        })
      );
    } catch (err) {
      console.error("TOP LEVEL ERROR:", err);
      if (req.method === "POST") {
        return res.status(500).json({ error: "Erro interno." });
      }
      res.status(500).send("Erro interno.");
    }
  }
);
