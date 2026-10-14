#!/usr/bin/env node
'use strict';
// Claude factory dashboard: http://127.0.0.1:7777 (loopback only). Zero dependencies.
// Activity comes from the telemetry hook's event files; tokens, models and estimated cost are read
// from the session transcripts on demand (deduped by message.id, cached by file size + mtime).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { DATA_DIR, gitInfo, localDate } = require('../lib');
const board = require('./board');

const HOST = '127.0.0.1';
const PORT = Number(process.env.FACTORY_DASHBOARD_PORT || 7777);
const ROOT = path.join(__dirname, '..');
const CONFIG_DIRS = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude-personal')];
const HERMES_STATE = path.join(process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || '', 'hermes'), 'state', 'agent_ops');
const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, 'pricing.json'), 'utf8'));
const ACTIVE_MS = 5 * 60 * 1000;
const SNAPSHOT_TTL = 4000; // /api answers from one shared snapshot for this long; the Overview polls every 5 s
const MAX_FILE = 64 * 1024 * 1024; // a jsonl file larger than this is not parsed (its session shows the skip)
const REQUEST_LIMIT = 30000; // every request is answered within this, so no socket is left open

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const tick = () => new Promise((r) => setImmediate(r)); // lets queued requests run between files

// ---------- incremental jsonl reader ----------

const fileCache = new Map(); // path -> { size, mtimeMs, offset, rest, state }
const CH = 8 * 1024 * 1024;
let readBuf = null; // one buffer for every read: reads are synchronous, so it is never shared mid-read

// Feeds only the new complete lines of `file` to onLine(obj, state); restarts if the file shrank.
function readIncremental(file, init, onLine) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.size > MAX_FILE) return { ...init(), skipped: true };
  let c = fileCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.state;
  if (!c || st.size < c.offset) { c = { offset: 0, state: init() }; fileCache.set(file, c); }
  const fd = fs.openSync(file, 'r');
  try {
    const buf = readBuf || (readBuf = Buffer.allocUnsafe(CH));
    let n;
    // offset always sits just after a newline, so a partial last line (or UTF-8 sequence) is re-read next time
    while ((n = fs.readSync(fd, buf, 0, CH, c.offset)) > 0) {
      const nl = buf.lastIndexOf(10, n - 1);
      if (nl < 0) { if (n < CH) break; c.offset += n; continue; } // shortcut: a single line over 8 MB is skipped
      const lines = buf.toString('utf8', 0, nl).split('\n');
      c.offset += nl + 1;
      for (const l of lines) {
        if (!l.trim()) continue;
        let o;
        try { o = JSON.parse(l); } catch { continue; }
        onLine(o, c.state);
      }
    }
  } finally { fs.closeSync(fd); }
  c.size = st.size; c.mtimeMs = st.mtimeMs;
  return c.state;
}

// ---------- transcripts: usage per message.id ----------

const newTranscript = () => ({ msgs: new Map(), title: null, prompt: null, cwd: null, first: null, last: null });

function onTranscriptLine(o, s) {
  if (o.timestamp) { s.first = s.first || o.timestamp; s.last = o.timestamp; }
  if (!s.cwd && o.cwd) s.cwd = o.cwd;
  if (o.type === 'custom-title' && o.customTitle) s.title = o.customTitle;
  else if (o.type === 'summary' && o.summary && !s.title) s.title = o.summary;
  if (o.type === 'user' && !o.isMeta && !s.prompt && o.message) {
    const c = o.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) && c[0] && c[0].type === 'text' ? c[0].text : null;
    if (text && !text.startsWith('<')) s.prompt = text.slice(0, 140);
  }
  const m = o.message;
  if (o.type !== 'assistant' || !m || !m.id || !m.usage || m.model === '<synthetic>') return;
  const u = m.usage;
  const cc = u.cache_creation || {};
  const cw1h = cc.ephemeral_1h_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const v = {
    model: m.model, geo: u.inference_geo,
    input: u.input_tokens || 0, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0,
    cache_write_1h: cw1h, cache_write_5m: Math.max(0, cw - cw1h),
  };
  const prev = s.msgs.get(m.id);
  if (prev) for (const k of ['input', 'output', 'cache_read', 'cache_write_1h', 'cache_write_5m']) v[k] = Math.max(v[k], prev[k]);
  s.msgs.set(m.id, v); // streamed chunks repeat the same id: keep one entry per message
}

