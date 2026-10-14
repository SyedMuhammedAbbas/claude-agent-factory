# Agent Factory for Claude Code

A chat-first software factory built only from native Claude Code parts: one set of global rules, five subagents, one optional `/factory` skill, and two hooks (telemetry and an approval gate) with a local dashboard.

There is no orchestrator service, no LLM router, no mandatory ticket or command. You talk to the main Claude Code session. It reads the project, decides whether to do the work itself or delegate parts of it, runs the project's own checks, and reports back. Agents are spawned only when they save context or add an independent view.

```
CLAUDE.global.md              global working rules (merge into ~/.claude/CLAUDE.md)
.claude/
  agents/                     engineer, code-reviewer, qa, docs, security-reviewer
  skills/factory/SKILL.md     optional /factory workflow for large multi-part features
hooks/
  telemetry.js                async hook: one JSON line per Claude Code event
  approval-gate.js            PreToolUse gate for protected shell commands
  protected.json              what counts as protected (branches, deploys, destructive ops)
  pricing.json                list prices used for the dashboard's cost estimate
  work.js                     appends a ticket stage change to the Board
  install-hooks.js            merges the hook entries into a settings.json
  boards.example.json         projects, repos and integration branch for the Board
  dashboard/                  local dashboard on http://127.0.0.1:7777
  test/                       node tests for the gate, board, server and usage parser
install.ps1                   installs everything into the current user's Claude Code
```

## How it works

Every request goes through the same four steps in the main session:

1. **Detect** the project and repo from the working directory. Read its `CLAUDE.md` / `AGENTS.md` and only the files and diffs the request touches.
2. **Understand** the request and the current state (git status, recent commits, existing docs) and continue from there.
3. **Decide**: do it directly, or delegate only the parts that need a specialist.
4. **Execute, validate, report**: run the checks, quote the result lines, report in the session.

### Routing

| Request | Who |
|---|---|
| Question, explanation, small fix, config, one or two files | Main session, no agents |
| Multi-file or multi-layer build that would flood the context | `engineer` (one per independent part; parallel only when they share no files) |
| Review before a change is called done | `code-reviewer` |
| UI change or user flow to verify (375px / 1440px screens, a11y) | `qa` |
| Money, payments, auth, permissions, tokens, realtime, secrets, public endpoints, new dependencies | add `security-reviewer` |
| README, CHANGELOG, release notes (only when asked or a documented contract changed) | `docs` |
| Ticket status, "work on ticket #123", Odoo changes, Discord | Hermes, then build as above |
| A large multi-part feature, or you say `/factory` | the `factory` skill |

### Hand-off contract

Each agent replies once, and the first line is machine-checkable:

- builders: `STATUS: READY` or `STATUS: BLOCKED: <reason>`
- reviewers: `VERDICT: PASS` or `VERDICT: CHANGES` with `file:line` findings

On `CHANGES` the main session resumes the **same** engineer with the findings (SendMessage), at most twice. After that it stops and asks you. Agents never merge, never push to a protected branch, and never delete branches or worktrees.

### Models

Agents default to Opus (`model: opus`; `engineer` inherits the session model). Use a bigger model only for genuinely hard or high-risk work, and Sonnet or Haiku for bulk mechanical work. Agent turns are capped with `maxTurns`.

## The agents

| Agent | Writes code | Role |
|---|---|---|
| `engineer` | yes | Builds a scoped change in a given worktree and branch, runs the project's own gates, reports created-vs-reused |
| `code-reviewer` | no | Independent review for correctness, edge cases, test quality and project-rule violations |
| `qa` | no | Runs each acceptance criterion end to end, checks loading/empty/error states, screenshots at 375 and 1440, a11y |
| `security-reviewer` | no | Only for money, auth, tokens, realtime, secrets, public endpoints or new dependencies; runs in parallel with `code-reviewer` |
| `docs` | docs only | README, CHANGELOG, runbooks and release notes, only when asked or a documented contract changed |

## The `/factory` workflow (optional)

For a large feature only. The main session is the coordinator and the only writer of each job's `job.json`.

```
spec -> build -> review -> ready-for-human
              \-> needs-human (from any stage)
```

1. **Claim a job**: `~/.claude/factory/jobs/<yyyymmdd>-<slug>/`, created with plain `mkdir` so the folder itself is the lock.
2. **Worktree** in the target repo, outside the repo folder, on a branch off the integration branch (`staging` when the repo has one, never `main` in that case).
3. **Spec** (`spec.md`): context, numbered testable requirements, acceptance criteria each with a `Verify:` step, out of scope, assumptions.
4. **Build**: `engineer` with the worktree, branch, spec and the gates to run.
5. **Review in parallel**: `code-reviewer` always, `qa` for anything user-facing, `security-reviewer` for sensitive areas. Each writes `review-<lens>-r<round>.md`.
6. **Rework**: at most 2 rounds, then `needs-human`.
7. **Approve or escalate**: anything touching money, auth, deploys, CI/CD, migrations, new dependencies or production data is escalated whatever the verdicts say.

