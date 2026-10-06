// Processes queued PRs.
//   full mode:      checkout -> diff -> AI review (claude, fallback opencode) -> validate -> post one COMMENT review
//   follow-up mode: PR already has open review threads -> AI judges each thread against HEAD ->
//                   one reply per thread + one COMMENT review with a summary table
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log, safeName } from './util.js';
import * as gh from './gh.js';
import { checkoutPr, localDiff, removeWorktree } from './workspace.js';
import { parseDiff, validateComments } from './diff.js';
import { buildPrompt, buildFollowUpPrompt, FOLLOWUP_STATUSES } from './prompt.js';
import { buildJob, parseResult } from './engines.js';
import { runJobInWindow } from './window.js';

const SEV_LABEL = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const STATUS_LABEL = {
  addressed: 'Addressed',
  partially_addressed: 'Partially addressed',
  not_addressed: 'Not addressed',
  not_applicable: 'No longer applicable',
};
const replyMarker = (sha) => `<!-- auto-pr-review-reply sha=${sha} -->`;

export class Worker {
  constructor({ cfg, state, dryRun }) {
    this.cfg = cfg; this.state = state; this.dryRun = dryRun;
    this.active = new Map();          // key -> {repo, number, engine}
    this.engineBusy = { claude: 0, opencode: 0 };
    this.onIdle = null;
  }

  runningCount() { return this.active.size; }

  /** Pick queued PRs and start them up to the concurrency limit. */
  tick() {
    const now = Date.now();
    const queue = this.state.all()
      .filter((p) => p.status === 'pending' && (!p.nextRetryAt || Date.parse(p.nextRetryAt) <= now))
      .sort((a, b) => Date.parse(a.queuedAt || 0) - Date.parse(b.queuedAt || 0));
    while (this.active.size < Math.max(1, this.cfg.concurrency) && queue.length) {
      const pr = queue.shift();
      const key = this.state.key(pr.repo, pr.number);
      if (this.active.has(key)) continue;
      this.active.set(key, { repo: pr.repo, number: pr.number, engine: null });
      this.review(pr).catch((err) => log.error(`Unexpected error reviewing ${key}:`, err)).finally(() => {
        this.active.delete(key);
        if (this.active.size === 0 && this.onIdle) this.onIdle();
        setImmediate(() => this.tick());
      });
    }
  }

  cooldownActive(engine) {
    const until = this.state.meta().cooldowns?.[engine];
    return until && Date.parse(until) > Date.now() ? until : null;
  }
  setCooldown(engine) {
    const mins = this.cfg.engines?.[engine]?.cooldownMinutesAfterLimit ?? 30;
    const cooldowns = { ...(this.state.meta().cooldowns || {}), [engine]: new Date(Date.now() + mins * 60_000).toISOString() };
    this.state.meta({ cooldowns });
    log.warn(`${engine} looks rate/usage-limited; not using it for ${mins} min`);
  }

