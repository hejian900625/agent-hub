// 用正式 adapter 跑一次端到端
import { runScnet, scnetStatus } from '../core/scnet-cdp.mjs'

const prompt = process.argv[2] || '只回复两个字：在线'
const port = Number(process.argv[3] || 9336)

console.log('status:', JSON.stringify(await scnetStatus(port)))

const emit = {
  log: (m, l) => console.log(`  [${l || 'info'}] ${m}`),
  thinking: (t) => process.stdout.write(`\x1b[90m${t}\x1b[0m`),
  text: (t) => process.stdout.write(t),
  usage: () => {},
}

const t0 = Date.now()
try {
  const r = await runScnet('scnet', { prompt, emit, port, newTopic: true })
  console.log(`\n\n=== done ${((Date.now() - t0) / 1000).toFixed(1)}s ===`)
  console.log(JSON.stringify(r, null, 1))
} catch (e) {
  console.log(`\n\n=== FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s ===`)
  console.log(e.message)
  process.exit(1)
}
