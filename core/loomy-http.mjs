/**
 * Loomy 轨：Loomy = Electron 外壳 + opencode 内核。
 * 外壳会拉起 `opencode serve --hostname=127.0.0.1 --port=<随机>`，
 * 所以不需要 CDP，直接打它自己的 HTTP API。
 *
 * 端点（实测 opencode 1.14.x）：
 *   GET  /config                 → agent / model 配置
 *   GET  /config/providers       → provider 与模型清单
 *   GET  /session                → 会话列表
 *   POST /session?directory=...  → 建会话
 *   POST /session/:id/message    → 发消息，阻塞返回完整 assistant message
 *   GET  /event                  → SSE 事件流
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CONFIG_DIR = 'C:\\Users\\Public\\Loomy\\acec4064d0fc\\opencode'
const PORT_FILE = 'D:\\workbuddy-hooks\\loomy_armor\\port.txt'
const HINT_PORTS = [4635, 4820, 4156, 4096]

let cachedBase = null

const get = async (url, ms = 4000) => {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(url, { signal: ac.signal })
    if (!r.ok) return null
    return r
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** netstat 里所有 127.0.0.1 LISTENING 端口（粗筛，后面用指纹校验） */
function listenPorts() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { maxBuffer: 8 << 20, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const out = new Set()
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/.test(line)) continue
        const m = line.match(/127\.0\.0\.1:(\d+)\s/)
        if (m) out.add(Number(m[1]))
      }
      resolve([...out])
    })
  })
}

/** 指纹：Loomy 的 opencode 一定有 loomy-file 这个内建 agent */
async function isLoomy(base) {
  const r = await get(`${base}/config`, 2500)
  if (!r) return false
  try {
    const j = await r.json()
    return !!(j?.agent && (j.agent['loomy-file'] || Object.keys(j.agent).some((k) => k.startsWith('loomy'))))
  } catch {
    return false
  }
}

export async function resolveBase(force = false) {
  if (cachedBase && !force) {
    const r = await get(`${cachedBase}/app`, 1500)
    if (r) return cachedBase
    cachedBase = null
  }

  const candidates = new Set()
  for (const p of HINT_PORTS) candidates.add(p)
  try {
    const p = fs.readFileSync(PORT_FILE, 'utf8').trim()
    if (/^\d+$/.test(p)) candidates.add(Number(p))
  } catch {}

  for (const p of candidates) {
    const base = `http://127.0.0.1:${p}`
    if (await isLoomy(base)) return (cachedBase = base)
  }

  // 兜底：扫本机监听端口（只试 >= 4000，最多 60 个，并发 8）
  const ports = (await listenPorts()).filter((p) => p >= 4000).slice(0, 60)
  for (let i = 0; i < ports.length; i += 8) {
    const batch = ports.slice(i, i + 8)
    const hits = await Promise.all(
      batch.map(async (p) => {
        const base = `http://127.0.0.1:${p}`
        return (await isLoomy(base)) ? base : null
      })
    )
    const hit = hits.find(Boolean)
    if (hit) return (cachedBase = hit)
  }
  throw new Error(
    'Loomy 的 opencode 服务未找到：先启动 Loomy 客户端（它会自己拉起 opencode serve）'
  )
}

export async function loomyStatus(force = false) {
  try {
    const base = await resolveBase(force)
    const r = await get(`${base}/config/providers`, 3000)
    const providers = r ? (await r.json())?.providers?.map((p) => p.id) ?? [] : []
    const app = await get(`${base}/app`, 2000)
    return { up: true, base, providers, webui: !!app }
  } catch (e) {
    return { up: false, error: e.message }
  }
}

