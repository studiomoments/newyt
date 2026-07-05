import express from 'express';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { exec } from 'child_process';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(__dirname)); // Отдавать index.html из корня

const dbPath = path.join(__dirname, 'proxies.db');

// Маршрут для запуска проверки прокси
app.post('/api/check', (req, res) => {
    const { input, proto, url } = req.body;
    
    if (!input || !proto || !url) {
        return res.status(400).json({ error: "Переданы не все параметры" });
    }

    // Безопасный запуск команды питона
    const command = `/opt/venv/bin/python check.py -i "${input}" -p "${proto}" -u "${url}" -o "${dbPath}"`;
    
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(stderr);
            return res.status(500).json({ error: "Ошибка при выполнении чекера", details: stderr });
        }
        res.json({ message: "Проверка успешно завершена", output: stdout.trim() });
    });
});

// Туннелирование потока
app.get('/api/tunnel', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    
    const { target_url } = req.query; // Ссылка на YouTube видео от юзера
    if (!target_url) return res.status(400).send("Укажите target_url");

    const db = new sqlite3.Database(dbPath);

    // Достаем случайный прокси socks5 из базы данных
    db.get("SELECT proxy_string FROM active_proxies WHERE protocol = 'socks5' ORDER BY RANDOM() LIMIT 1", async (err, row) => {
        db.close();

        if (err || !row) {
            return res.status(500).send("Нет доступных рабочих прокси в базе данных. Запустите проверку!");
        }

        const proxyAddress = row.proxy_string;
        const proxyUrl = `socks5://${proxyAddress}`;

        // Вызываем yt-dlp с указанием JS-рантайма node, чтобы избежать WARNING-ов
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
    });
});

app.listen(3000, () => console.log('Сервер и туннель запущен на порту 3000'));
