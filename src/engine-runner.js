// Runs ONE engine job inside the (red) review window.
// Usage: node engine-runner.js <jobDir>
// Reads <jobDir>/job.json, runs the CLI, shows live progress, writes raw.jsonl / stderr.log / done.json.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractJson } from './engines.js';

const jobDir = process.argv[2];
const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
const PLAIN = process.env.AUTO_PR_REVIEW_PLAIN === '1' || !process.stdout.isTTY;
const RED = '\x1b[41m\x1b[97m';
const outLog = fs.createWriteStream(path.join(jobDir, 'output.log'));

function say(text = '') {
  for (const line of String(text).split(/\r?\n/)) {
    outLog.write(line + '\n');
    if (!PLAIN) process.stdout.write(`${RED}${line}\x1b[K\n`); // keep red background, fill rest of line
  }
}
const short = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '...' : s; };

if (!PLAIN) process.stdout.write(`${RED}\x1b[2J\x1b[H`);
say('==================================================================');
say(`  AUTO PR REVIEW  |  ${job.title}`);
say(`  Engine : ${job.engine.toUpperCase()}   (running automatically, no input needed)`);
say(`  Folder : ${job.cwd}`);
say(`  Started: ${new Date().toLocaleString()}`);
say('==================================================================');
say('');

const raw = fs.createWriteStream(path.join(jobDir, 'raw.jsonl'));
const errLog = fs.createWriteStream(path.join(jobDir, 'stderr.log'));

function show(ev) {
  if (job.engine === 'claude') {
    if (ev.type === 'system' && ev.subtype === 'init') say(`[claude] session started, model: ${ev.model || '?'}`);
    else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) say(`[claude] ${short(c.text, 400)}`);
        else if (c.type === 'tool_use') say(`  -> ${c.name} ${short(c.input?.file_path || c.input?.pattern || c.input?.command || JSON.stringify(c.input), 140)}`);
      }
    } else if (ev.type === 'result') {
      say('');
      say(`[claude] finished: ${ev.subtype}${ev.is_error ? ' (ERROR)' : ''}, turns ${ev.num_turns}, ${Math.round((ev.duration_ms || 0) / 1000)}s, cost $${(ev.total_cost_usd || 0).toFixed(3)}`);
      const n = (ev.structured_output?.comments || ev.structured_output?.threads)?.length;
      if (n != null) say(`[claude] review JSON received with ${n} item(s)`);
      if (ev.is_error) say(`[claude] ${short(ev.result, 600)}`);
    }
  } else {
    if (ev.type === 'text' && ev.part?.text) say(`[opencode] ${short(ev.part.text, 400)}`);
    else if (ev.type === 'tool_use') say(`  -> ${ev.part?.tool || 'tool'} ${short(JSON.stringify(ev.part?.state?.input || {}), 140)}`);
    else if (ev.type === 'step_finish') say(`[opencode] step finished (${ev.part?.tokens?.total ?? '?'} tokens)`);
    else if (ev.type === 'error') say(`[opencode] ERROR ${short(JSON.stringify(ev.error || ev), 600)}`);
  }
}

const deadline = Date.now() + (job.timeoutMs || 25 * 60_000);
let sessionId = null;
const texts = [];

function runOnce(args, stdinFile, until = deadline) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(job.bin, args, { cwd: job.cwd, env: { ...process.env, ...(job.env || {}) }, windowsHide: true });
    } catch (err) { resolve({ code: -1, error: String(err) }); return; }
    const timer = setTimeout(() => {
      say(until < deadline ? '[runner] time budget almost used - stopping investigation' : '[runner] TIMEOUT - killing engine');
      child.kill();
    }, Math.max(5_000, until - Date.now()));
    let buf = '';
    child.stdout.on('data', (d) => {
      raw.write(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev = null;
        try { ev = JSON.parse(line); } catch { say(short(line, 300)); continue; }
        if (ev.sessionID) sessionId = ev.sessionID;
        if (ev.type === 'text' && ev.part?.text) texts.push(ev.part.text);
        show(ev);
      }
    });
    child.stderr.on('data', (d) => { errLog.write(d); const t = String(d).trim(); if (t) say(`[stderr] ${short(t, 300)}`); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, error: String(err) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1 }); });
    if (stdinFile) fs.createReadStream(stdinFile).pipe(child.stdin);
    else child.stdin.end();
  });
}

(async () => {
  // With a continuation available, stop the first run at 75% of the budget so there is time left to get the answer.
  const soft = job.continueArgs ? Date.now() + Math.round((deadline - Date.now()) * 0.75) : deadline;
  let r = await runOnce(job.args, job.stdinFile, soft);
  // OpenCode sometimes ends (or is stopped) after tool calls without the final answer: ask once more in the same session.
  if (job.continueArgs && sessionId && !extractJson(texts.join('\n')) && Date.now() < deadline - 30_000) {
    say('');
    say('[runner] no JSON answer yet - asking the same session for the final review JSON');
    r = await runOnce([...job.continueArgs, '--session', sessionId], null);
  }
  finish(r.code, r.error);
})();

let finished = false;
function finish(code, error) {
  if (finished) return; finished = true;
  if (error) { say(`[runner] failed to start engine: ${error}`); errLog.write(error + '\n'); }
  say('');
  say(`==== ${job.engine} exited with code ${code} ====`);
  let pending = 3;
  const done = () => {
    if (--pending > 0) return;
    fs.writeFileSync(path.join(jobDir, 'done.json'), JSON.stringify({ exitCode: code, finishedAt: new Date().toISOString() }));
    process.exit(code === 0 ? 0 : 1);
  };
  raw.end(done); errLog.end(done); outLog.end(done);
}
