/**
 * Alice 轨：Electron 应用，渲染进程 API 挂在 `window.alice`（~900 个方法），
 * 但没有可用的「发送消息」IPC —— 发送必须走 DOM + 真实键盘事件。
 *
 * 已验证的发送链路：
 *   1. 点 button[aria-label="新话题"]（可选，隔离上下文）
 *   2. 用 HTMLTextAreaElement.prototype 的 native setter 设值 + dispatch input
 *   3. Input.dispatchKeyEvent 派发真实 Enter（合成 KeyboardEvent 无效）
 *   4. 轮询 .message-enter.justify-start 抓 assistant 回复，文本静止即完成
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'

const EXE = 'D:\\Program Files\\Alice\\Alice.exe'
const DEFAULT_PORT = 9333

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

async function processRunning() {
  return new Promise((resolve) => {
    const p = spawn('tasklist', ['/FI', 'IMAGENAME eq Alice.exe', '/NH'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => resolve(/Alice\.exe/i.test(out)))
    p.on('error', () => resolve(false))
  })
}

export async function aliceStatus(port = DEFAULT_PORT) {
  const up = await cdpAlive(port)
  return { up, port, exe: fs.existsSync(EXE), running: up || (await processRunning()) }
}

/**
 * 只检查、不启动 —— 由用户自己打开客户端。
 *
 * 历史：这里曾经会自动 spawn(Alice.exe --remote-debugging-port=9333)。
 * 问题是窗口会在用户桌面上突然弹出来抢焦点，而且用户本来就打算自己开客户端，
 * 自动拉起的收益是负的。所以改成「没开就明确报错，告诉用户该怎么启动」。
 */
export async function ensureAlice({ port = DEFAULT_PORT } = {}) {
  if (await cdpAlive(port)) return { port, launched: false }

  if (!fs.existsSync(EXE)) throw new Error(`找不到 Alice 可执行文件：${EXE}`)

  const running = await processRunning()
  throw new Error(
    running
      ? `Alice 已在运行，但没有 CDP 端口 ${port}。请关掉 Alice，然后带调试端口重新打开：\n` +
        `  "${EXE}" --remote-debugging-port=${port}\n` +
        `（工作台不会自动帮你启动）`
      : `Alice 没有在运行。请先打开 Alice（必须带调试端口）：\n` +
        `  "${EXE}" --remote-debugging-port=${port}\n` +
        `（工作台不会自动帮你启动）`,
  )
}

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || '').slice(0, 300))
    return r.result?.value
  }

  async enter() {
    // 必须先聚焦：未聚焦的 textarea 收不到 Input.dispatchKeyEvent
    await this.eval(`(()=>{const t=document.querySelector('textarea'); if(!t) return false; t.focus(); return true})()`)
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: '\r' })
    await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

async function pageTarget(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
  const list = await r.json()
  const page =
    list.find((t) => t.type === 'page' && String(t.url).includes('renderer/index.html')) ||
    list.find((t) => t.type === 'page')
  if (!page) throw new Error('Alice 没有可用的 page target')
  return page
}

export async function connectAlice(port = DEFAULT_PORT) {
  const page = await pageTarget(port)
  return Cdp.connect(page.webSocketDebuggerUrl)
}

// 精确取正文：assistant 气泡里的 .text-alice-text 不含「复制/翻译/点赞」工具栏
const ASSISTANT_SEL = '.message-enter.justify-start .text-alice-text'
const FALLBACK_SEL = '.message-enter.justify-start'

// 正文节点 = .text-alice-text（干净正文）。
// 注意：正文没生成时这个节点根本不存在于气泡里，此时**不能**退回到外层气泡 ——
// 外层的 innerText 会混进「已思考 16s / 让我琢磨一下… / 复制 翻译 点赞 举报 … / 32,956」。
// 所以：内层不存在 → 记空串；只有气泡数（n）用于判「是否开始回复」。
const readAssistant = `(()=>{
  const outer=[...document.querySelectorAll('${FALLBACK_SEL}')];
  const inner=[...document.querySelectorAll('${ASSISTANT_SEL}')];
  return {
    n: outer.length,
    k: inner.length,
    texts: outer.slice(-4).map((o)=>{
      const i=o.querySelector('${ASSISTANT_SEL}');
      return i ? (i.innerText||'').trim() : '';
    }),
  };
})()`

