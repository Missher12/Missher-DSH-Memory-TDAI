# Cordis inject hotfix — 2026-10-22

## Symptom

After installing `@missher/dsh-memory-tdai` into the live desktop profile, the
Host warned:

```text
dsh: warning: 1 entry did not activate memory-tdai (@missher/dsh-memory-tdai):
Error: cannot get property "systemPrompt" without inject
```

## Root cause

The plugin declares `inject = ['tools']` and treats every other Host service as
optional. But `systemPromptOf()` read `ctx.systemPrompt` directly, and
`MemoryRuntime` read `ctx.llm` / `ctx.sessions` directly as a fast path. A real
Cordis fiber throws on direct access to a service that was not injected; the
in-repo plain-object mocks did not reproduce that guard.

## Fix

- `systemPromptOf()` reads `ctx.get('systemPrompt')` first; the direct read is
  only a guarded fallback for plain test contexts.
- `llmOf()` / `sessionsOf()` read `ctx.get('llm')` / `ctx.get('sessions')`
  first, with the same guarded fallback.
- `inject` remains `['tools']`; the plugin still loads when optional services
  are absent.
- Added `tests/inject-guard.test.mjs`: a context whose direct
  `systemPrompt`/`llm`/`sessions` properties throw the Cordis error but whose
  `ctx.get()` returns the services. The test drives apply, capture, extraction,
  and recall through that context.
- Bumped the package to `0.1.0-local.1`.

## Checks

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` (Node 24.11.1) | 16/16 pass, duration_ms 2677.9 |
| `npx node@22.19.0 --test tests/*.test.mjs` | 16/16 pass, duration_ms 2678.1 |
| Electron 44.7.0 / Node 24.21.0 / ABI 149 full suite | 16/16 pass, duration_ms 2661.2 |
| Electron store smoke | `{"ok":true,"node":"24.21.0","electron":"44.7.0","modules":"149","napi":"10","fts":true,"recalled":1}` |
| tarball install smoke (`0.1.0-local.1`) | package exports and client entry load |

## Package

- `dist/missher-dsh-memory-tdai-0.1.0-local.1.tgz`
- 165,746 bytes
- SHA-256 `30F759F48660B1B0B6F5A7A7EE11A4E0F06B2322FAC5750F56F79345263E93FE`

## Live-profile hotfix

The already-installed copy at
`C:\Users\Missher-R2\.dsh\profiles\desktop\node_modules\@missher\dsh-memory-tdai`
was built with the old code. Its `lib/` was replaced with the fixed build so a
restart can pick up the fix without a reinstall. The old `lib/` is backed up at:

`C:\Users\Missher-R2\.dsh\profiles\desktop\.plugin-manager\backups\memory-tdai-lib-20261022-1315`

The profile's `package.json` and `cordis.patch.yml` were **not** edited. The
profile dependency still points at the old `0.1.0-local.0` tarball and
`dsh.profile.bundles` does not yet contain `@missher/dsh-memory-tdai`; a clean
reinstall of `0.1.0-local.1` through the Host plugin manager is the durable path.

## Unverified

- Live activation after restarting DSH. The hotfix is applied, but this session
  cannot restart the running Host without killing itself.
- Live Settings-page rendering.
- Real-provider extraction/persona; tests still use a mock LLM.
- macOS/Linux real-machine runs.
- A clean plugin-manager install of `0.1.0-local.1` and its persisted bundle
  entry; the first install left the dependency but no bundle entry.
