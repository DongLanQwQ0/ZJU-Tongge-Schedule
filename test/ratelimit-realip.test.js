/**
 * 反代后面"限流按谁分桶"。
 *
 * 这是本次要修的 bug：站点在反代后面时，`socket.remoteAddress` 是反代/网桥地址，
 * 于是所有人的请求共用一个桶 —— 一个人刷 9 次注册就能让**全站** 10 分钟注册不了。
 * 下面两组用例分别守两件事：
 *   1. 同一个反代后面，不同客户端必须落在**不同的桶**里
 *   2. 直连方不可信时，客户端自己填的 X-Forwarded-For **必须被忽略**
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server.js');
const { createStore } = require('../shared/store.js');

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-realip-'));

/** 建一个群和一个账号，返回登录令牌与群号 */
async function seed(dir) {
    const store = createStore(dir);
    await store.init();
    const u = await store.createUser('小明', 'password1');
    const g = await store.createGroup(u.id, '计科2201组团');
    return { code: g.code, nickname: '小明' };
}

async function startServer(dir, trustedProxies) {
    const server = await createServer({
        vault: false, captcha: false, dataDir: dir, port: 0, skipCleanup: true,
        trustedProxies,
        // 只把"加入群"这一档压到 2 次，方便观察分桶
        limits: { join: { windowMs: 60000, max: 2, message: '太频繁了，等一分钟' } }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, base, stop: () => new Promise((r) => server.close(r)) };
}

const post = (base, p, headers, token) => fetch(base + p, {
    method: 'POST',
    headers: Object.assign({ Authorization: 'Bearer ' + token }, headers)
}).then((r) => r.status);

test('同一个反代后面：不同客户端的额度互不占用', async () => {
    const dir = newDir();
    const info = await seed(dir);
    // 测试进程从 127.0.0.1 连进来，所以把 127.0.0.1 当可信反代
    const { base, stop } = await startServer(dir, '127.0.0.1');
    try {
        const login = await fetch(base + '/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: info.nickname, password: 'password1' })
        }).then((r) => r.json());
        const url = `/api/groups/${info.code}/join`;

        // 客户端 A：两次用完自己的额度，第三次被拦
        assert.equal(await post(base, url, { 'x-forwarded-for': '1.1.1.1' }, login.token), 200);
        assert.equal(await post(base, url, { 'x-forwarded-for': '1.1.1.1' }, login.token), 200);
        assert.equal(await post(base, url, { 'x-forwarded-for': '1.1.1.1' }, login.token), 429);

        // 客户端 B：同一个反代、同一个 socket 地址，但**不该被 A 连累**
        assert.equal(await post(base, url, { 'x-forwarded-for': '2.2.2.2' }, login.token), 200);
        // 没带头的那部分（比如反代自己发的探针）落回直连地址，也不受影响
        assert.equal(await post(base, url, {}, login.token), 200);
    } finally {
        await stop();
    }
});

test('直连方不可信时：自己填的 X-Forwarded-For 一律不算数', async () => {
    const dir = newDir();
    const info = await seed(dir);
    // trustedProxies: 'none' = 谁都不信（相当于端口直接对公网/LAN 开放）
    const { base, stop } = await startServer(dir, 'none');
    try {
        const login = await fetch(base + '/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: info.nickname, password: 'password1' })
        }).then((r) => r.json());
        const url = `/api/groups/${info.code}/join`;

        // 三次请求伪造三个不同 IP，但桶是同一个（直连地址），第三次照样被拦
        assert.equal(await post(base, url, { 'x-forwarded-for': '3.3.3.3' }, login.token), 200);
        assert.equal(await post(base, url, { 'x-forwarded-for': '4.4.4.4' }, login.token), 200);
        assert.equal(await post(base, url, { 'x-forwarded-for': '5.5.5.5' }, login.token), 429);
    } finally {
        await stop();
    }
});

test('记录下来的来源 IP 也是真实 IP（不是反代地址）', async () => {
    const dir = newDir();
    const info = await seed(dir);
    const { base, stop } = await startServer(dir, '127.0.0.1');
    try {
        const res = await fetch(base + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
            body: JSON.stringify({ nickname: info.nickname, password: 'password1' })
        });
        assert.equal(res.status, 200);

        // 登录会记 lastLoginIp（路由里 await 了落盘，不用等）
        const store = createStore(dir);
        await store.init();
        const u = await store.findUserByNickname(info.nickname);
        assert.equal(u.lastLoginIp, '9.9.9.9');
    } finally {
        await stop();
    }
});
