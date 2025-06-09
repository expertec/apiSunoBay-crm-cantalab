import { getWhatsAppSock } from '../whatsappService.js';
import { db } from '../firebaseAdmin.js';  // Asegúrate de tener Firebase Admin configurado

/**
 * Función para enviar mensajes a través de WhatsApp
 * @param {string} leadId - El ID del lead al que se va a enviar el mensaje.
 * @param {string} message - El contenido del mensaje a enviar.
 */
export async function sendMessage(leadId, message) {
  try {
    const leadDoc = await db.collection('leads').doc(leadId).get();
    if (!leadDoc.exists) {
      throw new Error(`Lead con ID ${leadId} no encontrado.`);
    }
    const leadData = leadDoc.data();
    const telefono = leadData.telefono;

    // Formatear el número de teléfono
    let number = telefono;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;

    // Enviar mensaje a WhatsApp
    const sock = getWhatsAppSock();
    if (!sock) {
      throw new Error('No hay conexión activa con WhatsApp.');
    }

    const sendMessagePromise = sock.sendMessage(jid, { text: message });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), 10000));

    await Promise.race([sendMessagePromise, timeout]);
    console.log(`Mensaje enviado a ${jid}: ${message}`);

    // Guardar el mensaje en Firebase
    const newMessage = {
      content: message,
      sender: "business",
      timestamp: new Date(),
    };
    await db.collection('leads').doc(leadId).collection('messages').add(newMessage);
    console.log(`Mensaje guardado en Firebase: ${message}`);
  } catch (error) {
    console.error('Error en el envío de mensaje:', error);
    throw error;
  }
}
