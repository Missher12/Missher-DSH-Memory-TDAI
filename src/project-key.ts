/**
 * Pure project-key validation shared by the RPC boundary and the store path
 * builder.
 *
 * This module must stay free of Node.js imports: it is also bundled into the
 * Settings dashboard client through the remote-contract descriptors.
 *
 * @module dsh-memory-tdai/project-key
 */

/**
 * Hard limits for project keys. The key is used as a single path segment under
 * `<root>/projects/`, so anything separator-like or traversal-like is refused.
 */
export const MAX_PROJECT_KEY_LENGTH = 160

/**
 * Validates a project key before it is used as a path segment.
 *
 * Rules (all checks are cheap and shared by the RPC boundary and the store
 * path builder):
 * - non-empty, no surrounding whitespace, at most {@link MAX_PROJECT_KEY_LENGTH};
 * - not `.` or `..` (directory traversal);
 * - no path separators of either platform (`/` and `\`), no drive/colon
 *   separators (`:`), no NUL and no other control characters;
 * - any other character is accepted verbatim, so legitimate non-ASCII keys
 *   (for example a Chinese project basename) and leading dots keep working.
 */
export function isValidProjectKey(key: unknown): key is string {
  if (typeof key !== 'string') return false
  const value = key
  if (value.length === 0 || value.length > MAX_PROJECT_KEY_LENGTH) return false
  if (value !== value.trim()) return false
  if (value === '.' || value === '..') return false
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
    if (character === '/' || character === '\\' || character === ':') return false
  }
  return true
}