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

const { createServer, resolveVault } = require('../server.js');
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
        // repoDir 指到这个空目录：本机开发那把 .tongge/key.env 不在那儿，
        // 于是"没有钥匙"这件事才是真的没有
        await assert.rejects(
            () => createServer({ captcha: false, dataDir: dir, repoDir: dir, port: 0, skipCleanup: true }),
            /TONGGE_ROOT_KEY/
        );
    } finally {
        if (saved !== undefined) process.env.TONGGE_ROOT_KEY = saved;
    }
});

test('本机开发钥匙文件：非 production 时认，production 时绝不认', () => {
    const dir = newDir();
    fs.mkdirSync(path.join(dir, '.tongge'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tongge', 'key.env'), 'TONGGE_ROOT_KEY=' + 'a'.repeat(64) + '\n');

    const savedKey = process.env.TONGGE_ROOT_KEY;
    const savedEnv = process.env.NODE_ENV;
    delete process.env.TONGGE_ROOT_KEY;
    try {
        const v = resolveVault({ repoDir: dir });
        assert.ok(v, '非 production 下应当认这个文件');
        assert.equal(v.keySource, '本机开发文件 .tongge/key.env', '横幅要能说出钥匙是从哪来的');

        // 镜像里 NODE_ENV=production —— 部署目录里就算躺着 key.env 也不许认，
        // 否则本地那把钥匙会悄悄顶替线上那把（表现是解密全线失败）
        process.env.NODE_ENV = 'production';
        assert.throws(() => resolveVault({ repoDir: dir }), /TONGGE_ROOT_KEY/);
    } finally {
        if (savedKey !== undefined) process.env.TONGGE_ROOT_KEY = savedKey;
        if (savedEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedEnv;
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

// ---------------------------------------------------------------- 超管与备注访问

/** 造一个「超管 + 普通管理员 + 一位同学」的场景（同学给小管起过备注） */
async function seedSuperScene(dir) {
    const store = createStore(dir);
    await store.init();
    const boss = await store.createUser('老板', 'password1');
    const adm = await store.createUser('小管', 'password2');
    const pal = await store.createUser('同学', 'password3');
    await store.setUserAdmin(adm.id, true);
    await store.transferSuper(boss.id);
    await store.setRemark(pal.id, adm.id, '外号小管');
    return { store, boss, adm, pal };
}

const login = async (base, nickname, password) => {
    const r = await api(base, '/api/login', { method: 'POST', body: { nickname, password } });
    assert.equal(r.status, 200, `登录失败：${nickname}`);
    return r.body.token;
};

test('超管的权限谁都动不了：撤不掉、删不掉、重置不了密码', async () => {
    const dir = newDir();
    const { store, boss, adm } = await seedSuperScene(dir);
    const { base, stop } = await startServer({ dataDir: dir, vault: false });
    try {
        const adminTok = await login(base, '小管', 'password2');
        const bossTok = await login(base, '老板', 'password1');

        // 普通管理员碰不到超管（这三条在改造前都是能过的，尤其是删号和重置密码）
        assert.equal((await api(base, `/api/admin/users/${boss.id}/admin`, {
            method: 'PUT', token: adminTok, body: { admin: false }
        })).status, 403);
        assert.equal((await api(base, `/api/admin/users/${boss.id}`, {
            method: 'DELETE', token: adminTok
        })).status, 403);
        assert.equal((await api(base, `/api/admin/users/${boss.id}/reset-password`, {
            method: 'POST', token: adminTok, body: {}
        })).status, 403);

        // 超管自己也撤不掉自己
        assert.equal((await api(base, `/api/admin/users/${boss.id}/admin`, {
            method: 'PUT', token: bossTok, body: { admin: false }
        })).status, 403);
        // 也不能删自己（先撞上"不能删自己"那条守卫）
        const selfDel = await api(base, `/api/admin/users/${boss.id}`, { method: 'DELETE', token: bossTok });
        assert.ok([400, 403].includes(selfDel.status), `实际 ${selfDel.status}`);

        // 把别人提成管理员不会顺带产生第二个超管
        await api(base, `/api/admin/users/${adm.id}/admin`, {
            method: 'PUT', token: bossTok, body: { admin: true }
        });
        assert.equal(await store.countSupers(), 1);
        assert.equal(!!(await store.getUser(adm.id)).super, false);

        // 仓储层也拦着（纵深防御：将来新增一条路由忘了守卫也不会漏）
        await assert.rejects(() => store.setUserAdmin(boss.id, false), /超级管理员的权限不能改/);
        await assert.rejects(() => store.deleteUser(boss.id), /超级管理员不能被删除/);
        await assert.rejects(() => store.resetUserPassword(boss.id), /不能重置超级管理员的密码/);
    } finally {
        await stop();
    }
});

test('备注访问接口：只有超管能用，且只记审计不记内容', async () => {
    const dir = newDir();
    const { store, adm, pal } = await seedSuperScene(dir);
    const { base, stop } = await startServer({ dataDir: dir, vault: false });
    try {
        const adminTok = await login(base, '小管', 'password2');
        const bossTok = await login(base, '老板', 'password1');

        // 普通管理员：看不了别人的备注
        assert.equal((await api(base, `/api/admin/users/${pal.id}/notes`, { token: adminTok })).status, 403);

        // 超管：看得到，而且拿到的是明文
        const ok = await api(base, `/api/admin/users/${pal.id}/notes`, { token: bossTok });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.nickname, '同学');
        assert.equal(ok.body.remarks[adm.id], '外号小管');

        // 审计留痕，但不许把备注内容写进去
        const row = (await store.readAudit(50)).find((x) => x.event === 'notes_view');
        assert.ok(row, '应当留一条 notes_view 审计');
        assert.equal(row.target, '同学');
        assert.equal(row.count, 1);
        assert.ok(!JSON.stringify(row).includes('外号小管'), '审计里不能出现备注内容');

        // 不存在的账号：404（而不是 500）
        assert.equal((await api(base, '/api/admin/users/u_nobody/notes', { token: bossTok })).status, 404);
    } finally {
        await stop();
    }
});
