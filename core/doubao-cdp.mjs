/**
 * 豆包（DoubaoWork 桌面版）—— CDP 轨
 *
 * 豆包没有 CLI、没有 ACP、没有 stream-json、没有本地 HTTP 对话入口，
 * 唯一的可编程面就是 Chromium 调试端口 + DOM。所以这里走 CDP。
 *
 * 实测要点（2026-11-17，DoubaoWork 2.32.14 / Chrome 147）：
 *   1. 必须带 --remote-debugging-port=9335 启动，否则无端口。
 *   2. /json/list 里有 4 个 target，只有 type=page 且 url 匹配
 *      `doubaowork://doubaowork-chat/chat` 的那个是对话页（标题「豆包工作」）。
 *   3. 输入框：`.tiptap.ProseMirror`（ProseMirror 编辑器，contenteditable）。
 *      必须先用 Input.dispatchMouseEvent 点它聚焦，再用 Input.insertText 注入。
 *      直接改 DOM / 合成事件会被 ProseMirror 的 transaction 洗掉。
 *   4. 发送：**点 `.send-btn-wrapper` 无效**（React 合成事件收不到）。
 *      唯一可靠路径是真实 Enter：rawKeyDown + char + keyUp，vk 13。
 *   5. 回复正文：助手气泡是 `[class*="container-"][class*="md-box-root"]`
 *      链下的叶子节点；用户气泡没有 md-box-root 父链，可据此区分。
 *   6. 发送后输入框会变成单个 "\n"（ProseMirror 清空后的空段落），
 *      可作为「已提交」信号。
 */
import { execFileSync } from 'node:child_process'

export const DEFAULT_PORT = 9335
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const EXE = 'D:\\Program Files\\DoubaoWork\\DoubaoWork.exe'
export const CHAT_URL_RE = /doubaowork-chat\/chat/
export const INPUT_SEL = '.tiptap.ProseMirror'
export const SEND_SEL = '.send-btn-wrapper'
/**
 * 助手气泡 vs 用户气泡的稳定判据（实测）：
 *   两者都带 class `md-box-root`，区别在祖先链：
 *     - 用户气泡外层有 `flex justify-end`（右对齐）
 *     - 助手气泡外层是 `flex w-full flex-col ...`，没有 justify-end
 * 所以选择器从「有 justify-end] 的容器里排除出去，才是真正的助手正文。
 */
export const ASSISTANT_SEL = '[class*="md-box-root"]'
const ASSISTANT_FILTER_JS = `(root) => !root.closest('[class*="justify-end"]')`

/**
 * 更稳的判据（2026-11-17 补测）：消息节点本身带方向性 class，
 *   助手 = `.receiveMessage-*`，用户 = `.sendMessage-*`（辅助类，哈希后缀会变，用前缀匹配）。
 * 气泡数 / 正文都改用这个，比「排除 justify-end」可靠——
 * 后者在 md-box-root 只有部分镜像时会把助手气泡算成用户气泡，导致一直是 0 个气泡、
 * 轮询永远 n<=baseCount、最后 text 为空（界面表现为只回一句「哈喽」或被兜底成空）。
 */
const RECV_SEL = '[class*="receiveMessage-"]'
const SEND_SEL_BUBBLE = '[class*="sendMessage-"]'

/* ------------------------- 状态探测 ------------------------- */

async function cdpAlive(port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return r.ok
  } catch {
    return false
  }
}

function procRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DoubaoWork.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    return /DoubaoWork\.exe/i.test(out)
  } catch {
    return false
  }
}

