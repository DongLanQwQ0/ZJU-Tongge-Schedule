/**
 * ICS 课表解析与地点比对。
 *
 * 纯函数模块：不得引用 document / window / localStorage / require('node:*')，
 * 以便原样复制到微信小程序的 .js 中。
 */
(function (root, factory) {
    'use strict';
    var isNode = typeof module === 'object' && module.exports;
    var periods = isNode ? require('./periods.js') : (root.DSH = root.DSH || {}).periods;
    var mod = factory(periods);
    if (isNode) module.exports = mod;
    else root.DSH.ics = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (periods) {
    'use strict';

    // 顺序有意义：'风雨操场' 必须排在 '篮球场'/'排球场' 之前，
    // 否则 '紫金港风雨操场（篮排球场）' 会被判成篮球场。
    var SPECIAL_CATEGORIES = [
        '风雨操场', '田径场', '足球场', '体育馆', '篮球场', '排球场', '机房', '操场'
    ];

    // 校区/园区前缀。影响「是不是同一片地方」：银泉足球场 ≠ 紫金港足球场。
    var CAMPUS_PREFIXES = ['紫金港', '银泉', '玉泉', '西溪', '华家池', '之江', '海宁'];

    /** 取字符串里的校区前缀，没有则返回 '' */
    function campusOf(loc) {
        for (var i = 0; i < CAMPUS_PREFIXES.length; i++) {
            if (loc.indexOf(CAMPUS_PREFIXES[i]) >= 0) return CAMPUS_PREFIXES[i];
        }
        return '';
    }

    /**
     * 特殊场地的「场地标识」：剥掉校区、类别、方位、括号与空白之后剩下的部分。
     *
     * 用来区分「同一栋楼里的不同场地」：
     *   紫金港风雨操场跑道        -> 跑道
     *   紫金港风雨操场（篮排球场）  -> 篮排球场
     * 两者不同，所以是「同楼栋」而不是「同教室」。
     */
    function venueKey(loc, category) {
        var s = loc;
        CAMPUS_PREFIXES.forEach(function (p) { s = s.split(p).join(''); });
        if (category && category !== '其他') s = s.split(category).join('');
        return s
            .replace(/[东南西北]/g, '')
            .replace(/[（）()【】\[\]【】\s]/g, '');
    }

    /** ICS 折行还原：CRLF/LF 后的单个空格或制表符表示续行 */
    function unfold(text) {
        return String(text == null ? '' : text)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n[ \t]/g, '');
    }

    /** ICS 转义还原：\, \; \n \\ */
    function unescapeText(s) {
        return String(s == null ? '' : s)
            .replace(/\\n/gi, ' ')
            .replace(/\\,/g, ',')
            .replace(/\\;/g, ';')
            .replace(/\\\\/g, '\\');
    }

    /** 取 VEVENT 块中某个属性的值（自动跳过 ;TZID=… 之类的参数） */
    function getProp(block, name) {
        var re = new RegExp('^' + name + '(;[^:\\n]*)?:(.*)$', 'm');
        var m = re.exec(block);
        return m ? m[2].trim() : null;
    }

    /**
     * 解析 ICS 日期时间值。
     * 支持 20260914T100000（本地）、20260914T020000Z（UTC，按 +08:00 折算）、20260914（全天）。
     */
    function parseDateTime(value) {
        if (!value) return null;
        var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
        if (!m) return null;
        var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (!m[4]) return { date: m[1] + m[2] + m[3], time: null }; // 全天事件

        var h = Number(m[4]), mi = Number(m[5]);
        if (m[7]) {
            // UTC -> 北京时间，跨日则日期顺延
            var t = Date.UTC(y, mo - 1, d, h, mi) + 8 * 3600 * 1000;
            var dd = new Date(t);
            return {
                date: '' + dd.getUTCFullYear() +
                    String(dd.getUTCMonth() + 1).padStart(2, '0') +
                    String(dd.getUTCDate()).padStart(2, '0'),
                time: String(dd.getUTCHours()).padStart(2, '0') + ':' +
                    String(dd.getUTCMinutes()).padStart(2, '0')
            };
        }
        return {
            date: m[1] + m[2] + m[3],
            time: String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
        };
    }

    /** 'YYYYMMDD' -> 1(周一)…7(周日) */
    function weekdayOf(dateStr) {
        var y = Number(dateStr.slice(0, 4));
        var m = Number(dateStr.slice(4, 6)) - 1;
        var d = Number(dateStr.slice(6, 8));
        var wd = new Date(Date.UTC(y, m, d)).getUTCDay();
        return wd === 0 ? 7 : wd;
    }

    /**
     * 解析 ICS 文本，返回按「课程槽位」合并后的数组。
     *
     * 同一门课同一时段同一地点的多次周重复会合并为一个槽位，
     * 实际发生的日期记在 dates 里 —— 单双周、调休、临时加课因此天然正确。
     *
     * @returns {Array<{course:string,day:number,startPeriod:number,endPeriod:number,
     *                  startTime:string,endTime:string,location:string,dates:string[]}>}
     */
    function parseICS(icsText) {
        var text = unfold(icsText);
        var chunks = text.split('BEGIN:VEVENT');
        var map = Object.create(null);

        for (var i = 1; i < chunks.length; i++) {
            var block = chunks[i].split('END:VEVENT')[0];
            if (!block) continue;

            var summary = getProp(block, 'SUMMARY');
            var location = getProp(block, 'LOCATION');
            var dtStart = parseDateTime(getProp(block, 'DTSTART'));
            var dtEnd = parseDateTime(getProp(block, 'DTEND'));

            if (!summary || !dtStart || !dtStart.time) continue;   // 无课名或无具体时间，丢弃

            var endTime = (dtEnd && dtEnd.time) ? dtEnd.time : null;
            if (!endTime) continue;

            var span = periods.periodsFromTime(dtStart.time, endTime);
            if (!span) continue;                                    // 与任何节次都不重叠

            var courseName = unescapeText(summary).trim();
            if (!courseName) continue;

            var locRaw = location ? unescapeText(location).split(/[,，]/)[0].trim() : '';
            var day = weekdayOf(dtStart.date);

            var key = [courseName, day, dtStart.time, endTime, locRaw].join('|');
            if (!map[key]) {
                map[key] = {
                    course: courseName,
                    day: day,
                    startPeriod: span.first,
                    endPeriod: span.last,
                    startTime: dtStart.time,
                    endTime: endTime,
                    location: locRaw || '未知',
                    dates: []
                };
            }
            if (map[key].dates.indexOf(dtStart.date) < 0) map[key].dates.push(dtStart.date);
        }

        var slots = Object.keys(map).map(function (k) { return map[k]; });
        slots.forEach(function (s) { s.dates.sort(); });
        slots.sort(function (a, b) {
            if (a.day !== b.day) return a.day - b.day;
            if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
            if (a.course !== b.course) return a.course < b.course ? -1 : 1;
            return 0;
        });
        return slots;
    }

    /** 群组存储用：把槽位压成可安全传输/落盘的精简结构 */
    function toStoredSlots(slots) {
        return (slots || []).map(function (s) {
            var dates = [];
            (s.dates || []).forEach(function (d) {
                var v = String(d);
                if (/^\d{8}$/.test(v) && dates.indexOf(v) < 0) dates.push(v);
            });
            dates.sort();
            return {
                course: String(s.course).trim().slice(0, 60),
                day: s.day,
                startPeriod: s.startPeriod,
                endPeriod: s.endPeriod,
                startTime: s.startTime,
                endTime: s.endTime,
                location: String(s.location || '未知').split(/[,，]/)[0].trim().slice(0, 100) || '未知',
                dates: dates.slice(0, 60)
            };
        });
    }

    /**
     * 解析地点。
     * @returns {{area:string,building:string,room:string,isSpecial:boolean,isUnknown:boolean,
     *            category?:string,direction?:string,original:string}}
     */
    function parseLocation(raw) {
        var loc = String(raw == null ? '' : raw).trim();
        loc = loc.split(/[,，]/)[0].trim();

        if (!loc || loc === '未知' || loc === '未知地点' || loc === '-') {
            return {
                area: '未知', building: '未知', room: '未知',
                isSpecial: false, isUnknown: true, original: loc
            };
        }

        // 标准教室：紫金港[方位]楼栋-房间
        // 楼栋允许数字、字母（1A 与 1 必须区分）与中文（化学实验中心）
        var m = /^紫金港([东南西北])?([^-]+)-(.+)$/.exec(loc);
        if (m) {
            var building = m[2].trim();
            var room = m[3].trim();
            if (building && room) {
                return {
                    area: m[1] || '未知',
                    building: building.toUpperCase(),
                    room: room.toUpperCase(),
                    isSpecial: false,
                    isUnknown: false,
                    original: loc
                };
            }
        }

        // 特殊场地（田径场、足球场、机房……）
        var category = '其他';
        for (var i = 0; i < SPECIAL_CATEGORIES.length; i++) {
            if (loc.indexOf(SPECIAL_CATEGORIES[i]) >= 0) { category = SPECIAL_CATEGORIES[i]; break; }
        }
        var dm = /[东南西北]/.exec(loc);
        return {
            area: '特殊', building: '特殊', room: loc,
            isSpecial: true, isUnknown: false,
            category: category,
            campus: campusOf(loc),
            venue: venueKey(loc, category),
            direction: dm ? dm[0] : '',
            original: loc
        };
    }

    /** 地点的人类可读短名，用于提示文案 */
    function locationName(loc) {
        if (!loc || loc.isUnknown) return '未知';
        if (loc.isSpecial) return loc.category + (loc.direction || '');
        var area = loc.area === '未知' ? '' : loc.area;
        return area + loc.building + '-' + loc.room;
    }

    var LEVEL_RANK = { same: 5, nearby: 4, area: 3, cross: 2, unknown: 1, single: 0, empty: -1 };

    /** 取更优（更亲近）的等级 */
    function bestLevel(a, b) {
        if (!a) return b;
        if (!b) return a;
        return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
    }

    /**
     * 比对两个地点，返回等级与说明。
     * 等级：same(绿) > nearby(黄) > area(蓝) > cross(红) > unknown(灰)
     */
    function compareLocation(a, b) {
        if (!a || !b || a.isUnknown || b.isUnknown) {
            return { level: 'unknown', text: '未知地点' };
        }

        if (a.isSpecial || b.isSpecial) {
            if (!a.isSpecial || !b.isSpecial) {
                return {
                    level: 'cross',
                    text: '不同区域（' + locationName(a) + ' vs ' + locationName(b) + '）'
                };
            }
            // 字符串一模一样，没什么可犹豫的
            if (a.original === b.original) {
                return { level: 'same', text: '相同地点（' + a.original + '）' };
            }
            if (a.category !== b.category) {
                return {
                    level: 'cross',
                    text: '不同区域（' + a.category + ' vs ' + b.category + '）'
                };
            }
            // 不同校区/园区：银泉足球场 ≠ 紫金港足球场
            if (a.campus && b.campus && a.campus !== b.campus) {
                return {
                    level: 'cross',
                    text: '不同区域（' + a.campus + ' vs ' + b.campus + '）'
                };
            }
            // 方位都写了且不同：东田径场 ≠ 西田径场
            if (a.direction && b.direction && a.direction !== b.direction) {
                return {
                    level: 'cross',
                    text: '方位不同（' + a.category + a.direction + ' vs ' + b.category + b.direction + '）'
                };
            }
            // 一边写了方位、一边没写：可能是同一片，也可能不是，不敢判「同教室」
            if (!a.direction !== !b.direction) {
                return {
                    level: 'nearby',
                    text: '同类别场地（' + a.category + '，方位未注明）'
                };
            }
            // 「其他」是兜底类别，两个不同的未归类场地不能当成同一处
            if (a.category === '其他') {
                return { level: 'nearby', text: '同为未归类场地（' + a.original + ' vs ' + b.original + '）' };
            }
            // 同类别、同校区，但场地不同：风雨操场跑道 ≠ 风雨操场（篮排球场）
            if (a.venue !== b.venue) {
                return {
                    level: 'nearby',
                    text: '同类别场地（' + a.category + '：' + (a.venue || '—') + ' vs ' + (b.venue || '—') + '）'
                };
            }
            return {
                level: 'same',
                text: '相同地点（' + a.category + (a.direction || b.direction || '') + '）'
            };
        }

        if (a.area === b.area) {
            if (a.building === b.building) {
                if (a.room === b.room) {
                    return { level: 'same', text: '同教室（' + locationName(a) + '）' };
                }
                return {
                    level: 'nearby',
                    text: '同楼栋（' + (a.area === '未知' ? '' : a.area) + a.building + '）'
                };
            }
            return { level: 'area', text: '同区域（' + a.area + '）' };
        }
        return {
            level: 'cross',
            text: '不同区域（' + locationName(a) + ' vs ' + locationName(b) + '）'
        };
    }

    return {
        SPECIAL_CATEGORIES: SPECIAL_CATEGORIES,
        LEVEL_RANK: LEVEL_RANK,
        unfold: unfold,
        unescapeText: unescapeText,
        parseDateTime: parseDateTime,
        weekdayOf: weekdayOf,
        parseICS: parseICS,
        toStoredSlots: toStoredSlots,
        parseLocation: parseLocation,
        locationName: locationName,
        bestLevel: bestLevel,
        compareLocation: compareLocation
    };
});
