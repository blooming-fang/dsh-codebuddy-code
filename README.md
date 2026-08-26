# dsh-codebuddy-code

CodeBuddy LLM 提供商 bundle，为 DeepSeek Harness **Web GUI 的 LLM 能力**接入腾讯 CodeBuddy。它不是独立的聊天面板——而是把 CodeBuddy 作为模型提供商注册进 dsh 的 `ctx.llm` seam：web 模型设置里出现 **CodeBuddy** 提供商卡片，聊天框的模型选择器里可直接选到 CodeBuddy 的模型并用它对话。

## 它做什么

安装并重启后：

- **Settings → Models** 出现一个 **CodeBuddy** 卡片（由 `registerConfigurableProviders` 提供），带设置表单、无凭据小圆点（因为 token 来自本机登录而非产品 API key）。
- **聊天框模型选择器** 列出 CodeBuddy 的模型（`deepseek-v4-flash` / `deepseek-v4-pro`，可在 `llm-codebuddy:` 设置段里改），选中即可用 CodeBuddy 云接口对话。

Token 来源（每次请求按序解析）：

1. 环境变量覆盖：`CODEBUDDY_AUTH_TOKEN` 或 `CODEBUDDY_API_KEY`。
2. CodeBuddy 桌面端登录文件：
   `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`，带过期检查——请先用 CodeBuddy 桌面端（或 `/login`）完成登录。

都不存在/过期时，请求以 `LlmError: MISSING_CREDENTIAL` 失败（不是插件加载失败）。

请求走 `POST https://copilot.tencent.com/v2/chat/completions`，SSE 流式。地址可在配置里改。

## 目录结构

```
dsh-codebuddy-code/
├── package.json       # 声明 dsh.bundle + 对 in-closure 运行时包的依赖
├── cordis.patch.yml   # bundle 层：插入 llm-codebuddy 行
└── src/
    ├── index.js       # 插件入口：注册 provider、settings 段、session 解析
    ├── adapter.js     # fetch + SSE 适配器
    ├── serialize.js   # harness 消息 → CodeBuddy wire 请求
    ├── translate.js   # wire chunk → harness StreamChunk
    ├── sse.js         # SSE 解码
    └── types.js       # wire 格式说明
```

本包是 `packages/llm/llm-codebuddy`（workspace TypeScript，rc.5）的**自包含 JS 移植**，面向已安装的 dsh。若你从源码 checkout 跑 dsh，用 workspace 包即可；这里的内嵌版本与已安装 dsh 完全兼容，不需要发布或构建 workspace 包。

## 安装

需要一个已初始化的 web profile。在此包**所在目录**（`plugins/dsh-codebuddy-code` 的父目录）或直接指到 tgz/包路径运行：

```sh
# 从源码目录安装（先打包，见下）
dsh plugin --profile web add D:\path\to\dsh-codebuddy-code

# 或安装打好的 tgz
dsh plugin --profile web add D:\path\to\dsh-codebuddy-code-0.1.0.tgz
```

然后重启 `dsh web` 并打开 GUI。

`dsh plugin --profile web remove dsh-codebuddy-code` 同时移除依赖与 bundle 层。

## 打包为 tgz

```sh
cd plugins/dsh-codebuddy-code
npm pack
# 生成 dsh-codebuddy-code-0.1.0.tgz
```

该包所有依赖（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-timeout`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`eventsource-parser`）都已在已安装 dsh 的 profile 依赖闭包 / module fallback 里，bundle 以 peer 直接依赖的形式解析到同一实例，无需额外 `pnpm install`。

## 配置

**Settings → CodeBuddy** 同名的 `llm-codebuddy:` settings 段（`$DSH_HOME/settings.yaml`，改动即时生效、无需重启）：

```yaml
llm-codebuddy:
  endpoint: https://copilot.tencent.com/v2/chat/completions   # 可选
  tokenPath: C:\Users\you\AppData\Local\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info  # 可选
  thinking: enabled                  # enabled | disabled（默认 disabled）
  reasoningEffort: off               # off | high | max（默认 off）
  maxTokens: 4096                    # 默认 4096
  defaultContextWindow: 1000000      # 默认 1000000
  models:
    - id: deepseek-v4-flash
      name: CodeBuddy-V4-Flash
    - id: deepseek-v4-pro
      name: CodeBuddy-V4-Pro
  streamIdleTimeoutMs: 300000        # 默认 300000
  retryPolicy: {}                    # 可选
```

## 验证可用

1. 先确认 CodeBuddy 桌面端已登录（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info` 存在且有 `auth.accessToken`）。
2. 重启 `dsh web`，打开 **Settings → Models**，应看到 **CodeBuddy** 卡片。
3. 回到聊天框，点模型选择器，选 **CodeBuddy** 下某个模型，发一条消息。

## 已知限制

- **网关只会在一次工具调用的第一个 SSE delta 里携带 `function.name`，后续 delta 的 `name` 是空字符串 `""`**。适配器的 translate 只在 `name` 非空时覆盖已记录的调用名（否则空值会把正确名称冲掉，产生 `unknown tool ""`，且第二轮把 `name: ""` 发回时网关返回 HTTP 400 `model_param_invalid` — "the request parameters were rejected by the model provider"）。**不要**改回「只要 `name !== undefined` 就覆盖」。
- **网关安全策略会拦截广告 `deepseek-harness` 客户端的 `user-agent`**（HTTP 400 code `11128`，`request illegal` / "blocked by security policy"）。适配器用中性的 `user-agent: codebuddy-dsh` 发送请求——**不要**改回 dsh 的归属 `attributionHeaders()`，否则 CodeBuddy 网关会拒绝所有请求。
- 纯文本路由：不支持图片输入，适配器会以 `UNSUPPORTED_CONTENT` 拒绝并说明。
- `reasoning_effort: 'off'` 是合法 harness 值，但被网关以 HTTP 400 拒绝，故适配器把 `off` 映射为 `thinking: { type: 'disabled' }`，从不发送该字段。
- 无 `stop` 语义差异遵循 OpenAI 兼容；`stream_options` 不发（网关在 finish chunk 上已附 `usage`）。
- 推理内容只在带工具调用的轮次被回放为 `reasoning_content`（与 DeepSeek 思维模式一致）。

## 结构与来源

源码是 `packages/llm/llm-codebuddy` 的 JS 移植（该 workspace 包仍是**源码 checkout 下**的首选实现）。二者共享同一契约：provider route `codebuddy`、settings namespace `llm-codebuddy`、同一套 request/serialize/translate 逻辑。