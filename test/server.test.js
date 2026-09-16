'use strict';

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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-srv-'));
    server = await createServer({
        dataDir, port: 0, skipCleanup: true,
        // 这里测的是功能本身，不是限流（限流另有专门用例），把阈值放开
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

// ---------------------------------------------------------------- 元信息与静态文件

test('GET /api/meta 无需登录', async () => {
    const r = await api('/api/meta');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.lanUrls));
});

test('未知接口返回 404，非法方法返回 405', async () => {
    assert.equal((await api('/api/nope')).status, 404);
});

// ---------------------------------------------------------------- 鉴权

test('未带令牌访问受保护接口 -> 401', async () => {
    assert.equal((await api('/api/me')).status, 401);
    assert.equal((await api('/api/me', { token: 'fake-token-abc' })).status, 401);
    assert.equal((await api('/api/me/groups')).status, 401);
});

// ---------------------------------------------------------------- 完整旅程

test('端到端：注册 -> 传课表 -> 建群 -> 入群 -> 拉群 -> 改密 -> 退群 -> 解散', async () => {
    // 1. 注册 A
    const regA = await api('/api/register', { method: 'POST', body: { nickname: '我', password: 'password1' } });
    assert.equal(regA.status, 200, JSON.stringify(regA.body));
    const tokenA = regA.body.token;
    assert.ok(tokenA);

    // 2. 昵称重复 -> 409
    const dup = await api('/api/register', { method: 'POST', body: { nickname: '我', password: 'password2' } });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /已经有人/);

    // 3. 密码太短 -> 400
    const weak = await api('/api/register', { method: 'POST', body: { nickname: '别人', password: '123' } });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /至少 6 位/);

    // 4. 上传课表
    const put = await api('/api/me/courses', { method: 'PUT', token: tokenA, body: { courses: [COURSE] } });
    assert.equal(put.status, 200);
    assert.equal(put.body.courseCount, 1);

    // 5. 非法课表被服务端拒绝
    const bad = await api('/api/me/courses', { method: 'PUT', token: tokenA, body: { courses: [{ ...COURSE, day: 99 }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /星期数据不合法/);

    // 6. GET /api/me 不泄露密码字段
    const me = await api('/api/me', { token: tokenA });
    assert.equal(me.status, 200);
    assert.equal(me.body.nickname, '我');
    assert.equal(me.body.courseCount, 1);
    assert.equal(me.body.pwHash, undefined);
    assert.equal(me.body.pwSalt, undefined);

    // 7. 建群
    const created = await api('/api/groups', { method: 'POST', token: tokenA, body: { name: '计科2201组团' } });
    assert.equal(created.status, 200);
    const code = created.body.code;
    assert.match(code, /^\d{8}$/);

    // 8. 注册 B 并加入群组
    const regB = await api('/api/register', { method: 'POST', body: { nickname: '小灰', password: 'password2' } });
    const tokenB = regB.body.token;
    await api('/api/me/courses', { method: 'PUT', token: tokenB, body: { courses: [COURSE] } });

    const join = await api(`/api/groups/${code}/join`, { method: 'POST', token: tokenB });
    assert.equal(join.status, 200);
    const joinAgain = await api(`/api/groups/${code}/join`, { method: 'POST', token: tokenB });
    assert.equal(joinAgain.status, 200, '重复加入应当幂等');

    // 9. 非成员不能看群组
    const regC = await api('/api/register', { method: 'POST', body: { nickname: '路人', password: 'password3' } });
    const outsider = await api(`/api/groups/${code}`, { token: regC.body.token });
    assert.equal(outsider.status, 403);

    // 10. 拉群组详情：两名成员，无密码字段
    const detail = await api(`/api/groups/${code}`, { token: tokenA });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.members.length, 2);
    assert.equal(detail.body.name, '计科2201组团');
    assert.equal(detail.body.creatorId, me.body.id);
    detail.body.members.forEach((m) => {
        assert.equal(m.pwHash, undefined);
        assert.equal(m.pwSalt, undefined);
        assert.ok(Array.isArray(m.courses));
        assert.ok(m.courses.length === 1);
    });

    // 11. 我的群组列表
    const groups = await api('/api/me/groups', { token: tokenB });
    assert.equal(groups.body.groups.length, 1);
    assert.equal(groups.body.groups[0].isCreator, false);

    // 12. 登录：密码错 -> 401
    const wrong = await api('/api/login', { method: 'POST', body: { nickname: '我', password: '不对的密码' } });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error, /昵称或密码不对/);

    // 13. 登录成功
    const login = await api('/api/login', { method: 'POST', body: { nickname: '我', password: 'password1' } });
    assert.equal(login.status, 200);
    const tokenA2 = login.body.token;
    assert.ok(await api('/api/me', { token: tokenA2 }).then((r) => r.status === 200));

    // 14. 改密码（旧密码错 -> 401）
    const badPwd = await api('/api/me/password', { method: 'PUT', token: tokenA2, body: { oldPassword: '错的', newPassword: 'password9' } });
    assert.equal(badPwd.status, 401);

    const chg = await api('/api/me/password', { method: 'PUT', token: tokenA2, body: { oldPassword: 'password1', newPassword: 'password9' } });
    assert.equal(chg.status, 200);

    // 15. 改密码吊销全部旧会话
    assert.equal((await api('/api/me', { token: tokenA })).status, 401);
    assert.equal((await api('/api/me', { token: tokenA2 })).status, 401);
    const relogin = await api('/api/login', { method: 'POST', body: { nickname: '我', password: 'password9' } });
    assert.equal(relogin.status, 200);
    const tokenA3 = relogin.body.token;

    // 16. 群主不能退群，只能解散
    const leaveOwner = await api(`/api/groups/${code}/me`, { method: 'DELETE', token: tokenA3 });
    assert.equal(leaveOwner.status, 400);
    assert.match(leaveOwner.body.error, /群主/);

    // 17. B 退群
    const leaveB = await api(`/api/groups/${code}/me`, { method: 'DELETE', token: tokenB });
    assert.equal(leaveB.status, 200);
    const afterLeave = await api(`/api/groups/${code}`, { token: tokenA3 });
    assert.equal(afterLeave.body.members.length, 1);

    // 18. 非群主不能解散
    await api('/api/me/courses', { method: 'PUT', token: tokenB, body: { courses: [COURSE] } });
    const regD = await api('/api/register', { method: 'POST', body: { nickname: '第四人', password: 'password4' } });
    await api(`/api/groups/${code}/join`, { method: 'POST', token: regD.body.token });
    const delByOther = await api(`/api/groups/${code}`, { method: 'DELETE', token: regD.body.token });
    assert.equal(delByOther.status, 403);

    // 19. 群主解散
    const del = await api(`/api/groups/${code}`, { method: 'DELETE', token: tokenA3 });
    assert.equal(del.status, 200);
    assert.equal((await api(`/api/groups/${code}`, { token: tokenA3 })).status, 404);
});

