import fs from 'fs-extra';
import path from 'path';
import PQueue from 'p-queue';

// 1. Загрузка конфигурации
const config = await fs.readJson('./config/root.json');
const { vlm, paths } = config;

const queue = new PQueue({ concurrency: 1 }); // Классифицируем по одному, чтобы не перегружать GPU

async function runClassifier() {
    console.log('--- Starting Classifier ---');
    
    // Получаем список поддерживаемых типов из папки config/docTypes
    const typeFiles = await fs.readdir('./config/docTypes');
    const allowedTypes = typeFiles.map(f => path.parse(f).name);
    console.log(`Allowed types: ${allowedTypes.join(', ')}`);

    const docs = await fs.readdir(paths.staging);
    
    for (const docId of docs) {
        queue.add(() => classifyDocument(docId, allowedTypes));
    }

    await queue.onIdle();
    console.log('--- Classification completed ---');
}

async function classifyDocument(docId, allowedTypes) {
    const manifestPath = path.join(paths.staging, docId, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);

    // Пропускаем, если тип уже определен
    if (manifest.docType && manifest.docType !== 'unknown') {
        console.log(`[${docId}] Already classified as: ${manifest.docType}`);
        return;
    }

    const imagePath = path.join(paths.staging, docId, 'r100', 'p1.webp');
    if (!await fs.pathExists(imagePath)) return;

    console.log(`[${docId}] Classifying...`);

    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');

    const prompt = `Это документ. Определи его тип из списка: ${allowedTypes.join(', ')}. 
    Если тип не подходит, ответь "unknown". 
    Ответь ТОЛЬКО одним словом (названием типа).`;

    try {
        const response = await fetch(`${vlm.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: vlm.model,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                        ]
                    }
                ],
                temperature: 0.1
            })
        });

        const result = await response.json();
        let detectedType = result.choices[0].message.content.toLowerCase().trim();
        
        // Очистка от лишних точек и кавычек (бывает у малых моделей)
        detectedType = detectedType.replace(/[.\"\']/g, '');

        // Проверяем, входит ли ответ в список разрешенных
        if (!allowedTypes.includes(detectedType)) {
            console.warn(`[${docId}] Model returned unknown type: ${detectedType}`);
            detectedType = 'unknown';
        }

        // Обновляем манифест
        manifest.docType = detectedType;
        manifest.classifierModel = vlm.model;
        await fs.writeJson(manifestPath, manifest, { spaces: 2 });

        console.log(`[${docId}] Result: ${detectedType}`);

    } catch (err) {
        console.error(`[${docId}] Classification failed:`, err.message);
    }
}

runClassifier();
