/**
 * 会话令牌只以 sha256 落盘。
 *
 * 要守住三件事：
 *   1. 文件里搜不到令牌原文（否则拿到 sessions.json 就能冒充任意登录用户）
 *   2. 老数据（明文令牌为键）升级后**没人需要重新登录**
 *   3. 重复启动不会把哈希再哈希一遍 —— 那会把所有人踢下线
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, sessionKey } = require('../shared/store.js');

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-sesskey-'));
const sessionsFile = (dir) => path.join(dir, 'sessions.json');
const rawSessions = (dir) => JSON.parse(fs.readFileSync(sessionsFile(dir), 'utf8'));

async function fresh(dir) {
    const store = createStore(dir);
    await store.init();
    return store;
}

test('新建会话：落盘的是哈希，令牌原文不在文件里', async () => {
    const dir = newDir();
    const store = await fresh(dir);
    const u = await store.createUser('小明', 'password1');
    const token = await store.createSession(u.id);

    const text = fs.readFileSync(sessionsFile(dir), 'utf8');
    assert.ok(!text.includes(token), '会话文件里不该出现令牌原文');
    assert.ok(text.includes(sessionKey(token)), '应当存的是令牌的 sha256');

    const db = rawSessions(dir);
    assert.equal(db.keyed, 'sha256');
    assert.equal(db.sessions[sessionKey(token)].userId, u.id);

    // 服务端拿原文照样能认人
    assert.equal((await store.resolveSession(token)).id, u.id);
    assert.equal(await store.resolveSession('不是这个令牌'), null);
});

test('老数据（明文令牌为键）：启动时就地升级，用户无需重新登录', async () => {
    const dir = newDir();
    const store = await fresh(dir);
    const u = await store.createUser('小明', 'password1');

    // 手工造一份"改造之前"的会话表：键就是令牌原文
    const plain = 'f'.repeat(64);
    const t = Date.now();
    fs.writeFileSync(sessionsFile(dir), JSON.stringify({
        v: 1, sessions: { [plain]: { userId: u.id, createdAt: t, lastSeen: t } }
    }, null, 2));

    const upgraded = await fresh(dir);
    const text = fs.readFileSync(sessionsFile(dir), 'utf8');
    assert.ok(!text.includes(plain), '升级后文件里不该再有令牌原文');
    assert.equal(rawSessions(dir).sessions[sessionKey(plain)].userId, u.id);
    assert.equal((await upgraded.resolveSession(plain)).id, u.id, '浏览器里那个令牌要照旧管用');
});

test('反复启动不会把哈希再哈希一遍（否则等于把所有人踢下线）', async () => {
    const dir = newDir();
    const store = await fresh(dir);
    const u = await store.createUser('小明', 'password1');
    const plain = 'a'.repeat(64);
    const t = Date.now();
    fs.writeFileSync(sessionsFile(dir), JSON.stringify({
        v: 1, sessions: { [plain]: { userId: u.id, createdAt: t, lastSeen: t } }
    }, null, 2));

    for (let i = 0; i < 3; i++) {
        const again = await fresh(dir);
        assert.equal((await again.resolveSession(plain)).id, u.id, `第 ${i + 1} 次启动后仍应认得出`);
    }
    assert.equal(Object.keys(rawSessions(dir).sessions).length, 1);
});

test('登出后令牌立即失效', async () => {
    const dir = newDir();
    const store = await fresh(dir);
    const u = await store.createUser('小明', 'password1');
    const token = await store.createSession(u.id);
    assert.equal((await store.resolveSession(token)).id, u.id);

    await store.revokeSession(token);
    assert.equal(await store.resolveSession(token), null);
    assert.equal(Object.keys(rawSessions(dir).sessions).length, 0);
});

test('改密码之后旧令牌全部失效（哈希键也要跟着清干净）', async () => {
    const dir = newDir();
    const store = await fresh(dir);
    const u = await store.createUser('小明', 'password1');
    const token = await store.createSession(u.id);
    await store.setUserPassword(u.id, 'password2');
    assert.equal(await store.resolveSession(token), null);
    assert.equal(Object.keys(rawSessions(dir).sessions).length, 0);
});
