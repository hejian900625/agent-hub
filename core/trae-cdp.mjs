/**
 * Trae CN 轨：Electron 应用（TraeCN 1.107.1 / Electron 39.2.7），走 CDP 驱动 Solo 工作台。
 *
 * 背景：Trae CN 的对话请求不经过 HTTP，也不经过可控的 pipe ——
 *   renderer → `ahaIpc`（字节定制 Electron fork 的**原生导出**）→ ai-agent 子进程(harness.dll)。
 *   Node 侧无法复现 `ahaIpc`，所以唯一可行的自动化入口是 CDP 接管渲染进程。
 *
 * 已验证的发送链路（2026-11-17 实测）：
 *   1. 定位 `.chat-input-v2-input-box-editable`（contenteditable，**不能用 innerHTML 硬改**，
 *      React 受控组件会把内容洗掉 → 必须用 CDP `Input.insertText`）
 *   2. `Input.dispatchMouseEvent` 点一下输入框拿焦点
 *   3. `Input.insertText` 注入文本 → 发送按钮 `button.chat-input-v2-send-button` 解除 disabled
 *   4. `button.click()` 发送
 *   5. 轮询 `.markdown-renderer`（assistant 正文），文本静止即完成
 *
 * 前置：Trae CN 必须带 `--remote-debugging-port=9334` 启动
 *   （`D:\Programs\Trae CN\start-debug.bat`）。
 *   从非交互 shell 直接 Start-Process 会 exit code 9，必须用户双击或用 explorer 启动。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { TRAE_EXE } from './trae-cn.mjs'

const DEFAULT_PORT = 9334
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EXE = TRAE_EXE
const BAT = 'D:\\Programs\\Trae CN\\start-debug.bat'

const INPUT_SEL = '.chat-input-v2-input-box-editable'
const SEND_SEL = 'button.chat-input-v2-send-button'
const ASSISTANT_SEL = '.markdown-renderer'

/* --------------------------- 状态探测 --------------------------- */

async function cdpAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

function processRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Trae CN.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    return /Trae CN\.exe/i.test(out)
  } catch {
    return false
  }
}

/**
 * @returns {Promise<{up:boolean, port:number, exe:boolean, running:boolean, debuggable:boolean, reason?:string}>}
 */
export async function traeCdpStatus(port = DEFAULT_PORT) {
  const running = processRunning()
  const debuggable = await cdpAlive(port)
  return {
    up: debuggable,
    port,
    exe: fs.existsSync(EXE),
    running,
    debuggable,
    reason: debuggable
      ? undefined
      : running
        ? `Trae CN 在运行但没带调试端口。请关掉后用 ${BAT} 启动（非交互 shell 拉不起 GUI）`
        : `Trae CN 未运行。请双击 ${BAT} 启动（会带 --remote-debugging-port=${port}）`,
  }
}

/** 已带端口在跑就直接用；否则给出明确指引（不尝试从后台拉起，实测 exit code 9） */
/**
 * 只检查、不启动 —— 由用户自己打开 Trae CN。
 *
 * 历史：这里曾尝试 spawn(cmd /c start start-debug.bat) 自动拉起。
 * 实测从后台 shell 拉 GUI 一律失败（HasExited=True / ExitCode=9），
 * 非交互 shell 拿不到桌面会话，所以那段只会白等 45 秒再报错。
 */
export async function ensureTraeCdp({ port = DEFAULT_PORT } = {}) {
  if (await cdpAlive(port)) return { port, launched: false }

  const running = await processRunning()
  throw new Error(
    running
      ? `Trae CN 已在运行，但没有调试端口 ${port}。请退出 Trae CN，然后双击：\n  ${BAT}\n（工作台不会自动帮你启动）`
      : `Trae CN 没有在运行。请双击：\n  ${BAT}\n它会带 --remote-debugging-port=${port} 启动客户端。\n（工作台不会自动帮你启动）`,
  )
}

/* --------------------------- CDP 客户端 --------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      let m
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      const p = m.id && this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new Cdp(ws)))
      ws.addEventListener('error', () => reject(new Error('CDP websocket 连接失败')))
    })
  }

  send(method, params = {}) {
    const i = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(i, { res, rej })
      this.ws.send(JSON.stringify({ id: i, method, params }))
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.text + ' ' + String(r.exceptionDetails.exception?.description || '').slice(0, 300)
      )
    return r.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

async function pageTarget(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })
  const list = await r.json()
  const page =
    list.find((t) => t.type === 'page' && String(t.url).includes('solo-lite')) ||
    list.find((t) => t.type === 'page' && String(t.url).includes('solo')) ||
    list.find((t) => t.type === 'page' && !String(t.url).includes('floatingButton'))
  if (!page) throw new Error('Trae CN 没有可用的 Solo 页面 target')
  return page
}

export async function connectTrae(port = DEFAULT_PORT) {
  const page = await pageTarget(port)
  const c = await Cdp.connect(page.webSocketDebuggerUrl)
  c.pageTitle = page.title
  c.pageUrl = page.url
  return c
}

/* --------------------------- 执行 --------------------------- */

