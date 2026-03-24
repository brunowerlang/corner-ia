"use strict";

/**
 * Builds a text prompt to generate a fashion model image from descriptive attributes.
 *
 * @param {object} attrs - Model attributes from the user form
 * @returns {string} Text prompt for Gemini image generation
 */
function buildModelGenerationPrompt(attrs) {
  const a = attrs || {};
  const age = a.age || "25";
  const ethnicity = a.ethnicity || "latina";
  const bodyType = a.bodyType || "media";
  const hairColor = a.hairColor || "castanho";
  const hairLength = a.hairLength || "longo";
  const eyeColor = a.eyeColor || "castanhos";
  const height = a.height || "media";
  const skinTone = a.skinTone || "media";

  const bodyDesc = {
    magra: "slim, lean body proportions",
    media: "average, healthy body proportions",
    atletica: "athletic, toned body proportions",
    plus: "plus size, curvy body proportions",
  }[bodyType] || "average body proportions";

  const heightDesc = {
    baixa: "short stature (around 1.55m)",
    media: "medium height (around 1.65m)",
    alta: "tall stature (around 1.75m)",
  }[height] || "medium height";

  return `You are a professional fashion ecommerce photographer. Generate ONE high-quality full-body photo of a fashion model.

MODEL DESCRIPTION:
- Age: ${age} years old
- Ethnicity: ${ethnicity}
- Body type: ${bodyDesc}
- Height: ${heightDesc}
- Skin tone: ${skinTone}
- Hair color: ${hairColor}
- Hair length: ${hairLength}
- Eye color: ${eyeColor}

CLOTHING:
- Wearing simple, neutral basics: a plain white fitted t-shirt and simple blue jeans.
- The clothing should be minimal and non-distracting.

POSE AND COMPOSITION:
- Professional ecommerce fashion catalog pose.
- Standing, front facing, arms relaxed along the body.
- Natural stance, legs slightly apart, upright fashion catalog posture.
- Full body shot from head to toe, eye level camera angle.
- The model should look directly at the camera with a natural, confident expression.

PHOTOGRAPHY STYLE:
- Professional ecommerce fashion catalog photography.
- Soft diffused studio lighting.
- Sharp focus across the entire subject.
- Ultra realistic, photorealistic, high resolution.
- Light neutral solid studio background, clean and minimal.

STRICT CONSTRAINTS:
- Generate exactly ONE person.
- Full body must be visible from head to toe.
- No extra people, objects, or text.
- No complex backgrounds. Plain studio background only.
- The person must look natural and realistic.

AVOID: multiple people, distorted body, extra limbs, blurry, low resolution, busy background, cropped body, unrealistic proportions, cartoon style.`;
}

/**
 * Builds a text prompt for Gemini 2.5 Flash Image virtual try-on generation.
 * The model is an AI-generated reference image, and the garment is a real uploaded photo.
 *
 * @param {object} params
 * @param {object} params.garmentAnalysis    - Structured analysis from Gemini Vision
 * @param {object} [params.modelAttributes]  - Model attributes { age, ethnicity, bodyType, hairColor, etc. }
 * @param {string} [params.pose]             - Pose key
 * @param {string} [params.accessories]      - User-described accessories and complements
 * @param {string} [params.imageFormat]      - "vertical" (1080x1350) or "square" (1080x1080)
 * @returns {string} Text prompt for Gemini image generation
 */
