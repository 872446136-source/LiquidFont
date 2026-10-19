/* ═══════════════════════════════════════════════════════════
   fontinfo.js — 极简 sfnt 解析
   只读需要的表：name / head / OS2 / maxp / fvar / cmap
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function tag(v, o) {
    return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  }

  function readName(dv, off, len) {
    // name 表：platformID/encodingID/languageID 决定解码方式
    const count = dv.getUint16(off + 2);
    const strOff = dv.getUint16(off + 4);
    const out = {};
    let best = {};
    for (let i = 0; i < count; i++) {
      const p = off + 6 + i * 12;
      const platform = dv.getUint16(p);
      const encoding = dv.getUint16(p + 2);
      const lang = dv.getUint16(p + 4);
      const nameId = dv.getUint16(p + 6);
      const length = dv.getUint16(p + 8);
      const offset = dv.getUint16(p + 10);
      if (nameId > 8) continue;
      const start = off + strOff + offset;
      if (start + length > off + len) continue;
      let s = '';
      if (platform === 3 || (platform === 0)) {
        for (let j = 0; j < length; j += 2) s += String.fromCharCode(dv.getUint16(start + j));
      } else if (platform === 1) {
        for (let j = 0; j < length; j++) s += String.fromCharCode(dv.getUint8(start + j));
      } else continue;
      s = s.replace(/\u0000/g, '').trim();
      if (!s) continue;
      // 优先级：Windows 英文 > Windows 其它 > Mac
      const score = platform === 3 ? (lang === 0x409 ? 3 : 2) : 1;
      if (!best[nameId] || score > best[nameId].score) best[nameId] = { s, score };
    }
    for (const k in best) out[k] = best[k].s;
    return {
      family: out[1] || out[4] || '未知字体',
      subfamily: out[2] || '',
      full: out[4] || out[1] || '',
      version: out[5] || '',
      psName: out[6] || ''
    };
  }

  const CJK_RANGES = [
    [0x2e80, 0x2fdf], [0x3000, 0x303f], [0x3040, 0x30ff], [0x3100, 0x312f],
    [0x31a0, 0x31bf], [0x31f0, 0x31ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
    [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xffef],
    [0x20000, 0x2a6df], [0x2a700, 0x2ebef], [0x2f800, 0x2fa1f], [0x30000, 0x3134f]
  ];
  const LATIN_RANGES = [[0x20, 0x24f], [0x1e00, 0x1eff], [0x2c60, 0x2c7f], [0xa720, 0xa7ff]];
  const EMOJI_RANGES = [[0x2600, 0x27bf], [0x1f000, 0x1faff], [0xfe00, 0xfe0f]];

  function inRanges(cp, ranges) {
    for (let i = 0; i < ranges.length; i++) {
      if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
    }
    return false;
  }

  // 统计某个码点区间集合被覆盖的数量（按区间求和，不逐个枚举）
  function countCoverage(segments, ranges) {
    let n = 0;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i][0], e = segments[i][1];
      for (let r = 0; r < ranges.length; r++) {
        const lo = Math.max(s, ranges[r][0]);
        const hi = Math.min(e, ranges[r][1]);
        if (hi >= lo) n += hi - lo + 1;
      }
    }
    return n;
  }

  function parseCmap(dv, off, len) {
    const numTables = dv.getUint16(off + 2);
    let best = null, bestScore = -1;
    for (let i = 0; i < numTables; i++) {
      const p = off + 4 + i * 8;
      const platform = dv.getUint16(p);
      const encoding = dv.getUint16(p + 2);
      const sub = off + dv.getUint32(p + 4);
      const format = dv.getUint16(sub);
      let score = 0;
      if (format === 12) score = 100;
      else if (format === 4) score = 60;
      else if (format === 6) score = 20;
      else continue;
      if (platform === 3 && encoding === 10) score += 30;
      if (platform === 3 && encoding === 1) score += 20;
      if (platform === 0) score += 10;
      if (score > bestScore) { bestScore = score; best = { sub, format }; }
    }
    if (!best) return null;

    const segs = [];
    if (best.format === 12) {
      const nGroups = dv.getUint32(best.sub + 12);
      const base = best.sub + 16;
      const max = Math.min(nGroups, 200000);
      for (let i = 0; i < max; i++) {
        const p = base + i * 12;
        if (p + 12 > off + len) break;
        segs.push([dv.getUint32(p), dv.getUint32(p + 4)]);
      }
    } else if (best.format === 4) {
      const segX2 = dv.getUint16(best.sub + 6);
      const segCount = segX2 / 2;
      const endBase = best.sub + 14;
      const startBase = endBase + segX2 + 2;
      for (let i = 0; i < segCount; i++) {
        const end = dv.getUint16(endBase + i * 2);
        const start = dv.getUint16(startBase + i * 2);
        if (start === 0xffff && end === 0xffff) continue;
        if (end >= start) segs.push([start, end]);
      }
    }
    return segs;
  }

  function parseFvar(dv, off, len) {
    const axesOffset = dv.getUint16(off + 4);
    const axisCount = dv.getUint16(off + 8);
    const axisSize = dv.getUint16(off + 10);
    const axes = [];
    for (let i = 0; i < Math.min(axisCount, 32); i++) {
      const p = off + axesOffset + i * axisSize;
      if (p + 20 > off + len) break;
      axes.push({
        tag: tag(dv, p),
        min: +dv.getInt32(p + 4) / 65536,
        def: +dv.getInt32(p + 8) / 65536,
        max: +dv.getInt32(p + 12) / 65536
      });
    }
    return axes;
  }

  function parse(buffer) {
    try {
      const dv = new DataView(buffer);
      if (dv.byteLength < 12) return null;
      let base = 0;
      let sig = tag(dv, 0);
      if (sig === 'ttcf') {
        base = dv.getUint32(12);
        sig = tag(dv, base);
      }
      const ok = sig === 'true' || sig === 'OTTO' || sig === 'typ1' || dv.getUint32(base) === 0x00010000;
      if (!ok) return null;

      const numTables = dv.getUint16(base + 4);
      const tables = {};
      for (let i = 0; i < numTables; i++) {
        const p = base + 12 + i * 16;
        if (p + 16 > dv.byteLength) break;
        tables[tag(dv, p)] = { offset: dv.getUint32(p + 8), length: dv.getUint32(p + 12) };
      }

      const info = {
        family: '未知字体', subfamily: '', full: '', version: '', psName: '',
        unitsPerEm: 1000, weight: 400, italic: false, glyphs: 0,
        variable: false, axes: [], isCFF: sig === 'OTTO',
        coverage: { latin: 0, cjk: 0, emoji: 0 }
      };

      if (tables.name) Object.assign(info, readName(dv, tables.name.offset, tables.name.length));

      if (tables.head && tables.head.length >= 54) {
        info.unitsPerEm = dv.getUint16(tables.head.offset + 18) || 1000;
        const macStyle = dv.getUint16(tables.head.offset + 44);
        info.italic = !!(macStyle & 0x02);
      }
      if (tables['OS/2'] && tables['OS/2'].length >= 64) {
        const o = tables['OS/2'].offset;
        info.weight = dv.getUint16(o + 4) || 400;
        const fs = dv.getUint16(o + 62);
        if (fs & 0x01) info.italic = true;
      }
      if (tables.maxp) info.glyphs = dv.getUint16(tables.maxp.offset + 4);
      if (tables.fvar) {
        info.axes = parseFvar(dv, tables.fvar.offset, tables.fvar.length);
        info.variable = info.axes.length > 0;
        const w = info.axes.find((a) => a.tag === 'wght');
        if (w) info.weightAxis = w;
      }
      if (tables.cmap) {
        const segs = parseCmap(dv, tables.cmap.offset, tables.cmap.length);
        if (segs) {
          info.coverage.latin = countCoverage(segs, LATIN_RANGES);
          info.coverage.cjk = countCoverage(segs, CJK_RANGES);
          info.coverage.emoji = countCoverage(segs, EMOJI_RANGES);
        }
      }
      return info;
    } catch (e) {
      return null;
    }
  }

  global.FontInfo = { parse };
})(window);
