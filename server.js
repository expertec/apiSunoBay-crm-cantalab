// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import axios from 'axios';

// Dile a fluent-ffmpeg dónde está el binario
ffmpeg.setFfmpegPath(ffmpegInstaller.path);


import { sendAudioMessage } from './whatsappService.js';  // ajusta ruta si es necesario


dotenv.config();

import { db, admin } from './firebaseAdmin.js';

import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  sendMessageToLead,
  getSessionPhone
} from './whatsappService.js';

import {
  processSequences,
  generateGuiones,
  sendGuiones,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  procesarClips,
  enviarMusicaPorWhatsApp,
  retryStuckMusic
} from './scheduler.js';


const app = express();
const port = process.env.PORT || 3001;

const upload = multer({ dest: path.resolve('./uploads') });

app.use(cors());
app.use(bodyParser.json());

// Endpoint para consultar el estado de WhatsApp (QR y conexión)
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    status: getConnectionStatus(),
    qr: getLatestQR()
  });
});

// Nuevo endpoint para obtener el número de sesión
app.get('/api/whatsapp/number', (req, res) => {
  const phone = getSessionPhone();
  if (phone) {
    res.json({ phone });
  } else {
    res.status(503).json({ error: 'WhatsApp no conectado' });
  }
});

app.post('/api/suno/callback', express.json(), async (req, res) => {
  const raw    = req.body;
  const taskId = raw.taskId || raw.data?.taskId || raw.data?.task_id;
  if (!taskId) return res.sendStatus(400);

  // Extrae la URL privada que envía Suno
  const item = Array.isArray(raw.data?.data)
    ? raw.data.data.find(i => i.audio_url || i.source_audio_url)
    : null;
  const audioUrlPrivada = item?.audio_url || item?.source_audio_url;
  if (!audioUrlPrivada) return res.sendStatus(200);

  // Busca el documento correspondiente en Firestore
  const snap = await db.collection('musica')
    .where('taskId', '==', taskId)
    .limit(1)
    .get();
  if (snap.empty) return res.sendStatus(404);
  const docRef = snap.docs[0].ref;

  try {
    // 1) Descarga el MP3 completo a un archivo temporal
    const tmpFull = path.join(os.tmpdir(), `${taskId}-full.mp3`);
    const r = await axios.get(audioUrlPrivada, { responseType: 'stream' });
    await new Promise((ok, ko) => {
      const ws = fs.createWriteStream(tmpFull);
      r.data.pipe(ws);
      ws.on('finish', ok);
      ws.on('error', ko);
    });

    // 2) Súbelo a Firebase Storage
    const dest = `musica/full/${taskId}.mp3`;
    await bucket.upload(tmpFull, {
      destination: dest,
      metadata: { contentType: 'audio/mpeg' }
    });

    // 3) Genera URL firmada pública
    const [fullUrl] = await bucket
      .file(dest)
      .getSignedUrl({ action: 'read', expires: Date.now() + 86400_000 });

    // 4) Actualiza el documento para que procesarClips() lo recoja
    await docRef.update({
      fullUrl,
      status: 'Audio listo',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 5) Limpia el archivo temporal
    fs.unlink(tmpFull, () => {});

    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ callback Suno error:', err);
    await docRef.update({ status: 'Error música', errorMsg: err.message });
    return res.sendStatus(500);
  }
});


// Endpoint para enviar mensaje de WhatsApp
app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;
  if (!leadId || !message) {
    return res.status(400).json({ error: 'Faltan leadId o message en el body' });
  }

  try {
    const leadRef = db.collection('leads').doc(leadId);
    const leadDoc = await leadRef.get();
    if (!leadDoc.exists) {
      return res.status(404).json({ error: "Lead no encontrado" });
    }

    const { telefono } = leadDoc.data();
    if (!telefono) {
      return res.status(400).json({ error: "Lead sin número de teléfono" });
    }

    // Delega la normalización y el guardado a sendMessageToLead
    const result = await sendMessageToLead(telefono, message);
    return res.json(result);
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Recibe el audio, lo convierte a M4A y lo envía por Baileys
app.post(
  '/api/whatsapp/send-audio',
  upload.single('audio'),
  async (req, res) => {
    const { phone } = req.body;
    const uploadPath = req.file.path;           // WebM/Opus crudo
    const m4aPath   = `${uploadPath}.m4a`;      // destino M4A

    try {
      // 1) Transcodifica a M4A (AAC)
      await new Promise((resolve, reject) => {
        ffmpeg(uploadPath)
          .outputOptions(['-c:a aac', '-vn'])
          .toFormat('mp4')
          .save(m4aPath)
          .on('end', resolve)
          .on('error', reject);
      });

      // 2) Envía la nota de voz ya en M4A
      await sendAudioMessage(phone, m4aPath);

      // 3) Borra archivos temporales
      fs.unlinkSync(uploadPath);
      fs.unlinkSync(m4aPath);

      return res.json({ success: true });
    } catch (error) {
      console.error('Error enviando audio:', error);
      // limpia lo que haya quedado
      try { fs.unlinkSync(uploadPath); } catch {}
      try { fs.unlinkSync(m4aPath); }   catch {}
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);




// (Opcional) Marcar todos los mensajes de un lead como leídos
app.post('/api/whatsapp/mark-read', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) {
    return res.status(400).json({ error: "Falta leadId en el body" });
  }
  try {
    await db.collection('leads')
            .doc(leadId)
            .update({ unreadCount: 0 });
    return res.json({ success: true });
  } catch (err) {
    console.error("Error marcando como leídos:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Arranca el servidor y conecta WhatsApp
app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err =>
    console.error("Error al conectar WhatsApp en startup:", err)
  );

  generateGuiones().catch(err =>
    console.error("Error inicial en generateGuiones:", err)
  );
  sendGuiones().catch(err =>
    console.error("Error inicial en sendGuiones:", err)
  );
  
});

 // Scheduler: ejecuta las secuencias activas cada 15 segundos
 cron.schedule('*/30 * * * * *', () => {
  console.log('⏱️ processSequences:', new Date().toISOString());
  processSequences().catch(err => console.error('Error en processSequences:', err));
});

// Genera guiones pendientes cada minuto
cron.schedule('* * * * *', () => {
  console.log('🖋️ generateGuiones:', new Date().toISOString());
  generateGuiones().catch(err => console.error('Error en generateGuiones:', err));
});

// Envía guiones pendientes cada minuto
cron.schedule('* * * * *', () => {
  console.log('📨 sendGuiones:', new Date().toISOString());
  sendGuiones().catch(err => console.error('Error en sendGuiones:', err));
});

// Música
cron.schedule('*/1 * * * *', generarLetraParaMusica);
cron.schedule('*/1 * * * *', generarPromptParaMusica);
cron.schedule('*/2 * * * *', generarMusicaConSuno);
cron.schedule('*/2 * * * *', procesarClips);
cron.schedule('*/1 * * * *', enviarMusicaPorWhatsApp);
cron.schedule('*/5 * * * *', () => retryStuckMusic(10));