/**
 * 发一条消息并等回复。
 * @returns {Promise<{text:string, session:string}>}
 */
/** Alice 的「还在想」类占位文案（不是答案，拿到就应继续等）。 */
const ALICE_PLACEHOLDER_RE = /(稍等片刻|稍等|请稍候|在想|快了|正在[\u4e00-\u9fa5]{0,10}|思考中|生成中|处理中)/u
function isPlaceholder(t) {
  const s = String(t || '').trim()
  if (!s) return true
  // 整段都是占位词（且很短）才算占位，避免把正常答案误杀
  return s.length <= 20 && ALICE_PLACEHOLDER_RE.test(s)
}

/** Alice 输出前的过渡文案：「稍等片刻…」「正在思考」之类，属占位而非答案。 */
const ALICE_PENDING_RE = /^(稍等片刻|稍等|请稍候|正在[\u4e00-\u9fa5]{0,10}|思考中|生成中|处理中)[.。…！!\s]*$/u
function isPendingOnly(t) {
  const s = String(t || '').trim()
  if (!s) return true
  return s.split('\n').every((line) => !line.trim() || ALICE_PENDING_RE.test(line.trim()))
}

export async function runAlice(agentId, { prompt, emit, port = DEFAULT_PORT, newTopic = true, idleMs = 6000, timeoutMs = 300000, model, signal }) {
  await ensureAlice({ port })
  const c = await connectAlice(port)
  emit.start({ transport: 'cdp', port })

  try {
    // 模型：有指定就先切，切不动就按当前模型继续（不阻塞派发）
    if (model) {
      const ok = await aliceSetModel(c, model, emit)
      if (!ok) emit.log(`模型切换未生效，沿用当前模型（目标 ${model}）`, 'warn')
    }

    let baseline = (await c.eval(readAssistant)) || { n: 0 }

    if (newTopic) {
      const clicked = await c.eval(`(()=>{const b=document.querySelector('button[aria-label="新话题"]'); if(!b) return false; b.click(); return true})()`)
      if (clicked) {
        emit.log('新话题已开', 'debug')
        await sleep(1200)
        baseline = { n: 0 } // 新话题里 assistant 气泡从 0 开始
      }
    }

    const typed = await c.eval(`(()=>{
      const t=document.querySelector('textarea');
      if(!t) return 'no-textarea';
      const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(t, ${JSON.stringify(prompt)});
      t.dispatchEvent(new Event('input',{bubbles:true}));
      return t.value.length;
    })()`)
    if (typed === 'no-textarea') throw new Error('Alice 输入框未找到（界面可能未就绪）')
    emit.log(`已填入 ${typed} 字，派发 Enter`, 'debug')

    await c.enter()

    const t0 = Date.now()
    const baseN = baseline.n
    let last = ''
    let stableSince = 0
    let sentAny = false
    let cancelled = false

    for (;;) {
      await sleep(900)
      if (signal?.aborted) {
        cancelled = true
        emit.log('收到取消信号，停止等待 Alice 输出', 'warn')
        break
      }
      if (Date.now() - t0 > timeoutMs) {
        emit.log(`${timeoutMs / 1000}s 超时，返回已捕获内容`, 'warn')
        break
      }
      const st = await c.eval(readAssistant)
      if (!st) continue
      if (st.n <= baseN) continue
      const cur = st.texts[st.texts.length - 1] || ''
      // Alice 会先铺「稍等片刻…」「正在思考」这类过渡文案，此时正文其实是空的。
      // 不能把它当答案收走（否则 idleMs 一到就拿「稍等片刻…」收工），
      // 也不能把它 emit 出去（前端会把它当正文显示）。
      if (isPendingOnly(cur)) {
        if (!sentAny) last = ''
        continue
      }
      if (cur && !sentAny) {
        sentAny = true
        emit.log('已开始输出', 'debug')
      }
      if (cur !== last) {
        const delta = cur.startsWith(last) ? cur.slice(last.length) : cur
        if (delta) emit.text(delta)
        last = cur
        stableSince = Date.now()
        continue
      }
      // 正文没变：但 Alice 会先显示「在想，快了…」再整体替换成真答案，
      // 所以没有实质正文时不能计入稳定期（否则 2.5s 就收工）。
      if (!cur) continue
      if (isPlaceholder(cur)) {
        // 占位文案不动，但也不推进 stableSince —— 一直等到 timeoutMs
        continue
      }
      if (Date.now() - stableSince > idleMs) break
    }

    if (cancelled) {
      emit.cancelled('用户取消')
      return { ok: false, aborted: true, text: last, transport: 'cdp' }
    }

    // 用 queryLLMLogs 拿 usage，失败不影响主流程
    try {
      const logs = await c.eval(`JSON.stringify(window.alice.queryLLMLogs({caller:'chat', limit:1}))`)
      const j = JSON.parse(logs || '{}')
      const e = (j.entries || j)[0]
      if (e?.usage) emit.usage(e.usage)
    } catch {}

    emit.done({ stopReason: 'stop', ms: Date.now() - t0 })
    return { text: last, transport: 'cdp' }
  } finally {
    c.close()
  }
}

