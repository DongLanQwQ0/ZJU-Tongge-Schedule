/**
 * 浙大作息表与节次换算。
 *
 * 纯函数模块：不得引用 document / window / localStorage / require('node:*')，
 * 以便原样复制到微信小程序的 .js 中。
 */
(function (root, factory) {
    'use strict';
    var mod = factory();
    if (typeof module === 'object' && module.exports) module.exports = mod;
    else (root.DSH = root.DSH || {}).periods = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 浙江大学紫金港校区作息表（1-13 节）
    var PERIODS = [
        { period: 1, start: '08:00', end: '08:45' },
        { period: 2, start: '08:50', end: '09:35' },
        { period: 3, start: '10:00', end: '10:45' },
        { period: 4, start: '10:50', end: '11:35' },
        { period: 5, start: '11:40', end: '12:25' },
        { period: 6, start: '13:25', end: '14:10' },
        { period: 7, start: '14:15', end: '15:00' },
        { period: 8, start: '15:05', end: '15:50' },
        { period: 9, start: '16:15', end: '17:00' },
        { period: 10, start: '17:05', end: '17:50' },
        { period: 11, start: '18:50', end: '19:35' },
        { period: 12, start: '19:40', end: '20:25' },
        { period: 13, start: '20:30', end: '21:15' }
    ];

    var MAX_PERIOD = 13;
    var DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    /** 'HH:MM' -> 自 0 点起的分钟数；非法输入返回 NaN */
    function timeToMinutes(hhmm) {
        if (typeof hhmm !== 'string') return NaN;
        var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
        if (!m) return NaN;
        var h = Number(m[1]);
        var min = Number(m[2]);
        if (h > 23 || min > 59) return NaN;
        return h * 60 + min;
    }

    /**
     * 由起止时间求覆盖的节次区间。
     * 判定口径：课程时间与节次时间有任意重叠即算覆盖该节。
     * @returns {{first:number,last:number,periods:number[]}|null} 无重叠返回 null
     */
    function periodsFromTime(startHHMM, endHHMM) {
        var s = timeToMinutes(startHHMM);
        var e = timeToMinutes(endHHMM);
        if (isNaN(s) || isNaN(e) || e <= s) return null;

        var hit = [];
        for (var i = 0; i < PERIODS.length; i++) {
            var p = PERIODS[i];
            var ps = timeToMinutes(p.start);
            var pe = timeToMinutes(p.end);
            if (s <= pe && e >= ps) hit.push(p.period);
        }
        if (hit.length === 0) return null;
        return { first: hit[0], last: hit[hit.length - 1], periods: hit };
    }

    /** 节次 -> {start,end}；越界返回 null */
    function periodInfo(period) {
        for (var i = 0; i < PERIODS.length; i++) {
            if (PERIODS[i].period === period) return PERIODS[i];
        }
        return null;
    }

    /** 节次 -> '08:00-08:45'，用于表格行标题 */
    function periodLabel(period) {
        var p = periodInfo(period);
        return p ? p.start + '-' + p.end : '';
    }

    /** 展开节次区间为数组，如 (3,4) -> [3,4] */
    function periodRange(first, last) {
        var out = [];
        for (var p = first; p <= last; p++) out.push(p);
        return out;
    }

    return {
        PERIODS: PERIODS,
        MAX_PERIOD: MAX_PERIOD,
        DAY_NAMES: DAY_NAMES,
        timeToMinutes: timeToMinutes,
        periodsFromTime: periodsFromTime,
        periodInfo: periodInfo,
        periodLabel: periodLabel,
        periodRange: periodRange
    };
});
