/**
 * 存储加密接到 store 的文件读写边界后的行为。
 *
 * 三条主线：
 *   1. 开了加密 —— 磁盘上是密文、内存里是明文
 *   2. 没开加密 —— 老行为原样保留（回归护栏，保证不加密的部署与老测试都还能跑）
 *   3. 迁移 —— 明文就地转密文、幂等、留下可回滚的明文副本
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../shared/store.js');
const vaultMod = require('../shared/vault.js');

// 固定测试钥匙 —— 绝不是任何真实口令
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const COURSE = {
    course: '大学英语Ⅲ', day: 1, startPeriod: 3, endPeriod: 4,
    startTime: '10:00', endTime: '11:35', location: '紫金港东6-328',
    dates: ['20260914']
};

function newDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-vault-'));
}

async function openStore(dir, key) {
    const store = createStore(dir, key ? { vault: vaultMod.createVault(key) } : undefined);
    await store.init();
    return store;
}

const rawOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const usersFile = (dir) => path.join(dir, 'users.json');
const groupFile = (dir, code) => path.join(dir, 'groups', `${code}.json`);

/** 造一份有课表、有备注、有群、有对外备注的数据 */
async function seed(store) {
    const a = await store.createUser('小明', 'password1');
    const b = await store.createUser('小红', 'password2');
    await store.setUserCourses(a.id, [COURSE]);
    await store.setRemark(a.id, b.id, '外号小红');
    const g = await store.createGroup(a.id, '计科2201组团');
    await store.joinGroup(g.code, b.id);
    await store.setSelfRemark(g.code, b.id, '三班的小红');
    return { a, b, g };
}

// ---------------------------------------------------------------- 开了加密

test('开启加密：磁盘上是密文，读回来是明文', async () => {
    const dir = newDir();
    const store = await openStore(dir, KEY_A);
    const { a, b, g } = await seed(store);

    const file = usersFile(dir);
    const raw = rawOf(file);
    const rawText = fs.readFileSync(file, 'utf8');
    const rawA = raw.users.find((u) => u.id === a.id);

    assert.equal(typeof rawA.nickname, 'object', '昵称落盘应是密文对象');
    assert.equal(rawA.nickname.v, 1);
    assert.equal(typeof rawA.nickname.ct, 'string');
    assert.equal(typeof rawA.courses, 'object', '课表落盘应是密文对象');
    assert.ok(!Array.isArray(rawA.courses));
    assert.ok(!rawText.includes('小明'), '文件里不该出现明文昵称');
    assert.ok(!rawText.includes('大学英语'), '文件里不该出现明文的课名');
    assert.ok(!rawText.includes('外号小红'), '文件里不该出现明文备注');

    // 内存里仍然是明文，老代码的读法完全不用改
    const users = await store.readUsers();
    const gotA = users.find((u) => u.id === a.id);
    assert.equal(gotA.nickname, '小明');
    assert.deepEqual(gotA.courses, [COURSE]);
    assert.equal(gotA.remarks[b.id], '外号小红');
    assert.equal((await store.getUser(b.id)).nickname, '小红');

    // 群的对外备注同样落盘加密，并且 AAD 绑了群号
    const rawG = rawOf(groupFile(dir, g.code));
    assert.equal(typeof rawG.selfRemarks[b.id], 'object');
    assert.ok(!fs.readFileSync(groupFile(dir, g.code), 'utf8').includes('三班的小红'));
    assert.equal((await store.readGroup(g.code)).selfRemarks[b.id], '三班的小红');
});

test('开启加密：按昵称查找、课表统计、管理页都照常工作', async () => {
    const dir = newDir();
    const store = await openStore(dir, KEY_A);
    const { a } = await seed(store);

    assert.equal((await store.findUserByNickname('小明')).id, a.id);
    assert.equal((await store.findUserByNickname('  小明  ')).id, a.id);
    assert.equal(await store.findUserByNickname('查无此人'), null);

    const listed = await store.listAdminUsers();
    const row = listed.find((u) => u.id === a.id);
    assert.equal(row.nickname, '小明');
    assert.equal(row.courseCount, 1);
});

test('没有 vault 时保持老行为：文件里就是明文', async () => {
    const dir = newDir();
    const store = await openStore(dir);          // 不给 vault
    const { a, b } = await seed(store);

    const rawText = fs.readFileSync(usersFile(dir), 'utf8');
    assert.ok(rawText.includes('小明'), '不加密时就该是明文');
    assert.ok(rawText.includes('大学英语'));

    const rawA = rawOf(usersFile(dir)).users.find((u) => u.id === a.id);
    assert.equal(rawA.nickname, '小明');
    assert.equal(rawA.remarks[b.id], '外号小红');
});

