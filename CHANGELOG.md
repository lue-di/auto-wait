# pi-auto-wait

本项目独立发布的 Pi 扩展，基于上游 `@narumitw/pi-usage`（v0.52.3）的用法/配额功能集开发。
历史版本记录见上游仓库 `narumiruna/pi-extensions`。

## 0.1.1

- Codex 5h 自动等待增强：在一次 run 中途触发 Codex usage-limit 429 时，扩展在 `agent_end` 识别该错误，保留已提交的 prompt，等 5h 窗口重置后自动重发并继续（同一耗尽周期内最多 3 次）。

## 0.1.0

- 首个独立发布版本，包名 `pi-auto-wait`。
- 功能集与上游 `@narumitw/pi-usage@0.52.3` 对齐：OpenAI Codex 用量 / 重置 / credits、GitHub Copilot、OpenRouter、OpenCode Zen usage 展示，以及 `/usage` / `/fast` 命令。
- 新增可选的 Codex 5h 限额自动等待：已提交的 prompt 会等待接口返回的重置时间，到期复查可用后继续执行。
- 许可证：GPL-3.0-only。
- 构建与发布流程改为单包形式（去掉 monorepo workspace 与 changesets）。