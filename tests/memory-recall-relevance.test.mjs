import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { MemoryRuntime } from '../lib/memory.js'
import { resolveConfig } from '../lib/config.js'
import { openProjectStore, recallQueryTerms, recallTermMatches } from '../lib/store.js'

const context={ get(){}, logger:{info(){},warn(){},error(){},debug(){}} }
function seed(root,key,contents){
 const store=openProjectStore(root,key,{key,name:key,cwd:`/test/${key}`})
 try{for(const [index,content] of contents.entries()){
  const source=store.captureMessage({sessionId:key,role:'user',content,sourceKind:'user',sourceEventId:`${key}-${index}`,origin:'dsh-session',agentPreset:'agent-mock'})
  store.addMemory({content,kind:'project',status:'approved',confidence:1,sourceVerified:true,sourceMessageIds:[source.id]})
 }}finally{store.close()}
}

test('a Chinese question with a trailing tool constraint recalls the named fact instead of unrelated old instructions',t=>{
 t.mock.method(performance,'now',()=>0)
 const root=mkdtempSync(path.join(os.tmpdir(),'memory-query-relevance-'));let runtime
 try{
  seed(root,'old-source',Array.from({length:52},(_,i)=>`旧流程${String.fromCharCode(0x4e00+i)}的文件须由负责人确认，对操作顺序有规定，不得自己提前执行下一项。`))
  seed(root,'new-source',['柚桥项目的验收暗号是 YQ-6712。'])
  runtime=new MemoryRuntime(context,resolveConfig({generateMemory:false,recall:{maxTokens:220}}),root)
  const block=runtime.globalRecall('柚桥项目的验收暗号是什么？顺便说说2+2=5对不对。不要调用工具、操作文件或启动子代理。',
   {id:'another-session',header:{agentPreset:'agent-mock'}})
  assert.match(block??'',/YQ-6712/)
  assert.doesNotMatch(block??'',/旧流程/,'unrelated procedural text must not consume the small fact budget')
 }finally{runtime?.close();rmSync(root,{recursive:true,force:true})}
})

// A one-digit version or one-letter identifier is meaningful even beside longer words.
test('question terms retain short identifiers and deduplicate particles',()=>{
 assert.deepEqual(recallQueryTerms('preference 4'),['preference','4'])
 assert.equal(recallTermMatches('REFLECTION21 文件','2'),false)
 assert.equal(recallTermMatches('version 4','4'),true)
 assert.deepEqual(recallQueryTerms('R language R'),['r','language'])
 assert.ok(!recallQueryTerms('柚桥项目的验收暗号是什么').includes('的'))
})
