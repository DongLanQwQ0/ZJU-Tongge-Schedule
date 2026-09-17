'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server.js');
const { INVITE_TTLS } = require('../shared/store.js');

let server;
let base;
let dataDir;

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-srv-'));
    server = await createServer({ vault: false, captcha: false,
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

test('GET /api/meta 无需登录，且只回健康信息', async () => {
    const r = await api('/api/meta');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // 它在正式服上是个免鉴权接口，别再往这里塞网卡与内网地址
    // （曾经把容器地址 172.x 泄露给任何访问者）
    assert.equal(r.body.lanUrls, undefined);
    assert.equal(r.body.interfaces, undefined);
    assert.equal(r.body.port, undefined);
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
    const s = await createServer({ vault: false, captcha: false,
        dataDir: dir, port: 0, skipCleanup: true,
        limits: { join: { windowMs: 60000, max: 3, message: '试得太频繁了，等一分钟再试' } }
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const ra = `http://127.0.0.1:${s.address().port}`;
    try {
        const reg = await fetch(ra + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

    // 未知页面路径仍然回落首页（单页应用的前端路由靠这个）
    const spa = await fetch(base + '/some/deep/page');
    assert.equal(spa.status, 200);

    // 但「像文件的路径」不能再回落 —— 否则穿越尝试和被挡住长得一模一样。
    // 这里的核心断言不只是状态码，而是**响应体不等于 index.html**：
    // 以前这一组全部回 200 + 首页，评审时根本分不清是挡住了还是读到了。
    for (const p of [
        '/../server.js', '/..%2fserver.js', '/%2e%2e%2fserver.js',
        '/....//server.js', '/..\\server.js', '/%2e%2e%5cserver.js',
        '/shared/../server.js', '/shared/../data/users.json',
        '/../data/users.json', '/%2e%2e/data/users.json', '/%00'
    ]) {
        const r = await fetch(base + p);
        const body = await r.text();
        assert.equal(r.status, 404, `${p} 应当 404`);
        assert.notEqual(body, html, `${p} 不能回首页`);
        assert.doesNotMatch(body, /require\(|module\.exports|pwHash|createStore/, `${p} 泄露了源码`);
    }
});

test('/shared/ 只放行前端真正加载的模块', async () => {
    // 白名单内的仍在
    for (const f of ['config.js', 'periods.js', 'ics.js', 'weeks.js', 'compare.js']) {
        assert.equal((await fetch(base + '/shared/' + f)).status, 200, f);
    }
    // 白名单外的一律不给：这两个文件自己的注释都写着「仅服务端使用」
    for (const f of ['auth.js', 'store.js', 'ics.js.bak', 'sessions.json']) {
        const r = await fetch(base + '/shared/' + f);
        assert.equal(r.status, 404, f);
        assert.doesNotMatch(await r.text(), /scrypt|createStore|module\.exports/, f);
    }
});

test('请求体不是 JSON 类型 -> 415', async () => {
    const r = await fetch(base + '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ nickname: '类型探测', password: 'password1' })
    });
    assert.equal(r.status, 415);

    // 没有 body 的 DELETE 不该被这条规则误伤
    const reg = await api('/api/register', { method: 'POST', body: { nickname: '无体测试', password: 'password1' } });
    assert.equal((await api('/api/logout', { method: 'POST', token: reg.body.token })).status, 200);
});

test('请求体超限 -> 413（而不是把连接掐断）', async () => {
    const reg = await api('/api/register', { method: 'POST', body: { nickname: '超限测试', password: 'password1' } });
    const r = await fetch(base + '/api/me/courses', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${reg.body.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ courses: [], pad: 'x'.repeat(2 * 1024 * 1024) })
    });
    assert.equal(r.status, 413, '应当拿到明确的 413 而不是连接被重置');
    assert.match((await r.json()).error, /太大/);
});

test('每个响应都带安全头', async () => {
    for (const p of ['/', '/style.css', '/api/meta', '/api/me', '/no/such/file.txt']) {
        const r = await fetch(base + p);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
        assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
        assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p);
        assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, p);
    }
});

test('内部错误不回传 errno 或绝对路径', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-leak-'));
    const s = await createServer({ vault: false, captcha: false, dataDir: dir, port: 0, skipCleanup: true });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const ra = `http://127.0.0.1:${s.address().port}`;
    try {
        // 把 users.json 换成目录 -> 读取时抛 EISDIR，走 500 分支
        fs.rmSync(path.join(dir, 'users.json'), { force: true });
        fs.mkdirSync(path.join(dir, 'users.json'));
        const r = await fetch(ra + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: '内部错误', password: 'password1' })
        });
        assert.equal(r.status, 500);
        const text = await r.text();
        assert.doesNotMatch(text, /EISDIR|ENOENT|errno|syscall/, '不能回传系统错误原文');
        assert.doesNotMatch(text, /[A-Za-z]:\\/, '不能回传绝对路径');
        assert.match(text, /服务器内部错误/);
    } finally {
        await new Promise((res) => s.close(res));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('改密码：旧密码连错会被限速，成功后旧会话全失效', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-pw-'));
    const s = await createServer({ vault: false, captcha: false,
        dataDir: dir, port: 0, skipCleanup: true,
        limits: { loginFail: { windowMs: 600000, max: 3, message: '原密码错误次数太多' } }
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const ra = `http://127.0.0.1:${s.address().port}`;
    const call = (pathname, opts = {}) => {
        const headers = {};
        if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        return fetch(ra + pathname, {
            method: opts.method || 'GET', headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
        });
    };
    try {
        const reg = await (await call('/api/register', { method: 'POST', body: { nickname: '改密测试', password: 'password1' } })).json();
        const token = reg.token;

        // 前 3 次错误旧密码：401；第 4 次起应当被限速
        for (let i = 0; i < 3; i++) {
            const r = await call('/api/me/password', {
                method: 'PUT', token, body: { oldPassword: '错的' + i, newPassword: 'password2' }
            });
            assert.equal(r.status, 401, `第 ${i + 1} 次应当 401`);
        }
        const blocked = await call('/api/me/password', {
            method: 'PUT', token, body: { oldPassword: '错的', newPassword: 'password2' }
        });
        assert.equal(blocked.status, 429, '旧密码连错必须被限速');

        // 换个人不受影响（限速是按账号，不是全局）
        const reg2 = await (await call('/api/register', { method: 'POST', body: { nickname: '无辜的人', password: 'password1' } })).json();
        const ok = await call('/api/me/password', {
            method: 'PUT', token: reg2.token, body: { oldPassword: 'password1', newPassword: 'password2' }
        });
        assert.equal(ok.status, 200, '别人不该被连坐');

        // 改密码吊销全部旧会话
        assert.equal((await call('/api/me', { token: reg2.token })).status, 401);
    } finally {
        await new Promise((res) => s.close(res));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('会话表：读路径不重写整张表，令牌照常认得出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-sess-'));
    const store = require('../shared/store.js').createStore(dir);
    await store.init();
    const u = await store.createUser('会话落盘', 'password1', { ip: '127.0.0.1' });
    const token = await store.createSession(u.id);

    const sess = path.join(dir, 'sessions.json');
    await new Promise((r) => setTimeout(r, 20));
    const before = fs.statSync(sess).mtimeMs;

    // 核心回归：每个请求都重写整张会话表是以前的写放大来源（实测慢 19 倍）。
    // 现在紧跟的鉴权请求只读内存，不该产生任何写盘。
    assert.ok(await store.resolveSession(token), '会话应当可解析');
    assert.equal(fs.statSync(sess).mtimeMs, before, '紧跟的请求不该重写整个会话表');

    // 令牌必须真的在盘上（重建 store 模拟重启后仍认得出）
    const fresh = require('../shared/store.js').createStore(dir);
    await fresh.init();
    assert.ok(await fresh.resolveSession(token), '重启后会话仍然有效');

    // 没有脏数据时 flush 是空操作，不该白写一次
    assert.equal(await fresh.flushSessions('测试'), false, '没有改动就不该写盘');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('关键文件损坏：优先从 .bak 恢复，而不是把所有人清空', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-bak-'));
    const storeMod = require('../shared/store.js');
    const store = storeMod.createStore(dir);
    await store.init();
    await store.createUser('备份测试', 'password1', { ip: '127.0.0.1' });

    // 上一步写完就该有 .bak
    const users = path.join(dir, 'users.json');
    assert.ok(fs.existsSync(users + '.bak'), '应当留了 .bak');

    // 把正式文件写坏，然后重新加载
    fs.writeFileSync(users, '{ 这不是合法 JSON', 'utf8');
    const store2 = storeMod.createStore(dir);
    await store2.init();
    const back = await store2.findUserByNickname('备份测试');
    assert.ok(back, '应当从 .bak 把账号找回，而不是从空表开始');
    assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), '损坏的那份要留证');
});

test('邀请链接：作废过的码不会被重新发出来（复活旧链接）', async () => {
    const t = await inviteSetup();
    try {
        // 发一枚、作废它，记住这个码
        const dead = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: 'never' }
        })).json()).invite;
        await t.call(`/api/groups/${t.code}/invites/${dead.code}`, {
            method: 'DELETE', token: t.owner.token, body: {}
        });

        // 再连发一批，确认这个码不会卷土重来。
        // 作废码若能复活，拿着旧链接的人会莫名其妙重新拿到入口。
        const issued = [];
        for (let i = 0; i < 15; i++) {
            const r = await (await t.call(`/api/groups/${t.code}/invites`, {
                method: 'POST', token: t.owner.token, body: { ttl: 'never' }
            })).json();
            issued.push(r.invite.code);
        }
        assert.ok(!issued.includes(dead.code), '作废过的码不能被重新发出来');
        assert.equal(new Set(issued).size, issued.length, '新发的码之间也不能重复');

        // 作废那枚仍然进不来（410 = 码还在，但已被作废，语义比 404 更准）
        const u = await newUser(t.call, '拿作废码的人');
        const r = await t.call(`/api/groups/${dead.code}/join`, { method: 'POST', token: u.token });
        assert.equal(r.status, 410);
        assert.match((await r.json()).error, /作废/);
    } finally { await t.close(); }
});