function buildVirtualTryOnPrompt({ garmentAnalysis, modelAttributes, pose, accessories, imageFormat }) {
  const attrs = modelAttributes || {};
  const analysis = garmentAnalysis || {};

  const age = attrs.age || "25";
  const ethnicity = attrs.ethnicity || "";
  const bodyType = attrs.bodyType || "media";
  const hairColor = attrs.hairColor || "";
  const hairLength = attrs.hairLength || "";

  const garmentDesc = analysis.full_description || "fashion clothing item";
  const garmentType = analysis.garment_type || "clothing item";
  const color = analysis.primary_color || "";
  const material = analysis.material_texture || "";
  const fit = analysis.fit || "";
  const pattern = analysis.pattern || "";
  const patternDescription = analysis.pattern_description || "";
  const patternColors = (analysis.pattern_colors || []).join(", ");
  const patternScale = analysis.pattern_scale || "";
  const patternPlacement = analysis.pattern_placement || "";
  const neckline = analysis.neckline || "";
  const sleeves = analysis.sleeves || "";
  const details = (analysis.distinctive_details || []).join(", ");
  const closureType = analysis.closure || "";
  const closureCount = analysis.closure_count || 0;
  const pocketCount = analysis.pocket_count || 0;
  const quantitativeDetails = analysis.quantitative_details || "";
  const hasHumanModel = analysis.has_human_model || false;
  const hemEndingPoint = analysis.hem_ending_point || "";
  const garmentProportions = analysis.garment_proportions || "";
  const lengthRelativeToBody = analysis.length_relative_to_body || "";
  const garmentLength = analysis.length || "";
  const garmentCoverage = analysis.garment_coverage || "";
  const hasBeltOrSash = analysis.has_belt_or_sash || false;
  const beltSashDescription = analysis.belt_sash_description || "none";
  const decorativeElements = (analysis.decorative_elements || []).join(", ");

  // Pose descriptions
  const poseKey = (pose || "frente").toLowerCase();
  const poseDesc = {
    "frente": {
      direction: "FRONT-FACING",
      body: "Standing straight, facing the camera directly, arms relaxed along the body. Natural stance, legs slightly apart.",
      camera: "Front view, eye level camera angle.",
      face: "The model should look directly at the camera with a natural, confident expression.",
    },
    "frente-mao-cintura": {
      direction: "FRONT-FACING, HAND ON HIP",
      body: "Standing facing the camera, one hand placed on the hip, the other arm relaxed. Confident, editorial fashion pose. Weight slightly on one leg.",
      camera: "Front view, eye level camera angle.",
      face: "The model should look directly at the camera with a confident, editorial expression.",
    },
    "frente-braco-cruzado": {
      direction: "FRONT-FACING, ARMS CROSSED",
      body: "Standing facing the camera, arms crossed over the chest. Confident, relaxed posture. Legs slightly apart.",
      camera: "Front view, eye level camera angle.",
      face: "The model should look directly at the camera with a relaxed, confident expression.",
    },
    "lado": {
      direction: "SIDE VIEW (profile)",
      body: "Standing in a natural side profile pose, body turned 90 degrees to the left or right. Arms relaxed, one slightly in front. Natural stance.",
      camera: "Side view (profile), eye level camera angle.",
      face: "The model's face is in profile view, looking ahead (not at camera).",
    },
    "lado-caminhando": {
      direction: "SIDE VIEW, WALKING",
      body: "Walking naturally in a side/three-quarter view. One leg stepping forward, arms in natural walking motion. Dynamic but elegant movement. Fashion runway walk style.",
      camera: "Side/three-quarter view, eye level camera angle.",
      face: "The model is looking ahead in the walking direction with a natural, confident expression.",
    },
    "costas": {
      direction: "BACK VIEW",
      body: "Standing with back facing the camera, arms relaxed along the body. Natural stance, legs slightly apart. Showing the garment from behind.",
      camera: "Back view, eye level camera angle.",
      face: "The back of the model's head is visible, face not visible.",
    },
    "tres-quartos": {
      direction: "THREE-QUARTER VIEW",
      body: "Body turned approximately 45 degrees from the camera. One shoulder slightly closer to the camera. Arms relaxed naturally. Slight weight shift to one leg for a natural stance.",
      camera: "Three-quarter angle view, eye level camera.",
      face: "The model looks towards the camera with a natural expression, face at a slight angle.",
    },
    "sentada": {
      direction: "SEATED POSE",
      body: "Sitting on a minimal stool or bench, back straight, legs together or crossed elegantly. Hands resting naturally on thighs or one hand on the seat. The garment should be fully visible and not bunched up.",
      camera: "Front or slight three-quarter view, eye level with the seated model.",
      face: "The model should look at the camera with a relaxed, natural expression.",
    },
    "inclinada": {
      direction: "LEANING POSE",
      body: "Leaning casually against an invisible wall or surface, body at a slight angle. One leg bent, arms relaxed or one hand in pocket area. Casual, editorial fashion vibe.",
      camera: "Front or slight three-quarter view, eye level camera angle.",
      face: "The model should look at the camera with a relaxed, editorial expression.",
    },
  }[poseKey] || {
    direction: "FRONT-FACING",
    body: "Standing straight, facing the camera directly, arms relaxed along the body.",
    camera: "Front view, eye level camera angle.",
    face: "The model should look directly at the camera.",
  };

  // === ENHANCED ANTI-HALLUCINATION & FIDELITY RULES (TOP PRIORITY) ===
  // These rules are placed at the very top of the prompt for maximum priority.
  const pixelPerfectRules = `ABSOLUTE RULE #1 (TOP PRIORITY):\nThe generated garment must be a PIXEL-PERFECT copy of the garment reference image. ZERO differences allowed. Every button, every pocket, every bow, every seam, every detail must match EXACTLY. If the reference has 3 buttons, output MUST have 3 buttons. If the reference has NO bow at the waist, output MUST have NO bow. If the reference HAS a sash, output MUST have that EXACT sash. DO NOT ADD OR REMOVE ANY ELEMENT.\n\nANTI-HALLUCINATION: DO NOT invent, add, or imagine any element (belt, sash, bow, ribbon, tie, buttons, pockets, decorative details) that is NOT 100% visible in the garment image. If the garment does NOT have a belt, sash, bow, ribbon, tie, or buttons, you MUST generate the output with NO BELT/SASH/BOW/RIBBON/TIE/BUTTONS. If the garment has NO buttons, closure_count must be 0 and closure must be \"n/a\". If the garment has NO belt/sash/bow, has_belt_or_sash must be false and belt_sash_description must be \"none\". If the garment has NO decorative elements, decorative_elements must be [].\n\nFAILURE CONSEQUENCES: If you generate an image with missing buttons, extra buttons, invented bows, or any element that does not match the reference, this is a CRITICAL FAILURE. The output will be rejected.\n\nDO NOT GUESS: If any part of the garment is unclear or not visible, DO NOT invent or imagine. Leave it blank, say \"none\", or omit it. Never add details that are not 100% certain from the reference image.\n\nVISUAL VERIFICATION: Before finalizing, visually compare the output to the reference garment image. Confirm that every button, pocket, bow, sash, pattern, and detail matches EXACTLY. If there is any difference, correct it before outputting.\n`;

  // Build precise countable elements section
  const countableElements = [];
  if (closureType && closureType !== "n/a") {
    countableElements.push(`Closure: ${closureType}${closureCount > 0 ? ` — exactly ${closureCount} ${closureType}` : ""}`);
  }
  if (pocketCount > 0) {
    countableElements.push(`Pockets: exactly ${pocketCount} pocket${pocketCount > 1 ? "s" : ""}`);
  }
  if (quantitativeDetails) {
    countableElements.push(`Quantitative details: ${quantitativeDetails}`);
  }
  const countableSection = countableElements.length > 0
    ? countableElements.map((e) => `- ${e}`).join("\n")
    : "";

  const humanWarning = hasHumanModel
    ? `\nCRITICAL NOTE: The garment reference image shows a human model wearing the clothing. IGNORE the person in the garment image completely. Extract ONLY the garment design. Do NOT copy the person's pose, face, body, or any human features from the garment image. Only use the FIRST image for the model identity.\n`
    : "";

  // Accessories section
  const accessoriesText = accessories ? accessories.trim() : "";
  const accessoriesSection = accessoriesText
    ? `\nACCESSORIES AND COMPLEMENTS (add these to the outfit):\n- ${accessoriesText}\n- These accessories should complement the garment naturally.\n- Do NOT let accessories obscure or cover the garment. The garment remains the focal point.\n`
    : "";

  // Image format/composition
  const formatKey = (imageFormat || "vertical").toLowerCase();
  const compositionDesc = formatKey === "square"
    ? "Square format (1:1 ratio). Frame the model centered, full body from head to toe within a square composition."
    : "Vertical format (4:5 ratio). Frame the model centered, full body from head to toe within a vertical/portrait composition.";

  // Build belt/sash/bow section
  const beltSection = hasBeltOrSash
    ? `\n- Belt/Sash/Bow: YES — ${beltSashDescription}. This element MUST appear in the output exactly as described.`
    : `\n- Belt/Sash/Bow: NONE — The garment does NOT have any belt, sash, bow, ribbon, or waist tie. Do NOT add one.`;

  const decorativeSection = decorativeElements
    ? `\n- Decorative elements present: ${decorativeElements}`
    : `\n- Decorative elements: NONE — do NOT add any decorative elements not in the reference.`;


  return `You are a professional fashion ecommerce photographer. Generate a high-quality virtual try-on image.\n\n${pixelPerfectRules}\nNEVER invent or add any detail that is not present. If in doubt, always choose to OMIT rather than invent. If the garment is plain, say so. If there are no buttons, bows, sashes, or ribbons, state this explicitly. If there is any uncertainty, always answer \"none\" or 0.\n\nTASK: Dress the model from the first reference image in the exact garment from the second reference image.${humanWarning}${accessoriesSection}\n\nMODEL IDENTITY:\n- Use the first uploaded image as the model identity source.\n- Preserve exactly: face identity, facial structure, body proportions, skin tone, hair style, hair color.\n- Age: ${age}. Ethnicity: ${ethnicity}. Body type: ${bodyType}. Hair: ${hairColor} ${hairLength}.\n\nGARMENT TO DRESS THE MODEL IN:\n- Use the second uploaded image as the exact clothing to put on the model.\n- Garment type: ${garmentType}\n- Color: ${color}\n- Material: ${material}\n- Fit: ${fit}\n- Pattern: ${pattern}\n${patternDescription ? `- Pattern detailed description: ${patternDescription}` : ""}\n${patternColors ? `- Pattern colors: ${patternColors}` : ""}\n${patternScale ? `- Pattern scale: ${patternScale}` : ""}\n${patternPlacement ? `- Pattern placement: ${patternPlacement}` : ""}\n- Neckline: ${neckline}\n- Sleeves: ${sleeves}\n- Length: ${garmentLength}\n- Notable details: ${details}${beltSection}${decorativeSection}\n- Full description: ${garmentDesc}\n${hemEndingPoint ? `- Hem ending point: ${hemEndingPoint}` : ""}\n${garmentProportions ? `- Garment proportions/silhouette: ${garmentProportions}` : ""}\n${lengthRelativeToBody ? `- Length relative to body: ${lengthRelativeToBody}` : ""}\n${countableSection ? `\nEXACT COUNTABLE ELEMENTS (DO NOT CHANGE THESE COUNTS):\n${countableSection}\n` : ""}\nOUTFIT SUBSTITUTION RULES (CRITICAL — READ BEFORE GENERATING):\n${garmentCoverage === "full" ? `- The garment is a FULL-BODY piece (${garmentType}). It REPLACES THE ENTIRE OUTFIT of the model.\n- REMOVE ALL other clothing from the model — no pants, no skirt, no shirt, no blouse underneath.\n- The model must wear ONLY this single garment. Nothing else.\n- FORBIDDEN combinations: dress + pants, dress + skirt, jumpsuit + jeans, romper + trousers.` : garmentCoverage === "upper" ? `- The garment is an UPPER-BODY piece (${garmentType}). It REPLACES ONLY the top/upper clothing of the model.\n- KEEP the model's original lower-body clothing (pants, jeans, skirt, shorts) unchanged.\n- Only the torso/upper body clothing changes to the new garment.` : garmentCoverage === "lower" ? `- The garment is a LOWER-BODY piece (${garmentType}). It REPLACES ONLY the bottom/lower clothing of the model.\n- KEEP the model's original upper-body clothing (shirt, blouse, top) unchanged.\n- Only the legs/lower body clothing changes to the new garment.` : `- Replace the model's clothing with ONLY the garment shown in the reference image.\n- Do NOT combine the new garment with the model's original outfit in unrealistic ways.`}\n- The uploaded garment image ALWAYS takes priority over whatever the model was originally wearing.\n- Do NOT invent or add any clothing that is not visible in the garment reference image.\n- Replicate ONLY the pieces visible in the garment reference.\n\nGARMENT FIDELITY RULES (MOST CRITICAL — VIOLATION = FAILURE):\n- Reproduce the garment with PIXEL-LEVEL fidelity to the reference image.\n- Preserve the EXACT number of buttons, pockets, snaps, zippers, and any other discrete elements.\n- Do NOT add, remove, or merge any buttons, pockets, or design elements.\n- Do NOT hallucinate or invent details that are not in the garment reference image.\n- Every seam, stitch, fold, logo, print, and hardware must match the original.\n- If the garment has ${closureCount} ${closureType}, the output MUST have EXACTLY ${closureCount} ${closureType}. Not ${closureCount - 1}, not ${closureCount + 1}. EXACTLY ${closureCount}.\n- If the garment has ${pocketCount} pocket(s), the output MUST have EXACTLY ${pocketCount} pocket(s).\n${hasBeltOrSash ? `- The garment HAS a belt/sash/bow: ${beltSashDescription}. This MUST appear in the output.` : "- The garment has NO belt, sash, bow, or waist tie. Do NOT add any."}\n${decorativeElements ? `- Decorative elements to reproduce exactly: ${decorativeElements}` : "- No decorative elements. Do NOT invent or add any."}\n- Preserve exact garment proportions, fabric texture, and color.\n- BEFORE finalizing: verify button count matches ${closureCount}, pocket count matches ${pocketCount}, belt/sash presence matches ${hasBeltOrSash ? "YES" : "NO"}.\n\nPATTERN / PRINT / ESTAMPA FIDELITY (HIGHEST PRIORITY):\n- The pattern, print, or graphic on the garment fabric MUST be reproduced IDENTICALLY to the reference image.\n- Copy the EXACT same motifs, shapes, colors, scale, and arrangement of the pattern.\n- Do NOT simplify, stylize, reinterpret, or change the pattern in any way.\n- Do NOT replace the pattern with a similar but different one.\n- Do NOT change the colors of the print. The pattern colors must match the reference exactly.\n- Do NOT change the size/scale of the pattern elements. If the flowers are small, keep them small. If the stripes are wide, keep them wide.\n- Do NOT change the density or spacing of repeating pattern elements.\n- The pattern/print on the generated garment must be visually indistinguishable from the reference image's pattern.\n${patternDescription ? `- EXACT pattern to reproduce: ${patternDescription}` : ""}\n${patternColors ? `- Pattern color palette: ${patternColors}` : ""}\n${patternScale ? `- Pattern scale: ${patternScale}` : ""}\n${patternPlacement ? `- Pattern placement on garment: ${patternPlacement}` : ""}\n\nGARMENT LENGTH AND PROPORTION RULES (CRITICAL):\n- The garment MUST end at EXACTLY the same point on the body as shown in the reference image.\n- Do NOT make the garment longer or shorter than the reference.\n${hemEndingPoint ? `- The bottom hem MUST end at: ${hemEndingPoint}. Do NOT extend it beyond this point.` : ""}\n${garmentLength ? `- The garment length category is: ${garmentLength}. Maintain this exact length.` : ""}\n${lengthRelativeToBody ? `- Body-relative length: ${lengthRelativeToBody}. Match this proportion exactly.` : ""}\n${garmentProportions ? `- Silhouette and proportions: ${garmentProportions}. Do NOT alter the garment's silhouette or proportions.` : ""}\n- If the reference garment is cropped, keep it cropped. If it is mid-thigh, keep it mid-thigh. NEVER extend the length.\n- The garment's width, taper, and flare must match the reference exactly.\n\nPOSE AND COMPOSITION (${poseDesc.direction}):\n- ${poseDesc.body}\n- ${poseDesc.camera}\n- ${poseDesc.face}\n- ${compositionDesc}\n- Professional ecommerce fashion catalog pose.\n- Full body shot from head to toe.\n\nPHOTOGRAPHY STYLE:\n- Professional ecommerce fashion catalog photography.\n- Soft diffused studio lighting.\n- Sharp focus across the entire subject.\n- Ultra realistic, high resolution.\n- Light neutral studio background, clean and minimal.\n\nSTRICT CONSTRAINTS:\n- The model MUST be the same person from the first reference image (same face, same hair).\n- The clothing MUST be the exact garment from the second reference image.\n- The garment MUST have the EXACT same number of buttons, pockets, and details as the reference.\n- No extra garments or accessories${accessoriesText ? " beyond those specified in the ACCESSORIES section" : ""}.\n- No complex backgrounds.\n- Full body must be visible.\n- Do NOT change the model's face or the clothing design.\n- Do NOT modify, skip, or add any garment detail.\n\nFINAL CHECKLIST (verify each before outputting):\n1. Button count: exactly ${closureCount}? ✓\n2. Pocket count: exactly ${pocketCount}? ✓\n3. Belt/sash/bow: ${hasBeltOrSash ? "present and matching description" : "ABSENT — none added"}? ✓\n4. Pattern: identical to reference? ✓\n5. Garment length: same as reference? ✓\n6. No extra clothing added? ✓\n7. Model identity preserved from first image? ✓\n\nAVOID: different person, wrong clothing, distorted body, extra limbs, blurry, low resolution, busy background, cropped body, missing buttons, extra buttons, wrong number of pockets, hallucinated details, garment longer than reference, garment shorter than reference, wrong garment proportions, altered silhouette, DIFFERENT PATTERN, altered print, wrong pattern colors, changed pattern scale, simplified pattern, reinterpreted print design, ADDED BOWS/SASHES/BELTS THAT DON'T EXIST, REMOVED BOWS/SASHES/BELTS THAT DO EXIST.`;
}

module.exports = { buildVirtualTryOnPrompt, buildModelGenerationPrompt };
