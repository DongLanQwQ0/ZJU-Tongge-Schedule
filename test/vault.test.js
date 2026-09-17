/**
 * shared/vault.js 单测。
 *
 * 重点不是"能加能解"，而是**解不开的那些情况**：AAD 把用途和归属绑死，
 * 换用途、换用户、换群、换钥匙、改密文，都必须失败。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vault = require('../shared/vault.js');

// 固定测试钥匙 —— 绝不是任何真实口令
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const UID_1 = 'u_test0001';
const UID_2 = 'u_test0002';

const v = vault.createVault(KEY_A);

test('往返：文本原样解回', () => {
    const blob = v.seal(vault.KINDS.REMARKS, UID_1, '小明');
    assert.equal(v.open(vault.KINDS.REMARKS, UID_1, blob), '小明');
});

test('往返：JSON 原样解回（含中文与嵌套）', () => {
    const value = { u_aaa: '小明', u_bbb: '小红', u_ccc: '小刚' };
    const blob = v.sealJson(vault.KINDS.REMARKS, UID_1, value);
    assert.deepEqual(v.openJson(vault.KINDS.REMARKS, UID_1, blob), value);
});

test('往返：课表量级（500 条）', () => {
    const courses = Array.from({ length: 500 }, (_, i) => ({
        course: `课程${i}`, day: (i % 7) + 1, startPeriod: 1, endPeriod: 2,
        startTime: '08:00', endTime: '09:35', location: `东${i % 4}-${100 + i}`
    }));
    const blob = v.sealJson(vault.KINDS.COURSE, UID_1, courses);
    assert.deepEqual(v.openJson(vault.KINDS.COURSE, UID_1, blob), courses);
});

test('密文形状：v/iv/ct/tag 齐全，且明文不出现在密文里', () => {
    const blob = v.seal(vault.KINDS.NICKNAME, UID_1, 'DongLanQwQ');
    assert.equal(blob.v, 1);
    assert.equal(typeof blob.iv, 'string');
    assert.equal(typeof blob.ct, 'string');
    assert.equal(typeof blob.tag, 'string');
    assert.equal(Buffer.from(blob.iv, 'base64').length, 12);
    assert.equal(Buffer.from(blob.tag, 'base64').length, 16);
    const joined = JSON.stringify(blob);
    assert.ok(!joined.includes('DongLanQwQ'), '明文不该出现在密文对象里');
});

test('同一个明文加密两次，IV 与密文都不同（IV 绝不复用）', () => {
    const a = v.seal(vault.KINDS.REMARKS, UID_1, '同名');
    const b = v.seal(vault.KINDS.REMARKS, UID_1, '同名');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
});

test('AAD 绑用途：换个用途解不开', () => {
    const blob = v.seal(vault.KINDS.NICKNAME, UID_1, '小明');
    assert.throws(() => v.open(vault.KINDS.REMARKS, UID_1, blob), (e) => e.code === 'BAD_TAG');
    assert.throws(() => v.open(vault.KINDS.COURSE, UID_1, blob), (e) => e.code === 'BAD_TAG');
});

test('AAD 绑归属：换个用户 id 解不开', () => {
    const blob = v.seal(vault.KINDS.REMARKS, UID_1, '只属于一号');
    assert.throws(() => v.open(vault.KINDS.REMARKS, UID_2, blob), (e) => e.code === 'BAD_TAG');
});

test('AAD 绑群号：对外备注挪到别的群解不开', () => {
    const kind = vault.KINDS.SELF_REMARK;
    const blob = v.seal(kind, `212518:${UID_1}`, '左囿');
    assert.equal(v.open(kind, `212518:${UID_1}`, blob), '左囿');
    assert.throws(() => v.open(kind, `546693:${UID_1}`, blob), (e) => e.code === 'BAD_TAG');
    // 少了群号（只剩 uid）同样解不开
    assert.throws(() => v.open(kind, UID_1, blob), (e) => e.code === 'BAD_TAG');
});

test('换一把钥匙解不开', () => {
    const other = vault.createVault(KEY_B);
    const blob = v.seal(vault.KINDS.REMARKS, UID_1, '钥匙 A 的内容');
    assert.throws(() => other.open(vault.KINDS.REMARKS, UID_1, blob), (e) => e.code === 'BAD_TAG');
});

test('篡改 ct / tag / iv 都解不开', () => {
    const kind = vault.KINDS.REMARKS;
    const blob = v.seal(kind, UID_1, '原始内容');

    const flip = (s) => {
        const buf = Buffer.from(s, 'base64');
        buf[0] ^= 0x01;
        return buf.toString('base64');
    };
    assert.throws(() => v.open(kind, UID_1, { ...blob, ct: flip(blob.ct) }), (e) => e.code === 'BAD_TAG');
    assert.throws(() => v.open(kind, UID_1, { ...blob, tag: flip(blob.tag) }), (e) => e.code === 'BAD_TAG');
    assert.throws(() => v.open(kind, UID_1, { ...blob, iv: flip(blob.iv) }), (e) => e.code === 'BAD_TAG');
});

test('密文格式不对时抛 BAD_BLOB，而不是当成明文读过去', () => {
    const kind = vault.KINDS.REMARKS;
    assert.throws(() => v.open(kind, UID_1, '明文'), (e) => e.code === 'BAD_BLOB');
    assert.throws(() => v.open(kind, UID_1, null), (e) => e.code === 'BAD_BLOB');
    assert.throws(() => v.open(kind, UID_1, { v: 1, iv: 'AA==', ct: 'AA==', tag: 'AA==' }), (e) => e.code === 'BAD_BLOB');
    assert.throws(() => v.open(kind, UID_1, { v: 2, iv: 'x', ct: 'y', tag: 'z' }), (e) => e.code === 'BAD_BLOB');
});

test('isSealed：只认完整的密文对象（迁移脚本靠它判重）', () => {
    assert.equal(vault.isSealed(v.seal(vault.KINDS.REMARKS, UID_1, 'x')), true);
    assert.equal(vault.isSealed('小明'), false);
    assert.equal(vault.isSealed({}), false);
    assert.equal(vault.isSealed({ v: 1, iv: 'a', ct: 'b' }), false);
    assert.equal(vault.isSealed({ v: 1, iv: 'a', ct: 'b', tag: 'c' }), true);
});

test('未知用途 / 缺少归属：直接拒绝，不静默降级', () => {
    assert.throws(() => v.seal('nick_name', UID_1, 'x'), (e) => e.code === 'BAD_KIND');
    assert.throws(() => v.seal(vault.KINDS.NICKNAME, '', 'x'), (e) => e.code === 'BAD_AAD');
    assert.throws(() => v.seal(vault.KINDS.NICKNAME, null, 'x'), (e) => e.code === 'BAD_AAD');
});

test('parseKeyHex：长度或字符不对就拒绝（不许被静默截断成另一把钥匙）', () => {
    assert.equal(vault.parseKeyHex('a'.repeat(64)).length, 32);
    assert.equal(vault.parseKeyHex('A'.repeat(64)).length, 32);         // 大写也认
    assert.throws(() => vault.parseKeyHex('a'.repeat(63)), (e) => e.code === 'BAD_KEY');
    assert.throws(() => vault.parseKeyHex('a'.repeat(66)), (e) => e.code === 'BAD_KEY');
    assert.throws(() => vault.parseKeyHex('z'.repeat(64)), (e) => e.code === 'BAD_KEY');
    assert.throws(() => vault.parseKeyHex(''), (e) => e.code === 'BAD_KEY');
});

test('randomKeyHex：64 位、两次不同', () => {
    const a = vault.randomKeyHex();
    const b = vault.randomKeyHex();
    assert.equal(a.length, 64);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
});

test('fromEnv：缺失返回 null，格式不对就抛（不把配错当成没配）', () => {
    assert.equal(vault.fromEnv({}), null);
    assert.equal(vault.fromEnv({ TONGGE_ROOT_KEY: '   ' }), null);
    assert.equal(vault.fromEnv({ TONGGE_ROOT_KEY: KEY_A }).length, 32);
    assert.throws(() => vault.fromEnv({ TONGGE_ROOT_KEY: 'short' }), (e) => e.code === 'BAD_KEY');
});

test('createVault 接受 hex 字符串或 Buffer，长度不对都拒绝', () => {
    assert.equal(typeof vault.createVault(KEY_A).seal, 'function');
    assert.equal(typeof vault.createVault(Buffer.from(KEY_A, 'hex')).seal, 'function');
    assert.throws(() => vault.createVault(Buffer.alloc(16)), (e) => e.code === 'BAD_KEY');
});

// ---------------------------------------------------------------- 本机开发用的钥匙文件

/** 造一个带 .tongge/key.env 的假仓库 */
function repoWithKeyFile(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-vault-'));
    if (content !== null) {
        fs.mkdirSync(path.join(dir, '.tongge'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.tongge', 'key.env'), content);
    }
    return dir;
}

test('fromLocalFile：本机开发读 .tongge/key.env（可以带注释和空行）', () => {
    const dir = repoWithKeyFile('# 本机开发用，不是线上那把\n\nTONGGE_ROOT_KEY=' + KEY_A + '\n');
    assert.equal(vault.fromLocalFile(dir, {}).length, 32);
    assert.equal(vault.fromLocalFile(dir, { NODE_ENV: 'development' }).length, 32);
});

test('fromLocalFile：NODE_ENV=production 时**根本不看**这个文件', () => {
    const dir = repoWithKeyFile('TONGGE_ROOT_KEY=' + KEY_A + '\n');
    // 镜像里就是 production —— 部署目录里就算躺着 key.env，也只认环境变量
    assert.equal(vault.fromLocalFile(dir, { NODE_ENV: 'production' }), null);
});

test('fromLocalFile：没有文件 / 文件里没有那一行 → null；值坏了就抛', () => {
    assert.equal(vault.fromLocalFile(repoWithKeyFile(null), {}), null);
    assert.equal(vault.fromLocalFile(repoWithKeyFile('# 只有注释\n'), {}), null);
    assert.equal(vault.fromLocalFile(path.join(os.tmpdir(), 'gcc-根本没有这个目录'), {}), null);
    const bad = repoWithKeyFile('TONGGE_ROOT_KEY=短了\n');
    assert.throws(() => vault.fromLocalFile(bad, {}), (e) => e.code === 'BAD_KEY');
});

test('实例自带 KINDS 与 isSealed（store 按实例用，不必回头 require 模块）', () => {
    const one = vault.createVault(KEY_A);
    assert.equal(one.KINDS.REMARKS, 'remarks');
    assert.equal(one.isSealed(one.seal(one.KINDS.REMARKS, UID_1, 'x')), true);
    assert.equal(one.isSealed('明文'), false);
});

test('openJson：内容不是 JSON 时抛 BAD_JSON，而不是静默返回 null', () => {
    const blob = v.seal(vault.KINDS.REMARKS, UID_1, '这不是 JSON');
    assert.throws(() => v.openJson(vault.KINDS.REMARKS, UID_1, blob), (e) => e.code === 'BAD_JSON');
});
