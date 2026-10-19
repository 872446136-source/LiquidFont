#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · 卸载清理
#
# 目标：卸载之后，设备上不留下任何属于本模块的东西。
#
# 管理器（Magisk / KernelSU）会在本脚本跑完后删掉模块目录，但那只能清掉
# 目录本身。真正会残留的是四类东西，都在模块目录之外：
#   1. 被停用的 GMS 字体组件（Play 商店接管留下的）
#   2. mountify 的配置被我们改过（伪装挂载点 / 挂载源名）+ 我们留下的 config.sh.bak
#   3. mountify 的 skipped_modules 里记着本模块 id
#   4. OTA 更新暂存的 /data/adb/modules_update/LiquidFont
#
# 还有一个时序问题：Magisk 是在**下次开机**的 post-fs-data 阶段跑本脚本的，
# 那时候 pm / am 还没起来，直接调用会静默失败、组件永远停用。
# 所以 pm 不可用时改写成一次性收尾脚本，等系统起来再补做，做完自删。
#
# 脚本是幂等的：重复执行不会报错，也不会误删别人的东西。

MODDIR="${MODDIR:-/data/adb/modules/LiquidFont}"
[ -n "$1" ] && MODDIR="$1"

MODID="LiquidFont"
MOUNTIFY_DIR="/data/adb/mountify"
GMS_PKG="com.google.android.gms"
GMS_FONTS="$GMS_PKG/com.google.android.gms.fonts.provider.FontsProvider"
GMS_SCHED="$GMS_PKG/com.google.android.gms.fonts.update.UpdateSchedulerService"

log() { echo "[-] $1"; }
ok() { echo "[*] $1"; }

# ---------- 1. GMS 字体服务 ----------
# 不看标记文件决定要不要恢复，直接恢复：pm enable 对本来就启用的组件是无害的。
# 这样即使 CONFIG/ 被手动删过、或者停用状态是上一次留下的，也能放回去。
pm_ready() {
    command -v pm >/dev/null 2>&1 && pm list packages >/dev/null 2>&1
}

defer_gms() {
    d=/data/adb/service.d
    mkdir -p "$d" 2>/dev/null || return 1
    cat > "$d/lf-cleanup.sh" <<'EOS'
#!/system/bin/sh
# LiquidFont 卸载收尾：卸载时系统服务还没起来，这里补做。
# 执行一次后自删，不留下任何东西。
for u in $(ls -d /data/user/* 2>/dev/null | sed 's#.*/##'); do
    pm enable --user "$u" com.google.android.gms/com.google.android.gms.fonts.provider.FontsProvider >/dev/null 2>&1
    pm enable --user "$u" com.google.android.gms/com.google.android.gms.fonts.update.UpdateSchedulerService >/dev/null 2>&1
done
am force-stop com.android.vending >/dev/null 2>&1
am force-stop com.android.chrome >/dev/null 2>&1
am force-stop com.google.android.gm >/dev/null 2>&1
rm -f /data/adb/service.d/lf-cleanup.sh
EOS
    chmod 0755 "$d/lf-cleanup.sh" 2>/dev/null
}

if [ -f "$MODDIR/gms.sh" ] && pm_ready; then
    MODDIR="$MODDIR" sh "$MODDIR/gms.sh" off >/dev/null 2>&1 &&
        ok "已恢复 GMS 字体服务"
elif [ -f "$MODDIR/CONFIG/gms-takeover" ]; then
    if defer_gms; then
        ok "系统服务未就绪，已安排开机后恢复 GMS 字体服务"
    else
        log "无法安排 GMS 恢复，可手动 pm enable $GMS_FONTS"
    fi
fi

# ---------- 2. 元模块配置 ----------
# hide.sh 加固前会备份成 config.sh.bak。卸载时还原成加固前的样子，
# 再把备份删掉——不然 /data/adb/mountify 里就多了一个我们写的文件。
for c in "$MOUNTIFY_DIR/config.sh" /data/adb/modules/mountify/config.sh; do
    [ -f "$c.bak" ] || continue
    if cp -f "$c.bak" "$c" 2>/dev/null; then
        ok "已还原 ${c}（加固前的配置）"
    else
        log "还原 ${c} 失败"
    fi
    rm -f "$c.bak" "$c.lf-tmp" 2>/dev/null
done

# ---------- 3. mountify 的挂载记录 ----------
# 非元模块模式下 mountify 会把挂上的模块 id 追加到 skipped_modules，
# 留着就是一行 "LiquidFont"。
SM="$MOUNTIFY_DIR/skipped_modules"
if [ -f "$SM" ] && grep -qx "$MODID" "$SM" 2>/dev/null; then
    if grep -vx "$MODID" "$SM" > "$SM.lf-tmp" 2>/dev/null; then
        mv -f "$SM.lf-tmp" "$SM"
        ok "已从 mountify 挂载记录中移除"
    fi
    rm -f "$SM.lf-tmp" 2>/dev/null
fi

# ---------- 4. OTA 暂存目录 ----------
# 刷了更新包但没重启时，新版本会先落在 modules_update 里；
# 这时候卸载，管理器只删 /data/adb/modules 下那份，暂存目录会留下来。
if [ -d "/data/adb/modules_update/$MODID" ]; then
    rm -rf "/data/adb/modules_update/$MODID" 2>/dev/null &&
        ok "已清除更新暂存 modules_update/$MODID"
fi

# ---------- 5. 模块目录内部 ----------
# 字体、字库、overlay、WebUI、状态标记、日志，全部清掉。
# 先清内容再让管理器删目录，避免「挂载中导致目录删不掉」。
for d in FONTS FALLBACK system webroot tools META-INF CONFIG; do
    [ -e "$MODDIR/$d" ] || continue
    rm -rf "$MODDIR/$d" 2>/dev/null
done

# 各种标记 / 临时文件：跳过挂载、停用、待删除、子集缓存、应用日志
rm -f "$MODDIR/skip_mount" "$MODDIR/skip_mountify" \
    "$MODDIR/disable" "$MODDIR/remove" \
    "$MODDIR"/*.log "$MODDIR"/*.lf-tmp 2>/dev/null

# ---------- 收尾 ----------
# 剩下的只有脚本和 module.prop，管理器会把整个目录一起删掉。
ok "模块内容已清空，管理器将删除 $MODDIR"
echo "[✓] LiquidFont 已卸载，重启后系统字体恢复原样"
