/* ═══════════════════════════════════════════════════════════
   test.js — 字体测试页
   ═══════════════════════════════════════════════════════════
   字重、字族、可变字体、Unicode 覆盖率四组测试，
   测试项与样本文字对齐 YuKongA / Font_Weight_Test（Apache-2.0）。

   覆盖率部分不读字体文件的 cmap，而是逐字光栅化比对，
   量的是「整条系统兜底链现在能不能画出这个字」，
   和原版 Paint.hasGlyph 的语义一致。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /* 九档标准字重，与 FontUtils.kt 的 fontWeightsList / fontWeightDescriptions 一致 */
  const WEIGHTS = [
    [100, '淡体 Thin (Hairline)'],
    [200, '特细 ExtraLight (UltraLight)'],
    [300, '细体 Light'],
    [400, '标准 Normal (Regular)'],
    [500, '适中 Medium'],
    [600, '次粗 SemiBold (DemiBold)'],
    [700, '粗体 Bold'],
    [800, '特粗 ExtraBold (UltraBold)'],
    [900, '浓体 Black (Heavy)']
  ];

  const CMP_TEXT = '永 の 한 A 6';
  const FAM_TEXT = '伤仲永 にほんご 한국어 AaBbCc 123';
  const MORE_TEXT = '不以物喜，不以己悲。——范仲淹《岳阳楼记》\n' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ\n' +
    'abcdefghijklmnopqrstuvwxyz\n' +
    '0123456789,.';
  const FAMILIES = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' };

  const cov = {
    mode: 'han',
    running: false,
    handle: null,
    hide: false,
    results: { han: null, uni: null }
  };

  /* ───────────── 字重 ───────────── */

  function renderWeights() {
    const all = $('#wt-all');
    if (all) {
      all.innerHTML = WEIGHTS.map(([w, name]) =>
        '<div class="wt-row"><i>' + w + '</i>' +
        '<span style="font-weight:' + w + '">' + w + ' · ' + esc(name) + '</span></div>'
      ).join('');
    }

    const cmp = $('#wt-compare');
    if (cmp) {
      cmp.innerHTML = WEIGHTS.map(([w]) =>
        '<div class="wt-row cmp"><i>' + w + '</i>' +
        '<span style="font-weight:' + w + '">' + esc(CMP_TEXT) + '</span></div>'
      ).join('');
    }
  }

  /* ───────────── 字族 ───────────── */

  let fam = 'sans';

  function renderFamily() {
    const ff = FAMILIES[fam] || 'sans-serif';
    const normal = $('#fam-normal');
    const italic = $('#fam-italic');
    const more = $('#fam-more');

    if (normal) {
      normal.innerHTML = WEIGHTS.map(([w]) =>
        '<div class="fam-row"><i>' + w + '</i>' +
        '<span style="font-family:' + ff + ';font-weight:' + w + '">' + esc(FAM_TEXT) + '</span></div>'
      ).join('');
    }

    if (italic) {
      italic.innerHTML = WEIGHTS.map(([w]) =>
        '<div class="fam-row"><i>' + w + '</i>' +
        '<span style="font-family:' + ff + ';font-weight:' + w + ';font-style:italic">' + esc(FAM_TEXT) + '</span></div>'
      ).join('');
    }

    if (more) {
      more.innerHTML = WEIGHTS.map(([w]) =>
        '<div class="fam-more">' +
        '<em>— ' + w + ' —</em>' +
        '<p style="font-family:' + ff + ';font-weight:' + w + '">' + esc(MORE_TEXT) + '</p>' +
        '<p style="font-family:' + ff + ';font-weight:' + w + ';font-style:italic">' + esc(MORE_TEXT) + '</p>' +
        '</div>'
      ).join('');
    }
  }

  /* ───────────── 可变字体 ───────────── */

  function applyVariable() {
    const out = $('#vf-out');
    if (!out) return;
    const w = +$('#vf-w').value;
    const s = +$('#vf-s').value;
    const text = $('#vf-text').value;

    $('#vf-w-val').textContent = w;
    $('#vf-s-val').textContent = s;
    out.textContent = text || '永 の 한 A 6';
    out.style.fontSize = s + 'px';
    out.style.fontWeight = w;
    out.style.fontVariationSettings = '"wght" ' + w;
  }

  /* ───────────── Unicode 覆盖率 ───────────── */

  function fmtDuration(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
  }

  function covDesc() {
    const C = window.LF_COVERAGE;
    const t = C ? C.totals() : { han: 0, uni: 0 };
    if (cov.mode === 'han') {
      return '只测 Han 脚本的 <b>' + num(t.han) + '</b> 个汉字（含扩展 B–J）。' +
        '生僻字能不能显示，看这一项就够了。';
    }
    return '测 <b>' + num(t.uni) + '</b> 个已分配码位（已去掉控制符、空白与组合记号），' +
      '覆盖全部文字系统，耗时大约是 Unihan 的两倍多。';
  }

  function renderCovDesc() {
    const d = $('#cov-desc');
    if (d) d.innerHTML = covDesc();
    const tip = $('#cov-tip');
    if (tip) {
      const C = window.LF_COVERAGE;
      tip.textContent = C && C.available()
        ? '逐字比对渲染结果，缺字多的字体耗时更长；检测期间可以随时取消。'
        : '缺少码位数据（ucd.js），覆盖率检测不可用。';
    }
  }

  function gradeClass(g) {
    return 'g-' + String(g || '').toLowerCase();
  }

  function renderCovBlocks(res) {
    const box = $('#cov-blocks');
    if (!box || !res) return;
    const list = res.blocks.filter((b) => !(cov.hide && b.supported === b.total));
    if (!list.length) {
      box.innerHTML = '<p class="hint dim" style="margin-top:0">全部区块都是 100%，已被过滤。</p>';
      return;
    }
    box.innerHTML = list.map((b) =>
      '<div class="cov-block">' +
      '<span>' + esc(b.name) + '</span>' +
      '<em>' + num(b.supported) + '/' + num(b.total) + '</em>' +
      '<b class="' + gradeClass(b.grade) + '">' + esc(b.grade) + '</b>' +
      '</div>'
    ).join('');
  }

  function renderCovResult(res) {
    const box = $('#cov-result');
    const chip = $('#cov-chip');
    if (!res) {
      if (box) box.hidden = true;
      if (chip) { chip.textContent = '未检测'; chip.className = 'chip'; }
      return;
    }
    if (box) box.hidden = false;

    const g = $('#cov-grade');
    g.textContent = res.grade;
    g.className = gradeClass(res.grade);
    $('#cov-ratio').textContent = num(res.supported) + ' / ' + num(res.total) + ' 码位';
    $('#cov-sub').textContent = res.pct.toFixed(2) + '%';
    $('#cov-ver').textContent = res.version || '—';
    $('#cov-time').textContent = fmtDuration(res.durationMs);
    $('#cov-rel').textContent = res.reliable ? '豆腐块基准一致' : '基准异常';
    $('#cov-rel').className = res.reliable ? '' : 'warn';

    if (chip) {
      chip.textContent = res.grade + ' · ' + res.pct.toFixed(1) + '%';
      chip.className = 'chip' + (res.reliable ? '' : ' warn');
    }

    renderCovBlocks(res);
  }

  function setCovRunning(on) {
    cov.running = on;
    const btn = $('#cov-run');
    if (!btn) return;
    btn.classList.toggle('danger', on);
    btn.classList.toggle('primary', !on);
    btn.innerHTML = on
      ? '<span class="btn-shine"></span>取消检测'
      : '<span class="btn-shine"></span>开始检测';
    const seg = $('#cov-seg');
    if (seg) seg.style.opacity = on ? '.45' : '';
    if (seg) seg.style.pointerEvents = on ? 'none' : '';
  }

  function startCoverage() {
    const C = window.LF_COVERAGE;
    if (!C || !C.available()) {
      if (window.LF && LF.toast) LF.toast('缺少码位数据，无法检测', 'err');
      return;
    }
    if (cov.running) {
      if (cov.handle) cov.handle.cancel();
      cov.handle = null;
      setCovRunning(false);
      $('#cov-progress').hidden = true;
      renderCovResult(cov.results[cov.mode]);
      if (window.LF && LF.toast) LF.toast('已取消检测');
      return;
    }

    cov.results[cov.mode] = null;
    renderCovResult(null);

    const prog = $('#cov-progress');
    prog.hidden = false;
    $('#cov-result').hidden = true;
    $('#cov-bar').style.width = '0%';
    $('#cov-pct').textContent = '0%';
    $('#cov-stage').textContent = cov.mode === 'han' ? '检测 Unihan…' : '检测 Unicode…';
    $('#cov-cur').textContent = '—';
    $('#cov-glyph').textContent = '';
    const chip = $('#cov-chip');
    if (chip) { chip.textContent = '检测中'; chip.className = 'chip warn'; }
    setCovRunning(true);

    cov.handle = C.start({
      mode: cov.mode,
      onProgress: (p) => {
        $('#cov-bar').style.width = p.pct.toFixed(1) + '%';
        $('#cov-pct').textContent = p.pct.toFixed(1) + '%';
        $('#cov-stage').textContent =
          num(p.processed) + ' / ' + num(p.total) + ' · 已有字形 ' + num(p.supported);
        const ch = String.fromCodePoint(p.cp);
        $('#cov-glyph').textContent = ch;
        $('#cov-cur').textContent = 'U+' + p.cp.toString(16).toUpperCase().padStart(4, '0');
      },
      onDone: (res) => {
        cov.handle = null;
        setCovRunning(false);
        prog.hidden = true;
        cov.results[cov.mode] = res;
        renderCovResult(res);
        if (!res.reliable) {
          if (window.LF && LF.toast) LF.toast('缺字方框不统一，判定结果仅供参考', 'err');
        }
      },
      onError: (e) => {
        cov.handle = null;
        setCovRunning(false);
        prog.hidden = true;
        if (window.LF && LF.toast) LF.toast('检测失败：' + (e.message || e), 'err');
      }
    });
  }

  function selectMode(mode) {
    if (cov.running) return;
    cov.mode = mode === 'uni' ? 'uni' : 'han';
    Array.from(document.querySelectorAll('#cov-seg .seg-btn')).forEach((b) => {
      b.classList.toggle('is-on', b.dataset.mode === cov.mode);
    });
    renderCovDesc();
    renderCovResult(cov.results[cov.mode]);
  }

  /* ───────────── 绑定 ───────────── */

  function bind() {
    Array.from(document.querySelectorAll('#fam-seg .seg-btn')).forEach((b) => {
      b.addEventListener('click', () => {
        fam = b.dataset.fam;
        Array.from(document.querySelectorAll('#fam-seg .seg-btn')).forEach((x) => {
          x.classList.toggle('is-on', x === b);
        });
        renderFamily();
      });
    });

    ['#vf-w', '#vf-s'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('input', applyVariable);
    });
    const ti = $('#vf-text');
    if (ti) ti.addEventListener('input', applyVariable);

    Array.from(document.querySelectorAll('#cov-seg .seg-btn')).forEach((b) => {
      b.addEventListener('click', () => selectMode(b.dataset.mode));
    });
    const run = $('#cov-run');
    if (run) run.addEventListener('click', startCoverage);
    const hide = $('#cov-hide');
    if (hide) {
      hide.addEventListener('change', () => {
        cov.hide = hide.checked;
        renderCovBlocks(cov.results[cov.mode]);
      });
    }
  }

  /* ───────────── 启动 ───────────── */

  function render() {
    renderWeights();
    renderFamily();
    applyVariable();
    renderCovDesc();

    const ucd = $('#test-ucd');
    const C = window.LF_COVERAGE;
    if (ucd) {
      if (C && C.available()) {
        const t = C.totals();
        ucd.textContent = C.version() + ' · ' + num(t.han) + ' / ' + num(t.uni);
      } else {
        ucd.textContent = '未载入';
      }
    }
    if (C && !C.available()) {
      const btn = $('#cov-run');
      if (btn) btn.disabled = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bind(); render(); });
  } else {
    bind();
    render();
  }

  window.LF_TEST = { render: render };
})();
