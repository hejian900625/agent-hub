import fs from 'node:fs'
import path from 'node:path'
import { snapshot } from './fanout.mjs'

/**
 * 链式流水的「输出契约」。
 *
 * 背景：链条原本只定义「谁接谁」。第 1 步如果回了一段带围栏的解释文字，
 * 这段文字会被原样塞进第 2 步的 prompt —— 下游拿到的是脏数据，还说不清是哪一步脏的。
 *
 * 现在每一步可以声明 expect（输出契约）：
 *   { type: 'text'  , minLength?: 1, maxLength?, contains?: [], regex?: '...' }
 *   { type: 'json'  , schema?: {...} }         // 支持 JSON Schema 子集
 *   { type: 'code'  , language?: 'js', requireFence?: true }
 *   { type: 'files' , files?: ['a.js'], pattern?: 'src/*.js', min?: 1 }
 *   { type: 'regex' , regex: '^\\d+$' }
 *   retry?: 1        // 校验失败后最多重试几次（默认 1，即最多跑 2 次）
 *
 * 校验失败时不是把脏数据喂下去，而是带着错误信息重跑该步；仍失败则该步标记 error，
 * 下游不再启动。
 */

const DEFAULT_RETRY = 1

export function normalizeExpect(e) {
  if (!e) return null
  if (e === true) return { type: 'text', minLength: 1, retry: DEFAULT_RETRY }
  const out = { ...e }
  out.type = out.type || 'text'
  out.retry = Number.isFinite(out.retry) ? Math.max(0, out.retry) : DEFAULT_RETRY
  if (out.type === 'text' && out.minLength == null) out.minLength = 1
  return out
}

export function describeExpect(e) {
  if (!e) return '无'
  switch (e.type) {
    case 'json':
      return e.schema ? `JSON（需满足 schema：${JSON.stringify(e.schema).slice(0, 200)}）` : '合法 JSON'
    case 'code':
      return `代码块${e.language ? `（语言 ${e.language}）` : ''}${e.requireFence ? '，必须放在围栏里' : ''}`
    case 'files':
      return e.files?.length
        ? `产出文件：${e.files.join(', ')}`
        : e.pattern
          ? `产出匹配 ${e.pattern} 的文件`
          : '至少产出 1 个文件'
    case 'regex':
      return `匹配正则 /${e.regex}/`
    default: {
      const bits = []
      if (e.minLength != null) bits.push(`至少 ${e.minLength} 字`)
      if (e.maxLength != null) bits.push(`至多 ${e.maxLength} 字`)
      if (e.contains?.length) bits.push(`必须包含 ${e.contains.join('、')}`)
      if (e.regex) bits.push(`匹配 /${e.regex}/`)
      return bits.length ? `文本（${bits.join('，')}）` : '非空文本'
    }
  }
}

/** 从回复里取出第一个匹配语言的围栏；没有语言标注时退回第一个围栏 */
export function extractFence(text, language, { fallback = true } = {}) {
  const re = /```([\w+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g
  const all = []
  let m
  while ((m = re.exec(String(text || '')))) all.push({ lang: (m[1] || '').toLowerCase(), body: m[2] })
  if (!all.length) return null
  if (language) {
    const want = language.toLowerCase()
    const hit = all.find((f) => f.lang === want || f.lang.startsWith(want))
    if (hit) return hit
    if (!fallback) return null
  }
  return all[0]
}

const TYPE_OK = (v, t) => {
  switch (t) {
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'integer':
      return Number.isInteger(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v)
    case 'array':
      return Array.isArray(v)
    case 'null':
      return v === null
    default:
      return true
  }
}

/** JSON Schema 的最小子集校验：type / required / properties / items / enum / minLength / minItems */
function validateSchema(value, schema, at, errors) {
  if (!schema || typeof schema !== 'object') return
  if (schema.type && !TYPE_OK(value, schema.type)) {
    errors.push(`${at} 应为 ${schema.type}，实际是 ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((x) => JSON.stringify(x) === JSON.stringify(value)))
    errors.push(`${at} 必须是枚举值之一：${schema.enum.map((x) => JSON.stringify(x)).join(' / ')}`)
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength)
      errors.push(`${at} 长度至少 ${schema.minLength}，实际 ${value.length}`)
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength)
      errors.push(`${at} 长度至多 ${schema.maxLength}，实际 ${value.length}`)
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems)
      errors.push(`${at} 至少 ${schema.minItems} 项，实际 ${value.length}`)
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems)
      errors.push(`${at} 至多 ${schema.maxItems} 项，实际 ${value.length}`)
    if (schema.items) value.forEach((v, i) => validateSchema(v, schema.items, `${at}[${i}]`, errors))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || [])
      if (!(key in value)) errors.push(`${at} 缺少必填字段 ${key}`)
    for (const [key, sub] of Object.entries(schema.properties || {}))
      if (key in value) validateSchema(value[key], sub, `${at}.${key}`, errors)
  }
}