// ---------------------------------------------------------------------------
// 模型选择
// ---------------------------------------------------------------------------
// Alice 的模型清单不在本地文件里，必须问渲染进程：
//   window.alice.fetchMiyangModelCatalog() -> { models: [{id, name, contextLength, descriptionI18n}] }
// 切模型走 window.alice.setSessionModel(...) / 界面右上角的模型按钮。
// 实测 2026-11-18：21 个模型，id 形如 swift / auto / standard / opus-5-5 / gpt-6-astra-pipellm。
const FETCH_CATALOG = `window.alice.fetchMiyangModelCatalog().then(v => JSON.stringify(v)).catch(e => 'ERR:' + e.message)`

/** 取 Alice 的模型清单（连不上 CDP 时返回空数组） */
/** 目录名/菜单行 → 可比对键：[40.2x] GPT-6 Astra / GPT-6 Astra 40.2x → "gpt-6 astra" */
function nameKey(x) {
  return String(x)
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s*\d+(\.\d+)?x\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 点开 Alice 的模型菜单，读出所有带 is-region-restricted 的模型名。
 *
 * 只探一次、纯字符串表达式（不走模板字符串嵌套，避免多层转义把正则吃掉）。
 */
const RESTRICTED_MODELS_JS = String.raw`(async () => {
  const PILL_RE = new RegExp('^[A-Za-z0-9_./\u4e00-\u9fa5 -]{2,40}\\s*[0-9]+(\\.[0-9]+)?x$');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = async () => {
    const prev = document.activeElement;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
  };
  // 菜单开合是交替的：先按 ESC 归零，确保下一次点击一定是「打开」。
  await esc(); await esc();
  const pill = (() => {
    for (const b of document.querySelectorAll('button')) {
      const t = (b.innerText || '').trim();
      if (PILL_RE.test(t) && b.getBoundingClientRect().width > 60) return b;
    }
    return null;
  })();
  if (!pill) return '[]';
  let list = null;
  // 最多点两次：第一次可能因为菜单本来就是开的而被关掉
  for (let attempt = 0; attempt < 2 && !list; attempt++) {
    await esc();
    const r = pill.getBoundingClientRect();
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    await sleep(900);
    list = document.querySelector('.model-menu__list');
  }
  if (!list) return '[]';
  const out = [];
  for (const row of list.querySelectorAll('.model-menu__row')) {
    if (!/is-region-restricted/.test(String(row.className))) continue;
    out.push((row.innerText || '').trim().replace(/\\s+/g, ' ').replace(/\\s*[0-9]+(\\.[0-9]+)?x\\s*$/, '').trim());
  }
  await esc(); await esc();
  return JSON.stringify(out);
})()`;

export async function aliceModels(port = DEFAULT_PORT) {
  let c
  try {
    c = await connectAlice(port)
  } catch {
    return []
  }
  try {
    const raw = await c.eval(FETCH_CATALOG)
    if (typeof raw !== 'string' || raw.startsWith('ERR:')) return []
    const j = JSON.parse(raw)
    let list = (j.models || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      ctx: m.contextLength || null,
      desc: (m.descriptionI18n && (m.descriptionI18n['zh-CN'] || m.descriptionI18n.en)) || '',
      restricted: false,
    }))
    // 目录里不含「区域是否可用」，必须点开模型菜单读 .model-menu__row 的
    // is-region-restricted 类。实测 2026-11-18：9 个模型（GPT 全系 / Claude 全系 /
    // Gemini 全系）在当前区域受限，点了也不生效 —— 直接从清单里剔掉，
    // 否则工作台下拉里会出现一堆选了没反应的选项。
    try {
      let rawNames = await c.eval(RESTRICTED_MODELS_JS)
      if (rawNames && typeof rawNames === 'object' && typeof rawNames.value === 'string') rawNames = rawNames.value
      const names = JSON.parse(typeof rawNames === 'string' ? rawNames : '[]')
      if (Array.isArray(names) && names.length) {
        // 目录名 "[40.2x] GPT-6 Astra"，菜单行 "GPT-6 Astra" —— 两边都去档位、去前缀再比
        const blocked = new Set(names.map(nameKey))
        list = list.map((m) => ({
          ...m,
          restricted: blocked.has(nameKey(m.name)) || blocked.has(nameKey(m.id)),
        }))
      }
    } catch (e) { /* 菜单探测失败就都当作可用 */
      if (process.env.ALICE_DEBUG) console.error('restricted probe failed:', e?.message)
    }
    return list.filter((m) => !m.restricted)
  } catch {
    return []
  } finally {
    try {
      c.close()
    } catch {}
  }
}

