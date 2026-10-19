import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9388;
const profile = mkdtempSync(join(tmpdir(), 'lf-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(200);
  }
  throw new Error('no chrome');
}

const list = await getJSON('/json/list');
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});

await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: process.argv[2] });
await sleep(1500);

await send('Runtime.evaluate', { expression: "window.LF.app.go('slots')" });
await sleep(400);
await send('Runtime.evaluate', { expression: "document.querySelector('.slot[data-slot=\"hans\"] [data-act=\"pick\"]').click()" });
await sleep(300);

const doc = await send('DOM.getDocument', { depth: -1 });
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#picker' });
await send('DOM.setFileInputFiles', { files: [process.argv[3]], nodeId: node.nodeId });
await sleep(2500);

const dbg = await send('Runtime.evaluate', {
  expression: "JSON.stringify({n:document.querySelector('#picker').files.length,toasts:[...document.querySelectorAll('.toast')].map(t=>t.textContent)})",
  returnByValue: true
});
console.log('DBG', dbg.result.value);

const r = await send('Runtime.evaluate', {
  expression: "JSON.stringify({state:window.LF.app.state.slots.hans, meta:window.LF.app.state.meta.hans, faces:Object.keys(window.LF.app.state.faces)})",
  returnByValue: true
});
console.log(r.result.value);
console.log('--- console ---\n' + (logs.join('\n') || '(none)'));

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(process.argv[4], Buffer.from(shot.data, 'base64'));
ws.close();
chrome.kill();
process.exit(0);
