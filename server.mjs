import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bus, makeEmitter, nextRunId } from './core/bus.mjs'
import { listAgents, getAgent } from './core/registry.mjs'
import { runAgent } from './core/runner.mjs'
import { authStatus, startLogin } from './core/auth.mjs'
import { loomyStatus } from './core/loomy-http.mjs'
import { aliceStatus } from './core/alice-cdp.mjs'
import { traeLive } from './core/trae-cn.mjs'
import { wbLive } from './core/workbuddy.mjs'
import { traeCdpStatus } from './core/trae-cdp.mjs'
import { doubaoStatus } from './core/doubao-cdp.mjs'
import { scnetStatus } from './core/scnet-cdp.mjs'
import { aliceModels } from './core/alice-cdp.mjs'
import { doubaoModels } from './core/doubao-cdp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(__dirname, 'web')
const PORT = Number(process.env.PORT || 7788)
let ACTUAL_PORT = PORT

/** 运行中的任务表 */
const runs = new Map() // runId -> {runId, agentId, prompt, cwd, startedAt, status, abort}

/* ----------------------------- SSE ----------------------------- */

const sseClients = new Set()

bus.on('event', (ev) => {
  const line = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(line)
    } catch {
      sseClients.delete(res)
    }
  }
})

/* ---------------------------- helpers ---------------------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid JSON body')
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let p = url.pathname === '/' ? '/index.html' : url.pathname
  const file = path.join(WEB, decodeURIComponent(p))
  if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' })
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' })
  const ext = path.extname(file)
  const mime =
    { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }[ext] ||
    'application/octet-stream'
  res.writeHead(200, { 'content-type': mime })
  fs.createReadStream(file).pipe(res)
}

/* ------------------------- 单个 run 执行 ------------------------- */

/* ---------------------- 派发回环防护 ---------------------- */

/**
 * 事故：MiniMax 被派发到 agent-hub 自己目录下，发现旁边跑着 7788 端口的 hub，
 * 直接打 /api/run 把整批任务又派发了一遍，6 分钟、把每个 agent 都重复问了一次。
 *
 * 两层防护：
 *   1. 环境变量标记（core/spawn.mjs 的 isolationEnv）—— 子进程能读到 AGENT_HUB_WORKER=1
 *   2. 这里：带 agent 环境的请求 + 已存在 root run 时，直接 409 拒绝
 * 显式想嵌套时（自己在脚本里调 API）可以通过 header `x-agent-hub-allow-fanout: 1` 放行。
 */
const MAX_DEPTH = 2

function depthOf(runId) {
  const r = runs.get(runId)
  return r?.depth ?? 0
}

function fanoutGate(req) {
  if (req.headers['x-agent-hub-allow-fanout'] === '1') return null
  // 子进程继承的 AGENT_HUB_WORKER=1 会随 env 传下去，但 HTTP 请求头不会。
  // 所以真正管用的是「当前有 root run 在跑 + 请求方是本机」这个组合信号：
  // 我们自己发起的 root run 不会在别人跑着的时候再打 /api/run 开新根。
  const runningRoots = [...runs.values()].filter((r) => r.status === 'running' && !r.parentRunId)
  const ua = String(req.headers['user-agent'] || '')
  const looksLikeAgent = /curl|node|python|axios|undici|wget/i.test(ua)
  if (runningRoots.length > 0 && looksLikeAgent) {
    return {
      error: 'fanout blocked',
      reason: '已有根任务在运行，疑似被派发的 agent 在反向派发',
      runningRoots: runningRoots.map((r) => ({ runId: r.runId, agentId: r.agentId, ms: Date.now() - r.startedAt })),
      hint: '确需嵌套请加 header x-agent-hub-allow-fanout: 1',
    }
  }
  return null
}

function executeRun({ agentId, prompt, cwd, transport, model, extraArgs = [], parentRunId = null, concurrent = false }) {
  // 兜底：调用方没给模型时，强制落到这个 agent 自己的 defaultModel。
  // 不补的话 CLI 会用厂商内置默认（workbuddy 会去请求 openrouter/deepseek/... 然后 400）。
  if (!model) {
    const ag = getAgent(agentId)
    if (ag?.defaultModel) model = ag.defaultModel
  }
  const runId = nextRunId(agentId)
  const emit = makeEmitter(runId, agentId)
  const rec = {
    runId,
    agentId,
    prompt,
    cwd,
    transport,
    model,
    parentRunId,
    depth: parentRunId ? depthOf(parentRunId) + 1 : 0,
    startedAt: Date.now(),
    status: 'running',
  }
  runs.set(runId, rec)

  ;(async () => {
    try {
      const r = await runAgent(agentId, { prompt, cwd, transport, model, extraArgs, emit, concurrent })
      rec.status = 'done'
      // 有些轨（runCli / runTrae / runMinimax）是一次性把全文返回的，
      // 期间 SSE 可能没吐过 text 增量（比如 codebuddy 的 result 帧），
      // 这时要补发一次，否则 lastText 空、下游编排拿不到上游输出。
      if (r?.text && !rec.lastText) {
        rec.lastText = r.text
        emit.text(r.text)
      }
    } catch (e) {
      rec.status = 'error'
      rec.error = e.message
      emit.error(e.message)
    } finally {
      rec.endedAt = Date.now()
      // 延迟清理，留给前端拉取
      setTimeout(() => runs.delete(runId), 10 * 60 * 1000)
    }
  })()

  return runId
}

