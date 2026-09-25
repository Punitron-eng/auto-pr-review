# auto-pr-review

Automatically reviews GitHub pull requests that are **assigned to you** or where **your review is requested**,
and posts the result as one GitHub review (event `COMMENT` - never approve / request changes).

- Poller: checks GitHub every 2 minutes (configurable) with `gh`.
- Worker: checks the PR out in its **own** clone (`workspace/`), runs **Claude Code** (Sonnet) headless; falls back to
  **OpenCode** if Claude is rate/usage-limited, fails, or is already busy with another review.
- **Two modes per PR:**
  - **full review** - the PR has no open review comments yet: review the whole diff, post inline comments.
  - **follow-up** - the PR already has unresolved review threads (from anyone, including earlier auto-pr-review
    runs): do NOT review the whole PR again; check only whether each open thread was addressed at the current head,
    reply once in each thread, and post one summary COMMENT review with a table.
- Every AI run opens in its own **red** terminal window (Windows Terminal tab with red tab colour + dark-red
  background; falls back to a classic PowerShell window with a DarkRed background). The window closes itself
  about 15 s after the run finishes.
- Dashboard at **http://localhost:4545**: what is running now, how many are pending / done / failed, the mode
  (full review / follow-up) of each review, and recent reviews with links.
- No input is needed while it runs.

Currently configured for `iThink-Logistics/itl-dashboard-react` only (see `config.json`).

## Requirements

- Windows 10/11, Node.js 20+ (no npm packages needed)
- GitHub CLI logged in: `gh auth login` (the reviews are posted **as that GitHub user**)
- `claude` (Claude Code) and/or `opencode` on PATH, both already logged in
- Windows Terminal (`wt`) optional, for the red tabs

The tool clones the target repo over HTTPS into `workspace\repos\` using `gh auth git-credential` as a
credential helper **inside that clone only** (so no SSH key is needed and your global git config is not changed).
It never touches your own working copies such as `D:\next-itl\itl-dashboard-react`.

## Usage

```powershell
cd D:\auto-pr-review

npm run dry-run                     # full pipeline, but NOTHING is posted to GitHub
npm start                           # LIVE: posts COMMENT reviews on matching PRs