function priceFor(model) {
  let best = null;
  for (const k of Object.keys(PRICING.models)) if (model && model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? PRICING.models[best] : null;
}

function messageCost(v) {
  let p = priceFor(v.model);
  if (!p) return null;
  if (p.over_100k && v.input + v.cache_read + v.cache_write_5m + v.cache_write_1h > 100000) p = p.over_100k;
  const usd = (v.input * p.input + v.output * p.output + v.cache_read * p.cache_read
    + v.cache_write_5m * p.cache_write_5m + v.cache_write_1h * p.cache_write_1h) / 1e6;
  return v.geo === 'us' ? usd * 1.1 : usd;
}

const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0, unpriced: 0, messages: 0 });
function add(t, v) {
  t.input += v.input; t.output += v.output; t.cache_read += v.cache_read;
  t.cache_write += v.cache_write_5m + v.cache_write_1h;
  t.total += v.input + v.output + v.cache_read + v.cache_write_5m + v.cache_write_1h;
  t.messages++;
  const c = messageCost(v);
  if (c == null) t.unpriced += v.input + v.output + v.cache_read + v.cache_write_5m + v.cache_write_1h; else t.cost += c;
}
function sum(a, b) { for (const k of Object.keys(a)) a[k] += b[k]; return a; }

function subagentFiles(transcript) {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  try { return fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).map((f) => path.join(dir, f)); } catch { return []; }
}

// Parent transcript + each subagent transcript, each attributed once; a message id already counted in
// another file of the session is skipped, so nothing is double counted.
function sessionUsage(transcript) {
  const files = [transcript, ...subagentFiles(transcript)];
  const seen = new Set();
  const totals = zero();
  const models = {};
  const parts = [];
  let meta = null;
  let skipped = 0;
  for (const f of files) {
    const s = readIncremental(f, newTranscript, onTranscriptLine);
    if (!s) continue;
    if (s.skipped) { skipped++; continue; }
    if (!meta) meta = s;
    const t = zero();
    for (const [id, v] of s.msgs) {
      if (seen.has(id)) continue;
      seen.add(id);
      add(t, v);
      models[v.model] = (models[v.model] || 0) + 1;
    }
    sum(totals, t);
    const am = f === transcript ? {} : readJson(f.replace(/\.jsonl$/, '.meta.json'), {});
    const agent = f === transcript ? 'main' : am.agentType || path.basename(f, '.jsonl');
    parts.push({ file: f, agent, description: am.description || null, model: am.model || null, first: s.first, last: s.last, ...t });
  }
  return { totals, models, parts, skipped, meta: meta || newTranscript() };
}

// Parses each file of the session that changed, one per event-loop turn, so a cold start (tens of MB of
// transcripts) never blocks the board or other requests for longer than one file.
async function warmSession(transcript) {
  for (const f of [transcript, ...subagentFiles(transcript)]) { readIncremental(f, newTranscript, onTranscriptLine); await tick(); }
}

// ---------- events ----------

function windowStart(days) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1));
  return d;
}

