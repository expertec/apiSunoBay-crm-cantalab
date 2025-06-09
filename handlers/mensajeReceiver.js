import { db } from '../firebaseAdmin.js'; // Asegúrate de tener Firebase Admin configurado

/**
 * Función para manejar la recepción de mensajes y guardar la conversación en Firebase
 * @param {Object} message - El mensaje recibido.
 */
export async function receiveMessage(message) {
  try {
    const jid = message.key.remoteJid;
    const content = message.message?.conversation || message.message?.extendedTextMessage?.text;

    if (!content) {
      throw new Error('No se encontró el contenido del mensaje.');
    }

    // Verificar si el lead ya existe en Firestore
    let leadDoc = await db.collection('leads').doc(jid).get();
    if (!leadDoc.exists) {
      const telefono = jid.split('@')[0];  // Extraemos el número de teléfono del JID
      const newLead = {
        telefono,
        nombre: message.pushName || 'Desconocido',
        fecha_creacion: new Date(),
        estado: 'nuevo',
        etiquetas: ['NuevoLead'],
      };
      await db.collection('leads').doc(jid).set(newLead);
      console.log(`Nuevo lead creado: ${telefono}`);
    }

    // Guardar el mensaje recibido en Firebase
    const newMessage = {
      content,
      sender: "lead",
      timestamp: new Date(),
    };
    await db.collection('leads').doc(jid).collection('messages').add(newMessage);
    console.log(`Mensaje guardado en Firebase: ${content}`);
  } catch (error) {
    console.error('Error al procesar el mensaje recibido:', error);
    throw error;
  }
}
