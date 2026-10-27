# 技术参考与历史验证记录

以下保留本次已验收源码随附的详细实现说明。状态与交付范围以仓库 README 和 verification/2026-10-28-candidate-acceptance.md 为准；历史测试、平台支持与预期设计不能替代当前平台实测。

# DSH Memory TDAI

**Unofficial DeepSeek Harness plugin derived from [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory).**
This is not a Tencent product and is not endorsed by Tencent.

A single-process, local-first long-term memory plugin designed for the DSH 0.2.1-rc.2 API:

- captures L0 conversation messages from `session/event`;
- extracts L1 memories in the background through the Host LLM route;
- automatically makes sufficiently confident, sourced, non-conflicting extraction results usable;
- recalls visible memories across the current profile at `agent/pre-step`, with origin-qualified ids and profile isolation;
- exposes bounded search/get/propose/status tools, history and retrieval
  explanation, and project-local task, relation, and experience reads.

## Demo v7 source candidate (2026-10-27)

The normal Memory Settings section now has a global home, L0–L3 browse/search,
record details, source information, confirmed L1 forgetting, inline L2 expansion, and one inline gear.
The gear exposes only **自动生成记忆** and **在对话中使用记忆**. They persist independently;
turning off generation stops new capture/extraction and invalidates in-flight
acceptance, while turning off use removes memory from subsequent conversation
packets and blocks memory-reading tools. Existing records remain browseable.
Initial legacy capture/extraction/recall disables are reflected in the effective switches; deliberately enabling a switch persists its corresponding subgates. Zero automatic budgets still pause generation. High-confidence automatic
extraction no longer waits for a manual approval screen; uncertain or explicitly
conflicting outputs remain candidates, and repeated forgotten records stay forgotten.

Project shards and session ids are retained as provenance inside the actual
profile state root. They are not a user-selectable scope. No-cwd Host sessions
use an internal provenance shard; no process cwd or request-provided path is
used as a substitute. Search results and injected references include their
origin identity. Opening pages or changing search/statistics makes no model call.
The annual calendar counts visible memories' first revisions and later content/
evidence revisions, deduplicated per record/day/type; capture, recall, injection,
and approval/forget bookkeeping do not inflate it. The 30-day count uses the
same revision scan, including the previous year near January.

The profile reader streams directory entries and record keysets. Sources are admitted
one at a time on the **same** S1 ledger: source changes do not reset SQL, rows,
projects, keys, materialization, residence, lifetime or continuation budgets.
The existing 4-project per-call / 16-project cumulative limits remain. Reaching
an overall window limit produces an opaque `next` position, retained only in
this process under an accounted, expiring lease (at most two positions). The
**继续读取下一批** action starts a new bounded window at that position; the
previous prefix is not rescanned. Search exposes `next_scan` / `scan_cursor`
with the same query and offset zero for a new window; reuse that window cursor for nextOffset or response-budget retries. Each replay performs a fresh budgeted proof, never serves cached bodies. Automatic recall retains bounded query
progress for subsequent conversations. Window positions are replayable while their bounded lease remains valid; native in-session cursors stay single use. Positions are invalidated
by profile/generation/policy changes, expiry or eviction; they contain no bodies.

Each source is proved before switching and each packet receives the native
final control/version/visibility proof. Multiple source snapshots and resumed
windows remain **partial**; they do not claim one atomic global snapshot or
exact global counts. A record whose complete proof cannot fit still remains
unresolved. No source count or work limit is raised to force a complete badge.
Legacy explicit historical-time tools and management APIs remain compatible;
their provenance-local contracts are not normal v7 navigation.

A successful extraction batch now refreshes L3 without an additional model call:
at most eight currently readable, high-confidence approved facts/preferences,
with bounded bodies and sources, are projected deterministically. Current source
revisions are saved and rechecked; forgetting, revocation and revisions invalidate
the derived result. Generation disables, zero budgets and stale in-flight policy
snapshots cannot authorize this update. Browsing/search/statistics remain model-free.

