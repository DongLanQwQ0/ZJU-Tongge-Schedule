'use strict';

/**
 * 全量覆盖：管理接口 + 备注接口。
 *
 * 这两块是后加的，之前的 server.test.js 一行都没测到 —— 实际上第一次写
 * 重置密码时就是因为服务器还在跑旧代码，路由压根没挂上而返回 404。
 * 所以这里除了功能断言，还有一条「每条路由都真的挂上了」的体检。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server.js');

let server;
let base;

const LIMITS = {
    registerBurst: { windowMs: 60000, max: 1000, message: 'x' },
    register: { windowMs: 3600000, max: 1000, message: 'x' },
    join: { windowMs: 60000, max: 1000, message: 'x' },
    loginFail: { windowMs: 600000, max: 1000, message: 'x' }
};

before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-admin-'));
    server = await createServer({ vault: false, captcha: false, dataDir, port: 0, skipCleanup: true, limits: LIMITS });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((r) => server.close(r));
});

async function call(host, pathname, opts = {}) {
    const method = opts.method || 'GET';
    const headers = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    // GET/HEAD 带 body 会被 fetch 直接拒掉，别发
    const hasBody = opts.body !== undefined && method !== 'GET' && method !== 'HEAD';
    if (hasBody) headers['Content-Type'] = 'application/json';
    const res = await fetch(host + pathname, {
        method,
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
}

const api = (pathname, opts) => call(base, pathname, opts);

/**
 * 有些断言只在「全局就一个管理员」时才有意义，共用的 server 攒不出这个状态
 * （前面的用例已经造出好几个管理员了），只能单开一台。
 */
async function withFreshServer(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-fresh-'));
    const srv = await createServer({ vault: false, captcha: false, dataDir: dir, port: 0, skipCleanup: true, limits: LIMITS });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const host = `http://127.0.0.1:${srv.address().port}`;
    try {
        await fn((p, o) => call(host, p, o), srv);
    } finally {
        await new Promise((r) => srv.close(r));
    }
}

const COURSE = {
    course: '大学英语Ⅲ', day: 1, startPeriod: 3, endPeriod: 4,
    startTime: '10:00', endTime: '11:35', location: '紫金港东6-328',
    dates: ['20260914', '20260921']
};

let seq = 0;
async function mkUser(prefix, password = 'pw123456') {
    seq += 1;
    const nickname = `${prefix}${seq}`;
    const r = await api('/api/register', { method: 'POST', body: { nickname, password } });
    assert.equal(r.status, 200, `注册 ${nickname} 失败：${JSON.stringify(r.body)}`);
    return { id: r.body.userId, nickname, password, token: r.body.token };
}

async function mkAdmin(prefix) {
    const u = await mkUser(prefix);
    await server.store.setUserAdmin(u.id, true);
    return u;
}

/** 群主视角：这个群现在能用的那枚票（入群只认票，群码是地址、不是票） */
async function liveTicket(code, ownerToken) {
    const d = await api(`/api/groups/${code}`, { token: ownerToken });
    const live = (d.body.invites || []).filter((i) => i.active);
    assert.ok(live.length, `群 ${code} 没有能用的票，测试进不去`);
    return live[0].code;
}

/** 新建一个「管理员 + 普通用户 + 一个群（两人都在）」的干净场景 */
async function scene() {
    const admin = await mkAdmin('管');
    const a = await mkUser('甲');
    const b = await mkUser('乙');
    const g = await api('/api/groups', { method: 'POST', token: a.token, body: { name: '测试群' } });
    assert.equal(g.status, 200);
    const code = g.body.code;
    await api(`/api/groups/${await liveTicket(code, a.token)}/join`, { method: 'POST', token: b.token, body: {} });
    return { admin, a, b, code };
}

// ---------------------------------------------------------------- 路由体检

