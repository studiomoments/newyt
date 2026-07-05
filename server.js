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
// STREAM API (WITH ORIGINAL TITLE)
// =========================
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

        // Итерируемся по прокси и ЖДЕМ исхода работы через await
        for (const row of dbRes.rows) {
            const proxyAddress = row.proxy_string;
            const proxyUrl = `socks5://${proxyAddress}`;
            console.log('TRY PROXY WITH TITLE:', proxyAddress);

            try {
                // Запускаем стрим. Если прокси упадет — сработает блок catch
                await startAudioStream(proxyUrl, target_url, res);
                return; // Успешно скачано, завершаем работу эндпоинта
            } catch (err) {
                console.log('PROXY FAIL:', proxyAddress, err.message);

                try {
                    await pool.query('DELETE FROM active_proxies WHERE proxy_string=$1', [proxyAddress]);
                    console.log('REMOVED BAD PROXY:', proxyAddress);
                } catch (e) {
                    console.error('DB delete error:', e.message);
                }

                // Критично: если прокси умер ПУТЕМ обрыва связи, когда часть аудио уже ушла, 
                // мы физически не можем подкинуть клиенту другой прокси, так как заголовки отправлены.
                if (res.headersSent) {
                    console.error('Headers already sent. Cannot switch proxy mid-stream.');
                    return;
                }
                // Если заголовки еще не ушли, цикл for переключится на следующий рабочий прокси
            }
        }

        if (!res.headersSent) res.status(500).send('No working proxies');

    } catch (e) {
        console.error('DB error:', e.message);
        if (!res.headersSent) res.status(500).send('Database error');
    }
});

// Улучшенная функция-промис, которая читает title из потока yt-dlp перед аудио-данными
function startAudioStream(proxyUrl, targetUrl, res) {
    return new Promise((resolve, reject) => {
        const yt = spawn('/opt/venv/bin/yt-dlp', [
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            '--no-check-certificate',
            '--add-header', 'User-Agent: Mozilla/5.0',
            '--add-header', 'Accept-Language: en-US,en',
            '--proxy', proxyUrl,
            '--print', 'filename:%(title)s.m4a', // Важно: заставляет yt-dlp выдать "filename:Название трека.m4a" первой строкой
            '-o', '-',
            targetUrl
        ]);

        let headersSentLocal = false;
        let buffer = Buffer.alloc(0);

        yt.stdout.on('data', (chunk) => {
            if (!headersSentLocal) {
                // Накапливаем байты, пока не встретим перенос строки \n
                buffer = Buffer.concat([buffer, chunk]);
                const index = buffer.indexOf('\n');

                if (index !== -1) {
                    // Вырезаем первую текстовую строку с названием
                    const line = buffer.slice(0, index).toString().trim();
                    // Весь остаток первого чанка — это уже чистый бинарный поток аудио
                    const audioTail = buffer.slice(index + 1);

                    let filename = 'audio.m4a'; // Запасное имя на случай сбоя парсинга
                    if (line.startsWith('filename:')) {
                        filename = line.replace('filename:', '').trim();
                    }

                    // Чистим название от запрещенных для файловых систем символов (слэши, кавычки и т.д.)
                    const safeTitle = filename.replace(/[^a-z0-9а-яё_\-.]/gi, ' ').trim().slice(0, 100);

                    // Устанавливаем заголовки ответа клиенту
                    res.setHeader('Content-Type', 'audio/mp4'); // Стандартный MIME-тип для контейнера m4a
                    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}"`);
                    headersSentLocal = true;

                    // Если в первом чанке помимо имени уже лежал кусок аудио, пушим его клиенту
                    if (audioTail.length > 0) {
                        res.write(audioTail);
                    }
                    buffer = null; // Очищаем буфер из памяти
                }
            } else {
                // Для всех последующих чанков просто гоним бинарный стрим напрямую клиенту
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
                resolve(); // Успешно выполнено
            } else {
                if (!headersSentLocal) {
                    // Если процесс завершился до отправки заголовков — прокси плохой, кидаем reject
                    reject(new Error(`Exited with code ${code} before metadata parsed`));
                } else {
                    res.end(); // Обрываем стрим на стороне клиента
                    reject(new Error(`Stream cut off mid-way with code ${code}`));
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
