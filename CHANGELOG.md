# 更新日志

## v1.3.2

大字体不再被拦在门外。

- 单文件上限从 48 MB 提到 **128 MB**；超过 64 MB 会跳过预览（FontFace 加载几十 MB
  会把 WebView 卡住几秒），但写入和应用照常
- 超限提示改成显示实际大小与上限，不再只有一句「文件超过 48MB」
- 选字体时整份 buffer 只读一次：解析元信息、写盘、预览共用同一份，
  去掉原来的两次整份复制（大字体上省下几百 MB 内存）
- 预览读取上限 40 MB → 64 MB，读块 48 KB → 64 KB，回读快一截

## v1.3.1

卸载不留尾巴。

- 卸载时把模块目录之外的东西也清掉：mountify 的配置还原成加固前的样子并删除
  `config.sh.bak`、从 mountify 的 `skipped_modules` 里移除本模块、
  删掉 OTA 暂存的 `/data/adb/modules_update/LiquidFont`
- 模块目录内的 `FONTS` / `FALLBACK` / `system` / `webroot` / `tools` / `META-INF` /
  `CONFIG`、日志与 `skip_mount` 等标记全部清除
- 修掉一个会让 GMS 组件永久停用的时序问题：Magisk 在开机阶段跑卸载脚本，
  那时 `pm` 还没起来，`gms.sh off` 会静默失败。现在检测到这种情况会往
  `/data/adb/service.d/` 放一个一次性脚本，开机后补做恢复并自删
- 恢复 GMS 组件不再依赖标记文件，`pm enable` 对本来就启用的组件是无害的

## v1.3.0

把挂载痕迹藏起来。

- 新增「挂载隐藏」卡片：检测元模块（mountify）是否以元模块方式安装、当前伪装挂载点、
  Zygisk 提供者与旧命名残留，一键把配置调成推荐值（改前自动备份 `config.sh.bak`）
- 把 mountify 的 `FAKE_MOUNT_NAME` 从默认的 `mountify` 换成看起来像厂商分区的名字
  （自动挑一个当前不存在的，撞名会让 mountify 直接退出）
- 只有检测到 Zygisk 提供者时才把 `MOUNT_DEVICE_NAME` 设成 `KSU` / `APatch` / `magisk`；
  没有提供者时保持 `overlay`——否则 `/proc/mounts` 里直接写着 `KSU`，比默认值更显眼
- tmpfs 模式额外打开 `test_decoy_mount`，给挂载加一层诱饵
- **修正一个会让字体直接失效的坑**：元模块模式下模块目录里若有 `skip_mount`，
  mountify 会跳过整个模块；刷入时自动清除，加固时也会检查
- `system/fonts/` 下的 `LiquidFont-Unifont*.otf` 改名为 `SysFont-Unicode*.otf` /
  `SysFont-UnicodeExt.otf`，沿用 OPPO 自己的 `SysFont-` 前缀
- 应用字体与刷入时自动清除 v1.2.0 遗留的 `LiquidFont-*` 文件
- 新增 `hide.sh`，支持 `status` / `apply` / `restore` / `auto`

## v1.2.0

Play 商店的英文和数字也能跟着换了。

- 新增「Play 商店字体接管」开关：停用 Google Play 服务的 `FontsProvider` 与
  `UpdateSchedulerService`，并清掉已下载的字体缓存，让 Play 商店 / Chrome / Gmail
  的英文与数字回落到系统字体（这几家的可下载字体原本绕开 `system/fonts`）
- 只清已知的字体缓存路径，不做 `find /data` 全盘扫描
- 开关状态以系统里组件的真实状态为准，不只信标记文件
- 卸载模块时自动把 GMS 字体服务放回去，不会留下被停用的组件
- 新增 `gms.sh`，支持 `status` / `on` / `off`

## v1.1.0

内置全字库，生僻字不再缺字。

- 打包 **遍黑体 Plangothic 2.9.5795**（P1 + P2），覆盖 CJK 扩展 B–J 全部汉字，
  直接顶替系统里的旧版 `PlangothicP1.ttf` / `PlangothicP2.ttf`
- 打包 **GNU Unifont 18.0.01**（含 Unifont Upper），覆盖整张 Unicode 码表；
  作为新的字族追加到 `fonts.xml` 末尾，只接管前面所有字体都没覆盖的码位
- WebUI「更多」页新增「全字库兜底」开关，可随时关掉并恢复系统原样
- 三份字体配置（`fonts.xml` / `fonts_base.xml` / `fonts_ule.xml`）同步追加兜底字族
- 应用日志与状态接口新增兜底状态与字库版本号

## v1.0.0

首个版本。

- 五槽位字体替换：简体 / 繁体 / 西文 / 等宽 / Emoji，缺省自动回退
- 覆盖 ColorOS 17 新增的 `OPSans-En` 字族
- 全液态玻璃 WebUI：网格渐变背景、流动极光、镜面高光描边、液态底栏指示器、指针透镜
- 深色 / 浅色双主题，跟随系统并可手动切换
- 字体实时预览：直接加载本地字体文件渲染，支持字号与字重轴
- 读取字体元信息：家族名、可变轴范围、字形数、中文 / 西文覆盖量
- 英文槽位 CJK 覆盖检测与警告
- 一键应用 / 清空 / 还原，应用日志可在 WebUI 内查看
