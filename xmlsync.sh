#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · xmlsync.sh
#
# 把「全字库兜底」字族注入到设备上真正生效的那份字体配置里。
#
# 背景：
#   Android 12 之后 /system/etc/fonts.xml 头部已经写着 DEPRECATED，
#   部分 ROM（含 ColorOS 17）改用 /system/etc/font_fallback.xml。
#   v1.4.0 及以前只把设备原文件原样复制进模块，兜底字族根本没进去，结果是：
#     遍黑体（同名覆盖 PlangothicP1/P2，靠文件名生效）→ 有
#     Unifont（新文件名 SysFont-Unicode*.otf，靠 XML 引用生效）→ 没有
#   表现就是「两个开关都开了还是缺字」。
#
# 用法：
#   xmlsync.sh <模块目录>              注入并落盘（幂等）
#   xmlsync.sh --status [<模块目录>]    只输出状态，key=value
#
# 设计要点：
#   - 不猜哪份清单是权威的：把 /system/etc、/system/system_ext/etc、
#     /system_ext/etc、/product/etc 下所有带 </familyset> 的 XML 都扫一遍；
#   - 模块自带的 fonts.xml / fonts_base.xml / fonts_ule.xml 已经内置字族，
#     原样挂载，不被设备版本覆盖（避免把 ColorOS 17 的槽位映射换掉）；
#   - 补丁只是在最后一个 </familyset> 前追加两条无名 family，排在整条兜底链末尾，
#     只接管前面没人认领的码位，不改设备原有的任何一条字体映射；
#   - 已含兜底字族就跳过，重复刷入 / 重复应用都不会叠加；
#   - LF_ROOT 只给本地自测用（指向一个假的 /system 根），设备上是空的。

MODDIR="/data/adb/modules/LiquidFont"
STATUS=0
case "$1" in
--status)
    STATUS=1
    [ -n "$2" ] && MODDIR="$2"
    ;;
*)
    [ -n "$1" ] && MODDIR="$1"
    ;;
esac

ROOT="${LF_ROOT:-}"

# 兜底字族（无名 family = 只做回退，不会被任何语种匹配优先选中）
LF_BLOCK='    <family><font weight="400" style="normal">SysFont-Unicode.otf</font></family>
    <family><font weight="400" style="normal">SysFont-UnicodeExt.otf</font></family>'

# 模块内置、随模块挂载的清单（内容已带字族，只做校验）
SHIPPED="/system/etc/fonts.xml
/system/system_ext/etc/fonts_base.xml
/system/system_ext/etc/fonts_ule.xml"

# 扫清单的目录
DISCOVER_DIRS="/system/etc /system/system_ext/etc /system_ext/etc /product/etc"

# 逻辑路径 → 模块内路径
# /system_ext/... 在多数设备上是 /system/system_ext 的挂载或符号链接，
# 两种写法都落到模块的 system/system_ext 下即可。
modpath_of() {
    case "$1" in
    /system_ext/*) echo "system/system_ext/${1#/system_ext/}" ;;
    *) echo "${1#/}" ;;
    esac
}

name_of() {
    case "$1" in
    /system/etc/fonts.xml) echo fonts ;;
    */font_fallback.xml) echo fallback ;;
    */fonts_base.xml) echo base ;;
    */fonts_ule.xml) echo ule ;;
    *) echo other ;;
    esac
}

has_fb() { grep -q 'SysFont-Unicode\.otf' "$1" 2>/dev/null; }

is_shipped() {
    case "$1" in
    /system/etc/fonts.xml | /system/system_ext/etc/fonts_base.xml | /system/system_ext/etc/fonts_ule.xml) return 0 ;;
    esac
    return 1
}

