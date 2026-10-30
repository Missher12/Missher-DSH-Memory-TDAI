import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveMemoryRoot } from '../lib/project.js'

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tdai-profile-')))
  const a = path.join(home, 'profiles', 'a'), b = path.join(home, 'profiles', 'b'), legacy = path.join(home, 'memory-tdai')
  for (const dir of [a, b]) mkdirSync(dir, { recursive: true })
  return { home, a, b, legacy, close() { rmSync(home, { recursive: true, force: true }) } }
}

test('the same DSH_HOME keeps default memory roots separate for actual Host profiles', () => {
  const f = fixture()
  try {
    assert.equal(resolveMemoryRoot(undefined, f.home, f.a), path.join(f.a, 'memory-tdai'))
    assert.equal(resolveMemoryRoot(undefined, f.home, f.b), path.join(f.b, 'memory-tdai'))
    assert.notEqual(resolveMemoryRoot(undefined, f.home, f.a), resolveMemoryRoot(undefined, f.home, f.b))
    assert.equal(resolveMemoryRoot(undefined, f.home), f.legacy, 'minimal hosts without profiles retain their existing default')
  } finally { f.close() }
})

test('only the explicitly recorded legacy owner can keep the existing root; other profiles cannot adopt it', () => {
  const f = fixture()
  try {
    mkdirSync(f.legacy)
    writeFileSync(path.join(f.legacy, '.profile-owner.json'), JSON.stringify({ version: 1, profileDir: f.a }))
    writeFileSync(path.join(f.legacy, 'preserve.txt'), 'existing profile memory must remain unchanged')
    assert.equal(resolveMemoryRoot(undefined, f.home, f.a), f.legacy)
    assert.equal(resolveMemoryRoot(undefined, f.home, f.b), path.join(f.b, 'memory-tdai'))
    assert.equal(readFileSync(path.join(f.legacy, 'preserve.txt'), 'utf8'), 'existing profile memory must remain unchanged')
    assert.equal(resolveMemoryRoot(f.legacy, f.home, f.b), f.legacy, 'an explicit dataDir remains an intentional override')
  } finally { f.close() }
})

test('unassigned legacy data is preserved without silently assigning it to a newly opened profile', () => {
  const f = fixture()
  try {
    mkdirSync(f.legacy)
    writeFileSync(path.join(f.legacy, 'preserve.txt'), 'unassigned historical data')
    assert.equal(resolveMemoryRoot(undefined, f.home, f.b), path.join(f.b, 'memory-tdai'))
    assert.equal(readFileSync(path.join(f.legacy, 'preserve.txt'), 'utf8'), 'unassigned historical data')
  } finally { f.close() }
})

test('a symlink or malformed owner marker cannot redirect the default profile root', () => {
  const f = fixture()
  try {
    mkdirSync(f.legacy)
    const owner = path.join(f.legacy, '.profile-owner.json'), target = path.join(f.home, 'owner.json')
    writeFileSync(target, JSON.stringify({ version: 1, profileDir: f.a })); symlinkSync(target, owner)
    assert.throws(() => resolveMemoryRoot(undefined, f.home, f.a), /owner|profile/i)
    rmSync(owner); writeFileSync(owner, '{broken')
    assert.throws(() => resolveMemoryRoot(undefined, f.home, f.a), /owner|profile/i)
  } finally { f.close() }
})
