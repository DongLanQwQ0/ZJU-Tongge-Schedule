/**
 * server 侧的加密接线：拒绝启动的三种情形，以及"迁移之后一切照常"。
 *
 * 三种拒绝启动比"能启动"更重要：
 *   1. 没配根密钥          → 不许悄悄退化成明文存盘
 *   2. 数据还没迁移        → 不许半明文半密文地上线
 *   3. 钥匙不对            → 不许带着错钥匙跑起来，把后面写的数据也弄坏
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server.js');
const { createStore } = require('../shared/store.js');
const vaultMod = require('../shared/vault.js');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const COURSE = {
    course: '大学英语Ⅲ', day: 1, startPeriod: 3, endPeriod: 4,
    startTime: '10:00', endTime: '11:35', location: '紫金港东6-328',
    dates: ['20260914']
};

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-srvvault-'));
const usersFile = (dir) => path.join(dir, 'users.json');

/** 在指定目录里造一份明文数据（模拟"改造之前"的线上数据） */
async function seedPlaintext(dir) {
    const store = createStore(dir);
    await store.init();
    const a = await store.createUser('小明', 'password1');
    await store.setUserCourses(a.id, [COURSE]);
    const g = await store.createGroup(a.id, '计科2201组团');
    return { store, a, g };
}

async function startServer(options) {
    const server = await createServer({ captcha: false, port: 0, skipCleanup: true, ...options });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, base, stop: () => new Promise((r) => server.close(r)) };
}

async function api(base, pathname, opts = {}) {
    const headers = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + pathname, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
}

test('没有根密钥：拒绝启动，并告诉你怎么生成', async () => {
    const dir = newDir();
    const saved = process.env.TONGGE_ROOT_KEY;
    delete process.env.TONGGE_ROOT_KEY;
    try {
        await assert.rejects(
            () => createServer({ captcha: false, dataDir: dir, port: 0, skipCleanup: true }),
            /TONGGE_ROOT_KEY/
        );
    } finally {
        if (saved !== undefined) process.env.TONGGE_ROOT_KEY = saved;
    }
});

test('根密钥格式不对：拒绝启动', async () => {
    const dir = newDir();
    const saved = process.env.TONGGE_ROOT_KEY;
    process.env.TONGGE_ROOT_KEY = 'too-short';
    try {
        await assert.rejects(
            () => createServer({ captcha: false, dataDir: dir, port: 0, skipCleanup: true }),
            /根密钥格式不对/
        );
    } finally {
        if (saved === undefined) delete process.env.TONGGE_ROOT_KEY;
        else process.env.TONGGE_ROOT_KEY = saved;
    }
});

test('vault: false 是显式关闭加密：能起，且 banner 会说自己没加密', async () => {
    const dir = newDir();
    const { server, stop } = await startServer({ dataDir: dir, vault: false });
    assert.equal(server.encrypted, false);
    await stop();
});

test('数据还没迁移：拒绝启动，并提示跑迁移命令', async () => {
    const dir = newDir();
    await seedPlaintext(dir);
    await assert.rejects(
        () => createServer({
            captcha: false, dataDir: dir, port: 0, skipCleanup: true,
            vault: vaultMod.createVault(KEY_A)
        }),
        (e) => /还没迁移/.test(e.message) && /--migrate-vault/.test(e.message)
    );
});

test('钥匙不对：拒绝启动（而不是把数据写坏）', async () => {
    const dir = newDir();
    const { store } = await seedPlaintext(dir);
    const keyed = createStore(dir, { vault: vaultMod.createVault(KEY_A) });
    await keyed.init();
    await keyed.migrateVault('T');
    assert.ok(store);

    await assert.rejects(
        () => createServer({
            captcha: false, dataDir: dir, port: 0, skipCleanup: true,
            vault: vaultMod.createVault(KEY_B)
        }),
        /根密钥不对/
    );

    // 关键：拿着错钥匙，绝不能把好文件当"损坏"改名再重建空表。
    // 这一步曾经真的做错过 —— 解密失败被当成文件损坏，等于把数据删了。
    assert.ok(fs.existsSync(usersFile(dir)), 'users.json 必须原样还在');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.deepEqual(leftovers, [], '不该产生 .corrupt-* 副本');
    const text = fs.readFileSync(usersFile(dir), 'utf8');
    assert.ok(!text.includes('小明'), '文件里仍应是密文（说明没被重建过）');

    // 用对的钥匙仍然读得回来
    const again = createStore(dir, { vault: vaultMod.createVault(KEY_A) });
    await again.init();
    assert.equal((await again.readUsers()).length, 1);
});

test('迁移之后：服务能起，接口端到端正常，文件里没有明文', async () => {
    const dir = newDir();
    await seedPlaintext(dir);

    // 迁移（模拟运维在服务停掉之后跑的那条命令）
    const keyed = createStore(dir, { vault: vaultMod.createVault(KEY_A) });
    await keyed.init();
    const report = await keyed.migrateVault('E2E');
    assert.ok(report.fields > 0);

    const { server, base, stop } = await startServer({
        dataDir: dir, vault: vaultMod.createVault(KEY_A)
    });
    try {
        assert.equal(server.encrypted, true);

        // 老数据读得出来
        const login = await api(base, '/api/login', {
            method: 'POST', body: { nickname: '小明', password: 'password1' }
        });
        assert.equal(login.status, 200);
        const me = await api(base, '/api/me', { token: login.body.token });
        assert.equal(me.body.nickname, '小明');
        assert.equal(me.body.courseCount, 1);

        // 新注册的账号也走同一条加解密路径
        const reg = await api(base, '/api/register', {
            method: 'POST', body: { nickname: '小红', password: 'password2' }
        });
        assert.equal(reg.status, 200);
        const put = await api(base, '/api/me/courses', {
            method: 'PUT', token: reg.body.token, body: { courses: [COURSE] }
        });
        assert.equal(put.status, 200);
        const meB = await api(base, '/api/me', { token: reg.body.token });
        assert.equal(meB.body.nickname, '小红');
        assert.equal(meB.body.courseCount, 1);

        // 落盘的是密文
        const text = fs.readFileSync(usersFile(dir), 'utf8');
        assert.ok(!text.includes('小明'), '文件里不该有明文昵称');
        assert.ok(!text.includes('小红'));
        assert.ok(!text.includes('大学英语'));
        assert.ok(!text.includes(path.basename(dir)), '不该泄漏路径');

        // 群组详情（含对外备注的解密）也能正常返回
        const groups = await api(base, '/api/me/groups', { token: login.body.token });
        assert.equal(groups.status, 200);
        assert.equal(groups.body.groups.length, 1);
    } finally {
        await stop();
    }
});
