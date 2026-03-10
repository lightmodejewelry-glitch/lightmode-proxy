const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const Jimp     = require('jimp');

const app  = express();
const jobs = {};

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── PREPARAR IMAGEN (solo descarga y redimensiona) ────────────
app.post('/img2img-prepare', async (req, res) => {
  const { imageUrl, jobId } = req.body;

  if (!imageUrl || !jobId) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  jobs[jobId] = { status: 'preparing' };
  res.json({ ok: true, jobId });

  (async () => {
    try {
      const imgRes    = await fetch(imageUrl);
      const imgBuffer = await imgRes.buffer();

      const image = await Jimp.read(imgBuffer);
      image.cover(1024, 1024);
      const resizedBuffer = await image.getBufferAsync(Jimp.MIME_PNG);

      console.log(`Job ${jobId}: imagen preparada 1024x1024`);
      jobs[jobId] = { status: 'ready', buffer: resizedBuffer };

      setTimeout(() => { delete jobs[jobId]; }, 30 * 60 * 1000);
    } catch(e) {
      console.error(`Job ${jobId} prepare error:`, e.message);
      jobs[jobId] = { status: 'error', error: e.message };
    }
  })();
});

// ── GENERAR CON IMAGEN PREPARADA ──────────────────────────────
app.post('/img2img-generate', async (req, res) => {
  const { prompt, stabilityKey, strength, jobId } = req.body;

  if (!prompt || !stabilityKey || !jobId) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  const job = jobs[jobId];

  if (!job) {
    return res.status(400).json({ error: 'Job no encontrado' });
  }

  if (job.status === 'error') {
    return res.status(400).json({ error: job.error });
  }

  const genJobId = jobId + '_gen_' + Date.now();
  jobs[genJobId] = { status: 'processing' };
  res.json({ ok: true, genJobId });

  const bufferToUse = job.buffer;

  (async () => {
    await generarConBuffer(bufferToUse, prompt, stabilityKey, strength, genJobId);
  })();
});

// ── CONSULTAR RESULTADO ───────────────────────────────────────
app.get('/img2img-result/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ status: 'not_found' });
  res.json(job);
});

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── FUNCIÓN GENERAR ───────────────────────────────────────────
async function generarConBuffer(buffer, prompt, stabilityKey, strength, genJobId) {
  try {
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
    form.append('init_image',              buffer, { filename: 'reference.png', contentType: 'image/png' });
    form.append('init_image_mode',         'IMAGE_STRENGTH');
    form.append('image_strength',          String(strength || 0.45));
    form.append('text_prompts[0][text]',   promptFinal);
    form.append('text_prompts[0][weight]', '1');
    form.append('text_prompts[1][text]',   negativePrompt);
    form.append('text_prompts[1][weight]', '-1');
    form.append('cfg_scale',               '7');
    form.append('steps',                   '30');
    form.append('samples',                 '1');

    const stabRes = await fetch(
      'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
      {
        method:  'POST',
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
      console.error(`Job ${genJobId} Stability error:`, errText);
      jobs[genJobId] = { status: 'error', error: errText };
      return;
    }

    const data = await stabRes.json();

    if (!data.artifacts || !data.artifacts.length) {
      jobs[genJobId] = { status: 'error', error: 'Stability no devolvió imagen' };
      return;
    }

    console.log(`Job ${genJobId}: generación completada`);
    jobs[genJobId] = { status: 'done', base64: data.artifacts[0].base64 };
    setTimeout(() => { delete jobs[genJobId]; }, 10 * 60 * 1000);

  } catch(e) {
    console.error(`Job ${genJobId} error:`, e.message);
    jobs[genJobId] = { status: 'error', error: e.message };
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto', PORT));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto', PORT));
