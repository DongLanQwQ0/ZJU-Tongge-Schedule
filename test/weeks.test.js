'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const weeks = require('../shared/weeks.js');

// 基准学期：2026-09-14（周一）为第 1 周
const BASE = '20260914';

test('周一计算：周内任意一天都回落到同一个周一', () => {
    assert.equal(weeks.mondayOf('20260914'), '20260914');   // 周一
    assert.equal(weeks.mondayOf('20260916'), '20260914');   // 周三
    assert.equal(weeks.mondayOf('20260920'), '20260914');   // 周日
    assert.equal(weeks.mondayOf('20260921'), '20260921');   // 下周一
});

test('周序号：第 1 周起算，早于基准一律算第 1 周', () => {
    assert.equal(weeks.weekIndexOf('20260914', BASE), 1);
    assert.equal(weeks.weekIndexOf('20260920', BASE), 1);
    assert.equal(weeks.weekIndexOf('20260921', BASE), 2);
    assert.equal(weeks.weekIndexOf('20270104', BASE), 17);
    assert.equal(weeks.weekIndexOf('20260101', BASE), 1, '早于基准不出现 0 或负数');
});

test('第 n 周的周一', () => {
    assert.equal(weeks.mondayOfWeek(BASE, 1), '20260914');
    assert.equal(weeks.mondayOfWeek(BASE, 3), '20260928');
    assert.equal(weeks.mondayOfWeek(BASE, 17), '20270104');
});

test('按周过滤：只留该周的日期，不改动入参', () => {
    const slots = [{
        course: '甲', day: 1, startPeriod: 1, endPeriod: 1,
        startTime: '08:00', endTime: '08:45', location: 'X',
        dates: ['20260914', '20260921', '20260928']
    }];
    const out = weeks.filterByWeek(slots, '20260921');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].dates, ['20260921']);
    assert.equal(slots[0].dates.length, 3, '原数组未被修改');

    assert.deepEqual(weeks.filterByWeek(slots, '20260101'), [], '该周无课返回空');
});

test('按周次奇偶拆分：单周与双周各归各的', () => {
    const slots = [{
        course: '甲', day: 1, startPeriod: 1, endPeriod: 1, startTime: '08:00', endTime: '08:45',
        location: 'X',
        dates: ['20260914', '20260921', '20260928', '20261005']   // 第 1,2,3,4 周
    }];
    const { odd, even } = weeks.splitByParity(slots, BASE);
    assert.deepEqual(odd[0].dates, ['20260914', '20260928']);
    assert.deepEqual(even[0].dates, ['20260921', '20261005']);
});

test('学期窗口：从最早日期所在周到最晚日期所在周', () => {
    const w = weeks.semesterWindow([[
        { dates: ['20260916', '20260928'] },
        { dates: ['20261019'] }
    ]]);
    assert.equal(w.baseMonday, '20260914');
    assert.equal(w.weekCount, 6);           // 9/28 是第 3 周，10/19 是第 6 周
    assert.equal(weeks.weekOptions(w).length, 6);
    assert.equal(weeks.weekOptions(w)[0].label, '第 1 周');
});

// ---------------------------------------------------------------- 年内周次

test('年内周次：ISO 规则，含 1 月 4 日的那周是第 1 周', () => {
    // 2026-01-01 是周四 -> 该周（2025-12-29 起）就是 2026 年第 1 周
    assert.equal(weeks.yearWeekOf('20260101'), 1);
    assert.equal(weeks.yearWeekOf('20260104'), 1);   // 周日，仍属第 1 周
    assert.equal(weeks.yearWeekOf('20260105'), 2);   // 周一，进入第 2 周
    // 2027-01-04 是周一 -> 2027 年第 1 周
    assert.equal(weeks.yearWeekOf('20270104'), 1);
    // 2026-12-28 那一周的周四落在 2026 年，归为 2026 年第 53 周（2026 年共 53 个 ISO 周）
    assert.equal(weeks.yearWeekOf('20261228'), 53);
    assert.equal(weeks.yearWeekOf('20270101'), 53);
});

test('年内周次：2026-09-14 是第 38 周，且与教学周无关', () => {
    assert.equal(weeks.yearWeekOf('20260914'), 38);
    assert.equal(weeks.mondayOf('20260914'), '20260914');
    // 同一天的年内周次不随「教学周基准」变化 —— 这正是它比教学周更稳的地方
    assert.equal(weeks.yearWeekOf('20260914'), 38);
});