export async function doubaoStatus(port = DEFAULT_PORT) {
  const exe = (() => {
    try {
      return execFileSync('cmd', ['/c', 'if exist "' + EXE + '" echo 1'], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim() === '1'
    } catch {
      return false
    }
  })()
  const running = procRunning()
  const up = await cdpAlive(port)
  let reason
  if (!up) {
    reason = running
      ? `豆包在跑但没开调试端口。关掉后重新启动：\n  "${EXE}" --remote-debugging-port=${port}`
      : `豆包没有运行。先启动（必须带调试端口）：\n  "${EXE}" --remote-debugging-port=${port}\n（工作台不会自动帮你启动）`
  }
  return { up, port, exe, running, debuggable: up, reason }
}

/* ------------------------- CDP 连接 ------------------------- */

export async function ensureDoubao({ port = DEFAULT_PORT } = {}) {
  if (!(await cdpAlive(port))) {
    const st = await doubaoStatus(port)
    throw new Error(st.reason)
  }
  return true
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 15000)
      ws.onopen = () => {
        clearTimeout(timer)
        const c = new Cdp(ws)
        ws.onmessage = (e) => {
          let m
          try {
            m = JSON.parse(e.data)
          } catch {
            return
          }
          if (m.id && c.pending.has(m.id)) {
            const { resolve: res, reject: rej } = c.pending.get(m.id)
            c.pending.delete(m.id)
            if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)))
            else res(m.result)
          }
        }
        ws.onerror = () => reject(new Error('CDP socket error'))
        resolve(c)
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('CDP connect failed'))
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} timeout`))
        }
      }, 30000)
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed')
    return r?.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

async function pickChatTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && CHAT_URL_RE.test(t.url || ''))
  if (!page) {
    const pages = list.map((t) => `${t.type} ${t.url}`).join('\n  ')
    throw new Error(`豆包对话页没找到。当前 targets：\n  ${pages}`)
  }
  return page
}

export async function connectDoubao(port = DEFAULT_PORT) {
  const page = await pickChatTarget(port)
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable').catch(() => {})
  return cdp
}

/** 关掉可能存在的遮罩弹窗。豆包的「新建」按钮有时会误开「创建项目」对话框，
 *  它会盖住输入框，导致后面所有点击与 insertText 全部落空（读到永远是 "\n"）。 */
async function dismissOverlays(cdp) {
  for (let i = 0; i < 4; i++) {
    // 两条判据都要看：焦点是否落在 modal（activeElement 带 fixed/z-50），
    // 以及 DOM 里是否还挂着 role=dialog / data-state=open 的浮层。
    const state = await cdp.eval(`(() => {
      const ae = document.activeElement
      const cls = ae && ae.className ? String(ae.className) : ''
      const dialog = !!document.querySelector('[role="dialog"],[data-state="open"][class*="z-50"]')
      return JSON.stringify({ focusedModal: /fixed|z-50|dialog|modal/i.test(cls), dialog })
    })()`)
    const { focusedModal, dialog } = JSON.parse(state || '{}')
    if (!focusedModal && !dialog) return true
    // 先点浮层里的关闭按钮（比 ESC 稳，ESC 有时被输入法/组合键吃掉）
    await cdp
      .eval(`(() => {
        const b = document.querySelector('[role="dialog"] [aria-label="关闭"],[role="dialog"] [aria-label="Close"],[role="dialog"] button')
        if (b) b.click()
      })()`)
      .catch(() => {})
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/* ------------------------- 发送与读取 ------------------------- */

/** 真实 Enter（rawKeyDown + char + keyUp）。合成 KeyboardEvent 无效。 */
async function pressEnter(cdp) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'char', text: '\r', unmodifiedText: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** 读输入框现有文本（用于校验注入成功） */
async function readInput(cdp) {
  return (await cdp.eval(`(document.querySelector('${INPUT_SEL}')||{}).innerText || ''`)) || ''
}

/**
 * 读最后一个助手气泡的正文。
 * 助手气泡特征：祖先链里出现 md-box-root；取其最深的连续文本。
 */
async function readAssistant(cdp) {
  return (
    (await cdp.eval(`(() => {
      // 优先用消息节点 class（.receiveMessage-*），回退到 md-box-root + 排除右对齐
      let nodes = [...document.querySelectorAll('${RECV_SEL}')]
      if (!nodes.length) {
        nodes = [...document.querySelectorAll('${ASSISTANT_SEL}')]
          .filter(r => !r.closest('[class*="justify-end"]'))
      }
      if (!nodes.length) return ''
      const last = nodes[nodes.length - 1]
      // 去掉气泡尾部的操作栏文本（复制/点赞/免费/时间戳等）
      const body = last.querySelector('[class*="md-box-root"]') || last
      return (body.innerText || '').trim()
    })()`)) || ''
  )
}

/** 尾部噪音：操作栏按钮文字 + 「免费」 + 「今天 16:11」这类时间戳 */
function stripTailNoise(t) {
  return String(t || '')
    .replace(/\n*(复制|翻译|点赞|点踩|举报|重新生成|创建分支|下载|分享|免费|编辑|试试)\n*/g, '\n')
    .replace(/\n*(今天|昨天|前天)\s*\d{1,2}:\d{2}\n*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 前导噪音：豆包在真正开答前会先铺一行「正在调度资源 / 正在思考 / 正在搜索…」。
 *  这些是状态文案不是答案。只要整段内容还全是这类提示，就当「还没开始」。 */
const PENDING_RE = /^(正在[\u4e00-\u9fa5]{0,8}|深度思考中|搜索中|思考中|生成中)[.。…\s]*$/u

function isPendingOnly(t) {
  const s = String(t || '').trim()
  if (!s) return true
  // 逐行判断：所有行都是状态文案 → 还没有真答案
  return s.split('\n').every((line) => !line.trim() || PENDING_RE.test(line.trim()))
}

/** 切换到新对话（可选）。返回是否成功。 */
async function newChat(cdp) {
  // 顺序：点侧栏「新工作任务」（最稳） -> Ctrl+N -> 兜底点「新建」按钮。
  //
  // 血泪教训：Ctrl+N 在豆包里不等于「新对话」。当当前会话是「工作台」形态时，
  // Ctrl+N 会把你带到 chrome://doubaowork-chat/chat/workbench —— 那是工作台 landing
  // （22 款智能工作台推荐卡片 + 签到），整页 **没有任何输入框**（editables = []）。
  // 而旧判据是「助手气泡数 === 0」，workbench 上空气泡天然为 0，于是误判成「已开新对话」，
  // 后续注入 6 次全部读到 ""，报「文本注入失败」。
  // 所以成功判据必须是：气泡数为 0 **且** 输入框存在（且 URL 不是 workbench）。
  const count = () => cdp.eval(`document.querySelectorAll('${RECV_SEL}').length`)
  // 「到了一个可以打字的新会话」= 输入框在 + 不在 workbench 落地页 + 没有历史气泡
  const ready = async () =>
    cdp.eval(`(() => {
      if (!document.querySelector('${INPUT_SEL}')) return false
      if (/\\/chat\\/workbench/.test(location.href)) return false
      return document.querySelectorAll('${RECV_SEL}').length === 0
    })()`)

  // 先看现在是不是已经干净了（前端已就位就不折腾）
  if (await ready()) return true

  // 方案 1：侧栏「新工作任务」导航项。点击坐标派发真实鼠标事件。
  const clickNewTask = async () => {
    const box = await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('div,button,a')].find(
        (b) => /^新工作任务/.test((b.innerText || '').trim()) && String(b.className).includes('sidebar_nav_item'),
      )
      if (!el) return ''
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return ''
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`)
    if (!box) return false
    const { x, y } = JSON.parse(box)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return true
  }

  if (await clickNewTask()) {
    await new Promise((r) => setTimeout(r, 2200))
    if (await ready()) return true
    // 侧栏点完落到 workbench 的情况：再点一次（第二次才真的建新会话）
    if (await clickNewTask()) {
      await new Promise((r) => setTimeout(r, 2200))
      if (await ready()) return true
    }
  }

  // 方案 2：Ctrl+N
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78, modifiers: 2,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78, modifiers: 2,
  })
  await new Promise((r) => setTimeout(r, 1800))
  if (await ready()) return true

  // 兜底 1：导航项「新工作任务」再来一次（workbench -> chat 的过渡有时需要两跳）
  if (await clickNewTask()) {
    await new Promise((r) => setTimeout(r, 2200))
    if (await ready()) return true
  }

  // 兜底 2：任何「新建/新对话」按钮
  const r = await cdp.eval(`(() => {
    const cands = [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => /新建|新对话|New/i.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')))
    if (!cands.length) return 'no-btn'
    cands[0].click()
    return 'clicked'
  })()`)
  await new Promise((r2) => setTimeout(r2, 1200))
  return r === 'clicked' && (await ready())
}

