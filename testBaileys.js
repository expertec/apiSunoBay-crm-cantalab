// testBaileys.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import Pino from 'pino';
import fs from 'fs';

const localAuthFolder = './baileys_test_sessions';

async function testBaileysConnection() {
  // Asegura carpeta de sesiones
  if (!fs.existsSync(localAuthFolder)) {
    fs.mkdirSync(localAuthFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(localAuthFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: Pino({ level: 'info' }),
    version
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n\n=== ESCANEA ESTE QR EN TU WHATSAPP ===\n');
    }
    if (connection === 'open') {
      console.log('✅ ¡Conexión exitosa! WhatsApp está conectado.');
      process.exit(0);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('❌ Desconectado. Código:', code);
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(localAuthFolder, { recursive: true, force: true });
        console.log('🗑️ Sesión borrada. Reinicia el script para probar de nuevo.');
      }
      process.exit(1);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

testBaileysConnection();
