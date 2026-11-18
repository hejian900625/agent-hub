import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { spawnTransport, lineReader } from './spawn.mjs'

/**
 * ACP (Agent Client Protocol) 统一客户端
 * 规范：JSON-RPC 2.0 over stdio，ndjson。
 *
 * 客户端 → Agent：initialize / session/new / session/prompt / session/cancel
 * Agent → 客户端：session/update(通知) / session/request_permission(请求) /
 *                 fs/read_text_file, fs/write_text_file(请求)
 */
export class AcpClient extends EventEmitter {
  constructor({ transport, cwd, env, label = 'acp' } = {}) {
    super()
    this.transport = transport
    this.cmd = transport?.cmd
    this.args = transport?.args || []
    this.cwd = cwd
    this.env = env
    this.label = label
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.sessionId = null
    this.closed = false
    this.stderrTail = ''
  }

  start() {
    // Electron runtime（MiniMax）不接受未定义的 cwd —— mmSpawnSpec 里会兜底，但这里显式给
    this.proc = spawnTransport(this.transport, [], {
      cwd: this.cwd || process.cwd(),
      env: this.env,
      stdin: 'pipe',
    })

    lineReader(this.proc.stdout, (line) => this.#onLine(line))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-8000)
      this.emit('stderr', d)
    })
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      for (const [, p] of this.pending) p.reject(new Error(`agent exited code=${code} signal=${signal}`))
      this.pending.clear()
      this.emit('exit', { code, signal })
    })
    this.proc.on('error', (err) => {
      this.closed = true
      this.emit('error', err)
    })
    return this
  }

  #write(obj) {
    if (this.closed || !this.proc) throw new Error('acp process not running')
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result })
  }

  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async #onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this.emit('raw', line)
      return
    }

    // 响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result)
      }
      return
    }

    // 服务端请求（要我们应答）
    if (msg.id !== undefined && msg.method) {
      await this.#onServerRequest(msg)
      return
    }

    // 通知
    if (msg.method === 'session/update' || msg.method === 'session/notification') {
      this.emit('update', msg.params)
      return
    }

    this.emit('notification', msg)
  }

  async #onServerRequest(msg) {
    const { id, method, params } = msg
    try {
      switch (method) {
        case 'fs/read_text_file': {
          const content = await fs.promises.readFile(params.path, 'utf8')
          this.respond(id, { content })
          break
        }
        case 'fs/write_text_file': {
          await fs.promises.mkdir(requireDirname(params.path), { recursive: true })
          await fs.promises.writeFile(params.path, params.content ?? '', 'utf8')
          this.respond(id, {})
          break
        }
        case 'session/request_permission': {
          // 默认放行第一个非 reject 选项；上层可监听 permission 事件改写策略
          const options = params?.options || []
          const prefer =
            options.find((o) => o.kind === 'allow_always') ||
            options.find((o) => o.kind === 'allow_once') ||
            options[0]
          this.emit('permission', params)
          this.respond(id, {
            outcome: prefer ? { outcome: 'selected', optionId: prefer.optionId } : { outcome: 'cancelled' },
          })
          break
        }
        case 'terminal/create':
          this.respondError(id, -32601, 'terminal not supported by hub')
          break
        default:
          this.respondError(id, -32601, `unsupported client method: ${method}`)
      }
    } catch (e) {
      this.respondError(id, -32000, String(e.message || e))
    }
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    })
    this.capabilities = res
    return res
  }

  async newSession({ cwd, mcpServers = [] } = {}) {
    const res = await this.request('session/new', { cwd: cwd || this.cwd, mcpServers })
    this.sessionId = res.sessionId
    return res
  }

  /**
   * 标准 ACP：切 session 的模型/模式等 config option。
   * 服务端在 session/new 的返回值里给 configOptions，value 必须取自该列表。
   */
  async setConfigOption(configId, value) {
    return this.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId,
      value,
    })
  }

  async prompt(text) {
    return this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    })
  }

  cancel() {
    if (!this.closed) this.notify('session/cancel', { sessionId: this.sessionId })
  }

  kill() {
    this.closed = true
    try {
      this.proc?.kill()
    } catch {}
  }
}

function requireDirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : '.'
}
