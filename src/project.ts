/**
 * Project identity and state paths.
 *
 * A project is keyed by a short hash of the canonical working directory plus a
 * human-readable basename. The hash is the isolation boundary: two different
 * directories can never share a store by accident.
 *
 * @module dsh-memory-tdai/project
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

export interface ProjectIdentity {
  key: string
  name: string
  cwd: string
}

export function resolveDshHome(configured?: string): string {
  const explicit = configured?.trim()
  if (explicit) return path.resolve(explicit)
  const env = process.env.DSH_HOME?.trim()
  if (env) return path.resolve(env)
  return path.join(homedir(), '.dsh')
}

export function resolveMemoryRoot(dataDir: string | undefined, dshHome?: string): string {
  if (dataDir?.trim()) return path.resolve(dataDir)
  return path.join(resolveDshHome(dshHome), 'memory-tdai')
}

export function projectIdentity(cwd: string): ProjectIdentity {
  const canonical = path.resolve(cwd)
  const base = path.basename(canonical).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'project'
  const key = `${base.slice(0, 40)}-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`
  return { key, name: path.basename(canonical) || canonical, cwd: canonical }
}