No database migration, live profile edit, installation or release is part of this
source change. The new candidate has **not** been compiled, tested, or exercised
in a Host. Older validation receipts apply only to their original frozen source.
The older R4.1 sections below describe retained compatibility backends, not the
normal v7 navigation or new runtime acceptance.

## Design goals

- **Cross-platform.** Windows, macOS, and Linux; DSH Desktop (Electron Node
  ABI 149) and Web/CLI (Node 22/24). Pure TypeScript plus optional N-API
  modules; no `postinstall`, no `better-sqlite3`, no `node-llama-cpp`, no
  hard-coded platform paths. FTS5 falls back to `LIKE` when unavailable.
- **Remember reliably.** L0 is persisted before extraction. An unextracted
  L0 row survives a restart and is reloaded when the session resumes;
  extraction consumes only the fixed oldest-first batch that was being
  processed, so rows captured during a model call are never lost or replayed.
  Extraction is idempotent, deduplicated, and reviewable; forgotten memories
  are never revived by a retry, and a persona built from a later-forgotten
  memory is flagged stale instead of being injected as current facts. L2
  scene chips and an opt-in L3 profile add higher-level recall without hiding
  the L1 evidence.
- **Bound memory work.** Each recall step rechecks current readability and
  prepares a bounded digest (default ~220 estimated tokens) only when relevance
  clears a threshold, with at most five memories. There is no per-session
  “already injected” filter, so a relevant memory may be prepared again in a
  later step. No hit means no injection. Extraction runs asynchronously
  through the configured Host route. Net token savings have not been measured
  for the R4.1 candidate.
- **Bounded global reads.** Current conversation recall and ordinary search use
  the same profile reader and current source/dependency/version proofs. Search
  scans the bounded readable set, not just a rendered page, and reports a partial
  scan. Explicit historical compatibility calls keep their existing time fences.
- **See what happened.** The v7 Settings section shows four memory layers, a
  January–December activity grid, collapsed recent activity, and two switches.

## Status

R4.1 source candidate (`0.1.0-local.2`) contains implementation work across A,
B0, B1, and C1, including local management flows and a settings overview.
Recovery now has a quiesced v3 SQLite snapshot, isolated staged migration,
identity checks, a journaled generation-pointer cutover, and a UI action gated by
a verified recovery plan. The stable control ledger remains authoritative and
is not rolled back. Provider text responses are saved to private local sidecars
before the billable gate is released; startup reconciliation can recover saved
extraction and persona results when source and policy checks still pass.
Overview metrics count later approvals of existing memories as accepted
revisions and report first approvals separately. These are source capabilities,
not runtime acceptance claims. This candidate has not been typechecked, built,
tested, packed, loaded in the official Host, or evaluated with a real provider.
Historical `0.1.0-local.1` test and CI receipts apply only to that earlier
frozen candidate and do not establish R4.1 acceptance. R4.1-specific tests use
synthetic data and are currently unrun.

The sixth R4.1 source round adds explicit-unknown and partial-precision
effective-time display/history, per-verifiable-Host-event revocation with a
hashed local-source mapping that survives L0 retention cleanup, and selected
managed-content deletion with a durable fence and recovery-time replay. The
new synthetic regressions are recorded in
`tests/r41-temporal-control-delete.test.mjs`; they have not been run. These
changes remain static source work, not runtime or release acceptance.

The parallel-core closeout connects the deterministic relation route and the
explicit dual-time revision route to the real recall/search/explain candidate
window, applies the current Agent/dependency policy to the ordinary export
while keeping management history, and replaces the permanently-unresolved
experience prerequisite flag with an explicit condition-fact comparison. Its
synthetic regressions live in `tests/r41.test.mjs`, `tests/runtime.test.mjs`,
`tests/tools.test.mjs`, `tests/store.test.mjs`, `tests/r41-management.test.mjs`
and `tests/dashboard.test.mjs`; they have not been run, so this remains static
source work rather than runtime acceptance.

