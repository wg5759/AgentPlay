import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { connectCdp, delay, freePort, until } from './lib/reliability-cdp.mjs'

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const exe = argument('exe')
assert.ok(exe && fs.existsSync(exe), 'provide --exe=actual candidate or installed executable')
const cloud = process.argv.includes('--cloud'), native = process.argv.includes('--native')
const root = path.resolve('release')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-reliability-'))
const evidence = fs.mkdtempSync(path.join(root, 'reliability-acceptance-'))
const realProfile = path.join(process.env.APPDATA, 'ai-player')
const ffmpegRoot = [path.join(realProfile, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'), 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build'].find(value => fs.existsSync(path.join(value, 'bin', 'ffmpeg.exe')))
assert.ok(ffmpegRoot, 'verified ffmpeg assets are required')
fs.mkdirSync(path.join(profile, 'yt-dlp'), { recursive: true })
fs.symlinkSync(ffmpegRoot, path.join(profile, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'), 'junction')
const source = path.join(profile, 'source.mp4'), subtitle = path.join(profile, '字幕.srt'), facts = path.join(profile, 'facts.txt')
const generated = spawnSync(path.join(ffmpegRoot, 'bin', 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=8:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 60000 })
assert.equal(generated.status, 0, 'fixture generation')
fs.writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:03,000\n第一条字幕\n\n2\n00:00:03,000 --> 00:00:08,000\n第二条字幕\n')
fs.writeFileSync(facts, '这是合成的验收文档，不涉及真实个人。\n租赁到期日：2030年3月1日。\n')
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originals = [source, subtitle, facts].map(file => [file, sha(file)])
const configFile = path.join(realProfile, 'model-config.json')
const originalConfigHash = cloud && fs.existsSync(configFile) ? sha(configFile) : null
if (cloud) { assert.ok(originalConfigHash, 'existing saved model connection required'); fs.copyFileSync(configFile, path.join(profile, 'model-config.json')) }
const receipt = { executable: exe, sourceFixture: 'generated-h264-aac-8s', syntheticConsent: cloud, nativePilot: native, checks: {}, profile }
let child, page, main

async function launch(currentProfile, firstSource, env = {}) {
  const port = await freePort(), inspector = await freePort()
  child = spawn(exe, [`--user-data-dir=${currentProfile}`, `--remote-debugging-port=${port}`, `--inspect=${inspector}`, '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', firstSource], { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } })
  main = await connectCdp(inspector, 'node')
  await main.evaluate(`globalThis.__reliabilityElectron = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); true`)
  const actualProfile = await main.evaluate("globalThis.__reliabilityElectron.app.getPath('userData')")
  assert.equal(fs.realpathSync(actualProfile).toLowerCase(), fs.realpathSync(currentProfile).toLowerCase(), 'isolated profile')
  await main.evaluate(`(() => { const e=globalThis.__reliabilityElectron; const open=e.dialog.showOpenDialog.bind(e.dialog); e.dialog.showOpenDialog=(...args)=>args.at(-1)?.title==='选择字幕文件'?Promise.resolve({canceled:false,filePaths:[${JSON.stringify(subtitle)}]}):open(...args); ${cloud ? "const box=e.dialog.showMessageBox.bind(e.dialog);e.dialog.showMessageBox=(...args)=>args.at(-1)?.title==='云端发送确认'?Promise.resolve({response:1}):box(...args);" : ''} return true })()`)
  page = await connectCdp(port, 'page')
  await page.command('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until(() => page.evaluate('!!window.aiPlayer?.taskRuntime'), 'preload')
}
async function close() { try { await main?.evaluate('globalThis.__reliabilityElectron.app.quit(); true') } catch {}; page?.close(); main?.close(); if (child?.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) child.kill() } }
async function click(label) {
  const rect = await page.evaluate(`(() => { const element=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(label)}); if(!element)return null; element.scrollIntoView({block:'nearest'}); const r=element.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return r.width&&r.height&&(hit===element||element.contains(hit))?{x:r.x+r.width/2,y:r.y+r.height/2}:null })()`)
  assert.ok(rect, `visible clickable control: ${label}`)
  await page.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
  await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
  await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
}
async function seek(seconds) { await page.evaluate(`(() => {const v=document.querySelector('[data-ai-player-video]');v.currentTime=${seconds};v.dispatchEvent(new Event('timeupdate'));return true})()`); await delay(250) }

try {
  receipt.stage = 'launch'
  await launch(profile, source, native ? { MPV_EMBED: '1' } : { MPV_EMBED: '0' })
  if (native) {
    await delay(5000)
    receipt.checks.nativeConnected = await page.evaluate("document.body.innerText.includes('mpv 播放内核已连接')")
    receipt.checks.windows = await main.evaluate('globalThis.__reliabilityElectron.BrowserWindow.getAllWindows().map(w=>({id:w.id,parent:w.getParentWindow()?.id,bounds:w.getBounds(),visible:w.isVisible()}))')
    receipt.verdict = 'geometry-only-pilot'; receipt.visualPlaybackVerified = false
  } else {
    await until(() => page.evaluate("document.querySelector('[data-ai-player-video]')?.readyState>=2"), 'decoded video')
    receipt.buildInfo = await page.evaluate('window.aiPlayer.buildInfo')
    receipt.stage = 'subtitle-ui'
    assert.match(receipt.buildInfo.sourceSha256, /^[a-f0-9]{64}$/)
    await page.evaluate("const v=document.querySelector('[data-ai-player-video]');v.muted=true;v.loop=true;const button=[...document.querySelectorAll('.player-video-controls button[title]')].find(b=>b.title.startsWith('暂停'));button?.click();true")
    if (await page.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='不用了')")) await click('不用了')
    await page.evaluate("document.querySelector('[data-ai-player-video]').dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:200,clientY:200}));true")
    await click('片段与字幕')
    await click('加载本地字幕')
    await seek(1)
    await until(() => page.evaluate("document.querySelector('track')?.track?.activeCues?.length>0"), 'subtitle cues')
    await click('修改当前字幕')
    await page.evaluate("const input=document.querySelector('[aria-label=\"当前字幕文字\"]');input.focus();input.select();true")
    await page.command('Input.insertText', { text: '已校对的字幕' })
    await click('保存为新字幕')
    await until(() => page.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='撤销本次字幕修改')"), 'saved subtitle', 90000)
    await seek(1)
    const edited = await page.evaluate("document.querySelector('track')?.track?.activeCues?.[0]?.text")
    assert.equal(edited, '已校对的字幕')
    await click('撤销本次字幕修改'); await seek(1)
    assert.equal(await page.evaluate("document.querySelector('track')?.track?.activeCues?.[0]?.text"), '第一条字幕')
    receipt.checks.subtitleEditAndUndo = true
    receipt.stage = 'clip-ui'
    await seek(1); await click('起点 —s'); await seek(3); await click('终点 —s'); await click('剪出选段')
    await until(() => page.evaluate("(()=>{const v=document.querySelector('[data-ai-player-video]');return v?.readyState>=2&&Math.abs(v.duration-2)<0.3})()"), 'trimmed playback', 120000)
    receipt.checks.directTrimSeconds = await page.evaluate("document.querySelector('[data-ai-player-video]').duration")
    await page.evaluate("const v=document.querySelector('[data-ai-player-video]');v.loop=true;v.muted=true;true")
    await page.evaluate("window.aiPlayer.windowControls.setPreset('fullscreen')")
    await page.evaluate("window.aiPlayer.windowControls.setPreset('fullscreen')")
    assert.equal(await page.evaluate('window.aiPlayer.windowControls.isFullscreen()'), true)
    await page.evaluate("window.aiPlayer.windowControls.setPreset('original')")
    await until(() => page.evaluate('window.aiPlayer.windowControls.isFullscreen().then(value=>!value)'), 'restored window')
    assert.ok(await page.evaluate('outerWidth<screen.availWidth&&outerHeight<screen.availHeight'))
    receipt.checks.idempotentFullscreenAndWindowMargins = true
    receipt.stage = 'model-verification'
    const image = await page.command('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(evidence, 'workspace.png'), Buffer.from(image.data, 'base64'))
    if (cloud) {
      const config = await page.evaluate("window.aiPlayer.models.config('chat')")
      receipt.model = { providerId: config.providerId, model: config.model }
      receipt.capabilities = await page.evaluate(`window.aiPlayer.models.verify({role:'chat',providerId:${JSON.stringify(config.providerId)},model:${JSON.stringify(config.model)},useSavedKey:true})`)
      assert.equal(receipt.capabilities.success, true, 'real text capability')
      const cases = [ ['不要录屏，我只是想知道这个功能怎么用','ask'], ['查重会不会删除我的原文件？','ask'], ['先别压缩，文件太大是不是码率高？','ask'], ['如果以后想剪辑视频，应该怎么做？','ask'], ['我只想了解字幕翻译的费用，请别开始翻译。','ask'], ['请将当前视频的字幕翻译成英文','execute'], ['帮我把这个视频里的重复句子删掉','execute'], ['请把这份材料改写成一段简短介绍','execute'] ]
      receipt.intentCases = []
      for (let index=0; index<cases.length; index++) { const [text, expected]=cases[index]; const started=Date.now(); const result=await page.evaluate(`window.aiPlayer.ai.interpretIntent({text:${JSON.stringify(text)},requestId:'intent-acceptance-${index}',materials:[{name:'demo.mp4',type:'active-video'},{name:'facts.txt',type:'.txt'}],history:[]})`); receipt.intentCases.push({text,expected,actual:result.kind,latencyMs:Date.now()-started}); assert.equal(result.kind,expected,text) }
      const attached = await page.evaluate(`window.aiPlayer.chat.attachPaths([${JSON.stringify(facts)}])`)
      assert.ok(attached.documents?.[0]?.token)
      const answer = await page.evaluate(`window.aiPlayer.ai.chat([{role:'user',content:'这份合成文档的租赁到期日是什么？'}],null,'chat-document-proof',{mode:'ask',documentTokens:[${JSON.stringify(attached.documents[0].token)}]})`)
      assert.match(answer.text, /2030/); assert.equal(answer.toolResults.length, 0)
      receipt.checks.readOnlyDocumentQuestion = true
    }
    receipt.checks.originalsUnchanged = originals.every(([file, digest]) => sha(file) === digest)
    assert.equal(receipt.checks.originalsUnchanged, true)
    if (cloud) { receipt.checks.realConfigurationUnchanged = sha(configFile) === originalConfigHash; assert.equal(receipt.checks.realConfigurationUnchanged, true) }
    await close()
    const damagedProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-damaged-state-'))
    fs.mkdirSync(path.join(damagedProfile, 'yt-dlp'), { recursive: true })
    fs.symlinkSync(ffmpegRoot, path.join(damagedProfile, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'), 'junction')
    fs.mkdirSync(path.join(damagedProfile, 'task-runtime'), { recursive: true })
    fs.writeFileSync(path.join(damagedProfile, 'task-runtime', 'task-runtime-v1.json'), 'broken-primary')
    fs.writeFileSync(path.join(damagedProfile, 'task-runtime', 'task-runtime-v1.json.bak'), 'broken-backup')
    await launch(damagedProfile, source, { MPV_EMBED: '0' })
    await until(() => page.evaluate("document.querySelector('[data-ai-player-video]')?.readyState>=2"), 'playback with damaged task storage')
    const tasks = await page.evaluate('window.aiPlayer.taskRuntime.list()')
    assert.ok(tasks.some(task => task.failure?.code === 'TASK_STORAGE_UNREADABLE'))
    assert.equal(fs.readFileSync(path.join(damagedProfile, 'task-runtime', 'task-runtime-v1.json'), 'utf8'), 'broken-primary')
    receipt.checks.damagedTaskStorageKeepsPlayback = true
    receipt.verdict = 'passed'
  }
} catch (error) { receipt.verdict = 'failed'; receipt.failure = error.message; process.exitCode = 1; try { const image = await page?.command('Page.captureScreenshot', { format: 'png' }, 5000); if (image) fs.writeFileSync(path.join(evidence, 'failure.png'), Buffer.from(image.data, 'base64')) } catch {} }
finally { await close(); fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ evidence, stage: receipt.stage, verdict: receipt.verdict, failure: receipt.failure, checks: receipt.checks, model: receipt.model })) }
