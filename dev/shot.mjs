/**
 * dev/shot.mjs — 用 Chrome DevTools Protocol 截图 + 量尺寸
 * 仅开发时使用，不打包进模块。
 *
 *   node dev/shot.mjs <url> <out.png> [width] [height] [theme] [view]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, out, w = '390', h = '844', theme = 'dark', view = 'home', scrollSel = ''] = process.argv.slice(2);
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'lf-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank'
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
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: +w,
  height: +h,
  deviceScaleFactor: 2,
  mobile: true
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'theme=' + theme });
await sleep(1400);

// 切到目标视图
await send('Runtime.evaluate', {
  expression: `window.LF && window.LF.app && window.LF.app.go('${view}'); true;`
});
await sleep(900);

// 可选：把某个元素滚进视野（截图只截视口）
if (scrollSel) {
  await send('Runtime.evaluate', {
    expression: "(() => { const el = document.querySelector('" + scrollSel + "'); if (el) el.scrollIntoView({ block: 'center' }); return !!el; })()",
    returnByValue: true
  });
  await sleep(400);
}

// 量一下有没有横向溢出
const metrics = await send('Runtime.evaluate', {
  expression: `(() => {
    const vw = innerWidth;
    const bad = [...document.querySelectorAll('body *')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); })
      .slice(0, 12)
      .map(e => (e.tagName.toLowerCase() + '.' + (typeof e.className === 'string' ? e.className.split(' ')[0] : '')).padEnd(24) + ' L' + Math.round(e.getBoundingClientRect().left) + ' R' + Math.round(e.getBoundingClientRect().right));
    return JSON.stringify({ vw, scrollW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth, bad }, null, 1);
  })()`,
  returnByValue: true
});
console.log(metrics.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);

ws.close();
chrome.kill();
process.exit(0);
