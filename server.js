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
// STREAM API (FIXED)
// =========================
app.get('/api/tunnel', async (req, res) => {
    const { target_url } = req.query;

    if (!target_url) {
        return res.status(400).send('No target_url');
    }

    if (!pool) {
        return res.status(500).send('DB not configured');
    }

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
                // yt-dlp STREAM (spawn FIX)
                // =========================
                const yt = spawn('/opt/venv/bin/yt-dlp', [
                    '-f', 'bestaudio[ext=m4a]/bestaudio',
                    '--no-check-certificate',
                    '--add-header', 'User-Agent: Mozilla/5.0',
                    '--add-header', 'Accept-Language: en-US,en',
                    '--proxy', proxyUrl,
                    '-o', '-',
                    target_url
                ]);

                res.setHeader('Content-Type', 'audio/mp4');
                res.setHeader(
                    'Content-Disposition',
                    'attachment; filename="audio.m4a"'
                );
                let started = false;

                yt.stdout.on('data', (chunk) => {
                    started = true;
                    res.write(chunk);
                });

                yt.stderr.on('data', (d) => {
                    console.log('yt-dlp:', d.toString());
                });

                yt.on('error', async (err) => {
                    console.log('FAIL:', proxyAddress, err.message);

                    if (pool) {
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

                    if (!res.headersSent) {
                        res.status(500).send('Stream error');
                    }
                });

                yt.on('close', (code) => {
                    console.log('yt-dlp exit:', code);

                    if (!started) {
                        console.log('NO DATA STREAMED');

                        if (!res.headersSent) {
                            res.status(500).end('Empty stream');
                        }
                        return;
                    }

                    res.end();
                });

                return; // stop proxy loop after start

            } catch (err) {

                console.log('PROXY FAIL:', proxyAddress, err.message);

                try {
                    await pool.query(
                        'DELETE FROM active_proxies WHERE proxy_string=$1',
                        [proxyAddress]
                    );
                } catch (e) {
                    console.error(e.message);
                }
            }
        }

        res.status(500).send('No working proxies');

    } catch (e) {
        console.error('DB error:', e.message);
        res.status(500).send('Database error');
    }
});
function extractVideoId(url) {
    try {
        const u = new URL(url);
        return u.searchParams.get('v') || url.split('/').pop();
    } catch {
        return 'audio';
    }
}
// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('Server running on', PORT);
});
