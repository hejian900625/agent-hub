// 直接跑 CLI 轨的 adapter，把统一事件打到 stdout
// 用法：node tools/probe-cli.mjs <agent> "prompt"
import { runAgent } from '../core/runner.mjs'
import { makeEmitter, nextRunId, bus } from '../core/bus.mjs'

const [, , agentId = 'qoder', prompt = '回复两个字：在线'] = process.argv
const runId = nextRunId('probe')

const emit = makeEmitter(runId, agentId)
const t0 = Date.now()
let text = ''

bus.on('event', (e) => {
  if (e.runId !== runId) return
  const ms = String(Date.now() - t0).padStart(5)
  if (e.type === 'text') {
    text += e.delta ?? ''
    process.stdout.write(`[${ms}] text: ${JSON.stringify((e.delta ?? '').slice(0, 200))}\n`)
  } else if (e.type === 'thinking') {
    process.stdout.write(`[${ms}] think: ${JSON.stringify((e.delta ?? '').slice(0, 120))}\n`)
  } else if (e.type === 'error') {
    process.stdout.write(`[${ms}] !! error: ${e.message}\n`)
  } else {
    process.stdout.write(`[${ms}] ${e.type}: ${JSON.stringify(e).slice(0, 220)}\n`)
  }
})

try {
  await runAgent(agentId, { prompt, cwd: process.cwd(), emit })
  process.stdout.write(`\n--- FINAL (${Date.now() - t0}ms) ---\n${text}\n`)
} catch (e) {
  process.stdout.write(`\n--- THREW after ${Date.now() - t0}ms: ${e.message}\n`)
  process.exitCode = 1
}
