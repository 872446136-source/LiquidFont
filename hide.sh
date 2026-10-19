#!/system/bin/sh
# shellcheck shell=ash
# LiquidFont · hide.sh
#
# 为什么需要它：
#   字体模块靠 overlay 把文件盖到 /system/fonts 上。KernelSU 自带的挂载
#   会给每个文件单独做 bind mount，挂载点数量暴涨、来源是模块目录，
#   这是目前最容易被检测到的一类痕迹（zimperium 那套就是数挂载点）。
#
#   元模块把挂载从 KSU 核心里剥出来，改由自己接管。目前推荐
#   Meta-Magic-Mount-RS（MMRS，模块 ID magic_mount_rs）：它用 magic mount
#   的方式按目录合并挂载，挂载点数量回到 OEM 水平；更关键的是它有两个
#   别处没有的隐藏开关：
#
#     mountsource —— 那两个 tmpfs 的「来源」字符串，默认写死成 KSU。
#                    /proc/self/mountinfo 里一眼就能看到，等于自报家门。
#                    改成 tmpfs 之后，和系统自己在 /debug_ramdisk 挂的那层
#                    完全一样，看不出第二层是后加的。
#     umount      —— 把每个挂载点登记给 KSU 驱动（MANAGE_TRY_UMOUNT）。
#                    只有登记过，denylist 里的应用才会真的看不到这层挂载。
#                    默认关，等于挂载对检测应用完全可见。
#
#   本脚本不改字体，只做两件事：
#     1. 把模块自己的命名痕迹清干净（旧版本留下的 LiquidFont-* 文件）；
#     2. 把元模块的配置调到「来源伪装 + 可按应用卸载」的状态。
#
# 用法：
#   hide.sh status    输出 key=value，供 WebUI 解析
#   hide.sh apply     写入推荐的元模块配置（会先备份）
#   hide.sh restore   还原元模块配置
#   hide.sh auto      只做绝对安全的事（清旧文件 / 修 skip_mount），刷入时调用
#
# 一个容易踩的坑：
#   - 元模块模式（$META/metamount.sh 存在）：目标模块带 skip_mount 会被
#     **跳过挂载**，字体直接不生效；
#   - 非元模块模式：mountify 反过来会自己 touch skip_mount，不用我们管。
#   所以「无脑 touch skip_mount」是错的，本脚本按模式分别处理。

MODDIR="${MODDIR:-/data/adb/modules/LiquidFont}"
ACTION="${1:-status}"
[ -n "$2" ] && MODDIR="$2"

META_LINK="/data/adb/metamodule"

# MMRS（推荐）
MMRS_DIR="/data/adb/magic_mount"
MMRS_CFG="$MMRS_DIR/config.toml"

# mountify（仍兼容）
MOUNTIFY_CFG="/data/adb/mountify/config.sh"

# 伪装挂载点候选：都长得像厂商分区，且默认不存在（同名目录会让 mountify 直接退出）
FAKE_CANDIDATES="my_manifest my_region odm_dlkm my_heytap_cfg vendor_dlkm_cfg oem_cfg"

# MMRS 的挂载源改成什么。tmpfs 和系统自己在 /debug_ramdisk 挂的那层同名，
# 混在里面看不出区别；写 KSU / Magisk / APatch 等于直接告诉检测方「这里有模块」。
MMRS_SRC="tmpfs"

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

# 元模块模式判定：元模块在安装阶段会把 post-fs-data.sh 改名成 metamount.sh
meta_mode() {
    d="$1"
    [ -n "$d" ] || { echo none; return; }
    if [ -f "$d/metamount.sh" ]; then
        echo metamodule
    else
        echo module
    fi
}

# 认出是哪个元模块。只看标志文件，不猜名字——用户可能改过模块显示名。
meta_kind() {
    d="$1"
    [ -n "$d" ] || { echo none; return; }
    id="${d##*/}"
    if [ "$id" = "magic_mount_rs" ] || [ -f "$d/meta-mm" ] || [ -f "$MMRS_CFG" ]; then
        echo mmrs
        return
    fi
    if [ "$id" = "mountify" ] || [ -f "$MOUNTIFY_CFG" ] || [ -f "$d/config.sh" ]; then
        echo mountify
        return
    fi
    echo other
}

