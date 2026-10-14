'use strict';
// Board tab: the tickets agents are working on, one tab per project. Local data only, no Odoo calls:
// stages come from data/work-events.jsonl (written by work.js), "running" from the telemetry subagent events,
// and badges (branch, factory job, queue bucket) from local git refs and files.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DATA_DIR } = require('../lib');

const ROOT = path.join(__dirname, '..');
const BOARDS_FILE = path.join(ROOT, 'boards.json');
const JOBS_DIR = path.join(ROOT, 'jobs');
const TTL = 60 * 1000;

// ---------- boards.json (project name -> repos, integration branch) ----------

const readBoards = () => { try { return JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8')); } catch { return null; } };
const git = (repo, args) => new Promise((res) => execFile('git', ['-C', repo, ...args], { timeout: 10000, windowsHide: true, maxBuffer: 16 << 20 }, (err, out) => res(err ? null : out)));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- local badges ----------

function matchers(t) {
  const eme = [...new Set([...String(t.title).matchAll(/EME-(\d+)/gi)].map((m) => m[1]))];
  const branch = [], text = [];
  if (eme.length) { const r = `EME-(?:${eme.join('|')})(?!\\d)`; branch.push(r); text.push(r); }
  if (t.ticket) { const r = `ticket[\\s#_-]*${t.ticket}(?!\\d)`; branch.push(r); text.push(r); }
  if (t.id > 0) { // pipeline cards use a negative placeholder id; a positive id is an Odoo task id named in a branch or text
    branch.push(`(?<!\\d)${t.id}(?!\\d)`);
    text.push(`(?:odoo|project\\.task)[\\s#:/_-]*${t.id}(?!\\d)`);
  }
  const re = (parts) => (parts.length ? new RegExp(parts.join('|'), 'i') : /(?!)/);
  // loose also accepts "#371" (proposal titles, agent descriptions); not used on telemetry text where "#N" is often a PR
  return { branch: re(branch), text: re(text), loose: re(t.ticket ? [...text, `#${t.ticket}(?!\\d)`] : text), eme, ticket: t.ticket, id: t.id };
}

const refCache = new Map(); // repo -> { at, refs }
async function repoRefs(repo, integration) {
  const c = refCache.get(repo);
  if (c && Date.now() - c.at < TTL) return c.refs;
  const fmt = '%(refname:short)\t%(objectname)';
  const base = `origin/${integration}`;
  const [all, merged] = await Promise.all([
    git(repo, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes']),
    git(repo, ['for-each-ref', `--merged=${base}`, `--format=${fmt}`, 'refs/heads', 'refs/remotes']),
  ]);
  const repoName = path.basename(repo);
  const refs = [];
  if (all) {
    const mergedSet = merged == null ? null : new Set(merged.split('\n').map((l) => l.split('\t')[0]));
    const tip = (all.split('\n').map((l) => l.split('\t')).find((p) => p[0] === base) || [])[1];
    const byName = new Map();
    for (const l of all.split('\n')) {
      const [ref, sha] = l.split('\t');
      if (!ref || ref === 'origin' || ref.endsWith('/HEAD')) continue;
      const name = ref.replace(/^origin\//, '');
      if (name === integration || name === 'main' || name === 'master') continue;
      const prev = byName.get(name) || { name, repo: repoName, local: false, remote: false, merged: null, sha };
      if (ref.startsWith('origin/')) prev.remote = true; else prev.local = true;
      // a branch is merged when either of its refs is an ancestor of the integration branch; same tip = nothing to merge yet
      prev.merged = mergedSet ? (prev.merged || mergedSet.has(ref)) : null;
      prev.atTip = tip ? sha === tip : false;
      byName.set(name, prev);
    }
    refs.push(...byName.values());
  }
  refCache.set(repo, { at: Date.now(), refs });
  return refs;
}

let queueCache = { file: null, mtime: 0, map: new Map() };
function queueBuckets(file) {
  const map = new Map();
  if (!file) return map;
  let st;
  try { st = fs.statSync(file); } catch { return map; }
  if (queueCache.file === file && queueCache.mtime === st.mtimeMs) return queueCache.map;
  // shortcut: format of work-queue.md is not fixed yet; a bucket is the letter A-F in a "Bucket X"/"## X" heading
  // or a lone table cell, applied to every ticket/EME/Odoo id on the line. Tighten when the file format is settled.
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = /^#{1,4}\s*(?:bucket\s*)?([A-F])(?![A-Za-z0-9])/i.exec(line);
    if (h) { cur = h[1].toUpperCase(); continue; }
    if (/^#{1,4}\s/.test(line)) { cur = null; continue; }
    const cell = /\|\s*(?:bucket\s*)?([A-F])\s*\|/i.exec(line) || /\bbucket[\s:]*([A-F])\b/i.exec(line);
    const b = cell ? cell[1].toUpperCase() : cur;
    if (!b) continue;
    for (const m of line.matchAll(/(?:ticket\s*#?|#)(\d+)/gi)) map.set('t' + m[1], b);
    for (const m of line.matchAll(/EME-(\d+)/gi)) map.set('e' + m[1], b);
    for (const m of line.matchAll(/(?:odoo|task)[\s#:/_-]*(\d{4,})/gi)) map.set('o' + m[1], b);
  }
  queueCache = { file, mtime: st.mtimeMs, map };
  return map;
}

function readJobs() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(JOBS_DIR); } catch { return out; }
  for (const d of dirs) {
    try { const raw = fs.readFileSync(path.join(JOBS_DIR, d, 'job.json'), 'utf8'); const j = JSON.parse(raw); out.push({ id: j.id || d, stage: j.stage, round: j.round, raw, branches: [].concat(j.branch || []) }); } catch { /* not a job */ }
  }
  return out;
}

async function badges(b, tasks) {
  const refs = (await Promise.all((b.repos || []).filter((r) => fs.existsSync(r)).map((r) => repoRefs(r, b.integration || 'main')))).flat();
  const jobs = readJobs();
  const queue = queueBuckets(b.queue);
  const out = new Map();
  for (const t of tasks) {
    const m = matchers(t);
    const bd = {};
    const hit = refs.filter((r) => m.branch.test(r.name));
    if (hit.length) bd.branches = hit.map((r) => ({ name: r.name, repo: r.repo, local: r.local, remote: r.remote, merged: r.merged, atTip: r.atTip }));
    const names = hit.map((r) => r.name);
    const job = jobs.find((j) => m.text.test(j.raw) || j.branches.some((n) => names.includes(String(n).replace(/^origin\//, ''))));
    if (job) bd.job = { id: job.id, stage: job.stage, round: job.round };
    const q = (m.ticket && queue.get('t' + m.ticket)) || m.eme.map((n) => queue.get('e' + n)).find(Boolean);
    if (q) bd.bucket = q;
    if (Object.keys(bd).length) out.set(t.id, bd);
  }
  return out;
}

// ---------- Pipeline: our own stages, from data/work-events.jsonl ----------
// Agents and the coordinator append lines (see work.js); the latest line per (project, ticket) sets the stage.

const WORK_FILE = process.env.FACTORY_WORK_EVENTS || path.join(DATA_DIR, 'work-events.jsonl');
const PENDING_FILE = path.join(process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || '', 'hermes'), 'state', 'agent_ops', 'pending.json');
const STAGES = [
  ['queued', 'Queued'], ['building', 'Building'], ['review', 'Code review'], ['qa', 'QA (device/web)'], ['fix-needed', 'Fix needed'],
  ['evidence-pending', 'Evidence awaiting approval (Discord)'], ['done', 'Done'], ['blocked', 'Blocked / needs owner'],
];
const STAGE_IDS = new Set(STAGES.map((s) => s[0]));
const WORKING = new Set(['building', 'review', 'qa', 'fix-needed']);
const WORK_ACTIVE_MS = 30 * 60 * 1000;
const STALE_MS = 24 * 3600 * 1000; // a ticket with no work line for this long, and no running agent, leaves the board
const FINISHED_LIMIT = 50;
const str = (v, n) => (v == null ? '' : String(v).slice(0, n));
const ticketKey = (t) => String(t).trim().replace(/^(ticket)?#/i, '').toUpperCase();

let workCache = { size: -1, mtime: 0, list: [] };
function workEvents() {
  let st;
  try { st = fs.statSync(WORK_FILE); } catch { return []; }
  if (workCache.size === st.size && workCache.mtime === st.mtimeMs) return workCache.list;
  const list = [];
  for (const l of fs.readFileSync(WORK_FILE, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; } // tolerant: a torn or hand-edited line is skipped
    if (!o || typeof o !== 'object') continue;
    const stage = str(o.stage, 30).toLowerCase(), project = str(o.project, 80).trim(), ticket = o.ticket == null ? '' : ticketKey(str(o.ticket, 40));
    if (!STAGE_IDS.has(stage) || !project || !ticket || !(Date.parse(o.ts) > 0)) continue;
    list.push({ ts: o.ts, project, ticket, stage, agent: str(o.agent, 80), note: str(o.note, 500), pr: /^https?:\/\//.test(o.pr) ? str(o.pr, 300) : '', proposal: o.proposal == null || o.proposal === '' ? '' : str(o.proposal, 20) });
  }
  list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)); // stable: equal timestamps keep file order
  workCache = { size: st.size, mtime: st.mtimeMs, list };
  return list;
}

function appendWork(o) {
  fs.mkdirSync(path.dirname(WORK_FILE), { recursive: true });
  fs.appendFileSync(WORK_FILE, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');
}

// Subagents started and not yet stopped (telemetry), with the Agent-call description and model from the subagent's meta file.
function runningAgents(deps) {
  const now = Date.now(), open = new Map(), ended = new Map();
  for (const e of deps.loadEvents(2)) {
    if (e.event === 'SessionEnd') ended.set(e.session_id, e.ts);
    else if (e.event === 'SubagentStart') open.set(e.agent_id, e);
    else if (e.event === 'SubagentStop') open.delete(e.agent_id);
  }
  const out = [];
  for (const a of open.values()) {
    if (now - Date.parse(a.ts) > 12 * 3600 * 1000 || (ended.get(a.session_id) || '') > a.ts) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(a.transcript_path.replace(/\.jsonl$/, ''), 'subagents', `agent-${a.agent_id}.meta.json`), 'utf8')); } catch { /* no meta: type only */ }
    out.push({ type: meta.agentType || a.agent_type || 'agent', model: meta.model || null, since: a.ts, description: String(meta.description || '') });
  }
  return out;
}

function readPending() { // null when unreadable, so a bad read is never mistaken for "approved"
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    if (!Array.isArray(p)) return null;
    return p.map((x) => ({ n: String(x.n), title: [x.title, x.identifier].filter(Boolean).join(' '), tasks: (x.actions || []).map((a) => a.task).filter(Boolean) }));
  } catch { return null; }
}

const isEme = (t) => /^EME-\d+$/i.test(t);
const pseudo = (ticket, i) => ({ id: -(i + 1), title: isEme(ticket) ? ticket : '', ticket: /^\d+$/.test(ticket) ? Number(ticket) : null });
const last = (g) => g.events[g.events.length - 1];

// The project's work events grouped by ticket, in first-seen order.
function groupsFor(name) {
  const groups = new Map(), key = norm(name);
  for (const e of workEvents()) {
    if (norm(e.project) !== key) continue;
    const g = groups.get(e.ticket) || { ticket: e.ticket, events: [] };
    g.events.push(e);
    groups.set(e.ticket, g);
  }
  return groups;
}

// A ticket is in progress unless its latest line is "done", or it has been quiet for STALE_MS with no agent running on it.
const finished = (l, run, now) => l.stage === 'done' || (!run && now - Date.parse(l.ts) > STALE_MS);
// The running subagent whose Agent-call description names the ticket, if any.
const runFor = (g, i, agents) => (!['done', 'blocked'].includes(last(g).stage) && agents.find((a) => a.description && matchers(pseudo(g.ticket, i)).loose.test(a.description))) || null;

async function pipelineApi(deps, b) {
  const now = Date.now();
  const groups = groupsFor(b.name);
  const list = [...groups.values()];

  // Hermes proposals: a pending one moves its ticket to Evidence; one that left pending after approval moves it to Done
  const pending = readPending();
  if (pending) {
    const live = new Set(pending.map((x) => x.n));
    for (const g of list) {
      const l = last(g);
      if (l.stage === 'evidence-pending' && l.proposal && !live.has(l.proposal) && now - Date.parse(l.ts) > 2 * 60 * 1000) {
        const e = { ts: new Date().toISOString(), project: b.name, ticket: g.ticket, stage: 'done', agent: 'dashboard', note: `Hermes proposal ${l.proposal} is no longer pending (approved or dismissed)`, pr: '', proposal: l.proposal };
        appendWork(e); g.events.push(e);
      }
    }
    for (const pr of pending) {
      const hit = list.filter((g, i) => matchers(pseudo(g.ticket, i)).loose.test(pr.title));
      if (!hit.length || hit.length > 3) continue; // a bulk proposal naming many tickets is not evidence for any one
      for (const g of hit) {
        if (g.events.some((e) => e.proposal === pr.n) || last(g).stage === 'done') continue;
        const e = { ts: new Date().toISOString(), project: b.name, ticket: g.ticket, stage: 'evidence-pending', agent: 'dashboard', note: `Hermes proposal ${pr.n} waiting: ${pr.title}`.slice(0, 300), pr: '', proposal: pr.n };
        appendWork(e); g.events.push(e);
      }
    }
  }

  const agents = runningAgents(deps);
  const cards = list.map((g, i) => {
    const l = last(g), run = runFor(g, i, agents);
    const lastWith = (k) => [...g.events].reverse().find((e) => e[k]);
    return {
      i, ticket: g.ticket, title: (lastWith('note') || {}).note || '', stage: l.stage, since: l.ts,
      agent: run ? `${run.type}${run.model ? ` (${run.model})` : ''}` : l.agent, running: run ? { since: run.since } : null,
      activeNow: !!(run || (WORKING.has(l.stage) && now - Date.parse(l.ts) < WORK_ACTIVE_MS)),
      pr: (lastWith('pr') || {}).pr || '', proposal: (lastWith('proposal') || {}).proposal || '',
      finished: finished(l, run, now), events: g.events.slice(-50).reverse(),
    };
  });
  const open = cards.filter((c) => !c.finished);
  const bd = await badges(b, open.map((c) => pseudo(c.ticket, c.i)));
  const stages = STAGES.filter(([id]) => id !== 'done').map(([id, name]) => ({ id, name, cards: [] }));
  for (const c of open) {
    c.badges = bd.get(-(c.i + 1)) || null;
    stages.find((s) => s.id === c.stage).cards.push(c);
  }
  for (const s of stages) s.cards.sort((a, c) => (c.activeNow - a.activeNow) || (Date.parse(c.since) - Date.parse(a.since)));
  const done = cards.filter((c) => c.finished).sort((a, c) => Date.parse(c.since) - Date.parse(a.since));
  return [200, {
    board: { id: b.id, name: b.name, integration: b.integration || 'main' }, stages, generated: new Date().toISOString(),
    tickets: open.length, finished: done.slice(0, FINISHED_LIMIT).map(({ ticket, title, stage, since, agent }) => ({ ticket, title, stage, since, agent })), finishedCount: done.length,
  }];
}

// ---------- API ----------

// boards.json entries plus any project that appears only in work-events.jsonl (keyed by its normalised name).
function boardList() {
  const boards = ((readBoards() || {}).boards || []).filter((b) => b && b.name);
  const seen = new Set(boards.map((b) => norm(b.name)));
  for (const e of workEvents()) {
    const k = norm(e.project);
    if (!seen.has(k)) { seen.add(k); boards.push({ id: k, name: e.project, repos: [], integration: 'main' }); }
  }
  return boards;
}

function boardsApi(deps) {
  const now = Date.now(), agents = runningAgents(deps);
  return [200, {
    boards: boardList().map((b) => ({ id: b.id, name: b.name, open: [...groupsFor(b.name).values()].filter((g, i) => !finished(last(g), runFor(g, i, agents), now)).length })),
  }];
}

function boardApi(url, deps) {
  const id = String(url.searchParams.get('id') || '');
  const b = boardList().find((x) => String(x.id) === id);
  if (!b) return [404, { error: 'unknown board' }];
  return pipelineApi(deps, b);
}

// Returns a promise of [status, body] for a board route, or null when the path is not one of ours.
function handle(method, url, deps) {
  if (method !== 'GET') return null;
  if (url.pathname === '/api/boards') return Promise.resolve().then(() => boardsApi(deps));
  if (url.pathname === '/api/board') return Promise.resolve().then(() => boardApi(url, deps));
  return null;
}

module.exports = { handle, matchers, queueBuckets, workEvents, STAGES, STALE_MS };