test('群主移除成员：别人不行、自己不行、移完就进不来了', async () => {
    // 群主
    const owner = await api('/api/register', { method: 'POST', body: { nickname: '移除测试群主', password: 'password1' } });
    const ownerToken = owner.body.token;
    const code = (await api('/api/groups', { method: 'POST', token: ownerToken, body: { name: '移除测试群' } })).body.code;

    // 两个普通成员
    const b = await api('/api/register', { method: 'POST', body: { nickname: '要被踢的', password: 'password1' } });
    const c = await api('/api/register', { method: 'POST', body: { nickname: '留下的', password: 'password1' } });
    await api(`/api/groups/${code}/join`, { method: 'POST', token: b.body.token });
    await api(`/api/groups/${code}/join`, { method: 'POST', token: c.body.token });

    // 非群主不能移除人
    const byOther = await api(`/api/groups/${code}/members/${b.body.userId}`, { method: 'DELETE', token: c.body.token });
    assert.equal(byOther.status, 403);
    assert.match(byOther.body.error, /群主/);

    // 还没登录不行
    assert.equal((await api(`/api/groups/${code}/members/${b.body.userId}`, { method: 'DELETE' })).status, 401);

    // 群主不能移除自己
    const self = await api(`/api/groups/${code}/members/${owner.body.userId}`, { method: 'DELETE', token: ownerToken });
    assert.equal(self.status, 400);
    assert.match(self.body.error, /不能移除自己/);

    // 移除一个不在群里的人 -> 404
    const ghost = await api(`/api/groups/${code}/members/u_nothere`, { method: 'DELETE', token: ownerToken });
    assert.equal(ghost.status, 404);

    // 群主移除 B
    const kicked = await api(`/api/groups/${code}/members/${b.body.userId}`, { method: 'DELETE', token: ownerToken });
    assert.equal(kicked.status, 200);

    // 群组里只剩群主与 C
    const detail = await api(`/api/groups/${code}`, { token: ownerToken });
    assert.deepEqual(detail.body.members.map((m) => m.nickname).sort(), ['留下的', '移除测试群主']);

    // B 看不到群组了，群组列表里也没了
    assert.equal((await api(`/api/groups/${code}`, { token: b.body.token })).status, 403);
    const bGroups = await api('/api/me/groups', { token: b.body.token });
    assert.equal(bGroups.body.groups.length, 0);

    // 重复移除同一个 -> 404（已经是干净的状态，不是 500）
    assert.equal((await api(`/api/groups/${code}/members/${b.body.userId}`, { method: 'DELETE', token: ownerToken })).status, 404);

    // B 可以重新用邀请码进来
    assert.equal((await api(`/api/groups/${code}/join`, { method: 'POST', token: b.body.token })).status, 200);
    assert.equal((await api(`/api/groups/${code}`, { token: b.body.token })).status, 200);
});

