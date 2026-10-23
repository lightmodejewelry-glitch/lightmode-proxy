// ============================================================
// LightMode — Servidor de Luz (Render)
// Reúne en un solo sitio lo que antes hacían el backend de Wix
// y el proxy de Render. Las claves viven SOLO en las variables
// de entorno de Render, nunca en la web.
//
// Variables de entorno en Render:
//   OPENAI_API_KEY      (obligatoria)
//   STABILITY_API_KEY   (opcional, respaldo si OpenAI falla)
//   RESEND_API_KEY      (para recibir las solicitudes por correo)
//   LUZ_EMAIL_TO        (tu correo, donde llegan las solicitudes)
//   LUZ_EMAIL_FROM      (opcional, por defecto "Luz <onboarding@resend.dev>")
//   ALLOWED_ORIGINS     (opcional, webs que pueden usar a Luz, separadas por comas)
// ============================================================
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const Jimp = require('jimp');

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const STABILITY_KEY = process.env.STABILITY_API_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_TO = process.env.LUZ_EMAIL_TO || '';
const EMAIL_FROM = process.env.LUZ_EMAIL_FROM || 'Luz <onboarding@resend.dev>';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lightmode-7709.myshopify.com')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const app = express();
const jobs = {};

app.set('trust proxy', true);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const clean = origin.replace(/\/$/, '');
      cb(null, ALLOWED_ORIGINS.includes(clean) || /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/.test(clean));
    },
  })
);
app.use(express.json({ limit: '20mb' }));

process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

// ── LÍMITE DE USO (protege tus claves de abusos) ─────────────
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const ip = String(req.ip || req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
    const key = `${name}:${ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      return res.status(429).json({ ok: false, error: 'Has hecho muchas peticiones seguidas. Inténtalo de nuevo un poco más tarde.' });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) {
    if (!list.some((t) => now - t < 3 * 60 * 60 * 1000)) hits.delete(key);
  }
}, 30 * 60 * 1000);

// ── HELPERS ──────────────────────────────────────────────────
function safeJsonParse(text) {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (e) {}
  }
  return null;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Solo aceptamos mensajes de cliente y de Luz; el "system" lo pone el servidor.
function limpiarHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  return historial
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }));
}

function historialATexto(historial = []) {
  return historial.map((m) => `${m.role === 'user' ? 'Cliente' : 'Luz'}: ${m.content}`).join('\n');
}

function compactPrompt(text, max = 1500) {
  if (!text) return '';
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 110).trim() + ' Realistic jewelry, full piece visible, client changes mandatory.';
}

async function openaiChat(body) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${res.status}`);
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

