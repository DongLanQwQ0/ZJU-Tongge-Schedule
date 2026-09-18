'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createStatsStore } = require('../shared/stats-store.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-stats-'));
const at = (y, m, d, hh = 10, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

/** 和 store 里那两个同形：readJson(file, fallback) / 原子写 */
async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return fallback(); }
}
async function writeJsonAtomic(file, data) {
    await fsp.writeFile(file + '.tmp', JSON.stringify(data), 'utf8');
    await fsp.rename(file + '.tmp', file);
}
const withLock = (key, fn) => fn();

function mk(extra) {
    const dir = tmpDir();
    const store = createStatsStore(Object.assign({
        dir, readJson, writeJsonAtomic, withLock, log: () => {}
    }, extra || {}));
    return { dir, store, fileOf: (day) => path.join(dir, 'stats', day + '.json') };
}

// ---------------------------------------------------------------- 记账不落盘

test('记账只动内存：flush 之前盘上没有文件，flush 之后才有', async () => {
    const { store, fileOf } = mk();
    const t = at(2026, 9, 18, 9);
    store.touch('u_a', t);
    store.touch('u_a', t + 1000);
    store.noteLogin('u_a', t);
    store.bump('u_a', 'course_upload', t);

    assert.deepEqual(store._state(), { days: ['2026-09-18'], dirty: ['2026-09-18'] });
    assert.equal(fs.existsSync(fileOf('2026-09-18')), false, '记账绝不能顺手写盘');

    const wrote = await store.flush('测试');
    assert.equal(wrote, 1);
    assert.deepEqual(store._state().dirty, [], '写完就清脏标记');

    const saved = JSON.parse(fs.readFileSync(fileOf('2026-09-18'), 'utf8'));
    assert.equal(saved.day, '2026-09-18');
    assert.equal(saved.requests, 2);
    assert.equal(saved.logins, 1);
    assert.deepEqual(Object.keys(saved.users), ['u_a'], '同一个人当天只有一行');
    assert.equal(saved.users.u_a.req, 2);
    assert.equal(saved.users.u_a.acts.course_upload, 1);
});

test('没有脏数据时 flush 不写盘，也不报错', async () => {
    const { store } = mk();
    assert.equal(await store.flush('测试'), undefined);
});

test('当天已经落过盘：之后新的记账不能把旧账覆盖掉（重启后的那个坑）', async () => {
    const dir = tmpDir();
    const mkOn = (d) => createStatsStore({ dir: d, readJson, writeJsonAtomic, withLock, log: () => {} });
    const file = path.join(dir, 'stats', '2026-09-18.json');

    // 第一次运行：老账号记一笔、落盘
    const first = mkOn(dir);
    first.touch('u_old', at(2026, 9, 18, 9));
    await first.flush('第一次');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users.u_old.req, 1);

    // 「重启」：内存空了，但盘上那份还在。新账号来了一笔 ——
    // 如果直接拿空桶写盘，u_old 当天的计数就无声消失了
    const second = mkOn(dir);
    second.touch('u_new', at(2026, 9, 18, 15));
    await second.flush('第二次');

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved.users).sort(), ['u_new', 'u_old'], '旧账必须还在');
    assert.equal(saved.requests, 2, '两笔都要算上');
    assert.equal(saved.users.u_old.req, 1);

    // 读出来也应当是两个人
    const out = await second.readWindow(7, { today: '2026-09-18' });
    assert.equal(out.summary.today.active, 2);
});

// ---------------------------------------------------------------- 跨天

test('跨零点自然分桶：两天各一个文件，各记各的', async () => {
    const { store, fileOf } = mk();
    store.touch('u_a', at(2026, 9, 17, 23, 59));
    store.touch('u_a', at(2026, 9, 18, 0, 1));

    assert.deepEqual(store._state().days, ['2026-09-17', '2026-09-18']);
    const wrote = await store.flush('跨天');
    assert.equal(wrote, 2, '两个脏桶一起落盘');

    const d17 = JSON.parse(fs.readFileSync(fileOf('2026-09-17'), 'utf8'));
    const d18 = JSON.parse(fs.readFileSync(fileOf('2026-09-18'), 'utf8'));
    assert.equal(d17.requests, 1);
    assert.equal(d18.requests, 1);
    assert.ok(d17.users.u_a && d18.users.u_a, '两天各自都记着这个人');
});

// ---------------------------------------------------------------- 落盘失败

test('落盘失败保留脏标记，下次接着写（不丢数据、也不影响调用方）', async () => {
    const dir = tmpDir();
    let boom = true;
    const store = createStatsStore({
        dir, withLock,
        readJson,
        writeJsonAtomic: async (file, data) => {
            if (boom) throw new Error('磁盘满了');
            return writeJsonAtomic(file, data);
        },
        log: () => {}
    });
    store.touch('u_a', at(2026, 9, 18));
    assert.equal(await store.flush('第一次'), 0, '写失败就当没写');
    assert.deepEqual(store._state().dirty, ['2026-09-18'], '脏标记必须留着，否则这几秒的活跃就永远丢了');

    boom = false;
    assert.equal(await store.flush('第二次'), 1);
    assert.deepEqual(store._state().dirty, []);
    assert.ok(fs.existsSync(path.join(dir, 'stats', '2026-09-18.json')));
});

