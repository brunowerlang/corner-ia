"use strict";
// v2.1 - Updated garment analyzer model
const admin = require("firebase-admin");

admin.initializeApp();

exports.shopifyProxy = require("./shopify_proxy").shopifyProxy;
exports.shopifyWebhook = require("./shopify_webhook").shopifyWebhook;
