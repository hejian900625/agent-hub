import { AcpClient } from './acp-client.mjs'
import { spawnTransport, lineReader } from './spawn.mjs'
import { getAgent } from './registry.mjs'
import { nextRunId } from './bus.mjs'
import { runLoomy, loomyStatus } from './loomy-http.mjs'
import { runAlice } from './alice-cdp.mjs'
import { runScnet } from './scnet-cdp.mjs'
import { runMinimax } from './minimax.mjs'
import { runTrae } from './trae-cdp.mjs'
import { runDoubao } from './doubao-cdp.mjs'

/**
 * 两轨执行器：
 *   1) runAcp   —— ACP JSON-RPC（Trae / WorkBuddy / MiniMax 原生支持）
 *   2) runCli   —— 非交互 CLI + stream-json（Qoder / 兜底通道）
 * 两者都把输出压成统一的 AgentEvent 流（见 core/bus.mjs）。
 */

/* ------------------------- ACP 轨 ------------------------- */

const abortError = (msg = 'cancelled') => Object.assign(new Error(msg), { name: 'AbortError' })

export async function runAcp(agentId, { prompt, cwd, emit, transport = 'acp', model, signal }) {
  const agent = getAgent(agentId)
  const t = agent.transports[transport]
  if (!t) throw new Error(`${agentId} has no ${transport} transport`)

  const client = new AcpClient({ transport: t, cwd, label: agentId })
  emit.start({ transport: 'acp', cwd })

  // 全局取消：先发 session/cancel 让 agent 自己收尾，300ms 后强杀进程
  const onAbort = () => {
    try {
      client.cancel()
    } catch {}
    setTimeout(() => {
      try {
        client.kill()
      } catch {}
    }, 300)
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  client.on('stderr', (d) => emit.log(String(d).trim().slice(0, 400), 'debug'))
  client.on('permission', (p) => emit.permission(p.toolCall?.toolCallId, p.options, p))

  let text = ''
  client.on('update', (params) => {
    const u = params?.update || params
    if (!u) return
    const sid = params?.sessionId
    if (sid && sid !== client.sessionId) {
      client.sessionId = sid
      emit.session(sid, 'active')
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = u.content?.text ?? u.content?.[0]?.text ?? ''
        if (chunk) {
          text += chunk
          emit.text(chunk)
        }
        break
      }
      case 'agent_thought_chunk': {
        const text = u.content?.text ?? ''
        if (text) emit.thinking(text)
        break
      }
      case 'tool_call':
        emit.toolCall(u.title || u.kind || 'tool', u.rawInput ?? u.input, u.toolCallId)
        break
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed')
          emit.toolResult(u.title || u.toolCallId, u.rawOutput ?? u.output, u.toolCallId)
        break
      case 'plan':
        emit.log(`plan: ${(u.entries || []).map((e) => `${e.status}:${e.content}`).join(' | ')}`)
        break
      default:
        break
    }
  })

  try {
    client.start()
    const init = await client.initialize()
    emit.log(`${agentId} acp ready (protocol ${init?.protocolVersion ?? '?'})`, 'debug')

    const s = await client.newSession({ cwd: cwd || process.cwd() })
    client.sessionId = s.sessionId
    emit.session(s.sessionId, 'created')

    // 标准 ACP 切模型：session/new 会带回 configOptions，
    // 里面 id:"model" 那项的 options 才是这个 agent 真正认的模型清单。
    // 传进来的 model 不在清单里就跳过（opencode 会回 Invalid params: model not found）。
    if (model && Array.isArray(s.configOptions)) {
      const mo = s.configOptions.find((o) => o.id === 'model' && Array.isArray(o.options))
      const hit = mo?.options?.find((o) => o.value === model)
      if (hit) {
        await client.setConfigOption('model', model)
        emit.log(`model → ${model}`, 'debug')
      } else if (mo) {
        emit.log(`ACP 不吃 ${model}（清单里没有），沿用 ${mo.currentValue}`, 'warn')
      }
    }

    const res = await client.prompt(prompt)
    const stopReason = res?.stopReason ?? 'end_turn'
    emit.done({ stopReason, sessionId: client.sessionId })
    return { ok: true, code: 0, sessionId: client.sessionId, stopReason, text }
  } catch (e) {
    if (signal?.aborted) {
      emit.cancelled('用户取消')
      throw abortError()
    }
    emit.error(e.message, { stderr: client.stderrTail.slice(-1500) })
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
    setTimeout(() => client.kill(), 1500)
  }
}

