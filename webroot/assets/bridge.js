/* ═══════════════════════════════════════════════════════════
   bridge.js — 与 Root 管理器通信
   原生：KernelSU / SukiSU / KernelSU Next / Magisk(WebUI X) 注入的 ksu 桥
   降级：浏览器里直接打开时进入演示模式（数据存 localStorage）
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const MODDIR = '/data/adb/modules/LiquidFont';
  const KSU = typeof global.ksu !== 'undefined' && global.ksu && typeof global.ksu.exec === 'function'
    ? global.ksu
    : null;
  const MODE = KSU ? 'native' : 'demo';

  // 单次 argv 上限 128KB，base64 后膨胀 4/3，取 64KB 原始数据留足余量
  const CHUNK = 64 * 1024;
  const READ_CHUNK = 48 * 1024;

  const demoStore = new Map(); // slot -> { file, info }

  function bytesToB64(bytes) {
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // KernelSU 的 exec 有 Promise 与 callback 两代实现（SukiSU / KSU Next / Magisk WebUI X
  // 又各有差异），这里同时兼容：先按 Promise 取，拿不到就等 callback，都没有则超时。
  function exec(cmd, timeoutMs) {
    if (!KSU) return Promise.resolve({ code: 0, out: '', err: '' });
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(-1, '', '执行超时'), timeoutMs || 120000);
      function finish(errno, out, err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: typeof errno === 'number' ? errno : -1,
          out: out == null ? '' : String(out),
          err: err == null ? '' : String(err)
        });
      }
      try {
        const ret = KSU.exec(cmd, { cwd: MODDIR }, (errno, out, err) => finish(errno, out, err));
        if (ret && typeof ret.then === 'function') {
          ret.then((v) => {
            if (v && typeof v.errno === 'number') finish(v.errno, v.stdout, v.stderr);
          }, (e) => finish(-1, '', String((e && e.message) || e)));
        } else if (ret && typeof ret.errno === 'number') {
          finish(ret.errno, ret.stdout, ret.stderr);
        }
      } catch (e) {
        finish(-1, '', String((e && e.message) || e));
      }
    });
  }

  function readDemoMeta() {
    try {
      return JSON.parse(localStorage.getItem('lf.slots') || '{}');
    } catch (e) {
      return {};
    }
  }
  function writeDemoMeta(o) {
    try { localStorage.setItem('lf.slots', JSON.stringify(o)); } catch (e) { /* ignore */ }
  }

  /* ───────── 状态 ───────── */
  async function status() {
    if (!KSU) {
      const meta = readDemoMeta();
      const slots = {};
      ['hans', 'hant', 'en', 'mono', 'emoji'].forEach((s) => {
        slots[s] = meta[s] ? { set: true, size: meta[s].size || 0 } : { set: false, size: 0 };
      });
      const fbOn = localStorage.getItem('lf.fallback') !== 'off';
      return {
        mode: 'demo',
        slots,
        applied: Object.values(slots).some((s) => s.set),
        rom: '演示模式 · 未连接设备',
        fallback: fbOn ? 'idle' : 'off',
        fbVersions: { plangothic: '2.9.5795', unifont: '18.0.01' },
        gms: (() => {
          const on = localStorage.getItem('lf.gms') === 'on';
          return { flag: on ? 'on' : 'off', state: on ? 'taken' : 'normal' };
        })(),
        hide: (() => {
          const on = localStorage.getItem('lf.hide') === 'on';
          return on
            ? { root: 'ksu', meta: 'mountify', metamode: 'metamodule', fake: 'my_manifest', dev: 'KSU', mounts: '2', zygisk: 'Zygisk Next', legacy: 0, state: 'hardened' }
            : { root: 'ksu', meta: 'mountify', metamode: 'metamodule', fake: 'mountify', dev: 'overlay', mounts: '2', zygisk: 'none', legacy: 0, state: 'partial' };
        })()
      };
    }

    const cmd =
      `if [ -d ${MODDIR} ]; then sh ${MODDIR}/apply.sh --status 2>/dev/null; ` +
      `else echo "missing=1"; fi; ` +
      `echo "@rom=$(getprop ro.build.version.oplusrom.display 2>/dev/null)"; ` +
      `echo "@api=$(getprop ro.build.version.oplus.api 2>/dev/null)"; ` +
      `if [ -f ${MODDIR}/gms.sh ]; then sh ${MODDIR}/gms.sh status 2>/dev/null; ` +
      `else echo "gms.state=missing"; fi; ` +
      `if [ -f ${MODDIR}/hide.sh ]; then sh ${MODDIR}/hide.sh status 2>/dev/null; fi`;
    const r = await exec(cmd);
    const slots = {};
    ['hans', 'hant', 'en', 'mono', 'emoji'].forEach((s) => (slots[s] = { set: false, size: 0 }));
    let applied = false, rom = '', missing = false, fallback = 'missing';
    const fbVersions = { plangothic: '', unifont: '' };
    const gms = { flag: 'off', state: 'missing' };
    const hide = { root: '', meta: 'none', metamode: 'none', fake: '-', dev: '-', mounts: '-', zygisk: 'none', legacy: 0, state: 'basic' };
    r.out.split('\n').forEach((line) => {
      const t = line.trim();
      if (!t) return;
      if (t.startsWith('@rom=')) return void (rom = t.slice(5));
      if (t.startsWith('@api=')) return;
      if (t === 'missing=1') return void (missing = true);
      if (t.startsWith('fallback=')) return void (fallback = t.slice(9));
      if (t.startsWith('fb.plangothic_version=')) return void (fbVersions.plangothic = t.slice(22));
      if (t.startsWith('fb.unifont_version=')) return void (fbVersions.unifont = t.slice(19));
      if (t.startsWith('gms.flag=')) return void (gms.flag = t.slice(9));
      if (t.startsWith('gms.state=')) return void (gms.state = t.slice(10));
      if (t.startsWith('hide.')) {
        const k = t.slice(5), i = k.indexOf('=');
        if (i > 0) {
          const key = k.slice(0, i), val = k.slice(i + 1);
          hide[key] = key === 'legacy' ? +val || 0 : val;
        }
        return;
      }
      const m = /^slot\.(\w+)=(set|empty)$/.exec(t);
      if (m) return void (slots[m[1]] = slots[m[1]] || { set: false, size: 0 }, (slots[m[1]].set = m[2] === 'set'));
      const n = /^size\.(\w+)=(\d+)$/.exec(t);
      if (n) return void (slots[n[1]] && (slots[n[1]].size = +n[2]));
      if (t === 'applied=1') applied = true;
    });
    return { mode: missing ? 'missing' : 'native', slots, applied, rom, fallback, fbVersions, gms, hide, raw: r.out };
  }

  /* ───────── 写入字体 ───────── */
  async function write(slot, file, onProgress) {
    if (!KSU) {
      const meta = readDemoMeta();
      meta[slot] = { name: file.name, size: file.size, at: Date.now() };
      writeDemoMeta(meta);
      demoStore.set(slot, { file });
      onProgress && onProgress(1);
      return;
    }

    const path = `${MODDIR}/FONTS/${slot}.ttf`;
    await exec(`mkdir -p ${MODDIR}/FONTS`);
    const created = await exec(`: > '${path}'`);
    if (created.code !== 0) throw new Error('无法创建文件：' + (created.err || created.code));

    const buf = new Uint8Array(await file.arrayBuffer());
    let sent = 0;
    for (let i = 0; i < buf.length; i += CHUNK) {
      const b64 = bytesToB64(buf.subarray(i, i + CHUNK));
      const r = await exec(`printf %s '${b64}' | base64 -d >> '${path}'`);
      if (r.code !== 0) throw new Error('写入失败：' + (r.err || 'base64 解码错误'));
      sent += Math.min(CHUNK, buf.length - i);
      onProgress && onProgress(sent / buf.length);
    }

    const chk = await exec(`wc -c < '${path}'`);
    const got = parseInt(chk.out.trim(), 10);
    if (!got || got !== buf.length) throw new Error(`校验失败（${got || 0}/${buf.length} 字节）`);
    await exec(`chmod 0644 '${path}'`);
  }

  /* ───────── 读取字体 ───────── */
  async function readBytes(slot, onProgress) {
    if (!KSU) {
      const hit = demoStore.get(slot);
      if (!hit) throw new Error('演示模式下无法回读已保存的字体');
      return new Uint8Array(await hit.file.arrayBuffer());
    }
    const path = `${MODDIR}/FONTS/${slot}.ttf`;
    const sizeR = await exec(`wc -c < '${path}' 2>/dev/null`);
    const size = parseInt(sizeR.out.trim(), 10);
    if (!size) throw new Error('文件不存在');
    if (size > 40 * 1024 * 1024) throw new Error('字体过大，无法预览');

    const parts = [];
    for (let off = 0; off < size; off += READ_CHUNK) {
      const r = await exec(`dd if='${path}' bs=${READ_CHUNK} skip=${off / READ_CHUNK} count=1 2>/dev/null | base64 -w0 2>/dev/null || dd if='${path}' bs=${READ_CHUNK} skip=${off / READ_CHUNK} count=1 2>/dev/null | base64`);
      parts.push((r.out || '').replace(/\s+/g, ''));
      onProgress && onProgress(Math.min(1, (off + READ_CHUNK) / size));
    }
    return b64ToBytes(parts.join(''));
  }

  /* ───────── 删除槽位 ───────── */
  async function clear(slot) {
    if (!KSU) {
      const meta = readDemoMeta();
      delete meta[slot];
      writeDemoMeta(meta);
      demoStore.delete(slot);
      return;
    }
    await exec(`rm -f '${MODDIR}/FONTS/${slot}.ttf' '${MODDIR}/FONTS/.${slot}-subset.ttf'`);
  }

  async function clearAll() {
    if (!KSU) {
      writeDemoMeta({});
      demoStore.clear();
      return;
    }
    await exec(`rm -f ${MODDIR}/FONTS/*.ttf ${MODDIR}/FONTS/.en-subset.ttf`);
  }

  /* ───────── 全字库兜底开关 ───────── */
  // 关闭方式就是在 FALLBACK/ 下放一个 .disabled，apply.sh 会据此跳过并清理已装文件
  async function setFallback(on) {
    if (!KSU) {
      try { localStorage.setItem('lf.fallback', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
      return { ok: true };
    }
    const flag = `${MODDIR}/FALLBACK/.disabled`;
    const r = on
      ? await exec(`rm -f '${flag}'`)
      : await exec(`mkdir -p '${MODDIR}/FALLBACK' && : > '${flag}'`);
    return { ok: r.code === 0, out: r.out || r.err || '' };
  }

  /* ───────── Play 商店字体接管 ───────── */
  // on  = 停用 GMS 的 FontsProvider / UpdateSchedulerService 并清字体缓存
  // off = 重新启用（组件状态存在 package manager 里，重启不会丢）
  async function setGms(on) {
    if (!KSU) {
      try { localStorage.setItem('lf.gms', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
      return { ok: true, out: '' };
    }
    const r = await exec(`sh ${MODDIR}/gms.sh ${on ? 'on' : 'off'}`, 120000);
    const out = (r.out || r.err || '').trim();
    return { ok: r.code === 0 && !/\[✗\]/.test(out), out };
  }

  /* ───────── 挂载隐藏 ───────── */
  // apply  = 把元模块配置改成「伪装挂载点 + 可被 Zygisk 卸载」，并清掉旧命名文件
  // restore = 用 hide.sh 留下的备份还原元模块配置
  async function setHide(on) {
    if (!KSU) {
      try { localStorage.setItem('lf.hide', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
      return { ok: true, out: '' };
    }
    const r = await exec(`sh ${MODDIR}/hide.sh ${on ? 'apply' : 'restore'}`, 60000);
    const out = (r.out || r.err || '').trim();
    return { ok: r.code === 0, out };
  }

  /* ───────── 应用 / 还原 ───────── */
  async function apply() {
    if (!KSU) {
      await new Promise((r) => setTimeout(r, 700));
      return { ok: true, out: '（演示模式）字体已模拟应用到 /system/fonts' };
    }
    const r = await exec(`cd ${MODDIR} && sh apply.sh 2>&1 | tee ${MODDIR}/last-apply.log`);
    const out = (r.out || r.err || '').trim();
    return { ok: r.code === 0 && !/\[✗\]/.test(out), out };
  }

  async function lastLog() {
    if (!KSU) return '（演示模式）这里会显示 apply.sh 的完整输出。';
    const r = await exec(`cat ${MODDIR}/last-apply.log 2>/dev/null | tail -n 80`);
    return r.out || '暂无日志';
  }

  async function restore() {
    if (!KSU) {
      writeDemoMeta({});
      demoStore.clear();
      return { ok: true, out: '（演示模式）已还原' };
    }
    const r = await exec(`rm -rf ${MODDIR}/system/fonts && rm -f ${MODDIR}/FONTS/*.ttf ${MODDIR}/last-apply.log`);
    return { ok: r.code === 0, out: r.out || r.err || '' };
  }

  function toast(msg) {
    try {
      if (KSU && typeof KSU.toast === 'function') KSU.toast(msg);
    } catch (e) { /* ignore */ }
  }

  global.LF = {
    bridge: { MODE, MODDIR, status, write, readBytes, clear, clearAll, apply, lastLog, restore, setFallback, setGms, setHide, exec, toast },
    bytesToB64,
    b64ToBytes
  };
})(window);