Dependency and derived-memory reads now check `depends_on` / `derived_from`
chains before recall, explanation, knowledge detail, persona generation,
local evaluation, or approved-memory browsing. Overview drilldown supports the
selected date range and its aggregated `other` dimension. Source groups and key
statistics open local detail views. Repeated clues reveal a short source excerpt
only after an explicit click; event pages support pagination and retain the
original event timestamp. A shared source excerpt is hidden in overview details,
`memory_get`, `memory_explain`, and knowledge details whenever any citing memory
is not currently readable; the readable memory fact and fully readable shared
sources remain available. The settings view also shows coverage windows,
bounded job errors, top sessions, and usage grouped by model and call purpose.
Paired evaluation uses the same temporal inputs for baseline and candidate and
shows missing, forbidden, and budget-omitted results. These source changes have
synthetic regression cases, which remain unrun in this candidate.

L3 persona generation remains operator-triggered from the dashboard (one Host
model call); once generated it is included with recalled facts when
`recall.includePersona` is on. A global profile is opt-in (`persona.global`,
default false), is generated only from approved memories across projects, and
is used only when the current project has no profile of its own.

Host tool costs include visible schemas, descriptions, instructions, history,
and returned content. The plugin keeps explicit tool registrations and does
not assume deferred loading is supported by every Host route. No R4.1 schema
reduction, native usage coverage, or net token savings has been measured.

Only `tools` is a hard inject. Optional Host services (`llm`, `sessions`,
`systemPrompt`) are read through Cordis `ctx.get`; the plugin stays loadable when
they are absent and degrades to capture/tools-only behavior.

## Install (development)

Run candidate checks only in an authorized isolated validation window. See the
exact command order and evidence limits in `IMPLEMENTATION-READY.md`.

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
    capture:
      excludeAgents:          # only sessions whose agentPreset matches are skipped
        - '*agent-mock'
        - 'reviewer?'
    recall:
      enabled: true
      maxResults: 5
      maxChars: 1400
    extraction:
      everyNConversations: 3
      idleSeconds: 60
      provider: deepseek-official   # optional; defaults to the session route
      model: deepseek-v4-flash
    retention:
      days: 0                 # 0 (default) keeps L0 raw rows forever; see below
```

`capture.excludeAgents` filters capture at the source: a session whose
`header.agentPreset` matches one of the patterns is neither recorded at L0 nor
sent to the extraction model. Matching is a simple anchored glob on the whole
preset name, case-sensitive: `*` matches any (possibly empty) sequence of
characters, `?` matches exactly one character, and every other character
matches itself literally (for example `'*agent-mock'` or `'reviewer?'`).
`capture.enabled: false` still disables capture globally.

## Data and isolation

Default root: `$DSH_HOME/memory-tdai/`. Preserve this entire directory when
backing up or moving the data; copying only `projects/` loses recovery and
usage state.

```text
memory-tdai/
  state-current.json                 # selects the authoritative generation
  generations/<generation>/          # active projects, persona, and settings
    projects/<project-key>/memory.db # L0/L1 + L2 scene index + L3 persona
    offload/<project-key>/           # raw large tool results, outside projects/
    global/persona.json              # opt-in cross-project persona
    settings.json
  control/control.db                 # stable ledger; not rolled back with a generation
  billable-results/                  # private saved provider responses for local recovery
  capture-spool/                     # durable capture events awaiting replay
  recovery/                          # recovery snapshots and cutover journal
