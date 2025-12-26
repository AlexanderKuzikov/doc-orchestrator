import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import PQueue from 'p-queue';

// --- Paths for PDF.js resources (fonts + cmaps) ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const pdfjsRoot = path.join(projectRoot, 'node_modules', 'pdfjs-dist');

const standardFontsPath = path.join(pdfjsRoot, 'standard_fonts', path.sep);
const cMapsPath = path.join(pdfjsRoot, 'cmaps', path.sep);

// --- Load config ---
const config = await fs.readJson(path.join(projectRoot, 'config', 'root.json'));
const { paths, rasterize } = config;

const DEFAULT_RESOLUTIONS = [
  { dpi: 75, folder: 'r75', quality: 80, lossless: false },
  { dpi: 100, folder: 'r100', quality: 80, lossless: false },
  { dpi: 150, folder: 'r150', quality: 82, lossless: false },
  { dpi: 200, folder: 'r200', quality: 84, lossless: false },
  { dpi: 250, folder: 'r250', quality: 86, lossless: false },
  { dpi: 300, folder: 'r300', quality: 90, lossless: false }
];

const RESOLUTIONS = Array.isArray(rasterize?.resolutions) && rasterize.resolutions.length > 0
  ? rasterize.resolutions
  : DEFAULT_RESOLUTIONS;

const queue = new PQueue({ concurrency: rasterize?.concurrency ?? 1 });

function naturalSort(a, b) {
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}

function normalizeManifest(manifest, docId) {
  const m = (manifest && typeof manifest === 'object') ? manifest : {};
  m.docId = m.docId ?? docId;
  m.createdAt = m.createdAt ?? new Date().toISOString();
  m.updatedAt = m.updatedAt ?? new Date().toISOString();

  m.input = (m.input && typeof m.input === 'object') ? m.input : {};
  m.pages = Array.isArray(m.pages) ? m.pages : [];
  m.stages = (m.stages && typeof m.stages === 'object') ? m.stages : {};

  return m;
}

async function listDocsInStaging(stagingDir) {
  const entries = await fs.readdir(stagingDir, { withFileTypes: true });
  const docs = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_')) continue;

    const docId = e.name;
    const inputPdfPath = path.join(stagingDir, docId, 'input', 'document.pdf');
    if (await fs.pathExists(inputPdfPath)) {
      docs.push({ docId, inputPdfPath });
    }
  }

  docs.sort((a, b) => naturalSort(a.docId, b.docId));
  return docs;
}

async function loadOrCreateManifest(docDir, docId) {
  const manifestPath = path.join(docDir, 'manifest.json');

  if (await fs.pathExists(manifestPath)) {
    const m = await fs.readJson(manifestPath);
    return normalizeManifest(m, docId);
  }

  return normalizeManifest(null, docId);
}

async function saveManifest(docDir, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await fs.writeJson(path.join(docDir, 'manifest.json'), manifest, { spaces: 2 });
}

async function rasterizePdfToPyramid(pdfPath, docDir) {
  const pagesInfo = [];

  const data = new Uint8Array(await fs.readFile(pdfPath));

  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl: standardFontsPath,
    cMapUrl: cMapsPath,
    cMapPacked: true,
    disableFontFace: true,
    verbosity: 0
  });

  const pdfDocument = await loadingTask.promise;

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber);
    const pageIdx = pageNumber;

    const pageEntry = { index: pageIdx };

    for (const res of RESOLUTIONS) {
      const folder = res.folder ?? `r${res.dpi}`;
      const resDir = path.join(docDir, folder);
      await fs.ensureDir(resDir);

      const viewport = page.getViewport({ scale: res.dpi / 72 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');

      await page.render({
        canvasContext: ctx,
        viewport,
        intent: 'print'
      }).promise;

      const pngBuffer = canvas.toBuffer('image/png');
      const webpName = `p${pageIdx}.webp`;
      const outPath = path.join(resDir, webpName);

      await sharp(pngBuffer)
        .webp({ quality: res.quality ?? 85, lossless: !!res.lossless })
        .toFile(outPath);

      pageEntry[folder] = webpName;
    }

    pagesInfo.push(pageEntry);
    page.cleanup();
  }

  if (pdfDocument.cleanup) pdfDocument.cleanup();
  return pagesInfo;
}

async function processOneDoc(stagingDir, doc) {
  const docDir = path.join(stagingDir, doc.docId);

  console.log(`[rasterize] [${doc.docId}] Start`);

  const manifest = await loadOrCreateManifest(docDir, doc.docId);
  manifest.stages = manifest.stages ?? {}; // защита от "undefined" [web:165]

  manifest.input.assembledPdf = path
    .relative(docDir, doc.inputPdfPath)
    .replaceAll('\\', '/');

  manifest.stages.rasterize = {
    startedAt: new Date().toISOString(),
    resolutions: RESOLUTIONS.map(r => ({ dpi: r.dpi, folder: r.folder ?? `r${r.dpi}` }))
  };

  const pages = await rasterizePdfToPyramid(doc.inputPdfPath, docDir);

  manifest.pages = pages;
  manifest.stages.rasterize.finishedAt = new Date().toISOString();
  manifest.stages.rasterize.pageCount = pages.length;

  await saveManifest(docDir, manifest);

  console.log(`[rasterize] [${doc.docId}] Done. Pages: ${pages.length}`);
}

async function runRasterizeStage() {
  if (!paths?.staging) {
    throw new Error('config/root.json: paths.staging is required');
  }

  const stagingDir = path.resolve(projectRoot, paths.staging);
  await fs.ensureDir(stagingDir);

  const docs = await listDocsInStaging(stagingDir);
  if (docs.length === 0) {
    console.log(`[rasterize] No docs found. Expected: ${stagingDir}/<docId>/input/document.pdf`);
    return;
  }

  console.log(`[rasterize] Found ${docs.length} docs in staging. Concurrency=${rasterize?.concurrency ?? 1}`);

  for (const doc of docs) {
    queue.add(() => processOneDoc(stagingDir, doc)).catch((e) => {
      console.error(`[rasterize] [${doc.docId}] Failed:`, e?.message ?? e);
    });
  }

  await queue.onIdle();
  console.log('[rasterize] All docs processed');
}

runRasterizeStage().catch((err) => {
  console.error('[rasterize] Fatal:', err);
  process.exitCode = 1;
});
