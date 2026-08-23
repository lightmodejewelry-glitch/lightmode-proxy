const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');
const Jimp = require('jimp');
 
const app = express();
const jobs = {};
 
app.use(cors());
app.use(express.json({ limit: '20mb' }));
 
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
 
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
 
async function fetchUrlAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo descargar la imagen generada');
  const contentType = res.headers.get('content-type') || 'image/png';
  const buffer = await res.buffer();
  return {
    base64: buffer.toString('base64'),
    dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`
  };
}
 
async function imageUrlToDataUrl(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error('No se pudo descargar la imagen de referencia');
 
  const contentType = res.headers.get('content-type') || 'image/png';
  const buffer = await res.buffer();
 
  // Normalizamos con Jimp para evitar formatos raros o imágenes demasiado grandes.
  const image = await Jimp.read(buffer);
  image.contain(1024, 1024);
  const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
 
  return `data:image/png;base64,${pngBuffer.toString('base64')}`;
}
 
async function runOpenAIImageEdit({ imageUrl, prompt, openaiKey, model }) {
  const dataUrl = await imageUrlToDataUrl(imageUrl);
 
  const body = JSON.stringify({
    model: model || 'gpt-image-1',
    images: [
      { image_url: dataUrl }
    ],
    prompt,
    n: 1,
    size: '1024x1024',
    output_format: 'png'
  });
 
  const openaiRes = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + openaiKey
    },
    body
  });
 
  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    throw new Error(errText);
  }
 
  const data = await openaiRes.json();
  const item = data?.data?.[0];
 
  if (!item) throw new Error('OpenAI no devolvió imagen');
 
  if (item.b64_json) return item.b64_json;
 
  if (item.url) {
    const converted = await fetchUrlAsBase64(item.url);
    return converted.base64;
  }
 
  throw new Error('OpenAI no devolvió b64_json ni url');
}
 
// ============================================================
// FIX BUG 1: generación de imagen SIN referencia vía OpenAI
// (gpt-image-1) en vez de Stability SDXL. gpt-image-1 sí
// interpreta instrucciones tipo "MANDATORY" / "must include",
// por lo que respeta el brief del cliente igual que en el
// modo con referencia.
// ============================================================
async function runOpenAIImageGenerate({ prompt, openaiKey, model }) {
  const body = JSON.stringify({
    model: model || 'gpt-image-1',
    prompt,
    n: 1,
    size: '1024x1024',
    output_format: 'png'
  });
 
  const openaiRes = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + openaiKey
    },
    body
  });
 
  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    throw new Error(errText);
  }
 
  const data = await openaiRes.json();
  const item = data?.data?.[0];
 
  if (!item) throw new Error('OpenAI no devolvió imagen');
 
  if (item.b64_json) return item.b64_json;
 
  if (item.url) {
    const converted = await fetchUrlAsBase64(item.url);
    return converted.base64;
  }
 
  throw new Error('OpenAI no devolvió b64_json ni url');
}
 
async function runStabilityTxt2Img({ prompt, negativePrompt, stabilityKey }) {
  const negativeFinal =
    negativePrompt ||
    'blurry, low quality, distorted, deformed, ugly, text, watermark, logo, person, hand, finger, body part, face, skin, dark muddy background, flat lighting, oversaturated, cartoon, illustration, painting, abstract, surreal, fantasy, unrealistic proportions, cropped jewelry, partial view, cut off, multiple pieces, duplicate, broken metal, melted, warped, cheap looking, plastic, toy jewelry, costume jewelry';
 
  const body = JSON.stringify({
    text_prompts: [
      { text: prompt, weight: 1.25 },
      { text: negativeFinal, weight: -1 }
    ],
    cfg_scale: 11,
    height: 1024,
    width: 1024,
    steps: 38,
    samples: 1
  });
 
  const stabRes = await fetch(
    'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + stabilityKey,
        Accept: 'application/json'
      },
      body
    }
  );
 
  if (!stabRes.ok) {
    const errText = await stabRes.text();
    throw new Error(errText);
  }
 
  const data = await stabRes.json();
  if (!data.artifacts || !data.artifacts.length) {
    throw new Error('Sin imagen de Stability');
  }
 
  return data.artifacts[0].base64;
}
 
async function runStabilityImg2Img({ imageUrl, prompt, negativePrompt, stabilityKey, strength }) {
  const imgRes = await fetch(imageUrl);
 
  if (!imgRes.ok) {
    throw new Error('No se pudo descargar la imagen de referencia');
  }
 
  const imgBuffer = await imgRes.buffer();
  const image = await Jimp.read(imgBuffer);
  image.contain(1024, 1024);
  const resizedBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
 
  const negativeFinal =
    negativePrompt ||
    'blurry, low quality, distorted, deformed, ugly, watermark, logo, person, hand, cropped, cut off, broken chain, melted metal, impossible structure';
 
  const form = new FormData();
 
  form.append('init_image', resizedBuffer, {
    filename: 'reference.png',
    contentType: 'image/png'
  });
 
  form.append('init_image_mode', 'IMAGE_STRENGTH');
  form.append('image_strength', String(strength || 0.20));
  form.append('text_prompts[0][text]', prompt);
  form.append('text_prompts[0][weight]', '1.25');
  form.append('text_prompts[1][text]', negativeFinal);
  form.append('text_prompts[1][weight]', '-1');
  form.append('cfg_scale', '11');
  form.append('steps', '38');
  form.append('samples', '1');
 
  const stabRes = await fetch(
    'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
    {
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        Authorization: 'Bearer ' + stabilityKey,
        Accept: 'application/json'
      },
      body: form
    }
  );
 
  if (!stabRes.ok) {
    const errText = await stabRes.text();
    throw new Error(errText);
  }
 
  const data = await stabRes.json();
  if (!data.artifacts || !data.artifacts.length) {
    throw new Error('Sin imagen de Stability');
  }
 
  return data.artifacts[0].base64;
}
 
function createJob(prefix, variacion) {
  const jobId = `${prefix}_${Date.now()}_${variacion || '0'}_${Math.floor(Math.random() * 10000)}`;
  jobs[jobId] = { status: 'processing' };
  return jobId;
}
 
function finishJob(jobId, payload) {
  jobs[jobId] = payload;
  setTimeout(() => {
    delete jobs[jobId];
  }, 10 * 60 * 1000);
}
 
// ── OPENAI IMAGE EDIT — CON REFERENCIA ────────────────────────
app.post('/openai-edit', async (req, res) => {
  const { imageUrl, prompt, openaiKey, model, variacion } = req.body;
 
  if (!imageUrl || !prompt || !openaiKey) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan parámetros openai-edit'
    });
  }
 
  const jobId = createJob('job_openai_edit', variacion);
  res.json({ ok: true, jobId });
 
  (async () => {
    try {
      console.log('=== OPENAI IMAGE EDIT ===', jobId);
      const base64 = await runOpenAIImageEdit({
        imageUrl,
        prompt,
        openaiKey,
        model: model || 'gpt-image-1'
      });
 
      finishJob(jobId, {
        status: 'done',
        base64
      });
    } catch (e) {
      console.error('openai-edit error:', e.message);
      finishJob(jobId, {
        status: 'error',
        error: e.message
      });
    }
  })();
});
 
// ============================================================
// FIX BUG 1: OPENAI IMAGE GENERATE — SIN REFERENCIA
// Nuevo endpoint. Reemplaza a Stability txt2img como camino
// principal cuando el cliente no sube imagen de referencia.
// ============================================================
app.post('/openai-generate', async (req, res) => {
  const { prompt, openaiKey, model, variacion } = req.body;
 
  if (!prompt || !openaiKey) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan parámetros openai-generate'
    });
  }
 
  const jobId = createJob('job_openai_generate', variacion);
  res.json({ ok: true, jobId });
 
  (async () => {
    try {
      console.log('=== OPENAI IMAGE GENERATE ===', jobId);
      const base64 = await runOpenAIImageGenerate({
        prompt,
        openaiKey,
        model: model || 'gpt-image-1'
      });
 
      finishJob(jobId, {
        status: 'done',
        base64
      });
    } catch (e) {
      console.error('openai-generate error:', e.message);
      finishJob(jobId, {
        status: 'error',
        error: e.message
      });
    }
  })();
});
 
// ── IMG2IMG STABILITY — FALLBACK / COMPATIBILIDAD ─────────────
app.post('/img2img', async (req, res) => {
  const { imageUrl, prompt, negativePrompt, stabilityKey, strength, variacion } = req.body;
 
  if (!imageUrl || !prompt || !stabilityKey) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan parámetros img2img'
    });
  }
 
  const jobId = createJob('job_img2img', variacion);
  res.json({ ok: true, jobId });
 
  (async () => {
    try {
      console.log('=== STABILITY IMG2IMG ===', jobId);
      const base64 = await runStabilityImg2Img({
        imageUrl,
        prompt,
        negativePrompt,
        stabilityKey,
        strength: strength || 0.20
      });
 
      finishJob(jobId, {
        status: 'done',
        base64
      });
    } catch (e) {
      console.error('img2img error:', e.message);
      finishJob(jobId, {
        status: 'error',
        error: e.message
      });
    }
  })();
});
 
// ── TXT2IMG STABILITY — FALLBACK SIN REFERENCIA ───────────────
app.post('/txt2img', async (req, res) => {
  const { prompt, ambienteSuffix, negativePrompt, stabilityKey, variacion } = req.body;
 
  if (!prompt || !stabilityKey) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan parámetros txt2img'
    });
  }
 
  const jobId = createJob('job_txt2img', variacion);
  res.json({ ok: true, jobId });
 
  (async () => {
    try {
      console.log('=== STABILITY TXT2IMG ===', jobId);
      const base64 = await runStabilityTxt2Img({
        prompt: prompt + (ambienteSuffix || ''),
        negativePrompt,
        stabilityKey
      });
 
      finishJob(jobId, {
        status: 'done',
        base64
      });
    } catch (e) {
      console.error('txt2img error:', e.message);
      finishJob(jobId, {
        status: 'error',
        error: e.message
      });
    }
  })();
});
 
// ── CONSULTAR RESULTADO ───────────────────────────────────────
app.get('/img2img-result/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
 
  if (!job) {
    return res.json({ status: 'not_found' });
  }
 
  res.json(job);
});
 
app.get('/health', (req, res) => {
  res.json({ ok: true });
});
 
const PORT = process.env.PORT || 3000;
 
app.listen(PORT, () => {
  console.log('Servidor en puerto', PORT);
});
