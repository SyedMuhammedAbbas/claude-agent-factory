'use strict';
// node hooks/test/gate.test.js  — rule checks for approval-gate.js (no Hermes calls).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { classify, redact } = require('../approval-gate');

function repo(branch) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q', '-b', branch);
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  return d;
}
const feature = repo('task/X-1');
const staging = repo('staging');
// a cwd outside temp, so the temp-dir allowance does not hide rm checks
const here = path.resolve(__dirname, '..', '..'); // this repo
// a non-repo folder that holds a repo, outside temp (temp paths are always allowed); removed at the end
const workspace = path.join(os.tmpdir(), '..', `factory-gate-workspace-${process.pid}`);
fs.mkdirSync(path.join(workspace, 'web-app'), { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: path.join(workspace, 'web-app'), stdio: 'ignore' });
const home = os.homedir();

const protectedCases = [
  ['git push origin staging', feature],
  ['git push origin HEAD:main', feature],
  ['git push -f origin task/X-1', feature],
  ['git push --force-with-lease origin task/X-1', feature],
  ['git push origin +task/X-1', feature],
  ['git push', staging],
  ['git push origin', staging],
  ['git merge task/X-1', staging],
  ['gh pr merge 12', feature],
  ['gh pr merge 12 --squash', feature],
  ['gcloud run deploy api --region me-central1', feature],
  ['gcloud run jobs execute neurax-migrate', feature],
  ['gcloud builds submit .', feature],
  ['npx vercel --prod', feature],
  ['firebase deploy', feature],
  ['terraform apply -auto-approve', feature],
  ['terraform -chdir=infra destroy', feature],
  ['psql "$DATABASE_URL" -c "DROP TABLE users;"', feature],
  ['git branch -D staging', feature],
  ['git reset --hard origin/main', feature],
  ['rm -rf /c/Users', here],
  ['rm -rf C:/Users/x', here],
  ['rm -rf ~', here],
  ['rm -rf .', here],
  ['rm -rf "$SOMEVAR/x"', here],
  ['cd /c && rm -rf Windows', here],
  ['rm -rf web-app', workspace],
  ['rm -rf .cache/x', home],
  ['bash -c "git push origin main"', feature],
  ['git -C ' + staging.replace(/\\/g, '/') + ' push', feature],
  ['Remove-Item -Recurse -Force C:\\Users\\x', here],
];
const allowedCases = [
  ['git push origin task/X-1', feature],
  ['git push -u origin task/X-1', feature],
  ['git push --follow-tags origin task/X-1', feature],
  ['git push', feature],
  ['git commit -m "fix main; push to staging later"', feature],
  ['git commit -am "merge main into feature"', staging],
  ['pnpm test', feature],
  ['git merge staging', feature],
  ['git merge --abort', staging],
  ['git pull origin main', feature],
  ['rm -rf node_modules', here],
  ['rm -rf ./dist/*', here],
  ['rm -rf ' + path.join(os.tmpdir(), 'x').replace(/\\/g, '/'), here],
  ['rm file.txt', here],
  ['rm -rf web-app/build', workspace],
  ['gh pr list', feature],
  ['gh pr create --base staging', feature],
  ['gcloud run services list', feature],
  ['vercel', feature],
  ['terraform plan', feature],
  ['git branch -D task/old', feature],
  ['git reset --hard HEAD~1', feature],
  ['psql -c "select 1"', feature],
  ['echo "git push origin main"', feature],
  ['git log main..staging', feature],
];

let fail = 0;
for (const [cmd, cwd] of protectedCases) {
  const r = classify(cmd, cwd);
  if (!r) { fail++; console.log('MISSED   ', cmd); } else console.log('protected', JSON.stringify(cmd), '->', r);
}
for (const [cmd, cwd] of allowedCases) {
  const r = classify(cmd, cwd);
  if (r) { fail++; console.log('FALSE HIT', cmd, '->', r); } else console.log('pass     ', JSON.stringify(cmd));
}
assert.strictEqual(redact('PGPASSWORD=hunter2 psql -c "x"'), 'PGPASSWORD=*** psql -c "x"');
assert.strictEqual(redact('psql postgres://u:pw@h/db'), 'psql postgres://***@h/db');
for (const d of [feature, staging, workspace]) fs.rmSync(d, { recursive: true, force: true });
assert.strictEqual(fail, 0, `${fail} gate rule failures`);
console.log(`gate rules OK (${protectedCases.length} protected, ${allowedCases.length} allowed)`);