cfg_file() {
    d="$1"
    if [ -f "$MOUNTIFY_CFG" ]; then
        echo "$MOUNTIFY_CFG"
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

# ---------- TOML（MMRS 用） ----------
# 只处理 config.toml 里的扁平键值，够用；不引第三方解析器。
toml_get() {
    key="$1"
    f="$2"
    [ -f "$f" ] || return 0
    sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$f" 2>/dev/null |
        head -n 1 |
        sed 's/[[:space:]]*#.*$//' |
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
        sed 's/^"//; s/"$//'
}

# mode=quote 写字符串，mode=raw 写布尔/数字/数组
toml_set() {
    key="$1"
    val="$2"
    f="$3"
    mode="${4:-quote}"
    [ -f "$f" ] || return 1
    if [ "$mode" = "raw" ]; then
        line="$key = $val"
    else
        line="$key = \"$val\""
    fi
    if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$f" 2>/dev/null; then
        awk -v k="$key" -v l="$line" '
            BEGIN { done = 0 }
            {
                if (!done && $0 ~ "^[ \t]*" k "[ \t]*=") { print l; done = 1 }
                else print
            }
        ' "$f" > "$f.lf-tmp" && mv -f "$f.lf-tmp" "$f" || return 1
    else
        printf '%s\n' "$line" >> "$f" || return 1
    fi
    return 0
}

# MMRS 没跑过之前 config.toml 可能还不存在，这里补一份默认的
mmrs_ensure_cfg() {
    mkdir -p "$MMRS_DIR" 2>/dev/null || return 1
    if [ ! -f "$MMRS_CFG" ]; then
        {
            printf 'mountsource = "KSU"\n'
            printf 'umount = false\n'
            printf 'partitions = []\n'
            printf 'extra_mount = []\n'
        } >"$MMRS_CFG" || return 1
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
    kind="$(meta_kind "$mdir")"
    zyg="$(detect_zygisk)"
    legacy="$(legacy_count)"

    echo "hide.root=$root"
    echo "hide.kind=$kind"

    if [ -z "$mdir" ]; then
        echo "hide.meta=none"
        echo "hide.metamode=none"
    else
        echo "hide.meta=$mname"
        echo "hide.metamode=$mmode"
    fi

    src=""
    fake=""
    dev=""
    mounts=""
    umount=""
    if [ "$kind" = "mmrs" ]; then
        src="$(toml_get mountsource "$MMRS_CFG")"
        umount="$(toml_get umount "$MMRS_CFG")"
    elif [ "$kind" = "mountify" ]; then
        cfg="$(cfg_file "$mdir")"
        if [ -n "$cfg" ]; then
            fake="$(cfg_get FAKE_MOUNT_NAME "$cfg")"
            dev="$(cfg_get MOUNT_DEVICE_NAME "$cfg")"
            mounts="$(cfg_get mountify_mounts "$cfg")"
            src="$dev"
        fi
    fi
    echo "hide.src=${src:--}"
    echo "hide.umount=${umount:--}"
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
    if [ "$mmode" != "metamodule" ]; then
        echo "hide.state=basic"
        return
    fi

    if [ "$kind" = "mmrs" ]; then
        # 两个开关都到位、也没有残留旧文件，才算加固完成
        if [ "$src" != "KSU" ] && [ -n "$src" ] && [ "$umount" = "true" ] && [ "$legacy" -eq 0 ]; then
            echo "hide.state=hardened"
        else
            echo "hide.state=partial"
        fi
    elif [ "$kind" = "mountify" ]; then
        if [ "$fake" != "mountify" ] && [ -n "$fake" ] && [ "$legacy" -eq 0 ]; then
            echo "hide.state=hardened"
        else
            echo "hide.state=partial"
        fi
    else
        echo "hide.state=partial"
    fi
}

# ---------- 加固：MMRS ----------
apply_mmrs() {
    d="$1"
    mname="$(meta_name "$d")"
    echo "[*] 元模块: ${mname:-Magic Mount-rs}（MMRS）"

    if ! mmrs_ensure_cfg; then
        echo "[!] 无法写入 $MMRS_CFG"
        clean_legacy
        return 1
    fi
    echo "[*] 配置文件: $MMRS_CFG"

    # 备份一次就够，别把好配置覆盖成坏配置
    if [ ! -f "$MMRS_CFG.bak" ]; then
        cp -f "$MMRS_CFG" "$MMRS_CFG.bak" && echo "[*] 已备份为 config.toml.bak"
    fi

    # 1) skip_mount：元模块模式下必须不存在，否则本模块会被跳过
    if [ -f "$MODDIR/skip_mount" ]; then
        rm -f "$MODDIR/skip_mount" && echo "[-] 移除 skip_mount（元模块模式下它会让字体不挂载）"
    fi

    # 2) 挂载源：默认的 KSU 在 mountinfo 里等于自报家门
    cur_src="$(toml_get mountsource "$MMRS_CFG")"
    case "$cur_src" in
    "" | KSU | ksu | Magisk | magisk | APatch | apatch)
        if toml_set mountsource "$MMRS_SRC" "$MMRS_CFG" quote; then
            echo "[*] mountsource: ${cur_src:-空} → $MMRS_SRC"
            echo "[-] 那两层 tmpfs 的来源不再写 KSU，和系统自带的 /debug_ramdisk 一模一样"
        fi
        ;;
    *)
        echo "[-] mountsource 已是 $cur_src，保持不动"
        ;;
    esac

    # 3) umount：登记给 KSU 驱动，denylist 里的应用才真的看不到这层挂载
    cur_um="$(toml_get umount "$MMRS_CFG")"
    if [ "$cur_um" != "true" ]; then
        if toml_set umount true "$MMRS_CFG" raw; then
            echo "[*] umount: ${cur_um:-空} → true"
            echo "[-] 每个挂载点都会登记给 KSU，屏蔽应用时能按应用卸载"
        fi
    else
        echo "[-] umount 已开启"
    fi

    # 4) Zygisk 提示
    zyg="$(detect_zygisk)"
    if [ -n "$zyg" ]; then
        echo "[-] 记得在 $zyg 里把 Denylist Policy 设成 Enforced 或 Unmount Only"
    else
        echo "[!] 没检测到 Zygisk 提供者，挂载无法对指定应用隐藏"
        echo "[-] 建议装 Zygisk Next / ReZygisk，再回来点一次加固"
    fi

    clean_legacy
    echo
    echo "[✓] 加固完成，重启后生效"
    return 0
}

