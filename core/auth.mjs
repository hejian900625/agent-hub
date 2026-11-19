import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { spawnTransport } from './spawn.mjs'
import { getAgent } from './registry.mjs'
import { traeStatus, readUserInfo, TRAE_EXE } from './trae-cn.mjs'
import { startWorkbuddyLogin, workbuddyLoginUrl, wbLoginSession, WB_ENTRY, WB_PRODUCT } from './workbuddy.mjs'
import { mmSpawnSpec } from './mm-runtime.mjs'
import { AcpClient } from './acp-client.mjs'

const HOME = process.env.USERPROFILE || 'C:\\Users\\Lenovo'

/**
 * 认证探测：不花模型 token，只看各家 credential 目录。
 * 返回 { status: 'ok'|'missing'|'unknown', detail }
 *
 * 路径必须对准 CLI 自己读的那个文件，猜错就会一直显示「未登录」——
 * 实测（2026-11-17）：
 *   qoder  → ~/.qoder/.auth/user（加密 blob，无扩展名；不是 credentials.json）
 *   minimax→ ~/.minimax/auth/prod/<env>/<region>/<clientId>/auth-state.json 里 status=authenticated
 *   workbuddy → ~/.credentials.json（CLI 的 getHomeDir() 是 home 本身，不是 ~/.codebuddy）
 *   trae   → 不在 CLI 侧：登录态在 Trae CN 客户端的 storage.json（iCubeAuthInfo://icube.cloudide，AES 加密），
 *            由 core/trae-cn.mjs 解密后判 expiredAt，并顺带给出积分余额
 */
const CRED_PATHS = {
  trae: [], // 走专门的 traeAuth()，见下
  qoder: [path.join(HOME, '.qoder', '.auth', 'user'), path.join(HOME, '.qoder', '.auth', 'credentials.json')],
  // 反编译 dist/codebuddy.js 实测：mcp_oauth_store → getHomeDir()/.credentials.json，
  // 另一个 getCredentialsPath() → getHomeDir()/credentials.json（无点），旧版机器还会散在
  // instances 目录里，由 migrateFromLegacyFormat() 迁移过来。
  workbuddy: [
    path.join(HOME, '.credentials.json'),
    path.join(HOME, 'credentials.json'),
    path.join(HOME, '.codebuddy', '.credentials.json'),
    path.join(HOME, '.codebuddy', 'credentials.json'),
    path.join(HOME, '.workbuddy', '.credentials.json'),
    path.join(HOME, '.workbuddy', 'credentials.json'),
    path.join(HOME, '.workbuddy', 'auth', 'credentials.json'),
  ],
  minimax: [
    path.join(HOME, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth-state.json'),
    path.join(HOME, '.minimax', 'auth', 'credentials.json'),
  ],
  doubao: [],
  // 桌面应用：没有 CLI credential 文件，登录态在客户端自身
  loomy: [],
  alice: [],
}

/** 文件存在但内部写着 status!=authenticated 的，视为未登录 */
const STATE_JSON = {
  minimax: { key: 'status', ok: 'authenticated', alt: 'expiresAtMs' },
}

const LOCAL_APPS = new Set(['alice', 'loomy', 'doubao', 'scnet'])

/**
 * ---------------------------------------------------------------------------
 * 三级状态：凭据存在 / 握手成功 / 额度可用
 *
 * 背景（2026-11-19）：早先的「已登录」只判断 credential 文件在不在。token 过期、
 * 积分耗尽、账号被限流时文件都还在，界面照样一片绿。所以现在每家的状态拆成：
 *
 *   config    —— 本地能读到凭据（或应用装好/在跑），**未做任何真实请求**
 *   handshake —— 真的发了一次轻量请求并成功（qoder 拉模型目录、minimax 跑一句
 *                最小 prompt、workbuddy 跑一句 hi、trae 打积分接口、loomy ACP initialize、
 *                GUI 三家的 CDP 会话 + 模型目录读取）
 *   quota     —— 握手成功且额度可判定为可用（目前只有 Trae 的积分接口能给出这个数）
 *
 * 拿不到额度的（qoder / workbuddy / minimax / loomy / doubao / alice / scnet）
 * 一律停在 handshake，界面写「额度未知」，绝不冒充「够用」。
 *
 * 真实探测很贵（qoder 8s、minimax 11s、workbuddy 10s+），所以：
 *   - /api/agents 默认只给 config 级（快）
 *   - /api/verify 才跑真实握手，结果缓存 5 分钟
 * ---------------------------------------------------------------------------
 */

export const LEVEL_ORDER = ['none', 'config', 'handshake', 'quota']
export const LEVEL_LABEL = {
  none: '未登录',
  config: '仅配置存在',
  handshake: '握手通过',
  quota: '额度可用',
}

const VERIFY_TTL = 5 * 60_000
const verifyCache = new Map() // agentId -> { at, checks }

/** 握手通道的兜底文案：探测分支重写 handshake 时可能没带 via */
const VIA_DEFAULT = {
  trae: 'api.trae.cn 积分接口',
  qoder: 'CLI --list-models',
  workbuddy: 'CLI 最小 prompt (hi)',
  minimax: 'CLI 最小 prompt (exec)',
  loomy: 'ACP initialize',
  doubao: 'CDP 9335 + 模型目录',
  alice: 'CDP 9333 + 模型目录',
  scnet: 'CDP 9336',
}

/**
 * 上次握手成功的时间。额度拿不到时，界面至少能说「上次成功 3 分钟前」，
 * 比干巴巴的「未知」有用；重启服务也保留（落在 ~/.agent-hub/verify.json）。
 */
const STATE_DIR = path.join(HOME, '.agent-hub')
const STATE_FILE = path.join(STATE_DIR, 'verify.json')
let lastOk = loadLastOk()

function loadLastOk() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

function markOk(agentId) {
  if (!agentId) return
  lastOk[agentId] = Date.now()
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(lastOk, null, 2))
  } catch {
    /* 落盘失败不影响探测 */
  }
}