/* ------------------------- CLI 轨 ------------------------- */

export async function runCli(agentId, { prompt, cwd, emit, transport = 'cli', extraArgs = [], model, signal }) {
  const runId = nextRunId(agentId)
  const agent = getAgent(agentId)
  const t = agent.transports[transport]
  if (!t) throw new Error(`${agentId} has no ${transport} transport`)

  // 提示词走 stdin 而不是 argv：中文长提示走 argv 在 Windows 会踩命令行长度/编码问题，
  // 且 qodercli 会把 query 当成「初始 prompt」在启动阶段预处理。位置参数打底，
  // stdin 里再写一遍（支持 stdin 输入的 CLI 会以 stdin 为准）。
  const args = [...extraArgs]
  // 显式模型：Qoder 不带 -m 会 FatalRoutingError（见 registry 注释）。
  // codebuddy 只认长参数 --model，传 -m 会被当成未知选项；而且它不带 --model
  // 会用 product.json 里的 openrouter 默认模型，直接 400 service info not found。
  if (model && (agent.models || []).includes(model)) {
    args.push(agentId === 'workbuddy' ? '--model' : '-m', model)
  }
  if (!t.promptViaStdin) args.push(prompt)
  emit.start({ transport: 'cli', cwd, args: [t.cmd, ...t.args, ...args] })

  const child = spawnTransport(t, args, {
    cwd: cwd || process.cwd(),
    stdin: 'pipe',
    env: { AGENT_HUB_RUN_ID: runId || '', AGENT_HUB_AGENT: agentId },
  })

  const onAbort = () => {
    try {
      child.kill()
    } catch {}
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  // 关闭 stdin：不给 EOF 的话部分 CLI（Qoder）会一直挂着等输入
  try {
    if (t.promptViaStdin) child.stdin.write(prompt + '\n')
    child.stdin.end()
  } catch {}

  let sessionId = null
  let sawText = false

  lineReader(child.stdout, (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      emit.text(line + '\n')
      sawText = true
      return
    }
    handleStreamJson(msg, { emit, setSession: (id) => (sessionId = id) })
    if (msg.type === 'assistant' || msg.type === 'result') sawText = true
  })

  child.stderr.setEncoding('utf8')
  let errBuf = ''
  child.stderr.on('data', (d) => {
    errBuf = (errBuf + d).slice(-6000)
    emit.log(String(d).trim().slice(0, 300), 'debug')
  })

  const code = await new Promise((resolve) => child.on('exit', resolve))
  signal?.removeEventListener('abort', onAbort)
  if (signal?.aborted) {
    emit.cancelled('用户取消')
    throw abortError()
  }
  if (code !== 0) {
    emit.error(`${agentId} cli exited ${code}`, { stderr: errBuf.slice(-1500) })
    throw new Error(`${agentId} exited ${code}`)
  }
  // 部分 CLI（Qoder）会把正文只在 result.result 里给一次，
  // 之前的 assistant 帧内容为空；这时必须补发，否则界面全空
  if (!sawText && lastResult) emit.text(lastResult)
  emit.done({ sessionId, stopReason: 'end_turn', sawText: sawText || !!lastResult })
  return { ok: true, code: 0, sessionId, text: lastResult || '' }
}

