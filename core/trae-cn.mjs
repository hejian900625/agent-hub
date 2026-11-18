// Trae CN 桥接：解出客户端 userInfo.token → 查积分 → 列出客户端模型。
// 纯 Node 实现（AES 用 crypto），不依赖 Python；Python 只作为兜底。
import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const TRAE_STATE_JSON = 'C:\\Users\\Lenovo\\AppData\\Roaming\\Trae CN\\User\\globalStorage\\storage.json';
export const TRAE_VSCDB = 'C:\\Users\\Lenovo\\AppData\\Roaming\\Trae CN\\User\\globalStorage\\state.vscdb';
export const TRAE_EXE = 'D:\\Programs\\Trae CN\\Trae CN.exe';
export const TRAE_AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
export const TRAE_UG_API = 'https://api.trae.cn';

const XHE = Buffer.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const MHE = Buffer.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);
const PHE = Buffer.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209]);
const RHE = Buffer.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170]);

const QS = 32, GL = 64, OV = 6, HP = 64, AES128 = 16;

function patchBytes(privateMode) {
  const a = privateMode ? PHE : XHE;
  const b = privateMode ? RHE : MHE;
  const out = Buffer.alloc(GL);
  for (let i = 0; i < GL; i++) out[i] = a[i] ^ b[i];
  return out;
}

// Che(): 由 seed 派生 aesKey(16) 与 iv(16)
function derive(seed, privateMode) {
  const ns = Buffer.alloc(HP + GL);
  const h1 = createHash('sha512').update(seed).digest();
  h1.copy(ns, 0);
  patchBytes(privateMode).copy(ns, HP);
  const h2 = createHash('sha512').update(ns).digest();
  return { aesKey: h2.subarray(0, AES128), iv: h2.subarray(AES128, AES128 + AES128) };
}

export function decryptUserInfoBlob(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.subarray(0, 2).toString('latin1') !== 'tc') throw new Error('bad magic');
  const payload = raw.subarray(OV);
  const privateMode = raw[2] === 32;
  const key = payload.subarray(0, QS);
  const { aesKey, iv } = derive(key, privateMode);
  const d = createDecipheriv('aes-128-cbc', aesKey, iv);
  const pt = Buffer.concat([d.update(payload.subarray(QS)), d.final()]);
  const digest = pt.subarray(0, HP);
  const body = pt.subarray(HP);
  const check = createHash('sha512').update(body).digest();
  if (!check.equals(digest)) throw new Error('sha512 mismatch');
  return JSON.parse(body.toString('utf8'));
}

export function readUserInfo() {
  const st = JSON.parse(readFileSync(TRAE_STATE_JSON, 'utf8'));
  const blob = st[TRAE_AUTH_KEY];
  if (!blob) throw new Error('no ' + TRAE_AUTH_KEY + ' in storage.json — 请先在 Trae CN 里登录');
  return decryptUserInfoBlob(blob);
}

export async function traeQuota(token) {
  const r = await fetch(`${TRAE_UG_API}/trae/api/v2/pay/ide_user_ent_usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Cloud-IDE-JWT ${token}` },
    body: JSON.stringify({ require_usage: true, req_source: 2 }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, body: await r.json() };
}