test('26 条路由全部真的挂上了（没有一条落到「接口不存在」）', async () => {
    const code = '12345678';
    const uid = 'u_nobody01';
    // [方法, 路径, 该路由「正常响应」时不该出现的状态]
    const routes = [
        ['GET', '/api/meta'],
        ['POST', '/api/register'],
        ['POST', '/api/login'],
        ['POST', '/api/logout'],
        ['GET', '/api/me'],
        ['PUT', '/api/me/courses'],
        ['PUT', '/api/me/password'],
        ['PUT', `/api/me/remarks/${uid}`],
        ['DELETE', '/api/me'],
        ['GET', '/api/me/groups'],
        ['POST', '/api/groups'],
        ['POST', `/api/groups/${code}/join`],
        ['GET', `/api/groups/${code}`],
        ['PUT', `/api/groups/${code}/settings`],
        ['POST', `/api/groups/${code}/transfer`],
        ['PUT', `/api/groups/${code}/self-remark`],
        ['POST', `/api/groups/${code}/requests/${uid}/approve`],
        ['DELETE', `/api/groups/${code}/requests/${uid}`],
        ['DELETE', `/api/groups/${code}/me`],
        ['DELETE', `/api/groups/${code}/members/${uid}`],
        ['DELETE', `/api/groups/${code}`],
        ['GET', '/api/admin/overview'],
        ['PUT', `/api/admin/users/${uid}/admin`],
        ['DELETE', `/api/admin/users/${uid}`],
        ['POST', `/api/admin/users/${uid}/reset-password`],
        ['DELETE', `/api/admin/groups/${code}`]
    ];
    assert.equal(routes.length, 26, '路由清单要和 server.js 对齐');

    for (const [method, p] of routes) {
        const r = await api(p, { method, body: method === 'GET' ? undefined : {} });
        assert.notEqual(r.body && r.body.error, '接口不存在',
            `${method} ${p} 没有挂上路由`);
    }
});

test('未登录时所有受保护路由都是 401（不是 404）', async () => {
    const uid = 'u_nobody01';
    for (const [method, p] of [
        ['GET', '/api/admin/overview'],
        ['PUT', `/api/admin/users/${uid}/admin`],
        ['DELETE', `/api/admin/users/${uid}`],
        ['POST', `/api/admin/users/${uid}/reset-password`],
        ['DELETE', '/api/admin/groups/12345678']
    ]) {
        const r = await api(p, { method, body: {} });
        assert.equal(r.status, 401, `${method} ${p}`);
    }
});

test('普通账号访问全部管理接口都是 403', async () => {
    const u = await mkUser('普通');
    for (const [method, p] of [
        ['GET', '/api/admin/overview'],
        ['PUT', `/api/admin/users/${u.id}/admin`],
        ['DELETE', `/api/admin/users/${u.id}`],
        ['POST', `/api/admin/users/${u.id}/reset-password`],
        ['DELETE', '/api/admin/groups/12345678']
    ]) {
        const r = await api(p, { method, token: u.token, body: {} });
        assert.equal(r.status, 403, `${method} ${p}`);
    }
});
test('伪造 / 过期令牌一律 401', async () => {
    assert.equal((await api('/api/admin/overview', { token: 'not-a-token' })).status, 401);
    assert.equal((await api('/api/admin/overview', { token: '' })).status, 401);
});

// ---------------------------------------------------------------- 概览

test('概览：统计数字自洽，且绝不夹带密码字段', async () => {
    const { admin, a, code } = await scene();
    await api('/api/me/courses', { method: 'PUT', token: a.token, body: { courses: [COURSE] } });

    const r = await api('/api/admin/overview', { token: admin.token });
    assert.equal(r.status, 200);

    const s = r.body.stats;
    assert.equal(s.userCount, r.body.users.length);
    assert.equal(s.adminCount, r.body.users.filter((u) => u.admin).length);
    assert.equal(s.groupCount, r.body.groups.length);
    assert.equal(s.courseUploaded, r.body.users.filter((u) => u.courseCount > 0).length);
    assert.equal(s.dormantCount, r.body.users.filter((u) => u.dormant).length);
    assert.ok(Array.isArray(r.body.audit));
    assert.ok(r.body.groups.some((g) => g.code === code), '群组列表里应有刚建的群');

    for (const u of r.body.users) {
        for (const bad of ['pwHash', 'pwSalt', 'pwAlgo', 'password', 'remarks']) {
            assert.equal(bad in u, false, `概览不该返回 ${bad}`);
        }
    }
});

test('概览：登录活动字段齐全（最后登录时间 / IP / 次数）', async () => {
    const { admin } = await scene();
    const r = await api('/api/admin/overview', { token: admin.token });
    const me = r.body.users.find((u) => u.id === admin.id);
    assert.ok(me.lastLoginAt > 0, '应有最后登录时间');
    assert.equal(typeof me.lastLoginIp, 'string');
    assert.ok(me.loginCount >= 1, '注册即算一次登录');
    assert.equal(typeof me.idleDays, 'number');
    assert.equal(typeof me.dormant, 'boolean');
});