/* ------------------------- 任务分步解析 ------------------------- */

/**
 * 把「1. xxx\n2. yyy」这类清单拆出来。
 * 只认行首编号（1. / 1、/ 1) / 第1步 / 步骤1），且至少 2 步才算清单。
 */
function parseSteps(text) {
  const lines = String(text || '').split(/\r?\n/)
  const re = /^\s*(?:第\s*(\d+)\s*步|步骤\s*(\d+)|(\d+)\s*[.、)）:：])\s*(.+)$/
  const out = []
  for (const line of lines) {
    const m = line.match(re)
    if (!m) continue
    const n = Number(m[1] || m[2] || m[3])
    const body = (m[4] || '').trim()
    if (!body) continue
    out.push({ n, text: body })
  }
  // 编号必须是 1,2,3… 递增的，否则不算分步清单
  if (out.length < 2) return []
  for (let k = 0; k < out.length; k++) if (out[k].n !== k + 1) return []
  return out
}

/**
 * 用编排层的权威指派替换用户原 prompt 的分步部分。
 * 保留用户原话（作为背景），但明确覆盖掉「你是第一个 agent，只做任务 1」这类会误导的句子。
 */
function assignPrompt(original, index, total, step, agents) {
  const mine = step ? `第 ${step.n} 步：${step.text}` : '（本链路没有给你分配具体步骤，只做与你的位置相关的那一步）'
  return [
    '【编排指派 · 以此为准】',
    `你是本链路的第 ${index + 1} 位（共 ${total} 位）：${agents[index] || ''}。`,
    `你**只做一步**，就是下面这一步：`,
    '',
    mine,
    '',
    '规则：',
    '- 不要做前面步骤的事（上游已完成），也不要做后面步骤的事（下游会做）。',
    '- 用户原文里如果有「你是第一个 agent，只做任务 1」这类句子，那是写给第 1 位的，对你不适用。',
    '- 完成后用一句话说明「第 N 步已完成」并交代下游该做什么，就结束。',
    '',
    '【用户原始任务（仅作背景，勿据此越权）】',
    String(original || ''),
  ].join('\n')
}

/* ---------------------------- 编排 ---------------------------- */

/**
 * plan: [{ agent, prompt, cwd?, transport?, after?: number[] }]
 * after 指向 plan 中下标；无 after = 立即并行启动。
 */
