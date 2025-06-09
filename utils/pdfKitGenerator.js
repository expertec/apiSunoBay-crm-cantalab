import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

/**
 * Crea un PDF con un diseño adaptado al ejemplo proporcionado (pdfPlantilla.pdf).
 * Se incluye un encabezado con un tagline, un título, un bloque de información del negocio
 * y el contenido del plan (generado por ChatGPT).
 *
 * @param {string} planText - El plan generado por ChatGPT en texto plano.
 * @param {object} leadData - Datos del lead, por ejemplo:
 *   {
 *     negocio: "Plomeria Profesional",
 *     giro: "Servicios de Plomeria",
 *     descripcion: "Brindamos servicio de plomeria",
 *     nombre: "Adam Smith",
 *     telefono: "8311760335"
 *   }
 * @returns {Promise<string>} - Ruta local del PDF generado.
 */
export async function createStrategyPDF(planText, leadData) {
  return new Promise(async (resolve, reject) => {
    try {
      const fileName = `plan-ventas-${leadData.id || Date.now()}.pdf`;
      const outputPath = path.join('/tmp', fileName);
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      // Usar la fuente Helvetica (moderna y sans serif)
      doc.font('Helvetica');

      // 1. Tagline y subtítulo (parte superior)
      doc.fontSize(18).fillColor('#333')
         .text("Conecta, automatiza, vende.", { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(14).fillColor('#555')
         .text("Marketing digital impulsado por software para vender más.", { align: 'center' });
      doc.moveDown(1);

      // 2. Título del plan
      doc.fontSize(20).fillColor('black')
         .text("Plan de Ventas para Facebook", { align: 'center', underline: true });
      doc.moveDown(1);

      // 3. Bloque de información del negocio
      // Opcional: dibujar un fondo ligero para resaltar este bloque
      const infoY = doc.y;
      doc.rect(50, infoY, doc.page.width - 100, 70)
         .fillOpacity(0.1)
         .fill("#f0f0f0")
         .fillOpacity(1);
      doc.y = infoY + 10;
      doc.fontSize(12).fillColor('black');
      doc.text(`Negocio: ${leadData.negocio || "N/D"}`, { align: 'left' });
      doc.text(`Giro: ${leadData.giro || "N/D"}`, { align: 'left' });
      doc.text(`Descripción: ${leadData.descripcion || "N/D"}`, { align: 'left' });
      doc.text(`Contacto: ${leadData.nombre || "N/D"}    Teléfono: ${leadData.telefono || "N/D"}`, { align: 'left' });
      doc.text(`Fecha: ${new Date().toLocaleDateString()}`, { align: 'left' });
      doc.moveDown(1);

      // 4. Línea divisoria
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown();

      // 5. Contenido del plan
      doc.fontSize(11)
         .fillColor('black')
         .text(planText, { align: 'justify', lineGap: 4 });

      doc.end();
      stream.on("finish", () => resolve(outputPath));
      stream.on("error", err => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}
