// scheduler.js FINAL CORREGIDO - Listo para producción
import admin from 'firebase-admin';
import { getWhatsAppSock } from './whatsappService.js';
import { db } from './firebaseAdmin.js';
import { Configuration, OpenAIApi } from 'openai';

// 🔧 CRÍTICO: Importar dependencias faltantes
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { sendMessageToLead, sendClipMessage } from './whatsappService.js';

// 🔧 CRÍTICO: Definir constantes faltantes
const bucket = admin.storage().bucket();
const { FieldValue } = admin.firestore;

// 🔧 CRÍTICO: Configurar OpenAI correctamente
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta la variable de entorno OPENAI_API_KEY");
}

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Cache para secuencias - EVITA CONSULTAS REPETITIVAS
const sequenceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Cache para configuración
let configCache = null;
let configCacheTime = 0;

/**
 * 🔧 FUNCIÓN FALTANTE: replacePlaceholders
 */
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    const value = leadData[field] || '';
    if (field === 'nombre') {
      return value.split(' ')[0] || '';
    }
    return value;
  });
}

/**
 * 🔧 FUNCIÓN FALTANTE: downloadStream
 */
async function downloadStream(url, destPath) {
  const res = await axios.get(url, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

/**
 * 🔧 FUNCIÓN FALTANTE: lanzarTareaSuno
 */
async function lanzarTareaSuno({ title, stylePrompt, lyrics }) {
  const url = 'https://apibox.erweima.ai/api/v1/generate';
  const body = { 
    model: "V4_5", 
    customMode: true, 
    instrumental: false,
    title, 
    style: stylePrompt, 
    prompt: lyrics,
    callbackUrl: process.env.CALLBACK_URL 
  };
  
  console.log('🛠️ Suno request:', body);
  
  const res = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SUNO_API_KEY}`
    }
  });
  
  console.log('🛠️ Suno response:', res.status, res.data);
  
  if (res.data.code !== 200 || !res.data.data?.taskId) {
    throw new Error(`No taskId recibido: ${JSON.stringify(res.data)}`);
  }
  
  return res.data.data.taskId;
}

/**
 * 🔧 FUNCIÓN FALTANTE: enviarMensaje
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
          video: { url: replacePlaceholders(mensaje.contenido, lead) }
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
 * OPTIMIZACIÓN 1: Cache de secuencias
 */
async function getSequenceFromCache(trigger) {
  const now = Date.now();
  const cached = sequenceCache.get(trigger);
  
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  const seqSnap = await db
    .collection('secuencias')
    .where('trigger', '==', trigger)
    .limit(1)
    .get();

  const data = seqSnap.empty ? null : seqSnap.docs[0].data();
  sequenceCache.set(trigger, { data, timestamp: now });
  return data;
}

/**
 * OPTIMIZACIÓN 2: Cache de configuración
 */
async function getConfigFromCache() {
  const now = Date.now();
  if (configCache && (now - configCacheTime) < CACHE_TTL) {
    return configCache;
  }

  const cfgSnap = await db.collection('config').doc('appConfig').get();
  configCache = cfgSnap.exists ? cfgSnap.data() : {};
  configCacheTime = now;
  return configCache;
}

/**
 * PROCESO PRINCIPAL: Secuencias optimizado
 */
async function processSequences() {
  try {
    console.log('🔍 Iniciando processSequences optimizado...');
    
    const leadsSnap = await db
      .collection('leads')
      .where('secuenciasActivas', '!=', null)
      .where('estado', '!=', 'completado')
      .limit(50)
      .get();

    if (leadsSnap.empty) {
      console.log('✅ No hay leads con secuencias activas');
      return;
    }

    console.log(`📊 Procesando ${leadsSnap.docs.length} leads`);
    
    const batch = db.batch();
    let batchCount = 0;
    const MAX_BATCH_SIZE = 10;

    for (const doc of leadsSnap.docs) {
      const lead = { id: doc.id, ...doc.data() };
      
      if (!Array.isArray(lead.secuenciasActivas) || !lead.secuenciasActivas.length) {
        continue;
      }

      let needsUpdate = false;
      const updatedSequences = [];

      for (const seq of lead.secuenciasActivas) {
        const { trigger, startTime, index } = seq;
        
        const sequenceData = await getSequenceFromCache(trigger);
        if (!sequenceData) {
          console.warn(`⚠️ Secuencia no encontrada: ${trigger}`);
          continue;
        }

        const msgs = sequenceData.messages;
        if (index >= msgs.length) {
          needsUpdate = true;
          continue;
        }

        const msg = msgs[index];
        const sendAt = new Date(startTime).getTime() + msg.delay * 60000;
        
        if (Date.now() >= sendAt) {
          await enviarMensaje(lead, msg);
          
          if (index % 3 === 0) {
            await db
              .collection('leads')
              .doc(lead.id)
              .collection('messages')
              .add({
                content: `Secuencia ${trigger}: mensajes ${index+1}-${Math.min(index+3, msgs.length)}`,
                sender: 'system',
                timestamp: new Date(),
                type: 'batch_summary'
              });
          }

          seq.index++;
          needsUpdate = true;
        }

        updatedSequences.push(seq);
      }

      if (needsUpdate && batchCount < MAX_BATCH_SIZE) {
        const leadRef = db.collection('leads').doc(lead.id);
        batch.update(leadRef, { 
          secuenciasActivas: updatedSequences,
          lastProcessedAt: FieldValue.serverTimestamp()
        });
        batchCount++;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
      console.log(`✅ Batch actualizado: ${batchCount} leads`);
    }

  } catch (err) {
    console.error("❌ Error en processSequences:", err);
  }
}

/**
 * GENERAR LETRA OPTIMIZADA
 */
async function generarLetraParaMusica() {
  const snap = await db
    .collection('musica')
    .where('status', '==', 'Sin letra')
    .limit(1)
    .get();
    
  if (snap.empty) return;

  const docSnap = snap.docs[0];
  const d = docSnap.data();
  
  await docSnap.ref.update({
    status: 'Generando letra',
    processingStartedAt: FieldValue.serverTimestamp()
  });

  try {
    const prompt = `
Escribe una letra de canción con lenguaje simple siguiendo esta estructura:
verso 1, verso 2, coro, verso 3, verso 4 y coro.
Agrega título en negritas.
Propósito: ${d.purpose}.
Nombre: ${d.includeName}.
Anecdotas: ${d.anecdotes}.
    `.trim();

    const resp = await openai.createChatCompletion({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Eres un compositor creativo.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 400
    });
    
    const letra = resp.data.choices?.[0]?.message?.content?.trim();
    if (!letra) throw new Error(`No letra generada para ${docSnap.id}`);

    const batch = db.batch();
    
    batch.update(docSnap.ref, {
      lyrics: letra,
      status: 'Sin prompt',
      lyricsGeneratedAt: FieldValue.serverTimestamp()
    });

    if (d.leadId) {
      const leadRef = db.collection('leads').doc(d.leadId);
      batch.update(leadRef, {
        letra: letra,
        letraIds: FieldValue.arrayUnion(docSnap.id),
        estadoProduccion: 'Letra Generada'
      });
    }

    await batch.commit();
    console.log(`✅ Letra generada para ${docSnap.id}`);
    
  } catch (error) {
    console.error(`❌ Error generando letra para ${docSnap.id}:`, error);
    await docSnap.ref.update({
      status: 'Error letra',
      errorMsg: error.message
    });
  }
}

/**
 * GENERAR PROMPT OPTIMIZADO
 */
async function generarPromptParaMusica() {
  const snap = await db
    .collection('musica')
    .where('status', '==', 'Sin prompt')
    .limit(1)
    .get();
    
  if (snap.empty) return;
  
  const docSnap = snap.docs[0];
  const data = docSnap.data();
  const { artist, genre, voiceType } = data;
  
  await docSnap.ref.update({
    status: 'Generando prompt',
    promptProcessingStartedAt: FieldValue.serverTimestamp()
  });

  try {
    if (!artist || !genre || !voiceType) {
      throw new Error(`Faltan datos: artist="${artist}", genre="${genre}", voiceType="${voiceType}"`);
    }

    const draft = `
Crea un prompt musical para Suno AI que capture el estilo de ${artist} del género ${genre} con voz ${voiceType}.

RESTRICCIONES IMPORTANTES:
- NO mencionar nombres de artistas por derechos de autor
- Máximo 120 caracteres
- Elementos separados por comas
- Enfocarse solo en elementos musicales: ritmo, instrumentos, géneros

EJEMPLO: "rock pop con influencias en blues, guitarra eléctrica, ritmo de batería enérgico"

Genera un prompt similar para esta canción.
    `.trim();

    const gptRes = await openai.createChatCompletion({
      model: 'gpt-4o',
      messages: [
        { 
          role: 'system', 
          content: 'Eres un experto en crear prompts musicales para IA. Respondes SOLO con el prompt final, sin explicaciones adicionales. Máximo 120 caracteres.'
        },
        { 
          role: 'user', 
          content: draft
        }
      ],
      max_tokens: 50,
      temperature: 0.7
    });

    let stylePrompt = gptRes.data.choices?.[0]?.message?.content?.trim();
    
    if (!stylePrompt) {
      throw new Error('GPT no devolvió un prompt válido');
    }

    if (stylePrompt.length > 120) {
      console.warn(`⚠️ Prompt muy largo (${stylePrompt.length} chars): ${stylePrompt}`);
      stylePrompt = stylePrompt.substring(0, 117) + '...';
      console.log(`✂️ Prompt truncado: ${stylePrompt}`);
    }

    const batch = db.batch();
    
    batch.update(docSnap.ref, {
      stylePrompt,
      status: 'Sin música',
      promptGeneratedAt: FieldValue.serverTimestamp()
    });

    if (data.leadId) {
      const leadRef = db.collection('leads').doc(data.leadId);
      batch.update(leadRef, {
        estadoProduccion: 'Prompt Generado',
        stylePrompt: stylePrompt
      });
    }

    await batch.commit();
    console.log(`✅ generarPromptParaMusica: ${docSnap.id} → "${stylePrompt}" (${stylePrompt.length} chars)`);

  } catch (err) {
    console.error(`❌ generarPromptParaMusica(${docSnap.id}):`, err.message);
    
    await docSnap.ref.update({
      status: 'Error prompt',
      errorMsg: err.message,
      errorAt: FieldValue.serverTimestamp()
    });

    if (data.leadId) {
      await db.collection('leads').doc(data.leadId).update({
        estadoProduccion: 'Error en Prompt'
      });
    }
  }
}

/**
 * GENERAR MÚSICA CON SUNO
 */
async function generarMusicaConSuno() {
  const snap = await db
    .collection('musica')
    .where('status', '==', 'Sin música')
    .limit(1)
    .get();
    
  if (snap.empty) return;
  
  const docSnap = snap.docs[0];
  const data = docSnap.data();
  
  await docSnap.ref.update({
    status: 'Procesando música',
    generatedAt: FieldValue.serverTimestamp(),
    processingStartedAt: FieldValue.serverTimestamp()
  });

  try {
    const taskId = await lanzarTareaSuno({
      title: data.purpose.slice(0, 30),
      stylePrompt: data.stylePrompt,
      lyrics: data.lyrics
    });
    
    await docSnap.ref.update({ 
      taskId,
      taskSubmittedAt: FieldValue.serverTimestamp()
    });
    
    console.log(`🔔 generarMusicaConSuno: task ${taskId} lanzado para ${docSnap.id}`);
  } catch (err) {
    console.error(`❌ generarMusicaConSuno(${docSnap.id}):`, err.message);
    await docSnap.ref.update({
      status: 'Error música',
      errorMsg: err.message,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}

/**
 * PROCESAR CLIPS OPTIMIZADO
 */
async function procesarClips() {
  const snap = await db
    .collection('musica')
    .where('status', '==', 'Audio listo')
    .limit(3)
    .get();
    
  if (snap.empty) return;

  console.log(`🎵 Procesando ${snap.docs.length} clips de audio`);

  for (const doc of snap.docs) {
    const ref = doc.ref;
    const { fullUrl } = doc.data();
    const id = doc.id;

    if (!fullUrl) {
      console.error(`[${id}] falta fullUrl`);
      await ref.update({ 
        status: 'Error sin fullUrl',
        errorMsg: 'fullUrl no disponible'
      });
      continue;
    }

    await ref.update({ 
      status: 'Generando clip',
      clipProcessingStartedAt: FieldValue.serverTimestamp()
    });

    const tmpFull = path.join(os.tmpdir(), `${id}-full.mp3`);
    const tmpClip = path.join(os.tmpdir(), `${id}-clip.m4a`);
    const watermarkUrl = 'https://cantalab.com/wp-content/uploads/2025/05/marca-de-agua-1-minuto.mp3';
    const tmpWatermark = path.join(os.tmpdir(), 'watermark.mp3');
    const tmpFinal = path.join(os.tmpdir(), `${id}-watermarked.m4a`);

    try {
      console.log(`[${id}] Descargando audio completo...`);
      await downloadStream(fullUrl, tmpFull);

      console.log(`[${id}] Creando clip de 60 segundos...`);
      await new Promise((res, rej) => {
        ffmpeg(tmpFull)
          .setStartTime(0)
          .setDuration(60)
          .audioCodec('aac')
          .format('ipod')
          .output(tmpClip)
          .on('end', res)
          .on('error', rej)
          .run();
      });

      console.log(`[${id}] Aplicando watermark...`);
      await downloadStream(watermarkUrl, tmpWatermark);
      await new Promise((res, rej) => {
        ffmpeg()
          .input(tmpClip)
          .input(tmpWatermark)
          .complexFilter([
            '[1]adelay=1000|1000,volume=0.3[wm];[0][wm]amix=inputs=2:duration=first'
          ])
          .audioCodec('aac')
          .format('ipod')
          .output(tmpFinal)
          .on('end', res)
          .on('error', rej)
          .run();
      });

      console.log(`[${id}] Subiendo clip final...`);
      const dest = `musica/clip/${id}-clip.m4a`;
      const [file] = await bucket.upload(tmpFinal, {
        destination: dest,
        metadata: { contentType: 'audio/mp4' }
      });
      await file.makePublic();
      const clipUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;

      const batch = db.batch();
      
      batch.update(ref, { 
        clipUrl, 
        status: 'Enviar música',
        clipGeneratedAt: FieldValue.serverTimestamp()
      });

      const leadPhone = doc.data().leadPhone;
      if (leadPhone) {
        const leadQuery = await db
          .collection('leads')
          .where('telefono', '==', leadPhone)
          .limit(1)
          .get();
        
        if (!leadQuery.empty) {
          batch.update(leadQuery.docs[0].ref, {
            estadoProduccion: 'Clip Listo'
          });
        }
      }

      await batch.commit();
      console.log(`✅ [${id}] Clip AAC listo → Enviar música`);

    } catch (err) {
      console.error(`❌ [${id}] Error procesando clip:`, err);
      await ref.update({ 
        status: 'Error clip',
        errorMsg: err.message,
        errorAt: FieldValue.serverTimestamp()
      });
    } finally {
      [tmpFull, tmpClip, tmpWatermark, tmpFinal].forEach(f => {
        try { 
          if (fs.existsSync(f)) {
            fs.unlinkSync(f); 
          }
        } catch (cleanupErr) {
          console.warn(`⚠️ No se pudo limpiar ${f}:`, cleanupErr.message);
        }
      });
    }
  }
}

/**
 * ENVIAR MÚSICA POR WHATSAPP
 */
async function enviarMusicaPorWhatsApp() {
  const snap = await db
    .collection('musica')
    .where('status', '==', 'Enviar música')
    .limit(3)
    .get();
    
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const { leadId, leadPhone, lyrics, clipUrl } = doc.data();
    const ref = doc.ref;

    if (!leadPhone || !lyrics || !clipUrl) {
      console.warn(`[${doc.id}] faltan datos`);
      continue;
    }

    await ref.update({
      status: 'Enviando música',
      sendingStartedAt: FieldValue.serverTimestamp()
    });

    try {
      const leadDoc = await db.collection('leads').doc(leadId).get();
      const name = leadDoc.exists ? leadDoc.data().nombre.split(' ')[0] : '';
      
      const saludo = name 
        ? `Hola ${name}, esta es la letra:\n\n${lyrics}`
        : `Esta es la letra:\n\n${lyrics}`;

      await sendMessageToLead(leadPhone, saludo);
      await sendMessageToLead(leadPhone, '¿Cómo la ves? Ahora escucha el clip.');
      await sendClipMessage(leadPhone, clipUrl);

      const batch = db.batch();
      
      batch.update(ref, {
        status: 'Enviada',
        sentAt: FieldValue.serverTimestamp()
      });

      batch.update(db.collection('leads').doc(leadId), {
        secuenciasActivas: FieldValue.arrayUnion({
          trigger: 'CancionEnviada',
          startTime: new Date().toISOString(),
          index: 0
        }),
        estadoProduccion: 'Canción Enviada'
      });

      await batch.commit();
      console.log(`✅ Música enviada a ${leadPhone}`);
      
    } catch (err) {
      console.error(`❌ Error enviando música ${doc.id}:`, err);
      await ref.update({
        status: 'Error música',
        errorMsg: err.message
      });
    }
  }
}

/**
 * LIMPIAR DOCUMENTOS STUCK
 */
async function limpiarDocumentosStuck() {
  const ahora = Date.now();
  const limite = ahora - (30 * 60 * 1000);
  
  const stuckDocs = await db
    .collection('musica')
    .where('status', 'in', ['Procesando música', 'Generando clip', 'Generando letra', 'Generando prompt'])
    .limit(10)
    .get();

  for (const doc of stuckDocs.docs) {
    const data = doc.data();
    const processingTime = data.processingStartedAt?.toDate?.()?.getTime() || 0;
    
    if (processingTime && processingTime < limite) {
      console.log(`🔄 Reiniciando documento stuck: ${doc.id}`);
      
      let newStatus = 'Sin letra';
      if (data.status === 'Procesando música') newStatus = 'Sin música';
      else if (data.status === 'Generando clip') newStatus = 'Audio listo';
      else if (data.status === 'Generando prompt') newStatus = 'Sin prompt';
      
      await doc.ref.update({
        status: newStatus,
        taskId: FieldValue.delete(),
        errorMsg: 'Reiniciado por timeout'
      });
    }
  }
}

/**
 * RETRY STUCK MUSIC - Función original mantenida
 */
async function retryStuckMusic(thresholdMin = 10) {
  const cutoff = Date.now() - thresholdMin * 60_000;
  const snap = await db.collection('musica')
    .where('status', '==', 'Procesando música')
    .where('generatedAt', '<=', new Date(cutoff))
    .get();
    
  for (const docSnap of snap.docs) {
    await docSnap.ref.update({
      status: 'Sin música',
      taskId: FieldValue.delete(),
      errorMsg: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}

// EXPORTAR TODAS LAS FUNCIONES
export {
  processSequences,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  procesarClips,
  enviarMusicaPorWhatsApp,
  limpiarDocumentosStuck,
  retryStuckMusic
};