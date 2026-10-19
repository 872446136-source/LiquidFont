// 载入字体 → 切到预览页 → 截图（开发用）
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9401;
const [url, fontPath, out, theme = 'dark'] = process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), 'lf-pv-'));
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
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });
await sleep(1400);
await send('Runtime.evaluate', { expression: `window.LF.app.go('slots')` });
await sleep(300);
await send('Runtime.evaluate', { expression: `document.querySelector('.slot[data-slot="hans"] [data-act="pick"]').click()` });
await sleep(250);
const doc = await send('DOM.getDocument', { depth: -1 });
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#picker' });
await send('DOM.setFileInputFiles', { files: [fontPath], nodeId: node.nodeId });
await sleep(2200);
await send('Runtime.evaluate', { expression: `window.LF.app.go('preview')` });
await sleep(900);
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out, theme);
ws.close(); chrome.kill(); process.exit(0);