test('记账本身出错也不会抛给调用方（统计不能影响业务）', () => {
    const dir = tmpDir();
    const store = createStatsStore({
        dir, readJson, writeJsonAtomic, withLock,
        now: () => { throw new Error('时钟坏了'); },
        log: () => {}
    });
    // 时钟坏掉 -> 算不出今天 -> record 内部捕获，调用方毫无感觉
    assert.doesNotThrow(() => store.touch('u_a'));
    assert.doesNotThrow(() => store.bump('u_a', 'course_upload'));
});

// ---------------------------------------------------------------- 读

test('读窗口：优先用内存里那份，所以刚发生的活跃立刻看得见', async () => {
    const { store, fileOf } = mk();
    // 盘上先放一份「今天只有 1 个人」的旧数据
    await fsp.mkdir(path.dirname(fileOf('2026-09-18')), { recursive: true });
    fs.writeFileSync(fileOf('2026-09-18'), JSON.stringify({
        v: 1, day: '2026-09-18', requests: 5, logins: 1, newUsers: [], users: { u_old: { req: 5, logins: 1, lastAt: 1, acts: {} } }
    }), 'utf8');

    store.touch('u_new', at(2026, 9, 18, 12));      // 还没落盘

    const out = await store.readWindow(7, { today: '2026-09-18' });
    assert.equal(out.summary.today.active, 2, '内存那份额外的活跃不能被盘上那份盖掉');
    assert.equal(out.summary.today.requests, 6);
});

test('读窗口：连续日历天，没数据的天补 0', async () => {
    const { store } = mk();
    store.touch('u_a', at(2026, 9, 18));
    const out = await store.readWindow(7, { today: '2026-09-18' });
    assert.equal(out.series.length, 7);
    assert.deepEqual(out.series.map((r) => r.day), [
        '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'
    ]);
    assert.equal(out.series[0].active, 0);
    assert.equal(out.series[6].active, 1);
});

test('读窗口：7 天窗口也能算 7 日留存（它要比窗口多读一天）', async () => {
    const { store } = mk();
    store.noteNewUser('u_back', at(2026, 9, 11));   // 7 天前注册
    store.noteNewUser('u_gone', at(2026, 9, 11));   // 7 天前注册，再没出现
    store.touch('u_back', at(2026, 9, 18));         // 今天回来了

    const out = await store.readWindow(7, { today: '2026-09-18' });
    assert.deepEqual(out.summary.retention7, { cohort: 2, returned: 1, rate: 0.5 });
    assert.equal(out.series.some((r) => r.day === '2026-09-11'), false, '9-11 仍然是窗口外，不该出现在序列里');
});

test('读窗口：坏掉的桶当空桶，不抛错', async () => {
    const { store, fileOf } = mk();
    await fsp.mkdir(path.dirname(fileOf('2026-09-18')), { recursive: true });
    fs.writeFileSync(fileOf('2026-09-18'), '{ 这不是合法 JSON', 'utf8');

    const out = await store.readWindow(7, { today: '2026-09-18' });
    assert.equal(out.summary.today.active, 0);
    assert.equal(out.series.length, 7);
});

test('读窗口：昵称由调用方给，活跃榜跟着走', async () => {
    const { store } = mk();
    store.touch('u_a', at(2026, 9, 18));
    const out = await store.readWindow(7, { today: '2026-09-18', nameOf: (id) => (id === 'u_a' ? '小灰' : id) });
    assert.equal(out.top[0].nickname, '小灰');
});

// ---------------------------------------------------------------- 修剪

test('修剪：只留最近 90 天，更老的整个文件删掉', async () => {
    const { store, fileOf } = mk();
    const today = '2026-09-18';
    // 直接摆三个文件：89 天前（留）、90 天前（删）、91 天前（删）
    await fsp.mkdir(path.dirname(fileOf(today)), { recursive: true });
    const days = ['2026-06-21', '2026-06-20', '2026-06-19'];   // today-89 / -90 / -91
    days.forEach((d) => fs.writeFileSync(fileOf(d), JSON.stringify({ v: 1, day: d, requests: 0, logins: 0, newUsers: [], users: {} }), 'utf8'));
    // 一个无关文件不该被误删
    fs.writeFileSync(path.join(path.dirname(fileOf(today)), 'README.txt'), 'x', 'utf8');

    const removed = await store.prune(at(2026, 9, 18));
    assert.equal(removed, 2);
    assert.ok(fs.existsSync(fileOf('2026-06-21')), '第 89 天还在保留期内');
    assert.equal(fs.existsSync(fileOf('2026-06-20')), false);
    assert.equal(fs.existsSync(fileOf('2026-06-19')), false);
    assert.ok(fs.existsSync(path.join(path.dirname(fileOf(today)), 'README.txt')), '不是桶的文件不碰');
});

test('修剪：内存里过老的桶也清掉（跨天之后会挂在内存里）', async () => {
    const { store } = mk();
    store.touch('u_old', at(2026, 6, 1));           // 三个多月前
    await store.flush('先落盘');
    store.touch('u_new', at(2026, 9, 18));
    await store.prune(at(2026, 9, 18));
    assert.deepEqual(store._state().days, ['2026-09-18']);
});
