'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, sessionKey, validateCourses, sanitizeNickname, validatePassword } = require('../shared/store.js');

function tmpStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-store-'));
    const store = createStore(dir);
    return store.init().then(() => ({ store, dir }));
}

const COURSE = {
    course: '大学英语Ⅲ', day: 1, startPeriod: 3, endPeriod: 4,
    startTime: '10:00', endTime: '11:35', location: '紫金港东6-328',
    dates: ['20260914', '20260921']
};

// ---------------------------------------------------------------- 校验

test('昵称清洗：剔除控制字符与文件系统保留字符，长度上限 10', () => {
    assert.equal(sanitizeNickname('  小灰  '), '小灰');
    assert.equal(sanitizeNickname('a/b:c*d?'), 'abcd');
    assert.equal(sanitizeNickname('一二三四五六七八九十'), '一二三四五六七八九十');
    assert.throws(() => sanitizeNickname('一二三四五六七八九十一'), /最多 10 个字/);
    assert.throws(() => sanitizeNickname('   '), /不能为空/);
});

test('密码校验：6–64 位，不接受纯空白', () => {
    assert.equal(validatePassword('123456'), '123456');
    assert.throws(() => validatePassword('12345'), /至少 6 位/);
    assert.throws(() => validatePassword('x'.repeat(65)), /最多 64 位/);
    assert.throws(() => validatePassword('      '), /不能全是空白/);
});

test('课表校验：拒绝非法结构', () => {
    assert.equal(validateCourses([COURSE]).length, 1);
    assert.throws(() => validateCourses('不是数组'), /格式不对/);
    assert.throws(() => validateCourses([{ ...COURSE, day: 8 }]), /星期数据不合法/);
    assert.throws(() => validateCourses([{ ...COURSE, startPeriod: 0 }]), /开始节次不合法/);
    assert.throws(() => validateCourses([{ ...COURSE, endPeriod: 2 }]), /结束节次不合法/);
    assert.throws(() => validateCourses([{ ...COURSE, startTime: '10点' }]), /开始时间格式不对/);
    assert.throws(() => validateCourses([{ ...COURSE, course: '   ' }]), /课程名不能为空/);
    assert.throws(() => validateCourses(new Array(501).fill(COURSE)), /上限/);
});

test('课表校验：日期被清洗、去重、排序', () => {
    const out = validateCourses([{ ...COURSE, dates: ['20260921', 'bad', '20260914', '20260914'] }]);
    assert.deepEqual(out[0].dates, ['20260914', '20260921']);
});

// ---------------------------------------------------------------- 账号

test('注册与登录：明文密码绝不落盘', async () => {
    const { store, dir } = await tmpStore();
    const user = await store.createUser('小灰', 'hunter2secret');
    assert.equal(user.nickname, '小灰');
    assert.ok(user.pwHash && user.pwSalt);
    assert.notEqual(user.pwHash, 'hunter2secret');

    const raw = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
    assert.ok(!raw.includes('hunter2secret'), 'users.json 里不得出现明文密码');

    assert.ok(await store.verifyLogin('小灰', 'hunter2secret'));
    assert.equal(await store.verifyLogin('小灰', '错的'), null);
    assert.equal(await store.verifyLogin('不存在的人', 'hunter2secret'), null);
});

test('注册：昵称全局唯一且忽略大小写', async () => {
    const { store } = await tmpStore();
    await store.createUser('Alice', 'password1');
    await assert.rejects(() => store.createUser('alice', 'password2'), /已经有人/);
    await assert.rejects(() => store.createUser('  Alice ', 'password2'), /已经有人/);
});

test('公开视图不泄露密码字段', async () => {
    const { store } = await tmpStore();
    const user = await store.createUser('小灰', 'password1');
    const pub = store.publicUser(user);
    assert.equal(pub.pwHash, undefined);
    assert.equal(pub.pwSalt, undefined);
    assert.equal(pub.nickname, '小灰');
});

test('并发注册不丢更新（写队列生效）', async () => {
    const { store } = await tmpStore();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.createUser(`用户${i}`, 'password1')));
    const users = await store.readUsers();
    assert.equal(users.length, 20, '20 个并发注册必须全部落盘');
});

test('覆盖课表：合法写入，非法拒绝', async () => {
    const { store } = await tmpStore();
    const user = await store.createUser('小灰', 'password1');
    await store.setUserCourses(user.id, [COURSE]);
    assert.equal((await store.getUser(user.id)).courses.length, 1);

    await assert.rejects(() => store.setUserCourses(user.id, [{ ...COURSE, day: 99 }]), /星期数据不合法/);
    assert.equal((await store.getUser(user.id)).courses.length, 1, '非法写入不得破坏已有数据');
    await assert.rejects(() => store.setUserCourses('不存在', [COURSE]), /账号不存在/);
});

