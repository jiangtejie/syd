/**
 * 产品名的**唯一来源**。
 *
 * 为什么单独一个文件：这个名字此前散在十来处（窗口标题、托盘提示、系统通知、HTML title、
 * 设置页版本行、对话空态、默认智能体播种、两处 AI 系统提示词、electron-builder 的 productName），
 * 改一次名要全仓搜一遍，还容易漏掉只在某些时刻才看得见的那几处（托盘、通知、空态）。
 * 主进程与渲染层都从这里取；构建期与静态文件（electron-builder.yml、renderer/index.html、
 * 数据库迁移里记录的历史值）只能写字面量，那几处有注释互指。
 *
 * 注意：**只改显示名，不要改 package.json 的 name**（`wechat-cs-desktop`）。
 * Electron 用 package.json 的 name 决定 userData 目录（%APPDATA%\wechat-cs-desktop），
 * 一改老用户的 cs.db、日志、缓存、注入截图就全都"不见了"。
 */
export const APP_NAME = '私域运营助手'
