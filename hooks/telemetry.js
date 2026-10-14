#!/usr/bin/env node
'use strict';
// Claude Code telemetry hook: appends one compact JSON line per hook event to data/events-YYYY-MM-DD.jsonl.
// Never prints (stdout becomes model context on SessionStart/UserPromptSubmit), always exits 0, no AI calls.
// Tokens, models and cost are NOT measured here: the dashboard reads them from the transcripts.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DATA_DIR, gitInfo, localDate } = require('./lib');

const cut = (s, n) => (s == null ? undefined : String(s).slice(0, n));

function toolSummary(name, inp) {
  if (!inp || typeof inp !== 'object') return undefined;
  if (name === 'Bash' || name === 'PowerShell') return cut(inp.command, 200);
  if (inp.file_path || inp.notebook_path) return cut(inp.file_path || inp.notebook_path, 300);
  if (name === 'Agent' || name === 'Task') return cut(`${inp.subagent_type || 'general-purpose'}: ${inp.description || ''}`, 200);
  if (name === 'Grep' || name === 'Glob') return cut(`${inp.pattern || ''}${inp.path ? ' in ' + inp.path : ''}`, 200);
  if (name === 'WebFetch') return cut(inp.url, 200);
  if (name === 'WebSearch') return cut(inp.query, 200);
  if (name === 'Skill') return cut(inp.skill, 100);
  return undefined; // other tools: name only, never their payloads
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return undefined; }
}

function record(h) {
  const ev = h.hook_event_name;
  const cwd = h.cwd;
  const gi = gitInfo(cwd);
  const o = {
    ts: new Date().toISOString(),
    event: ev,
    session_id: h.session_id,
    transcript_path: h.transcript_path,
    cwd,
    project: gi.project || undefined,
    repo: gi.root || undefined,
    agent_id: h.agent_id,
    agent_type: h.agent_type,
  };
  if (h.tool_name) {
    o.tool_name = h.tool_name;
    o.tool = toolSummary(h.tool_name, h.tool_input);
  }
  switch (ev) {
    case 'SessionStart': o.source = h.source; o.model = h.model; o.title = cut(h.session_title, 120); break;
    case 'SessionEnd': o.reason = h.reason; break;
    case 'UserPromptSubmit': o.prompt = cut(h.prompt, 120); o.permission_mode = h.permission_mode; break;
    case 'PostToolUseFailure': o.error = true; o.error_text = cut(h.error, 300); o.interrupted = h.is_interrupt; break;
    case 'StopFailure': o.error = true; o.error_text = cut(`${h.error || ''} ${h.error_details || ''}`.trim(), 300); break;
    case 'Notification': o.message = cut(h.message, 300); o.notification_type = h.notification_type; break;
    case 'PermissionRequest': o.notification_type = 'permission_request'; break;
    case 'PermissionDenied': o.reason = cut(h.reason, 300); break;
    case 'SubagentStop': o.agent_transcript_path = h.agent_transcript_path; break;
    case 'PreCompact': case 'PostCompact': o.trigger = h.trigger; break;
    case 'TaskCreated': case 'TaskCompleted': o.task_id = h.task_id; o.task = cut(h.task_subject, 120); break;
    case 'PostModelSwitch': o.model = h.model; break;
  }
  if ((ev === 'Stop' || ev === 'SubagentStop' || ev === 'SessionEnd') && gi.root) {
    o.branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    o.diff = git(cwd, ['diff', '--shortstat']) || undefined;
    o.diff_cached = git(cwd, ['diff', '--cached', '--shortstat']) || undefined;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, `events-${localDate()}.jsonl`), JSON.stringify(o) + '\n');
}

try {
  record(JSON.parse(fs.readFileSync(0, 'utf8')));
} catch (e) {
  try { fs.appendFileSync(path.join(DATA_DIR, 'telemetry-errors.log'), `${new Date().toISOString()} ${e && e.message}\n`); } catch { /* never fail the session */ }
}
process.exitCode = 0;