test('最后登录时间会随每次登录推进', async () => {
    const u = await mkUser('记时');
    const first = (await server.store.getUser(u.id)).lastLoginAt;
    assert.ok(first > 0);
    await new Promise((r) => setTimeout(r, 5));
    await api('/api/login', { method: 'POST', body: { nickname: u.nickname, password: u.password } });
    const second = (await server.store.getUser(u.id)).lastLoginAt;
    assert.ok(second >= first, '再登录一次，时间不应倒退');
    assert.ok((await server.store.getUser(u.id)).loginCount >= 2);
});

test('改密码 / 注销时的密码校验不会被记成「登录」', async () => {
    const u = await mkUser('不记');
    const before = (await server.store.getUser(u.id)).loginCount;
    // 故意用错密码去撞改密码接口，这条路径不该增加登录次数
    await api('/api/me/password', { method: 'PUT', token: u.token, body: { oldPassword: '错的', newPassword: 'newpw123' } });
    await api('/api/me', { method: 'DELETE', token: u.token, body: { password: '错的' } });
    assert.equal((await server.store.getUser(u.id)).loginCount, before);
});

// ---------------------------------------------------------------- 授权 / 撤管

test('授权后对方立刻拿到管理接口权限，撤掉后立刻失去', async () => {
    const { admin, a } = await scene();
    assert.equal((await api('/api/admin/overview', { token: a.token })).status, 403);

    await api(`/api/admin/users/${a.id}/admin`, { method: 'PUT', token: admin.token, body: { admin: true } });
    assert.equal((await api('/api/admin/overview', { token: a.token })).status, 200);

    await api(`/api/admin/users/${a.id}/admin`, { method: 'PUT', token: admin.token, body: { admin: false } });
    assert.equal((await api('/api/admin/overview', { token: a.token })).status, 403);
});

test('唯一的管理员不能撤自己，也不能删自己 —— 否则这扇门永久锁死', async () => {
    await withFreshServer(async (fresh, srv) => {
        const reg = await fresh('/api/register', {
            method: 'POST', body: { nickname: '独苗', password: 'pw123456' }
        });
        assert.equal(reg.status, 200);
        await srv.store.setUserAdmin(reg.body.userId, true);
        assert.equal(await srv.store.countAdmins(), 1, '这台机器上应当只有它一个管理员');

        const revoke = await fresh(`/api/admin/users/${reg.body.userId}/admin`, {
            method: 'PUT', token: reg.body.token, body: { admin: false }
        });
        assert.equal(revoke.status, 400);
        assert.match(revoke.body.error, /唯一的管理员/);

        const del = await fresh(`/api/admin/users/${reg.body.userId}`, {
            method: 'DELETE', token: reg.body.token, body: {}
        });
        assert.equal(del.status, 400);
        assert.match(del.body.error, /不能删自己/);

        // 试完还得是管理员
        assert.equal((await fresh('/api/admin/overview', { token: reg.body.token })).status, 200);
        assert.equal(await srv.store.countAdmins(), 1);
    });
});

test('有了第二个管理员之后，就可以撤自己了', async () => {
    const one = await mkAdmin('一号');
    const two = await mkAdmin('二号');
    assert.ok(await server.store.countAdmins() >= 2);

    const r = await api(`/api/admin/users/${one.id}/admin`, {
        method: 'PUT', token: one.token, body: { admin: false }
    });
    assert.equal(r.status, 200);
    // 撤完自己就没有权限了
    assert.equal((await api('/api/admin/overview', { token: one.token })).status, 403);
    // 另一个还在
    assert.equal((await api('/api/admin/overview', { token: two.token })).status, 200);
});

// ---------------------------------------------------------------- 删号 / 解散

