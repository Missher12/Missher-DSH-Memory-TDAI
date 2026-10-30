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
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isValidProjectKey, MAX_PROJECT_KEY_LENGTH } from './project-key.js'

export { isValidProjectKey, MAX_PROJECT_KEY_LENGTH } from './project-key.js'

export interface ProjectIdentity {
  key: string
  name: string
  cwd: string
}

export function validProjectKeyOrThrow(key: unknown): asserts key is string {
  if (!isValidProjectKey(key)) {
    throw new Error(`invalid project key: ${JSON.stringify(key)}`)
  }
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

/**
 * Builds the memory.db path for a project, enforcing the containment and
 * symlink boundary around `<root>/projects/<key>`.
 *
 * - the key must pass {@link isValidProjectKey};
 * - the resolved file must stay inside `<root>/projects`;
 * - when the project directory already exists, its real path (after symlink
 *   resolution) must also stay inside the real path of `<root>/projects`, so a
 *   pre-planted symlink cannot redirect a project database outside the store;
 * - when the database file itself already exists as a symlink, its target must
 *   stay inside the store; a dangling `memory.db` symlink is rejected so the
 *   opener never creates a database over it.
 *
 * @throws when the key is invalid or the resolved location escapes the store.
 */
export function projectDbPath(root: string, projectKey: string): string {
  validProjectKeyOrThrow(projectKey)
  const projectsRoot = path.resolve(root, 'projects')
  const dir = path.join(projectsRoot, projectKey)
  const file = path.join(dir, 'memory.db')
  if (!isWithin(projectsRoot, file)) throw new Error(`project path escapes the store root: ${JSON.stringify(projectKey)}`)
  let realRoot = projectsRoot
  try {
    realRoot = realpathSync(projectsRoot)
  } catch {
    // The projects root may not exist yet; containment against the literal path still holds.
  }
  if (lstatSync(dir, { throwIfNoEntry: false }) !== undefined) {
    let realDir: string
    try {
      realDir = realpathSync(dir)
    } catch {
      throw new Error(`project directory is not readable: ${JSON.stringify(projectKey)}`)
    }
    if (!isWithin(realRoot, realDir)) {
      throw new Error(`project directory escapes the store root: ${JSON.stringify(projectKey)}`)
    }
  }
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) {
      // Resolve the *target*; a broken link throws ENOENT here and must not be
      // silently replaced by a fresh database file.
      let realFile: string
      try {
        realFile = realpathSync(file)
      } catch {
        throw new Error(`project database is a dangling symlink: ${JSON.stringify(projectKey)}`)
      }
      if (!isWithin(realRoot, realFile)) {
        throw new Error(`project database escapes the store root: ${JSON.stringify(projectKey)}`)
      }
    }
  } catch (error) {
    // ENOENT is the normal case for a fresh project (no database yet).
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  return file
}

export function resolveDshHome(configured?: string): string {
  const explicit = configured?.trim()
  if (explicit) return path.resolve(explicit)
  const env = process.env.DSH_HOME?.trim()
  if (env) return path.resolve(env)
  return path.join(homedir(), '.dsh')
}

export function resolveMemoryRoot(dataDir: string | undefined, dshHome?: string, profileDirectory?: string): string {
  if (dataDir?.trim()) return path.resolve(dataDir)
  const legacy = path.join(resolveDshHome(dshHome), 'memory-tdai')
  if (profileDirectory === undefined) return legacy
  if (!path.isAbsolute(profileDirectory)) throw new Error('Host profile directory must be absolute')
  const profile = realpathSync(profileDirectory)
  if (!lstatSync(profile).isDirectory()) throw new Error('Host profile directory is unavailable')
  const scoped = path.join(profile, 'memory-tdai')
  const legacyStat = lstatSync(legacy, { throwIfNoEntry: false })
  if (legacyStat === undefined) return scoped
  if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) throw new Error('legacy memory profile root is not a regular directory')
  const file = path.join(legacy, '.profile-owner.json'), stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat === undefined) return scoped
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) throw new Error('legacy memory profile owner is invalid')
  let owner: { version?: unknown; profileDir?: unknown }
  try { owner = JSON.parse(readFileSync(file, 'utf8')) as typeof owner }
  catch { throw new Error('legacy memory profile owner is invalid') }
  if (owner === null || typeof owner !== 'object' || owner.version !== 1 ||
      typeof owner.profileDir !== 'string' || !path.isAbsolute(owner.profileDir) || path.resolve(owner.profileDir) !== owner.profileDir) {
    throw new Error('legacy memory profile owner is invalid')
  }
  // Never guess who owns an older shared root. Adoption is an explicit upgrade operation.
  return owner.profileDir === profile ? legacy : scoped
}

export function projectIdentity(cwd: string): ProjectIdentity {
  const canonical = path.resolve(cwd)
  const base = path.basename(canonical).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'project'
  const key = `${base.slice(0, 40)}-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`
  return { key, name: path.basename(canonical) || canonical, cwd: canonical }
}
