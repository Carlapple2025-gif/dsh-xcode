# dsh-xcode

一个可安装的 DeepSeek Harness（DSH）Host 插件，让模型直接操作正在运行的 Xcode。

核心不是“再包一层 shell”，而是复用 Apple 官方 **Xcode MCP server**：

- `xcrun mcpbridge`（stdio JSON-RPC）
- `xcrun simctl`（Simulator 生命周期）
- Xcode 27.1 的 `xcode-tools` MCP server

插件只向模型暴露 5 个高层工具，避免把 Xcode MCP 的 54 个原始工具全部塞进上下文。

## 交付物

| 路径 | 说明 |
|---|---|
| [plugin/](plugin/) | DSH bundle；也是实际安装到 `desktop` profile 的包 |
| [plugin/index.js](plugin/index.js) | 插件实现：Xcode MCP 客户端 + 5 个工具 |
| [plugin/scripts/check-schemas.mjs](plugin/scripts/check-schemas.mjs) | 零依赖 schema 冒烟检查 |
| [plugin/README.md](plugin/README.md) | 使用说明、首次授权、限制 |
| [Fixtures/XcodeAgentDemo/](Fixtures/XcodeAgentDemo/) | 真实 macOS SwiftUI 测试工程，用于端到端验证 |

## 工具

| 工具 | 能力 |
|---|---|
| `xcode_context` | 状态、列出/打开工作区、查看 scheme/target/destination/test plan、切换当前选择 |
| `xcode_build` | 构建当前 scheme，返回结构化错误/警告 + 完整日志路径 |
| `xcode_test` | 列出测试、跑全部或指定测试，返回计数与失败详情 |
| `xcode_run` | 构建并运行、停止、读 console、渲染 SwiftUI Preview、执行 LLDB 命令 |
| `xcode_simulator` | `simctl` 列出/启动/关闭模拟器，安装/启动/终止 App，截图，打开 URL |

## 本次实测环境

- macOS 27.0.1
- Xcode **27.1**（Build 27A9275）
- Xcode MCP server：`xcode-tools` **25320**
- MCP 协议：`2025-06-18`
- 测试工作区：`workspace-0zOWH549O7`
- 测试工程：`Fixtures/XcodeAgentDemo/XcodeAgentDemo.xcodeproj`

### 结果

| 检查 | 结果 |
|---|---|
| `xcode_context status` | 通过；读取到 Xcode 版本、MCP server、权限、打开的 workspace |
| `xcode_context open` | 通过；打开真实 `.xcodeproj`，返回 workspace id、scheme、destination |
| `xcode_context inspect` | 通过；1 个 scheme、3 个 target、2 个 destination、1 个 test plan |
| `xcode_context select` | 通过；切到 `Any Mac (arm64)` 再切回 `My Mac`，inspect 结果同步更新 |
| `xcode_build` | 通过；`BUILD SUCCEEDED`（增量 0.5s / 0.2s），返回完整日志路径 |
| `xcode_build` 带 `pattern` | 通过；`pattern` 是纯 `{ "type": "string" }`，未再触发 API 400 |
| `xcode_build` 编译失败用例 | 通过；返回 `success:false`、1 个 error，包含文件、行号和消息 |
| `xcode_test list` | 通过；发现 3 个测试 |
| `xcode_test some` | 通过；`1 passed, 0 failed`，返回 XCTest 结果路径 |
| `xcode_run run` | 通过；App 启动，PID 11003 |
| `xcode_run console` | 通过；读取到 9 条 stdout/stderr/OSLog |
| `xcode_run stop` | 通过；停止 PID 11003 |
| `xcode_run preview` | 通过；渲染出 `ContentView` 216×200 PNG，并已检查图片内容 |
| `xcode_run debug` | 通过；attach debugger 后 `process interrupt` + `bt` 返回真实 LLDB 调用栈 |
| 并行 `status` + `build` | 通过；MCP 操作在插件内串行，未再出现 bridge 超时 |
| `xcode_simulator list` | 通过；本机未安装 Simulator runtime，返回空列表和安装提示 |

结论：**Xcode 27.1 与官方 `xcrun mcpbridge` 在本插件链路中兼容**，构建、测试、运行、console、Preview 都已实际跑通。

## 关键修复：工具 schema 必须是标准 JSON Schema

DeepSeek API 会把 `ctx.tools.register` 的 `parameters` 原样当作 function parameters schema 校验。之前写成“属性表”：

```js
parameters: {
  pattern: { type: 'string', description: '...' }
}
```

会被当成 JSON Schema 根，`pattern` 变成关键字而非属性，API 返回：

```text
Invalid schema for function 'xcode_build':
{"type":"string","description":"..."} is not of type "string"
```

现在 5 个工具统一通过 `parameterSchema()` 编译成：

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string" }
  },
  "required": ["action"]
}
```

`xcode_build.pattern` 按你的要求精简成了最直接的 `{ "type": "string" }`，不再带 description。注册前 `assertToolSchema()` 会做结构自检；schema 再退化时插件会在加载期失败，而不是让每个 turn 都 400。

`xcode_build.pattern` 的修复位置：[plugin/index.js](plugin/index.js) 的 `makeBuildTool`。

## 安装与重载

当前 `desktop` profile 已通过 `plugin_manager` 以 link 方式安装：

```text
@local/dsh-xcode -> /Users/carl_li/Dev/personal/proj-swift/dsh-xcode/plugin
```

源码修改后，在本会话中把 `include:dsh-xcode` 禁用再启用即可重新注册；本次验证就是这样做的。重启 DSH 后也会重新加载。

## 自行验证

```bash
cd plugin
npm run check
```

会真实加载插件并检查：

- 5 个工具都存在且不重名；
- 每个 `parameters` 都是 `type: "object"` + `properties`；
- `required` 是数组且只引用已声明属性；
- `xcode_build.pattern` 是纯字符串 schema；
- 输出 schema 可无损序列化。

端到端测试使用 `Fixtures/XcodeAgentDemo`，需要 Xcode 已打开该工程并完成一次 external-agent 授权。

## 第三方 `mcpbridge-wrapper` 说明

`mcpbridge-wrapper` 面向“严格 MCP 客户端与 Xcode 原生桥接之间的兼容层”问题。本插件自带一个最小 stdio 桥接客户端，直接连接官方 `xcrun mcpbridge`，并已在 Xcode 27.1 上完成真实工具调用，因此当前链路不依赖 wrapper。

如果以后改用 DSH 自带的通用 MCP client 去直连 Xcode 的 54 个工具，并遇到 framing / 严格响应校验问题，再考虑把命令替换为 wrapper；当前实现无需额外进程。
