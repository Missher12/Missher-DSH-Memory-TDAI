/**
 * Development-only static render of the Settings dashboard with synthetic data.
 * It is not part of the plugin package; it exists to verify layout and styling.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Dashboard } from '../src/client/Dashboard'
import type { DashboardSnapshot, MemoryView } from '../src/remote-contract'

const today = new Date()
const activity = [] as DashboardSnapshot['activity']
for (let offset = 364; offset >= 0; offset -= 1) {
  const date = new Date(today)
  date.setDate(today.getDate() - offset)
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const wave = Math.max(0, Math.round(Math.sin(offset / 11) * 3 + Math.cos(offset / 5) * 2 + (offset < 90 ? 2 : 0)))
  activity.push({ date: key, captures: wave + (offset % 7 === 0 ? 4 : 0), memories: Math.max(0, wave - 1), recalls: offset % 13 === 0 ? 3 : 0 })
}

const memory = (id: string, content: string, kind: string, confidence: number, status: 'candidate' | 'approved', projectName = 'deepseek-plug'): MemoryView => ({
  id,
  content,
  kind,
  confidence,
  status,
  source: 'extraction',
  sourceMessageIds: ['u_alpha'],
  createdAt: Date.now() - 86_400_000 * 3,
  updatedAt: Date.now() - 86_400_000,
  projectKey: 'deepseek-plug-55d6866c33af',
  projectName,
})

const candidates: MemoryView[] = [
  memory('mem_c1a7', '用户偏好所有插件使用 TypeScript + ESM，构建产物必须能被 DSH 模块加载器直接消费。', 'preference', 0.71, 'candidate'),
  memory('mem_c2b8', '记忆插件的默认模式应为 balanced：高置信度自动通过，低置信度进入审核。', 'decision', 0.66, 'candidate'),
  memory('mem_c3c9', 'Dashboard 采用暗色终端风、等宽数字、紫色强调色；不复制第三方素材。', 'project', 0.58, 'candidate'),
  memory('mem_c4da', '大工具结果超过 8000 字符时 offload 到本地，模型通过 memory_read_raw 取回。', 'decision', 0.74, 'candidate'),
]
const recent: MemoryView[] = [
  memory('mem_a1f2', '插件状态目录为 $DSH_HOME/memory-tdai，按项目 cwd 的短哈希隔离。', 'project', 0.94, 'approved'),
  memory('mem_b2e3', '注入默认约 220 token，最多 5 条，并在同一会话内去重。', 'decision', 0.91, 'approved'),
  memory('mem_c3d4', 'Windows 使用 Electron Node 24.21 / ABI 149；native 依赖限定为 N-API 或 SQLite 扩展。', 'fact', 0.89, 'approved'),
  memory('mem_d4c5', '中文检索使用 FTS5 + jieba 预分词；FTS5 缺失时回退 LIKE。', 'project', 0.86, 'approved'),
  memory('mem_e5b6', '审核队列支持 approve / forget；遗忘的记忆不会被重复抽取复活。', 'decision', 0.84, 'approved'),
]

const snapshot: DashboardSnapshot = {
  version: 1,
  generatedAt: Date.now(),
  root: 'C:/Users/Missher-R2/.dsh/memory-tdai',
  mode: 'balanced',
  totals: {
    memories: 128,
    approved: 96,
    candidates: 24,
    forgotten: 8,
    sessions: 23,
    projects: 3,
    l0Messages: 1842,
    repeatedQuestions: 6,
    injectedCount: 147,
    injectedTokens: 26_400,
    rawTokens: 91_300,
    savedTokens: 64_900,
  },
  sources: [
    { source: 'extraction', count: 84 },
    { source: 'manual', count: 31 },
    { source: 'import', count: 9 },
    { source: 'tool', count: 4 },
  ],
  activity,
  projects: [
    { key: 'deepseek-plug-55d6866c33af', name: 'deepseek-plug', cwd: 'D:/Deepseek-Plug', memories: 84, approved: 64, candidates: 16, sessions: 14, lastActivity: Date.now() },
    { key: 'media-missher-0a6b8c4d1e2f', name: 'media-missher', cwd: 'D:/Deepseek-Plug/Missher-Media', memories: 31, approved: 23, candidates: 6, sessions: 6, lastActivity: Date.now() - 86_400_000 },
    { key: 'ffacg-9c8b7a6d5e4f', name: 'FFACG-Official', cwd: 'D:/Deepseek-Plug/FFACG-Official', memories: 13, approved: 9, candidates: 2, sessions: 3, lastActivity: Date.now() - 86_400_000 * 4 },
  ],
  candidates,
  recent,
  scenes: [
    { name: 'dsh-plugin-architecture', summary: 'DSH 插件包契约、Cordis 生命周期、Settings slot 与 Typert RPC。', memoryCount: 34, updatedAt: Date.now(), projectKey: 'deepseek-plug-55d6866c33af', projectName: 'deepseek-plug' },
    { name: 'memory-product', summary: '记忆分层、审核优先、token 预算、项目隔离。', memoryCount: 22, updatedAt: Date.now(), projectKey: 'deepseek-plug-55d6866c33af', projectName: 'deepseek-plug' },
    { name: 'windows-runtime', summary: 'Electron ABI 149、N-API、sqlite-vec DLL、FTS5 回退。', memoryCount: 18, updatedAt: Date.now(), projectKey: 'deepseek-plug-55d6866c33af', projectName: 'deepseek-plug' },
    { name: 'media-collection', summary: 'Media@Missher 的采集、证据与导出边界。', memoryCount: 12, updatedAt: Date.now(), projectKey: 'media-missher-0a6b8c4d1e2f', projectName: 'media-missher' },
  ],
  personas: [
    {
      content: '## 核心特征\n一位同时做产品、插件和桌面工具的一人团队负责人，偏好“先方案、再小步交付、最后用证据验收”的节奏。\n\n## 工作方式\n- 默认使用 TypeScript + ESM；插件必须能被 DSH 模块加载器直接消费。\n- 关注跨平台与 Windows Electron 兼容性，拒绝不必要的 native 依赖。\n- 记忆产品优先本地、可审核、可导出；反对不可解释的自动写入。\n- 喜欢暗色终端风仪表盘和等宽数字。',
      sourceCount: 96,
      updatedAt: Date.now() - 3_600_000,
      projectKey: 'deepseek-plug-55d6866c33af',
      projectName: 'deepseek-plug',
    },
  ],
  globalPersona: {
    content: '## 跨项目稳定特征\n本地优先、证据驱动、跨平台；偏好 TypeScript/ESM 与可审核的记忆写入。',
    sourceCount: 140,
    updatedAt: Date.now() - 86_400_000 * 2,
  },
  longestSession: { sessionId: 'session-demo', messages: 38, projectName: 'deepseek-plug' },
  settings: {
    mode: 'balanced',
    recallMaxTokens: 220,
    recallMaxResults: 5,
    dedupeSession: true,
    includePersona: true,
    globalPersona: true,
    extractionEveryN: 3,
    autoApproveConfidence: 0.82,
  },
}

const markup = renderToStaticMarkup(
  <Dashboard
    initialSnapshot={snapshot}
    load={async () => snapshot}
    review={async () => snapshot}
    updateSettings={async () => snapshot}
    exportProject={async () => ({ fileName: 'memory.jsonl', content: '' })}
  />,
)

const dir = path.resolve('preview')
mkdirSync(dir, { recursive: true })
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TDAI Memory — dashboard preview</title>
<style>
  html, body { margin: 0; min-height: 100%; background: #0c0b12; }
  body { padding: 28px; font-family: ui-sans-serif, system-ui, sans-serif; }
  .page { max-width: 1120px; margin: 0 auto; }
  .preview-label { margin: 0 0 12px 2px; color: #6f6880; font: 10px ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; }
</style>
</head>
<body><div class="page"><div class="preview-label">Synthetic preview · real component · not live host data</div>${markup}</div></body>
</html>`
writeFileSync(path.join(dir, 'dashboard.html'), html, 'utf8')
console.log(path.join(dir, 'dashboard.html'))
