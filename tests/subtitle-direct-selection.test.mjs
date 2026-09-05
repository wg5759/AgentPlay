import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createRequire } from 'node:module'
import * as policy from '../src/subtitle-display-policy.mjs'
import { findSubtitleOrdinal } from '../src/subtitle-display-policy.mjs'

test('the direct range button compiles both marked boundaries into a trim plan', () => {
  const ui = fs.readFileSync(path.resolve('src/components/PlaybackTools.tsx'), 'utf8')
  const expression = ui.match(/: (`保留[^`]+`)/)?.[1]
  assert.ok(expression)
  const { planEditInstruction } = createRequire(import.meta.url)('../electron/media-edit-decision')
  for (const range of [{ start: 1, end: 3 }, { start: 0, end: 2.125 }]) {
    const instruction = new Function('range', `return ${expression}`)(range)
    const result = planEditInstruction({ sourcePath: 'D:/fixture.mp4', instruction })
    assert.equal(result.decision?.kind, 'media.trim')
    assert.equal(result.decision.timeline.startSeconds, range.start)
    assert.equal(result.decision.timeline.endSeconds, range.end)
  }
})
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

test('the player positioning conversion preserves subtitle text on following lines', () => {
  const source = fs.readFileSync(path.resolve('src/components/PlayerView.tsx'), 'utf8')
  const start = source.indexOf('function applyVttPosition(')
  const end = source.indexOf('function subtitleToVtt(', start)
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const apply = new Function('subtitleCueSettings', 'positionVttContent', `${code}; return applyVttPosition`)(policy.subtitleCueSettings, policy.positionVttContent)
  for (const newline of ['\n', '\r\n']) {
    const vtt = ['WEBVTT', '', '1', '00:00:00.000 --> 00:00:03.000', '已校对的字幕', '', '2', '00:00:03.000 --> 00:00:08.000', 'Second caption'].join(newline)
    const result = apply(vtt, 'low')
    assert.ok(result.includes('已校对的字幕'))
    assert.ok(result.includes('Second caption'))
  }
})
