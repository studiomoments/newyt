import express from 'express';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg'; // Используем pg вместо sqlite3

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(__dirname));
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "найден" : "НЕ НАЙДЕН");
// Подключение к PostgreSQL через переменную окружения Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Обязательно для облачных БД типа Render/AWS
});

// Инициализация таблицы при запуске сервера
pool.query(`
    CREATE TABLE IF NOT EXISTS active_proxies (
        id SERIAL PRIMARY KEY,
        proxy_string TEXT UNIQUE,
        protocol TEXT
    )
`).catch(err => console.error("Ошибка инициализации таблицы БД:", err));

// Маршрут для запуска проверки прокси
// Маршрут для запуска проверки прокси
app.post('/api/check', (req, res) => {
    const { input, proto, url } = req.body;

    if (!input || !proto || !url) {
        return res.status(400).json({ error: "Переданы не все параметры" });
    }

    if (!process.env.DATABASE_URL) {
        return res.status(500).json({
            error: "DATABASE_URL отсутствует в Environment Variables"
        });
    }

    const command = `/opt/venv/bin/python check.py -i "${input}" -p "${proto}" -u "${url}"`;

    exec(
        command,
        {
            env: process.env
        },
        (error, stdout, stderr) => {
            if (error) {
                console.error(stderr);
                return res.status(500).json({
                    error: "Ошибка выполнения Python",
                    details: stderr
                });
            }

            res.json({
                message: "Проверка завершена",
                output: stdout.trim()
            });
        }
    );
});


// Туннелирование потока
app.get('/api/tunnel', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { target_url } = req.query;
    if (!target_url) return res.status(400).send("Укажите target_url");

    try {
        // Достаем случайный прокси из PostgreSQL
        const dbRes = await pool.query(
            "SELECT proxy_string FROM active_proxies WHERE protocol = 'socks5' ORDER BY RANDOM() LIMIT 1"
        );

        if (dbRes.rows.length === 0) {
            return res.status(500).send("Нет доступных рабочих прокси в PostgreSQL. Запустите проверку!");
        }

        const proxyAddress = dbRes.rows[0].proxy_string;
        const proxyUrl = `socks5://${proxyAddress}`;

        const ytdlpCmd = `/opt/venv/bin/yt-dlp -g -f bestaudio --js-runtimes node --proxy "${proxyUrl}" "${target_url}"`;

        exec(ytdlpCmd, async (ytErr, stdout, ytStderr) => {
            if (ytErr) {
                console.error("Ошибка yt-dlp:", ytStderr);
                return res.status(500).send("Не удалось получить streamurl через прокси.");
            }

            const streamUrl = stdout.trim();

            try {
                const agent = new SocksProxyAgent(proxyUrl);
                const youtubeResponse = await axios({
                    method: 'get',
                    url: streamUrl,
                    responseType: 'stream',
                    httpsAgent: agent,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });

                res.setHeader('Content-Type', youtubeResponse.headers['content-type'] || 'audio/webm');
                youtubeResponse.data.pipe(res);

            } catch (error) {
                console.error("Ошибка туннелирования байт:", error.message);
                res.status(500).send("Ошибка стриминга данных.");
            }
        });

    } catch (dbErr) {
        console.error("Ошибка БД:", dbErr.message);
        res.status(500).send("Ошибка при обращении к базе данных.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
