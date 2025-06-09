// server/firebaseAdmin.js
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

// Define la ruta del archivo secreto montado por Render
const firebaseKeyPath = path.join('/etc/secrets', 'serviceAccountKey.json');

// Verifica que el archivo exista
if (!fs.existsSync(firebaseKeyPath)) {
  throw new Error(`No se encontró el archivo secreto de Firebase en ${firebaseKeyPath}`);
}

// Lee y parsea el contenido del archivo secreto
let serviceAccount;
try {
  const fileData = fs.readFileSync(firebaseKeyPath, 'utf8');
  serviceAccount = JSON.parse(fileData);
} catch (error) {
  throw new Error('Error leyendo o parseando el archivo secreto: ' + error.message);
}

// Inicializa Firebase Admin con las credenciales y el bucket de Storage
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'cantalab-crm.firebasestorage.app'
});



// Obtén la instancia de Firestore
const db = admin.firestore();



export { admin, db };