You merge. The factory reports branch, worktree, commits, verdict files, how to try it and open risks.

## Approval gate

`approval-gate.js` runs before every `Bash` / `PowerShell` call. Commands are split into segments (`;`, `&&`, `||`, `|`, newlines), wrappers like `sudo`, `env` and `git -C` are stripped, nested `bash -c "..."` is expanded, and each segment is checked against `protected.json`:

- pushes or merges to `staging`, `main`, `master`, `production`; force pushes; `gh pr merge`
- Cloud Run / Cloud Build / Vercel `--prod` / Firebase deploys, `terraform apply|destroy`
- hard resets to a remote protected branch, deleting a protected branch
- `kubectl` against a non-local context, `rm` outside the repo, `DROP` / `TRUNCATE` through `psql`

A protected command is queued as a proposal in [Hermes](#hermes) and denied with `Approval #N requested in Discord`. Reply `approve N` in Discord and re-run the same command; the approval is single-use and expires after 24 hours. Approval is read only from Hermes's own state, never from a file the session can write.

It fails safe: if Hermes is not running or anything errors, it falls back to Claude Code's own permission prompt. It never allows on error, and the hook is registered with `onFailure: block`.

Rules that depend on the current branch (`git push`, `git push origin HEAD`, `git merge`) also fail closed: if git cannot name the branch within 5 seconds, the branch is treated as protected. Set `FACTORY_GATE_GIT_TIMEOUT_MS` to change the limit.

Edit `hooks/protected.json` and re-run `install.ps1` to change the rules.

## Dashboard

`http://127.0.0.1:7777`, loopback only, zero dependencies. It shows active agents, sessions per project with model, duration, tokens and estimated cost, pending approvals, errors, open PRs for repos seen today, and a **Board** tab with one column per stage for the tickets agents are working on.

- Activity comes from the telemetry hook's daily files in `~/.claude/factory/data/`.
- Tokens and cost are read from the session transcripts on demand (deduplicated per message). Cost is an **estimate** from the list prices in `pricing.json`.
- The Board reads `boards.json` (seeded from `boards.example.json` on first install, never overwritten) and the append-only `data/work-events.jsonl`. Agents move a ticket with:

  ```
  node ~/.claude/factory/work.js "My Project" 123 building --agent "engineer (opus)"
  ```

  Stages: `queued`, `building`, `review`, `qa`, `fix-needed`, `evidence-pending`, `done`, `blocked`.

## Hermes

[Hermes](https://github.com/NousResearch/hermes-agent) is the one external piece: it owns Odoo tickets and Discord. The factory reads ticket context read-only and never writes to Odoo directly; every Odoo change is queued with `agent_ops.py propose` and approved in Discord. The approval gate and the dashboard look for Hermes in `%LOCALAPPDATA%\hermes` (override with `HERMES_HOME`).

Without Hermes everything still works: protected commands fall back to the normal Claude Code prompt and the dashboard shows no Discord approvals.

## Install

Requirements: Windows, Claude Code (Desktop or CLI), Node.js 18+.

1. Clone the repo anywhere.
2. Merge `CLAUDE.global.md` into your own `~/.claude/CLAUDE.md`. The installer never touches it.
3. Run:

   ```
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

   It copies the agents and the `factory` skill into `~/.claude/`, deploys the hooks and dashboard to `~/.claude/factory/`, merges the hook entries into `~/.claude/settings.json` and `~/.claude-personal/settings.json` (whichever exist, after a one-time `.bak-factory` backup), and registers the dashboard as a logon task.
4. Edit `~/.claude/factory/boards.json` with your projects.
5. Restart Claude Code.

Switches: `-NoAgents`, `-NoHooks`, `-NoDashboard`, and `-RemoveHooks` to take the hook entries out again. The script is idempotent; re-run it after editing anything in this repo.

## Use it in a project

Nothing to install per repo. What makes the factory work well in a project is its own `CLAUDE.md` / `AGENTS.md`:

- the stack and repo layout
- the exact commands for typecheck, lint, test and build (the gates the engineer runs)
- the branch convention and the integration branch
- architecture rules that must not be broken and a definition of done

Then just ask in chat. Say `/factory <feature>` only for a large multi-part feature.

## Tests

```
node hooks/test/gate.test.js
```

```
node hooks/test/board.test.js
```

```
node hooks/test/server.test.js
```

```
node hooks/test/usage.test.js
```

## License

[MIT](LICENSE)
