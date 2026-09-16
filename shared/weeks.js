/**
 * 教学周计算、按周过滤、单双周拆分。
 *
 * 纯函数模块：不得引用 document / window / localStorage / require('node:*')，
 * 以便原样复制到微信小程序的 .js 中。
 *
 * 设计要点：本模块不推算单双周奇偶，只按槽位里真实存在的日期判定。
 * 调休、临时加课、某周停课等情况因此天然正确。
 */
(function (root, factory) {
    'use strict';
    var isNode = typeof module === 'object' && module.exports;
    var mod = factory();
    if (isNode) module.exports = mod;
    else (root.DSH = root.DSH || {}).weeks = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var DAY_MS = 86400000;
    var WEEK_MS = 7 * DAY_MS;

    function pad2(n) { return String(n).padStart(2, '0'); }

    /** 'YYYYMMDD' -> UTC 毫秒（只用做日期算术，避开本地时区） */
    function toUTC(dateStr) {
        return Date.UTC(
            Number(String(dateStr).slice(0, 4)),
            Number(String(dateStr).slice(4, 6)) - 1,
            Number(String(dateStr).slice(6, 8))
        );
    }

    /** UTC 毫秒 -> 'YYYYMMDD' */
    function fromUTC(ms) {
        var d = new Date(ms);
        return '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
    }

    /** Date 对象（本地时区）-> 'YYYYMMDD' */
    function dateToStr(date) {
        return '' + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate());
    }

    /** 某个日期所在周的周一 */
    function mondayOf(dateStr) {
        var ms = toUTC(dateStr);
        var dow = new Date(ms).getUTCDay();        // 0=周日
        var offset = dow === 0 ? 6 : dow - 1;      // 周一为 0
        return fromUTC(ms - offset * DAY_MS);
    }

    /** 今天的 'YYYYMMDD'（本地时区） */
    function todayStr(now) {
        return dateToStr(now ? new Date(now) : new Date());
    }

    /** 今天所在周的周一 */
    function currentMonday(now) {
        return mondayOf(todayStr(now));
    }

    /** 第 n 周（1 起）的周一 */
    function mondayOfWeek(baseMonday, weekIndex) {
        return fromUTC(toUTC(baseMonday) + (weekIndex - 1) * WEEK_MS);
    }

    /**
     * 某日期相对基准周的周序号（1 起）。
     * 早于基准周的日期一律算第 1 周，避免出现 0 或负数。
     */
    function weekIndexOf(dateStr, baseMonday) {
        var diff = toUTC(dateStr) - toUTC(baseMonday);
        if (diff < 0) return 1;
        return Math.floor(diff / WEEK_MS) + 1;
    }

    /** 收集多份槽位数组里所有日期，得到学期基准周一与总周数 */
    function semesterWindow(slotGroups) {
        var min = null, max = null;
        (Array.isArray(slotGroups) ? slotGroups : []).forEach(function (slots) {
            if (!Array.isArray(slots)) return;
            slots.forEach(function (s) {
                (s.dates || []).forEach(function (d) {
                    if (min === null || d < min) min = d;
                    if (max === null || d > max) max = d;
                });
            });
        });
        if (min === null) return { baseMonday: null, lastMonday: null, weekCount: 0 };
        var base = mondayOf(min);
        var last = mondayOf(max);
        return {
            baseMonday: base,
            lastMonday: last,
            weekCount: weekIndexOf(max, base)
        };
    }

    /**
     * 某日期在自然年里的 ISO 周次（1–53）。
     *
     * 与课表内容无关，只由日期决定 —— 所以课表里混进调休补课、期末考试之类的
     * 零散日期时，这个数字也不会跟着偏。用来给「第 N 周」补一个绝对参照。
     * ISO 规则：含 1 月 4 日的那一周是这个自然年的第 1 周，跨年周归给含周四的那年。
     */
    function yearWeekOf(dateStr) {
        var mon = mondayOf(dateStr);
        var monMs = toUTC(mon);
        var year = new Date(monMs + 3 * DAY_MS).getUTCFullYear();   // 该周的周四决定年份
        var week1Monday = toUTC(mondayOf(fromUTC(Date.UTC(year, 0, 4))));
        return Math.floor((monMs - week1Monday) / WEEK_MS) + 1;
    }

    /** 'YYYYMMDD' -> 'M/D'，用于周次胶囊的提示 */
    function shortDate(dateStr) {
        return Number(String(dateStr).slice(4, 6)) + '/' + Number(String(dateStr).slice(6, 8));
    }

    /**
     * 周次选项。
     * @param window semesterWindow() 的结果
     * @param now 用来判断哪一周是「本周」，不传则用当前时间
     */
    function weekOptions(window, now) {
        var out = [];
        if (!window || !window.baseMonday) return out;
        var thisMonday = currentMonday(now);
        for (var i = 1; i <= window.weekCount; i++) {
            var mon = mondayOfWeek(window.baseMonday, i);
            var sun = fromUTC(toUTC(mon) + 6 * DAY_MS);
            out.push({
                index: i,
                monday: mon,
                // label 是教学周（从课表最早日期那周起算），yearLabel 是同一天的年内周次
                label: '第 ' + i + ' 周',
                yearWeek: yearWeekOf(mon),
                yearLabel: '年' + yearWeekOf(mon) + '周',
                range: shortDate(mon) + ' ~ ' + shortDate(sun),
                shortRange: shortDate(mon) + '~' + shortDate(sun),
                isCurrent: mon === thisMonday
            });
        }
        return out;
    }

    /**
     * 只保留 dates 落在指定周（周一那周）内的槽位。
     * 返回新对象，不改动入参。
     */
    function filterByWeek(slots, mondayStr) {
        if (!mondayStr || !Array.isArray(slots)) return [];
        var start = toUTC(mondayStr);
        var end = start + WEEK_MS;
        var out = [];
        slots.forEach(function (s) {
            var keep = (s.dates || []).filter(function (d) {
                var t = toUTC(d);
                return t >= start && t < end;
            });
            if (keep.length) {
                var copy = Object.assign({}, s);
                copy.dates = keep;
                out.push(copy);
            }
        });
        return out;
    }

    /**
     * 按周次奇偶拆成两套视图，供导出图片使用（§12）。
     * @returns {{odd:Array, even:Array}}
     */
    function splitByParity(slots, baseMonday) {
        var odd = [], even = [];
        if (!Array.isArray(slots)) return { odd: odd, even: even };
        slots.forEach(function (s) {
            var o = [], e = [];
            (s.dates || []).forEach(function (d) {
                if (weekIndexOf(d, baseMonday) % 2 === 1) o.push(d); else e.push(d);
            });
            if (o.length) { var c1 = Object.assign({}, s); c1.dates = o; odd.push(c1); }
            if (e.length) { var c2 = Object.assign({}, s); c2.dates = e; even.push(c2); }
        });
        return { odd: odd, even: even };
    }

    /** 某份课表在整个学期里实际有课的周序号集合 */
    function activeWeeks(slots, baseMonday) {
        var set = Object.create(null);
        (Array.isArray(slots) ? slots : []).forEach(function (s) {
            (s.dates || []).forEach(function (d) { set[weekIndexOf(d, baseMonday)] = true; });
        });
        return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }

    /**
     * 选出「默认展示周」：优先今天所在周；若该周双方都无课，
     * 退回到距今天最近的、至少有一方有课的周。
     * @returns {{weekIndex:number, fellBack:boolean, hasClass:boolean}}
     */
    function resolveDefaultWeek(slotGroups, window_, now) {
        if (!window_ || !window_.baseMonday) return { weekIndex: 1, fellBack: false, hasClass: false };
        var base = window_.baseMonday;
        var target = weekIndexOf(todayStr(now), base);
        if (target < 1) target = 1;
        if (target > window_.weekCount) target = window_.weekCount;

        var has = function (idx) {
            return (Array.isArray(slotGroups) ? slotGroups : []).some(function (slots) {
                return filterByWeek(slots, mondayOfWeek(base, idx)).length > 0;
            });
        };

        if (has(target)) return { weekIndex: target, fellBack: false, hasClass: true };

        for (var d = 1; d <= window_.weekCount; d++) {
            var before = target - d, after = target + d;
            if (before >= 1 && has(before)) return { weekIndex: before, fellBack: true, hasClass: true };
            if (after <= window_.weekCount && has(after)) return { weekIndex: after, fellBack: true, hasClass: true };
        }
        return { weekIndex: target, fellBack: false, hasClass: false };
    }

    return {
        DAY_MS: DAY_MS,
        WEEK_MS: WEEK_MS,
        toUTC: toUTC,
        fromUTC: fromUTC,
        dateToStr: dateToStr,
        mondayOf: mondayOf,
        todayStr: todayStr,
        currentMonday: currentMonday,
        mondayOfWeek: mondayOfWeek,
        weekIndexOf: weekIndexOf,
        yearWeekOf: yearWeekOf,
        shortDate: shortDate,
        semesterWindow: semesterWindow,
        weekOptions: weekOptions,
        filterByWeek: filterByWeek,
        splitByParity: splitByParity,
        activeWeeks: activeWeeks,
        resolveDefaultWeek: resolveDefaultWeek
    };
});
