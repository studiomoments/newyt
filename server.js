import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'найден' : 'НЕ НАЙДЕН');

// =========================
// POSTGRESQL
// =========================
let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    pool.query(`
        CREATE TABLE IF NOT EXISTS active_proxies (
            id SERIAL PRIMARY KEY,
            proxy_string TEXT UNIQUE,
            protocol TEXT
        )
    `).catch(console.error);

} else {
    console.error('DATABASE_URL отсутствует');
}

// =========================
// CHECK PROXIES (Python)
// =========================
app.post('/api/check', (req, res) => {
    const { input, proto, url } = req.body;

    if (!input || !proto || !url) {
        return res.status(400).json({ error: 'missing params' });
    }

    const cmd =
        `/opt/venv/bin/python check.py -i "${input}" -p "${proto}" -u "${url}"`;

    const p = spawn('/opt/venv/bin/python', [
        'check.py',
        '-i', input,
        '-p', proto,
        '-u', url
    ]);

    let out = '';
    let err = '';

    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());

    p.on('close', () => {
        if (err) return res.status(500).json({ error: err });
        res.json({ output: out.trim() });
    });
});

// =========================
// STREAM API (FIXED)
// =========================
const { spawn } = require('child_process');

app.get('/api/tunnel', async (req, res) => {
    const { target_url } = req.query;

    if (!target_url) return res.status(400).send('No target_url');
    if (!pool) return res.status(500).send('DB not configured');

    try {
        const dbRes = await pool.query(
            "SELECT proxy_string FROM active_proxies WHERE protocol='socks5' ORDER BY RANDOM()"
        );

        if (!dbRes.rows.length) {
            return res.status(500).send('No proxies');
        }

        // Итерируемся по прокси. Обернуто в Promise, чтобы цикл ЖДАЛ исхода работы
        for (const row of dbRes.rows) {
            const proxyAddress = row.proxy_string;
            const proxyUrl = `socks5://${proxyAddress}`;
            console.log('TRY PROXY:', proxyAddress);

            try {
                // Ждем завершения стрима или ошибки этого конкретного прокси
                await startStreaming(proxyUrl, target_url, res);
                return; // Если успешно завершилось — выходим из эндпоинта
            } catch (err) {
                console.log('PROXY FAIL:', proxyAddress, err.message);

                try {
                    await pool.query('DELETE FROM active_proxies WHERE proxy_string=$1', [proxyAddress]);
                    console.log('REMOVED BAD PROXY:', proxyAddress);
                } catch (e) {
                    console.error('DB delete error:', e.message);
                }

                // Если данные уже начали уходить клиенту, мы не можем переключить прокси посередине трека
                if (res.headersSent) {
                    console.error('Headers already sent. Cannot switch proxy mid-stream.');
                    return;
                }
                // Если заголовки не отправлены, цикл перейдет к следующей строке (следующему прокси)
            }
        }

        if (!res.headersSent) res.status(500).send('No working proxies');

    } catch (e) {
        console.error('DB error:', e.message);
        if (!res.headersSent) res.status(500).send('Database error');
    }
});

// Вынесенная функция для управления потоком yt-dlp
function startStreaming(proxyUrl, targetUrl, res) {
    return new Promise((resolve, reject) => {
        // Запускаем yt-dlp с флагом --print, чтобы он выдал имя файла ПЕРЕД бинарным потоком
        const yt = spawn('/opt/venv/bin/yt-dlp', [
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            '--no-check-certificate',
            '--add-header', 'User-Agent: Mozilla/5.0',
            '--add-header', 'Accept-Language: en-US,en',
            '--proxy', proxyUrl,
            '--print', 'filename:%(title)s.%(ext)s', // Печатаем "filename:Название.расширение" первой строкой
            '-o', '-',
            targetUrl
        ]);

        let headersSentLocal = false;
        let buffer = Buffer.alloc(0);

        yt.stdout.on('data', (chunk) => {
            if (!headersSentLocal) {
                // Накапливаем данные, пока не найдем перенос строки, чтобы вырезать имя файла
                buffer = Buffer.concat([buffer, chunk]);
                const index = buffer.indexOf('\n');

                if (index !== -1) {
                    // Выделяем строку с именем файла
                    const line = buffer.slice(0, index).toString().trim();
                    // Оставшийся хвост чанка — это уже чистое аудио
                    const audioTail = buffer.slice(index + 1);

                    let filename = 'audio.webm'; // дефолтное имя
                    if (line.startsWith('filename:')) {
                        filename = line.replace('filename:', '').trim();
                    }

                    // Очищаем имя от запрещенных символов для файловой системы
                    const safeTitle = filename.replace(/[^a-z0-9а-яё_\-.]/gi, ' ').trim().slice(0, 100);

                    // Определяем MIME-тип на основе расширения видео
                    const ext = safeTitle.split('.').pop().toLowerCase();
                    const contentType = ext === 'm4a' ? 'audio/mp4' : 'audio/webm';

                    // Отправляем заголовки клиенту
                    res.setHeader('Content-Type', contentType);
                    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}"`);
                    headersSentLocal = true;

                    // Пушим остаток аудио-данных из первого чанка
                    if (audioTail.length > 0) {
                        res.write(audioTail);
                    }
                    // Очищаем буфер
                    buffer = null;
                }
            } else {
                // Если заголовки уже ушли, просто гоним бинарный поток
                res.write(chunk);
            }
        });

        yt.stderr.on('data', (d) => {
            const msg = d.toString();
            if (msg.includes('ERROR:')) console.log('yt-dlp error:', msg.trim());
        });

        yt.on('error', (err) => {
            reject(err);
        });

        yt.on('close', (code) => {
            console.log('yt-dlp exit:', code);
            if (code === 0 && headersSentLocal) {
                res.end();
                resolve();
            } else {
                if (!headersSentLocal) {
                    reject(new Error(`Failed before streaming started. Code: ${code}`));
                } else {
                    res.end(); // Обрываем стрим
                    reject(new Error(`Stream interrupted. Code: ${code}`));
                }
            }
        });
    });
}

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('Server running on', PORT);
});
