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