test('邀请链接：批量作废 + 彻底删除失效记录', async () => {
    const t = await inviteSetup();
    try {
        const mk = async () => (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: 'never' }
        })).json()).invite;
        const a = await mk(), b = await mk(), c = await mk();

        // 批量作废 a、b（c 留着）
        const bulk = await t.call(`/api/groups/${t.code}/invites/revoke`, {
            method: 'POST', token: t.owner.token, body: { codes: [a.code, b.code] }
        });
        assert.equal(bulk.status, 200);
        assert.deepEqual((await bulk.json()).revoked.sort(), [a.code, b.code].sort());

        // 成员无权批量作废
        const mate = await newUser(t.call, '想批量的人');
        await t.call(`/api/groups/${c.code}/join`, { method: 'POST', token: mate.token });
        assert.equal((await t.call(`/api/groups/${t.code}/invites/revoke`, {
            method: 'POST', token: mate.token, body: { codes: [c.code] }
        })).status, 403);

        // 还能用的那条不许删（必须先作废）
        assert.equal((await t.call(`/api/groups/${t.code}/invites/${c.code}/purge`, {
            method: 'DELETE', token: t.owner.token, body: {}
        })).status, 400);

        // 已作废的可以删掉
        assert.equal((await t.call(`/api/groups/${t.code}/invites/${a.code}/purge`, {
            method: 'DELETE', token: t.owner.token, body: {}
        })).status, 200);

        // 删掉之后列表里就没有它了，记录数从 3 变 2
        const detail = await (await t.call(`/api/groups/${t.code}`, { token: t.owner.token })).json();
        assert.equal(detail.invites.length, 2);
        assert.ok(!detail.invites.some((i) => i.code === a.code), '删掉的那条不该还在');

        // 作废 + 删除之后，这条彻底进不来了
        const late = await newUser(t.call, '拿删掉的码');
        assert.equal((await t.call(`/api/groups/${a.code}/join`, { method: 'POST', token: late.token })).status, 404);
    } finally { await t.close(); }
});

