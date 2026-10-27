/**
 * Presentation adapters for the bounded dashboard wire contract.
 * Unknown and lower-bound values stay metrics until they reach the label.
 */
export function metricText(metric) {
  if (metric === undefined || metric.relation === 'unknown' || metric.value === null) return '未知'
  return metric.relation === 'exact' ? String(metric.value) : `≥${metric.value}`
}

export function boundedProjectSummaries(result) {
  if (result.page !== undefined) {
    return result.page.projects.map(({ key, name, forgotten }) => ({ kind: 'bounded', key, name, forgottenMetric: forgotten }))
  }
  return (result.projects ?? []).map(({ key, name }) => ({ kind: 'bounded', key, name }))
}

export function boundedDimensionRows(items, category) {
  const dimensions = items ?? []
  return dimensions.map((item, index) => ({
    reactKey: `${category}:${index}:${item.key}`,
    label: item.key === 'other' && dimensions.length === 10 && index === dimensions.length - 1 ? '其他（合并）' : item.key,
    countText: metricText(item.count),
  }))
}

const MODEL_USAGE_FIELDS = [
  ['inputTokens', '输入 Token'], ['outputTokens', '输出 Token'], ['cacheReadTokens', '缓存读取 Token'],
  ['cacheWriteTokens', '缓存写入 Token'], ['reasoningTokens', '推理 Token'], ['costMicros', '记录费用（微单位）'],
]

function usageFieldRow(item, key, label) {
  const field = item[key]
  return { key, label, valueText: metricText(field),
    evidenceText: field === undefined ? '尚无字段记录' :
      `${field.seen} 条有值 · ${field.missing} 条缺失 · ${field.uncertain} 条待核实` }
}

function modelUsageRows(items) {
  return (items ?? []).map((item) => ({
    reactKey: item.key, label: item.other ? '其他模型（合并）' :
      `提供方：${item.provider ?? '未知'} · 模型：${item.model ?? '未知'}`,
    countText: metricText(item.count), knownText: metricText(item.knownCalls), unknownText: metricText(item.unknownCalls),
    unknownIdentityText: metricText(item.unknownIdentityCalls),
    fields: MODEL_USAGE_FIELDS.map(([key, label]) => usageFieldRow(item, key, label)),
  }))
}

function purposeUsageRows(items) {
  return (items ?? []).map((item) => ({
    reactKey: item.key, label: item.other ? '其他用途（合并）' : item.purpose ?? '用途未知',
    countText: metricText(item.count), knownText: metricText(item.knownCalls), unknownText: metricText(item.unknownCalls),
    unknownIdentityText: metricText(item.unknownIdentityCalls),
    fields: [usageFieldRow(item, 'actualTokens', '账本实际 Token')],
  }))
}

function usageEmptyText(calls) {
  return calls?.relation === 'exact' && calls.value === 0 ? '已完整确认此范围没有调用记录。'
    : '当前已读部分暂无分组；未记录不代表零用量。'
}

/** Main overview projection. It keeps every wire metric intact until render. */
export function boundedOverviewModel(result, activity) {
  const dimensions = result?.dimensions
  const scoped = result?.scopedDimensions
  const usage = result?.usage
  return {
    current: {
      effectiveMemories: result?.metrics?.effectiveMemories,
      candidates: result?.metrics?.candidates,
    },
    period: {
      captures: result?.metrics?.captures,
      sessions: result?.metrics?.sessions,
      recallRequests: result?.metrics?.recallRequests,
      recallResults: result?.metrics?.recallResults,
      acceptedRevisions: result?.metrics?.acceptedRevisions,
      initialApprovals: result?.metrics?.initialApprovals,
      preparedInjectionEvents: result?.metrics?.preparedInjectionEvents,
      preparedInjectionMemories: result?.metrics?.preparedInjectionMemories,
    },
    activity: result?.activity ?? [],
    // Never reinterpret legacy all-event groups as capture/selected-activity counts.
    captureSources: scoped?.captureSources,
    selectedDimensions: scoped !== undefined && (activity === undefined || scoped.activity === activity) ? scoped.selected : undefined,
    sources: dimensions?.sources ?? [],
    agents: dimensions?.agents ?? [],
    agentPresets: dimensions?.agentPresets ?? [],
    providers: dimensions?.providers ?? [],
    models: dimensions?.models ?? [],
    attemptsByModel: usage?.attempts.byModel ?? [],
    billableByPurpose: usage?.billable.byPurpose ?? [],
    modelUsageRows: modelUsageRows(usage?.attempts.byModel), purposeUsageRows: purposeUsageRows(usage?.billable.byPurpose),
    modelUsageEmptyText: usageEmptyText(usage?.attempts.calls), purposeUsageEmptyText: usageEmptyText(usage?.billable.calls),
    coverage: result?.coverage,
    processing: result?.processing,
    generatedAt: result?.generatedAt,
    complete: result?.complete === true && result?.status === 'ok',
    status: result?.status,
    reason: result?.reason,
  }
}


/** Shape the actual bounded detail request independently of the overview's selected activity. */
export function boundedEventDetailRequest({ projectKey, range, activity, dimension, value, date }) {
  return {
    range: { ...range, activity: activity ?? range.activity },
    request: { version: 1, action: 'detail', projectKey,
      target: { kind: 'events', dimension: date !== '' ? 'date' : dimension === 'agent_preset' ? 'agentPreset' : dimension,
        value: date !== '' ? date : value } },
  }
}