test('换一把钥匙读同一个目录：启动时就失败（钥匙必须保管好）', async () => {
    const dir = newDir();
    const store = await openStore(dir, KEY_A);
    await seed(store);

    // 失败发生在 init（读到第一条密文就解不开）—— 这正是 fail-fast 想要的时机
    await assert.rejects(() => openStore(dir, KEY_B), (e) => e.code === 'BAD_TAG');

    // 而且不许把好文件当"损坏"改名重建
    assert.ok(fs.existsSync(usersFile(dir)));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')), []);
});

test('AAD 绑群号：把甲群的对外备注密文挪到乙群，解不开', async () => {
    const dir = newDir();
    const store = await openStore(dir, KEY_A);
    const a = await store.createUser('小明', 'password1');
    const b = await store.createUser('小红', 'password2');
    const g1 = await store.createGroup(a.id, '甲组');
    const g2 = await store.createGroup(a.id, '乙组');
    await store.joinGroup(g1.code, b.id);
    await store.joinGroup(g2.code, b.id);
    await store.setSelfRemark(g1.code, b.id, '甲组里的我');
    await store.setSelfRemark(g2.code, b.id, '乙组里的我');

    // 手工把甲群的密文塞进乙群（同一个用户、同一个值，只是群号不同）
    const f1 = groupFile(dir, g1.code);
    const f2 = groupFile(dir, g2.code);
    const g2raw = rawOf(f2);
    g2raw.selfRemarks[b.id] = rawOf(f1).selfRemarks[b.id];
    fs.writeFileSync(f2, JSON.stringify(g2raw, null, 2));

    await assert.rejects(() => store.readGroup(g2.code), (e) => e.code === 'BAD_TAG');
});

// ---------------------------------------------------------------- 迁移

test('迁移：明文就地转密文，列得出待迁项、迁移后为空', async () => {
    const dir = newDir();
    const plain = await openStore(dir);          // 先在明文状态下造数据
    await seed(plain);

    const store = await openStore(dir, KEY_A);   // 换上有钥匙的 store
    const before = await store.pendingPlaintext();
    assert.ok(before.length >= 4, `应列出待迁移字段，实际 ${before.length} 条`);
    assert.ok(before.some((x) => x.endsWith(':nickname')));
    assert.ok(before.some((x) => x.endsWith(':courses')));
    assert.ok(before.some((x) => x.endsWith(':remarks')));
    assert.ok(before.some((x) => x.endsWith(':selfRemark')));

    const report = await store.migrateVault('TESTSTAMP');
    assert.equal(report.users, 2);
    assert.equal(report.groups, 1);
    assert.ok(report.fields >= 4);
    assert.ok(report.backups.includes('users.json.plaintext-TESTSTAMP'));

    assert.deepEqual(await store.pendingPlaintext(), [], '迁移后不该还有明文');

    // 数据本身没变，只是换了存法
    const users = await store.readUsers();
    assert.equal(users.find((u) => u.nickname === '小明').courses.length, 1);
    assert.equal((await store.readGroup((await store.listAdminGroups())[0].code)).selfRemarks[users[1].id], '三班的小红');
});

test('迁移是幂等的：跑第二遍什么都不做', async () => {
    const dir = newDir();
    const plain = await openStore(dir);
    await seed(plain);

    const store = await openStore(dir, KEY_A);
    const first = await store.migrateVault('S1');
    assert.ok(first.fields > 0);

    const second = await store.migrateVault('S2');
    assert.equal(second.fields, 0);
    assert.equal(second.users, 0);
    assert.equal(second.groups, 0);
    assert.deepEqual(second.backups, [], '没有改动就不该留备份');
});

test('迁移留下明文副本，可据它回滚', async () => {
    const dir = newDir();
    const plain = await openStore(dir);
    await seed(plain);

    const store = await openStore(dir, KEY_A);
    await store.migrateVault('ROLLBACK');

    const backup = `${usersFile(dir)}.plaintext-ROLLBACK`;
    assert.ok(fs.existsSync(backup), '应留下明文副本作为回滚路径');
    assert.ok(fs.readFileSync(backup, 'utf8').includes('小明'), '副本里应是原文');

    // 回滚：把副本盖回去，用没有钥匙的 store 读，数据完好
    fs.copyFileSync(backup, usersFile(dir));
    const rolled = await openStore(dir);
    const users = await rolled.readUsers();
    assert.equal(users.length, 2);
    assert.equal(users.find((u) => u.nickname === '小明').courses.length, 1);
});

test('迁移时没有根密钥就直接拒绝', async () => {
    const dir = newDir();
    const store = await openStore(dir);
    await seed(store);
    await assert.rejects(() => store.migrateVault('X'), /没有配置根密钥/);
});
