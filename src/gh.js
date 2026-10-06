// Thin wrappers around the GitHub CLI (gh). Uses the user's existing `gh auth login`.
import fs from 'node:fs';
import { run, runOk } from './util.js';

let cachedLogin = null;
export async function currentLogin() {
  if (!cachedLogin) cachedLogin = (await runOk('gh', ['api', 'user', '--jq', '.login'])).trim();
  return cachedLogin;
}

const PR_FIELDS = 'number,title,url,headRefOid,headRefName,baseRefName,isDraft,author,state';

/** Open PRs in `repo` matching a GitHub search qualifier such as "review-requested:@me". */
export async function listPrs(repo, query) {
  const out = await runOk('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--search', query, '--limit', '100', '--json', PR_FIELDS]);
  return JSON.parse(out || '[]');
}

export async function viewPr(repo, number) {
  return JSON.parse(await runOk('gh', ['pr', 'view', String(number), '-R', repo, '--json', PR_FIELDS + ',body,additions,deletions,changedFiles']));
}

export async function prDiff(repo, number) {
  const r = await run('gh', ['pr', 'diff', String(number), '-R', repo], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  return { ok: true, diff: r.stdout };
}

/** All reviews on the PR that carry our marker: [{sha, mode}] (mode = full | followup | retest). */
export async function markerReviews(repo, number) {
  const out = await runOk('gh', ['api', '--paginate', `repos/${repo}/pulls/${number}/reviews`, '--jq', '.[].body']);
  return [...out.matchAll(/<!-- auto-pr-review sha=([0-9a-f]+)(?: engine=\S+)?(?: mode=(\w+))? -->/g)]
    .map((m) => ({ sha: m[1], mode: m[2] || 'full' }));
}

/** Post one review (event COMMENT). payload = {commit_id, body, event, comments}. */
export async function postReview(repo, number, payload, payloadFile) {
  if (payload.event !== 'COMMENT') throw new Error('Refusing to post a review whose event is not COMMENT');
  fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2));
  const r = await run('gh', ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', payloadFile]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  const res = JSON.parse(r.stdout);
  return { ok: true, id: res.id, url: res.html_url };
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:50, after:$after){
      pageInfo{ hasNextPage endCursor }
      nodes{ id isResolved isOutdated path line originalLine startLine diffSide
        comments(first:50){ nodes{ databaseId url author{login} body createdAt diffHunk originalCommit{oid} } } }
    } } } }`;

/** All review threads of a PR (GraphQL, so we get isResolved / isOutdated). */
export async function reviewThreads(repo, number) {
  const [owner, name] = repo.split('/');
  const threads = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const args = ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`];
    if (after) args.push('-F', `after=${after}`);
    const res = JSON.parse(await runOk('gh', args));
    const rt = res.data.repository.pullRequest.reviewThreads;
    threads.push(...rt.nodes);
    if (!rt.pageInfo.hasNextPage) break;
    after = rt.pageInfo.endCursor;
  }
  return threads;
}

/** Reply inside an existing review thread. commentId = databaseId of the thread's first comment. */
export async function postReply(repo, number, commentId, body) {
  const r = await run('gh', ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, '-f', `body=${body}`]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  const res = JSON.parse(r.stdout);
  return { ok: true, id: res.id, url: res.html_url };
}

/** APPROVE the PR at `sha`. Only ever called from the dashboard's Accept button (a human click). */
export async function approvePr(repo, number, sha, body) {
  const r = await run('gh', ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${sha}`, '-f', `body=${body}`]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  const res = JSON.parse(r.stdout);
  return { ok: true, id: res.id, url: res.html_url };
}

/** Current lifecycle state of a PR: {state: OPEN|CLOSED|MERGED, mergedAt, closedAt, mergedBy}. */
export async function prState(repo, number) {
  const p = JSON.parse(await runOk('gh', ['pr', 'view', String(number), '-R', repo, '--json', 'state,mergedAt,closedAt,mergedBy']));
  return { state: p.state, mergedAt: p.mergedAt || null, closedAt: p.closedAt || null, mergedBy: p.mergedBy?.login || null };
}
