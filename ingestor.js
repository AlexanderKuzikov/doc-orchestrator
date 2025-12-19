import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import PQueue from 'p-queue';

// Определяем пути для ресурсов PDF.js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfjsPath = path.join(__dirname, 'node_modules', 'pdfjs-dist');
const standardFontsPath = path.join(pdfjsPath, 'standard_fonts', path.sep);
const cMapsPath = path.join(pdfjsPath, 'cmaps', path.sep);

// 1. Загрузка конфигурации
const config = await fs.readJson('./config/root.json');
const { paths, rasterize } = config;

// Контроль нагрузки
const queue = new PQueue({ concurrency: rasterize.concurrency || 2 });

/**
 * Запуск процесса
 */
async function runIngestor() {
    console.log('--- Starting Ingestor (NAPI-Canvas + Font Fix v2) ---');
    await fs.ensureDir(paths.staging);
    
    const items = await fs.readdir(paths.input);
    
    for (const item of items) {
        const fullPath = path.join(paths.input, item);
        const stats = await fs.stat(fullPath);
        const docId = stats.isDirectory() ? item : path.parse(item).name;
        
        queue.add(() => processDocument(fullPath, docId, stats.isDirectory()));
    }

    await queue.onIdle();
    console.log('--- All documents processed successfully ---');
}

/**
 * Обработка одного документа
 */
async function processDocument(sourcePath, docId, isFolder) {
    console.log(`[${docId}] Processing...`);
    const docStagingPath = path.join(paths.staging, docId);
    await fs.ensureDir(docStagingPath);

    const manifest = {
        docId,
        source: sourcePath,
        processedAt: new Date().toISOString(),
        pages: []
    };

    try {
        if (isFolder) {
            const files = (await fs.readdir(sourcePath))
                .filter(f => /\.(pdf|png|jpg|jpeg|webp)$/i.test(f))
                .sort();
            
            let pageIdx = 1;
            for (const file of files) {
                const filePath = path.join(sourcePath, file);
                if (file.toLowerCase().endsWith('.pdf')) {
                    const pages = await rasterizePdf(filePath, docStagingPath, pageIdx);
                    manifest.pages.push(...pages);
                    pageIdx += pages.length;
                } else {
                    const pageData = await processImagePage(filePath, docStagingPath, pageIdx);
                    manifest.pages.push(pageData);
                    pageIdx++;
                }
            }
        } else if (sourcePath.toLowerCase().endsWith('.pdf')) {
            manifest.pages = await rasterizePdf(sourcePath, docStagingPath, 1);
        }

        await fs.writeJson(path.join(docStagingPath, 'manifest.json'), manifest, { spaces: 2 });
        console.log(`[${docId}] Completed. Pages: ${manifest.pages.length}`);
    } catch (err) {
        console.error(`[${docId}] Critical Error:`, err.message);
    }
}

/**
 * Растрирование PDF
 */
async function rasterizePdf(pdfPath, targetDir, startIdx) {
    const pagesInfo = [];
    const data = new Uint8Array(await fs.readFile(pdfPath));
    
    // Ключевые настройки для подавления ошибок шрифтов в Node.js
    const loadingTask = pdfjs.getDocument({ 
        data,
        standardFontDataUrl: standardFontsPath,
        cMapUrl: cMapsPath,
        cMapPacked: true,
        disableFontFace: true, // Игнорируем шрифты ОС, используем внутренний рендерер PDF.js
        verbosity: 0            // Подавляем лишние логи в консоли
    });
    
    const pdfDocument = await loadingTask.promise;

    for (let i = 1; i <= pdfDocument.numPages; i++) {
        const page = await pdfDocument.getPage(i);
        const pageIdx = startIdx + i - 1;
        pagesInfo[i - 1] = { index: pageIdx };

        for (const res of rasterize.resolutions) {
            const resDir = path.join(targetDir, res.folder);
            await fs.ensureDir(resDir);
            
            const viewport = page.getViewport({ scale: res.dpi / 72 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d');

            // Отрисовка страницы
            await page.render({ 
                canvasContext: context, 
                viewport: viewport,
                intent: 'print' // Улучшает качество текста при рендеринге
            }).promise;
            
            const buffer = canvas.toBuffer('image/png');
            const webpName = `p${pageIdx}.webp`;
            
            await sharp(buffer)
                .webp({ quality: res.quality, lossless: res.lossless })
                .toFile(path.join(resDir, webpName));

            pagesInfo[i - 1][res.folder] = webpName;
        }
    }
    return pagesInfo;
}

/**
 * Обработка изображения
 */
async function processImagePage(imgPath, targetDir, pageIdx) {
    const pageEntry = { index: pageIdx };
    for (const res of rasterize.resolutions) {
        const resDir = path.join(targetDir, res.folder);
        await fs.ensureDir(resDir);
        const webpName = `p${pageIdx}.webp`;
        const webpPath = path.join(resDir, webpName);

        let pipeline = sharp(imgPath);
        if (res.dpi < 300) {
            pipeline = pipeline.resize({ width: 1200, withoutEnlargement: true });
        }

        await pipeline
            .webp({ quality: res.quality, lossless: res.lossless })
            .toFile(webpPath);
            
        pageEntry[res.folder] = webpName;
    }
    return pageEntry;
}

runIngestor().catch(err => console.error('Fatal Error:', err));
