# Agent Hub — 多智能体指挥台

用一个本地 Web 工作台统一指挥 **Trae / Qoder / WorkBuddy / MiniMax / Doubao / Loomy / Alice / SCNet** 八个 agent：统一派发、统一事件流、统一编排。

## 1. 本机实测能力矩阵（2026-11-16）

| Agent | CLI 入口 | ACP | 非交互 | 额外通道 | 当前状态 |
|---|---|---|---|---|---|
| **Trae** | `Trae CN.exe` (3.4.17) | — | ⚠️ 待定（AhaIpc） | 客户端凭据桥（storage.json AES 解密）→ 积分 + 30 模型 | ✅ 凭据/积分/模型已打通（客户端登录） |
| **Qoder** | `qodercli` (1.1.70) | — | ✅ `-p -o stream-json` | `remote-control` 守护进程 / 会话列表 | 需 `/login` |
| **WorkBuddy** | `codebuddy` / `cbc` (2.184.0) + `D:\Program Files\WorkBuddy` 桌面版 product.json | ⚠️ `--acp`（能握手但回 refusal，不用） | ✅ `-p --output-format stream-json --model <id>` | SDK `control_request/authenticate` 登录桥 / `--serve`（REST+SSE+WebUI）/ 后台会话 `ps/attach/kill` | ✅ 已打通（45 个模型可选，链式编排已验证） |
| **MiniMax** | `mcode` (0.7.7) | ✅ `acp` | ✅ `exec` | `app-server` / `computer-use` | ✅ 已打通（走 Electron 内嵌 Node 24.19 绕开 ABI 146 vs 137） |
| **Doubao** | `DoubaoWork.exe` (2.32.14) | — | ✅ CDP 驱动 | `--remote-debugging-port=9335` + DOM | ✅ 已打通（Chrome 147 / ProseMirror / 真实 Enter） |
| **Loomy** | `opencode.exe acp`（`D:\Program Files\Loomy` 只是外壳，**不需要启动**） | ✅ `opencode acp`（默认轨） | ✅ 本地 HTTP API（需开客户端） | **`opencode serve` 随机端口 + SSE**；`opencode-kernel` | ✅ ACP 直连可用（无需客户端） |
| **Alice** | `Alice.exe`（Electron + 本地 worker） | — | ✅ CDP 驱动 | `window.alice` ~900 方法 / persona 文件 | ✅ 直连可用（已实测） |
| **SCNet** | `计算服务.exe` (4.2.0，曙光智算) | — | ✅ CDP 驱动 | `--remote-debugging-port=9336` + 清空 `ELECTRON_RUN_AS_NODE`；CLI 只读（status/doctor/logs/diagnose）| ✅ 已打通（Chrome 152 / tiptap / SCNet-Max） |

> 结论：**ACP 是统一层**（5/8 支持：trae 走客户端 CDP、qoder/workbuddy/minimax/loomy 走 ACP 或 CLI），**Alice / Doubao / SCNet 走 CDP**（都需要自己开调试端口）。

## 2. 快速开始

**双击 `start.bat`** 即可（Windows 最省事）：

- 自动找 `node.exe`：先查 PATH，再回退 `D:\nodejs\node.exe`、`C:\Program Files\nodejs\node.exe`、`%LOCALAPPDATA%\Programs\nodejs\node.exe`
- 起服务后**自动打开浏览器**
- 端口 7788 已被本工作台占用 → 提示「已经在运行」并直接开浏览器，不会重复起
- 端口 7788 被别的程序占用 → 自动顺延到 7789/7790…（最多 11 个）
- 启动失败时窗口不会闪退：打印错误码后 `pause`，能看到原因

命令行方式等价：

```bash
cd agent-hub
npm start          # 或 node server.mjs
# → http://127.0.0.1:7788
```

> `start.bat` 必须是 **CRLF 行尾 + 纯 ASCII**。用 LF 行尾保存会让 cmd.exe 错切 `chcp 65001`（报 `'5001' 不是内部或外部命令`）导致整份批处理失效——这是 2026-11-17 那次「启动不了」的真实原因。

先登录各家（工作台左侧点「未登录·点击登录」会调起）：

```bash
"D:\Programs\Trae CN\Trae CN.exe"  # Trae CN（客户端扫码，登录后点「刷新登录状态」）
qodercli login                  # Qoder
codebuddy login                 # WorkBuddy
mcode login                     # MiniMax（Node 24 有坑，见 §6）
"D:\Program Files\DoubaoWork\DoubaoWork.exe"   # 豆包只能开客户端
```

## 3. 界面三种编排模式

- **单发** — 选一个 agent，输入指令。
- **并行分发（fanout）** — 同一指令同时打给 N 个 agent，横向比结果。
- **链式流水（chain）** — 按选择顺序串行，**前一个 agent 的文本输出自动注入后一个的 prompt**（`core/orchestrate`）。

## 4. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agents` | agent 列表 + 安装/登录/通道状态 + models/defaultModel |
| GET | `/api/events` | SSE 全量事件流 |
| POST | `/api/run` | `{agent, prompt, cwd?, transport?, model?}` → `{runId}`（model 仅在 caps 含 model-select 的 agent 上生效） |
| POST | `/api/orchestrate` | `{plan:[{agent,prompt,model?,after?:[]}], cwd?}` |
| GET | `/api/runs` | 运行中/近期任务 |
| POST | `/api/login` | `{agent}` 调起该 agent 的登录流程 |

```bash
# 单发
curl -s localhost:7788/api/run -H 'content-type: application/json' \
  -d '{"agent":"trae","prompt":"列出当前目录结构","cwd":"D:/proj"}'

# 链式：Qoder 出方案 → Trae 落地 → WorkBuddy 复核
curl -s localhost:7788/api/orchestrate -H 'content-type: application/json' -d '{
  "plan":[
    {"agent":"qoder","prompt":"给出重构方案"},
    {"agent":"trae","prompt":"按方案改代码","after":[0]},
    {"agent":"workbuddy","prompt":"review 上述改动","after":[1]}
  ]}'
```

## 5. 统一事件模型

所有 adapter 输出都归一成同一种事件（`core/bus.mjs`）：

```
run_start · session · text · thinking · tool_call · tool_result
file_edit · permission · usage · log · done · error
```

前端只认这一层，新增 agent 不用改 UI。

## 6. 桌面应用专章：Alice / Loomy / Trae CN

这两个不是 CLI，是 **Electron 桌面应用**，接入方式完全不同：

### Loomy — 剥开外壳，直接对话 opencode 内核

**先说结论：走 ACP 轨不需要启动 Loomy 客户端。**

`D:\Program Files\Loomy` 只是 Electron 外壳；内核是独立的 `opencode`（本机 `C:\Users\Lenovo\AppData\Roaming\npm\opencode.exe`，`opencode2 v0.0.0-beta-17823`）。
两条轨道的区别：

| 轨道 | 命令 | 需要开客户端？ |
|---|---|---|
| **acp（默认）** | `opencode.exe acp` | ❌ 独立进程，直接可用 |
| http | 连客户端自己拉起的 `opencode serve --hostname=127.0.0.1 --port=<随机>` | ✅ 必须开着 Loomy |

