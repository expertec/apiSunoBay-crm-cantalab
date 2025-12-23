// whatsappService.js
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
  isJidGroup
} from 'baileys'; // Sin @whiskeysockets/
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';
import axios from 'axios';      
import { syncLeadNextSequence } from './sequenceUtils.js';

let latestQR = null;
let connectionStatus = "Desconectado";
let whatsappSock = null;
let sessionPhone = null; // almacenará el número de la sesión activa

const localAuthFolder = '/var/data';
const { FieldValue } = admin.firestore;
const bucket = admin.storage().bucket();
const DEFAULT_COUNTRY_CODE = '52';

// Normaliza un JID o un número y devuelve solo dígitos
function phoneFromJid(jid) {
  if (!jid) return null;
  const local = String(jid).split('@')[0] || '';
  const digits = local.replace(/\D/g, '');
  return digits || null;
}

// Convierte un número (con o sin prefijo) a JID de WhatsApp
function numberToJid(num) {
  if (!num) return null;
  let digits = String(num).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) digits = DEFAULT_COUNTRY_CODE + digits;
  return `${digits}@s.whatsapp.net`;
}

// Obtiene el mejor JID disponible desde la entidad del lead
export function extractJidFromLead(lead) {
  if (!lead) return null;
  const candidate =
    lead.resolvedJid ||
    lead.jid ||
    lead.id ||
    lead.leadId;
  if (candidate) return jidNormalizedUser(candidate);

  const digits = phoneFromJid(lead.telefono || lead.phone || '');
  const fallback = numberToJid(digits);
  return fallback ? jidNormalizedUser(fallback) : null;
}

function resolveTargetJid(target) {
  if (!target) return null;
  if (typeof target === 'string') {
    if (target.includes('@')) return jidNormalizedUser(target);
    const byNumber = numberToJid(target);
    return byNumber ? jidNormalizedUser(byNumber) : null;
  }
  if (typeof target === 'object') {
    const fromLead = extractJidFromLead(target);
    if (fromLead) return fromLead;
    return resolveTargetJid(target.telefono || target.phone || '');
  }
  return null;
}

async function findLeadRef(jid) {
  if (!jid) return null;
  const normalized = jidNormalizedUser(jid);
  const docSnap = await db.collection('leads').doc(normalized).get();
  if (docSnap.exists) return docSnap.ref;

  const digits = phoneFromJid(normalized);
  if (digits) {
    const q = await db
      .collection('leads')
      .where('telefono', '==', digits)
      .limit(1)
      .get();
    if (!q.empty) return q.docs[0].ref;
  }
  return null;
}

export async function connectToWhatsApp() {
  try {
    // Asegurar carpeta de auth
    if (!fs.existsSync(localAuthFolder)) {
      fs.mkdirSync(localAuthFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(localAuthFolder);

    // Extraer número de sesión
    if (state.creds.me?.id) {
      sessionPhone = state.creds.me.id.split('@')[0];
    }

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      auth: state,
      logger: Pino({ level: 'info' }),
      version,
    });
    whatsappSock = sock;

    // Manejo de conexión
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        latestQR = qr;
        connectionStatus = "QR disponible. Escanéalo.";
        QRCode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        connectionStatus = "Conectado";
        latestQR = null;
        if (sock.user?.id) {
          sessionPhone = sock.user.id.split('@')[0];
        }
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        connectionStatus = "Desconectado";
        if (reason === DisconnectReason.loggedOut) {
          fs.readdirSync(localAuthFolder).forEach(f =>
            fs.rmSync(path.join(localAuthFolder, f), { force: true, recursive: true })
          );
          sessionPhone = null;
        }
        connectToWhatsApp();
      }
    });

    sock.ev.on('creds.update', saveCreds);

// Dentro de whatsappService.js, ubica tu sección donde tienes:
// sock.ev.on('messages.upsert', async ({ messages, type }) => { … });