function loadEvents(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const f = path.join(DATA_DIR, `events-${localDate(d)}.jsonl`);
    const s = readIncremental(f, () => ({ list: [] }), (o, st) => st.list.push(o));
    if (s) out.push(...s.list);
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

// Async fs calls: hundreds of stats run on the libuv pool instead of blocking the event loop.
async function recentTranscripts(since) {
  const fsp = fs.promises;
  const out = [];
  const scanned = new Set();
  for (const cfg of CONFIG_DIRS) {
    const proj = path.join(cfg, 'projects');
    let real;
    try { real = await fsp.realpath(proj); } catch { continue; }
    if (scanned.has(real)) continue; // .claude-personal\projects may be a junction to .claude\projects
    scanned.add(real);
    let dirs = [];
    try { dirs = await fsp.readdir(proj); } catch { continue; }
    await Promise.all(dirs.map(async (d) => {
      let files = [];
      try { files = await fsp.readdir(path.join(proj, d)); } catch { return; }
      await Promise.all(files.filter((f) => f.endsWith('.jsonl')).map(async (f) => {
        const p = path.join(proj, d, f);
        try { if ((await fsp.stat(p)).mtimeMs >= since) out.push({ id: f.slice(0, -6), transcript: p, configDir: cfg }); } catch { /* gone */ }
      }));
    }));
  }
  return out;
}

const ACTIVITY = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PermissionDenied', 'SubagentStart', 'SubagentStop']);

async function snapshot(days) {
  const since = windowStart(days).getTime();
  const events = loadEvents(days);
  const recent = await recentTranscripts(since);
  const now = Date.now();
  const byId = new Map();
  const S = (id) => {
    if (!byId.has(id)) byId.set(id, { id, events: [], transcript: null });
    return byId.get(id);
  };
  for (const e of events) if (e.session_id) { const s = S(e.session_id); s.events.push(e); if (e.transcript_path) s.transcript = e.transcript_path; }
  for (const t of recent) { const s = S(t.id); s.transcript = s.transcript || t.transcript; }

  const sessions = [];
  const agents = [];
  const errors = [];
  const approvals = [];
  for (const s of byId.values()) {
    if (s.transcript) await warmSession(s.transcript);
    const u = s.transcript ? sessionUsage(s.transcript) : { totals: zero(), models: {}, parts: [], skipped: 0, meta: newTranscript() };
    const ev = s.events;
    const lastEv = ev[ev.length - 1];
    const startEv = ev.find((e) => e.event === 'SessionStart');
    const cwd = (lastEv && lastEv.cwd) || u.meta.cwd;
    const gi = cwd ? gitInfo(cwd) : { project: '?' };
    const project = (lastEv && lastEv.project) || gi.project || '?';
    const start = [ev[0] && ev[0].ts, u.meta.first].filter(Boolean).sort()[0] || null;
    const last = [lastEv && lastEv.ts, u.meta.last].filter(Boolean).sort().pop() || null;
    const ended = lastEv && lastEv.event === 'SessionEnd';
    const lastMs = last ? Date.parse(last) : 0;
    const status = ended ? 'ended' : now - lastMs < ACTIVE_MS && !(lastEv && lastEv.event === 'Stop') ? 'active' : 'idle';
    const gitEv = [...ev].reverse().find((e) => e.branch);
    const lastTool = [...ev].reverse().find((e) => e.tool_name);
    const firstPrompt = ev.find((e) => e.event === 'UserPromptSubmit');
    sessions.push({
      id: s.id, project, cwd, repo: gi.root || null,
      title: u.meta.title || (startEv && startEv.title) || u.meta.prompt || (firstPrompt && firstPrompt.prompt) || '',
      models: Object.keys(u.models), start, last, duration_ms: start && last ? Date.parse(last) - Date.parse(start) : 0,
      status, stage: lastEv ? `${lastEv.event}${lastTool && lastTool === lastEv ? ': ' + lastEv.tool_name : ''}` : 'no hook events',
      last_tool: lastTool ? `${lastTool.tool_name}${lastTool.tool ? ' ' + lastTool.tool.slice(0, 80) : ''}` : null,
      tokens: u.totals, subagents: Math.max(0, u.parts.length - 1), skipped: u.skipped,
      branch: gitEv ? gitEv.branch : null, diff: gitEv ? [gitEv.diff, gitEv.diff_cached && `staged: ${gitEv.diff_cached}`].filter(Boolean).join('; ') : null,
      hooked: ev.length > 0,
    });
    if (!ended) {
      const open = new Map();
      for (const e of ev) {
        if (e.event === 'SubagentStart') open.set(e.agent_id, e);
        if (e.event === 'SubagentStop') open.delete(e.agent_id);
      }
      for (const a of open.values()) if (now - Date.parse(a.ts) < 12 * 3600 * 1000) agents.push({ session: s.id, project, agent_id: a.agent_id, agent_type: a.agent_type, since: a.ts });
    }
    for (const e of ev) if (e.error) errors.push({ session: s.id, project, ts: e.ts, event: e.event, tool: e.tool_name, summary: e.tool, error: e.error_text });
    const perm = [...ev].reverse().find((e) => e.event === 'PermissionRequest' || (e.event === 'Notification' && e.notification_type === 'permission_prompt'));
    if (perm && !ended && !ev.some((e) => e.ts > perm.ts && ACTIVITY.has(e.event) && e.event !== 'PreToolUse')) {
      approvals.push({ source: 'session', session: s.id, project, ts: perm.ts, what: perm.message || `${perm.tool_name || ''} ${perm.tool || ''}`.trim() });
    }
  }
  for (const p of readJson(path.join(HERMES_STATE, 'pending.json'), [])) {
    const a = (p.actions || []).find((x) => x.type === 'claude_action');
    if (a) approvals.push({ source: 'discord', n: p.n, project: a.project, session: a.session_id, what: a.command, status: 'waiting for `approve ' + p.n + '`' });
  }
  for (const [key, r] of Object.entries(readJson(path.join(HERMES_STATE, 'claude_approvals.json'), {}))) {
    if (r.status === 'approved' && !r.consumed_at && now - Date.parse(r.at) < 24 * 3600 * 1000) {
      approvals.push({ source: 'discord', n: r.n, what: r.command, status: 'approved, waiting for the session to re-run it', key: key.slice(0, 12) });
    }
  }
  sessions.sort((a, b) => ((a.last || '') < (b.last || '') ? 1 : -1));
  const projects = {};
  for (const s of sessions) {
    const p = projects[s.project] || (projects[s.project] = { project: s.project, sessions: 0, active: 0, tokens: zero(), last: null });
    p.sessions++; if (s.status === 'active') p.active++;
    sum(p.tokens, s.tokens);
    if (!p.last || (s.last && s.last > p.last)) p.last = s.last;
  }
  errors.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return {
    generated: new Date().toISOString(), days, since: new Date(since).toISOString(),
    pricing: { source: PRICING.source, retrieved: PRICING.retrieved },
    projects: Object.values(projects).sort((a, b) => ((a.last || '') < (b.last || '') ? 1 : -1)),
    sessions, agents, errors: errors.slice(0, 100), approvals,
  };
}

// One snapshot per window, shared by every caller inside SNAPSHOT_TTL; concurrent callers wait on the same build.
const snaps = new Map(); // days -> { at, data, pending }
function cachedSnapshot(days) {
  const c = snaps.get(days) || {};
  if (c.data && Date.now() - c.at < SNAPSHOT_TTL) return Promise.resolve(c.data);
  if (!c.pending) {
    c.pending = snapshot(days).then(
      (data) => { snaps.set(days, { at: Date.now(), data }); return data; },
      (e) => { delete c.pending; throw e; });
    snaps.set(days, c);
  }
  return c.pending;
}

async function sessionDetail(id, days) {
  const events = loadEvents(Math.max(days, 7)).filter((e) => e.session_id === id);
  let transcript = (events.find((e) => e.transcript_path) || {}).transcript_path;
  if (!transcript) transcript = ((await recentTranscripts(0)).find((t) => t.id === id) || {}).transcript;
  if (transcript) await warmSession(transcript);
  const u = transcript ? sessionUsage(transcript) : null;
  return { id, transcript, usage: u && { totals: u.totals, models: u.models, parts: u.parts, skipped: u.skipped }, events: events.slice(-500) };
}

// ---------- PRs (page load only, 60 s cache) ----------

let prCache = { at: 0, data: null };
async function prs() {
  if (prCache.data && Date.now() - prCache.at < 60000) return prCache.data;
  const repos = new Set(loadEvents(1).map((e) => e.repo).filter(Boolean));
  for (const s of (await cachedSnapshot(1)).sessions) if (s.repo) repos.add(s.repo);
  const jobs = [...repos].map((repo) => new Promise((resolve) => {
    execFile('gh', ['pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,url,headRefName'],
      { cwd: repo, timeout: 15000, windowsHide: true }, (err, out, errOut) => {
        if (err) return resolve({ repo, project: path.basename(repo), error: String(errOut || err.message).split('\n')[0].slice(0, 200), prs: [] });
        try { resolve({ repo, project: path.basename(repo), prs: JSON.parse(out) }); } catch { resolve({ repo, project: path.basename(repo), error: 'unreadable gh output', prs: [] }); }
      });
  }));
  return Promise.all(jobs).then((data) => { prCache = { at: Date.now(), data }; return data; });
}

// ---------- http ----------

function send(res, code, body, type = 'application/json; charset=utf-8') {
  if (res.headersSent || res.writableEnded) return; // already answered (e.g. by the time limit)
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Every async route goes through here: it is answered once, with the result, the error, or 503 after REQUEST_LIMIT.
function reply(res, p) {
  const timer = setTimeout(() => send(res, 503, { error: 'timed out, try again' }), REQUEST_LIMIT);
  Promise.resolve(p).then(([code, body]) => send(res, code, body), (e) => send(res, 500, { error: e.message })).finally(() => clearTimeout(timer));
}

function route(req, url) {
  const days = Math.min(14, Math.max(1, Number(url.searchParams.get('days')) || 1));
  const b = board.handle(req.method, url, { loadEvents });
  if (b) return b;
  if (url.pathname === '/api') return cachedSnapshot(days).then((d) => [200, d]);
  if (url.pathname === '/api/session') return sessionDetail(String(url.searchParams.get('id') || ''), days).then((d) => [200, d]);
  if (url.pathname === '/api/prs') return prs().then((d) => [200, d]);
  return [404, { error: 'not found' }];
}

function handler(req, res) {
  // loopback-only server; also refuse other Host headers (DNS rebinding)
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden' });
  let url;
  try { url = new URL(req.url, `http://${HOST}`); } catch { return send(res, 400, { error: 'bad url' }); }
  if (url.pathname === '/') {
    try { return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8'); } catch (e) { return send(res, 500, { error: e.message }); }
  }
  try { return reply(res, route(req, url)); } catch (e) { return send(res, 500, { error: e.message }); }
}

if (require.main === module) {
  http.createServer(handler).listen(PORT, HOST, () => console.log(`Claude factory dashboard on http://${HOST}:${PORT}`))
    .on('error', (e) => { console.error(e.message); process.exit(1); });
}
module.exports = { sessionUsage, snapshot, messageCost, handler };
