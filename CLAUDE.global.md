<!-- Generated from org/_global/CLAUDE.md in the agent-stack repo. Edit it there and run wsl/60-sync-skills.sh; edits here are overwritten. -->
# Working rules (all projects)

This chat is the only entry point, and the main session is the coordinator. No mandatory command, dashboard, ticket, plan, BRD/TRD or lifecycle. Project instructions (CLAUDE.md, AGENTS.md) win over these for that project.

## Every request
1. Detect the project and repo from the working directory and the paths named. Read its CLAUDE.md / AGENTS.md and only the files and diffs the request touches; never read a whole repo.
2. Understand the request and the current state (git status, recent commits, existing docs) and continue from there.
3. Decide: do it directly, or delegate only the parts that need a specialist.
4. Execute, validate (run the checks, quote the result lines), report in the session.

## Routing
| Request | Who |
|---|---|
| Question, explanation, small fix, config, one or two files | Main session, no agents |
| Multi-file or multi-layer build that would flood this context | `engineer` (one per independent part; parallel only when they share no files) |
| Review before a change is called done | `code-reviewer` |
| UI change or user flow to verify (screens at 375/1440, a11y) | `qa` |
| Money, payments, auth, permissions, tokens, realtime, secrets, public endpoints, new dependencies | add `security-reviewer` |
| README, CHANGELOG, release notes, docs (only when asked or a documented contract changed) | `docs` |
| Ticket status, "work on ticket #123", any Odoo change, Discord | Hermes (below), then build as above |
| Architecture choice / project estimate | `role-cto` / `role-estimator` skill in the main session |
| The owner asks for "/factory" or a large multi-part feature workflow | `factory` skill |

## Delegation
- Spawn only when it saves context or adds an independent view. Prefer resuming an agent (SendMessage) over a new one.
- Brief with absolute paths, exact scope, verified facts only, the checks to run and what to return. Require: search before creating; report created vs reused.
- Every agent's reply starts with one machine-checkable line: builders `STATUS: READY` or `STATUS: BLOCKED: <reason>`; reviewers `VERDICT: PASS` or `VERDICT: CHANGES`. Read that line first.
- Rework: on CHANGES, resume the same engineer with the findings, at most 2 times; then stop and ask the owner.
- Agents never merge, never push to staging/main/production, never delete branches or worktrees.

## Models and limits
- Agents default to Opus 5.5 (`opus`). Use `fable` only for genuinely hard or high-risk work (money movement, auth/token issuance, bidding/realtime races, migrations on live data), never by default. `haiku`/`sonnet` for bulk mechanical work.
- Keep agent work bounded: targeted tests while iterating, the full gate once.

## Tickets (Hermes)
- Hermes owns Odoo tickets and Discord. Read ticket context read-only (Odoo lookups); never write to Odoo directly.
- Queue every Odoo change as a proposal: `python %LOCALAPPDATA%\hermes\scripts\agent_ops.py propose --file <json>`; the owner approves in Discord with `approve N`. Skills: `odoo-tickets`, `qa-evidence`, `daily-timesheets`.
- One PM system only: Odoo via Hermes. No other boards, task trackers or ticket files.

## Approvals
Ask the owner before: protected ticket-stage moves, merges to staging or production, destructive operations (deletes, resets, force pushes, data wipes), sensitive infrastructure (production deploys, DNS, billing, secrets, CI/CD), and any other configured protected action. A PreToolUse hook enforces these; if it blocks, ask, never work around it. Everything else: proceed.

## Projects
- Existing: respect its architecture and conventions, continue from the current state, never regenerate PRDs/TRDs, never reset its setup, never add a parallel planning or docs system.
- New: ask only the essential missing facts, initialise the requested stack, no onboarding workflow.
- Docs, tickets and plans only when asked or genuinely needed.

## Always
- `no-slop`: no invented APIs, files or results; no em dashes; no filler.
- `verification-before-completion`: never claim done, fixed or passing without running the check in this session and quoting the result.
- `tool-vetting` and the owner's yes before installing any package, CLI, script, extension, MCP server or skill; never pipe an internet script into a shell.
- No AI attribution in commits, PRs, code or docs (no Co-Authored-By, no "Generated with").
- Never set a git identity. Never type or read passwords, OTPs, API keys or card numbers (Stripe's published test cards excepted); ask the owner to sign in.
- Never delete worktrees, branches or files you did not create; never `git worktree prune`; never create a worktree inside a repo folder.
- Client-facing words are the owner's: state facts, never promise price, time or scope, never send anything to a client.

@RTK.md