test('周次选项：教学周与年内周次并列，并给出周一到周日的日期范围', () => {
    const opts = weeks.weekOptions({ baseMonday: '20260914', weekCount: 3 });
    assert.equal(opts[0].label, '第 1 周');
    assert.equal(opts[0].yearLabel, '年38周');
    assert.equal(opts[0].yearWeek, 38);
    assert.equal(opts[0].range, '9/14 ~ 9/20');
    assert.equal(opts[0].shortRange, '9/14~9/20');
    // 「本周」按传入的当天算：2026-09-16 落在第 1 周（9/14~9/20）
    const withNow = weeks.weekOptions({ baseMonday: '20260914', weekCount: 4 }, new Date(2026, 8, 16));
    assert.equal(withNow[0].isCurrent, true);
    assert.equal(withNow[1].isCurrent, false);
    // 整段学期都不包含今天时，没有任何一周会被标成本周
    const faraway = weeks.weekOptions({ baseMonday: '20260914', weekCount: 4 }, new Date(2027, 4, 1));
    assert.equal(faraway.filter((o) => o.isCurrent).length, 0);
    // 跨年时教学周连续、年内周次会跳回 1
    const crossYear = weeks.weekOptions({ baseMonday: '20261221', weekCount: 4 });
    assert.deepEqual(crossYear.map((o) => o.label), ['第 1 周', '第 2 周', '第 3 周', '第 4 周']);
    assert.deepEqual(crossYear.map((o) => o.yearWeek), [52, 53, 1, 2]);
});

test('年内周次不受课表里混入的调休日期影响（教学周会受影响）', () => {
    const clean = weeks.semesterWindow([[{ dates: ['20260916', '20260923'] }]]);
    // 多塞一个 9/2 的调休补课日期，教学周基准整体前移两周
    const dirty = weeks.semesterWindow([[{ dates: ['20260902', '20260916', '20260923'] }]]);

    assert.equal(clean.baseMonday, '20260914');
    assert.equal(dirty.baseMonday, '20260831');
    // 同一天 2026-09-16：教学周从「第 1 周」变成了「第 3 周」……
    assert.equal(weeks.weekIndexOf('20260916', clean.baseMonday), 1);
    assert.equal(weeks.weekIndexOf('20260916', dirty.baseMonday), 3);
    // ……但年内周次始终是第 38 周，这就是它存在的意义
    assert.equal(weeks.yearWeekOf('20260916'), 38);
    assert.equal(weeks.yearWeekOf('20261010'), 41);
});

test('学期窗口：无任何日期时返回空窗口，不抛异常', () => {
    assert.deepEqual(weeks.semesterWindow([[]]), { baseMonday: null, lastMonday: null, weekCount: 0 });
    assert.deepEqual(weeks.weekOptions(null), []);
});

test('默认周：优先今天所在周', () => {
    const w = { baseMonday: BASE, weekCount: 18 };
    const slots = [{ dates: ['20260914'] }, { dates: ['20261012'] }];
    // 2026-10-14 是第 5 周的周三，且第 5 周确实有课
    const r = weeks.resolveDefaultWeek([slots], w, new Date(2026, 9, 14));
    assert.equal(r.weekIndex, 5);
    assert.equal(r.fellBack, false);
});

test('默认周：今天所在周无课时退回到最近的有课周', () => {
    const w = { baseMonday: BASE, weekCount: 18 };
    // 只有第 1 周和第 3 周有课，今天在第 8 周
    const only = [{ dates: ['20260914', '20260928'] }];
    const r = weeks.resolveDefaultWeek([only], w, new Date(2026, 10, 4));   // 11/4 属第 8 周
    assert.equal(r.fellBack, true);
    assert.equal(r.weekIndex, 3, '第 3 周比第 1 周更近');
});

test('默认周：今天超出学期范围时被夹到边界，无课再回退', () => {
    const w = { baseMonday: BASE, weekCount: 3 };
    const slots = [{ dates: ['20260914'] }];
    // 早于学期 -> 夹到第 1 周，恰好有课
    assert.equal(weeks.resolveDefaultWeek([slots], w, new Date(2026, 0, 1)).weekIndex, 1);
    // 晚于学期 -> 夹到第 3 周，但第 3 周无课，回退到最近的第 1 周
    const late = weeks.resolveDefaultWeek([slots], w, new Date(2027, 5, 1));
    assert.equal(late.weekIndex, 1);
    assert.equal(late.fellBack, true);
});

test('默认周：双方都没有课时不谎报 hasClass', () => {
    const w = { baseMonday: BASE, weekCount: 5 };
    assert.equal(weeks.resolveDefaultWeek([[], []], w, new Date(2026, 9, 14)).hasClass, false);
});

test('实际有课周集合', () => {
    const slots = [{ dates: ['20260914', '20260928', '20261019'] }];
    assert.deepEqual(weeks.activeWeeks(slots, BASE), [1, 3, 6]);
});