const readAssistant = `(()=>{
  const els=[...document.querySelectorAll('${ASSISTANT_SEL}')];
  return { n: els.length, texts: els.slice(-3).map(e=>e.innerText.trim()) };
})()`

/**
 * 发一条消息并等回复。
 * @returns {Promise<{text:string, ms:number, transport:'cdp'}>}
 */
export async function runTrae(
  agentId,
  { prompt, emit, port = DEFAULT_PORT, idleMs = 3000, timeoutMs = 300000, newTopic = false, signal }
) {
  const { launched } = await ensureTraeCdp({ port })
  const c = await connectTrae(port)
  emit.start({ transport: 'cdp', port, toplevel: c.pageTitle, launched })

  try {
    // 等输入框就绪
    const readyDeadline = Date.now() + 20000
    let ready = false
    while (Date.now() < readyDeadline) {
      ready = await c.eval(`!!document.querySelector('${INPUT_SEL}')`)
      if (ready) break
      await sleep(600)
    }
    if (!ready) throw new Error('Trae CN 输入框未就绪（Solo 页面可能还在加载）')

    let baseline = (await c.eval(readAssistant)) || { n: 0 }

    if (newTopic) {
      const clicked = await c.eval(`(()=>{
        const b=document.querySelector('[aria-label="新建任务"],button[class*=new-btn]');
        if(!b) return false; b.click(); return true;
      })()`)
      if (clicked) {
        emit.log('已新建任务（隔离上下文）', 'debug')
        await sleep(1500)
        baseline = { n: 0 }
      }
    }

    // 1) 聚焦：点一下输入框
    const box = JSON.parse(
      await c.eval(`(()=>{
        const el=document.querySelector('${INPUT_SEL}');
        el.focus();
        const r=el.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});
      })()`)
    )
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(300)

    // 2) 真实输入（Input.insertText 会触发 beforeinput/input，React 才认）
    await c.send('Input.insertText', { text: prompt })
    await sleep(800)

    const st = JSON.parse(
      await c.eval(`(()=>{
        const ed=document.querySelector('${INPUT_SEL}');
        const b=document.querySelector('${SEND_SEL}');
        return JSON.stringify({text:(ed?.innerText||'').trim(), disabled: b? b.disabled : null});
      })()`)
    )
    if (!st.text) throw new Error('文本注入失败：Trae CN 输入框仍为空')
    emit.log(`已填入 ${st.text.length} 字`, 'debug')

    if (st.disabled) {
      // 部分场景按钮延迟解禁，用 Enter 兜底
      emit.log('发送按钮仍 disabled，改用 Enter 提交', 'warn')
      const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: '\r' })
      await c.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' })
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    } else {
      await c.eval(`document.querySelector('${SEND_SEL}').click()`)
    }
    emit.log('已发送', 'debug')

    // 3) 轮询 assistant 正文
    const t0 = Date.now()
    const baseN = baseline.n
    let last = ''
    let stableSince = 0
    let sentAny = false
    let announcedIdle = false
    let cancelled = false

    for (;;) {
      await sleep(900)
      if (signal?.aborted) {
        cancelled = true
        emit.log('收到取消信号，停止等待 Trae 输出', 'warn')
        break
      }
      if (Date.now() - t0 > timeoutMs) {
        emit.log(`${Math.round(timeoutMs / 1000)}s 超时，返回已捕获内容`, 'warn')
        break
      }
      const s = await c.eval(readAssistant)
      if (!s) continue
      if (s.n <= baseN) {
        // 气泡还没出现；长时间没有新气泡说明这条压根没发出去
        if (!announcedIdle && Date.now() - t0 > 30000) {
          announcedIdle = true
          emit.log('30s 内没等到新回复气泡，可能输入未提交', 'warn')
        }
        continue
      }
      const cur = s.texts[s.texts.length - 1] || ''
      if (cur && !sentAny) {
        sentAny = true
        emit.log('已开始输出', 'debug')
      }
      // 关键修正：只要正文非空就开始计静默时间。
      // 旧写法只在 cur !== last 时刷新 stableSince，若第一轮气泡还没渲染完
      // （cur === ''）就再也不会刷新，导致 stableSince 永远是 0、永不收敛。
      if (cur) {
        if (cur !== last) {
          const delta = cur.startsWith(last) ? cur.slice(last.length) : cur
          if (delta) emit.text(delta)
          last = cur
        }
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince > idleMs) break
      }
      // cur 为空说明这一条还在流式渲染，下一轮再看
    }

    if (cancelled) {
      emit.cancelled('用户取消')
      return { ok: false, aborted: true, text: last, transport: 'cdp' }
    }

    const ms = Date.now() - t0
    try {
      emit.usage({ note: 'Trae CN 不暴露 token 用量；积分见 /api/agents 的 credits' })
    } catch {}
    emit.done({ stopReason: 'stop', ms })
    return { ok: true, code: 0, text: last, ms, transport: 'cdp' }
  } finally {
    c.close()
  }
}
