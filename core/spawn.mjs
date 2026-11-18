import { spawn } from 'node:child_process'
import process from 'node:process'
import fs from 'node:fs'
import { mmSpawnSpec } from './mm-runtime.mjs'

const isWin = process.platform === 'win32'

/**
 * 启动策略（Windows 关键）：
 *   1. 有 nodeEntry（.js/.mjs）→ 用当前 node 直接跑，绕开 .cmd 与 cmd.exe
 *      （shell:true 传 .cmd 会触发 node 原生断言崩溃 DEP0190）
 *   2. 原生 .exe → 直接 spawn
 *   3. 其他 .cmd/.bat → cmd.exe /d /s /c 显式包裹
 */

/**
 * Agent 隔离环境变量 —— 防止被派发的 agent「反向指挥」工作台。
 *
 * 事故背景：MiniMax 被派发到 agent-hub 自己目录下时，发现旁边就有个 7788 端口的
 * hub，直接打 /api/agents、/api/run 把整批任务又派发了一遍（还被派发对象的回答
 * 又回流一次），一轮 6 分钟。
 *
 * 隔离手段（不指望 agent 听话，靠环境让它「看不到」）：
 *   1. AGENT_HUB_WORKER=1         —— 标记这是被派发的子任务，不是主控
 *   2. AGENT_HUB_NO_FANOUT=1      —— 约定变量，runAgent 内部读到就拒绝再派发
 *   3. 把 HUB 端口相关变量抹掉，避免 agent 顺着环境变量找到入口
 *   4. NO_PROXY 追加 127.0.0.1   —— 走代理时不要把本地回环也代理出去
 */
function isolationEnv(runId, agentId) {
  const env = {
    AGENT_HUB_WORKER: '1',
    AGENT_HUB_NO_FANOUT: '1',
    AGENT_HUB_RUN_ID: runId || '',
    AGENT_HUB_AGENT: agentId || '',
  }
  return env
}

export function spawnTransport(t, extraArgs = [], { cwd, env, stdio, stdin = 'ignore' } = {}) {
  // runtime: 'electron' → 用 Electron 内嵌 Node 跑（MiniMax 的原生 sqlite 是 ABI 146，
  // 系统 node 24.20 是 137，装不上就会在退出时断言崩溃 exit 134）
  // 约定：extraArgs 若为空（ACP 这类「transport 自身 args 即完整参数表」的调用），
  // 就用 t.args 当完整参数表；否则以调用方给的完整参数表为准。
  // 两种情况下都只传给 mmSpawnSpec 一份，绝不拼 t.args + extraArgs。
  if (t.runtime === 'electron') {
    const fullArgs = extraArgs.length ? extraArgs : t.args || []
    const spec = mmSpawnSpec(fullArgs)
    return spawn(spec.cmd, spec.args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...isolationEnv(env?.AGENT_HUB_RUN_ID, env?.AGENT_HUB_AGENT), ...spec.env, ...env, ...productEnv(t) },
      stdio: stdio || [stdin, 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
  }

  const opts = {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...isolationEnv(env?.AGENT_HUB_RUN_ID, env?.AGENT_HUB_AGENT), ...env, ...productEnv(t) },
    // 关键：非交互 agent CLI 在 Windows 上若继承了父进程的 stdin 管道，
    // 会卡在等待 stdin EOF / 或被上游管道内容污染（Qoder 会重复刷 session created
    // 然后 exit 1）。默认给一个已关闭的 stdin，需要写 stdin 的调用方显式传 'pipe'。
    stdio: stdio || [stdin, 'pipe', 'pipe'],
    windowsHide: true,
  }

  // 相对 nodeEntry 一律按工程根解析（registry 里已给绝对路径，这里只做兜底）
  if (t.nodeEntry && fs.existsSync(t.nodeEntry)) {
    return spawn(process.execPath, [t.nodeEntry, ...t.args, ...extraArgs], { ...opts, shell: false })
  }

  if (isWin && /\.(cmd|bat)$/i.test(t.cmd)) {
    const line = [t.cmd, ...t.args, ...extraArgs].map(quoteWin).join(' ')
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, shell: false })
  }

  return spawn(t.cmd, [...t.args, ...extraArgs], { ...opts, shell: false })
}

/**
 * 有些 agent 的 CLI 有两套 product.json（比如 codebuddy：npm 包自带链到 codebuddy.ai，
 * 桌面版 WorkBuddy 链到 workbuddy.cn，两套的端点、认证方式、模型 id 都不一样）。
 * transport 上带 productConfig 就注入 ACC_PRODUCT_CONFIG_PATH 指定用哪套。
 */
function productEnv(t) {
  if (!t || !t.productConfig) return {}
  if (!fs.existsSync(t.productConfig)) return {}
  return { ACC_PRODUCT_CONFIG_PATH: t.productConfig }
}

function quoteWin(s) {
  s = String(s)
  if (s === '') return '""'
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** 按行切 stdio 流（兼容 \r\n） */
export function lineReader(stream, onLine) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line.trim()) onLine(line)
    }
  })
  stream.on('end', () => {
    if (buf.trim()) onLine(buf.trim())
  })
}