test('管理员删号：群主身份移交给最早入群的成员', async () => {
    const admin = await mkAdmin('删管');
    const owner = await mkUser('原群主');
    const early = await mkUser('早来的');
    const late = await mkUser('晚来的');
    const g = await api('/api/groups', { method: 'POST', token: owner.token, body: { name: '移交群' } });
    const code = g.body.code;
    const ticket = await liveTicket(code, owner.token);
    await api(`/api/groups/${ticket}/join`, { method: 'POST', token: early.token, body: {} });
    await api(`/api/groups/${ticket}/join`, { method: 'POST', token: late.token, body: {} });

    const r = await api(`/api/admin/users/${owner.id}`, { method: 'DELETE', token: admin.token, body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.transferred, ['移交群']);

    const detail = await api(`/api/groups/${code}`, { token: early.token });
    assert.equal(detail.body.creatorId, early.id, '应移交给最早入群的');
    // 被删的人会话也没了
    assert.equal((await api('/api/me', { token: owner.token })).status, 401);
});

test('管理员删号：群里只剩 TA 一个人就解散', async () => {
    const admin = await mkAdmin('删管2');
    const loner = await mkUser('独行侠');
    const g = await api('/api/groups', { method: 'POST', token: loner.token, body: { name: '空群' } });
    const code = g.body.code;

    const r = await api(`/api/admin/users/${loner.id}`, { method: 'DELETE', token: admin.token, body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.disbanded, ['空群']);
    assert.equal(await server.store.readGroup(code), null);
});

test('管理员解散群组：不需要是群主', async () => {
    const { admin, code, a } = await scene();
    // 群主自己都删不掉别人的群 —— 先确认普通权限确实不够
    const outsider = await mkUser('外人');
    assert.equal((await api(`/api/groups/${code}`, { method: 'DELETE', token: outsider.token, body: {} })).status, 403);

    const r = await api(`/api/admin/groups/${code}`, { method: 'DELETE', token: admin.token, body: {} });
    assert.equal(r.status, 200);
    assert.equal(await server.store.readGroup(code), null);
    // 群没了，成员访问就是 404
    assert.equal((await api(`/api/groups/${code}`, { token: a.token })).status, 404);
});

test('解散不存在的群 -> 404', async () => {
    const admin = await mkAdmin('删管3');
    const r = await api('/api/admin/groups/99999999', { method: 'DELETE', token: admin.token, body: {} });
    assert.equal(r.status, 404);
});

// ---------------------------------------------------------------- 重置密码

test('重置密码：新密码能登、旧密码作废、旧会话立刻失效', async () => {
    const { admin, b } = await scene();
    const oldToken = b.token;

    const r = await api(`/api/admin/users/${b.id}/reset-password`, { method: 'POST', token: admin.token, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.nickname, b.nickname);
    assert.equal(typeof r.body.password, 'string');
    assert.ok(r.body.password.length >= 12, '临时密码不该太短');

    // 旧密码作废
    const oldLogin = await api('/api/login', { method: 'POST', body: { nickname: b.nickname, password: b.password } });
    assert.equal(oldLogin.status, 401);
    // 新密码可用
    const newLogin = await api('/api/login', { method: 'POST', body: { nickname: b.nickname, password: r.body.password } });
    assert.equal(newLogin.status, 200);
    // 旧会话被吊销
    assert.equal((await api('/api/me', { token: oldToken })).status, 401);
});

test('重置密码：明文不落盘，盘上还是 scrypt 哈希', async () => {
    const { admin, b } = await scene();
    const r = await api(`/api/admin/users/${b.id}/reset-password`, { method: 'POST', token: admin.token, body: {} });
    const pw = r.body.password;

    const raw = await fs.promises.readFile(path.join(server.store.dataDir, 'users.json'), 'utf8');
    assert.equal(raw.includes(pw), false, '明文密码不能出现在 users.json 里');

    const u = await server.store.getUser(b.id);
    assert.equal(u.pwAlgo, 'scrypt');
    assert.equal(u.pwHash, undefined === u.pwHash ? '' : u.pwHash);
    assert.ok(u.pwSalt && u.pwHash);
    assert.equal(typeof u.password, 'undefined');
});

test('重置密码：两次生成的不一样，且不含易混字符', async () => {
    const { admin, b } = await scene();
    const seen = new Set();
    for (let i = 0; i < 8; i++) {
        const r = await api(`/api/admin/users/${b.id}/reset-password`, { method: 'POST', token: admin.token, body: {} });
        seen.add(r.body.password);
        assert.equal(/[0O1lI]/.test(r.body.password), false, '临时密码不该含 0/O/1/l/I');
    }
    assert.equal(seen.size, 8, '每次都应该不一样');
});

test('重置密码：不存在的账号 -> 404', async () => {
    const admin = await mkAdmin('重置管');
    const r = await api('/api/admin/users/u_nobody01/reset-password', { method: 'POST', token: admin.token, body: {} });
    assert.equal(r.status, 404);
});

// ---------------------------------------------------------------- 备注

test('备注：设置、覆盖、清空；给自己加被拒；超长被拒', async () => {
    const { a, b } = await scene();

    let r = await api(`/api/me/remarks/${b.id}`, { method: 'PUT', token: a.token, body: { remark: '小灰灰' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.remarks[b.id], '小灰灰');

    r = await api(`/api/me/remarks/${b.id}`, { method: 'PUT', token: a.token, body: { remark: '另一个' } });
    assert.equal(r.body.remarks[b.id], '另一个');

    r = await api(`/api/me/remarks/${b.id}`, { method: 'PUT', token: a.token, body: { remark: '' } });
    assert.equal(b.id in r.body.remarks, false, '空串应清掉备注');

    assert.equal((await api(`/api/me/remarks/${a.id}`, {
        method: 'PUT', token: a.token, body: { remark: '我自己' }
    })).status, 400);

    assert.equal((await api(`/api/me/remarks/${b.id}`, {
        method: 'PUT', token: a.token, body: { remark: '一'.repeat(13) }
    })).status, 400);
});

test('备注：别人的备注看不到，也不影响对方', async () => {
    const { a, b } = await scene();
    await api(`/api/me/remarks/${b.id}`, { method: 'PUT', token: a.token, body: { remark: '只有我叫' } });

    const mine = await api('/api/me', { token: a.token });
    assert.equal(mine.body.remarks[b.id], '只有我叫');

    const his = await api('/api/me', { token: b.token });
    assert.equal(b.id in (his.body.remarks || {}), false, '不该看到别人给我起的备注');
});

test('对外备注：成员可设、非成员 403、超长 400、空串恢复', async () => {
    const { a, b, code } = await scene();

    let r = await api(`/api/groups/${code}/self-remark`, { method: 'PUT', token: b.token, body: { remark: '三班-乙' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.selfRemark, '三班-乙');

    // 甲看群详情，能拿到乙的对外备注，但昵称不变
    const detail = await api(`/api/groups/${code}`, { token: a.token });
    const mb = detail.body.members.find((m) => m.id === b.id);
    assert.equal(mb.selfRemark, '三班-乙');
    assert.equal(mb.nickname, b.nickname);

    const outsider = await mkUser('群外');
    assert.equal((await api(`/api/groups/${code}/self-remark`, {
        method: 'PUT', token: outsider.token, body: { remark: '偷改' }
    })).status, 403);

    assert.equal((await api(`/api/groups/${code}/self-remark`, {
        method: 'PUT', token: b.token, body: { remark: '一'.repeat(13) }
    })).status, 400);

    await api(`/api/groups/${code}/self-remark`, { method: 'PUT', token: b.token, body: { remark: '' } });
    const after = await api(`/api/groups/${code}`, { token: a.token });
    assert.equal(after.body.members.find((m) => m.id === b.id).selfRemark, '');
});

// ---------------------------------------------------------------- 审计

test('管理动作都写进审计日志（但不记密码）', async () => {
    const { admin, b, code } = await scene();
    await api(`/api/admin/users/${b.id}/admin`, { method: 'PUT', token: admin.token, body: { admin: true } });
    const r = await api(`/api/admin/users/${b.id}/reset-password`, { method: 'POST', token: admin.token, body: {} });
    await api('/api/admin/groups/' + code, { method: 'DELETE', token: admin.token, body: {} });

    const audit = await server.store.readAudit(200);
    const events = audit.map((e) => e.event);
    for (const ev of ['admin_grant', 'admin_reset_password', 'admin_delete_group']) {
        assert.ok(events.includes(ev), `审计里应该有 ${ev}`);
    }
    const reset = audit.find((e) => e.event === 'admin_reset_password');
    assert.equal(reset.by, admin.nickname);
    assert.equal(reset.target, b.nickname);
    assert.equal(JSON.stringify(audit).includes(r.body.password), false, '审计里不能出现明文密码');
});

test('审计日志按时间倒序，最新的在最前', async () => {
    const audit = await server.store.readAudit(50);
    for (let i = 1; i < audit.length; i++) {
        assert.ok(audit[i - 1].at >= audit[i].at, '审计应从新到旧');
    }
});
