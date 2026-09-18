/**
 * 活跃度统计：分桶形状、聚合口径、迷你折线的路径。
 *
 * **为什么放在 shared/ 而不是服务端私有**：服务端算聚合、浏览器画图，但**口径只能有一份**。
 * 留存的分子分母、折线的归一化、动作白名单都在这儿，两边加载同一个文件，
 * 就不可能出「服务端说 12 人、前端画成 11 人」这种查半天的错。
 *
 * 纯函数模块：不得引用 document / window / localStorage / require('node:*')，
 * 以便服务端 require、浏览器 <script> 原样加载（和 compare.js 一个套路）。
 */
(function (root, factory) {
    'use strict';
    var isNode = typeof module === 'object' && module.exports;
    var mod = factory();
    if (isNode) module.exports = mod;
    else root.DSH.stats = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * 动作白名单。统计表只认这几个 key ——
     * 开放成任意字符串的话，它迟早会长成第二份审计日志（而审计日志已经有了）。
     */
    var ACTIONS = [
        'course_upload', 'group_create', 'group_join', 'group_leave',
        'group_transfer', 'invite_create', 'password_change',
        'account_delete', 'admin_action'
    ];

    /** 桶保留多久。够算 30 日活跃与 7 日留存，也不至于把磁盘当仓库 */
    var KEEP_DAYS = 90;

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function r1(x) { return Math.round(x * 10) / 10; }

    /**
     * 本地日 `YYYY-MM-DD`。
     *
     * 用**本地**时区而不是 UTC：管理页上那个「今天」必须和值班的人眼里的今天一致，
     * 否则晚上 8 点之后（UTC 已经跨天）数字会莫名其妙地跳一天。
     * 代价是「天的边界」由服务端时区决定 —— 部署时锁 TZ，见设计文档 §5。
     */
    function dayKey(ts) {
        var d = new Date(ts == null ? Date.now() : ts);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    /** `YYYY-MM-DD` -> 当地零点的 Date（只用来做日期加减，不参与计算） */
    function parseDay(key) {
        var p = String(key).split('-');
        return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    }

    /** 日期加减（按日历天）。夏令时那天也照常得到「前一天」 —— 用的是日期分量，不是毫秒差 */
    function addDays(key, n) {
        var d = parseDay(key);
        d.setDate(d.getDate() + n);
        return dayKey(d.getTime());
    }

    /** 闭区间的每一天，从 from 到 to 升序。图表要的是**连续日历天**，中间没数据的也要占位 */
    function dayKeys(from, to) {
        var out = [];
        var cur = from;
        // 上限兜一层：调用方传进来的窗口是白名单（7/30/90），这里防的是手滑写出死循环
        for (var i = 0; i <= KEEP_DAYS * 4 && cur <= to; i++) {
            out.push(cur);
            cur = addDays(cur, 1);
        }
        return out;
    }

    /** 一个空桶 */
    function emptyBucket(day) {
        return { v: 1, day: day, requests: 0, logins: 0, newUsers: [], users: {} };
    }

    /**
     * 取（必要时建）某个账号在桶里的那一行。
     *
     * **主动建行是有意的**：登录和注册都发生在「拿到令牌之前」，不经过
     * 「带令牌请求」那个挂点，所以这里必须能凭空把人加进当天 ——
     * 否则「登了一下、没干别的」会被算成不活跃，而这显然是活跃。
     */
    function userOf(bucket, userId) {
        if (!bucket.users) bucket.users = {};
        var u = bucket.users[userId];
        if (!u) u = bucket.users[userId] = { req: 0, logins: 0, lastAt: 0, acts: {} };
        if (!u.acts) u.acts = {};
        return u;
    }

    function seen(u, at) {
        if (at != null && at > (u.lastAt || 0)) u.lastAt = at;
    }

    /** 请求级：带令牌的请求 +1，并把人钉进当天 */
    function touch(bucket, userId, at) {
        var u = userOf(bucket, userId);
        bucket.requests = (bucket.requests || 0) + 1;
        u.req += 1;
        seen(u, at);
    }

    /** 登录级：登录成功一次 */
    function noteLogin(bucket, userId, at) {
        var u = userOf(bucket, userId);
        bucket.logins = (bucket.logins || 0) + 1;
        u.logins += 1;
        seen(u, at);
    }

    /**
     * 注册级：当天新增了一个账号。
     *
     * 存 **id 列表**而不是数字：账号注销之后用户表里就查不到了，但「那天新增了几个」
     * 是历史事实，不该因为后来注销而变小；而且留存要按 id 求交集。
     */
    function noteNewUser(bucket, userId, at) {
        var u = userOf(bucket, userId);
        seen(u, at);
        if (!Array.isArray(bucket.newUsers)) bucket.newUsers = [];
        if (bucket.newUsers.indexOf(userId) < 0) bucket.newUsers.push(userId);
    }

    /** 动作级：白名单之外的 key 直接丢弃（返回 false，调用方不用管） */
    function bump(bucket, userId, action, at) {
        if (ACTIONS.indexOf(action) < 0) return false;
        var u = userOf(bucket, userId);
        u.acts[action] = (u.acts[action] || 0) + 1;
        seen(u, at);
        return true;
    }

    /**
     * 把一堆桶折成前端要的那一份：连续日历天的序列 + 区间汇总 + 留存 + 活跃榜。
     *
     * @param buckets      桶数组（顺序无所谓，内部按 day 索引；缺失的天当空）
     * @param opts.today   今天（`YYYY-MM-DD`）；不传就取当前时间
     * @param opts.days    窗口长度（日历天），默认 30
     * @param opts.nameOf  id -> 昵称，只用于活跃榜（浏览器端不传也不报错）
     */
    function summarize(buckets, opts) {
        var o = opts || {};
        var today = o.today || dayKey();
        var win = o.days || 30;
        var nameOf = o.nameOf || function (id) { return id; };
        var from = addDays(today, -(win - 1));

        var byDay = Object.create(null);
        (buckets || []).forEach(function (b) { if (b && b.day) byDay[b.day] = b; });

        // ---- 连续日历天的序列（没数据的天补 0，图表才不会把两个不挨着的天画在一起）
        var series = dayKeys(from, today).map(function (k) {
            var b = byDay[k];
            var users = (b && b.users) || {};
            var acts = {};
            ACTIONS.forEach(function (a) { acts[a] = 0; });
            Object.keys(users).forEach(function (id) {
                var ua = (users[id] && users[id].acts) || {};
                ACTIONS.forEach(function (a) { if (ua[a]) acts[a] += ua[a]; });
            });
            return {
                day: k,
                // 去重是结构自带的：一个账号一天只在 users 里占一行
                active: Object.keys(users).length,
                newUsers: (b && Array.isArray(b.newUsers)) ? b.newUsers.length : 0,
                logins: (b && b.logins) || 0,
                requests: (b && b.requests) || 0,
                acts: acts
            };
        });

        // ---- 区间汇总：跨天要去重，所以走 id 并集，而不是把每天的人数相加
        var uniq = Object.create(null);
        var perUser = Object.create(null);
        var totals = { newUsers: 0, logins: 0, requests: 0 };
        series.forEach(function (row) {
            var b = byDay[row.day];
            if (!b) return;
            totals.newUsers += row.newUsers;
            totals.logins += row.logins;
            totals.requests += row.requests;
            Object.keys(b.users || {}).forEach(function (id) {
                uniq[id] = true;
                var u = b.users[id] || {};
                var e = perUser[id] || (perUser[id] = { id: id, activeDays: 0, requests: 0, lastAt: 0 });
                e.activeDays += 1;
                e.requests += u.req || 0;
                if ((u.lastAt || 0) > e.lastAt) e.lastAt = u.lastAt || 0;
            });
        });
        var activeUnique = Object.keys(uniq).length;

        // ---- 7 日留存：7 天前新增的人里，今天还活跃的比例。
        // 选这个口径是因为它一句话能说清 —— 界面上也要把这句话写出来
        var cohortBucket = byDay[addDays(today, -7)];
        var cohort = (cohortBucket && Array.isArray(cohortBucket.newUsers)) ? cohortBucket.newUsers : [];
        var todayUsers = (byDay[today] && byDay[today].users) || {};
        var returned = cohort.filter(function (id) { return !!todayUsers[id]; }).length;

        var actions = {};
        ACTIONS.forEach(function (a) {
            actions[a] = series.reduce(function (n, row) { return n + (row.acts[a] || 0); }, 0);
        });

        var top = Object.keys(perUser).map(function (id) {
            var e = perUser[id];
            return {
                id: id, nickname: nameOf(id),
                activeDays: e.activeDays, requests: e.requests, lastAt: e.lastAt
            };
        }).sort(function (a, b) {
            return (b.activeDays - a.activeDays) || (b.requests - a.requests) || (b.lastAt - a.lastAt);
        }).slice(0, 10);

        var last = series[series.length - 1] || { active: 0, newUsers: 0, logins: 0, requests: 0 };
        return {
            days: win,
            from: from,
            to: today,
            series: series,
            summary: {
                today: {
                    active: last.active, newUsers: last.newUsers,
                    logins: last.logins, requests: last.requests
                },
                range: {
                    days: win, from: from, to: today,
                    activeUnique: activeUnique,
                    newUsers: totals.newUsers,
                    logins: totals.logins,
                    requests: totals.requests,
                    avgRequestsPerActive: activeUnique ? r1(totals.requests / activeUnique) : 0
                },
                retention7: {
                    cohort: cohort.length,
                    returned: returned,
                    // cohort 为 0 时给 0，不给 NaN —— 前端不想到处判 NaN
                    rate: cohort.length ? r1((returned / cohort.length) * 100) / 100 : 0
                },
                actions: actions
            },
            top: top
        };
    }

    /** 序列里的最大值（非有限值当 0）。折线用它归一化，界面用它做刻度上限 */
    function seriesMax(values) {
        var max = 0;
        (values || []).forEach(function (v) {
            var n = Number(v);
            if (isFinite(n) && n > max) max = n;
        });
        return max;
    }

    /**
     * 迷你折线的 SVG path。零依赖手画 —— 为一张 30 个点的图引一个图表库不划算。
     *
     * 归一化按窗口内的最大值，所以它画的是**形状**（「这周比上周高」看得见），
     * 绝对值看旁边的数字。退化情形都必须给出确定结果：
     *   空数组      -> ''（前端据此不渲染 <svg>）
     *   全 0        -> 贴着底边的一条直线（不是空白，也不是 NaN）
     *   只有一个点  -> 一小段横线（一个孤立点画出来是看不见的）
     *   NaN / 非有限 -> 当 0（宁可画平，也不能让一个 NaN 把整条 path 废掉）
     */
    function sparkPath(values, w, h) {
        var vals = (values || []).map(function (v) { var n = Number(v); return isFinite(n) ? n : 0; });
        var n = vals.length;
        if (!n) return '';
        var max = seriesMax(vals);
        var px = w || 120;
        var ph = h || 28;
        var y = function (v) { return max > 0 ? ph - (ph * v) / max : ph; };
        var x = function (i) { return n <= 1 ? 0 : (px * i) / (n - 1); };

        if (n === 1) return 'M0 ' + r1(y(vals[0])) + ' L' + r1(px) + ' ' + r1(y(vals[0]));
        return vals.map(function (v, i) {
            return (i ? 'L' : 'M') + r1(x(i)) + ' ' + r1(y(v));
        }).join(' ');
    }

    return {
        ACTIONS: ACTIONS,
        KEEP_DAYS: KEEP_DAYS,
        dayKey: dayKey,
        addDays: addDays,
        dayKeys: dayKeys,
        emptyBucket: emptyBucket,
        userOf: userOf,
        touch: touch,
        noteLogin: noteLogin,
        noteNewUser: noteNewUser,
        bump: bump,
        summarize: summarize,
        seriesMax: seriesMax,
        sparkPath: sparkPath
    };
});
