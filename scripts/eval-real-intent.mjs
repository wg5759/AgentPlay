import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { interpretIntent } from '../electron/intent-policy.mjs'
const { AgentEngine } = createRequire(import.meta.url)('../electron/llm-service')
if (!process.env.AGNES_API_KEY) throw Error('AGNES_API_KEY must already exist; never print it')
const engine = new AgentEngine({})
const config = { providerId: 'agnes', model: 'agnes-2.5-flash', apiKey: process.env.AGNES_API_KEY }
const cases = [
  ['不要录屏，我只是想知道这个功能怎么用','ask'], ['查重会不会删除我的原文件？','ask'],
  ['先别压缩，文件太大是不是码率高？','ask'], ['如果以后想剪辑视频，应该怎么做？','ask'],
  ['我只想了解字幕翻译的费用，请别开始翻译。','ask'], ['请将当前视频的字幕翻译成英文','execute'],
  ['帮我把这个视频里的重复句子删掉','execute'], ['请把这份材料改写成一段简短介绍','execute'],
  ['朋友说把这段删了，我只是想知道这样会不会破坏原片','ask'], ['添加配乐一定需要付费吗？','ask'],
  ['先不要导出，解释一下帧率和码率的区别','ask'], ['有办法恢复误删的字幕吗，先介绍方法','ask'],
  ['将目前加载的字幕整体推迟两秒，另存一份','execute'], ['把当前视频转为无声版，原文件保留','execute'],
  ['把这份文档里的姓名整理为表格','execute'], ['帮我压短这段视频','clarify'],
]
const results = []
for (const [text, expected] of cases) {
  const started = Date.now()
  try {
    const result = await interpretIntent({ text, materials: [{name:'demo.mp4',type:'active-video'}, {name:'facts.txt',type:'.txt'}], history:[] }, options => engine.completeText([{ role:'user',content:options.prompt }],config,options))
    results.push({text,expected,actual:result.kind,route:result.route,elapsedMs:Date.now()-started,passed:result.kind===expected})
  } catch (error) { results.push({text,expected,actual:'error',elapsedMs:Date.now()-started,error:error.message,passed:false}) }
}
const sorted = results.map(r=>r.elapsedMs).sort((a,b)=>a-b)
const report = {generatedAt:new Date().toISOString(),model:config.model,fixture:'synthetic held-out instructions; no tools or media upload',results,passed:results.filter(r=>r.passed).length,total:results.length,falseExecutions:results.filter(r=>r.expected!=='execute'&&r.actual==='execute').length,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]}
const file = path.join(fs.mkdtempSync(path.resolve('release/intent-real-eval-')),'receipt.json')
fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({file,passed:report.passed,total:report.total,falseExecutions:report.falseExecutions,p95Ms:report.p95Ms}));process.exitCode=report.passed===report.total?0:1
