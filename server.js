// Runs on Render. Serves the page and forwards pairing requests to your Katabump server.
// The browser only talks to this server (HTTPS). This server talks to Katabump.
//
// Environment variables to set on Render:
//   KATABUMP_URL = http://145.239.69.111:20370
//   MINIBOT_KEY  = the same secret you put in minibotKey in settings.js on Katabump

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const KATABUMP_URL = (process.env.KATABUMP_URL || '').replace(/\/$/, '');
const MINIBOT_KEY = process.env.MINIBOT_KEY || '';

const PAGE = fs.readFileSync(path.join(__dirname, 'index.html'));

let statsCache = null;

// Simple per-visitor limit: 5 code requests per 10 minutes
const hits = new Map();
function limited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > 5;
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 2048) { reject(new Error('too large')); req.destroy(); }
        });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); }
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
    }

    if (req.method === 'GET' && req.url === '/api/stats') {
        if (!KATABUMP_URL) return send(503, { error: 'Not set up yet.' });

        // Cache for 30 seconds so visitors do not hammer your bot server
        if (statsCache && Date.now() - statsCache.time < 30000) return send(200, statsCache.data);

        try {
            const upstream = await fetch(`${KATABUMP_URL}/stats`, { signal: AbortSignal.timeout(10000) });
            const data = await upstream.json();
            statsCache = { time: Date.now(), data: { users: data.users, online: data.online } };
            return send(200, statsCache.data);
        } catch (e) {
            return send(502, { error: 'Stats unavailable' });
        }
    }

    if (req.method === 'POST' && req.url === '/api/pair') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (limited(ip)) return send(429, { error: 'Too many tries. Please wait a few minutes.' });

        if (!KATABUMP_URL || !MINIBOT_KEY) return send(503, { error: 'The service is not set up yet.' });

        try {
            const body = await readJson(req);
            const number = String(body.number || '').replace(/\D/g, '');

            const upstream = await fetch(`${KATABUMP_URL}/pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': MINIBOT_KEY },
                body: JSON.stringify({ number }),
                signal: AbortSignal.timeout(40000)
            });

            const data = await upstream.json().catch(() => ({}));
            return send(upstream.status, data.code ? { code: data.code } : { error: data.error || 'Request failed.' });
        } catch (e) {
            console.error('proxy error:', e.message);
            return send(502, { error: 'The bot server is not reachable right now. Try again soon.' });
        }
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => console.log('Site running on port', PORT));