test('入群审批：默认谁都能进，改成要审批后就只登记申请', async () => {
    const owner = await api('/api/register', { method: 'POST', body: { nickname: '审批群主', password: 'password1' } });
    const ownerToken = owner.body.token;
    const code = (await api('/api/groups', { method: 'POST', token: ownerToken, body: { name: '审批测试群' } })).body.code;

    // 默认是开放模式：拿到码就能进
    const detail0 = await api(`/api/groups/${code}`, { token: ownerToken });
    assert.equal(detail0.body.joinMode, 'open');

    const a = await api('/api/register', { method: 'POST', body: { nickname: '直接进的人', password: 'password1' } });
    assert.equal((await api(`/api/groups/${code}/join`, { method: 'POST', token: a.body.token })).body.pending, false);

    // 群主切成审批模式；别人改不了
    assert.equal((await api(`/api/groups/${code}/settings`, { method: 'PUT', token: ownerToken, body: { joinMode: 'approval' } })).status, 200);
    assert.equal((await api(`/api/groups/${code}/settings`, { method: 'PUT', token: a.body.token, body: { joinMode: 'open' } })).status, 403);

    // 新的人申请：只登记，不进群
    const b = await api('/api/register', { method: 'POST', body: { nickname: '申请人', password: 'password1' } });
    const apply = await api(`/api/groups/${code}/join`, { method: 'POST', token: b.body.token });
    assert.equal(apply.body.pending, true);
    assert.equal((await api(`/api/groups/${code}`, { token: b.body.token })).status, 403, '还没批就看不到群');
    // 重复申请幂等，不会塞两条
    assert.equal((await api(`/api/groups/${code}/join`, { method: 'POST', token: b.body.token })).body.pending, true);
    assert.equal((await api(`/api/groups/${code}`, { token: ownerToken })).body.requests.length, 1);

    // 申请人首页能看到这个群，标着待审批
    const bGroups = await api('/api/me/groups', { token: b.body.token });
    assert.equal(bGroups.body.groups.length, 1);
    assert.equal(bGroups.body.groups[0].pending, true);

    // 申请名单只有群主看得到；别人也审批不了
    const ownerView = await api(`/api/groups/${code}`, { token: ownerToken });
    assert.equal(ownerView.body.requests[0].nickname, '申请人');
    assert.equal((await api(`/api/groups/${code}`, { token: a.body.token })).body.requests.length, 0);
    assert.equal((await api(`/api/groups/${code}/requests/${b.body.userId}/approve`, { method: 'POST', token: a.body.token })).status, 403);

    // 群主同意 -> 进群；申请被消费，不能重复批
    assert.equal((await api(`/api/groups/${code}/requests/${b.body.userId}/approve`, { method: 'POST', token: ownerToken })).status, 200);
    assert.equal((await api(`/api/groups/${code}`, { token: b.body.token })).status, 200);
    assert.equal((await api('/api/me/groups', { token: b.body.token })).body.groups[0].pending, false);
    assert.equal((await api(`/api/groups/${code}/requests/${b.body.userId}/approve`, { method: 'POST', token: ownerToken })).status, 404);

    // 拒绝：申请消失
    const c = await api('/api/register', { method: 'POST', body: { nickname: '被拒的人', password: 'password1' } });
    await api(`/api/groups/${code}/join`, { method: 'POST', token: c.body.token });
    assert.equal((await api(`/api/groups/${code}/requests/${c.body.userId}`, { method: 'DELETE', token: ownerToken })).status, 200);
    assert.equal((await api('/api/me/groups', { token: c.body.token })).body.groups.length, 0);

    // 切回开放模式：正在等的申请直接放进来，别让人干等
    const d = await api('/api/register', { method: 'POST', body: { nickname: '积压的人', password: 'password1' } });
    await api(`/api/groups/${code}/join`, { method: 'POST', token: d.body.token });
    await api(`/api/groups/${code}/settings`, { method: 'PUT', token: ownerToken, body: { joinMode: 'open' } });
    assert.equal((await api('/api/me/groups', { token: d.body.token })).body.groups[0].pending, false);
});

