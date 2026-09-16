/**
 * 凭据处理：scrypt 加盐哈希与会话令牌。
 *
 * 仅服务端使用（依赖 node:crypto）。浏览器端不加载本模块。
 * 明文密码不得出现在任何日志、响应或落盘文件中。
 */
'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// scrypt 参数：内存约 16 MB，单次约 50–80 ms，局域网自用足够
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/** 生成 16 字节随机盐（hex） */
function makeSalt() {
    return crypto.randomBytes(16).toString('hex');
}

/** 生成 32 字节会话令牌（hex） */
function newToken() {
    return crypto.randomBytes(32).toString('hex');
}

/** 生成 8 位邀请码（10^8 空间，配合加入接口的 IP 限流，基本没法枚举） */
function newGroupCode() {
    return String(crypto.randomInt(10000000, 100000000));
}

/** 由明文密码与盐推出哈希（hex） */
async function hashPassword(password, saltHex) {
    const buf = await scrypt(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_PARAMS.keylen, {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p
    });
    return buf.toString('hex');
}

/** 定长安全比较，避免计时侧信道 */
function safeEqualHex(a, b) {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/** 校验明文密码是否匹配已存哈希 */
async function verifyPassword(password, saltHex, hashHex) {
    if (!password || !saltHex || !hashHex) return false;
    const got = await hashPassword(password, saltHex);
    return safeEqualHex(got, hashHex);
}

/** 昵称归一化：用于唯一性判定（忽略大小写与首尾空白） */
function normalizeNickname(nickname) {
    return String(nickname == null ? '' : nickname).trim().toLowerCase();
}

module.exports = {
    SCRYPT_PARAMS,
    makeSalt,
    newToken,
    newGroupCode,
    hashPassword,
    safeEqualHex,
    verifyPassword,
    normalizeNickname
};
