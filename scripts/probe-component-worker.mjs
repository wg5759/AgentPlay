import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { freePort, connectCdp, delay } from './lib/reliability-cdp.mjs'
const require = createRequire(import.meta.url), asar = require('../node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar'), JSZip = require('jszip')
const root = path.resolve('.'), evidence = fs.mkdtempSync(path.join(root, 'release/worker-asar-probe-')), source = path.join(evidence, 'source'), archive = path.join(evidence, 'fixture.asar')
fs.mkdirSync(path.join(source, 'electron'), {recursive:true})
for(const name of ['component-archive.js','component-archive-worker.js']) fs.copyFileSync(path.join(root,'electron',name),path.join(source,'electron',name))
await asar.createPackage(source,archive)
const content = Buffer.alloc(65536, 42), zip = new JSZip(); zip.file('data.bin',content)
const bytes = await zip.generateAsync({type:'nodebuffer'}), zipFile=path.join(evidence,'fixture.zip');fs.writeFileSync(zipFile,bytes)
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const asset={size:bytes.length,sha256:sha(bytes),files:[{path:'data.bin',size:content.length,sha256:sha(content)}]}
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'worker-asar-profile-'));fs.writeFileSync(path.join(profile,'first-run-components.json'),JSON.stringify({done:true}))
const port=await freePort(), exe='C:/Program Files/ai-player/AgentPlay/AgentPlay.exe'
const child=spawn(exe,[`--user-data-dir=${profile}`,`--inspect=${port}`],{windowsHide:true,stdio:'ignore'})
let cdp;const receipt={evidence,mode:'new archive worker inside ASAR under installed Electron; no media or network task'}
try {cdp=await connectCdp(port,'node');await cdp.evaluate("globalThis.__probeRequire=process.getBuiltinModule('module').createRequire(process.execPath);globalThis.__probeElectron=__probeRequire('electron');__probeElectron.app.whenReady().then(()=>true)");receipt.electron=await cdp.evaluate('process.versions.electron');await cdp.evaluate(`__probeRequire(${JSON.stringify(archive+'/electron/component-archive.js')}).extractInWorker(${JSON.stringify(zipFile)},${JSON.stringify(path.join(evidence,'output'))},${JSON.stringify(asset)},new AbortController().signal)`);if(sha(fs.readFileSync(path.join(evidence,'output/data.bin')))!==sha(content))throw Error('worker output mismatch');receipt.passed=true}
catch(error){receipt.passed=false;receipt.error=error.message;process.exitCode=1}
finally{try{await cdp?.evaluate('__probeElectron.app.quit();true')}catch{}cdp?.close();if(child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);if(child.exitCode===null)child.kill()}fs.writeFileSync(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt))}
