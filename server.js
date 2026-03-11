const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const Jimp     = require('jimp');

const app  = express();
const jobs = {};

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── GENERATE TODO EN UNO ──────────────────────────────────────
app.post('/img2img', async (req, res) => {
  const { imageUrl, prompt, stabilityKey, strength } = req.body;
  if (!imageUrl || !prompt || !stabilityKey) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  const jobId = 'job_' + Date.now();
  jobs[jobId] = { status: 'processing' };
  res.json({ ok: true, jobId });

  (async () => {
    try {
      // 1. Descargar imagen
      const imgRes    = await fetch(imageUrl);
      const imgBuffer = await imgRes.buffer();

      // 2. Redimensionar a 1024x1024
      const image = await Jimp.read(imgBuffer);
      image.cover(1024, 1024);
      const resizedBuffer = await image.getBufferAsync(Jimp.MIME_PNG);

      // 3. Generar con Stability
      const promptFinal = prompt +
        ", placed on white marble surface, warm golden sunset lighting, " +
        "dramatic side light, luxury jewelry photography, editorial style, " +
        "shallow depth of field, 85mm lens, highly detailed, " +
        "full jewelry piece visible not cropped, 3/4 front view, " +
        "small object centered with negative space around it";

      const negativePrompt =
        "blurry, low quality, distorted, ugly, text, watermark, " +
        "dark background, flat lighting, person, hand, cropped, cut off";

      const form = new FormData();
      form.append('init_image',              resizedBuffer, { filename: 'reference.png', contentType: 'image/png' });
      form.append('init_image_mode',         'IMAGE_STRENGTH');
      form.append('image_strength',          String(strength || 0.35));
      form.append('text_prompts[0][text]',   promptFinal);
      form.append('text_prompts[0][weight]', '1');
      form.append('text_prompts[1][text]',   negativePrompt);
      form.append('text_prompts[1][weight]', '-1');
      form.append('cfg_scale',               '10');
      form.append('steps',                   '30');
      form.append('samples',                 '1');

      const stabRes = await fetch(
        'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
        {
          method:  'POST',
          headers: { ...form.getHeaders(), Authorization: 'Bearer ' + stabilityKey, Accept: 'application/json' },
          body: form
        }
      );

      if (!stabRes.ok) {
        const errText = await stabRes.text();
        jobs[jobId] = { status: 'error', error: errText };
        return;
      }

      const data = await stabRes.json();
      if (!data.artifacts || !data.artifacts.length) {
        jobs[jobId] = { status: 'error', error: 'Sin imagen de Stability' };
        return;
      }

      jobs[jobId] = { status: 'done', base64: data.artifacts[0].base64 };
      setTimeout(() => { delete jobs[jobId]; }, 10 * 60 * 1000);

    } catch(e) {
      console.error('Job error:', e.message);
      jobs[jobId] = { status: 'error', error: e.message };
    }
  })();
});

// ── RESULTADO ─────────────────────────────────────────────────
app.get('/img2img-result/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ status: 'not_found' });
  res.json(job);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor en puerto', PORT));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto', PORT));
