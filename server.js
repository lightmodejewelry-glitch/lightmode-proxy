const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/img2img', async (req, res) => {
  try {
    const { imageUrl, prompt, stabilityKey, strength } = req.body;

    if (!imageUrl || !prompt || !stabilityKey) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const promptFinal = prompt +
      ", placed on white marble surface, warm golden sunset lighting, " +
      "dramatic side light, luxury jewelry photography, editorial style, " +
      "shallow depth of field, 85mm lens, highly detailed, " +
      "full jewelry piece visible not cropped, 3/4 front view, " +
      "small object centered with negative space around it";

    const negativePrompt =
      "blurry, low quality, distorted, ugly, text, watermark, " +
      "dark background, flat lighting, person, hand, cropped, cut off";

    // Descargar imagen en binario real
    const imgRes    = await fetch(imageUrl);
    const imgBuffer = await imgRes.buffer();

    // Construir multipart con binario real
    const form = new FormData();
    form.append('init_image',              imgBuffer, { filename: 'reference.jpg', contentType: 'image/jpeg' });
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
      return res.status(stabRes.status).json({ error: errText });
    }

    const data = await stabRes.json();

    if (!data.artifacts || !data.artifacts.length) {
      return res.status(500).json({ error: 'Stability no devolvió imagen' });
    }

    res.json({ ok: true, base64: data.artifacts[0].base64 });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto', PORT));