/**
 * 切换 Alice 的当前会话模型。
 *
 * 菜单结构（实测 2026-11-18）：
 *   点右上角药丸 button（宽 176，文本形如 "DeepSeek-V4.1-Flash-1017 0.5x"）
 *   → 弹出 `.model-menu`（`liquid-fluid-glass wd-beak-menu model-menu`）
 *     其中 `.model-menu__list` 可滚动，每行是 `.model-menu__row`（314x39），
 *     行文本就是模型 id（swift / opus-5-5 / gpt-6-astra-pipellm …）。
 *   坑：列表很长会滚出视口（实测第 5 行起 y 已 >1200），必须先 scrollIntoView，
 *       再按「重算后的 rect」发真实鼠标事件；直接 click() 不生效。
 *
 * @returns {Promise<boolean>} 是否切成功（以药丸文本变化为准）
 */
export async function aliceSetModel(cdp, modelId, emit, port = DEFAULT_PORT) {
  if (!modelId) return false
  const want = String(modelId).trim()
  const wantLower = want.toLowerCase()

  // 0) 读当前药丸文本，用于最后校验
  const pillText = `(() => {
    for (const b of document.querySelectorAll('button')) {
      const t = (b.innerText || '').trim()
      if (/^[\\w./\\-\\u4e00-\\u9fa5 ]{2,40}\\s*\\d+(\\.\\d+)?x$/.test(t)) {
        const r = b.getBoundingClientRect()
        if (r.width > 60) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t: t.replace(/\\s+/g, ' ') }
      }
    }
    return null
  })()`
  const before = await cdp.eval(pillText)
  if (!before) {
    emit?.log?.('找不到 Alice 的模型药丸按钮', 'warn')
    return false
  }
  // 已经是目标模型就不用动
  if (before.t.toLowerCase().includes(wantLower)) {
    emit?.log?.(`模型已是 ${before.t}`, 'debug')
    return true
  }

  // 1) 点药丸打开菜单
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: before.x, y: before.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
  }
  await sleep(1000)

  // 2) 在 .model-menu__row 里找目标行；找不到就先滚动再找（列表可滚动且很长）
  // 菜单里显示的是「人读名称 + 档位」（"Claude Opus 5.5 16.1x"），不是模型 id（opus-5-5）。
  // 所以先用目录把 id 翻成 name，匹配不到再拿 id 本身兜底。
  let wantNames = [wantLower]
  try {
    const catalog = await aliceModels(port)
    const hit = catalog.find((m) => String(m.id).toLowerCase() === wantLower)
    if (hit && hit.name) {
      // 去掉 name 里的「[0.6x] 」前缀
      const clean = String(hit.name).replace(/^\[[^\]]*\]\s*/, '').trim()
      if (clean) wantNames = [clean.toLowerCase(), wantLower]
    }
  } catch { /* 目录拿不到就用 id 匹配 */ }
  emit?.log?.(`目标模型 ${want} → 菜单名候选 ${JSON.stringify(wantNames)}`, 'debug')

  const findRow = `(() => {
    const wants = ${JSON.stringify(wantNames)}
    const list = document.querySelector('.model-menu__list')
    if (!list) return { err: 'no-menu' }
    const rows = [...list.querySelectorAll('.model-menu__row')]
    // 部分模型带 is-region-restricted（实测 9 个：GPT 全系 / Claude 全系 / Gemini 全系），
    // 在当前区域不可用 —— 它们的按钮点了也不生效，必须跳过并明确报错。
    const isRestricted = (el) => /is-region-restricted/.test(String(el.className))
    const pick = (rs) => {
      const scored = rs.map((el) => {
        const t = (el.innerText || '').trim().replace(/\\s+/g, ' ')
        const lower = t.toLowerCase()
        // 行文本形如 "Claude Opus 5.5 16.1x"，去掉档位再比
        const stripped = lower.replace(/\\s*\\d+(\\.\\d+)?x\\s*$/, '').trim()
        let rank = -1
        wants.forEach((w, i) => { if (rank < 0 && stripped === w) rank = 100 - i })
        if (rank < 0) wants.forEach((w, i) => { if (rank < 0 && stripped.startsWith(w)) rank = 50 - i })
        if (rank < 0) wants.forEach((w, i) => { if (rank < 0 && stripped.includes(w)) rank = 20 - i })
        if (rank < 0) return null
        const r = el.getBoundingClientRect()
        return { el, t, rank, len: t.length, y: r.y, w: r.width, restricted: isRestricted(el) }
      }).filter(Boolean)
      if (!scored.length) return null
      scored.sort((a, b) => (b.rank - a.rank) || (a.len - b.len))
      return scored[0]
    }
    let hit = pick(rows)
    if (!hit) return { err: 'not-found', count: rows.length }
    if (hit.restricted) return { err: 'region-restricted', t: hit.t }
    // 关键：.model-menu__list 是 scrollH 1524 / clientH 360 的内部滚动容器，
    // scrollIntoView 在这里不生效（它滚的是最近的可滚动祖先，实测没滚）。
    // 直接改 list.scrollTop 把目标行滚进可视区，再读新 rect。
    const lr = list.getBoundingClientRect()
    const rr = hit.el.getBoundingClientRect()
    const rowTopInList = rr.top - lr.top + list.scrollTop
    const want = rowTopInList - (list.clientHeight - rr.height) / 2
    list.scrollTop = Math.max(0, Math.min(want, list.scrollHeight - list.clientHeight))
    const nr = hit.el.getBoundingClientRect()
    const cx = Math.round(nr.x + nr.width / 2)
    const cy = Math.round(nr.y + nr.height / 2)
    // 落在列表可视区内才算可点
    const inView = nr.top >= lr.top - 2 && nr.bottom <= lr.bottom + 2
    return { x: cx, y: cy, t: hit.t, inView }
  })()`

  let row = await cdp.eval(findRow)
  if (row && row.err === 'no-menu') {
    emit?.log?.('模型菜单没弹出来', 'warn')
    await pressEsc(cdp)
    return false
  }
  if (row && row.err === 'region-restricted') {
    emit?.log?.(`「${row.t}」在当前区域不可用（is-region-restricted），未切换`, 'warn')
    await pressEsc(cdp)
    return false
  }
  if (row && row.err === 'not-found') {
    emit?.log?.(`菜单 ${row.count} 行里没有「${want}」`, 'warn')
    await pressEsc(cdp)
    return false
  }
  if (row && row.inView === false) {
    emit?.log?.('目标行滚不到可视区（菜单高度异常）', 'warn')
    await pressEsc(cdp)
    return false
  }
  if (row && row.x == null) {
    emit?.log?.('目标行不可见', 'warn')
    await pressEsc(cdp)
    return false
  }

  // 3) 点目标行 + Enter 双保险（部分版本行只响应键盘）
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: row.x, y: row.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
  }
  await sleep(900)

  // 4) 校验药丸是否真的变了 —— 界面刷新有延迟，轮询最多 4 秒
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    const after = await cdp.eval(pillText)
    if (!after) continue
    const got = after.t.toLowerCase()
    // 药丸显示的是 name（"GLM-5.3 Flash 0.3x"），用 name / id / 去档位三种方式比
    const ok = wantNames.some((w) => got.includes(w)) || got.includes(wantLower)
    if (ok) {
      emit?.log?.(`已切模型 → ${after.t}`, 'debug')
      return true
    }
  }
  emit?.log?.(`切模型后药丸未变成目标值（当前 ${before.t}）`, 'warn')
  return false
}

async function pressEsc(cdp) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    })
  }
}
