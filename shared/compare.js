/**
 * 双人课表比对：格子化、配色等级、重合课时统计、全学期导出视图。
 *
 * 纯函数模块：不得引用 document / window / localStorage / require('node:*')，
 * 以便原样复制到微信小程序的 .js 中。
 */
(function (root, factory) {
    'use strict';
    var isNode = typeof module === 'object' && module.exports;
    var periods = isNode ? require('./periods.js') : (root.DSH = root.DSH || {}).periods;
    var ics = isNode ? require('./ics.js') : (root.DSH = root.DSH || {}).ics;
    var weeks = isNode ? require('./weeks.js') : (root.DSH = root.DSH || {}).weeks;
    var mod = factory(periods, ics, weeks);
    if (isNode) module.exports = mod;
    else root.DSH.compare = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (periods, ics, weeks) {
    'use strict';

    var LEVELS = ['same', 'nearby', 'area', 'cross', 'unknown'];

    // 地点解析结果缓存：同一地点串在一次比对里会被反复解析
    var locCache = Object.create(null);
    function loc(name) {
        if (!(name in locCache)) locCache[name] = ics.parseLocation(name);
        return locCache[name];
    }

    function cellKey(day, period) { return day + '-' + period; }

    /**
     * 把两份（已按周/按奇偶过滤过的）槽位铺进 7×13 网格并评级。
     *
     * @returns {{cells:Object, stats:Object, hasAny:boolean}}
     *   cells['3-4'] = {day, period, a:[entry], b:[entry], level, text}
     *   entry = {course, location, startPeriod, endPeriod, isFirst}
     *   level ∈ same|nearby|area|cross|unknown|single|empty
     */
    function buildGrid(slotsA, slotsB) {
        var cells = Object.create(null);

        function place(slots, side) {
            (slots || []).forEach(function (s) {
                for (var p = s.startPeriod; p <= s.endPeriod; p++) {
                    if (p < 1 || p > periods.MAX_PERIOD) continue;
                    var k = cellKey(s.day, p);
                    if (!cells[k]) cells[k] = { day: s.day, period: p, a: [], b: [], level: 'empty', text: '' };
                    cells[k][side].push({
                        course: s.course,
                        location: s.location,
                        startPeriod: s.startPeriod,
                        endPeriod: s.endPeriod,
                        isFirst: p === s.startPeriod
                    });
                }
            });
        }
        place(slotsA, 'a');
        place(slotsB, 'b');

        Object.keys(cells).forEach(function (k) {
            var c = cells[k];
            if (!c.a.length && !c.b.length) { c.level = 'empty'; return; }
            if (!c.a.length || !c.b.length) { c.level = 'single'; return; }

            var best = null, text = '';
            c.a.forEach(function (x) {
                c.b.forEach(function (y) {
                    var r = ics.compareLocation(loc(x.location), loc(y.location));
                    if (!best || ics.LEVEL_RANK[r.level] > ics.LEVEL_RANK[best]) {
                        best = r.level;
                        text = r.text;
                    }
                });
            });
            c.level = best;
            c.text = text;
        });

        return { cells: cells, stats: countStats(cells), hasAny: Object.keys(cells).length > 0 };
    }

    /** 按等级统计格子数（= 节数），不计单人与空格 */
    function countStats(cells) {
        var stats = { same: 0, nearby: 0, area: 0, cross: 0, unknown: 0, total: 0 };
        Object.keys(cells).forEach(function (k) {
            var lv = cells[k].level;
            if (LEVELS.indexOf(lv) >= 0) stats[lv]++;
        });
        LEVELS.forEach(function (lv) { stats.total += stats[lv]; });
        return stats;
    }

    /**
     * 屏幕用：指定周内的双人比对。
     * @param {string} mondayStr 该周周一 'YYYYMMDD'
     */
    function compareInWeek(slotsA, slotsB, mondayStr) {
        var a = weeks.filterByWeek(slotsA, mondayStr);
        var b = weeks.filterByWeek(slotsB, mondayStr);
        var grid = buildGrid(a, b);
        grid.weekSlotsA = a;
        grid.weekSlotsB = b;
        return grid;
    }

    /** 格子内容签名，用于判断单双周两套是否「一致」 */
    function cellSignature(cell) {
        function side(list) {
            return (list || []).map(function (e) {
                return e.course + '@' + e.location + (e.isFirst ? '' : '~');
            }).sort().join(',');
        }
        return side(cell.a) + '||' + side(cell.b);
    }

    function emptyCell(day, period) {
        return { day: day, period: period, a: [], b: [], level: 'empty', text: '' };
    }

    /**
     * 「规律性」过滤：只保留在整个学期里出现 ≥ min 次的槽位。
     *
     * 真实教务导出的 .ics 里混着期末考试条目与国庆调休补课，它们都只出现一次，
     * 却会和常规课撞在同一格，制造大量假的「单双周差异」。
     * 实测：一份真实课表的 39 个槽位中 20 个只出现一次；不过滤时导出图有 28 处单双周标注，
     * 过滤后剩 5 处，且 ≥2 与 ≥3 结果一致 —— 2 是稳定阈值。
     *
     * 该过滤**只作用于导出视图**；屏幕上始终按真实日期原样显示，不丢数据。
     */
    function regularSlots(slots, min) {
        var n = (min == null) ? 2 : min;
        if (n <= 1) return (slots || []).slice();
        return (slots || []).filter(function (s) {
            return (s.dates || []).length >= n;
        });
    }

    /**
     * 导出用：全学期代表周视图（§12）。
     *
     * 把双方槽位按教学周奇偶拆成单周/双周两套，各自评级；
     * 两套内容完全一致的格子不产生任何周次标注（「一致就不管他」）。
     *
     * @param {Object} [options] options.minOccurrences 规律性阈值，默认 2
     * @returns {{cells:Object, parity:boolean, dropped:{a:number,b:number}}}
     *   cells['3-4'] = {day, period, level, variants:[{label, cell}]}
     *   label ∈ null | '单周' | '双周'
     *   parity = 全图是否存在任何单双周差异
     */
    function buildExportGrid(slotsA, slotsB, baseMonday, options) {
        var min = (options && options.minOccurrences != null) ? options.minOccurrences : 2;
        var keepA = regularSlots(slotsA, min);
        var keepB = regularSlots(slotsB, min);

        var a = weeks.splitByParity(keepA, baseMonday);
        var b = weeks.splitByParity(keepB, baseMonday);
        var odd = buildGrid(a.odd, b.odd).cells;
        var even = buildGrid(a.even, b.even).cells;

        var keys = Object.create(null);
        Object.keys(odd).forEach(function (k) { keys[k] = true; });
        Object.keys(even).forEach(function (k) { keys[k] = true; });

        var cells = Object.create(null);
        var parity = false;

        Object.keys(keys).forEach(function (k) {
            var parts = k.split('-');
            var day = Number(parts[0]), period = Number(parts[1]);
            var cOdd = odd[k] || emptyCell(day, period);
            var cEven = even[k] || emptyCell(day, period);

            var same = cellSignature(cOdd) === cellSignature(cEven);
            var level = ics.bestLevel(cOdd.level, cEven.level);

            var variants;
            if (same) {
                // 两套一致（含都为空）→ 不标注，只留一份
                variants = [{ label: null, cell: cOdd }];
                if (cOdd.level === 'empty') return;   // 整格无课，不产出
            } else {
                parity = true;
                variants = [];
                if (cOdd.level !== 'empty') variants.push({ label: '单周', cell: cOdd });
                if (cEven.level !== 'empty') variants.push({ label: '双周', cell: cEven });
            }

            cells[k] = { day: day, period: period, level: level, variants: variants };
        });

        return {
            cells: cells,
            parity: parity,
            minOccurrences: min,
            dropped: {
                a: (slotsA || []).length - keepA.length,
                b: (slotsB || []).length - keepB.length
            }
        };
    }

    /** 群组页用：我与某人在指定周的重合课时数，按等级分类 */
    function overlapInWeek(mySlots, otherSlots, mondayStr) {
        return compareInWeek(mySlots, otherSlots, mondayStr).stats;
    }

    /** 群组页用：一次算出我与所有成员的重合统计 */
    function overlapWithMembers(mySlots, members, mondayStr) {
        var out = Object.create(null);
        (members || []).forEach(function (m) {
            if (m.isMe) return;
            out[m.id] = overlapInWeek(mySlots, m.courses || [], mondayStr);
        });
        return out;
    }

    return {
        LEVELS: LEVELS,
        cellKey: cellKey,
        buildGrid: buildGrid,
        countStats: countStats,
        compareInWeek: compareInWeek,
        cellSignature: cellSignature,
        regularSlots: regularSlots,
        buildExportGrid: buildExportGrid,
        overlapInWeek: overlapInWeek,
        overlapWithMembers: overlapWithMembers
    };
});
