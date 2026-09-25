// Launches an engine job in its own visible RED terminal window and waits for it to finish.
// Modes: "wt" (Windows Terminal tab, red tab + red background), "powershell" (classic console, DarkRed),
// "hidden" (no window; for debugging). Falls back wt -> powershell -> hidden automatically.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log, resolveExecutable, run, sleep } from './util.js';

const PS1 = path.join(ROOT, 'scripts', 'review-window.ps1');
const RUNNER = path.join(ROOT, 'src', 'engine-runner.js');

function psArgs(jobDir, title, closeAfter) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
    '-JobDir', jobDir, '-Title', title, '-Node', process.execPath, '-CloseAfter', String(closeAfter)];
}

async function waitForFile(file, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fs.existsSync(file)) return true; await sleep(500); }
  return false;
}

function launchWt(jobDir, title, wcfg) {
  const wt = resolveExecutable('wt');
  if (!wt) throw new Error('wt.exe not found');
  // ';' is a command separator for wt, keep it out of the title.
  const safeTitle = title.replace(/;/g, ',');
  const child = spawn(wt, ['-w', 'new', 'new-tab', '--title', safeTitle, '--tabColor', wcfg.tabColor || '#C00000',
    '--suppressApplicationTitle', 'powershell.exe', ...psArgs(jobDir, safeTitle, wcfg.closeAfterSeconds ?? 15)],
  { detached: true, stdio: 'ignore' });
  child.unref();
}

function launchPowershell(jobDir, title, wcfg) {
  // detached:true on Windows gives the child its own new console window.
  const child = spawn('powershell.exe', psArgs(jobDir, title.replace(/;/g, ','), wcfg.closeAfterSeconds ?? 15),
    { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/**
 * Runs the job in jobDir. Returns {exitCode, mode, timedOut}.
 */
export async function runJobInWindow(jobDir, title, wcfg, timeoutMs) {
  const exitFile = path.join(jobDir, 'exitcode.txt');
  const doneFile = path.join(jobDir, 'done.json');
  const pidFile = path.join(jobDir, 'pid.txt');
  const modes = { wt: ['wt', 'powershell', 'hidden'], powershell: ['powershell', 'hidden'], hidden: ['hidden'] }[wcfg.mode || 'wt'] || ['wt', 'powershell', 'hidden'];

  for (const mode of modes) {
    if (mode === 'hidden') {
      const r = await run(process.execPath, [RUNNER, jobDir], { timeoutMs: timeoutMs + 60_000, env: { AUTO_PR_REVIEW_PLAIN: '1' } });
      return { exitCode: r.code, mode, timedOut: false };
    }
    try {
      if (mode === 'wt') launchWt(jobDir, title, wcfg); else launchPowershell(jobDir, title, wcfg);
    } catch (err) {
      log.warn(`Could not open ${mode} window: ${err.message}`);
      continue;
    }
    if (!(await waitForFile(pidFile, 30_000))) {
      log.warn(`${mode} window did not start within 30s, trying next mode`);
      continue;
    }
    log.info(`Review window opened (${mode}): ${title}`);
    // The runner has its own engine timeout; give it a margin before we kill the window.
    const end = Date.now() + timeoutMs + 90_000;
    while (Date.now() < end && !fs.existsSync(doneFile) && !fs.existsSync(exitFile)) await sleep(1000);
    if (fs.existsSync(doneFile)) {
      return { exitCode: JSON.parse(fs.readFileSync(doneFile, 'utf8')).exitCode, mode, timedOut: false };
    }
    if (fs.existsSync(exitFile)) {
      return { exitCode: Number.parseInt(fs.readFileSync(exitFile, 'utf8'), 10), mode, timedOut: false };
    }
    const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
    if (pid) await run('taskkill', ['/PID', pid, '/T', '/F']);
    return { exitCode: -2, mode, timedOut: true };
  }
  return { exitCode: -1, mode: 'none', timedOut: false };
}
