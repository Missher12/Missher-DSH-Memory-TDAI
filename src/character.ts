/**
 * Stable assistant character + learned communication preferences.
 *
 * This is persisted response guidance, not consciousness, identity, or model
 * fine-tuning. The base character is a user-configured setting; learned
 * preferences are ordinary source-backed L1 records that can only adapt
 * expression, never replace the base or outrank current user instructions.
 *
 * @module dsh-memory-tdai/character
 */

import { estimateTokens } from './tokens.js'

export const DEFAULT_CHARACTER_DESCRIPTION = '坦率、耐心、有判断，表达自然，适度幽默'
/** The exact L1 scene that marks an explicit communication-style preference. */
export const COMMUNICATION_STYLE_SCENE = 'communication-style'
export const MAX_CHARACTER_DESCRIPTION_CHARS = 400
export const MAX_STYLE_ITEMS = 6
export const MAX_STYLE_SCAN_PER_PROJECT = 12
const MAX_STYLE_TOKENS = 160

export interface LearnedStylePreference {
  projectKey: string
  projectName: string
  id: string
  revision: number
  content: string
  updatedAt: number
}

// Only these canonical presentation preferences enter learned guidance. Historical
// prose is evidence for this projection, never copied into a behavior block.
const STYLE_RULES = [
  ['length', '简洁回答', /简洁|简短|精简|短一点|少点废话|\bconcise\b|\bbrief\b/giu, '详细解释'],
  ['length', '详细解释', /详细|详尽|展开解释|\bdetailed\b/giu, '简洁回答'],
  ['directness', '直接表达', /直接(?:一点|些|回答|回复|表达|说)?|\bdirect\b/giu, '委婉表达'],
  ['directness', '委婉表达', /委婉|温和(?:一点|些)?|\bgentle\b/giu, '直接表达'],
  ['formality', '正式表达', /正式(?:一点|些)?|\bformal\b/giu, '自然口语'],
  ['formality', '自然口语', /随和|随意|口语|不那么正式|\bcasual\b/giu, '正式表达'],
  ['humor', '适度幽默', /幽默|开玩笑|\bhumou?r\b/giu, '避免玩笑'],
  ['language', '使用中文沟通', /中文|汉语|\bChinese\b/giu, '避免中文沟通'],
  ['language', '使用英文沟通', /英文|英语|\bEnglish\b/giu, '避免英文沟通'],
  ['structure', '先给结论', /先(?:给|说)?结论|结论在前|\bconclusion first\b/giu, ''],
] as const

export function explicitCommunicationPreferences(texts: string[]): Array<{ dimension: string; content: string }> {
  const preferences = new Map<string, { content: string; at: number }>()
  for (const [index, text] of texts.entries()) {
    if (!/(?:回复|回答|沟通|表达|说话|语气|风格|解释|结论|我.{0,4}(?:喜欢|偏好|希望)|以后|今后|请|\b(?:please|respond|reply|answer|prefer|be)\b)/iu.test(text)) continue
    if (!/(?:请|以后|今后|希望|偏好|喜欢|不要|别|不想|不用|不必|我想要|记住|接下来|从现在起|(?:回复|回答|表达|说话|解释|语气|风格).{0,8}(?:要|应当|应该|必须|尽量|用)|(?:短|详细|简洁|直接|正式|随意|幽默)一点|\b(?:please|prefer|be)\b)/iu.test(text)) continue
    for (const [dimension, positive, pattern, negative] of STYLE_RULES) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const prefix = text.slice(Math.max(0, match.index - 12), match.index)
        const negated = /(?:不要|不想|不喜欢|不需要|别|避免|不用|不必|不那么|不太|\bnot\b|\bno\b|don't)[^，。；！？.!?\n]{0,6}$/iu.test(prefix)
        const content = negated ? negative : positive
        const at = index * 4096 + match.index
        if (content !== '' && at >= (preferences.get(dimension)?.at ?? -1)) preferences.set(dimension, { content, at })
      }
    }
  }
  return [...preferences].map(([dimension, { content }]) => ({ dimension, content }))
}

/**
 * Renders one bounded guidance block. The description is trimmed to fit the
 * budget instead of being dropped, and learned lines are added only while the
 * whole block still fits, so fact recall keeps usable capacity.
 */
export function formatCharacterGuidance(input: {
  description: string
  learned: LearnedStylePreference[]
  maxTokens: number
  maxChars?: number
}): { text: string; usedTokens: number } | undefined {
  let description = input.description.trim().slice(0, MAX_CHARACTER_DESCRIPTION_CHARS)
  const budget = Math.min(MAX_STYLE_TOKENS, Math.floor(input.maxTokens))
  if (!Number.isFinite(budget) || budget < 1) return undefined
  const fits = (text: string): boolean => estimateTokens(text) <= budget &&
    (input.maxChars === undefined || text.length <= input.maxChars)
  const header = '<character-guidance source="tdai">\n' +
    '仅作表达参考，当前指示优先：\n'
  const closing = '\n</character-guidance>'
  const learned = input.learned
    .filter((item) => item.content.trim() !== '' && Number.isSafeInteger(item.revision) && item.revision >= 1)
    .slice(0, MAX_STYLE_ITEMS)
  if (description === '' && learned.length === 0) return undefined

  // The user's own base description is authoritative; trim it into the budget.
  const render = (body: string): string => `${header}${body}${closing}`
  let body = description === '' ? '' : `底色：${description}\n`
  let trimmed = 0
  while (!fits(render(body)) && description.length > 4 && trimmed < 64) {
    const keep = Math.max(4, description.length - Math.max(4, Math.ceil(description.length / 16)))
    if (keep >= description.length) break
    description = `${description.slice(0, keep - 1)}…`
    body = `底色：${description}\n`
    trimmed += 1
  }
  if (!fits(render(body))) return undefined
  if (learned.length > 0) {
    const base = body, grouped = new Map<string, string[]>()
    const preferences = (groups: Map<string, string[]>): string => '沟通偏好：\n' +
      [...groups].map(([source, labels]) => `- [${source}] ${labels.join('；')}\n`).join('')
    for (const item of learned) {
      const source = `${item.id}@r${item.revision}`, candidate = new Map(grouped)
      candidate.set(source, [...new Set([...(grouped.get(source) ?? []), item.content.trim()])])
      if (!fits(render(base + preferences(candidate)))) continue
      grouped.set(source, candidate.get(source)!)
    }
    if (grouped.size > 0) body = base + preferences(grouped)
  }
  const text = render(body)
  if (!fits(text)) return undefined
  return { text, usedTokens: estimateTokens(text) }
}
