import assert from 'node:assert/strict'
import test from 'node:test'
import { matchExperienceConditions, mergeRouteCandidates } from '../lib/r41.js'

test('repeated hits in one retrieval route are idempotent; distinct routes add bounded synergy', () => {
  const merged = mergeRouteCandidates([
    { name: 'lexical', candidates: [
      { id: 'mem-a', revision: 2, score: 0.7, sourceIds: ['l0_a'] },
      { id: 'mem-a', revision: 2, score: 0.9, sourceIds: ['l0_b'] },
      { id: 'mem-b', revision: 1, score: 0.6 },
    ] },
    { name: 'exact', candidates: [
      { id: 'mem-a', revision: 2, score: 0.8, sourceIds: ['l0_a'] },
    ] },
  ])

  assert.deepEqual(merged.find((item) => item.id === 'mem-a'), {
    id: 'mem-a', revision: 2, score: 0.92, routes: ['exact', 'lexical'], sourceIds: ['l0_a', 'l0_b'],
  })
  assert.equal(merged.find((item) => item.id === 'mem-b')?.score, 0.6)
})

test('experience conditions distinguish satisfied, missing, different and known counterexample facts', () => {
  const expected = { os: 'linux', runtime: 'node-22' }
  const prerequisites = ['path has moved']
  const satisfied = matchExperienceConditions({ expected, actual: { os: 'linux', runtime: 'node-22' },
    prerequisites, satisfiedPrerequisites: ['path has moved'] })
  assert.equal(satisfied.applicability, 'applicable')
  assert.equal(satisfied.conditionState, 'satisfied')
  assert.deepEqual(satisfied.matched.sort(), ['os', 'runtime'])
  assert.deepEqual(satisfied.satisfiedPrerequisites, ['path has moved'])
  assert.deepEqual(satisfied.unresolvedPrerequisites, [])

  const missing = matchExperienceConditions({ expected, actual: { os: 'linux', runtime: 'node-22' }, prerequisites })
  assert.equal(missing.applicability, 'conditions_missing', 'an unproven prerequisite cannot be guessed from the matching environment')
  assert.equal(missing.conditionState, 'missing')
  assert.deepEqual(missing.unresolvedPrerequisites, ['path has moved'])

  const different = matchExperienceConditions({ expected, actual: { os: 'windows', runtime: 'node-20' },
    prerequisites, satisfiedPrerequisites: ['path has moved'] })
  assert.equal(different.applicability, 'inapplicable')
  assert.equal(different.conditionState, 'different')
  assert.equal(different.different.length, 2)

  const counterexample = matchExperienceConditions({ expected, actual: { os: 'windows', runtime: 'node-20' },
    prerequisites, satisfiedPrerequisites: ['path has moved'], counterexampleMatches: ['source rows are missing'] })
  assert.equal(counterexample.applicability, 'known_counterexample')
  assert.equal(counterexample.conditionState, 'known_counterexample')
})

test('experience conditions re-match a changed environment version and never fuzzy-match prerequisites', () => {
  const expected = { version: '2.1.0' }
  const prerequisites = ['migration 0007 applied']
  const oldVersion = matchExperienceConditions({ expected, actual: { version: '2.0.4' }, prerequisites,
    satisfiedPrerequisites: ['migration 0007 applied'] })
  assert.equal(oldVersion.applicability, 'inapplicable')
  const newVersion = matchExperienceConditions({ expected, actual: { version: '2.1.0' }, prerequisites,
    satisfiedPrerequisites: ['migration 0007 applied'] })
  assert.equal(newVersion.applicability, 'applicable', 'the same stored card re-matches when the environment changes back')
  const looseText = matchExperienceConditions({ expected, actual: { version: '2.1.0' }, prerequisites,
    satisfiedPrerequisites: ['migration 7 applied'] })
  assert.equal(looseText.applicability, 'conditions_missing', 'a similar prerequisite text is not treated as satisfied')
  const unverifiedOnly = matchExperienceConditions({ expected: {}, actual: {}, prerequisites: [] })
  assert.equal(unverifiedOnly.applicability, 'conditions_missing')
  assert.equal(unverifiedOnly.conditionState, 'unknown')
})

test('experience condition matching is bounded and reports truncated key comparison', () => {
  const match = matchExperienceConditions({
    expected: { first: 'a', second: 'b', third: 'c' },
    actual: { first: 'x', second: 'y', third: 'z' },
    maxKeys: 2,
  })
  assert.equal(match.truncated, true)
  assert.equal(match.applicability, 'partially_applicable', 'a truncated comparison cannot claim a full mismatch')
  assert.equal(match.different.length, 2)
})

test('experience condition matching reports omitted environment and prerequisite conditions as unknown', () => {
  const environment = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, `value-${index}`]))
  const actual = Object.fromEntries(Object.entries(environment).slice(0, 32))
  const environmentMatch = matchExperienceConditions({ expected: environment, actual })
  assert.equal(environmentMatch.truncated, true)
  assert.equal(environmentMatch.applicability, 'conditions_missing')
  assert.equal(environmentMatch.conditionState, 'unknown', 'the omitted 33rd environment key is not assumed to match')
  assert.equal(environmentMatch.matched.length, 32)

  const prerequisites = Array.from({ length: 33 }, (_, index) => `prerequisite ${index}`)
  const prerequisiteMatch = matchExperienceConditions({ expected: { os: 'linux' }, actual: { os: 'linux' }, prerequisites,
    satisfiedPrerequisites: prerequisites.slice(0, 32) })
  assert.equal(prerequisiteMatch.truncated, true)
  assert.equal(prerequisiteMatch.applicability, 'conditions_missing')
  assert.equal(prerequisiteMatch.conditionState, 'unknown', 'the omitted 33rd prerequisite is not assumed satisfied')
  assert.equal(prerequisiteMatch.satisfiedPrerequisites.length, 32)
  assert.deepEqual(prerequisiteMatch.unresolvedPrerequisites, [])

  const knownMismatch = matchExperienceConditions({ expected: { os: 'linux', runtime: 'node-22' },
    actual: { os: 'windows', runtime: 'node-20' }, prerequisites, satisfiedPrerequisites: prerequisites.slice(0, 32) })
  assert.equal(knownMismatch.applicability, 'inapplicable', 'a complete explicit environment counterexample retains precedence')
})

test('repeated same-source route hits never add source support votes', () => {
  const merged = mergeRouteCandidates([
    { name: 'lexical', candidates: [{ id: 'mem-same', revision: 1, score: 0.5, sourceIds: ['l0_root'] }] },
    { name: 'relation', candidates: [{ id: 'mem-same', revision: 1, score: 0.4, sourceIds: ['l0_root'] }] },
    { name: 'temporal', candidates: [{ id: 'mem-same', revision: 1, score: 0.4, sourceIds: ['l0_root'] }] },
  ])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].sourceIds, ['l0_root'], 'one root stays one root no matter how many routes hit it')
  assert.deepEqual(merged[0].routes, ['lexical', 'relation', 'temporal'])
})
