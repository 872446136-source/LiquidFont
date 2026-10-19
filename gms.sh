#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · gms.sh
#
# 为什么需要它：
#   Play 商店 / Chrome / Gmail 的英文与数字有一部分走 Google Play 服务的
#   「可下载字体」（Downloadable Fonts）。这条链路由 GMS 自己的 FontsProvider 供字，
#   完全绕开 system/fonts，表现就是「中文换好了，英文和数字还是 Roboto」。
#
#   本脚本停用 GMS 的字体提供器与它的更新调度，并清掉已经下载的字体缓存，
#   这些应用就会回落到系统字体，跟五槽位的选择保持一致。
#
# 用法：
#   gms.sh status   输出 key=value，供 WebUI 解析
#   gms.sh on       接管：停用服务 + 清缓存 + 停掉相关应用
#   gms.sh off      恢复：重新启用 GMS 字体服务
#   gms.sh          按 CONFIG/gms-takeover 标记执行（缺省即恢复）
#
# 状态标记：CONFIG/gms-takeover 存在 = 已接管

MODDIR="${MODDIR:-/data/adb/modules/LiquidFont}"
FLAG="$MODDIR/CONFIG/gms-takeover"

PKG="com.google.android.gms"
SVC_FONTS="$PKG/com.google.android.gms.fonts.provider.FontsProvider"
SVC_SCHED="$PKG/com.google.android.gms.fonts.update.UpdateSchedulerService"

# 受这条链路影响、需要重新加载字体的应用
APPS="com.android.vending com.android.chrome com.google.android.gm"

PM="/system/bin/pm"
[ -x "$PM" ] || PM="$(command -v pm 2>/dev/null)"

# ---------- 工具 ----------
list_users() {
    users="$(ls -d /data/user/* 2>/dev/null | sed 's#.*/##' | tr '\n' ' ')"
    [ -n "$users" ] || users="0"
    echo "$users"
}

have_gms() {
    [ -n "$PM" ] || return 1
    # 带包名过滤的查询比列全量再 grep 快得多
    "$PM" list packages "$PKG" 2>/dev/null | grep -q "^package:${PKG}$"
}

# ---------- 状态 ----------
print_status() {
    if [ -f "$FLAG" ]; then
        echo "gms.flag=on"
    else
        echo "gms.flag=off"
    fi

    if ! have_gms; then
        echo "gms.state=missing"
        return 0
    fi

    # 没开过接管就别去 dump：pm dump 一次要 2~4 秒，而「没开过」是绝大多数情况。
    # WebUI 每次刷新都会调 status，这里省掉的就是每次开面板的等待。
    if [ ! -f "$FLAG" ]; then
        echo "gms.state=normal"
        return 0
    fi

    # 开过接管才以系统里的实际状态为准，不只看标记文件
    if command -v timeout >/dev/null 2>&1; then
        taken="$(timeout 3 "$PM" dump "$PKG" 2>/dev/null \
            | grep -A12 "fonts.provider.FontsProvider" \
            | grep -ciE "disabled=true|DISABLED")"
    else
        taken="$("$PM" dump "$PKG" 2>/dev/null \
            | grep -A12 "fonts.provider.FontsProvider" \
            | grep -ciE "disabled=true|DISABLED")"
    fi

    if [ "${taken:-0}" -gt 0 ] 2>/dev/null; then
        echo "gms.state=taken"
    else
        echo "gms.state=normal"
    fi
}

# ---------- 接管 ----------
takeover() {
    if [ -z "$PM" ]; then
        echo "[✗] 找不到 pm 命令，无法操作 GMS"
        return 1
    fi
    if ! have_gms; then
        echo "[!] 未安装 Google Play 服务，跳过"
        return 0
    fi

    for u in $(list_users); do
        if "$PM" disable --user "$u" "$SVC_FONTS" >/dev/null 2>&1; then
            echo "[*] 用户 $u: 已停用 FontsProvider"
        else
            echo "[!] 用户 $u: 停用 FontsProvider 失败"
        fi
        "$PM" disable --user "$u" "$SVC_SCHED" >/dev/null 2>&1
    done

    # 只清已知路径，不用 find /data 全盘扫（那会很慢）
    for d in /data/fonts \
        /data/data/com.google.android.gms/files/fonts \
        /data/user/*/com.google.android.gms/files/fonts \
        /data/user_de/*/com.google.android.gms/files/fonts; do
        [ -d "$d" ] || continue
        rm -rf "$d"/* 2>/dev/null && echo "[*] 已清理 $d"
    done

    # 让已经缓存了字体的应用重新加载
    for a in $APPS; do
        am force-stop "$a" >/dev/null 2>&1
    done

    mkdir -p "${FLAG%/*}"
    : > "$FLAG"
    echo "[✓] 已接管，重新打开 Play 商店即可看到效果"
}

# ---------- 恢复 ----------
restore() {
    rm -f "$FLAG"
    if [ -z "$PM" ] || ! have_gms; then
        echo "[-] 未安装 Google Play 服务，无需恢复"
        return 0
    fi

    for u in $(list_users); do
        if "$PM" enable --user "$u" "$SVC_FONTS" >/dev/null 2>&1; then
            echo "[*] 用户 $u: 已恢复 FontsProvider"
        fi
        "$PM" enable --user "$u" "$SVC_SCHED" >/dev/null 2>&1
    done

    for a in $APPS; do
        am force-stop "$a" >/dev/null 2>&1
    done

    echo "[✓] 已恢复 GMS 字体服务"
}

# ---------- 入口 ----------
case "$1" in
status) print_status ;;
on) takeover ;;
off) restore ;;
*)
    if [ -f "$FLAG" ]; then
        takeover
    else
        restore
    fi
    ;;
esac
