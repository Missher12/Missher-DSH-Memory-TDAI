import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DashboardSnapshot, ExportResult, MemoryView } from '../remote-contract'

export interface DashboardActions {
  load: () => Promise<DashboardSnapshot>
  review: (request: { projectKey: string; id: string; action: 'approve' | 'forget' }) => Promise<DashboardSnapshot>
  updateSettings: (request: {
    mode?: string
    recallMaxTokens?: number
    dedupeSession?: boolean
    includePersona?: boolean
    extractionEveryN?: number
  }) => Promise<DashboardSnapshot>
  exportProject: (projectKey: string) => Promise<ExportResult>
  refreshPersona?: (projectKey: string) => Promise<DashboardSnapshot>
  refreshGlobalPersona?: () => Promise<DashboardSnapshot>
}

export interface DashboardProps extends Partial<DashboardActions> {
  /** Optional snapshot used by server-side previews and tests. */
  initialSnapshot?: DashboardSnapshot
}

const WEEK_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function Dashboard(props: DashboardProps): ReactNode {
  const { load, review, updateSettings, exportProject, refreshPersona, refreshGlobalPersona, initialSnapshot } = props
  if (!load || !review || !updateSettings || !exportProject) return null
  return <Loaded {...{ load, review, updateSettings, exportProject, refreshPersona, refreshGlobalPersona, initialSnapshot }} />
}

