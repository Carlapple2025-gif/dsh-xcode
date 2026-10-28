# Xcode Pilot

DSH Host 插件：让模型直接操作正在运行的 Xcode。底层使用 Apple 官方接口，不修改 `project.pbxproj`，也不依赖 UI 脚本。

## 能力

| 工具 | 能做什么 |
|---|---|
| `xcode_context` | 查看 Xcode/MCP/权限状态；列出、打开工作区；查看 scheme、target、run destination、test plan；切换当前 scheme / destination / test plan |
| `xcode_project` | 列出/筛选官方 Xcode 工程模板，查看模板选项；从模板创建 `.xcodeproj` 并自动打开 |
| `xcode_build` | 用 Xcode 构建当前 scheme；可选 `configuration` / `clean` / `destination`（native xcodebuild），返回结构化错误/警告和完整日志路径 |
| `xcode_test` | 列出测试；运行全部或指定测试；无 test target 时返回 0 用例而不是硬错误 |
| `xcode_run` | 运行/停止 App；console 支持 process/subsystem 过滤，stop 前缓存最后 500 行；渲染 `#Preview`；执行 LLDB 命令 |
| `xcode_simulator` | 用 `simctl` 列出、启动、关闭模拟器，安装/启动/终止 App，截图，打开 URL |

模型只看到 6 个高层工具，而不是 Xcode MCP 的 54 个原始工具，减少上下文占用。

## 安装

包名：`dsh-xcode`。发布到 npm 后：

```text
plugin_manager install_bundle
  target: dsh-xcode@0.3.0
```

从 GitHub Release tarball 安装：

```text
plugin_manager install_bundle
  target: /absolute/path/to/dist/dsh-xcode-0.3.0.tgz
```

本地开发时可以直接 link 包目录：

```text
plugin_manager install_bundle
  target: /absolute/path/to/dsh-xcode/plugin
```

安装后调用 `xcode_context`（`action: "status"`）确认 Xcode MCP 连接正常。

## 依赖

- macOS + Xcode 26.3 或更高版本（本机验证：Xcode 27.1 / 27A9275）
- Xcode 已启用：**Xcode > Settings > Intelligence > Allow external agents to use Xcode tools**
- 至少打开一个 `.xcodeproj` 或 `.xcworkspace`
- 模拟器功能需要安装对应的 Simulator runtime
- DSH profile 已有 `tools` 与 `subprocess` 服务（Desktop profile 默认具备）

## 首次使用

1. 在 Xcode 中打开项目，或在 DSH 里调用：
   `xcode_context` → `action: "open"` → `path: "/abs/path/App.xcodeproj"`
2. Xcode 会弹出授权提示；选择允许，并允许访问项目所在文件夹。
3. 再调用 `xcode_context` → `action: "inspect"` 确认当前 scheme 和 destination。
4. 之后即可 `xcode_build` / `xcode_test` / `xcode_run`。

首次授权是按 Agent 和文件夹记录的。升级 Xcode、移动项目目录或更换运行 DSH 的二进制后，可能需要重新授权。

## 示例

```text
帮我看看这个项目有哪些 scheme，选 XcodeAgentDemo，然后在 My Mac 上构建。
```

```text
构建失败的话，把错误按文件和行号整理出来，直接修掉，再重新构建。
```

```text
在 My Mac 上运行 App，等 2 秒，读取控制台里最近的错误，然后停止。
```

```text
把 ContentView 的第一个 SwiftUI Preview 渲染成图片，路径发我。
```

```text
列出可用模拟器；启动 iPhone 17；安装并启动刚构建的 App。
```

## 架构

```
DSH model
  └─ xcode_* tools
       ├─ XcodeMCP: one persistent `xcrun mcpbridge` child
       │    └─ Apple Xcode MCP server (JSON-RPC over stdio)
       │         └─ Xcode: open workspace, build, test, run, console, preview, LLDB
       └─ subprocess: `xcrun simctl ...` for Simulator management
```

