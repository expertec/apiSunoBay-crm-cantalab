// src/utils/generateStrategyPDF.js
import React from "react";
import { renderToStream } from "@react-pdf/renderer";
import PDFGenerator from "../components/PDFGenerator"; // Tu componente de diseño para el PDF
import fs from "fs";
import path from "path";

/**
 * Genera un PDF con la estrategia de marketing usando el componente PDFGenerator.
 * @param {string} strategyText - Texto generado por ChatGPT.
 * @param {object} leadData - Datos del lead (puedes incluir nombre, negocio, giro, etc.).
 * @returns {Promise<string>} - Ruta local del PDF generado.
 */
export async function generateStrategyPDF(strategyText, leadData) {
  const MyPDFDocument = () => (
    <PDFGenerator reportData={{ ...leadData, estrategia: strategyText }} />
  );
  // Renderiza el documento a un stream
  const stream = await renderToStream(<MyPDFDocument />);
  const fileName = `estrategia-${leadData.id || Date.now()}.pdf`;
  const outputPath = path.join("/tmp", fileName);
  const writeStream = fs.createWriteStream(outputPath);
  stream.pipe(writeStream);
  return new Promise((resolve, reject) => {
    writeStream.on("finish", () => resolve(outputPath));
    writeStream.on("error", (err) => reject(err));
  });
}
