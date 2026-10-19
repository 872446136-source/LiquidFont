#!/system/bin/sh
# LiquidFont · 卸载时清理（字体文件随模块目录一起删除，这里只做收尾）
MODDIR="${MODDIR:-/data/adb/modules/LiquidFont}"

# 如果开过「Play 商店字体接管」，卸载时要把 GMS 的字体服务放回去，
# 否则组件会一直停用，Play 商店 / Chrome 的可下载字体再也用不了。
if [ -f "$MODDIR/CONFIG/gms-takeover" ]; then
    echo "[*] 恢复 GMS 字体服务"
    MODDIR="$MODDIR" sh "$MODDIR/gms.sh" off >/dev/null 2>&1
fi

# 删除临时子集、日志与状态，避免残留
rm -f "$MODDIR/FONTS/.en-subset.ttf" 2>/dev/null
rm -f "$MODDIR/last-apply.log" 2>/dev/null
rm -rf "$MODDIR/CONFIG" 2>/dev/null

# 模块目录会被管理器整体删除，system/fonts 的 overlay 随之消失，字体自动还原
echo "[*] LiquidFont 已卸载，重启后恢复系统字体"
