import { memoryYear, memoryMetric, readCompleteGlobalMemory, createMemorySettingsMutation, memoryDayPresentation, type MemoryDay, type MemorySettingsPatch } from './memory-v7-model.js'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { GlobalMemoryItem, GlobalMemoryPage, ReadDashboardAck, ReadDashboardRequest, ReadDashboardResult, UpdateSettingsRequest } from '../remote-contract.js'
import { observeDashboardTheme } from './theme.js'
import { createSettingsReadController } from './settings-read-state.js'

export interface DashboardActions {
  readDashboard: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>
  updateSettingsAck: (request: UpdateSettingsRequest) => Promise<ReadDashboardAck>
  manage: (request: { projectKey: string; operation: string; payload?: Record<string, unknown> }) => Promise<unknown>
}
export interface DashboardProps extends Partial<DashboardActions> {}

export function Dashboard(props: DashboardProps): ReactNode {
  if (!props.readDashboard || !props.updateSettingsAck || !props.manage) return <p role="alert">全局记忆服务不可用，请重新打开设置。</p>
  return <MemoryV7 {...props} readDashboard={props.readDashboard} updateSettingsAck={props.updateSettingsAck} manage={props.manage} />
}

/** Demo v7's normal Settings surface. No project selector or legacy management navigation. */
function MemoryV7(props: DashboardProps & Required<Pick<DashboardActions, 'readDashboard' | 'updateSettingsAck' | 'manage'>>): ReactNode {
  const [view, setView] = useState<'home' | 'library'>('home')
  const [layer, setLayer] = useState<GlobalMemoryItem['layer']>('L1')
  const [approvalFilter, setApprovalFilter] = useState<'approved' | 'candidate'>('approved')
  const [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | undefined>()
  const [related, setRelated] = useState<{ items: GlobalMemoryItem[]; complete: boolean; next?: string } | undefined>()
  const [relatedError, setRelatedError] = useState('')
  const [scene, setScene] = useState<{ projectKey: string; name: string } | undefined>()
  const [data, setData] = useState<GlobalMemoryPage | undefined>()
  const [detail, setDetail] = useState<GlobalMemoryItem | undefined>()
  const [settings, setSettings] = useState(false), [confirm, setConfirm] = useState(false)
  const [switches, setSwitches] = useState<{ generateMemory: boolean; useMemory: boolean } | undefined>()
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false)
  const [readProgress, setReadProgress] = useState(0)
  const [complete, setComplete] = useState(false), [error, setError] = useState('')
  const [revision, setRevision] = useState(0), [page, setPage] = useState(0)
  const [day, setDay] = useState<{ cell: MemoryDay; index: number } | undefined>()
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [character, setCharacter] = useState<{ enabled: boolean; description: string }>()
  const [characterDraft, setCharacterDraft] = useState(''), [characterError, setCharacterError] = useState('')
  const [extractionRoute, setExtractionRoute] = useState<string>()
  const loadedScope = useRef<{ filter: string; transport: DashboardActions['readDashboard'] } | undefined>()
  const settingsMutation = useRef<ReturnType<typeof createMemorySettingsMutation> | undefined>()
  const savingNow = useRef(false)
  const [theme, setTheme] = useState<'light' | 'dark' | undefined>()
  const root = useRef<HTMLElement | null>(null), returnKey = useRef<string | undefined>()
  const mounted = useRef(true), mutation = useRef(0)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const year = new Date().getFullYear()
  const contentFilter = JSON.stringify([view, layer, approvalFilter, search, scene, year, zone])
  useLayoutEffect(() => {
    if (root.current === null) return
    return observeDashboardTheme(root.current, setTheme)
  }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mutation.current += 1 } }, [])
  useEffect(() => {
    const controller = createMemorySettingsMutation({ readDashboard: props.readDashboard, updateSettingsAck: props.updateSettingsAck })
    settingsMutation.current = controller; savingNow.current = false; setSaving(false); setSettingsFailed(false)
    setSwitches(undefined)
    return () => { controller.dispose(); settingsMutation.current = undefined; mutation.current += 1; savingNow.current = false }
  }, [props.readDashboard, props.updateSettingsAck])
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(0) }, 200); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    if (!settings) return
    const controller = createSettingsReadController({ readDashboard: props.readDashboard })
    const token = mutation.current
    setCharacter(undefined)
    setExtractionRoute(undefined)
    setCharacterError('')
    void controller.startRead().promise.then((result) => {
      if (!controller.isActive() || token !== mutation.current || savingNow.current) return
      if (result.kind !== 'applied' || typeof result.settings.characterEnabled !== 'boolean' || typeof result.settings.characterDescription !== 'string') {
        setCharacterError('角色设置读取失败，请重新打开设置。'); return
      }
      setCharacter({ enabled: result.settings.characterEnabled, description: result.settings.characterDescription })
      setCharacterDraft(result.settings.characterDescription)
      const { extractionProvider: provider, extractionModel: model } = result.settings
      setExtractionRoute(provider && model ? provider === 'deepseek-account' && model === 'deepseek-flash'
        ? 'DeepSeek Flash' : `${provider} / ${model}` : '跟随会话模型')
    })
    return () => controller.dispose()
  }, [settings, props.readDashboard, revision])
  useEffect(() => {
    let cancelled = false
    const readMutation = mutation.current
    setLoading(true); setReadProgress(0); setError(''); setDetail(undefined); setDay(undefined); setPage(0)
    // Retain the same view during refresh; a different scope/transport never displays old records.
    if (loadedScope.current?.filter !== contentFilter || loadedScope.current?.transport !== props.readDashboard) setData(undefined)
    void readCompleteGlobalMemory(props.readDashboard, { version: 1, action: 'global', layer: view === 'home' ? 'home' : layer,
      query: view === 'home' ? '' : search, year, timeZone: zone,
      ...(view === 'library' && layer === 'L1' ? { status: approvalFilter } : {}), ...(view === 'library' && scene ? { scene } : {}) }, () => cancelled,
      (result) => { if (!cancelled && readMutation === mutation.current && result.global) setReadProgress(Object.values(result.global.counts).reduce((sum, metric) => sum + (metric.value ?? 0), 0)) })
      .then((result) => {
        if (cancelled || readMutation !== mutation.current || !result?.global) return
        setData(result.global); loadedScope.current = { filter: contentFilter, transport: props.readDashboard }
        if (!savingNow.current && !settingsMutation.current?.hasFailed()) setSwitches({ generateMemory: result.global.generateMemory, useMemory: result.global.useMemory })
        setComplete(result.complete); setLoading(false)
      }).catch((cause: unknown) => { if (!cancelled && readMutation === mutation.current) {
        setData(undefined); setLoading(false)
        const message = cause instanceof Error ? cause.message : ''
        setError(/^(结果较多|读取范围过大|读取进度|读取资源)/u.test(message) ? message : '读取未完成，记忆可能正在更新，请重新读取。')
      } })
    return () => { cancelled = true }
  }, [props.readDashboard, props.updateSettingsAck, view, layer, approvalFilter, search, scene, revision, year, zone, contentFilter])
  useEffect(() => {
    let cancelled = false
    setRelated(undefined); setRelatedError('')
    const item = data?.items.find((row) => row.key === expanded && row.layer === 'L2')
    if (item) void readCompleteGlobalMemory(props.readDashboard, { version: 1, action: 'global', layer: 'L1', query: '',
      year, timeZone: zone, scene: { projectKey: item.projectKey, name: item.scene ?? item.id } }, () => cancelled)
      .then((answer) => { if (!cancelled && answer?.global) setRelated({ items: answer.global.items, complete: answer.complete, next: answer.global.next }) })
      .catch(() => { if (!cancelled) setRelatedError('关联记忆读取未完成') })
    return () => { cancelled = true }
  }, [expanded, data, props.readDashboard, year, zone])
  useLayoutEffect(() => {
    if (detail || returnKey.current === undefined) return
    const key = returnKey.current; returnKey.current = undefined
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[data-memory-key]') ?? [])].find((element) => element.dataset.memoryKey === key)
    ;(target ?? root.current)?.focus({ preventScroll: true })
  }, [detail])
  const open = (item: GlobalMemoryItem): void => { returnKey.current = item.key; setConfirm(false); setDetail(item); setError('') }
  const library = (next: GlobalMemoryItem['layer'], status: 'approved' | 'candidate' = 'approved'): void => {
    setApprovalFilter(status)
    setExpanded(undefined); setScene(undefined); setQuery(''); setSearch(''); setLayer(next); setView('library'); setDetail(undefined)
  }
  const saveSwitch = async (key?: 'generateMemory' | 'useMemory', patch?: MemorySettingsPatch): Promise<void> => {
    const controller = settingsMutation.current
    if (!controller || savingNow.current || key !== undefined && (loading || !switches || controller.hasFailed())) return
    const token = ++mutation.current
    savingNow.current = true; setSaving(true); setError('')
    try {
      const outcome = await (patch !== undefined ? controller.save(patch) : key === undefined ? controller.retry() : controller.save(
        key === 'generateMemory' ? { generateMemory: !switches!.generateMemory } : { useMemory: !switches!.useMemory }))
      if (!mounted.current || token !== mutation.current || controller !== settingsMutation.current) return
      if (outcome.kind === 'saved') {
        setSwitches(outcome.settings)
        if (typeof outcome.settings.characterEnabled === 'boolean' && typeof outcome.settings.characterDescription === 'string') {
          setCharacter({ enabled: outcome.settings.characterEnabled, description: outcome.settings.characterDescription })
          setCharacterDraft(outcome.settings.characterDescription)
        }
        setData((old) => old ? { ...old, generateMemory: outcome.settings.generateMemory, useMemory: outcome.settings.useMemory } : old)
      }
      setSettingsFailed(controller.hasFailed())
    } finally {
      if (mounted.current && token === mutation.current && controller === settingsMutation.current) {
        mutation.current += 1 // Read responses issued before the confirmed save cannot restore old switches.
        savingNow.current = false; setSaving(false); setRevision((n) => n + 1)
      }
    }
  }
  const review = async (action: 'approve' | 'forget'): Promise<void> => {
    if (!detail || detail.layer !== 'L1' || savingNow.current) return
    const token = ++mutation.current
    savingNow.current = true; setSaving(true); setError('')
    try {
      const answer = await props.manage({ projectKey: detail.projectKey, operation: action === 'forget' ? 'v7.forget' : 'v7.approve',
        payload: { layer: detail.layer, id: detail.id, updatedAt: detail.updatedAt, revision: detail.revision, confirmed: true } }) as { data?: { applied?: boolean }; applied?: boolean }
      if ((answer.data ?? answer).applied !== true) throw new Error('not confirmed')
      if (mounted.current && token === mutation.current) { setDetail(undefined); setConfirm(false); setRevision((n) => n + 1) }
    } catch { if (mounted.current && token === mutation.current) setError('操作未确认完成，请重新读取确认；已生效的操作不会回滚。') }
    finally { if (mounted.current && token === mutation.current) { savingNow.current = false; setSaving(false) } }
  }
  const validDate = (at?: number): Date | undefined => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000 ? new Date(at) : undefined
  const dateText = (at?: number): string => validDate(at)?.toLocaleString() ?? '时间不可用'
  const title = (item: GlobalMemoryItem): string => item.layer === 'L2' ? item.scene ?? item.id : item.content.trim().split('\n')[0]?.slice(0, 90) || '无正文'
  const layerNames = { L0: '原始对话', L1: '提炼记忆', L2: '场景索引', L3: '画像' }
  const pauseLabels = { generation_disabled: '自动生成已关闭', capture_disabled: '对话采集已关闭',
    extraction_disabled: '提炼已关闭' }
  const pauseText = data?.pauseReasons?.map((reason) => pauseLabels[reason]).join('；')
  const calendar = memoryYear(year, zone, data?.days ?? [], data?.activityComplete ?? false)
  const dayTip = day && memoryDayPresentation(day.cell, day.index, calendar.firstWeekday, calendar.weeks)
  const rows = (items: GlobalMemoryItem[]): ReactNode => <div className="mv7-rows">{items.map((item) =>
    <div key={`${item.layer}:${item.key}`}>
    <button type="button" data-memory-key={item.key} className="mv7-row" aria-expanded={item.layer === 'L2' ? expanded === item.key : undefined}
      disabled={loading} onClick={() => item.layer === 'L2' ? setExpanded((old) => old === item.key ? undefined : item.key) : open(item)}>
      <span className="mv7-row-icon" aria-hidden="true">{item.layer === 'L0' ? '◌' : item.layer === 'L2' ? '▱' : '◇'}</span>
      <span className="mv7-row-text"><strong>{title(item)}</strong><small>{item.content.replace(/\s+/g, ' ').slice(0, 160)}</small></span>
      <time dateTime={validDate(item.updatedAt)?.toISOString()}>{validDate(item.updatedAt)?.toLocaleDateString() ?? '时间不可用'}</time><span aria-hidden="true">›</span>
    </button>
    {item.layer === 'L2' && expanded === item.key && <div className="mv7-inline" role="region" aria-label={`${title(item)}关联记忆`}>
      <p>{item.content}</p>{relatedError ? <p role="alert">{relatedError}</p> : related ? <>{rows(related.items)}
        {!related.complete && <p className="mv7-muted">部分关联来源暂时无法核验。</p>}</> : <p role="status">正在读取关联记忆…</p>}
    </div>}</div>)}</div>
  return <section className="tdai-root mv7" ref={root} onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); setConfirm(false); setDay(undefined); setExpanded(undefined)
      if (detail) setDetail(undefined); else if (query) { setQuery(''); setSearch('') } else setSettings(false)
    }} data-tdai-theme={theme} tabIndex={-1} aria-label="全局记忆" aria-busy={loading}>
    <style>{MEMORY_V7_CSS}</style>
    {detail ? <>
      <button type="button" className="mv7-back" onClick={() => { setDetail(undefined); setConfirm(false) }}>‹ 返回{view === 'home' ? '首页' : '记忆库'}</button>
      <h2>{title(detail)}</h2><p className="mv7-muted">{detail.layer} · {dateText(detail.updatedAt)} 更新</p>
      <div className="mv7-body">{detail.content}</div>
      <details className="mv7-sources"><summary>来源与更新</summary>
        <p>来源项目：{detail.projectKey}（来源标识）</p><p>更新于：{dateText(detail.updatedAt)}</p>
        {detail.sources.map((source) => <p key={source.id}>会话：{source.sessionId ?? '不可用'}<br />来源：{source.id}<br />时间：{dateText(source.createdAt)}</p>)}
        {!detail.sourcesComplete && <p className="mv7-muted">来源信息不完整；缺失的会话名称或时间不会推测补全。</p>}
      </details>
      {detail.memory?.status === 'candidate' && <div className="mv7-confirm"><p>待确认记忆暂不参与对话召回。请核对原话和已有约定；启用不会自动覆盖旧记忆。</p><button type="button" disabled={saving} onClick={() => void review('approve')}>确认并启用</button></div>}
      {detail.layer === 'L1' && (!confirm ? <button type="button" className="mv7-forget" onClick={() => setConfirm(true)}>遗忘</button> : <div className="mv7-confirm" role="group" aria-label="确认遗忘">
        <p>确认遗忘这条记忆？之后的对话不再使用这些内容，相关派生内容也会失效。</p>
        <button type="button" disabled={saving} onClick={() => void review('forget')}>确认遗忘</button><button type="button" disabled={saving} onClick={() => setConfirm(false)}>取消</button>
      </div>)}
    </> : view === 'home' ? <>
      <header className="mv7-header"><h2>全局记忆</h2><div><button type="button" disabled={loading || saving} aria-label="刷新记忆" onClick={() => setRevision(value => value + 1)}>刷新</button><button type="button" aria-label="记忆设置" aria-expanded={settings} onClick={() => setSettings((old) => !old)}>⚙</button></div></header>
      {settings && <div className="mv7-settings">
        {(['generateMemory', 'useMemory'] as const).map((key) => <label key={key}><span>{key === 'generateMemory' ? '自动生成记忆' : '在对话中使用记忆'}</span>
          <button type="button" role="switch" aria-checked={switches?.[key] ?? false} aria-label={key === 'generateMemory' ? '自动生成记忆' : '在对话中使用记忆'} disabled={!data || loading || saving || settingsFailed} onClick={() => void saveSwitch(key)}><span /></button></label>)}
        <label><span>稳定角色底色</span><button type="button" role="switch" aria-label="稳定角色底色" aria-checked={character?.enabled ?? false}
          disabled={!character || saving || settingsFailed || !!characterError}
          onClick={() => void saveSwitch(undefined, { characterEnabled: !character!.enabled })}><span /></button></label>
        <div><label htmlFor="memory-character-description">角色描述</label>
          <textarea id="memory-character-description" className="mv7-search" rows={3} maxLength={400} value={characterDraft}
            placeholder="坦率、耐心、有判断，表达自然，适度幽默" disabled={!character || saving || settingsFailed || !!characterError}
            onChange={(event) => setCharacterDraft(event.currentTarget.value)} />
          <p className="mv7-muted">留空使用建议底色；沟通偏好随记忆学习，当前要求优先。</p>
          <button type="button" disabled={!character || saving || settingsFailed || !!characterError || characterDraft.trim() === character.description}
            onClick={() => void saveSwitch(undefined, { characterDescription: characterDraft.trim() })}>保存角色描述</button>
        </div>
        {characterError && <p role="alert">{characterError}</p>}
        <p className="mv7-muted">后台提炼模型：{extractionRoute ?? '尚未读取'}。对话模型独立选择。</p>
        <p className="mv7-muted">不设插件每日配额；按相关性召回，提炼调用仍记录实际用量。</p>
      </div>}
      <div className="mv7-status"><span>{loading ? '正在读取…' : !data ? '状态不可用' : !data.generateMemory ? '自动记忆已关闭' : data.paused ? '自动记忆已暂停' : '自动记忆已启用'}</span><button type="button" onClick={() => library('L1')}>查看全部 ›</button></div>
      {pauseText && <p className="mv7-pause" role="status">{pauseText} <button type="button" onClick={() => setSettings(true)}>查看设置</button></p>}
      <div className="mv7-stats">{(['L0', 'L1', 'L2', 'L3'] as const).map((key) => <button type="button" key={key} onClick={() => library(key)}><span>{key} {layerNames[key]}</span><strong>{loading ? '—' : memoryMetric(data?.counts[key])}<small>{key === 'L2' ? '组' : key === 'L3' ? '份' : '条'}</small></strong></button>)}</div>
      {!loading && data && <p className="mv7-muted">{complete ? '全局统计已完成。' : '本次仅确认了部分来源，≥ 表示已确认的至少数量。可点击刷新重新核验。'}</p>}
      {!loading && !!data?.processing?.pendingApproval && <div className="mv7-review">
        <button type="button" onClick={() => library('L1', 'candidate')}>查看待确认记忆（{complete ? '' : '≥ '}{data.processing.pendingApproval} 条）</button>
        <p className="mv7-muted">这些记忆已提炼，确认启用后才会用于对话。</p>
      </div>}
      {!loading && data?.processing && <details className="mv7-processing">
        <summary>提炼状态与历史记录</summary>
        <p>待提炼：{complete ? '' : '至少 '}{data.processing.queued} 个任务。等待满足提炼条件，不代表正在调用模型。</p>
        <p>历史失败：{complete ? '' : '至少 '}{data.processing.failed} 个任务；历史结果未确认：{complete ? '' : '至少 '}{data.processing.uncertain} 个任务。</p>
        {!!data.processing.uncertain && <p>“结果未确认”指旧调用可能已经发出，但没有保存可确认的结果，不是等待你审核的记忆。</p>}
        {data.processing.latestIssue && <p>最近一次历史问题：{data.processing.latestIssue}。</p>}
        {!!(data.processing.failed || data.processing.uncertain) && <p>这些记录不代表当前正在报错。为避免重复计费，失败或结果未确认的旧任务没有自动重发。</p>}
      </details>}
      <div className="mv7-activity"><div className="mv7-header"><h3>记忆活动</h3><span className="mv7-muted">{year} 年</span></div>
        <div className="mv7-heatmap-stage">
          {dayTip && <div className="mv7-tooltip" role="tooltip" data-edge={dayTip.edge} style={{ left: `${dayTip.x}%` }}>{dayTip.text}</div>}
          <div className="mv7-calendar" style={{ gridTemplateColumns: `repeat(${calendar.weeks}, minmax(0, 1fr))` }} role="group" aria-label="全年新增与更新的记忆记录">
            {calendar.grid.map((cell, slot) => {
              if (cell === null) return <span key={`pad-${slot}`} aria-hidden="true" data-padding="true" />
              const index = slot - calendar.firstWeekday
              const presentation = memoryDayPresentation(cell, index, calendar.firstWeekday, calendar.weeks)
              return <button key={cell.date} type="button" disabled={cell.future} data-day={cell.date}
                data-level={presentation.level} data-unknown={!cell.known} aria-label={presentation.text}
                onMouseEnter={() => setDay({ cell, index })} onMouseLeave={() => setDay(undefined)} onFocus={() => setDay({ cell, index })} onBlur={() => setDay(undefined)} onClick={() => setDay({ cell, index })}
                onKeyDown={(event) => { const delta = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[event.key]; if (delta === undefined) return; event.preventDefault();
                  const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-day]') ?? [])], position = buttons.indexOf(event.currentTarget)
                  buttons[Math.max(0, Math.min(buttons.length - 1, position + delta))]?.focus() }} />
            })}
          </div>
        </div>
        <div className="mv7-months" style={{ gridTemplateColumns: `repeat(${calendar.weeks}, minmax(0, 1fr))` }} aria-hidden="true">{calendar.months.map((month) => <span key={month.month} style={{ gridColumn: `${month.column} / span ${month.span}` }}>{month.month}月</span>)}</div>
        <p className="mv7-muted">近 30 天新增 {memoryMetric(data?.recentAdded)} 条</p>
      </div>
      <details className="mv7-recent"><summary>最近活动</summary>{data?.items.length ? rows(data.items) : <p className="mv7-muted">{loading ? '正在读取…' : complete ? '暂无记忆活动' : '尚无可确认的活动'}</p>}</details>
    </> : <>
      <button type="button" className="mv7-back" onClick={() => { setView('home'); setScene(undefined); setQuery(''); setSearch('') }}>‹ 返回首页</button>
      <header className="mv7-header"><h2>记忆库</h2><span className="mv7-muted">全局共享</span></header>
      <div className="mv7-tabs" role="tablist" aria-label="记忆层级">{(['L0', 'L1', 'L2', 'L3'] as const).map((key) => <button type="button" key={key} role="tab" aria-selected={key === layer} onClick={() => library(key)}>{key} {layerNames[key]}</button>)}</div>
      {layer === 'L1' && <div className="mv7-tabs" role="group" aria-label="记忆状态"><button type="button" aria-pressed={approvalFilter === 'approved'} onClick={() => setApprovalFilter('approved')}>可用记忆</button><button type="button" aria-pressed={approvalFilter === 'candidate'} onClick={() => setApprovalFilter('candidate')}>待确认记忆</button></div>}
      <div className="mv7-search-wrap"><input className="mv7-search" aria-label="搜索记忆" type="search" placeholder="搜索记忆…" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); setSearch(''); root.current?.querySelector<HTMLInputElement>('.mv7-search')?.focus() }}>×</button>}</div>
      {scene && <p className="mv7-muted">场景：{scene.name} <button type="button" onClick={() => setScene(undefined)}>查看全部</button></p>}
      <p className="mv7-muted">{complete ? '总数' : '可确认数量'}：{loading ? '—' : memoryMetric(data?.counts[layer])} {layerNames[layer]}</p>
      {data?.items.length ? rows(data.items.slice(page * 12, page * 12 + 12)) : !loading && !error && <p>{search ? complete ? '没有匹配结果' : '已读取部分没有匹配结果' : complete ? '暂无记录' : '尚无可确认的记录'}</p>}
      {data && data.items.length > 12 && <nav className="mv7-pagination" aria-label="列表分页"><button type="button" disabled={page === 0} onClick={() => setPage((old) => old - 1)}>上一页</button><span>{page + 1} / {Math.ceil(data.items.length / 12)}</span><button type="button" disabled={(page + 1) * 12 >= data.items.length} onClick={() => setPage((old) => old + 1)}>下一页</button></nav>}
    </>}
    {loading && !detail && <p className="mv7-loading" role="status">正在自动读取全局记忆…已确认 {readProgress} 条</p>}
    {!loading && data && !complete && !detail && view === 'library' && <p className="mv7-muted" role="status">本次仅确认了部分来源，≥ 表示已确认的至少数量。<button type="button" disabled={saving} onClick={() => setRevision((old) => old + 1)}>重新核验</button></p>}
    {settingsFailed && <div className="mv7-error" role="alert">设置尚未确认保存，当前设置保持已确认值。<button type="button" disabled={saving} onClick={() => void saveSwitch()}>重试保存</button></div>}
    {error && <div className="mv7-error" role="alert">{error} <button type="button" disabled={saving} onClick={() => setRevision((old) => old + 1)}>重新读取</button></div>}
  </section>
}