/**
 * 跑一次豆包对话。
 * @param {string} agentId
 * @param {{prompt:string, emit:object, port?:number, idleMs?:number, timeoutMs?:number, newTopic?:boolean}} opts
 */
export async function runDoubao(
  agentId,
  { prompt, emit, port = DEFAULT_PORT, idleMs = 3000, timeoutMs = 300000, newTopic = true, model, signal } = {},
) {
  const t0 = Date.now()
  emit.start({ transport: 'cdp', port })

  await ensureDoubao({ port })
  const cdp = await connectDoubao(port)

  try {
    // 1) 等输入框就绪
    const ready = Date.now()
    let has = false
    while (Date.now() - ready < 20000) {
      if (signal?.aborted) {
        emit.cancelled('用户取消')
        return { ok: false, aborted: true, transport: 'cdp' }
      }
      has = !!(await cdp.eval(`!!document.querySelector('${INPUT_SEL}')`))
      if (has) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!has) throw new Error('豆包输入框 20 秒内没就绪（页面可能还在加载）')
    emit.log('输入框就绪', 'debug')

    // 助手气泡计数：用「个数」而不是文本做基线。
    // 文本做基线会被同文污染（上一轮答「在线」，这一轮也答「在线」→ cur===baseline 被跳过）。
    const countAssistant = () =>
      cdp.eval(`(() => {
        const n = document.querySelectorAll('${RECV_SEL}').length
        if (n) return n
        return [...document.querySelectorAll('${ASSISTANT_SEL}')].filter(r => !r.closest('[class*="justify-end"]')).length
      })()`)

    // 2) 可选：开新对话
    await dismissOverlays(cdp)
    if (newTopic) {
      const ok = await newChat(cdp)
      emit.log(ok ? '已开新对话' : '没找到新建对话按钮，沿用当前会话', ok ? 'debug' : 'warn')
      await new Promise((r) => setTimeout(r, 1200))
      // 「新建」在部分版本会弹出「创建项目」对话框，必须收掉
      await dismissOverlays(cdp)
    }
    // 基线取法：
    //   - 开了新对话 → 固定 0（新会话从零开始长气泡，旧会话的气泡已不在 DOM 里或计数不准）
    //   - 没开新对话 → 取当前已有的助手气泡数，只有超过它才是这一轮的新回复
    // 注意：即使 newTopic=true 也可能没找到「新建」按钮（沿用当前会话），
    // 这时基线必须取「发送前」的真实计数，不能写死 0，否则历史气泡会被当成新回复。
    // 另外「新建」点击后面的 DOM 是异步重建的（实测点完立刻读仍然还是旧会话的数字），
    // 所以开新对话后再多等一拍、连读两次取较小值，避免基线偏大导致这一轮永远等不到新气泡。
    let baseCount = await countAssistant()
    if (newTopic) {
      await new Promise((r) => setTimeout(r, 800))
      baseCount = Math.min(baseCount, await countAssistant())
    }
    emit.log(`基线气泡数 base=${baseCount}`, 'debug')

    // 3.5) 模型：有指定就先切（下拉在输入框右下角，切完会收起）
    if (model) {
      const ok = await doubaoSetModel(cdp, model, emit)
      if (!ok) emit.log(`模型切换未生效，沿用当前模型（目标 ${model}）`, 'warn')
      await dismissOverlays(cdp)
      await new Promise((r) => setTimeout(r, 400))
    }


    // 4) 焦点 + 注入（ProseMirror 必须真实鼠标事件才能拿到焦点）。
    //    新开对话后编辑器会重新挂载，坐标可能一时失效，所以整体重试几轮。
    const probe = prompt.slice(0, 6)
    let typed = ''
    for (let attempt = 0; attempt < 6 && !typed.includes(probe); attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 900))
      // 每次注入前先清场：中间那条兜底「新建」路径会弹出「创建项目」对话框
      // （activeElement 是 fixed z-50 的 modal），不移除的话点击和 insertText 全落空。
      await dismissOverlays(cdp)
      const box = await cdp.eval(`(() => {
        const el = document.querySelector('${INPUT_SEL}')
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) return null
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      })()`)
      if (!box) continue
      const { x, y } = JSON.parse(box)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 450))
      // 焦点必须真落在 ProseMirror 上，否则 insertText 会打给窗口本身
      const focused = String(
        await cdp.eval(`String((document.activeElement && document.activeElement.className) || '')`),
      ).includes('ProseMirror')
      if (!focused) {
        emit.log(`第 ${attempt + 1} 次点击没拿到焦点（activeElement 不是 ProseMirror），重试`, 'debug')
        continue
      }
      // 清空残留（新对话可能带着上次的空段落）
      await cdp.eval(`(() => {
        const el = document.querySelector('${INPUT_SEL}')
        if (el) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete') }
      })()`)
      await cdp.send('Input.insertText', { text: prompt })
      await new Promise((r) => setTimeout(r, 500))
      typed = await readInput(cdp)
      if (typed.includes(probe)) break
      emit.log(`注入未生效（第 ${attempt + 1} 次，读到 ${JSON.stringify(typed.slice(0, 20))}），重试`, 'debug')
    }
    if (!typed.includes(probe)) {
      throw new Error(`文本注入失败（6 次重试后输入框读到：${JSON.stringify(typed.slice(0, 40))}）`)
    }
    emit.log(`已填入 ${typed.length} 字`, 'debug')

    // 6) 发送：真实 Enter（点 send 按钮无效）
    await pressEnter(cdp)
    emit.log('已按 Enter 发送', 'debug')

    // 7) 轮询正文，按前缀差分
    let last = ''
    let stableSince = 0
    let announced = false
    const deadline = Date.now() + timeoutMs
    let text = ''
    let cancelled = false
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700))
      if (signal?.aborted) {
        cancelled = true
        emit.log('收到取消信号，停止等待豆包输出', 'warn')
        break
      }
      const n = await countAssistant()
      // 只有气泡数量超过基线，才是这一轮的新回复。
      // 兜底：极少数情况下气泡节点被虚拟列表回收，计数不涨但正文已经变了 —— 这里放宽：
      // 已经拿到过 text 就继续差分，不再被计数卡住。
      if (n <= baseCount && !text) {
        if (!announced && Date.now() - t0 > 30000) {
          emit.log('30 秒没出现新气泡，可能输入未提交', 'warn')
          announced = true
        }
        continue
      }
      const cur = stripTailNoise(await readAssistant(cdp))
      // 只有「正在调度资源」这类状态文案时，不算答案，继续等
      if (isPendingOnly(cur)) {
        if (!announced && Date.now() - t0 > 30000) {
          emit.log('30 秒仍只有状态提示，继续等待', 'debug')
        }
        continue
      }
      if (cur && cur !== last) {
        const delta = cur.startsWith(last) ? cur.slice(last.length) : cur
        if (delta) {
          emit.text(delta)
          text = cur
        }
        last = cur
        stableSince = Date.now()
      } else if (cur) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince > idleMs) break
      }
    }

    if (!text) {
      // 兜底：数量涨了就整体再读一次
      if ((await countAssistant()) > baseCount) {
        const cur = stripTailNoise(await readAssistant(cdp))
        if (cur) {
          emit.text(cur)
          text = cur
        }
      }
    }

    if (cancelled) {
      emit.cancelled('用户取消')
      return { ok: false, aborted: true, text: (text || '').trim(), transport: 'cdp' }
    }

    const ms = Date.now() - t0
    emit.usage({ note: '豆包不暴露 token 用量' })
    emit.done({ ok: true, ms, transport: 'cdp' })
    return { ok: true, code: 0, text: (text || '').trim(), ms, transport: 'cdp' }
  } finally {
    cdp.close()
  }
}

