import test from 'node:test'
import assert from 'node:assert/strict'
import { findSubtitleOrdinal } from '../src/subtitle-display-policy.mjs'
test('direct subtitle edits bind to source order rather than time-sorted TextTrack order', () => {
  const content = '10\n00:00:03,000 --> 00:00:08,000\n后半段\n\n20\n00:00:00,000 --> 00:00:03,000\n前半段\n'
  assert.equal(findSubtitleOrdinal(content, 0, 3), 2)
  assert.equal(findSubtitleOrdinal(content, 3, 8), 1)
  assert.equal(findSubtitleOrdinal(content, 1, 2), null)
})
test('ambiguous overlapping subtitle rows are not silently edited', () => {
  const cue = '00:00:00.000 --> 00:00:02.000\n同一句'
  assert.equal(findSubtitleOrdinal(`WEBVTT\n\n${cue}\n\n${cue}`, 0, 2), null)
})
