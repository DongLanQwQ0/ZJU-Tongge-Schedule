'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ics = require('../shared/ics.js');
const periods = require('../shared/periods.js');
const cmp = require('../shared/compare.js');

const FIX = (name) => path.join(__dirname, '..', name);
const has = (name) => fs.existsSync(FIX(name));

const ROOT = path.join(__dirname, '..');

/* 真实课表含真实姓名，已在 .gitignore 里排除。
   这里靠扫描目录来拿它们，而不是在代码里写死文件名 —— 免得把同学的名字
   写进提交记录。换名字重新导出一份也照样能跑。
   文件不在时（比如刚 clone 下来）相关断言自动跳过。 */
const REAL = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT)
        .filter((f) => /\.ics$/i.test(f))
        .sort()
        .map((f) => ({
            file: f,
            slots: ics.parseICS(fs.readFileSync(path.join(ROOT, f), 'utf8'))
        }))
    : [];

/** 含某门课的那份真实课表；没有就返回 null */
const realWith = (course) => REAL.find((r) => r.slots.some((s) => s.course === course));

// ---------------------------------------------------------------- 折行与转义

test('ICS 折行还原：续行被拼回同一行', () => {
    const folded = 'LOCATION:紫金港东6-328,\r\n 浙江大学紫金港校区';
    assert.equal(ics.unfold(folded), 'LOCATION:紫金港东6-328,浙江大学紫金港校区');
});

test('ICS 转义还原', () => {
    assert.equal(ics.unescapeText('大学英语\\,Ⅲ'), '大学英语,Ⅲ');
    assert.equal(ics.unescapeText('第一行\\n第二行'), '第一行 第二行');
});

test('日期时间解析：本地 / UTC / 全天', () => {
    assert.deepEqual(ics.parseDateTime('20260914T100000'), { date: '20260914', time: '10:00' });
    // UTC 02:00 -> 北京时间 10:00
    assert.deepEqual(ics.parseDateTime('20260914T020000Z'), { date: '20260914', time: '10:00' });
    // UTC 跨日：20:00 UTC = 次日 04:00 北京
    assert.deepEqual(ics.parseDateTime('20260914T200000Z'), { date: '20260915', time: '04:00' });
    assert.equal(ics.parseDateTime('20260914').time, null);
    assert.equal(ics.parseDateTime('乱码'), null);
});

// ---------------------------------------------------------------- 解析

test('parseICS 从真实文件解析出的槽位数符合基准', { skip: !REAL.length }, () => {
    // 只断言「槽位数的集合」：三份分别是 39 / 39 / 35。
    // 不写文件名，一样能锁住解析结果没变。
    const counts = REAL.map((r) => r.slots.length).sort((a, b) => a - b);
    assert.deepEqual(counts, [35, 39, 39], '三份真实课表的槽位数');

    REAL.forEach(({ file, slots }) => {
        // 其中一份有 2 处单双周地点差异，故比粗粒度的 37 个时段多 2 个槽位
        slots.forEach((s) => {
            assert.ok(s.day >= 1 && s.day <= 7, `${file}: day 合法`);
            assert.ok(s.startPeriod >= 1 && s.startPeriod <= 13, `${file}: startPeriod 合法`);
            assert.ok(s.endPeriod >= s.startPeriod, `${file}: 节次区间有序`);
            assert.ok(s.dates.length >= 1, `${file}: 至少有一次发生日期`);
        });
    });
});

test('单双周的两处地点都被保留（v1 会丢弃第二次）', { skip: !realWith('音响技术与家庭影院') }, () => {
    const slots = realWith('音响技术与家庭影院').slots;

    const audio = slots.filter((s) => s.course === '音响技术与家庭影院');
    assert.deepEqual(audio.map((s) => s.location).sort(), ['紫金港东4-322', '紫金港北4-313']);
    assert.equal(audio.reduce((n, s) => n + s.dates.length, 0), 15, '8 个单周 + 7 个双周');

    // 数字音视频：真正的单双周是周四那两个槽位
    const avThu = slots.filter((s) => s.course === '数字音视频基础与制作' && s.day === 4);
    assert.deepEqual(avThu.map((s) => s.location).sort(), ['紫金港东4-322', '紫金港北4-211']);

    // 另有周一的一条单次条目（20270104 考试周），属于噪声，导出时会被规律性过滤剔除
    const avMon = slots.filter((s) => s.course === '数字音视频基础与制作' && s.day === 1);
    assert.equal(avMon.length, 1);
    assert.equal(avMon[0].dates.length, 1);
    assert.equal(avMon[0].dates[0], '20270104');
    assert.equal(cmp.regularSlots(avMon, 2).length, 0, '单次条目被规律性过滤剔除');
});

test('解析不做单双周奇偶推算：只看真实日期', { skip: !realWith('音响技术与家庭影院') }, () => {
    const slots = realWith('音响技术与家庭影院').slots;
    const audio = slots.find((s) => s.course === '音响技术与家庭影院' && s.location === '紫金港北4-313');
    assert.ok(audio.dates.length >= 5);
    audio.dates.forEach((d) => assert.match(d, /^\d{8}$/));
});

// ---------------------------------------------------------------- 地点解析

test('地点解析：中文楼栋（v1 误判点）', () => {
    const loc = ics.parseLocation('紫金港化学实验中心-424');
    assert.equal(loc.isSpecial, false);
    assert.equal(loc.isUnknown, false);
    assert.equal(loc.area, '未知');
    assert.equal(loc.building, '化学实验中心');
    assert.equal(loc.room, '424');
});