// ---------------------------------------------------------------------------
// 模型选择
// ---------------------------------------------------------------------------
// 豆包的模型选择器在输入框右下角：一颗显示「DeepSeek V4.1 Flash 高」的按钮，
// 点开是竖排列表（自动 / 豆包 2.1 Lite / 豆包 2.1 Pro / DeepSeek V4.1 Flash /
// Qwen 4 Max / Kimi K3.1 Pro / Kimi K3.1 Pro 高速 / Kimi K3 / GLM 5.3 / GLM 5.3 Flash），
// 底部还有「更多模型」和「推理强度 高」两个二级入口。
// 实测 2026-11-18：列表项文本形如 "GLM 5.3 Flash  0.08x"。
export const DOUBAO_MODELS = [
  '自动',
  '豆包 2.1 Lite',
  '豆包 2.1 Pro',
  'DeepSeek V4.1 Flash',
  'Qwen 4 Max',
  'Kimi K3.1 Pro',
  'Kimi K3.1 Pro 高速',
  'Kimi K3',
  'GLM 5.3',
  'GLM 5.3 Flash',
]

/** 打开模型下拉并读出当前真实可选项（连不上返回静态清单） */
export async function doubaoModels(port = DEFAULT_PORT) {
  let cdp
  try {
    cdp = await connectDoubao(port)
  } catch {
    return DOUBAO_MODELS.slice()
  }
  try {
    const box = await cdp.eval(`(()=>{
  // 模型药丸：输入框右下角那颗，文本形如 "DeepSeek V4.1 Flash 高"。
  // 约束（实测 2026-11-18）：在视口右侧下半部、宽 80~260、高 18~45，
  // 且不能是侧栏「新工作任务 Ctrl N」（那个 y 在顶部、x 在左侧）。
  const vh = window.innerHeight, vw = window.innerWidth
  const cands = []
  for (const el of document.querySelectorAll('div,span')) {
    const t = (el.innerText || '').trim().replace(/\\s+/g, ' ')
    if (!t || t.length > 24 || t.includes('工作任务')) continue
    if (!/(Flash|Pro|Lite|Max|GLM|Kimi|自动)/i.test(t)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 80 || r.width > 260 || r.height < 18 || r.height > 45) continue
    if (r.y < vh * 0.6 || r.x < vw * 0.5) continue
    cands.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), now: t, area: r.width * r.height })
  }
  if (!cands.length) return null
  // 取面积最大（最外层可点）的那个
  cands.sort((a, b) => b.area - a.area)
  return cands[0]
})()`)
    if (!box) return DOUBAO_MODELS.slice()
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    await sleep(1100)
    const names = await cdp.eval(`(()=>{
      const pops = [...document.querySelectorAll('[role=menu],[role=listbox],[class*=popover],[class*=popper]')]
      const txt = pops.map(p => p.innerText || '').join('\n')
      if (!txt.trim()) return []
      // 列表项形如 "GLM 5.3 Flash  0.08x" / "自动  小额免费"，剥掉末尾的价格标记
      return txt.split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replace(/\s*(限时优惠|新上线|小额免费)?\s*\d+(\.\d+)?x\s*$/, '').trim())
        .filter(s => s && !/^(更多模型|推理强度|高|中|低)$/.test(s))
    })()`)
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    return Array.isArray(names) && names.length ? names : DOUBAO_MODELS.slice()
  } catch {
    return DOUBAO_MODELS.slice()
  } finally {
    try {
      cdp.close()
    } catch {}
  }
}

