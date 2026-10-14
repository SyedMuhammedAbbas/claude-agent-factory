---
name: factory
description: Optional build workflow for a large multi-part feature - job folder, isolated git worktree, written spec, engineer, parallel reviewers, bounded rework, hand-off to the owner. Use ONLY when the owner explicitly asks for the factory ("/factory", "run it through the factory") or for a large multi-part feature workflow. Never for normal requests, bug fixes, small features or questions.
---

# Factory

The main session is the coordinator and the approver. It writes the job file, briefs the agents (`engineer`, `code-reviewer`, `qa`, `security-reviewer`) and decides each transition. It never merges, never pushes to staging/main, and never deletes the branch or the worktree.

Stages: `spec` -> `build` -> `review` -> `ready-for-human`, or `needs-human` from any stage.

## 1. Claim a job
- Jobs live outside every repo: `~/.claude/factory/jobs/` (Windows: `%USERPROFILE%\.claude\factory\jobs\`). Create the parent once (`mkdir -p ~/.claude/factory/jobs`).
- Id: `<yyyymmdd>-<slug>`. Claim it with plain `mkdir ~/.claude/factory/jobs/<id>` (no `-p`): the folder is the lock. If `mkdir` fails, the id is taken; add `-2`, `-3`.
- Write `job.json` in it. Only the coordinator writes this file:
  ```json
  {"id": "", "feature": "", "repo": "", "branch": "", "worktree": "", "base": "", "stage": "spec", "round": 0, "reviews": {}}
  ```
  For a feature across several repos, `repo`, `branch` and `worktree` are arrays in the same order. Update `stage`, `round` and `reviews` at every transition.

## 2. Worktree, in the target repo
- Read the repo's CLAUDE.md / AGENTS.md. Pick only the repos the feature touches.
- Branch: the repo's convention (e.g. `task/<ID>-<slug>`), else `agent/<ticket-or-id>-<slug>`.
- Base: the integration branch (`staging` when it exists or the project names it; never `main` in a repo that has `staging`).
- `git -C <repo> fetch origin <base>` then `git -C <repo> worktree add <path> -b <branch> origin/<base>`. The path is outside the repo folder: the project's worktree folder if it names one, else `<repo parent>/_worktrees/<repo>-<id>`.
- Flutter repos (`pubspec.yaml` and `android/`): copy `android/key.properties` into the worktree (it is git-ignored and release builds need it). Install dependencies the way the project does.

## 3. Spec: `<job>/spec.md`
Written by the coordinator, or drafted by `engineer` and checked by the coordinator.
```
# <feature>
## Context        why, ticket and PRD references, current state with file paths
## Requirements   numbered, each testable
## Acceptance criteria   each with "Verify:" the exact command, test or screen step
## Out of scope
## Assumptions    each one marked; a product assumption goes to the owner before build
```
Move to `build` when no load-bearing question is open.

## 4. Build
Spawn `engineer` with: worktree path, branch, base, spec path, the gates to run, and "write your reply to `<job>/build-r<round>.md` too". `STATUS: BLOCKED` -> stage `needs-human`, ask the owner.

## 5. Review, in parallel (one message)
- `code-reviewer`: always.
- `qa`: when anything user-facing changed.
- `security-reviewer`: only for money, payments, auth, permissions, tokens, realtime or bidding, secrets, public endpoints.
Each writes `<job>/review-<lens>-r<round>.md`; first line `VERDICT: PASS` or `VERDICT: CHANGES`. Record each verdict in `job.json` `reviews`.

## 6. Rework, bounded
Any `CHANGES`: resume the same engineer with SendMessage, pointing at the review files; `round` + 1. At most 2 resumes. Then re-run only the reviewers that said `CHANGES` (and any whose area the fix touched). Still `CHANGES` after round 2 -> `needs-human`.

## 7. Approve or escalate
All `PASS` -> the coordinator decides:
- **ESCALATE** (`needs-human`) whenever the change touches money, auth or permissions, deploys, CI/CD, migrations, new dependencies, production data, or rests on an unconfirmed product assumption, whatever the verdicts say.
- Otherwise **APPROVE** (`ready-for-human`).

Either way, report to the owner: branch, worktree path, commits, verdicts with their file paths, how to try it, open risks. Open a PR against the base only if the owner asked (`gh pr create --base <base>`). Merging, pushing to staging/main and cleaning up the worktree and branch stay with the owner; protected actions are also held by the approval hook.
