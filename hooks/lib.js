'use strict';
// Helpers shared by telemetry.js, approval-gate.js and dashboard/server.js. Zero dependencies.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// Walk up from dir to the git toplevel without spawning git. A linked worktree's `.git` is a file
// pointing into the main repo's .git/worktrees, so the project is named after the main repo.
function gitInfo(dir) {
  let d = dir ? path.resolve(dir) : '';
  for (let i = 0; d && i < 40; i++) {
    const g = path.join(d, '.git');
    let st;
    try { st = fs.statSync(g); } catch { st = null; }
    if (st) {
      let project = path.basename(d);
      if (st.isFile()) {
        try {
          const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
          const wt = m && /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(m[1].trim());
          if (wt) project = path.basename(wt[1]);
        } catch { /* keep the dir name */ }
      }
      return { root: d, project };
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { root: null, project: dir ? path.basename(path.resolve(dir)) : '' };
}

function localDate(t = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

module.exports = { DATA_DIR, gitInfo, localDate };
