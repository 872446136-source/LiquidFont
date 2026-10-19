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
  // 并发写入的通道数。每个通道一次 exec（一个 root shell），6 路在手机上
  // 既能压满 IO 又不会把系统拖垮。
  const CONCURRENCY = 6;
  const READ_CHUNK = 64 * 1024;
  // 预览要把整份字体读进内存再交给 FontFace，超过这个大小就没必要了
  const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

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

  // KernelSU 的原生桥（WebViewInterface.kt）只有这三个签名，参数**全是 String**：
  //   fun exec(cmd: String): String
  //   fun exec(cmd: String, callbackFunc: String)
  //   fun exec(cmd: String, options: String?, callbackFunc: String)
  // 官方 kernelsu JS 库的用法是：先在 window 上挂一个全局函数，
  // 再把**函数名**当字符串传进去，管理器用 `javascript: name(errno, stdout, stderr)` 回调。
  //
  // 直接传函数对象或对象字面量，WebView 转不成 String，Java 侧就会抛
  // "Java exception was raised during method invocation" —— 这就是之前写入失败的原因。
  //
  // 但也有管理器（部分独立 WebUI 壳）自己包了一层，能收函数。所以这里列全，
  // 先用 echo 探一次，哪个能回包就固定用哪个。
  let cbSeq = 0;
  function namedCallback(cb) {
    const name = '__lf_exec_' + Date.now() + '_' + (++cbSeq);
    global[name] = (errno, out, err) => {
      try { delete global[name]; } catch (e) { /* ignore */ }
      cb(errno, out, err);
    };
    return name;
  }

  const EXEC_STYLES = [
    // 官方形式：函数名当字符串传，options 也是 JSON 字符串
    {
      id: 'cbname',
      call: (cmd, cb) => {
        const name = namedCallback(cb);
        try {
          KSU.exec(cmd, JSON.stringify({ cwd: MODDIR }), name);
        } catch (e) {
          try { delete global[name]; } catch (e2) { /* ignore */ }
          throw e;
        }
      }
    },
    // 两参重载：没有 options
    {
      id: 'cbname2',
      call: (cmd, cb) => {
        const name = namedCallback(cb);
        try {
          KSU.exec(cmd, name);
        } catch (e) {
          try { delete global[name]; } catch (e2) { /* ignore */ }
          throw e;
        }
      }
    },
    // 包了一层的实现，可以直接收函数
    { id: 'cb2', call: (cmd, cb) => KSU.exec(cmd, cb) },
    { id: 'opts', call: (cmd, cb) => KSU.exec(cmd, { cwd: MODDIR }, cb) },
    { id: 'json', call: (cmd, cb) => KSU.exec(cmd, JSON.stringify({ cwd: MODDIR }), cb) },
    // 同步返回 stdout（官方 exec(cmd) 会阻塞 UI，只作兜底）
    { id: 'sync', call: (cmd) => KSU.exec(cmd) },
    // Promise 风格
    { id: 'p2json', call: (cmd) => KSU.exec(cmd, JSON.stringify({ cwd: MODDIR })) },
    { id: 'p2obj', call: (cmd) => KSU.exec(cmd, { cwd: MODDIR }) },
    { id: 'p1', call: (cmd) => KSU.exec(cmd) }
  ];

  // code === -2 表示「同步抛异常」，也就是调用形式不对，可以换一种再试；
  // code === -1 表示超时，形式可能是对的但没回包，不能当作形式错误。
  function runOnce(style, cmd, timeoutMs) {
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
        const ret = style.call(cmd, (errno, out, err) => finish(errno, out, err));
        if (ret && typeof ret.then === 'function') {
          ret.then((v) => {
            if (v && typeof v.errno === 'number') finish(v.errno, v.stdout, v.stderr);
            else if (v && typeof v.code === 'number') finish(v.code, v.stdout || v.out, v.stderr || v.err);
          }, (e) => finish(-1, '', String((e && e.message) || e)));
        } else if (ret && typeof ret.errno === 'number') {
          finish(ret.errno, ret.stdout, ret.stderr);
        } else if (typeof ret === 'string') {
          finish(0, ret, '');
        }
      } catch (e) {
        finish(-2, '', String((e && e.message) || e));
      }
    });
  }

  let execStyle = null;
  let execProbe = null;
  let probeDone = false;

  async function probeStyle() {
    for (const s of EXEC_STYLES) {
      const r = await runOnce(s, 'echo lf-probe', 2000);
      if (/lf-probe/.test(r.out)) {
        execStyle = s;
        probeDone = true;
        return s;
      }
    }
    probeDone = true;
    return null;
  }

  // 给「运行环境」看的：当前用的是哪种调用形式，探不通就是 none
  function execStyleId() {
    if (execStyle) return execStyle.id;
    return probeDone ? 'none' : 'pending';
  }

  async function exec(cmd, timeoutMs) {
    if (!KSU) return { code: 0, out: '', err: '' };

    if (!execStyle) {
      if (!execProbe) execProbe = probeStyle();
      await execProbe;
    }
    // 三种形式都探不通：用默认形式试一次，不再每回轮询三遍
    if (!execStyle) return runOnce(EXEC_STYLES[1], cmd, timeoutMs);

    const r = await runOnce(execStyle, cmd, timeoutMs);
    if (r.code !== -2) return r;

    // 已选定的形式这次同步抛了，可能管理器换了实现，换其它形式再试并记住
    for (const s of EXEC_STYLES) {
      if (s === execStyle) continue;
      const r2 = await runOnce(s, cmd, timeoutMs);
      if (r2.code !== -2) {
        execStyle = s;
        return r2;
      }
    }
    return r;
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
        xml: { fonts: 'on', fallback: 'on', base: 'on', ule: 'on', patched: 4, total: 4, fmgr: 'absent' },
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
    // 字体清单注入状态：on=已带兜底字族 raw=原样 none=设备没有
    const xml = { fonts: '', fallback: '', base: '', ule: '', patched: 0, total: 0, fmgr: '' };
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
      if (t.startsWith('xml.')) {
        const k = t.slice(4), i = k.indexOf('=');
        if (i > 0) {
          const key = k.slice(0, i), val = k.slice(i + 1);
          xml[key] = key === 'patched' || key === 'total' ? +val || 0 : val;
        }
        return;
      }
      const m = /^slot\.(\w+)=(set|empty)$/.exec(t);
      if (m) return void (slots[m[1]] = slots[m[1]] || { set: false, size: 0 }, (slots[m[1]].set = m[2] === 'set'));
      const n = /^size\.(\w+)=(\d+)$/.exec(t);
      if (n) return void (slots[n[1]] && (slots[n[1]].size = +n[2]));
      if (t === 'applied=1') applied = true;
    });
    return {
      mode: missing ? 'missing' : 'native',
      slots, applied, rom, fallback, fbVersions, gms, hide, xml,
      // exec 同步抛异常 = WebUI 桥的调用形式不对，所有读写都会失败
      execOk: r.code !== -2,
      execErr: r.code === -2 ? r.err : '',
      raw: r.out
    };
  }

  /* ───────── 写入字体 ───────── */
  // 串行追加：最笨但最兼容，只在 dd 方案校验不过时兜底
  async function writeSequential(path, buf, onProgress) {
    await exec(`: > '${path}'`);
    let sent = 0;
    for (let i = 0; i < buf.length; i += CHUNK) {
      const b64 = bytesToB64(buf.subarray(i, i + CHUNK));
      const r = await exec(`printf %s '${b64}' | base64 -d >> '${path}'`);
      if (r.code !== 0) return false;
      sent += Math.min(CHUNK, buf.length - i);
      onProgress && onProgress(sent / buf.length);
    }
    const chk = await exec(`wc -c < '${path}'`);
    return parseInt(chk.out.trim(), 10) === buf.length;
  }

  // preloaded：调用方已经读好的 ArrayBuffer。大字体再读一遍就是多占一份内存，
  // 传进来就直接用（new Uint8Array(ab) 是视图，不复制）。
  async function write(slot, file, onProgress, preloaded) {
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
    if (created.code !== 0) {
      throw new Error(created.code === -2
        ? 'WebUI 无法调用 Root 接口（' + (created.err || '未知错误') + '）'
        : '无法创建文件：' + (created.err || created.code));
    }

    const buf = preloaded ? new Uint8Array(preloaded) : new Uint8Array(await file.arrayBuffer());

    // 写入策略：每块 64KB → base64 → dd 直接写到目标文件的对应偏移（conv=notrunc）。
    // 块与块不重叠，所以能并发。瓶颈从来不是 base64，而是每次 exec 都要新建一个
    // root shell：串行 320 次就是几十秒，并发 6 路能压到几秒。
    const n = Math.ceil(buf.length / CHUNK);
    let cursor = 0, done = 0, failed = null;

    async function worker() {
      for (;;) {
        const i = cursor++;
        if (i >= n || failed) return;
        const off = i * CHUNK;
        const b64 = bytesToB64(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
        const r = await exec(
          `printf %s '${b64}' | base64 -d | dd of='${path}' bs=${CHUNK} seek=${i} conv=notrunc 2>/dev/null`
        );
        if (r.code !== 0) {
          failed = r;
          return;
        }
        done++;
        onProgress && onProgress(done / n);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, worker));

    // 校验字节数；dd 方案不成立（老 toybox / 权限）就退回串行追加。
    // 注意 failed 也要算失败：中间某块写挂了、但最后一块写成功时，
    // 文件长度照样对得上，只是中间有个洞——只比长度会漏掉这种情况。
    const chk = await exec(`wc -c < '${path}'`);
    const got = parseInt(chk.out.trim(), 10);
    if (failed || !got || got !== buf.length) {
      const ok = await writeSequential(path, buf, onProgress);
      if (!ok) throw new Error(`写入失败（${got || 0}/${buf.length} 字节）`);
    }
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
    if (size > MAX_PREVIEW_BYTES) {
      throw new Error(`字体 ${(size / 1048576).toFixed(0)}MB，超过预览上限 64MB（不影响已保存的字体和应用）`);
    }

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
    // gms.sh 失败时返回码不一定是非 0，得看输出里的标记
    return { ok: r.code === 0 && !/\[✗\]|失败/.test(out), out };
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
    return { ok: r.code === 0 && !/\[✗\]|失败/.test(out), out };
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
    bridge: { MODE, MODDIR, status, write, readBytes, clear, clearAll, apply, lastLog, restore, setFallback, setGms, setHide, exec, execStyle: execStyleId, toast },
    bytesToB64,
    b64ToBytes
  };
})(window);
