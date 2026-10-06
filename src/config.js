// Loads config.json, optionally overlaid by config.local.json (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.js';

const DEFAULTS = {
  repos: [],
  searchQueries: ['review-requested:@me', 'assignee:@me'],
  projectRulesFiles: {},
  pollIntervalMinutes: 2,
  concurrency: 1,
  reviewNewCommits: true,
  existingCommentsMode: 'review-existing-only', // or 'full' = always do a fresh full review
  maxFollowUpThreads: 30,
  singleFullReview: true, // after the first full review only follow-ups run; a new full review only from the dashboard
  skipDrafts: true,
  skipOwnPrs: true,
  maxAttempts: 2,
  reviewTimeoutMinutes: 25,
  maxInlineComments: 40,
  maxDiffChars: 200000,
  engineOrder: ['claude', 'opencode'],
  engines: { claude: { maxParallel: 1 }, opencode: { maxParallel: 1 } },
  fallbackOnAnyError: true,
  window: { mode: 'wt', tabColor: '#C00000', closeAfterSeconds: 15 },
  keepWorktrees: false,
  dashboard: { host: '127.0.0.1', port: 4545 },
};

function merge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b === undefined ? a : b;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
}

function readConfigFile(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`Invalid JSON in ${file}: ${err.message} (tip: write Windows paths with / or \\\\)`); }
}

export function loadConfig() {
  const base = readConfigFile(path.join(ROOT, 'config.json'));
  const local = readConfigFile(path.join(ROOT, 'config.local.json'));
  return merge(merge(DEFAULTS, base), local);
}