function ageText(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '无成功记录'
  const m = Math.max(0, Math.round((Date.now() - n) / 60_000))
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`
}

/**
 * 把失败文本归成三档，回答「是过期、被限流、还是额度耗尽」。
 * 这是拿不到余额接口时的降级方案，不冒充精确额度。
 */
function classifyFailure(text) {
  const s = String(text || '')
  if (/401|403|unauthor|invalid token|token.{0,12}(expired|invalid)|please use \/login|未登录|登录已失效/i.test(s))
    return { state: 'auth_expired', fatal: true, detail: '凭据失效（401/未登录）' }
  if (/429|rate.?limit|too many requests|限流/i.test(s)) return { state: 'rate_limited', fatal: false, detail: '被限流（429）' }
  if (/402|insufficient|quota|credit|balance|额度|余额|exhaust/i.test(s)) return { state: 'exhausted', fatal: false, detail: '额度不足/耗尽' }
  return { state: 'error', fatal: false, detail: '请求失败' }
}

/** 异步子进程：带超时、收 stdout/stderr，不阻塞事件循环 */
function runAsync(cmd, args, { timeout = 30_000, cwd, env, onSpawn } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let out = ''
    let err = ''
    let settled = false
    let proc
    try {
      proc = spawn(cmd, args, {
        cwd: cwd || os.tmpdir(),
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message, ms: 0 })
    }
    onSpawn?.(proc)
    const timer = setTimeout(() => {
      try { proc.kill() } catch {}
    }, timeout)
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (d) => { if (out.length < 400_000) out += d })
    proc.stderr.on('data', (d) => { if (err.length < 200_000) err += d })
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out, err, ms: Date.now() - t0 })
    }
    proc.on('close', (code) => finish(code))
    proc.on('error', (e) => { err += e.message; finish(-1) })
  })
}

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ])
}

const short = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

function lvlOf(checks) {
  if (checks.handshake?.fatal) return 'none'
  // 只有真正拿到额度数字（Trae 积分）才算 quota；
  // 「最小请求 200」只证明此刻能用，不等于余额充足，仍停在 handshake。
  if (checks.quota?.ok === true && checks.quota?.kind === 'credits') return 'quota'
  if (checks.handshake?.ok === true) return 'handshake'
  if (checks.config?.ok === true) return 'config'
  return 'none'
}

function grade(checks, { na = false, agentId = null } = {}) {
  const level = na ? 'n/a' : lvlOf(checks)
  const quota = checks.quota || { ok: null, kind: 'unknown', detail: '' }
  const via = checks.handshake?.via || VIA_DEFAULT[agentId] || ''
  let detail
  if (level === 'n/a') detail = checks.config?.detail || '本地应用 · 无需 CLI 登录'
  else if (level === 'none') detail = checks.handshake?.detail || checks.config?.detail || '未检测到可用凭据'
  else if (level === 'config') detail = checks.config.detail + (checks.handshake?.detail ? ` · ${checks.handshake.detail}` : '')
  else if (level === 'handshake')
    detail =
      checks.handshake.detail +
      (quota.ok === null
        ? ' · 额度未知'
        : quota.ok === false
          ? ` · ${quota.detail || '额度异常'}`
          : ` · ${quota.detail || '最近请求 200 · 余额未暴露'}`)
  else detail = quota.detail

  const reach = na ? 'n/a' : level === 'none' ? 'down' : level === 'config' ? 'config' : 'up'
  if (reach === 'up') markOk(agentId)
  const at = lastOk[agentId] || null
  return {
    status: level === 'none' ? 'missing' : 'ok',
    reach,
    level,
    label: LEVEL_LABEL[level],
    detail,
    via,
    quota: { ok: quota.ok ?? null, kind: quota.kind || 'unknown', source: quota.source || '', detail: quota.detail || '', checkedAt: quota.checkedAt || null },
    lastOkAt: at,
    lastOkAge: ageText(at),
    checks,
  }
}

/**
 * Trae CN 登录态：解密 storage.json 里的 userInfo，看 token 过期时间。
 * 顺带把积分余额也拉回来，界面直接显示「3600 积分」。
 */
const traeCache = { at: 0, result: null }
/** WorkBuddy 登录后凭证写盘有延迟，缓存 8s 避免狂扫 */
const wbCache = { at: 0, result: null }

async function traeAuth(fresh) {
  if (!fresh && traeCache.result && Date.now() - traeCache.at < 60_000) return traeCache.result
  const checks = {
    config: { ok: false, detail: '' },
    handshake: { ok: false, detail: '', via: 'api.trae.cn 积分接口' },
    quota: { ok: null, kind: 'unknown', source: 'api.trae.cn', detail: '' },
  }
  try {
    const info = readUserInfo()
    checks.config = {
      ok: !!info?.token,
      detail: info?.token
        ? `storage.json · 用户 ${info.userId} · 有效期 ${String(info.expiredAt).slice(0, 10)}`
        : 'storage.json 里有登录项但没 token',
    }
    if (!checks.config.ok) return finishTrae(grade(checks, { agentId: 'trae' }))

    const t0 = Date.now()
    const st = await traeStatus()
    const ms = Date.now() - t0
    const exp = Date.parse(st.expiredAt)
    if (!st?.up) {
      // 401/过期 = 凭据存在但确实不可用
      checks.handshake = { ok: false, ms, fatal: true, detail: st?.reason || 'token 已失效' }
      checks.quota = { ok: false, kind: 'unknown', source: 'api.trae.cn', detail: '登录已失效，无法查询额度', checkedAt: Date.now() }
    } else if (st.credits == null && st.quotaError) {
      // 网络抖动 ≠ token 失效：停在 config 级，不冒充已验证
      checks.handshake = { ok: false, ms, detail: st.quotaError }
    } else {
      checks.handshake = { ok: true, ms, detail: `api.trae.cn 200（${ms}ms）` }
      if (st.credits != null) {
        const used = st.consumed != null && st.total != null ? `，已用 ${st.consumed}/${st.total}` : ''
        checks.quota = { ok: st.credits > 0, kind: 'credits', source: 'api.trae.cn 积分接口', detail: `${st.credits} 积分${used}`, checkedAt: Date.now() }
      } else {
        checks.quota = { ok: null, kind: 'unknown', source: 'api.trae.cn', detail: '积分字段缺失', checkedAt: Date.now() }
      }
    }
  } catch (e) {
    checks.config = { ok: false, detail: `本地凭据读取失败：${short(e.message)}` }
  }
  return finishTrae(grade(checks, { agentId: 'trae' }))
}

function finishTrae(result) {
  result.verifiedAt = Date.now()
  traeCache.at = Date.now()
  traeCache.result = result
  return result
}

/**
 * WorkBuddy 登录态：不看凭证文件（codebuddy 的凭证落点随版本变，实测
 * ~/.credentials.json / ~/credentials.json 都没写），直接跑一次真实请求。
 * 用 --model auto 问一句 "hi"，出 Success 就说明 token 有效、端点可用、模型可路由。
 * 缓存 8s（登录成功后界面会立刻刷新，8s 足够吸收连点）。
 */
async function wbAuth(fresh) {
  if (!fresh && wbCache.result && Date.now() - wbCache.at < 120_000) return wbCache.result
  let result
  const checks = {
    config: wbConfig(),
    handshake: { ok: false, detail: '', via: 'CLI 最小 prompt (hi)' },
    quota: { ok: null, kind: 'unknown', source: 'CLI 最小 prompt', detail: '' },
  }
  try {
    const r = await runAsync(process.execPath, [WB_ENTRY, '-p', '--output-format', 'json', '--model', 'auto', 'hi'], {
      timeout: 90_000,
      env: { ACC_PRODUCT_CONFIG_PATH: WB_PRODUCT },
    })
    if (/Please use \/login/i.test(r.out)) {
      checks.handshake = { ok: false, ms: r.ms, fatal: true, detail: '未登录：点登录后浏览器扫码（走 SDK authenticate）' }
    } else if (/"subtype":"success"/.test(r.out) || /"subtype": "success"/.test(r.out)) {
      const inTok = Number((r.out.match(/"input_tokens"\s*:\s*(\d+)/) || [])[1])
      const outTok = Number((r.out.match(/"output_tokens"\s*:\s*(\d+)/) || [])[1])
      const usage = Number.isFinite(inTok) && Number.isFinite(outTok) ? ` · in ${inTok} / out ${outTok} tokens` : ''
      checks.handshake = {
        ok: true,
        ms: r.ms,
        detail: `真实 prompt 成功 · ${WB_PRODUCT.includes('WorkBuddy') ? 'workbuddy.cn' : 'codebuddy.ai'} · ${r.ms}ms`,
      }
      checks.quota = {
        ok: true,
        kind: 'request',
        source: 'CLI 最小 prompt',
        detail: `最小请求 200${usage} · 余额未暴露`,
        checkedAt: Date.now(),
      }
    } else {
      const err = (r.out.match(/"errors":\s*\[\s*"([^"]{0,160})/) || [])[1]
      const why = classifyFailure(`${err || ''} ${r.out} ${r.err}`)
      checks.handshake = { ok: false, ms: r.ms, fatal: why.fatal, detail: err ? `探测失败：${err}` : `探测失败（exit ${r.code}）` }
      if (!why.fatal) checks.quota = { ok: false, kind: 'unknown', source: 'CLI 最小 prompt', detail: why.detail, checkedAt: Date.now() }
    }
  } catch (e) {
    checks.handshake = { ok: false, detail: `探测异常：${short(e.message)}` }
  }
  result = grade(checks, { agentId: 'workbuddy' })
  result.verifiedAt = Date.now()
  wbCache.at = Date.now()
  wbCache.result = result
  return result
}

/**
 * WorkBuddy 的凭证落点随版本变，实测本机这三个位置都不写文件，
 * 所以「配置存在」只能退一步看：CLI 入口 + 桌面版 product.json 是否齐备。
 * 真正的登录态一律以握手（一句 hi）为准。
 */
function wbConfig() {
  const file = configCheck('workbuddy')
  if (file.ok) return file
  if (fs.existsSync(WB_ENTRY) && fs.existsSync(WB_PRODUCT))
    return { ok: true, detail: `CLI + product.json 就绪（该版本不落盘凭证，需握手确认）` }
  return file
}

/** 纯本地检查：credential 文件是否存在（不代表可用） */
function configCheck(agentId) {
  const paths = CRED_PATHS[agentId] || []
  const hit = paths.find((p) => {
    try {
      const st = fs.statSync(p)
      return st.isFile() && st.size > 0
    } catch {
      return false
    }
  })
  if (!hit) return { ok: false, detail: paths[0] ? `凭据文件不存在：${paths[0]}` : '无 CLI 凭据文件' }
  const shape = STATE_JSON[agentId]
  if (shape) {
    try {
      const o = JSON.parse(fs.readFileSync(hit, 'utf8'))
      if (o[shape.key] !== shape.ok) return { ok: false, detail: `${hit} 里 status=${o[shape.key]}` }
      const exp = Number(o[shape.alt])
      if (Number.isFinite(exp) && exp > 0 && exp < Date.now()) return { ok: false, detail: 'token 已过期，请重新登录' }
    } catch (e) {
      return { ok: false, detail: `${hit} 解析失败：${short(e.message)}` }
    }
  }
  return { ok: true, detail: hit }
}

/** Qoder：--list-models 是带身份的真实目录请求，顺便验证了账号与端点 */
function qoderSpawn() {
  const cli = getAgent('qoder').transports.cli
  const cmd = cli.nodeEntry && fs.existsSync(cli.nodeEntry) ? process.execPath : cli.cmd
  const args = (cli.nodeEntry && fs.existsSync(cli.nodeEntry) ? [cli.nodeEntry] : []).concat(['--list-models'])
  return { cmd, args }
}

async function qoderChecks() {
  const checks = {
    config: configCheck('qoder'),
    handshake: { ok: false, detail: '', via: 'CLI --list-models' },
    quota: { ok: null, kind: 'unknown', source: '无余额接口', detail: '--list-models 不返回余额（可点「探测额度」发一次最小请求）' },
  }
  if (!checks.config.ok) return checks
  const { cmd, args } = qoderSpawn()
  const r = await runAsync(cmd, args, { timeout: 40_000 })
  const models = r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^MODEL$/i.test(s) && !/^[-─—]{2,}$/.test(s))
  if (r.code === 0 && models.length) {
    checks.handshake = { ok: true, ms: r.ms, detail: `--list-models 200 · ${models.length} 个模型 · ${r.ms}ms` }
  } else {
    const err = short(`${r.err} ${r.out}`, 160)
    const why = classifyFailure(err)
    checks.handshake = {
      ok: false,
      ms: r.ms,
      fatal: why.fatal,
      detail: err || `--list-models exit ${r.code}`,
    }
    if (!why.fatal) checks.quota = { ok: false, kind: 'unknown', source: 'CLI --list-models', detail: why.detail, checkedAt: Date.now() }
  }
  return checks
}

/** 按需额度探针：发一条最小 prompt，用返回码区分 200 / 401 / 429 / 额度耗尽 */
async function qoderQuotaProbe() {
  try {
    const { cmd, args } = qoderSpawn()
    const r = await runAsync(cmd, args.slice(0, -1).concat(['-p', '--output-format', 'json', '只回复 ok 两个字符']), { timeout: 90_000 })
    if (r.code === 0 && /"subtype"\s*:\s*"success"/.test(r.out)) {
      const c = Number((r.out.match(/"total_credits"\s*:\s*([\d.]+)/) || [])[1])
      const cost = Number.isFinite(c) ? ` · 本次消耗 ${c.toFixed(4)} 积分` : ''
      return { ok: true, kind: 'request', source: 'CLI 最小 prompt', detail: `最小请求 200${cost} · 余额未暴露`, checkedAt: Date.now() }
    }
    const why = classifyFailure(`${r.err} ${r.out}`)
    return { ok: false, kind: 'unknown', source: 'CLI 最小 prompt', detail: `${why.detail}（exit ${r.code}）`, checkedAt: Date.now() }
  } catch (e) {
    return { ok: false, kind: 'unknown', source: 'CLI 最小 prompt', detail: `探针异常：${short(e.message)}`, checkedAt: Date.now() }
  }
}

/** MiniMax：provider test 对 OAuth 不支持，只能跑一句最小 prompt（约 11s） */
async function minimaxChecks() {
  const checks = {
    config: configCheck('minimax'),
    handshake: { ok: false, detail: '', via: 'CLI 最小 prompt (exec)' },
    quota: { ok: null, kind: 'unknown', source: 'CLI 最小 prompt', detail: '' },
  }
  if (!checks.config.ok) return checks
  const model = getAgent('minimax').defaultModel
  let spec
  try {
    spec = mmSpawnSpec(['exec', '--prompt-mode', 'coding', '--model', model, '只回复 ok 两个字符，不要调用任何工具'])
  } catch (e) {
    checks.handshake = { ok: false, detail: `运行时不可用：${short(e.message)}` }
    return checks
  }
  const r = await runAsync(spec.cmd, spec.args, { timeout: 120_000, env: spec.env })
  const body = (r.out || '').trim()
  if (r.code === 0 && body && !/Assertion failed|RemoveEnvironmentCleanupHook/.test(r.err + body)) {
    checks.handshake = { ok: true, ms: r.ms, detail: `最小 prompt 成功 · ${model} · ${r.ms}ms` }
    checks.quota = { ok: true, kind: 'request', source: 'CLI 最小 prompt', detail: '最小请求 200 · 余额未暴露', checkedAt: Date.now() }
  } else {
    const err = short(`${r.err} ${r.out}`, 160)
    const why = classifyFailure(err)
    checks.handshake = {
      ok: false,
      ms: r.ms,
      fatal: why.fatal,
      detail: err || `mcode exit ${r.code}`,
    }
    if (!why.fatal) checks.quota = { ok: false, kind: 'unknown', source: 'CLI 最小 prompt', detail: why.detail, checkedAt: Date.now() }
  }
  return checks
}

/** Loomy：ACP initialize 是独立进程的真实协议握手（不需要开客户端） */
async function loomyChecks() {
  const acp = getAgent('loomy').transports.acp
  const checks = {
    config: { ok: fs.existsSync(acp.cmd), detail: acp.cmd },
    handshake: { ok: false, detail: '', via: 'ACP initialize' },
    quota: { ok: null, kind: 'unknown', source: '无余额接口', detail: 'ACP 握手不含额度' },
  }
  if (!checks.config.ok) return checks
  const client = new AcpClient({ transport: acp, cwd: os.tmpdir(), label: 'loomy-verify' })
  const t0 = Date.now()
  try {
    client.start()
    const res = await withTimeout(client.initialize(), 20_000, 'ACP initialize')
    checks.handshake = { ok: true, ms: Date.now() - t0, detail: `ACP initialize v${res?.protocolVersion ?? '?'} · ${Date.now() - t0}ms` }
  } catch (e) {
    checks.handshake = { ok: false, detail: `ACP initialize 失败：${short(e.message)}` }
  } finally {
    client.kill()
  }
  return checks
}

/**
 * GUI 三家（doubao / alice / scnet）：CDP 端口通只是「配置」，真正握手要看
 * 会话里能不能读到模型目录 —— 那一步得登录后才有。
 */
function guiChecks(agentId, { live, modelsFetched = 0 } = {}) {
  const agent = getAgent(agentId)
  const checks = {
    config: { ok: fs.existsSync(agent.bin), detail: agent.bin },
    handshake: { ok: false, detail: '', via: `CDP ${agent.transports.cdp?.port || ''}`.trim() },
    quota: { ok: null, kind: 'unknown', source: '无余额接口', detail: '客户端不暴露额度' },
  }
  if (!checks.config.ok) return checks
  if (agentId === 'scnet') {
    // SCNet 没有可枚举的模型目录（固定 SCNet-Max），判据是「CDP 通 + 停在任务页」
    checks.handshake = live?.up && live?.running
      ? { ok: true, via: `CDP ${live.port}`, detail: `会话可读（CDP ${live.port}）· ${agent.bin.includes('scnet') ? 'SCNet' : ''}` }
      : { ok: false, detail: live?.up ? `CDP ${live.port} 已连，但页面不在任务页（可能停在登录页）` : 'CDP 调试端口未监听（客户端没开或没带 --remote-debugging-port）' }
    return checks
  }
  if (live?.up && modelsFetched > 0) {
    checks.handshake = { ok: true, via: `CDP ${live.port} + 模型目录`, detail: `CDP 会话可读 · ${modelsFetched} 个模型` }
  } else if (live?.up) {
    checks.handshake = { ok: false, detail: `CDP ${live.port} 已连，但读不到模型目录（可能停在登录页）` }
  } else {
    checks.handshake = { ok: false, detail: live?.reason || 'CDP 调试端口未监听（客户端没开或没带 --remote-debugging-port）' }
  }
  return checks
}

const PROBES = {
  trae: () => traeAuth(true),
  qoder: qoderChecks,
  workbuddy: () => wbAuth(true),
  minimax: minimaxChecks,
  loomy: loomyChecks,
  doubao: (ev) => guiChecks('doubao', ev),
  alice: (ev) => guiChecks('alice', ev),
  scnet: (ev) => guiChecks('scnet', ev),
}

/**
 * @param {string} agentId
 * @param {{fresh?: boolean, verify?: boolean, quotaProbe?: boolean, live?: object, modelsFetched?: number}} opts
 *   verify=false 只做本地检查（快）；verify=true 才发真实轻量请求（缓存 5 分钟）。
 *   quotaProbe=true 额外发一条最小 prompt 探测额度档位（目前只有 qoder 需要，按需触发）。
 */
export async function authStatus(agentId, { fresh = false, verify = false, quotaProbe = false, live = null, modelsFetched = 0 } = {}) {
  if (agentId === 'trae') return traeAuth(fresh)
  if (agentId === 'workbuddy' && !verify) {
    // 未要求验证时只读本地文件，不为一张卡片跑 10s 的 prompt
    const cached = wbCache.result
    if (cached && Date.now() - wbCache.at < 60_000) return cached
    return grade(
      { config: wbConfig(), handshake: { ok: false, detail: '尚未握手（点「刷新登录状态」验证）' }, quota: { ok: null, kind: 'unknown' } },
      { agentId }
    )
  }
  if (agentId === 'workbuddy') return wbAuth(fresh)

  const probe = PROBES[agentId]
  if (!probe) {
    return grade(
      {
        config: { ok: false, detail: LOCAL_APPS.has(agentId) ? '本地应用 · 无需 CLI 登录' : 'GUI 登录' },
        handshake: { ok: false, detail: '' },
        quota: { ok: null, kind: 'unknown' },
      },
      { na: true, agentId }
    )
  }

  const cached = verifyCache.get(agentId)
  if (!fresh && !quotaProbe && cached && Date.now() - cached.at < VERIFY_TTL) {
    const checks = cached.checks
    // GUI 三家的握手依赖实时 CDP 状态，缓存只保留「额度」这类不会瞬变的结论
    const out =
      ['doubao', 'alice', 'scnet'].includes(agentId)
        ? grade({ ...checks, handshake: guiChecks(agentId, { live, modelsFetched }).handshake }, { agentId })
        : grade(checks, { agentId })
    out.verifiedAt = cached.at
    return out
  }

  if (!verify) {
    // 只给本地层，明确标注「未握手」
    const local =
      agentId === 'qoder' || agentId === 'minimax'
        ? configCheck(agentId)
        : agentId === 'loomy'
          ? { ok: fs.existsSync(getAgent('loomy').transports.acp.cmd), detail: getAgent('loomy').transports.acp.cmd }
          : guiChecks(agentId, { live, modelsFetched }).config
    return grade(
      { config: local, handshake: { ok: false, detail: '尚未握手（点「刷新登录状态」验证）' }, quota: { ok: null, kind: 'unknown' } },
      { agentId }
    )
  }

  const checks = await probe({ live, modelsFetched })
  if (quotaProbe && agentId === 'qoder') checks.quota = await qoderQuotaProbe()
  verifyCache.set(agentId, { at: Date.now(), checks })
  const out = grade(checks, { agentId })
  out.verifiedAt = Date.now()
  return out
}

/**
 * 触发登录：spawn 各家 login 命令，浏览器 OAuth 会自己弹。
 * 返回 pid，工作台不等结果。
 */
export function startLogin(agentId) {
  const agent = getAgent(agentId)
  const t = agent.transports.acp || agent.transports.cli || Object.values(agent.transports)[0]
  if (!t) throw new Error(`no transport for ${agentId}`)

  if (agentId === 'trae') {
    traeCache.at = 0
    traeCache.result = null
    const child = execFile(TRAE_EXE, [], { windowsHide: false })
    child.unref()
    return { pid: child.pid, cmd: `${TRAE_EXE}  （在客户端里扫码登录，登录后点「刷新登录状态」）` }
  }

  // WorkBuddy：没有 `login` 子命令，走 SDK 控制协议的 authenticate（见 core/workbuddy.mjs）
  if (agentId === 'workbuddy') {
    const r = startWorkbuddyLogin({ open: true })
    wbCache.at = 0
    return {
      pid: r.pid,
      url: r.url,
      cmd: `${WB_ENTRY} -p --input-format stream-json（control_request/authenticate → authUrl 已用浏览器打开，扫码后点「刷新登录状态」）`,
      reused: r.reused,
    }
  }

  const loginArgs = {
    qoder: ['login'],
    minimax: ['login'],
    doubao: [],
  }[agentId]

  if (!loginArgs) throw new Error(`${agentId} 无 CLI 登录，请打开客户端扫码`)

  const child = spawnTransport({ ...t, args: loginArgs }, [], { stdio: 'ignore' })
  child.unref()
  // 登录后让徽标立刻重查：清掉本地与真实探测两层缓存
  verifyCache.delete(agentId)
  traeCache.result = null
  wbCache.result = null
  return { pid: child.pid, cmd: `${t.nodeEntry || t.cmd} ${loginArgs.join(' ')}` }
}