async function orchestrate({ plan, cwd }) {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error('plan must be a non-empty array')
  plan.forEach((s, i) => {
    const a = getAgent(s.agent)
    if (!a) throw new Error(`plan[${i}] unknown agent ${s.agent}`)
    // 没指定模型 => 用这个 agent 自己的 defaultModel。
    // 绝不能把上游的模型名（比如 qoder 的）套到下游 agent 上：workbuddy 收到
    // openrouter/deepseek/deepseek-v4.1-flash-1017 会 400 service info not found。
    if (!s.model && a.defaultModel) s.model = a.defaultModel
  })

  // 把用户的任务原文拆成有序步骤：[{ n: 1, text: '在D:\\project\\...\\1.txt新建文件' }]
  // 支持 `1.` / `1、` / `1)` / `第1步` 这些常见写法。
  const steps = parseSteps(plan[0]?.prompt || '')
  // 链长 > 1 且能拆出 ≥2 步时，按位置把步骤分下去：第 i 位只做第 i 步。
  const assign = steps.length >= 2 && plan.length > 1 ? steps.slice(0, plan.length) : null

  const done = new Map() // index -> runId
  const results = []

  const waitAll = (idxs) =>
    Promise.all(
      idxs.map(
        (i) =>
          new Promise((resolve) => {
            const check = () => {
              const r = runs.get(done.get(i))
              if (!r || r.status !== 'running') resolve(r)
              else setTimeout(check, 300)
            }
            check()
          }),
      ),
    )

  // 分批：无依赖的先跑，有依赖的等
  const remaining = new Set(plan.map((_, i) => i))
  while (remaining.size) {
    const ready = [...remaining].filter((i) => (plan[i].after || []).every((j) => done.has(j)))
    if (ready.length === 0) throw new Error('circular or unsatisfiable dependencies in plan')

    // 等待依赖完成
    await Promise.all(
      ready.map(async (i) => {
        const deps = plan[i].after || []
        if (deps.length) await waitAll(deps)
        // 依赖结果注入 prompt
        let prompt = plan[i].prompt
        if (assign) {
          // 用户的原话（比如「你是第一个 agent，只做任务 1」）原样留在 prompt 里，
          // 每个 agent 都会读到 —— 它据此判断「第 1 步已有人做 / 我是第一个」，
          // 于是要么空转、要么把后面几步一起做了（实测 MiniMax 把 2 和 3 都做了）。
          // 这里把「分步清单 + 身份声明」整段换成编排层给出的一份权威指派。
          prompt = assignPrompt(prompt, i, plan.length, assign[i], plan.map((p) => p.agent))
        }
        if (deps.length) {
          const upstream = deps
            .map((j) => {
              const r = runs.get(done.get(j))
              return `### 来自 ${plan[j].agent} 的输出\n${r?.lastText || '(无文本输出)'}`
            })
            .join('\n\n')
          // 链式流水必须显式告诉它「你是第几位、只做哪一步」。
          // 否则原 prompt 里给第 1 个 agent 写的话（比如「你是第一个agent，只做任务1」）
          // 会被第 2、3 位原样读到，它们据此判断「已有人做了任务1，我不该越界」而空转。
          const pos = `【你在链路中的位置】第 ${i + 1} 位（共 ${plan.length} 位）`
          const only = deps.length
            ? `- 上游 ${deps.map((j) => plan[j].agent).join('、')} 已完成它那一步；你只做属于你的那一步，不要重做上游的事。\n`
            : ''
          prompt = `${prompt}\n\n${pos}\n${only}${upstream}`
        }
        const runId = executeRun({
          agentId: plan[i].agent,
          prompt,
          cwd: plan[i].cwd || cwd,
          transport: plan[i].transport,
          model: plan[i].model,
          extraArgs: plan[i].extraArgs,
          // 同批并发跑的多个 agent 若都往同一个文件写，必须排队，否则后写者会盖掉先写者。
          concurrent: ready.length > 1,
        })
        done.set(i, runId)
        remaining.delete(i)
      }),
    )
  }

  return { runIds: [...done.entries()].map(([i, runId]) => ({ index: i, agent: plan[i].agent, runId })) }
}

/* -------------------------- 文本聚合 -------------------------- */

// 收集每个 run 的文本，供下游依赖注入
bus.on('event', (ev) => {
  if (ev.type !== 'text') return
  const r = runs.get(ev.runId)
  if (r) r.lastText = (r.lastText || '') + ev.delta
})