// Normaliza la foto de referencia que sube el cliente (data URL) a PNG 1024x1024.
async function normalizarReferencia(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return '';
  const base64 = dataUrl.split(',')[1] || '';
  const image = await Jimp.read(Buffer.from(base64, 'base64'));
  image.contain(1024, 1024);
  const png = await image.getBufferAsync(Jimp.MIME_PNG);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// ── LUZ: PERSONALIDAD Y FLUJO ────────────────────────────────
const SYSTEM = {
  role: 'system',
  content: `Eres Luz, asistente creativa de diseño de joyería personalizada de LightMode Jewelry.
Hablas en español. Tono cálido, elegante y cercano.
REGLAS CLAVE:
- Haz UNA sola pregunta por mensaje.
- No hagas interrogatorios.
- La conversación debe sentirse natural, no como un formulario.
FLUJO:
1. Empieza preguntando qué tipo de joya quiere diseñar.
2. Después pregunta si tiene una imagen de referencia (puede subirla con el botón de la imagen).
3. Si sube referencia, la web ya pregunta automáticamente qué quiere mantener y cambiar. NO repitas esa pregunta.
4. Después completa solo lo imprescindible:
- ocasión o para quién
- piedras sí/no
- delicada o llamativa
5. Última pregunta:
"Para terminar, ¿hay algún detalle más que te gustaría añadir?"
Cuando tengas suficiente información, responde EXACTAMENTE:
"¡Perfecto! Ya tengo todo lo que necesito para crear tus bocetos. Dame un momento... ✨"
IMPORTANTE:
- No repitas preguntas.
- No pidas información innecesaria.
- La referencia nunca manda sobre la conversación.`,
};
const FRASE_LISTO = '¡Perfecto! Ya tengo todo lo que necesito para crear tus bocetos. Dame un momento... ✨';

function buildMandatoryBriefBlock(brief = {}) {
  const tipo = String(brief.tipo_joya || 'jewelry piece').trim() || 'jewelry piece';
  const name = String(brief.nombre_o_iniciales || '').trim();
  const cambios = String(brief.cambios_respecto_referencia || '').trim();
  const material = String(brief.material_final || '').trim();
  const piedras = String(brief.piedras_finales || '').trim();
  const elementos = Array.isArray(brief.elementos_centrales_obligatorios) ? brief.elementos_centrales_obligatorios.join(', ') : '';
  const descripcion = String(brief.descripcion_final_unificada || '').trim();
  const parts = [];
  parts.push(`MANDATORY CLIENT BRIEF FOR A ${tipo.toUpperCase()}:`);
  parts.push(`Jewelry type must be exactly: ${tipo}. Do not generate another jewelry type.`);
  if (material) parts.push(`Material: ${material}.`);
  if (piedras) parts.push(`Stones: ${piedras}.`);
  if (cambios) parts.push(`Requested changes: ${cambios}.`);
  if (elementos) parts.push(`Required elements: ${elementos}.`);
  if (descripcion) parts.push(`Final description: ${descripcion}.`);
  if (name) {
    const cleanName = name.toUpperCase();
    const spaced = cleanName.split('').join('-');
    parts.push(
      `The ${tipo} MUST visibly include the name or initials ${cleanName} as a physical jewelry element adapted to a ${tipo}. ` +
        `Use polished metal letter charms spelling ${spaced}, or one clear custom nameplate charm reading ${cleanName}. ` +
        `The letters must be part of the jewelry structure, not printed text.`
    );
  }
  const lowerAll = `${cambios} ${elementos} ${descripcion}`.toLowerCase();
  if (lowerAll.includes('mariposa') || lowerAll.includes('butterfly')) {
    parts.push(`Butterfly motif/charm must be physically integrated into the ${tipo}, in the exact position requested by the client.`);
  }
  if (lowerAll.includes('corazon') || lowerAll.includes('corazón') || lowerAll.includes('heart')) {
    parts.push(`Heart motif/charm must be physically integrated into the ${tipo}, in the exact position requested by the client.`);
  }
  if (lowerAll.includes('estrella') || lowerAll.includes('star')) {
    parts.push(`Star motif must be a clear five-point star if the client requested a five-point star, physically integrated into the ${tipo}.`);
  }
  parts.push('Do not omit requested names, initials, symbols, charms, material, stones/no-stones, or the requested jewelry type.');
  return parts.join(' ');
}

async function extraerBriefFinal(historial, imagenDesc, tieneReferencia) {
  const raw = await openaiChat({
    model: 'gpt-4o',
    temperature: 0.12,
    response_format: { type: 'json_object' },
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: `Extrae el brief FINAL para generar bocetos de joyería personalizada.
Devuelve SOLO JSON válido:
{
"tipo_joya": "",
"tiene_referencia": false,
"para_quien": "",
"ocasion": "",
"material_final": "",
"materiales_prohibidos": [],
"piedras_finales": "",
"estilo_final": "",
"presencia": "",
"simbolo": "",
"nombre_o_iniciales": "",
"cambios_respecto_referencia": "",
"elementos_centrales_obligatorios": [],
"estructura_a_conservar_de_referencia": "",
"elementos_a_ignorar_de_referencia": "",
"cambios_obligatorios": [],
"descripcion_final_unificada": ""
}
Reglas absolutas:
- Usa TODA la conversación.
- La última preferencia explícita del cliente manda.
- El tipo de joya pedido por el cliente es obligatorio. Si pide anillo, debe ser anillo. Si pide pulsera, debe ser pulsera.
- La referencia solo sirve como inspiración visual compatible: silueta, proporción, composición, cadena/estructura, volumen, estilo general.
- Si hay referencia, estilo_final debe ser "como la referencia" salvo que el cliente pida otro estilo explícitamente.
- Si el cliente pide cambios respecto a la referencia, esos cambios son obligatorios.
- Si el cliente pide nombre, iniciales, símbolo, mariposa, estrella, corazón u otra forma, debe aparecer en elementos_centrales_obligatorios y cambios_obligatorios.
- Si el cliente pide cambiar una palabra de la referencia por un nombre, interpreta eso como una pieza física de joyería: letras o placa de nombre, no texto decorativo pintado.
- Si el cliente pide sin piedras, piedras_finales debe indicar "sin piedras".
- Si no especifica piedras, no inventes piedras protagonistas.
- Si no especifica material, usa el material aparente de la referencia si existe; si no, deja material_final como "no especificado".
- descripcion_final_unificada debe ser clara, fabricable, física y concreta.`,
      },
      {
        role: 'user',
        content: `TIENE REFERENCIA: ${tieneReferencia ? 'sí' : 'no'}
CONVERSACIÓN COMPLETA:
${historialATexto(historial)}
DESCRIPCIÓN VISUAL DE REFERENCIA:
${imagenDesc || 'sin referencia visual'}`,
      },
    ],
  });
  const brief = safeJsonParse(raw);
  if (!brief) throw new Error('El brief final no vino en JSON válido.');
  brief.tiene_referencia = tieneReferencia;
  return brief;
}

