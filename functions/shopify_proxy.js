"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Busboy = require("busboy");
const path = require("path");

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { analyzeGarmentWithGemini } = require("./garment_analyzer");
const { buildVirtualTryOnPrompt, buildModelGenerationPrompt } = require("./prompt_builder");
const { optimizeImage } = require("./image_optimizer");

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
   HELPER: Refresh a model's signed URL
========================================= */
async function refreshModelUrl(modelData) {
  if (modelData.gcsPath) {
    try {
      const [freshUrl] = await bucket.file(modelData.gcsPath).getSignedUrl({
        action: "read",
        version: "v4",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      return freshUrl;
    } catch (e) {
      console.warn("Failed to refresh model URL:", e.message);
    }
  }
  return modelData.referenceImageUrl || "";
}

/* =========================================
   PAGE RENDERER
========================================= */
function renderPage({ customerEmail = "Cliente", credits = 0, customerId = "", sessionToken = "", generations = [], models = [], selectedModelId = "", pathPrefix = "" }) {
  const safeEmail = escapeHtml(customerEmail);
  const selectedModel = models.find((m) => m.id === selectedModelId) || models[0] || null;

  const galleryItems = (generations || []).map((g) => `
    <div class="gallery-item">
      <img src="${escapeHtml(g.imageUrl)}" alt="Gerada" loading="lazy" />
      <div class="gallery-meta">
        <span class="gallery-date">${escapeHtml(g.date || "")}</span>
        <a href="${escapeHtml(g.imageUrl)}" download class="gallery-dl" title="Baixar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>
      </div>
    </div>
  `).join("");

  const modelCards = (models || []).map((m) => {
    const sel = m.id === (selectedModel?.id || "");
    const attrs = m.attributes || {};
    const desc = [
      attrs.age ? `${escapeHtml(attrs.age)}a` : "",
      attrs.ethnicity ? escapeHtml(attrs.ethnicity) : "",
      attrs.bodyType ? escapeHtml(attrs.bodyType) : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="model-card ${sel ? "model-card-selected" : ""}" data-model-id="${escapeHtml(m.id)}" data-model-url="${escapeHtml(m.imageUrl)}">
        <img src="${escapeHtml(m.imageUrl)}" alt="Modelo" class="model-thumb" />
        <div class="model-card-info">
          <span class="model-card-desc">${desc || "Modelo IA"}</span>
          ${sel ? '<span class="model-badge">Ativa</span>' : ""}
        </div>
        <form method="POST" action="${FUNCTION_URL}" class="mc-delete-form" onclick="event.stopPropagation()"><input type="hidden" name="customerId" value="${escapeHtml(customerId)}"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}"><input type="hidden" name="action" value="deleteModel"><input type="hidden" name="modelId" value="${escapeHtml(m.id)}"><input type="hidden" name="_return" value="${escapeHtml(pathPrefix)}"><button type="submit" class="mc-btn mc-delete" title="Excluir">✕</button></form>
      </div>`;
  }).join("");

  return `{% layout none %}<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root{--p:#7c3aed;--p-light:#f5f3ff;--p-lighter:#faf5ff;--p-dark:#6d28d9;--p-darker:#5b21b6;--bg:#fafafa;--card:#ffffff;--muted:#64748b;--muted-light:#94a3b8;--border:#e2e8f0;--border-light:#f1f5f9;--success:#10b981;--danger:#ef4444;--radius:16px;--shadow-sm:0 1px 2px rgba(0,0,0,.04);--shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);--shadow-md:0 4px 6px -1px rgba(0,0,0,.05),0 2px 4px -2px rgba(0,0,0,.04);--shadow-lg:0 10px 25px -3px rgba(0,0,0,.06),0 4px 6px -4px rgba(0,0,0,.04);--shadow-xl:0 20px 50px -12px rgba(0,0,0,.08)}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:#0f172a;min-height:100vh;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}

    /* === LAYOUT === */
    .app-shell{display:flex;min-height:100vh}
    .sidebar{width:260px;background:#fff;border-right:1px solid var(--border-light);padding:28px 0;display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100}
    .sidebar-logo{padding:0 24px 28px;font-size:20px;font-weight:800;color:var(--p-dark);letter-spacing:-.3px;display:flex;align-items:center;gap:10px}
    .sidebar-logo svg{width:28px;height:28px}
    .sidebar-nav{flex:1;padding:0 12px}
    .nav-section{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-light);padding:16px 12px 8px}
    .nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;font-size:13px;font-weight:500;color:#475569;cursor:pointer;transition:.15s;text-decoration:none;margin-bottom:2px}
    .nav-item:hover{background:var(--p-light);color:var(--p-dark)}
    .nav-item.active{background:var(--p-light);color:var(--p-dark);font-weight:600}
    .nav-item svg{width:18px;height:18px;opacity:.7}
    .nav-item.active svg{opacity:1}
    .sidebar-footer{padding:16px 16px;border-top:1px solid var(--border-light)}
    .sidebar-credits{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:linear-gradient(135deg,var(--p-light),#ede9fe);border-radius:12px}
    .sidebar-credits-info{display:flex;flex-direction:column;gap:2px}
    .sidebar-credits-label{font-size:11px;color:var(--muted);font-weight:500}
    .sidebar-credits-value{font-size:20px;font-weight:800;color:var(--p-dark)}
    .sidebar-buy{font-size:11px;font-weight:700;color:var(--p);text-decoration:none;padding:6px 12px;border-radius:8px;border:1.5px solid var(--p);transition:.15s;white-space:nowrap}
    .sidebar-buy:hover{background:var(--p);color:#fff}
    .sidebar-user{display:flex;align-items:center;gap:10px;padding:12px 14px;margin-top:10px;border-radius:10px;background:var(--border-light)}
    .sidebar-user-avatar{width:32px;height:32px;border-radius:50%;background:var(--p-light);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--p-dark)}
    .sidebar-user-info{flex:1;min-width:0}
    .sidebar-user-email{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .main-content{margin-left:260px;flex:1;min-height:100vh}
    .main-header{display:flex;align-items:center;justify-content:space-between;padding:20px 40px;border-bottom:1px solid var(--border-light);background:#fff;position:sticky;top:0;z-index:50}
    .main-header h1{font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-.3px}
    .main-header-pills{display:flex;gap:8px;align-items:center}
    .header-badge{padding:6px 14px;border-radius:999px;font-size:12px;font-weight:600;background:var(--p-light);color:var(--p-dark);display:flex;align-items:center;gap:5px}
    .main-body{padding:32px 40px;max-width:1200px}

    /* === MESSAGES === */
    .msg{padding:14px 18px;border-radius:12px;font-size:13px;font-weight:500;margin-bottom:20px;display:none;line-height:1.5}
    .msg-error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
    .msg-success{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}

    /* === CARDS === */
    .card{background:var(--card);border-radius:var(--radius);border:1px solid var(--border-light);box-shadow:var(--shadow-sm);padding:0;margin-bottom:24px;overflow:hidden}
    .card-header{padding:20px 24px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;justify-content:space-between}
    .card-title{font-size:15px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:8px;letter-spacing:-.2px}
    .card-title svg{width:18px;height:18px;color:var(--p)}
    .card-body{padding:24px}
    .card-footer{padding:16px 24px;border-top:1px solid var(--border-light);background:var(--border-light)}

    /* === BUTTONS === */
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:none;padding:12px 22px;border-radius:12px;font-weight:600;font-size:14px;cursor:pointer;transition:all .2s;font-family:inherit;letter-spacing:-.1px}
    .btn-primary{background:var(--p);color:#fff;box-shadow:0 1px 3px rgba(124,58,237,.3),0 1px 2px rgba(124,58,237,.2)}
    .btn-primary:hover{background:var(--p-dark);transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,58,237,.3)}
    .btn-primary:active{transform:translateY(0)}
    .btn:disabled{opacity:.45;cursor:not-allowed;transform:none!important;box-shadow:none!important}
    .btn-outline{background:transparent;border:1.5px solid var(--border);color:#475569;box-shadow:none}
    .btn-outline:hover{border-color:var(--p);color:var(--p);background:var(--p-lighter)}
    .btn-sm{padding:8px 14px;font-size:12px;border-radius:10px}
    .btn-full{width:100%}
    .btn-lg{padding:14px 28px;font-size:15px;border-radius:14px;font-weight:700}
    .btn-generate{background:linear-gradient(135deg,var(--p) 0%,#9333ea 100%);color:#fff;box-shadow:0 2px 8px rgba(124,58,237,.3);width:100%;padding:16px 24px;font-size:15px;font-weight:700;border-radius:14px;letter-spacing:-.2px}
    .btn-generate:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(124,58,237,.35)}
    .btn-generate:active{transform:translateY(0)}
    .btn-danger-outline{background:transparent;border:1.5px solid #fecaca;color:var(--danger)}
    .btn-danger-outline:hover{background:#fef2f2;border-color:var(--danger)}

    /* === WORKSPACE LAYOUT === */
    .workspace{display:grid;grid-template-columns:1fr 340px;gap:28px;align-items:start}

    /* === MODEL PANEL (right sidebar) === */
    .panel{background:var(--card);border-radius:var(--radius);border:1px solid var(--border-light);box-shadow:var(--shadow-sm);overflow:hidden}
    .panel-header{padding:16px 20px;border-bottom:1px solid var(--border-light)}
    .panel-title{font-size:13px;font-weight:700;color:#0f172a;letter-spacing:-.1px}
    .panel-body{padding:20px}

    .active-model-preview{width:100%;border-radius:12px;overflow:hidden;position:relative;background:var(--border-light);margin-bottom:16px}
    .active-model-preview img{width:100%;display:block;object-fit:cover}
    .active-model-desc{text-align:center;font-size:12px;color:var(--muted);margin-bottom:16px}
    .model-divider{height:1px;background:var(--border-light);margin:16px 0}

    /* Model cards horizontal */
    .models-scroll{display:flex;gap:10px;overflow-x:auto;padding:4px 0 8px;scrollbar-width:thin}
    .models-scroll::-webkit-scrollbar{height:4px}
    .models-scroll::-webkit-scrollbar-track{background:transparent}
    .models-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
    .model-card{min-width:72px;max-width:72px;border-radius:12px;border:2px solid var(--border-light);overflow:hidden;background:#fff;flex-shrink:0;transition:all .2s;position:relative;cursor:pointer}
    .model-card:hover{border-color:var(--p);transform:translateY(-2px);box-shadow:var(--shadow-md)}
    .model-card-selected{border-color:var(--p);box-shadow:0 0 0 3px rgba(124,58,237,.12)}
    .model-thumb{width:100%;height:90px;object-fit:cover;display:block}
    .model-card-info{padding:4px 6px;font-size:9px;color:var(--muted);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .model-badge{background:var(--p);color:#fff;font-size:8px;font-weight:700;padding:2px 5px;border-radius:999px;position:absolute;top:4px;left:4px}
    .mc-delete-form{position:absolute;top:3px;right:3px;z-index:2}
    .mc-btn{font-size:10px;padding:2px 5px;border-radius:6px;border:1px solid rgba(255,255,255,.8);background:rgba(255,255,255,.9);cursor:pointer;font-weight:600;transition:.15s;line-height:1}
    .mc-delete{color:var(--danger)}
    .mc-delete:hover{background:#fef2f2;border-color:var(--danger)}
    .model-card-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    /* Create model form */
    details.model-toggle>summary{list-style:none;cursor:pointer}
    details.model-toggle>summary::-webkit-details-marker{display:none}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .form-field{display:flex;flex-direction:column;gap:4px}
    .form-field span{font-size:11px;font-weight:600;color:#475569;letter-spacing:.2px}
    .form-field input,.form-field select{padding:9px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:13px;color:#0f172a;background:#fff;transition:.2s;font-family:inherit;appearance:none;-webkit-appearance:none}
    .form-field select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:30px}
    .form-field input:focus,.form-field select:focus{outline:none;border-color:var(--p);box-shadow:0 0 0 3px rgba(124,58,237,.08)}

    /* === GENERATION FORM (main area) === */
    .section-label{font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;letter-spacing:.3px;text-transform:uppercase;display:flex;align-items:center;gap:6px}
    .section-label svg{width:14px;height:14px;color:var(--muted-light)}
    .section-group{margin-bottom:24px}

    /* Pose selector */
    .pose-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .pose-option{text-align:center;padding:10px 4px;border:1.5px solid var(--border);border-radius:12px;cursor:pointer;transition:all .2s;background:#fff}
    .pose-option:hover{border-color:var(--p);background:var(--p-lighter)}
    .pose-option:has(input:checked){border-color:var(--p);background:var(--p-light);box-shadow:0 0 0 3px rgba(124,58,237,.1)}
    .pose-option input[type="radio"]{display:none}
    .pose-icon{font-size:20px;display:block;margin-bottom:2px}
    .pose-label{font-size:10px;font-weight:600;color:#475569}

    /* Format selector */
    .format-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .format-option{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1.5px solid var(--border);border-radius:12px;cursor:pointer;transition:all .2s;background:#fff}
    .format-option:hover{border-color:var(--p);background:var(--p-lighter)}
    .format-option:has(input:checked){border-color:var(--p);background:var(--p-light);box-shadow:0 0 0 3px rgba(124,58,237,.1)}
    .format-option input[type="radio"]{display:none}
    .format-icon-wrap{width:36px;height:36px;border-radius:8px;background:var(--border-light);display:flex;align-items:center;justify-content:center}
    .format-icon-wrap svg{color:var(--muted)}
    .format-info{display:flex;flex-direction:column;gap:1px}
    .format-label{font-size:13px;font-weight:600;color:#0f172a}
    .format-desc{font-size:11px;color:var(--muted)}

    /* Accessories textarea */
    .accessories-textarea{width:100%;min-height:72px;padding:12px 14px;border:1.5px solid var(--border);border-radius:12px;font-size:13px;font-family:inherit;color:#0f172a;background:#fff;resize:vertical;transition:.2s;box-sizing:border-box;line-height:1.5}
    .accessories-textarea:focus{outline:none;border-color:var(--p);box-shadow:0 0 0 3px rgba(124,58,237,.08)}
    .accessories-textarea::placeholder{color:var(--muted-light)}

    /* Upload area */
    .upload-zone{border:2px dashed var(--border);border-radius:16px;padding:36px 20px;text-align:center;background:#fff;transition:all .2s;cursor:pointer;position:relative}
    .upload-zone:hover{border-color:var(--p);background:var(--p-lighter)}
    .upload-zone.dragover{border-color:var(--p);background:var(--p-light);box-shadow:0 0 0 4px rgba(124,58,237,.1)}
    .upload-zone input[type="file"]{position:absolute;inset:0;opacity:0;cursor:pointer}
    .upload-zone-icon{width:48px;height:48px;margin:0 auto 12px;border-radius:12px;background:var(--p-light);display:flex;align-items:center;justify-content:center}
    .upload-zone-icon svg{width:24px;height:24px;color:var(--p)}
    .upload-zone-title{font-size:14px;font-weight:600;color:#0f172a;margin-bottom:4px}
    .upload-zone-hint{font-size:12px;color:var(--muted-light)}
    .upload-preview{display:none;width:100%;max-height:200px;object-fit:contain;border-radius:12px;margin-top:8px}

    /* === LOADING OVERLAY === */
    .loading-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,.95);backdrop-filter:blur(12px);z-index:9999;justify-content:center;align-items:center}
    .loading-overlay.active{display:flex}
    .loading-card{background:#fff;border-radius:24px;padding:44px 36px;box-shadow:var(--shadow-xl);text-align:center;max-width:380px;width:90%;border:1px solid var(--border-light)}
    .spinner{display:inline-block;width:52px;height:52px;border:3px solid var(--border-light);border-top-color:var(--p);border-radius:50%;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .loading-title{font-size:18px;font-weight:800;color:#0f172a;margin-top:20px;letter-spacing:-.3px}
    .loading-text{margin-top:6px;color:var(--muted);font-size:13px;min-height:20px}
    .loading-progress{margin-top:20px;background:var(--border-light);border-radius:8px;height:4px;overflow:hidden}
    .loading-progress-bar{height:100%;background:linear-gradient(90deg,var(--p),#9333ea);border-radius:8px;transition:width .6s ease;width:0%}
    .loading-steps{margin-top:20px;text-align:left}
    .loading-step{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:12px;color:var(--muted-light);transition:.3s}
    .loading-step.active{color:var(--p-dark);font-weight:600}
    .loading-step.done{color:var(--success)}
    .loading-step-icon{width:18px;text-align:center;font-size:13px}
    .loading-tip{margin-top:20px;font-size:11px;color:var(--muted-light)}

    /* === GALLERY === */
    .gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
    .gallery-item{border-radius:14px;overflow:hidden;border:1px solid var(--border-light);background:#fff;transition:all .2s}
    .gallery-item:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg)}
    .gallery-item img{width:100%;display:block}
    .gallery-meta{display:flex;align-items:center;justify-content:space-between;padding:10px 14px}
    .gallery-date{font-size:11px;color:var(--muted-light)}
    .gallery-dl{font-size:12px;text-decoration:none;color:var(--p);font-weight:600;display:flex;align-items:center;gap:4px;transition:.15s}
    .gallery-dl:hover{color:var(--p-dark)}
    .gallery-dl svg{width:14px;height:14px}
    .empty-state{color:var(--muted-light);font-size:13px;text-align:center;padding:32px 16px}

    /* === MOBILE === */
    .mobile-header{display:none;padding:16px 20px;background:#fff;border-bottom:1px solid var(--border-light);position:sticky;top:0;z-index:100}
    .mobile-header-inner{display:flex;align-items:center;justify-content:space-between}
    .mobile-logo{font-size:18px;font-weight:800;color:var(--p-dark);letter-spacing:-.3px}
    .mobile-credits{font-size:12px;font-weight:700;color:var(--p-dark);background:var(--p-light);padding:5px 12px;border-radius:999px}
    .format-grid-stacked{grid-template-columns:1fr}
    .format-accessories-row{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
    @media(max-width:960px){
      .sidebar{display:none}
      .main-content{margin-left:0}
      .main-header{display:none}
      .mobile-header{display:block}
      .workspace{grid-template-columns:1fr;gap:20px}
      .main-body{padding:20px 16px}
      .form-grid{grid-template-columns:1fr}
      .format-accessories-row{grid-template-columns:1fr}
      .format-grid-stacked{grid-template-columns:1fr 1fr}
      .gallery-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
    }
  </style></head><body>

  <div class="mobile-header">
    <div class="mobile-header-inner">
      <span class="mobile-logo">Corner IA</span>
      <span class="mobile-credits"><span id="creditCountMobile">${Number(credits) || 0}</span> cr&eacute;ditos</span>
    </div>
  </div>

  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-logo">
        <svg viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="8" fill="#7c3aed"/><path d="M8 14l4 4 8-8" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Corner IA
      </div>

      <nav class="sidebar-nav">
        <div class="nav-section">Criar</div>
        <div class="nav-item active" data-nav="generate">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          Prova Virtual
        </div>
        <div class="nav-item" data-nav="models">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          Modelos
        </div>
        <div class="nav-item" data-nav="gallery">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          Galeria
        </div>

        <div class="nav-section">Conta</div>
        <a href="/collections/all" target="_blank" class="nav-item" style="text-decoration:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>
          Comprar cr&eacute;ditos
        </a>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-credits">
          <div class="sidebar-credits-info">
            <span class="sidebar-credits-label">Cr&eacute;ditos</span>
            <span class="sidebar-credits-value"><span id="creditCount">${Number(credits) || 0}</span></span>
          </div>
          <a href="/collections/all" target="_blank" class="sidebar-buy">Comprar</a>
        </div>
        <div class="sidebar-user">
          <div class="sidebar-user-avatar">${safeEmail.charAt(0).toUpperCase()}</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-email">${safeEmail}</div>
          </div>
        </div>
      </div>
    </aside>

    <main class="main-content">
      <header class="main-header">
        <h1>Prova Virtual</h1>
        <div class="main-header-pills">
          <span class="header-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            <span id="creditCount2">${Number(credits) || 0}</span> cr&eacute;ditos
          </span>
        </div>
      </header>

      <div class="main-body">
        <div id="errorBox" class="msg msg-error"></div>
        <div id="statusBox" class="msg msg-success"></div>

        <div class="workspace">
          <div>
            <div class="card" id="generateCard" ${!selectedModel ? 'style="display:none"' : ""}>
              <div class="card-header">
                <span class="card-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                  Gerar Prova Virtual
                </span>
                <span style="font-size:11px;color:var(--muted)">1 cr&eacute;dito por gera&ccedil;&atilde;o</span>
              </div>
              <div class="card-body">
                <form id="generateForm" enctype="multipart/form-data" method="POST" action="${FUNCTION_URL}">
                  <input type="hidden" name="customerId" value="${escapeHtml(customerId)}" />
                  <input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}" />
                  <input type="hidden" name="action" value="generate" />
                  <input type="hidden" name="modelId" id="selectedModelId" value="${escapeHtml(selectedModel?.id || '')}" />
                  <input type="hidden" name="model" id="selectedModelUrl" value="${escapeHtml(selectedModel?.imageUrl || '')}" />
                  <input type="hidden" name="_return" value="${escapeHtml(pathPrefix)}" />

                  <div class="section-group">
                    <div class="section-label">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      Imagem da roupa
                    </div>
                    <div class="upload-zone" id="garmentDrop">
                      <input type="file" name="garment" accept="image/*" id="garmentInput" required />
                      <div class="upload-zone-icon drop-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      </div>
                      <div class="upload-zone-title drop-title">Arraste ou clique para enviar</div>
                      <div class="upload-zone-hint drop-hint">JPG, PNG, WEBP &mdash; at&eacute; 12MB</div>
                      <img class="upload-preview" id="garmentPreview" alt="Preview" />
                    </div>
                    
                    <div style="margin-top: 16px; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
                      <h4 style="margin: 0 0 10px 0; font-size: 13px; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                        💡 Como enviar a foto da roupa
                      </h4>
                      <p style="font-size: 11px; color: #475569; margin: 0 0 10px 0; line-height: 1.4;">
                        Para um resultado perfeito, a foto deve ser limpa. Evite fotos de pessoas vestindo a pe&ccedil;a (Lifestyle). Siga a ordem de qualidade:
                      </p>
                      <ul style="font-size: 11px; color: #475569; padding-left: 18px; margin: 0; line-height: 1.6;">
                        <li><strong style="color: #10b981;">🌟 Flat Lay (Mais Recomendado):</strong> Roupa esticada sobre uma mesa ou ch&atilde;o liso. Mostra a estampa sem distor&ccedil;&otilde;es.</li>
                        <li><strong>👻 Ghost Mannequin:</strong> Num manequim invis&iacute;vel (fundo apagado). D&aacute; volume 3D &agrave; pe&ccedil;a.</li>
                        <li><strong>🧥 No Cabide:</strong> Pendurada reta num cabide simples contra uma parede lisa.</li>
                      </ul>
                    </div>
                    </div>

                  <div class="section-group">
                    <div class="section-label">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
                      Pose
                    </div>
                    <div class="pose-grid" id="poseGrid">
                      <label class="pose-option"><input type="radio" name="pose" value="frente" checked><span class="pose-icon">\ud83e\uddcd</span><span class="pose-label">Frente</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="frente-mao-cintura"><span class="pose-icon">\ud83d\udc81\u200d\u2640\ufe0f</span><span class="pose-label">M&atilde;o na cintura</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="frente-braco-cruzado"><span class="pose-icon">\ud83e\udd1e</span><span class="pose-label">Bra&ccedil;os cruzados</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="lado"><span class="pose-icon">\ud83e\uddcd\u200d\u2642\ufe0f</span><span class="pose-label">Perfil</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="lado-caminhando"><span class="pose-icon">\ud83d\udeb6\u200d\u2640\ufe0f</span><span class="pose-label">Caminhando</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="costas"><span class="pose-icon">\ud83d\udd04</span><span class="pose-label">Costas</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="tres-quartos"><span class="pose-icon">\u2197\ufe0f</span><span class="pose-label">3/4</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="sentada"><span class="pose-icon">\ud83e\ude91</span><span class="pose-label">Sentada</span></label>
                      <label class="pose-option"><input type="radio" name="pose" value="inclinada"><span class="pose-icon">\ud83e\udd38</span><span class="pose-label">Inclinada</span></label>
                    </div>
                  </div>

                  <div class="format-accessories-row">
                    <div>
                      <div class="section-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
                        Formato
                      </div>
                      <div class="format-grid format-grid-stacked">
                        <label class="format-option"><input type="radio" name="format" value="vertical" checked>
                          <div class="format-icon-wrap"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="2"/></svg></div>
                          <div class="format-info"><span class="format-label">Vertical</span><span class="format-desc">1080&times;1350</span></div>
                        </label>
                        <label class="format-option"><input type="radio" name="format" value="square">
                          <div class="format-icon-wrap"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></div>
                          <div class="format-info"><span class="format-label">Quadrado</span><span class="format-desc">1080&times;1080</span></div>
                        </label>
                      </div>
                    </div>
                    <div>
                      <div class="section-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 110 20 10 10 0 010-20z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg>
                        Acess&oacute;rios <span style="font-weight:400;color:var(--muted-light)">(opcional)</span>
                      </div>
                      <textarea name="accessories" id="accessoriesInput" class="accessories-textarea" placeholder="Colar de prata, brincos, scarpin preto, cal&ccedil;a jeans..." maxlength="500"></textarea>
                    </div>
                  </div>

                  <button type="submit" class="btn btn-generate" id="submitBtn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    Gerar prova virtual
                  </button>
                </form>
              </div>
            </div>

            ${!selectedModel ? `
            <div class="card">
              <div class="card-body" style="text-align:center;padding:48px 24px">
                <div style="font-size:48px;margin-bottom:16px">\ud83d\udc64</div>
                <div style="font-size:18px;font-weight:700;color:#0f172a;margin-bottom:8px">Crie sua primeira modelo</div>
                <div style="font-size:13px;color:var(--muted);margin-bottom:20px;max-width:320px;margin-left:auto;margin-right:auto">Para come&ccedil;ar a gerar provas virtuais, crie uma modelo IA no painel ao lado.</div>
              </div>
            </div>` : ""}

            <div class="card">
              <div class="card-header">
                <span class="card-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  Galeria
                </span>
                <span style="font-size:11px;color:var(--muted)">${(generations || []).length} imagen${(generations || []).length !== 1 ? "s" : ""}</span>
              </div>
              <div class="card-body">
                <div id="galleryGrid" class="gallery-grid">
                  ${galleryItems || '<div class="empty-state">Nenhuma imagem gerada ainda.</div>'}
                </div>
              </div>
            </div>
          </div>

          <div>
            <div class="panel" id="activeModelCard">
              <div class="panel-header">
                <span class="panel-title">Modelo Ativa</span>
              </div>
              <div class="panel-body">
                ${selectedModel ? `
                <div class="active-model-preview">
                  <img src="${escapeHtml(selectedModel.imageUrl)}" alt="Modelo ativa" id="activeModelImg" />
                </div>
                <div class="active-model-desc" id="activeModelDesc">
                  ${selectedModel.attributes ? [
                    selectedModel.attributes.age ? `${escapeHtml(selectedModel.attributes.age)} anos` : "",
                    selectedModel.attributes.ethnicity ? escapeHtml(selectedModel.attributes.ethnicity) : "",
                    selectedModel.attributes.bodyType ? escapeHtml(selectedModel.attributes.bodyType) : "",
                    selectedModel.attributes.hairColor ? `cabelo ${escapeHtml(selectedModel.attributes.hairColor)}` : "",
                  ].filter(Boolean).join(" &middot; ") : "Modelo IA"}
                </div>
                ` : `<div class="empty-state" style="padding:24px 8px">Nenhuma modelo selecionada</div>`}
              </div>
            </div>

            <div class="panel" style="margin-top:16px" id="modelsCard">
              <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between">
                <span class="panel-title">Suas Modelos</span>
                <span style="font-size:11px;color:var(--muted)">${models.length} modelo${models.length !== 1 ? "s" : ""}</span>
              </div>
              <div class="panel-body">
                ${models.length > 0 ? `
                <div class="models-scroll" id="modelsList">
                  ${modelCards}
                </div>` : '<div class="empty-state" id="noModelsMsg" style="padding:12px 0">Nenhuma modelo criada.</div>'}

                <div class="model-divider"></div>

                <details class="model-toggle" id="createModelDetails">
                  <summary class="btn btn-outline btn-sm btn-full" style="margin-top:4px">+ Criar nova modelo</summary>
                  <div style="margin-top:16px">
                    <form id="createModelForm" method="POST" action="${FUNCTION_URL}">
                      <input type="hidden" name="customerId" value="${escapeHtml(customerId)}" />
                      <input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}" />
                      <input type="hidden" name="action" value="createModel" />
                      <input type="hidden" name="_return" value="${escapeHtml(pathPrefix)}" />
                      <div class="form-grid">
                        <label class="form-field"><span>Idade</span><input type="number" name="age" value="25" min="16" max="80" /></label>
                        <label class="form-field"><span>Etnia</span><select name="ethnicity"><option value="branca">Branca</option><option value="negra">Negra</option><option value="asiatica">Asi&aacute;tica</option><option value="latina" selected>Latina</option><option value="indiana">Indiana</option><option value="arabe">&Aacute;rabe</option></select></label>
                        <label class="form-field"><span>Biotipo</span><select name="bodyType"><option value="magra">Magra</option><option value="media" selected>M&eacute;dia</option><option value="atletica">Atl&eacute;tica</option><option value="plus">Plus Size</option></select></label>
                        <label class="form-field"><span>Cor do cabelo</span><select name="hairColor"><option value="preto">Preto</option><option value="castanho" selected>Castanho</option><option value="loiro">Loiro</option><option value="ruivo">Ruivo</option><option value="platinado">Platinado</option><option value="rosa">Rosa</option></select></label>
                        <label class="form-field"><span>Comprimento</span><select name="hairLength"><option value="curto">Curto</option><option value="medio">M&eacute;dio</option><option value="longo" selected>Longo</option></select></label>
                        <label class="form-field"><span>Cor dos olhos</span><select name="eyeColor"><option value="castanhos" selected>Castanhos</option><option value="azuis">Azuis</option><option value="verdes">Verdes</option><option value="pretos">Pretos</option><option value="mel">Mel</option></select></label>
                        <label class="form-field"><span>Altura</span><select name="height"><option value="baixa">Baixa</option><option value="media" selected>M&eacute;dia</option><option value="alta">Alta</option></select></label>
                        <label class="form-field"><span>Tom de pele</span><select name="skinTone"><option value="clara">Clara</option><option value="media" selected>M&eacute;dia</option><option value="morena">Morena</option><option value="escura">Escura</option></select></label>
                      </div>
                      <div style="margin-top:14px">
                        <button type="submit" class="btn btn-primary btn-full btn-sm" id="createModelBtn">Gerar modelo</button>
                      </div>
                    </form>
                  </div>
                </details>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <div class="loading-overlay" id="loading">
    <div class="loading-card">
      <div class="spinner"></div>
      <div class="loading-title" id="loadingTitle">Gerando imagem...</div>
      <div class="loading-text" id="loadingText">Preparando...</div>
      <div class="loading-progress"><div class="loading-progress-bar" id="loadingBar"></div></div>
      <div class="loading-steps" id="loadingSteps">
        <div class="loading-step active" data-step="1"><span class="loading-step-icon">\u23f3</span> Analisando a pe&ccedil;a de roupa</div>
        <div class="loading-step" data-step="2"><span class="loading-step-icon">\u23f3</span> Preparando a modelo</div>
        <div class="loading-step" data-step="3"><span class="loading-step-icon">\u23f3</span> Gerando imagem com IA</div>
        <div class="loading-step" data-step="4"><span class="loading-step-icon">\u23f3</span> Otimizando resultado</div>
      </div>
      <div class="loading-tip">Isso pode levar at&eacute; 60 segundos</div>
    </div>
  </div>

  <div id="appConfig" data-api="${FUNCTION_URL}" data-cid="${escapeHtml(customerId)}" data-token="${escapeHtml(sessionToken)}" style="display:none"></div>
  <script>
  (function(){
    var cfg=document.getElementById("appConfig");
    if(!cfg)return;
    var API=cfg.dataset.api,CID=cfg.dataset.cid,TOKEN=cfg.dataset.token;

    document.querySelectorAll(".model-card[data-model-id]").forEach(function(card){
      card.addEventListener("click",function(e){
        if(e.target.closest(".mc-delete-form"))return;
        var id=card.dataset.modelId,url=card.dataset.modelUrl;
        document.querySelectorAll(".model-card").forEach(function(c){
          c.classList.remove("model-card-selected");
          var b=c.querySelector(".model-badge");if(b)b.remove();
        });
        card.classList.add("model-card-selected");
        var info=card.querySelector(".model-card-info");
        if(info){var b=document.createElement("span");b.className="model-badge";b.textContent="Ativa";info.appendChild(b);}
        var ai=document.getElementById("activeModelImg");if(ai)ai.src=url;
        var mi=document.getElementById("selectedModelId");if(mi)mi.value=id;
        var mu=document.getElementById("selectedModelUrl");if(mu)mu.value=url;
        var gc=document.getElementById("generateCard");if(gc)gc.style.display="";
        var fd=new FormData();
        fd.append("customerId",CID);fd.append("sessionToken",TOKEN);
        fd.append("action","selectModel");fd.append("modelId",id);
        fetch(API,{method:"POST",body:fd}).catch(function(){});
      });
    });

    document.querySelectorAll(".mc-delete-form").forEach(function(f){
      f.addEventListener("submit",function(e){
        if(!confirm("Excluir esta modelo?"))e.preventDefault();
      });
    });
  })();
  </script>
  <script src="${FUNCTION_URL}?_resource=js"></script>
</body></html>`;
}


/* =========================================
   CLIENT JAVASCRIPT
========================================= */
function getClientJS() {
  return `try {

function cornerIaInit() {
  var cfg = document.getElementById("appConfig");
  if (!cfg) return;

  var API_URL = cfg.getAttribute("data-api");
  var CID = cfg.getAttribute("data-cid");
  var TOKEN = cfg.getAttribute("data-token");

  var errorBox = document.getElementById("errorBox");
  var statusBox = document.getElementById("statusBox");
  var loading = document.getElementById("loading");
  var loadingText = document.getElementById("loadingText");
  var loadingTitle = document.getElementById("loadingTitle");
  var loadingBar = document.getElementById("loadingBar");
  var loadingSteps = document.getElementById("loadingSteps");
  var latestResult = document.getElementById("latestResult");
  var latestImg = document.getElementById("latestImg");
  var latestDl = document.getElementById("latestDl");
  var creditCount = document.getElementById("creditCount");
  var creditCount2 = document.getElementById("creditCount2");
  var galleryGrid = document.getElementById("galleryGrid");

  var loadingInterval = null;
  function startLoadingAnimation() {
    if (!loading) return;
    loading.classList.add("active");
    if (loadingBar) loadingBar.style.width = "0%";
    var steps = loadingSteps ? loadingSteps.querySelectorAll(".loading-step") : [];
    for (var i = 0; i < steps.length; i++) {
      steps[i].className = "loading-step";
      steps[i].querySelector(".loading-step-icon").textContent = "\\u23F3";
    }
    if (steps.length > 0) { steps[0].className = "loading-step active"; }

    var messages = [
      { step: 0, pct: 5, title: "Analisando roupa...", text: "Identificando detalhes da peca" },
      { step: 0, pct: 15, title: "Analisando roupa...", text: "Contando botoes, bolsos e detalhes" },
      { step: 1, pct: 25, title: "Preparando modelo...", text: "Carregando imagem da modelo" },
      { step: 1, pct: 35, title: "Preparando modelo...", text: "Configurando pose e acessorios" },
      { step: 2, pct: 45, title: "Gerando imagem...", text: "Enviando para a IA" },
      { step: 2, pct: 55, title: "Gerando imagem...", text: "A IA esta criando sua imagem" },
      { step: 2, pct: 65, title: "Gerando imagem...", text: "Isso pode demorar um pouco..." },
      { step: 2, pct: 75, title: "Gerando imagem...", text: "Quase la! Aguarde..." },
      { step: 3, pct: 85, title: "Finalizando...", text: "Otimizando qualidade da imagem" },
      { step: 3, pct: 92, title: "Finalizando...", text: "Salvando resultado" },
    ];
    var msgIndex = 0;

    function advanceStep(to) {
      for (var i = 0; i < steps.length; i++) {
        if (i < to) {
          steps[i].className = "loading-step done";
          steps[i].querySelector(".loading-step-icon").textContent = "\\u2705";
        } else if (i === to) {
          steps[i].className = "loading-step active";
          steps[i].querySelector(".loading-step-icon").textContent = "\\u23F3";
        } else {
          steps[i].className = "loading-step";
        }
      }
    }

    loadingInterval = setInterval(function() {
      if (msgIndex >= messages.length) { clearInterval(loadingInterval); return; }
      var m = messages[msgIndex];
      if (loadingTitle) loadingTitle.textContent = m.title;
      if (loadingText) loadingText.textContent = m.text;
      if (loadingBar) loadingBar.style.width = m.pct + "%";
      advanceStep(m.step);
      msgIndex++;
    }, 4000);
  }

  function stopLoadingAnimation(success) {
    if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = null; }
    if (loading) {
      if (success) {
        if (loadingBar) loadingBar.style.width = "100%";
        if (loadingTitle) loadingTitle.textContent = "Pronto!";
        if (loadingText) loadingText.textContent = "Imagem gerada com sucesso";
        var steps = loadingSteps ? loadingSteps.querySelectorAll(".loading-step") : [];
        for (var i = 0; i < steps.length; i++) {
          steps[i].className = "loading-step done";
          steps[i].querySelector(".loading-step-icon").textContent = "\\u2705";
        }
        setTimeout(function() { loading.classList.remove("active"); }, 1200);
      } else {
        loading.classList.remove("active");
      }
    }
  }

  function showError(msg) {
    if (errorBox) { errorBox.textContent = msg; errorBox.style.display = "block"; }
    if (statusBox) statusBox.style.display = "none";
    window.scrollTo({top:0, behavior:"smooth"});
  }
  function showStatus(msg) {
    if (statusBox) { statusBox.textContent = msg; statusBox.style.display = "block"; }
    if (errorBox) errorBox.style.display = "none";
  }
  function hideMessages() {
    if (errorBox) errorBox.style.display = "none";
    if (statusBox) statusBox.style.display = "none";
  }
  function updateCredits(n) {
    if (creditCount) creditCount.textContent = n;
    if (creditCount2) creditCount2.textContent = n;
    var cm = document.getElementById("creditCountMobile");
    if (cm) cm.textContent = n;
  }

  /* Safe fetch helper */
  function safeFetch(url, opts) {
    return fetch(url, opts).then(function(r) {
      var ct = r.headers.get("content-type") || "";
      if (ct.indexOf("application/json") === -1) {
        return r.text().then(function(txt) {
          return { ok: false, data: { error: "Resposta inesperada do servidor (status " + r.status + ")." } };
        });
      }
      return r.json().then(function(d) { return { ok: r.ok, data: d }; });
    });
  }

  /* --- Drop zone / File preview --- */
  var zone = document.getElementById("garmentDrop");
  var fileInput = document.getElementById("garmentInput");
  var preview = document.getElementById("garmentPreview");

  if (zone && fileInput) {
    zone.addEventListener("dragover", function(e) { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", function() { zone.classList.remove("dragover"); });
    zone.addEventListener("drop", function(e) {
      e.preventDefault();
      zone.classList.remove("dragover");
      if (e.dataTransfer && e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        showFilePreview(fileInput.files[0]);
      }
    });
    fileInput.addEventListener("change", function() {
      if (fileInput.files.length) showFilePreview(fileInput.files[0]);
    });
  }

  /* --- FEEDBACK DE UPLOAD CORRIGIDO (Animação + Imagem + Check Verde) --- */
  function showFilePreview(file) {
    if (!preview || !file) return;
    var fileName = file.name;
    
    // Esconde os textos originais com segurança
    var texts = zone.querySelectorAll(".drop-icon, .drop-title, .drop-hint");
    for (var i = 0; i < texts.length; i++) texts[i].style.display = "none";
    
    // Adiciona o Spinner Temporário (sem destruir o input)
    var tempLoading = document.createElement("div");
    tempLoading.id = "tempLoading";
    tempLoading.innerHTML = '<div style="width: 28px; height: 28px; border: 3px solid #e2e8f0; border-top: 3px solid #7c3aed; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 10px;"></div><div style="font-size: 13px; color: #475569; font-weight: 600;">Lendo arquivo...</div>';
    zone.appendChild(tempLoading);

    // Usa o FileReader para mostrar a miniatura real da foto enviada
    var reader = new FileReader();
    reader.onload = function(ev) {
      setTimeout(function() {
        var tl = document.getElementById("tempLoading");
        if (tl) tl.remove();

        // Mostra a imagem
        preview.src = ev.target.result;
        preview.style.display = "block";
        preview.style.marginTop = "0";

        // Estiliza o fundo de verde
        zone.style.borderColor = '#10b981';
        zone.style.backgroundColor = '#ecfdf5';

        // Cria a etiqueta de Sucesso Verde
        var existingBadge = document.getElementById('successBadge');
        if(!existingBadge) {
          var badge = document.createElement('div');
          badge.id = 'successBadge';
          badge.innerHTML = '✅ Upload Concluído!<br><span style="font-size:11px; font-weight:normal;">' + fileName + '</span>';
          badge.style.cssText = 'font-size: 14px; font-weight: 700; color: #10b981; margin-top: 12px; padding: 8px 12px; background: #d1fae5; border-radius: 8px; display: inline-block; width: 100%; box-sizing: border-box; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
          zone.appendChild(badge);
        } else {
          existingBadge.innerHTML = '✅ Upload Concluído!<br><span style="font-size:11px; font-weight:normal;">' + fileName + '</span>';
        }
      }, 500); // pequeno delay para a animação aparecer
    };
    reader.readAsDataURL(file);
  }

  /* --- Create Model form --- */
  var createForm = document.getElementById("createModelForm");
  var createBtn = document.getElementById("createModelBtn");
  if (createForm && createBtn) {
    createForm.addEventListener("submit", function(e) {
      e.preventDefault();
      hideMessages();
      var formData = new FormData(createForm);
      createBtn.disabled = true;
      createBtn.textContent = "Gerando...";
      if (loading) loading.classList.add("active");
      if (loadingTitle) loadingTitle.textContent = "Criando modelo...";
      if (loadingText) loadingText.textContent = "Gerando sua modelo IA";
      if (loadingBar) loadingBar.style.width = "30%";

      safeFetch(API_URL, { method: "POST", body: formData })
        .then(function(res) {
          if (!res.ok || res.data.error) { if (loading) loading.classList.remove("active"); showError(res.data.error || "Erro ao gerar modelo."); return; }
          if (loadingBar) loadingBar.style.width = "100%";
          if (loadingTitle) loadingTitle.textContent = "Pronto!";
          if (loadingText) loadingText.textContent = "Modelo criada com sucesso";
          showStatus("Modelo criada com sucesso! Recarregando...");
          setTimeout(function() { location.reload(); }, 1500);
        })
        .catch(function(err) { if (loading) loading.classList.remove("active"); showError("Erro de rede: " + err.message); })
        .finally(function() { createBtn.disabled = false; createBtn.textContent = "Gerar modelo"; });
    });
  }

  /* --- Select Model --- */
  function selectModel(modelId) {
    showStatus("Selecionando modelo...");
    var fd = new FormData();
    fd.append("customerId", CID);
    fd.append("sessionToken", TOKEN);
    fd.append("action", "selectModel");
    fd.append("modelId", modelId);

    safeFetch(API_URL, { method: "POST", body: fd })
      .then(function(res) {
        if (!res.ok || res.data.error) { showError(res.data.error || "Erro ao selecionar modelo."); return; }
        showStatus("Modelo selecionada! Recarregando...");
        setTimeout(function() { location.reload(); }, 800);
      })
      .catch(function(err) { showError("Erro de rede: " + err.message); });
  }

  /* --- Delete Model --- */
  function deleteModel(modelId) {
    if (!confirm("Excluir esta modelo?")) return;
    showStatus("Excluindo modelo...");
    var fd = new FormData();
    fd.append("customerId", CID);
    fd.append("sessionToken", TOKEN);
    fd.append("action", "deleteModel");
    fd.append("modelId", modelId);

    safeFetch(API_URL, { method: "POST", body: fd })
      .then(function(res) {
        if (!res.ok || res.data.error) { showError(res.data.error || "Erro ao excluir modelo."); return; }
        location.reload();
      })
      .catch(function(err) { showError("Erro de rede: " + err.message); });
  }

  /* --- Bind model card buttons --- */
  document.addEventListener("click", function(e) {
    var selBtn = e.target.closest ? e.target.closest(".mc-select") : null;
    if (selBtn) {
      e.preventDefault();
      e.stopPropagation();
      selectModel(selBtn.getAttribute("data-id"));
      return;
    }
    var delBtn = e.target.closest ? e.target.closest(".mc-delete") : null;
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      deleteModel(delBtn.getAttribute("data-id"));
      return;
    }
  });

  /* --- Generate form --- */
  var genForm = document.getElementById("generateForm");
  var submitBtn = document.getElementById("submitBtn");
  if (genForm && submitBtn) {
    genForm.addEventListener("submit", function(e) {
      e.preventDefault();
      hideMessages();
      var formData = new FormData(genForm);
      var garment = formData.get("garment");
      if (!garment || !garment.size) { showError("Envie a imagem da roupa."); return; }
      if (garment.size > 12 * 1024 * 1024) { showError("Arquivo muito grande. Maximo 12MB."); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "Gerando...";
      startLoadingAnimation();
      if (latestResult) latestResult.style.display = "none";

      safeFetch(API_URL, { method: "POST", body: formData })
        .then(function(res) {
          var data = res.data;
          if (!res.ok || data.error) {
            stopLoadingAnimation(false);
            showError(data.error || "Erro ao gerar imagem.");
            if (typeof data.credits === "number") updateCredits(data.credits);
            return;
          }
          showStatus("Imagem gerada com sucesso!");
          stopLoadingAnimation(true);
          updateCredits(data.credits);
          if (latestImg) latestImg.src = data.imageUrl;
          if (latestDl) latestDl.href = data.imageUrl;
          if (latestResult) latestResult.style.display = "block";
          if (galleryGrid) {
            var empty = galleryGrid.querySelector(".empty-state");
            if (empty) empty.remove();
            var item = document.createElement("div"); item.className = "gallery-item";
            var img = document.createElement("img"); img.src = data.imageUrl; img.alt = "Gerada"; img.loading = "lazy";
            var meta = document.createElement("div"); meta.className = "gallery-meta";
            var dt = document.createElement("span"); dt.className = "gallery-date"; dt.textContent = data.date || "Agora";
            var dl = document.createElement("a"); dl.className = "gallery-dl"; dl.href = data.imageUrl; dl.download = ""; dl.textContent = "Baixar";
            meta.appendChild(dt); meta.appendChild(dl);
            item.appendChild(img); item.appendChild(meta);
            galleryGrid.insertBefore(item, galleryGrid.firstChild);
          }
          
          // Reseta a caixa de upload para o estado original
          if (fileInput) fileInput.value = "";
          if (preview) { preview.style.display = "none"; preview.src = ""; }
          if (zone) {
             zone.style.borderColor = 'var(--border)';
             zone.style.backgroundColor = '#fff';
             var t = zone.querySelectorAll(".drop-icon, .drop-title, .drop-hint");
             for (var i=0;i<t.length;i++) t[i].style.display = "";
             var b = document.getElementById('successBadge');
             if (b) b.remove();
          }
        })
        .catch(function(err) { stopLoadingAnimation(false); showError("Erro de rede: " + err.message); })
        .finally(function() { submitBtn.disabled = false; submitBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Gerar prova virtual'; });
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", cornerIaInit);
} else {
  cornerIaInit();
}

} catch(fatalErr) {
  console.error("[Corner IA] FATAL:", fatalErr);
  var eb = document.getElementById("errorBox");
  if (eb) { eb.style.display = "block"; eb.textContent = "Erro JS: " + fatalErr.message; }
}`;
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
    memory: "1GiB",
  },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      /* ========== TEMP: Add credits for testing ========== */
      if (req.method === "GET" && req.query._admin === "addCredits") {
        const uid = req.query.uid;
        if (!uid) {
          const allUsers = await db.collection("users").get();
          const list = allUsers.docs.map(d => ({ id: d.id, email: d.data().email, credits: d.data().credits }));
          return res.json(list);
        }
        await db.collection("users").doc(uid).update({ credits: admin.firestore.FieldValue.increment(50) });
        const snap = await db.collection("users").doc(uid).get();
        return res.json({ ok: true, credits: snap.data()?.credits });
      }

      /* ========== Serve client JS ========== */
      if (req.method === "GET" && req.query._resource === "js") {
        res.set("Content-Type", "application/javascript; charset=utf-8");
        res.set("Cache-Control", "no-cache, no-store, must-revalidate");
        res.set("Access-Control-Allow-Origin", "*");
        return res.send(getClientJS());
      }

      /* ========== POST ========== */
      if (req.method === "POST") {
        const _isFormNav = (req.headers.accept || "").includes("text/html");
        let _redirectUrl = req.headers.referer || req.headers.origin || "";
        if (_isFormNav) {
          res.json = function(data) {
            if (data && data.success && _redirectUrl) return res.redirect(303, _redirectUrl);
            res.set("Content-Type", "text/html; charset=utf-8");
            if (data && data.error) return res.send(renderResponseHtml({ title: "Erro", icon: "⚠️", message: data.error }));
            if (data && data.success) return res.send(renderResponseHtml({ title: "Sucesso!", icon: "✅", message: "Operação realizada.", autoBack: true }));
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
            error: tooLarge ? "Arquivo muito grande. Máximo 12MB." : "Formato de upload inválido.",
          });
        }

        const _return = String(parsed.fields?._return || "");
        const _origin = req.headers.origin || "";
        if (_return && _origin) _redirectUrl = _origin + _return;

        const customerId = String(parsed.fields?.customerId || "");
        const sessionToken = String(parsed.fields?.sessionToken || "");
        const action = String(parsed.fields?.action || "generate");

        console.log("POST action:", action, "customerId:", customerId);

        if (!customerId || !verifySessionToken(customerId, sessionToken)) {
          return res.status(403).json({ error: "Sessão expirada. Recarregue a página." });
        }

        const userRef = db.collection("users").doc(customerId);

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
              generationConfig: { responseModalities: ["image", "text"] },
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

            if (!imageBase64) throw new Error("Gemini did not return a model image");

            // Optimize the model image
            const rawBuf = Buffer.from(imageBase64, "base64");
            const { buffer: optBuf, mimeType: optMime } = await optimizeImage(rawBuf);

            const fileName = `models/${customerId}-${Date.now()}.webp`;
            const gcsFile = bucket.file(fileName);

            await gcsFile.save(optBuf, {
              metadata: { contentType: optMime },
              resumable: false,
            });

            const [signedUrl] = await gcsFile.getSignedUrl({
              action: "read",
              version: "v4",
              expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
            });

            // Save new model (keep existing models)
            const newModelRef = await db.collection("users").doc(customerId).collection("models").add({
              referenceImageUrl: signedUrl,
              gcsPath: fileName,
              attributes: modelAttrs,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Set as selected model
            await userRef.update({ selectedModelId: newModelRef.id });

            console.log("Model created:", customerId, fileName);
            return res.status(200).json({ success: true, imageUrl: signedUrl, modelId: newModelRef.id });
          } catch (e) {
            console.error("Create model error:", e);
            return res.status(500).json({ error: "Erro ao gerar a modelo. Tente novamente." });
          }
        }

        /* ========== ACTION: SELECT MODEL ========== */
        if (action === "selectModel") {
          const modelId = String(parsed.fields?.modelId || "");
          if (!modelId) return res.status(400).json({ error: "Modelo não especificada." });

          const modelDoc = await db.collection("users").doc(customerId).collection("models").doc(modelId).get();
          if (!modelDoc.exists) return res.status(404).json({ error: "Modelo não encontrada." });

          await userRef.update({ selectedModelId: modelId });
          return res.status(200).json({ success: true });
        }

        /* ========== ACTION: DELETE MODEL ========== */
        if (action === "deleteModel") {
          const modelId = String(parsed.fields?.modelId || "");
          if (!modelId) return res.status(400).json({ error: "Modelo não especificada." });

          const modelDoc = await db.collection("users").doc(customerId).collection("models").doc(modelId).get();
          if (modelDoc.exists) {
            const gcsPath = modelDoc.data().gcsPath;
            await modelDoc.ref.delete();
            if (gcsPath) {
              try { await bucket.file(gcsPath).delete(); } catch {}
            }
          }

          // If the deleted model was selected, select another one
          const snap = await userRef.get();
          if (snap.data()?.selectedModelId === modelId) {
            const remaining = await db.collection("users").doc(customerId).collection("models")
              .orderBy("createdAt", "desc").limit(1).get();
            await userRef.update({
              selectedModelId: remaining.empty ? admin.firestore.FieldValue.delete() : remaining.docs[0].id,
            });
          }

          return res.status(200).json({ success: true });
        }

        /* ========== ACTION: GENERATE ========== */
        const modelUrl = String(parsed.fields?.model || "");
        const garmentFile = parsed.files?.garment;
        const pose = String(parsed.fields?.pose || "frente");
        const imageFormat = String(parsed.fields?.format || "vertical");
        const accessories = String(parsed.fields?.accessories || "").trim().substring(0, 500);

        if (!modelUrl) return res.status(400).json({ error: "Modelo não encontrada. Recarregue a página." });
        if (!garmentFile) return res.status(400).json({ error: "Envie a imagem da roupa." });

        const txResult = await db.runTransaction(async (tx) => {
          const s = await tx.get(userRef);
          const current = Number(s.data()?.credits || 0);
          if (current < 1) return { ok: false, credits: current };
          tx.update(userRef, { credits: current - 1 });
          return { ok: true, credits: current - 1 };
        });

        if (!txResult.ok) {
          return res.status(402).json({
            error: "Sem créditos. Compre mais créditos para continuar.",
            credits: txResult.credits,
          });
        }

        /* --- Passo A: Analisar roupa --- */
        let garmentAnalysis;
        try {
          garmentAnalysis = await analyzeGarmentWithGemini(garmentFile.buffer, garmentFile.mimetype);
        } catch (e) {
          console.warn("Garment analysis failed:", e.message);
          garmentAnalysis = { full_description: "fashion clothing item" };
        }

        /* --- Passo B: Buscar modelo selecionada --- */
        const modelId = String(parsed.fields?.modelId || "");
        let modelImageUrl = modelUrl;
        let modelAttributes = {};

        if (modelId) {
          try {
            const modelDoc = await db.collection("users").doc(customerId).collection("models").doc(modelId).get();
            if (modelDoc.exists) {
              const modelData = modelDoc.data();
              modelImageUrl = await refreshModelUrl(modelData);
              modelAttributes = modelData.attributes || {};
            }
          } catch (e) {
            console.warn("Failed to fetch model data:", e.message);
          }
        }

        /* --- Passo C: Upload roupa --- */
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

        /* --- Passo D: Prompt --- */
        const textPrompt = buildVirtualTryOnPrompt({
          garmentAnalysis,
          modelAttributes,
          pose,
          accessories,
          imageFormat,
        });

        /* --- Passo E: Gerar imagem --- */
        let finalImage;
        let finalGcsPath;
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const imageModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-image",
            generationConfig: { responseModalities: ["image", "text"] },
          });

          const modelImgResp = await fetch(modelImageUrl);
          if (!modelImgResp.ok) throw new Error(`Failed to fetch model image: ${modelImgResp.status}`);
          const modelImgBuffer = Buffer.from(await modelImgResp.arrayBuffer());
          const modelImgMime = modelImgResp.headers.get("content-type") || "image/png";

          const garmentHasHuman = garmentAnalysis.has_human_model === true;
          const closureInfo = garmentAnalysis.closure_count ? ` Exact button/closure count: ${garmentAnalysis.closure_count}.` : "";
          const beltInfo = garmentAnalysis.has_belt_or_sash === true
            ? ` Has belt/sash/bow: YES — preserve it exactly.`
            : ` Has belt/sash/bow: NO — do NOT add any.`;
          const garmentLabel = garmentHasHuman
            ? `Garment reference image (WARNING: a human model is wearing this garment — IGNORE the person, extract ONLY the clothing design. CRITICAL: reproduce this garment with ZERO modifications. EXACT pattern/print, exact colors, exact fabric texture, exact number of buttons/pockets/details.${closureInfo}${beltInfo} Copy this garment IDENTICALLY):`
            : `Garment to dress the model in (CRITICAL: reproduce this EXACT garment with ZERO modifications. Same pattern/print pixel-for-pixel, same colors, same design, same button count, same pocket count, ALL details identical.${closureInfo}${beltInfo} ANY deviation from this reference is a failure):`;

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

          const parts = result.response.candidates?.[0]?.content?.parts || [];
          let imageBase64 = null;

          for (const part of parts) {
            if (part.inlineData) {
              imageBase64 = part.inlineData.data;
              break;
            }
          }

          if (!imageBase64) throw new Error("Gemini did not return an image");

          // Optimize generated image
          const rawBuf = Buffer.from(imageBase64, "base64");
          const { buffer: optBuf, mimeType: optMime } = await optimizeImage(rawBuf, { format: imageFormat });

          const genFileName = `generations/${customerId}-${Date.now()}.webp`;
          const genFile = bucket.file(genFileName);

          await genFile.save(optBuf, {
            metadata: { contentType: optMime },
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
          console.error("Gemini generation error:", e);
          await userRef.update({ credits: admin.firestore.FieldValue.increment(1) });
          return res.status(500).json({
            error: "Erro ao gerar imagem com IA. Tente novamente.",
            credits: txResult.credits + 1,
          });
        }

        if (!finalImage) {
          await userRef.update({ credits: admin.firestore.FieldValue.increment(1) });
          return res.status(500).json({
            error: "A IA não retornou uma imagem válida. Tente outra foto.",
            credits: txResult.credits + 1,
          });
        }

        const now = new Date();
        const dateStr = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

        await db.collection("users").doc(customerId).collection("generations").add({
          imageUrl: finalImage,
          gcsPath: finalGcsPath || null,
          modelId: parsed.fields?.modelId || null,
          modelUrl: modelImageUrl,
          garmentUrl,
          garmentAnalysis,
          pose,
          promptSnapshot: textPrompt,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          date: dateStr,
        });

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

      /* ========== GET (Shopify App Proxy) ========== */
      if (!verifyShopifyProxy(req)) {
        return res.status(403).send("Unauthorized");
      }

      const customerId = req.query.logged_in_customer_id || req.query.customer_id || null;
      const customerEmail = req.query.logged_in_customer_email || req.query.customer_email || "Cliente";

      if (!customerId) {
        res.set("Content-Type", "application/liquid");
        return res.send(`{% layout none %}<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Inter,Arial,sans-serif;background:#f5f3ff;margin:0;padding:60px 16px}.box{max-width:500px;margin:0 auto;background:#fff;padding:36px;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center}.box a{display:inline-block;margin-top:14px;padding:14px 22px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:12px;font-weight:700}.box p{color:#374151}</style></head><body><div class="box"><h1>Acesso restrito</h1><p>Voc&ecirc; precisa estar logado para usar a ferramenta de IA.</p><a href="/account/login">Fazer login na loja</a></div></body></html>`);
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
      const selectedModelId = snap.data()?.selectedModelId || "";
      const sessionToken = generateSessionToken(String(customerId));

      // Fetch ALL user models (up to 10)
      const modelsSnap = await userRef.collection("models")
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();

      const models = [];
      for (const doc of modelsSnap.docs) {
        const data = doc.data();
        const freshUrl = await refreshModelUrl(data);
        if (freshUrl) {
          models.push({
            id: doc.id,
            imageUrl: freshUrl,
            attributes: data.attributes || {},
          });
        }
      }

      // Determine which model is selected
      let effectiveSelectedId = selectedModelId;
      if (!effectiveSelectedId && models.length > 0) {
        effectiveSelectedId = models[0].id;
      }

      // Fetch generations
      const gensSnap = await userRef.collection("generations")
        .orderBy("createdAt", "desc")
        .limit(20)
        .get();

      const generations = [];
      for (const doc of gensSnap.docs) {
        const d = doc.data();
        if (d.gcsPath || d.imageUrl) {
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
              console.warn("Failed to refresh generation URL:", e.message);
            }
          }
          if (imgUrl) generations.push({ imageUrl: imgUrl, date: d.date || "" });
        }
      }

      const pathPrefix = req.query.path_prefix || "";

      res.set("Content-Type", "application/liquid");
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.send(
        renderPage({
          customerEmail,
          credits,
          customerId: String(customerId),
          sessionToken,
          generations,
          models,
          selectedModelId: effectiveSelectedId,
          pathPrefix,
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