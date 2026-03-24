"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { CREDIT_PACKAGES, CREDIT_PRODUCT_TAG } = require("./credits_config");

const db = admin.firestore();

/**
 * Verifies the Shopify webhook HMAC signature.
 * @param {object} req - Cloud Function request
 * @returns {boolean}
 */
function verifyWebhookHmac(req) {
  const hmacHeader = req.get("x-shopify-hmac-sha256");
  if (!hmacHeader || !process.env.SHOPIFY_SECRET) return false;

  const rawBody = req.rawBody;
  if (!rawBody) return false;

  const generated = crypto
    .createHmac("sha256", process.env.SHOPIFY_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  try {
    const a = Buffer.from(generated, "utf8");
    const b = Buffer.from(String(hmacHeader), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Shopify Webhook handler for orders/paid.
 * Grants credits to customers based on purchased credit packages.
 */
exports.shopifyWebhook = onRequest(
  {
    secrets: ["SHOPIFY_SECRET"],
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req, res) => {
    /* Only accept POST */
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    /* Verify HMAC */
    if (!verifyWebhookHmac(req)) {
      return res.status(401).send("Unauthorized");
    }

    /* Only process orders/paid */
    const topic = req.get("x-shopify-topic") || "";
    if (topic !== "orders/paid") {
      return res.status(200).send("Ignored");
    }

    let order;
    try {
      order = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    const orderId = String(order.id || "");
    const customerId = String(order.customer?.id || "");
    const customerEmail = String(order.customer?.email || order.email || "");

    if (!orderId || !customerId) {
      return res.status(200).send("No customer or order ID");
    }

    /* Idempotency check */
    const processedRef = db.collection("processedOrders").doc(orderId);
    const processedSnap = await processedRef.get();
    if (processedSnap.exists) {
      return res.status(200).send("Already processed");
    }

    /* Calculate total credits from line items */
    const lineItems = order.line_items || [];
    let totalCredits = 0;
    const matchedItems = [];

    for (const item of lineItems) {
      const productId = String(item.product_id || "");
      const quantity = Number(item.quantity) || 0;
      let creditsPerUnit = 0;

      // Check by product ID in CREDIT_PACKAGES
      if (productId && CREDIT_PACKAGES[productId]) {
        creditsPerUnit = CREDIT_PACKAGES[productId];
      }

      // Check by tag
      if (!creditsPerUnit) {
        const tags = String(item.tags || "").toLowerCase();
        if (tags.includes(CREDIT_PRODUCT_TAG)) {
          // Try to extract credits from variant title or properties
          creditsPerUnit = Number(item.variant_title) || 0;
        }
      }

      if (creditsPerUnit > 0) {
        const itemCredits = creditsPerUnit * quantity;
        totalCredits += itemCredits;
        matchedItems.push({
          product_id: productId,
          title: item.title || "",
          quantity,
          creditsPerUnit,
          totalCredits: itemCredits,
        });
      }
    }

    if (totalCredits === 0) {
      return res.status(200).send("No credits");
    }

    /* Firestore transaction: add credits + mark as processed */
    const userRef = db.collection("users").doc(customerId);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);

      if (userSnap.exists) {
        tx.update(userRef, {
          credits: admin.firestore.FieldValue.increment(totalCredits),
        });
      } else {
        tx.set(userRef, {
          customerId,
          email: customerEmail,
          credits: totalCredits,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      tx.set(processedRef, {
        orderId,
        customerId,
        customerEmail,
        creditsAdded: totalCredits,
        matchedItems,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const txRef = userRef.collection("creditTransactions").doc();
      tx.set(txRef, {
        type: "purchase",
        credits: totalCredits,
        orderId,
        matchedItems,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log(
      `✅ ${totalCredits} créditos adicionados para customer ${customerId} — pedido ${orderId}`
    );

    return res.status(200).send("OK");
  }
);
