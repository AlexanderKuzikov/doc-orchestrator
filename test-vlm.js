import fs from 'fs-extra';
import path from 'path';

const config = await fs.readJson('./config/root.json');
const { vlm, paths } = config;

async function testVLM() {
    console.log(`--- Testing VLM Connection: ${vlm.model} ---`);

    const docs = await fs.readdir(paths.staging);
    if (docs.length === 0) return console.error('No docs in staging!');

    const testDoc = docs[0];
    const imagePath = path.join(paths.staging, testDoc, 'r100', 'p1.webp');
    console.log(`Using image: ${imagePath}`);

    // Читаем файл и переводим в чистый Base64
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');

    const payload = {
        model: vlm.model,
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "Что это за документ? Ответь одним словом." },
                    { 
                        type: "image_url", 
                        image_url: { 
                            // Важно: Попробуем формат, который чаще всего принимает LM Studio
                            url: `data:image/jpeg;base64,${base64Image}` 
                        } 
                    }
                ]
            }
        ],
        temperature: 0.1
    };

    try {
        const response = await fetch(`${vlm.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        
        if (result.error) {
            console.error('LM Studio Error:', result.error);
        } else {
            console.log('--- VLM Response ---');
            console.log('Answer:', result.choices[0].message.content);
        }
    } catch (err) {
        console.error('Fetch failed:', err.message);
    }
}

testVLM();
