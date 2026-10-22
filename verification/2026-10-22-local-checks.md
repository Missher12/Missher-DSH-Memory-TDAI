# Local checks — 2026-10-22

> Historical snapshot (10-test baseline). See `2026-10-22-final-checks.md` for
> the current 15-test tree and the v1 schema-upgrade fix.

All commands ran from `D:\Deepseek-Plug\Missher-DSH-Memory-TDAI` on Windows 11 x64.
Synthetic data and temporary directories only; no real profile was modified.

## 1. Install / build

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` (host `tsc` + client esbuild wrapper) | exit 0 |
| client bundle syntax check (`new Function`) | ok, 798,3xx bytes |

## 2. Tests

| Runtime | Command | Result |
|---|---|---|
| Node 24.11.1 (system) | `npm test` | 10/10 pass |
| Node 22.19.0 (`npx node@22.19.0`) | `npx node@22.19.0 --test tests/*.test.mjs` | 10/10 pass |

Covered: store isolation/Chinese FTS, extraction JSON, runtime capture/extract/recall,
plugin entry + tools + pre-step injection, dashboard aggregate/contract, offload/readRaw,
L2 scene index + L3 persona generation, opt-in global persona generation/fallback, and
loading the bundle as a real Cordis plugin with injected `tools`, `llm`, `sessions`,
`systemPrompt`, and `dshHomePath` services.

### Cordis plugin load

`tests/cordis-load.test.mjs` creates a real `Context` from
`@deepseek-ai/cordis`, provides mock Host services, loads the package through
`ctx.plugin({ name, inject, apply })`, and verifies 6 tools register, an L1 pass
runs, and `agent/pre-step` injects the recalled memory.

The same test was executed under the DSH Electron runtime:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\Deepseek-Harness\DeepSeek Harness.exe' --test tests/cordis-load.test.mjs
```

Result: 1/1 pass. This is stronger than a plain `apply(mockCtx)` test but still
uses synthetic Host services, not the real DSH profile.


## 3. Electron / DSH runtime

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\Deepseek-Harness\DeepSeek Harness.exe' scripts/electron-smoke.mjs
```

Observed:

```json
{"ok":true,"node":"24.21.0","electron":"44.7.0","modules":"149","napi":"10","fts":true,"recalled":1}
```

This proves the store and recall path load in the DSH Electron Node runtime. It is
not a real profile install and does not prove the Settings page is served.

## 4. Client bundle slot smoke

The built `lib/client/index.js` was evaluated with a `window.__ModuleLoader__`
stub. `apply()` mounted the Remote contribution and registered
`settings.section` with `id: "memory-tdai"`, `order: 16`.

## 5. Package

`npm pack --dry-run`: 34 files, ~163.6 kB tarball, includes `lib/index.js`,
`lib/typert.host.js`, `lib/typert.remote-client.js`, and `lib/client/index.js`.

Actual tarball:

- `dist/missher-dsh-memory-tdai-0.1.0-local.0.tgz`
- SHA-256 `FF4251B5C2ECC01DCF617379E591632EE829F46EDD334F10F0A131BD25336CDB`

Tarball install smoke (temporary project, not a DSH profile):

```text
npm install <tarball> @deepseek-ai/dsh-typert-protocol@0.2.1-rc.2 @deepseek-ai/cordis@4.0.5
import { apply, inject, name } from '@missher/dsh-memory-tdai'
import typert from '@missher/dsh-memory-tdai/typert'
import remote from '@missher/dsh-memory-tdai/remote'
import client from '@missher/dsh-memory-tdai/client'
```

Result: `apply` function, `inject: ["tools"]`, `typert.package` and
`remote.package` resolve to `dsh-memory-tdai`, and the client entry exists
(801,477 bytes). This validates package layout and exports, not the DSH
plugin-manager installation path.

## 6. Visual check

`preview/dashboard.png` is a static render of the real `Dashboard` component with
synthetic data. The page shows counters, provenance, heatmap, review queue,
recent memories, L2 scene chips, L3 project/global profile actions, behavior
controls, and export. It is a layout check, not proof that DSH serves it in a
real installation.

## Unverified

- Real DSH profile install / uninstall and Settings-page rendering.
- macOS and Linux runs (CI workflow exists but has not run here).
- Live L3/global persona generation and injection against a real provider; tests use a mock LLM.
- Vector (sqlite-vec) recall; it is installed but not enabled in this MVP.
- Model-backed extraction against a real provider route; tests use a mock LLM.
