"use strict";

const sharp = require("sharp");

const WEBP_QUALITY = 82;
const MAX_SIZE_BYTES = 500 * 1024; // 500KB

const FORMAT_PRESETS = {
  vertical: { width: 1080, height: 1350 },
  square: { width: 1080, height: 1080 },
};

/**
 * Optimizes an image buffer: resizes to target format, converts to WebP,
 * and compresses to stay under MAX_SIZE_BYTES.
 *
 * @param {Buffer} inputBuffer - Raw image buffer (PNG, JPEG, etc.)
 * @param {object} [options]
 * @param {string} [options.format] - "vertical" (1080x1350) or "square" (1080x1080)
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function optimizeImage(inputBuffer, options = {}) {
  const preset = FORMAT_PRESETS[options.format] || FORMAT_PRESETS.vertical;
  let quality = WEBP_QUALITY;


  let result = await sharp(inputBuffer)
    .resize({
      width: preset.width,
      height: preset.height,
      fit: "cover", // Crop to fill the frame, no borders
      position: sharp.strategy.entropy // Focus crop on the most "interesting" part (usually the subject)
    })
    .webp({ quality })
    .toBuffer();

  // If still too large, reduce quality iteratively
  while (result.length > MAX_SIZE_BYTES && quality > 40) {
    quality -= 8;
    result = await sharp(inputBuffer)
      .resize({
        width: preset.width,
        height: preset.height,
        fit: "cover",
        position: sharp.strategy.entropy
      })
      .webp({ quality })
      .toBuffer();
  }

  return { buffer: result, mimeType: "image/webp" };
}

module.exports = { optimizeImage };
