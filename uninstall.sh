#!/system/bin/sh
# LiquidFont · 卸载时清理（字体文件随模块目录一起删除，这里只做收尾）
MODDIR="${MODDIR:-/data/adb/modules/LiquidFont}"

# 删除临时子集与日志，避免残留
rm -f "$MODDIR/FONTS/.en-subset.ttf" 2>/dev/null
rm -f "$MODDIR/last-apply.log" 2>/dev/null

# 模块目录会被管理器整体删除，system/fonts 的 overlay 随之消失，字体自动还原
echo "[*] LiquidFont 已卸载，重启后恢复系统字体"
