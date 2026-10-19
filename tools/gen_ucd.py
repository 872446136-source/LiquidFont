#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_ucd.py — 生成 WebUI 内置的 Unicode 码位数据

复刻 Font_Weight_Test-KMP 的筛选逻辑（shared/.../utils/UnicodeCoverage.kt）：

  Unihan 模式 = Scripts.txt 里 Script 为 Han 的区间
              + ScriptExtensions.txt 里含 Hani、且起点落在 Han 块内的区间
              → 合并区间 → 展开

  Unicode 模式 = UnicodeData.txt 全部已分配码位，
               剔除 Cc/Cf/Co/Cs/Cn（控制、格式、私用、代理、未分配）
               与 Zs/Zl/Zp（空白）、Mn（组合记号）

  Blocks.txt  → 分块统计用

用法：
  python tools/gen_ucd.py <ucd 目录> <输出 js 路径>

<ucd 目录> 里需要 Scripts.txt / ScriptExtensions.txt / UnicodeData.txt / Blocks.txt。
产物是 webroot/assets/ucd.js，挂到 window.LF_UCD。
"""

import json
import re
import sys
from pathlib import Path

FILTERED = {"Cc", "Cf", "Co", "Cs", "Cn", "Zs", "Zl", "Zp", "Mn"}


def read(path):
    return Path(path).read_text(encoding="utf-8", errors="replace")


def parse_range(text):
    """'20000..2A6DF' 或 '4E00' → (start, end)；解析失败返回 None"""
    parts = text.split("..")
    try:
        if len(parts) == 2:
            return int(parts[0], 16), int(parts[1], 16)
        if len(parts) == 1:
            v = int(parts[0], 16)
            return v, v
    except ValueError:
        pass
    return None


def merge_ranges(ranges):
    """排序后合并相邻/重叠区间"""
    if not ranges:
        return []
    ranges = sorted(ranges)
    out = [list(ranges[0])]
    for s, e in ranges[1:]:
        if s <= out[-1][1] + 1:
            if e > out[-1][1]:
                out[-1][1] = e
        else:
            out.append([s, e])
    return [tuple(r) for r in out]


def load_blocks(text):
    blocks = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or ";" not in line:
            continue
        rng, name = line.split(";", 1)
        r = parse_range(rng.strip())
        if r:
            blocks.append((r[0], r[1], name.strip()))
    blocks.sort()
    return blocks


def find_block(blocks, cp):
    lo, hi = 0, len(blocks) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        s, e, name = blocks[mid]
        if cp > e:
            lo = mid + 1
        elif cp < s:
            hi = mid - 1
        else:
            return name
    return None


def load_han(scripts_text, ext_text, blocks):
    ranges = []
    for line in scripts_text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split(";")
        if len(parts) < 2 or parts[1].strip() != "Han":
            continue
        r = parse_range(parts[0].strip())
        if r:
            ranges.append(r)

    han_blocks = set()
    for s, e in ranges:
        for bs, be, name in blocks:
            if be < s:
                continue
            if bs > e:
                break
            han_blocks.add(name)

    for line in ext_text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split(";")
        if len(parts) < 2:
            continue
        if "Hani" not in parts[1].strip().split(" "):
            continue
        r = parse_range(parts[0].strip())
        if not r:
            continue
        name = find_block(blocks, r[0])
        if name and name in han_blocks:
            ranges.append(r)

    return merge_ranges(ranges)


def load_unicode(unicode_data_text):
    ranges = []
    pending = None
    for line in unicode_data_text.splitlines():
        if not line or line.startswith("#"):
            continue
        f = line.split(";")
        if len(f) < 3:
            continue
        try:
            cp = int(f[0], 16)
        except ValueError:
            continue
        name = f[1]
        cat = f[2]
        filtered = cat in FILTERED

        if name.endswith("First>"):
            pending = -2 if filtered else cp
            continue
        if name.endswith("Last>"):
            if pending is not None and pending >= 0:
                ranges.append((pending, cp))
            pending = None
            continue
        if filtered:
            continue
        ranges.append((cp, cp))
    return merge_ranges(ranges)


def meta(text, prefix):
    ver = date = None
    for line in text.splitlines():
        line = line.strip()
        if ver is None:
            m = re.match(r"^#\s*" + prefix + r"-(\d+(?:\.\d+){2})\.txt$", line)
            if m:
                ver = m.group(1)
        if date is None:
            m = re.match(r"^#\s*Date:\s*(.+)$", line)
            if m:
                date = m.group(1).strip()
        if ver and date:
            break
    return ver, date


def encode_ranges(ranges):
    """区间压成 base36 字符串：每段 'startDelta.endDelta'，段间用 ',' 分隔"""
    out = []
    prev = 0
    for s, e in ranges:
        ds = s - prev
        de = e - s
        out.append(f"{ds:x}.{de:x}")
        prev = e + 1
    return ",".join(out)


def expand(ranges):
    n = 0
    for s, e in ranges:
        n += e - s + 1
    return n


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])

    scripts = read(src / "Scripts.txt")
    ext = read(src / "ScriptExtensions.txt")
    udata = read(src / "UnicodeData.txt")
    blocks_text = read(src / "Blocks.txt")

    blocks = load_blocks(blocks_text)
    han = load_han(scripts, ext, blocks)
    uni = load_unicode(udata)

    ver, date = meta(scripts, "Scripts")
    if not ver:
        ver, date = meta(ext, "ScriptExtensions")

    han_n = expand(han)
    uni_n = expand(uni)

    payload = {
        "v": ver or "",
        "d": date or "",
        "hn": han_n,
        "un": uni_n,
        "han": encode_ranges(han),
        "uni": encode_ranges(uni),
        "blocks": [[s, e, n] for s, e, n in blocks],
    }

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    js = (
        "/* ucd.js — Unicode 码位数据（由 tools/gen_ucd.py 生成，勿手改）\n"
        f"   Unicode {payload['v']} · {payload['d']}\n"
        f"   Han 脚本 {han_n:,} 码位 · 全码位 {uni_n:,} 码位 */\n"
        "window.LF_UCD = " + body + ";\n"
    )
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(js, encoding="utf-8", newline="\n")

    print(f"Unicode {payload['v']} ({payload['d']})")
    print(f"  Han 脚本   {han_n:,} 码位 / {len(han)} 段")
    print(f"  全码位     {uni_n:,} 码位 / {len(uni)} 段")
    print(f"  区块       {len(blocks)} 个")
    print(f"  输出       {dst}  {dst.stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
