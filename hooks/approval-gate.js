#!/usr/bin/env node
'use strict';
// PreToolUse approval gate (Bash|PowerShell). Protected commands (protected.json) need the owner's
// `approve N` in Discord through Hermes. Approval is read only from Hermes's own state, never from a
// file the session writes. Fail safe: if Hermes is unreachable or anything errors, fall back to the
// native Claude Code prompt ("ask"); never allow on error. Non-protected commands: no output, no decision.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DATA_DIR, gitInfo } = require('./lib');

const HERMES_HOME = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes');
const STATE_DIR = path.join(HERMES_HOME, 'state', 'agent_ops');
const PYTHON = path.join(HERMES_HOME, 'hermes-agent', 'venv', 'Scripts', 'python.exe');
const AGENT_OPS = path.join(HERMES_HOME, 'scripts', 'agent_ops.py');
const APPROVAL_TTL_MS = 24 * 3600 * 1000;
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'protected.json'), 'utf8'));
const BRANCHES = CFG.protectedBranches;
const WIN = process.platform === 'win32';

// ---------- parsing ----------

// Split at ; & | and newlines outside quotes. Good enough for a tripwire; not a shell parser.
function splitSegments(cmd) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
      if (c === q) q = null;
      cur += c;
    } else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === '\\' && i + 1 < cmd.length && cmd[i + 1] !== '\n') { cur += c + cmd[++i]; }
    else if (c === ';' || c === '&' || c === '|' || c === '\n') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function tokenize(seg) {
  const toks = seg.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) || [];
  return toks.map((t) => t.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, a, b) => (a !== undefined ? a.replace(/\\(.)/g, '$1') : b)));
}

const SHELLS = /^(bash|sh|zsh|dash|pwsh|powershell)(\.exe)?$/i;
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env', 'builtin']);

