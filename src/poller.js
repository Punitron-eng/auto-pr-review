// Polls GitHub for open PRs assigned to / awaiting review from the authenticated user and queues them.
import { log } from './util.js';
import * as gh from './gh.js';

export async function poll({ cfg, state }) {
  const started = new Date().toISOString();
  const me = await gh.currentLogin();
  const filtered = [];
  let found = 0, queued = 0;
  const errors = [];

  for (const repo of cfg.repos) {
    const seen = new Map();
    let repoOk = true;
    for (const q of cfg.searchQueries) {
      try {
        for (const pr of await gh.listPrs(repo, q)) {
          const e = seen.get(pr.number) || { ...pr, matchedBy: [] };
          e.matchedBy.push(q);
          seen.set(pr.number, e);
        }
      } catch (err) {
        repoOk = false;
        errors.push(`${repo} [${q}]: ${err.message.slice(0, 300)}`);
      }
    }

    for (const pr of seen.values()) {
      if (cfg.skipDrafts && pr.isDraft) { filtered.push({ repo, number: pr.number, title: pr.title, reason: 'draft' }); continue; }
      if (cfg.skipOwnPrs && pr.author?.login?.toLowerCase() === me.toLowerCase()) { filtered.push({ repo, number: pr.number, title: pr.title, reason: 'your own PR' }); continue; }
      found++;
      const cur = state.get(repo, pr.number);
      const base = { title: pr.title, url: pr.url, author: pr.author?.login, matchedBy: pr.matchedBy };
      const enqueue = () => {
        queued++;
        state.upsert(repo, pr.number, { ...base, sha: pr.headRefOid, status: 'pending', queuedAt: new Date().toISOString(), attempts: 0, error: null, skipReason: null, nextRetryAt: null, reviewUrl: null, counts: null });
        log.info(`Queued ${repo}#${pr.number} @ ${pr.headRefOid.slice(0, 7)} - ${pr.title}`);
      };
      if (!cur) { enqueue(); continue; }
      if (cur.status === 'running') continue; // re-evaluated on the next poll once it finishes
      if (cur.status === 'pending') { state.upsert(repo, pr.number, { ...base, sha: pr.headRefOid }); continue; }
      if (cur.status === 'skipped' && cur.skipReason === 'no longer assigned/open') { enqueue(); continue; }
      const newCommits = cur.sha !== pr.headRefOid;
      if (newCommits && (cfg.reviewNewCommits || cur.status === 'failed' || cur.status === 'skipped')) enqueue();
      else state.upsert(repo, pr.number, base);
    }

    // Queued PRs that no longer match (unassigned, closed, merged) are dropped from the queue.
    if (repoOk) {
      for (const p of state.all()) {
        if (p.repo === repo && p.status === 'pending' && !p.manual && !seen.has(p.number)) {
          state.upsert(repo, p.number, { status: 'skipped', skipReason: 'no longer assigned/open', finishedAt: new Date().toISOString() });
        }
      }
    }
  }

  state.meta({ lastPollAt: started, lastPollError: errors.join('\n') || null, lastPollFound: found, lastPollFiltered: filtered, login: me });
  if (errors.length) log.warn(`Poll finished with errors: ${errors.join(' | ')}`);
  else log.info(`Poll done: ${found} matching PR(s), ${queued} newly queued, ${filtered.length} filtered`);
  return { found, queued };
}