test('地点解析：数字与字母楼栋，1A 与 1 严格区分', () => {
    assert.deepEqual(
        [ics.parseLocation('紫金港东6-328').building, ics.parseLocation('紫金港东6-328').room],
        ['6', '328']
    );
    const a = ics.parseLocation('紫金港东1A-205');
    assert.equal(a.building, '1A');
    assert.notEqual(a.building, ics.parseLocation('紫金港东1-205').building);
});

test('地点解析：带后缀的完整地点串只取第一段', () => {
    const loc = ics.parseLocation('紫金港东6-328, 浙江大学紫金港校区东六教学楼');
    assert.equal(loc.building, '6');
    assert.equal(loc.room, '328');
});

test('地点解析：特殊场地类别与方位', () => {
    const track = ics.parseLocation('紫金港田径场（东）');
    assert.equal(track.isSpecial, true);
    assert.equal(track.category, '田径场');
    assert.equal(track.direction, '东');
    assert.equal(ics.parseLocation('紫金港田径场（西）').direction, '西');

    // 顺序敏感：必须先识别「风雨操场」，而不是被里面的「篮排球场」抢走
    assert.equal(ics.parseLocation('紫金港风雨操场（篮排球场）').category, '风雨操场');
    assert.equal(ics.parseLocation('银泉足球场').category, '足球场');
    assert.equal(ics.parseLocation('紫金港机房').category, '机房');
});

test('地点解析：未知地点', () => {
    for (const raw of ['未知', '', null, undefined, '-', '未知地点']) {
        assert.equal(ics.parseLocation(raw).isUnknown, true, `raw=${raw}`);
    }
});

// ---------------------------------------------------------------- 比对分级

const C = (a, b) => ics.compareLocation(ics.parseLocation(a), ics.parseLocation(b)).level;

test('比对分级：五档配色', () => {
    assert.equal(C('紫金港东6-328', '紫金港东6-328'), 'same');       // 绿
    assert.equal(C('紫金港东6-328', '紫金港东6-210'), 'nearby');     // 黄
    assert.equal(C('紫金港东6-328', '紫金港东2-101'), 'area');       // 蓝
    assert.equal(C('紫金港东6-328', '紫金港西1-216'), 'cross');      // 红
    assert.equal(C('未知', '紫金港东6-328'), 'unknown');             // 灰
    assert.equal(C('紫金港东6-328', '未知'), 'unknown');
});

test('比对分级：1A 与 1 不可判为同楼栋', () => {
    assert.equal(C('紫金港东1A-205', '紫金港东1-205'), 'area');
});

test('比对分级：中文楼栋与普通教学楼跨区', () => {
    assert.equal(C('紫金港化学实验中心-424', '紫金港化学实验中心-525'), 'nearby');
    assert.equal(C('紫金港化学实验中心-424', '紫金港东6-328'), 'cross');
});

test('比对分级：特殊场地规则', () => {
    assert.equal(C('紫金港田径场（东）', '紫金港田径场（西）'), 'cross');   // 同类不同方位
    assert.equal(C('紫金港田径场（东）', '紫金港田径场（东）'), 'same');
    assert.equal(C('银泉足球场', '紫金港田径场（东）'), 'cross');           // 类别不同
    assert.equal(C('紫金港风雨操场（篮排球场）', '紫金港风雨操场（篮排球场）'), 'same');
    // 特殊 vs 教学楼
    assert.equal(C('紫金港机房', '紫金港东6-328'), 'cross');
});

test('比对分级：特殊场地不能「宁可信其同」', () => {
    // 同一栋楼里的不同场地：跑道与篮排球场 —— 体育课撞课时的真实情况
    assert.equal(C('紫金港风雨操场跑道', '紫金港风雨操场（篮排球场）'), 'nearby');
    assert.equal(C('紫金港风雨操场跑道', '紫金港风雨操场跑道'), 'same');
    // 一方没写方位，不敢断言同一片
    assert.equal(C('紫金港田径场', '紫金港田径场（东）'), 'nearby');
    // 不同校区/园区
    assert.equal(C('银泉足球场', '紫金港足球场（西）'), 'cross');
    // 「其他」是兜底类别，两个不同的未归类场地不能当同一处
    assert.equal(C('紫金港水上码头', '紫金港湖边'), 'nearby');
    assert.equal(C('紫金港水上码头', '紫金港水上码头'), 'same');
    // 机房：同名字才算同
    assert.equal(C('紫金港机房', '紫金港机房（东）'), 'nearby');
});

// ---------------------------------------------------------------- 作息表

test('节次换算：区间覆盖口径', () => {
    assert.deepEqual(periods.periodsFromTime('08:00', '09:35'), { first: 1, last: 2, periods: [1, 2] });
    assert.deepEqual(periods.periodsFromTime('10:00', '11:35'), { first: 3, last: 4, periods: [3, 4] });
    assert.equal(periods.periodsFromTime('07:00', '07:45'), null, '不重叠则丢弃');
    assert.equal(periods.periodsFromTime('22:00', '23:00'), null);
    assert.equal(periods.periodsFromTime('乱', '09:35'), null);
});

test('课表槽位可安全落盘（长度截断 + 日期去重排序）', () => {
    const stored = ics.toStoredSlots([{
        course: 'x'.repeat(200), day: 1, startPeriod: 1, endPeriod: 2,
        startTime: '08:00', endTime: '09:35', location: 'y'.repeat(300),
        dates: ['20260921', '20260914', '20260914']
    }]);
    assert.equal(stored[0].course.length, 60);
    assert.equal(stored[0].location.length, 100);
    assert.deepEqual(stored[0].dates, ['20260914', '20260921']);
});
