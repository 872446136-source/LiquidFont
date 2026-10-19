#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · hide.sh
#
# 为什么需要它：
#   字体模块靠 overlay 把文件盖到 /system/fonts 上。KernelSU 自带的 magic mount
#   会给每个文件单独做 bind mount，挂载点数量暴涨、来源是模块目录，
#   这是目前最容易被检测到的一类痕迹（zimperium 那套就是数挂载点）。
#
#   元模块（mountify 等）把挂载从 KSU 核心里剥出来：先把模块内容复制到
#   /mnt/vendor/<伪装名>，再整体 overlay 上去。挂载点数量回到 OEM 水平，
#   来源变成一个看起来像厂商分区的东西。
#
#   本脚本不改字体，只做两件事：
#     1. 把模块自己的命名痕迹清干净（旧版本留下的 LiquidFont-* 文件）；
#     2. 把元模块的配置调到「伪装挂载点 + 可被 Zygisk 卸载」的状态。
#
# 用法：
#   hide.sh status    输出 key=value，供 WebUI 解析
#   hide.sh apply     写入推荐的元模块配置（会先备份）
#   hide.sh restore   还原元模块配置
#   hide.sh auto      只做绝对安全的事（清旧文件 / 修 skip_mount），刷入时调用
#
# 一个容易踩的坑（mountify 源码 mountify_copy()）：
#   - 元模块模式（$META/metamount.sh 存在）：目标模块带 skip_mount 会被**跳过挂载**，
#     字体直接不生效；
#   - 普通模块模式：mountify 反过来会自己 touch skip_mount，不用我们管。
#   所以「无脑 touch skip_mount」是错的，本脚本按模式分别处理。

MODDIR="${MODDIR:-/data/adb/modules/LiquidFont}"
ACTION="${1:-status}"
[ -n "$2" ] && MODDIR="$2"

META_LINK="/data/adb/metamodule"
CFG_PERSIST="/data/adb/mountify/config.sh"

# 伪装挂载点候选：都长得像厂商分区，且默认不存在（同名目录会让 mountify 直接退出）
FAKE_CANDIDATES="my_manifest my_region odm_dlkm my_heytap_cfg vendor_dlkm_cfg oem_cfg"

# ---------- 探测 ----------
detect_root() {
    if [ -f /data/adb/ksud ] || [ -d /data/adb/ksu ]; then
        echo ksu
    elif [ -d /data/adb/ap ]; then
        echo apatch
    elif [ -d /data/adb/magisk ]; then
        echo magisk
    else
        echo unknown
    fi
}

meta_dir() {
    [ -e "$META_LINK" ] || return 1
    d="$(readlink -f "$META_LINK" 2>/dev/null)"
    if [ -z "$d" ] || [ ! -d "$d" ]; then
        d="$(ls -ld "$META_LINK" 2>/dev/null | sed -n 's/.* -> //p')"
        case "$d" in
        /*) ;;
        *) d="/data/adb/modules/$d" ;;
        esac
    fi
    [ -d "$d" ] || return 1
    echo "$d"
}

meta_name() {
    [ -f "$1/module.prop" ] || return 0
    sed -n 's/^name=//p' "$1/module.prop" 2>/dev/null | head -n 1 | tr -d '\r'
}

# 元模块模式判定：mountify 在 customize 阶段会把 post-fs-data.sh 改名成 metamount.sh
meta_mode() {
    d="$1"
    [ -n "$d" ] || { echo none; return; }
    if [ -f "$d/metamount.sh" ]; then
        echo metamodule
    else
        echo module
    fi
}

cfg_file() {
    d="$1"
    if [ -f "$CFG_PERSIST" ]; then
        echo "$CFG_PERSIST"
    elif [ -n "$d" ] && [ -f "$d/config.sh" ]; then
        echo "$d/config.sh"
    fi
}

# 读 KEY="value" / KEY=value，忽略注释
cfg_get() {
    awk -F= -v k="$1" '
        $1 ~ "^[ \t]*" k "[ \t]*$" {
            v = substr($0, index($0, "=") + 1)
            gsub(/^[ \t]+|[ \t]+$/, "", v)
            gsub(/^"|"$/, "", v)
            sub(/[ \t]*#.*$/, "", v)
            gsub(/^[ \t]+|[ \t]+$/, "", v)
            val = v
        }
        END { print val }
    ' "$2" 2>/dev/null
}

# 写 KEY=value，保留其余行；数值键不加引号
cfg_set() {
    f="$2"
    key="$1"
    val="$3"
    quote="${4:-yes}"
    [ -f "$f" ] || return 1
    if [ "$quote" = "no" ]; then
        line="$key=$val"
    else
        line="$key=\"$val\""
    fi
    if grep -qE "^[[:space:]]*${key}=" "$f" 2>/dev/null; then
        awk -v k="$key" -v l="$line" '
            BEGIN { done = 0 }
            {
                if (!done && $0 ~ "^[ \t]*" k "=") { print l; done = 1 }
                else print
            }
        ' "$f" > "$f.lf-tmp" && mv -f "$f.lf-tmp" "$f" || return 1
    else
        printf '%s\n' "$line" >> "$f" || return 1
    fi
    return 0
}

detect_zygisk() {
    hit=""
    for d in /data/adb/modules/*; do
        [ -d "$d" ] || continue
        id="${d##*/}"
        case "$id" in
        zygisk* | Zygisk* | zygisksu | shamiko | Shamiko | NoHello | nohello | rezygisk | ReZygisk | neozygisk | NeoZygisk | zygisk-assistant)
            n="$(meta_name "$d")"
            hit="${n:-$id}"
            ;;
        esac
    done
    echo "$hit"
}