/** Claude-Code 风格 stream-json 解析（CodeBuddy / Qoder 基本一致） */
let lastSessionId = null
let lastResult = ''
function handleStreamJson(msg, { emit, setSession }) {
  const type = msg.type

  if (type === 'system' || type === 'init') {
    const sid = msg.session_id || msg.sessionId
    // Qoder 每帧 system 都带同一个 session_id，只在首次（或换 id）时报一次，
    // 否则界面上会刷出一大串 "session created"
    if (sid && sid !== lastSessionId) {
      lastSessionId = sid
      setSession(sid)
      emit.session(sid, 'created')
    }
    if (msg.subtype === 'init' && !msg.__logged) {
      msg.__logged = true
      emit.log(`model=${msg.model ?? '?'} cwd=${msg.cwd ?? '?'}`, 'debug')
    }
    return
  }

  if (type === 'assistant' || type === 'message' || type === 'text') {
    const content = msg.message?.content ?? msg.content ?? msg.delta
    if (typeof content === 'string') return emit.text(content)
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) emit.text(block.text)
        else if (block.type === 'thinking' && block.thinking) emit.thinking(block.thinking)
        else if (block.type === 'tool_use') emit.toolCall(block.name, block.input, block.id)
        else if (block.type === 'tool_result')
          emit.toolResult(block.tool_use_id, block.content, block.tool_use_id)
      }
    }
    return
  }

  if (type === 'stream_event' || type === 'delta') {
    const d = msg.delta ?? msg.event?.delta
    if (d?.type === 'text_delta' && d.text) emit.text(d.text)
    else if (d?.type === 'thinking_delta' && d.thinking) emit.thinking(d.thinking)
    else if (typeof d?.text === 'string') emit.text(d.text)
    return
  }

  if (type === 'user' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_result') emit.toolResult(block.tool_use_id, block.content, block.tool_use_id)
    }
    return
  }

  if (type === 'result') {
    if (typeof msg.result === 'string' && msg.result.trim()) lastResult = msg.result
    // Qoder 的 total_credits、CodeBuddy 的 total_cost_usd 都在 result 帧上，
    // 不能只取 msg.usage，否则账单里只剩 token、没有钱。
    if (msg.usage || msg.total_cost_usd != null || msg.total_credits != null)
      emit.usage({ ...(msg.usage || {}), costUsd: msg.total_cost_usd, credits: msg.total_credits })
    if (msg.is_error)
      emit.error(
        (msg.errors && msg.errors[0]) || msg.result || msg.error_code || 'cli result error',
        { subtype: msg.subtype, code: msg.error_code }
      )
    return
  }

  if (type === 'error') {
    emit.error(msg.message || msg.error || 'unknown error')
    return
  }

  // 未知类型：原样透传到日志，方便适配新 agent
  emit.log(`unparsed: ${JSON.stringify(msg).slice(0, 300)}`, 'debug')
}

/* ------------------------- 统一入口 ------------------------- */


/* ---------------------- Loomy 双轨自动选择 ---------------------- */

/** 客户端开着吗（能连上 opencode serve 吗） */
async function isLoomyUp() {
  try {
    return !!(await loomyStatus())
  } catch {
    return false
  }
}

/**
 * 决定 Loomy 这次该走哪条轨。
 *  - 客户端开着，且（没指定模型 或 指定的是 imodel/*）→ http（能吃到 opencode.json 的 imodel 全家桶）
 *  - 指定了 opencode/* 模型却没开客户端 → 客户端开着优先，否则 ACP + 免费模型
 *  - 客户端没开 → ACP
 * 返回 { track, canAcp, reason }
 */
async function pickLoomyTrack(model) {
  const st = await loomyStatus().catch(() => ({ up: false }))
  const up = !!st.up

  // 模型前缀决定轨道 —— 这是硬约束，不是偏好：
  //   imodel/*   只存在于 opencode.json 的外壳注入 provider，只有 http 轨认
  //   opencode/* 是 opencode 自身上游，只有 ACP 轨的 configOptions 里有
  const wantsImodel = !!model && model.startsWith('imodel/')
  const wantsOpencode = !!model && model.startsWith('opencode/')

  if (wantsOpencode) {
    return up
      ? { track: 'acp', canHttp: true, reason: 'opencode/* 只认 ACP 的 configOptions' }
      : { track: 'acp', canHttp: false, reason: 'opencode/* 走 ACP 独立进程' }
  }
  if (wantsImodel) {
    if (up) return { track: 'http', canAcp: false, reason: 'imodel/* 只有 http 轨认' }
    return { track: 'http', canAcp: false, reason: 'imodel/* 需要开客户端' }
  }
  // 没指定模型：按客户端状态兜底
  if (up) return { track: 'http', canAcp: true, reason: '客户端开着，用默认 imodel 模型' }
  return { track: 'acp', canAcp: true, reason: '客户端未开，走独立 acp 进程' }
}


/* ---------------------- CDP 轨互斥锁 ---------------------- */

/**
 * CDP 类 agent（alice / trae）都是「往同一个输入框打字、读同一个回复区」，
 * 两个会话同时跑会互相覆盖输入、抢同一个 .markdown-renderer / .text-alice-text。
 * 这里用进程内串行锁强制排队：后来的等前面的跑完。
 *
 * 注意：锁是进程级的，多开 server 进程仍会打架 —— 所以工作台只应跑一个实例。
 */
/**
 * 跨 agent 串行锁：同一批派发里，多个 agent 可能被要求「追加写同一个文件」。
 * 实测 Qoder / WorkBuddy / Loomy / Doubao 都会「先读后写」——并发跑时后写的
 * agent 读到的是旧内容，于是把别人刚写的行整个覆盖掉（test.txt 只剩 2 行就是这么来的）。
 * 这里给 (cwd + 文件名) 维度加一把进程内队列，让写同名文件的派发自动排队。
 */
