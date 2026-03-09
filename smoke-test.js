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
const BASE = process.env.BASE_URL || `${process.env.HTTPS === '1' ? 'https' : 'http'}://127.0.0.1:${PORT}`;
const BASE_URL = new URL(BASE);

function get(path) {
    return new Promise((resolve, reject) => {
        const target = new URL(path, BASE_URL);
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.get(target, { timeout: 5000, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function run() {
    const results = [];
    try {
        const health = await get('/health');
        const ok = health.status === 200 && (() => { try { return JSON.parse(health.body).status === 'ok'; } catch { return false; } })();
        results.push({ name: 'GET /health', pass: ok, status: health.status });
    } catch (e) {
        results.push({ name: 'GET /health', pass: false, error: e.message });
    }
    try {
        const index = await get('/');
        results.push({ name: 'GET /', pass: index.status === 200, status: index.status });
    } catch (e) {
        results.push({ name: 'GET /', pass: false, error: e.message });
    }

    const passed = results.filter((r) => r.pass).length;
    const total = results.length;
    console.log('Smoke test:', passed === total ? 'PASS' : 'FAIL', `(${passed}/${total})`);
    results.forEach((r) => console.log('  ', r.pass ? '✓' : '✗', r.name, r.status != null ? r.status : r.error || ''));
    process.exit(passed === total ? 0 : 1);
}

run();