// -> [{ tokens, dir }] with wrappers, env assignments and git global options removed; nested `bash -c "..."` expanded.
function segments(cmd, cwd, depth = 0) {
  const res = [];
  for (const seg of splitSegments(cmd)) {
    let t = tokenize(seg);
    while (t.length && (WRAPPERS.has(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || t[0] === '&' || t[0] === '.')) t = t.slice(1);
    if (t[0] && t[0].startsWith('(')) t[0] = t[0].slice(1);
    if (!t.length) continue;
    if (/^(cd|pushd|Set-Location|sl)$/i.test(t[0]) && t[1]) { cwd = path.resolve(cwd || '.', toNative(t[t.length - 1])); continue; }
    if (SHELLS.test(t[0]) && depth < 3) {
      const ci = t.findIndex((x, i) => i > 0 && /^(-c|-Command|-command|\/c)$/.test(x));
      if (ci > 0 && t[ci + 1]) { res.push(...segments(t.slice(ci + 1).join(' '), cwd, depth + 1)); continue; }
    }
    if (t[0] === 'eval' && depth < 3) { res.push(...segments(t.slice(1).join(' '), cwd, depth + 1)); continue; }
    let dir = cwd;
    if (/^git(\.exe)?$/i.test(t[0])) {
      const g = ['git'];
      let i = 1;
      for (; i < t.length && t[i].startsWith('-'); i++) {
        if (t[i] === '-C') { dir = path.resolve(dir || '.', toNative(t[++i] || '.')); }
        else if (['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(t[i])) i++;
      }
      t = g.concat(t.slice(i));
    }
    res.push({ tokens: t, dir });
  }
  return res;
}

function toNative(p) {
  if (WIN) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:${m[2] || '/'}`;
    const c = /^\/cygdrive\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (c) return `${c[1].toUpperCase()}:${c[2] || '/'}`;
  }
  return p;
}

// ---------- context checks ----------

function currentBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return undefined; }
}

const VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function pushHitsProtected(t, dir) {
  if (t[0] !== 'git' || t[1] !== 'push') return false;
  const pos = [];
  for (let i = 2; i < t.length; i++) {
    if (VALUE_FLAGS.has(t[i])) { i++; continue; }
    if (t[i] === '--all' || t[i] === '--mirror' || t[i] === '--branches') return true;
    if (!t[i].startsWith('-')) pos.push(t[i]);
  }
  if (pos.length < 2) {
    if (t.includes('--tags')) return false;
    return BRANCHES.includes(currentBranch(dir)); // `git push [remote]` pushes the current branch
  }
  return pos.slice(1).some((r) => {
    let dst = r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
    if (dst === 'HEAD' || dst === '@') dst = currentBranch(dir);
    return BRANCHES.includes(dst);
  });
}

function mergeOnProtected(t, dir) {
  if (t[0] !== 'git' || t[1] !== 'merge') return false;
  if (t.some((x) => ['--abort', '--continue', '--quit', '--skip'].includes(x))) return false;
  return BRANCHES.includes(currentBranch(dir));
}

function kubectlRemote(t, dir) {
  if (!/^kubectl(\.exe)?$/i.test(t[0])) return false;
  const sub = t.slice(1).find((x) => !x.startsWith('-'));
  if (sub !== 'delete' && sub !== 'apply') return false;
  let ctx;
  const ci = t.findIndex((x) => x === '--context' || x.startsWith('--context='));
  if (ci > 0) ctx = t[ci].includes('=') ? t[ci].split('=')[1] : t[ci + 1];
  if (!ctx) {
    try {
      ctx = execFileSync('kubectl', ['config', 'current-context'], { cwd: dir, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch { ctx = undefined; }
  }
  if (!ctx) return true; // unknown context: treat as remote
  return !CFG.localKubeContexts.some((re) => new RegExp(`^(${re})$`).test(ctx));
}

const norm = (p) => { const r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''); return WIN ? r.toLowerCase() : r; };
const inside = (p, root) => p.startsWith(root + '/');

// Allowed: strictly inside the session cwd's repo, or (cwd not a repo, e.g. a multi-repo workspace) strictly
// inside a repo that lives under the cwd, or inside a temp/scratch dir. Everything else, and any repo root itself, is protected.
function rmOutsideRepo(t, dir, cwd0) {
  const cmd = t[0];
  let recursive = false;
  if (/^(rm|rm\.exe)$/i.test(cmd)) recursive = t.some((x) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(x) || x === '--recursive' || /^-recurse$/i.test(x));
  else if (/^(Remove-Item|ri|rmdir|rd|del|erase)$/i.test(cmd)) recursive = t.some((x) => /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(x));
  if (!recursive) return false;
  const base = dir || cwd0 || process.cwd();
  const sessionRoot = gitInfo(cwd0 || base).root;
  const temps = [norm(os.tmpdir()), ...[process.env.TEMP, process.env.TMP, ...CFG.scratchDirs].filter(Boolean).map((d) => norm(toNative(d)))];
  const targets = t.slice(1).filter((x) => !x.startsWith('-'));
  if (!targets.length) return false;
  return targets.some((raw) => {
    let p = raw.replace(/^~(?=\/|\\|$)/, os.homedir())
      .replace(/\$\{?(HOME|USERPROFILE)\}?|\$env:USERPROFILE/gi, os.homedir())
      .replace(/\$\{?(TMPDIR|TEMP|TMP)\}?|\$env:(TEMP|TMP)/gi, os.tmpdir());
    if (/[$`]/.test(p)) return true; // unresolvable expansion: protect
    const g = p.search(/[*?[]/);
    if (g >= 0) p = p.slice(0, g).replace(/[^/\\]*$/, '') || '.';
    const abs = norm(path.resolve(base, toNative(p)));
    if (temps.some((a) => inside(abs, a))) return false;
    if (sessionRoot) return !inside(abs, norm(sessionRoot));
    const own = gitInfo(abs).root; // the target's repo must sit under the (non-repo) cwd
    return !(own && inside(abs, norm(own)) && (norm(own) === norm(cwd0) || inside(norm(own), norm(cwd0))));
  });
}

const CHECKS = {
  push_protected_branch: { name: 'push to protected branch', fn: pushHitsProtected },
  merge_on_protected_branch: { name: 'merge on protected branch', fn: mergeOnProtected },
  kubectl_remote_context: { name: 'kubectl delete/apply on non-local context', fn: kubectlRemote },
  rm_outside_repo: { name: 'recursive delete outside repo/temp', fn: rmOutsideRepo },
};

const RULES = CFG.rules.map((r) => ({
  name: r.name,
  scope: r.command ? 'command' : 'segment',
  re: new RegExp((r.command || r.segment).replace(/\{branches\}/g, BRANCHES.join('|')), r.flags || ''),
}));

// -> rule name or null
function classify(command, cwd) {
  for (const r of RULES) if (r.scope === 'command' && r.re.test(command)) return r.name;
  for (const s of segments(command, cwd)) {
    const line = s.tokens.join(' ');
    for (const r of RULES) if (r.scope === 'segment' && r.re.test(line)) return r.name;
    for (const id of CFG.checks) if (CHECKS[id] && CHECKS[id].fn(s.tokens, s.dir, cwd)) return CHECKS[id].name;
  }
  return null;
}

