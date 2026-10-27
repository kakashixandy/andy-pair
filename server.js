// Runs on Render. Serves the page and sends pairing requests to your bot servers.
// The visitor never chooses a server. This file picks one automatically:
//   1. It asks every server for its status (alive? full? already has this number?)
//   2. A number that already has a bot is refused, so it never runs on two servers
//   3. It uses the least busy server that has space, and falls back to the next one
//      if that server is full or has a problem
//
// Environment variables on Render (name in the first box, value in the second):
//   SERVER1_URL = http://145.239.69.111:20370     SERVER1_KEY = your key
//   SERVER2_URL = http://NEW_IP:PORT              SERVER2_KEY = your key
//   (SERVER3_URL / SERVER3_KEY ... up to SERVER5 work the same way)
// With only server 1 set, everything works with one server.
// The old names KATABUMP_URL and MINIBOT_KEY still work for server 1, so nothing breaks
// while you switch over.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

function loadServers() {
    const list = [];
    const add = (id, url, key) => {
        url = (url || '').replace(/\/$/, '');
        if (url && key) list.push({ id, url, key });
    };
    for (let n = 1; n <= 5; n++) {
        let url = process.env[`SERVER${n}_URL`];
        let key = process.env[`SERVER${n}_KEY`];

        // Server 1 can still use the old names
        if (n === 1) {
            url = url || process.env.KATABUMP_URL;
            key = key || process.env.MINIBOT_KEY;
        }
        add(String(n), url, key);
    }
    return list;
}

const SERVERS = loadServers();
console.log(`Bot servers configured: ${SERVERS.length}`);

const PAGE = fs.readFileSync(path.join(__dirname, 'index.html'));

// ---------- talking to a bot server ----------
async function ask(server, endpoint, { method = 'GET', body, timeout = 8000 } = {}) {
    const res = await fetch(server.url + endpoint, {
        method,
        headers: {
            'x-api-key': server.key,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

// Status of every server. A server that does not answer is left out (treated as down).
async function allStatuses(number = '') {
    const query = number ? `?number=${number}` : '';
    const results = await Promise.all(SERVERS.map(async (server) => {
        try {
            const r = await ask(server, `/status${query}`, { timeout: 6000 });
            return r.status === 200 ? { server, ...r.data } : null;
        } catch {
            return null;
        }
    }));
    return results.filter(Boolean);
}

// ---------- small helpers ----------
let statsCache = null;

const hits = new Map(); // simple per-visitor limit: 5 code requests per 10 minutes
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

// ---------- the web server ----------
const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
    }

    // Live stats for the page: totals across all servers (counts only, never numbers)
    if (req.method === 'GET' && req.url === '/api/stats') {
        if (!SERVERS.length) return send(503, { error: 'Not set up yet.' });

        if (statsCache && Date.now() - statsCache.time < 30000) return send(200, statsCache.data);

        const alive = await allStatuses();
        if (!alive.length) return send(502, { error: 'Stats unavailable' });

        const data = {
            users: alive.reduce((sum, s) => sum + (s.users || 0), 0),
            online: alive.reduce((sum, s) => sum + (s.online || 0), 0),
            available: alive.some((s) => !s.full)
        };
        statsCache = { time: Date.now(), data };
        return send(200, data);
    }

    if (req.method === 'POST' && req.url === '/api/pair') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (limited(ip)) return send(429, { error: 'Too many tries. Please wait a few minutes.' });

        if (!SERVERS.length) return send(503, { error: 'The service is not set up yet.' });

        try {
            const body = await readJson(req);
            const number = String(body.number || '').replace(/\D/g, '');
            if (number.length < 8 || number.length > 15) {
                return send(400, { error: 'Enter a valid number with the country code, digits only.' });
            }

            // 1. Ask every server about this number
            const alive = await allStatuses(number);
            if (!alive.length) {
                return send(503, { error: 'The bot servers are not reachable right now. Try again soon.' });
            }

            // 2. A number must never run on two servers
            if (alive.some((s) => s.has)) {
                return send(409, { error: 'This number already has a bot running.' });
            }

            // 3. Servers with space, least busy first
            const open = alive
                .filter((s) => !s.full)
                .sort((a, b) => (a.running / (a.max || 1)) - (b.running / (b.max || 1)));

            if (!open.length) {
                return send(503, { error: 'All servers are full right now. Please try again later.' });
            }

            // 4. Try the best one, fall back to the next if it is full or has a problem
            for (const candidate of open) {
                try {
                    const r = await ask(candidate.server, '/pair', {
                        method: 'POST',
                        body: { number },
                        timeout: 40000
                    });

                    if (r.status === 200 && r.data.code) return send(200, { code: r.data.code });

                    // Full (503) or a server problem (5xx): try the next server
                    if (r.status >= 500) continue;

                    // A problem with the request itself (wait a minute, bad number...): tell the user
                    return send(r.status, { error: r.data.error || 'Request failed.' });
                } catch (e) {
                    console.error(`server ${candidate.server.id} failed:`, e.message);
                    continue;
                }
            }

            return send(503, { error: 'The servers are busy right now. Please try again in a moment.' });
        } catch (e) {
            console.error('pair error:', e.message);
            return send(502, { error: 'Something went wrong. Try again.' });
        }
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => console.log('Site running on port', PORT));