function Loaded(props: DashboardActions & { initialSnapshot?: DashboardSnapshot }): ReactNode {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | undefined>(props.initialSnapshot)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string>()
  const generation = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const current = generation.current + 1
    generation.current = current
    setFailed(false)
    try {
      const next = await props.load()
      if (generation.current === current) setSnapshot(next)
    } catch {
      if (generation.current === current) setFailed(true)
    }
  }, [props.load])

  useEffect(() => {
    void refresh()
    return () => { generation.current += 1 }
  }, [refresh])

  const mutate = (operation: () => Promise<DashboardSnapshot>, message = 'saved'): void => {
    if (busy) return
    setBusy(true)
    setNotice(undefined)
    void operation()
      .then((next) => { setSnapshot(next); setNotice(message) })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'operation failed'))
      .finally(() => setBusy(false))
  }

  const reviewMemory = (memory: MemoryView, action: 'approve' | 'forget'): void => {
    mutate(() => props.review({ projectKey: memory.projectKey, id: memory.id, action }), action === 'approve' ? 'approved' : 'forgotten')
  }

  const regenerate = (): void => {
    const project = snapshot?.projects[0]
    if (project === undefined || props.refreshPersona === undefined || busy) return
    mutate(() => props.refreshPersona!(project.key), 'profile generated')
  }

  const regenerateGlobal = (): void => {
    if (props.refreshGlobalPersona === undefined || busy) return
    mutate(() => props.refreshGlobalPersona!(), 'global profile generated')
  }

  const download = (): void => {
    const project = snapshot?.projects[0]
    if (project === undefined || busy) return
    setBusy(true)
    void props.exportProject(project.key)
      .then((result) => {
        const url = URL.createObjectURL(new Blob([result.content], { type: 'application/x-ndjson' }))
        const link = document.createElement('a')
        link.href = url
        link.download = result.fileName
        link.click()
        URL.revokeObjectURL(url)
      })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'export failed'))
      .finally(() => setBusy(false))
  }

  if (snapshot === undefined && !failed) return <Shell><div className="tdai-loading">loading local memory state…</div></Shell>
  if (snapshot === undefined) {
    return (
      <Shell>
        <div className="tdai-error">
          <p>Could not read the memory dashboard.</p>
          <button type="button" onClick={() => void refresh()}>Retry</button>
        </div>
      </Shell>
    )
  }

  const { totals, settings } = snapshot
  const filteredCandidates = filterMemories(snapshot.candidates, query)
  const filteredRecent = filterMemories(snapshot.recent, query)
  const heat = buildHeatmap(snapshot.activity)
  const maxSource = Math.max(1, ...snapshot.sources.map((source) => source.count))
  const savedPercent = totals.rawTokens > 0 ? Math.round((totals.savedTokens / totals.rawTokens) * 100) : 0
  const range = `${heat.startLabel} — ${heat.endLabel}`

  return (
    <Shell>
      <header className="tdai-header">
        <div className="tdai-brand">
          <span className="tdai-glyph" aria-hidden="true">◈</span>
          <div>
            <div className="tdai-kicker">TDAI MEMORY <span>· agent memory</span></div>
            <h2>Long-term memory</h2>
          </div>
        </div>
        <div className="tdai-range">{range}</div>
      </header>

      <div className="tdai-stats">
        <Stat value={totals.memories} label="memories" hint={`${totals.approved} approved · ${totals.candidates} pending`} />
        <Stat value={totals.sessions} label="sessions" hint={`${totals.projects} project${totals.projects === 1 ? '' : 's'}`} />
        <Stat value={totals.repeatedQuestions} label="repeated questions" hint="asked more than once" />
        <Stat value={formatCompact(totals.injectedTokens)} label="tokens injected" hint={`${totals.injectedCount} recalls`} />
      </div>

      <div className="tdai-grid">
        <section className="tdai-panel tdai-provenance">
          <div className="tdai-panel-head"><h3>Where it came from</h3><span>{totals.memories} total</span></div>
          {snapshot.sources.length === 0 && <p className="tdai-muted">No memories yet. Approved extraction will appear here.</p>}
          {snapshot.sources.map((source) => (
            <div className="tdai-source" key={source.source}>
              <span className="tdai-source-name">{source.source}</span>
              <span className="tdai-source-bar"><i style={{ width: `${Math.max(4, (source.count / maxSource) * 100)}%` }} /></span>
              <strong>{source.count}</strong>
            </div>
          ))}
          <div className="tdai-saved">
            <span>context compression</span>
            <strong>{formatCompact(totals.savedTokens)} saved · {savedPercent}%</strong>
          </div>
        </section>

        <section className="tdai-panel tdai-activity">
          <div className="tdai-panel-head"><h3>Activity</h3><span>{totals.l0Messages} captured messages</span></div>
          <div className="tdai-heat">
            <div className="tdai-months" style={{ gridTemplateColumns: `repeat(${heat.weeks.length}, 1fr)` }}>
              {heat.months.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}
            </div>
            <div className="tdai-heat-body">
              <div className="tdai-weekdays">{WEEK_LABELS.map((label, index) => <span key={index}>{label}</span>)}</div>
              <div className="tdai-heat-weeks">
                {heat.weeks.map((week, weekIndex) => (
                  <div className="tdai-heat-col" key={weekIndex}>
                    {week.map((cell) => (
                      <i
                        key={cell.date}
                        className={`tdai-cell tdai-level-${cell.level}`}
                        title={`${cell.date}: ${cell.captures} captured, ${cell.memories} memories, ${cell.recalls} recalls`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="tdai-legend"><span>less</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`tdai-cell tdai-level-${level}`} />)}<span>more</span></div>
          </div>
        </section>
      </div>

      <div className="tdai-grid tdai-lower">
        <section className="tdai-panel">
          <div className="tdai-panel-head">
            <h3>Review queue</h3>
            <span>{totals.candidates} pending</span>
          </div>
          {snapshot.candidates.length === 0 && <p className="tdai-muted">Nothing to review. Balanced mode auto-approves high-confidence memories.</p>}
          <div className="tdai-list">
            {filteredCandidates.slice(0, 6).map((memory) => (
              <article className="tdai-memory" key={memory.id}>
                <div className="tdai-memory-top"><code>{memory.id}</code><span>{memory.projectName}</span></div>
                <p>{memory.content}</p>
                <div className="tdai-memory-actions">
                  <span className="tdai-pill">{memory.kind}</span>
                  <span className="tdai-pill">{Math.round(memory.confidence * 100)}%</span>
                  <button type="button" disabled={busy} onClick={() => reviewMemory(memory, 'approve')}>Approve</button>
                  <button type="button" className="tdai-danger" disabled={busy} onClick={() => reviewMemory(memory, 'forget')}>Forget</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="tdai-panel">
          <div className="tdai-panel-head"><h3>Recent memories</h3><span>{totals.approved} approved</span></div>
          <div className="tdai-list">
            {filteredRecent.length === 0 && <p className="tdai-muted">No approved memories yet.</p>}
            {filteredRecent.slice(0, 6).map((memory) => (
              <article className="tdai-memory tdai-recent" key={memory.id}>
                <div className="tdai-memory-top"><code>{memory.id}</code><span>{memory.projectName}</span></div>
                <p>{memory.content}</p>
                <div className="tdai-memory-actions"><span className="tdai-pill">{memory.kind}</span><span className="tdai-pill">{new Date(memory.updatedAt).toLocaleDateString()}</span></div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="tdai-panel tdai-profile">
        <div className="tdai-panel-head">
          <h3>Profile &amp; scenes</h3>
          <div className="tdai-profile-head">
            <span>{snapshot.personas.length} project · {snapshot.globalPersona === null ? 'no global' : 'global on'}</span>
            <button type="button" disabled={busy || snapshot.projects.length === 0 || props.refreshPersona === undefined} onClick={regenerate}>Regenerate project</button>
            <button type="button" disabled={busy || props.refreshGlobalPersona === undefined} onClick={regenerateGlobal}>Global profile</button>
          </div>
        </div>
        {snapshot.personas.length === 0 && snapshot.globalPersona === null && (
          <p className="tdai-muted">No L3 profile yet. Approve at least 3 memories, then generate a compact profile from approved facts. This is optional and calls the Host model once.</p>
        )}
        {snapshot.personas.slice(0, 1).map((persona) => (
          <div className="tdai-profile-body" key={persona.projectKey}>
            <div className="tdai-profile-meta">{persona.projectName} · {persona.sourceCount} source memories · {new Date(persona.updatedAt).toLocaleDateString()}</div>
            <pre className="tdai-profile-text">{persona.content}</pre>
          </div>
        ))}
        {snapshot.personas.length === 0 && snapshot.globalPersona !== null && (
          <div className="tdai-profile-body">
            <div className="tdai-profile-meta">global · {snapshot.globalPersona.sourceCount} source memories · {new Date(snapshot.globalPersona.updatedAt).toLocaleDateString()}</div>
            <pre className="tdai-profile-text">{snapshot.globalPersona.content}</pre>
          </div>
        )}
        <div className="tdai-scenes">
          {snapshot.scenes
            .filter((scene) => snapshot.personas.length === 0 || scene.projectKey === snapshot.personas[0]?.projectKey)
            .slice(0, 6)
            .map((scene) => (
              <span className="tdai-scene" key={`${scene.projectKey}:${scene.name}`} title={scene.summary}>
                {scene.name} <b>{scene.memoryCount}</b>
              </span>
            ))}
        </div>
      </section>

      <div className="tdai-grid tdai-lower">
        <section className="tdai-panel tdai-settings">
          <div className="tdai-panel-head"><h3>Behavior</h3><span>stored locally</span></div>
          <label className="tdai-field">
            <span>Mode</span>
            <select
              value={settings.mode}
              disabled={busy}
              onChange={(event) => mutate(() => props.updateSettings({ mode: event.currentTarget.value }), 'mode saved')}
            >
              <option value="review">review — everything needs approval</option>
              <option value="balanced">balanced — high confidence auto</option>
              <option value="auto">auto — inject immediately</option>
            </select>
          </label>
          <label className="tdai-field">
            <span>Recall token budget</span>
            <input
              type="number"
              min={40}
              max={4000}
              defaultValue={settings.recallMaxTokens}
              disabled={busy}
              onBlur={(event) => {
                const value = Number(event.currentTarget.value)
                if (Number.isFinite(value) && value !== settings.recallMaxTokens) {
                  mutate(() => props.updateSettings({ recallMaxTokens: Math.round(value) }), 'budget saved')
                }
              }}
            />
          </label>
          <label className="tdai-check">
            <input
              type="checkbox"
              checked={settings.dedupeSession}
              disabled={busy}
              onChange={(event) => mutate(() => props.updateSettings({ dedupeSession: event.currentTarget.checked }), 'dedupe saved')}
            />
            <span>Skip memories already injected in the same session</span>
          </label>
          <label className="tdai-check">
            <input
              type="checkbox"
              checked={settings.includePersona}
              disabled={busy}
              onChange={(event) => mutate(() => props.updateSettings({ includePersona: event.currentTarget.checked }), 'profile recall saved')}
            />
            <span>Include the L3 profile summary with recalled facts</span>
          </label>
          <label className="tdai-check">
            <input
              type="checkbox"
              checked={settings.globalPersona}
              disabled={busy}
              onChange={(event) => mutate(() => props.updateSettings({ globalPersona: event.currentTarget.checked }), 'global profile saved')}
            />
            <span>Allow the global profile to stand in when a project has none</span>
          </label>
          {notice !== undefined && <p className="tdai-notice" role="status">{notice}</p>}
        </section>

        <section className="tdai-panel tdai-footer-panel">
          <div className="tdai-panel-head"><h3>At a glance</h3><span>{snapshot.root}</span></div>
          <dl className="tdai-facts">
            <div><dt>Longest session</dt><dd>{snapshot.longestSession === null ? '—' : `${snapshot.longestSession.messages} messages · ${snapshot.longestSession.projectName}`}</dd></div>
            <div><dt>Forgotten</dt><dd>{totals.forgotten}</dd></div>
            <div><dt>Recall hits</dt><dd>{totals.injectedCount}</dd></div>
            <div><dt>Last error</dt><dd className={snapshot.lastError ? 'tdai-danger-text' : ''}>{snapshot.lastError ?? 'none'}</dd></div>
          </dl>
          <div className="tdai-toolbar">
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Filter local view…" />
            <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button>
            <button type="button" onClick={download} disabled={busy || snapshot.projects.length === 0}>Export JSONL</button>
          </div>
          <p className="tdai-muted">Recalled memory is historical evidence, not instructions. Nothing leaves this machine except the model calls the Host already owns.</p>
        </section>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }): ReactNode {
  return (
    <section className="tdai-root">
      <style>{CSS}</style>
      {children}
    </section>
  )
}

function Stat({ value, label, hint }: { value: number | string; label: string; hint: string }): ReactNode {
  const formatted = typeof value === 'number' ? value.toLocaleString() : value
  return (
    <div className="tdai-stat">
      <div className="tdai-stat-value">{formatted}</div>
      <div className="tdai-stat-label">{label}</div>
      <div className="tdai-stat-hint">{hint}</div>
    </div>
  )
}

function filterMemories(memories: MemoryView[], query: string): MemoryView[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return memories
  return memories.filter((memory) => memory.content.toLowerCase().includes(needle) || memory.projectName.toLowerCase().includes(needle))
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

interface HeatCell { date: string; captures: number; memories: number; recalls: number; level: number }

function buildHeatmap(activity: DashboardSnapshot['activity']): {
  startLabel: string
  endLabel: string
  weeks: HeatCell[][]
  months: string[]
} {
  const map = new Map(activity.map((day) => [day.date, day]))
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setDate(start.getDate() - 52 * 7 + 1)
  start.setDate(start.getDate() - start.getDay())
  const cells: HeatCell[] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    const found = map.get(date)
    const total = (found?.captures ?? 0) + (found?.memories ?? 0) + (found?.recalls ?? 0)
    const level = total === 0 ? 0 : total < 3 ? 1 : total < 8 ? 2 : total < 20 ? 3 : 4
    cells.push({ date, captures: found?.captures ?? 0, memories: found?.memories ?? 0, recalls: found?.recalls ?? 0, level })
    cursor.setDate(cursor.getDate() + 1)
  }
  while (cells.length % 7 !== 0) cells.push({ date: '', captures: 0, memories: 0, recalls: 0, level: 0 })
  const weeks: HeatCell[][] = []
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7))
  const months: string[] = []
  for (let index = 0; index < weeks.length; index += 1) {
    const first = weeks[index]?.[0]
    if (first === undefined || first.date === '') { months.push(''); continue }
    const month = new Date(`${first.date}T00:00:00`).getMonth()
    const previous = index > 0 ? weeks[index - 1]?.[0] : undefined
    const previousMonth = previous?.date ? new Date(`${previous.date}T00:00:00`).getMonth() : -1
    months.push(month === previousMonth ? '' : MONTHS[month] ?? '')
  }
  return {
    startLabel: new Date(`${cells[0]?.date || end.toISOString().slice(0, 10)}T00:00:00`).toISOString().slice(0, 10),
    endLabel: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`,
    weeks,
    months,
  }
}

const CSS = `
.tdai-root {
  --tdai-bg: #12111a;
  --tdai-panel: #191722;
  --tdai-line: #2a2637;
  --tdai-ink: #f4f1ff;
  --tdai-muted: #8f899f;
  --tdai-accent: #a78bfa;
  --tdai-accent-strong: #8b5cf6;
  --tdai-good: #5eead4;
  --tdai-bad: #fb7185;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 22px 28px;
  border-radius: 14px;
  color: var(--tdai-ink);
  background:
    radial-gradient(1000px 240px at 8% -20%, rgba(139, 92, 246, .22), transparent 60%),
    var(--tdai-bg);
  border: 1px solid var(--tdai-line);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
.tdai-root * { box-sizing: border-box; }
.tdai-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.tdai-brand { display: flex; align-items: center; gap: 12px; }
.tdai-glyph { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid #4c3a7a; border-radius: 10px; color: var(--tdai-accent); background: #1e1930; font-size: 20px; }
.tdai-kicker { color: var(--tdai-accent); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; }
.tdai-kicker span { color: var(--tdai-muted); letter-spacing: .06em; }
.tdai-header h2 { margin: 2px 0 0; font-size: 22px; line-height: 1.1; letter-spacing: -.02em; }
.tdai-range { color: var(--tdai-muted); font-size: 11px; white-space: nowrap; }
.tdai-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.tdai-stat { padding: 14px 16px 12px; border: 1px solid var(--tdai-line); border-radius: 10px; background: linear-gradient(180deg, rgba(167,139,250,.08), transparent 70%), var(--tdai-panel); }
.tdai-stat-value { color: var(--tdai-accent); font-size: clamp(26px, 4vw, 40px); line-height: 1; letter-spacing: -.04em; }
.tdai-stat-label { margin-top: 9px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.tdai-stat-hint, .tdai-muted { color: var(--tdai-muted); font-size: 11px; }
.tdai-stat-hint { margin-top: 4px; }
.tdai-grid { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 12px; }
.tdai-grid.tdai-lower { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.tdai-panel { min-width: 0; padding: 14px 16px; border: 1px solid var(--tdai-line); border-radius: 10px; background: var(--tdai-panel); }
.tdai-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.tdai-panel-head h3 { margin: 0; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
.tdai-panel-head span { color: var(--tdai-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tdai-source { display: grid; grid-template-columns: 86px minmax(0, 1fr) 30px; align-items: center; gap: 8px; margin: 8px 0; font-size: 11px; }
.tdai-source-name { color: var(--tdai-muted); overflow: hidden; text-overflow: ellipsis; }
.tdai-source-bar { height: 8px; border-radius: 2px; background: #211d2d; overflow: hidden; }
.tdai-source-bar i { display: block; height: 100%; background: linear-gradient(90deg, #6d4bd8, var(--tdai-accent)); border-radius: 2px; }
.tdai-source strong { font-weight: 600; text-align: right; }
.tdai-saved { display: flex; justify-content: space-between; gap: 10px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--tdai-line); color: var(--tdai-muted); font-size: 10px; }
.tdai-saved strong { color: var(--tdai-good); font-weight: 500; }
.tdai-heat { overflow: hidden; }
.tdai-heat-body { display: flex; gap: 5px; }
.tdai-weekdays { display: grid; grid-template-rows: repeat(7, 10px); gap: 3px; padding-top: 15px; color: var(--tdai-muted); font-size: 7px; line-height: 10px; }
.tdai-heat-weeks { display: flex; gap: 3px; flex: 1; min-width: 0; }
.tdai-heat-col { display: grid; grid-template-rows: repeat(7, 10px); gap: 3px; flex: 1; min-width: 0; }
.tdai-months { display: grid; gap: 3px; margin-left: 17px; margin-bottom: 3px; color: var(--tdai-muted); font-size: 8px; }
.tdai-months span { overflow: visible; white-space: nowrap; }
.tdai-cell { display: block; width: 100%; min-width: 3px; height: 10px; border-radius: 2px; background: #211d2d; }
.tdai-level-1 { background: #3b2e58; }
.tdai-level-2 { background: #58408f; }
.tdai-level-3 { background: #7c5cce; }
.tdai-level-4 { background: #b59cff; }
.tdai-legend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 8px; color: var(--tdai-muted); font-size: 9px; }
.tdai-legend .tdai-cell { width: 9px; height: 9px; }
.tdai-list { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow: auto; padding-right: 2px; }
.tdai-memory { padding: 10px 11px; border: 1px solid #272235; border-radius: 8px; background: #15131d; }
.tdai-memory p { margin: 6px 0 8px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; line-height: 1.55; color: #ddd8ed; }
.tdai-memory-top { display: flex; justify-content: space-between; gap: 10px; color: var(--tdai-muted); font-size: 9px; }
.tdai-memory-top code { color: #b7a6ea; }
.tdai-memory-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tdai-pill { padding: 1px 6px; border: 1px solid #332c45; border-radius: 99px; color: var(--tdai-muted); font-size: 9px; }
.tdai-memory-actions button, .tdai-toolbar button, .tdai-error button { margin-left: auto; padding: 3px 9px; border: 1px solid #453a62; border-radius: 5px; background: #211b31; color: var(--tdai-ink); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-memory-actions button + button { margin-left: 0; }
.tdai-memory-actions button:hover, .tdai-toolbar button:hover { border-color: var(--tdai-accent); }
.tdai-memory-actions button:disabled, .tdai-toolbar button:disabled { opacity: .45; cursor: default; }
.tdai-danger { color: var(--tdai-bad) !important; border-color: #5b2b3a !important; }
.tdai-field, .tdai-check { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 8px 0; color: var(--tdai-muted); font-size: 11px; }
.tdai-field select, .tdai-field input, .tdai-toolbar input { max-width: 62%; padding: 5px 7px; border: 1px solid #332c45; border-radius: 5px; background: #15131d; color: var(--tdai-ink); font: inherit; font-size: 10px; }
.tdai-field input[type="number"] { width: 92px; text-align: right; }
.tdai-check { justify-content: flex-start; }
.tdai-check input { accent-color: var(--tdai-accent-strong); }
.tdai-notice { margin: 10px 0 0; color: var(--tdai-good); font-size: 10px; }
.tdai-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin: 0 0 12px; }
.tdai-facts div { min-width: 0; }
.tdai-facts dt { color: var(--tdai-muted); font-size: 9px; text-transform: uppercase; letter-spacing: .07em; }
.tdai-facts dd { margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ddd8ed; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; }
.tdai-danger-text { color: var(--tdai-bad) !important; }
.tdai-toolbar { display: flex; gap: 6px; align-items: center; }
.tdai-toolbar input { flex: 1; max-width: none; }
.tdai-toolbar button { margin-left: 0; white-space: nowrap; }
.tdai-profile-head { display: flex; align-items: center; gap: 10px; }
.tdai-profile-head button { padding: 3px 9px; border: 1px solid #453a62; border-radius: 5px; background: #211b31; color: var(--tdai-ink); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-profile-head button:disabled { opacity: .45; cursor: default; }
.tdai-profile-body { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 12px; align-items: start; }
.tdai-profile-meta { color: var(--tdai-muted); font-size: 10px; line-height: 1.5; }
.tdai-profile-text { margin: 0; max-height: 170px; overflow: auto; color: #ddd8ed; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; line-height: 1.55; white-space: pre-wrap; }
.tdai-scenes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.tdai-scene { padding: 2px 7px; border: 1px solid #332c45; border-radius: 4px; color: var(--tdai-muted); font-size: 9px; }
.tdai-scene b { color: var(--tdai-accent); font-weight: 500; }
@media (max-width: 700px) { .tdai-profile-body { grid-template-columns: 1fr; } }
.tdai-loading, .tdai-error { padding: 42px 8px; color: var(--tdai-muted); font-size: 12px; text-align: center; }
.tdai-error button { margin-top: 10px; }
@media (max-width: 900px) {
  .tdai-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tdai-grid, .tdai-grid.tdai-lower { grid-template-columns: minmax(0, 1fr); }
  .tdai-header { align-items: flex-start; flex-direction: column; }
}
`
