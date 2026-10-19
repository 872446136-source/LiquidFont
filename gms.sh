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
#   gms.sh enforce  只停用服务（开机时用，不清缓存不停应用）
#   gms.sh          按标记文件执行（有标记即接管，无标记即恢复）
#
# 状态标记：/data/adb/LiquidFont/gms-takeover
#
# 为什么标记文件不放在模块目录里：
#   刷入新版本时管理器会先删掉旧模块目录再解包，放里面的标记会被一起清掉，
#   表现就是「开关开了，刷个版本或者重启又变回关的」。
#   所以状态放在模块目录之外的 /data/adb/LiquidFont，卸载时由 uninstall.sh 清掉。
#   老版本的 $MODDIR/CONFIG/gms-takeover 会被自动迁移过来。

MODDIR="${MODDIR:-/data/adb/modules/LiquidFont}"
STATE="${LF_STATE:-/data/adb/LiquidFont}"
FLAG="$STATE/gms-takeover"
OLD_FLAG="$MODDIR/CONFIG/gms-takeover"

PKG="com.google.android.gms"
SVC_FONTS="$PKG/com.google.android.gms.fonts.provider.FontsProvider"
SVC_SCHED="$PKG/com.google.android.gms.fonts.update.UpdateSchedulerService"

# 受这条链路影响、需要重新加载字体的应用
APPS="com.android.vending com.android.chrome com.google.android.gm"

PM="/system/bin/pm"
[ -x "$PM" ] || PM="$(command -v pm 2>/dev/null)"

# ---------- 标记迁移 ----------
# 老版本把标记放在模块目录里，刷版本就丢。发现就搬到持久位置。
migrate_flag() {
    [ -f "$OLD_FLAG" ] || return 0
    if [ ! -f "$FLAG" ]; then
        mkdir -p "$STATE" 2>/dev/null
        if mv -f "$OLD_FLAG" "$FLAG" 2>/dev/null; then
            echo "[-] 已把接管标记迁移到 $FLAG"
        fi
    else
        rm -f "$OLD_FLAG" 2>/dev/null
    fi
}

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

# 停用组件，返回成功次数
disable_all() {
    n=0
    for u in $(list_users); do
        if "$PM" disable --user "$u" "$SVC_FONTS" >/dev/null 2>&1; then
            n=$((n + 1))
            echo "[*] 用户 $u: 已停用 FontsProvider"
        else
            echo "[!] 用户 $u: 停用 FontsProvider 失败"
        fi
        "$PM" disable --user "$u" "$SVC_SCHED" >/dev/null 2>&1
    done
    echo "$n"
}

enable_all() {
    for u in $(list_users); do
        if "$PM" enable --user "$u" "$SVC_FONTS" >/dev/null 2>&1; then
            echo "[*] 用户 $u: 已恢复 FontsProvider"
        fi
        "$PM" enable --user "$u" "$SVC_SCHED" >/dev/null 2>&1
    done
}

# ---------- 状态 ----------
print_status() {
    migrate_flag

    if [ -f "$FLAG" ]; then
        echo "gms.flag=on"
    else
        echo "gms.flag=off"
    fi

    if ! have_gms; then
        echo "gms.state=missing"
        return 0
    fi

    # 没开过接管就别动它：这是绝大多数情况，也省掉一次 pm 调用
    if [ ! -f "$FLAG" ]; then
        echo "gms.state=normal"
        return 0
    fi

    # 开过接管：标记文件是「用户意图」，系统里的组件状态是「事实」，两者会打架。
    # 部分 ROM 在 GMS 自更新后会把组件重置回启用，所以这里顺手再断言一次。
    # pm disable 对已停用的组件是幂等的，代价约 0.3~0.5 秒，
    # 比 pm dump（2~4 秒）便宜一个数量级，也比解析 dump 文本可靠。
    if "$PM" disable --user 0 "$SVC_FONTS" >/dev/null 2>&1; then
        echo "gms.state=taken"
    else
        echo "gms.state=normal"
    fi
}

# ---------- 接管 ----------
takeover() {
    migrate_flag
    if [ -z "$PM" ]; then
        echo "[✗] 找不到 pm 命令，无法操作 GMS"
        return 1
    fi
    if ! have_gms; then
        echo "[!] 未安装 Google Play 服务，跳过"
        return 0
    fi

    res="$(disable_all)"
    n="$(printf '%s\n' "$res" | tail -n 1)"
    printf '%s\n' "$res" | sed '$d'

    if [ "${n:-0}" -lt 1 ] 2>/dev/null; then
        echo "[✗] 一个用户都没停用成功，不写标记"
        return 1
    fi

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

    mkdir -p "$STATE"
    : >"$FLAG"
    echo "[✓] 已接管，重新打开 Play 商店即可看到效果"
}

# 开机时用：只停用，不清缓存、不停应用（避免开机卡顿）
enforce() {
    migrate_flag
    [ -f "$FLAG" ] || return 0
    [ -n "$PM" ] || return 0
    have_gms || return 0
    disable_all >/dev/null 2>&1
    return 0
}

# ---------- 恢复 ----------
restore() {
    rm -f "$FLAG" "$OLD_FLAG" 2>/dev/null
    if [ -z "$PM" ] || ! have_gms; then
        echo "[-] 未安装 Google Play 服务，无需恢复"
        return 0
    fi

    enable_all

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
enforce) enforce ;;
*)
    migrate_flag
    if [ -f "$FLAG" ]; then
        takeover
    else
        restore
    fi
    ;;
esac
