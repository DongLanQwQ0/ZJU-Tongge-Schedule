'use strict';

/**
 * 活跃度统计的接口层：权限、窗口白名单、三种口径、活跃榜、落盘。
 *
 * 纯函数口径（去重、留存、折线）在 stats.test.js；桶的读写规则在 stats-store.test.js。
 * 这里测的是「真的走一遍 HTTP 之后，记进去的东西对不对」。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server.js');

let server;
let base;
let dataDir;

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-metrics-'));
    server = await createServer({
        vault: false, captcha: false, dataDir, port: 0, skipCleanup: true,
        limits: {
            registerBurst: { windowMs: 60000, max: 1000, message: 'x' },
            register: { windowMs: 3600000, max: 1000, message: 'x' },
            join: { windowMs: 60000, max: 1000, message: 'x' }
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((r) => server.close(r));
});

async function api(pathname, opts = {}) {
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

const COURSE = {
    course: '大学英语Ⅲ', day: 1, startPeriod: 3, endPeriod: 4,
    startTime: '10:00', endTime: '11:35', location: '紫金港东6-328',
    dates: ['20260914', '20260921']
};

let seq = 0;
async function reg(nick) {
    seq += 1;
    const r = await api('/api/register', {
        method: 'POST', body: { nickname: nick || `统计${seq}`, password: 'password1' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.userId, token: r.body.token, nickname: r.body.nickname };
}

/** 群主视角：这个群现在能用的那枚票 */
async function liveTicket(code, ownerToken) {
    const d = await api(`/api/groups/${code}`, { token: ownerToken });
    const live = (d.body.invites || []).filter((i) => i.active);
    assert.ok(live.length, '新群应当自带一枚能用的默认链接');
    return live[0].code;
}

async function stats(token, days) {
    const r = await api('/api/admin/stats' + (days == null ? '' : `?days=${days}`), { token });
    return r;
}

// ---------------------------------------------------------------- 权限与参数

test('统计只有管理员能看：未登录 401、普通用户 403', async () => {
    const mate = await reg('普通统计人');
    assert.equal((await api('/api/admin/stats')).status, 401);
    assert.equal((await stats(mate.token)).status, 403);
});

test('窗口只认 7 / 30 / 90，别的一律 400（不静默回落）', async () => {
    const boss = await reg('统计管理员');
    await server.store.setUserAdmin(boss.id, true);

    const def = await stats(boss.token);
    assert.equal(def.status, 200);
    assert.equal(def.body.days, 30, '不带参数就是 30 天');
    assert.equal(def.body.series.length, 30, '序列是连续的日历天');

    for (const [d, n] of [[7, 7], [30, 30], [90, 90]]) {
        const r = await stats(boss.token, d);
        assert.equal(r.status, 200);
        assert.equal(r.body.days, n);
        assert.equal(r.body.series.length, n);
    }
    for (const bad of [13, 0, -7, 'abc', '7.5']) {
        const r = await stats(boss.token, bad);
        assert.equal(r.status, 400, `days=${bad} 应当被拒`);
        assert.match(r.body.error, /7 \/ 30 \/ 90/);
    }
});

// ---------------------------------------------------------------- 三种口径

test('三种口径都记上：请求 / 登录 / 动作', async () => {
    const boss = await reg('口径管理员');
    await server.store.setUserAdmin(boss.id, true);

    const before = (await stats(boss.token, 7)).body;

    // 新账号：注册（注册级）+ 传课表（动作级）+ 建群（动作级）
    const u = await reg('口径小明');
    await api('/api/me/courses', { method: 'PUT', token: u.token, body: { courses: [COURSE] } });
    const g = await api('/api/groups', { method: 'POST', token: u.token, body: { name: '口径群' } });
    // 再登录一次（登录级）
    await api('/api/login', { method: 'POST', body: { nickname: u.nickname, password: 'password1' } });

    const after = (await stats(boss.token, 7)).body;
    const today = after.series[after.series.length - 1];
    const wasToday = before.series[before.series.length - 1];

    assert.equal(today.newUsers - wasToday.newUsers, 1, '当天新增应当 +1');
    assert.ok(today.logins > wasToday.logins, '登录次数应当涨');
    assert.ok(today.acts.course_upload > wasToday.acts.course_upload, '传课表要记一笔');
    assert.ok(today.acts.group_create > wasToday.acts.group_create, '建群要记一笔');
    assert.ok(today.active >= 2, '新账号和管理员都算当天活跃');

    // 活跃榜里有这个人，昵称是服务端补的（桶里只有 id）
    assert.ok(after.top.some((x) => x.id === u.id && x.nickname === u.nickname), '活跃榜要带上昵称');
    // 群里自带默认票，入群也算动作
    const mate = await reg('口径来客');
    await api(`/api/groups/${await liveTicket(g.body.code, u.token)}/join`, { method: 'POST', token: mate.token });
    const afterJoin = (await stats(boss.token, 7)).body;
    assert.equal(
        afterJoin.series[afterJoin.series.length - 1].acts.group_join
        - after.series[after.series.length - 1].acts.group_join, 1
    );
});

