import type { ReadDashboardRequest, ReadDashboardResult } from '../remote-contract.js'

type Metric = NonNullable<NonNullable<ReadDashboardResult['usage']>['attempts']>['calls']
type Dimension = NonNullable<ReadDashboardResult['dimensions']>['sources'][number]
type PageProject = NonNullable<ReadDashboardResult['page']>['projects'][number]
type ProjectDirectoryEntry = NonNullable<ReadDashboardResult['projects']>[number]

export type BoundedProjectSummary = Pick<ProjectDirectoryEntry, 'key' | 'name'> & {
  kind: 'bounded'
  forgottenMetric?: PageProject['forgotten']
}

export type BoundedDimensionRow = {
  reactKey: string
  label: string
  countText: string
}

export type BoundedUsageRow = {
  reactKey: string; label: string; countText: string; knownText: string; unknownText: string; unknownIdentityText: string
  fields: Array<{ key: string; label: string; valueText: string; evidenceText: string }>
}

export function metricText(metric: Metric | undefined): string
export function boundedProjectSummaries(result: ReadDashboardResult): BoundedProjectSummary[]
export function boundedDimensionRows(items: readonly Dimension[] | undefined,
  category: 'model' | 'purpose' | 'source' | 'agent' | 'agent_preset' | 'provider'): BoundedDimensionRow[]
type DashboardRange = NonNullable<Extract<ReadDashboardRequest, { action: 'bootstrap' }>['range']>

export function boundedOverviewModel(result: ReadDashboardResult | undefined, activity?: DashboardRange['activity']): {
  current: { effectiveMemories: Metric | undefined; candidates: Metric | undefined }
  period: {
    captures: Metric | undefined; sessions: Metric | undefined; recallRequests: Metric | undefined; recallResults: Metric | undefined
    acceptedRevisions: Metric | undefined; initialApprovals: Metric | undefined
    preparedInjectionEvents: Metric | undefined; preparedInjectionMemories: Metric | undefined
  }
  activity: NonNullable<ReadDashboardResult['activity']>
  captureSources: NonNullable<ReadDashboardResult['scopedDimensions']>['captureSources'] | undefined
  selectedDimensions: NonNullable<ReadDashboardResult['scopedDimensions']>['selected'] | undefined
  sources: NonNullable<ReadDashboardResult['dimensions']>['sources']
  agents: NonNullable<ReadDashboardResult['dimensions']>['agents']
  agentPresets: NonNullable<ReadDashboardResult['dimensions']>['agentPresets']
  providers: NonNullable<ReadDashboardResult['dimensions']>['providers']
  models: NonNullable<ReadDashboardResult['dimensions']>['models']
  attemptsByModel: NonNullable<NonNullable<ReadDashboardResult['usage']>['attempts']>['byModel']
  billableByPurpose: NonNullable<NonNullable<ReadDashboardResult['usage']>['billable']>['byPurpose']
  modelUsageRows: BoundedUsageRow[]; purposeUsageRows: BoundedUsageRow[]
  modelUsageEmptyText: string; purposeUsageEmptyText: string
  coverage: ReadDashboardResult['coverage']
  processing: ReadDashboardResult['processing']
  generatedAt: number | undefined
  complete: boolean
  status: ReadDashboardResult['status'] | undefined
  reason: string | undefined
}


export function boundedEventDetailRequest(input: {
  projectKey: string
  range: DashboardRange
  activity?: DashboardRange['activity']
  dimension: 'source' | 'agent' | 'agent_preset' | 'provider' | 'model'
  value: string
  date: string
}): { range: DashboardRange; request: Omit<Extract<ReadDashboardRequest, { action: 'detail' }>, 'readId'> }
