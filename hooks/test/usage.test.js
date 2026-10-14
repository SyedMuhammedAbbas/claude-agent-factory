'use strict';
// node claude/factory/test/usage.test.js — transcript usage: dedupe by message.id, parent + subagents counted once.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sessionUsage } = require('../dashboard/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
const parent = path.join(dir, 'sess.jsonl');
const sub = path.join(dir, 'sess', 'subagents');
fs.mkdirSync(sub, { recursive: true });
const a = (id, model, u) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T00:00:00Z', message: { id, model, usage: u } });
const u = (i, o, cw, cr) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 } });
fs.writeFileSync(parent, [
  JSON.stringify({ type: 'user', message: { content: 'hello' }, cwd: dir }),
  a('m1', 'claude-opus-5-5', u(10, 100, 1000, 0)),
  a('m1', 'claude-opus-5-5', u(10, 100, 1000, 0)), // streamed chunk, same id
  a('m2', 'claude-opus-5-5', u(5, 50, 0, 2000)),
  a('m9', '<synthetic>', u(0, 0, 0, 0)),
].join('\n') + '\n');
fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), [
  a('s1', 'claude-sonnet-5-5', u(1, 10, 500, 0)),
  a('s1', 'claude-sonnet-5-5', u(1, 10, 500, 0)),
  a('m2', 'claude-opus-5-5', u(5, 50, 0, 2000)), // already counted in the parent: must not count twice
].join('\n') + '\n');

const r = sessionUsage(parent);
assert.strictEqual(r.parts.length, 2);
assert.strictEqual(r.parts[0].messages, 2);
assert.strictEqual(r.parts[1].messages, 1);
assert.strictEqual(r.totals.messages, 3);
assert.strictEqual(r.totals.total, (10 + 100 + 1000) + (5 + 50 + 2000) + (1 + 10 + 500));
// opus 5.5: in 4, out 20, 5m write 5, read 0.2 ; sonnet 5.5: in 2, out 10, 5m write 2.5
const expect = (10 * 4 + 100 * 20 + 1000 * 5 + 5 * 4 + 50 * 20 + 2000 * 0.2 + 1 * 2 + 10 * 10 + 500 * 2.5) / 1e6;
assert.ok(Math.abs(r.totals.cost - expect) < 1e-12, `cost ${r.totals.cost} != ${expect}`);
// incremental append is picked up
fs.appendFileSync(parent, a('m3', 'claude-unknown-9', u(1, 1, 0, 0)) + '\n');
const r2 = sessionUsage(parent);
assert.strictEqual(r2.totals.messages, 4);
assert.strictEqual(r2.totals.unpriced, 2);
fs.rmSync(dir, { recursive: true, force: true });
console.log('usage dedupe OK', JSON.stringify(r.totals));