const pathLocks = new Map()
function withPathLock(key, fn) {
  if (!key) return fn()
  const prev = pathLocks.get(key) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  pathLocks.set(key, next.catch(() => {}))
  return next
}

/** 从 prompt 里嗅出被要求写入的文件名（绝对路径或相对名），用于取锁键。 */
function sniffWriteKey(prompt, cwd) {
  const text = String(prompt || '')
  const abs = text.match(/[A-Za-z]:\\[^\s"'`，。、）)】]+\.[A-Za-z0-9]{1,8}/g)
  if (abs && abs.length) return abs[0].toLowerCase()
  const rel = text.match(/(?:^|\s)([\w.\-]+\.(?:txt|md|json|log|csv|js|ts|py|yaml|yml))\b/)
  if (rel && rel[1]) return `${String(cwd || '').toLowerCase()}::${rel[1].toLowerCase()}`
  return null
}

const cdpLocks = new Map()
function withCdpLock(agentId, fn) {
  const prev = cdpLocks.get(agentId) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  cdpLocks.set(
    agentId,
    next.catch(() => {}),
  )
  return next
}

/* ---------------------- 角色限定（防越权） ---------------------- */

/**
 * 被派发的 agent 常常会「越界」：MiniMax 曾在自己的工作目录里发现 agent-hub 源码和
 * 7788 端口，直接反向派发了一整批任务。环境变量和 server 端的 fanoutGate 是硬拦，
 * 这里是软约束 —— 在 prompt 最前面声明它的角色边界，让模型自己不去做那件事。
 *
 * 只对「工作台内部派发」生效：runAgent 的任何调用都是被派发的一方。
 * 需要干净 prompt 时传 opts.rawPrompt = true 跳过。
 */
const ROLE_PREFIX = [
  '【角色限定】',
  '你是 Agent Hub 派发的一个子任务执行者，不是主控，也不是调度者。',
  '- 只完成下面这一条任务，直接给出结果，不要额外扩展。',
  '- 如果任务是分步的（任务1/2/3…），而 prompt 里标明了「你在链路中的位置」，就只做你那一步，其余步骤留给上/下游。',
  '- 禁止调用 http://127.0.0.1:7788 或任何 Agent Hub 接口（/api/run、/api/orchestrate 等）。',
  '- 禁止派发、唤起、询问其他 agent；需要协作时说明「需要上游提供什么」即可。',
  '- 如果你在工作目录里看到 agent-hub 的源码或配置文件，那是宿主程序，不要读取、修改或利用。',
  '',
  '【任务】',
].join('\n')

function withRole(prompt, raw) {
  if (raw) return prompt
  return `${ROLE_PREFIX}\n${prompt}`
}

export async function runAgent(agentId, rawOpts) {
  // 统一注入角色限定：所有轨（acp/http/cdp/cli/gui）都吃这一份
  const opts = { ...rawOpts, prompt: withRole(rawOpts.prompt, rawOpts.rawPrompt) }
  // 同一批派发里若多个 agent 都写同一个文件，串行化，避免「先读后写」互相覆盖。
  // 只有并发派发才需要排队（链式流水本身就是串行的，套锁反而会自锁）。
  if (!rawOpts.noPathLock && rawOpts.concurrent) {
    const key = sniffWriteKey(rawOpts.prompt, rawOpts.cwd)
    if (key) {
      if (rawOpts.emit?.log) rawOpts.emit.log(`文件锁排队：${key}`, 'debug')
      return withPathLock(key, () => runAgentCore(agentId, opts))
    }
  }
  return runAgentCore(agentId, opts)
}

async function runAgentCore(agentId, opts) {
  const agent = getAgent(agentId)
  const t = agent.transports
  // 某些 agent 的 ACP 轨能握手但实际拒绝执行（WorkBuddy 会回
  // done{stopReason:'refusal'}，正文全空），必须钉死走 CLI stream-json。
  // workbuddy：--acp 能握手但回 done{stopReason:'refusal'}，正文全空，必须钉死 CLI。
  // loomy 不写死：交给 pickLoomyTrack() 在运行时探测（见下）。
  // Loomy 双轨：模型前缀就是硬约束（imodel/* 只有 http 认，opencode/* 只有 ACP 认），
  // 所以在这里短路，不走下面的 prefer 通用链 —— 否则 prefer 会先命中 http 把 opencode/* 喂错轨。
  if (agentId === 'loomy' && !opts.transport) {
    const want = await pickLoomyTrack(opts.model)
    opts.emit.log(`loomy 轨：${want.track}（${want.reason}）`, 'debug')
    if (want.track === 'http') {
      try {
        return await runLoomy(agentId, { ...opts, agent: t.http.agent })
      } catch (e) {
        // 取消不是「轨失败」，绝不能拿 ACP 再跑一遍
        if (opts.signal?.aborted || e?.name === 'AbortError') throw e
        if (!want.canAcp) throw e
        opts.emit.log(`opencode http 轨失败（${e.message.slice(0, 120)}），回退 ACP`, 'warn')
        return await runAcp(agentId, { ...opts, transport: 'acp' })
      }
    }
    try {
      return await runAcp(agentId, { ...opts, transport: 'acp' })
    } catch (e) {
      if (opts.signal?.aborted || e?.name === 'AbortError') throw e
      if (!want.canHttp) throw e
      opts.emit.log(`ACP 轨失败（${e.message.slice(0, 120)}），回退 http`, 'warn')
      return await runLoomy(agentId, { ...opts, agent: t.http.agent })
    }
  }

  const PREFER_OVERRIDE = { workbuddy: 'cli' }
  const prefer =
    opts.transport ||
    PREFER_OVERRIDE[agentId] ||
    // trae 的 client 必须排在 cdp 前面：trae 现在同时带 cdp 与 client 两个键，
    // 而它的 cdp 轨跑的是 runTrae（Solo 工作台），不是 alice 的 runAlice。
    (t.http?.mode === 'opencode'
      ? 'http'
      : t.client?.mode === 'trae-cn'
        ? 'client'
        : t.cdp?.mode === 'cdp-generic' || (!t.client && t.cdp)
          ? 'cdp'
          : t.acp
            ? 'acp'
            : t.cli
              ? 'cli'
              : 'gui')


  // Trae CN：client 与 cdp 两个 transport 都指向同一个执行轨 runTrae
  if (
    agentId === 'trae' &&
    (prefer === 'client' || prefer === 'cdp') &&
    t.client?.mode === 'trae-cn'
  )
    return withCdpLock(agentId, () =>
      runTrae(agentId, { ...opts, port: t.client.port || t.cdp?.port || 9334 }),
    )
  // 豆包：只有 CDP 一条真轨（GUI 轨仅记录 prompt，不能结构化执行）。
  // CDP 是单窗口串行，同样要吃 withCdpLock。
  if (agentId === 'doubao' && t.cdp?.kind === 'cdp')
    return withCdpLock(agentId, () => runDoubao(agentId, { ...opts, port: t.cdp.port || 9335 }))
  // SCNet：同样只有 CDP 一条真轨，单窗口串行。
  if (agentId === 'scnet' && t.cdp?.kind === 'cdp')
    return withCdpLock(agentId, () => runScnet(agentId, { ...opts, port: t.cdp.port || 9336 }))
  if (prefer === 'cdp') return withCdpLock(agentId, () => runAlice(agentId, { ...opts, port: t.cdp?.port }))
  // MiniMax 必须走专用轨：它的原生 sqlite 是 ABI 146（Electron 内嵌 Node 24.19），
  // 系统 node 24.20 装载失败会在退出时断言崩溃 exit 134，不能用通用 runCli。
  if (prefer === 'cli' && agentId === 'minimax')
    return runMinimax(agentId, { ...opts, transport: t.cli, model: opts.model })
  if (prefer === 'acp') return runAcp(agentId, { ...opts, transport: 'acp' })
  if (prefer === 'cli') return runCli(agentId, { ...opts, transport: 'cli', model: opts.model })
  if (prefer === 'gui') return runGui(agentId, opts)
  throw new Error(`unsupported transport ${prefer} for ${agentId}`)
}

/** 无编程接口的 agent（Doubao）：进程级拉起，交给上层人工/CDP 接管 */
async function runGui(agentId, { emit, prompt }) {
  const agent = getAgent(agentId)
  emit.start({ transport: 'gui' })
  emit.log(`${agentId} 仅提供 GUI，无法结构化执行；已记录待派发 prompt`, 'warn')
  emit.permission('launch-gui', [{ optionId: 'open', name: '打开客户端' }], { bin: agent.bin })
  emit.done({ stopReason: 'gui_only', dispatchNote: prompt })
  return { transport: 'gui', ok: true, code: 0, text: '' }
}