test('改密码后旧密码失效，且旧会话被吊销', async () => {
    const { store } = await tmpStore();
    const user = await store.createUser('小灰', 'password1');
    const token = await store.createSession(user.id);
    assert.ok(await store.resolveSession(token));

    await store.setUserPassword(user.id, 'password2');
    assert.equal(await store.verifyLogin('小灰', 'password1'), null);
    assert.ok(await store.verifyLogin('小灰', 'password2'));
    assert.equal(await store.resolveSession(token), null, '改密码后旧令牌失效');
});

// ---------------------------------------------------------------- 会话

test('会话：签发、解析、吊销', async () => {
    const { store } = await tmpStore();
    const user = await store.createUser('小灰', 'password1');
    const token = await store.createSession(user.id);

    const resolved = await store.resolveSession(token);
    assert.equal(resolved.id, user.id);
    assert.equal(await store.resolveSession('伪造的令牌'), null);
    assert.equal(await store.resolveSession(''), null);

    await store.revokeSession(token);
    assert.equal(await store.resolveSession(token), null);
});

// ---------------------------------------------------------------- 群组

async function twoUsers(store) {
    const a = await store.createUser('我', 'password1');
    const b = await store.createUser('小灰', 'password1');
    return [a, b];
}

test('建群：创建者自动入群，邀请码为 6 位数字', async () => {
    const { store } = await tmpStore();
    const [a] = await twoUsers(store);
    const g = await store.createGroup(a.id, '计科2201组团');
    assert.match(g.code, /^\d{8}$/);
    assert.equal(g.creatorId, a.id);
    assert.deepEqual(g.members.map((m) => m.userId), [a.id]);
});

test('入群幂等：重复加入不产生重复成员', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g = await store.createGroup(a.id, '组');
    await store.joinGroup(g.code, b.id);
    await store.joinGroup(g.code, b.id);
    assert.equal((await store.readGroup(g.code)).members.length, 2);
});

test('入群：邀请码格式错 / 群不存在', async () => {
    const { store } = await tmpStore();
    const [a] = await twoUsers(store);
    await assert.rejects(() => store.joinGroup('12345', a.id), /8 位数字/);
    // 6 位是改版前的老码，仍然接受，只是找不到对应的群
    await assert.rejects(() => store.joinGroup('999999', a.id), /群组不存在/);
    await assert.rejects(() => store.joinGroup('99999999', a.id), /群组不存在/);
});

test('群组详情：成员信息实时取自账号表，且不含密码字段', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    await store.setUserCourses(b.id, [COURSE]);
    const g = await store.createGroup(a.id, '组');
    await store.joinGroup(g.code, b.id);

    const detail = await store.groupDetail(g.code);
    assert.equal(detail.members.length, 2);
    const m = detail.members.find((x) => x.id === b.id);
    assert.equal(m.nickname, '小灰');
    assert.equal(m.courseCount, 1);
    assert.equal(m.courses.length, 1);
    assert.equal(m.pwHash, undefined);
    assert.equal(m.pwSalt, undefined);
});

test('退群：群主不能退群，只能解散', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g = await store.createGroup(a.id, '组');
    await store.joinGroup(g.code, b.id);

    await assert.rejects(() => store.leaveGroup(g.code, a.id), /群主/);
    await store.leaveGroup(g.code, b.id);
    assert.equal((await store.readGroup(g.code)).members.length, 1);
});

// ---------------------------------------------------------------- 对外备注

test('对外备注：自己设的，群里所有人都能在群组详情里看到', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g = await store.createGroup(a.id, '组');
    await store.joinGroup(g.code, b.id);

    await store.setSelfRemark(g.code, b.id, '三班-小灰');

    const detail = await store.groupDetail(g.code);
    assert.equal(detail.members.find((x) => x.id === b.id).selfRemark, '三班-小灰');
    // 昵称本身不变，备注只是「对外显示用」
    assert.equal(detail.members.find((x) => x.id === b.id).nickname, '小灰');
});

test('对外备注：自己的和别人的互不干扰，一个群一份', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g1 = await store.createGroup(a.id, '组一');
    await store.joinGroup(g1.code, b.id);
    const g2 = await store.createGroup(a.id, '组二');
    await store.joinGroup(g2.code, b.id);

    await store.setSelfRemark(g1.code, b.id, '组一里的我');
    await store.setSelfRemark(g2.code, b.id, '组二里的我');
    // a 给 b 起的私人备注存在账号上，和群无关
    await store.setRemark(a.id, b.id, '我的外号');

    assert.equal((await store.groupDetail(g1.code)).members.find((x) => x.id === b.id).selfRemark, '组一里的我');
    assert.equal((await store.groupDetail(g2.code)).members.find((x) => x.id === b.id).selfRemark, '组二里的我');
    assert.equal((await store.getUser(a.id)).remarks[b.id], '我的外号');
});

