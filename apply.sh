#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · apply.sh
# 把 FONTS/ 下的五个槽位字体铺到 system/fonts（模块 overlay），并同步状态。
#
# 用法：
#   apply.sh                 应用字体（默认模块目录 /data/adb/modules/LiquidFont）
#   apply.sh <模块目录>       指定模块目录
#   apply.sh --status        只输出状态，key=value 形式，供 WebUI 解析
#
# 槽位与 ColorOS 17 fonts.xml 的对应关系：
#   hans  → sans-serif / sys-sans-en / zh-Hans / NotoSansCJK 的简体兜底
#   hant  → zh-Hant / zh-Bopo
#   en    → SysFont-Regular / SysSans-En / OPSans-En（ColorOS 17 新增的西文字族）
#   mono  → DroidSansMono / CutiveMono
#   emoji → NotoColorEmoji

MODDIR="${1:-/data/adb/modules/LiquidFont}"
case "$1" in
--*) MODDIR="/data/adb/modules/LiquidFont" ;;
esac

FONTS="$MODDIR/FONTS"
DEST="$MODDIR/system/fonts"
FB="$MODDIR/FALLBACK"
FB_OFF="$FB/.disabled"

# 简体：中文字形 + ColorOS 自带的 CJK 兜底文件
SLOT_HANS="SysSans-Hans-Regular.ttf SysFont-Hans-Regular.ttf SysFont-Static-Regular.ttf SysFont-Myanmar.ttf"
# 繁体
SLOT_HANT="SysSans-Hant-Regular.ttf SysFont-Hant-Regular.ttf"
# 西文：fonts.xml 里 sans-serif 的首位是 SysFont-Regular，另有 SysSans-En / OPSans-En
SLOT_EN="SysFont-Regular.ttf SysSans-En-Regular.ttf OPSans-En-Regular.ttf Roboto-Regular.ttf"
# 等宽
SLOT_MONO="DroidSansMono.ttf CutiveMono.ttf"
# Emoji：ColorOS 把 emoji 拆成多个文件（NotoColorEmoji / 1 / 2 / Flags / Flags1）。
# 只覆盖前两个，其余留作缺字回退——写满反而会让新版 emoji 变豆腐块。
SLOT_EMOJI="NotoColorEmoji.ttf NotoColorEmoji1.ttf"

SLOTS="hans hant en mono emoji"

# 内置全字库 → system/fonts 的落点
#   遍黑体：系统里本来就有同名文件，直接顶替（新版本覆盖旧版本）
#   Unifont：写到 SysFont-Unicode*.otf（沿用 OPPO 自己的 SysFont- 前缀，避免留下模块特征），
#            排在整条兜底链最后，只接管前面没人认领的码位
FB_PLANGOTHIC="PlangothicP1.ttf PlangothicP2.ttf"
FB_UNIFONT="SysFont-Unicode.otf SysFont-UnicodeExt.otf"
FB_TARGETS="$FB_PLANGOTHIC $FB_UNIFONT"

# ---------- 状态 ----------
print_status() {
    for s in $SLOTS; do
        f="$FONTS/$s.ttf"
        if [ -f "$f" ]; then
            size=$(wc -c <"$f" 2>/dev/null | tr -d ' ')
            echo "slot.$s=set"
            echo "size.$s=${size:-0}"
        else
            echo "slot.$s=empty"
            echo "size.$s=0"
        fi
    done
    if [ -f "$DEST/SysFont-Regular.ttf" ] || [ -f "$DEST/SysSans-Hans-Regular.ttf" ]; then
        echo "applied=1"
    else
        echo "applied=0"
    fi

    # 全字库兜底
    if [ ! -d "$FB" ]; then
        echo "fallback=missing"
    elif [ -f "$FB_OFF" ]; then
        echo "fallback=off"
    elif [ -f "$DEST/SysFont-Unicode.otf" ]; then
        echo "fallback=applied"
    else
        echo "fallback=idle"
    fi
    if [ -f "$FB/VERSION" ]; then
        sed -n 's/^\(plangothic_version\|unifont_version\)=/fb.\1=/p' "$FB/VERSION"
    fi
    # 字体配置注入状态：Unifont 靠 XML 引用生效，这里能直接看出有没有漏
    if [ -f "$MODDIR/xmlsync.sh" ]; then
        sh "$MODDIR/xmlsync.sh" --status "$MODDIR" 2>/dev/null
    fi

    echo "moddir=$MODDIR"
}

