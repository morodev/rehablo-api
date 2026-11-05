import PDFDocument from 'pdfkit';

export interface ClinicalPdfInput {
    title: string; text: string; patientName: string; authorName: string;
    recordId: string; version: number; createdAt: string; confirmed: boolean;
}

export function renderClinicalPdf(input: ClinicalPdfInput): Promise<Buffer> {
    if (!input.confirmed) return Promise.reject(Object.assign(new Error('Conferma il referto prima di esportarlo'), {statusCode: 409}));
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({size: 'A4', margin: 50, bufferPages: true, info: {Title: input.title, Author: input.authorName, Creator: 'Rehablo'}});
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.font('Helvetica-Bold').fontSize(20).fillColor('#1e3a5f').text(input.title);
        doc.moveDown().font('Helvetica').fontSize(11).fillColor('#111827');
        doc.text('Paziente: ' + input.patientName);
        doc.text('Professionista: ' + input.authorName);
        doc.text('Data: ' + input.createdAt + '  |  Versione: ' + input.version);
        doc.moveDown().text(input.text, {lineGap: 4});
        const pages = doc.bufferedPageRange();
        for (let page = pages.start; page < pages.start + pages.count; page++) {
            doc.switchToPage(page);
            doc.fontSize(8).fillColor('#4b5563').text('Rehablo | ' + input.recordId + ' | ' + (page+1) + '/' + pages.count,
                50, doc.page.height - 35, {lineBreak: false});
        }
        doc.end();
    });
}