const MEMORY_V7_CSS = `
.mv7{container-type:inline-size;container-name:memory-v7;--mv-bg:#222323;--mv-panel:#2a2b2d;--mv-text:#f0f1f2;--mv-muted:#a2a6ae;--mv-line:#3c3e41;--mv-accent:#8b9ffd;--mv-cell:#303236;color:var(--mv-text);background:var(--mv-bg);height:auto;width:100%;max-width:none;min-width:0;box-sizing:border-box;padding:20px 22px;overflow:visible;line-height:1.55;font:inherit;color-scheme:dark;}
.mv7-review{margin:12px 0}.mv7-review button{padding-left:0}.mv7-review p{margin:3px 0}.mv7-processing{color:var(--mv-muted);font-size:12px;margin:12px 0 20px;overflow-wrap:anywhere}.mv7-processing p{margin:8px 0}
.mv7[data-tdai-theme="light"]{--mv-bg:#fff;--mv-panel:#f3f4f6;--mv-text:#20242a;--mv-muted:#626b78;--mv-line:#e1e4e8;--mv-accent:#5265d0;--mv-cell:#f3f4f5;color-scheme:light;}
@media(prefers-color-scheme:light){.mv7:not([data-tdai-theme]){--mv-bg:#fff;--mv-panel:#f3f4f6;--mv-text:#20242a;--mv-muted:#626b78;--mv-line:#e1e4e8;--mv-accent:#5265d0;--mv-cell:#f3f4f5;color-scheme:light;}}
.mv7 *{box-sizing:border-box;min-width:0}.mv7 h2{font-size:20px;font-weight:500;margin:0 0 10px;overflow-wrap:anywhere}.mv7 h3{font-size:14px;font-weight:500;margin:0}.mv7 button{font:inherit;color:inherit;background:transparent;border:0;border-radius:5px;cursor:pointer;padding:6px 8px}.mv7 button:disabled{cursor:default;opacity:.45}.mv7 :focus-visible{outline:2px solid var(--mv-accent);outline-offset:3px}.mv7-header,.mv7-status{display:flex;align-items:center;justify-content:space-between;gap:12px}.mv7-header{margin-bottom:16px}.mv7-header h2{margin:0}.mv7-muted,.mv7-status{color:var(--mv-muted);font-size:12px}.mv7-status{margin:24px 0 20px}.mv7-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:24px}.mv7-stats>button{text-align:left;border-radius:0;padding:0 14px;border-right:1px solid var(--mv-line)}.mv7-stats>button:first-child{padding-left:0}.mv7-stats>button:last-child{border:0}.mv7-stats span{font-size:11px;color:var(--mv-muted);display:block;white-space:nowrap}.mv7-stats strong{font-size:28px;font-weight:400;display:block;margin-top:8px;font-variant-numeric:tabular-nums}.mv7-stats small{font-size:10px;margin-left:3px}.mv7-activity{padding:20px 0;border-top:1px solid var(--mv-line)}.mv7-heatmap-stage{position:relative;margin-top:28px}.mv7-calendar{display:grid;grid-template-rows:repeat(7,minmax(0,1fr));grid-auto-flow:column;gap:3px;width:100%}.mv7-calendar button,.mv7-calendar>span{aspect-ratio:1;padding:0;border-radius:2px;min-height:0;min-width:0;width:100%;background:var(--dsw-alias-bg-skeleton,var(--mv-cell))}.mv7-calendar>span{background:var(--mv-cell);opacity:.65}
.mv7-calendar{--mv-particle:var(--dsw-alias-state-business-primary,#0f766e)}
.mv7-calendar button[data-level="1"]{background:color-mix(in srgb,var(--mv-particle) 20%,var(--mv-bg));background:oklch(from var(--mv-particle) .89 calc(c * .35) h)}
.mv7-calendar button[data-level="2"]{background:color-mix(in srgb,var(--mv-particle) 40%,var(--mv-bg));background:oklch(from var(--mv-particle) .78 calc(c * .55) h)}
.mv7-calendar button[data-level="3"]{background:color-mix(in srgb,var(--mv-particle) 60%,var(--mv-bg));background:oklch(from var(--mv-particle) .67 calc(c * .75) h)}
.mv7-calendar button[data-level="4"]{background:color-mix(in srgb,var(--mv-particle) 80%,var(--mv-bg));background:oklch(from var(--mv-particle) .56 calc(c * .9) h)}
.mv7-calendar button[data-level="5"]{background:var(--mv-particle);background:oklch(from var(--mv-particle) .45 c h)}
.mv7-calendar button[data-unknown="true"][data-level="0"]{background:repeating-linear-gradient(135deg,var(--mv-cell),var(--mv-cell) 2px,var(--mv-line) 2px,var(--mv-line) 3px);box-shadow:inset 0 0 0 1px var(--mv-line)}
.mv7-months{display:grid;gap:3px;color:var(--mv-muted);font-size:9px;line-height:14px;margin-top:7px}.mv7-months span{overflow:hidden;white-space:nowrap}
.mv7-tooltip{position:absolute;z-index:2;bottom:calc(100% + 6px);left:50%!important;width:calc(100% - 8px);max-width:480px;min-height:46px;transform:translateX(-50%);border-radius:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-3,var(--mv-panel));box-shadow:var(--dsw-shadow-lv1,0 2px 8px #0002);color:var(--mv-text);font-size:11px;line-height:18px;pointer-events:none;white-space:normal;overflow-wrap:anywhere}
.mv7-inline{padding:4px 12px 12px;background:var(--mv-panel);font-size:12px}.mv7-search-wrap{position:relative}.mv7-search-wrap input{padding-right:38px}.mv7-search-wrap>button{position:absolute;right:4px;top:2px}.mv7-recent,.mv7-sources{padding-top:18px;border-top:1px solid var(--mv-line)}.mv7 summary{cursor:pointer;font-size:13px;color:var(--mv-muted);padding:5px 0}.mv7-settings{border-block:1px solid var(--mv-line);padding:10px 0}.mv7-settings label{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;font-size:14px}.mv7 [role="switch"]{padding:3px;width:36px;height:21px;background:var(--mv-line);border-radius:15px;flex:none}.mv7 [role="switch"]>span{display:block;width:15px;height:15px;background:var(--mv-muted);border-radius:50%}.mv7 [role="switch"][aria-checked="true"]{background:var(--mv-text)}.mv7 [role="switch"][aria-checked="true"]>span{margin-left:15px;background:var(--mv-bg)}.mv7-back{font-size:12px!important;padding-left:0!important;margin-bottom:14px;color:var(--mv-muted)!important}.mv7-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;background:var(--mv-panel);padding:3px;border-radius:8px;margin-bottom:12px}.mv7-tabs button{font-size:12px;height:34px;padding:5px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mv7-tabs [aria-selected="true"]{background:var(--mv-line)}.mv7-search{display:block;width:100%;background:var(--mv-panel);border:1px solid transparent;border-radius:7px;padding:9px 12px;color:var(--mv-text);font:inherit;font-size:13px}.mv7-row{display:flex!important;align-items:center;gap:10px;width:100%;text-align:left;border-radius:0!important;border-top:1px solid var(--mv-line)!important;padding:13px 0!important}.mv7-row-icon{padding:4px 7px;background:var(--mv-panel);border-radius:7px;flex:none}.mv7-row-text{flex:1;overflow:hidden}.mv7-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;font-size:13px}.mv7-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--mv-muted);margin-top:3px}.mv7-row time{font-size:10px;color:var(--mv-muted);flex:none}.mv7-body{white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;background:var(--mv-panel);padding:20px;margin:24px 0;font-size:14px}.mv7-sources{margin:24px 0;font-size:12px;overflow-wrap:anywhere}.mv7-forget{color:#d98888!important}.mv7-confirm{background:var(--mv-panel);border-radius:8px;padding:12px;font-size:13px}.mv7-error{color:#db8585;font-size:13px;padding-top:16px}.mv7-pagination{display:flex;align-items:center;justify-content:center;gap:16px;font-size:12px;padding:12px 0}
.mv7-pause{font-size:12px;color:var(--mv-muted);padding:10px 12px;background:var(--mv-panel);border-radius:8px;margin:-8px 0 20px;overflow-wrap:anywhere}.mv7-pause button{font-size:12px;color:var(--mv-accent)}.mv7-loading{min-height:120px;border-radius:8px;background:var(--mv-panel);padding:20px;color:var(--mv-muted);font-size:13px}.mv7-calendar button:disabled[data-level="0"]{opacity:1;background:var(--mv-cell)}
@container memory-v7 (max-width:320px){.mv7-tabs button{font-size:10px}}
@media(max-width:480px){.mv7{padding:16px 10px}.mv7-stats>button{padding:0 7px}.mv7-stats span{font-size:9px}.mv7-stats strong{font-size:22px}.mv7-tabs button{font-size:10px}.mv7-calendar{gap:2px}.mv7-months{font-size:8px;gap:2px}.mv7-row time{display:none}.mv7-body{padding:14px}}
`
