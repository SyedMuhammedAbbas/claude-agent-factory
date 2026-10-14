'use strict';
// node claude/factory/test/board.test.js  - offline checks for dashboard/board.js (no network: fetch throws).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'we-')), 'work-events.jsonl');
process.env.FACTORY_WORK_EVENTS = wf; // before the require: board.js reads it at load
process.env.HERMES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-')); // no pending.json: no Hermes reconciliation
global.fetch = () => { throw new Error('the board must not make network calls'); };
const { handle, matchers, queueBuckets, workEvents } = require('../dashboard/board');
const { build } = require('../work');

// id matching: digit boundaries, so ticket 37 does not match branch ticket-371
const m = matchers({ id: 28608, ticket: 37, title: 'EME-1241: x' });
assert.ok(m.branch.test('agent/EME-1241-odoo-28608-fix'));
assert.ok(m.branch.test('task/ticket-37-foo'));
assert.ok(!m.branch.test('task/ticket-371-foo'));
assert.ok(!m.branch.test('agent/EME-12410-foo'));
assert.ok(m.text.test('working on Ticket#37 now'));
assert.ok(m.text.test('odoo 28608'));
assert.ok(!m.text.test('size 286089 bytes'));

// work-queue.md buckets (heading, table cell and inline forms)
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wq-')), 'work-queue.md');
fs.writeFileSync(f, '## Bucket A\n- Ticket#371 fix\n## B - later\n- EME-5 thing\n## Notes\n- Ticket#9\n| Ticket#12 | C |\n');
const q = queueBuckets(f);
assert.strictEqual(q.get('t371'), 'A');
assert.strictEqual(q.get('e5'), 'B');
assert.strictEqual(q.get('t9'), undefined);
assert.strictEqual(q.get('t12'), 'C');

// work-events.jsonl: malformed and invalid lines are skipped, the latest line per ticket is last in order
fs.writeFileSync(wf, [
  '{"ts":"2026-10-13T10:00:00Z","project":"Acme","ticket":"374","stage":"building","agent":"engineer (sonnet)"}',
  'not json at all',
  '{"ts":"2026-10-13T10:05:00Z","project":"Acme","ticket":"#374","stage":"review","pr":"https://x/pr/1"}',
  '{"ts":"2026-10-13T10:06:00Z","project":"Acme","ticket":"1","stage":"nonsense"}',
  '{"ts":"bad","project":"Acme","ticket":"2","stage":"qa"}',
  '{"ts":"2026-10-13T10:07:00Z","project":"Acme","ticket":"eme-9","stage":"queued","pr":"javascript:alert(1)"}',
  '{"ts":"2026-10-13T10:08:'].join('\n'));
const w = workEvents();
assert.deepStrictEqual(w.map((e) => e.ticket + ':' + e.stage), ['374:building', '374:review', 'EME-9:queued']);
assert.strictEqual(w[2].pr, ''); // only http(s) links survive

// work.js builds a valid line and rejects bad input
const l = build(['Acme', '#376', 'qa', '--agent', 'qa (sonnet)', '--proposal', '12']);
assert.strictEqual(l.ticket, '376');
assert.strictEqual(l.proposal, '12');
assert.throws(() => build(['Acme', '376', 'shipping']), /stage must be/);
assert.throws(() => build(['Acme', '376', 'qa', '--pr', 'file:///x']), /http/);
// The board keeps only tickets in progress: latest line not "done", and a line in the last 24 h or a running agent.
(async () => {
  const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const line = (h, ticket, stage, note) => JSON.stringify({ ts: ago(h), project: 'Probe Board', ticket, stage, agent: 'engineer (sonnet)', note });
  fs.writeFileSync(wf, [
    line(3, '1', 'queued', 'old'), line(1, '1', 'building', 'Fix the checkout total'),
    line(1, '2', 'done', 'shipped'),
    line(30, '3', 'qa', 'quiet for 30 hours'),
    line(2, '4', 'blocked', 'needs the owner'),
    line(30, '5', 'building', 'long build, agent still running'),
  ].join('\n') + '\n');
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  fs.mkdirSync(path.join(tdir, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 's1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'engineer', description: 'Build Ticket#5' }));
  const deps = { loadEvents: () => [{ event: 'SubagentStart', ts: ago(0.5), agent_id: 'a1', session_id: 's1', transcript_path: path.join(tdir, 's1.jsonl') }] };
  const get = (u) => handle('GET', new URL(u, 'http://127.0.0.1'), deps);

  const [code, d] = await get('/api/board?id=probeboard');
  assert.strictEqual(code, 200);
  const open = Object.fromEntries(d.stages.flatMap((s) => s.cards.map((c) => [c.ticket, s.id])));
  assert.deepStrictEqual(open, { 1: 'building', 4: 'blocked', 5: 'building' });
  assert.ok(!d.stages.some((s) => s.id === 'done'));
  assert.strictEqual(d.tickets, 3);
  assert.deepStrictEqual(d.finished.map((c) => c.ticket).sort(), ['2', '3']);
  const building = d.stages.find((s) => s.id === 'building').cards;
  assert.strictEqual(building.find((c) => c.ticket === '1').title, 'Fix the checkout total'); // title is the latest note
  assert.ok(building.find((c) => c.ticket === '5').running);

  const [, l] = await get('/api/boards');
  assert.strictEqual(l.boards.find((b) => b.id === 'probeboard').open, 3); // tab count follows the same rule
  assert.strictEqual(handle('GET', new URL('http://127.0.0.1/api/board/task?id=1'), deps), null); // Odoo routes are gone
  assert.strictEqual(handle('POST', new URL('http://127.0.0.1/api/boards/discover'), deps), null);
  assert.strictEqual((await get('/api/board?id=nope'))[0], 404);
  console.log('board tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
