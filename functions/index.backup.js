"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Replicate = require("replicate");
const Busboy = require("busboy");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

/* =========================================
   🔐 VERIFY SHOPIFY APP PROXY (HMAC/SIGNATURE)
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

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPage({
  formAction,
  customerEmail = "Cliente",
  credits = 0,
  resultImageUrl = "",
  statusMessage = "",
  errorMessage = "",
  selectedModel = "",
}) {
  const safeEmail = escapeHtml(customerEmail);
  const safeStatus = escapeHtml(statusMessage);
  const safeError = escapeHtml(errorMessage);
  const safeAction = escapeHtml(formAction || "/apps/corner-ia");

  // modelos “prontos”
  const model1 =
    "https://firebasestorage.googleapis.com/v0/b/corner-ia-v2.firebasestorage.app/o/models%2FChatGPT%20Image%2024_02_2026%2C%2009_05_24.png?alt=media&token=bc78b1b6-dca6-4d8b-acee-f9655493e76e";
  const model2 =
    "https://firebasestorage.googleapis.com/v0/b/corner-ia-v2.firebasestorage.app/o/models%2FChatGPT%20Image%2024_02_2026%2C%2009_11_29.png?alt=media&token=b1c5f57a-0f77-4a05-a743-c6134a00f388";
  const model3 =
    "https://firebasestorage.googleapis.com/v0/b/corner-ia-v2.firebasestorage.app/o/models%2FChatGPT%20Image%2024_02_2026%2C%2009_19_12.png?alt=media&token=cc00edc3-00eb-40a9-8ea3-d88584f5659c";

  const checked1 = selectedModel ? selectedModel === model1 : true;
  const checked2 = selectedModel === model2;
  const checked3 = selectedModel === model3;

  const resultBlock = resultImageUrl
    ? `
      <div class="result">
        <h3>✅ Resultado</h3>
        <img src="${escapeHtml(resultImageUrl)}" alt="Resultado gerado" />
      </div>
    `
    : "";

  const statusBlock = safeStatus ? `<div class="status">${safeStatus}</div>` : "";
  const errorBlock = safeError
    ? `<div class="error">⚠️ ${safeError}</div>`
    : "";

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Corner IA - Prova Virtual</title>
      <style>
        :root { --p:#7c3aed; --bg:#f5f6fa; --card:#fff; --muted:#6b7280; }
        body { font-family: Inter, Arial, sans-serif; background: var(--bg); margin: 0; padding: 32px 16px; }
        .container { max-width: 920px; margin: 0 auto; background: var(--card); padding: 24px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); }
        h1 { margin: 0 0 10px; font-size: 26px; }
        .meta { display:flex; gap: 16px; flex-wrap: wrap; margin: 10px 0 18px; color:#111827; }
        .pill { background:#f3f4f6; padding: 8px 12px; border-radius: 999px; font-size: 14px; }
        .muted { color: var(--muted); font-size: 14px; margin-top: 6px; }
        .models { display:grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 14px 0 18px; }
        @media (max-width: 860px){ .models{ grid-template-columns:1fr; } }
        .model-card { border: 2px solid #eee; border-radius: 14px; padding: 10px; cursor: pointer; text-align: center; transition: 0.2s; }
        .model-card:hover { border-color: var(--p); }
        .model-card img { width: 100%; border-radius: 10px; display:block; }
        .model-card input { display:none; }
        .model-card .label { margin-top: 8px; font-weight: 600; }
        .model-card input:checked + img { outline: 3px solid var(--p); }
        .section { margin: 18px 0; }
        .row { display:flex; gap: 12px; flex-wrap: wrap; align-items: center; }
        input[type="file"] { padding: 10px; border: 1px solid #e5e7eb; border-radius: 10px; background:#fff; width: 100%; max-width: 520px; }
        button { background: var(--p); color: white; border: none; padding: 12px 18px; border-radius: 12px; font-weight: 700; cursor: pointer; }
        button:disabled { opacity: .6; cursor: not-allowed; }
        .status { margin-top: 14px; padding: 12px 14px; border-radius: 12px; background:#eef2ff; color:#111827; }
        .error { margin-top: 14px; padding: 12px 14px; border-radius: 12px; background:#fff1f2; color:#991b1b; border:1px solid #fecdd3; }
        .result { margin-top: 18px; }
        .result img { width: 100%; border-radius: 14px; border:1px solid #e5e7eb; }
        .buy { margin-top: 10px; font-size: 14px; color: var(--muted); }
        .buy a { color: var(--p); text-decoration: none; font-weight: 700; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>✨ Corner IA - Prova Virtual</h1>

        <div class="meta">
          <div class="pill"><strong>Usuário:</strong> ${safeEmail}</div>
          <div class="pill"><strong>Créditos:</strong> ${Number(credits) || 0}</div>
        </div>

        <div class="muted">1 geração = 1 crédito. Primeiro uso ganha 5 créditos automaticamente.</div>

        ${errorBlock}
        ${statusBlock}

        <form id="generateForm" method="POST" action="${safeAction}" enctype="multipart/form-data">
          <div class="section">
            <h3>1️⃣ Escolha a modelo IA</h3>
            <div class="models">
              <label class="model-card">
                <input type="radio" name="model" value="${model1}" ${checked1 ? "checked" : ""}>
                <img src="${model1}" alt="Modelo loira" />
                <div class="label">Modelo Loira</div>
              </label>

              <label class="model-card">
                <input type="radio" name="model" value="${model2}" ${checked2 ? "checked" : ""}>
                <img src="${model2}" alt="Modelo morena" />
                <div class="label">Modelo Morena</div>
              </label>

              <label class="model-card">
                <input type="radio" name="model" value="${model3}" ${checked3 ? "checked" : ""}>
                <img src="${model3}" alt="Modelo plus size" />
                <div class="label">Plus Size</div>
              </label>
            </div>
          </div>

          <div class="section">
            <h3>2️⃣ Envie a imagem da roupa</h3>
            <div class="row">
              <input type="file" name="garment" accept="image/*" required />
              <button type="submit">Gerar imagem (1 crédito)</button>
            </div>
            <div class="buy">
              Sem créditos? <a href="/collections/all" target="_blank" rel="noreferrer">Comprar pacotes</a>
            </div>
          </div>
        </form>

        ${resultBlock}
      </div>
    </body>
  </html>
  `;
}

async function extractImageUrl(value) {
  if (!value) return "";

  if (typeof value === "string") return value;

  if (typeof value === "object") {
    if (typeof value.url === "string") return value.url;

    if (typeof value.url === "function") {
      try {
        const fromFn = await value.url();
        if (typeof fromFn === "string") return fromFn;
      } catch {
        // ignore and continue to fallback formats
      }
    }

    if (typeof value.href === "string") return value.href;

    if (Array.isArray(value.urls)) {
      for (const candidate of value.urls) {
        const extracted = await extractImageUrl(candidate);
        if (extracted) return extracted;
      }
    }

    const asString = String(value);
    if (/^https?:\/\//i.test(asString)) return asString;
  }

  return "";
}

async function pickFinalImageUrl(output) {
  if (!output) return "";

  if (Array.isArray(output)) {
    for (const item of output) {
      const extracted = await extractImageUrl(item);
      if (extracted) return extracted;
    }
    return "";
  }

  return extractImageUrl(output);
}

async function uploadGarmentAndGetUrl({ customerId, file }) {
  if (!file || !file.buffer) {
    throw new Error("Arquivo de roupa inválido para upload.");
  }

  const ext = (() => {
    const original = file.originalname || "";
    const e = path.extname(original).toLowerCase();
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
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return resolve({
        fields: req.body || {},
        file: null,
        error: new Error("Formato de upload inválido."),
      });
    }

    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      return resolve({
        fields: req.body || {},
        file: null,
        error: new Error("Corpo do upload indisponível."),
      });
    }

    const fields = {};
    let garmentFile = null;
    let fileLimitReached = false;

    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    });

    busboy.on("field", (fieldname, value) => {
      fields[fieldname] = value;
    });

    busboy.on("file", (fieldname, file, info) => {
      const { filename, mimeType } = info;

      if (fieldname !== "garment") {
        file.resume();
        return;
      }

      const chunks = [];

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("limit", () => {
        fileLimitReached = true;
      });

      file.on("end", () => {
        if (fileLimitReached) return;

        garmentFile = {
          originalname: filename || "upload",
          mimetype: mimeType || "application/octet-stream",
          buffer: Buffer.concat(chunks),
        };
      });
    });

    busboy.on("error", (err) => {
      reject(err);
    });

    busboy.on("finish", () => {
      if (fileLimitReached) {
        const limitError = new Error("LIMIT_FILE_SIZE");
        limitError.code = "LIMIT_FILE_SIZE";
        return resolve({ fields, file: null, error: limitError });
      }

      return resolve({ fields, file: garmentFile, error: null });
    });

    busboy.end(req.rawBody);
  });
}

function getFullCurrentUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https")
    .toString()
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "")
    .toString()
    .split(",")[0]
    .trim();
  const original = (req.originalUrl || req.url || "").toString();
  return `${proto}://${host}${original}`;
}

function getShopifyProxyAction(req) {
  const rawPrefix = String(req.query.path_prefix || "").trim();
  if (!rawPrefix) return "/apps/corner-ia";

  try {
    const decoded = decodeURIComponent(rawPrefix);
    if (decoded.startsWith("/")) return decoded;
    return `/${decoded}`;
  } catch {
    if (rawPrefix.startsWith("/")) return rawPrefix;
    return `/${rawPrefix}`;
  }
}

/* =========================================
   🚀 MAIN FUNCTION (SHOPIFY APP PROXY)
========================================= */
exports.shopifyProxy = onRequest(
  { secrets: ["SHOPIFY_SECRET", "REPLICATE_API_TOKEN"] },
  async (req, res) => {
    try {
      if (!verifyShopifyProxy(req)) {
        return res.status(403).send("Unauthorized");
      }

      const customerId =
        req.query.logged_in_customer_id || req.query.customer_id || null;
      const customerEmail =
        req.query.logged_in_customer_email || req.query.customer_email || "Cliente";

      // Action = rota do app proxy na loja (evita POST para /?shop=... e 404)
      const formAction = getShopifyProxyAction(req);

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
              <h1>🔒 Acesso restrito</h1>
              <p>Você precisa estar logado para usar a ferramenta de IA.</p>
              <a href="/account/login">Fazer login na loja</a>
            </div>
          </body></html>
        `);
      }

      const userRef = db.collection("users").doc(String(customerId));

      // Ensure user exists and gets 5 credits on first use
      let snap = await userRef.get();
      if (!snap.exists) {
        await userRef.set({
          customerId: String(customerId),
          email: String(customerEmail || ""),
          credits: 5,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        snap = await userRef.get();
      }

      const credits = Number(snap.data()?.credits || 0);

      if (req.method === "POST") {
        try {
          const parsed = await parseMultipartForm(req);

          if (parsed.error) {
            const isTooLarge = parsed.error.code === "LIMIT_FILE_SIZE";

            return res
              .status(400)
              .send(
                renderPage({
                  formAction,
                  customerEmail,
                  credits,
                  errorMessage: isTooLarge
                    ? "Arquivo muito grande. Limite máximo: 12MB."
                    : "Erro no upload (arquivo inválido ou não suportado).",
                  selectedModel: parsed.fields?.model || req.body?.model || "",
                })
              );
          }

          const modelUrl = String(parsed.fields?.model || req.body?.model || "");
          const garmentFile = parsed.file;

          if (!modelUrl) {
            return res
              .status(400)
              .send(
                renderPage({
                  formAction,
                  customerEmail,
                  credits,
                  errorMessage: "Selecione uma modelo.",
                  selectedModel: "",
                })
              );
          }

          if (!garmentFile) {
            return res
              .status(400)
              .send(
                renderPage({
                  formAction,
                  customerEmail,
                  credits,
                  errorMessage: "Envie a imagem da roupa.",
                  selectedModel: modelUrl,
                })
              );
          }

          // Debit 1 credit with transaction
          const txResult = await db.runTransaction(async (tx) => {
            const s = await tx.get(userRef);
            const current = Number(s.data()?.credits || 0);
            if (current < 1) return { ok: false, credits: current };
            tx.update(userRef, { credits: current - 1 });
            return { ok: true, credits: current - 1 };
          });

          if (!txResult.ok) {
            return res
              .status(402)
              .send(
                renderPage({
                  formAction,
                  customerEmail,
                  credits: txResult.credits,
                  errorMessage: "Sem créditos. Compre mais créditos para continuar.",
                  selectedModel: modelUrl,
                })
              );
          }

          let garmentUrl;
          try {
            garmentUrl = await uploadGarmentAndGetUrl({
              customerId: String(customerId),
              file: garmentFile,
            });
          } catch (e) {
            await userRef.update({
              credits: admin.firestore.FieldValue.increment(1),
            });

            return res
              .status(500)
              .send(
                renderPage({
                  formAction,
                  customerEmail,
                  credits: txResult.credits + 1,
                  errorMessage:
                    "Erro ao enviar imagem da roupa. Tente novamente com outro arquivo.",
                  selectedModel: modelUrl,
                })
              );
          }

          let output;
          try {
            output = await replicate.run("cuuupid/idm-vton", {
              input: {
                garm_img: garmentUrl,
                human_img: modelUrl,
                garment_des: "fashion clothing",
              },
            });
          } catch (e) {
            // refund credit
            await userRef.update({
              credits: admin.firestore.FieldValue.increment(1),
            });

            return res
              .status(500)
              .send(
                renderPage({
                  formAction,
                  customerEmail,
                  credits: txResult.credits + 1,
                  errorMessage:
                    "Erro ao gerar imagem IA (Replicate). Verifique token e logs.",
                  selectedModel: modelUrl,
                })
              );
          }

          const finalImage = await pickFinalImageUrl(output);
          if (!finalImage) {
            // refund credit
            await userRef.update({
              credits: admin.firestore.FieldValue.increment(1),
            });

            return res
              .status(500)
              .send(
                renderPage({
                  formAction,
                  customerEmail,
                  credits: txResult.credits + 1,
                  errorMessage:
                    "A IA não retornou uma imagem válida. Tente outra foto/modelo.",
                  selectedModel: modelUrl,
                })
              );
          }

          return res.status(200).send(
            renderPage({
              formAction,
              customerEmail,
              credits: txResult.credits,
              resultImageUrl: finalImage,
              statusMessage: "✅ Imagem gerada com sucesso!",
              selectedModel: modelUrl,
            })
          );
        } catch (error) {
          console.error("POST ERROR:", {
            message: error?.message,
            code: error?.code,
            contentType: req.headers["content-type"],
          });
          return res.status(500).send(
            renderPage({
              formAction,
              customerEmail,
              credits,
              errorMessage: "Erro interno ao processar a solicitação.",
              selectedModel: req.body?.model || "",
            })
          );
        }
      }

      // GET
      return res.send(
        renderPage({
          formAction,
          customerEmail,
          credits,
          selectedModel: "",
        })
      );
    } catch (err) {
      console.error("TOP LEVEL ERROR:", err);
      res.status(500).send("Erro interno.");
    }
  }
);