/** 点开下拉并选中指定模型 */
export async function doubaoSetModel(cdp, modelName, emit) {
  if (!modelName) return false
  const box = await cdp.eval(`(()=>{
  // 模型药丸：输入框右下角那颗，文本形如 "DeepSeek V4.1 Flash 高"。
  // 约束（实测 2026-11-18）：在视口右侧下半部、宽 80~260、高 18~45，
  // 且不能是侧栏「新工作任务 Ctrl N」（那个 y 在顶部、x 在左侧）。
  const vh = window.innerHeight, vw = window.innerWidth
  const cands = []
  for (const el of document.querySelectorAll('div,span')) {
    const t = (el.innerText || '').trim().replace(/\\s+/g, ' ')
    if (!t || t.length > 24 || t.includes('工作任务')) continue
    if (!/(Flash|Pro|Lite|Max|GLM|Kimi|自动)/i.test(t)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 80 || r.width > 260 || r.height < 18 || r.height > 45) continue
    if (r.y < vh * 0.6 || r.x < vw * 0.5) continue
    cands.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), now: t, area: r.width * r.height })
  }
  if (!cands.length) return null
  // 取面积最大（最外层可点）的那个
  cands.sort((a, b) => b.area - a.area)
  return cands[0]
})()`)
  if (!box) return false
  emit?.log?.(`当前模型 ${box.now}，准备切到 ${modelName}`, 'debug')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
  }
  await sleep(1100)
  const want = String(modelName).toLowerCase()
  // 下拉每一项的结构（实测 2026-11-18）：
  //   DIV.h-38 w-full items-center truncate rounded-dbx-sm   ← 外层行 292x38，可点
  //     DIV.flex min-w-0 flex-1 items-center gap-6            ← 内层文字 272x30
  //       SPAN.shrink-0  "GLM 5.3 Flash"                       ← 模型名
  //       SPAN           "0.08x"                               ← 价格
  // 坑：内层节点自己 click() 不触发选中，必须发真实鼠标事件到「外层行」中心。
  // 再用 elementFromPoint 反查一次，确保落点真的在这行上（防止被遮挡）。
  const hit = await cdp.eval(`(()=>{
    const want = ${JSON.stringify(want)}
    const norm = (s) => String(s || '').replace(/\\s*(限时优惠|新上线|小额免费)?\\s*\\d+(\\.\\d+)?x\\s*$/,'').replace(/\\s+/g,' ').trim()
    const rows = []
    for (const el of document.querySelectorAll('div')) {
      if (!String(el.className).includes('h-38 w-full')) continue
      const clean = norm(el.innerText)
      if (!clean) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      rows.push({ el, rect: r, clean })
    }
    if (!rows.length) return null
    const scored = rows.map((row) => {
      const c = row.clean.toLowerCase()
      const exact = c === want
      const starts = c.startsWith(want)
      const has = c.includes(want)
      if (!has) return null
      const cx = Math.round(row.rect.x + row.rect.width / 2)
      const cy = Math.round(row.rect.y + row.rect.height / 2)
      const land = document.elementFromPoint(cx, cy)
      const landed = land ? (land === row.el || row.el.contains(land)) : false
      return { x: cx, y: cy, t: row.clean, score: (exact ? 4 : 0) + (starts ? 2 : 0) + (landed ? 1 : 0) }
    }).filter(Boolean)
    if (!scored.length) return null
    scored.sort((a, b) => (b.score - a.score) || (a.t.length - b.t.length))
    return scored[0]
  })()`)
  if (!hit) {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    emit?.log?.(`模型列表里没找到「${modelName}」`, 'warn')
    return false
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: hit.x, y: hit.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
  }
  await sleep(800)
  emit?.log?.(`已切模型 → ${hit.t}`, 'debug')
  return true
}