# 挑一个当前不存在的伪装名，避免 mountify 撞上已有目录直接退出
pick_fake() {
    for c in $FAKE_CANDIDATES; do
        [ -e "/mnt/vendor/$c" ] && continue
        [ -e "/mnt/$c" ] && continue
        echo "$c"
        return 0
    done
    echo "oem_cfg"
}

# ---------- 旧版本痕迹 ----------
# v1.2.0 及以前，Unifont 落盘叫 LiquidFont-Unifont*.otf。
# 升级时旧文件不会自动消失（apply.sh 只写不删），留着就是一条「这里装过 LiquidFont」的线索。
LEGACY_GLOB="LiquidFont-*"
legacy_count() {
    n=0
    for f in "$MODDIR"/system/fonts/$LEGACY_GLOB; do
        [ -e "$f" ] || continue
        n=$((n + 1))
    done
    echo "$n"
}

clean_legacy() {
    n=0
    for f in "$MODDIR"/system/fonts/$LEGACY_GLOB; do
        [ -e "$f" ] || continue
        if rm -f "$f" 2>/dev/null; then
            n=$((n + 1))
            echo "[-] 清除旧命名文件 ${f##*/}"
        fi
    done
    [ "$n" -gt 0 ] && echo "[✓] 已清除 $n 个带模块名的旧文件"
    return 0
}

# ---------- 状态 ----------
print_status() {
    root="$(detect_root)"
    mdir="$(meta_dir)"
    mmode="$(meta_mode "$mdir")"
    mname="$(meta_name "$mdir")"
    cfg="$(cfg_file "$mdir")"
    zyg="$(detect_zygisk)"
    legacy="$(legacy_count)"

    echo "hide.root=$root"

    if [ -z "$mdir" ]; then
        echo "hide.meta=none"
        echo "hide.metamode=none"
    else
        echo "hide.meta=$mname"
        echo "hide.metamode=$mmode"
    fi

    fake=""
    dev=""
    mounts=""
    if [ -n "$cfg" ]; then
        fake="$(cfg_get FAKE_MOUNT_NAME "$cfg")"
        dev="$(cfg_get MOUNT_DEVICE_NAME "$cfg")"
        mounts="$(cfg_get mountify_mounts "$cfg")"
    fi
    echo "hide.fake=${fake:--}"
    echo "hide.dev=${dev:--}"
    echo "hide.mounts=${mounts:--}"

    # skip_mount 的正确性
    if [ "$mmode" = "metamodule" ]; then
        if [ -f "$MODDIR/skip_mount" ]; then
            echo "hide.skip=stale"
        else
            echo "hide.skip=ok"
        fi
    elif [ -f "$MODDIR/skip_mount" ]; then
        echo "hide.skip=present"
    else
        echo "hide.skip=absent"
    fi

    echo "hide.zygisk=${zyg:-none}"
    echo "hide.legacy=$legacy"

    # 综合评估
    if [ "$mmode" = "metamodule" ] && [ "$fake" != "mountify" ] && [ -n "$fake" ] && [ "$legacy" -eq 0 ]; then
        echo "hide.state=hardened"
    elif [ "$mmode" = "metamodule" ]; then
        echo "hide.state=partial"
    else
        echo "hide.state=basic"
    fi
}