# ---------- 加固：mountify ----------
apply_mountify() {
    d="$1"
    mmode="$(meta_mode "$d")"
    mname="$(meta_name "$d")"
    cfg="$(cfg_file "$d")"

    if [ -z "$cfg" ]; then
        echo "[!] 元模块是 ${mname:-未知}，不是 mountify，没有可写的配置"
        echo "[-] 请在它的设置里把挂载源改成 KSU / APatch，并确认已开启全局挂载"
        clean_legacy
        return 1
    fi

    echo "[*] 元模块: ${mname:-mountify}（$mmode 模式）"
    echo "[*] 配置文件: $cfg"

    if [ ! -f "$cfg.bak" ]; then
        cp -f "$cfg" "$cfg.bak" && echo "[*] 已备份为 ${cfg##*/}.bak"
    fi

    # 1) skip_mount
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
    return 0
}

# ---------- 入口 ----------
apply() {
    mdir="$(meta_dir)"
    if [ -z "$mdir" ]; then
        echo "[!] 没有安装元模块，无法伪装挂载点"
        echo "[-] KernelSU / APatch 请先刷 Meta-Magic-Mount-RS，再把模块重装一次"
        clean_legacy
        return 1
    fi

    kind="$(meta_kind "$mdir")"
    case "$kind" in
    mmrs) apply_mmrs "$mdir" ;;
    mountify) apply_mountify "$mdir" ;;
    *)
        echo "[!] 元模块是 $(meta_name "$mdir")，既不是 MMRS 也不是 mountify，没有可写的配置"
        echo "[-] 请在它的设置里把挂载源改成 KSU / APatch，并确认已开启全局挂载"
        clean_legacy
        return 1
        ;;
    esac
}

restore() {
    mdir="$(meta_dir)"
    kind="$(meta_kind "$mdir")"
    if [ "$kind" = "mmrs" ]; then
        f="$MMRS_CFG"
    else
        f="$(cfg_file "$mdir")"
    fi
    if [ -z "$f" ] || [ ! -f "$f.bak" ]; then
        echo "[-] 没有可还原的备份"
        return 0
    fi
    cp -f "$f.bak" "$f" && echo "[✓] 已还原 ${f##*/}"
}

# 刷入时调用：只做不会把设备搞坏的事
auto() {
    mdir="$(meta_dir)"
    mmode="$(meta_mode "$mdir")"
    kind="$(meta_kind "$mdir")"
    if [ "$mmode" = "metamodule" ] && [ -f "$MODDIR/skip_mount" ]; then
        rm -f "$MODDIR/skip_mount" && echo "[-] 移除残留的 skip_mount（元模块模式下会让字体不挂载）"
    fi
    clean_legacy >/dev/null 2>&1
    if [ -z "$mdir" ]; then
        echo "[-] 未安装元模块，挂载点仍由 KSU 自己管理"
    elif [ "$kind" = "mmrs" ]; then
        echo "[-] 元模块: $(meta_name "$mdir")（MMRS），可在 WebUI「挂载隐藏」里一键加固"
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
