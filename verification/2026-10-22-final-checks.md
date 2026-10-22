# Final local checks — 2026-10-22

> Superseded for the installed package by `2026-10-22-inject-hotfix.md`
> (`0.1.0-local.1`, Cordis inject fix).

Supersedes the earlier 10-test snapshot in `2026-10-22-local-checks.md` for the
current tree. All commands ran from `D:\Deepseek-Plug\Missher-DSH-Memory-TDAI`
on Windows 11 x64. Temporary directories and synthetic data only; no DSH profile
and no user memory directory were modified.

## Changes since the previous snapshot

- Added `tests/hardening.test.mjs`:
  - unextracted L0 is reloaded after a restart and extracted once;
  - review mode keeps extracted memories as candidates until approval;
  - recall dedupes within a session and caps `maxResults`;
  - a v1 database upgrades in place and keeps its L0 rows.
- Added `tests/client-slot.test.mjs`: the built client bundle loads through
  `window.__ModuleLoader__`, mounts the Remote contribution, and registers the
  `settings.section` with id `memory-tdai`, order 16, label `Memory`.
- Fixed a real migration bug found by the new v1-upgrade test: the
  `l0_extract_idx` index referenced `extracted_at` before the v1 table was
  altered to add that column. The index now runs after the `ALTER TABLE`.
- Corrected stale README claims about the dashboard being "in progress" and
  about L2/L3 injection.

## 1. Typecheck and build

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` (host `tsc` + client esbuild wrapper) | exit 0 |

## 2. Tests

| Runtime | Command | Result |
|---|---|---|
| Node 24.11.1 (system) | `npm test` | 15/15 pass |
| Node 22.19.0 (`npx node@22.19.0`) | `--test tests/*.test.mjs` | 15/15 pass |
| Electron 44.7.0 / Node 24.21.0 / ABI 149 | `ELECTRON_RUN_AS_NODE=1 ... --test tests/*.test.mjs` | 15/15 pass |

The suite now covers: store isolation/Chinese FTS, extraction JSON, runtime
capture/extract/recall, plugin entry + tools + pre-step injection, dashboard
aggregate/contract, offload/readRaw, L2 scene index + L3 persona generation,
opt-in global persona generation/fallback, real Cordis plugin loading, restart
recovery, review mode, session dedupe, v1 schema upgrade, and the client slot
registration.

## 3. Electron ABI 149 store smoke

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\Deepseek-Harness\DeepSeek Harness.exe' scripts/electron-smoke.mjs
```

Observed:

```json
{"ok":true,"node":"24.21.0","electron":"44.7.0","modules":"149","napi":"10","fts":true,"recalled":1}
```

## 4. Package

```powershell
npm pack --pack-destination dist
```

- `dist/missher-dsh-memory-tdai-0.1.0-local.0.tgz`
- 165,448 bytes
- SHA-256 `5666F082EFD311BB328082DC92F201F3E260918A8C7F031412EA612DD901D410`
- 34 files

Tarball install smoke in `_research/tmp/plugin-install-test` (temporary
project, not a DSH profile):

```text
{"name":"memory-tdai","inject":["tools"],"apply":"function","typert":"dsh-memory-tdai","remote":"dsh-memory-tdai","client":true,"clientBytes":801477,"dsh":{"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-locale"]}}}
```

This validates the package layout, exports, and the client entry, not the DSH
plugin-manager installation path.

## Unverified

- Real DSH desktop profile install/uninstall and live Settings-page acceptance.
  This Host Session has no plugin-manager/install tool (`capability_search`
  returned no match), so this step was not performed and no profile file was
  edited.
- Live L3/global persona generation and injection against a real provider; the
  suite uses a mock LLM stream and no provider credentials were used.
- Model-backed extraction against a real provider route.
- macOS and Linux real-machine runs. The CI workflow exists but has not run in
  this environment.
- Vector (`sqlite-vec`) recall; it is installed but not enabled.
- Short-term Mermaid canvas compression, the TCVDB backend, and team sync; not
  implemented in this MVP.
