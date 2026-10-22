/**
 * Cheap, conservative token estimator for memory-injection budgets.
 *
 * Provider tokenizers differ, so this is intentionally approximate: one token
 * per CJK character and roughly one token per four non-CJK characters. The
 * budget is a guardrail, not billing truth.
 *
 * @module dsh-memory-tdai/tokens
 */

export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk += 1
    else other += 1
  }
  return Math.max(1, cjk + Math.ceil(other / 4))
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  let out = ''
  for (const char of text) {
    if (estimateTokens(out + char) > maxTokens - 1) break
    out += char
  }
  return `${out}…`
}
