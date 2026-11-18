import fs from 'node:fs'
import path from 'node:path'
import { traeModelList } from './trae-cn.mjs'
import { wbChatModels, wbDefaultModel } from './workbuddy.mjs'

/**
 * 本机实测的 agent 入口（2026-11-16）。
 * 每个 agent 可声明多条「传输通道」，工作台按 acp → http → cli → gui 择优。
 * nodeEntry = 直接用 node 执行的 JS 入口，避免 Windows .cmd/shell 的坑。
 */

const HOME = process.env.USERPROFILE || 'C:\\Users\\Lenovo'
const NPM = path.join(HOME, 'AppData', 'Roaming', 'npm')
const NM = path.join(NPM, 'node_modules')

const WORKBUDDY_PRODUCT = 'D:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\product.json'
const TRAE_CN_EXE = 'D:\\Programs\\Trae CN\\Trae CN.exe'

export const AGENTS = {
  trae: {
    id: 'trae',
    label: 'Trae CN',
    vendor: 'ByteDance',
    accent: '#3b82f6',
    // 官方 traex CLI 已弃用（需企业版登录）。现走 Trae CN 客户端的本地凭据：
    //   storage.json 里的 iCubeAuthInfo://icube.cloudide 解出 userInfo.token，
    //   以 Cloud-IDE-JWT 头打 https://api.trae.cn 的积分/模型接口。
    bin: TRAE_CN_EXE,
    authHint: '打开 Trae CN 客户端登录（token 从 storage.json 解密）',
    transports: {
      // 执行轨：CDP 驱动 Solo 渲染进程（必须带 --remote-debugging-port=9334 启动，
      // 见 D:\Programs\Trae CN\start-debug.bat）。
      cdp: { kind: 'cdp', port: 9334, exe: TRAE_CN_EXE, launchArgs: ['--remote-debugging-port=9334'] },
      // 客户端本体：只表示「依赖 Trae CN.exe 这个应用」，不参与派发。
      client: { kind: 'client', mode: 'trae-cn', exe: TRAE_CN_EXE, port: 9334 },
    },
    caps: ['credits', 'model-select', 'client-models'],
    // models / defaultModel 由 listAgents() 动态注入（读 state.vscdb），此处留空
    models: null,
    defaultModel: 'Doubao-Seed-Code',
  },

  qoder: {
    id: 'qoder',
    label: 'Qoder',
    vendor: 'Alibaba',
    accent: '#a855f7',
    bin: path.join(NPM, 'qodercli.cmd'),
    authHint: 'qodercli login',
    transports: {
      cli: {
        kind: 'cli',
        cmd: path.join(NPM, 'qodercli.cmd'),
        nodeEntry: path.join(NM, '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js'),
        // -m 必须显式给：不带 -m 时 qodercli 1.1.70 的 headless 路由会抛
        // FatalRoutingError: No models are available in the current catalog
        // （catalog 拉到了 24 个模型，但 turn.started model="" 路由不上）
        // --yolo 是必须的：qodercli 默认把 cwd 当「信任目录」，任何落在 cwd
        // 之外（包括工作台派发的 D:\project\xxx）的读写都会弹权限确认；非交互
        // 模式下没人能点确认，工具调用直接返回 is_error。
        // 实测（2026-11-18）：无 --yolo → `Error: Allow reading C:\X.txt?`；
        // 加 --yolo → ls 外部目录直接成功，permission_denials 为空数组。
        // --yolo 在 bundle 里等价于 permissionMode="bypass_permissions"
        // （见 qodercli.js 的 GQo 映射表 yolo:"permission_mode"）。
        args: ['-p', '-o', 'stream-json', '-m', 'Auto', '--yolo'],
      },
    },
    caps: ['stream-json', 'remote-control', 'sessions', 'worktree', 'mcp', 'model-select'],
    models: [
      'Auto', 'Ultimate', 'Fast', 'Efficient', 'Sonus', 'Cantus',
      'Qwen4-Max', 'Qwen4-Max-Preview', 'Qwen3.8-Max', 'Qwen3.8-Flash',
      'Kimi-K3.1-Pro', 'Kimi-K2.8-Preview', 'GLM-5.3', 'GLM-5.3-Flash',
      'DeepSeek-V4-Pro', 'DeepSeek-Flash', 'MiniMax-M3.1-Flash',
    ],
    defaultModel: 'Auto',
  },

  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    vendor: 'Tencent',
    accent: '#22c55e',
    bin: path.join(NPM, 'codebuddy.cmd'),
    authHint: '在浏览器里登录 WorkBuddy（工作台会打开登录页）',
    transports: {
      http: {
        kind: 'http',
        cmd: path.join(NPM, 'codebuddy.cmd'),
        nodeEntry: path.join(NM, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
        productConfig: WORKBUDDY_PRODUCT,
        args: ['--serve', '--auth', 'none', '--port', '7799'],
      },
      acp: {
        kind: 'acp',
        cmd: path.join(NPM, 'codebuddy.cmd'),
        nodeEntry: path.join(NM, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
        productConfig: WORKBUDDY_PRODUCT,
        args: ['--acp', '--dangerously-skip-permissions'],
      },
      cli: {
        kind: 'cli',
        cmd: path.join(NPM, 'codebuddy.cmd'),
        nodeEntry: path.join(NM, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
        productConfig: WORKBUDDY_PRODUCT,
        // --dangerously-skip-permissions 是必须的：headless 模式下 codebuddy
        // 把 cwd 当唯一信任目录，写 cwd 之外的文件会走权限确认流程，没人确认
        // 就返回 `[object Object]`（错误体被 toJSON 吞了）。
        // 实测（2026-11-18）dist/codebuddy.js 的 parseAgentsArgv：
        //   "--dangerously-skip-permissions" === eu || "-y" === eu
        //     → el.permissionMode = "bypassPermissions"
        // 并列的还有 --permission-mode <mode>，可用值 bypassPermissions。
        args: ['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions'],
      },
    },
    // 本机已有的 opencode 网关（OpenAI 兼容，可当模型后端）
    bridge: {
      endpoint: 'http://127.0.0.1:41980/v1',
      keyFile: path.join(HOME, 'AppData', 'Roaming', 'Buddy Bridge', 'api-key'),
    },
    caps: ['http-serve', 'acp', 'stream-json', 'background-sessions', 'mcp', 'model-select'],
    // WorkBuddy 桌面版 product.json 里的模型表（58 项，含 credits / 上下文长度）。
    // 运行时由 listAgents() 用 wbChatModels() 覆盖成真表；这里只作离线兜底。
    models: ['auto', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.1', 'glm-5.0', 'glm-4.7', 'kimi-k2.5', 'minimax-m2.7', 'minimax-m3-pay', 'hy3', 'hy4-preview'],
    defaultModel: 'auto',
    // 用 WorkBuddy 桌面版的 product.json 才能走 workbuddy.cn 端点与上面这套模型 id
    productConfig: WORKBUDDY_PRODUCT,
  },

  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    vendor: 'MiniMax',
    accent: '#f59e0b',
    bin: path.join(NPM, 'mcode.cmd'),
    authHint: 'mcode（首次进入 TUI 登录）',
    // 原生 better_sqlite3.node 是 ABI 146（Electron 35 / Node 24.19）编译的。
    // 用系统 node 24.20（ABI 137）跑会在装载失败后被 exit 路径吞掉，表现成
    // "Assertion failed: (env) != nullptr" + exit 134 + stdout 全空。
    // 解法：runtime:'electron' + ELECTRON_RUN_AS_NODE，并指向桌面版 ABI 匹配的那份 sqlite。
    // 实现见 core/mm-runtime.mjs；spawn 见 core/spawn.mjs 的 runtime 分支。
    runtime: 'electron',
    transports: {
      acp: {
        kind: 'acp',
        runtime: 'electron',
        cmd: path.join(NPM, 'mcode.cmd'),
        nodeEntry: path.join(NM, '@minimax-ai', 'code', 'cli.js'),
        args: ['acp'],
      },
      cli: {
        kind: 'cli',
        runtime: 'electron',
        cmd: path.join(NPM, 'mcode.cmd'),
        nodeEntry: path.join(NM, '@minimax-ai', 'code', 'cli.js'),
        // --prompt-mode coding 必须显式给；默认 tui 会试图开交互式界面
        args: ['exec', '--prompt-mode', 'coding'],
      },
    },
    caps: ['acp', 'exec', 'stream-json', 'app-server', 'computer-use', 'model-select'],
    // 这台机器走 token_plan（minimax_oauth active），官方目录只放出这两个。
    // 其余 id（M2.x / M1 / 小写 m3）传进去 mcode 不报错，而是**静默回退**到
    // M3.1-Flash —— 实测 `--model minimax/minimax-m2.5` 的 turn.completed 里
    // modelId 是 "MiniMax-M3.1-Flash"。所以列表只留真实可解析的，别放假 id。
    models: ['minimax/MiniMax-M3', 'minimax/MiniMax-M3.1-Flash'],
    defaultModel: 'minimax/MiniMax-M3',
  },

  doubao: {
    id: 'doubao',
    label: 'Doubao',
    vendor: 'ByteDance',
    accent: '#ef4444',
    bin: 'D:\\Program Files\\DoubaoWork\\DoubaoWork.exe',
    authHint: '打开豆包客户端登录（必须带 --remote-debugging-port=9335；工作台不代劳）',
    // 豆包没有 CLI / ACP / stream-json / 本地 HTTP 对话入口，唯一可编程面是
    // Chromium 调试端口 + DOM。CDP 轨实测要点见 core/doubao-cdp.mjs 顶部注释。
    transports: {
      cdp: {
        kind: 'cdp',
        port: 9335,
        exe: 'D:\\Program Files\\DoubaoWork\\DoubaoWork.exe',
        launchArgs: ['--remote-debugging-port=9335'],
      },
      gui: { kind: 'gui', cmd: 'D:\\Program Files\\DoubaoWork\\DoubaoWork.exe', args: [] },
    },
    // 模型选择器在输入框右下角（「DeepSeek V4.1 Flash 高」那颗按钮）。
    // 完整 10 项由 core/doubao-cdp.mjs 的 doubaoModels() 运行时点开下拉读取，
    // 这里只是 CDP 未开时的兜底清单。
    caps: ['cdp', 'gui-fallback', 'model-select'],
    models: [
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
    ],
    defaultModel: '自动',
  },

  // Loomy = Electron 外壳 + opencode 内核。外壳自己拉起
  // `opencode serve --hostname=127.0.0.1 --port=<随机>`，端口只能发现不能写死。
  // Loomy：Electron 外壳 + opencode 内核。两条轨都能走，但默认用 ACP —— 因为
  // `opencode.exe acp` 是独立进程，**不用启动 Loomy 客户端**；而 http 轨要连客户端
  // 自己拉起的 `opencode serve`（随机端口 + SSE），必须先开着客户端。
  // ACP 实测（2026-11-17，opencode2 v0.0.0-beta-17823）：
  //   initialize → protocolVersion 1，capabilities 含 loadSession /
  //   promptCapabilities{embeddedContext,image} / sessionCapabilities{close,delete,fork,list,resume}
  //   session/new → ses_xxx；prompt → agent_message_chunk 增量，stopReason end_turn
  loomy: {
    id: 'loomy',
    label: 'Loomy',
    vendor: 'Loomy / opencode',
    accent: '#0ea5e9',
    bin: 'D:\\Program Files\\Loomy\\Loomy.exe',
    authHint: 'ACP 轨无需登录；走 http 轨才需要开 Loomy 客户端',
    transports: {
      acp: {
        kind: 'acp',
        cmd: path.join(NPM, 'opencode.exe'),
        args: ['acp'],
      },
      http: {
        kind: 'http',
        mode: 'opencode',
        discover: 'netstat \u626b\u63cf /config \u91cc\u6709 agent.loomy-file',
        agent: 'loomy-file',
      },
    },
    configDir: 'C:\\Users\\Public\\Loomy\\acec4064d0fc\\opencode',
    caps: ['acp', 'http-api', 'sse-stream', 'opencode-kernel', 'skills', 'mcp', 'plugin', 'model-select'],
    // 两套模型池，取决于客户端开没开（runner 的 pickLoomyTrack 运行时决定走哪轨）：
    //   客户端开着 → http 轨 → opencode.json 里的 imodel/*（实测 5 个全能跑）
    //   客户端没开 → acp 轨  → 只能 opencode/*（本机只有 hy4-flash-free 免费额度够）
    // 这里给的是「取并集」的兜底清单，运行时 listAgents 会按客户端状态覆盖。
    models: [
      'imodel/auto',
      'imodel/spark-x2.6',
      'imodel/DeepSeek-V4.1-Flash',
      'imodel/deepseek-v4-flash-1017',
      'imodel/GLM-5.3-Flash',
      'imodel/qwen3.8-flash',
      'imodel/mimo-v2.5',
      'opencode/hy4-flash-free',
    ],
    defaultModel: 'imodel/auto',
  },

  // Alice = Electron + 本地 agent worker（Miyang Tech）。window.alice 有 ~900 个方法，
  // 但没有发送消息的 IPC —— 发送走 CDP + DOM + 真实键盘事件。
  alice: {
    id: 'alice',
    label: 'Alice',
    vendor: 'Miyang Tech',
    accent: '#ec4899',
    bin: 'D:\\Program Files\\Alice\\Alice.exe',
    authHint: '桌面客户端已登录，无需额外认证',
    transports: {
      cdp: { kind: 'cdp', port: 9333, exe: 'D:\\Program Files\\Alice\\Alice.exe', launchArgs: ['--remote-debugging-port=9333'] },
    },
    caps: ['cdp', 'dom-drive', 'persona', 'local-worker', 'miyang-gateway', 'model-select'],
    // 完整 21 项由 core/alice-cdp.mjs 的 aliceModels() 运行时从
    // window.alice.fetchMiyangModelCatalog() 拉；这里只是 CDP 未开时的兜底子集。
    models: ['auto', 'swift', 'standard', 'gemini-3.8-flash', 'qwen4-max', 'opus-5-5', 'sonnet-5-5', 'gpt-6-sol'],
    defaultModel: 'auto',
  },

  // SCNet = 曙光智算「计算服务」（Electron 44 / Chrome 152）。
  // 无 CLI 对话入口，不开本地 HTTP 端口，唯一可编程面是 CDP；
  // 启动必须清空 ELECTRON_RUN_AS_NODE，否则 --remote-debugging-port 会被 Node 层吞掉。
  scnet: {
    id: 'scnet',
    label: 'SCNet',
    vendor: '曙光智算',
    accent: '#22c55e',
    bin: 'D:\\Program Files\\scnet-client\\计算服务.exe',
    authHint:
      '客户端自带登录态（config.json accessToken）；启动时清空 ELECTRON_RUN_AS_NODE 并带 --remote-debugging-port=9336',
    transports: {
      cdp: {
        kind: 'cdp',
        port: 9336,
        exe: 'D:\\Program Files\\scnet-client\\计算服务.exe',
        launchArgs: ['--remote-debugging-port=9336'],
        clearEnv: ['ELECTRON_RUN_AS_NODE'],
      },
    },
    caps: ['cdp', 'dom-drive', 'hpc-jobs', 'scnet-tools', 'file-transfer', 'shell', 'model-select'],
    models: ['SCNet-Max'],
    defaultModel: 'SCNet-Max',
  },
}

const exists = (p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

export function listAgents() {
  return Object.values(AGENTS).map((a) => {
    // trae：模型清单在运行时从 Trae CN 的 state.vscdb 拉（客户端装/登录才准）
    let models = a.models || null
    // trae：模型清单在运行时从 Trae CN 的 state.vscdb 拉（客户端登录才准）
    let defaultModel = a.defaultModel || null
    if (a.id === 'trae' && !models) {
      try { models = traeModelList() } catch { models = null }
    }
    // workbuddy：模型清单从 WorkBuddy 桌面版 product.json 拉（58 项里挑聊天可用的）
    if (a.id === 'workbuddy') {
      try {
        const wm = wbChatModels()
        if (wm && wm.length) models = wm
        defaultModel = wbDefaultModel()
      } catch { /* 保留兜底 models */ }
    }
    return {
      id: a.id,
      label: a.label,
      vendor: a.vendor,
      accent: a.accent,
      bin: a.bin,
      authHint: a.authHint,
      installed: exists(a.bin),
      transports: Object.entries(a.transports).map(([k, t]) => ({
        name: k,
        kind: t.kind,
        nodeEntry: !!t.nodeEntry && exists(t.nodeEntry),
      })),
      caps: a.caps,
      models,
      defaultModel,
    }
  })
}

export function getAgent(id) {
  const a = AGENTS[id]
  if (!a) throw new Error(`unknown agent: ${id}`)
  return a
}
