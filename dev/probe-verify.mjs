/**
 * dev/probe-verify.mjs — 验证「步进宽度 + 墨迹包围盒」判定与逐像素判定是否等价
 * 仅开发时使用，不打包进模块。
 *
 *   node dev/probe-verify.mjs [han|uni]
 *
 * 覆盖率检测为了快，想用 measureText 的特征直接判缺字，不走光栅化。
 * 这个脚本拿逐像素的结果当基准，看两者差多少。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9340;
const MODE = process.argv[2] || 'han';

const ucd = readFileSync(resolve('webroot/assets/ucd.js'), 'utf8');

const profile = mkdtempSync(join(tmpdir(), 'lf-pv-'));
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

const expr = `(() => {
  const U = window.LF_UCD;
  function decode(s) {
    const out = []; let prev = 0;
    for (const part of s.split(',')) {
      const dot = part.indexOf('.');
      const s0 = prev + parseInt(part.slice(0, dot), 16);
      const e0 = s0 + parseInt(part.slice(dot + 1), 16);
      out.push([s0, e0]); prev = e0 + 1;
    }
    return out;
  }
  const arr = [];
  for (const [s, e] of decode('${MODE}' === 'han' ? U.han : U.uni)) for (let cp = s; cp <= e; cp++) arr.push(cp);

  const CW = 16, CH = 20, STRIP = 64;
  const cv = document.createElement('canvas');
  cv.width = STRIP * CW; cv.height = CH;
  const g = cv.getContext('2d');
  g.font = '14px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';

  function met(cp) {
    const m = g.measureText(String.fromCodePoint(cp));
    return [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent, m.actualBoundingBoxLeft, m.actualBoundingBoxRight];
  }
  const base = met(0x0378);
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];

  // 逐像素基准
  const tofu = new Uint32Array(CW * CH);
  (function () {
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillText('\\u0378', CW / 2, CH / 2);
    const d = g.getImageData(0, 0, CW, CH).data;
    new Uint32Array(d.buffer, d.byteOffset, CW * CH).forEach((v, i) => { tofu[i] = v; });
  })();

  const t0 = performance.now();
  const byPix = new Uint8Array(arr.length);   // 1 = 有字形
  for (let i = 0; i < arr.length; i += STRIP) {
    const n = Math.min(STRIP, arr.length - i);
    g.clearRect(0, 0, cv.width, cv.height);
    for (let k = 0; k < n; k++) g.fillText(String.fromCodePoint(arr[i + k]), k * CW + CW / 2, CH / 2);
    const d = g.getImageData(0, 0, n * CW, CH).data;
    const u = new Uint32Array(d.buffer, d.byteOffset, n * CW * CH);
    const stride = n * CW;
    for (let k = 0; k < n; k++) {
      let ok = false;
      for (let y = 0; y < CH && !ok; y++) {
        const row = y * stride + k * CW, rr = y * CW;
        for (let x = 0; x < CW; x++) if (u[row + x] !== tofu[rr + x]) { ok = true; break; }
      }
      byPix[i + k] = ok ? 1 : 0;
    }
  }
  const tPix = performance.now() - t0;

  const t1 = performance.now();
  const byMet = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) byMet[i] = same(met(arr[i]), base) ? 0 : 1;
  const tMet = performance.now() - t1;

  let agree = 0, falseMissing = 0, missedMissing = 0;
  const samplesA = [], samplesB = [];
  for (let i = 0; i < arr.length; i++) {
    if (byMet[i] === byPix[i]) agree++;
    else if (byMet[i] === 0) { falseMissing++; if (samplesA.length < 6) samplesA.push('U+' + arr[i].toString(16).toUpperCase()); }
    else { missedMissing++; if (samplesB.length < 6) samplesB.push('U+' + arr[i].toString(16).toUpperCase()); }
  }
  let supPix = 0, supMet = 0;
  for (let i = 0; i < arr.length; i++) { supPix += byPix[i]; supMet += byMet[i]; }

  return JSON.stringify({
    total: arr.length,
    supByPixels: supPix,
    supByMetric: supMet,
    agree, falseMissing, missedMissing,
    falseMissingSamples: samplesA,
    missedMissingSamples: samplesB,
    msPixels: Math.round(tPix),
    msMetric: Math.round(tMet)
  }, null, 1);
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result.value || JSON.stringify(r, null, 1));
ws.close();
chrome.kill();
process.exit(0);
