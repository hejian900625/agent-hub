#!/usr/bin/env node
// Trae CN 客户端桥：解密 userInfo.token → 查积分 → 列出客户端模型。
// 用法：
//   node tools/trae-cn.mjs auth      # 打印账号/积分/剩余额度
//   node tools/trae-cn.mjs models    # 打印客户端模型清单
//   node tools/trae-cn.mjs token     # 打印 token（调试用）
import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PY = 'D:\\project\\trae-agent\\.venv\\Scripts\\python.exe';
const DECRYPTOR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'trae-cn-auth.py');
const STORAGE = 'C:\\Users\\Lenovo\\AppData\\Roaming\\Trae CN\\User\\globalStorage\\storage.json';
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const UG_API = 'https://api.trae.cn';

function decryptUserInfo() {
  const out = execFileSync(PY, [DECRYPTOR], { encoding: 'utf8', windowsHide: true });
  const i = out.indexOf('{');
  const j = out.lastIndexOf('}');
  return JSON.parse(out.slice(i, j + 1));
}

async function quota(token) {
  const r = await fetch(`${UG_API}/trae/api/v2/pay/ide_user_ent_usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Cloud-IDE-JWT ${token}` },
    body: JSON.stringify({ require_usage: true, req_source: 2 }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, body: await r.json() };
}

function models() {
  // 从 state.vscdb 读模型清单（不依赖客户端运行）
  const py = `import sqlite3,json
c=sqlite3.connect(r'file:C:/Users/Lenovo/AppData/Roaming/Trae CN/User/globalStorage/state.vscdb?mode=ro',uri=True)
cur=c.cursor()
cur.execute("select value from ItemTable where key like '%AI.agent.model.model_list_map' order by length(value) desc limit 1")
print(cur.fetchone()[0])`;
  const raw = execFileSync(PY, ['-c', py], { encoding: 'utf8', maxBuffer: 8 << 20, windowsHide: true });
  return JSON.parse(raw);
}

const cmd = process.argv[2] || 'auth';
if (cmd === 'token') {
  const info = decryptUserInfo();
  console.log(info.token);
} else if (cmd === 'models') {
  const m = models();
  for (const [scene, list] of Object.entries(m)) {
    console.log(`\n## ${scene} (${list.length})`);
    for (const it of list) {
      console.log(`  ${it.name}${it.is_default ? '  [default]' : ''}   ${it.display_name || ''}`);
    }
  }
} else {
  const info = decryptUserInfo();
  const q = await quota(info.token);
  console.log(JSON.stringify({
    userId: info.userId,
    host: info.host,
    expiredAt: info.expiredAt,
    refreshExpiredAt: info.refreshExpiredAt,
    scope: info.account?.scope,
    userTag: info.account?.userTag,
    tokenLen: info.token.length,
    quotaStatus: q.status,
    totalBalance: q.body?.total_balance,
    trial: q.body?.trial_status,
    usage: q.body?.usage_summary,
    packs: (q.body?.user_entitlement_pack_list || []).map(p => ({
      desc: p.display_desc, status: p.status,
      credits: p.entitlement_base_info?.product_extra?.package_extra?.quota?.credits_limit,
      expire: p.expire_time,
    })),
  }, null, 2));
}