if [ "$1" = "--status" ]; then
    print_status
    exit 0
fi

# ---------- 工具 ----------
die() {
    echo "[✗] $1"
    exit 1
}

# 把源字体复制到 system/fonts 下的若干文件名
# 只写设备上真实存在的文件：不同 ColorOS 版本的字体清单不完全一样，
# 无条件铺一遍会往模块里塞几十 MB 用不上的副本。
install_from() {
    src="$1"
    list="$2"
    primary="$3"
    [ -f "$src" ] || die "源字体不存在: $src"
    mkdir -p "$DEST" || die "无法创建 $DEST"
    for name in $list; do
        if [ "$name" != "$primary" ] && [ ! -f "/system/fonts/$name" ]; then
            echo "[-] 系统无 $name，跳过"
            continue
        fi
        cp -f "$src" "$DEST/$name" || die "复制 $name 失败"
        echo "[*] 安装 $name"
    done
}

# 删除 overlay 里的文件 → 恢复系统原字体
restore() {
    list="$1"
    for name in $list; do
        if [ -f "$DEST/$name" ]; then
            rm -f "$DEST/$name"
            echo "[-] 恢复系统 $name"
        fi
    done
}

# 原生工具（刷入后权限可能是 0644，不能靠 -x 判断）
run_tool() {
    tool="$1"
    shift
    [ -f "$tool" ] || return 127
    chmod 0755 "$tool" 2>/dev/null
    "$tool" "$@"
    rc=$?
    chmod 0644 "$tool" 2>/dev/null
    return $rc
}

# 英文字体若自带 CJK 字形，会盖掉中文字体（fonts.xml 里 sans-serif 排在 zh-Hans 之前）。
# 有 tools/subset 时裁成拉丁子集，没有则只提示，不影响安装。
prepare_en() {
    src="$1"
    out="$2"
    tool="$MODDIR/tools/subset"

    [ -f "$src" ] || return 1
    if [ ! -f "$tool" ]; then
        echo "[-] 未内置子集化工具，跳过英文裁切（若英文含汉字会覆盖中文）"
        return 1
    fi

    run_tool "$tool" -check "$src" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
        echo "[-] 英文字体不含 CJK，无需裁切"
        return 1
    fi
    if [ "$rc" -ne 1 ]; then
        echo "[-] 无法检测字体（工具返回 $rc），跳过裁切"
        return 1
    fi

    echo "[*] 英文字体含 CJK，生成拉丁子集..."
    if ! run_tool "$tool" -in "$src" -out "$out" 2>&1; then
        echo "[!] 裁切失败，使用原字体"
        rm -f "$out"
        return 1
    fi
    echo "[✓] 已裁切，汉字字形不再覆盖中文"
    return 0
}

# ---------- 内置全字库 ----------
# 遍黑体补 CJK 扩展 B–J，Unifont 补整张 Unicode 码表里剩下的角落。
# 关闭方式：在 FALLBACK/ 下建一个 .disabled 文件（WebUI 的开关就是干这个）。
restore_fallback() {
    for n in $FB_TARGETS; do
        if [ -f "$DEST/$n" ]; then
            rm -f "$DEST/$n"
            echo "[-] 移除 $n"
        fi
    done
}

