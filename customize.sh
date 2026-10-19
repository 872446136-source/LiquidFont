#!/system/bin/sh
# shellcheck shell=ash
# shellcheck disable=SC2034
# LiquidFont · 刷入脚本
# 字体安装统一交给 apply.sh（与 WebUI 共用同一套逻辑）

REPLACE=""
REMOVE=""

# ---------- 路径 ----------
if [ -z "${MODPATH+x}" ]; then
    case "$0" in
    */*) MODPATH="${0%/*}" ;;
    *) MODPATH="." ;;
    esac
fi

FONTS_DIR="$MODPATH/FONTS"
UPDATE_MODE=0

# ---------- 日志 ----------
log() { echo "[-] $1"; }
ok() { echo "[*] $1"; }
warn() { echo "[!] $1"; }

fail() {
    if command -v abort >/dev/null 2>&1; then
        abort "$1"
    fi
    echo "[✗] $1"
    exit "${2:-1}"
}

# ---------- 音量键 ----------
btn() {
    while :; do
        c="$(getevent -qlc 1 2>/dev/null | awk '{ print $3 }')"
        case "$c" in
        KEY_VOLUMEUP) echo 0; return ;;
        KEY_VOLUMEDOWN) echo 1; return ;;
        esac
    done
}

confirm() {
    echo
    log "警告: $1"
    [ -n "$2" ] && log "$2"
    log "音量上键继续安装，音量下键取消。"
    [ "$(btn)" = "1" ] && fail "用户取消安装"
}

# ---------- 系统检查 ----------
CHECK_SYSTEM() {
    api="$(getprop ro.build.version.oplus.api 2>/dev/null || true)"
    if [ -z "$api" ]; then
        warn "当前不是 ColorOS，字体映射可能不匹配"
        confirm "非 ColorOS 设备" "fonts.xml 来自 ColorOS 17，其它系统可能导致字体渲染异常"
        return 0
    fi

    rom="$(getprop ro.build.version.oplusrom.display 2>/dev/null || true)"
    major="${rom%%.*}"
    if [ "${major:-0}" -lt 16 ] 2>/dev/null; then
        warn "ColorOS 版本 ${rom:-未知} 偏低（建议 16+）"
        confirm "ColorOS 版本过低 (${rom:-未知})" "低版本字体文件清单不同，可能出现缺字"
    else
        ok "ColorOS ${rom:-$api}"
    fi
}

CHECK_METAMODULE() {
    [ -f /data/adb/ksud ] || {
        log "非 KernelSU 环境，跳过元模块检查"
        return 0
    }
    ver="$(/data/adb/ksud --version 2>/dev/null | tr -d '\r' || true)"
    num="$(printf '%s' "$ver" | grep -o '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*' | head -n 1 || true)"
    ok "KernelSU v${num:-未知}"
    major="${num%%.*}"
    if [ "${major:-0}" -lt 3 ] 2>/dev/null; then
        return 0
    fi
    if [ ! -f /data/adb/metamodule/module.prop ]; then
        fail "KernelSU >= 3.0.0 需要元模块（mountify / hybrid_mount），请先安装"
    fi
    name="$(sed -n 's/^name=//p' /data/adb/metamodule/module.prop | head -n 1 || true)"
    ok "元模块已安装: ${name:-未知}"
}

# ---------- 更新模式：继承旧字体 ----------
IMPORT_OLD_FONTS() {
    if [ -d /data/adb/modules/LiquidFont ]; then
        UPDATE_MODE=1
        log "检测到已安装的 LiquidFont，进入更新模式"
    else
        log "全新安装"
        return 0
    fi

    old="/data/adb/modules/LiquidFont/FONTS"
    if [ ! -d "$old" ]; then
        log "旧模块没有 FONTS 目录，使用新包字体"
        return 0
    fi

    mkdir -p "$FONTS_DIR"
    for f in hans.ttf hant.ttf en.ttf mono.ttf emoji.ttf; do
        if [ -f "$old/$f" ]; then
            cp -f "$old/$f" "$FONTS_DIR/$f" && ok "继承字体: $f"
        fi
    done
}

# ---------- 字体配置：注入兜底字族 ----------
# 模块内置 ColorOS 17 的 fonts.xml / fonts_base.xml / fonts_ule.xml。
# 但 fonts.xml 头部已标注 DEPRECATED，ColorOS 17 上真正生效的可能是
# /system/etc/font_fallback.xml —— 那份不内置，交给 xmlsync.sh 就地打补丁：
# 设备上有几份就补几份，只在最后一个 </familyset> 前追加两条无名 family。
#
# 这一步是「全字库兜底」能不能生效的关键：
#   遍黑体靠同名覆盖 PlangothicP1/P2 生效，不需要改 XML；
#   Unifont 是新增文件名 SysFont-Unicode*.otf，必须靠 XML 引用，不注入就永远不生效。
SYNC_XMLS() {
    if [ -f "$MODPATH/xmlsync.sh" ]; then
        sh "$MODPATH/xmlsync.sh" "$MODPATH"
    else
        warn "缺少 xmlsync.sh，全字库兜底可能不生效"
    fi
    chmod 0644 "$MODPATH/system/etc/"*.xml 2>/dev/null
    chmod 0644 "$MODPATH/system/system_ext/etc/"*.xml 2>/dev/null
}

# ---------- 外部 FontLoader ----------
# 本模块不做 Zygisk 预加载；若同时启用了 FontLoader 之类模块，可能重复挂载，仅提示。
CHECK_FONTLOADER() {
    for d in /data/adb/modules/*; do
        [ -d "$d" ] || continue
        [ "$(basename "$d")" = "LiquidFont" ] && continue
        p="$d/module.prop"
        [ -f "$p" ] || continue
        if grep -qiE '^description=.*font.?loader' "$p" 2>/dev/null; then
            warn "检测到其它字体加载模块: $(basename "$d")，建议只保留一个"
            break
        fi
    done
}

# ---------- 挂载痕迹 ----------
# 元模块模式下，模块目录里残留 skip_mount 会让 mountify 直接跳过本模块（字体不生效），
# 顺手清掉；旧命名的字体文件也一起清。剩下的伪装配置交给 WebUI 的「一键加固」，
# 刷入阶段不擅自改别的模块的配置。
HARDEN() {
    [ -f "$MODPATH/hide.sh" ] || return 0
    sh "$MODPATH/hide.sh" auto "$MODPATH" 2>/dev/null
}

# ---------- 主流程 ----------
MAIN() {
    CHECK_SYSTEM
    CHECK_METAMODULE
    CHECK_FONTLOADER
    HARDEN

    echo && log "准备字体..."
    IMPORT_OLD_FONTS
    SYNC_XMLS

    # 全新安装且包内没有字体时，跳过应用，等用户去 WebUI 选字体
    if [ ! -f "$FONTS_DIR/hans.ttf" ]; then
        echo
        warn "包内没有预置字体（模板包）"
        log "安装完成后打开 WebUI 选择字体，再点『应用字体』"
        log "或把字体放到 $FONTS_DIR/hans.ttf 后执行 sh $MODPATH/apply.sh"
        return 0
    fi

    echo && log "安装字体..."
    if sh "$MODPATH/apply.sh" "$MODPATH"; then
        echo && ok "全部完成，重启后生效"
    else
        echo && fail "字体安装失败"
    fi
}

MAIN
