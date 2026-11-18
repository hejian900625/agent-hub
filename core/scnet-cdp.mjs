/**
 * scnet-client（曙光「计算服务」）CDP adapter
 * ---------------------------------------------------------------------------
 * 应用结构：Electron 44 / Chrome 152，无 CLI 对话入口，无本地 HTTP 端口，
 *           唯一可编程面是 CDP + preload 暴露的 window.host.invoke()。
 *
 * 启动（必须清空 ELECTRON_RUN_AS_NODE，否则 Chromium switches 被 Node 层吞掉）：
 *   cmd /c 'set ELECTRON_RUN_AS_NODE=&& start "" "<exe>" --remote-debugging-port=9336'
 *
 * 对话链路（实测 2026-11-18，SCNet-Max 返回「在线」）：
 *   1. 点击 .tiptap.ProseMirror.agent-chat-composer__editor 聚焦（ProseMirror 不接受 DOM 改值）
 *   2. Ctrl+A + Backspace 清空，再 Input.insertText 注入
 *   3. 真实 Enter（rawKeyDown vk13 + char \r + keyUp）发送
 *   4. 轮询 .chat-message--response 数量增长 + .chat-block-markdown 正文
 *
 * 三个已踩的坑：
 *   - .chat-message--response 的 innerText 带「10:06 SCNet-Max 13.3k toks」尾巴，
 *     正文必须取内层 .chat-block-markdown。
 *   - 页面是 SPA，body.innerText 变化会因侧栏「最近」更新而误判，必须按消息节点计数。
 *   - 开新任务用侧栏「新建任务 Ctrl+N」，但 Ctrl+N 在部分页面会切到工作台 landing，
 *     所以判据是「输入框存在 且 助手消息数为 0」，不是单纯计数。
 */

const DEFAULT_PORT = 9336
const EXE = 'D:\\Program Files\\scnet-client\\计算服务.exe'
const CHAT_URL_RE = /app\.asar\/dist\/index\.html/
const EDITOR_SEL = '.tiptap.ProseMirror.agent-chat-composer__editor'
const RESPONSE_SEL = '.chat-message--response'
const USER_SEL = '.chat-message--user'
const BODY_SEL = '.chat-block-markdown'
const MODEL_SEL = '.chat-message__model'
const TOKENS_SEL = '.chat-message__tokens'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 极简 CDP 客户端（Node 内置 WebSocket，零依赖） */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.listeners = []
    this.ws.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? p.rej(new Error(`CDP ${m.error.message || JSON.stringify(m.error)}`)) : p.res(m.result)
      } else if (m.method) {
        for (const fn of this.listeners) fn(m)
      }
    }
  }
  static async connect(url) {
    const c = new Cdp(url)
    await new Promise((res, rej) => {
      c.ws.onopen = res
      c.ws.onerror = () => rej(new Error('CDP 连接失败'))
    })
    return c
  }
  onEvent(fn) {
    this.listeners.push(fn)
  }
  send(method, params) {
    return new Promise((res, rej) => {
      const n = ++this.id
      this.pending.set(n, { res, rej })
      this.ws.send(JSON.stringify({ id: n, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      const e = r.exceptionDetails
      throw new Error((e.exception && (e.exception.description || e.exception.value)) || e.text)
    }
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/** 探测 CDP 端口与对话页 target */
export async function scnetStatus(port = DEFAULT_PORT) {
  const out = { up: false, port, exe: false, running: false, debuggable: false, reason: '' }
  try {
    out.exe = Boolean(await import('node:fs').then((fs) => fs.existsSync(EXE)))
  } catch {
    out.exe = false
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) })
    if (r.ok) {
      const v = await r.json()
      out.up = true
      out.debuggable = true
      out.browser = v.Browser
    }
  } catch {
    out.reason = `CDP 端口 ${port} 未监听`
  }
  if (out.up) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })).json()
      const page = list.find((t) => t.type === 'page' && CHAT_URL_RE.test(String(t.url || '')))
      out.running = Boolean(page)
      if (!page) out.reason = '找到端口但没有对话页 target'
    } catch (e) {
      out.reason = `target 列表读取失败：${e.message}`
    }
  }
  return out
}

/** 连上对话页 */
export async function connectScnet(port = DEFAULT_PORT) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) })).json()
  const page =
    list.find((t) => t.type === 'page' && CHAT_URL_RE.test(String(t.url || ''))) ||
    list.find((t) => t.type === 'page')
  if (!page) throw new Error(`scnet 没有可用的对话页 target（端口 ${port}）`)
  return Cdp.connect(page.webSocketDebuggerUrl)
}

/** 读当前页面状态：输入框、消息数、最新正文 */
async function readState(cdp) {
  return cdp.eval(`(() => {
    const ed = document.querySelector('${EDITOR_SEL}')
    const rs = document.querySelectorAll('${RESPONSE_SEL}')
    const last = rs[rs.length - 1]
    const body = last ? (last.querySelector('${BODY_SEL}') || {}).innerText || '' : ''
    const model = last ? (last.querySelector('${MODEL_SEL}') || {}).innerText || '' : ''
    const toks = last ? (last.querySelector('${TOKENS_SEL}') || {}).innerText || '' : ''
    return {
      hasEditor: !!ed,
      active: !!ed && (document.activeElement === ed || ed.contains(document.activeElement)),
      nResp: rs.length,
      nUser: document.querySelectorAll('${USER_SEL}').length,
      body: String(body),
      model: String(model),
      toks: String(toks),
      href: location.hash || '',
    }
  })()`)
}

