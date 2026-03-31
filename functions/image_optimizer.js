"use strict";

const sharp = require("sharp");

const WEBP_QUALITY = 82;
const MAX_SIZE_BYTES = 500 * 1024; // 500KB

const FORMAT_PRESETS = {
  vertical: { width: 1080, height: 1350 },
  square: { width: 1080, height: 1080 },
};

/**
 * Optimizes an image buffer: resizes to target format with safety padding,
 * converts to WebP, and compresses to stay under MAX_SIZE_BYTES.
 *
 * @param {Buffer} inputBuffer - Raw image buffer (PNG, JPEG, etc.)
 * @param {object} [options]
 * @param {string} [options.format] - "vertical" (1080x1350) or "square" (1080x1080)
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function optimizeImage(inputBuffer, options = {}) {
  const preset = FORMAT_PRESETS[options.format] || FORMAT_PRESETS.vertical;
  let quality = WEBP_QUALITY;

  // Define uma margem de segurança de 15% para não cortar cabeça/pés
  const PADDING_FACTOR = 0.85; 
  const innerWidth = Math.floor(preset.width * PADDING_FACTOR);
  const innerHeight = Math.floor(preset.height * PADDING_FACTOR);
  
  const padX = Math.floor((preset.width - innerWidth) / 2);
  const padY = Math.floor((preset.height - innerHeight) / 2);
  
  const padBottom = preset.height - innerHeight - padY;
  const padRight = preset.width - innerWidth - padX;

  // Fundo transparente para a margem
  const bgConfig = { r: 255, g: 255, b: 255, alpha: 0 };

  // Função encapsulada para o Sharp para facilitar a iteração de qualidade
  const processImage = async (q) => {
    return await sharp(inputBuffer)
      .resize({
        width: innerWidth,
        height: innerHeight,
        fit: "contain", // Mantém a proporção inteira dentro do espaço menor
        background: bgConfig
      })
      .extend({
        top: padY,
        bottom: padBottom,
        left: padX,
        right: padRight,
        background: bgConfig // Adiciona o padding real no tamanho final do preset
      })
      .webp({ quality: q })
      .toBuffer();
  };

  let result = await processImage(quality);

  // Se ainda estiver muito grande, reduz a qualidade gradativamente
  while (result.length > MAX_SIZE_BYTES && quality > 40) {
    quality -= 8;
    result = await processImage(quality);
  }

  return { buffer: result, mimeType: "image/webp" };
}

module.exports = { optimizeImage };