function globToRe(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE__')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/__DOUBLE__/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * @param {object} expect  normalizeExpect 后的契约
 * @param {string} text    agent 的原始输出（可能带 markdown）
 * @param {{cwd?: string, before?: Map<string,{hash:string}>}} ctx
 * @returns {{ok: boolean, errors: string[], value?: any, normalized: string}}
 */
export function validateOutput(expect, text, ctx = {}) {
  const raw = String(text || '')
  const errors = []
  let value = raw
  let normalized = raw.trim()

  switch (expect.type) {
    case 'json': {
      const fence = extractFence(raw, 'json')
      const body = (fence ? fence.body : raw).trim()
      try {
        value = JSON.parse(body)
        normalized = JSON.stringify(value, null, 2)
      } catch (e) {
        errors.push(`不是合法 JSON：${e.message}`)
        return { ok: false, errors, normalized: raw.trim() }
      }
      if (expect.schema) validateSchema(value, expect.schema, '$', errors)
      break
    }
    case 'code': {
      const fence = extractFence(raw, expect.language, { fallback: !expect.language })
      if (!fence) {
        if (expect.requireFence !== false) {
          errors.push(
            expect.language
              ? `没有找到 \`\`\`${expect.language} 代码块（只接受围栏内的代码）`
              : '没有找到 ``` 代码块'
          )
          return { ok: false, errors, normalized: raw.trim() }
        }
        value = raw.trim()
      } else value = fence.body
      if (!String(value).trim()) errors.push('代码块为空')
      normalized = String(value).replace(/\s+$/, '')
      break
    }
    case 'files': {
      const cwd = ctx.cwd || process.cwd()
      const made = []
      if (expect.files?.length) {
        for (const rel of expect.files) {
          if (fs.existsSync(path.join(cwd, rel))) made.push(rel)
          else errors.push(`缺少文件 ${rel}`)
        }
      } else if (expect.pattern) {
        const re = globToRe(expect.pattern)
        const walk = (d, rel = '') => {
          let ents = []
          try {
            ents = fs.readdirSync(d, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of ents) {
            if (['node_modules', '.git', 'dist', 'build'].includes(e.name)) continue
            const r = rel ? `${rel}/${e.name}` : e.name
            if (e.isDirectory()) walk(path.join(d, e.name), r)
            else if (e.isFile() && re.test(r)) made.push(r)
          }
        }
        walk(cwd)
        if (!made.length) errors.push(`没有产出匹配 ${expect.pattern} 的文件`)
      } else if (ctx.before) {
        // 没有声明具体文件/模式：对比跑之前的快照，新增或内容变化都算产出
        const after = snapshot(cwd)
        for (const [rel, v] of after) {
          const prev = ctx.before.get(rel)
          if (!prev || prev.hash !== v.hash) made.push(rel)
        }
        if (made.length < (expect.min || 1))
          errors.push(`没有产出新文件（要求至少 ${expect.min || 1} 个）`)
      } else if (!expect.files?.length && !expect.pattern) {
        errors.push('files 契约缺少 files / pattern，且没有 baseline')
      }
      if (made.length) normalized = `${raw.trim()}\n\n[产出文件]\n${made.map((f) => `- ${f}`).join('\n')}`.trim()
      break
    }
    case 'regex': {
      let re
      try {
        re = new RegExp(expect.regex)
      } catch (e) {
        errors.push(`契约里的正则写错了：${e.message}`)
        break
      }
      if (!re.test(raw)) errors.push(`输出不匹配 /${expect.regex}/`)
      normalized = raw.trim()
      break
    }
    default: {
      const t = raw.trim()
      if ((expect.minLength ?? 1) > 0 && t.length < (expect.minLength ?? 1))
        errors.push(`输出太短（${t.length} < ${expect.minLength ?? 1}）`)
      if (expect.maxLength != null && t.length > expect.maxLength)
        errors.push(`输出太长（${t.length} > ${expect.maxLength}）`)
      for (const s of expect.contains || []) if (!raw.includes(s)) errors.push(`输出里没有「${s}」`)
      if (expect.regex && !new RegExp(expect.regex).test(raw)) errors.push(`输出不匹配 /${expect.regex}/`)
      normalized = t
    }
  }

  return { ok: errors.length === 0, errors, value, normalized }
}

/** 重试时追加的修复说明：只换格式，不换任务 */
export function repairPrompt(originalPrompt, expect, errors) {
  return [
    originalPrompt,
    '',
    '【上一轮输出未通过校验 · 请重做这一步】',
    `校验失败原因：${errors.join('；')}`,
    `本次输出必须满足：${describeExpect(expect)}`,
    '- 直接给出符合格式的最终结果，不要解释、不要复述任务。',
  ].join('\n')
}
