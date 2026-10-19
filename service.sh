#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · service.sh
#
# late_start service 阶段跑一次（每次开机）。
#
# 只做一件事：如果用户开过「Play 商店字体接管」，就把 GMS 的字体组件再停用一遍。
#
# 为什么要重复做：pm disable 的结果理论上会写进 package-restrictions.xml 跨重启保留，
# 但部分 ROM（尤其是 GMS 自更新之后）会把组件重置回启用。开机补一刀最稳，
# 也顺手把「刷了新版本、标记还在但状态丢了」的情况修回来。
#
# 这里不清缓存、不停应用——开机阶段做那些只会拖慢启动，
# 真正的清理在用户点开关时已经做过了。

MODDIR="${MODDIR:-${0%/*}}"
STATE="${LF_STATE:-/data/adb/LiquidFont}"

# 没开过接管就直接退出，不占用开机时间
[ -f "$STATE/gms-takeover" ] || [ -f "$MODDIR/CONFIG/gms-takeover" ] || exit 0
[ -f "$MODDIR/gms.sh" ] || exit 0

# 等 pm 就绪：system_server 起来得比 service 阶段晚，最多等 60 秒
i=0
while [ "$i" -lt 60 ]; do
    pm list packages >/dev/null 2>&1 && break
    i=$((i + 1))
    sleep 1
done
[ "$i" -ge 60 ] && exit 0

MODDIR="$MODDIR" sh "$MODDIR/gms.sh" enforce >/dev/null 2>&1
exit 0