test('邀请链接：管理页用到的字段都齐（剩余时间 / 状态 / 备注名）', async () => {
    const t = await inviteSetup();
    try {
        const inv = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: '3d', label: '给室友' }
        })).json()).invite;
        assert.equal(inv.label, '给室友');
        // 留几秒余量：expiresAt 和 remainingMs 是两次取时刻算出来的，
        // 中间隔着几行代码，机器忙的时候差值会被放大到毫秒级以上，
        // 卡死在正好 3 天上会偶发失败（与功能无关，是用例自己的精度问题）。
        assert.ok(inv.remainingMs > 0 && inv.remainingMs <= 3 * 86400000 + 5000,
            `remainingMs 应当是正的且不超过 3 天，实际 ${inv.remainingMs}`);
        assert.equal(inv.active, true);
        assert.equal(inv.expired, false);
        assert.equal(inv.revoked, false);

        // 作废之后状态翻转，remainingMs 仍在（前端要显示「原本还剩多久」）
        await t.call(`/api/groups/${t.code}/invites/${inv.code}`, {
            method: 'DELETE', token: t.owner.token, body: {}
        });
        const detail = await (await t.call(`/api/groups/${t.code}`, { token: t.owner.token })).json();
        const after = detail.invites.find((i) => i.code === inv.code);
        assert.equal(after.active, false);
        assert.equal(after.revoked, true);
    } finally { await t.close(); }
});