sock.ev.on('messages.upsert', async ({ messages, type }) => {
  const allowedTypes = new Set(['notify', 'append', 'replace']);
  if (!allowedTypes.has(type)) return;

  for (const msg of messages) {
    const rawRemoteJid = msg?.key?.remoteJid;
    const remoteJidAlt = msg?.key?.remoteJidAlt;
    const addressingMode = msg?.key?.addressingMode || 'pn';
    const preferredJid = remoteJidAlt || rawRemoteJid;
    if (!preferredJid) continue;

    const normalizedPreferred = jidNormalizedUser(preferredJid);
    const normalizedRemote = rawRemoteJid ? jidNormalizedUser(rawRemoteJid) : normalizedPreferred;
    const resolvedJid = remoteJidAlt ? jidNormalizedUser(remoteJidAlt) : null;

    if (!normalizedPreferred || isJidGroup(normalizedPreferred)) continue; // ignorar grupos

    const isLidRemote = addressingMode === 'lid' || normalizedPreferred.endsWith('@lid');
    const jid = normalizedRemote || normalizedPreferred;

    // 1) Determinar número de teléfono y quién envía
    const phone = phoneFromJid(resolvedJid || normalizedPreferred);
    const phoneForFiles = phone || 'unknown';
    const sender = msg.key.fromMe ? 'business' : 'lead';

    if (remoteJidAlt) {
      console.log('[WA] ✅ Usando remoteJidAlt (número real):', remoteJidAlt);
    }

    // 2) Inicializar variables para contenido y tipo de media
    let content = '';
    let mediaType = null;
    let mediaUrl = null;

    // 3) Procesar distintos tipos de mensaje
    try {
      // 3.1) Video
      if (msg.message.videoMessage) {
        mediaType = 'video';
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const fileName = `videos/${phoneForFiles}-${Date.now()}.mp4`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: 'video/mp4' });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.2) Imagen
      else if (msg.message.imageMessage) {
        mediaType = 'image';
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const fileName = `images/${phoneForFiles}-${Date.now()}.jpg`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: 'image/jpeg' });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.3) Audio
      else if (msg.message.audioMessage) {
        mediaType = 'audio';
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const fileName = `audios/${phoneForFiles}-${Date.now()}.ogg`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: 'audio/ogg' });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.4) Documento
      else if (msg.message.documentMessage) {
        mediaType = 'document';
        const { mimetype, fileName: origName } = msg.message.documentMessage;
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const ext = path.extname(origName) || '';
        const fileName = `docs/${phoneForFiles}-${Date.now()}${ext}`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: mimetype });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.5) Texto o extendedTextMessage
      else if (msg.message.conversation) {
        content = msg.message.conversation.trim();
        mediaType = 'text';
      } else if (msg.message.extendedTextMessage?.text) {
        content = msg.message.extendedTextMessage.text.trim();
        mediaType = 'text';
      } else {
        // Cualquier otro tipo, lo ignoramos por ahora
        continue;
      }
    } catch (err) {
      console.error('Error descargando/guardando media:', err);
      continue; // saltar este mensaje si falla descarga
    }

    // 4) BUSCAR O CREAR EL LEAD en Firestore usando JID como ID

const leadRef = db.collection('leads').doc(jid);
const docSnap = await leadRef.get();
const leadData = docSnap.data() || {};

const leadIdentity = {
  telefono: phone || '',
  jid,
  resolvedJid: resolvedJid || null,
  lidJid: isLidRemote ? jid : null,
  addressingMode,
  isLidRemote,
  lastAddressingMode: addressingMode
};

// Leemos configuración para defaultTrigger (solo una vez)
const cfgSnap = await db.collection('config').doc('appConfig').get();
const cfg = cfgSnap.exists ? cfgSnap.data() : {};

const normalizedContent = (content || '').toLowerCase();
const isLinkCommand = normalizedContent.includes('#link');

// Detectamos si el mensaje incluye "#webPro1490"
let trigger;
if (normalizedContent.includes('#webpro1490')) {
  trigger = 'LeadWeb1490';
} else {
  trigger = cfg.defaultTrigger || 'NuevoLead';
}
const nowIso = new Date().toISOString();
let sequencesToPersist = null;

