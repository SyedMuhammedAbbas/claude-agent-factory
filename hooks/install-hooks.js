#!/usr/bin/env node
'use strict';
// node install-hooks.js <settings.json> <deployed factory dir> [--remove]
// Idempotently (re)writes the factory's hook entries in a Claude Code settings.json; every other key and
// every other hook is kept. Output: 2-space JSON, LF, trailing newline.
const fs = require('fs');
const path = require('path');

const [file, factoryDir] = process.argv.slice(2);
const remove = process.argv.includes('--remove');
if (!file || !factoryDir) { console.error('usage: install-hooks.js <settings.json> <factory dir> [--remove]'); process.exit(2); }

const fwd = (p) => p.replace(/\\/g, '/');
const telemetry = `node "${fwd(path.join(factoryDir, 'telemetry.js'))}"`;
const gate = `node "${fwd(path.join(factoryDir, 'approval-gate.js'))}"`;
const ours = (h) => /factory\/(telemetry|approval-gate)\.js/.test(fwd(String(h.command || '')));

// Observer events only. Not registered: WorktreeCreate/WorktreeRemove (a hook replaces Claude Code's own
// git worktree handling), Elicitation/ElicitationResult (hooks answer MCP prompts), FileChanged (needs
// literal file names), Setup (only with --init), MessageDisplay/PostToolBatch/UserPromptExpansion/
// InstructionsLoaded/ConfigChange/DirectoryAdded/PreModelSwitch/TeammateIdle (duplicate or no signal).
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
const OTHER_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure',
  'PreCompact', 'PostCompact', 'TaskCreated', 'TaskCompleted', 'CwdChanged', 'PostModelSwitch'];

const raw = fs.readFileSync(file, 'utf8');
const s = JSON.parse(raw);
const hooks = s.hooks || {};
for (const ev of Object.keys(hooks)) {
  hooks[ev] = hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}
if (!remove) {
  const push = (ev, group) => { (hooks[ev] = hooks[ev] || []).push(group); };
  const async = { type: 'command', command: telemetry, async: true, timeout: 10 };
  for (const ev of TOOL_EVENTS) push(ev, { matcher: '*', hooks: [async] });
  for (const ev of OTHER_EVENTS) push(ev, { hooks: [async] });
  // SessionEnd runs synchronously: async work can be killed while the session exits. 5 s covers the git calls.
  push('SessionEnd', { hooks: [{ type: 'command', command: telemetry, timeout: 5 }] });
  // The gate must finish before the tool runs; a timeout or crash blocks the call instead of letting it through.
  push('PreToolUse', { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: gate, timeout: 60, onFailure: 'block' }] });
}
if (Object.keys(hooks).length) s.hooks = hooks; else delete s.hooks;
fs.writeFileSync(file, JSON.stringify(s, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
JSON.parse(fs.readFileSync(file, 'utf8')); // validate what was written
console.log(`${remove ? 'removed factory hooks from' : 'factory hooks written to'} ${file}`);