- Xcode MCP 工具调用使用官方 `tools/call` 协议；本插件只做白名单和结果整形。
- 所有走 MCP 的工具在插件内串行执行。Xcode 的 active scheme/destination、构建流和 launch session 都是单实例状态；串行队列避免并行 `status`/`build` 让官方 bridge 丢失关联响应（实测并发时会 60s 超时，加入队列后通过）。
- `xcodebuild -version` 仅用于状态展示；普通构建/测试/运行交给 Xcode MCP，确保使用 Xcode 当前 scheme、destination 和测试计划。
- 显式传 `xcode_build.configuration` 或 `clean` 时改用 native `xcodebuild`，DerivedData 放在系统临时目录；这是为了支持 Release/全量构建，不改变普通构建路径。
- `simctl` 用于模拟器生命周期；Xcode 的 Run 按钮流程仍由 `xcode_run` 负责。
- `xcode_run action="preview"` 接受绝对路径；插件会把它换算成 Xcode 工程内相对路径（例如 `XcodeAgentDemo/ContentView.swift`），再交给 `RenderPreview`。
- 工具输出有上限，完整构建日志/测试结果保留在 Xcode 返回的路径中。
- 工具参数注册为标准 JSON Schema（`type: "object"` + `properties` + `required` 数组）。注册前会做结构自检：如果 schema 非法，插件直接加载失败，而不是让 DeepSeek API 在每一轮请求里返回 400 `Invalid schema for function`。

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_XCODE_XCRUN` | `/usr/bin/xcrun` | 自定义 xcrun 路径 |
| `DSH_XCODE_START_TIMEOUT_MS` | `45000` | MCP 初始化超时 |
| `DSH_XCODE_BUILD_TIMEOUT_MS` | `1800000` | 单次构建超时 |
| `DSH_XCODE_TEST_TIMEOUT_MS` | `1800000` | 单次测试超时 |
| `DSH_XCODE_RUN_TIMEOUT_MS` | `600000` | 运行/预览超时 |

## 安全与限制

- `xcode_run action="debug"` 会在 App 进程内执行 LLDB 命令；`xcode_simulator` 的安装/启动/终止会改变模拟器状态。这些操作都会出现在 DSH 的工具调用记录中。
- 构建、测试、运行都作用于 Xcode **当前激活**的 workspace / scheme / destination；多工作区时显式传 `workspace`。
- Xcode 关闭或 MCP 未授权时，工具返回可操作的错误提示，不会静默成功。
- 模拟器截图默认写到系统临时目录；需要长期保存时传绝对 `outputPath`。
- 没有安装 Simulator runtime 时，`xcode_simulator list` 会返回空列表和安装提示；macOS 目标仍可正常构建/运行。

## 验证

### Xcode 27.1 兼容性

已在本机实际验证：

- Xcode 27.1（27A9275）
- Apple Xcode MCP `xcode-tools` 25320，协议 `2025-06-18`
- `xcrun mcpbridge` 可直接完成 open / build / test / run / console / preview / debug
- 测试工程：`Fixtures/XcodeAgentDemo/XcodeAgentDemo.xcodeproj`

具体结果见根目录 [README.md](../README.md#本次实测环境)。当前实现不需要 `mcpbridge-wrapper`；它直接使用官方 bridge，并自己处理 stdio framing 与请求关联。

### schema 冒烟检查

插件自带一条零依赖检查：用 stub context 真正加载插件，断言 6 个工具注册出去的 JSON Schema。

```bash
cd plugin && npm run check      # 等价于 node scripts/check-schemas.mjs
```

检查内容：

- 工具名集合（`context` / `project` / `build` / `test` / `run` / `simulator`，不重名，不占用 `run_code`）；
- 参数根必须是 `type: "object"` + `properties`，属性表形式直接失败；
- `required` 必须是数组、只引用已声明的属性、不重复；`action` 必填的工具固定为 `["action"]`；
- `xcode_build.pattern` 是纯 `{ "type": "string" }`，不携带描述或嵌套对象；
- `xcode_build` 的 errors/warnings 必须允许构建日志的 `task` 字段；
- 关键字类型与位置符合 DSH 的 enforced subset（`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` + 注解）；
- 每个工具都有非空 `description`；schema 可无损 JSON 序列化，注解（`description`/`title`）类型正确。

失败时以非零码退出并指出具体工具与路径；这条脚本守住的就是“schema 退化成属性表 → 每个 turn 400”这个回归。

## License

MIT © 2026 Carl. See [LICENSE](LICENSE).
