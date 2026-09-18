'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../shared/stats.js');

/** 本地时间的时间戳。全部用本地构造，这样测试不依赖机器时区 */
const at = (y, m, d, hh = 10, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

// ---------------------------------------------------------------- 日期

test('dayKey：本地日，跨零点才换天', () => {
    assert.equal(S.dayKey(at(2026, 9, 18, 0, 0)), '2026-09-18');
    assert.equal(S.dayKey(at(2026, 9, 18, 23, 59)), '2026-09-18');
    assert.equal(S.dayKey(at(2026, 9, 19, 0, 1)), '2026-09-19');
    // 月和日都要补零：文件名字典序就是时间序，靠的就是这个
    assert.equal(S.dayKey(at(2026, 1, 5)), '2026-01-05');
});

test('addDays：跨月、跨年、闰年都对（用的是日期分量，不是毫秒差）', () => {
    assert.equal(S.addDays('2026-09-18', 1), '2026-09-19');
    assert.equal(S.addDays('2026-09-30', 1), '2026-10-01');
    assert.equal(S.addDays('2026-10-01', -1), '2026-09-30');
    assert.equal(S.addDays('2026-01-01', -1), '2025-12-31');
    // 2026 不是闰年，2028 是
    assert.equal(S.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(S.addDays('2028-03-01', -1), '2028-02-29');
    // 平移 0 天应当原样返回（幂等）
    for (const day of ['2026-01-01', '2026-06-15', '2026-12-31']) {
        assert.equal(S.addDays(day, 0), day);
    }
});

test('dayKeys：闭区间的连续日历天', () => {
    assert.deepEqual(S.dayKeys('2026-09-16', '2026-09-18'), ['2026-09-16', '2026-09-17', '2026-09-18']);
    assert.deepEqual(S.dayKeys('2026-09-18', '2026-09-18'), ['2026-09-18']);
    assert.equal(S.dayKeys('2026-09-18', '2026-09-17').length, 0, '起点晚于终点就是空，不是死循环');
    // 跨月
    assert.equal(S.dayKeys('2026-09-29', '2026-10-02').join(','), '2026-09-29,2026-09-30,2026-10-01,2026-10-02');
    // 90 天窗口（最长的白名单）
    assert.equal(S.dayKeys(S.addDays('2026-09-18', -89), '2026-09-18').length, 90);
});

// ---------------------------------------------------------------- 记账

test('请求级：同一账号同一天记五次，活跃人数还是 1，请求数是 5', () => {
    const b = S.emptyBucket('2026-09-18');
    for (let i = 0; i < 5; i++) S.touch(b, 'u_a', at(2026, 9, 18, 9, i));
    assert.equal(Object.keys(b.users).length, 1, '去重是结构自带的');
    assert.equal(b.requests, 5);
    assert.equal(b.users.u_a.req, 5);
    assert.equal(b.users.u_a.lastAt, at(2026, 9, 18, 9, 4), 'lastAt 取最晚那一次');

    S.touch(b, 'u_b', at(2026, 9, 18, 11));
    assert.equal(Object.keys(b.users).length, 2);
    assert.equal(b.requests, 6);
});

test('登录 / 注册 / 动作各自独立计数，不互相污染', () => {
    const b = S.emptyBucket('2026-09-18');
    const t = at(2026, 9, 18, 8);
    S.noteLogin(b, 'u_a', t);        // 登录发生在拿到令牌之前，不经过请求级挂点
    S.noteLogin(b, 'u_a', t + 1000);
    S.noteNewUser(b, 'u_b', t);
    S.bump(b, 'u_a', 'course_upload', t);

    assert.equal(b.logins, 2);
    assert.deepEqual(b.newUsers, ['u_b']);
    assert.equal(b.users.u_a.logins, 2);
    assert.equal(b.users.u_a.req, 0, '登录不该顺手把请求数加一');
    assert.equal(b.users.u_a.acts.course_upload, 1);
    // 注册的人也算当天活跃：他做了事，只是还没令牌
    assert.ok(b.users.u_b);
    assert.equal(b.requests, 0, '这几种都不算请求');
});

test('注册：同一个人重复记也只出现在 newUsers 里一次', () => {
    const b = S.emptyBucket('2026-09-18');
    S.noteNewUser(b, 'u_a', at(2026, 9, 18));
    S.noteNewUser(b, 'u_a', at(2026, 9, 18));
    assert.deepEqual(b.newUsers, ['u_a']);
});

test('动作：白名单之外的 key 一律丢弃', () => {
    const b = S.emptyBucket('2026-09-18');
    assert.equal(S.bump(b, 'u_a', 'course_upload', at(2026, 9, 18)), true);
    // 开放成任意字符串的话，统计表会慢慢长成第二份审计日志
    assert.equal(S.bump(b, 'u_a', '随便写的动作', at(2026, 9, 18)), false);
    assert.equal(S.bump(b, 'u_a', '__proto__', at(2026, 9, 18)), false);
    assert.deepEqual(Object.keys(b.users.u_a.acts), ['course_upload']);
});

// ---------------------------------------------------------------- 聚合

/** 造一个「7 天前的桶 + 今天的桶」：两个新增，其中一个今天回来了 */
function retentionFixture() {
    const d7 = S.emptyBucket('2026-09-11');
    S.noteNewUser(d7, 'u_a', at(2026, 9, 11));
    S.noteNewUser(d7, 'u_b', at(2026, 9, 11));
    S.touch(d7, 'u_a', at(2026, 9, 11, 12));

    const today = S.emptyBucket('2026-09-18');
    S.touch(today, 'u_a', at(2026, 9, 18, 9));
    S.touch(today, 'u_c', at(2026, 9, 18, 9));
    S.noteLogin(today, 'u_c', at(2026, 9, 18, 9));
    S.bump(today, 'u_a', 'course_upload', at(2026, 9, 18, 9));
    return { d7, today };
}

test('聚合：跨天去重、今日快照、新增总数、动作合计', () => {
    const { d7, today } = retentionFixture();
    const out = S.summarize([d7, today], { today: '2026-09-18', days: 30 });

    assert.equal(out.series.length, 30, '窗口是日历天，缺的天也要占位');
    assert.equal(out.series[0].day, '2026-08-20');
    assert.equal(out.series[29].day, '2026-09-18');
    // 中间那几天没有任何活动 -> 全 0，而不是被跳过（跳过着画，折线会把两个不挨着的天连起来）
    const hole = out.series.find((r) => r.day === '2026-09-15');
    assert.equal(hole.active, 0);
    assert.equal(hole.requests, 0);

    assert.deepEqual(out.summary.today, { active: 2, newUsers: 0, logins: 1, requests: 2 });
    // u_a 出现在两天里，但区间活跃人数是并集：u_a / u_b / u_c
    assert.equal(out.summary.range.activeUnique, 3, '不能把每天的人数相加');
    assert.equal(out.summary.range.newUsers, 2);
    assert.equal(out.summary.range.requests, 3);
    assert.equal(out.summary.range.avgRequestsPerActive, 1);
    assert.equal(out.summary.actions.course_upload, 1);
    assert.equal(out.summary.actions.group_create, 0, '白名单里的 key 一律给出来，没发生就是 0');
});

test('聚合：7 日留存 = 7 天前新增的人里今天还活跃的比例', () => {
    const { d7, today } = retentionFixture();
    const out = S.summarize([d7, today], { today: '2026-09-18', days: 7 });
    assert.deepEqual(out.summary.retention7, { cohort: 2, returned: 1, rate: 0.5 });
    // 留存要的那一天（today-7）落在 7 天窗口的**外面**一天（窗口是 today-6..today），
    // 所以它照旧算得出来 —— 服务端读桶时要比窗口多读一天，这条钉在这儿免得以后被"优化"掉
    assert.equal(out.summary.range.activeUnique, 2, '窗口内只有今天那两个人');
    assert.ok(!out.series.some((r) => r.day === '2026-09-11'), '9-11 不在 7 天窗口的序列里');
});

test('聚合：没人可算时留存是 0，不是 NaN', () => {
    const out = S.summarize([], { today: '2026-09-18', days: 30 });
    assert.deepEqual(out.summary.retention7, { cohort: 0, returned: 0, rate: 0 });
    assert.equal(out.summary.range.avgRequestsPerActive, 0, '活跃人数为 0 时人均是 0，不是 Infinity');
});

test('聚合：没有任何数据时给出完整的空结果（不是抛错、不是 undefined）', () => {
    const out = S.summarize([], { today: '2026-09-18', days: 90 });
    assert.equal(out.series.length, 90);
    assert.equal(out.from, '2026-06-21');
    assert.equal(out.to, '2026-09-18');
    assert.ok(out.series.every((r) => r.active === 0 && r.requests === 0));
    assert.deepEqual(out.summary.today, { active: 0, newUsers: 0, logins: 0, requests: 0 });
    assert.equal(out.summary.range.activeUnique, 0);
    assert.deepEqual(out.top, []);
});

test('聚合：窗口外的桶不计入', () => {
    const old = S.emptyBucket('2026-08-01');           // 48 天前，30 天窗口之外
    S.touch(old, 'u_z', at(2026, 8, 1));
    const out = S.summarize([old], { today: '2026-09-18', days: 30 });
    assert.equal(out.summary.range.activeUnique, 0);
    assert.equal(out.from, '2026-08-20');
});

test('聚合：活跃榜按活跃天数、再看请求数，昵称由调用方给', () => {
    const b1 = S.emptyBucket('2026-09-17');
    const b2 = S.emptyBucket('2026-09-18');
    S.touch(b1, 'u_quiet', at(2026, 9, 17));      // 只来一天
    S.touch(b1, 'u_busy', at(2026, 9, 17));
    S.touch(b2, 'u_busy', at(2026, 9, 18));
    S.touch(b2, 'u_busy', at(2026, 9, 18, 11));
    S.touch(b2, 'u_quiet', at(2026, 9, 18));      // 两天都来，但请求少

    const names = { u_busy: '话多的', u_quiet: '话少的' };
    const out = S.summarize([b1, b2], { today: '2026-09-18', days: 7, nameOf: (id) => names[id] || id });
    assert.equal(out.top[0].id, 'u_busy', '两天都来、且请求多的排前面');
    assert.equal(out.top[0].nickname, '话多的');
    assert.equal(out.top[0].activeDays, 2);
    assert.equal(out.top[0].requests, 3);
    assert.equal(out.top[1].id, 'u_quiet');
    assert.equal(out.top[1].activeDays, 2);
    assert.equal(out.top[1].requests, 2);
});

// ---------------------------------------------------------------- 折线

test('seriesMax：非有限值当 0，负数不算最大值', () => {
    assert.equal(S.seriesMax([]), 0);
    assert.equal(S.seriesMax([1, 5, '3', NaN, -2, Infinity, null]), 5);
    assert.equal(S.seriesMax([0, 0]), 0);
});

test('sparkPath：按窗口最大值归一化，形状对得上', () => {
    assert.equal(S.sparkPath([0, 4], 100, 40), 'M0 40 L100 0');
    assert.equal(S.sparkPath([0, 2, 4], 100, 40), 'M0 40 L50 20 L100 0');
});

test('sparkPath：退化成确定的结果，绝不出现 NaN', () => {
    assert.equal(S.sparkPath([], 100, 40), '', '没数据就别给 path（前端据此不画 svg）');
    // 全 0：贴着底边的一条直线，而不是空白
    assert.equal(S.sparkPath([0, 0, 0], 120, 28), 'M0 28 L60 28 L120 28');
    // 单点：一小段横线（孤立点画出来看不见）
    assert.equal(S.sparkPath([5], 120, 28), 'M0 0 L120 0');
    // 脏数据：当 0 处理
    const dirty = S.sparkPath([1, NaN, undefined, '2', null], 90, 20);
    assert.equal(dirty.includes('NaN'), false);
    assert.match(dirty, /^M0 /);
});