export async function traeStatus() {
  // 关键：登录态只看【本地 token + 过期时间】，不能看积分接口是否通 ——
  // 积分接口超时/抖动只应让 credits 变 null，不该把整家判成「未登录」。
  let info
  try {
    info = readUserInfo()
  } catch (e) {
    return { up: false, reason: `本地凭据读取失败：${e.message || e}` }
  }
  if (!info?.token) return { up: false, reason: 'storage.json 里没有 iCubeAuthInfo' }

  const exp = Date.parse(info.expiredAt)
  const expired = Number.isFinite(exp) && exp < Date.now()

  // 积分是锦上添花，失败就留空，不污染登录态
  let credits = null
  let consumed = null
  let total = null
  let quotaError = null
  try {
    const q = await traeQuota(info.token)
    if (q.status === 200) {
      credits = q.body?.total_balance ?? null
      consumed = q.body?.usage_summary?.consumed_amount ?? null
      total = q.body?.usage_summary?.total_amount ?? null
    } else if (q.status === 401) {
      // 401 才是真的 token 失效（早前实测：用 .trae-cn/trae-jwt-token 调同一接口就是 401 code 1001）
      return { up: false, userId: info.userId, expiredAt: info.expiredAt, reason: 'token 已失效（积分接口 401），请打开 Trae CN 重新登录' }
    } else {
      quotaError = `积分接口 HTTP ${q.status}`
    }
  } catch (e) {
    quotaError = `积分接口不可达：${String(e.message || e).slice(0, 80)}`
  }

  return {
    up: !expired,
    userId: info.userId,
    expiredAt: info.expiredAt,
    refreshExpiredAt: info.refreshExpiredAt,
    scope: info.account?.scope,
    userTag: info.account?.userTag,
    credits,
    consumed,
    total,
    quotaError,
    reason: expired ? `token 已过期（${info.expiredAt}），请打开 Trae CN 重新登录` : undefined,
  }
}

/**
 * 给工作台卡片用的实时状态：登录态 + 积分 + 客户端是否在跑。
 * 客户端进程检测走 tasklist（不需要管理员权限）。
 */
export async function traeLive() {
  const st = await traeStatus();
  let running = false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Trae CN.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    running = /Trae CN\.exe/i.test(out);
  } catch {
    running = false;
  }
  return { up: !!st.up, running, credits: st.credits ?? null, userId: st.userId ?? null, expiredAt: st.expiredAt ?? null, consumed: st.consumed ?? null, total: st.total ?? null, reason: st.reason };
}

// 模型清单：主源是 state.vscdb（无需客户端运行），失败则返回内置兜底
export function traeModels() {
  const builtin = {
    solo_agent: ['Doubao-Seed-2.1-Turbo', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-Evolving', 'Doubao-Seed-Code', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'deepseek-v4.1-flash', 'DeepSeek-V4-Pro-Official', 'kimi-k3.1-pro', 'kimi-k3', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'minimax-m3.1-flash', 'minimax-m3', 'step-5-preview', 'qwen3.8-flash', 'qwen3.8-max'],
  };
  try {
    const py = [
      'import sqlite3,json',
      `c=sqlite3.connect(r'file:${TRAE_VSCDB.replace(/\\/g, '/')}?mode=ro',uri=True)`,
      'cur=c.cursor()',
      `cur.execute("select value from ItemTable where key like '%AI.agent.model.model_list_map' order by length(value) desc limit 1")`,
      'row=cur.fetchone()',
      'print(row[0] if row else "{}")',
    ].join('\n');
    const raw = execFileSync('python', ['-c', py], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20, timeout: 20000 });
    const map = JSON.parse(raw.trim());
    const scenes = {};
    for (const [scene, list] of Object.entries(map)) {
      if (!Array.isArray(list) || !list.length) continue;
      scenes[scene] = list.map(x => x.name).filter(Boolean);
    }
    return Object.keys(scenes).length ? scenes : builtin;
  } catch {
    return builtin;
  }
}

// 拍平成下拉用的扁平列表（去重、保序）
export function traeModelList() {
  const scenes = traeModels();
  const order = ['solo_agent', 'agent', 'chat_v3', 'chat', 'builder_v3', 'builder', 'code_reviewer', 'code_review_summary', 'refactor'];
  const seen = new Set();
  const out = [];
  for (const s of order) {
    for (const n of scenes[s] || []) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  for (const [s, list] of Object.entries(scenes)) {
    if (order.includes(s)) continue;
    for (const n of list) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('trae-cn.mjs')) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'token') {
    console.log(readUserInfo().token);
  } else if (cmd === 'userinfo') {
    console.log(JSON.stringify(readUserInfo(), null, 2));
  } else {
    console.log(JSON.stringify(await traeStatus(), null, 2));
  }
}
