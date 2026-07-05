import express from 'express';
import { request } from 'undici';
import { exec } from 'child_process';
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
// CHECK PROXIES
// =========================
app.post('/api/check', (req, res) => {
    const { input, proto, url } = req.body;

    if (!input || !proto || !url) {
        return res.status(400).json({ error: 'missing params' });
    }

    const cmd =
        `/opt/venv/bin/python check.py -i "${input}" -p "${proto}" -u "${url}"`;

    exec(cmd, { env: process.env, timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: stderr });
        }

        res.json({ output: stdout.trim() });
    });
});

// =========================
// TUNNEL (NO COOKIES VERSION)
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

        for (const row of dbRes.rows) {

            const proxyAddress = row.proxy_string;
            const proxyUrl = `socks5://${proxyAddress}`;

            console.log('TRY:', proxyAddress);

            try {

                // =========================
                // yt-dlp (NO COOKIES)
                // =========================
                const streamUrl = await new Promise((resolve, reject) => {

                    const cmd =
                        `/opt/venv/bin/yt-dlp -f bestaudio \
                        --no-check-certificate \
                        --add-header "User-Agent: Mozilla/5.0" \
                        --add-header "Accept-Language: en-US,en" \
                        --proxy "${proxyUrl}" "${target_url}"`;

                    exec(cmd,
                        { timeout: 30000, maxBuffer: 1024 * 1024 },
                        (err, stdout, stderr) => {

                            if (stderr) console.log('yt-dlp:', stderr);

                            if (err) return reject(err);

                            resolve(stdout.trim());
                        }
                    );
                });

                console.log('STREAM URL OK');

                // =========================
                // STREAM FIXED (undici)
                // =========================
                const { body, headers, statusCode } = await request(streamUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0',
                        'Accept': '*/*',
                        'Range': 'bytes=0-'
                    }
                });

                if (statusCode !== 200) {
                    throw new Error('Bad status ' + statusCode);
                }

                console.log('SUCCESS:', proxyAddress);

                res.setHeader(
                    'Content-Type',
                    headers['content-type'] || 'audio/webm'
                );

                body.pipe(res);
                return;

            } catch (err) {

                console.log('FAIL:', proxyAddress, err.message);

                // удалить мёртвый прокси
                try {
                    await pool.query(
                        'DELETE FROM active_proxies WHERE proxy_string=$1',
                        [proxyAddress]
                    );
                    console.log('REMOVED:', proxyAddress);
                } catch (e) {
                    console.error('DB delete error:', e.message);
                }
            }
        }

        res.status(500).send('No working proxies');

    } catch (e) {
        console.error('DB error:', e.message);
        res.status(500).send('Database error');
    }
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('Server running on', PORT);
});