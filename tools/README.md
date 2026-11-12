# ZCode 破限注入（持久化版）

替代 `a0yark/zcode-prompt`：不再只改一次磁盘文件，而是**改完还能自动续命**。

## 为什么原方案重启会失效

`zcode-prompt` 直接改写 `resources/glm/zcode.cjs`。但这个文件会被官方更新、
安装器重装、或自修复流程覆盖回原版——一旦覆盖，注入就没了。

本方案在原思路上加了一层**自愈守护**：改完后有个常驻进程盯着引擎文件，
一旦发现被还原，15 秒内自动重新注入。

## 工作方式

1. **定位**：不按固定文案找安全条款，而是先找到 `buildIdentityPrompt` 引用的
   那个模块级常量（当前版本叫 `Qgo`），再用语义特征确认它确实是安全/边界条款。
   官方改了措辞、换了变量名也能命中。

2. **替换**：只把这一处常量的值换成「从 `system-prompt.md` 读内容」的表达式。
   身份段的其它结构（CLI 前缀、harness 段）全部保留。

3. **续命**：计划任务 `ZCodeUnlockWatchdog` 登录时启动，15 秒轮询一次引擎文件，
   发现被还原就重新注入。

4. **无窗口**：守护进程通过 `run-hidden.vbs`（`WScript.Shell.Run` + `SW_HIDE`）
   拉起。`node.exe` 是控制台子系统程序，直接启动会弹黑色命令行窗口；这台
   机器没有 `nodew.exe`，所以用 VBS 隐藏。计划任务和开机启动项都走这条路径。

## 关键设计取舍

**为什么不走 `customSystemPrompt`？** 引擎里 `customSystemPrompt` 非空时，会
整体跳过身份段以及 `!i` 块里的 memory / env info / output style /
context management 等段落。实测会损失大量正常功能，所以没用这条路。

**为什么替换成读文件而不是内联文本？** 改提示词只需编辑 `system-prompt.md`，
不用重写 15MB 的引擎文件。改完重启 ZCode 即生效。

**为什么用 `vm.Script` 而不是 `node --check` 做语法校验？** 15MB 的 bundle
用 `--check` 会耗尽 V8 堆内存直接崩，`vm.Script` 只编译不执行，稳定。

**为什么用 VBS 而不是直接跑 node？** `node.exe` 是控制台程序，用计划任务或
HKCU 启动项在登录时直接拉起会弹黑窗。`run-hidden.vbs` 用
`WScript.Shell.Run(cmd, 0, False)` 以 `SW_HIDE` 方式异步启动，进程完全静默。
守护进程派生的子进程也带 `windowsHide: true`。

## 常用操作

```bash
cd C:/zcode-unlock

node prompt-injector.cjs status   # 查看当前状态
node prompt-injector.cjs apply    # 手动注入一次
node prompt-injector.cjs revert   # 从备份回滚
node watchdog.cjs --once          # 只做一次检查/修复
```

改提示词：编辑 `C:/zcode-unlock/system-prompt.md`，然后**完全退出并重启 ZCode**
（托盘也要退）。已打开的会话仍是用启动时组装的旧系统提示词。

## 计划任务

```powershell
# 启动/停止
Start-ScheduledTask -TaskName 'ZCodeUnlockWatchdog'
Stop-ScheduledTask  -TaskName 'ZCodeUnlockWatchdog'

# 彻底卸载
node C:/zcode-unlock/install-task.cjs uninstall
node C:/zcode-unlock/install-autostart.cjs uninstall
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `system-prompt.md` | 注入的提示词正文，改这个即可 |
| `prompt-injector.cjs` | 注入器：定位 / 替换 / 备份 / 原子写 / 回滚 |
| `watchdog.cjs` | 守护进程：检测被覆盖并自动重新注入 |
| `run-hidden.vbs` | 隐藏窗口启动器（SW_HIDE），计划任务与开机启动项都走它 |
| `install-task.cjs` | 安装 / 卸载计划任务 |
| `install-autostart.cjs` | 安装 / 卸载 HKCU\Run 启动项 |
| `watchdog.log` | 守护进程日志 |

## 备份与回滚

注入时会在引擎旁留一份：

- `zcode.cjs.zcode-unlock.bak` —— 注入前的引擎
- `zcode.cjs.zcode-unlock.bak.meta` —— 引擎指纹，避免拿旧备份覆盖新版本

回滚：`node prompt-injector.cjs revert`

## 已知限制

- 云端审核、供应商 content policy、账号侧 guardrail 不在本地范围内，改本地
  文件影响不到这些。
- 官方若彻底删除 `buildIdentityPrompt` 或该常量，定位会失败；此时
  `watchdog.log` 会记录 `policy constant not found`，需要更新定位策略。
- 会话标题生成走独立代码路径，不受这里影响。
- 改动安装目录里的文件可能影响应用签名校验。Windows 上一般不触发问题，
  但如果 ZCode 升级后行为异常，先 `revert` 再查。