if (!docSnap.exists) {
  const secuenciasActivas = [
    {
      trigger,
      startTime: nowIso,
      index: 0
    }
  ];
  // Si NO existe, creamos el lead nuevo con el JID como ID
  await leadRef.set({
    ...leadIdentity,
    nombre: msg.pushName || '',
    source: 'WhatsApp',
    fecha_creacion: new Date(),
    estado: 'nuevo',
    etiquetas: [trigger],
    secuenciasActivas,
    unreadCount: 0,
    lastMessageAt: new Date()
  });
  await syncLeadNextSequence(jid, secuenciasActivas);
} else if (sender === 'lead' || isLinkCommand) {
  let existingSequences = Array.isArray(leadData.secuenciasActivas)
    ? leadData.secuenciasActivas.filter(Boolean)
    : [];
  if (isLinkCommand) {
    existingSequences = existingSequences.filter(seq => seq?.trigger !== trigger);
  }
  const alreadyActive = existingSequences.some(
    seq => seq?.trigger === trigger && !seq?.completed
  );
  if (!alreadyActive || isLinkCommand) {
    sequencesToPersist = [
      ...existingSequences,
      {
        trigger,
        startTime: nowIso,
        index: 0
      }
    ];
  }
}

    const leadId = jid;

    // 5) GUARDAR el mensaje dentro de /leads/{leadId}/messages
    const msgData = {
      content,
      mediaType,
      mediaUrl,
      sender,
      timestamp: new Date()
    };
    await db
      .collection('leads')
      .doc(leadId)
      .collection('messages')
      .add(msgData);

    // 6) ACTUALIZAR el lead: incrementar unreadCount si envió el lead
    const updateData = {
      etiquetas: FieldValue.arrayUnion(trigger),
      lastMessageAt: msgData.timestamp,
      jid: leadIdentity.jid,
      addressingMode,
      lastAddressingMode: addressingMode,
      isLidRemote
    };
    if (leadIdentity.telefono) {
      updateData.telefono = leadIdentity.telefono;
    }
    if (leadIdentity.resolvedJid) {
      updateData.resolvedJid = leadIdentity.resolvedJid;
    }
    if (leadIdentity.lidJid) {
      updateData.lidJid = leadIdentity.lidJid;
    }
    if (sender === 'lead') {
      updateData.unreadCount = FieldValue.increment(1);
    }
    if (sequencesToPersist) {
      updateData.secuenciasActivas = sequencesToPersist;
    }
    await leadRef.update(updateData);
    if (sequencesToPersist) {
      await syncLeadNextSequence(leadId, sequencesToPersist);
    }
  }
});

    

    return sock;
  } catch (error) {
    console.error("Error al conectar con WhatsApp:", error);
    throw error;
  }
}

export async function sendFullAudioAsDocument(phone, fileUrl) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('No hay conexión activa con WhatsApp');

  const jid = resolveTargetJid(phone);
  if (!jid) throw new Error('No se pudo obtener JID para el envío de documento');

  // 1) Descargar el archivo
  let res;
  try {
    res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  } catch (err) {
    console.error('Error descargando fullUrl:', err);
    throw new Error('No se pudo descargar el archivo completo');
  }
  if (!res.data) {
    throw new Error('La descarga no produjo datos');
  }
  const buffer = Buffer.from(res.data);

  // 2) Enviar como documento adjunto (payload "flat")
  try {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: 'audio/mpeg',
      fileName: 'cancion_completa.mp3',
      caption: '¡Te comparto tu canción completa!'
    });
    console.log(`✅ Canción completa enviada como adjunto a ${jid}`);
  } catch (err) {
    console.error('Error enviando documento:', err);
    throw err;
  }
}

