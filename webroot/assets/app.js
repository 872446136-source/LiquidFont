/* ═══════════════════════════════════════════════════════════
   app.js — LiquidFont WebUI
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const B = window.LF.bridge;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const SLOTS = [
    { id: 'hans', name: '简体中文', glyph: '永', desc: 'sans-serif · zh-Hans · 必选槽位', tag: '必选' },
    { id: 'hant', name: '繁体中文', glyph: '繁', desc: 'zh-Hant · zh-Bopo · 缺省回退简体', tag: '可选' },
    { id: 'en', name: '西文与数字', glyph: 'Aa', desc: 'SysFont · SysSans-En · OPSans-En', tag: '可选' },
    { id: 'mono', name: '等宽', glyph: '01', desc: 'DroidSansMono · CutiveMono', tag: '可选' },
    { id: 'emoji', name: 'Emoji', glyph: '🙂', desc: 'NotoColorEmoji', tag: '可选' }
  ];

  const SAMPLES = {
    mix: '液态玻璃\nLiquid Glass 0123456789\n永和九年，岁在癸丑。',
    zh: '永和九年，岁在癸丑，暮春之初。\n落霞与孤鹜齐飞，秋水共长天一色。',
    en: 'The quick brown fox jumps over the lazy dog.\nSphinx of black quartz, judge my vow.',
    num: '0123456789 · ￥1,234.56 · 3.1415926 · 09:41'
  };

  const state = {
    fallback: 'idle',
    fbVersions: { plangothic: '', unifont: '' },
    gms: { flag: 'off', state: 'missing' },
    hide: { root: '', meta: 'none', metamode: 'none', fake: '-', dev: '-', zygisk: 'none', legacy: 0, state: 'basic' },
    mode: B.MODE,
    slots: {},
    meta: {},
    faces: {},
    applied: false,
    rom: '',
    view: 'home',
    pendingSlot: null,
    weight: 400
  };

  /* ───────────────────── 小工具 ───────────────────── */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function toast(msg, type) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'err' ? ' err' : '');
    el.innerHTML = '<i></i><span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, 2600);
  }

  function setProgress(label, pct) {
    const wrap = $('#progress');
    if (label === null) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    $('#progress-label').textContent = label;
    const p = Math.max(0, Math.min(1, pct || 0));
    $('#progress-pct').textContent = Math.round(p * 100) + '%';
    $('#progress-bar').style.width = p * 100 + '%';
  }

  /* ───────────────────── 主题 ───────────────────── */
  function initTheme() {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'light' || q === 'dark') return applyTheme(q);
    let saved = null;
    try { saved = localStorage.getItem('lf.theme'); } catch (e) { /* ignore */ }
    if (!saved) {
      saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    applyTheme(saved);
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#e9ecf5' : '#06060a');
    try { localStorage.setItem('lf.theme', t); } catch (e) { /* ignore */ }
  }

  /* ───────────────────── 导航 ───────────────────── */
  function moveInd() {
    const dock = $('#dock');
    const ind = $('#ind');
    const active = $('.dock-btn.is-on', dock);
    if (!active || !ind) return;
    const dr = dock.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    const w = ar.width - 12;
    const x = ar.left - dr.left + 6;
    ind.style.width = w + 'px';
    ind.style.setProperty('--tf', `translateX(${x}px)`);
    ind.style.transform = `translateX(${x}px)`;
    ind.classList.remove('squish');
    void ind.offsetWidth;
    ind.classList.add('squish');
  }

  function go(view) {
    state.view = view;
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + view));
    $$('.dock-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));
    const main = $('#main');
    main.scrollTop = 0;
    moveInd();
    if (view === 'preview') ensureHansPreview();
  }

  /* ───────────────────── 渲染 ───────────────────── */
  function slotMetaChips(id) {
    const m = state.meta[id];
    if (!m) return '';
    const chips = [];
    if (m.variable && m.weightAxis) {
      chips.push(`<span class="chip">可变 ${m.weightAxis.tag} ${Math.round(m.weightAxis.min)}–${Math.round(m.weightAxis.max)}</span>`);
    } else if (m.weight) {
      chips.push(`<span class="chip">字重 ${m.weight}</span>`);
    }
    if (m.glyphs) chips.push(`<span class="chip">${m.glyphs.toLocaleString()} 字形</span>`);
    if (m.coverage && m.coverage.cjk > 0) chips.push(`<span class="chip">中文 ${m.coverage.cjk.toLocaleString()}</span>`);
    if (m.coverage && m.coverage.latin > 0) chips.push(`<span class="chip">西文 ${m.coverage.latin.toLocaleString()}</span>`);
    if (id === 'en' && m.coverage && m.coverage.cjk > 200) {
      chips.push(`<span class="chip" style="color:#ffb84d">⚠ 含汉字，会盖掉中文</span>`);
    }
    return chips.join('');
  }

  function renderMini() {
    const box = $('#mini-list');
    box.innerHTML = SLOTS.map((s, i) => {
      const st = state.slots[s.id] || { set: false, size: 0 };
      const face = state.faces[s.id];
      return `<div class="mini glass ring" data-slot="${s.id}" style="--i:${i}">
        <div class="mini-glyph" ${face ? `style="font-family:'${face}'"` : ''}>${s.glyph}</div>
        <div class="mini-body">
          <div class="mini-name">${s.name}</div>
          <div class="mini-sub">${st.set ? fmtSize(st.size) + ' · ' + esc((state.meta[s.id] && state.meta[s.id].family) || '已配置') : s.desc}</div>
        </div>
        <span class="mini-state ${st.set ? 'on' : ''}">${st.set ? '已配置' : '空'}</span>
      </div>`;
    }).join('');
  }

  function renderSlots() {
    const box = $('#slot-list');
    box.innerHTML = SLOTS.map((s, i) => {
      const st = state.slots[s.id] || { set: false, size: 0 };
      const face = state.faces[s.id];
      const m = state.meta[s.id];
      return `<article class="slot glass ring" data-slot="${s.id}" style="--i:${i}">
        <div class="slot-top">
          <div class="slot-preview" data-act="peek" ${face ? `style="font-family:'${face}'"` : ''}>
            <span>${s.glyph}</span>
          </div>
          <div class="slot-info">
            <div class="slot-head">
              <h3>${s.name}</h3>
              <span class="chip ${st.set ? 'on' : ''}">${st.set ? '已配置' : s.tag}</span>
            </div>
            <p class="slot-desc">${s.desc}</p>
            <p class="slot-file">${st.set ? (m ? esc(m.family) + ' · ' + fmtSize(st.size) : fmtSize(st.size)) : '尚未选择字体'}</p>
            <div class="meta-chips">${slotMetaChips(s.id)}</div>
          </div>
        </div>
        <div class="slot-actions">
          <button class="btn ghost" data-act="pick">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/></svg>
            ${st.set ? '更换字体' : '选择字体'}
          </button>
          <button class="btn ghost icon" data-act="clear" ${st.set ? '' : 'disabled style="opacity:.4"'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </article>`;
    }).join('');
  }

  function updateStats() {
    const list = SLOTS.map((s) => state.slots[s.id] || { set: false, size: 0 });
    const count = list.filter((x) => x.set).length;
    const total = list.reduce((a, x) => a + (x.size || 0), 0);
    $('#stat-set').textContent = count;
    $('#stat-size').innerHTML = (total / 1048576).toFixed(1) + '<small>MB</small>';
    $('#stat-state').textContent = state.applied ? '已应用' : count ? '待应用' : '未配置';
    const dot = $('#state-dot');
    dot.className = 'dot ' + (state.applied ? 'ok' : count ? 'warn' : '');
  }

  function updateEnv() {
    const rootName = state.mode === 'native' ? 'KernelSU 系（ksu 桥）' : state.mode === 'missing' ? '未找到模块目录' : '浏览器（演示模式）';
    $('#env-root').textContent = rootName;
    $('#env-moddir').textContent = state.mode === 'demo' ? '—' : B.MODDIR;
    $('#env-rom').textContent = state.rom || '未知';
    $('#env-mode').textContent = state.mode === 'native' ? '原生' : '演示';
    $('#sys-line').textContent =
      state.mode === 'native'
        ? (state.rom || 'ColorOS') + ' · ' + (state.applied ? '字体已应用' : '等待配置')
        : state.mode === 'missing'
          ? '未检测到模块目录'
          : '演示模式 · 界面可自由体验';
  }

  function renderFallback() {
    const sw = $('#fb-sw');
    if (!sw) return;
    const v = state.fbVersions || {};
    $('#fb-ver-p').textContent = v.plangothic || '—';
    $('#fb-ver-u').textContent = v.unifont || '—';

    const missing = state.fallback === 'missing';
    const on = state.fallback !== 'off' && !missing;
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.disabled = missing;

    const map = {
      applied: '已随字体一起安装',
      idle: '待应用 · 点「应用字体」后生效',
      off: '已关闭 · 重新开启后需再次应用',
      missing: '当前版本未内置全字库'
    };
    $('#fb-state').textContent = map[state.fallback] || '—';
  }

  async function toggleFallback() {
    const on = $('#fb-sw').getAttribute('aria-checked') !== 'true';
    $('#fb-sw').setAttribute('aria-checked', on ? 'true' : 'false');
    try {
      const r = await B.setFallback(on);
      if (!r.ok) throw new Error(r.out || '写入失败');
      toast(on ? '已开启全字库兜底，记得应用字体' : '已关闭全字库兜底');
      await refresh(true);
    } catch (e) {
      $('#fb-sw').setAttribute('aria-checked', on ? 'false' : 'true');
      toast('切换失败：' + (e.message || e), 'err');
    }
  }

  function renderGms() {
    const sw = $('#gms-sw');
    if (!sw) return;
    const g = state.gms || { flag: 'off', state: 'missing' };
    const on = g.flag === 'on';
    const missing = g.state === 'missing';

    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.disabled = missing;

    let text;
    if (missing) {
      text = '未检测到 Google Play 服务';
    } else if (on && g.state === 'taken') {
      text = '已接管 · Play 商店 / Chrome / Gmail 已改用系统字体';
    } else if (on) {
      text = '已开启，但系统里仍是正常状态（可能被系统重置，重新切一次即可）';
    } else {
      text = '未接管 · 这些应用仍使用 Google 自己的字体';
    }
    $('#gms-state').textContent = text;
  }

  async function toggleGms() {
    const on = $('#gms-sw').getAttribute('aria-checked') !== 'true';
    $('#gms-sw').setAttribute('aria-checked', on ? 'true' : 'false');
    setProgress(on ? '接管中…' : '恢复中…', 0.45);
    try {
      const r = await B.setGms(on);
      setProgress(null);
      if (!r.ok) throw new Error(r.out || '执行失败');
      toast(on ? '已接管 Play 商店字体' : '已恢复 GMS 字体服务');
      await refresh(true);
    } catch (e) {
      setProgress(null);
      $('#gms-sw').setAttribute('aria-checked', on ? 'false' : 'true');
      toast('切换失败：' + (e.message || e), 'err');
    }
  }

  function renderHide() {
    const chip = $('#hide-chip');
    if (!chip) return;
    const h = state.hide || {};

    const hasMeta = h.meta && h.meta !== 'none';
    $('#hide-meta').textContent = hasMeta
      ? h.meta + (h.metamode === 'metamodule' ? ' · 元模块' : ' · 普通模块')
      : '无 · 由 KSU 自己挂载';
    $('#hide-fake').textContent = h.fake && h.fake !== '-' ? '/mnt/vendor/' + h.fake : '—';
    $('#hide-zygisk').textContent = h.zygisk && h.zygisk !== 'none' ? h.zygisk : '未检测到';
    $('#hide-legacy').textContent = h.legacy > 0 ? h.legacy + ' 个（加固时清除）' : '无';

    const map = {
      hardened: ['已加固', 'ok'],
      partial: ['可加固', 'warn'],
      basic: ['未启用元模块', 'warn']
    };
    const hit = map[h.state] || ['—', ''];
    chip.textContent = hit[0];
    chip.className = 'chip' + (hit[1] === 'ok' ? ' on' : hit[1] === 'warn' ? ' warn' : '');

    let tip;
    if (h.state === 'hardened') {
      tip = h.zygisk && h.zygisk !== 'none'
        ? '挂载点已伪装。最后一步：在 ' + h.zygisk + ' 里把 Denylist Policy 设为 Enforced 或 Unmount Only，被屏蔽的应用才会看不到这层挂载。'
        : '挂载点已伪装，但没有 Zygisk 提供者，挂载无法对指定应用单独隐藏。建议装 Zygisk Next 或 ReZygisk。';
    } else if (h.state === 'partial') {
      tip = '元模块已就位，但挂载点还是默认的 mountify。点下面的按钮把伪装名、诱饵挂载和挂载源一次性配好。';
    } else if (state.mode === 'demo') {
      tip = '演示模式：这里显示的是加固后的样子。真机上点一下会把 mountify 配置改成伪装挂载点。';
    } else {
      tip = '没有元模块时，KSU 会给每个字体文件单独挂载，挂载点数量很容易被数出来。KernelSU 3.0+ 请先刷 mountify，再回来点加固。';
    }
    $('#hide-tip').textContent = tip;

    const btn = $('#hide-btn');
    btn.textContent = h.state === 'hardened' ? '重新加固' : '一键加固';
  }

  async function toggleHide() {
    setProgress('加固中…', 0.5);
    try {
      const r = await B.setHide(true);
      setProgress(null);
      if (!r.ok) throw new Error(r.out || '执行失败');
      toast('已加固 · 重启后生效');
      await refresh(true);
    } catch (e) {
      setProgress(null);
      toast('加固失败：' + (e.message || e), 'err');
    }
  }

  function renderAll() {
    renderMini();
    renderFallback();
    renderGms();
    renderHide();
    renderSlots();
    updateStats();
    updateEnv();
  }

  /* ───────────────────── 读取状态 ───────────────────── */
  async function refresh(quiet) {
    try {
      const st = await B.status();
      state.mode = st.mode;
      state.slots = st.slots || {};
      state.applied = !!st.applied;
      state.rom = st.rom || '';
      state.fallback = st.fallback || 'missing';
      state.fbVersions = st.fbVersions || state.fbVersions;
      state.gms = st.gms || state.gms;
      state.hide = st.hide || state.hide;
      renderAll();
      if (!quiet) toast(state.mode === 'demo' ? '演示模式：操作不会写入设备' : '状态已刷新');
    } catch (e) {
      toast('读取状态失败：' + (e.message || e), 'err');
    }
  }

  /* ───────────────────── 字体预览 ───────────────────── */
  async function loadFace(slot, bytes) {
    const family = 'LF-' + slot;
    try {
      const face = new FontFace(family, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      await face.load();
      document.fonts.add(face);
      state.faces[slot] = family;
      return family;
    } catch (e) {
      return null;
    }
  }

  async function ensureHansPreview() {
    if (state.faces.hans) {
      applyPreviewFont();
      return;
    }
    if (!state.slots.hans || !state.slots.hans.set) {
      applyPreviewFont();
      return;
    }
    $('#preview-badge').textContent = '读取字体中…';
    try {
      const bytes = await B.readBytes('hans');
      const family = await loadFace('hans', bytes);
      if (family) {
        const info = window.FontInfo.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        if (info) state.meta.hans = info;
      }
      applyPreviewFont();
      renderAll();
    } catch (e) {
      $('#preview-badge').textContent = '预览不可用';
    }
  }

  function applyPreviewFont() {
    const el = $('#preview-text');
    const face = state.faces.hans;
    el.style.fontFamily = face ? `'${face}', var(--fallback, sans-serif)` : '';
    el.style.fontVariationSettings = `"wght" ${state.weight}`;
    el.style.fontWeight = state.weight;
    const m = state.meta.hans;
    $('#preview-badge').textContent = m ? `${m.family}${m.variable ? ' · 可变' : ''}` : '系统默认字体';

    // 只有真正带 wght 轴的字体，字重滑杆才有意义
    const hasAxis = !!(m && m.variable && m.weightAxis);
    const row = $('#weight-row');
    const range = $('#weight-range');
    if (row) row.classList.toggle('is-off', !!m && !hasAxis);
    if (range) {
      range.disabled = !!m && !hasAxis;
      if (hasAxis) {
        range.min = Math.round(m.weightAxis.min);
        range.max = Math.round(m.weightAxis.max);
        if (state.weight < range.min || state.weight > range.max) {
          state.weight = Math.min(Math.max(state.weight, +range.min), +range.max);
          range.value = state.weight;
          $('#weight-val').textContent = state.weight;
          el.style.fontVariationSettings = `"wght" ${state.weight}`;
        }
      } else {
        range.min = 100;
        range.max = 1000;
      }
    }
  }

  /* ───────────────────── 选字体 ───────────────────── */
  function pickFor(slot) {
    state.pendingSlot = slot;
    const input = $('#picker');
    input.value = '';
    input.click();
  }

  async function handleFile(slot, file) {
    if (!file) return;
    if (/\.ttc$/i.test(file.name)) {
      toast('.ttc 字体合集请先拆成单个 .ttf', 'err');
      return;
    }
    if (!/\.(ttf|otf)$/i.test(file.name)) {
      toast('只支持 .ttf / .otf', 'err');
      return;
    }
    if (file.size > 48 * 1024 * 1024) {
      toast('文件超过 48MB', 'err');
      return;
    }

    const buf = await file.arrayBuffer();
    const info = window.FontInfo.parse(buf.slice(0));
    if (info) state.meta[slot] = info;

    setProgress('写入 ' + file.name, 0);
    try {
      await B.write(slot, file, (p) => setProgress('写入 ' + file.name, p));
      const family = await loadFace(slot, new Uint8Array(buf));
      state.slots[slot] = { set: true, size: file.size };
      renderAll();
      setProgress(null);
      toast(`${SLOTS.find((s) => s.id === slot).name} 已就绪 · 记得点「应用字体」`);
      if (slot === 'hans') applyPreviewFont();
      if (info && slot === 'en' && info.coverage.cjk > 200) {
        setTimeout(() => toast('这个西文字体带汉字，可能盖掉中文（可在 apply.sh 里启用裁切）', 'err'), 1400);
      }
    } catch (e) {
      setProgress(null);
      toast('写入失败：' + (e.message || e), 'err');
    }
  }

  /* ───────────────────── 操作 ───────────────────── */
  async function doApply() {
    const count = SLOTS.filter((s) => (state.slots[s.id] || {}).set).length;
    if (!count) {
      toast('先选一个简体字体吧', 'err');
      go('slots');
      return;
    }
    setProgress('正在铺字体到 system/fonts…', 0.25);
    const timer = setTimeout(() => setProgress('正在铺字体到 system/fonts…', 0.7), 700);
    const r = await B.apply();
    clearTimeout(timer);
    setProgress(null);
    if (r.ok) {
      state.applied = true;
      updateStats();
      toast('已应用 · 重启后全局生效');
    } else {
      toast('应用失败，去「更多」看日志', 'err');
      $('#log-box').hidden = false;
      $('#log-box').textContent = r.out || '';
    }
  }

  async function doClear(slot) {
    await B.clear(slot);
    state.slots[slot] = { set: false, size: 0 };
    delete state.meta[slot];
    delete state.faces[slot];
    renderAll();
    toast('已清空该槽位（重启后还原系统字体）');
  }

  /* ───────────────────── 事件绑定 ───────────────────── */
  function bind() {
    $$('.dock-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

    $('#theme-btn').addEventListener('click', () => {
      const now = document.documentElement.getAttribute('data-theme');
      applyTheme(now === 'dark' ? 'light' : 'dark');
    });

    $('#apply-btn').addEventListener('click', doApply);
    $('#apply-btn-2').addEventListener('click', doApply);
    $('#reload-btn').addEventListener('click', () => refresh(false));

    $('#clear-all').addEventListener('click', async () => {
      if (!confirm('清空全部槽位字体？重启后恢复系统默认。')) return;
      setProgress('清理中…', 0.5);
      await B.clearAll();
      state.slots = {};
      state.meta = {};
      state.faces = {};
      setProgress(null);
      renderAll();
      toast('已清空全部槽位');
    });

    $('#picker').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f && state.pendingSlot) handleFile(state.pendingSlot, f);
    });

    // 槽位卡片：委托
    $('#slot-list').addEventListener('click', (e) => {
      const card = e.target.closest('.slot');
      if (!card) return;
      const slot = card.dataset.slot;
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'pick') pickFor(slot);
      if (act.dataset.act === 'clear') doClear(slot);
      if (act.dataset.act === 'peek') peek(slot);
    });

    // 概览里的迷你项 → 跳到槽位页
    $('#mini-list').addEventListener('click', (e) => {
      const item = e.target.closest('.mini');
      if (!item) return;
      go('slots');
      const card = $(`.slot[data-slot="${item.dataset.slot}"]`);
      if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    });

    // 预览控件
    $('#size-range').addEventListener('input', (e) => {
      $('#size-val').textContent = e.target.value;
      $('#preview-text').style.fontSize = e.target.value + 'px';
    });
    $('#weight-range').addEventListener('input', (e) => {
      state.weight = +e.target.value;
      $('#weight-val').textContent = state.weight;
      applyPreviewFont();
    });
    $('#sample-seg').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      $$('.seg-btn', $('#sample-seg')).forEach((b) => b.classList.toggle('is-on', b === btn));
      $('#preview-text').textContent = SAMPLES[btn.dataset.sample];
    });

    // 更多页
    $('#log-btn').addEventListener('click', async () => {
      const box = $('#log-box');
      box.hidden = false;
      box.textContent = '读取中…';
      box.textContent = await B.lastLog();
    });

    const bindSwitch = (sel, fn) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('click', fn);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fn();
        }
      });
    };
    bindSwitch('#fb-sw', toggleFallback);
    bindSwitch('#gms-sw', toggleGms);

    $('#hide-btn').addEventListener('click', toggleHide);

    $('#restore-btn').addEventListener('click', async () => {
      if (!confirm('还原系统默认字体？会删除模块内所有字体文件。')) return;
      setProgress('还原中…', 0.6);
      const r = await B.restore();
      setProgress(null);
      state.slots = {};
      state.meta = {};
      state.faces = {};
      state.applied = false;
      renderAll();
      toast(r.ok ? '已还原 · 重启后生效' : '还原失败', r.ok ? '' : 'err');
    });

    window.addEventListener('resize', moveInd);

    // 液体透镜
    const lens = $('#lens');
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      let raf = 0, tx = 0, ty = 0;
      document.addEventListener('pointermove', (e) => {
        tx = e.clientX; ty = e.clientY;
        lens.classList.add('is-on');
        if (!raf) {
          raf = requestAnimationFrame(() => {
            lens.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
            raf = 0;
          });
        }
      });
      document.addEventListener('pointerleave', () => lens.classList.remove('is-on'));
    }

    // 按钮涟漪
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('.btn');
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2;
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = size + 'px';
      span.style.left = e.clientX - r.left - size / 2 + 'px';
      span.style.top = e.clientY - r.top - size / 2 + 'px';
      btn.appendChild(span);
      setTimeout(() => span.remove(), 640);
    });
  }

  async function peek(slot) {
    if (state.faces[slot]) {
      toast(state.meta[slot] ? state.meta[slot].family : '已加载');
      return;
    }
    if (!(state.slots[slot] || {}).set) {
      pickFor(slot);
      return;
    }
    setProgress('读取字体…', 0);
    try {
      const bytes = await B.readBytes(slot, (p) => setProgress('读取字体…', p));
      const family = await loadFace(slot, bytes);
      const info = window.FontInfo.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (info) state.meta[slot] = info;
      setProgress(null);
      renderAll();
      if (slot === 'hans') applyPreviewFont();
      if (!family) toast('这个字体无法被浏览器渲染', 'err');
    } catch (e) {
      setProgress(null);
      toast('读取失败：' + (e.message || e), 'err');
    }
  }

  /* ───────────────────── 启动 ───────────────────── */
  initTheme();
  bind();
  renderAll();
  moveInd();
  refresh(true);

  // 字体就绪后重绘一次（防止 FontFace 异步加载导致的字形缺失）
  document.fonts && document.fonts.ready && document.fonts.ready.then(() => {
    if (state.faces.hans) applyPreviewFont();
  });

  window.LF.app = { go, refresh, state };
})();
