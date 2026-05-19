const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const Jimp     = require('jimp');

const app  = express();
const jobs = {};

app.use(cors());
app.use(express.json({ limit: '10mb' }));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

async function runStabilityTxt2Img({ prompt, negativePrompt, stabilityKey }) {
  const negativeFinal =
    negativePrompt ||
    "blurry, low quality, distorted, deformed, ugly, text, watermark, logo, person, hand, finger, body part, face, skin, dark muddy background, flat lighting, oversaturated, cartoon, illustration, painting, abstract, surreal, fantasy, unrealistic proportions, cropped jewelry, partial view, cut off, multiple pieces, duplicate, broken metal, melted, warped, cheap looking, plastic, toy jewelry, costume jewelry";

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
    "blurry, low quality, distorted, deformed, ugly, watermark, logo, person, hand, cropped, cut off, broken chain, melted metal, impossible structure";

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

// ── IMG2IMG SUAVE CON FALLBACK INTERNO A TXT2IMG ──────────────
app.post('/img2img', async (req, res) => {
  const { imageUrl, prompt, negativePrompt, stabilityKey, strength, variacion } = req.body;

  if (!imageUrl || !prompt || !stabilityKey) {
    return res.status(400).json({ ok: false, error: 'Faltan parámetros img2img' });
  }

  const jobId = 'job_img2img_' + Date.now() + '_' + (variacion || '0');
  jobs[jobId] = { status: 'processing' };
  res.json({ ok: true, jobId });

  (async () => {
    try {
      console.log('=== IMG2IMG SUAVE ===', jobId, 'strength:', strength || 0.20);

      const base64 = await runStabilityImg2Img({
        imageUrl,
        prompt,
        negativePrompt,
        stabilityKey,
        strength: strength || 0.20
      });

      jobs[jobId] = { status: 'done', base64 };
      setTimeout(() => { delete jobs[jobId]; }, 10 * 60 * 1000);

    } catch (e) {
      console.error('img2img error, intentando fallback txt2img:', e.message);

      try {
        const fallbackPrompt =
          prompt +
          ' Fallback generation without image conditioning: preserve the compatible visual DNA described in the prompt, but prioritize the client brief and produce a coherent realistic jewelry product.';

        const base64 = await runStabilityTxt2Img({
          prompt: fallbackPrompt,
          negativePrompt,
          stabilityKey
        });

        jobs[jobId] = { status: 'done', base64, fallback: true };
        setTimeout(() => { delete jobs[jobId]; }, 10 * 60 * 1000);

      } catch (fallbackError) {
        console.error('fallback txt2img error:', fallbackError.message);
        jobs[jobId] = { status: 'error', error: fallbackError.message };
      }
    }
  })();
});

// ── TXT2IMG ORIGINAL ──────────────────────────────────────────
app.post('/txt2img', async (req, res) => {
  const { prompt, ambienteSuffix, negativePrompt, stabilityKey, variacion } = req.body;

  if (!prompt || !stabilityKey) {
    return res.status(400).json({ ok: false, error: 'Faltan parámetros txt2img' });
  }

  const jobId = 'job_txt2img_' + Date.now() + '_' + (variacion || '0');
  jobs[jobId] = { status: 'processing' };
  res.json({ ok: true, jobId });

  (async () => {
    try {
      console.log('=== TXT2IMG ===', jobId);

      const promptFinal = prompt + (ambienteSuffix || '');

      const base64 = await runStabilityTxt2Img({
        prompt: promptFinal,
        negativePrompt,
        stabilityKey
      });

      jobs[jobId] = { status: 'done', base64 };
      setTimeout(() => { delete jobs[jobId]; }, 10 * 60 * 1000);

    } catch (e) {
      console.error('txt2img error:', e.message);
      jobs[jobId] = { status: 'error', error: e.message };
    }
  })();
});

// ── CONSULTAR RESULTADO ───────────────────────────────────────
app.get('/img2img-result/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ status: 'not_found' });
  res.json(job);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor en puerto', PORT));