export async function createSession(base, { cwd, title, agent } = {}) {
  const q = cwd ? `?directory=${encodeURIComponent(cwd)}` : ''
  const r = await fetch(`${base}/session${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: title || `hub ${new Date().toISOString().slice(0, 19)}`, ...(agent ? { agent } : {}) }),
  })
  if (!r.ok) throw new Error(`POST /session ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

/** 订阅 SSE，把 part 增量转成统一事件；返回 stop() */
function subscribe(base, emit, ac, stats) {
  ;(async () => {
    const r = await fetch(`${base}/event`, { signal: ac.signal, headers: { accept: 'text/event-stream' } })
    if (!r.ok || !r.body) return
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    // partID -> part.type（reasoning / text / tool ...）。delta 事件只给 partID，
    // 必须靠 part.updated 建映射，否则思维链会混进正文。
    const partType = new Map()
    // tool part 去重：opencode 会为同一 part 反复推 updated，且伴随状态推进
    const toolSeen = new Set()  // `${id}:${status}` 已报过
    const toolIds = new Set()   // 已报过 tool_call 的 part.id
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() || ''
      for (const c of chunks) {
        const line = c.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        const p = ev?.properties

        if (ev.type === 'message.part.updated' && p?.part) {
          if (p.part.id && p.part.type) partType.set(p.part.id, p.part.type)
          if (p.part.type === 'tool') {
            // opencode 对同一个 tool part 会反复推 message.part.updated：
            // 实测一次 bash 调用就推了 113 次，part.id 始终不变，只有 state.status
            // 在 pending → running → completed 之间变。原来每推一次就 emit 一次
            // toolCall，界面于是刷出上百行「⚙ bash {}」。
            // 按「id + status」去重：同一状态只报一次；状态推进时再报一次（带 delta）。
            const id = p.part.id
            const st = p.part.state || {}
            const status = st.status || 'unknown'
            const key = `${id}:${status}`
            if (toolSeen.has(key)) continue
            toolSeen.add(key)
            // 第一次见到这个 tool 报 tool_call，后续状态推进报 tool_result（带 status）
            if (!toolIds.has(id)) {
              toolIds.add(id)
              emit.toolCall(p.part.tool || 'tool', st.input ?? p.part.input, id)
            } else if (status === 'completed' || status === 'error') {
              const out = st.output ?? st.error ?? ''
              emit.toolResult(p.part.tool || 'tool', typeof out === 'string' ? out : JSON.stringify(out), id)
            }
          }
          continue
        }

        // 真正的增量：{partID, field:'text', delta:'...'}
        if (ev.type === 'message.part.delta' && p?.field === 'text' && p.delta) {
          const kind = partType.get(p.partID) || 'text'
          if (kind === 'reasoning') emit.thinking(p.delta)
          else {
            stats.text += p.delta.length
            emit.text(p.delta)
          }
          continue
        }

        if (ev.type === 'session.idle') emit.log('session idle', 'debug')
      }
    }
  })().catch(() => {})
  return () => ac.abort()
}

export async function runLoomy(agentId, { prompt, cwd, emit, sessionId, agent = 'loomy-file', model, signal }) {
  const base = await resolveBase()
  emit.start({ transport: 'http', base, cwd })
  emit.log(`opencode 服务 ${base}`, 'debug')

  let sid = sessionId
  if (!sid) {
    const s = await createSession(base, { cwd, title: prompt.slice(0, 40) })
    sid = s.id
  }
  emit.session(sid, 'active')

  const ac = new AbortController()
  const stats = { text: 0 }
  const stop = subscribe(base, emit, ac, stats)

  // 外部取消 → 同时掐断 SSE 和 POST /message
  const onAbort = () => ac.abort()
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const started = Date.now()
  let res
  try {
    const r = await fetch(`${base}/session/${sid}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([ac.signal, signal]) : ac.signal,
      body: JSON.stringify({
        agent,
        parts: [{ type: 'text', text: prompt }],
        // opencode 的模型指定是 {providerID, modelID}，不是 "provider/model" 字符串
        ...(model ? { model: { providerID: model.split('/')[0], modelID: model.split('/').slice(1).join('/') } } : {}),
      }),
    })
    if (!r.ok) throw new Error(`POST message ${r.status}: ${(await r.text()).slice(0, 400)}`)
    res = await r.json()
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') {
      emit.cancelled('用户取消')
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    }
    throw e
  } finally {
    // SSE 的 part.delta 是流式推送的，POST 返回时可能还在路上。
    // 先等一小会儿让最后的增量落地，再判断「SSE 到底吐没吐过」，
    // 否则 stats.text 还是 0 就会把全文再补发一遍 → 界面出现「在线在线」。
    await new Promise((r) => setTimeout(r, 800))
    stop()
    signal?.removeEventListener('abort', onAbort)
  }

  if (signal?.aborted) {
    emit.cancelled('用户取消')
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
  }

  // 同步返回里已有完整文本：拼起来（SSE 已吐过的部分前端会去重，这里只给收尾全文）
  const full = (res?.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')

  // SSE 已吐过增量就不要再重复整段；没吐过（事件流不可用）才补发全文
  if (full && stats.text === 0) emit.text(full)
  if (res?.info?.tokens) emit.usage(res.info.tokens)

  emit.done({
    stopReason: res?.info?.finish || 'stop',
    sessionId: sid,
    model: res?.info?.modelID,
    provider: res?.info?.providerID,
    ms: Date.now() - started,
  })
  // ok/code 是 runAgent 的统一返回形状（server 的 executeRun 要据此补发 lastText）
  return { ok: true, code: 0, sessionId: sid, transport: 'http', text: stats.text > 0 ? '' : full, model: res?.info ? `${res.info.providerID}/${res.info.modelID}` : null }
}

/**
 * Loomy 模型清单：直接读 opencode.json 的 provider.*.models。
 * opencode 的模型 id 一律是 `<provider>/<model>`（和 CLI / ACP 里 --model 的写法一致）。
 * 图片类模型（无 tool_call 能力）不放进聊天下拉。
 */
let modelCache = { at: 0, list: null }
export function loomyModels(force = false) {
  if (!force && modelCache.list && Date.now() - modelCache.at < 300_000) return modelCache.list
  const cfg = path.join(CONFIG_DIR, 'opencode.json')
  const o = JSON.parse(fs.readFileSync(cfg, 'utf8'))
  const out = []
  for (const [pid, pv] of Object.entries(o.provider || {})) {
    for (const [mid, mv] of Object.entries(pv.models || {})) {
      // 纯生图模型没有 tool_call 能力，放进来会让 agent 一用就废
      if (mv && mv.tool_call === false) continue
      if (mv && mv.modalities?.output && !mv.modalities.output.includes('text')) continue
      out.push(`${pid}/${mid}`)
    }
  }
  modelCache = { at: Date.now(), list: out }
  return out
}

export function loomyDefaultModel() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'opencode.json'), 'utf8'))
    if (o.model) return o.model
  } catch {}
  return loomyModels()[0] || null
}
