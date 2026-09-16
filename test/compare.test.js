'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cmp = require('../shared/compare.js');
const ics = require('../shared/ics.js');
const weeks = require('../shared/weeks.js');

const BASE = '20260914';

function slot(o) {
    return Object.assign({
        course: '某课', day: 1, startPeriod: 1, endPeriod: 1,
        startTime: '08:00', endTime: '08:45',
        location: '紫金港东6-328', dates: ['20260914']
    }, o);
}

// 奇数教学周（1,3,5,7,9,11 周）与偶数教学周（2,4,6,8,10 周）
const ODD = ['20260914', '20260928', '20261012', '20261026', '20261109', '20261123'];
const EVEN = ['20260921', '20261005', '20261019', '20261102', '20261116'];

// ---------------------------------------------------------------- 网格

test('buildGrid：把多课时课程铺满区间，并标出续格', () => {
    const g = cmp.buildGrid([slot({ startPeriod: 3, endPeriod: 4, startTime: '10:00', endTime: '11:35' })], []);
    assert.equal(g.cells['1-3'].level, 'single');
    assert.equal(g.cells['1-3'].a[0].isFirst, true);
    assert.equal(g.cells['1-4'].a[0].isFirst, false, '第 4 节是续格，界面显示「同上」');
});

test('buildGrid：五档等级与统计', () => {
    const pairs = [
        ['紫金港东6-328', '紫金港东6-328', 'same'],
        ['紫金港东6-328', '紫金港东6-210', 'nearby'],
        ['紫金港东6-328', '紫金港东2-101', 'area'],
        ['紫金港东6-328', '紫金港西1-216', 'cross'],
        ['未知', '紫金港东6-328', 'unknown']
    ];
    pairs.forEach(([la, lb, level], i) => {
        const g = cmp.buildGrid([slot({ location: la })], [slot({ location: lb })]);
        assert.equal(g.cells['1-1'].level, level, `${la} vs ${lb}`);
    });

    const g = cmp.buildGrid([slot({ location: '紫金港东6-328' })], [slot({ location: '紫金港东6-210' })]);
    assert.deepEqual(g.stats, { same: 0, nearby: 1, area: 0, cross: 0, unknown: 0, total: 1 });
});

test('buildGrid：单人课不参与配色统计', () => {
    const g = cmp.buildGrid([slot({})], []);
    assert.deepEqual(g.stats, { same: 0, nearby: 0, area: 0, cross: 0, unknown: 0, total: 0 });
});

test('compareInWeek：按周过滤后再比对', () => {
    const A = [slot({ dates: ['20260914'], location: '紫金港东6-328' })];
    const B = [slot({ dates: ['20260914', '20260928'], location: '紫金港东6-328' })];
    assert.equal(cmp.compareInWeek(A, B, '20260914').stats.total, 1, '第 1 周重合');
    assert.equal(cmp.compareInWeek(A, B, '20260928').stats.total, 0, '第 3 周只有 B 有课');
});

test('compareInWeek：屏幕不丢弃单次条目（数据保真）', () => {
    const A = [slot({ dates: ['20261010'] })];   // 只出现一次：调休补课
    const B = [slot({ dates: ['20261010'] })];
    assert.equal(cmp.compareInWeek(A, B, '20261005').stats.total, 1);
});

// ---------------------------------------------------------------- 重合统计

test('overlapInWeek：按节计数，一格只算一节', () => {
    // 双方同一门课各占 3 节
    const A = [slot({ startPeriod: 6, endPeriod: 8, startTime: '13:25', endTime: '15:50', dates: ['20260914'] })];
    const B = [slot({ startPeriod: 6, endPeriod: 8, startTime: '13:25', endTime: '15:50', dates: ['20260914'] })];
    const s = cmp.overlapInWeek(A, B, BASE);
    assert.equal(s.same, 3, '3 节算 3 节，不是 1 门课');
    assert.equal(s.total, 3);
});

test('overlapWithMembers：逐个成员给出分级统计', () => {
    const me = [slot({ dates: ['20260914'], location: '紫金港东6-328' })];
    const members = [
        { id: 'me', isMe: true, courses: me },
        { id: 'x', courses: [slot({ dates: ['20260914'], location: '紫金港东6-210' })] },
        { id: 'y', courses: [slot({ dates: ['20260928'], location: '紫金港东6-328' })] }
    ];
    const out = cmp.overlapWithMembers(me, members, BASE);
    assert.equal(out.me, undefined, '自己不与自己比');
    assert.equal(out.x.nearby, 1);
    assert.equal(out.y.total, 0, '不同周不重合');
});

// ---------------------------------------------------------------- 导出视图

test('导出：单双周地点不同 -> 标注单周/双周两套', () => {
    const A = [
        slot({ course: '音响', startPeriod: 11, endPeriod: 11, startTime: '18:50', endTime: '19:35', location: '紫金港北4-313', dates: ODD }),
        slot({ course: '音响', startPeriod: 11, endPeriod: 11, startTime: '18:50', endTime: '19:35', location: '紫金港东4-322', dates: EVEN })
    ];
    const ex = cmp.buildExportGrid(A, [], BASE);
    assert.equal(ex.parity, true);
    const v = ex.cells['1-11'].variants;
    assert.equal(v.length, 2);
    assert.deepEqual(v.map((x) => x.label), ['单周', '双周']);
    assert.equal(v[0].cell.a[0].location, '紫金港北4-313');
    assert.equal(v[1].cell.a[0].location, '紫金港东4-322');
});

