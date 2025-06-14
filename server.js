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
import os from 'os';               // ← Asegúrate de importar

import { db, admin } from './firebaseAdmin.js';
const bucket = admin.storage().bucket();


// Dile a fluent-ffmpeg dónde está el binario
ffmpeg.setFfmpegPath(ffmpegInstaller.path);


import { sendAudioMessage } from './whatsappService.js';  // ajusta ruta si es necesario
import { sendClipMessage } from './whatsappService.js';  // ya lo tienes exportado
import { sendFullAudioAsDocument } from './whatsappService.js';





dotenv.config();



import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  sendMessageToLead,
  getSessionPhone
} from './whatsappService.js';

import {
  processSequences,
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
    const [file] = await bucket.upload(tmpFull, {
      destination: dest,
      metadata: { contentType: 'audio/mpeg' }
    });

    // 3) Haz el archivo público
    await file.makePublic();
    // 4) Construye la URL pública (sin firma ni expiración)
    const fullUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;

    // 5) Actualiza el documento para que procesarClips() lo recoja
    await docRef.update({
      fullUrl,
      status: 'Audio listo',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 6) Limpia el archivo temporal
    fs.unlink(tmpFull, () => {});

    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ callback Suno error:', err);
    await docRef.update({ status: 'Error música', errorMsg: err.message });
    return res.sendStatus(500);
  }
});

/**
 * Envía la canción completa como adjunto y marca el estado.
 */
app.post('/api/whatsapp/send-full', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Falta leadId' });

  try {
    // 1) Obtener lead y teléfono
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead no encontrado' });
    const telefono = String(leadSnap.data().telefono).replace(/\D/g, '');

    // 2) Obtener documento música
    const musicSnap = await db
      .collection('musica')
      .where('leadPhone', '==', telefono)
      .limit(1).get();
    if (musicSnap.empty) return res.status(404).json({ error: 'No hay música para este lead' });
    const fullUrl = musicSnap.docs[0].data().fullUrl;
    if (!fullUrl) return res.status(400).json({ error: 'fullUrl no disponible' });

    // 3) Enviar como documento adjunto
    await sendFullAudioAsDocument(telefono, fullUrl);

    // 4) Actualizar estados
    await musicSnap.docs[0].ref.update({
      status: 'Enviada completa',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('leads').doc(leadId).update({ estadoProduccion: 'Canción Enviada' });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/whatsapp/send-full:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send-full', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) {
    return res.status(400).json({ error: 'Falta leadId en el body' });
  }

  try {
    // 1) Obtén el lead y su teléfono
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }
    const telefono = String(leadSnap.data().telefono).replace(/\D/g, '');

    // 2) Busca el documento de música asociado
    const musicSnap = await db
      .collection('musica')
      .where('leadPhone', '==', telefono)
      .limit(1)
      .get();
    if (musicSnap.empty) {
      return res.status(404).json({ error: 'No hay música para este lead' });
    }
    const musicData = musicSnap.docs[0].data();

    // 3) Toma el fullUrl
    const fullUrl = musicData.fullUrl;
    if (!fullUrl) {
      return res.status(400).json({ error: 'fullUrl no disponible' });
    }

    // 4) Envía la canción completa por WhatsApp
    await sendClipMessage(telefono, fullUrl);

    // 5) Actualiza status en 'musica'
    await musicSnap.docs[0].ref.update({
      status: 'Enviada completa',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 6) Actualiza estadoProduccion en 'leads'
    await db.collection('leads').doc(leadId).update({
      estadoProduccion: 'Canción Enviada'
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/whatsapp/send-full:', err);
    return res.status(500).json({ error: err.message });
  }
});


app.post('/api/whatsapp/send-clip', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) {
    return res.status(400).json({ error: 'Falta leadId en el body' });
  }
  try {
    // 1) Obtener teléfono del lead
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }
    const telefono = String(leadSnap.data().telefono).replace(/\D/g, '');

    // 2) Obtener clipUrl de la colección 'musica'
    const musicSnap = await db
      .collection('musica')
      .where('leadPhone', '==', telefono)
      .limit(1)
      .get();

    if (musicSnap.empty) {
      return res.status(404).json({ error: 'No hay clip generado para este lead' });
    }
    const { clipUrl } = musicSnap.docs[0].data();
    if (!clipUrl) {
      return res.status(400).json({ error: 'Clip aún no disponible' });
    }

    // 3) Enviar el clip por WhatsApp
    await sendClipMessage(telefono, clipUrl);

    // 4) Marcar en Firestore que se envió desde el botón
    await musicSnap.docs[0].ref.update({
      status: 'Enviado por botón',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error enviando clip:', err);
    return res.status(500).json({ error: err.message });
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


  
});

 // Scheduler: ejecuta las secuencias activas cada 15 segundos
 cron.schedule('*/30 * * * * *', () => {
  console.log('⏱️ processSequences:', new Date().toISOString());
  processSequences().catch(err => console.error('Error en processSequences:', err));
});



// Música
cron.schedule('*/1 * * * *', generarLetraParaMusica);
cron.schedule('*/1 * * * *', generarPromptParaMusica);
cron.schedule('*/2 * * * *', generarMusicaConSuno);
cron.schedule('*/2 * * * *', procesarClips);
cron.schedule('*/1 * * * *', enviarMusicaPorWhatsApp);
cron.schedule('*/5 * * * *', () => retryStuckMusic(10));