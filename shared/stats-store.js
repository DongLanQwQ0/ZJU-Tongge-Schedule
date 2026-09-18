/**
 * 活跃度桶的落盘、节流与修剪。
 *
 * **为什么不塞进 store.js**：那边已经两千行，而桶的规则自成一套
 * （一天一个文件、10 秒节流、只留 90 天、跨零点自然分桶），独立出来更好读，
 * 也能直接拿一个临时目录测，不必先把整个 store 搭起来。
 *
 * 依赖全部由外面注入（目录、读写、锁、时钟），所以这个模块不碰 store 的私有状态。
 * 「记什么」的口径在 shared/stats.js（纯函数，前后端共用），这里只管**怎么存**。
 *
 * 设计与取舍见 docs/superpowers/specs/2026-09-18-activity-metrics-design.md
 */
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const S = require('./stats.js');

/**
 * @param deps.dir            数据根目录（会在其下用 stats/）
 * @param deps.readJson       (file, fallback) => Promise<any>
 * @param deps.writeJsonAtomic(file, data) => Promise<void>
 * @param deps.withLock       (key, fn) => Promise<any>
 * @param deps.now            () => number，默认 Date.now
 * @param deps.log            错误出口，默认 console.warn
 */
function createStatsStore(deps) {
    const dir = path.join(deps.dir, 'stats');
    const readJson = deps.readJson;
    const writeJsonAtomic = deps.writeJsonAtomic;
    const withLock = deps.withLock;
    const now = deps.now || (() => Date.now());
    const log = deps.log || ((msg) => console.warn(msg));

    /** 内存里的桶，day -> bucket。只放「今天」和被跨零点挤下来的那一天 */
    const buckets = new Map();
    /** 有改动、还没落盘的 day */
    const dirty = new Set();
    /**
     * 「盘上那份的内容已经并进内存了」的 day。
     *
     * **这张表是这个模块最要紧的十行。** 少了他就会这样丢数据：服务跑着跑着，
     * 某个账号今天已经记过账、也落过盘；进程重启（或过了零点又有人来），
     * 内存里为这一天新建了一个**空桶**，下一次落盘就把盘上那份覆盖掉 ——
     * 当天的历史计数无声消失（和 store.js 里 `invitesOf` 那个坑是同一类）。
     * 所以：**任何一次写、任何一次读之前，先把盘上那份并进来。**
     */
    const loaded = new Set();
    /** 落盘串行化：定时器与关服可能同时来 */
    let flushing = null;

    const dayOf = (at) => S.dayKey(at == null ? now() : at);
    const fileOf = (day) => path.join(dir, day + '.json');

    /**
     * 取当天的桶。**内存优先**：文件里那份是上一次落盘的样子，
     * 而这里要的是「包括刚过去那几秒」的最新值。
     */
    function bucketOf(at) {
        const day = dayOf(at);
        let b = buckets.get(day);
        if (!b) {
            b = S.emptyBucket(day);
            buckets.set(day, b);
        }
        return b;
    }

    /** 把盘上那份的计数并进内存那份（相加；newUsers 去重） */
    function absorb(mem, disk) {
        mem.requests = (mem.requests || 0) + (disk.requests || 0);
        mem.logins = (mem.logins || 0) + (disk.logins || 0);
        if (!Array.isArray(mem.newUsers)) mem.newUsers = [];
        (Array.isArray(disk.newUsers) ? disk.newUsers : []).forEach((id) => {
            if (mem.newUsers.indexOf(id) < 0) mem.newUsers.push(id);
        });
        Object.keys(disk.users || {}).forEach((id) => {
            const d = disk.users[id] || {};
            const m = S.userOf(mem, id);
            m.req += d.req || 0;
            m.logins += d.logins || 0;
            if ((d.lastAt || 0) > (m.lastAt || 0)) m.lastAt = d.lastAt || 0;
            Object.keys(d.acts || {}).forEach((a) => { m.acts[a] = (m.acts[a] || 0) + d.acts[a]; });
        });
    }

    /**
     * 保证「这一天盘上的内容已经在内存里」。读过（或确认没有）就记下来，之后不再读。
     * 只在异步路径上调用 —— 请求路径（touch）绝不碰盘。
     */
    async function absorbFromDisk(day, mem) {
        if (loaded.has(day)) return mem;
        loaded.add(day);                       // 先记下：读失败也不该反复重读并重复相加
        let disk = null;
        try {
            disk = await readJson(fileOf(day), () => null);
        } catch (e) {
            log(`[stats] 读 ${day}.json 失败（当成空的）：${e.message}`);
        }
        if (disk && disk.day === day && disk.users) absorb(mem, disk);
        return mem;
    }

    /** 记账三个入口都走它：改内存、标脏，绝不 await、绝不碰盘 */
    function record(at, fn) {
        try {
            const b = bucketOf(at);
            fn(b, b.day);
            dirty.add(b.day);
        } catch (e) {
            // 统计永远不能影响业务：记不上就记不上，请求照常返回
            log(`[stats] 记账失败（忽略）：${e.message}`);
        }
    }

    /** 请求级：带令牌的请求 +1 */
    function touch(userId, at) {
        record(at, (b) => S.touch(b, userId, at == null ? now() : at));
    }
    /** 登录级 */
    function noteLogin(userId, at) {
        record(at, (b) => S.noteLogin(b, userId, at == null ? now() : at));
    }
    /** 注册级 */
    function noteNewUser(userId, at) {
        record(at, (b) => S.noteNewUser(b, userId, at == null ? now() : at));
    }
    /** 动作级（白名单之外会被 stats.bump 丢掉） */
    function bump(userId, action, at) {
        record(at, (b) => S.bump(b, userId, action, at == null ? now() : at));
    }

    /**
     * 把脏桶写下去。
     *
     * 失败**不清脏标记** —— 下次接着试（和 sessions 的 lastSeen 一样）。
     * 崩溃最多丢一个节流周期（10 秒）的计数，这是明确接受的代价。
     */
    async function flush(reason) {
        if (flushing) return flushing;              // 定时器与关服撞一起时只跑一个
        if (!dirty.size) return;
        const days = Array.from(dirty);
        flushing = (async () => {
            let wrote = 0;
            for (const day of days) {
                const b = buckets.get(day);
                if (!b) { dirty.delete(day); continue; }
                try {
                    // 写之前先并一次盘上那份：见 loaded 那段注释
                    await absorbFromDisk(day, b);
                    await withLock('stats', async () => {
                        await fsp.mkdir(dir, { recursive: true });
                        await writeJsonAtomic(fileOf(day), b);
                    });
                    dirty.delete(day);
                    wrote++;
                } catch (e) {
                    log(`[stats] ${reason || 'flush'} 写 ${day}.json 失败（保留脏标记）：${e.message}`);
                }
            }
            return wrote;
        })();
        try {
            return await flushing;
        } finally {
            flushing = null;
        }
    }

    /**
     * 修剪：只留最近 KEEP_DAYS 天。
     *
     * 日期文件名 `YYYY-MM-DD` 的字典序就是时间序，所以直接比字符串即可
     * （不用把 90 个名字都解析成 Date）。顺手也清掉内存里过老的桶。
     */
    async function prune(at) {
        const today = dayOf(at);
        const oldest = S.addDays(today, -(S.KEEP_DAYS - 1));
        let removed = 0;
        try {
            await fsp.mkdir(dir, { recursive: true });
            for (const f of await fsp.readdir(dir)) {
                if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
                const day = f.slice(0, -'.json'.length);
                if (day >= oldest) continue;
                await fsp.unlink(path.join(dir, f)).catch(() => {});
                buckets.delete(day);
                dirty.delete(day);
                loaded.delete(day);
                removed++;
            }
            // 内存里同样清一遍：跨天之后旧桶可能还挂着
            for (const day of Array.from(buckets.keys())) {
                if (day < oldest && !dirty.has(day)) buckets.delete(day);
            }
        } catch (e) {
            log(`[stats] 修剪失败（下次再试）：${e.message}`);
        }
        return removed;
    }

    /**
     * 读一天的桶：内存里那份最新（先把盘上那份并进来，保证不只见新账不见旧账），
     * 内存里没有就读盘；坏文件当空桶（绝不让统计把管理页搞挂）。
     */
    async function dayBucket(day) {
        const live = buckets.get(day);
        if (live) return absorbFromDisk(day, live);
        const fromDisk = await readJson(fileOf(day), () => null);
        return (fromDisk && fromDisk.day === day) ? fromDisk : null;
    }

    /**
     * 给管理页的那一份：窗口内的桶 + 聚合。
     *
     * 比窗口**多读 7 天**：7 日留存要看「7 天前新增的人」，而窗口只有 7 天时
     * 那一天正好落在窗口外（见 stats.js 里那条被钉住的用例）。
     * 内存里没落盘的那份优先 —— 否则管理员刚刷完页面，10 秒内的活跃还看不见。
     */
    async function readWindow(days, opts) {
        const o = opts || {};
        const today = o.today || dayOf();
        const win = days || 30;
        const need = Math.max(win, 8);
        const from = S.addDays(today, -(need - 1));

        const list = [];
        for (const day of S.dayKeys(from, today)) {
            const b = await dayBucket(day);
            if (b) list.push(b);
        }
        // 内存里可能有还没进窗口计算的新桶（比如刚好跨了零点），补上
        for (const [day, b] of buckets) {
            if (day < from || day > today) continue;
            if (!list.some((x) => x.day === day)) list.push(b);
        }

        const out = S.summarize(list, { today: today, days: win, nameOf: o.nameOf });
        return out;
    }

    return {
        dir,
        touch,
        noteLogin,
        noteNewUser,
        bump,
        flush,
        prune,
        readWindow,
        // 给测试用的观察窗：内存里有哪些桶、哪些还没落盘
        _state: () => ({ days: Array.from(buckets.keys()).sort(), dirty: Array.from(dirty).sort() })
    };
}

module.exports = { createStatsStore };
