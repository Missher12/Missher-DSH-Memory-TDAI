/**
 * Small lifecycle/result helpers shared by the Settings page and overview
 * shortcuts. They contain no React state and are used by Dashboard.tsx.
 */

export function settingsReadId(result) {
  return typeof result?.readId === 'string' && result.readId.length > 0 ? result.readId : undefined
}

export function settingsReadIsCurrent(started, current, mounted) {
  return mounted === true && Number.isSafeInteger(started) && started === current
}

export function isSuccessfulSettingsRead(result) {
  return result?.status === 'ok' && result.complete === true && result.settings !== undefined && result.settings !== null
}

export function settingsReadFailure(result) {
  const reason = typeof result?.reason === 'string' && result.reason !== '' ? `：${result.reason}` : ''
  return `配置读取失败（${typeof result?.status === 'string' ? result.status : 'unknown'}${reason}）`
}

export function isAcceptedSettingsAck(ack) {
  return ack?.ok === true && ack.scope === 'global' && ack.operation === 'settings.update' &&
    (ack.result === 'applied' || ack.result === 'confirmed' || ack.result === 'noop')
}

export function settingsAckMessage(ack) {
  if (isAcceptedSettingsAck(ack)) {
    if (ack.result === 'applied') return '配置已保存'
    if (ack.result === 'confirmed') return '配置已是目标值'
    return '配置无需改变'
  }
  const reason = typeof ack?.reason === 'string' && ack.reason !== '' ? `：${ack.reason}` : ''
  return `配置保存失败（${typeof ack?.result === 'string' ? ack.result : 'invalid-ack'}${reason}）`
}

export function settingsCloseRequest(readId) {
  return { version: 1, action: 'close', readId }
}

export function settingsLastErrorNotice(result) {
  if (result?.lastErrorState === 'present') {
    return typeof result.lastError === 'string' ? result.lastError : '运行时提示存在'
  }
  if (result?.lastErrorState === 'omitted') return '运行时错误详情已省略'
  return undefined
}

export function parseSettingsNumberDraft(raw, minimum, maximum) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { valid: false, reason: 'empty' }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return { valid: false, reason: 'out-of-range' }
  }
  return { valid: true, value }
}

/**
 * One controller per mounted transport/lifecycle. It owns read/save ownership,
 * close-once delivery through the transport that created the reader, and
 * save single-flight. It never touches React state.
 */
export function createSettingsReadController({ readDashboard, updateSettingsAck } = {}) {
  let active = true
  let readRevision = 0
  let latestRead = 0
  let saveRevision = 0
  let latestSave = 0
  let saveActive = false
  const closedReadIds = new Set()

  const closeReader = (transport, readId) => {
    const id = settingsReadId({ readId })
    if (id === undefined || closedReadIds.has(id) || typeof transport !== 'function') return
    closedReadIds.add(id)
    // Cleanup is deliberately separate from business results. A stale or
    // rejected close never changes a save/read outcome and is never retried.
    void Promise.resolve().then(() => transport(settingsCloseRequest(id))).catch(() => {})
  }

  const performRead = async (token, transport) => {
    if (typeof transport !== 'function') return { kind: 'failure', message: '配置读取不可用' }
    try {
      const result = await transport({ version: 1, action: 'settings' })
      closeReader(transport, settingsReadId(result))
      if (!active || token !== latestRead) return { kind: 'ignored' }
      if (!isSuccessfulSettingsRead(result)) return { kind: 'failure', message: settingsReadFailure(result) }
      return { kind: 'applied', settings: result.settings, lastError: settingsLastErrorNotice(result) }
    } catch (error) {
      if (!active || token !== latestRead) return { kind: 'ignored' }
      return { kind: 'failure', message: error instanceof Error ? error.message : '配置读取失败' }
    }
  }

  const issueRead = () => {
    const token = ++readRevision
    latestRead = token
    return { token, promise: performRead(token, readDashboard) }
  }
  const deniedRead = (reason) => ({
    token: undefined,
    promise: Promise.resolve({ kind: 'ignored' }),
    reason,
  })
  // The save-owned read has a separate entry point. It can only be issued
  // while its own save token is active, so external startRead calls cannot
  // preempt the normalized reread.
  const issueSaveRead = (ownerSaveToken) => {
    if (!active || !saveActive || ownerSaveToken !== latestSave) return deniedRead('stale-save')
    return issueRead()
  }

  const api = {
    isActive: () => active,
    isLatestRead: (token) => active && token === latestRead,
    isLatestSave: (token) => active && token === latestSave,
    startRead: () => {
      if (!active) return deniedRead('inactive')
      if (saveActive) return deniedRead('save-in-progress')
      return issueRead()
    },
    startSave: (patch) => {
      if (!active) return { started: false, reason: 'disposed' }
      if (saveActive) return { started: false, reason: 'in-flight' }
      if (typeof updateSettingsAck !== 'function') return { started: false, reason: 'unavailable' }
      saveActive = true
      const token = ++saveRevision
      latestSave = token
      // Invalidate reads that were started before this update. Their own
      // transports still close their readIds when they eventually settle.
      latestRead = ++readRevision
      const transport = updateSettingsAck
      const promise = (async () => {
        try {
          const ack = await transport(patch)
          if (!active || token !== latestSave) return { kind: 'ignored' }
          if (!isAcceptedSettingsAck(ack)) return { kind: 'rejected', message: settingsAckMessage(ack) }
          const acknowledgement = settingsAckMessage(ack)
          const read = issueSaveRead(token)
          const normalized = await read.promise
          if (!active || token !== latestSave) return { kind: 'ignored' }
          if (normalized.kind === 'applied') {
            return { kind: 'saved', acknowledgement, settings: normalized.settings, lastError: normalized.lastError }
          }
          return { kind: 'read-failed', acknowledgement,
            message: normalized.kind === 'failure' ? normalized.message : '配置回读被新的读取替代' }
        } catch (error) {
          if (!active || token !== latestSave) return { kind: 'ignored' }
          return { kind: 'failed', message: error instanceof Error ? error.message : '配置保存失败' }
        } finally {
          if (active && token === latestSave) saveActive = false
        }
      })()
      return { started: true, token, promise }
    },
    dispose: () => { active = false; saveActive = false },
  }
  return api
}