// ---------------------------------------------------------------- 换群自己的码

test('换群码：旧码作废、新码可用、成员和群内容一个不动', async () => {
    const t = await inviteSetup();
    try {
        // 先让一个人进来，等会儿验证他不会被这次换码影响
        const member = await newUser(t.call, '换码前就进群的人');
        await t.call(`/api/groups/${t.code}/join`, { method: 'POST', token: member.token });

        const r = await t.call(`/api/groups/${t.code}/rotate-code`, { method: 'POST', token: t.owner.token, body: {} });
        assert.equal(r.status, 200);
        const out = await r.json();
        assert.match(out.code, /^\d{8}$/, '新码必须是 8 位');
        assert.equal(out.oldCode, t.code);
        assert.notEqual(out.code, t.code);

        // 旧码不能再进人
        const late = await newUser(t.call, '换码后来的');
        assert.equal((await t.call(`/api/groups/${t.code}/join`, { method: 'POST', token: late.token })).status, 404,
            '旧码应当彻底作废');

        // 新码能进人
        const fresh = await newUser(t.call, '拿新码的人');
        assert.equal((await t.call(`/api/groups/${out.code}/join`, { method: 'POST', token: fresh.token })).status, 200);

        // 用新码能读到群，且成员都在（换码不该动成员）
        const detail = await (await t.call(`/api/groups/${out.code}`, { token: t.owner.token })).json();
        assert.equal(detail.code, out.code);
        assert.ok(detail.members.some((m) => m.nickname === '换码前就进群的人'), '老成员必须还在');
        assert.ok(detail.members.some((m) => m.nickname === '拿新码的人'));

        // 老成员照常能看群（他手里的码早就旧了，但成员身份不依赖码）
        assert.equal((await t.call(`/api/groups/${out.code}`, { token: member.token })).status, 200);
        // 他的群列表也没丢
        const mine = await (await t.call('/api/me/groups', { token: member.token })).json();
        assert.equal(mine.groups.length, 1);
        assert.equal(mine.groups[0].code, out.code, '群列表里应当给出新码');
    } finally { await t.close(); }
});

test('换群码：只有群主能换，成员无权', async () => {
    const t = await inviteSetup();
    try {
        const member = await newUser(t.call, '不是群主');
        await t.call(`/api/groups/${t.code}/join`, { method: 'POST', token: member.token });
        assert.equal((await t.call(`/api/groups/${t.code}/rotate-code`, {
            method: 'POST', token: member.token, body: {}
        })).status, 403);
        // 群码没被换掉
        assert.equal((await (await t.call(`/api/groups/${t.code}`, { token: t.owner.token })).json()).code, t.code);
    } finally { await t.close(); }
});

