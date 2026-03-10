#!/usr/bin/env node
/**
 * Smoke test: verify server responds on /health and serves static.
 * Run: node smoke-test.js
 * Optional:
 *   - BASE_URL=https://127.0.0.1:3002
 *   - PORT=3000 HTTPS=1
 */
import http from 'http';
import https from 'https';

const PORT = Number(process.env.PORT || 3000);
const EXPLICIT_BASE_URL = process.env.BASE_URL || '';

function get(baseUrl, path) {
    return new Promise((resolve, reject) => {
        const target = new URL(path, baseUrl);
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.get(target, { timeout: 5000, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body, url: target.toString() }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function resolveBaseUrl() {
    if (EXPLICIT_BASE_URL) return new URL(EXPLICIT_BASE_URL);

    const candidates = [
        new URL(`https://127.0.0.1:${PORT}`),
        new URL(`http://127.0.0.1:${PORT}`)
    ];

    for (const candidate of candidates) {
        try {
            const health = await get(candidate, '/health');
            if (health.status === 200) return candidate;
        } catch {
            // Try the next candidate.
        }
    }

    return candidates[0];
}

async function run() {
    const results = [];
    const baseUrl = await resolveBaseUrl();
    try {
        const health = await get(baseUrl, '/health');
        const ok = health.status === 200 && (() => { try { return JSON.parse(health.body).status === 'ok'; } catch { return false; } })();
        results.push({ name: 'GET /health', pass: ok, status: health.status });
    } catch (e) {
        results.push({ name: 'GET /health', pass: false, error: e.message });
    }
    try {
        const index = await get(baseUrl, '/');
        results.push({ name: 'GET /', pass: index.status === 200, status: index.status });
    } catch (e) {
        results.push({ name: 'GET /', pass: false, error: e.message });
    }

    const passed = results.filter((r) => r.pass).length;
    const total = results.length;
    console.log(`Smoke target: ${baseUrl.toString()}`);
    console.log('Smoke test:', passed === total ? 'PASS' : 'FAIL', `(${passed}/${total})`);
    results.forEach((r) => console.log('  ', r.pass ? '[OK]' : '[X]', r.name, r.status != null ? r.status : r.error || ''));
    process.exit(passed === total ? 0 : 1);
}

run();

