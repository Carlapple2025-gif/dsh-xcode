# dsh-xcode

一个可安装的 DeepSeek Harness（DSH）Host 插件，让模型直接操作正在运行的 Xcode。

核心不是“再包一层 shell”，而是复用 Apple 官方 **Xcode MCP server**：

- `xcrun mcpbridge`（stdio JSON-RPC）
- `xcrun simctl`（Simulator 生命周期）
- Xcode 27.1 的 `xcode-tools` MCP server

插件只向模型暴露 6 个高层工具，避免把 Xcode MCP 的 54 个原始工具全部塞进上下文。

## 交付物

| 路径 | 说明 |
|---|---|
| [plugin/](plugin/) | DSH bundle；也是实际安装到 `desktop` profile 的包 |
| [plugin/index.js](plugin/index.js) | 插件实现：Xcode MCP 客户端 + 6 个工具 |
| [plugin/scripts/check-schemas.mjs](plugin/scripts/check-schemas.mjs) | 零依赖 schema 冒烟检查 |
| [plugin/README.md](plugin/README.md) | 使用说明、首次授权、限制 |
| [plugin/LICENSE](plugin/LICENSE) | MIT |
| [PUBLISHING.md](PUBLISHING.md) | 打包、发布、安装到其他 profile 的流程 |
| [Fixtures/XcodeAgentDemo/](Fixtures/XcodeAgentDemo/) | 真实 macOS SwiftUI 测试工程，用于端到端验证 |
| [Fixtures/ProjectToolSmoke/](Fixtures/ProjectToolSmoke/) | 由 `xcode_project` 从官方模板创建并构建通过的 smoke 工程 |

## 工具

| 工具 | 能力 |
|---|---|
| `xcode_context` | 状态、列出/打开工作区、查看 scheme/target/destination/test plan、切换当前选择 |
| `xcode_project` | 列出/筛选官方 Xcode 工程模板、查看模板选项、从模板创建并打开 `.xcodeproj` |
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
| `xcode_build` warning schema | 通过；真实 `#warning` 构建返回 warning，不再被 output schema 拒绝（0.1.1） |
| `xcode_build` 编译失败用例 | 通过；返回 `success:false`、1 个 error，包含文件、行号和消息 |
| `xcode_project templates` | 通过；列出 52 个官方工程模板，过滤 macOS/App 后返回 9 个，并显示模板选项 |
| `xcode_project create` | 通过；创建 `ProjectToolSmoke`（SwiftUI + Swift Testing），自动打开 workspace 并构建成功（0.2.0） |
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

现在 6 个工具统一通过 `parameterSchema()` 编译成：

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

公开分发入口：

- npm：[dsh-xcode](https://www.npmjs.com/package/dsh-xcode)（registry 当前为 0.1.0；0.1.1 hotfix 与 0.2.0 的 npm 发布待认证）
- 仓库：https://github.com/Carlapple2025-gif/dsh-xcode
- Release：https://github.com/Carlapple2025-gif/dsh-xcode/releases/tag/v0.2.0
- 直接下载：
  https://github.com/Carlapple2025-gif/dsh-xcode/releases/download/v0.2.0/dsh-xcode-0.2.0.tgz

从 GitHub Release 安装（当前推荐）：

```bash
curl -L -o dsh-xcode-0.2.0.tgz \
  https://github.com/Carlapple2025-gif/dsh-xcode/releases/download/v0.2.0/dsh-xcode-0.2.0.tgz
shasum -a 256 dsh-xcode-0.2.0.tgz
# ce8ab2266f47c8f03eff3ac8bfd3e2363e58267915a4e24cb7108eb49530436c
```

安装到 DSH profile：

```text
plugin_manager install_bundle
  target: /absolute/path/to/dsh-xcode-0.2.0.tgz
```

npm 发布后也可以直接安装：

```text
plugin_manager install_bundle
  target: dsh-xcode@0.2.0
```

当前 `desktop` profile 则以 link 方式安装正式包名，便于开发：

```text
dsh-xcode -> /Users/carl_li/Dev/personal/proj-swift/dsh-xcode/plugin
```

本仓库也可以自行产出 npm tarball：

```bash
cd plugin
npm pack --pack-destination dist
```

完整发布流程见 [PUBLISHING.md](PUBLISHING.md)。

源码修改后，在本会话中把 `include:dsh-xcode` 禁用再启用即可重新注册；本次验证就是这样做的。重启 DSH 后也会重新加载。

## 自行验证

```bash
cd plugin
npm run check
```

会真实加载插件并检查：

- 6 个工具都存在且不重名；
- 每个 `parameters` 都是 `type: "object"` + `properties`；
- `required` 是数组且只引用已声明属性；
- `xcode_build.pattern` 是纯字符串 schema；
- `xcode_build` 的 errors/warnings 允许构建日志的 `task`；
- 输出 schema 可无损序列化。

端到端测试使用 `Fixtures/XcodeAgentDemo`，需要 Xcode 已打开该工程并完成一次 external-agent 授权。

## 使用数据与迭代

真实会话的采集字段、脱敏规则和迭代判断标准见
[docs/usage/README.md](docs/usage/README.md)。原始 session log 和项目相关案例卡默认
只保留在本地，`docs/usage/cases/` 与 `docs/usage/raw/` 已加入 `.gitignore`，避免把
App 源码、路径或业务数据带进公开仓库。

## 第三方 `mcpbridge-wrapper` 说明

`mcpbridge-wrapper` 面向“严格 MCP 客户端与 Xcode 原生桥接之间的兼容层”问题。本插件自带一个最小 stdio 桥接客户端，直接连接官方 `xcrun mcpbridge`，并已在 Xcode 27.1 上完成真实工具调用，因此当前链路不依赖 wrapper。

如果以后改用 DSH 自带的通用 MCP client 去直连 Xcode 的 54 个工具，并遇到 framing / 严格响应校验问题，再考虑把命令替换为 wrapper；当前实现无需额外进程。
