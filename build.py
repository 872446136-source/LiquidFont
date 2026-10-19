#!/usr/bin/env python3
"""LiquidFont 打包脚本：把模块打成可以直接刷入的 zip。

    python build.py            # 产出 dist/LiquidFont-v<version>.zip
    python build.py --no-zip   # 只做完整性检查
"""
from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"

# 需要打进 zip 的条目（相对模块根目录）
INCLUDE = [
    "module.prop",
    "customize.sh",
    "apply.sh",
    "gms.sh",
    "hide.sh",
    "xmlsync.sh",
    "uninstall.sh",
    "META-INF",
    "system",
    "webroot",
    "FONTS",
    "FALLBACK",
    "tools",
]

REQUIRED = [
    "module.prop",
    "customize.sh",
    "apply.sh",
    "xmlsync.sh",
    "META-INF/com/google/android/update-binary",
    "META-INF/com/google/android/updater-script",
    "webroot/index.html",
    "system/etc/fonts.xml",
    "system/system_ext/etc/fonts_base.xml",
    "system/system_ext/etc/fonts_ule.xml",
]

SKIP_SUFFIX = {".pyc", ".DS_Store"}
SKIP_NAMES = {".gitkeep", ".DS_Store", "Thumbs.db"}


def read_prop(key: str) -> str:
    for line in (ROOT / "module.prop").read_text(encoding="utf-8").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def check() -> list[str]:
    problems = [f"缺少必需文件: {p}" for p in REQUIRED if not (ROOT / p).is_file()]
    prop = (ROOT / "module.prop").read_text(encoding="utf-8")
    if not re.search(r"^id=\S+", prop, re.M):
        problems.append("module.prop 缺少 id")
    if not re.search(r"^versionCode=\d+", prop, re.M):
        problems.append("module.prop 缺少 versionCode（必须是整数）")
    return problems


def walk(entry: Path):
    if entry.is_file():
        yield entry
        return
    for p in sorted(entry.rglob("*")):
        if p.is_dir():
            continue
        if p.name in SKIP_NAMES or p.suffix in SKIP_SUFFIX:
            continue
        yield p


def build() -> Path:
    version = read_prop("version") or "0.0.0"
    DIST.mkdir(exist_ok=True)
    out = DIST / f"LiquidFont-v{version}.zip"

    files: list[tuple[Path, str]] = []
    for name in INCLUDE:
        entry = ROOT / name
        if not entry.exists():
            continue
        for p in walk(entry):
            files.append((p, p.relative_to(ROOT).as_posix()))

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        # 空的 FONTS 目录也要留一个条目，方便用户直接往里放字体
        if not any(arc.startswith("FONTS/") for _, arc in files):
            info = zipfile.ZipInfo("FONTS/")
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, "")
        for path, arc in files:
            info = zipfile.ZipInfo.from_file(path, arc)
            info.compress_type = zipfile.ZIP_DEFLATED
            # 脚本给可执行位，其余 0644
            exe = arc.endswith(".sh") or arc.endswith("update-binary")
            info.external_attr = (0o100755 if exe else 0o100644) << 16
            z.writestr(info, path.read_bytes())

    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-zip", action="store_true")
    args = ap.parse_args()

    problems = check()
    if problems:
        print("检查未通过：")
        for p in problems:
            print("  ✗", p)
        return 1

    if "USER/LiquidFont" in (ROOT / "module.prop").read_text(encoding="utf-8"):
        print("! module.prop / update.json 里的 USER 还是占位符，记得换成你的 GitHub 用户名")

    if args.no_zip:
        print("✓ 检查通过")
        return 0

    out = build()
    size = out.stat().st_size
    print(f"✓ {out.relative_to(ROOT)}  ({size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
