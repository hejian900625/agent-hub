#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Trae CN userInfo 解密器 —— 复刻 main.js 里 out-build/vs/base/common/byteCrypto.js 的算法。

算法（源码 1:1 对应）：
  外层容器: b"tc" + bytes([5,16,0,0]) + payload
  key  : payload 前 QS=32 字节
  body : payload[32:]，AES-128-CBC
  derive(aesKey, iv) [Che]:
      ns = 64 字节缓冲
      ns[0:64]  = SHA512(seed)
      ns[64:128] = (xhe ^ Mhe)[0:64]      # eo.AES 模式的 GL=64 字节补丁
      ns[0:64]  = SHA512(ns)              # 覆盖前 64 字节
      aesKey = ns[0:16]   (GE.AES128=16, zL=16)
      iv     = ns[16:32]  (n=zL=16)
  queue: t.slice(QS+ov) = payload[38:]
  plain: AES-CBC 解密 → 校验头 64 字节 = SHA512(明文正文)
"""
import base64
import hashlib
import json
import sys
from pathlib import Path

STATE_JSON = Path(r"C:\Users\Lenovo\AppData\Roaming\Trae CN\User\globalStorage\storage.json")
KEY = "iCubeAuthInfo://icube.cloudide"

head = bytes([116, 99, 5, 16, 0, 0])  # KL,JL,YL,XL,QL,ZL
QS = 32      # key 长度
GL = 64      # 补丁块长度
OV = 6       # 头长度
HP = 64      # sha512 摘要长度
AES128 = 16


def _b(arr):
    return bytes(arr)


XHE = _b([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37])
MHE = _b([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
PHE = _b([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209])
RHE = _b([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170])


def patch(mode_private=False):
    a, b = (PHE, RHE) if mode_private else (XHE, MHE)
    return bytes(a[i] ^ b[i] for i in range(GL))


def derive(seed, mode_private=False):
    ns = bytearray(HP + GL)
    ns[0:HP] = hashlib.sha512(seed).digest()
    ns[HP:HP + GL] = patch(mode_private)
    ns[0:HP] = hashlib.sha512(bytes(ns)).digest()
    return bytes(ns[0:AES128]), bytes(ns[AES128:AES128 + AES128])


SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16")
INV_SBOX = bytes(256)
_inv = bytearray(256)
for _i, _v in enumerate(SBOX):
    _inv[_v] = _i
INV_SBOX = bytes(_inv)
RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36, 0x6C, 0xD8, 0xAB, 0x4D]


def _xtime(a):
    a <<= 1
    if a & 0x100:
        a = (a ^ 0x1B) & 0xFF
    return a


def _mul(a, b):
    r = 0
    for _ in range(8):
        if b & 1:
            r ^= a
        b >>= 1
        a = _xtime(a)
    return r


def _key_expansion(key):
    nk = len(key) // 4
    nr = nk + 6
    w = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    for i in range(nk, 4 * (nr + 1)):
        t = list(w[i - 1])
        if i % nk == 0:
            t = t[1:] + t[:1]
            t = [SBOX[x] for x in t]
            t[0] ^= RCON[i // nk - 1]
        elif nk > 6 and i % nk == 4:
            t = [SBOX[x] for x in t]
        w.append([w[i - nk][j] ^ t[j] for j in range(4)])
    return w, nr


def _decrypt_block(w, nr, block):
    # 状态按列存：st[c][r] 对应 AES 规范 state[r][c]
    st = [[block[4 * c + r] for r in range(4)] for c in range(4)]

    def add_rk(rnd):
        for c in range(4):
            rk = w[rnd * 4 + c]
            for r in range(4):
                st[c][r] ^= rk[r]

    def inv_shift_rows():
        # 行 r 右移 r 位
        for r in range(1, 4):
            row = [st[c][r] for c in range(4)]
            row = row[-r:] + row[:-r]
            for c in range(4):
                st[c][r] = row[c]

    def inv_mix_columns():
        for c in range(4):
            a = list(st[c])
            st[c][0] = _mul(a[0], 14) ^ _mul(a[1], 11) ^ _mul(a[2], 13) ^ _mul(a[3], 9)
            st[c][1] = _mul(a[0], 9) ^ _mul(a[1], 14) ^ _mul(a[2], 11) ^ _mul(a[3], 13)
            st[c][2] = _mul(a[0], 13) ^ _mul(a[1], 9) ^ _mul(a[2], 14) ^ _mul(a[3], 11)
            st[c][3] = _mul(a[0], 11) ^ _mul(a[1], 13) ^ _mul(a[2], 9) ^ _mul(a[3], 14)

    add_rk(nr)
    for rnd in range(nr - 1, 0, -1):
        inv_shift_rows()
        for c in range(4):
            for r in range(4):
                st[c][r] = INV_SBOX[st[c][r]]
        add_rk(rnd)
        inv_mix_columns()
    # 最后一轮（rnd=0）：无 InvMixColumns
    inv_shift_rows()
    for c in range(4):
        for r in range(4):
            st[c][r] = INV_SBOX[st[c][r]]
    add_rk(0)
    return bytes(st[c][r] for c in range(4) for r in range(4))


def aes_cbc_decrypt(key, iv, data):
    w, nr = _key_expansion(key)
    out = bytearray()
    prev = iv
    for i in range(0, len(data) - len(data) % 16, 16):
        blk = data[i:i + 16]
        dec = _decrypt_block(w, nr, blk)
        out += bytes(a ^ b for a, b in zip(dec, prev))
        prev = blk
    if out and 1 <= out[-1] <= 16:
        out = out[:-out[-1]]
    return bytes(out)


def decrypt_b64(b64):
    raw = base64.b64decode(b64)
    if raw[:2] != b"tc":
        raise ValueError("bad magic: %r" % raw[:2])
    hdr = raw[0:OV]
    payload = raw[OV:]
    private = (hdr[2] == 32)  # AES_PRIVATE 分支
    aes_key, iv = derive(payload[0:QS], private)
    ct = payload[QS:]
    pt = aes_cbc_decrypt(aes_key, iv, ct)
    digest, body = pt[0:HP], pt[HP:]
    if hashlib.sha512(body).digest() != digest:
        raise ValueError("sha512 mismatch (wrong key derivation)")
    return body.decode("utf-8", "replace")


def try_variants(b64):
    """按多种可能组合尝试，返回第一个成功的。"""
    raw = base64.b64decode(b64)
    payload = raw[OV:]
    attempts = []
    for priv in (False, True):
        for skip in (QS + OV, QS):
            for hdrsz in (OV, 0):
                attempts.append((priv, skip, hdrsz))
    out = []
    for priv, skip, hdrsz in attempts:
        try:
            body = payload[hdrsz:]
            aes_key, iv = derive(body[0:QS], priv)
            pt = aes_cbc_decrypt(aes_key, iv, body[QS + (skip - QS - hdrsz) if skip > QS + hdrsz else QS:])
            out.append((priv, skip, hdrsz, "ok", len(pt)))
        except Exception as e:
            out.append((priv, skip, hdrsz, str(e)[:60], 0))
    return out


def main():
    st = json.loads(STATE_JSON.read_text(encoding="utf-8"))
    b64 = st.get(KEY)
    if not b64:
        print("no %s in storage.json" % KEY)
        return 1
    print("blob chars:", len(b64))
    try:
        plain = decrypt_b64(b64)
    except Exception as e:
        print("decrypt failed:", e)
        print("variants:")
        for a in try_variants(b64):
            print("  ", a)
        return 2
    print("=== PLAINTEXT (%d chars) ===" % len(plain))
    try:
        info = json.loads(plain)
        pretty = json.dumps(info, ensure_ascii=False, indent=2)
        print(pretty)
        tok = (info.get("token") or "")
        print("\n[token] len=%d head=%s tail=%s" % (len(tok), tok[:24], tok[-12:]))
    except Exception:
        print(plain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
