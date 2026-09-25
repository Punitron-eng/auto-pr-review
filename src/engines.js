// Engine definitions: how to launch Claude Code / OpenCode headlessly and how to read their output.
import fs from 'node:fs';
import { resolveExecutable } from './util.js';
import { REVIEW_SCHEMA, FOLLOWUP_SCHEMA, FOLLOWUP_FINAL_SHAPE } from './prompt.js';

const KINDS = {
  full: { schema: REVIEW_SCHEMA, shape: '{"summary": ..., "comments": [...]}', listKey: 'comments' },
  followup: { schema: FOLLOWUP_SCHEMA, shape: FOLLOWUP_FINAL_SHAPE, listKey: 'threads' },
};

// Text that means "this engine is busy / out of quota right now" -> fall back to the next engine.
const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|hit your limit|limit will reset|resets at|quota|too many requests|\b429\b|\b529\b|overloaded|credit balance is too low|out of credits/i;

/**
 * Build the job spec that engine-runner.js executes (inside the red window).
 * ctx = { cwd, promptFile, title, kind: 'full' | 'followup' }
 */
export function buildJob(engine, cfg, ctx) {
  const ecfg = cfg.engines?.[engine] || {};
  const kind = KINDS[ctx.kind || 'full'];
  if (engine === 'claude') {
    const bin = resolveExecutable('claude', ecfg.command);
    if (!bin) return { error: 'claude executable not found on PATH' };
    const tools = ['Read', 'Grep', 'Glob'];
    const allowed = ['Read', 'Grep', 'Glob'];
    if (ecfg.allowGitBash !== false) {
      tools.push('Bash');
      allowed.push('Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git status:*)');
    }
    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(kind.schema),
      '--tools', tools.join(','),
      '--allowedTools', ...allowed,
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(gh:*)',
      // dontAsk = anything not pre-approved above is denied automatically (never waits for a human).
      '--permission-mode', 'dontAsk',
      // Ignore user/project settings files (user hooks, prompt routers, broad allow rules, PR-supplied .claude/settings.json).
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--name', `auto-pr-review ${ctx.title || ''}`.trim(),
    ];
    if (ecfg.model) args.push('--model', ecfg.model);
    if (ecfg.effort) args.push('--effort', ecfg.effort);
    if (ecfg.maxBudgetUsd > 0) args.push('--max-budget-usd', String(ecfg.maxBudgetUsd));
    return { engine, bin, args, cwd: ctx.cwd, stdinFile: ctx.promptFile, env: {} };
  }

  if (engine === 'opencode') {
    const bin = resolveExecutable('opencode', ecfg.command);
    if (!bin) return { error: 'opencode executable not found on PATH' };
    const args = [
      'run',
      'Read the attached review instructions file and follow them exactly. Your final message must be only the JSON object.',
      '--format', 'json',
      '--dir', ctx.cwd,
      '--title', `auto-pr-review ${ctx.title || ''}`.trim(),
    ];
    if (ecfg.model) args.push('--model', ecfg.model);
    args.push('-f', ctx.promptFile); // keep -f last: it is an array option and would swallow positionals
    // Read-only permissions. Everything is allow/deny (never "ask"): an auto-rejected "ask" ends an
    // opencode run early, while a configured "deny" just fails that one tool call and the model continues.
    const permission = {
      edit: 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
      bash: { '*': 'deny', 'git diff*': 'allow', 'git log*': 'allow', 'git show*': 'allow', 'git blame*': 'allow', 'git status*': 'allow' },
    };
    // Switch off MCP servers from the user's global opencode config (e.g. itl-context shared memory).
    const mcp = {}, tools = {};
    for (const name of ecfg.disableMcp || []) {
      mcp[name] = { type: 'local', command: ['node'], enabled: false };
      tools[`${name}*`] = false;
    }
    const config = JSON.stringify({ permission, mcp, tools });
    const continueArgs = ['run', `Stop investigating now. Reply with ONLY the final JSON object ${kind.shape} as specified in the instructions file. No prose, no code fences.`,
      '--format', 'json', '--dir', ctx.cwd];
    if (ecfg.model) continueArgs.push('--model', ecfg.model);
    return { engine, bin, args, cwd: ctx.cwd, env: { OPENCODE_CONFIG_CONTENT: config }, continueArgs };
  }
  return { error: `unknown engine ${engine}` };
}

/** Pull the first JSON object with a "summary" key out of free text. */
export function extractJson(text) {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { const o = JSON.parse(t); if (o && typeof o === 'object') return o; } catch { /* continue */ }
  const starts = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '{') starts.push(i);
  for (const s of starts) {
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < text.length; i++) {
      const ch = text[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { const o = JSON.parse(text.slice(s, i + 1)); if (o && 'summary' in o) return o; } catch { /* next */ }
        break;
      }
    }
  }
  return null;
}

/** Read engine output files and produce {ok, review, error, limitHit, meta}. */
export function parseResult(engine, { rawFile, stderrFile, exitCode, kind = 'full' }) {
  const listKey = KINDS[kind].listKey;
  const raw = fs.existsSync(rawFile) ? fs.readFileSync(rawFile, 'utf8') : '';
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '';
  const events = [];
  for (const l of raw.split(/\r?\n/)) { if (l.trim().startsWith('{')) { try { events.push(JSON.parse(l)); } catch { /* skip */ } } }
  const meta = {};
  let review = null, errorText = '';

  if (engine === 'claude') {
    const res = [...events].reverse().find((e) => e.type === 'result');
    if (res) {
      meta.costUsd = res.total_cost_usd; meta.turns = res.num_turns; meta.durationMs = res.duration_ms;
      if (!res.is_error) review = res.structured_output || extractJson(res.result);
      else errorText = `${res.subtype || 'error'}: ${res.result || ''} ${res.api_error_status || ''}`;
    } else {
      errorText = 'no result event from claude';
    }
  } else {
    const texts = events.filter((e) => e.type === 'text' && e.part?.text).map((e) => e.part.text);
    const errs = events.filter((e) => e.type === 'error' || e.error).map((e) => JSON.stringify(e.error || e));
    for (let i = texts.length - 1; i >= 0 && !review; i--) review = extractJson(texts[i]);
    if (!review) review = extractJson(texts.join('\n'));
    if (!review) errorText = errs.join('; ') || 'no JSON review found in opencode output';
    const fin = events.filter((e) => e.type === 'step_finish');
    meta.tokens = fin.reduce((a, e) => a + (e.part?.tokens?.total || 0), 0);
  }

  if (review && (typeof review.summary !== 'string' || !Array.isArray(review[listKey]))) {
    errorText = `JSON did not match {summary, ${listKey}[]}`;
    review = null;
  }
  if (!review && exitCode !== 0) errorText = `${errorText} (exit ${exitCode}) ${stderr.slice(-800)}`.trim();
  const limitHit = !review && LIMIT_RE.test(`${errorText}\n${stderr.slice(-4000)}`);
  return { ok: !!review, review, error: errorText, limitHit, meta };
}