async function generarPrompts(brief, imagenDesc, tieneReferencia) {
  const systemPrompt = tieneReferencia
    ? `Eres un prompt engineer especializado en joyería realista y edición con imagen de referencia.
Devuelve SOLO JSON válido:
{ "prompt1": "", "prompt2": "", "prompt3": "" }
Objetivo:
Crear 3 prompts en inglés para transformar una referencia visual en 3 bocetos de la MISMA joya personalizada.
Reglas absolutas:
- El tipo de joya del cliente manda. Nunca cambies anillo por pulsera, collar por anillo, etc.
- La referencia visual debe aportar ADN visual compatible: silueta, escala, composición, proporciones, estructura y sensación general.
- La conversación del cliente manda sobre la referencia.
- Los cambios del cliente deben ir al principio del prompt.
- No copies detalles de la referencia que contradigan el brief.
- Describe la joya como objeto físico fabricable.
- Si hay nombre o iniciales, son piezas físicas de joyería, no texto impreso.
- Cada prompt máximo 520 caracteres.
- Los 3 prompts deben conservar el mismo diseño base, variando presentación: clean luxury, warm artisanal, bold luxury.`
    : `Eres un prompt engineer especializado en joyería original, realista, elegante y fabricable.
Devuelve SOLO JSON válido:
{ "prompt1": "", "prompt2": "", "prompt3": "" }
Objetivo:
Crear 3 prompts en inglés para generar desde cero 3 bocetos DIFERENTES de la MISMA joya personalizada.
Reglas absolutas:
- El tipo de joya del cliente manda. Nunca cambies anillo por pulsera, collar por anillo, etc.
- Sin referencia: crea propuestas originales, coherentes, elegantes y fabricables.
- Los elementos centrales obligatorios deben aparecer físicamente en la joya.
- Si hay nombre o iniciales, son piezas físicas de joyería, no texto impreso.
- Cada prompt máximo 520 caracteres.
- Los 3 prompts deben ser direcciones distintas: clean luxury, warm artisanal, bold luxury.`;

  const raw = await openaiChat({
    model: 'gpt-4o',
    temperature: tieneReferencia ? 0.28 : 0.42,
    response_format: { type: 'json_object' },
    max_tokens: 1500,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `BRIEF FINAL:
${JSON.stringify(brief, null, 2)}
DESCRIPCIÓN DE REFERENCIA:
${imagenDesc || 'sin referencia'}
Crea 3 prompts en inglés.
Si hay referencia, incluye:
"Use the reference image as a soft visual guide for compatible silhouette, scale, composition and jewelry structure. Client changes override the reference."
Si no hay referencia, no menciones referencia.`,
      },
    ],
  });
  const parsed = safeJsonParse(raw);
  if (!parsed) throw new Error('Los prompts no vinieron en JSON válido.');
  const prompts = [parsed.prompt1, parsed.prompt2, parsed.prompt3].filter(Boolean);
  if (prompts.length < 3) throw new Error('No se obtuvieron los 3 prompts.');
  return prompts;
}

