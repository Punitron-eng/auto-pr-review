#!/usr/bin/env node
// auto-pr-review entry point: poller + worker + dashboard in one process.
//
//   node src/index.js                 live mode (posts COMMENT reviews to GitHub)
//   node src/index.js --dry-run       everything except posting (review JSON saved under runs/)
//   node src/index.js --once          poll once, review the queue, then exit
//   node src/index.js --pr 1402       review one PR now (first configured repo), then exit
//   node src/index.js --pr owner/repo#1402
//   node src/index.js --dashboard-only
//   node src/index.js --no-dashboard
import { loadConfig } from './config.js';
import { State } from './state.js';
import { Worker } from './worker.js';
import { poll } from './poller.js';
import { startDashboard } from './dashboard.js';
import { log, run } from './util.js';
import * as gh from './gh.js';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const cfg = loadConfig();
const dryRun = flag('--dry-run');
const once = flag('--once');
const prArg = opt('--pr');
const state = new State(dryRun);
const worker = new Worker({ cfg, state, dryRun });
const startedAt = new Date().toISOString();
let nextPollAt = null, polling = false;

function getStatus() {
  const prs = state.all();
  const count = (s) => prs.filter((p) => p.status === s).length;
  const meta = state.meta();
  return {
    mode: dryRun ? 'dry-run' : 'live',
    startedAt, now: new Date().toISOString(),
    repos: cfg.repos, queries: cfg.searchQueries, pollIntervalMinutes: cfg.pollIntervalMinutes,
    login: meta.login, lastPollAt: meta.lastPollAt, lastPollError: meta.lastPollError, nextPollAt, polling,
    filtered: meta.lastPollFiltered || [],
    cooldowns: meta.cooldowns || {},
    counts: { running: count('running'), pending: count('pending'), done: count('done'), failed: count('failed'), skipped: count('skipped') },
    running: prs.filter((p) => p.status === 'running'),
    pending: prs.filter((p) => p.status === 'pending').sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt)),
    recent: prs.filter((p) => ['done', 'failed', 'skipped'].includes(p.status))
      .sort((a, b) => Date.parse(b.finishedAt || 0) - Date.parse(a.finishedAt || 0)).slice(0, 50),
  };
}

async function doPoll() {
  if (polling) return;
  polling = true;
  try { await poll({ cfg, state }); }
  catch (err) { log.error('Poll failed:', err.message); state.meta({ lastPollAt: new Date().toISOString(), lastPollError: err.message }); }
  finally { polling = false; }
  worker.tick();
}

async function preflight() {
  const a = await run('gh', ['auth', 'status']);
  if (a.code !== 0) { log.error('gh is not logged in. Run: gh auth login'); process.exit(1); }
  log.info(`GitHub login: ${await gh.currentLogin()} | repos: ${cfg.repos.join(', ')} | mode: ${dryRun ? 'DRY-RUN (nothing is posted)' : 'LIVE (posts COMMENT reviews)'}`);
}

async function main() {
  if (!flag('--no-dashboard')) startDashboard({ cfg, getStatus, pollNow: () => { doPoll(); } });
  if (flag('--dashboard-only')) return;
  await preflight();

  if (prArg) {
    const m = prArg.match(/^(?:([\w.-]+\/[\w.-]+)#)?(\d+)$/);
    if (!m) { log.error('--pr expects 123 or owner/repo#123'); process.exit(1); }
    const repo = m[1] || cfg.repos[0];
    const number = Number(m[2]);
    const pr = await gh.viewPr(repo, number);
    state.upsert(repo, number, { title: pr.title, url: pr.url, author: pr.author?.login, sha: pr.headRefOid, status: 'pending', manual: true, queuedAt: new Date().toISOString(), attempts: cfg.maxAttempts - 1, error: null, nextRetryAt: null });
    worker.onIdle = () => { log.info('Single PR review finished.'); setTimeout(() => process.exit(0), 500); };
    worker.tick();
    return;
  }

  if (once) {
    await doPoll();
    if (worker.runningCount() === 0) { log.info('Nothing to review.'); process.exit(0); }
    worker.onIdle = () => {
      if (state.all().some((p) => p.status === 'pending' && !p.nextRetryAt)) return worker.tick();
      log.info('Queue drained.'); setTimeout(() => process.exit(0), 500);
    };
    return;
  }

  const intervalMs = Math.max(0.5, cfg.pollIntervalMinutes) * 60_000;
  const loop = async () => {
    await doPoll();
    nextPollAt = new Date(Date.now() + intervalMs).toISOString();
    setTimeout(loop, intervalMs);
  };
  loop();
  setInterval(() => worker.tick(), 30_000); // picks up retries whose backoff has expired
}

process.on('SIGINT', () => { log.info('Stopping (in-flight review windows keep running and will be re-queued on next start).'); process.exit(0); });
main().catch((err) => { log.error(err); process.exit(1); });
