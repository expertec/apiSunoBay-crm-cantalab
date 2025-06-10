// src/server/scheduler.js
import admin from 'firebase-admin';
import { getWhatsAppSock } from './whatsappService.js';
import { db } from './firebaseAdmin.js';
import { Configuration, OpenAIApi } from 'openai';

// al inicio de src/server/scheduler.js, tras tus imports existentes:
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';


const bucket = admin.storage().bucket();

const { FieldValue } = admin.firestore;
// Asegúrate de que la API key esté definida
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta la variable de entorno OPENAI_API_KEY");
}

// Configuración de OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

/**
 * Reemplaza placeholders en plantillas de texto.
 * {{campo}} se sustituye por leadData.campo si existe.
 */
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    const value = leadData[field] || '';
    if (field === 'nombre') {
      // devolver sólo la primera palabra del nombre completo
      return value.split(' ')[0] || '';
    }
    return value;
  });
}


async function downloadStream(url, destPath) {
  const res = await axios.get(url, { responseType: 'stream' });
  await new Promise((r, e) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on('finish', r);
    ws.on('error', e);
  });
}

// helper que lanza la tarea en Suno y devuelve taskId
async function lanzarTareaSuno({ title, stylePrompt, lyrics }) {
  const res = await axios.post(
    'https://apibox.erweima.ai/api/v1/generate',
    { model: "V4_5", customMode: true, instrumental: false, title, style: stylePrompt, prompt: lyrics, callbackUrl: process.env.CALLBACK_URL },
    { headers: { 'Content-Type':'application/json', Authorization:`Bearer ${process.env.SUNO_API_KEY}` } }
  );
  if (res.data.code !== 200 || !res.data.data?.taskId) throw new Error('No taskId de Suno');
  return res.data.data.taskId;
}


/**
 * Envía un mensaje de WhatsApp según su tipo.
 * Usa exactamente el número que viene en lead.telefono (sin anteponer country code).
 */
async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) return;

    const phone = (lead.telefono || '').replace(/\D/g, '');
    const jid = `${phone}@s.whatsapp.net`;

    switch (mensaje.type) {
      case 'texto': {
        const text = replacePlaceholders(mensaje.contenido, lead).trim();
        if (text) await sock.sendMessage(jid, { text });
        break;
      }
      case 'formulario': {
        const rawTemplate = mensaje.contenido || '';
        const nameVal = encodeURIComponent(lead.nombre || '');
        const text = rawTemplate
          .replace('{{telefono}}', phone)
          .replace('{{nombre}}', nameVal)
          .replace(/\r?\n/g, ' ')
          .trim();
        if (text) await sock.sendMessage(jid, { text });
        break;
      }
      case 'audio': {
        const audioUrl = replacePlaceholders(mensaje.contenido, lead);
        console.log('→ Enviando PTT desde URL:', audioUrl);
        await sock.sendMessage(jid, {
          audio: { url: audioUrl },
          ptt: true
      
        });
        break;
      }
      case 'imagen':
        await sock.sendMessage(jid, {
          image: { url: replacePlaceholders(mensaje.contenido, lead) }
        });
        break;
      case 'video':
        await sock.sendMessage(jid, {
          video: { url: replacePlaceholders(mensaje.contenido, lead) },
          // si quieres un caption, descomenta la línea siguiente y añade mensaje.contenidoCaption en tu secuencia
          // caption: replacePlaceholders(mensaje.contenidoCaption || '', lead)
        });
        break;
      default:
        console.warn(`Tipo desconocido: ${mensaje.type}`);
    }
  } catch (err) {
    console.error("Error al enviar mensaje:", err);
  }
}


/**
 * Procesa las secuencias activas de cada lead.
 */
async function processSequences() {
  try {
    const leadsSnap = await db
      .collection('leads')
      .where('secuenciasActivas', '!=', null)
      .get();

    for (const doc of leadsSnap.docs) {
      const lead = { id: doc.id, ...doc.data() };
      if (!Array.isArray(lead.secuenciasActivas) || !lead.secuenciasActivas.length) continue;

      let dirty = false;
      for (const seq of lead.secuenciasActivas) {
        const { trigger, startTime, index } = seq;
        const seqSnap = await db
          .collection('secuencias')
          .where('trigger', '==', trigger)
          .get();
        if (seqSnap.empty) continue;

        const msgs = seqSnap.docs[0].data().messages;
        if (index >= msgs.length) {
          seq.completed = true;
          dirty = true;
          continue;
        }

        const msg = msgs[index];
        const sendAt = new Date(startTime).getTime() + msg.delay * 60000;
        if (Date.now() < sendAt) continue;

        // Enviar y luego registrar en Firestore
        await enviarMensaje(lead, msg);
        await db
          .collection('leads')
          .doc(lead.id)
          .collection('messages')
          .add({
            content: `Se envió el ${msg.type} de la secuencia ${trigger}`,
            sender: 'system',
            timestamp: new Date()
          });

        seq.index++;
        dirty = true;
      }

      if (dirty) {
        const rem = lead.secuenciasActivas.filter(s => !s.completed);
        await db.collection('leads').doc(lead.id).update({ secuenciasActivas: rem });
      }
    }
  } catch (err) {
    console.error("Error en processSequences:", err);
  }
}