  /** Run the engines in order (with fallback) on a prompt file. Returns {result, usedEngine, attempts}. */
  async runEngines({ key, set, runDir, worktree, promptFile, kind, number, jobTitle }) {
    const attempts = [];
    for (const engine of this.cfg.engineOrder) {
      const cd = this.cooldownActive(engine);
      if (cd) { attempts.push(`${engine}: skipped (limit cooldown until ${cd})`); continue; }
      const maxPar = this.cfg.engines?.[engine]?.maxParallel ?? 1;
      if ((this.engineBusy[engine] || 0) >= maxPar) { attempts.push(`${engine}: skipped (busy with another review)`); continue; }

      const title = `PR ${kind === 'followup' ? 'Follow-up' : 'Review'} #${number} (${engine})`;
      const jobDir = path.join(runDir, engine);
      fs.mkdirSync(jobDir, { recursive: true });
      const job = buildJob(engine, this.cfg, { cwd: worktree, promptFile, title, kind });
      if (job.error) { attempts.push(`${engine}: ${job.error}`); continue; }
      const timeoutMs = this.cfg.reviewTimeoutMinutes * 60_000;
      fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({ ...job, title: jobTitle, timeoutMs }, null, 2));

      this.engineBusy[engine] = (this.engineBusy[engine] || 0) + 1;
      this.active.get(key).engine = engine;
      set({ engine, step: `${kind === 'followup' ? 'checking old comments' : 'reviewing'} with ${engine}`, engineStartedAt: new Date().toISOString() });
      log.info(`${key}: ${kind} review with ${engine} ...`);
      let win;
      try { win = await runJobInWindow(jobDir, title, this.cfg.window || {}, timeoutMs); }
      finally { this.engineBusy[engine]--; }

      const r = parseResult(engine, { rawFile: path.join(jobDir, 'raw.jsonl'), stderrFile: path.join(jobDir, 'stderr.log'), exitCode: win.exitCode, kind });
      if (win.timedOut) r.error = `timed out after ${this.cfg.reviewTimeoutMinutes} min. ${r.error || ''}`;
      attempts.push(`${engine}: ${r.ok ? 'ok' : r.error} [window: ${win.mode}]`);
      if (r.ok) return { result: r, usedEngine: engine, attempts };
      log.warn(`${key}: ${engine} failed: ${r.error}`);
      if (r.limitHit) this.setCooldown(engine);
      else if (!this.cfg.fallbackOnAnyError) break;
    }
    return { result: null, usedEngine: null, attempts };
  }

  async review(entry) {
    const { repo, number } = entry;
    const retest = entry.retest || null; // 'verify' | 'full' - set by the dashboard's Re-test buttons
    const key = this.state.key(repo, number);
    const set = (patch) => this.state.upsert(repo, number, patch);
    set({ status: 'running', startedAt: new Date().toISOString(), finishedAt: null, engine: null, error: null, step: 'starting', mode: null, followUp: null, counts: null });
    let worktree = null;
    try {
      // Fresh PR data (the head may have moved since the poll).
      const pr = await gh.viewPr(repo, number);
      if (pr.state !== 'OPEN') {
        const st = await gh.prState(repo, number).catch(() => ({ state: pr.state }));
        set({ status: 'skipped', skipReason: `PR is ${pr.state}`, prState: st.state, mergedAt: st.mergedAt || null, closedAt: st.closedAt || null, mergedBy: st.mergedBy || null, finishedAt: new Date().toISOString(), step: null, retest: null });
        return;
      }
      set({ sha: pr.headRefOid, title: pr.title, url: pr.url, author: pr.author?.login });
      const sha = pr.headRefOid;

      const markers = await gh.markerReviews(repo, number);
      if (!retest && markers.some((m) => m.sha === sha)) {
        log.info(`${key} already has an auto-pr-review for ${sha.slice(0, 7)}; skipping`);
        set({ status: 'done', reviewedSha: sha, skipReason: 'already reviewed (marker found on PR)', finishedAt: new Date().toISOString(), step: null });
        return;
      }

      // ---- Full review, follow-up on existing comments, or re-test? ----
      // A PR gets ONE full review. After that only its comments are followed up, so the author never gets a
      // second batch of new comments. Another full review only happens when asked for from the dashboard.
      let mode = 'full', threads = [];
      const followUpOnly = (this.cfg.existingCommentsMode || 'review-existing-only') === 'review-existing-only';
      if (retest === 'verify' || (followUpOnly && retest !== 'full')) {
        set({ step: 'checking existing review comments' });
        const all = (await gh.reviewThreads(repo, number)).filter((t) => t.comments?.nodes?.length);
        const open = all.filter((t) => !t.isResolved);
        set({ existingThreads: { total: all.length, open: open.length } });
        const finishWithoutReview = (outcome, reason) => {
          log.info(`${key}: ${reason}`);
          set({ status: 'done', mode: 'none', outcome, openLeft: 0, reviewedSha: sha, skipReason: reason, finishedAt: new Date().toISOString(), step: null, retest: null });
        };
        if (retest === 'verify') {
          if (!all.length) return finishWithoutReview('clean', 'nothing to re-test: the PR has no review comments');
          mode = 'retest'; threads = all;
        } else if (open.length) {
          mode = 'followup'; threads = open;
        } else if (markers.length && this.cfg.singleFullReview !== false) {
          return finishWithoutReview(all.length ? 'all-resolved' : 'clean', all.length
            ? `all ${all.length} review comment(s) are resolved - no new review (use Re-test on the dashboard)`
            : 'already had its full review and nothing is open - no new review (use Re-test on the dashboard)');
        }
        log.info(`${key}: ${all.length} review thread(s), ${open.length} unresolved -> ${mode}`);
      }
      set({ mode });

      const runDir = path.join(DIRS.runs, `${safeName(repo.replace('/', '__'))}__${number}__${sha.slice(0, 7)}__${mode}__${Date.now()}`);
      fs.mkdirSync(runDir, { recursive: true });
      set({ runDir, step: 'checkout' });

      const co = await checkoutPr(repo, pr);
      worktree = co.dir;

      // Team rules file kept outside the repo (e.g. a git-ignored CLAUDE.md in the user's own checkout) - read-only.
      let projectRules = null;
      const rulesPath = this.cfg.projectRulesFiles?.[repo];
      if (rulesPath && !fs.existsSync(path.join(worktree, 'CLAUDE.md'))) {
        try { projectRules = fs.readFileSync(rulesPath, 'utf8'); } catch (err) { log.warn(`Could not read projectRulesFiles for ${repo}: ${err.message}`); }
      }
      const jobTitle = `${repo} #${number} - ${pr.title}`;
      const promptFile = path.join(runDir, 'prompt.md');

      if (mode !== 'full') {
        await this.followUp({ key, set, repo, number, pr, sha, runDir, worktree, co, projectRules, promptFile, jobTitle, threads, retest: mode === 'retest' });
        return;
      }

      set({ step: 'diff' });
      let diff;
      const d = await gh.prDiff(repo, number);
      if (d.ok && d.diff.trim()) diff = d.diff;
      else { log.warn(`gh pr diff failed for ${key} (${d.error || 'empty'}); using local git diff`); diff = await localDiff(worktree, co.baseRef); }
      fs.writeFileSync(path.join(runDir, 'pr.diff'), diff);
      const diffFiles = parseDiff(diff);
      fs.writeFileSync(promptFile, buildPrompt({ repo, pr, diff, maxDiffChars: this.cfg.maxDiffChars, maxComments: this.cfg.maxInlineComments, baseRef: co.baseRef, projectRules }));

      const { result, usedEngine, attempts } = await this.runEngines({ key, set, runDir, worktree, promptFile, kind: 'full', number, jobTitle });
      fs.writeFileSync(path.join(runDir, 'attempts.txt'), attempts.join('\n'));
      if (!result) throw new Error(`No engine produced a review. ${attempts.join(' | ')}`);
      fs.writeFileSync(path.join(runDir, 'review.json'), JSON.stringify(result.review, null, 2));

      // ---- Build and post the review ----
      set({ step: 'posting' });
      const { valid, invalid } = validateComments(result.review.comments, diffFiles, this.cfg.maxInlineComments);
      const payload = {
        commit_id: sha,
        event: 'COMMENT',
        body: buildBody({ review: result.review, engine: usedEngine, sha, valid, invalid }),
        comments: valid.map((c) => ({ path: c.path, line: c.line, side: c.side, body: `**[${SEV_LABEL[c.severity]}]** ${c.body}` })),
      };
      const payloadFile = path.join(runDir, 'review-payload.json');
      fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2));
      const counts = { inline: valid.length, unanchored: invalid.length };
      const outcomeOf = (c) => ({ outcome: c.inline + c.unanchored ? 'changes-requested' : 'clean', openLeft: c.inline + c.unanchored, retest: null });

      if (this.dryRun) {
        log.info(`[dry-run] ${key}: review NOT posted. ${valid.length} inline, ${invalid.length} moved to body. Payload: ${payloadFile}`);
        set({ status: 'done', dryRun: true, reviewedSha: sha, engine: usedEngine, counts, ...outcomeOf(counts), meta: result.meta, payloadFile, reviewUrl: null, finishedAt: new Date().toISOString(), step: null, attemptsLog: attempts });
        return;
      }

      let posted = await gh.postReview(repo, number, payload, payloadFile);
      if (!posted.ok && valid.length) {
        // GitHub rejected an inline position (422) - retry with everything in the body.
        log.warn(`${key}: posting with inline comments failed (${posted.error.slice(0, 300)}); retrying with all notes in the body`);
        const flat = { ...payload, comments: [], body: buildBody({ review: result.review, engine: usedEngine, sha, valid: [], invalid: [...valid, ...invalid] }) };
        posted = await gh.postReview(repo, number, flat, payloadFile.replace('.json', '.fallback.json'));
        counts.unanchored += counts.inline; counts.inline = 0;
      }
      if (!posted.ok) throw new Error(`Posting review failed: ${posted.error}`);
      log.info(`${key}: review posted ${posted.url}`);
      set({ status: 'done', dryRun: false, reviewedSha: sha, engine: usedEngine, counts, ...outcomeOf(counts), meta: result.meta, reviewUrl: posted.url, finishedAt: new Date().toISOString(), step: null, attemptsLog: attempts });
    } catch (err) {
      const cur = this.state.get(repo, number);
      const n = (cur.attempts || 0) + 1;
      const retry = n < this.cfg.maxAttempts;
      log.error(`${key}: review failed (attempt ${n}/${this.cfg.maxAttempts}): ${err.message}`);
      set({
        status: retry ? 'pending' : 'failed', attempts: n, error: err.message.slice(0, 2000), step: null,
        finishedAt: new Date().toISOString(), nextRetryAt: retry ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
        ...(retry ? {} : { retest: null }),
      });
    } finally {
      if (worktree && !this.cfg.keepWorktrees) await removeWorktree(repo, worktree).catch(() => {});
    }
  }

  /** Follow-up / re-test: judge each thread against HEAD, reply in each thread, post a summary COMMENT review. */
  async followUp({ key, set, repo, number, pr, sha, runDir, worktree, co, projectRules, promptFile, jobTitle, threads, retest }) {
    const max = this.cfg.maxFollowUpThreads ?? 30;
    const items = threads.slice(0, max).map((t, i) => threadItem(t, i, worktree, sha));
    const unchecked = threads.slice(max).map((t, i) => threadItem(t, max + i, worktree, sha));
    fs.writeFileSync(path.join(runDir, 'threads.json'), JSON.stringify(items.map(({ snippet, ...rest }) => rest), null, 2));
    fs.writeFileSync(promptFile, buildFollowUpPrompt({ repo, pr, threads: items, baseRef: co.baseRef, projectRules, retest }));

    const { result, usedEngine, attempts } = await this.runEngines({ key, set, runDir, worktree, promptFile, kind: 'followup', number, jobTitle });
    fs.writeFileSync(path.join(runDir, 'attempts.txt'), attempts.join('\n'));
    if (!result) throw new Error(`No engine produced a follow-up. ${attempts.join(' | ')}`);
    fs.writeFileSync(path.join(runDir, 'review.json'), JSON.stringify(result.review, null, 2));

    // The tool (not the model) decides what gets posted: only known ids, only known statuses.
    const judged = new Map();
    for (const v of result.review.threads) {
      const id = String(v.id || '').trim();
      if (items.some((it) => it.id === id) && FOLLOWUP_STATUSES.includes(v.status) && !judged.has(id)) {
        judged.set(id, { status: v.status, explanation: String(v.explanation || '').trim() || '(no explanation given)' });
      }
    }
    const rows = items.map((it) => ({ ...it, verdict: judged.get(it.id) || null }));
    const replies = rows.filter((r) => r.verdict && !r.alreadyReplied)
      .map((r) => ({ threadId: r.id, commentId: r.rootCommentId, url: r.url, body: replyBody(r.verdict, usedEngine, sha) }));

    const counts = { threads: items.length, replies: replies.length, notJudged: rows.filter((r) => !r.verdict).length, unchecked: unchecked.length };
    for (const s of FOLLOWUP_STATUSES) counts[s] = rows.filter((r) => r.verdict?.status === s).length;
    const openLeft = counts.partially_addressed + counts.not_addressed + counts.notJudged + counts.unchecked;
    const outcome = { outcome: openLeft ? 'open-comments' : 'all-resolved', openLeft, retest: null };

    const reviewPayload = { commit_id: sha, event: 'COMMENT', body: buildFollowUpBody({ summary: result.review.summary, rows, unchecked, engine: usedEngine, sha, counts, retest }), comments: [] };
    const payloadFile = path.join(runDir, 'followup-payload.json');
    fs.writeFileSync(payloadFile, JSON.stringify({ replies, review: reviewPayload }, null, 2));
    set({ step: 'posting', followUp: counts, counts: null });

    if (this.dryRun) {
      log.info(`[dry-run] ${key}: follow-up NOT posted. ${items.length} thread(s) checked, ${replies.length} repl(ies) prepared. Payload: ${payloadFile}`);
      set({ status: 'done', dryRun: true, reviewedSha: sha, engine: usedEngine, ...outcome, meta: result.meta, payloadFile, reviewUrl: null, finishedAt: new Date().toISOString(), step: null, attemptsLog: attempts });
      return;
    }

    const replyResults = [];
    for (const rep of replies) {
      const r = await gh.postReply(repo, number, rep.commentId, rep.body);
      replyResults.push({ ...rep, ...r });
      if (!r.ok) log.warn(`${key}: reply to thread ${rep.threadId} (comment ${rep.commentId}) failed: ${r.error.slice(0, 300)}`);
    }
    fs.writeFileSync(path.join(runDir, 'replies-result.json'), JSON.stringify(replyResults, null, 2));
    counts.replies = replyResults.filter((r) => r.ok).length;
    counts.replyErrors = replyResults.length - counts.replies;
    if (counts.replyErrors) reviewPayload.body = reviewPayload.body.replace('\n---\n', `\n_${counts.replyErrors} thread repl(ies) could not be posted; see the table above for the verdicts._\n\n---\n`);

    const posted = await gh.postReview(repo, number, reviewPayload, path.join(runDir, 'followup-review-posted.json'));
    if (!posted.ok) throw new Error(`Posting follow-up summary failed (${counts.replies} thread replies were posted): ${posted.error}`);
    log.info(`${key}: follow-up posted ${posted.url} (${counts.replies} thread replies)`);
    set({ status: 'done', dryRun: false, reviewedSha: sha, engine: usedEngine, followUp: counts, ...outcome, meta: result.meta, reviewUrl: posted.url, finishedAt: new Date().toISOString(), step: null, attemptsLog: attempts });
  }
}

