import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

export async function generatePDF(leadData, planText) {
  // Construir la plantilla HTML dinámica usando los datos del lead y el plan generado
  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Plan de Ventas para Facebook</title>
    <style>
      body {
        font-family: 'Helvetica', sans-serif;
        margin: 0;
        padding: 0;
        color: #333;
      }
      .header {
        background-image: url('https://i.imgur.com/3eXYuMZ.jpeg');
        background-size: cover;
        background-position: center;
        height: 150px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        color: #fff;
      }
      .header .tagline {
        font-size: 18px;
        font-weight: bold;
      }
      .header .subtagline {
        font-size: 14px;
      }
      .content {
        padding: 20px 40px;
      }
      .title {
        text-align: center;
        font-size: 24px;
        font-weight: bold;
        text-decoration: underline;
        margin-bottom: 10px;
      }
      .business-info {
        background-color: #f0f0f0;
        padding: 10px 15px;
        margin-bottom: 20px;
        border-radius: 4px;
      }
      .business-info div {
        font-size: 12px;
        margin: 3px 0;
      }
      .section {
        margin-bottom: 20px;
      }
      .section h2 {
        font-size: 16px;
        margin-bottom: 5px;
        color: #0056b3;
        border-bottom: 1px solid #ccc;
        padding-bottom: 3px;
      }
      .section p, .section ul {
        font-size: 12px;
        line-height: 1.4;
      }
      .section ul {
        list-style: disc;
        margin-left: 20px;
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="tagline">Conecta, automatiza, vende.</div>
      <div class="subtagline">Marketing digital impulsado por software para vender más.</div>
    </div>
    <div class="content">
      <div class="title">Plan de Ventas para Facebook</div>
      <div class="business-info">
        <div><strong>Negocio:</strong> ${leadData.negocio || "N/D"}</div>
        <div><strong>Giro:</strong> ${leadData.giro || "N/D"}</div>
        <div><strong>Descripción:</strong> ${leadData.descripcion || "N/D"}</div>
        <div><strong>Contacto:</strong> ${leadData.nombre || "N/D"}</div>
        <div><strong>Teléfono:</strong> ${leadData.telefono || "N/D"}</div>
        <div><strong>Fecha:</strong> ${new Date().toLocaleDateString()}</div>
      </div>
      <div class="section">
        ${planText}
      </div>
    </div>
  </body>
  </html>
  `;

  // Inicia Puppeteer y genera el PDF
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
  
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '10mm', right: '10mm' }
  });
  
  await browser.close();

  const fileName = `plan-ventas-${leadData.id || Date.now()}.pdf`;
  const outputPath = path.join('/tmp', fileName);
  fs.writeFileSync(outputPath, pdfBuffer);
  console.log("PDF generado en:", outputPath);
  return outputPath;
}
