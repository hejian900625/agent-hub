import { AcpClient } from '../core/acp-client.mjs'
import { getAgent } from '../core/registry.mjs'

const id = process.argv[2] || 'trae'
const agent = getAgent(id)
const t = agent.transports.acp
if (!t) {
  console.log(`[skip] ${id} 没有 acp 通道`)
  process.exit(0)
}

console.log(`[probe] ${agent.label} → ${t.nodeEntry || t.cmd} ${t.args.join(' ')}`)
const c = new AcpClient({ transport: t, cwd: process.cwd(), label: id })

c.on('stderr', (d) => process.stderr.write(`  [stderr] ${d}`))
c.on('update', (p) => console.log('  [update]', JSON.stringify(p).slice(0, 200)))

const timeout = (ms, tag) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag} timeout ${ms}ms`)), ms))

try {
  c.start()
  const init = await Promise.race([c.initialize(), timeout(20000, 'initialize')])
  console.log('  ✓ initialize:', JSON.stringify(init).slice(0, 400))

  const s = await Promise.race([c.newSession({ cwd: process.cwd() }), timeout(20000, 'session/new')])
  console.log('  ✓ session:', JSON.stringify(s).slice(0, 300))
} catch (e) {
  console.log('  ✗', e.message)
  if (c.stderrTail) console.log('  --- stderr tail ---\n' + c.stderrTail.slice(-1200))
  process.exitCode = 1
} finally {
  c.kill()
}
