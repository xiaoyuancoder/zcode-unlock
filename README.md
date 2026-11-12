# zcode-unlock（私有）

ZCode 客户端破甲：把引擎内置的「安全/道德边界」身份段替换为自定义提示词，
并带守护进程自愈——官方升级/重装覆盖引擎后 15 秒内自动重新注入。

本仓库是**工具包**，不含客户端本体（app.asar 384MB / ZCode.exe 246MB 超 GitHub
单文件限制）。新电脑流程：先装官方 ZCode，再跑本包一键脚本。

## 新电脑安装

前置：Windows + 官方 ZCode 已安装 + Node.js 在 PATH 里。

```powershell
# 1. clone 本私有仓库（需已登录有权限的 GitHub 账号）
git clone https://github.com/<你的账号>/zcode-unlock.git
cd zcode-unlock

# 2. 一键安装（注入引擎 + 部署 C:\zcode-unlock + 装守护自愈）
powershell -ExecutionPolicy Bypass -File .\unlock.ps1 apply
```

或双击 `run.cmd`（默认 status；要安装就先编辑传参 `apply`）。

装完**完全退出 ZCode（托盘也要退）再重启**生效。

验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\unlock.ps1 status
```

`injected: true` 即成功。

## 常用操作

```powershell
powershell -ExecutionPolicy Bypass -File .\unlock.ps1 status    # 查看状态
powershell -ExecutionPolicy Bypass -File .\unlock.ps1 apply     # 安装/重注入
powershell -ExecutionPolicy Bypass -File .\unlock.ps1 rollback  # 一键回滚
```

改提示词：编辑 `C:\zcode-unlock\system-prompt.md`，重启 ZCode 生效。
（仓库里 `tools/system-prompt.md` 是初始副本，改运行副本即可；想让新电脑
也用改过的版本，再拷回仓库提交。）

## 原理摘要

- 定位：按结构锚点（`buildIdentityPrompt` 引用的模块级常量）+ 语义特征
  （refuse/dual-use/safety 等关键词密度）匹配安全条款，不绑定固定文案，
  官方改措辞/换变量名也能命中。
- 替换：把该常量值换成 IIFE——运行时读 `<部署目录>\system-prompt.md`，
  读不到则回落为空串，不崩。
- 原子写：临时文件 → `vm.Script` 语法校验（15MB bundle 用 `node --check`
  会爆堆）→ rename 覆盖。备份 `zcode.cjs.zcode-unlock.bak` 带引擎指纹。
- 自愈：计划任务 + HKCU\Run 双保险拉起 `watchdog.cjs`（经 `run-hidden.vbs`
  SW_HIDE 隐藏窗口），15s 轮询引擎文件，被覆盖即重注入。

## 已知限制

- 云端审核 / 供应商 content policy / 账号侧 guardrail 不在本地范围。
- 引擎若被官方彻底重写定位锚点，看 `C:\zcode-unlock\watchdog.log` 的
  失败记录，需要更新定位策略。
- 会话标题生成走独立路径，不受影响。
- 部署目录路径写进了引擎注入表达式，**不要移动/重命名 `C:\zcode-unlock`**。

## 文件

| 文件 | 作用 |
| --- | --- |
| `unlock.ps1` | 一键入口：apply / status / rollback |
| `run.cmd` | 双击运行 unlock.ps1 |
| `tools/prompt-injector.cjs` | 注入器（定位/替换/备份/原子写/回滚） |
| `tools/system-prompt.md` | 注入的提示词正文 |
| `tools/watchdog.cjs` | 守护进程：检测覆盖并自动重注入 |
| `tools/run-hidden.vbs` | 隐藏窗口启动器 |
| `tools/install-task.cjs` | 计划任务安装/卸载 |
| `tools/install-autostart.cjs` | HKCU\Run 启动项安装/卸载 |
| `tools/README.md` | 原方案详细设计说明 |
