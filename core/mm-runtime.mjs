import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * MiniMax（mcode）运行时桥。
 *
 * 为什么需要这一层：
 *   @minimax-ai/code 的原生模块 better_sqlite3.node 是针对 NODE_MODULE_VERSION 146
 *   （Electron 35 / Node 24.19）编译的；用系统 node（24.20 / ABI 137）跑，装载失败，
 *   而这个失败被 mcode 的 exit 路径吞掉，表现成
 *       #  minimax-code: node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr
 *       exit code = 134，stdout 0 字节
 *   追溯很久才定位。正确解法是用 Electron 内嵌的 Node 当宿主（ELECTRON_RUN_AS_NODE=1），
 *   并把 better-sqlite3 指向桌面版 app.asar.unpacked 里那份 ABI 匹配的构建。
 *
 * 本模块负责在首次使用时自动把桌面版的 better-sqlite3 暂存到 core/mm-runtime/node_modules/，
 * 并返回 { exe, env } 给 spawn 用。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STAGE = path.join(HERE, 'mm-runtime', 'node_modules')

export const MM_DESKTOP = 'D:\\Program Files\\MiniMax Code\\MiniMax Code.exe'
export const MM_PKG = path.join(
  process.env.USERPROFILE || 'C:\\Users\\Lenovo',
  'AppData', 'Roaming', 'npm', 'node_modules', '@minimax-ai', 'code',
)
const MM_UNPACKED = 'D:\\Program Files\\MiniMax Code\\resources\\app.asar.unpacked\\node_modules'

let cached = null

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

/** 把桌面版 ABI 匹配的 better-sqlite3 复制到工程内，返回模块根目录；失败返回 null */
function stageSqlite() {
  const dst = path.join(STAGE, 'better-sqlite3')
  const native = path.join(dst, 'build', 'Release', 'better_sqlite3.node')
  if (fs.existsSync(native) && fs.statSync(native).size > 0) return dst

  const src = path.join(MM_UNPACKED, 'better-sqlite3')
  if (!fs.existsSync(src)) return null
  try {
    copyDir(src, dst)
    // better-sqlite3 用 require('bindings')(...) 解析原生模块，Desktop 的 asar 里
    // bindings 没有 unpacked，必须从 npm 版 mcode 里补两个纯 JS 依赖过来。
    for (const dep of ['bindings', 'file-uri-to-path']) {
      const from = path.join(MM_PKG, 'node_modules', dep)
      const to = path.join(STAGE, dep)
      if (fs.existsSync(from) && !fs.existsSync(to)) copyDir(from, to)
    }
    return dst
  } catch {
    return null
  }
}

/**
 * 探测 MiniMax 专用运行时。
 * @returns {{ok: boolean, exe?: string, node?: string, abi?: number, sqlite?: string, reason?: string}}
 */
export function mmRuntime(force = false) {
  if (cached && !force) return cached

  if (!fs.existsSync(MM_DESKTOP)) {
    return (cached = { ok: false, reason: `未找到桌面版：${MM_DESKTOP}` })
  }
  if (!fs.existsSync(path.join(MM_PKG, 'cli.js'))) {
    return (cached = { ok: false, reason: `未找到 mcode 包：${MM_PKG}` })
  }

  const r = spawnSync(MM_DESKTOP, ['-e', 'process.stdout.write(process.versions.node + " " + process.versions.modules)'], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (r.status !== 0 || !r.stdout) {
    return (cached = { ok: false, reason: `Electron 节点模式不可用：${(r.stderr || '').slice(0, 200)}` })
  }
  const [nodeVer, abi] = r.stdout.trim().split(/\s+/)
  const sqlite = stageSqlite()

  cached = {
    ok: true,
    exe: MM_DESKTOP,
    node: nodeVer,
    abi: Number(abi),
    sqlite: sqlite || undefined,
  }
  return cached
}

/** 组装 spawn 参数：{ cmd, args, env } —— cmd 是 Electron 可执行文件，不是 node */
export function mmSpawnSpec(extraArgs = []) {
  const rt = mmRuntime()
  if (!rt.ok) throw new Error(`MiniMax 运行时不可用：${rt.reason}`)
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  if (rt.sqlite) env.MAVIS_SQLITE3_MODULE_PATH = rt.sqlite
  return {
    cmd: rt.exe,
    // Electron 的 argv[1] 就是要执行的脚本；这里直接塞 mcode 的 cli.js
    args: [path.join(MM_PKG, 'cli.js'), ...extraArgs],
    env,
    runtime: rt,
  }
}

export function mmStatus() {
  const rt = mmRuntime()
  return {
    up: !!rt.ok,
    exe: rt.ok ? rt.exe : undefined,
    node: rt.ok ? rt.node : undefined,
    abi: rt.ok ? rt.abi : undefined,
    sqliteStaged: rt.ok ? !!rt.sqlite : false,
    reason: rt.ok ? undefined : rt.reason,
  }
}
