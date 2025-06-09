// utils/uploadPDF.js
import admin from 'firebase-admin';
import path from 'path';

const bucket = admin.storage().bucket();

/**
 * Sube un PDF local al Storage y devuelve su URL pública firmada.
 * @param {string} localFilePath - Ruta local del archivo (ej. './temp/estrategia-123.pdf')
 * @param {string} destinationPath - Ruta dentro del bucket (ej. 'estrategias/estrategia-123.pdf')
 * @returns {Promise<string>} URL firmada de acceso al archivo
 */
export async function uploadPDFToStorage(localFilePath, destinationPath) {
  // Sube el archivo al bucket
  await bucket.upload(localFilePath, {
    destination: destinationPath,
    metadata: {
      contentType: 'application/pdf'
    }
  });

  // Obtiene el objeto file
  const file = bucket.file(destinationPath);

  // Genera una URL firmada de larga duración
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: '2500-01-01'    // Fecha muy lejana
  });

  return url;
}