install_fallback() {
    if [ ! -d "$FB" ]; then
        echo "[-] 未内置全字库，跳过"
        return 0
    fi
    if [ -f "$FB_OFF" ]; then
        echo "[-] 全字库兜底已关闭"
        restore_fallback
        return 0
    fi

    mkdir -p "$DEST" || die "无法创建 $DEST"

    # 遍黑体：同名字体直接覆盖
    for pair in "PlangothicP1.ttf:PlangothicP1.ttf" "PlangothicP2.ttf:PlangothicP2.ttf"; do
        src="$FB/${pair%%:*}"
        dst="${pair##*:}"
        if [ -f "$src" ]; then
            cp -f "$src" "$DEST/$dst" || die "复制 $dst 失败"
            echo "[*] 安装 $dst"
        fi
    done

    # Unifont：写到自己的文件名，由 fonts.xml 末尾的字族引用
    if [ -f "$FB/Unifont.otf" ]; then
        cp -f "$FB/Unifont.otf" "$DEST/SysFont-Unicode.otf" || die "复制 Unifont 失败"
        echo "[*] 安装 SysFont-Unicode.otf"
    fi
    if [ -f "$FB/UnifontUpper.otf" ]; then
        cp -f "$FB/UnifontUpper.otf" "$DEST/SysFont-UnicodeExt.otf" || die "复制 Unifont Upper 失败"
        echo "[*] 安装 SysFont-UnicodeExt.otf"
    fi
}

# ---------- 主流程 ----------
[ -f "$FONTS/hans.ttf" ] || die "FONTS/hans.ttf 不存在，请先在 WebUI 里选择简体字体"

# v1.2.0 及以前 Unifont 落盘叫 LiquidFont-Unifont*.otf。升级后这些文件不会被覆盖，
# 留着就是一条「这里装过 LiquidFont」的线索，顺手清掉。
for f in "$DEST"/LiquidFont-*; do
    [ -e "$f" ] || continue
    rm -f "$f" && echo "[-] 清除旧命名文件 ${f##*/}"
done

echo "[*] 简体"
install_from "$FONTS/hans.ttf" "$SLOT_HANS" "SysSans-Hans-Regular.ttf"

echo "[*] 繁体"
if [ -f "$FONTS/hant.ttf" ]; then
    install_from "$FONTS/hant.ttf" "$SLOT_HANT" "SysSans-Hant-Regular.ttf"
else
    echo "[-] 未设置繁体，回退简体"
    install_from "$FONTS/hans.ttf" "$SLOT_HANT" "SysSans-Hant-Regular.ttf"
fi

echo "[*] 西文"
if [ -f "$FONTS/en.ttf" ]; then
    EN_SRC="$FONTS/en.ttf"
    if prepare_en "$FONTS/en.ttf" "$FONTS/.en-subset.ttf"; then
        EN_SRC="$FONTS/.en-subset.ttf"
    else
        rm -f "$FONTS/.en-subset.ttf"
    fi
    install_from "$EN_SRC" "$SLOT_EN" "SysFont-Regular.ttf"
else
    echo "[-] 未设置西文，回退简体"
    rm -f "$FONTS/.en-subset.ttf"
    install_from "$FONTS/hans.ttf" "$SLOT_EN" "SysFont-Regular.ttf"
fi

echo "[*] 等宽"
if [ -f "$FONTS/mono.ttf" ]; then
    install_from "$FONTS/mono.ttf" "$SLOT_MONO" "DroidSansMono.ttf"
else
    restore "$SLOT_MONO"
fi

echo "[*] Emoji"
if [ -f "$FONTS/emoji.ttf" ]; then
    install_from "$FONTS/emoji.ttf" "$SLOT_EMOJI" "NotoColorEmoji.ttf"
else
    restore "$SLOT_EMOJI"
fi

echo "[*] 全字库兜底"
# 先补 XML：设备上真正生效的字体清单可能不是 /system/etc/fonts.xml，
# 老版本刷入的模块没有注入兜底字族，这里就地补一次（下次重启生效）。
if [ -f "$MODDIR/xmlsync.sh" ]; then
    sh "$MODDIR/xmlsync.sh" "$MODDIR" 2>/dev/null | grep -E '^\[' || true
fi
install_fallback

# 字体文件权限：0644，属主 root
chmod 0644 "$DEST"/*.ttf 2>/dev/null
chown 0:0 "$DEST"/*.ttf 2>/dev/null

echo
echo "[✓] 应用完成，重启后生效"
print_status
