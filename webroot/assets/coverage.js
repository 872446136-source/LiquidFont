/* ═══════════════════════════════════════════════════════════
   coverage.js — Unicode 覆盖率检测
   ═══════════════════════════════════════════════════════════
   复刻 Font_Weight_Test-KMP 的测量口径：
     · 码位集合来自 ucd.js（Unicode 18.0：Unihan 103,389 / 全码位 170,529）
     · 「有没有字形」看的是渲染结果，也就是整条系统字体兜底链，
       不是某个字体文件的 cmap —— 和原版 Paint.hasGlyph 语义一致
     · 分批处理、分块统计、按百分比评级，与原版对齐

   为什么慢：缺字每判一次都要遍历整条兜底链，实测约 360µs/字；
   17 万码位里有 6 万多个缺字，所以整体在十秒量级。
   试过用 measureText 的宽度/包围盒做快路，结果与逐像素完全一致
   （Han 模式 103,389 字零分歧），但耗时一模一样——因为慢的是
   兜底链本身，不是光栅化。所以这里直接用逐像素比对，不做折衷。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const CW = 16;        // 格子宽（像素）
  const CH = 20;        // 格子高
  const SIZE = 14;      // 字号
  const STRIP = 64;     // 一次光栅化多少个字
  const BUDGET = 32;    // 单次占用主线程的毫秒上限

  // 校准样本：未分配区，任何字体都不会有字形
  const UNASSIGNED = [0x0378, 0x0380, 0x0530, 0x0590, 0x0c5b, 0x1c3b];
  // 反向校验：这几个必须有字形
  const PRESENT = [0x41, 0x4e2d, 0x3042];

  const GRADE = [
    [99.99, 'PG'], [96, 'EX'], [90, 'A'], [82, 'B'],
    [70, 'C'], [62, 'D'], [42, 'E']
  ];

  function gradeFromScore(score) {
    for (let i = 0; i < GRADE.length; i++) {
      if (score >= GRADE[i][0]) return GRADE[i][1];
    }
    return 'F';
  }

  /* ───────────── 让出主线程 ─────────────
     setTimeout(0) 在嵌套几层之后会被钳到 4ms，几千次下来白等十几秒。
     MessageChannel 没有这个钳制，是标准的「尽快回到事件循环」做法。 */
  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
  let yieldFn = null;
  if (channel) {
    channel.port1.onmessage = function () {
      const fn = yieldFn;
      yieldFn = null;
      if (fn) fn();
    };
  }
  function yieldTo(fn) {
    if (channel) {
      yieldFn = fn;
      channel.port2.postMessage(0);
    } else {
      setTimeout(fn, 0);
    }
  }

  /* ───────────── 码位数据 ───────────── */

  function decodeRanges(s) {
    const out = [];
    let prev = 0;
    if (!s) return out;
    const parts = s.split(',');
    for (let i = 0; i < parts.length; i++) {
      const dot = parts[i].indexOf('.');
      const s0 = prev + parseInt(parts[i].slice(0, dot), 16);
      const e0 = s0 + parseInt(parts[i].slice(dot + 1), 16);
      out.push([s0, e0]);
      prev = e0 + 1;
    }
    return out;
  }

  function expand(ranges, cap) {
    const arr = new Int32Array(cap);
    let n = 0;
    for (let i = 0; i < ranges.length; i++) {
      const s = ranges[i][0];
      const e = ranges[i][1];
      for (let cp = s; cp <= e; cp++) arr[n++] = cp;
    }
    return arr.subarray(0, n);
  }

  const cache = { han: null, uni: null };

  function codePoints(mode) {
    const U = window.LF_UCD;
    if (!U) return null;
    if (mode === 'han') {
      if (!cache.han) cache.han = expand(decodeRanges(U.han), U.hn);
      return cache.han;
    }
    if (!cache.uni) cache.uni = expand(decodeRanges(U.uni), U.un);
    return cache.uni;
  }

  /* ───────────── 画布 ───────────── */

  function makeCanvas() {
    const cv = document.createElement('canvas');
    cv.width = STRIP * CW;
    cv.height = CH;
    // 刻意不开 willReadFrequently：大画布上它会让 fillText 慢 30 倍（实测）。
    const g = cv.getContext('2d');
    g.font = SIZE + 'px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    return { cv: cv, g: g };
  }

  function tofuBitmap(g, cv, cp) {
    const out = new Uint32Array(CW * CH);
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillText(String.fromCodePoint(cp), CW / 2, CH / 2);
    const d = g.getImageData(0, 0, CW, CH).data;
    const u = new Uint32Array(d.buffer, d.byteOffset, CW * CH);
    for (let i = 0; i < CW * CH; i++) out[i] = u[i];
    return out;
  }

  function calibrate(g, cv) {
    // 缺字方框必须「长得都一样」，逐像素比对才有意义。
    // 有的渲染器会给缺字画带码位的方框，那样每个缺字都不同，判据就失效了。
    const ref = tofuBitmap(g, cv, UNASSIGNED[0]);
    let uniform = true;
    for (let i = 1; i < UNASSIGNED.length; i++) {
      const other = tofuBitmap(g, cv, UNASSIGNED[i]);
      for (let k = 0; k < CW * CH; k++) {
        if (other[k] !== ref[k]) { uniform = false; break; }
      }
      if (!uniform) break;
    }

    // 真字形必须和豆腐块不同，否则说明整套判定失效
    let presentOk = false;
    for (let i = 0; i < PRESENT.length; i++) {
      const p = tofuBitmap(g, cv, PRESENT[i]);
      let same = true;
      for (let k = 0; k < CW * CH; k++) {
        if (p[k] !== ref[k]) { same = false; break; }
      }
      if (!same) { presentOk = true; break; }
    }

    return { ok: uniform && presentOk, uniform: uniform, presentOk: presentOk, tofu: ref };
  }

  /* ───────────── 分块统计 ───────────── */

  function blockIndexer(blocks) {
    let i = 0;
    return function (cp) {
      while (i < blocks.length && cp > blocks[i][1]) i++;
      if (i < blocks.length && cp >= blocks[i][0]) return blocks[i][2];
      return 'Unknown';
    };
  }

  /* ───────────── 主流程 ───────────── */

  /**
   * @param {Object} opt
   *   mode        'han' | 'uni'
   *   onProgress  每批回调 { processed, supported, total, pct, cp }
   *   onDone      完成回调，参数是结果对象
   *   onError     出错回调，参数是 Error
   * @returns {{ cancel: Function }}
   */
  function start(opt) {
    const U = window.LF_UCD;
    const mode = opt.mode === 'uni' ? 'uni' : 'han';
    let cancelled = false;
    let running = false;

    if (!U) {
      setTimeout(function () {
        if (opt.onError) opt.onError(new Error('缺少 ucd.js，无法载入码位数据'));
      }, 0);
      return { cancel: function () {} };
    }

    const cps = codePoints(mode);
    const total = cps.length;
    const blocks = (U.blocks || []).map(function (b) { return [b[0], b[1], b[2]]; });
    const blockOf = blockIndexer(blocks);

    const canvas = makeCanvas();
    const g = canvas.g;
    const cv = canvas.cv;
    const cal = calibrate(g, cv);

    const stat = Object.create(null);   // 块名 → [supported, total]
    let processed = 0;
    let supported = 0;
    const t0 = performance.now();

    function step() {
      if (cancelled || !running) return;
      const deadline = performance.now() + BUDGET;

      while (processed < total) {
        const n = Math.min(STRIP, total - processed);

        g.clearRect(0, 0, cv.width, cv.height);
        for (let k = 0; k < n; k++) {
          g.fillText(String.fromCodePoint(cps[processed + k]), k * CW + CW / 2, CH / 2);
        }
        const d = g.getImageData(0, 0, n * CW, CH).data;
        const u = new Uint32Array(d.buffer, d.byteOffset, n * CW * CH);
        const stride = n * CW;
        const tofu = cal.tofu;

        for (let k = 0; k < n; k++) {
          let has = false;
          for (let y = 0; y < CH && !has; y++) {
            const row = y * stride + k * CW;
            const rr = y * CW;
            for (let x = 0; x < CW; x++) {
              if (u[row + x] !== tofu[rr + x]) { has = true; break; }
            }
          }

          const cp = cps[processed + k];
          const name = blockOf(cp);
          let s = stat[name];
          if (!s) s = stat[name] = [0, 0];
          s[1]++;
          if (has) { s[0]++; supported++; }
        }

        processed += n;
        if (performance.now() >= deadline) break;
      }

      if (opt.onProgress) {
        opt.onProgress({
          processed: processed,
          supported: supported,
          total: total,
          pct: total ? (processed / total) * 100 : 0,
          cp: cps[Math.min(processed, total - 1)]
        });
      }

      if (processed < total) yieldTo(step);
      else finish();
    }

    function finish() {
      running = false;
      const durationMs = Math.round(performance.now() - t0);
      const pct = total ? (supported / total) * 100 : 0;
      const list = [];
      for (const name in stat) {
        const s = stat[name];
        const p = s[1] ? (s[0] / s[1]) * 100 : 0;
        list.push({
          name: name,
          supported: s[0],
          total: s[1],
          pct: p,
          grade: gradeFromScore(p)
        });
      }
      list.sort(function (a, b) { return b.pct - a.pct; });

      if (opt.onDone) {
        opt.onDone({
          mode: mode,
          supported: supported,
          total: total,
          pct: pct,
          grade: gradeFromScore(pct),
          durationMs: durationMs,
          version: U.v,
          date: U.d,
          reliable: cal.ok,
          uniformTofu: cal.uniform,
          presentOk: cal.presentOk,
          blocks: list
        });
      }
    }

    running = true;
    yieldTo(step);

    return {
      cancel: function () {
        cancelled = true;
        running = false;
      }
    };
  }

  window.LF_COVERAGE = {
    start: start,
    gradeFromScore: gradeFromScore,
    available: function () { return !!window.LF_UCD; },
    version: function () { return window.LF_UCD ? window.LF_UCD.v : ''; },
    date: function () { return window.LF_UCD ? window.LF_UCD.d : ''; },
    totals: function () {
      const U = window.LF_UCD;
      return U ? { han: U.hn, uni: U.un } : { han: 0, uni: 0 };
    }
  };
})();