# 设备上所有「带 familyset 且模块没内置」的清单
collect_extra() {
    for d in $DISCOVER_DIRS; do
        for f in "$ROOT$d"/*.xml; do
            [ -f "$f" ] || continue
            grep -q '</familyset>' "$f" 2>/dev/null || continue
            rel="${f#"$ROOT"}"
            is_shipped "$rel" && continue
            echo "$rel"
        done
    done
}

# ---------- 状态 ----------
if [ "$STATUS" = "1" ]; then
    on=0
    total=0
    seen=""
    for rel in $SHIPPED $(collect_extra); do
        src="$ROOT$rel"
        [ -f "$src" ] || continue
        real="$(readlink -f "$src" 2>/dev/null || echo "$src")"
        case " $seen " in
        *" $real "*) continue ;;
        esac
        seen="$seen $real"
        total=$((total + 1))
        if has_fb "$src"; then
            echo "xml.$(name_of "$rel")=on"
            on=$((on + 1))
        else
            echo "xml.$(name_of "$rel")=raw"
        fi
    done

    # 模块里有、设备上没有 → 是随模块新增的，同样算已注入
    if [ -f "$MODDIR/system/etc/font_fallback.xml" ] && [ ! -f "$ROOT/system/etc/font_fallback.xml" ]; then
        total=$((total + 1))
        if has_fb "$MODDIR/system/etc/font_fallback.xml"; then
            echo "xml.fallback=on"
            on=$((on + 1))
        else
            echo "xml.fallback=raw"
        fi
    fi

    echo "xml.patched=$on"
    echo "xml.total=$total"
    if [ -f "$ROOT/data/fonts/files/fonts.xml" ]; then
        echo "xml.fmgr=present"
    else
        echo "xml.fmgr=absent"
    fi
    exit 0
fi

# ---------- 注入 ----------
# 在最后一个 </familyset> 前插入兜底字族。
# 返回：0 成功  1 失败  3 结构不认识
splice() {
    src="$1"
    dst="$2"
    rel="$3"

    last="$(grep -n '</familyset>' "$src" 2>/dev/null | tail -n 1 | cut -d: -f1)"
    if [ -z "$last" ]; then
        echo "[!] ${rel} 找不到 </familyset>，跳过"
        return 3
    fi

    mkdir -p "${dst%/*}" 2>/dev/null
    tmp="$dst.lf-tmp"
    {
        head -n $((last - 1)) "$src"
        printf '%s\n' "$LF_BLOCK"
        tail -n +"$last" "$src"
    } >"$tmp" 2>/dev/null || {
        rm -f "$tmp"
        echo "[!] 写入 ${dst#"$MODDIR"/} 失败"
        return 1
    }

    # 自检：行数必须正好 +2，否则说明截断或拼接出错
    a="$(wc -l <"$src" 2>/dev/null | tr -d ' ')"
    b="$(wc -l <"$tmp" 2>/dev/null | tr -d ' ')"
    if [ -z "$b" ] || [ "${b:-0}" -ne "$((a + 2))" ]; then
        rm -f "$tmp"
        echo "[!] ${rel} 拼接校验失败（${a:-?} → ${b:-?}），放弃"
        return 1
    fi

    mv -f "$tmp" "$dst" || {
        rm -f "$tmp"
        echo "[!] 覆盖 ${dst#"$MODDIR"/} 失败"
        return 1
    }
    chmod 0644 "$dst" 2>/dev/null
    echo "[*] 注入兜底字族 → ${dst#"$MODDIR"/}"
    return 0
}

# 返回：0 已含/注入成功  2 设备无此文件  3 结构不认识  1 写入失败
inject() {
    rel="$1"
    src="$ROOT$rel"
    dst="$MODDIR/$(modpath_of "$rel")"

    [ -f "$src" ] || return 2

    if has_fb "$src"; then
        [ -f "$dst" ] && {
            echo "[-] ${rel} 已含兜底字族"
            return 0
        }
        # 刷入时设备上的这份可能正是上一个版本挂载出来的（已经带字族），
        # 直接沿用。用临时文件 + mv，避免 src/dst 恰好是同一个 inode 时
        # cp 打开目标写入、把正在读的源截断。
        mkdir -p "${dst%/*}" 2>/dev/null
        if cp -f "$src" "$dst.lf-new" 2>/dev/null && mv -f "$dst.lf-new" "$dst" 2>/dev/null; then
            chmod 0644 "$dst" 2>/dev/null
            echo "[-] ${rel} 沿用设备上已注入的那份"
            return 0
        fi
        rm -f "$dst.lf-new" 2>/dev/null
        echo "[!] ${rel} 同步进模块失败"
        return 1
    fi

    splice "$src" "$dst" "$rel"
}

changed=0
seen=""
for rel in $(collect_extra); do
    src="$ROOT$rel"
    # /system_ext 与 /system/system_ext 指向同一个文件，别重复处理
    real="$(readlink -f "$src" 2>/dev/null || echo "$src")"
    case " $seen " in
    *" $real "*) continue ;;
    esac
    seen="$seen $real"

    inject "$rel"
    [ $? = 0 ] && changed=$((changed + 1))
done

if [ "$changed" = "0" ]; then
    echo "[-] 设备上没有需要补的字体清单，沿用模块内置 fonts.xml"
fi

# 模块自带的清单也要确认带上兜底字族（v1.4.0 已内置，这里做兜底校验）
for rel in $SHIPPED; do
    f="$MODDIR/${rel#/}"
    [ -f "$f" ] || continue
    has_fb "$f" || echo "[!] ${rel#/} 缺少兜底字族"
done

exit 0
