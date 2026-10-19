# tools/

放可选的原生工具，`apply.sh` 会自动识别（存在即启用，不存在就跳过）。

## subset

用来把「西文槽位」字体里自带的 CJK 字形裁掉。

为什么需要：`fonts.xml` 里 `sans-serif` / `sys-sans-en` 排在 `zh-Hans` / `zh-Hant` 之前，
而 Android 的字体配置没法声明「这个字体只负责英文」。所以只要英文字体带汉字，
中文就会被它渲染，表现为「中文没换干净」。

编译方式（harfbuzz 的 `hb-subset`，交叉编译到 Android arm64）：

```bash
# 需要 NDK 与 harfbuzz 源码
./configure --host=aarch64-linux-android --without-glib --without-freetype --without-cairo
make -j
# 产出 util/hb-subset，改名为 subset 放到这里
cp util/hb-subset ../tools/subset
```

约定接口（`apply.sh` 会这样调用）：

| 命令 | 语义 | 退出码 |
| --- | --- | --- |
| `subset -check <font>` | 检测是否含 CJK 字形 | 0=不含 1=含 2=文件无效 |
| `subset -in <font> -out <file>` | 生成拉丁子集 | 0=成功 其它=失败 |

> 没有这个工具也能正常用模块，只是英文字体带汉字时会盖掉中文字体，
> WebUI 会在对应卡片上给出 ⚠ 提示。
