import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { spawnTransport } from './spawn.mjs'
import { getAgent } from './registry.mjs'
import { traeStatus, TRAE_EXE } from './trae-cn.mjs'
import { startWorkbuddyLogin, workbuddyLoginUrl, wbLoginSession, WB_ENTRY, WB_PRODUCT } from './workbuddy.mjs'

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

/** 有些 CLI 只能问自己（traex 已随官方 CLI 一起删掉，目前无登记项） */
const STATUS_PROBE = {}
const probeCache = new Map() // agentId -> { at, result }
const PROBE_TTL = 30_000

function runProbe(agentId) {
  const p = STATUS_PROBE[agentId]
  if (!p || !fs.existsSync(p.cmd)) return null
  try {
    const r = spawnSync(p.cmd, p.args, { encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
    const lower = out.toLowerCase()
    const ok = /logged in as|already logged in|登录成功|已登录/.test(lower) || (/logged in/.test(lower) && !/not logged in/.test(lower))
    return { status: ok ? 'ok' : 'missing', detail: out.split('\n')[0].slice(0, 200) || 'traex login status' }
  } catch (e) {
    return { status: 'unknown', detail: `probe failed: ${e.message}` }
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
  let result
  try {
    const st = await traeStatus()
    if (!st || !st.up) {
      result = { status: 'missing', detail: st?.reason || 'Trae CN 未登录（storage.json 里没有 iCubeAuthInfo）' }
    } else {
      const exp = Date.parse(st.expiredAt)
      if (Number.isFinite(exp) && exp < Date.now())
        result = { status: 'missing', detail: `token 已过期（${st.expiredAt}），请打开 Trae CN 重新登录` }
      else {
        // 登录态已经由 traeStatus 保证（本地 token 未过期）。
        // 积分可能因为接口抖动拿不到 —— 那就别显示积分，而不是显示成 "? 积分"。
        const parts = []
        parts.push(Number.isFinite(st.credits) ? `${st.credits} 积分` : '积分暂不可查')
        parts.push(`用户 ${st.userId}`)
        parts.push(`有效期 ${String(st.expiredAt).slice(0, 10)}`)
        result = { status: 'ok', detail: parts.join(' · ') }
      }
    }
  } catch (e) {
    result = { status: 'unknown', detail: `解密失败：${e.message}` }
  }
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
  if (!fresh && wbCache.result && Date.now() - wbCache.at < 8000) return wbCache.result
  let result
  const t0 = Date.now()
  try {
    const r = spawnSync(
      process.execPath,
      [WB_ENTRY, '-p', '--output-format', 'json', '--model', 'auto', 'hi'],
      {
        encoding: 'utf8',
        timeout: 90_000,
        windowsHide: true,
        env: { ...process.env, ACC_PRODUCT_CONFIG_PATH: WB_PRODUCT },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    const out = r.stdout || ''
    if (/Please use \/login/i.test(out)) {
      result = { status: 'missing', detail: '未登录：点登录后浏览器扫码（登录走 SDK authenticate，不是 login 子命令）' }
    } else if (/"subtype":"success"/.test(out) || /"subtype": "success"/.test(out)) {
      result = { status: 'ok', detail: `可用 · ${WB_PRODUCT.includes('WorkBuddy') ? 'workbuddy.cn' : 'codebuddy.ai'} · ${Date.now() - t0}ms` }
    } else {
      const err = (out.match(/"errors":\s*\[\s*"([^"]{0,160})/) || [])[1]
      result = { status: 'unknown', detail: err ? `探测失败：${err}` : `探测失败（exit ${r.status}）` }
    }
  } catch (e) {
    result = { status: 'unknown', detail: `探测异常：${e.message}` }
  }
  wbCache.at = Date.now()
  wbCache.result = result
  return result
}

export async function authStatus(agentId, { fresh = false } = {}) {
  if (agentId === 'trae') return traeAuth(fresh)
  if (agentId === 'workbuddy') return wbAuth(fresh)
  // 能自查的优先自查（结果缓存 30s，避免每次刷新页面都起进程）
  if (STATUS_PROBE[agentId]) {
    const c = probeCache.get(agentId)
    if (!fresh && c && Date.now() - c.at < PROBE_TTL) return c.result
    const r = runProbe(agentId)
    if (r) {
      probeCache.set(agentId, { at: Date.now(), result: r })
      return r
    }
  }

  const paths = CRED_PATHS[agentId] || []
  if (!paths.length)
    return { status: 'n/a', detail: LOCAL_APPS.has(agentId) ? '本地应用 · 无需 CLI 登录' : 'GUI 登录' }

  const hit = paths.find((p) => {
    try {
      const st = fs.statSync(p)
      return st.isFile() && st.size > 0
    } catch {
      return false
    }
  })
  if (!hit) return { status: 'missing', detail: paths[0] }

  const shape = STATE_JSON[agentId]
  if (shape) {
    try {
      const o = JSON.parse(fs.readFileSync(hit, 'utf8'))
      if (o[shape.key] !== shape.ok) return { status: 'missing', detail: `${hit} 里 status=${o[shape.key]}` }
      const exp = Number(o[shape.alt])
      if (Number.isFinite(exp) && exp > 0 && exp < Date.now()) return { status: 'missing', detail: 'token 已过期，请重新 mcode login' }
    } catch (e) {
      return { status: 'unknown', detail: `${hit} 解析失败：${e.message}` }
    }
  }
  return { status: 'ok', detail: hit }
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
  probeCache.delete(agentId) // 登录后让徽标立刻重查
  return { pid: child.pid, cmd: `${t.nodeEntry || t.cmd} ${loginArgs.join(' ')}` }
}
