// Persistent JSON state: one entry per PR (repo#number) plus poll metadata.
// Statuses: pending -> running -> done | failed | skipped
import path from 'node:path';
import { DIRS, readJson, writeJsonAtomic } from './util.js';

export class State {
  constructor(dryRun) {
    this.file = path.join(DIRS.data, dryRun ? 'state.dry-run.json' : 'state.json');
    this.data = readJson(this.file, null) || { prs: {}, meta: {} };
    this.data.prs ||= {};
    this.data.meta ||= {};
    // A crash/restart mid-review: put interrupted jobs back in the queue.
    for (const pr of Object.values(this.data.prs)) {
      if (pr.status === 'running') { pr.status = 'pending'; pr.engine = null; pr.startedAt = null; }
    }
    this.save();
  }
  save() { writeJsonAtomic(this.file, this.data); }
  key(repo, number) { return `${repo}#${number}`; }
  get(repo, number) { return this.data.prs[this.key(repo, number)]; }
  upsert(repo, number, patch) {
    const k = this.key(repo, number);
    this.data.prs[k] = { ...(this.data.prs[k] || { repo, number, history: [] }), ...patch };
    this.save();
    return this.data.prs[k];
  }
  all() { return Object.values(this.data.prs); }
  meta(patch) { if (patch) { Object.assign(this.data.meta, patch); this.save(); } return this.data.meta; }
}