```

`project-key` is a short hash of the canonical session `cwd` plus its basename.
Different projects never share a database, and recall only searches the project
bound to the current session. There is no cloud sync, telemetry, or network call
other than the Host LLM route used for extraction.

Before a generation cutover exists, project data may still be stored directly
under the root; `state-current.json` identifies the active generation after a
cutover. Keep the pointer, its active generation, the stable control database,
and `billable-results/` together. The last directory can contain local response
bodies needed to finish a paid request without sending it again.

FTS5 + `@node-rs/jieba` provide Chinese-capable keyword recall. `sqlite-vec` is
installed but vector recall is not enabled in this MVP.

## Safety and limits

- Recalled blocks are **historical facts, not instructions or new authorization**.
- `memory_propose` always creates a candidate; it never approves itself.
- Forgotten memories are not revived by repeated extraction.
- Un-dispatched L0 rows and queued extraction jobs remain local across restart.
  When their Host session is available again with a usable route, recovery
  rebuilds the oldest-first backlog in batches of up to 24; missing session or
  route information leaves the rows local instead of dispatching a guess.
- After a provider response has been saved locally, restart recovery validates
  that saved response and can finish its local commit without another provider
  request. Keep `billable-results/` with the control ledger and project data so
  that path remains available.
- A dispatched request that returns malformed/off-protocol JSON or fails
  frozen-source validation leaves its L0 rows unconsumed and marks the job
  failed. That paid result is not automatically charged again or retried; a
  later independent source batch can still proceed. `{"memories":[]}` is a
  legal empty answer and consumes its frozen batch. Extraction failures remain
  visible in the dashboard.
- **L0 retention is strictly raw conversation rows.** `retention.days: 0` (the
  default) never deletes anything; a positive value prunes only L0 rows older
  than that many days, on an in-process unref'd timer. L1 memories, forgotten
  review records, L2 scenes and L3 personas are never deleted by retention —
  the Settings review page and export remain the ways to inspect or remove
  them.
- **Export applies the current policy.** The ordinary JSONL export is built
  from the same read policy as recall: managed content deletion and
  deleted/revoked sources keep masking a row, the current
  `capture.excludeAgents` rule is applied, and any row with a recorded
  dependency chain that is no longer readable is exported as metadata history
  with an empty `content` and `contentWithheld: true` instead of a stale body.
  Independent forgotten, candidate and expired management history keeps its
  body because the review page and export are its inspection path. The header
  keeps `dsh-memory-tdai/v1`, `count` and adds
  `withheldCount`. The L0 data is conversation text; uninstalling keeps the data
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

## Experience conditions

`memory_experience` compares a stored card’s environment and prerequisites with
explicit caller facts. The legacy `environment` argument keeps its meaning; two
optional bounded fields can be added: `conditions` (extra current key/value
facts) and `satisfied_prerequisites` (exact prerequisite statements the caller
declares as currently satisfied). Results distinguish `applicable`,
`partially_applicable`, `conditions_missing`, `inapplicable` and
`known_counterexample`, and include `conditionState`, the satisfied/unresolved
prerequisite lists, `verified` and `executionAuthorized: false`. Supplying
conditions never writes the card, never upgrades an episode/candidate to
verified and never authorizes executing the steps; an unproven condition stays
`conditions_missing` instead of being guessed from text similarity. Bounded
comparisons report `truncated: true` and `conditions_missing` when stored
environment keys or prerequisites fall beyond the checked limit; they are not
assumed to match.

## Settings dashboard

The client bundle contributes a `settings.section` page (`Memory`). It renders
the real local store, not a mock:

- project-scoped memory / session / repeated-question / usage counters;
- activity dimensions for capture, recall, accepted later revisions, and first
  approvals, with a date heatmap and metadata-only event drill-down. First
  approvals are counted separately from revisions;
- review queue, recent memories, paginated library, and JSONL export;
- L2 scene chips and an L3 profile with `Regenerate project` / `Global profile`
  actions;
- behavior controls for mode, recall token budget, session dedupe, profile
  inclusion, extraction pause, and explicit daily task/token budgets;
- project-local task continuity, experience cards, revision/relation review,
  decision impact, synthetic retrieval evaluation, budget audit, and recovery
  snapshots with a verified-plan-gated apply action.

The Host exposes the page through a pathless Typert Remote service for snapshots,
reviews, settings, export, overview metrics, paginated library reads, and
project-local management operations. The client bundle is wrapped for the DSH
module loader and keeps React external.

## Validation status

No R4.1 validation command has been run in the implementation window. Follow
the staged, serial validation sequence recorded in `IMPLEMENTATION-READY.md`;
do not use an old build, tarball, CI run, or installed bundle as proof for this
candidate. Official Host loading, native Settings interaction, real provider
usage reconciliation, package digest, release, and installation each require
their own evidence and are not implied by source or offline tests.