// ---------- Hermes ----------

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

function hermesAvailable() {
  if (!fs.existsSync(PYTHON) || !fs.existsSync(AGENT_OPS)) return false;
  const pid = readJson(path.join(HERMES_HOME, 'gateway.pid'), {}).pid;
  try { process.kill(pid, 0); } catch { return false; }
  const jobs = readJson(path.join(HERMES_HOME, 'cron', 'jobs.json'), {});
  return (Array.isArray(jobs) ? jobs : jobs.jobs || []).some((j) => j.name === 'agent-proposals' && j.enabled);
}

function pendingNumber(key) {
  const p = readJson(path.join(STATE_DIR, 'pending.json'), []).find((it) => (it.actions || []).some((a) => a.type === 'claude_action' && a.key === key));
  return p && p.n;
}

function redact(cmd) {
  return cmd
    .replace(/\b([A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PWD|KEY|CREDENTIALS?)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=***')
    .replace(/(--?(token|password|secret|api-key|apikey|key|auth)[= ])("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@')
    .replace(/\b(Bearer\s+)\S+/gi, '$1***');
}

function propose(fields) {
  const dir = path.join(DATA_DIR, 'gate-proposals');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${fields.key.slice(0, 16)}.json`);
  fs.writeFileSync(f, JSON.stringify({ title: fields.title, actions: [{ type: 'claude_action', ...fields, title: undefined }] }));
  execFileSync(PYTHON, [AGENT_OPS, 'propose', '--file', f], {
    timeout: 30000, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

// ---------- hook ----------

function decide(h) {
  if (!['Bash', 'PowerShell'].includes(h.tool_name)) return null;
  const command = String((h.tool_input || {}).command || '');
  const cwd = h.cwd || process.cwd();
  const rule = classify(command, cwd);
  if (!rule) return null;
  const key = crypto.createHash('sha256').update(`${norm(cwd)}\n${command.trim().replace(/\s+/g, ' ')}`).digest('hex');
  const log = { rule, key, session_id: h.session_id, cwd, project: gitInfo(cwd).project, command: redact(command).slice(0, 200) };

  const approvalsFile = path.join(STATE_DIR, 'claude_approvals.json');
  const rec = readJson(approvalsFile, {})[key];
  const fresh = rec && Date.now() - Date.parse(rec.at) < APPROVAL_TTL_MS;
  if (fresh && rec.status === 'approved' && !rec.consumed_at) {
    const all = readJson(approvalsFile, {}); // re-read just before writing to keep Hermes's latest entries
    all[key] = { ...all[key], consumed_at: new Date().toISOString(), consumed_by: h.session_id };
    fs.writeFileSync(approvalsFile, JSON.stringify(all, null, 2));
    return { ...log, n: rec.n, decision: 'allow', reason: `Protected action (${rule}) approved in Discord as #${rec.n}; this approval is now used up.` };
  }
  if (fresh && rec.status === 'rejected') {
    return { ...log, n: rec.n, decision: 'deny', reason: `Protected action (${rule}). The owner rejected approval #${rec.n} in Discord. Do not retry; ask the owner how to proceed.` };
  }
  if (!hermesAvailable()) {
    return { ...log, decision: 'ask', reason: `Protected action (${rule}). Hermes is not reachable, so confirm it here.` };
  }
  let n = pendingNumber(key);
  if (!n) {
    propose({ title: `Claude Code: ${rule} in ${log.project}`, command: redact(command).slice(0, 1000), cwd, project: log.project, session_id: h.session_id, key, rule });
    n = pendingNumber(key);
  }
  if (!n) return { ...log, decision: 'ask', reason: `Protected action (${rule}). The approval request could not be queued in Hermes, so confirm it here.` };
  return { ...log, n, decision: 'deny', reason: `Protected action. Approval #${n} requested in Discord (reply \`approve ${n}\`). Re-run the same command after approval.` };
}

function main() {
  let h = {};
  let d;
  try {
    h = JSON.parse(fs.readFileSync(0, 'utf8'));
    d = decide(h);
  } catch (e) {
    d = { decision: 'ask', reason: `Approval gate error (${String(e && e.message).slice(0, 120)}); confirm it here.`, session_id: h.session_id };
  }
  if (!d) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'gate-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...d }) + '\n');
  } catch { /* logging is best effort */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason },
  }));
}

if (require.main === module) main();
module.exports = { classify, redact, splitSegments };
