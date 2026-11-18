import { EventEmitter } from 'node:events'

/**
 * 全局事件总线：所有 adapter 统一往这里抛 AgentEvent，
 * HTTP/SSE 层按 runId 过滤后推给浏览器。
 */
export const bus = new EventEmitter()
bus.setMaxListeners(200)

let seq = 0
export function nextRunId(prefix = 'run') {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

/**
 * 统一事件模型（所有 adapter 的输出都必须落成这个形状）
 *
 *  type: run_start | session | text | thinking | tool_call | tool_result |
 *        file_edit | permission | usage | log | done | error
 */
export function makeEmitter(runId, agentId) {
  const emit = (ev) => {
    const payload = { ...ev, runId, agentId, ts: Date.now() }
    bus.emit('event', payload)
    return payload
  }
  return {
    emit,
    start: (meta = {}) => emit({ type: 'run_start', ...meta }),
    session: (sessionId, phase = 'created', extra = {}) =>
      emit({ type: 'session', sessionId, phase, ...extra }),
    text: (delta) => emit({ type: 'text', delta }),
    thinking: (delta) => emit({ type: 'thinking', delta }),
    toolCall: (name, input, id) => emit({ type: 'tool_call', id, name, input }),
    toolResult: (name, output, id) => emit({ type: 'tool_result', id, name, output }),
    fileEdit: (path, diff) => emit({ type: 'file_edit', path, diff }),
    permission: (id, options, detail) => emit({ type: 'permission', id, options, detail }),
    usage: (tokens) => emit({ type: 'usage', tokens }),
    log: (message, level = 'info') => emit({ type: 'log', level, message }),
    done: (result = {}) => emit({ type: 'done', ok: true, ...result }),
    error: (message, extra = {}) => emit({ type: 'error', ok: false, message, ...extra }),
  }
}
