import fs from 'fs-extra';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

const DEFAULTS = {
  incomingDir: 'incoming',
  stagingDir: 'staging',
  docFolderName: 'input',
  outputPdfName: 'document.pdf',
  allowedImageExt: new Set(['.jpg', '.jpeg', '.png', '.webp']),
  allowedPdfExt: new Set(['.pdf']),
};

function naturalSort(a, b) {
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}

function safeDocKey(name) {
  // минимальная “санитизация” для папки в staging
  // (имена файлов/папок из incoming могут быть с пробелами — это ок)
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

async function listIncomingDocuments(incomingDir) {
  const entries = await fs.readdir(incomingDir, { withFileTypes: true });

  const docs = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(incomingDir, e.name);

    if (e.isDirectory()) {
      docs.push({ kind: 'folder', name: e.name, fullPath: full });
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (DEFAULTS.allowedPdfExt.has(ext)) {
        docs.push({ kind: 'file', name: e.name, fullPath: full });
      }
    }
  }

  docs.sort((a, b) => naturalSort(a.name, b.name));
  return docs;
}

async function listFolderParts(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const parts = [];

  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;

    const ext = path.extname(e.name).toLowerCase();
    if (DEFAULTS.allowedPdfExt.has(ext) || DEFAULTS.allowedImageExt.has(ext)) {
      parts.push({ name: e.name, fullPath: path.join(folderPath, e.name), ext });
    }
  }

  parts.sort((a, b) => naturalSort(a.name, b.name));
  return parts;
}

async function mergePdfsToBytes(pdfPaths) {
  const merged = await PDFDocument.create();

  for (const p of pdfPaths) {
    const bytes = await fs.readFile(p);
    const src = await PDFDocument.load(bytes);
    const copied = await merged.copyPages(src, src.getPageIndices());
    copied.forEach((page) => merged.addPage(page));
  }

  return await merged.save();
}

async function imagesToPdfBytes(imagePaths) {
  const pdf = await PDFDocument.create();

  for (const imgPath of imagePaths) {
    const bytes = await fs.readFile(imgPath);
    const ext = path.extname(imgPath).toLowerCase();

    let embedded;
    if (ext === '.png') embedded = await pdf.embedPng(bytes); // [web:102]
    else embedded = await pdf.embedJpg(bytes); // jpeg/jpg/webp -> через embedJpg (webp часто не поддерживается как jpg)
    // ВАЖНО: pdf-lib не гарантирует поддержку webp как embedJpg.
    // Поэтому webp на входе лучше не допускать или конвертировать заранее.
    // Сейчас считаем, что входные изображения будут jpg/png.

    const w = embedded.width;
    const h = embedded.height;

    const page = pdf.addPage([w, h]);
    page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  }

  return await pdf.save();
}

async function assembleOneDocument(doc, { incomingDir, stagingDir }) {
  const docKey = safeDocKey(doc.name);
  const outDir = path.join(stagingDir, docKey, DEFAULTS.docFolderName);
  const outPdfPath = path.join(outDir, DEFAULTS.outputPdfName);

  await fs.ensureDir(outDir);

  if (doc.kind === 'file') {
    // один PDF в корне incoming => просто копируем как документ.pdf
    await fs.copyFile(doc.fullPath, outPdfPath);
    return { docKey, outputPdfPath: outPdfPath, sources: [path.relative(incomingDir, doc.fullPath)] };
  }

  // doc.kind === 'folder'
  const parts = await listFolderParts(doc.fullPath);

  const pdfs = parts.filter((p) => DEFAULTS.allowedPdfExt.has(p.ext)).map((p) => p.fullPath);
  const imgs = parts.filter((p) => DEFAULTS.allowedImageExt.has(p.ext)).map((p) => p.fullPath);

  if (pdfs.length === 0 && imgs.length === 0) {
    throw new Error(`No supported files in folder: ${doc.fullPath}`);
  }

  let mergedBytes;
  if (pdfs.length > 0 && imgs.length === 0) {
    mergedBytes = await mergePdfsToBytes(pdfs); // [web:43]
  } else if (pdfs.length === 0 && imgs.length > 0) {
    mergedBytes = await imagesToPdfBytes(imgs); // [web:102]
  } else {
    // Смешанный случай (PDF + изображения) — пока “срезаем углы”:
    // 1) склеить PDF-части
    // 2) изображения пока не включать
    // (позже расширим: можно конвертировать изображения в PDF и тоже добавлять)
    mergedBytes = await mergePdfsToBytes(pdfs); // [web:43]
  }

  await fs.writeFile(outPdfPath, mergedBytes);

  const relSources = parts.map((p) => path.relative(incomingDir, p.fullPath));
  return { docKey, outputPdfPath: outPdfPath, sources: relSources };
}

async function runAssembleInput() {
  const incomingDir = DEFAULTS.incomingDir;
  const stagingDir = DEFAULTS.stagingDir;

  await fs.ensureDir(incomingDir);
  await fs.ensureDir(stagingDir);

  const docs = await listIncomingDocuments(incomingDir);

  if (docs.length === 0) {
    console.log(`[assemble-input] No documents found in ${incomingDir}`);
    return;
  }

  console.log(`[assemble-input] Found ${docs.length} incoming documents`);

  const results = [];
  for (const doc of docs) {
    console.log(`[assemble-input] Assembling: ${doc.name}`);
    const r = await assembleOneDocument(doc, { incomingDir, stagingDir });
    results.push(r);
    console.log(`[assemble-input] OK: staging/${r.docKey}/input/document.pdf`);
  }

  // Технический “индекс” (потом можно превратить в manifest)
  const indexPath = path.join(stagingDir, '_assemble_index.json');
  await fs.writeJson(
    indexPath,
    {
      createdAt: new Date().toISOString(),
      incomingDir,
      stagingDir,
      documents: results,
    },
    { spaces: 2 }
  );

  console.log(`[assemble-input] Wrote: ${indexPath}`);
}

runAssembleInput().catch((err) => {
  console.error('[assemble-input] Failed:', err);
  process.exitCode = 1;
});