# ---------- 加固 ----------
apply() {
    mdir="$(meta_dir)"
    if [ -z "$mdir" ]; then
        echo "[!] 没有安装元模块，无法伪装挂载点"
        echo "[-] KernelSU 3.0+ 请先刷 mountify，再把模块重装一次"
        clean_legacy
        return 1
    fi

    mmode="$(meta_mode "$mdir")"
    mname="$(meta_name "$mdir")"
    cfg="$(cfg_file "$mdir")"

    if [ -z "$cfg" ]; then
        echo "[!] 元模块是 ${mname:-未知}，不是 mountify，没有可写的配置"
        echo "[-] 请在它的设置里把挂载源改成 KSU / APatch，并确认已开启全局挂载"
        clean_legacy
        return 1
    fi

    echo "[*] 元模块: ${mname:-mountify}（$mmode 模式）"
    echo "[*] 配置文件: $cfg"

    # 备份一次就够，别把好配置覆盖成坏配置
    if [ ! -f "$cfg.bak" ]; then
        cp -f "$cfg" "$cfg.bak" && echo "[*] 已备份为 ${cfg##*/}.bak"
    fi

    # 1) skip_mount：元模块模式下必须不存在，否则 mountify 会跳过本模块
    if [ "$mmode" = "metamodule" ]; then
        if [ -f "$MODDIR/skip_mount" ]; then
            rm -f "$MODDIR/skip_mount" && echo "[-] 移除 skip_mount（元模块模式下它会让字体不挂载）"
        fi
    elif [ ! -f "$MODDIR/skip_mount" ]; then
        echo "[!] 当前 mountify 不是元模块模式，挂载仍由 KSU 自己做"
        echo "[-] 建议把 mountify 以元模块方式安装（KernelSU 3.0+ 必需）"
    fi

    # 2) 全局挂载：只挂 modules.txt 里列出的模块容易漏掉本模块
    if [ "$(cfg_get mountify_mounts "$cfg")" != "2" ]; then
        cfg_set mountify_mounts "$cfg" 2 no && echo "[*] mountify_mounts=2（挂载所有带 system 的模块）"
    fi

    # 3) 伪装挂载点
    old_fake="$(cfg_get FAKE_MOUNT_NAME "$cfg")"
    if [ "$old_fake" = "mountify" ] || [ -z "$old_fake" ]; then
        new_fake="$(pick_fake)"
        if cfg_set FAKE_MOUNT_NAME "$cfg" "$new_fake"; then
            echo "[*] FAKE_MOUNT_NAME: ${old_fake:-空} → $new_fake"
            echo "[-] 重启后挂载点变成 /mnt/vendor/$new_fake，不再是 /mnt/vendor/mountify"
        fi
    else
        echo "[-] FAKE_MOUNT_NAME 已是 $old_fake，保持不动"
    fi

    # 4) 挂载源名：只有存在 Zygisk 提供者时才值得设成 KSU，
    #    否则 /proc/mounts 里直接写着 KSU，比默认的 overlay 更显眼。
    zyg="$(detect_zygisk)"
    cur_dev="$(cfg_get MOUNT_DEVICE_NAME "$cfg")"
    if [ -n "$zyg" ]; then
        want="$(detect_root)"
        case "$want" in
        ksu) want="KSU" ;;
        apatch) want="APatch" ;;
        magisk) want="magisk" ;;
        *) want="" ;;
        esac
        if [ -n "$want" ] && [ "$cur_dev" != "$want" ]; then
            cfg_set MOUNT_DEVICE_NAME "$cfg" "$want" && echo "[*] MOUNT_DEVICE_NAME → $want（配合 $zyg 按应用卸载）"
        fi
        echo "[-] 记得在 $zyg 里把 Denylist Policy 设成 Enforced 或 Unmount Only"
    else
        echo "[!] 没检测到 Zygisk 提供者，挂载无法对指定应用隐藏"
        echo "[-] 建议装 Zygisk Next / ReZygisk，再回来点一次加固"
    fi

    # 5) tmpfs 模式的 decoy 挂载
    if [ "$(cfg_get use_ext4_sparse "$cfg")" != "1" ]; then
        if [ "$(cfg_get test_decoy_mount "$cfg")" != "1" ]; then
            cfg_set test_decoy_mount "$cfg" 1 no && echo "[*] test_decoy_mount=1（给 tmpfs 加一层诱饵挂载）"
        fi
    fi

    clean_legacy
    echo
    echo "[✓] 加固完成，重启后生效"
}

restore() {
    mdir="$(meta_dir)"
    cfg="$(cfg_file "$mdir")"
    if [ -z "$cfg" ] || [ ! -f "$cfg.bak" ]; then
        echo "[-] 没有可还原的备份"
        return 0
    fi
    cp -f "$cfg.bak" "$cfg" && echo "[✓] 已还原 ${cfg##*/}"
}

# 刷入时调用：只做不会把设备搞坏的事
auto() {
    mdir="$(meta_dir)"
    mmode="$(meta_mode "$mdir")"
    if [ "$mmode" = "metamodule" ] && [ -f "$MODDIR/skip_mount" ]; then
        rm -f "$MODDIR/skip_mount" && echo "[-] 移除残留的 skip_mount（元模块模式下会让字体不挂载）"
    fi
    clean_legacy >/dev/null 2>&1
    if [ -z "$mdir" ]; then
        echo "[-] 未安装元模块，挂载点仍由 KSU 自己管理"
    else
        echo "[-] 元模块: $(meta_name "$mdir")，可在 WebUI「挂载隐藏」里一键加固"
    fi
}

case "$ACTION" in
status) print_status ;;
apply) apply ;;
restore) restore ;;
auto) auto ;;
*)
    echo "用法: hide.sh [status|apply|restore|auto]"
    exit 1
    ;;
esac
