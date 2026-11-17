// One shared pdf.js setup. A single worker is reused for every document
// (faster, and works offline once loaded — no new worker script fetch per deck).
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let worker = null;
export function openPdf(data) {
  worker ||= new pdfjsLib.PDFWorker();
  return pdfjsLib.getDocument({ data, worker }).promise;
}

export { pdfjsLib };