test('导出：单双周内容一致 -> 不产生任何标注（「一致就不管他」）', () => {
    // 同一门课同一地点贯穿单双周
    const A = [slot({ course: '微积分', dates: ODD.concat(EVEN) })];
    const B = [slot({ course: '微积分', dates: ODD.concat(EVEN) })];
    const ex = cmp.buildExportGrid(A, B, BASE);
    assert.equal(ex.parity, false, '整图无单双周差异');
    assert.equal(ex.cells['1-1'].variants.length, 1);
    assert.equal(ex.cells['1-1'].variants[0].label, null);
});

test('导出：只在单周有课 -> 只标注存在的那个view', () => {
    const A = [slot({ course: '单周课', dates: ODD })];
    const ex = cmp.buildExportGrid(A, [], BASE);
    assert.equal(ex.parity, true);
    assert.deepEqual(ex.cells['1-1'].variants.map((x) => x.label), ['单周']);
});

test('导出：规律性过滤剔除只出现一次的考试/补课条目', () => {
    const A = [
        slot({ course: '常规课', dates: ODD.concat(EVEN) }),          // 11 次
        slot({ course: '期末考试', startPeriod: 3, endPeriod: 5, dates: ['20270104'] }),  // 1 次
        slot({ course: '调休补课', startPeriod: 6, endPeriod: 8, dates: ['20261010'] })   // 1 次
    ];
    const ex = cmp.buildExportGrid(A, [], BASE);
    assert.equal(ex.dropped.a, 2, '两个单次条目被剔除');
    assert.equal(ex.cells['1-3'], undefined, '考试条目不再制造格子');
    assert.equal(ex.cells['1-6'], undefined, '补课条目不再制造格子');
    assert.ok(ex.cells['1-1'], '常规课仍在');

    // 阈值可调：不过滤时假差异立刻出现
    const raw = cmp.buildExportGrid(A, [], BASE, { minOccurrences: 1 });
    assert.equal(raw.dropped.a, 0);
    assert.ok(raw.cells['1-3'], '不过滤时考试条目出现');
});

test('导出：背景色取单双周两套里更优的等级', () => {
    const A = [
        slot({ course: '甲', startPeriod: 11, endPeriod: 11, location: '紫金港东6-328', dates: ODD }),
        slot({ course: '甲', startPeriod: 11, endPeriod: 11, location: '紫金港东6-328', dates: EVEN })
    ];
    const B = [
        slot({ course: '乙', startPeriod: 11, endPeriod: 11, location: '紫金港东6-328', dates: ODD }),   // 同教室
        slot({ course: '乙', startPeriod: 11, endPeriod: 11, location: '紫金港西1-216', dates: EVEN })  // 跨区
    ];
    const ex = cmp.buildExportGrid(A, B, BASE);
    assert.equal(ex.cells['1-11'].level, 'same', 'same 优先于 cross');
    assert.equal(ex.cells['1-11'].variants.length, 2, '两套不同仍需分别标注');
});

test('导出：整格无课时不产出格子', () => {
    const ex = cmp.buildExportGrid([], [], BASE);
    assert.deepEqual(Object.keys(ex.cells), []);
    assert.equal(ex.parity, false);
});

// ---------------------------------------------------------------- 真实数据回归

test('真实数据：导出只标注 5 格单双周，且正是那两门课', () => {
    const ROOT = path.join(__dirname, '..');
    // 真实课表含真实姓名，已在 .gitignore 里排除；按内容认文件，不写死文件名
    const real = fs.existsSync(ROOT)
        ? fs.readdirSync(ROOT).filter((f) => /\.ics$/i.test(f)).sort().map((f) => ({
            file: f,
            slots: ics.parseICS(fs.readFileSync(path.join(ROOT, f), 'utf8'))
        }))
        : [];
    // 甲 = 有「音响技术与家庭影院」那份；乙 = 另一份槽位数相同的
    const A = real.find((r) => r.slots.some((s) => s.course === '音响技术与家庭影院'));
    if (!A) return;
    const B = real.find((r) => r !== A && r.slots.length === A.slots.length);
    if (!B) return;

    const w = weeks.semesterWindow([A.slots, B.slots]);
    const ex = cmp.buildExportGrid(A.slots, B.slots, w.baseMonday);

    assert.equal(w.baseMonday, '20260914');
    assert.equal(w.weekCount, 18);
    assert.equal(ex.dropped.a, 20, '甲的 20 个单次条目（考试/补课）被剔除');
    assert.equal(ex.dropped.b, 18);

    const diff = Object.keys(ex.cells).filter((k) => ex.cells[k].variants.length > 1).sort();
    // 音响技术与家庭影院 周一 p11-12；数字音视频基础与制作 周四 p6-8
    assert.deepEqual(diff, ['1-11', '1-12', '4-6', '4-7', '4-8']);
});