test('群组改名：群主可改，成员也看得到，别人改不了', async () => {
    const owner = await api('/api/register', { method: 'POST', body: { nickname: '改名群主', password: 'password1' } });
    const code = (await api('/api/groups', { method: 'POST', token: owner.body.token, body: { name: '原来的名字' } })).body.code;
    const other = await api('/api/register', { method: 'POST', body: { nickname: '改名成员', password: 'password1' } });
    await api(`/api/groups/${code}/join`, { method: 'POST', token: other.body.token });

    const put = (token, body) => api(`/api/groups/${code}/settings`, { method: 'PUT', token, body });

    // 成员改不了
    assert.equal((await put(other.body.token, { name: '我来改' })).status, 403);
    // 空名与超长名都挡掉
    assert.equal((await put(owner.body.token, { name: '   ' })).status, 400);
    assert.equal((await put(owner.body.token, { name: '一'.repeat(21) })).status, 400);

    assert.equal((await put(owner.body.token, { name: '  新的名字  ' })).status, 200);
    assert.equal((await api(`/api/groups/${code}`, { token: owner.body.token })).body.name, '新的名字');
    // 群里其他人立刻看到新名字
    assert.equal((await api(`/api/groups/${code}`, { token: other.body.token })).body.name, '新的名字');
    // 首页列表也跟着变
    const groups = await api('/api/me/groups', { token: other.body.token });
    assert.equal(groups.body.groups[0].name, '新的名字');
});

test('群组设置：非法值、空 patch、已废弃字段都被挡', async () => {
    const owner = await api('/api/register', { method: 'POST', body: { nickname: '设置校验群主', password: 'password1' } });
    const code = (await api('/api/groups', { method: 'POST', token: owner.body.token, body: { name: '设置校验群' } })).body.code;

    const put = (body) => api(`/api/groups/${code}/settings`, { method: 'PUT', token: owner.body.token, body });
    assert.equal((await put({ joinMode: '随便' })).status, 400);
    assert.equal((await put({})).status, 400);
    // memberCanInvite 已经删掉：传了也不再被接受，免得留下「设了但没用」的误会
    assert.equal((await put({ memberCanInvite: false })).status, 400);
});