ACP 实测（2026-11-17）：`initialize` 返回 `protocolVersion 1`，capabilities 含 `loadSession`、
`promptCapabilities{embeddedContext,image}`、`sessionCapabilities{close,delete,fork,list,resume}`；
`session/new` 得 `ses_xxx`；`prompt` 出 `agent_message_chunk` 增量，`stopReason: end_turn`。

**模型**：`session/new` 会返回 `configOptions`，里面 `id:"model"` 那一项带完整 `options`（88 个 `opencode/*` 模型），
切模型用标准 ACP 的 `session/set_config_option {sessionId, configId:'model', value}`。
**但本机 OpenCode Go 额度不够**——除默认的 `opencode/hy4-flash-free`（免费额度）外，切到任何 `opencode/<付费模型>` 都会回
`Internal error: Insufficient balance. This request is pay-as-you-go, billed to OpenCode Models credits`。
另外 ACP 的 model 选项里**不包含** `opencode.json` 里配置的 `imodel/*`（那些是外壳注入的 provider），传进去会
`Invalid params: model not found`。所以 registry 里只留 `opencode/hy4-flash-free`。

`opencode.json` 里的 `imodel/*`（`spark-x2.6`、`DeepSeek-V4.1-Flash`、`GLM-5.3-Flash` 等 7 个）只有 **http 轨**
（客户端拉起的内核）才认，且要开着客户端。

下面这条 http 轨是走客户端时的做法：

Loomy = Electron 外壳 + **opencode 内核**。外壳启动时会拉起：

```
opencode serve --hostname=127.0.0.1 --port=<随机>
```

所以**不需要 CDP、不需要点界面**，直接打 HTTP API 即可。端口每次随机，`core/loomy-http.mjs` 用三步发现：
1. 读提示位 `D:\workbuddy-hooks\loomy_armor\port.txt`
2. 按 `GET /config` 指纹（含 `agent.loomy-file`）验活
3. 兜底 `netstat -ano` 扫本机 127.0.0.1 监听端口

