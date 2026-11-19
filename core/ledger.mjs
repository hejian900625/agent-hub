import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 任务级账单：每个 run 结束（done / error / cancelled）追加一行 JSONL。
 * 只记实际拿到的东西 —— token、CLI 返回的 cost/credits；拿不到的写 null 并留 note，
 * 不要把「未知」记成 0，否则长期汇总会骗人。
 */
const HOME = process.env.USERPROFILE || os.homedir()
export const LEDGER_FILE = process.env.AGENT_HUB_LEDGER || path.join(HOME, '.agent-hub', 'ledger.jsonl')

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 各轨 usage 形状不一样，统一成 input/output/cacheRead/total/costUsd/credits */
export function normalizeUsage(u = {}) {
  const input = num(u.input ?? u.input_tokens ?? u.prompt_tokens ?? u.inputTokens)
  const output = num(u.output ?? u.output_tokens ?? u.completion_tokens ?? u.outputTokens)
  const cacheRead = num(u.cacheRead ?? u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.cache?.read)
  const total = num(u.total ?? u.total_tokens ?? u.totalTokens) ?? (input != null || output != null ? (input || 0) + (output || 0) + (cacheRead || 0) : null)
  const costUsd = num(u.costUsd ?? u.total_cost_usd ?? u.cost_usd ?? u.costUSD)
  const credits = num(u.credits ?? u.total_credits ?? u.totalCredits)
  const note = typeof u.note === 'string' ? u.note : ''
  const reported = [input, output, cacheRead, total, costUsd, credits].some((v) => v != null)
  return {
    input,
    output,
    cacheRead,
    total,
    costUsd,
    credits,
    source: reported ? (u.creditsSource || 'reported') : 'none',
    note,
  }
}

/** 多个 usage 事件（多轮/重试）累加；null 表示该字段谁都没报 */
export function mergeUsage(a, b) {
  const sum = (x, y) => (x == null && y == null ? null : (x || 0) + (y || 0))
  return {
    input: sum(a.input, b.input),
    output: sum(a.output, b.output),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    total: sum(a.total, b.total),
    costUsd: sum(a.costUsd, b.costUsd),
    credits: sum(a.credits, b.credits),
    source: a.source === 'none' && b.source === 'none' ? 'none' : b.source === 'none' ? a.source : b.source,
    note: [a.note, b.note].filter(Boolean).join('；'),
  }
}

export function appendBill(bill) {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true })
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(bill) + '\n', 'utf8')
    return true
  } catch (e) {
    console.error('[ledger] append failed:', e.message)
    return false
  }
}

export function readBills({ limit = 200, agent = null, group = null, since = null } = {}) {
  let raw = ''
  try {
    const st = fs.statSync(LEDGER_FILE)
    // 文件特别大时只读尾部 5MB，避免把内存吃满；首行可能截断，解析时跳过
    const start = Math.max(0, st.size - 5 * 1024 * 1024)
    const fd = fs.openSync(LEDGER_FILE, 'r')
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    raw = buf.toString('utf8')
  } catch {
    return { bills: [], warnings: [] }
  }
  const warnings = []
  const all = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      all.push(JSON.parse(line))
    } catch {
      warnings.push(line.slice(0, 80))
    }
  }
  let out = all
  if (agent) out = out.filter((b) => b.agentId === agent)
  if (group) out = out.filter((b) => b.groupId === group)
  if (since) {
    const t = Number(since) || Date.parse(since)
    if (Number.isFinite(t)) out = out.filter((b) => Number(b.ts) >= t)
  }
  return { bills: out.slice(-Math.max(1, limit)).reverse(), warnings }
}

export function summarize(bills) {
  const s = {
    runs: 0,
    done: 0,
    error: 0,
    cancelled: 0,
    ms: 0,
    input: null,
    output: null,
    cacheRead: null,
    total: null,
    costUsd: null,
    credits: null,
    byAgent: {},
    byDay: {},
  }
  const add = (obj, k, v) => {
    if (v == null) return
    obj[k] = (obj[k] || 0) + Number(v)
  }
  for (const b of bills) {
    const u = b.usage || {}
    s.runs++
    if (b.status === 'done') s.done++
    else if (b.status === 'cancelled') s.cancelled++
    else s.error++
    s.ms += Number(b.ms) || 0
    for (const k of ['input', 'output', 'cacheRead', 'total', 'costUsd', 'credits']) {
      add(s, k, u[k])
    }
    const id = b.agentId || 'unknown'
    const a = (s.byAgent[id] ||= { runs: 0, ms: 0, input: null, output: null, total: null, costUsd: null, credits: null })
    a.runs++
    a.ms += Number(b.ms) || 0
    for (const k of ['input', 'output', 'total', 'costUsd', 'credits']) add(a, k, u[k])
    const day = new Date(Number(b.ts) || Date.now()).toISOString().slice(0, 10)
    const d = (s.byDay[day] ||= { runs: 0, costUsd: null, credits: null, total: null })
    d.runs++
    for (const k of ['costUsd', 'credits', 'total']) add(d, k, u[k])
  }
  return s
}