/* ----------------------------- 路由 ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      return res.end()
    }

    if (url.pathname === '/api/agents' && req.method === 'GET') {
      const agents = await Promise.all(
        listAgents().map(async (a) => {
          const auth = await authStatus(a.id, { fresh: url.searchParams.get('fresh') === '1' })
          let live = null
          // 运行时模型清单可覆盖注册表兜底（alice / doubao 必须问客户端）
          let models = a.models
          try {
            if (a.id === 'loomy') {
              live = await loomyStatus()
              // 顺带告诉界面这次会走哪条轨，以及该轨能用哪些模型
              live.track = live.up ? 'http' : 'acp'
              live.tracks = { http: 'imodel/*（需开客户端）', acp: 'opencode/*（独立进程）' }
            }
            else if (a.id === 'alice') live = await aliceStatus()
            else if (a.id === 'trae') {
              // 积分/登录态来自 storage.json 解密；额外带上 CDP 可执行性
              const credits = await traeLive()
              const cdp = await traeCdpStatus(a.transports.client?.port || 9334)
              live = { ...credits, cdp }
            } else if (a.id === 'doubao') {
              // 豆包只有 CDP 一条真轨，live 就是「调试端口通不通」
              live = await doubaoStatus(a.transports.cdp?.port || 9335)
            } else if (a.id === 'scnet') {
              live = await scnetStatus(a.transports.cdp?.port || 9336)
            } else if (a.id === 'workbuddy') {
              live = await wbLive()
            }
          } catch (e) {
            live = { up: false, error: e.message }
          }
          // Alice / 豆包 的模型清单只能问客户端：Alice 走 window.alice.fetchMiyangModelCatalog()，
          // 豆包要真实点开输入框右下角的下拉读列表。CDP 没开就用注册表里的兜底子集。
          if (a.id === 'alice' && live?.up) {
            try {
              const ms = await aliceModels(a.transports.cdp?.port || 9333)
              if (ms.length) models = ms.map((m) => m.id)
            } catch { /* 保留兜底 */ }
          }
          if (a.id === 'doubao' && live?.up) {
            try {
              const ms = await doubaoModels(a.transports.cdp?.port || 9335)
              if (ms.length) models = ms
            } catch { /* 保留兜底 */ }
          }
          return { ...a, models, auth, live }
        })
      )
      return json(res, 200, { agents })
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = await body(req)
      try {
        const out = startLogin(b.agent)
        return json(res, 200, { ok: true, ...out })
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message })
      }
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {}
      }, 15000)
      req.on('close', () => {
        clearInterval(ping)
        sseClients.delete(res)
      })
      return
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      const gate = fanoutGate(req)
      if (gate) return json(res, 409, gate)
      const b = await body(req)
      if (!b.agent) return json(res, 400, { error: 'agent required' })
      getAgent(b.agent) // 校验
      if (b.parentRunId && depthOf(b.parentRunId) >= MAX_DEPTH)
        return json(res, 409, {
          error: `fanout depth limit ${MAX_DEPTH} reached`,
          hint: '被派发的 agent 不能再派发子任务',
        })
      const runId = executeRun({
        agentId: b.agent,
        prompt: b.prompt || '',
        cwd: b.cwd,
        transport: b.transport,
        model: b.model,
        concurrent: b.concurrent === true,
        extraArgs: b.extraArgs,
      })
      return json(res, 200, { runId })
    }

    if (url.pathname === '/api/orchestrate' && req.method === 'POST') {
      const b = await body(req)
      // 先同步跑完「第一批就绪任务」的派发（executeRun 立刻返回 runId，不阻塞），
      // 才能把 runIds 回给前端；整条链路的完成状态由 /api/runs + SSE 观察。
      const plan = Array.isArray(b.plan) ? b.plan : []
      const wanted = new Set(plan.map((s) => s.agent))
      const sentinel = new Set(wanted)
      const out = await Promise.race([
        orchestrate({ plan, cwd: b.cwd }),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ])
      if (out) return json(res, 200, out)
      return json(res, 200, {
        accepted: true,
        note: '流水线较长，首批派发已发出；用 /api/runs 或 SSE 观察后续进度',
        agents: [...sentinel],
      })
    }

    if (url.pathname === '/api/runs' && req.method === 'GET') {
      return json(res, 200, {
        runs: [...runs.values()].map(({ lastText, ...r }) => ({ ...r, lastText: (lastText || '').slice(-8000) })),
      })
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, port: ACTUAL_PORT, sse: sseClients.size, runs: runs.size })
    }

    if (req.method === 'GET') return serveStatic(req, res)

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) })
  }
})

server.listen(PORT, '127.0.0.1')

server.on('listening', () => {
  ACTUAL_PORT = server.address().port
  const url = `http://127.0.0.1:${ACTUAL_PORT}`
  console.log(`\n  Agent Hub  →  ${url}\n`)
  for (const a of listAgents()) {
    const t = a.transports.map((x) => x.name).join('/') || '-'
    console.log(`   ${a.installed ? '✓' : '×'} ${a.label.padEnd(10)} ${t.padEnd(20)} ${a.bin}`)
  }
  console.log('')

  // 双击启动时自动开浏览器
  if (process.env.AGENT_HUB_OPEN === '1') {
    import('node:child_process').then(({ exec }) =>
      exec(`start "" "${url}"`, { shell: 'cmd.exe' }, () => {})
    )
  }
})

server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') {
    console.error(`\n  ✗ 启动失败：${e.message}\n`)
    process.exitCode = 1
    return
  }

  // 端口被占：先判断是不是我们这个工作台已经在跑
  const alive = await new Promise((resolve) => {
    fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.json().then((j) => resolve(!!j?.ok)))
      .catch(() => resolve(false))
  })

  if (alive) {
    console.log(`\n  ✓ Agent Hub 已经在运行 → http://127.0.0.1:${PORT}`)
    console.log(`    直接打开浏览器即可，无需重复启动。\n`)
    if (process.env.AGENT_HUB_OPEN === '1') {
      const { exec } = await import('node:child_process')
      exec(`start "" "http://127.0.0.1:${PORT}"`, { shell: 'cmd.exe' }, () => {})
    }
    return
  }

  // 被别的程序占着：往后找一个空端口
  const { createServer } = await import('node:net')
  for (let p = PORT + 1; p < PORT + 12; p++) {
    const free = await new Promise((resolve) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.once('listening', () => s.close(() => resolve(true)))
      s.listen(p, '127.0.0.1')
    })
    if (!free) continue
    console.log(`\n  ⚠ 端口 ${PORT} 被其他程序占用，改用 ${p}`)
    server.listen(p, '127.0.0.1')
    return
  }
  console.error(`\n  ✗ 端口 ${PORT}–${PORT + 11} 全部被占用，无法启动\n`)
  process.exitCode = 1
})
