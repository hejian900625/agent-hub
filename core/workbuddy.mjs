/**
 * WorkBuddy (CodeBuddy CLI) 登录桥。
 *
 * 背景：`codebuddy login` 子命令根本不存在（传它会直接打印
 * "Authentication required. Please use /login command to sign in to your account"），
 * 所以从工作台点「登录」以前是空操作。真正可编程的入口是 **SDK 控制协议**：
 * 以 --input-format stream-json --output-format stream-json 起子进程，往 stdin 写
 *
 *   {"type":"control_request","request_id":"r1",
 *    "request":{"subtype":"authenticate","methodId":"external","environment":"external"}}
 *
 * CLI 会回一条 control_request / auth_url_callback 带 authUrl（www.workbuddy.cn 的登录页），
 * 用户在浏览器扫码后 CLI 自己轮询 /v2/plugin/auth/token?state=... 拿 token，
 * 再回 auth_result_callback。token 落在 CLI 自己的凭证文件里，之后 -p 就能用了。
 *
 * 实测（2026-11-17，codebuddy 2.184.0 + WorkBuddy 5.11.3 的 product.json）：
 *   {"type":"control_request","request_id":"auth_url_1794886883166_1",
 *    "request":{"subtype":"auth_url_callback",
 *               "authState":{"state":"d6e8...","authUrl":"https://www.workbuddy.cn/login?platform=workbuddy&state=...&version=2.184.0"}}}
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'

const NM = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code')
export const WB_ENTRY = path.join(NM, 'bin', 'codebuddy')

/** WorkBuddy 桌面版自带的 product.json —— 用它才能走 workbuddy.cn 的端点与 58 个模型 */
export const WB_PRODUCT = 'D:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\product.json'
export const WB_MODELS_SRC = WB_PRODUCT

/** 正在跑的登录子进程：agentId -> { child, url, at } */
const sessions = new Map()

/** 读 WorkBuddy 桌面版 product.json 的模型表（58 项，含 credits / 上下文长度） */
let modelCache = { at: 0, list: null }
export function wbModelCatalog() {
  if (modelCache.list && Date.now() - modelCache.at < 60_000) return modelCache.list
  let list = []
  try {
    const d = JSON.parse(fs.readFileSync(WB_MODELS_SRC, 'utf8'))
    list = (d.models || [])
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        credits: m.credits || null,
        maxInputTokens: m.maxInputTokens ?? null,
        maxOutputTokens: m.maxOutputTokens ?? null,
        supportsToolCall: !!m.supportsToolCall,
        supportsImages: !!m.supportsImages,
      }))
  } catch {
    list = []
  }
  modelCache = { at: Date.now(), list }
  return list
}

/** 文本模型（排除 pure-completion / 图像 / 视频类，留给下拉框干净一点） */
const NON_TEXT = /(^codewise-)|(^completion-)|(^kling-)|(hunyuan-image)|(^hunyuan-3b$)|(^hunyuan-7b-dense$)/
export function wbChatModels() {
  const all = wbModelCatalog()
  const text = all.filter((m) => !NON_TEXT.test(m.id))
  return text.length ? text.map((m) => m.id) : all.map((m) => m.id)
}

export function wbDefaultModel() {
  // 别用 'default'：实测 `--model default` 能 exit 0 但正文全空（该 id 在服务端没有
  // 对应的 service info，回包是空的）。`auto` 是账号里真实可用的默认路由。
  return 'auto'
}

/** 当前是否有登录会话在等浏览器 */
export function wbLoginSession() {
  const s = sessions.get('workbuddy')
  if (!s) return null
  return { pid: s.child.pid, url: s.url, at: s.at, args: s.args }
}

/**
 * 起登录流程：把 authUrl 用系统浏览器打开，子进程继续轮询直到拿到 token。
 * 返回 { pid, url, cmd }。已有会话就直接返回旧的，不重复开。
 */
export function startWorkbuddyLogin({ open = true, timeoutMs = 300_000 } = {}) {
  const running = sessions.get('workbuddy')
  if (running && running.child.exitCode === null) {
    return { pid: running.child.pid, url: running.url, cmd: 'codebuddy authenticate（已有会话在等浏览器）', reused: true }
  }

  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', 'hi']
  const env = { ...process.env }
  if (fs.existsSync(WB_PRODUCT)) env.ACC_PRODUCT_CONFIG_PATH = WB_PRODUCT
  const child = spawn(process.execPath, [WB_ENTRY, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  })

  const rec = { child, url: null, at: Date.now(), args }
  sessions.set('workbuddy', rec)

  let buf = ''
  const onLine = (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    const sub = m?.request?.subtype
    if (sub === 'auth_url_callback') {
      const url = m.request.authState?.authUrl
      rec.url = url
      if (open && url) execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: false })
    }
    if (sub === 'auth_result_callback') {
      // 拿到 token 了（或失败），子进程使命完成
      setTimeout(() => {
        try {
          child.kill()
        } catch {}
        sessions.delete('workbuddy')
      }, 1500)
    }
  }
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  child.stderr.on('data', () => {})
  child.on('exit', () => {
    if (sessions.get('workbuddy') === rec) sessions.delete('workbuddy')
  })

  // 等 CLI 起来再发控制帧：过早写会被吞
  const kick = setTimeout(() => {
    try {
      child.stdin.write(
        JSON.stringify({
          type: 'control_request',
          request_id: 'wb_auth_1',
          request: { subtype: 'authenticate', methodId: 'external', environment: 'external' },
        }) + '\n'
      )
    } catch {}
  }, 2500)

  const giveUp = setTimeout(() => {
    clearTimeout(kick)
    if (sessions.get('workbuddy') === rec && !rec.url) {
      try {
        child.kill()
      } catch {}
      sessions.delete('workbuddy')
    }
  }, timeoutMs)

  child.on('exit', () => clearTimeout(giveUp))

  return { pid: child.pid, url: null, cmd: 'codebuddy authenticate（等 authUrl 回传）', reused: false }
}

/** 取 authUrl（前端轮询用；登录流程里通常是 2-3 秒后就有） */
export function workbuddyLoginUrl({ waitMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      const s = sessions.get('workbuddy')
      if (s?.url) return resolve({ url: s.url, pid: s.child.pid })
      if (!s) return resolve({ url: null, pid: null, reason: '登录会话已结束（超时或被取消）' })
      if (Date.now() - t0 > waitMs) return resolve({ url: null, pid: s.child.pid, reason: '仍在等 authUrl' })
      setTimeout(tick, 200)
    }
    tick()
  })
}

/**
 * 工作台 live 徽标用：能不能对话 + 是否有登录流程正在等浏览器。
 * 不读凭证文件（codebuddy 的登录态落点不固定，见 README §8），
 * 只报「有没有活着的登录会话」+「本地 product.json 在不在」。
 */
export async function wbLive() {
  const sess = currentSession()
  const pending = !!sess && !sess.done
  return {
    up: !!pending || sessions.size > 0,
    product: fs.existsSync(WB_PRODUCT),
    productConfig: WB_PRODUCT,
    loginPending: pending,
    loginUrl: sess?.url || null,
    models: (() => { try { return wbChatModels().length } catch { return 0 } })(),
  }
}

export function currentSession() {
  for (const s of sessions.values()) if (!s.done) return s
  return null
}
