# 打包与分发

## 命令

```bash
npm run build:win            # 自检 → 构建 → 打 NSIS 安装包 → 写构建记录（需外网下载 Electron/NSIS）
npm run build:win:offline    # 同上，但用本地 node_modules/electron/dist（内网/无外网）
npm run build:unpack         # 只出 dist/win-unpacked（不生成安装包，用于快速验证打包内容）
```

产物：
```
dist\wechat-cs-desktop-1.0.0-setup.exe     NSIS 安装包
dist\BUILD-INFO.txt                       版本 / commit / 校验值 / 随包 ffmpeg 指纹
```

## 首次在新克隆的仓库上打包，必须先做一步

```bash
npm install
npm run ffmpeg:prepare -- "<你的 ffmpeg.exe 路径>"   # 见 docs/ffmpeg-bundling.md
```

`resources/bin/` 已加入 `.gitignore`（二进制不进版本库），所以**新克隆的仓库没有它**。
忘了跑这步会被下面的自检直接拦下来，而不是打出一个"图还是糊的"包。

## 构建前自检（`npm run prebuild:check`，已串进打包命令）

三项，任一不通过就 `exit 1` 并给出修复命令：

| 检查 | 为什么 |
| --- | --- |
| 随包 ffmpeg 就位 | 缺了不会构建失败，但目标机的 HEVC 图仍然打不开，事后极难排查 |
| `resources/ps/*.ps1` 三个注入脚本就位 | 缺了发送功能在打包后静默失效 |
| **原生模块能让 Electron 真的加载一次** | 见下 |

原生模块那条值得单说：`better-sqlite3-multiple-ciphers` 13 是 **N-API 预编译包**
（`prebuilds/<平台>-<架构>.node`，`gypfile:false`）。N-API 跨 Node 与 Electron 版本 ABI 稳定，
所以 **不需要 rebuild** —— `electron-builder.yml` 里的 `npmRebuild: false` 是刻意的，
`postinstall: electron-builder install-app-deps` 对它基本是空操作。

⚠️ 不要照抄网上"检查 `build/Release/better_sqlite3.node`"的老判据 —— 那是旧版 better-sqlite3 的
布局，在这个包上恒为假，会把好好的仓库判成坏的（本文件对应的脚本第一版就是这么写错的）。

现在的判据是**实际加载**：
```
ELECTRON_RUN_AS_NODE=1 electron.exe -e "require('better-sqlite3-multiple-ciphers')…建表读回…"
```
这是最接近真机的证据：它过了，包里的原生模块就能用。

## 打包配置里的几个刻意决定（`electron-builder.yml`）

| 配置 | 值 | 为什么 |
| --- | --- | --- |
| `nsis.oneClick` | `false` | 一站式安装闪一下就完事，用户不知道装到哪、也改不了。改成向导式；静默部署仍可用 `setup.exe /S` |
| `nsis.allowToChangeInstallationDirectory` | `true` | 门店电脑 C 盘常常很紧张，而这个应用还要在非系统盘写缓存 |
| `nsis.deleteAppDataOnUninstall` | `false` | **卸载不删用户数据**：`cs.db` 里有客户档案、群问题历史与密钥。要彻底清除请手动删 `%APPDATA%\wechat-cs-desktop` 与缓存目录 |
| `nsis.perMachine` | `false`（默认） | 按用户安装，**不需要管理员** |
| `electronLanguages` | `zh-CN, en-US` | Electron 自带约 50 个语言的 `.pak`；本产品只有中文界面，删掉的语言永远不会被加载。**实测省 43MB**（win-unpacked 699→656MB） |
| `compression` | `maximum` | NSIS solid LZMA。**实测安装包 175.4→167.9MB**（代价是构建变慢） |
| `publish` | **不配** | 本应用没有更新服务器，之前指向 `example.com` 占位地址。注意：**去掉后 `latest.yml` 仍会生成**（electron-builder 默认产出更新元数据），只是不再含那个不存在的域名/URL —— 如实记录，别以为它消失了。等真有更新服务时再加回 `publish` |
| `npmRebuild` | `false` | 见上一节 |
| `extraResources` | `resources/ps → ps`、`resources/bin → bin` | 运行时代码按 `process.resourcesPath/ps|bin` 读取（与 `injector.scriptPath()` 同一套分支写法） |

## ⚠️ 不要用 `win.files` 去裁 `prebuilds`（踩过的坑）

`better-sqlite3-multiple-ciphers` 按 node-gyp-build 约定带了 **8 个平台**的 N-API 二进制，
Windows 包里只有 `win32-x64.node` 会被加载，其余约 18MB 看起来是纯陪跑。曾经这样裁：

```yaml
# ❌ 这么做会出事，已撤销
win:
  files:
    - '!**/node_modules/better-sqlite3-multiple-ciphers/prebuilds/**'
    - '**/node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node'
```

**实测结果**：不仅没省下体积，反而**把整个原生模块都排除了**（包里连带 `prebuilds` 的目录都不存在），
且 `resources` 反而胖了 380MB，安装包从 175MB 涨到 **440MB**。打出来的包**一读库就会崩**。

原因是 `files` 里的 include 模式会连带影响 electron-builder 对 `node_modules` 的收集，
不是"只对这个目录生效"。**结论：省这 18MB 不值这个风险**。真要裁，请用
「打包后处理 + 用 Electron 实际加载验证」的方式，绝不要用 `files` 模式。

> 教训写在这里而不是删掉，是因为这个坑很符合直觉、很容易再犯一次。

## 构建后记录（`dist/BUILD-INFO.txt`）

安装包文件名里只有版本号。门店报问题时第一个要问的是"你装的是哪一版"，而**判断"是不是同一个包"
需要 commit + 校验值** —— 这份文件就是为此写的，同时记下随包 ffmpeg 的 SHA256
（它不在版本库里，事后无法从代码确认某台机器上跑的是哪份二进制）。

## 签名：目前**刻意不签**

安装包未做代码签名，Windows SmartScreen 会提示"未知发布者"，需点「更多信息 → 仍要运行」。

⚠️ 需要知道的一点：**签名买不到"没有警告"**。微软官方文档写明 OV/EV 证书首次下载**仍会警告**，
只是把"未知发布者"换成你的公司名；信誉要靠下载量累积，而本产品是低装机量的 B2B，
很可能永远攒不出来。另外 Azure Trusted Signing 的 Public Trust 证书有国家白名单，
**中国大陆不在其中**。

要接签名时，`electron-builder` 26 已支持 `win.certificateSubjectName`（USB Token / 云 HSM 场景）、
`win.certificateFile`、`win.azureSignOptions`、`win.signtoolOptions`。
**在拿到证书之前不要往配置里加签名项** —— 加了但没有证书会直接让构建失败。
用同一张证书一直签下去，否则版本间的信誉不能继承。

## 分发前还该知道的

- **目标机要求**：Windows 10/11 x64 + 微信桌面版并登录被托管的账号；不需要 Node
- **换机不能迁移密钥**：所有密钥用 DPAPI 加密、与机器+系统账户绑定，目标机必须重新导入
- **发送依赖微信窗口在前台**：锁屏 / RDP 直接失败
- **系统依赖**：PowerShell 5.1（自带）、中文 OCR 语言包、ffmpeg（现已随包，见 docs/ffmpeg-bundling.md）
- **数据落盘**：`%APPDATA%\wechat-cs-desktop`（cs.db + logs + inject-shots）、
  缓存默认优先放非系统盘根目录 `<盘>:\wechat-cs-desktop\cache`（含明文库副本，默认上限 3GB）
