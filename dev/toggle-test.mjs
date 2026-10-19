// 开发用：验证全字库开关在演示模式下的状态流转
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9411;
const url = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), 'lf-sw-'));
const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await sleep(200);
  }
  throw new Error('chrome 未就绪');
}
const page = (await getJSON('/json/list')).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });
await sleep(1400);
await evalJs(`window.LF.app.go('more')`);
await sleep(600);
const snap = `JSON.stringify({checked:document.querySelector('#fb-sw').getAttribute('aria-checked'),state:document.querySelector('#fb-state').textContent.trim(),verP:document.querySelector('#fb-ver-p').textContent,verU:document.querySelector('#fb-ver-u').textContent,ls:localStorage.getItem('lf.fallback')})`;
console.log('初始 ', await evalJs(snap));
await evalJs(`document.querySelector('#fb-sw').click()`);
await sleep(700);
console.log('点一次', await evalJs(snap));
await evalJs(`document.querySelector('#fb-sw').click()`);
await sleep(700);
console.log('再点  ', await evalJs(snap));
ws.close(); chrome.kill(); process.exit(0);