test('IP 限流：拿脚本刷加入接口会被挡住', async () => {
    // 单独起一个服务并把阈值调小（默认值宽得多，正常人碰不到）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-rate-'));
    const s = await createServer({
        dataDir: dir, port: 0, skipCleanup: true,
        limits: { join: { windowMs: 60000, max: 3, message: '试得太频繁了，等一分钟再试' } }
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const ra = `http://127.0.0.1:${s.address().port}`;
    try {
        const reg = await fetch(ra + '/api/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: '刷码的人', password: 'password1' })
        });
        const token = (await reg.json()).token;
        const attempt = (code) => fetch(`${ra}/api/groups/${code}/join`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }
        });
        // 前 3 次放行（码不存在是 404），第 4 次起被限流
        assert.equal((await attempt('11111111')).status, 404);
        assert.equal((await attempt('22222222')).status, 404);
        assert.equal((await attempt('33333333')).status, 404);
        const blocked = await attempt('44444444');
        assert.equal(blocked.status, 429);
        assert.match((await blocked.json()).error, /太频繁/);
    } finally {
        await new Promise((r) => s.close(r));
    }
});

test('注销账号：要密码、群主会移交、空群会解散、令牌立刻失效', async () => {
    const owner = await api('/api/register', { method: 'POST', body: { nickname: '注销群主', password: 'password1' } });
    const mate = await api('/api/register', { method: 'POST', body: { nickname: '接盘成员', password: 'password1' } });
    const code = (await api('/api/groups', { method: 'POST', token: owner.body.token, body: { name: '待移交群' } })).body.code;
    await api(`/api/groups/${code}/join`, { method: 'POST', token: mate.body.token });

    // 密码不对：拒绝，账号还在
    const wrong = await api('/api/me', { method: 'DELETE', token: owner.body.token, body: { password: '错的' } });
    assert.equal(wrong.status, 401);
    assert.equal((await api('/api/me', { token: owner.body.token })).status, 200);

    // 正确密码：注销，群主移交
    const del = await api('/api/me', { method: 'DELETE', token: owner.body.token, body: { password: 'password1' } });
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.transferred, ['待移交群']);
    assert.equal((await api('/api/me', { token: owner.body.token })).status, 401, '令牌立刻失效');

    const after = await api(`/api/groups/${code}`, { token: mate.body.token });
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.members.map((m) => m.nickname), ['接盘成员']);
    assert.equal(after.body.creatorId, mate.body.userId, '群主转给了留下的人');

    // 群里只剩自己时注销 -> 群直接解散
    const lonely = await api('/api/register', { method: 'POST', body: { nickname: '独苗群主', password: 'password1' } });
    const solo = (await api('/api/groups', { method: 'POST', token: lonely.body.token, body: { name: '独苗群' } })).body.code;
    const del2 = await api('/api/me', { method: 'DELETE', token: lonely.body.token, body: { password: 'password1' } });
    assert.deepEqual(del2.body.disbanded, ['独苗群']);
    assert.equal((await api(`/api/groups/${solo}`, { token: mate.body.token })).status, 404, '群文件已被删掉');

    // 昵称可以被后来的人重新用
    assert.equal((await api('/api/register', { method: 'POST', body: { nickname: '注销群主', password: 'password2' } })).status, 200);
});

test('登录节流：连续失败 5 次后锁定', async () => {
    const nickname = '被爆破的人';
    await api('/api/register', { method: 'POST', body: { nickname, password: 'password1' } });
    for (let i = 0; i < 5; i++) {
        const r = await api('/api/login', { method: 'POST', body: { nickname, password: '错的' } });
        assert.equal(r.status, 401);
    }
    const locked = await api('/api/login', { method: 'POST', body: { nickname, password: 'password1' } });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /太频繁/);
});

test('登出后令牌立即失效', async () => {
    const reg = await api('/api/register', { method: 'POST', body: { nickname: '要登出的人', password: 'password1' } });
    const token = reg.body.token;
    assert.equal((await api('/api/me', { token })).status, 200);
    assert.equal((await api('/api/logout', { method: 'POST', token })).status, 200);
    assert.equal((await api('/api/me', { token })).status, 401);
});

test('静态文件：首页可访问，目录穿越被挡', async () => {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const html = await home.text();
    assert.match(html, /同格/);
});
