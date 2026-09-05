import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
const arg=k=>process.argv.find(v=>v.startsWith(`--${k}=`))?.slice(k.length+3)
const exe=arg('exe'), media=arg('media'), port=19446
assert.ok(exe&&media)
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'agentplay-window-recovery-'))
const child=spawn(exe,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--disable-backgrounding-occluded-windows','--disable-features=CalculateNativeWinOcclusion',media],{windowsHide:true,stdio:'ignore'})
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws,id=0;const pending=new Map()
const command=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value}
const state=()=>evaluate(`(async()=>{const v=document.querySelector('[data-ai-player-video]');return {fullscreen:await window.aiPlayer.windowControls.isFullscreen(),theater:!!document.querySelector('.workspace-theater'),video:!!v,readyState:v?.readyState,paused:v?.paused,ended:v?.ended,outerWidth,outerHeight,availableWidth:screen.availWidth,availableHeight:screen.availHeight}})()`)
async function until(check,label,ms=10000){let last;const end=Date.now()+ms;while(Date.now()<end){try{last=await state();if(check(last))return last}catch{}await sleep(100)}throw Error(label+': '+JSON.stringify(last))}
try{
 let page;for(let i=0;i<240;i++){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page');if(page?.webSocketDebuggerUrl)break}catch{}await sleep(250)}assert.ok(page)
 ws=new WebSocket(page.webSocketDebuggerUrl);ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});await command('Emulation.setFocusEmulationEnabled',{enabled:true})
 const initial=await until(s=>s.video&&s.readyState>=2&&!s.fullscreen&&!s.theater,'initial window',90000)
 assert.ok(initial.outerWidth<initial.availableWidth && initial.outerHeight<initial.availableHeight,'default window must leave desktop space')
 await evaluate(`document.querySelector('[data-ai-player-video]').loop=true; const b=document.querySelector('.player-video-controls button[title]'); if(b.title.startsWith('播放'))b.click(); true`)
 await evaluate(`document.querySelector('.player-video-controls input').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); true`)
 await sleep(300)
 assert.equal((await state()).fullscreen,false,'control double-click must not enter fullscreen')
 await evaluate(`document.querySelector('[data-ai-player-video]').loop=true; document.querySelector('[data-ai-player-video]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); true`)
 await until(s=>s.fullscreen&&s.theater,'explicit fullscreen')
 await sleep(3500)
 assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-exit-fullscreen]')).opacity`),'1')
 await evaluate(`document.querySelector('[data-exit-fullscreen]').click(); true`)
 await until(s=>!s.fullscreen&&!s.theater&&s.video,'visible exit button')
 await evaluate(`document.querySelector('[data-ai-player-video]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); true`)
 await until(s=>s.fullscreen&&s.theater,'fullscreen before end')
 await evaluate(`(async()=>{const v=document.querySelector('[data-ai-player-video]');v.loop=false;v.currentTime=Math.max(0,v.duration-.15);await v.play();return true})()`)
 const ended=await until(s=>s.ended&&s.paused&&!s.fullscreen&&!s.theater,'end of video must restore window')
 await evaluate(`const v=document.querySelector('[data-ai-player-video]');v.loop=true;v.currentTime=0;document.querySelector('.player-video-controls button[title]').click();v.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));true`)
 await until(s=>s.fullscreen&&s.theater,'fullscreen before close')
 await evaluate(`Array.from(document.querySelector('[data-ai-player-video]').parentElement.querySelectorAll('button')).find(b=>b.textContent.includes('关闭')).click(); true`)
 const closed=await until(s=>!s.video&&!s.fullscreen&&!s.theater,'closing video must restore window')
 await evaluate(`window.aiPlayer.player.loadFile(${JSON.stringify(media)})`)
 const reopened=await until(s=>s.video&&s.readyState>=2&&!s.fullscreen&&!s.theater,'reopen must remain windowed',90000)
 console.log(JSON.stringify({initial,ended,closed,reopened,controlDoubleClickIgnored:true,persistentExitButton:true,passed:true,profile}))
}finally{ws?.close();if(child.exitCode===null){child.kill();await new Promise(r=>{const timer=setTimeout(r,5000);child.once('exit',()=>{clearTimeout(timer);r()})})}}
