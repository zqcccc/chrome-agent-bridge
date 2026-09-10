# AGENTS.md — Agent Browser Bridge 开发规范

本文件给在本仓库内工作的 Agent 开发者阅读，尤其是**修改 `skills/agent-browser-bridge/` 下的任何 skill 时**必须遵守。

## 最重要的规则：Skill 必须自包含

`skills/agent-browser-bridge/` 会被**其他 Agent 以链接 / 拷贝方式引用**，对方只能拿到 skill 目录本身（`SKILL.md`、`xhs/`、`debug/`、`scripts/`），**拿不到仓库根的文件**（`agent/`、`extension/`、`relay/` 等）。

因此编写 / 修改任何 skill 文档时：

1. **关键代码直接贴进文档**：RPC 调用示例、JS 表达式、返回数据格式、选择器，都要在 `SKILL.md` 里给出可复制的内容，而不是"见 `agent/cli.mjs`"或"参考 `extension/background.js`"。
2. **引用的文件必须位于 skill 目录内**：文档里出现"读取 xxx 脚本 / 工具"时，该文件必须放在 `skills/agent-browser-bridge/scripts/` 下（scripts/ 是 skill 的一部分，会随 skill 一起被链接），且文档要贴出核心用法与参数。
3. **禁止依赖仓库根文件**：不要把 `agent/cli.mjs`、`extension/*` 等仓库根文件当作唯一入口或必读文件。CLI 命令可以出现，但必须标注为"本机仓库的便利命令"，同时给出**等价的 RPC 代码示例**作为自包含路径。
4. **禁止机器特定绝对路径**：不写 `/Users/<user>/...` 之类路径。skill 内文件的路径用相对 skill 目录的写法（如 `scripts/browser-debug.mjs`）；仓库根的路径用占位符（如 `<chrome-agent-bridge 仓库根>`）。
5. **新增能力时：插件实现 + skill 文档双写**：给插件新增 RPC（如 `page.inspect`）时，skill 文档必须包含——调用方式（RPC / HTTP）、参数表、返回结构示例、一个最小可用示例。写完自检：**假设对方只有 skill 目录，能否照文档独立完成操作？** 不能，就补代码。

## 其他开发规范

- 改 `extension/` 或 `agent/` 后，需用户到 `chrome://extensions` 刷新扩展才能生效；skill 文档要标注版本要求，并提供旧版兜底方案。
- 修改 skill 时保持按需加载结构：站点专项 / 通用能力拆成子 skill（如 `xhs/`、`debug/`），不把全部内容堆进根 `SKILL.md`。
- 实测踩坑写回对应子 skill 或 `KNOWN_ISSUES.md`，避免下个 Agent 重踩。
- 文档中所有命令给出后，用 `node --check` / 实跑验证过再写；"凭印象写命令"视为缺陷。
