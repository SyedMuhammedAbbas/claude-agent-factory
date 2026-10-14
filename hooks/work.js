#!/usr/bin/env node
'use strict';
// Appends one line to data/work-events.jsonl, the file behind the dashboard Board tab. Zero dependencies.
//   node work.js <project> <ticket> <stage> [--agent "engineer (sonnet)"] [--note "text"] [--pr URL] [--proposal N]
// stage: queued | building | review | qa | fix-needed | evidence-pending | done | blocked
// The latest line per (project, ticket) decides the column; the file is append-only, never edit it.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./lib');

const STAGES = ['queued', 'building', 'review', 'qa', 'fix-needed', 'evidence-pending', 'done', 'blocked'];
const FILE = process.env.FACTORY_WORK_EVENTS || path.join(DATA_DIR, 'work-events.jsonl');

function build(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(agent|note|pr|proposal)$/.exec(argv[i]);
    if (m) { if (i + 1 >= argv.length) throw new Error(`--${m[1]} needs a value`); opt[m[1]] = argv[++i]; } else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    else pos.push(argv[i]);
  }
  if (pos.length !== 3) throw new Error('usage: node work.js <project> <ticket> <stage> [--agent X] [--note "..."] [--pr URL] [--proposal N]');
  const [project, ticketRaw, stage] = pos;
  if (!STAGES.includes(stage)) throw new Error(`stage must be one of: ${STAGES.join(', ')}`);
  const ticket = ticketRaw.replace(/^(ticket)?#/i, '');
  if (!ticket) throw new Error('ticket is empty');
  if (opt.pr && !/^https?:\/\//.test(opt.pr)) throw new Error('--pr must be an http(s) URL');
  const o = { ts: new Date().toISOString(), project, ticket, stage };
  for (const k of ['agent', 'note', 'pr', 'proposal']) if (opt[k]) o[k] = opt[k];
  return o;
}

if (require.main === module) {
  try {
    const line = build(process.argv.slice(2));
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(line) + '\n');
    console.log(JSON.stringify(line));
  } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { build, STAGES };
