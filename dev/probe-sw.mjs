import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9421;
const profile = mkdtempSync(join(tmpdir(), 'lf-pr-'));
const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await sleep(200);
  }
  throw new Error('no chrome');
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
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: process.argv[2] });
await sleep(1600);
const r = await send('Runtime.evaluate', { expression: `(()=>{
const sw=document.querySelector('#fb-sw'); const i=sw.querySelector('i');
const cs=getComputedStyle(sw), ci=getComputedStyle(i);
return JSON.stringify({checked:sw.getAttribute('aria-checked'),theme:document.documentElement.dataset.theme,
bg:cs.backgroundImage, bgc:cs.backgroundColor, thumbTf:ci.transform, state:window.LF.app.state.fallback,
matchTrue:sw.matches('.sw[aria-checked="true"]'),
sheets:[...document.styleSheets].map(sh=>{try{return [...sh.cssRules].filter(r=>r.selectorText&&r.selectorText.includes('.sw')).map(r=>r.selectorText)}catch(e){return ['ERR']}}).flat(),
thumbW:ci.width},null,1)})()`, returnByValue: true });
console.log(r.result.value);
ws.close(); chrome.kill(); process.exit(0);
