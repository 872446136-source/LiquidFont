/**
 * dev/bench-coverage.mjs — 跑一遍真实的覆盖率检测，看耗时与判定分布
 * 仅开发时使用，不打包进模块。
 *
 *   node dev/bench-coverage.mjs [han|uni]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9338;
const MODE = process.argv[2] || 'han';

const ucd = readFileSync(resolve('webroot/assets/ucd.js'), 'utf8');
const cov = readFileSync(resolve('webroot/assets/coverage.js'), 'utf8');

const profile = mkdtempSync(join(tmpdir(), 'lf-bc-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch (e) { /* wait */ }
    await sleep(200);
  }
  throw new Error('chrome 未就绪');
}
const list = await getJSON('/json/list');
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result)));
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');

await send('Runtime.evaluate', { expression: ucd });
await send('Runtime.evaluate', { expression: cov });

const expr = `new Promise((resolve) => {
  const t0 = performance.now();
  let last = { pending: -1 }, ticks = 0;
  window.LF_COVERAGE.start({
    mode: '${MODE}',
    onProgress: (p) => { last = p; ticks++; },
    onDone: (r) => resolve(JSON.stringify({
      wallMs: Math.round(performance.now() - t0),
      ticks: ticks,
      mode: r.mode,
      supported: r.supported,
      total: r.total,
      pct: +r.pct.toFixed(2),
      grade: r.grade,
      durationMs: r.durationMs,
      reliable: r.reliable,
      uniformTofu: r.uniformTofu,
      pendingLeft: last.pending,
      blocks: r.blocks.length,
      top: r.blocks.slice(0, 3).map(b => b.name + ' ' + b.supported + '/' + b.total + ' ' + b.grade),
      bottom: r.blocks.slice(-3).map(b => b.name + ' ' + b.supported + '/' + b.total + ' ' + b.grade)
    }, null, 1)),
    onError: (e) => resolve('ERR ' + e.message)
  });
})`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(r.result.value || JSON.stringify(r, null, 1));

ws.close();
chrome.kill();
process.exit(0);
