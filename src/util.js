// Shared helpers: paths, logging, process execution.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIRS = {
  data: path.join(ROOT, 'data'),
  logs: path.join(ROOT, 'logs'),
  runs: path.join(ROOT, 'runs'),
  workspace: path.join(ROOT, 'workspace'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const logFile = path.join(DIRS.logs, 'app.log');
function write(level, args) {
  const msg = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}
export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};

/** Run a command (no shell) and collect output. Never throws on non-zero exit. */
export function run(cmd, args, { cwd, input, timeoutMs = 10 * 60_000, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: String(err), error: err });
      return;
    }
    const timer = setTimeout(() => { if (!done) { child.kill(); stderr += '\n[timeout]'; } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err), error: err }); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/** Like run() but throws with a useful message on failure. */
export async function runOk(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 1500)}`);
  return r.stdout;
}

/** Resolve an executable to a spawnable path on Windows (prefers .exe; handles npm .cmd shims). */
export function resolveExecutable(name, override) {
  if (override) return override;
  if (process.platform !== 'win32') return name;
  const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
  const hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = hits.find((h) => h.toLowerCase().endsWith('.exe'));
  if (exe) return exe;
  const cmd = hits.find((h) => h.toLowerCase().endsWith('.cmd'));
  if (cmd) {
    // npm shim: look for the real binary inside node_modules (e.g. opencode-ai/bin/opencode.exe)
    try {
      const txt = fs.readFileSync(cmd, 'utf8');
      const m = txt.match(/"%dp0%\\([^"]+\.exe)"/i);
      if (m) {
        const p = path.join(path.dirname(cmd), m[1]);
        if (fs.existsSync(p)) return p;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
