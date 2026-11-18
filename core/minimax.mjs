import { spawnTransport, lineReader } from './spawn.mjs'
import { nextRunId } from './bus.mjs'
import { mmRuntime } from './mm-runtime.mjs'

/**
 * MiniMax（mcode）的 stream-json 事件映射。
 *
 * mcode 0.7.7 的行协议（每行一个 JSON）：
 *   exec.started / session.started / turn.started
 *   item.started | item.updated   → { item: { id, type, contentDelta } }
 *   item.completed                → { item: { id, type, content | toolCall{input,output} } }
 *   turn.completed                → { model:{providerId,modelId,variant}, usage:{inputTokens,outputTokens,cacheReadTokens,totalTokens}, durationMs }
 *   exec.completed                → { result: { status, output } }
 *
 * item.type 有：reasoning / agent_message / tool_call
 * toolCall.status 是数字：2 = 已完成（同一条会反复 item.updated，status 递增），
 * 直接用 started/updated 当增量的判据会重复吐同一个 tool_call，必须按 status 去重。
 */
const TOOL_STATUS_DONE = 2

const seenTools = new Map()

function handleLine(line, emit, stats) {
  let e
  try {
    e = JSON.parse(line)
  } catch {
    return
  }

  switch (e.type) {
    case 'session.started':
      if (e.sessionId && e.sessionId !== stats.sessionId) {
        stats.sessionId = e.sessionId
        emit.session(e.sessionId)
      }
      break

    case 'item.started':
    case 'item.updated': {
      const it = e.item || {}
      const d = it.contentDelta
      if (typeof d !== 'string' || !d) return
      if (it.type === 'reasoning') emit.thinking(d)
      else if (it.type === 'agent_message') {
        emit.text(d)
        stats.text += 1
      }
      break
    }

    case 'item.completed': {
      const it = e.item || {}
      if (it.type === 'tool_call') {
        const tc = it.toolCall || {}
        if (tc.status !== TOOL_STATUS_DONE || seenTools.has(tc.id)) break
        seenTools.set(tc.id, true)
        const out = tc.output?.content
        const text = Array.isArray(out)
          ? out.map((x) => x?.text || '').join('\n')
          : typeof out === 'string' ? out : ''
        emit.tool_result({ id: tc.id, name: tc.name, ok: tc.status === TOOL_STATUS_DONE, output: text.slice(0, 4000) })
      } else if (it.type === 'agent_message' && typeof it.content === 'string') {
        stats.final = it.content
      }
      break
    }

    case 'turn.completed':
      if (e.usage) {
        emit.usage({
          input: e.usage.inputTokens,
          output: e.usage.outputTokens,
          cacheRead: e.usage.cacheReadTokens,
          total: e.usage.totalTokens,
        })
      }
      if (e.model) stats.model = `${e.model.providerId}/${e.model.modelId}`
      break

    case 'exec.completed': {
      const r = e.result || {}
      stats.exitStatus = r.status
      if (typeof r.output === 'string' && r.output) stats.output = r.output
      break
    }

    case 'error':
      emit.error(e.message || JSON.stringify(e).slice(0, 500))
      break
    default:
      break
  }
}

/**
 * 跑一次 MiniMax。必须走 Electron 内嵌 Node（ABI 146），系统 node 会 exit 134。
 * @param {string} agentId
 * @param {{prompt:string, cwd?:string, emit:object, transport?:object, model?:string, extraArgs?:string[]}} o
 */
export function runMinimax(agentId, { prompt, cwd, emit, transport, model, extraArgs = [] }) {
  return new Promise((resolve) => {
    const runId = nextRunId(agentId)
    const stats = { text: 0, sessionId: null, final: '', output: '', exitStatus: null, model: null }
    seenTools.clear()

    const rt = mmRuntime()
    if (!rt.ok) {
      emit.error(`MiniMax 运行时不可用：${rt.reason}`)
      emit.done({ ok: false, code: -1 })
      resolve({ ok: false, code: -1, runtime: rt })
      return
    }

    // 顺序要紧：mcode 的 commander 严格按位置收 prompt，
    // 选项必须全部排在 prompt 之前，否则报 "too many arguments for 'exec'"
    const args = [...(transport.args || []), '--output-format', 'stream-json']
    if (model) args.push('--model', model)
    args.push(prompt)

    if (process.env.AGENT_HUB_DEBUG) emit.log(`minimax argv: ${args.join(' ')}`, 'debug')
    const child = spawnTransport(transport, [...args, ...extraArgs], {
      cwd,
      stdin: 'ignore',
      env: { AGENT_HUB_RUN_ID: runId || '', AGENT_HUB_AGENT: agentId },
    })

    lineReader(child.stdout, (line) => handleLine(line, emit, stats))
    let errBuf = ''
    child.stderr.on('data', (d) => {
      const s = d.toString()
      // Electron 的 node 模式仍会打一些无害的 GPU/EPIPE 噪声，只留真错误
      if (/#  minimax|stack trace|^\s*\d+[:]/m.test(s)) return
      errBuf += s
    })

    child.on('error', (e) => {
      emit.error(`spawn 失败：${e.message}`)
      emit.done({ ok: false, code: -1 })
      resolve({ ok: false, code: -1, error: e.message })
    })

    child.on('exit', (code) => {
      const ok = code === 0 && (stats.exitStatus === 'succeeded' || stats.final)
      if (!ok && errBuf.trim()) emit.error(errBuf.trim().slice(0, 2000))
      if (!ok && !stats.text) emit.error(`mcode 退出码 ${code}，无输出（若为 134，说明没用 Electron 运行时）`)
      resolve({ ok, code, sessionId: stats.sessionId || null, model: stats.model, text: stats.output || stats.final })
    })
  })
}