/**
 * Genera guiones VSL para los registros en 'guionesVideo' con status 'Sin guion',
 * guarda el guion, marca status → 'enviarGuion' y añade marca de tiempo.
 */
async function generateGuiones() {
  console.log("▶️ generateGuiones: inicio");
  try {
    const snap = await db.collection('guionesVideo').where('status', '==', 'Sin guion').get();
    console.log(`✔️ encontrados ${snap.size} guiones pendientes`);

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      // Adaptamos tu prompt VSL con placeholders
            // Adaptamos tu nuevo prompt con description y lenguaje sencillo
            const prompt = `
            Eres un creador de guiones de 1 minuto usando el método de viralidad en ventas.
            Tu lenguaje debe ser muy sencillo y cercano al dueño de negocio.
            Divide el guion en bloques con tiempos aproximados y utiliza estos datos:
            
            - Descripción del negocio/producto: ${data.description}
            - Nombre del negocio: ${data.businessName}
            - Objetivo del anuncio: ${data.purpose}
            - Promoción (si la hay): ${data.promo || 'ninguna'}
            
            Estructura sugerida:
            1. 0:00–0:10 Gancho: breve frase que capte atención y muestre el beneficio principal.
            2. 0:10–0:20 Testimonio: cita corta de un cliente satisfecho.
            3. 0:20–0:30 Dolor: describe el problema que enfrenta tu cliente.
            4. 0:30–0:40 Solución: muestra cómo resuelves ese problema.
            5. 0:40–0:55 Llamado a la acción: invita a aprovechar la promoción con urgencia.
            6. 0:55–1:00 Cierre: logo, contacto y CTA final.
            
            Texto para voz con tono cercano y entusiasta. Notas de edición: ritmo dinámico, texto en pantalla, música que sube en la parte 3.
            
            Escribe el guion en español, máximo 250–300 palabras, listo para grabar.
            `.trim();
            


      console.log(`📝 prompt para ${docSnap.id}:\n${prompt}`);

      const response = await openai.createChatCompletion({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Eres un experto creador de guiones de video persuasivos.' },
          { role: 'user', content: prompt }
        ]
      });

      const guion = response.data.choices?.[0]?.message?.content?.trim();
      if (guion) {
        console.log(`✅ guion generado para ${docSnap.id}`);
        await docSnap.ref.update({
          guion,
          status: 'enviarGuion',
          guionGeneratedAt: FieldValue.serverTimestamp()
        });
      }
    }
    console.log("▶️ generateGuiones: finalizado");
  } catch (err) {
    console.error("❌ Error generateGuiones:", err);
  }
}


/**
 * Envía por WhatsApp los guiones generados (status 'enviarGuion'),
 * añade trigger 'GuionEnviado' al lead y marca status → 'enviado'.
 * Solo envía si han pasado al menos 15 minutos desde 'guionGeneratedAt'.
 */



