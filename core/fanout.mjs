import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 并行分发沙箱 + 结果对比。
 *
 * 为什么需要：
 *   fanout 模式下所有 agent 拿到的是同一个 cwd，`package.json` / `src/index.js`
 *   这类同名文件会互相覆盖，最后既分不清是谁写的，也没法比较谁做得更好。
 *
 * 做法：
 *   1. 每个 agent 一个 `<cwd>/<agent>-<YYYYMMDD-HHmmss>/`
 *   2. 源目录先做一次快照（baseline），再把过滤后的文件复制进每个沙箱
 *      （跳过 node_modules / .git / dist / 历史沙箱，避免把几百 MB 复制 N 份）
 *   3. 跑完对每个沙箱做快照，和 baseline 比：新增 / 修改 / 删除
 *   4. 两个沙箱之间再做一次 pairwise 比较：谁和谁在哪些文件上不一样
 *
 * 注意：cwd 隔离只约束「相对路径」。prompt 里若写死绝对路径，agent 仍可能写到外面，
 * 所以派发时会额外注入一段沙箱约束，要求把绝对路径映射进沙箱。
 */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.idea',
  '.gradle',
  '.turbo',
])

const MAX_FILES = 800
const MAX_BYTES = 60 * 1024 * 1024
const SANDBOX_RE = /^(?:trae|qoder|workbuddy|minimax|doubao|loomy|alice|scnet)-\d{8}-\d{6}(?:-\d+)?$/

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function newBatchId() {
  return `fb-${stamp()}-${crypto.randomBytes(2).toString('hex')}`
}

function isIgnored(name, full) {
  if (IGNORE_DIRS.has(name)) return true
  if (SANDBOX_RE.test(name)) return true
  try {
    if (fs.lstatSync(full).isSymbolicLink()) return true
  } catch {}
  return false
}

/** 统计源目录规模，决定值不值得整体复制 */
export function measureTree(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(d, e.name)
      if (isIgnored(e.name, full)) continue
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        files++
        try {
          bytes += fs.statSync(full).size
        } catch {}
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true })
  let ents
  try {
    ents = fs.readdirSync(src, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const from = path.join(src, e.name)
    const to = path.join(dst, e.name)
    if (isIgnored(e.name, from)) {
      stats.skipped++
      continue
    }
    if (e.isDirectory()) copyTree(from, to, stats)
    else if (e.isFile()) {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.copyFileSync(from, to)
        stats.files++
      } catch {
        stats.failed++
      }
    }
  }
}

/**
 * 建一个沙箱目录。
 * 源目录有内容且规模可控时复制一份进去（这样「改造现有项目」的并行对比才有意义）；
 * 源目录是空的或过大时只建空目录，并在结果里说明。
 */
