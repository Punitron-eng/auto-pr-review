// The tool's own clone + one git worktree per PR, under workspace/.
// It never touches the user's own working copies.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, run, runOk, safeName, log } from './util.js';

const GH_HELPER = '!gh auth git-credential';
const repoDir =(repo) => path.join(DIRS.workspace, 'repos', safeName(repo.replace('/', '__')));

async function ensureClone(repo) {
  const dir = repoDir(repo);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  log.info(`Cloning ${repo} into ${dir} (partial clone over HTTPS, first time only)...`);
  // HTTPS + `gh auth git-credential` works with the gh login alone (no SSH key needed).
  // The helper is configured only inside this clone; global git config is not touched.
  await runOk('git', ['-c', 'credential.helper=', '-c', `credential.helper=${GH_HELPER}`,
    'clone', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}.git`, dir], { timeoutMs: 30 * 60_000 });
  await runOk('git', ['config', '--local', '--replace-all', 'credential.helper', ''], { cwd: dir });
  await runOk('git', ['config', '--local', '--add', 'credential.helper', GH_HELPER], { cwd: dir });
  return dir;
}

/** Creates a detached worktree at the PR head. Returns {dir, baseRef}. */
export async function checkoutPr(repo, pr) {
  const clone = await ensureClone(repo);
  await runOk('git', ['fetch', '--no-tags', 'origin',
    `+refs/pull/${pr.number}/head:refs/remotes/pr/${pr.number}`,
    `+refs/heads/${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`], { cwd: clone, timeoutMs: 15 * 60_000 });
  const wt = worktreePath(repo, pr.number);
  await removeWorktree(repo, wt);
  await runOk('git', ['worktree', 'add', '--detach', '--force', wt, pr.headRefOid], { cwd: clone, timeoutMs: 15 * 60_000 });
  return { dir: wt, baseRef: `origin/${pr.baseRefName}` };
}

export const worktreePath = (repo, number) =>
  path.join(DIRS.workspace, 'worktrees', `${safeName(repo.replace('/', '__'))}__${number}`);

/** Fallback when `gh pr diff` fails (e.g. very large PRs). */
export async function localDiff(worktree, baseRef) {
  return runOk('git', ['diff', '--no-color', `${baseRef}...HEAD`], { cwd: worktree, timeoutMs: 5 * 60_000 });
}

export async function removeWorktree(repo, wt) {
  const clone = repoDir(repo);
  if (!fs.existsSync(wt)) return;
  await run('git', ['worktree', 'remove', '--force', wt], { cwd: clone });
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  await run('git', ['worktree', 'prune'], { cwd: clone });
}