async function sendGuiones() {
  try {
    const now  = Date.now();
    const snap = await db.collection('guionesVideo')
                         .where('status', '==', 'enviarGuion')
                         .get();

    // URLs fijas de ejemplo
    const AUDIO_URL = 'https://storage.googleapis.com/merkagrama-crm.firebasestorage.app/audios/5218311760335-1746861301204.ogg?GoogleAccessId=firebase-adminsdk-fbsvc%40merkagrama-crm.iam.gserviceaccount.com&Expires=16730323200&Signature=twPtM5OppKWxMODTZFmZiyzMtZ1YdORW7QzguIopKhmt0tGbFFziET2zXnCJyhZjhawLZ08dOdumJNixWCAZgH2%2BmEavFo9ku2aFXDa96uP3sxZqIDglPhE6kHBegWtlGxgLKYxhnv%2Bi0UkVlqMXKAV9OrfqAEQGG7ovzYEMBpBRWF%2FFHeCG3S5B5yelnr8fCu0uj3TBCQBHonyCXVPX2%2Fi1mn1qNmj6i6NP2aLgC7lJSwdp%2FZEB803XheH3KaoM4%2B3mHXAN%2FwKCveonUBuJzZ6K6dsG94gJxISBHSqpiK1h9URY4jhB7apjMgvCb3Rk5selLRhJTRXwMHfePmBoAg%3D%3D'; 

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const { leadPhone, leadId, guion, guionGeneratedAt, senderName } = data;
      if (!leadPhone || !guion || !guionGeneratedAt) continue;

      const genTime = guionGeneratedAt.toDate().getTime();
      if (now - genTime < 15 * 60 * 1000) continue;

      // 1) Marcar como enviado en Firestore
      await docSnap.ref.update({ status: 'enviado' });
      console.log(`[sendGuiones] 🔒 ${docSnap.id} marcado como 'enviado'`);

      // 2) Prepara los datos comunes
      const lead = { telefono: leadPhone, id: leadId, nombre: senderName };
      
      // 3) Aviso de texto
      const firstName = (senderName||'').split(' ')[0] || '';
      const aviso     = `¡Listo ${firstName}! El guion de tu anuncio está listo. Revísalo y dime si tienes dudas.`;
      await enviarMensaje(lead, { type: 'texto', contenido: aviso });
      await db.collection('leads').doc(leadId).collection('messages')
              .add({ content: aviso, sender: 'business', timestamp: new Date() });

      // 4) Envío del guion en texto
      await enviarMensaje(lead, { type: 'texto', contenido: guion });
      await db.collection('leads').doc(leadId).collection('messages')
              .add({ content: guion, sender: 'business', timestamp: new Date() });

      // 5) Envío de la nota de voz reutilizando la misma lógica de audio
      await enviarMensaje(lead, { type: 'audio', contenido: AUDIO_URL });
      await db.collection('leads').doc(leadId).collection('messages')
              .add({ mediaType: 'audio', mediaUrl: AUDIO_URL, sender: 'business', timestamp: new Date() });

      // 6) (Opcional) Envío de un video
      // await enviarMensaje(lead, { type: 'video', contenido: VIDEO_URL });

      // 7) Actualizar lead para la siguiente secuencia
      await db.collection('leads').doc(leadId).update({
        etiquetas: FieldValue.arrayUnion('GuionEnviado'),
        secuenciasActivas: FieldValue.arrayUnion({
          trigger: 'GuionEnviado',
          startTime: new Date().toISOString(),
          index: 0
        })
      });

      console.log(`[sendGuiones] ✅ Guion ${docSnap.id} enviado`);
    }
  } catch (err) {
    console.error("❌ Error en sendGuiones:", err);
  }
}


// ————— Funciones para generación de canciones —————

async function generarLetraParaMusica() {
  const snap = await db.collection('musica').where('status','==','Sin letra').limit(1).get();
  if (snap.empty) return;
  const doc = snap.docs[0], d = doc.data();
  const prompt = `
Escribe una letra de canción con lenguaje simple siguiendo esta estructura:
verso 1, verso 2, coro, verso 3, verso 4 y coro.
Agrega título en negritas.
Propósito: ${d.purpose}.
Nombre: ${d.includeName}.
Anecdotas: ${d.anecdotes}.
`.trim();
  const resp = await openai.createChatCompletion({
    model:'gpt-4o',
    messages:[
      {role:'system',content:'Eres un compositor creativo.'},
      {role:'user',content:prompt}
    ],
    max_tokens:400
  });
  const lyrics = resp.data.choices?.[0]?.message?.content?.trim();
  await doc.ref.update({ lyrics, status:'Sin prompt', lyricsGeneratedAt: FieldValue.serverTimestamp() });
}

async function generarPromptParaMusica() {
  const snap = await db.collection('musica').where('status','==','Sin prompt').limit(1).get();
  if (snap.empty) return;
  const doc = snap.docs[0], { artist, genre, voiceType } = doc.data();
  const draft = `Crea un prompt para Suno de una canción estilo ${artist}, género ${genre}, tipo de voz ${voiceType}, lista solo elementos separados por comas (máx 120 caracteres).`;
  const gpt = await openai.createChatCompletion({
    model:'gpt-4o',
    messages:[
      {role:'system',content:'Eres un redactor creativo de prompts musicales.'},
      {role:'user',content:`Refina para <120 caracteres: "${draft}"`}
    ]
  });
  const stylePrompt = gpt.data.choices[0].message.content.trim();
  await doc.ref.update({ stylePrompt, status:'Sin música' });
}

