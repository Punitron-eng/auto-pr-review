// Unified-diff parsing and inline-comment validation against the PR diff.

/** Returns Map(path -> {right:Set<line>, left:Set<line>}) of lines GitHub allows comments on. */
export function parseDiff(diffText) {
  const files = new Map();
  let cur = null, left = 0, right = 0, inHunk = false;
  for (const raw of diffText.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = { right: new Set(), left: new Set() };
      if (m) files.set(m[2], cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk && line.startsWith('+++ ')) {
      // Re-key on the real new path (handles renames).
      const p = line.slice(4).replace(/^b\//, '');
      if (p !== '/dev/null' && !files.has(p)) {
        for (const [k, v] of files) if (v === cur) files.delete(k);
        files.set(p, cur);
      }
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) continue;
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { left = +h[1]; right = +h[2]; inHunk = true; continue; }
    if (!inHunk) continue;
    const c = line[0];
    if (c === ' ') { cur.left.add(left++); cur.right.add(right++); }
    else if (c === '-') { cur.left.add(left++); }
    else if (c === '+') { cur.right.add(right++); }
    else if (c === '\\') { /* "\ No newline at end of file" */ }
    else inHunk = false;
  }
  return files;
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
export const normPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, '');

/**
 * Split model comments into valid inline comments and "unanchored" ones.
 * If the side is wrong but the other side has that line, the side is corrected.
 */
export function validateComments(comments, diffFiles, maxInline) {
  const valid = [], invalid = [];
  const list = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && typeof c.body === 'string' && c.body.trim())
    .map((c) => {
      const sev = String(c.severity || '').toLowerCase();
      return {
        path: normPath(c.path),
        line: Number.parseInt(c.line, 10),
        side: String(c.side || 'RIGHT').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
        severity: sev in SEV_ORDER ? sev : 'medium',
        body: c.body.trim(),
      };
    })
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  for (const c of list) {
    const f = diffFiles.get(c.path);
    let ok = false;
    if (f && Number.isFinite(c.line)) {
      if (f[c.side.toLowerCase()].has(c.line)) ok = true;
      else {
        const other = c.side === 'RIGHT' ? 'LEFT' : 'RIGHT';
        if (f[other.toLowerCase()].has(c.line)) { c.side = other; ok = true; }
      }
    }
    if (ok && valid.length < maxInline) valid.push(c);
    else invalid.push({ ...c, reason: !f ? 'file not in diff' : ok ? 'over inline comment cap' : 'line not in diff' });
  }
  return { valid, invalid };
}
