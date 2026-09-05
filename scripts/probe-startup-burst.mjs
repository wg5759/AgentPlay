import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { connectCdp, freePort, delay, until } from './lib/reliability-cdp.mjs'
const require = createRequire(import.meta.url)
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3)
const exe = path.resolve(arg('exe')), fixture = path.resolve(arg('media'))
const components = path.resolve(arg('components')), zipSource = path.resolve(arg('zip'))
const evidence = fs.mkdtempSync(path.resolve('release/startup-burst-'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-startup-burst-'))
const whisper = require('../electron/whisper-pack-manifest'), site = require('../electron/ytdlp-pack-manifest')
const stage = (source, target, descriptor) => {
  const bytes = fs.readFileSync(source)
  assert.equal(bytes.length, descriptor.size)
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), descriptor.sha256)
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target)
}
for (const asset of whisper.assets) for (const file of asset.files || [asset]) stage(path.join(components, 'whisper-pack', file.path), path.join(profile, 'whisper-pack', file.path), file)
stage(path.join(components, 'yt-dlp/yt-dlp.exe'), path.join(profile, 'yt-dlp/yt-dlp.exe'), site.assets[0])
stage(zipSource, path.join(profile, 'yt-dlp/.dl', site.assets[1].id + '.zip'), site.assets[1])
// No installed ffmpeg/ffprobe and no completion receipts: the real first-run path must finish them.
const media = Array.from({ length: 12 }, (_, i) => path.join(evidence, `burst-${String(i).padStart(2, '0')}.mp4`))
for (const file of media) fs.copyFileSync(fixture, file)
const inspector = await freePort(), renderer = await freePort()
const child = spawn(exe, [`--user-data-dir=${profile}`, `--inspect=${inspector}`, `--remote-debugging-port=${renderer}`], { windowsHide: true, stdio: 'ignore' })
let main, page
const launched = [], receipt = { evidence, profile, exe, mode: 'real external processes during cached verified first-run ZIP extraction; no in-app-open substitute', startedAt: new Date().toISOString() }
try {
  main = await connectCdp(inspector, 'node')
  await main.command('Runtime.runIfWaitingForDebugger')
  // At native startup there may not yet be a Promise/microtask checkpoint. Install
  // synchronous observation without awaiting an artificial Promise around eval.
  const attached = await main.command('Runtime.evaluate', { expression: `(() => { const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');globalThis.__burst={events:[],maxLagMs:0};globalThis.__burstApp=e.app;e.app.prependListener('second-instance',(_,argv)=>__burst.events.push({at:Date.now(),argv}));let last=Date.now();globalThis.__burstTimer=setInterval(()=>{const now=Date.now();__burst.maxLagMs=Math.max(__burst.maxLagMs,now-last-50);last=now},50);return true })()`, returnByValue: true }, 15000)
  if (attached.exceptionDetails) throw Error(attached.exceptionDetails.exception?.description || attached.exceptionDetails.text)
  receipt.inspectorAttachedAt=Date.now()
  const extracting = path.join(profile, 'yt-dlp', site.assets[1].files[0].path + '.tmp')
  await until(() => fs.existsSync(extracting), 'real FFmpeg worker extraction', 90000)
  receipt.extractionObservedAt = Date.now()
  const results = []
  for (const file of media) {
    const start = Date.now(), processChild = spawn(exe, [`--user-data-dir=${profile}`, file], { windowsHide: true, stdio: 'ignore' })
    launched.push(processChild)
    results.push(new Promise(resolve => {
      const timer = setTimeout(() => { processChild.kill(); resolve({file, elapsedMs:Date.now()-start, timeout:true}) }, 15000)
      processChild.once('error', error => { clearTimeout(timer); resolve({file,error:error.message}) })
      processChild.once('exit', code => { clearTimeout(timer); resolve({file,elapsedMs:Date.now()-start,code}) })
    }))
    await delay(150)
  }
  receipt.forwarding = await Promise.all(results)
  receipt.telemetry = await main.evaluate('__burst')
  assert.ok(receipt.forwarding.every(item => item.code === 0 && !item.timeout), 'every forwarded process must exit within original 15s deadline')
  await until(async () => (await main.evaluate('__burst.events')).length === media.length, 'all second-instance receipts', 15000)
  receipt.telemetry = await main.evaluate('__burst')
  assert.ok(media.every(file => receipt.telemetry.events.some(event => event.argv.includes(file))))
  receipt.firstRun = await until(() => { try { const marker=JSON.parse(fs.readFileSync(path.join(profile,'first-run-components.json'),'utf8'));return marker.done && marker } catch {return false} }, 'complete verified first-run marker', 120000)
  const {LocalAiDownloadService}=require('../electron/local-ai-download-service')
  receipt.packs = [ ['whisper-pack',whisper],['yt-dlp',site] ].map(([directory,manifest]) => ({directory,...new LocalAiDownloadService({installRoot:path.join(profile,directory),manifest}).status()}))
  assert.ok(receipt.packs.every(pack => pack.installed))
  page=await connectCdp(renderer,'page')
  const expected=receipt.telemetry.events.at(-1).argv.find(value=>media.includes(value))
  receipt.visible = await until(async () => {const state=await page.evaluate(`(() => {const m=document.querySelector('[data-ai-player-video]');return {src:m?.currentSrc,ready:m?.readyState,history:JSON.parse(localStorage.getItem('ai-player-store')||'{}').state?.recentMedia?.[0]}})()`);return state.src && decodeURIComponent(state.src).replaceAll('\\','/').includes(path.basename(expected)) && state.ready>=2 && state}, 'last delivered file loaded in original player', 60000)
  receipt.passed=true
} catch(error) {receipt.passed=false;receipt.error=error.message;process.exitCode=1;try {receipt.telemetry=await main?.evaluate('__burst')}catch{}}
finally {
  for(const processChild of launched) if(processChild.exitCode===null) processChild.kill()
  try {await main?.evaluate('clearInterval(__burstTimer);__burstApp.quit();true')}catch{}
  page?.close();main?.close()
  if(child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);if(child.exitCode===null)child.kill()}
  fs.writeFileSync(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2))
}