function construirPromptFinal(prompt, variacion, brief, usarReferencia) {
  const ambientes = [
    'Clean luxury product render, neutral background, full jewelry piece visible, centered, sharp focus, realistic jewelry construction.',
    'Warm artisanal product render, soft natural light, premium handcrafted feel, full jewelry piece visible, realistic metal, coherent connections.',
    'Bold luxury product render, elegant background, dramatic but realistic lighting, full jewelry piece visible, high-end jewelry campaign style.',
  ];
  const variationInstructions = [
    'Variation 1: minimal refined luxury. Clean, precise, elegant, balanced, premium and wearable.',
    'Variation 2: organic artisanal luxury. Softer forms, handcrafted feeling, romantic but still coherent and premium.',
    'Variation 3: bold editorial luxury. More statement, high fashion, sculptural but still manufacturable and wearable.',
  ];
  const forbidden = Array.isArray(brief?.materiales_prohibidos) ? brief.materiales_prohibidos : [];
  const piedras = String(brief?.piedras_finales || '').toLowerCase();
  const sinPiedras = piedras.includes('sin piedras') || piedras.includes('no piedras');

  const negativePrompt =
    'blurry, low quality, distorted, deformed, ugly, watermark, logo, person, hand, finger, face, skin, cropped jewelry, partial jewelry, cut off, duplicate jewelry, multiple jewelry pieces, broken chain, melted metal, warped geometry, impossible structure, incoherent attachments, random letters, misspelled name, unreadable nameplate, malformed charm, messy charms, cheap plastic, toy jewelry, cartoon, illustration, fantasy' +
    (sinPiedras ? ', stones, gemstones, diamonds, crystals, pavé, sapphire, ruby, emerald' : '') +
    (forbidden.length ? ', ' + forbidden.join(', ') : '');

  const policy = usarReferencia
    ? `OPENAI IMAGE EDIT MODE:
Use the uploaded image as the real visual reference.
Keep the compatible visual DNA of the reference: jewelry category, general silhouette, proportions, scale, composition, material feeling and aesthetic language.
Apply the client's requested changes as mandatory edits.
Do NOT return an identical copy of the uploaded image.
Do NOT keep elements that conflict with the final client brief.
Create a new redesigned jewelry concept inspired by the reference, not a clone.
If the reference contains a hand, skin, model, watermark or lifestyle background, remove it and show the jewelry clearly as a premium product concept.`
    : `NO REFERENCE IMAGE MODE:
Create an original, elegant, coherent and manufacturable jewelry design based only on the client brief.
Be creative, but keep the design realistic and physically possible.`;

  const raw = `
${buildMandatoryBriefBlock(brief || {})}
${prompt}
${policy}
${variationInstructions[(variacion - 1) % 3]}
MANDATORY FINAL CHECK:
- Jewelry type must match the client brief exactly.
- Client changes are mandatory.
- The result must be one coherent physical jewelry piece.
- Full piece visible and centered.
- No duplicate jewelry pieces.
- If a name is requested, it must appear as physical metal letter charms or a physical nameplate, not printed text.
${sinPiedras ? '- No gemstones, no stones, no diamonds, no crystals.' : ''}
${ambientes[(variacion - 1) % 3]}`;

  return { finalPrompt: compactPrompt(raw, 2400), negativePrompt };
}

// ── GENERACIÓN DE IMÁGENES ───────────────────────────────────
async function leerImagenOpenAI(res) {
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const item = data?.data?.[0];
  if (!item) throw new Error('OpenAI no devolvió imagen');
  if (item.b64_json) return item.b64_json;
  if (item.url) {
    const img = await fetch(item.url);
    return (await img.buffer()).toString('base64');
  }
  throw new Error('OpenAI no devolvió imagen');
}

async function openaiEdit(dataUrl, prompt) {
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-image-1', images: [{ image_url: dataUrl }], prompt, n: 1, size: '1024x1024', output_format: 'png' }),
  });
  return leerImagenOpenAI(res);
}

async function openaiGenerate(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: '1024x1024', output_format: 'png' }),
  });
  return leerImagenOpenAI(res);
}

