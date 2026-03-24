"use strict";

/**
 * Credit packages mapping.
 * Keys are Shopify product IDs (as strings), values are the number of credits granted.
 *
 * Fill in with actual Shopify product IDs after configuring the products in the store.
 * Example:
 *   "1234567890": 10,
 *   "9876543210": 50,
 */
const CREDIT_PACKAGES = {
  // "SHOPIFY_PRODUCT_ID": credits,
};

/**
 * Tag used to identify credit products in Shopify.
 * Any line item whose tags include this value will be treated as a credit purchase.
 */
const CREDIT_PRODUCT_TAG = "corner-ia-credits";

module.exports = { CREDIT_PACKAGES, CREDIT_PRODUCT_TAG };