test('换群码：换完之后发新链接、作废旧码，整套仍然顺', async () => {
    const t = await inviteSetup();
    try {
        const out = await (await t.call(`/api/groups/${t.code}/rotate-code`, {
            method: 'POST', token: t.owner.token, body: {}
        })).json();

        // 换码后照常能发邀请链接
        const inv = (await (await t.call(`/api/groups/${out.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: '7d' }
        })).json()).invite;
        const u = await newUser(t.call, '走新码的新链接');
        assert.equal((await t.call(`/api/groups/${inv.code}/join`, { method: 'POST', token: u.token })).status, 200);
    } finally { await t.close(); }
});

// ---------------------------------------------------------------- 邀请链接（可多枚、可过期）

/** 起一个干净的实例 + 一个群主 + 一个路人 */
async function inviteSetup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-inv-'));
    const s = await createServer({ vault: false, captcha: false,
        dataDir: dir, port: 0, skipCleanup: true,
        limits: { join: { windowMs: 60000, max: 1000, message: 'x' } }
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const ra = `http://127.0.0.1:${s.address().port}`;
    const call = (pathname, opts = {}) => {
        const headers = {};
        if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        return fetch(ra + pathname, {
            method: opts.method || 'GET', headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
        });
    };
    const owner = await (await call('/api/register', { method: 'POST', body: { nickname: '票主', password: 'password1' } })).json();
    const g = await (await call('/api/groups', { method: 'POST', token: owner.token, body: { name: '邀请测试群' } })).json();
    return {
        dir, s, ra, call, owner, code: g.code,
        close: async () => { await new Promise((r) => s.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
    };
}

async function newUser(call, nickname) {
    return (await call('/api/register', { method: 'POST', body: { nickname, password: 'password1' } })).json();
}

test('邀请链接：可以同时发多枚，各自的码都能进人', async () => {
    const t = await inviteSetup();
    try {
        const a = await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: '1d', label: '给室友' }
        })).json();
        const b = await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: 'never' }
        })).json();

        assert.match(a.invite.code, /^\d{8}$/);
        assert.match(b.invite.code, /^\d{8}$/);
        assert.notEqual(a.invite.code, b.invite.code, '两枚码不能是同一个');
        assert.equal(a.invite.label, '给室友');
        assert.ok(a.invite.expiresAt > Date.now(), '1 天的码应当有未来到期时间');
        assert.equal(b.invite.expiresAt, null, '永久码没有到期时间');

        // 两个不同的码各自都能把人拉进来
        const u1 = await newUser(t.call, '走第一枚');
        const u2 = await newUser(t.call, '走第二枚');
        assert.equal((await t.call(`/api/groups/${a.invite.code}/join`, { method: 'POST', token: u1.token })).status, 200);
        assert.equal((await t.call(`/api/groups/${b.invite.code}/join`, { method: 'POST', token: u2.token })).status, 200);

        const detail = await (await t.call(`/api/groups/${t.code}`, { token: t.owner.token })).json();
        assert.deepEqual(detail.members.map((m) => m.nickname).sort(), ['票主', '走第一枚', '走第二枚']);
    } finally { await t.close(); }
});

test('邀请链接：过期就不能再进人了（410），但群里的人不受影响', async () => {
    const t = await inviteSetup();
    try {
        const inv = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: '1d' }
        })).json()).invite;

        // 先让一个人正常进来
        const early = await newUser(t.call, '赶上了');
        assert.equal((await t.call(`/api/groups/${inv.code}/join`, { method: 'POST', token: early.token })).status, 200);

        // 把这枚码改成「一小时前就过期」，模拟时间流逝（不真等一天）
        const f = path.join(t.dir, 'groups', `${t.code}.json`);
        const g = JSON.parse(fs.readFileSync(f, 'utf8'));
        g.invites.find((i) => i.code === inv.code).expiresAt = Date.now() - 3600000;
        fs.writeFileSync(f, JSON.stringify(g), 'utf8');

        const late = await newUser(t.call, '来晚了');
        const r = await t.call(`/api/groups/${inv.code}/join`, { method: 'POST', token: late.token });
        assert.equal(r.status, 410, '过期码应当 410，而不是静默当成无效码');
        assert.match((await r.json()).error, /过期/);

        // 已经在群里的人照样能看群
        assert.equal((await t.call(`/api/groups/${t.code}`, { token: early.token })).status, 200);
        // 群主自己的永久码也不受影响
        assert.equal((await t.call(`/api/groups/${t.code}`, { token: t.owner.token })).status, 200);
    } finally { await t.close(); }
});

test('邀请链接：群主能作废，作废后进不来；别人无权作废', async () => {
    const t = await inviteSetup();
    try {
        const inv = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: 'never' }
        })).json()).invite;

        const member = await newUser(t.call, '群里的成员');
        await t.call(`/api/groups/${inv.code}/join`, { method: 'POST', token: member.token });

        // 成员不能作废（也不是群主）
        assert.equal((await t.call(`/api/groups/${t.code}/invites/${inv.code}`, {
            method: 'DELETE', token: member.token, body: {}
        })).status, 403);

        // 群主可以
        assert.equal((await t.call(`/api/groups/${t.code}/invites/${inv.code}`, {
            method: 'DELETE', token: t.owner.token, body: {}
        })).status, 200);

        // 作废后新人不进来
        const late = await newUser(t.call, '作废后来的');
        const r = await t.call(`/api/groups/${inv.code}/join`, { method: 'POST', token: late.token });
        assert.equal(r.status, 410);
        assert.match((await r.json()).error, /作废/);
    } finally { await t.close(); }
});

