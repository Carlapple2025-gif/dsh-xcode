# Usage cases

See [coverage.md](coverage.md) for the current validation matrix and remaining
uncovered surfaces.

This directory keeps **real field traces** of `dsh-xcode` in use. Its purpose is
to preserve evidence for future iteration without committing private project
data.

## What counts

A useful case is a real task with a verifiable outcome, not a synthetic smoke
test. Capture:

- the project type and environment
- the user goal and final acceptance
- the sequence of Xcode tool calls
- build/test/run failures, retries, and recoveries
- manual workarounds and permission friction
- wall time, token usage, and tool time
- artifact-path or output-quality problems

This is qualitative evidence. One case can reveal a missing capability; it
cannot establish a success rate.

## Storage rules

| Data | Location | Committed? |
|---|---|---|
| Raw session log (`.jsonl.zstd`) | local DSH storage / secure disk | **No** |
| Project source, screenshots, credentials | outside this repo | **No** |
| Project-specific case card | `docs/usage/cases/` | **No by default** (gitignored) |
| Sanitized, shareable case card | `docs/usage/cases-public/` | Yes, after review |
| Case template and method | this directory | Yes |

Raw traces can contain source code, local paths, business data, and tool output.
Do not commit them. Copy only the fields needed for a case card.

## Case card fields

Start from [case-template.md](case-template.md). Minimum fields:

- date, DSH version, plugin version, Xcode/macOS version
- project shape: app/package, targets, schemes, destinations
- task and acceptance criteria
- tool usage counts, especially `xcode_context` / `build` / `test` / `run` / `simulator`
- build/test/run outcomes and retries
- human interventions and workarounds
- failure taxonomy and evidence
- candidate iteration items with severity
- what was not exercised

## Metrics to derive

| Metric | Definition |
|---|---|
| Task success | The user's acceptance criterion was met |
| Build pass rate | Successful builds / all `xcode_build` calls |
| Retry count | Repeated same tool/action after a failure |
| Tool error rate | Tool results with `isError: true` / all calls |
| Human interventions | Prompts, manual Xcode steps, shell fallbacks |
| Wall time | First event to `turn/end` |
| Tool time | Sum of tool/job durations |
| Artifact friction | Path mistakes, missing previews, unreadable results |

`xcode_build` returning `success:false` is a normal result, not a tool error.
Track those separately.

## Attribute every failure

Keep four failure layers separate; otherwise the plugin gets blamed for
infrastructure noise:

| Layer | Examples | Plugin iteration? |
|---|---|---|
| Plugin | wrong action, missing capability, bad schema, misleading output | yes |
| Xcode / project | App compile error, signing, missing SDK/runtime | usually no |
| DSH core | file read-before-write policy, transport failure, approval flow | no, report separately |
| Model | wrong tool choice, path copied incorrectly, malformed code | no, prompt/tool-description tuning |

A build that returns `success:false` with a compiler error is Xcode/project data,
not a plugin failure.

## Seeded / continuation sessions

A session with `isSeeded: true` or `parentSession` is a continuation of an
existing project. It is valuable for observing follow-up friction, but it is
**not a new independent case** for frequency counting.

Count only the new turns (events after the seed) and keep the parent case link.
The same project refactored twice must not inflate the evidence for a candidate
iteration.

## Safety boundary

Record whether the task crossed a public-API boundary:

- private frameworks or undocumented system services
- Accessibility control of other apps
- entitlements or system privacy permissions
- login items, background services, or persistent modifications
- App Store / notarization implications

A successful build and screenshot do not make a private-API solution safe or
shippable. The DSH approval policy may not gate a code-level decision to call a
private framework; if no approval event exists, state that explicitly.

This is usually an agent/product-policy finding, not a dsh-xcode iteration item.

## Visual verification

SwiftUI Preview is component-level evidence. It does not prove how a view
composes with the real window, menu bar, notch, or other apps.

Record the actual verification method:

- Preview snapshot only
- rendered app window screenshot
- full-screen capture including system chrome
- user acceptance / correction

If the user later reports a visual gap after a successful Preview, that is a
verification-method gap, not automatically a plugin bug. Capture the real-window
step before changing the plugin.

## Negative controls

A successful case with light Xcode usage is a **negative control**. Record it,
but do not use it to justify new capabilities.

Examples:

- a single incremental `xcode_build` on an existing project
- an icon/asset task with no project or build changes
- a task that never calls `xcode_run`, `xcode_test`, or `xcode_simulator`

Say what the case does **not** prove. This prevents a successful one-off from
turning into speculative scope.

## When to iterate

Do not change the plugin for every one-off project need. Use this order:

1. **Correctness or safety**: wrong result, silent failure, lost data — fix now.
2. **Repeated blocker**: the same friction in two or more real cases — prioritize.
3. **High-cost one-off**: one case with major manual work — record, investigate.
4. **Project-specific preference**: record and wait.

Use `severity × frequency × workaround cost` to rank candidates. Keep a
candidate list in the case card; only promote it to a design task when the
evidence is strong enough.

## Code Mode caveat

If the session used Code Mode / PTC, Xcode calls may be nested inside a
`run_code` call instead of appearing as top-level `tool/call` events. Parse the
code and its result; do not assume the absence of `xcode_build` means the tool
was not used.

## Review before sharing

Before moving a case to `cases-public/`:

- remove app names if they are not public
- remove source code, business logic, user names, local paths, tokens
- keep only counts, categories, sanitized error messages, and outcome
- state the evidence strength and what was not tested
