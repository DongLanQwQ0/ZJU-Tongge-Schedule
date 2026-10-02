'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../shared/store.js');
const { createServer } = require('../server.js');

const DAY = 24 * 3600000;
const COURSE = {
    course: '测试课程', day: 1, startPeriod: 1, endPeriod: 2,
    startTime: '08:00', endTime: '09:35', location: '教室', dates: ['20261005']
};

async function fixture(t, cleanup = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tongge-temporary-'));
    if (cleanup) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createStore(dir);
    await store.init();
    const owner = await store.createUser('群主', 'password1');
    const member = await store.createUser('群友', 'password1');
    await store.setUserCourses(owner.id, [COURSE]);
    await store.setUserCourses(member.id, [COURSE]);
    return { dir, store, owner, member };
}

function groupFile(dir, group) {
    return path.join(dir, 'groups', `${group.code}.json`);
}

function readGroupFile(dir, group) {
    return JSON.parse(fs.readFileSync(groupFile(dir, group), 'utf8'));
}

test('临时群精确存活 24 小时，邀请、入群和设置操作不续期', async (t) => {
    const { dir, store, owner, member } = await fixture(t);
    const before = Date.now();
    const group = await store.createGroup(owner.id, '临时组团', true);
    assert.ok(group.createdAt >= before && group.createdAt <= Date.now());
    assert.equal(group.expiresAt, group.createdAt + DAY);
    await store.joinByInvite(group.invites[0].code, member.id);
    await store.updateGroupSettings(group.code, owner.id, { name: '改名后的组团' });
    await store.addInvite(group.code, owner.id, 'never', '新链接');
    assert.equal(readGroupFile(dir, group).expiresAt, group.expiresAt);
    assert.equal((await store.groupDetail(group.code, owner.id)).expiresAt, group.expiresAt);
    assert.equal((await store.listGroupsForUser(owner.id))[0].expiresAt, group.expiresAt);
    assert.equal((await store.listAdminGroups())[0].expiresAt, group.expiresAt);
    assert.equal((await store.createGroup(owner.id, '永久组团')).expiresAt, null);
    for (const value of [null, 'true', 1, {}, []]) {
        await assert.rejects(store.createGroup(owner.id, '非法标记', value), { status: 400 });
    }
});

test('到期边界即时隐藏群详情、所有列表、成员搜索与邀请入群，重启也不恢复', async (t) => {
    const { dir, store, owner, member } = await fixture(t);
    const group = await store.createGroup(owner.id, '到期组团', true);
    await store.joinByInvite(group.invites[0].code, member.id);
    assert.equal((await store.searchGroupMembers(owner.id, '群友')).length, 1);
    const raw = readGroupFile(dir, group);
    const boundary = raw.expiresAt;
    t.mock.method(Date, 'now', () => boundary);
    assert.equal(await store.readGroup(group.code), null);
    await assert.rejects(store.groupDetail(group.code, owner.id), { status: 404 });
    assert.deepEqual(await store.listGroupsForUser(owner.id), []);
    assert.deepEqual(await store.listAdminGroups(), []);
    assert.deepEqual(await store.searchGroupMembers(owner.id, '群友'), []);
    assert.deepEqual(await store.searchGroupMembers(owner.id, '', [member.id]), []);
    await assert.rejects(store.joinByInvite(group.invites[0].code, member.id), { status: 404 });
    await assert.rejects(store.updateGroupSettings(group.code, owner.id, { name: '续命' }), { status: 404 });
    assert.ok(fs.existsSync(groupFile(dir, group)), '业务隐藏无需等待物理清理');
    const restarted = createStore(dir);
    await restarted.init();
    assert.equal(await restarted.readGroup(group.code), null);
    assert.deepEqual(await restarted.listGroupsForUser(member.id), []);
    assert.deepEqual(readGroupFile(dir, group), raw, '重启不写回到期群');
});

test('分钟清理仅删除到期临时群，每日清理仍删除闲置群，用户课表保留', async (t) => {
    const { dir, store, owner, member } = await fixture(t);
    const temporary = await store.createGroup(owner.id, '临时', true);
    const permanent = await store.createGroup(owner.id, '永久');
    const dormant = await store.createGroup(owner.id, '闲置');
    const dormantRaw = readGroupFile(dir, dormant);
    dormantRaw.updatedAt = Date.now() - 181 * DAY;
    fs.writeFileSync(groupFile(dir, dormant), JSON.stringify(dormantRaw), 'utf8');
    t.mock.method(Date, 'now', () => temporary.expiresAt);
    assert.equal(await store.expireTemporaryGroups(), 1);
    assert.ok(!fs.existsSync(groupFile(dir, temporary)));
    assert.ok(fs.existsSync(groupFile(dir, permanent)));
    assert.ok(fs.existsSync(groupFile(dir, dormant)));
    const another = await store.createGroup(owner.id, '再次到期', true);
    t.mock.method(Date, 'now', () => another.expiresAt);
    assert.equal((await store.cleanup()).groups, 2);
    assert.ok(!fs.existsSync(groupFile(dir, another)));
    assert.ok(!fs.existsSync(groupFile(dir, dormant)));
    assert.ok(fs.existsSync(groupFile(dir, permanent)));
    assert.deepEqual((await store.getUser(owner.id)).courses, [COURSE]);
    assert.deepEqual((await store.getUser(member.id)).courses, [COURSE]);
});

test('API 宣告能力并返回临时群寿命，服务重启清理到期文件', async (t) => {
    const { dir, store, owner } = await fixture(t, false);
    let server;
    t.after(async () => {
        if (server && server.listening) await new Promise((resolve) => server.close(resolve));
        if (server) {
            await server.store.flushSessions('测试结束');
            await server.store.stats.flush('测试结束');
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const expired = await store.createGroup(owner.id, '过期', true);
    const expiredRaw = readGroupFile(dir, expired);
    expiredRaw.expiresAt = Date.now() - 1;
    fs.writeFileSync(groupFile(dir, expired), JSON.stringify(expiredRaw), 'utf8');
    server = await createServer({ vault: false, captcha: false, dataDir: dir, port: 0, skipCleanup: true });
    assert.ok(!fs.existsSync(groupFile(dir, expired)), '启动应等待临时群清理完成');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await fetch(`${base}/api/meta`)).json()).temporaryGroups, true);
    const token = await server.store.createSession(owner.id);
    const create = async (body) => fetch(`${base}/api/groups`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const response = await create({ name: 'API 临时群', temporary: true, expiresAt: 1 });
    assert.equal(response.status, 200);
    const group = await response.json();
    const saved = readGroupFile(dir, group);
    assert.equal(group.expiresAt, saved.createdAt + DAY, '客户端不能自定寿命');
    assert.equal((await (await create({ name: 'API 永久群' })).json()).expiresAt, null);
    assert.equal((await create({ name: '非法', temporary: 'true' })).status, 400);
});