node src\index.js --dry-run --pr 1402                                   # review one PR now, then exit
node src\index.js --dry-run --pr iThink-Logistics/itl-dashboard-react#1402
node src\index.js --once            # poll once, review everything queued, exit
node src\index.js --dashboard-only  # just the dashboard (reads the live state file)
```

`start.cmd` does the same as `npm start` (double-clickable; add `--dry-run`).

Dry-run and live keep **separate** state files (`data\state.dry-run.json` vs `data\state.json`), so a dry run
never stops the live mode from reviewing that PR later.

### What gets reviewed

- Open PRs in `repos` matching any of `searchQueries` (default `review-requested:@me` and `assignee:@me`).
  Note: `review-requested:@me` also matches requests made to a **team** you are in.
- Drafts and your own PRs are skipped (configurable).
- Each head commit is reviewed once. A new push to the PR is reviewed again if `reviewNewCommits` is `true`.
  (GitHub removes you from "requested reviewers" once a review is posted from your account, so later pushes are
  only picked up while the PR is still assigned to you or your review is re-requested.)
- Before posting, the tool checks the PR for its own marker `<!-- auto-pr-review sha=... -->` and skips if the
  commit was already reviewed.

### Opening the dashboard

The dashboard is served by the same process, so it is available whenever the tool is running:

```powershell
cd D:auto-pr-review
npm start            # or: npm run dry-run
# then open http://localhost:4545 in a browser
```

It works the same in dry-run and live mode (the header shows which). Dry-run and live read different state files,
so the dashboard shows the queue of the mode that is running. `npm run dashboard` (= `--dashboard-only`) shows the
live state file without polling or reviewing - only use it while the main process is NOT running, because both use
port 4545. `--pr` and `--once` runs also serve the dashboard until they exit.

### Follow-up mode (existing review comments)

With `"existingCommentsMode": "review-existing-only"` (default), before reviewing the tool reads the PR's review
threads via GraphQL (`reviewThreads`, which includes `isResolved` / `isOutdated`):

- **Resolved threads are ignored.** If no unresolved thread is left, a normal full review is done.
- Otherwise the model gets, for each unresolved thread (up to `maxFollowUpThreads`): file, line, the original
  comment and all replies, the code the comment was made on (diff hunk + commit), and the current code at HEAD.
  It must return strict JSON: `{summary, threads:[{id, status, explanation}]}` with status
  `addressed | partially_addressed | not_addressed | not_applicable`.
- The **tool** (not the model) then posts:
  1. one short reply in each judged thread via `POST /repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies`,
     carrying `<!-- auto-pr-review-reply sha=<head> -->` so the same thread is never answered twice for the same
     head commit,
  2. one COMMENT review with a summary table, carrying `<!-- auto-pr-review sha=<head> ... mode=followup -->`.
- It never resolves threads, never approves, never requests changes, and does not add new inline findings.
- Set `"existingCommentsMode": "full"` to always do a fresh full review instead.

Run folders for follow-ups contain `threads.json`, `prompt.md`, `review.json` and `followup-payload.json`
(`{replies:[...], review:{...}}` = exactly what is / would be posted).

### Review output

The model must return `{summary, comments:[{path, line, side, severity, body}]}`. The tool (not the model) then:
1. checks every comment's file/line against the actual PR diff, and moves ones that do not match into the
   summary under "Additional notes",
2. caps the number of inline comments (`maxInlineComments`),
3. posts ONE review via `gh api repos/{owner}/{repo}/pulls/{n}/reviews` with `event: "COMMENT"`.
   If GitHub rejects an inline position, it retries once with all notes in the review body.

Everything for each run is kept in `runs\<repo>__<pr>__<sha>__<time>\`:
`prompt.md`, `pr.diff`, `claude\` or `opencode\` (live output, raw JSON events, stderr), `review.json`
(the model's answer), `review-payload.json` (exactly what is / would be posted), `attempts.txt`.

### Engines and fallback

`engineOrder` (default `["claude", "opencode"]`). An engine is skipped when:
- it is already running `maxParallel` reviews ("busy"),
- it hit a usage/rate limit recently (it is paused for `cooldownMinutesAfterLimit`, default 30 min),
- it is not installed.
If an engine fails, the next one is tried (`fallbackOnAnyError: true`).

**Claude** runs as `claude -p --output-format stream-json --json-schema <schema> --permission-mode dontAsk`
with only `Read, Grep, Glob` and read-only `git diff/log/show/blame/status` allowed. It uses
`--setting-sources ""` and `--strict-mcp-config`, so your personal hooks, prompt routers, MCP servers and
permission allow-lists are **not** loaded for reviews (and a PR cannot inject a `.claude/settings.json`).
It still reads the repo's `CLAUDE.md` because the prompt tells it to.
Model and effort come from `config.json` (`engines.claude.model` = `sonnet`, `effort` = `high` by default).
`sonnet` is the Claude Code alias for the latest Sonnet (currently `claude-sonnet-5`); a full model id such as
`claude-sonnet-5` or `opus` also works.
`maxBudgetUsd` > 0 adds `--max-budget-usd`.

**OpenCode** runs as `opencode run "<msg>" --format json --dir <worktree> -f prompt.md`, with read-only
permissions passed through the `OPENCODE_CONFIG_CONTENT` environment variable (edit/webfetch denied, bash
denied except read-only git). Leave `engines.opencode.model` empty to use your OpenCode default, or set e.g.
`"anthropic/claude-sonnet-5"`.
MCP servers listed in `engines.opencode.disableMcp` (default `itl-context`) are switched off for reviews, so the
reviewer does not read or write the shared ITL memory. If OpenCode ends without the JSON, or reaches 75% of
`reviewTimeoutMinutes`, the runner asks the same session once more for just the final JSON.

## config.json

| key | meaning |
|---|---|
| `repos` | `owner/repo` list to watch |
| `searchQueries` | GitHub search qualifiers that mean "this PR is for me" |
| `projectRulesFiles` | per repo: a rules file outside the repo (read-only) to put into the prompt when the checkout has no CLAUDE.md. Set to your local `CLAUDE.md` because itl-dashboard-react git-ignores it |
| `pollIntervalMinutes` | how often to poll (default 2) |
| `concurrency` | reviews running at the same time (default 1) |
| `reviewNewCommits` | re-review when the PR head changes |
| `existingCommentsMode` | `review-existing-only` (default: PRs with unresolved review threads get a follow-up instead of a full review) or `full` |
| `maxFollowUpThreads` | max open threads checked in one follow-up (default 30) |
| `skipDrafts`, `skipOwnPrs` | filters |
| `maxAttempts` | tries per commit before marking it failed (retry after 5 min) |
| `reviewTimeoutMinutes` | kill an AI run after this long |
| `maxInlineComments` | cap on inline comments per review |
| `maxDiffChars` | diff size put into the prompt (the model can run `git diff` for the rest) |
| `engineOrder`, `engines.*` | engine order and per-engine settings (`command` overrides the executable path) |
| `window.mode` | `wt` (default), `powershell`, or `hidden` |
| `window.tabColor`, `window.closeAfterSeconds` | red tab colour and auto-close delay |
| `keepWorktrees` | keep the per-PR checkout after the review (debugging) |
| `dashboard.host`, `dashboard.port` | dashboard address (default `127.0.0.1:4545`) |

Put personal overrides in `config.local.json` (git-ignored). It is merged on top of `config.json`.

## Start automatically at logon (optional)

```powershell
powershell -ExecutionPolicy Bypass -File D:\auto-pr-review\scripts\install-startup-task.ps1          # live
powershell -ExecutionPolicy Bypass -File D:\auto-pr-review\scripts\install-startup-task.ps1 -DryRun  # dry-run
powershell -ExecutionPolicy Bypass -File D:\auto-pr-review\scripts\uninstall-startup-task.ps1
```

## Files

```
config.json                     settings
start.cmd                       double-click launcher
src/index.js                    entry point: CLI flags, poll loop, wiring
src/poller.js                   finds matching PRs and queues them
src/worker.js                   checkout -> full review or follow-up -> engine (with fallback) -> validate -> post
src/engines.js                  claude / opencode command lines, output parsing, limit detection
src/engine-runner.js            runs inside the red window; streams live output; writes result files
src/window.js                   opens the red Windows Terminal / PowerShell window and waits for it
src/prompt.js                   full-review and follow-up prompts + JSON schemas
src/diff.js                     unified diff parser and inline comment validation
src/gh.js                       GitHub CLI wrappers
src/workspace.js                own clone + per-PR git worktrees
src/state.js                    JSON state file (survives restarts)
src/dashboard.js                local HTTP server
src/config.js, src/util.js      config loading, logging, process helpers
public/index.html               dashboard page (auto-refreshes every 3 s)
scripts/review-window.ps1       red window wrapper
scripts/install-startup-task.ps1 / uninstall-startup-task.ps1
```

Git-ignored at runtime: `workspace/`, `data/`, `runs/`, `logs/`.

## Troubleshooting

- **Nothing gets picked up**: check the dashboard "Poller" box; run
  `gh pr list -R iThink-Logistics/itl-dashboard-react --search "review-requested:@me"`.
- **Window does not appear**: set `"window": {"mode": "powershell"}`, or `"hidden"` to run without a window.
- **Stop**: Ctrl+C in the terminal running `npm start`. An interrupted review is queued again on the next start.
- Logs: `logs\app.log`.