test('审批模式下的申请不算「加入」', async () => {
    const boss = await reg('审批统计管理员');
    await server.store.setUserAdmin(boss.id, true);
    const owner = await reg('审批统计群主');
    const g = await api('/api/groups', { method: 'POST', token: owner.token, body: { name: '审批统计群' } });
    const ticket = await liveTicket(g.body.code, owner.token);
    await api(`/api/groups/${g.body.code}/settings`, {
        method: 'PUT', token: owner.token, body: { joinMode: 'approval' }
    });

    const before = (await stats(boss.token, 7)).body;
    const applicant = await reg('统计申请人');
    const r = await api(`/api/groups/${ticket}/join`, { method: 'POST', token: applicant.token });
    assert.equal(r.body.pending, true, '这个群现在是审批模式');

    const after = (await stats(boss.token, 7)).body;
    assert.equal(
        after.series[after.series.length - 1].acts.group_join,
        before.series[before.series.length - 1].acts.group_join,
        '登记申请不是加入，不该记 group_join'
    );
});

test('请求级：同一个人访问多次，当天活跃只算一次，请求数照数', async () => {
    const boss = await reg('请求统计管理员');
    await server.store.setUserAdmin(boss.id, true);
    const u = await reg('请求小明');

    const r1 = (await stats(boss.token, 7)).body;
    const activeBefore = r1.series[r1.series.length - 1].active;
    const reqBefore = r1.summary.range.requests;

    for (let i = 0; i < 3; i++) {
        assert.equal((await api('/api/me', { token: u.token })).status, 200);
    }

    const r2 = (await stats(boss.token, 7)).body;
    const today = r2.series[r2.series.length - 1];
    assert.equal(today.active, activeBefore, '同一个人来三次，活跃人数不变（去重）');
    // 两次统计调用本身也是请求。3 次 /api/me + 这次统计读之前就已经记进去了 -> 差 4
    assert.equal(r2.summary.range.requests - reqBefore, 4, '请求数要一次不落：3 次 /api/me + 这次统计');
});

// ---------------------------------------------------------------- 汇总与空数据

test('区间汇总：跨天去重、人均课表、传过课表的人数', async () => {
    const boss = await reg('汇总管理员');
    await server.store.setUserAdmin(boss.id, true);
    const u = await reg('汇总小明');
    await api('/api/me/courses', { method: 'PUT', token: u.token, body: { courses: [COURSE] } });

    const body = (await stats(boss.token, 30)).body;
    assert.equal(body.from, (await stats(boss.token, 30)).body.series[0].day);
    assert.ok(body.summary.range.activeUnique >= 2, '老板与小明都活跃过');
    assert.ok(body.summary.range.avgRequestsPerActive > 0);
    assert.ok(body.summary.courseUploaded >= 1, '至少有一个人传过课表');
    assert.ok(body.summary.avgCourses > 0, '人均课表数来自账号表');
    // 90 天窗口里，最早的几天必然什么都没有
    const wide = (await stats(boss.token, 90)).body;
    assert.equal(wide.series[0].active, 0);
    assert.equal(wide.series[0].requests, 0);
    assert.equal(wide.summary.actions.group_create >= 0, true, '没发生的动作是 0，不是 undefined');
    assert.equal(wide.summary.retention7.cohort, 0, '7 天前还没有数据');
    assert.equal(wide.summary.retention7.rate, 0, '分母为 0 时给 0，不给 NaN');
});

test('落盘：flush 之后桶文件真的写下去了，且里面没有明文昵称', async () => {
    const boss = await reg('落盘管理员');
    await server.store.setUserAdmin(boss.id, true);
    await api('/api/me', { token: boss.token });

    const wrote = await server.store.stats.flush('测试');
    assert.ok(wrote >= 1, '有脏桶就该写出文件');

    const dir = path.join(dataDir, 'stats');
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    assert.equal(files.length, 1, '只写今天这一份');

    const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.users[boss.id], '桶里按账号 id 记');
    assert.equal(raw.includes(boss.nickname), false, '桶里不该出现昵称（那是要加密的东西）');
    assert.equal(files[0], saved.day + '.json');
});

test('清理顺带修剪老桶（统计保留 90 天）', async () => {
    const boss = await reg('修剪管理员');
    await server.store.setUserAdmin(boss.id, true);

    const dir = path.join(dataDir, 'stats');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, '2000-01-01.json');       // 老得离谱的一天
    fs.writeFileSync(old, JSON.stringify({ v: 1, day: '2000-01-01', requests: 1, logins: 0, newUsers: [], users: {} }), 'utf8');

    const removed = await server.store.cleanup();
    assert.equal(removed.statDays, 1, '清理要把过老的桶删掉');
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.statSync(dir).isDirectory(), '统计目录还在');
});
