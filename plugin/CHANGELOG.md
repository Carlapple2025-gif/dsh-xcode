# Changelog

All notable changes to this package are documented here.

## 0.3.0 — 2026-10-28

Release-gate and console fixes.

- `xcode_test` now treats a scheme with no test target as an empty suite:
  `action="all"` returns `success:true`, `counts.total=0`, and a note instead of
  a hard "scheme is not testable" error. `some` handles the same domain error.
- `xcode_run action="stop"` snapshots up to 500 console lines before stopping;
  `action="console"` falls back to that snapshot when Xcode expires the launch
  session.
- `xcode_run` console adds `process` and `subsystem` filters. The process filter
  also matches the process label embedded in OSLog content, which is needed for
  WebKit's `WebContent` noise.
- `xcode_build` adds `configuration`, `clean`, and `destination`. Supplying
  `configuration` or `clean` uses a native `xcodebuild` path with a temp
  DerivedData; normal builds still use Xcode MCP and the active configuration.
- Adds schema regression assertions for the new parameters and output fields.

## 0.2.0 — 2026-10-28

Minimal project creation.

- Adds `xcode_project` with two actions:
  - `templates`: list/filter official Xcode project templates and inspect one
    template's options
  - `create`: create a new `.xcodeproj` from an official template, then open it
- Project creation uses Xcode's official `XcodeListTemplates` and
  `XcodeNewProject` tools; no hand-written `project.pbxproj`.
- Template option metadata is read from Xcode's full template list artifact when
  structured RPC content omits it.
- Verified by creating a macOS SwiftUI app with Swift Testing and building the
  generated project through `xcode_build`.

## 0.1.1 — 2026-10-28

Hotfix for build diagnostics.

- Fixes `xcode_build` output validation when Xcode build-log warnings carry a
  `task` field. `warnings[]` and `errors[]` now declare the optional `task`
  property, so a successful build with warnings no longer fails as an invalid
  tool result.
- Adds a schema regression assertion for `warnings[].task` and
  `errors[].task`.
- Verified with a real `#warning` build: the warning is returned instead of the
  whole result being rejected.

## 0.1.0 — 2026-10-27

Initial public package.

- Adds five model-facing tools: `xcode_context`, `xcode_build`, `xcode_test`,
  `xcode_run`, and `xcode_simulator`.
- Drives Xcode through Apple's official `xcrun mcpbridge` (Xcode MCP) and
  `simctl`; no private Xcode APIs, project-file rewriting, or UI scripting.
- Supports opening workspaces, building, testing, running, console/OSLog
  reading, SwiftUI Preview rendering, LLDB commands, and simulator control.
- Serializes Xcode MCP operations to protect Xcode's single active
  scheme/destination and launch session.
- Registers standard object-rooted JSON Schema for every tool and validates
  schemas at plugin load; includes a dependency-free schema check.
- Verified against Xcode 27.1 (27A9275), Xcode MCP `xcode-tools` 25320,
  protocol `2025-06-18`.