用到的端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config` | agent / model 配置（指纹用） |
| GET | `/config/providers` | provider 清单（本机：`opencode` / `imodel`） |
| POST | `/session?directory=…` | 建会话 |
| POST | `/session/:id/message` | 发消息 `{agent:'loomy-file', parts:[{type:'text',text}]}` |
| GET | `/event` | SSE 流 |

#### Loomy 双轨自动分派（按模型前缀）

两条轨认的模型是**互斥**的，所以 `core/runner.mjs` 的 `pickLoomyTrack(model)` 用模型前缀做硬判断，并在 `runAgent` 里短路（不走通用 `prefer` 链）：

| 模型前缀 | 走哪条轨 | 为什么 |
|---|---|---|
| `imodel/*` | **http**（需客户端开着） | `imodel` 是外壳注入的 provider，只存在于 opencode.json，ACP 的 `configOptions` 里根本没有 |
| `opencode/*` | **acp**（独立进程） | opencode 自身上游模型，只在 ACP 的 `session/new` → `configOptions[model].options` 里 |
| 不指定 | 客户端开着 → http / 没开 → acp | 兜底 |

失败会互相回退：http 挂了且有 `canAcp` 就转 ACP；ACP 挂了且有 `canHttp` 就转 http。日志里能看到 `loomy 轨：http（imodel/* 只有 http 轨认）`。

**额度差异**（本机实测）：`imodel/*` 走讯飞侧额度、7 个里 6 个能跑；`opencode/*` 走 OpenCode Go，**只有 `opencode/hy4-flash-free` 免费额度够**，其他全报 `Insufficient balance`。

**模型传参格式坑**：opencode 的 http 轨要 `{providerID, modelID}` **对象**，ACP 轨要 `session/set_config_option {configId:'model', value:'provider/model'}` **字符串** —— 两种写法不能混。

**重复吐字坑（已修）**：`finally` 里不能立刻 `stop()` 掉 SSE，否则增量还在路上时 `stats.text` 仍为 0，会把同步返回的全文再补一遍 → 界面显示「在线在线」。必须先 `await 800ms` 再判 `stats.text`。

**踩坑（已修）**：增量事件是 `message.part.delta`，只带 `partID` 和 `delta`，**不带 part 类型**。必须先用 `message.part.updated` 建 `partID → type` 映射，否则**思维链（reasoning）会混进正文**。映射后正文吐 `text` 事件、思维链吐 `thinking` 事件。

```bash
node tools/probe-local.mjs loomy "数到五"
```

### Alice — window.alice 有 900 个方法，但没有「发送」这个

Alice 的渲染进程 API 挂在 **`window.alice`**（899 个方法，不是 `window.api`），可是**发送消息不走 IPC** —— 必须模拟真人。

已验证链路（`core/alice-cdp.mjs`）：

1. **CDP 端口得自己开，工作台不代劳**：`"D:\Program Files\Alice\Alice.exe" --remote-debugging-port=9333`（`%APPDATA%\Alice\DevToolsActivePort` 是旧值，别信）。`ensureAlice()` 只做检查：没就绪就抛错并打印该敲的命令，不会替你启动进程 —— 自动拉起会让窗口突然抢焦点，收益是负的。
2. 点 `button[aria-label="新话题"]` 隔离上下文（**默认开启**，避免污染已有对话）。
3. 用 `HTMLTextAreaElement.prototype` 的 **native setter** 写值 + `dispatchEvent(new Event('input'))` —— React 受控组件只认这条路。
4. **`Input.dispatchKeyEvent` 派发真实 Enter**（合成 `KeyboardEvent` 完全无效）。且**必须先 focus()**，否则按键事件落不到 textarea。
5. 抓回复用 `.message-enter.justify-start .text-alice-text`。**别用外层容器** —— 内层 `innerText` 是干净正文，外层会混进「复制/翻译/点赞/举报/下载/回复建议/34,777/99%」这些工具栏文本。
6. 文本连续 `idleMs`（默认 2.5s）不变即判定完成，`timeoutMs` 默认 240s。

```bash
node tools/probe-local.mjs alice "只回复一个词：在线"
```

> 两家都**不需要登录**（桌面客户端早就登好了），所以 `auth` 显示 `n/a`，`live` 才是它们真正的在线状态。

### Trae CN — 客户端凭据桥（用客户端的积分和模型）

官方 `traex.exe` 已删、`Trae CN.exe` 的 `cli.js` 里 **没有 ACP 也没有 stream-json**（`grep acp` 命中 0）。所以走的不是命令行，而是**把客户端的登录凭据解开**：

- 登录态落在 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 键 `iCubeAuthInfo://icube.cloudide`（base64）。**不在任何 `state.vscdb` 里**。
- 密文格式：`"tc"` + `[5,16,0,0]` 头 → 32B seed → AES-128-CBC 密文；明文前 64 字节是正文的 SHA-512 校验和。
- 密钥派生（`main.js` 的 `Che`）：`SHA512(seed)` 与一张 64 字节补丁连接后**再** `SHA512`，取 `[0:16]` 作 aesKey、`[16:32]` 作 iv。补丁 = `S盒表 ^ 掩码`（非私有模式用 `XHE^MHE`，`raw[2]===32` 时用 `PHE^RHE`）。
- 解出来的 `token`（1004 字符 JWT）直接当 `Authorization: Cloud-IDE-JWT <token>` 用。**注意**：`.trae-cn\rae-jwt-token` 是另一份 IDE JWT，拿它打同一接口会 401 `code 1001`。

打通的两个接口：

| 用途 | 请求 | 返回 |
|---|---|---|
| 积分余额 | `POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`，body `{"require_usage":true,"req_source":2}` | `total_balance` / `usage_summary` / `user_entitlement_pack_list` |
| 客户端模型 | 读 `state.vscdb` 键 `1141714038826508_AI.agent.model.model_list_map` | 按 scene 分组，拍平去重后 30 个 |

相关文件：`core/trae-cn.mjs`（生产用，`node:crypto`）、`tools/trae-cn-auth.py`（手写 AES 参考实现，已过 NIST SP800-38A 向量）。

```bash
node core/trae-cn.mjs status    # {"up":true,"userId":"...","credits":3600,...}
node core/trae-cn.mjs userinfo  # 解密出的完整 userInfo
node core/trae-cn.mjs token     # 只打印 token
```

> 对话本身走的是**渲染进程 CDP 轨**，见下面 §6.1。

### 6.1 Trae CN — 对话执行（CDP 驱动 Solo 工作台）

> **启动方式**：工作台**不自动拉起** Trae CN —— 从后台 shell 启动 GUI 一律 `HasExited=True / ExitCode=9`（非交互 shell 拿不到桌面会话）。没就绪时 `ensureTraeCdp()` 直接抛错并给出 `D:\Programs\Trae CN\start-debug.bat` 的完整路径，由你自己双击。

客户端的 `chat` 走 **AhaIpc**（server `"ai-agent"`，`request_stream`）到 Rust 子进程 `harness.dll`。
`ahaIpc` 是字节定制 Electron fork 的**原生导出**（`import { ahaProcess, ahaIpc } from "electron"`），Node 侧复现不了，HTTP 端点全 404 —— 所以唯一可行入口是 **CDP 接管渲染进程**。

前提：Trae CN 必须带调试端口启动。**从非交互 shell 用 `Start-Process` 拉 GUI 会 exit code 9**（拿不到桌面会话），必须双击：

```
D:\Programs\Trae CN\start-debug.bat
```

（内容：`cd /d "D:\Programs\Trae CN"` + `start "" "Trae CN.exe" --remote-debugging-port=9334`，CRLF 行尾。）

CDP 目标不是 VSCode 编辑器，而是 **Solo 工作台**：`solo-lite.html`，标题 `Agent`。

已验证的发送链路（`core/trae-cdp.mjs`）：

| 步骤 | 做法 | 坑 |
|---|---|---|
| 找输入框 | `.chat-input-v2-input-box-editable` | 是 **contenteditable DIV**，不是 textarea |
| 填内容 | `Input.dispatchMouseEvent` 单击 → `Input.insertText` | **绝对不能用 `innerHTML` 硬改**：React 受控组件会把内容洗掉，`innerText` 读回是空串 |
| 发送 | `button.chat-input-v2-send-button` `.click()` | 空内容时带 `disabled`；解禁后点击即可 |
| 读回复 | `.markdown-renderer`（取最后一个） | 别用 `[class*=message]`，会把工具栏/模型名一起抓进来 |

实测：`trae "只回复两个字：在线"` → `在线`，7.4s；HTTP `/api/run` 同样通。

`/api/agents` 里 trae 的 `live` 同时给两样东西：`credits`（积分桥）和 `cdp`（CDP 可用性）。积分会随对话实时下降（实测 3600 → 3597.65）。


### 6.2 豆包 — 没有 CLI / ACP / HTTP，只有 CDP

豆包是七家里最封闭的一个：**没有 CLI、没有 ACP、没有 stream-json、不监听任何本地业务端口**。
`D:\Program Files\DoubaoWork\app\` 下只有 Chromium 外壳（`manifest.json` version 2.32.14，
Chrome 147），`entry-moa/main.js`（2.5 MB）里能捞到 291 个 `/samantha/*` 外围端点，
但真正的对话 SSE 入口在加密的 `biz.pak` 里。

所以只有一条路：**开调试端口 + 驱动 DOM**。

#### 启动（工作台不代劳，和 Alice / Trae 一样）

```
"D:\Program Files\DoubaoWork\DoubaoWork.exe" --remote-debugging-port=9335
```

不带这个参数就没有 9335 端口，`/api/agents` 里豆包显示「CDP 未开」。

#### 四步发送链路

| 步骤 | 做法 | 坑 |
|---|---|---|
| 找页面 | `/json/list` 里 `type=page` 且 url 匹配 `doubaowork-chat/chat` | 另有 `doubaowork-background`、`cross-site-support`、一个 drive iframe，都不是对话页 |
| 填内容 | `Input.dispatchMouseEvent` 点击 `.tiptap.ProseMirror` 聚焦 + `Input.insertText` | ProseMirror，DOM 改值/合成事件会被 transaction 洗掉 |
| 发送 | **真实 Enter**：`rawKeyDown` + `char` + `keyUp`，vk 13 | **`.send-btn-wrapper` 的 `.click()` 完全无效**，React 合成事件收不到 |
| 读回复 | **`.receiveMessage-*` 消息节点**（回退 `[class*="md-box-root"]` + 排除 `justify-end`） | 见下面第 1 条 |
| 开新话题 | **点侧栏「新工作任务」**（首选）→ Ctrl+N（兜底） | 见下面第 3 条：Ctrl+N 会落到 workbench 页 |

#### 五个已经踩过的坑

1. **判气泡方向别靠 `justify-end`，靠消息节点 class**。实测 DOM 里每条消息本身带方向性 class，
   哈希后缀会随构建变化，所以用前缀匹配：
   ```
   助手消息  .receiveMessage-WfTEmI      （容器 flex flex-row w-full ...）
   用户消息  .sendMessage-UztjyE         （容器 flex flex-row w-full justify-end ...）
   正文      —— 两者都套一层 container-* md-box-root
   ```
   早前用「从 `md-box-root` 里排除祖先含 `justify-end` 的」也能跑，但**会把重复出现的
   助手镜像节点漏算**，表现为气泡数一直是 0、轮询永远等不到。现在优先数
   `.receiveMessage-*`，读正文时取最后一个的 `md-box-root` 子节点。

2. **基线不能用文本，也不能写死 0**。上一轮答「在线」这一轮也答「在线」→ `cur === baseline` 跳过。
   改用**助手气泡个数**判增长；但即使 `newTopic` 为 true，也可能**没找到新建按钮、沿用当前会话**，
   所以基线一律取「发送前」的真实计数：
   `let baseCount = await countAssistant()`；开了新对话再多等 800ms 并取两次的较小值。

3. **Ctrl+N 不等于「新对话」，会落到 workbench 落地页**。这是最贵的一个坑：
   当当前会话是「工作台」形态时按 Ctrl+N（豆包自己标称的「新工作任务」快捷键），页面会跳到
   `chrome://doubaowork-chat/chat/workbench` —— 那是工作台 landing（「22 款智能工作台」推荐卡片
   \+ 今日签到 + 历史草稿），**整页一个输入框都没有**：

   ```
   url = chrome://doubaowork-chat/chat/workbench
   hasTiptap = false   tiptapCount = 0
   editables = []      ← 没有任何 textarea / contenteditable
   ```

   而旧的 `newChat()` 判据是「助手气泡数 === 0」。workbench 上空气泡天然为 0，于是**误判成
   「已开新对话」**，接着注入 6 次全部读到 `""`，最终报
   `文本注入失败（6 次重试后输入框读到：""）`。

   修法（`core/doubao-cdp.mjs`
    - `core/scnet-cdp.mjs` 的 `newChat()`）：
   - **判据换成三合一**：输入框存在 **且** URL 不含 `/chat/workbench` **且** 助手气泡数为 0。
   - **首选动作换成点侧栏导航项**「新工作任务」（`div`/`a`，class 含 `sidebar_nav_item`，
     `innerText` 以「新工作任务」开头），用真实鼠标事件点它的中心坐标。
     实测在 workbench 页点一下就会跳回 `chrome://doubaowork-chat/chat` 且 `hasTiptap = true`。
   - Ctrl+N 降为兜底；点任意「新建」按钮留作最后手段（它多半会弹「创建项目」对话框）。
   - `dismissOverlays()` 同时检查「activeElement 是否带 fixed/z-50」和「DOM 里是否还有
     `[role="dialog"]`」，先点浮层里的关闭按钮、再按 ESC，注入循环每轮都先清一次场；
   - 注入前校验 `document.activeElement.className` 含 `ProseMirror`，不满足就重试（最多 6 轮）。

5. **正文开头会先铺一行状态文案**（`正在调度资源` / `正在思考` / `搜索中`）。
   它是气泡里的真内容，所以按气泡差分时会先被当成答案吐出来，随后 `idleMs` 到点就收工，
   结果只拿到「正在调度资源」。`isPendingOnly()` 逐行匹配 `PENDING_RE`
   （`^(正在[\u4e00-\u9fa5]{0,8}|深度思考中|搜索中|思考中|生成中)[.。…\s]*$`），
   整段全是状态文案就 `continue` 继续等，不进差分。

4. **正文尾部会混进操作栏**（复制/点赞/免费/「今天 16:11」）。
   `stripTailNoise()` 在差分前统一清掉，否则 SSE 会把时间戳也当正文吐出来。

#### 结果

`runDoubao` 返回 `{ ok: true, code: 0, text, ms, transport: 'cdp' }`，
走 `withCdpLock` 与 Alice / Trae 共享同一个 CDP 串行锁。

实测：
- `POST /api/run {"agent":"doubao","prompt":"只回复两个字：测试"}` → `done`，17589 ms，正文「测试」
  （走「点侧栏新工作任务 → insertText → 真实 Enter → 跳过状态文案 → 差分读全文」）。
- `POST /api/run {"agent":"doubao","prompt":"你是谁，能做什么？用三点说明"}` → `done`，23651 ms，
  320 字完整三点回答（Ctrl+N 开新话题 → insertText → 真实 Enter → 按气泡差分读全文）。



### 6.3 SCNet（曙光「计算服务」）— 一个开关毁掉所有 Chromium 参数

**启动命令（必须先清 `ELECTRON_RUN_AS_NODE`）**：

```powershell
Get-Process | Where-Object { $_.ProcessName -match '计算' } | Stop-Process -Force
cmd /c 'set ELECTRON_RUN_AS_NODE=&& start "" "D:\Program Files\scnet-client\计算服务.exe" --remote-debugging-port=9336'
```

| 传参方式 | 结果 |
|---|---|
| `计算服务.exe --remote-debugging-port=9336` | ❌ `bad option: --remote-debugging-port=9336`（来自 `third_party/electron_node/src/node.cc:839`） |
| `计算服务.exe -- --remote-debugging-port=9336` | ❌ `Error: Cannot find module '--remote-debugging-port=9336'` |
| 无 flag 直启 | ❌ 静默 exit 0（`requestSingleInstanceLock` 失败） |
| **`set ELECTRON_RUN_AS_NODE=&& start "" exe --remote-debugging-port=9336`** | ✅ `Chrome/152.0.7977.130` + CDP 生效 |

根因：环境里残留 `ELECTRON_RUN_AS_NODE`（`scnet.cmd` 自己就会设它来跑 `cli/index.js`），一旦继承进子进程，Electron 把 argv 全部交给 Node 解析，所有 Chromium switch 失效。

**可编程面全貌**：

- `window.host = { context, getPathForFile, invoke(operation, input), on(event, cb) }`，走 IPC `sacp:host:invoke` / `sacp:host:event`。
- host operation 注册表 **schema 141 条 / 实现 128 条**，含 `cloud-chat.send/stop/runs/list/history`、`scnet.read`、`cluster-files.read/save`、`browser.agent-register`、`auth.*`、`developer.copy-scnet-token`。
- **奖励**：`cloud-chat.list` 直接可用 → `{scopeKey:"0b26ae…", page:1, hasMore:false, records:[]}`；`cloud-chat.send` 需要 `{scopeKey, requestId, protocol:"v1"|"v2", text, ...}`。
- **陷阱**：`agent.sessions` / `agent.prompt` / `agent.session.send` / `agent.turn` 等 13 个猜测名全部 `Unknown host operation` —— **agent 对话不在 host ops 里**，走渲染进程 IPC `agent:*` 通道族。
- CLI（`resources/cli/index.js`）只暴露 6 个只读 RPC：`cli.status` / `cli.doctor` / `cli.logs.tail` / `cli.task.inspect` / `cli.task.diagnose` / `cli.diagnostics.export`，**没有 prompt/session 入口**。
- 不开任何本地 HTTP 端口，只有命名管道 `\\.\pipe\scnet-client-cli-<sha256(userData)[:20]>`。

**对话执行链（`core/scnet-cdp.mjs`，实测 8.4s / 16.4s 两次全通）**：

1. 定位输入框 `.tiptap.ProseMirror.agent-chat-composer__editor`（tiptap，DOM 改值无效）
2. 真实鼠标点击聚焦 → 校验 `document.activeElement` 命中 ProseMirror
3. `Ctrl+A` + `Backspace` 清空 → `Input.insertText` 注入 → 回读校验
4. **真实 Enter**（`rawKeyDown` vk13 + `char` `\r` + `keyUp`）发送
5. 轮询 `.chat-message--response` 数量 + `.chat-block-markdown` 正文，稳定 3.5s 收工

**三个坑**：

1. `.chat-message--response` 的 `innerText` 带尾巴 `"10:06 SCNet-Max 13.3k toks"`，正文必须取内层 `.chat-block-markdown`。
2. 页面是 SPA，`body.innerText` 会因侧栏「最近」列表更新而变化，**必须按消息节点计数**判增量。
3. 开新任务的真入口是 `.sidebar-new-task` 内部的 `button.sidebar-nav-button`（div @124,94）；`Ctrl+N` 在部分页面会切到工作台 landing，兜底可用但判据必须是「输入框存在 且 助手消息数 === 0」。

**模型**：`SCNet-Max`（provider `scnet`），thinking level `high`，配置在 `C:\Users\Lenovo\.sclaw\agent\settings.json`。

### 6.4 模型选择 — 两个 GUI agent 的下拉都是「假 DOM」

工作台的下拉（`#modelbar`）只渲染注册表里 `models` 非空的 agent。Alice / 豆包最初 `models: null`，
而它们的模型清单只能在客户端里问出来，所以两者都在**运行时拉取**：

- `aliceModels(port)` —— `window.alice.fetchMiyangModelCatalog()` 给 21 个；
- `doubaoModels(port)` —— 真实点开输入框右下角药丸，读弹层文本给 10 个。

`server.mjs` 的 `/api/agents` 在 live 探测之后调用它们，覆盖注册表里的兜底子集。

#### Alice：目录 21 个，但只有 12 个能用

目录里不含「区域是否可用」。**必须点开模型菜单**，读 `.model-menu__row` 的
`is-region-restricted` 类。2026-11-18 实测 9 个受限（点了不生效、菜单也不关）：

| 受限（GPT / Claude / Gemini 全系） | 可用（12） |
|---|---|
| GPT-6 Astra / GPT-6.1 Sol / GPT-6 Sol / GPT-5.6 Sol / GPT-6 Luna | swift 迅捷 / auto 自动 / standard 标准 |
| Claude Opus 5.5 / Claude Sonnet 5.5 | qwen4-max / qwen3-8-max / qwen3-8-flash（bailian） |
| Gemini 4 Argon / Gemini 3.8 Flash | glm-5-3 / glm-5-3-flash / kimi-k3-bailian / grok-4-7 |
|  | deepseek-v4.1-flash-1017 / deepseek-v4.1-flash-expires-on-0910 |

三个坑：

1. **菜单开合是交替的**。第一次探测结束时菜单若还开着，下次点药丸是「关」，
   `querySelector('.model-menu__list')` 拿不到 → 过滤静默失效（表现为时好时坏：
   一次 12 项、一次 21 项）。修法：探测前先按两次 ESC 归零，并在点击后校验拿到列表，拿不到就再点一次。
2. **模板字符串/`String.raw` 的多层转义会把正则吃掉**（`\w` → `\w` → `w`，
   pill 正则直接匹配不到药丸，返回 `'[]'`，过滤全失效且不报错）。修法：正则改用
   `new RegExp('...')` 构造，只走一层转义。
3. **`.model-menu__list` 是内部滚动容器**，`scrollIntoView` 不生效，必须直接设 `scrollTop`。

#### 豆包：药丸在右下角，行只能点外层

药丸是 `div.flex.shrink-0`（181×36，文本 `DeepSeek V4.1 Flash 高`）。定位器要同时满足
「右下角（`y > vh*0.6 && x > vw*0.5`）+ 宽 80\~260 高 18\~45 + 文本含模型字** + 排除「工作任务」**，
否则会命中侧栏的「新工作任务 Ctrl N」。选项行是 `div.h-38.w-full`（292×38），
**点内部 SPAN 无效，必须 `Input.dispatchMouseEvent` 到行中心**。

#### 前端：每个选中的 agent 各一行下拉

原来的 `renderModel()` 只在**恰好选中一个** agent 时渲染（`currentAgent()` 在 `ids.length > 1` 时返回 `null`），
所以并行分发和链式流水里只有第一个 agent 能选模型，后面全是各自默认值。

现在 `#modelbar` 里放的是 `#models` 容器，按 `[...selected]` 逐 agent 渲染一组
`<b>标签</b><select data-model-for="agentId">`，`onchange` 只写 `modelOf.set(该 id, 值)`，
互不干扰。没有模型的 agent（纯 GUI 轨）渲染「无模型可选（客户端自管）」而不是把整条栏隐藏。

`modelFor()` 的退化链也修了：

```js
const want = modelOf.get(agentId)
return list.includes(want) ? want
     : (a.defaultModel && list.includes(a.defaultModel) ? a.defaultModel : list[0])
```

之前是 `a.defaultModel || list[0]`，一旦 `defaultModel` 不在 `models` 列表里（比如 Alice 兜底写的是
`'auto'` 而运行时列表是 12 项 id）就会静默落到 `list[0]`，进一步退到「列表最后一项」的观感
（实测 Alice 在链式第 2 位被喂成 `deepseek/deepseek-v4.1-flash-1017`）。

`dispatch()` 也改成**先算好每个 agent 的模型再打日志、再派发**，三处（single/fanout/chain）
日志里打印的模型和真正发出去的 `model` 是同一份快照，不会再出现「日志说 A，请求发 B」。

验证（链式流水，三家各选不同模型）：

| runId | agent | model | 正文 |
|---|---|---|---|
| `alice-mwlk49lo-9` | alice | `glm-5-3-flash` | 「一号」 |
| `doubao-mwlk4pp4-10` | doubao | `GLM 5.3` | 「二号」 |
| `scnet-mwlk523vk-11` | scnet | `SCNet-Max` | 「三号」 |

#### 切换后必须轮询校验

界面刷新有延迟，切完立刻读药丸一定是旧值。`aliceSetModel` / `doubaoSetModel` 都轮询 8×500ms。

#### 顺带修掉的一个真 bug：Alice 会把「占位话术」当答案

`.message-enter.justify-start` 这个外层气泡的 `innerText` 混着
`已思考 16s / 让我琢磨一下… / 复制 翻译 点赞 举报 / 32,956 / 286 / 0%`。
而 `readAssistant` 原来的写法是「`.text-alice-text` 找不到就退回外层气泡」——
正文还没生成时内层根本不存在，于是读到 `让我琢磨一下…`，`idleMs` 一到就收工，
对外表现为 **Alice 回答「让我琢磨一下…」/「在想，快了…」/「稍等片刻…」**。

修法（两处）：

```js
// 1) 只读内层；内层不存在就记空串，绝不退回外层
texts: outer.slice(-4).map((o)=>{
  const i = o.querySelector('.text-alice-text')
  return i ? (i.innerText || '').trim() : ''
})
// 2) 占位文案不推进 stableSince，idleMs 默认从 2500 提到 6000
if (isPlaceholder(cur)) continue   // 一直等到 timeoutMs
```

验证（全部 `POST /api/run`，带 `model`）：

| 派发 | model 回显 | 耗时 | 正文 |
|---|---|---|---|
| alice + `glm-5-3-flash` | `glm-5-3-flash` | 42650 ms | 「模型」 |
| alice + `kimi-k3-bailian` | `kimi-k3-bailian` | 30430 ms | 「我是 Kimi，由月之暗面开发。」 |
| alice 不指定 | `auto` | 22301 ms | 「默认」 |
| doubao + `GLM 5.3 Flash` | `GLM 5.3 Flash` | 24379 ms | 「模型」 |
| doubao + `Kimi K3` | `Kimi K3` | 34440 ms | 「我是 Kimi，由月之暗面（Moonshot AI）开发。」 |
| doubao 不指定 | `自动` | 20280 ms | 「默认」 |

切换是否真的生效不能只看 `model` 回显（那是我们自己记的），要看模型自报家门 ——
所以上表里用「你是什么模型」这个问题做的对照。

### 6.5 链式流水：每一棒必须知道自己是第几棒

派发方原样把同一个 `prompt` 发给链上每个 agent，只在末尾追加 `### 来自 X 的输出`。
如果用户的任务里写了「**你是第一个agent，只做任务1**」（典型的多步接力指令），
那么第 2、3 位读到的仍然是同一句原文 —— 它们据此推断「任务1 已有人做，我不该越界」，
于是**空转**。实测三家跑同一条三步任务：

| 位置 | agent | 实际行为 |
|---|---|---|
| 1 | SCNet | ✅ 做任务1，写交接说明 |
| 2 | Loomy | ❌ 看到「你是第一个，只做任务1」+ 上游说任务1已完成 → 只做任务1，报「我不越界」 |
| 3 | MiniMax | ⚠️ 自己推理「我是第 2 个」→ 做了任务 2，任务 3（改名）没人做 |

修复在 `server.mjs` 的 `orchestrate()`：有上游依赖时，prompt 追加位置声明：

```
【你在链路中的位置】第 2 位（共 3 位）
- 上游 scnet 已完成它那一步；你只做属于你的那一步，不要重做上游的事。

### 来自 scnet 的输出
...
```

`core/runner.mjs` 的 `ROLE_PREFIX` 同步补一条：任务分步且标了位置时，只做自己那一步。

修复后端到端复测（`D:\project\agent-hub-test2`，同一句三步任务）：

| 位置 | agent | 结果 |
|---|---|---|
| 1 | SCNet-Max | 「任务1完成。1.txt 已创建，0 字节」 |
| 2 | Loomy | 「任务2完成。已写入 1 行内容…我未执行任务3，未重做任务1」 |
| 3 | MiniMax | 「任务3完成。`Rename-Item` → 2.txt，仅剩 2.txt（139 字节）」 |

最终目录只剩 `2.txt`，139 字节，内容为 Loomy 写的那句自我介绍。

### 6.6 链式流水：把用户的分步清单「指派」下去，而不是让它自己读

6.5 的修法只是追加了一句「你只做属于你的那一步」，但**用户原文里的分步清单依然整段传下去**。
如果清单本身带身份声明（典型的「1. xxx（你是第一个 agent，只做任务 1）／2. yyy／3. zzz」），
第 2、3 位会把它当成约束读：要么空转，要么一口气把后面几步全做了。

实测（3 家，同一句带身份声明的三步任务，按 SCNet → MiniMax → Loomy 排列）：

| 位置 | agent | 行为 |
|---|---|---|
| 1 | SCNet | ✅ 只做任务 1 |
| 2 | MiniMax | ❌ **把任务 2 和任务 3 一起做了**（写入 + 改名），并声明「我负责的三步中的后两步」 |
| 3 | Loomy | ⚠️ 检测到三步已全部完成，只做只读核验，什么都没做 |

修复在 `server.mjs` 的 `orchestrate()`，两个新函数：

**`parseSteps(text)`** —— 从 `plan[0].prompt` 里拆出有序步骤，只认行首编号
（`1.` / `1、` / `1)` / `1）` / `第1步` / `步骤1`），且必须 1,2,3… 递增，少于 2 步不算清单：

```js
const re = /^\s*(?:第\s*(\d+)\s*步|步骤\s*(\d+)|(\d+)\s*[.、)）:：])\s*(.+)$/
```

实测：`1.xxx\n2.yyy\n3.zzz` → 3 步；`1、…2、…` → 3 步；`第1步…第2步…` → 3 步；
无编号 → `[]`；只有一步 → `[]`。

**`assignPrompt(original, index, total, step, agents)`** —— 用编排层的权威指派替换掉整段分步清单，
用户原话降级为「仅作背景」：

```
【编排指派 · 以此为准】
你是本链路的第 2 位（共 3 位）：minimax。
你**只做一步**，就是下面这一步：

第 2 步：在1.txt文件写入一句话介绍自己

规则：
- 不要做前面步骤的事（上游已完成），也不要做后面步骤的事（下游会做）。
- 用户原文里如果有「你是第一个 agent，只做任务 1」这类句子，那是写给第 1 位的，对你不适用。
- 完成后用一句话说明「第 N 步已完成」并交代下游该做什么，就结束。

【用户原始任务（仅作背景，勿据此越权）】
...
```

只有当 `steps.length >= 2 && plan.length > 1` 时才启用（单步任务、无编号任务不受影响）。

修复后同一句任务复测（`D:\project\agent-hub-test3`）：

| 位置 | agent | 结果 |
|---|---|---|
| 1 | SCNet-Max | 「第 1 步已完成：新建空文件 1.txt，0 字节…下游第 2 步应写入自我介绍」 |
| 2 | MiniMax | 「第 2 步已完成：已写入 170 字节…下游第 3 步把 1.txt 重命名为 2.txt」 |
| 3 | Loomy | 「第 3 步已完成：已重命名为 2.txt（170 字节，目录内已无 1.txt）」 |

最终目录只剩 `2.txt`，170 字节。

### 6.7 Loomy 的「思考链很长」其实是工具事件被重复推送

日志里 Loomy 那一栏刷出两百多条 `⚙ bash {}` / `⚙ read {}`，看起来像模型在反复试错，
实际是 **opencode 对同一个 tool part 反复推 `message.part.updated`**。

直连 SSE 实测（一次 bash 调用）：

| 事件类型 | 次数 |
|---|---|
| `message.part.delta` | 154 |
| `message.part.updated` | 113 |
| 其中 `part.type === 'tool'` | **113，且 `part.id` 始终是同一个 `prt_1ed3e1a68001rVbPedivZthHD0`** |
| 唯一 tool part 数 | **1** |

`state.status` 只在 `pending → running → completed` 之间变，`part.id` 不变。
`core/loomy-http.mjs:157` 原来对每个 `updated` 都 `emit.toolCall(...)`，界面就渲染成 113 行空白 `⚙ bash {}`。

修复：按 `part.id + state.status` 去重，并用 `tool_result` 报状态推进：

```js
const toolSeen = new Set()  // `${id}:${status}` 已报过
const toolIds = new Set()   // 已报过 tool_call 的 part.id
...
const key = `${id}:${status}`
if (toolSeen.has(key)) continue
toolSeen.add(key)
if (!toolIds.has(id)) {
  toolIds.add(id)
  emit.toolCall(p.part.tool || 'tool', st.input ?? p.part.input, id)
} else if (status === 'completed' || status === 'error') {
  const out = st.output ?? st.error ?? ''
  emit.toolResult(p.part.tool || 'tool', typeof out === 'string' ? out : JSON.stringify(out), id)
}
```

顺带修了界面：`tool_call` 用新的 `fmtToolInput()` 优先取 `command` / `filePath` / `path` / `pattern`，
不再把整个 `{}` 打印出来；`tool_result` 显示工具名 + 输出，空输出显示「（无输出）」。

修复后同一任务：`tool_call: 3 → tool_result: 3`（原 200+），且能看到真实结果，
例如 `✓ bash Rename-Item : 无法重命名，因为"…1.txt"处不存在项`。

**注意 `thinking` 事件量大是正常的**：推理是逐 token 增量推送的
（实测一个多步任务里 2 个 reasoning part 分别推了 46 和 24 个 delta）。
这和工具事件重复不是一回事，界面按 part 累积到同一个气泡即可。

## 7. 已知问题

1. **MiniMax `mcode` 在系统 Node 24 下 exit 134 —— 已修**。根因是 ABI 不匹配：`better_sqlite3.node` 按 **NODE_MODULE_VERSION 146**（Electron 35 / Node 24.19）编译，系统 `D:\nodejs\node.exe` 是 **v24.20.0 / ABI 137**。装载失败被 mcode 的退出路径吞掉，只剩裸断言：
   ```
   #  minimax-code[...]: node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr
   1: node::MultiIsolatePlatform::DisposeIsolate
   ```
   解法（`core/mm-runtime.mjs`）：拿桌面版 `D:\Program Files\MiniMax Code\MiniMax Code.exe` 当 Node 宿主，`ELECTRON_RUN_AS_NODE=1`（内嵌 Node 24.19.0 / ABI 146），并把 `MAVIS_SQLITE3_MODULE_PATH` 指向它自带的 ABI 匹配 better-sqlite3（首次调用会复制到 `core/mm-runtime/node_modules/better-sqlite3`，并从 npm 版补 `bindings`、`file-uri-to-path`）。registry 里 `runtime:'electron'`，`spawn.mjs` 的 electron 分支走 `mmSpawnSpec`。
   **踩坑**：electron 分支只接受「一份完整参数表」。ACP 轨 `spawnTransport(t, [])` 传空 → 取 `t.args`；CLI 轨连 `t.args` 一起算好再传 → 用 `extraArgs`。早期写成 `[...t.args, ...extraArgs]` 会重复拼成 `exec --prompt-mode coding exec --prompt-mode coding`，mcode 报 `too many arguments for 'exec'. Expected 1 argument but got 2.`
   **模型清单只有两个是真的**：本机走 `token_plan`（`minimax_oauth` active），官方目录只放出 `minimax/MiniMax-M3` 和 `minimax/MiniMax-M3.1-Flash`。其他 id（`MiniMax-M2.x`、`MiniMax-M1`、小写 `minimax-m3`）传进去 mcode **不报错而是静默回退**到 M3.1-Flash（实测 `--model minimax/minimax-m2.5` 的 `turn.completed` 里 `modelId` 是 `MiniMax-M3.1-Flash`）。所以 registry 里只留这两个。
2. **被派发的 agent 反向指挥工作台 —— 已防**。MiniMax 曾在 cwd 就是 `agent-hub/` 自己目录的情况下，发现旁边跑着 7788 端口的 hub，于是：读 `core/registry.mjs` → `GET /api/agents` → `POST /api/run` 把 trae/qoder/workbuddy 逐个又派发了一遍，还自己给 Alice 带上 `--remote-debugging-port=9333` 拉起来，并写了一份 `agent-roster.md`。三层防护：
   - **环境隔离**（`core/spawn.mjs` 的 `isolationEnv`）：所有子进程都带 `AGENT_HUB_WORKER=1` / `AGENT_HUB_NO_FANOUT=1` / `AGENT_HUB_RUN_ID` / `AGENT_HUB_AGENT`。
   - **服务端闸门**（`server.mjs` 的 `fanoutGate`）：已有根任务在跑且 UA 像 agent（curl/node/python/axios/undici/wget）时，`/api/run` 直接 `409 fanout blocked`；run 记 `parentRunId` 与 `depth`，`MAX_DEPTH=2`。确需嵌套加 header `x-agent-hub-allow-fanout: 1`。
   - **角色限定**（`core/runner.mjs` 的 `ROLE_PREFIX`）：`runAgent` 入口给所有轨统一拼上「你是子任务执行者，禁止调用 7788 接口、禁止派发其他 agent、不要读取 agent-hub 源码」。`opts.rawPrompt = true` 可跳过。

3. **WorkBuddy 不带 `--model` 必 400 —— 已修**。两个叠加错误：
   - 它的内置默认模型是 `openrouter/deepseek/deepseek-v4.1-flash-1017`，账号里没有 → `400 model [...] service info not found`。
   - `wbDefaultModel()` 曾返回 `'default'`，这个 id 能 exit 0 但**正文全空**。现在改回 `'auto'`。
   - `executeRun()` 里补了兜底：调用方没给 `model` 就强制落到该 agent 的 `defaultModel`，
     不会再让 CLI 甄它自己的内置默认。

4. **批量派发时模型一个名字套给所有 agent —— 已修**。页面上下拉框只在「只选中一个」时存在，
   并行/链式时 `curModel()` 返回 `undefined`，下游 agent 就能拿到上游的模型名。现在前端用
   `modelOf: Map<agentId, model>` 逐个记忆、`modelFor(agentId)` 逐个取值，`/api/orchestrate` 也会给每项 plan 补 `defaultModel`。

5. **WorkBuddy 点「登录」没反应 —— 已修**。`codebuddy login` 这个子命令**根本不存在**：传它只会打印
   `Authentication required. Please use /login command to sign in to your account` 然后 exit 0，什么也不做。
   真正的可编程入口是 **SDK 控制协议**（`core/workbuddy.mjs`）：用
   `-p --input-format stream-json --output-format stream-json` 起子进程，往 stdin 写一帧
   ```json
   {"type":"control_request","request_id":"wb_auth_1",
    "request":{"subtype":"authenticate","methodId":"external","environment":"external"}}
   ```
   CLI 回 `auth_url_callback`（`authState.authUrl` = `https://www.workbuddy.cn/login?platform=workbuddy&state=<uuid>`），
   浏览器扫码后 CLI 自己轮询 `GET /v2/plugin/auth/token?state=<uuid>`（pending 时 code `11217`），成功回
   `auth_result_callback`（`userinfo.userId/userName/token`）。工作台把 authUrl 用 `cmd /c start ""` 打开，并在 6s/15s/40s/90s
   各刷一次 `/api/agents?fresh=1`。
   **必须挂桌面版 product.json**：`ACC_PRODUCT_CONFIG_PATH=D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\product.json`。
   npm 包自带的那份指向 `codebuddy.ai` + `Tencent-Cloud.coding-copilot`（`cli-external-link`），桌面版才指向
   `www.workbuddy.cn` + `workbuddy-desktop`（`account-scoped-external-link`）。registry 里 transport 带 `productConfig`，
   `spawn.mjs` 的 `productEnv()` 自动注入。
   **不带 `--model` 必 400**：默认模型是 `openrouter/deepseek/deepseek-v4.1-flash-1017`，回
   `400 model [...] service info not found` 并附带账号可用清单。所以 `runCli` 对 workbuddy 用长参数 `--model`（不是 `-m`）。
   **ACP 轨能握手但拒绝执行**：`--acp` 会回 `done{stopReason:'refusal'}`、正文全空，所以 `runner.mjs` 里
   `PREFER_OVERRIDE = { workbuddy: 'cli' }` 把 workbuddy 钉死在 CLI stream-json 轨。
6. **Windows `.cmd` + `shell:true` 会炸** — 已由 `core/spawn.mjs` 修掉：优先用 `node <cli.js>` 直启，其次 `cmd.exe /d /s /c` 显式包裹。
7. **ACP 首次 `session/new` 报 `Authentication required`** — 属正常，登录后即通。
8. **子进程 stdin 必须显式关闭** — `spawnTransport` 默认 `stdin:'ignore'`。若让它继承父进程的 stdin 管道，Qoder 会卡在等 EOF（表现为界面上无限刷 `session created` 然后 `qoder cli exited 1`）。需要写 stdin 的调用方（ACP 轨）显式传 `stdin:'pipe'`。
9. **Qoder 必须带 `-m <model>`** — qodercli 1.1.70 不带 `-m` 时 headless 路由会抛
   `FatalRoutingError: No models are available in the current catalog`
   （catalog 实际拉到了 24 个模型，但 `turn.started model=""` 路由不上）。已在 registry 里把 `-m Auto` 写死为默认，界面上还可以下拉选 17 个模型之一。
   同时 `result.result` 字段才是正文：`assistant` 帧的 `message.content` 是空的，解析器现在会在没有 text 流时用 `result.result` 兜底，并把 `is_error` 的 `errors[0]` 提升成真正的错误提示。
10. **SCNet 必须清空 `ELECTRON_RUN_AS_NODE`**：否则 `--remote-debugging-port` 被 Node 层当作未知 option 拒绝，报 `bad option` 或 `Cannot find module`，且无 flag 直启会因单例锁静默退出。
11. **Alice 把「占位话术」当答案 —— 已修**：外层气泡的 `innerText` 混着 `已思考 16s` 与工具栏，
   而正文节点 `.text-alice-text` 尚未生成。`readAssistant` 曾退回外层 → 对外表现为回答
   「让我琢磨一下…」/「在想，快了…」。现在只读内层，占位文案不推进 `stableSince`，`idleMs` 2500→6000。
12. **Alice 模型菜单开合是交替的**：探测后菜单若仍开着，下次点击变关闭，
   区域受限过滤静默失效（时好时坏：12 项 / 21 项）。现在探测前按两次 ESC 归零。
13. **CDP 表达式里别用嵌套模板字符串**：多层转义会把正则里的 `\w` 吃成 `w`，
   正则匹配不到元素又不报错。统一用 `new RegExp('...')` 构造或 `String.raw` 单层直写。
14. **链式流水的「分步接力」曾把整条清单传给每一棒 —— 已修**：worker 会误读原文里的
   「你是第一个 agent，只做任务 1」，要么空转、要么一次做完后面所有步（实测 MiniMax 把 2 和 3 都做了）。
   现在 `orchestrate()` 用 `parseSteps()` 从 `plan[0].prompt` 拆出有序步骤（只认行首编号，
   必须 1,2,3… 递增），再用 `assignPrompt()` 给每一棒下发权威指派，用户原话降级为「仅作背景」。
   详见 §6.6。
15. **Loomy 一次工具调用会推上百次 `message.part.updated` —— 已修**：同一 `part.id` 只在
   `state.status` 上变（pending→running→completed），原来每推一次就 `emit.toolCall`，界面刷出
   200+ 行空白 `⚙ bash {}`。现在按 `part.id + status` 去重，状态推进改报 `tool_result`。详见 §6.7。

## 8. 登录状态徽标是怎么判断的

`core/auth.mjs` 的 `authStatus(agentId)` 只看**该 CLI 自己读的那个文件**，猜错就会一直显示「未登录」。
2026-11-17 实测校准后的真路径：

| Agent | 判据 | 备注 |
|---|---|---|
| qoder | `~/.qoder/.auth/user`（1368 字节加密 blob，无扩展名） | 不是 `credentials.json`；`.credential-transaction` 是 0 字节锁文件，用它判会永远 missing |
| minimax | `~/.minimax/auth/prod/cn/mcode-public/auth-state.json` 里 `status === 'authenticated'` 且 `expiresAtMs` 未过期 | 光看文件存在不够 |
| workbuddy | **真跑一次请求**：`-p --output-format json --model auto "hi"`，看 `subtype=success`；结果缓存 8s | 凭证文件落点随版本变（`~/.credentials.json`、`~/credentials.json`、`~/.workbuddy/*` 实测都没写），所以不猜文件，直接看可不可用 |
| trae | 解密 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide`（AES-128-CBC），再查 `ide_user_ent_usage` 数据；结果缓存 60s | token 未过期且接口 200 = ok，详情列「3600 积分·用户·有效期」 |
| doubao / loomy / alice | `n/a` | 桌面应用，登录态在客户端自身 |

界面上：`刷新登录状态` 按钮 → `GET /api/agents?fresh=1`（强制绕过 30s 缓存重查）。
点「未登录 · 点击登录」拉起登录流程后，前端会 6 秒后自动 `loadAgents(true)`，徽标自己转绿，不用手刷。

## 9. 加一个新 agent

只需在 `core/registry.mjs` 的 `AGENTS` 里加一条：

```js
myagent: {
  id: 'myagent', label: 'MyAgent', vendor: 'X', accent: '#0ea5e9',
  bin: 'C:/path/to/cli.exe',
  transports: {
    acp: { kind:'acp', cmd:'C:/path/to/cli.exe', args:['acp'] },
    cli: { kind:'cli', cmd:'C:/path/to/cli.exe', args:['-p','--output-format','stream-json'] },
  },
  caps: ['acp'],
}
```

UI、API、编排、事件流全自动生效。

## 10. 目录

```
agent-hub/
  server.mjs              HTTP + SSE + 编排 API
  core/bus.mjs            统一事件模型
  core/registry.mjs       agent 注册表（本机路径）
  core/spawn.mjs          跨平台启动（Windows .cmd 陷阱处理）
  core/acp-client.mjs     ACP JSON-RPC 客户端
  core/runner.mjs         ACP 轨 / CLI 轨 / GUI 轨 / HTTP 轨 / CDP 轨
  core/auth.mjs           登录态探测与调起
  core/loomy-http.mjs     Loomy 轨：opencode HTTP API + SSE（含端口发现）
  core/alice-cdp.mjs      Alice 轨：CDP + DOM + 真实键盘事件
  core/mm-runtime.mjs     MiniMax 运行时：Electron 内嵌 Node + ABI 匹配的 better-sqlite3
  core/minimax.mjs        MiniMax 轨：stream-json（reasoning/agent_message/tool_call 三路分流）
  core/trae-cn.mjs        Trae CN 凭据桥：解密 storage.json → 积分与模型
  core/trae-cdp.mjs       Trae CN 轨：CDP 驱动 Solo 工作台（Input.insertText + 轮询 .markdown-renderer）
  core/doubao-cdp.mjs     豆包轨：CDP（真实 Enter + 气泡数增长判定 + 弹窗 ESC 清场）
  core/scnet-cdp.mjs      SCNet 轨：CDP（tiptap 注入 + .chat-block-markdown 取正文 + 侧栏「新建任务」）
  core/workbuddy.mjs      WorkBuddy 桥：SDK control_request/authenticate 登录 + 45 个模型清单
  tools/trae-cn-auth.py   手写 AES-128-CBC 参考实现（解密校验用）
  tools/probe.mjs         ACP 握手自检：node tools/probe.mjs trae
  tools/probe-local.mjs   Alice/Loomy/Trae 自检：node tools/probe-local.mjs alice|loomy|trae "prompt"
  web/index.html          工作台单页
```
