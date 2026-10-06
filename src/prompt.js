// Builds the review prompt. Tailored for the ITL Next.js App Router + TS + Zustand + TanStack Query repo,
// but generic enough for other repos (it tells the model to read the repo's own CLAUDE.md / AGENTS.md).

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Markdown summary of the PR and overall assessment (3-10 lines).' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repo root, exactly as in the diff' },
          line: { type: 'integer', description: 'Line number in the file (new file for RIGHT, old file for LEFT)' },
          side: { type: 'string', enum: ['RIGHT', 'LEFT'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          body: { type: 'string', description: 'Markdown comment: the problem, why it matters, and a concrete fix' },
        },
        required: ['path', 'line', 'side', 'severity', 'body'],
      },
    },
  },
  required: ['summary', 'comments'],
};

export function buildPrompt({ repo, pr, diff, maxDiffChars, maxComments, baseRef, projectRules }) {
  const truncated = diff.length > maxDiffChars;
  const diffText = truncated ? diff.slice(0, maxDiffChars) : diff;
  const rulesBlock = projectRules
    ? `\n## Project rules (from the team's CLAUDE.md - it is not committed to the repo, so it is included here)\nTreat these as review criteria:\n"""\n${projectRules.slice(0, 20000)}\n"""\n`
    : '';
  return `You are a senior reviewer doing an automated code review of a GitHub pull request.
You are running NON-INTERACTIVELY. Nobody will answer questions. Do not ask for anything; just review and output the JSON.

## Pull request
- Repository: ${repo}
- PR #${pr.number}: ${pr.title}
- Author: ${pr.author?.login || 'unknown'}
- Base branch: ${pr.baseRefName}  |  Head: ${pr.headRefName} @ ${pr.headRefOid}
- URL: ${pr.url}

PR description:
"""
${(pr.body || '(no description)').slice(0, 4000)}
"""

## Your environment
- The current working directory is a checkout of the PR head commit. You may READ files for context (Read, Grep, Glob).
- Stay focused on the changed code: use at most about 40 tool calls in total, then write your answer. Do not explore unrelated docs or folders.
- If allowed, you may run read-only git commands (git diff ${baseRef}...HEAD, git log, git show, git blame). Never modify files, never commit, never push, never call GitHub.
- FIRST read the repository's CLAUDE.md (and AGENTS.md if present) in the repo root, if they exist, and apply their project rules and "lessons" as review criteria.
${rulesBlock}
## Stack and what to look for
This is (most likely) a Next.js App Router + TypeScript app using Zustand v5, TanStack Query, Tailwind CSS.
Focus on REAL problems a careful senior engineer would block or flag:
- Correctness bugs, wrong conditions, broken edge cases (empty/null/undefined data, off-by-one, wrong field names vs the API).
- React issues: stale closures, missing/incorrect hook dependencies, hooks called conditionally, state updates in render, effects that loop.
- Zustand: NEVER using the whole store (\`useXxxStore()\` without a selector) inside useEffect/useCallback/useMemo dependency arrays (causes infinite re-render loops). Reads should use selectors; writes/actions inside effects/handlers should use \`useXxxStore.getState()\`.
- Unstable references passed into hooks/config objects (inline functions/objects in deps) that cause re-render cascades.
- TanStack Query: wrong/unstable query keys, missing \`enabled\` guards, not invalidating after mutations, data used before it is loaded.
- Next.js App Router: "use client" boundaries, server/client misuse, accessing window/localStorage during SSR, routing/searchParams mistakes.
- API layer: wrong payloads, missing error handling, AbortSignal not passed through, leaking secrets/tokens, unsafe HTML (XSS).
- Access-rights / permission checks that were dropped or use the wrong module/tab key.
- Type-safety holes that hide bugs (\`any\`, unchecked casts, non-null assertions on possibly-missing data).
- Leftover debug code (console.log with sensitive data, commented-out logic that changes behaviour, hard-coded test values).
DO NOT comment on pure style, formatting, naming preferences, or import order. No praise-only comments. If the PR looks fine, return zero comments.

## This is the ONLY full review this PR will get (important)
The tool never runs a second full review on this PR. Later runs only check whether THESE comments were fixed; they
never raise new issues. So the author must get the COMPLETE list now, in one go:
- Go through EVERY changed file and every hunk before answering. Do not stop after the first few findings.
- Report every real problem you find now, including medium and low ones. Do not hold anything back for "a later round".
- If the same problem repeats in several places, add one comment per place (or one comment listing all the lines).
- Do not add things you are not fairly sure about just to look complete - but anything you would flag later, flag now.

## Output rules (strict)
- Return every real finding, most important first, up to ${maxComments} comments. If you truly have more, merge related ones so nothing is lost.
- Each comment must point at a line that is part of the diff below: use \`side: "RIGHT"\` and the NEW-file line number for added/context lines; use \`side: "LEFT"\` and the OLD-file line number only for removed lines.
- \`path\` must be exactly the file path as shown in the diff (no "a/" or "b/" prefix).
- \`severity\`: critical (will break prod / security), high (real bug), medium (likely bug or risky pattern), low (minor but worth fixing).
- \`body\`: concise Markdown. State the problem, why it matters, and a concrete fix (a small code suggestion is welcome).
- \`summary\`: 3-10 lines of Markdown: what the PR does, overall risk, and the top concerns. Mention anything important you could not anchor to a line. State that this is the complete list of requested changes.
- Your FINAL message must be ONLY a single JSON object, no prose, no code fences:
{"summary": "...", "comments": [{"path": "...", "line": 123, "side": "RIGHT", "severity": "high", "body": "..."}]}

## Diff (${pr.headRefOid.slice(0, 7)} vs ${pr.baseRefName})${truncated ? `\nNOTE: the diff was truncated to ${maxDiffChars} characters. Use \`git diff ${baseRef}...HEAD -- <path>\` to see the rest if you can.` : ''}
\`\`\`diff
${diffText}
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Follow-up mode: the PR already has review comments -> only check whether those were addressed.
export const FOLLOWUP_STATUSES = ['addressed', 'partially_addressed', 'not_addressed', 'not_applicable'];

export const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Markdown, 2-6 lines: overall state of the earlier review feedback.' },
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Thread id exactly as given, e.g. "T3"' },
          status: { type: 'string', enum: FOLLOWUP_STATUSES },
          explanation: { type: 'string', description: '1-3 sentences: what the code at HEAD does now and why that counts as this status.' },
        },
        required: ['id', 'status', 'explanation'],
      },
    },
  },
  required: ['summary', 'threads'],
};

export const FOLLOWUP_FINAL_SHAPE = '{"summary": ..., "threads": [{"id": "T1", "status": ..., "explanation": ...}]}';

/** threads = [{id, path, line, outdated, originalCommit, diffHunk, comments:[{author, body}], snippet}] */
export function buildFollowUpPrompt({ repo, pr, threads, baseRef, projectRules, retest = false }) {
  const rulesBlock = projectRules
    ? `\n## Project rules (team CLAUDE.md, for context only)\n"""\n${projectRules.slice(0, 12000)}\n"""\n`
    : '';
  const blocks = threads.map((t) => {
    const convo = t.comments.map((c, i) => `${i === 0 ? 'Comment' : 'Reply'} by @${c.author}:\n${c.body.replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 3000)}`).join('\n\n');
    return `### ${t.id} - \`${t.path}\`${t.line ? ` line ${t.line}` : ''}${t.outdated ? ' (OUTDATED: the code this comment was on has changed since)' : ''}${t.resolved ? ' (marked RESOLVED on GitHub - verify the fix really is in the code)' : ''}
Comment was made on commit ${t.originalCommit ? t.originalCommit.slice(0, 12) : 'unknown'}. Code it was attached to at that time:
\`\`\`diff
${(t.diffHunk || '(not available)').slice(-2500)}
\`\`\`

${convo}

Current code at HEAD (${t.snippetNote}):
\`\`\`
${t.snippet}
\`\`\``;
  }).join('\n\n---\n\n');

  return `You are a senior reviewer doing an automated FOLLOW-UP check on a GitHub pull request.
You are running NON-INTERACTIVELY. Nobody will answer questions. Do not ask for anything; just check and output the JSON.

The PR already has review comments. Do NOT do a new full review and do NOT raise new issues.
Your only job: for each ${retest ? '' : 'open '}review thread below, decide whether the CURRENT code at HEAD addresses it.
${retest ? 'This is a RE-TEST requested by the reviewer: every earlier thread is included, also the ones marked resolved, to confirm the fixes are real.\n' : ''}
## Pull request
- Repository: ${repo}
- PR #${pr.number}: ${pr.title}
- Author: ${pr.author?.login || 'unknown'}
- Base branch: ${pr.baseRefName}  |  Head: ${pr.headRefName} @ ${pr.headRefOid}

## Your environment
- The current working directory is a checkout of the PR head commit. You may READ files (Read, Grep, Glob) to verify.
- If allowed, you may run read-only git commands, e.g. \`git diff <comment-commit>..HEAD -- <path>\`, \`git log\`, \`git show\`, \`git diff ${baseRef}...HEAD -- <path>\`.
  Never modify files, never commit, never push, never call GitHub.
- Use at most about 20 tool calls in total, then answer.
${rulesBlock}
## How to judge each thread
- \`addressed\`: the code at HEAD fixes what the comment asked for (or does something equivalent that removes the problem).
- \`partially_addressed\`: some of it is fixed, something important is still missing - say what.
- \`not_addressed\`: the problem is still there at HEAD. If the author replied with a reason not to change it, judge whether the reason holds and say so.
- \`not_applicable\`: the comment no longer applies (the code was removed or rewritten so the concern is moot), it was only a question or FYI that has been answered, or it is not something code can address.
- Base your verdict on the code at HEAD, not on replies like "done" alone. Be specific and short.

## Output rules (strict)
- Return one entry for EVERY thread id listed below (${threads.map((t) => t.id).join(', ')}).
- \`explanation\`: 1-3 sentences, plain Markdown, mention the file/line or code you checked.
- \`summary\`: 2-6 lines: how many are fixed, what is still open and most important.
- Your FINAL message must be ONLY a single JSON object, no prose, no code fences:
${FOLLOWUP_FINAL_SHAPE}

## ${retest ? 'Review threads to re-test' : 'Open review threads'} (${threads.length})

${blocks}
`;
}