test('对外备注：传空串恢复昵称，超长和不在群里都被拒', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g = await store.createGroup(a.id, '组');
    await store.joinGroup(g.code, b.id);

    await assert.rejects(() => store.setSelfRemark(g.code, b.id, '一'.repeat(13)), /最多 12 个字/);

    const outsider = await store.createUser('路人', 'pw123456');
    await assert.rejects(() => store.setSelfRemark(g.code, outsider.id, '偷改'), /不在这个群/);

    await store.setSelfRemark(g.code, b.id, '临时名字');
    await store.setSelfRemark(g.code, b.id, '   ');
    assert.equal((await store.groupDetail(g.code)).members.find((x) => x.id === b.id).selfRemark, '');
});

test('对外备注：退群 / 被移除后不残留', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g = await store.createGroup(a.id, '组');
    await store.joinGroup(g.code, b.id);

    await store.setSelfRemark(g.code, b.id, '走之前');
    await store.leaveGroup(g.code, b.id);
    assert.equal((await store.readGroup(g.code)).selfRemarks[b.id], undefined);

    await store.joinGroup(g.code, b.id);
    await store.setSelfRemark(g.code, b.id, '再回来');
    await store.removeMember(g.code, a.id, b.id);
    assert.equal((await store.readGroup(g.code)).selfRemarks[b.id], undefined);
});

test('解散：非群主被拒', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g = await store.createGroup(a.id, '组');
    await store.joinGroup(g.code, b.id);

    await assert.rejects(() => store.deleteGroup(g.code, b.id), /只有群主/);
    await store.deleteGroup(g.code, a.id);
    assert.equal(await store.readGroup(g.code), null);
});

test('我的群组列表', async () => {
    const { store } = await tmpStore();
    const [a, b] = await twoUsers(store);
    const g1 = await store.createGroup(a.id, '甲组');
    const g2 = await store.createGroup(b.id, '乙组');
    await store.joinGroup(g2.code, a.id);

    const list = await store.listGroupsForUser(a.id);
    assert.equal(list.length, 2);
    const byCode = Object.fromEntries(list.map((x) => [x.code, x]));
    assert.equal(byCode[g1.code].isCreator, true);
    assert.equal(byCode[g2.code].isCreator, false);
    assert.equal(byCode[g2.code].memberCount, 2);
});

// ---------------------------------------------------------------- 健壮性

test('损坏文件兜底：留证重建，不静默丢数据', async () => {
    const { store, dir } = await tmpStore();
    await store.createUser('小灰', 'password1');

    const usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(usersFile, '{ 这不是合法 JSON', 'utf8');

    const users = await store.readUsers();
    assert.deepEqual(users, [], '重建为空库而不是抛异常');

    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.equal(backups.length, 1, '损坏文件被另存为证据');
    assert.ok(fs.readFileSync(path.join(dir, backups[0]), 'utf8').includes('这不是合法 JSON'));
});

test('并发建群不产生邀请码冲突', async () => {
    const { store } = await tmpStore();
    const [a] = await twoUsers(store);
    const groups = await Promise.all(Array.from({ length: 12 }, (_, i) => store.createGroup(a.id, `组${i}`)));
    const codes = new Set(groups.map((g) => g.code));
    assert.equal(codes.size, 12, '12 次建群邀请码互不相同');
});

test('清理：过期会话被移除', async () => {
    const { store, dir } = await tmpStore();
    const user = await store.createUser('小灰', 'password1');
    const token = await store.createSession(user.id);

    // 会话表现在常驻内存（读路径不再每请求读盘），所以不能靠改文件来伪造过期 ——
    // 得改内存里的那份，再落盘，这样才是「重启后仍过期」的真实状态。
    // 键是令牌的 sha256（明文令牌不落盘），所以先用 sessionKey 换算一下。
    const f = path.join(dir, 'sessions.json');
    const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    db.sessions[sessionKey(token)].lastSeen = Date.now() - 100 * 86400000;
    fs.writeFileSync(f, JSON.stringify(db), 'utf8');

    // 重建一个 store，从盘上加载这份「100 天前活动过」的表
    const fresh = createStore(dir);
    await fresh.init();
    const removed = await fresh.cleanup();
    assert.equal(removed.sessions, 1);
    assert.equal(await fresh.resolveSession(token), null);
    assert.equal(store.dataDir, dir);   // 保留原 store 引用，避免未使用告警
});
