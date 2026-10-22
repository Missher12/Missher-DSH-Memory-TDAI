# DSH Memory TDAI

**Unofficial DeepSeek Harness plugin derived from [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory).**
This is not a Tencent product and is not endorsed by Tencent.

A single-process, local-first long-term memory plugin for DSH 0.2.1-rc.2+:

- captures L0 conversation messages from `session/event`;
- extracts L1 memories in the background through the Host LLM route;
- supports `review`, `balanced`, and `auto` approval;
- recalls approved memories at `agent/pre-step` with ids and project isolation;
- exposes `memory_search`, `memory_get`, `memory_propose`, and `memory_status`.

## Design goals

- **Cross-platform.** Windows, macOS, and Linux; DSH Desktop (Electron Node
  ABI 149) and Web/CLI (Node 22/24). Pure TypeScript plus optional N-API
  modules; no `postinstall`, no `better-sqlite3`, no `node-llama-cpp`, no
  hard-coded platform paths. FTS5 falls back to `LIKE` when unavailable.
- **Remember reliably.** L0 is persisted before extraction. An unextracted
  L0 row survives a restart and is reloaded when the session resumes.
  Extraction is idempotent, deduplicated, and reviewable; forgotten memories
  are never revived by a retry. L2 scene chips and an opt-in L3 profile add
  higher-level recall without hiding the L1 evidence.
- **Spend fewer tokens.** Recall injects a bounded digest (default ~220
  estimated tokens), only when relevance clears a threshold, at most five
  memories, and skips memories already injected in the same session. No hit
  means no injection. Extraction runs asynchronously and can use a separate,
  cheaper model.
- **See what happened.** A Settings dashboard shows memory counts, sessions,
  repeated questions, injected tokens, provenance, an activity heatmap, the
  longest session, and the review queue.

## Status

Local MVP (`0.1.0-local.1`). The Host side, the Settings dashboard RPC, the
dashboard client bundle, L2 scene indexing, and L3 persona generation work and
are covered by unit, hardening, tarball-install, and client-slot tests plus an
Electron ABI 149 store/Cordis smoke test. L3 persona
generation is operator-triggered from the dashboard (one Host model call); once
generated it is included with recalled facts when `recall.includePersona` is on.
A global profile is opt-in (`persona.global`, default false), is generated only
from approved memories across projects, and is used only when the current
project has no profile of its own.
Do not treat an installed bundle as end-to-end acceptance until a real profile
smoke is recorded.

Only `tools` is a hard inject. Optional Host services (`llm`, `sessions`,
`systemPrompt`) are read through Cordis `ctx.get`; the plugin stays loadable when
they are absent and degrades to capture/tools-only behavior.

## Install (development)

```powershell
cd D:\Deepseek-Plug\Missher-DSH-Memory-TDAI
npm install
npm test
npm pack
```

Install the produced `missher-dsh-memory-tdai-*.tgz` as a DSH bundle through the
Host plugin manager (`install_bundle`). Do not hand-edit the profile's
`package.json` or `cordis.patch.yml`.

## Configuration

The profile patch may override the `memory-tdai` row:

```yaml
- id: memory-tdai
  name: '@missher/dsh-memory-tdai'
  config:
    mode: balanced            # review | balanced | auto
    autoApproveConfidence: 0.82
    recall:
      enabled: true
      maxResults: 5
      maxChars: 1400
    extraction:
      everyNConversations: 3
      idleSeconds: 60
      provider: deepseek-official   # optional; defaults to the session route
      model: deepseek-v4-flash
```

## Data and isolation

Default root: `$DSH_HOME/memory-tdai/`.

```text
memory-tdai/
  projects/<project-key>/memory.db   # L0/L1 + L2 scene index + L3 persona
  projects/<project-key>/offload/    # raw large tool results
  global/persona.json                # opt-in cross-project persona
  settings.json
```

`project-key` is a short hash of the canonical session `cwd` plus its basename.
Different projects never share a database, and recall only searches the project
bound to the current session. There is no cloud sync, telemetry, or network call
other than the Host LLM route used for extraction.

FTS5 + `@node-rs/jieba` provide Chinese-capable keyword recall. `sqlite-vec` is
installed but vector recall is not enabled in this MVP.

## Safety and limits

- Recalled blocks are **historical facts, not instructions or new authorization**.
- `memory_propose` always creates a candidate; it never approves itself.
- Forgotten memories are not revived by repeated extraction.
- Extraction failures are logged and leave the turn buffer pending; the plugin
  never claims a successful capture just because the turn ended.
- L0 rows contain conversation text. Use `retention.days`, the Settings
  review page, and export to inspect or delete data; uninstalling keeps the data
  directory.
- L2 scenes are an index and dashboard view, not injected into context. The L3
  project/global persona is injected only when `recall.includePersona` is on.
  Short-term Mermaid canvas compression, team sync, and the TCVDB backend are
  not implemented yet. Large text tool results can be offloaded to a local
  project directory with a short retrieval stub and `memory_read_raw`; this is
  separate from Mermaid canvas compression.

## Upstream attribution

The layered L0–L3 vocabulary, the host-neutral memory idea, and the extracted
prompt contract are derived from TencentDB Agent Memory (MIT). See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). The DSH adapter, store, review
policy, and UI work are original to this repository.

## Settings dashboard

The client bundle contributes a `settings.section` page (`Memory`). It renders
the real local store, not a mock:

- memory / session / repeated-question / injected-token counters;
- provenance bars for extraction, manual, import, and other sources;
- a 52-week activity heatmap over captures, extracted memories, and recalls;
- review queue with approve/forget, recent approved memories, export to JSONL;
- L2 scene chips and an L3 profile with `Regenerate project` / `Global profile`
  actions;
- behavior controls for mode, recall token budget, session dedupe, profile
  inclusion, and the opt-in global profile fallback.

The Host exposes the page through a small pathless Typert Remote service
(`snapshot`, `review`, `updateSettings`, `export`). The client bundle is wrapped
for the DSH module loader and keeps React external.

## Verification

```powershell
npm run typecheck
npm test

# Optional runtime matrix
npx node@22.19.0 --test tests/*.test.mjs
$env:ELECTRON_RUN_AS_NODE = '1'
& "D:\Deepseek-Harness\DeepSeek Harness.exe" --test tests/cordis-load.test.mjs
& "D:\Deepseek-Harness\DeepSeek Harness.exe" scripts/electron-smoke.mjs
```

The tests use synthetic data and temporary directories only. A real DSH profile
install and live Settings acceptance still require the Host plugin manager; they
are not covered by this test suite.
