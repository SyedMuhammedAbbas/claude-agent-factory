'use strict';
// node claude/factory/test/server.test.js  - every request path is answered (no socket left open).
const assert = require('assert');
const http = require('http');
const { handler } = require('../dashboard/server');

const get = (port, p, host) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: host || `127.0.0.1:${port}` }, timeout: 5000 }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('timeout', () => req.destroy(new Error(`no answer for ${p} within 5 s`)));
  req.on('error', reject);
});

const srv = http.createServer(handler).listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  try {
    assert.strictEqual(await get(port, '/api/nope'), 404);
    assert.strictEqual(await get(port, '/api/board?id=no-such-board'), 404);
    assert.strictEqual(await get(port, '/api/boards/discover'), 404); // removed Odoo route
    assert.strictEqual(await get(port, '/api', 'evil.example'), 403);
    assert.strictEqual(await get(port, '/'), 200);
    console.log('server tests passed');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { srv.close(); }
});
