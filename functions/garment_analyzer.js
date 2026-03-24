"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Analyzes a garment image using Gemini 2.0 Flash and returns
 * a structured JSON description optimized for virtual try-on generation.
 *
 * @param {Buffer} imageBuffer - Raw image buffer
 * @param {string} mimeType   - MIME type (e.g. "image/jpeg")
 * @returns {Promise<object>}  Structured garment analysis
 */
async function analyzeGarmentWithGemini(imageBuffer, mimeType) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });


  const prompt = `You are a fashion garment analysis expert. Analyze the clothing item in this image and return a JSON object.

IMPORTANT: The image may show a human model wearing the garment. If so, IGNORE the person entirely and focus ONLY on analyzing the garment itself. Do NOT let the person's pose, body, or skin influence your garment analysis.

ABSOLUTE RULE: DO NOT invent, add, or imagine any element (belt, sash, bow, ribbon, tie, buttons, pockets, decorative details) that is NOT 100% visible in the garment image. If the garment does NOT have a belt, sash, bow, ribbon, tie, or buttons, you MUST write explicitly: "NO BELT/SASH/BOW/RIBBON/TIE/BUTTONS" and set the corresponding fields to false/none/0. If the garment has NO buttons, set closure_count to 0 and closure to "n/a". If the garment has NO belt/sash/bow, set has_belt_or_sash to false and belt_sash_description to "none". If the garment has NO decorative elements, set decorative_elements to [].

NEVER invent or add any detail that is not present. If in doubt, always choose to OMIT rather than invent. If the garment is plain, say so. If there are no buttons, bows, sashes, or ribbons, state this explicitly. If there is any uncertainty, always answer "none" or 0.

Return a JSON object with the following fields:

- "has_human_model": boolean — true if a person/human model is visible wearing the garment in the image
- "garment_type": string — the type of garment (e.g. "t-shirt", "dress", "jeans", "jacket")
- "fit": string — the fit style (e.g. "slim", "regular", "oversized", "relaxed")
- "length": string — the garment length (e.g. "cropped", "regular", "long", "midi", "maxi")
- "primary_color": string — the main color of the garment
- "secondary_colors": string[] — any additional colors present
- "material_texture": string — the apparent fabric/material (e.g. "cotton", "denim", "silk", "knit", "leather")
- "pattern": string — the pattern if any (e.g. "solid", "striped", "plaid", "floral", "graphic print", "abstract", "geometric", "tropical", "animal print", "tie-dye", "paisley", "polka dot", "checkered")
- "pattern_description": string — a VERY detailed description of the pattern/print. Describe the exact motifs, shapes, figures, illustrations, or repeating elements visible on the fabric. If there is a graphic, describe what it depicts in detail. If it is a repeating pattern, describe the repeating unit, its size, and arrangement. If solid, write "solid color, no pattern". Be extremely specific — this description will be used to reproduce the exact same pattern.
- "pattern_colors": string[] — ALL colors present in the pattern/print, listed from most dominant to least. Include subtle accent colors.
- "pattern_scale": string — the scale of the pattern relative to the garment (e.g. "small/fine repeat", "medium repeat", "large/bold repeat", "all-over single graphic", "n/a for solid")
- "pattern_placement": string — where the pattern appears on the garment (e.g. "all-over entire garment", "chest area only", "front panel only", "sleeves only", "border/hem only", "scattered across fabric")
- "neckline": string — neckline type if applicable (e.g. "crew neck", "v-neck", "collar", "n/a")
- "sleeves": string — sleeve type if applicable (e.g. "short sleeve", "long sleeve", "sleeveless", "n/a")
- "closure": string — closure type if visible (e.g. "buttons", "zipper", "pullover", "n/a")
- "closure_count": number — exact count of closure elements (e.g. number of buttons visible). Count carefully. Use 0 if not applicable.
- "pocket_count": number — exact number of pockets visible on the garment. Use 0 if none.
- "has_belt_or_sash": boolean — true if the garment has any belt, sash, bow, tie, ribbon, waist cinch, or waistband decoration. false if not.
- "belt_sash_description": string — if has_belt_or_sash is true, describe it in detail: type (belt/sash/bow/ribbon/tie), material, color, where it sits (natural waist, high waist, low hip), how it is tied/fastened (bow knot, buckle, simple tie, wrap), its width, and any hardware (buckle, ring, etc.). If has_belt_or_sash is false, write "none".
- "decorative_elements": string[] — exhaustive list of ALL decorative elements on the garment: bows, ribbons, ruffles, frills, lace trim, embroidery, appliqué, beading, sequins, studs, patches, piping, contrast stitching, etc. If none, use empty array [].
- "distinctive_details": string[] — notable design details (e.g. "embroidered logo", "raw hem", "chest pocket", "4 visible buttons", "bow at waist", "self-tie belt")
- "style_category": string — overall style (e.g. "casual", "formal", "streetwear", "athletic", "bohemian")
- "quantitative_details": string — a precise description of ALL countable/discrete elements: exact number of buttons, pockets, zippers, straps, buckles, logos, seams, bows, ribbons, belt loops, etc. Be extremely precise. Count each element individually.
- "hem_ending_point": string — where the bottom hem of the garment ends relative to the body (e.g. "at natural waist", "at hip bone", "mid-thigh", "above knee", "at knee", "below knee", "mid-calf", "at ankle"). Be precise about the exact ending point.
- "garment_proportions": string — describe the proportions of the garment in detail: how long is the torso section vs the skirt/bottom section, how wide are the shoulders relative to the hem, is it tapered or flared, etc. Describe the overall silhouette shape.
- "length_relative_to_body": string — describe the garment length as a percentage or fraction of the model's body (e.g. "covers torso only, ending at hip", "extends to mid-thigh, roughly 1/3 of leg length", "full length to ankles"). If no model is present, estimate based on garment type.
- "garment_coverage": string — classify the garment into ONE of these categories: "upper" (tops, blouses, shirts, t-shirts, crop tops, jackets, coats, sweaters, hoodies — covers only the torso/upper body), "lower" (pants, jeans, shorts, skirts, trousers — covers only the lower body), or "full" (dresses, jumpsuits, rompers, overalls, one-piece outfits — covers both upper and lower body as a single piece). Choose based on what body area the garment covers.
- "full_description": string — a detailed technical paragraph describing the garment comprehensively, optimized for image generation prompts. Include color, material, fit, design details, overall aesthetic, EXACT LENGTH/HEM POSITION, exact counts of buttons, pockets, and other discrete elements, AND a thorough description of the pattern/print.

CRITICAL INSTRUCTIONS:
1. Count all discrete elements (buttons, pockets, snaps, bows, ribbons, belt loops, etc.) very carefully. These exact counts are essential for accurate image generation. Double-check your counts.
2. PATTERN/PRINT FIDELITY: Describe the pattern, print, or graphic on the fabric in EXHAUSTIVE detail. If there are flowers, describe the type, size, color, and arrangement. If there are geometric shapes, describe each shape. If there is text or a logo, transcribe it exactly. The pattern description is THE most critical element for faithful reproduction — be as detailed as humanly possible.
3. DECORATIVE ELEMENTS: Pay special attention to belts, sashes, bows, ribbons, ties at the waist or elsewhere. These are frequently hallucinated or omitted by image generators. Describe their EXACT presence or absence explicitly.
4. ELEMENT VERIFICATION: Before finalizing, re-count ALL buttons, ALL pockets, check for presence/absence of belt/sash/bow. Verify each discrete element one more time.

Return ONLY the JSON object, no additional text.`;

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType: mimeType || "image/png",
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const response = result.response;
  const text = response.text();

  try {
    const parsed = JSON.parse(text);
    if (!parsed.full_description) {
      parsed.full_description = "fashion clothing item";
    }
    return parsed;
  } catch {
    console.warn("Gemini returned non-JSON, attempting extraction:", text.substring(0, 200));

    // Try to extract JSON from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[1].trim());
        if (!extracted.full_description) {
          extracted.full_description = "fashion clothing item";
        }
        return extracted;
      } catch {}
    }

    return { full_description: "fashion clothing item" };
  }
}

module.exports = { analyzeGarmentWithGemini };
