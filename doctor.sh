#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · doctor.sh
#
# 「开关开了还是缺字」到底卡在哪一环，一次全打出来。
# 只看四件事：
#   1. 兜底字体在 /system/fonts（挂载后）里到底有没有
#   2. 模块里的副本有没有、和挂载后的是不是同一份
#   3. 设备上到底有几份字体清单，各有没有带上兜底字族
#   4. 有没有 FontManager 的可更新字体配置在插队
#
# 用法：doctor.sh [模块目录]

MODDIR="${1:-/data/adb/modules/LiquidFont}"
case "$1" in --*) MODDIR="/data/adb/modules/LiquidFont" ;; esac

FB="$MODDIR/FALLBACK"
DEST="$MODDIR/system/fonts"

sz() { [ -f "$1" ] && wc -c <"$1" 2>/dev/null | tr -d ' '; }

line() { printf '%s\n' "$1"; }

# ---------- 头部 ----------
ver="$(sed -n 's/^version=//p' "$MODDIR/module.prop" 2>/dev/null | head -n 1)"
rom="$(getprop ro.build.version.oplusrom.display 2>/dev/null)"
api="$(getprop ro.build.version.oplus.api 2>/dev/null)"
sdk="$(getprop ro.build.version.sdk 2>/dev/null)"
line "LiquidFont ${ver:-?} 诊断"
line "ROM ${rom:-未知} · API ${api:-?} · SDK ${sdk:-?}"
line ""

# ---------- 1. 兜底字体：挂载后 vs 模块副本 ----------
line "── 兜底字体 ──"
line "左=挂载后 · 右=模块副本"

check_pair() {
    name="$1"
    sys="$(sz "/system/fonts/$name")"
    mod="$(sz "$DEST/$name")"
    if [ -n "$sys" ] && [ -n "$mod" ]; then
        if [ "$sys" = "$mod" ]; then
            st="✓ 已挂载"
        else
            st="! 大小不符"
        fi
    elif [ -n "$sys" ]; then
        st="· 系统自带"
    elif [ -n "$mod" ]; then
        st="✗ 未挂载"
    else
        st="✗ 缺失"
    fi
    printf '%-24s %9s %9s  %s\n' "$name" "${sys:--}" "${mod:--}" "$st"
}

check_pair PlangothicP1.ttf
check_pair PlangothicP2.ttf
check_pair SysFont-Unicode.otf
check_pair SysFont-UnicodeExt.otf

if [ -f "$FB/.disabled" ]; then
    line "开关标记: .disabled 存在 → 兜底处于「关闭」状态"
else
    line "开关标记: 无（兜底为开启）"
fi
line ""

# ---------- 2. 字体清单 ----------
line "── 字体清单 ──"
found=0
for d in /system/etc /system/system_ext/etc /system_ext/etc /product/etc; do
    for f in "$d"/*.xml; do
        [ -f "$f" ] || continue
        grep -q '</familyset>' "$f" 2>/dev/null || continue
        found=$((found + 1))
        n="$(sz "$f")"
        if grep -q 'SysFont-Unicode\.otf' "$f" 2>/dev/null; then
            st="✓ 已注入"
        else
            st="✗ 未注入"
        fi
        printf '%-40s %9s  %s\n' "$f" "$n" "$st"
    done
done
# FontManager 的可更新字体配置（不在上面几个目录里）
if [ -f /data/fonts/files/fonts.xml ]; then
    found=$((found + 1))
    if grep -q 'SysFont-Unicode\.otf' /data/fonts/files/fonts.xml 2>/dev/null; then
        st="✓ 已注入"
    else
        st="✗ 未注入（插在系统清单之后）"
    fi
    printf '%-40s %9s  %s\n' "/data/fonts/files/fonts.xml" "$(sz /data/fonts/files/fonts.xml)" "$st"
fi
[ "$found" = "0" ] && line "（一份都没找到，异常）"
line ""

# ---------- 3. 兜底链末尾的候选文件 ----------
line "── 兜底链末尾的字体 ──"
for n in Unicode16-new.ttf UFSZeroExt.otf UnicodiaDaarage.otf UnicodiaSesh.ttf \
    NotoSansCJK-Regular.ttc SysSans-Hans-Regular.ttf SysFont-Regular.ttf; do
    s="$(sz "/system/fonts/$n")"
    [ -n "$s" ] && printf '%-28s %10s\n' "$n" "$s"
done
line ""

# ---------- 4. 挂载 ----------
line "── 挂载 ──"
mc="$(grep -c ' /system/fonts' /proc/mounts 2>/dev/null)"
[ -z "$mc" ] && mc=0
line "/system/fonts 相关挂载点: $mc"
n="$(ls -1 "$DEST" 2>/dev/null | wc -l | tr -d ' ')"
line "模块 system/fonts 文件数: ${n:-0}"
line ""
line "报告结束"
