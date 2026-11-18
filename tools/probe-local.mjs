// 本地应用轨道自检：不起 HTTP 服务，直接跑 adapter，事件打到 stdout
// 用法：node tools/probe-local.mjs <alice|loomy|trae> ["prompt"]
import { makeEmitter } from '../core/bus.mjs'
import { runAlice, aliceStatus } from '../core/alice-cdp.mjs'
import { runLoomy, loomyStatus } from '../core/loomy-http.mjs'
import { runTrae, traeCdpStatus } from '../core/trae-cdp.mjs'

const [agent = 'loomy', prompt = '只回复一个词：在线'] = process.argv.slice(2)

const emit = makeEmitter(`probe-${agent}`, agent)
const onEvent = (ev) => {
  if (ev.type === 'text') process.stdout.write(ev.delta)
  else if (ev.type === 'thinking') process.stdout.write(`\x1b[2m${ev.delta}\x1b[0m`)
  else if (ev.type === 'tool_call') console.log(`\n[tool] ${ev.name} ${JSON.stringify(ev.input ?? {}).slice(0, 200)}`)
  else if (ev.type === 'tool_result') console.log(`[tool_result] ${String(ev.output ?? '').slice(0, 200)}`)
  else console.log(`[${ev.type}] ${JSON.stringify({ ...ev, runId: undefined, agentId: undefined, ts: undefined })}`)
}
const { bus } = await import('../core/bus.mjs')
bus.on('event', onEvent)

let status
if (agent === 'alice') status = await aliceStatus()
else if (agent === 'trae') status = await traeCdpStatus()
else status = await loomyStatus(true)
console.log(`status: ${JSON.stringify(status)}\n---`)

const t0 = Date.now()
if (agent === 'alice') await runAlice('alice', { prompt, emit })
else if (agent === 'trae') await runTrae('trae', { prompt, emit })
else if (agent === 'loomy') await runLoomy('loomy', { prompt, emit, agent: 'loomy-file' })
else throw new Error(`unknown agent ${agent}`)
console.log(`\n--- ${Date.now() - t0}ms`)