async function stabilityTxt2Img(prompt, negativePrompt) {
  const res = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + STABILITY_KEY, Accept: 'application/json' },
    body: JSON.stringify({
      text_prompts: [
        { text: prompt.slice(0, 2000), weight: 1.25 },
        { text: negativePrompt, weight: -1 },
      ],
      cfg_scale: 11,
      height: 1024,
      width: 1024,
      steps: 38,
      samples: 1,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  if (!data.artifacts || !data.artifacts.length) throw new Error('Sin imagen de Stability');
  return data.artifacts[0].base64;
}

function createJob(variacion) {
  const jobId = `luz_${Date.now()}_${variacion}_${Math.floor(Math.random() * 100000)}`;
  jobs[jobId] = { status: 'processing', variacion };
  return jobId;
}

function finishJob(jobId, payload) {
  jobs[jobId] = payload;
  setTimeout(() => delete jobs[jobId], 15 * 60 * 1000);
}

function lanzarBoceto(jobId, variacion, finalPrompt, negativePrompt, referencia) {
  (async () => {
    try {
      const base64 = referencia ? await openaiEdit(referencia, finalPrompt) : await openaiGenerate(finalPrompt);
      finishJob(jobId, { status: 'done', variacion, base64 });
    } catch (e) {
      console.error(`Boceto ${variacion} OpenAI error:`, e.message);
      if (STABILITY_KEY) {
        try {
          const base64 = await stabilityTxt2Img(finalPrompt, negativePrompt);
          return finishJob(jobId, { status: 'done', variacion, base64 });
        } catch (e2) {
          console.error(`Boceto ${variacion} Stability error:`, e2.message);
        }
      }
      finishJob(jobId, { status: 'error', variacion, error: 'No se pudo crear este boceto.' });
    }
  })();
}

// ── RUTAS ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// 1. Conversación con Luz
app.post('/luz/chat', limit('chat', 80, 60 * 60 * 1000), async (req, res) => {
  try {
    const historial = limpiarHistorial(req.body.historial);
    let recordatorio =
      'Recuerda: haz UNA sola pregunta, no repitas preguntas que el cliente ya ha respondido en el historial, ' +
      'y ten en cuenta TODA la información que el cliente ha dado desde su primer mensaje (incluido el tipo de joya, ' +
      'material, piedras, estilo o cualquier detalle mencionado en cualquier punto de la conversación).';
    if (req.body.referenciaRespondida) {
      recordatorio += ' El cliente ya respondió qué mantener/cambiar de la referencia. NO vuelvas a preguntar por la referencia.';
    }
    const content = await openaiChat({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      max_tokens: 300,
      messages: [SYSTEM, ...historial, { role: 'system', content: recordatorio }],
    });
    if (!content) return res.json({ ok: false, error: 'Luz no ha podido responder. Inténtalo de nuevo.' });
    const readyToGenerate = content.includes('Ya tengo todo lo que necesito para crear tus bocetos');
    res.json({ ok: true, content: readyToGenerate ? FRASE_LISTO : content, readyToGenerate });
  } catch (e) {
    console.error('chat error:', e.message);
    res.status(500).json({ ok: false, error: 'Luz no ha podido responder. Inténtalo de nuevo.' });
  }
});

// 2. Análisis de la foto de referencia
app.post('/luz/analizar', limit('analizar', 15, 60 * 60 * 1000), async (req, res) => {
  try {
    const imagen = await normalizarReferencia(req.body.imagen);
    if (!imagen) return res.status(400).json({ ok: false, error: 'La imagen no es válida.' });
    const raw = await openaiChat({
      model: 'gpt-4o',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content: `Analiza visualmente la joya de referencia.
Devuelve SOLO JSON válido:
{
"tipo_joya": "", "metal_aparente": "", "acabado": "", "tipo_cadena_o_estructura": "", "forma_estructura": "",
"motivo_central": "", "posicion_motivo_central": "", "piedras_visibles": "", "distribucion_piedras": "",
"proporciones": "", "simetria": "", "estilo_visual": "", "elementos_destacados": [],
"adn_visual_a_conservar": "", "descripcion_unificada": ""
}
Reglas:
- Describe solo lo que ves.
- No inventes materiales si no se aprecian.
- No conviertas la referencia en instrucción final.
- La imagen será una referencia visual secundaria; la conversación del cliente mandará.
- Describe especialmente silueta, escala, estructura, composición, tipo de cadena, simetría y proporciones.`,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe la joya de la imagen de forma útil para crear un nuevo diseño personalizado.' },
            { type: 'image_url', image_url: { url: imagen, detail: 'high' } },
          ],
        },
      ],
    });
    const parsed = safeJsonParse(raw);
    const content = parsed ? parsed.descripcion_unificada || '' : String(raw || '').trim();
    res.json({ ok: true, content, analisis: parsed || { descripcion_unificada: content } });
  } catch (e) {
    console.error('analizar error:', e.message);
    res.status(500).json({ ok: false, error: 'No se ha podido analizar la imagen.' });
  }
});