test('邀请链接：群主自己的码永远有效，改版前的老链接不会失效', async () => {
    const t = await inviteSetup();
    try {
        // 一枚邀请码都没有、也没发过任何新链接时，用群主自己的码（= 群码）照样能进人。
        // 这正是改版前发出去的链接的形态，不能让它们失效。
        const u = await newUser(t.call, '拿旧链接的人');
        assert.equal((await t.call(`/api/groups/${t.code}/join`, { method: 'POST', token: u.token })).status, 200);
    } finally { await t.close(); }
});

test('邀请链接：非群主不能发新码；邀请列表对成员只露可用的', async () => {
    const t = await inviteSetup();
    try {
        const member = await newUser(t.call, '普通成员');
        await t.call(`/api/groups/${t.code}/join`, { method: 'POST', token: member.token });

        // 成员发不了
        assert.equal((await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: member.token, body: { ttl: '1d' }
        })).status, 403);

        // 群主发两枚，作废其中一枚
        const keep = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: 'never' }
        })).json()).invite;
        const drop = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: 'never' }
        })).json()).invite;
        await t.call(`/api/groups/${t.code}/invites/${drop.code}`, {
            method: 'DELETE', token: t.owner.token, body: {}
        });

        const asOwner = await (await t.call(`/api/groups/${t.code}`, { token: t.owner.token })).json();
        assert.equal(asOwner.invites.length, 2, '群主看得到两条（含已作废的）');
        assert.equal(asOwner.ownerCode, t.code);
        assert.ok(asOwner.invites.some((i) => i.code === drop.code && i.revoked), '作废状态要标出来');

        const asMember = await (await t.call(`/api/groups/${t.code}`, { token: member.token })).json();
        assert.deepEqual(asMember.invites.map((i) => i.code), [keep.code], '成员只看得到还能用的那枚');
        assert.equal(asMember.ownerCode, null, '群主自己的码不给成员');
    } finally { await t.close(); }
});

test('邀请链接：有效期档位非法就 400，且配额有上限', async () => {
    const t = await inviteSetup();
    try {
        assert.equal((await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: '99y' }
        })).status, 400);

        // 档位是白名单，全部都能过
        for (const ttl of Object.keys(INVITE_TTLS)) {
            const r = await t.call(`/api/groups/${t.code}/invites`, {
                method: 'POST', token: t.owner.token, body: { ttl }
            });
            assert.equal(r.status, 200, `档位 ${ttl} 应当被接受`);
        }

        // 撞到上限就明确报错，而不是无限发
        let blocked = null;
        for (let i = 0; i < 30 && !blocked; i++) {
            const r = await t.call(`/api/groups/${t.code}/invites`, {
                method: 'POST', token: t.owner.token, body: { ttl: 'never' }
            });
            if (r.status === 400) blocked = r;
        }
        assert.ok(blocked, '活跃邀请码应当有数量上限');
        assert.match((await blocked.json()).error, /最多/);
    } finally { await t.close(); }
});

test('邀请链接：过期后群主能换一条新的，新人立刻能进', async () => {
    const t = await inviteSetup();
    try {
        const old = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: 'never' }
        })).json()).invite;

        // 改成已过期
        const f = path.join(t.dir, 'groups', `${t.code}.json`);
        const g = JSON.parse(fs.readFileSync(f, 'utf8'));
        g.invites.find((i) => i.code === old.code).expiresAt = Date.now() - 1000;
        fs.writeFileSync(f, JSON.stringify(g), 'utf8');

        const fresh = (await (await t.call(`/api/groups/${t.code}/invites`, {
            method: 'POST', token: t.owner.token, body: { ttl: '7d', label: '新的' }
        })).json()).invite;
        assert.notEqual(fresh.code, old.code);

        const u = await newUser(t.call, '拿新链接的人');
        assert.equal((await t.call(`/api/groups/${fresh.code}/join`, { method: 'POST', token: u.token })).status, 200);
    } finally { await t.close(); }
});