export async function sendMessageToLead(phone, messageContent) {
  if (!whatsappSock) {
    throw new Error('No hay conexión activa con WhatsApp');
  }

  const jid = resolveTargetJid(phone);
  if (!jid) {
    throw new Error('No se pudo obtener JID del lead');
  }

  // 2) Enviar mensaje de texto sin link preview y con timeout extendido
  await whatsappSock.sendMessage(
    jid,
    {
      text: messageContent,
      linkPreview: false
    },
    {
      timeoutMs: 60_000
    }
  );

  // 3) Guardar en Firestore bajo sender 'business'
  const leadRef = await findLeadRef(jid);

  if (leadRef) {
    const outMsg = {
      content: messageContent,
      sender: 'business',
      timestamp: new Date()
    };

    // 3a) Añadir al subcolección messages
    await leadRef.collection('messages').add(outMsg);

    // 3b) Actualizar lastMessageAt del lead
    await leadRef.update({ lastMessageAt: outMsg.timestamp });
  }

  return { success: true, jid };
}

export function getLatestQR() {
  return latestQR;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function getWhatsAppSock() {
  return whatsappSock;
}

export function getSessionPhone() {
  return sessionPhone;
}

/**
 * Envía una nota de voz en M4A, la sube a Firebase Storage y la guarda en Firestore.
 * @param {string} phone    — número limpio (solo dígitos, con código de país).
 * @param {string} filePath — ruta al archivo .m4a en el servidor.
 */
export async function sendAudioMessage(phone, filePath) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('Socket de WhatsApp no está conectado');

  const jid = resolveTargetJid(phone);
  if (!jid) throw new Error('No se pudo obtener JID para audio');

  // 1) Leer y enviar por Baileys como audio/mp4
  const audioBuffer = fs.readFileSync(filePath);
  await sock.sendMessage(jid, {
    audio: audioBuffer,
    mimetype: 'audio/mp4',
    ptt: true,    // ← activa el modo nota de voz
  });

  // 2) Subir a Firebase Storage
  const bucket = admin.storage().bucket();
  const dest   = `audios/${phoneFromJid(jid) || 'unknown'}-${Date.now()}.m4a`;
  const file   = bucket.file(dest);
  await file.save(audioBuffer, { contentType: 'audio/mp4' });
  const [mediaUrl] = await file.getSignedUrl({
    action: 'read',
    expires: '03-01-2500'
  });

  // 3) Guardar en Firestore
  const leadRef = await findLeadRef(jid);
  if (leadRef) {
    const msgData = {
      content: '',
      mediaType: 'audio',
      mediaUrl,
      sender: 'business',
      timestamp: new Date()
    };
    await leadRef.collection('messages').add(msgData);
    await leadRef.update({ lastMessageAt: msgData.timestamp });
  }
}

/**
 * Envía un clip de audio AAC (.m4a) inline desde su URL.
 *
 * @param {string} phone      — número de teléfono (con o sin +52)
 * @param {string} clipUrl    — URL pública al .m4a (p.ej. Firebase Storage)
 */
export async function sendClipMessage(phone, clipUrl) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('No hay conexión activa con WhatsApp');

  // 1) Normalizar teléfono/JID → JID
  const jid = resolveTargetJid(phone);
  if (!jid) throw new Error('No se pudo obtener JID para el clip');

  // 2) Payload de audio directo desde URL
  const messagePayload = {
    audio: { url: clipUrl },
    mimetype: 'audio/mp4',
    ptt: false,
  };

  // 3) Opciones con timeout extendido y sin marcar como leído
  const sendOpts = {
    timeoutMs: 120_000,
    sendSeen: false,
  };

  // 4) Retry automático sólo en “Timed Out”
  for (let i = 1; i <= 3; i++) {
    try {
      await sock.sendMessage(jid, messagePayload, sendOpts);
      console.log(`✅ clip enviado (intento ${i}) a ${jid}`);
      return;
    } catch (err) {
      const isTO = err.message?.includes('Timed Out');
      console.warn(`⚠️ fallo envío clip intento ${i}${isTO ? ' (Timeout)' : ''}`);
      if (i === 3 || !isTO) throw err;
      await new Promise(r => setTimeout(r, 2_000 * i));
    }
  }
}