/** 开新任务（点击侧栏「新建任务」；失败再试 Ctrl+N） */
async function newTask(cdp, emit) {
  const ready = async () => {
    const s = await readState(cdp)
    return s.hasEditor && s.nResp === 0
  }
  if (await ready()) return true

  // 侧栏「新建任务」真正的可点元素是 .sidebar-new-task 内部的 button.sidebar-nav-button
  const clicked = await cdp.eval(`(() => {
    const pick = (sel) => document.querySelector(sel)
    const el =
      pick('.sidebar-new-task button') ||
      pick('.sidebar-new-task') ||
      [...document.querySelectorAll('button')].find((b) => /^新建任务/.test((b.innerText || '').trim()))
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 10 || r.height < 8) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (clicked) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: clicked.x,
        y: clicked.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    await sleep(1800)
    if (await ready()) {
      emit?.log?.('已开新任务（点侧栏「新建任务」）', 'debug')
      return true
    }
  }

  // 兜底：Ctrl+N
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'n',
      code: 'KeyN',
      windowsVirtualKeyCode: 78,
      nativeVirtualKeyCode: 78,
      modifiers: 2,
    })
  }
  await sleep(1800)
  if (await ready()) {
    emit?.log?.('已开新任务（Ctrl+N）', 'debug')
    return true
  }
  return false
}

/** 聚焦输入框并注入文本 */
async function inject(cdp, text, emit) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const box = await cdp.eval(`(() => {
      const el = document.querySelector('${EDITOR_SEL}')
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 5) return null
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 20)) }
    })()`)
    if (!box) {
      await sleep(600)
      continue
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    await sleep(350)
    const focused = await cdp.eval(
      `!!document.querySelector('${EDITOR_SEL}') && document.activeElement && (document.activeElement.matches('${EDITOR_SEL}') || document.activeElement.closest('${EDITOR_SEL}'))`
    )
    if (!focused) {
      emit?.log?.(`注入第 ${attempt} 轮：输入框未聚焦，重试`, 'debug')
      await sleep(500)
      continue
    }
    // 清空
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: 2,
      })
    }
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      })
    }
    await sleep(150)
    await cdp.send('Input.insertText', { text })
    await sleep(450)
    const got = await cdp.eval(`(document.querySelector('${EDITOR_SEL}')||{}).innerText || ''`)
    if (String(got).includes(String(text).slice(0, Math.min(6, text.length)))) {
      emit?.log?.(`已填入 ${text.length} 字`, 'debug')
      return true
    }
    emit?.log?.(`注入第 ${attempt} 轮：读到 ${JSON.stringify(String(got).slice(0, 30))}，重试`, 'debug')
    await sleep(600)
  }
  return false
}

/** 真实 Enter 发送 */
async function pressEnter(cdp) {
  for (const ev of [
    { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ]) {
    await cdp.send('Input.dispatchKeyEvent', ev)
  }
}

/**
 * 派发一条任务给 scnet-client
 * @returns {Promise<{ok:boolean,text:string,model?:string,tokens?:string,ms:number}>}
 */
export async function runScnet(agentId, opts = {}) {
  const { prompt, emit, port = DEFAULT_PORT, newTopic = true, idleMs = 3500, timeoutMs = 600000 } = opts
  const t0 = Date.now()
  const cdp = await connectScnet(port)
  // 与 Alice / 豆包 对齐：必须显式发 run_start，否则界面渲染不出「启动 (cdp)」那一行
  // （web/index.html 的 case 'run_start' 是唯一入口，正文 text 事件不会补它）。
  emit?.start?.({ transport: 'cdp', port })
  try {
    if (newTopic) {
      const ok = await newTask(cdp, emit)
      if (!ok) emit?.log?.('开新任务未确认，沿用当前会话', 'warn')
    }
    const before = await readState(cdp)
    emit?.log?.(`基线助手消息数 base=${before.nResp}`, 'debug')

    if (!(await inject(cdp, String(prompt), emit))) {
      throw new Error(`文本注入失败（5 次重试后输入框仍读不到内容）`)
    }
    await pressEnter(cdp)
    emit?.log?.('已按 Enter 发送', 'debug')

    let lastBody = before.body || ''
    let lastChange = Date.now()
    let started = false
    let sentText = ''

    while (Date.now() - t0 < timeoutMs) {
      await sleep(1200)
      const s = await readState(cdp)
      if (s.nResp > before.nResp) started = true
      if (!started) continue
      const body = s.body || ''
      if (body !== lastBody) {
        // 把增量发出去
        const delta = body.startsWith(lastBody) ? body.slice(lastBody.length) : body
        if (delta) {
          sentText += delta
          emit?.text?.(delta)
        } else if (body !== lastBody) {
          // 内容被重写（重新生成/流式替换），整段重发
          sentText = body
        }
        lastBody = body
        lastChange = Date.now()
      }
      if (body && Date.now() - lastChange > idleMs) {
        const st = await readState(cdp)
        const ms = Date.now() - t0
        // 同理：界面「完成 (stop)」只由 done 事件渲染
        emit?.done?.({ stopReason: 'stop', ms })
        return {
          ok: true,
          text: String(st.body || body),
          model: st.model,
          tokens: st.toks,
          ms,
          transport: 'cdp',
        }
      }
    }
    emit?.done?.({ stopReason: 'timeout', ms: Date.now() - t0, partial: true })
    return {
      ok: Boolean(lastBody),
      text: lastBody,
      ms: Date.now() - t0,
      transport: 'cdp',
      partial: true,
    }
  } finally {
    cdp.close()
  }
}

export default { scnetStatus, connectScnet, runScnet, DEFAULT_PORT, EXE }
