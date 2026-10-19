/**
 * dev/probe-glyph.mjs — 探测 WebView/Chromium 对「缺字」的绘制方式
 * 仅开发时使用，不打包进模块。
 *
 *   node dev/probe-glyph.mjs
 *
 * 覆盖率测试靠「拿缺字当基准」来判定每个码位有没有字形。
 * 前提是同一台机器上所有缺字都画成同一个图；如果渲染器画的是
 * 「带码位的方框」，每个缺字都不一样，这套判定就不成立。
 * 这个脚本就是来确认前提的。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;

const profile = mkdtempSync(join(tmpdir(), 'lf-probe-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (r.ok) return await r.json();
    } catch (e) { /* not up yet */ }
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
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');

const expr = `(() => {
  const CELL = 16, N = 32;
  const cv = document.createElement('canvas');
  cv.width = CELL * N; cv.height = CELL + 4;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.font = '14px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  function sig(cp) {
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillText(String.fromCodePoint(cp), CELL / 2, (CELL + 4) / 2);
    const d = g.getImageData(0, 0, CELL, CELL + 4).data;
    let h = 0, ink = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) ink++; h = (h * 31 + d[i]) | 0; }
    return h + '/' + ink;
  }

  // 未分配码位（Cn）——任何字体都不该有
  const unassigned = [0x0378, 0x0380, 0x0530, 0x0590, 0x0C5B, 0x1C3B];
  const known = { 'A': 0x41, '中': 0x4E2D, 'あ': 0x3042, '한': 0xD55C, '永': 0x6C38 };
  const cjkExt = { 'U+20000': 0x20000, 'U+2A6DF': 0x2A6DF, 'U+323B0': 0x323B0 };
  const pua = { 'U+E000': 0xE000, 'U+F8FF': 0xF8FF, 'U+10FFFD': 0x10FFFD };

  const out = { unassigned: {}, known: {}, cjkExt: {}, pua: {} };
  unassigned.forEach(cp => out.unassigned['U+' + cp.toString(16).toUpperCase()] = sig(cp));
  Object.entries(known).forEach(([k, cp]) => out.known[k] = sig(cp));
  Object.entries(cjkExt).forEach(([k, cp]) => out.cjkExt[k] = sig(cp));
  Object.entries(pua).forEach(([k, cp]) => out.pua[k] = sig(cp));

  const uniq = new Set(Object.values(out.unassigned));
  out.unassignedUniform = uniq.size === 1;
  out.unassignedDistinct = uniq.size;
  return JSON.stringify(out, null, 1);
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
console.log(r.result.value || JSON.stringify(r, null, 1));

ws.close();
chrome.kill();
process.exit(0);