/** Turn a GraphQL review thread into what the prompt and the poster need. */
function threadItem(t, i, worktree, sha) {
  const nodes = t.comments.nodes;
  const first = nodes[0];
  const line = t.line ?? t.originalLine ?? null;
  const outdated = !!t.isOutdated || t.line == null;
  let snippet, snippetNote;
  const file = path.join(worktree, t.path);
  if (!fs.existsSync(file)) {
    snippet = '(this file does not exist at HEAD - it was deleted or renamed)';
    snippetNote = 'file missing';
  } else {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const around = outdated ? 25 : 12;
    let from = 0, to = lines.length;
    if (line && lines.length > 2 * around + 1) { from = Math.max(0, line - 1 - around); to = Math.min(lines.length, line + around); }
    else if (!line && lines.length > 150) to = 150;
    snippet = lines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(5)} | ${l}`).join('\n');
    snippetNote = `lines ${from + 1}-${to} of ${lines.length}${outdated ? '; the comment is outdated, so line numbers may have shifted - read the file if needed' : ''}`;
  }
  return {
    id: `T${i + 1}`,
    path: t.path,
    line,
    outdated,
    resolved: !!t.isResolved,
    rootCommentId: first.databaseId,
    url: first.url,
    firstAuthor: first.author?.login || 'ghost',
    originalCommit: first.originalCommit?.oid || null,
    diffHunk: first.diffHunk || '',
    comments: nodes.map((c) => ({ author: c.author?.login || 'ghost', body: c.body || '' })),
    alreadyReplied: nodes.some((c) => (c.body || '').includes(replyMarker(sha))),
    snippet,
    snippetNote,
  };
}

function replyBody(verdict, engine, sha) {
  return `**Follow-up check: ${STATUS_LABEL[verdict.status]}** (as of \`${sha.slice(0, 7)}\`)\n\n${verdict.explanation}\n\n`
    + `<sub>Automated check by auto-pr-review using ${engine}. It does not resolve threads - please verify and resolve it yourself.</sub>\n${replyMarker(sha)}`;
}

const cell = (s, n = 220) => { s = String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(); return s.length > n ? s.slice(0, n) + '...' : s; };

function buildFollowUpBody({ summary, rows, unchecked, engine, sha, counts, retest }) {
  let body = `### Automated ${retest ? 're-test of all earlier' : 'follow-up on existing'} review comments\n\n${summary.trim()}\n\n`;
  body += `**${counts.threads} ${retest ? '' : 'open '}thread(s) checked:** ${counts.addressed} addressed, ${counts.partially_addressed} partially addressed, ${counts.not_addressed} not addressed, ${counts.not_applicable} no longer applicable${counts.notJudged ? `, ${counts.notJudged} not judged` : ''}.\n\n`;
  body += '| # | File | Comment by | Status | Note |\n|---|---|---|---|---|\n';
  rows.forEach((r, i) => {
    const where = `[\`${cell(r.path.split('/').pop(), 60)}${r.line ? `:${r.line}` : ''}\`](${r.url})`;
    body += `| ${i + 1} | ${where} | @${cell(r.firstAuthor, 40)} | ${r.verdict ? STATUS_LABEL[r.verdict.status] : 'Not judged'} | ${r.verdict ? cell(r.verdict.explanation) : '-'} |\n`;
  });
  if (unchecked.length) body += `\n_${unchecked.length} more open thread(s) were not checked (limit \`maxFollowUpThreads\`)._\n`;
  body += `\n---\n<sub>Generated automatically by auto-pr-review using ${engine} on ${sha.slice(0, 7)}. Only existing ${retest ? '' : 'open '}threads were checked (no new full review). Nothing was resolved, approved or rejected.</sub>\n`;
  body += `<!-- auto-pr-review sha=${sha} engine=${engine} mode=${retest ? 'retest' : 'followup'} -->`;
  return body;
}

function buildBody({ review, engine, sha, valid, invalid }) {
  const sev = valid.reduce((a, c) => ((a[c.severity] = (a[c.severity] || 0) + 1), a), {});
  const sevText = Object.entries(sev).map(([k, v]) => `${v} ${k}`).join(', ');
  let body = `### Automated review\n\n${review.summary.trim()}\n\n`;
  body += valid.length ? `**Inline comments:** ${valid.length} (${sevText})\n` : '**Inline comments:** none\n';
  if (invalid.length) {
    body += `\n<details><summary>Additional notes (${invalid.length}) that could not be attached to a diff line</summary>\n\n`;
    for (const c of invalid) body += `- **[${SEV_LABEL[c.severity]}]** \`${c.path}${Number.isFinite(c.line) ? `:${c.line}` : ''}\` - ${c.body.replace(/\n+/g, ' ')}\n`;
    body += '\n</details>\n';
  }
  body += `\n---\n<sub>Generated automatically by auto-pr-review using ${engine} on ${sha.slice(0, 7)}. This is a COMMENT review, not an approval. Please verify before acting.</sub>\n`;
  body += `<!-- auto-pr-review sha=${sha} engine=${engine} mode=full -->`;
  return body;
}