async function generarMusicaConSuno() {
  const snap = await db.collection('musica').where('status','==','Sin música').limit(1).get();
  if (snap.empty) return;
  const doc = snap.docs[0];
  await doc.ref.update({ status:'Procesando música', generatedAt: FieldValue.serverTimestamp() });
  try {
    const taskId = await lanzarTareaSuno({
      title: doc.data().purpose.slice(0,30),
      stylePrompt: doc.data().stylePrompt,
      lyrics: doc.data().lyrics
    });
    await doc.ref.update({ taskId });
  } catch (e) {
    await doc.ref.update({ status:'Error música', errorMsg:e.message, updatedAt: FieldValue.serverTimestamp() });
  }
}

async function procesarClips() {
  const snap = await db.collection('musica').where('status','==','Audio listo').get();
  if (snap.empty) return;
  for (const doc of snap.docs) {
    const id = doc.id, fullUrl = doc.data().fullUrl;
    await doc.ref.update({ status:'Generando clip' });
    const tmpFull = path.join(os.tmpdir(),`${id}-full.mp3`);
    const tmpClip = path.join(os.tmpdir(),`${id}-clip.mp3`);
    const waterTmp = path.join(os.tmpdir(),'watermark.mp3');
    const tmpWater = path.join(os.tmpdir(),`${id}-water.mp3`);
    await downloadStream(fullUrl, tmpFull);
    await new Promise((r,e)=>ffmpeg(tmpFull).setStartTime(0).setDuration(60).output(tmpClip).on('end',r).on('error',e).run());
    await downloadStream(process.env.WATERMARK_URL, waterTmp);
    await new Promise((r,e)=>ffmpeg().input(tmpClip).input(waterTmp)
      .complexFilter(['[1]adelay=1000|1000,volume=0.3[wm];[0][wm]amix=inputs=2:duration=first'])
      .output(tmpWater).on('end',r).on('error',e).run());
    const [file] = await bucket.upload(tmpWater, {
      destination:`musica/clip/${id}-clip.mp3`,
      metadata:{contentType:'audio/mpeg'}
    });
    const [clipUrl] = await file.getSignedUrl({ action:'read', expires:Date.now()+86400000 });
    await doc.ref.update({ clipUrl, status:'Enviar música' });
    [tmpFull,tmpClip,waterTmp,tmpWater].forEach(f=>fs.unlinkSync(f));
  }
}

async function enviarMusicaPorWhatsApp() {
  const snap = await db.collection('musica').where('status','==','Enviar música').get();
  if (snap.empty) return;
  for (const doc of snap.docs) {
    const d = doc.data();
    const phone = (d.leadPhone||'').replace(/\D/g,''), lyrics = d.lyrics, clip = d.clipUrl;
    if (!phone||!lyrics||!clip) continue;
    if (Date.now() - d.createdAt.toDate().getTime() < 15*60_000) continue;
    const { sendTextMessage, sendAudioMessage } = await import('./whatsappService.js');
    const lead = (await db.collection('leads').doc(d.leadId).get()).data();
    const name = lead.nombre?.split(' ')[0]||'';
    await sendTextMessage(phone, `Hola ${name}, aquí la letra:\n\n${lyrics}`);
    await sendTextMessage(phone, `¿Cómo la vez? Ahora escucha el clip.`);
    await sendAudioMessage(phone, clip);
    await doc.ref.update({ status:'Enviada', sentAt: FieldValue.serverTimestamp() });
    await db.collection('leads').doc(d.leadId)
      .update({ secuenciasActivas: FieldValue.arrayUnion({ trigger:'CancionEnviada', startTime:new Date().toISOString(), index:0 }) });
  }
}

async function retryStuckMusic(thresholdMin = 10) {
  const cutoff = Date.now() - thresholdMin*60_000;
  const snap = await db.collection('musica')
    .where('status','==','Procesando música')
    .where('generatedAt','<=',new Date(cutoff))
    .get();
  for (const doc of snap.docs) {
    await doc.ref.update({
      status:'Sin música',
      taskId: FieldValue.delete(),
      errorMsg: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}



export {
  processSequences,
  generateGuiones,
  sendGuiones,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  procesarClips,
  enviarMusicaPorWhatsApp,
  retryStuckMusic
};


