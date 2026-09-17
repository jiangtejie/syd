# 随包 ffmpeg（wxgf / HEVC 图片解码）

## 为什么需要它

微信 4.x 的图片附件里，一部分"默认图"是 **纯 HEVC(wxgf)** 流。项目内嵌的 JPEG/PNG 截取路径对这类
解不出来，只能调外部 ffmpeg 转 JPEG 首帧（`services/media/datDecrypt.ts` 的 `convertHevcToJpeg`）。
实测本机 232 张 HEVC 默认图里有 42 张（18%）还踩过"一次喂多张导致白图"的坑 —— 这条链路是真实存在、
且用户能直接感知的（"这张图为什么是糊的/白的"）。

在此之前只能由用户在 设置 → 图片解密 → ffmpeg 路径 手填。随包之后**开箱可用**。

## 它只需要三样能力

实际命令行（`datDecrypt.ts`）：

```
ffmpeg -hide_banner -loglevel error -f hevc -i pipe:0 -vframes 1 -q:v 3 -f mjpeg pipe:1
```

即：**hevc 解复用 + hevc 解码 + mjpeg 编码**。不需要 x264/x265、不需要网络协议、不需要滤镜。
`scripts/prepare-ffmpeg.mjs` 会在放入时自动探测这三项，缺哪项直接报错。

## 查找优先级

`services/media/ffmpegPath.ts`（纯函数，自检 `npm run test:ffmpeg-path`）：

```
用户显式配置(app_config: media.ffmpegPath)  >  环境变量 WECHAT_CS_FFMPEG  >  随包  >  PATH
```

两条刻意的设计：

- **显式配置即使文件不存在也原样返回** —— 让人当场发现路径填错，而不是被静默换成随包那份；
- **随包排在 PATH 之前** —— 否则目标机 PATH 上恰好有个残缺/旧版 ffmpeg 会先命中，
  表现为「装了包还是解不出 HEVC 图」，属于很难排查的一类现象。

## 怎么放入 / 怎么换

```bash
npm run ffmpeg:prepare -- "D:\path\to\ffmpeg.exe"   # 或设环境变量 FFMPEG_SRC
```

脚本会：探测能力 → 复制到 `resources/bin/` → 算 SHA256 → 写 `resources/bin/NOTICE.md`
（版本/体积/校验值/来源/许可证）→ 对体积和 GPL 给警告。

**换二进制不需要改任何代码**，重跑这条命令即可。

## 打包

`electron-builder.yml` 已配 `extraResources: resources/bin → bin`，
运行时代码按 `process.resourcesPath/bin/ffmpeg.exe` 读取（打包）/ `resources/bin/`（开发），
与 `resources/ps/` 同一套分支写法。

> `resources/bin/` 已加入 `.gitignore`：二进制不进版本库（可重新获取且体积大）。
> 因此**新克隆的仓库需要先跑一次 `ffmpeg:prepare` 才能打包**（否则 `extraResources` 找不到源目录）。

## ⚠️ 分发前必须确认的两件事

### 1. 许可证：GPL 还是 LGPL

以独立进程 spawn 调用，**应用代码不会被传染**，但**二进制本身**的许可证义务要履行：

| 构建类型 | 随包分发的义务 |
| --- | --- |
| **GPL**（`--enable-gpl`，如 gyan.dev full build） | 需随附许可证文本 **+ 对应源码的获取方式**（GPLv3 要求） |
| **LGPL**（`--disable-gpl` 自建，或 BtbN 的 lgpl 变体） | 附许可证文本 + 可重链接说明，义务轻得多 |

2026-09 集成时放进去的是 **gyan.dev full build 9.0.1（GPL v3，211.9 MB）** —— 见下方"当前状态"。
**只装自己/内网自用**通常无碍；**对外发给客户/门店**建议换 LGPL 最小构建。

### 2. HEVC 专利（与许可证是两件事）

HEVC 除版权外还涉及专利许可（Access Advance / Via LA 等专利池）。LGPL/GPL 解决不了这个问题，
商用分发前请自行确认。本文档不构成法律意见。

### 3. 体积

- 全功能构建：200 MB+（安装包明显变大）
- 最小构建（只要上面三样能力）：约 10–20 MB

## 当前状态

| 项 | 值 |
| --- | --- |
| 文件 | `resources/bin/ffmpeg.exe`（不在版本库） |
| 版本 | ffmpeg 9.0.1-full_build-www.gyan.dev |
| 体积 | 211.9 MB |
| 许可证 | **GPL v3**（configuration 带 `--enable-gpl --enable-version3`） |
| 能力 | ✔ hevc 解码 / ✔ mjpeg 编码 / ✔ hevc 解复用 |

## 怎么验证打包进去没有

```bash
npm run build && npx electron-builder --dir --config electron-builder.offline.yml
Test-Path dist\win-unpacked\resources\bin\ffmpeg.exe    # 应为 True
```

运行起来后：打开一张微信里的 HEVC 图片，若之前显示缩略图、现在能显示大图即为生效；
界面上的降级提示（"本机没有可用的 ffmpeg"）应当消失。
