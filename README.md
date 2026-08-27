<a id="zh"></a>

# pi-auto-wait

[![npm](https://img.shields.io/npm/v/pi-auto-wait)](https://www.npmjs.com/package/pi-auto-wait)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: GPLv3](https://img.shields.io/badge/license-GPLv3-blue.svg)](./LICENSE)

**中文文档（默认）** · [English](#en)

用于 [Pi](https://pi.dev) 的用量管理扩展：读取 **Pi 当前实际使用账号** 的 provider 用量、展示限额与重置时间、切换 Codex Fast 模式，并可在 Codex 的 5 小时限额耗尽时保留已提交的 prompt，等重置后自动继续。

> 该扩展展示各 provider 原生的配额语义，不会把订阅限额、API Key 消费额度和项目配额混为同一种“余额”。

## 目录

- [功能](#zh-features)
- [安装与升级](#zh-install)
- [快速开始](#zh-quick-start)
- [命令](#zh-commands)
- [Codex 5 小时自动等待](#zh-auto-wait)
- [Fast 模式](#zh-fast)
- [Provider 支持与语义](#zh-providers)
- [状态栏](#zh-statusline)
- [设置文件](#zh-settings)
- [安全、隐私与限制](#zh-security)
- [本地开发](#zh-development)

<a id="zh-features"></a>
## 功能

- `/usage` 查询当前账号用量；也可在菜单中查询其他已配置 provider。
- 支持 OpenAI Codex 的订阅窗口、5h / 周限额、重置时间、credits、模型专属 bucket 和可兑换的 usage reset。
- 支持 GitHub Copilot 的 AI Credits、Premium requests 或 Free chat allowance。
- 支持 OpenRouter 当前 API Key 的消费额度、剩余额度与消费周期。
- 支持 OpenCode Go（Zen）的滚动、周、月用量窗口。
- `/fast` 开关受支持 Codex 模型的 Fast 路由。
- `/autowait` 开关 Codex 5h 限额自动等待；等待后会复查额度才继续原 prompt。
- 用量缓存、状态栏和自动等待都按当前 provider 与当前账号隔离。
- 请求 provider 用量前验证 Pi 实际解析出的认证来源；不会把 custom/proxy provider 的凭据发送到官方用量端点。

<a id="zh-install"></a>
## 安装与升级

需要 Pi **0.81.0 或更高版本**，以便扩展验证 Pi 已解析认证的有效 base URL。OAuth credential-source v1 的互操作路径按 Pi 0.84.3 验证。

```bash
pi install npm:pi-auto-wait
```

临时运行而不永久安装：

```bash
pi -e npm:pi-auto-wait
```

从本地仓库构建并运行：

```bash
npm run build
pi -e ./
```

`pi-auto-wait` 的 Pi 入口是 `dist/index.ts`，因此直接从未构建的本地目录加载前必须先执行构建。

从旧版 `@narumitw/pi-codex-usage` 迁移：

```bash
pi remove npm:@narumitw/pi-codex-usage
pi install npm:pi-auto-wait
```

请移除旧扩展，避免两个用量扩展同时写入状态栏。

<a id="zh-quick-start"></a>
## 快速开始

1. 在 Pi 中选择已经登录的 provider / 模型。
2. 输入 `/usage`，查看当前账号与当前模型的用量。
3. 如需 Fast 模式，输入 `/fast`。
4. 如需在 5h 限额耗尽后自动等待并继续已提交的请求，输入 `/autowait` 开启。

常见状态栏示例：

```text
codex 59% 5h 61% wk
codex fast 59% 5h
codex waiting until 14:30
copilot credits 1200/1500 80%
openrouter $74.50 left
zen 0% r 4% w 2% m
```

<a id="zh-commands"></a>
## 命令

### `/usage`

在 TUI 或 RPC 模式执行 `/usage` 会先查询当前模型实际使用的 provider，然后提供菜单：

```text
Refresh current usage
Turn Fast mode on/off                 # 仅支持的当前 Codex 模型
Turn automatic 5h wait on/off         # 仅当前 OpenAI Codex provider
Redeem usage limit reset…             # 仅当前 Codex OAuth 账号且有可用 reset 时
View another configured provider…
View all configured providers…
Close
```

- `/usage` **不接受参数**；不支持 `/usage --all`、`/usage --refresh` 或 `/usage <provider>`。
- 跨 provider 查询必须在交互菜单中明确选择，避免在不知情时发送请求。
- Print / JSON 模式不支持 `/usage`，因为它们无法承载交互流程。
- 手动查询其他 provider 或查询全部 provider 不会覆盖当前 provider 的状态栏。

对于 Codex，**Redeem usage limit reset…** 会先重新验证当前账号、加载可用 reset、展示即将使用的 reset，再要求明确确认。默认选项是 **No, go back**。确认前不会发送 mutation；确认后请求使用唯一 redemption request ID，使不确定的网络重试可被后端幂等处理。

### `/fast`

切换当前受支持 Codex 模型的 Fast 模式。该命令不接受参数，且仅能在 TUI / RPC 模式使用。

### `/autowait`

切换当前 OpenAI Codex 模型的 5h 自动等待。该命令不接受参数，且仅能在 TUI / RPC 模式使用。开关会持久化到设置文件。

<a id="zh-auto-wait"></a>
## Codex 5 小时自动等待

自动等待默认关闭。开启后，扩展会在 Pi 准备开始 agent run 前执行以下步骤：

1. 强制查询当前账号、当前 Codex 模型对应的 **5h primary window**。
2. 如果窗口未耗尽，立即继续该 prompt。
3. 如果 `used_percent >= 100`（或 remaining 为 0），并且 provider 返回未来的 `reset_at`：
   - 已提交的 prompt 保持等待，不会丢弃，也不会要求用户重新输入；
   - 状态栏显示 `codex waiting until …`；
   - 到达重置时刻后额外等待 2 秒，并重新强制查询；
   - 只有确认窗口已经恢复可用时，才继续原 prompt。
4. 如果重置时间已过但 provider 仍报告耗尽，会每 15 秒复查一次，而不是假定额度已恢复。

模型切换、`/reload`、新会话、恢复/分叉会话以及 Pi 退出会取消正在进行的等待，防止旧模型的配额阻塞新会话。

### 自动等待的边界

- 仅适用于官方 `openai-codex` provider 返回的 5h window，不处理周限额、credits 或其他 provider。
- provider 没有返回 `reset_at`，或用量查询失败时，扩展会提示原因并**放行请求**，不会猜测等待时长。
- 如果一条已经发出的请求恰好触发 429，扩展无法追溯重试那条请求；它会保护之后提交的 prompt，在下一次 agent run 前先检查并等待。
- 等待状态与 reset 时间只保留在进程内存中，不写入磁盘。

<a id="zh-fast"></a>
## Codex Fast 模式

Fast 约快 **1.5×**，但会消耗更多计划额度。开关默认关闭，保存为 `codexFastMode`。

当前只对官方 `https://chatgpt.com` 上、API 为 `openai-codex-responses` 的以下模型生效：

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

开启时请求带 `service_tier: "priority"`；关闭时显式带 `service_tier: "default"`。custom origin、proxy 或未列出的模型不会被改写。

<a id="zh-providers"></a>
## Provider 支持与语义

| Provider | 用量来源 | 展示内容 | 说明 |
| --- | --- | --- | --- |
| OpenAI Codex | `GET https://chatgpt.com/backend-api/wham/usage` | 订阅窗口、5h / 周重置、credits、模型专属 bucket、earned resets | 使用 Pi 当前解析的官方 Codex 认证。状态栏优先选择与当前模型匹配的 bucket。 |
| GitHub Copilot | `GET https://api.github.com/copilot_internal/user` | AI Credits、Premium requests 或 Free chat requests、剩余量、重置时间、overage | 需要与当前 runtime access token 精确匹配的 Pi OAuth 登录。GitHub Enterprise 不支持。 |
| OpenRouter | `GET https://openrouter.ai/api/v1/key` | 当前 Key 的 limit、remaining、周期和 daily / weekly / monthly / total 消费 | 是 API Key 消费/额度，不是订阅配额；不会调用需要管理 key 的 `/credits`。 |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | 滚动、周、月窗口的使用率与重置时间 | 仅官方 `https://opencode.ai` origin。 |

### Codex usage reset

Codex reset redemption 使用：

```text
POST /wham/rate-limit-reset-credits/consume
```

它仅适用于：当前 provider 为 Codex、Pi 当前 OAuth access token 可与 Pi 登录或兼容 credential source 中的 OAuth 凭据精确匹配、且目标为官方 ChatGPT origin 的情况。API Key、proxy/custom origin、账号不匹配或已配置但非当前账号都会在 mutation 前失败。

<a id="zh-statusline"></a>
## 状态栏与刷新

状态栏 key 为 `usage`，仅服务于当前选择模型的 provider：

- session start、session tree、model select、turn start 会触发异步刷新；
- 活跃会话中每 5 分钟刷新一次；
- 切换到不支持的 provider 时清除状态栏；
- 失败会暂时退避，避免每个 turn 反复请求失败的端点；
- 自动等待期间，等待状态优先于普通 5h 百分比显示。

`@narumitw/pi-statusline` 如有安装会提供默认 `📊` 图标；本扩展只发布文本值。

<a id="zh-settings"></a>
## 设置文件

设置位于 Pi user agent 目录，通常为：

```text
~/.pi/agent/pi-usage.json
```

示例：

```json
{
  "codexFastMode": false,
  "codexAutoWait5h": true
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `codexFastMode` | `false` | 为受支持的 Codex 模型启用 Fast 路由。 |
| `codexAutoWait5h` | `false` | 在当前 Codex 5h window 耗尽后等待重置并继续已提交的 prompt。 |

设置读取与写入的保证：

- 每次 session start 重载；首次成功切换前不创建文件。
- 保留未知 JSON 字段。
- 写入使用私有临时文件和 rename，并设置为私有权限。
- 无效 JSON、错误类型、过大的文件或符号链接不会被覆盖。修复/删除文件后运行 `/reload`。
- 同一 Pi 进程内的写入串行化；不同 Pi 进程之间不互斥。

<a id="zh-security"></a>
## 安全、隐私与限制

### 凭据处理

- 凭据候选只在内存中同步收集；不会写入缓存、设置、日志、格式化输出或 session。
- 用量请求只向验证过的官方 origin 发送当前 runtime 精确匹配的凭据。
- API Key、OAuth token、opaque account ID、opaque reset credit ID 不会在界面或日志中展示。
- Pi 扩展拥有用户进程权限；扩展之间的 event bus 不是安全边界，请仅安装可信扩展。

### 通用限制

- Provider 报告是快照，可能落后于实际用量。
- Codex 与 Copilot 端点属于未文档化 provider 接口，可能随 provider 改动而失效。
- 扩展不枚举或切换同一 provider 下的多个账号；账号选择仍由 Pi 或账号管理扩展负责。
- Pi 没有即时账号变更事件；用量认证会在命令、turn 和自动等待复查时重新解析。
- OpenRouter 不会在成功 inference response 中提供可提前读取的请求速率计数器，因此 `/usage` 只报告文档化的 Key 消费字段。
- 其他稍后加载的扩展可重写最终 provider payload，本扩展无法防止任意第三方 payload hook 冲突。

<a id="zh-development"></a>
## 本地开发

```bash
npm install
npm run build
npm run typecheck
npm run check
```

项目结构：

```text
pi-auto-wait/
├── src/
│   ├── usage.ts                 # /usage、缓存、生命周期与状态栏
│   ├── codex-auto-wait.ts       # 5h 自动等待控制器
│   ├── codex-fast-runtime.ts    # /fast、持久化和请求 hook
│   ├── query.ts                 # runtime auth 与 provider 查询
│   ├── settings.ts              # 校验与原子设置写入
│   ├── format.ts                # 详情与状态栏格式化
│   └── providers/               # provider payload 适配器
├── scripts/build-runtime.mjs
├── dist/                         # 构建产物（不手改）
└── README.md
```

`src/` 是唯一权威源码；`dist/` 由 `npm run build` 从 `src/index.ts` 图构建，不能手动编辑。

---

<a id="en"></a>

# pi-auto-wait — English

[中文（默认）](#zh) · **English**

A [Pi](https://pi.dev) extension for provider-usage management. It reads usage for the account Pi is actually using, displays native quota semantics and reset times, toggles Codex Fast mode, and can keep a submitted prompt pending until an exhausted Codex 5-hour window resets.

## Overview

- `/usage`: inspect the active account, refresh it, redeem eligible Codex resets, or explicitly query another configured provider.
- `/fast`: toggle Fast routing for supported official Codex models.
- `/autowait`: toggle automatic waiting for the current Codex 5-hour limit.
- Supported providers: OpenAI Codex, GitHub Copilot, OpenRouter, and OpenCode Go (Zen).
- Provider credentials are sent only to validated official usage origins; custom/proxy credentials fail closed.

## Install

Pi 0.81.0 or newer is required.

```bash
pi install npm:pi-auto-wait
```

Try it without installing permanently:

```bash
pi -e npm:pi-auto-wait
```

For a local checkout:

```bash
npm run build
pi -e ./
```

## Commands

| Command | Purpose |
| --- | --- |
| `/usage` | Opens the interactive usage menu. It accepts no arguments and requires TUI or RPC mode. |
| `/fast` | Toggles Fast mode for the active supported Codex model. |
| `/autowait` | Toggles automatic waiting for an exhausted active Codex 5-hour window. |

The `/usage` menu can refresh the current provider, toggle Fast / automatic wait when relevant, redeem an eligible Codex reset, or explicitly inspect configured providers. Cross-provider queries never replace the active provider's statusline value.

## Automatic Codex 5-hour wait

Automatic wait is off by default. When `codexAutoWait5h` is enabled, Pi performs a forced usage check before starting an agent run:

1. It selects the 5-hour primary bucket for the active Codex model, including a model-specific bucket when the backend returns one.
2. If capacity remains, the submitted prompt continues immediately.
3. If the bucket is exhausted and returns a future `reset_at`, the submitted prompt remains pending. The statusline becomes `codex waiting until …`.
4. At the reset time, Pi waits an extra two seconds, fetches fresh usage again, and continues the original prompt only after capacity is confirmed.
5. If the backend still reports exhaustion after an elapsed reset time, Pi retries the check every 15 seconds.

A model change, reload, session replacement, or shutdown cancels the wait. Missing reset times and usage-query failures fail open: Pi reports the condition and continues rather than inventing a wait duration.

Automatic wait cannot retrospectively retry a provider request that has already returned 429. It protects later submitted prompts by checking before the agent run begins.

## Provider semantics

| Provider | Source | Meaning |
| --- | --- | --- |
| OpenAI Codex | `https://chatgpt.com/backend-api/wham/usage` | ChatGPT subscription windows, resets, credits, earned reset credits, and optional model buckets. |
| GitHub Copilot | `https://api.github.com/copilot_internal/user` | AI Credits, premium requests, or Free chat allowance, depending on the endpoint response. |
| OpenRouter | `https://openrouter.ai/api/v1/key` | Per-key spend / credit limit and usage periods; not a consumer subscription quota. |
| OpenCode Go | `https://opencode.ai/zen/go/v1/usage` | Rolling, weekly, and monthly Zen plan windows. |

## Settings

The settings file is normally `~/.pi/agent/pi-usage.json`:

```json
{
  "codexFastMode": false,
  "codexAutoWait5h": true
}
```

Writes preserve unknown JSON fields, use a private temporary file plus rename, and refuse to overwrite malformed, unsafe, or invalid settings files. Run `/reload` after repairing an invalid file.

## Fast mode

Fast is approximately 1.5× faster and uses more plan allowance. It applies only to official `openai-codex-responses` requests at `https://chatgpt.com` for `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.

## Privacy and limitations

Credential candidates are held only in memory and are never persisted, logged, or displayed. Reports are provider snapshots and can lag behind actual usage. Codex and Copilot usage endpoints are undocumented provider interfaces and may change. The extension does not enumerate or switch accounts within one provider.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run check
```

The authoritative source is `src/`; `dist/` is generated from `src/index.ts` and must not be edited manually.

## License

GPL-3.0-only. See [LICENSE](./LICENSE).
