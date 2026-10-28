# Validation coverage — 2026-10-28

Five independent validation sessions after v0.2.0. Each was a separate task;
the final "write a case card" turn is part of the same case.

## Matrix

| Surface | Result | Evidence | Decision |
|---|---|---|---|
| `xcode_project` create (macOS) | **pass** | PulseTimer; no hand-written pbxproj | validated |
| `xcode_build` | **pass** | 4/4 builds; warning probe returned warning | validated |
| Warning schema hotfix | **pass** | default severity returned 1 warning, no schema error | validated |
| Preview | **pass** | 2 final states rendered | validated |
| `xcode_test` (macOS) | **pass** | probe: 6 calls, 12 runs, final 5/5; real app: 6/6 after P1 | validated |
| `xcode_run` non-preview | **partial** | real app launch + console pass; debugger not covered | collect debugger |
| Clean / Release configuration / analyze | **unsupported** | plugin has no clean/configuration/analyze; CLI used | candidate |
| Real-app release audit | **partial** | P1 test target + notification fixed; P2 CI/privacy/version added; P0 signing blocked | app work, not plugin |
| CI / privacy / version | **pass** | CI green on Xcode 26.6; PrivacyInfo in bundle; app=plugin=0.2.3, schema 1 | app release hygiene |
| `xcode_simulator` end-to-end | **blocked** | zero runtimes; list empty, rest domain errors | environment |
| Swift Package input | **unsupported** | 6/7 xcode_* calls rejected at validation layer | candidate |
| Archive / export / signing | **blocked + shell-only** | no identity/team; no plugin tools | candidate |
| Multi-workspace selection | **observed** | inspect with `path` failed; workspace id worked | UX polish |

## Findings

### Positive

- `xcode_project` removed the hand-written `project.pbxproj` gap for a real
  macOS SwiftUI app.
- The warning schema fix held in a real default-severity build.
- `xcode_test` executed real macOS tests, including a deliberate failure and a
  clean rerun.
- Project creation and normal build were performed by the plugin, not shell.

### Candidates

1. **Swift Package support** — one independent case; plugin rejects package
   directories/Package.swift before Xcode. Needs a second case or a product
   decision.
2. **Archive/export/signing** — one case, blocked by missing signing identity;
   plugin has no archive/export/signing-status tools. Needs signing environment
   and certificate-handling policy.
3. **Simulator preflight** — no runtime; return a structured blocked result
   instead of raw `exit 148` chain.
4. **Project template UX** — reject reserved option keys (`productName`,
   `bundleIdentifierPrefix`), accept `path` alias for inspect, clarify
   `nameFilter` vs `platform` filter.
5. **Stale `xcode_test list`** — first list returned 3 cached tests; after
   `xcode_build buildForTesting` it returned the correct 5. Add a refresh hint.

### Real-project audit

- A real macOS menu-bar app confirmed `xcode_build`/`xcode_run` (launch + console)
  and `xcode_test` (6/6 after adding a test target).
- The same audit found missing `clean`, Release configuration, `analyze`,
  `archive`/`export`/signing-status, and console filtering/arguments.
- P1 test target + notification state were fixed in the app; P0 Developer ID
  signing and notarization remain blocked by credentials.
- CI, `PrivacyInfo.xcprivacy`, and version checks were added to the app repo;
  these are app hygiene, not dsh-xcode capabilities. CI is green on a hosted
  Xcode 26.6 runner after guarding a 27-only glass API.

### Negative controls

- macOS simulator work is not evidence for simulator quality.
- A successful Preview is not evidence for real-window composition.
- A project-creation success is not evidence for test/run/archive.

## Next data targets

1. `xcode_run` debugger (and post-stop console retention) on a real macOS app.
2. A second Swift Package project, to confirm the unsupported-input pattern.
3. Simulator after a runtime is installed, if that becomes a supported setup.
4. Archive/export with a real development team, if the user wants that path.
5. A second greenfield project using `xcode_project` to confirm repeatability.
6. `clean` / Release configuration / analyze as a candidate plugin batch.