export function createSandbox({ baseDir, agentId, batchStamp = stamp() }) {
  const root = path.resolve(baseDir)
  fs.mkdirSync(root, { recursive: true })
  let name = `${agentId}-${batchStamp}`
  let dir = path.join(root, name)
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${name}-${i}`)
  fs.mkdirSync(dir, { recursive: true })

  const size = measureTree(root)
  if (size.files === 0) return { dir, copied: 0, skipped: 0, note: '源目录为空，已建空沙箱' }
  if (size.files > MAX_FILES || size.bytes > MAX_BYTES)
    return {
      dir,
      copied: 0,
      skipped: size.files,
      note: `源目录过大（${size.files} 文件 / ${(size.bytes / 1048576).toFixed(1)}MB），只建空沙箱`,
    }

  const stats = { files: 0, skipped: 0, failed: 0 }
  copyTree(root, dir, stats)
  return { dir, copied: stats.files, skipped: stats.skipped, failed: stats.failed }
}

/** 目录快照：相对路径 → {size, hash}。大文件只记 size+mtime，避免读爆内存 */
export function snapshot(dir) {
  const out = new Map()
  const walk = (d, rel = '') => {
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (isIgnored(e.name, full)) continue
      if (e.isDirectory()) walk(full, r)
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full)
          let hash
          if (st.size <= 8 * 1024 * 1024) {
            hash = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 16)
          } else {
            hash = `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}`
          }
          out.set(r, { size: st.size, hash })
        } catch {}
      }
    }
  }
  walk(path.resolve(dir))
  return out
}

/** a → b 的变化（b 是「之后」）：谁新增、谁删除、谁内容变了 */
export function diffSnap(a, b) {
  const added = []
  const removed = []
  const modified = []
  const same = []
  for (const [rel, v] of b) {
    const old = a.get(rel)
    if (!old) added.push(rel)
    else if (old.hash !== v.hash) modified.push(rel)
    else same.push(rel)
  }
  for (const rel of a.keys()) if (!b.has(rel)) removed.push(rel)
  const sort = (x) => x.sort((p, q) => p.localeCompare(q))
  return { added: sort(added), removed: sort(removed), modified: sort(modified), sameCount: same.length }
}

/**
 * 生成整批报告。
 * @param {{baseDir:string, baseline:Map, members:{agent:string,dir:string}[]}} batch
 */
export function buildReport(batch) {
  const base = batch.baseline || new Map()
  batch.snapshots = batch.snapshots || {}
  const agents = batch.members.map((m) => {
    const snap = batch.snapshots[m.agent] || (batch.snapshots[m.agent] = snapshot(m.dir))
    return {
      agent: m.agent,
      dir: m.dir,
      fileCount: snap.size,
      ...diffSnap(base, snap),
    }
  })

  // 两两比较：只看「两边内容不一致」的文件，等价于「两家答案不一样」
  const comparisons = []
  for (let i = 0; i < batch.members.length; i++) {
    for (let j = i + 1; j < batch.members.length; j++) {
      const A = batch.snapshots[batch.members[i].agent]
      const B = batch.snapshots[batch.members[j].agent]
      const keys = new Set([...A.keys(), ...B.keys()])
      const differing = []
      for (const k of keys) {
        const x = A.get(k)
        const y = B.get(k)
        if (!x || !y || x.hash !== y.hash) differing.push(k)
      }
      comparisons.push({
        a: batch.members[i].agent,
        b: batch.members[j].agent,
        differingCount: differing.length,
        differing: differing.sort((p, q) => p.localeCompare(q)).slice(0, 200),
      })
    }
  }

  const overlapping = agents.filter((a) => a.added.length + a.modified.length > 0)
  const identical =
    comparisons.length > 0 && comparisons.every((c) => c.differingCount === 0)
      ? '所有 agent 产出完全一致'
      : overlapping.length > 1
        ? `${overlapping.length} 家都有产出，两两差异见 comparisons`
        : overlapping.length === 1
          ? `只有 ${overlapping[0].agent} 产出了文件`
          : '没有 agent 产出文件'

  return {
    batchId: batch.id,
    baseDir: batch.baseDir,
    isolated: batch.isolated,
    baselineSkipped: !!batch.baselineSkipped,
    createdAt: new Date(batch.createdAt).toISOString(),
    finishedAt: new Date().toISOString(),
    summary: identical,
    agents,
    comparisons,
  }
}

/** 把报告落到源目录旁边，方便事后直接打开 */
export function writeReport(baseDir, report) {
  const file = path.join(path.resolve(baseDir), `fanout-${report.batchId}.report.json`)
  try {
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
    return file
  } catch {
    return null
  }
}

/** 派发时注入的沙箱约束（避免 agent 拿绝对路径写到别人家里） */
export function sandboxPrompt(dir, baseDir) {
  return [
    '【沙箱约束 · 并行对比】',
    `本次多个 agent 并行处理同一任务，你的工作目录是：${dir}`,
    `- 所有新建/修改的文件都留在这个目录内，不要写到 ${baseDir} 根目录，也不要碰其他 agent 的目录。`,
    '- 任务里如果给了绝对路径（例如 D:\\project\\x\\a.txt），请把它映射成你沙箱里的同名相对路径（a.txt）。',
    '- 不要删除或重命名沙箱之外的任何东西。',
    '',
  ].join('\n')
}