// 3. Preparar y lanzar los 3 bocetos
app.post('/luz/bocetos', limit('bocetos', 4, 60 * 60 * 1000), async (req, res) => {
  try {
    const historial = limpiarHistorial(req.body.historial);
    const imagenDesc = String(req.body.imagenDesc || '').slice(0, 4000);
    const referencia = req.body.imagen ? await normalizarReferencia(req.body.imagen) : '';
    const tieneReferencia = !!referencia;

    const brief = await extraerBriefFinal(historial, imagenDesc, tieneReferencia);
    const prompts = await generarPrompts(brief, imagenDesc, tieneReferencia);

    const jobIds = prompts.map((prompt, i) => {
      const variacion = i + 1;
      const jobId = createJob(variacion);
      const { finalPrompt, negativePrompt } = construirPromptFinal(prompt, variacion, brief, tieneReferencia);
      lanzarBoceto(jobId, variacion, finalPrompt, negativePrompt, referencia);
      return jobId;
    });

    res.json({ ok: true, jobIds, brief });
  } catch (e) {
    console.error('bocetos error:', e.message);
    res.status(500).json({ ok: false, error: 'No se han podido preparar los bocetos. Inténtalo de nuevo.' });
  }
});

// 4. Consultar si un boceto está listo
app.get('/luz/resultado/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  res.json(job || { status: 'not_found' });
});

// 5. Enviar la solicitud con el boceto elegido a tu correo
app.post('/luz/enviar', limit('enviar', 6, 60 * 60 * 1000), async (req, res) => {
  try {
    const { nombre, email, mensaje, resumenJoya, numeroBoceto, boceto, historial } = req.body || {};
    if (!nombre || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Faltan el nombre o un email válido.' });
    }
    if (!RESEND_KEY || !EMAIL_TO) {
      return res.status(500).json({ ok: false, error: 'El envío de solicitudes aún no está configurado.' });
    }
    const conversacion = limpiarHistorial(historial)
      .map((m) => `<p><strong>${m.role === 'user' ? 'Cliente' : 'Luz'}:</strong> ${escapeHtml(m.content)}</p>`)
      .join('');
    const html = `
      <h2>Nueva solicitud de joya personalizada</h2>
      <p><strong>Nombre:</strong> ${escapeHtml(nombre)}<br>
      <strong>Email:</strong> ${escapeHtml(email)}<br>
      <strong>Boceto elegido:</strong> ${escapeHtml(numeroBoceto)}</p>
      <p><strong>Mensaje:</strong><br>${escapeHtml(mensaje || 'Sin mensaje adicional').replace(/\n/g, '<br>')}</p>
      <h3>Resumen de la joya</h3>
      <p>${escapeHtml(resumenJoya || '').replace(/\n/g, '<br>')}</p>
      <h3>Conversación con Luz</h3>
      ${conversacion}
      <p>El boceto elegido va adjunto.</p>`;

    const attachments = [];
    if (typeof boceto === 'string' && boceto.length > 100) {
      attachments.push({ filename: `boceto-${numeroBoceto || 1}.png`, content: boceto.replace(/^data:image\/\w+;base64,/, '') });
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: EMAIL_TO.split(',').map((s) => s.trim()),
        reply_to: email,
        subject: `Luz · Nueva joya personalizada de ${String(nombre).slice(0, 80)}`,
        html,
        attachments,
      }),
    });
    if (!r.ok) {
      console.error('resend error:', await r.text());
      return res.status(500).json({ ok: false, error: 'No se ha podido enviar la solicitud.' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('enviar error:', e.message);
    res.status(500).json({ ok: false, error: 'No se ha podido enviar la solicitud.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor de Luz en puerto', PORT));
