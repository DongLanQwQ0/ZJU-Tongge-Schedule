/**
 * 服务端持久化：账号、会话、群组。
 *
 * 设计要点（见设计文档 §7）：
 *  - 原子写：先写 .tmp 再 rename，杜绝半截文件
 *  - 写队列：同一文件读-改-写串行化，杜绝并发覆盖
 *  - 损坏兜底：JSON 解析失败时留证重建，不静默丢数据
 *  - 服务端强制校验：不信任前端传来的任何字段
 */
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('./auth.js');

const SESSION_TTL = 90 * 86400000;      // 会话 90 天
const GROUP_TTL = 180 * 86400000;       // 群组 180 天不活动即清理
const DORMANT_DAYS = 30;                // 没传课表 + 这么多天没登录 = 待清理
const MAX_MEMBERS = 50;
const MAX_COURSES = 500;
const MAX_GROUP_NAME = 20;
const MAX_REMARK = 12;      // 自己给群友起的备注，最长 12 字

/**
 * 会话令牌**只以 sha256 落盘**。
 *
 * 明文令牌落盘，等于"拿到 sessions.json 就能冒充任意登录用户" —— 而令牌是
 * Bearer 凭据，服务端只需要能比对，存哈希就够了。令牌本身在用户浏览器里，
 * 换成哈希之后没有人需要重新登录。
 */
const SESSION_KEY_ALGO = 'sha256';

/** 会话键：令牌的 sha256。明文令牌只在签发那一刻存在于内存与响应里 */
function sessionKey(token) {
    return crypto.createHash(SESSION_KEY_ALGO).update(String(token)).digest('hex');
}

// 同一 IP 在 24 小时内注册到这么多账号，就整簇标为「可疑」——
// 只标注、不自动处置，留给发起人复核（同宿舍共用一个出口 IP 也可能误标）
const SUSPECT_WINDOW = 24 * 3600000;
const SUSPECT_IP_COUNT = 6;

/**
 * 邀请链接的有效期档位（毫秒）；null = 永久。
 * 放在模块作用域，因为要导出给测试与前端用。
 */
const INVITE_TTLS = {
    '1d': 86400000,
    '3d': 3 * 86400000,
    '7d': 7 * 86400000,
    '30d': 30 * 86400000,
    'never': null
};
const MAX_INVITES_PER_GROUP = 20;   // 同时「还能用」的邀请码上限
const MAX_INVITE_LABEL = 12;

/** 带 HTTP 状态码的业务错误 */
function fail(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function now() { return Date.now(); }

// ---------------------------------------------------------------- 校验

/** 昵称清洗：剔除控制字符与文件系统保留字符，保留中文 */
function sanitizeNickname(raw) {
    const s = String(raw == null ? '' : raw)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[/\\:*?"<>|]/g, '')
        .trim();
    if (!s) throw fail(400, '昵称不能为空');
    if ([...s].length > 10) throw fail(400, '昵称最多 10 个字');
    return s;
}

function validatePassword(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s.trim()) throw fail(400, '密码不能全是空白');
    if (s.length < 6) throw fail(400, '密码至少 6 位');
    if (s.length > 64) throw fail(400, '密码最多 64 位');
    return s;
}

function sanitizeGroupName(raw) {
    const s = String(raw == null ? '' : raw)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[/\\:*?"<>|]/g, '')
        .trim();
    if ([...s].length > MAX_GROUP_NAME) throw fail(400, '群组名最多 20 个字');
    return s || '我的组团';
}

/**
 * 邀请码：新群是 8 位数字。
 * 仍然接受 6 位 —— 位数改版之前发出去的链接不能失效。
 */
function validateCode(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d{6}$|^\d{8}$/.test(s)) throw fail(400, '邀请码是 8 位数字');
    return s;
}

/** 课表结构校验 —— 服务端不信任前端解析结果 */
function validateCourses(raw) {
    if (!Array.isArray(raw)) throw fail(400, '课表数据格式不对');
    if (raw.length > MAX_COURSES) throw fail(400, `课程数量超过 ${MAX_COURSES} 条上限`);

    return raw.map((c) => {
        if (!c || typeof c !== 'object') throw fail(400, '课表数据里有非法条目');
        const day = Number(c.day);
        const startPeriod = Number(c.startPeriod);
        const endPeriod = Number(c.endPeriod);
        if (!(day >= 1 && day <= 7)) throw fail(400, '星期数据不合法');
        if (!(startPeriod >= 1 && startPeriod <= 13)) throw fail(400, '开始节次不合法');
        if (!(endPeriod >= startPeriod && endPeriod <= 13)) throw fail(400, '结束节次不合法');
        if (!/^\d{2}:\d{2}$/.test(String(c.startTime || ''))) throw fail(400, '开始时间格式不对');
        if (!/^\d{2}:\d{2}$/.test(String(c.endTime || ''))) throw fail(400, '结束时间格式不对');

        const course = String(c.course == null ? '' : c.course).trim().slice(0, 60);
        if (!course) throw fail(400, '课程名不能为空');

        const dates = (Array.isArray(c.dates) ? c.dates : [])
            .map((d) => String(d))
            .filter((d) => /^\d{8}$/.test(d))
            .slice(0, 60);

        return {
            course,
            day,
            startPeriod,
            endPeriod,
            startTime: String(c.startTime),
            endTime: String(c.endTime),
            location: String(c.location == null ? '未知' : c.location).trim().slice(0, 100) || '未知',
            dates: [...new Set(dates)].sort()
        };
    });
}

// ---------------------------------------------------------------- Store

function createStore(dataDir, options) {
    // vault 是可选的：不给就是"不加密"（老数据、现有测试都走这条路）。
    // 正式服由 server.js 从 TONGGE_ROOT_KEY 构造后传进来。
    const vault = (options && options.vault) || null;
    const USERS = path.join(dataDir, 'users.json');
    const SESSIONS = path.join(dataDir, 'sessions.json');
    const AUDIT = path.join(dataDir, 'audit.log');
    const GROUPS = path.join(dataDir, 'groups');

    // 每个 key 一条 Promise 链，保证同一文件的读-改-写串行
    const locks = new Map();
    function withLock(key, fn) {
        const prev = locks.get(key) || Promise.resolve();
        const run = prev.then(fn, fn);
        locks.set(key, run.then(() => {}, () => {}));
        return run;
    }

    /**
     * 原子写：先写 .tmp 再 rename。
     *
     * rename 在 Windows 上会被杀软/编辑器/索引器临时占用而抛 EPERM / EBUSY ——
     * 这是**平台常态**，不是异常。不重试的话，一次占用就是一次 500 加一个残留 .tmp。
     *
     * mode: 0o600 只在 Linux/macOS 生效。Windows 上 Node 的 chmod 是空操作
     * （statSync 会一直报 666），那边靠 ACL 收权，见 server.js 的启动提示；
     * 这里写上是为了让代码在类 Unix 上默认就是对的。
     */
    async function writeJsonAtomic(file, data) {
        const tmp = `${file}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(encodeFor(file, data), null, 2), { encoding: 'utf8', mode: 0o600 });
        for (let i = 0; ; i++) {
            try {
                await fsp.rename(tmp, file);
                return;
            } catch (e) {
                if (i >= 4 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) {
                    await fsp.unlink(tmp).catch(() => {});
                    throw e;
                }
                await new Promise((r) => setTimeout(r, 15 * (i + 1)));
            }
        }
    }

    /**
     * 原子写 + 留一份 .bak。
     *
     * 只给 users.json / sessions.json 用。备份是 **await 的** ——
     * 一开始写成异步不等待，结果紧接着的读路径会和拷贝抢文件句柄，
     * 在 Windows 上直接撞出 EBUSY。可靠性优先于那一点延迟。
     *
     * 有了 .bak，文件损坏时能恢复出上一次的完整数据，
     * 而不是「从空开始」——那等于把所有人强制登出。
     */
    async function writeCritical(file, data) {
        await writeJsonAtomic(file, data);
        await fsp.copyFile(file, `${file}.bak`).catch(() => {});
    }

    /** 只读盘、只解析 —— 不碰加解密。启动自检与迁移要靠它看见"文件里真实的样子" */
    async function readRaw(file, fallback) {
        let text;
        try {
            text = await fsp.readFile(file, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') return fallback();
            throw e;
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            // 损坏：留证据再重建，不静默丢数据
            const bak = `${file}.corrupt-${now()}`;
            try { await fsp.rename(file, bak); } catch (_) { /* 留证失败也不阻断 */ }
            console.error(`[store] ${file} 解析失败，已另存为 ${bak} 并重建：${e.message}`);
            return fallback();
        }
    }

    /** 业务读路径：读盘 + 解密 */
    async function readJson(file, fallback) {
        return decodeFor(file, await readRaw(file, fallback));
    }

    /**
     * readJson + 损坏时先尝试从 .bak 恢复。
     * 给 users.json / sessions.json 用 —— 这两个丢掉就是「全员掉线」级别的事故。
     */
    /**
     * readRaw + 损坏时先尝试从 .bak 恢复。
     * 给 users.json / sessions.json 用 —— 这两个丢掉就是「全员掉线」级别的事故。
     *
     * 注意：**只有"读不动 / 解析不了"才算损坏**。解密失败（钥匙不对、数据被改过）
     * 必须原样抛出去 —— 那不是文件坏了，而是我们拿着错钥匙。要是把它当损坏处理，
     * 就会把人家的好文件改名成 .corrupt-* 再"重建"一张空表 —— 那等于把数据删了。
     */
    async function readCritical(file, fallback) {
        let parsed = null;
        let readable = false;
        try {
            parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
            readable = true;
        } catch (e) {
            if (e.code === 'ENOENT') return fallback();
        }
        if (readable) return decodeFor(file, parsed);      // 解密失败在这里抛出

        const stamp = now();
        try { await fsp.rename(file, `${file}.corrupt-${stamp}`); } catch (_) { /* 保底继续 */ }
        let bak = null;
        try {
            bak = JSON.parse(await fsp.readFile(`${file}.bak`, 'utf8'));
        } catch (_) {
            console.error(`[store] ${file} 损坏且没有可用的 .bak，只能重建`);
            return fallback();
        }
        console.error(`[store] ${file} 损坏，已从 .bak 恢复（损坏副本：${file}.corrupt-${stamp}）`);
        const decoded = decodeFor(file, bak);              // 同上：钥匙不对就抛出去
        await writeJsonAtomic(file, bak).catch(() => {});
        return decoded;
    }

    const emptyUsers = () => ({ v: 1, users: [] });
    const emptySessions = () => ({ v: 1, sessions: {} });
    const groupFile = (code) => path.join(GROUPS, `${code}.json`);

    // ---------------------------------------------------------- 存储加密
    //
    // 加解密**只发生在这里** —— 文件读写边界。磁盘上那四个字段是密文，
    // 一进内存就是明文，和加密之前完全一样；所以路由、撞课比对、ICS 导出、
    // 前端渲染、管理页统计都不需要知道加密的存在。
    //
    // 认的是**文件路径**而不是调用点：users.json 与 groups/*.json 各自的
    // 读写都从这里过，将来新增一处写操作也不会漏。
    //
    // 没有 vault 时下面这些函数全都退化成"原样返回"。
    // 设计与威胁模型见 docs/superpowers/specs/2026-09-17-storage-encryption-design.md

    const inGroups = (file) => file.startsWith(GROUPS + path.sep);
    const sealed = (x) => !!(vault && vault.isSealed(x));

    /** 用户身上三个敏感字段还有几个是明文（给迁移与启动自检数数用） */
    const plainUserFields = (u) =>
        (typeof u.nickname === 'string' ? 1 : 0) +
        (Array.isArray(u.courses) ? 1 : 0) +
        (u.remarks && typeof u.remarks === 'object' && !sealed(u.remarks) ? 1 : 0);

    /** 是明文就封上；已经是密文就原样留着 —— 幂等，迁移可以重复跑 */
    function sealUser(u) {
        const out = Object.assign({}, u);
        if (typeof u.nickname === 'string') {
            out.nickname = vault.seal(vault.KINDS.NICKNAME, u.id, u.nickname);
        }
        if (Array.isArray(u.courses)) {
            out.courses = vault.sealJson(vault.KINDS.COURSE, u.id, u.courses);
        }
        if (u.remarks && typeof u.remarks === 'object' && !sealed(u.remarks)) {
            out.remarks = vault.sealJson(vault.KINDS.REMARKS, u.id, u.remarks);
        }
        return out;
    }

    /** 解回明文。没加密过的老数据原样带过（由启动自检与迁移命令去发现） */
    function unsealUser(u) {
        const out = Object.assign({}, u);
        if (sealed(u.nickname)) out.nickname = vault.open(vault.KINDS.NICKNAME, u.id, u.nickname);
        if (sealed(u.courses)) out.courses = vault.openJson(vault.KINDS.COURSE, u.id, u.courses);
        if (sealed(u.remarks)) out.remarks = vault.openJson(vault.KINDS.REMARKS, u.id, u.remarks);
        return out;
    }

    /** 对外备注：AAD 绑 `<群号>:<uid>`，所以甲群的密文挪到乙群解不开 */
    function mapSelfRemarks(g, fn) {
        if (!g || !g.selfRemarks || typeof g.selfRemarks !== 'object') return g;
        const next = {};
        Object.keys(g.selfRemarks).forEach((uid) => { next[uid] = fn(uid, g.selfRemarks[uid]); });
        return Object.assign({}, g, { selfRemarks: next });
    }

    const sealGroup = (g) => mapSelfRemarks(g, (uid, val) => (sealed(val)
        ? val
        : vault.seal(vault.KINDS.SELF_REMARK, `${g.code}:${uid}`, String(val))));

    const unsealGroup = (g) => mapSelfRemarks(g, (uid, val) => (sealed(val)
        ? vault.open(vault.KINDS.SELF_REMARK, `${g.code}:${uid}`, val)
        : val));

    /** 落盘前：把明文封上 */
    function encodeFor(file, data) {
        if (!vault || !data || typeof data !== 'object') return data;
        if (file === USERS) {
            if (!Array.isArray(data.users)) return data;
            return Object.assign({}, data, { users: data.users.map(sealUser) });
        }
        if (inGroups(file)) return sealGroup(data);
        return data;
    }

    /** 读盘后：把密文解开 */
    function decodeFor(file, data) {
        if (!vault || !data || typeof data !== 'object') return data;
        if (file === USERS) {
            if (!Array.isArray(data.users)) return data;
            return Object.assign({}, data, { users: data.users.map(unsealUser) });
        }
        if (inGroups(file)) return unsealGroup(data);
        return data;
    }

    /**
     * 还有哪些敏感字段是明文。
     *
     * 两个用途：启动自检（发现明文就拒绝启动，避免"半明文半密文"悄悄上线）、
     * 迁移命令（先看看有没有活要干）。
     */
    async function pendingPlaintext() {
        const found = [];
        const users = await readRaw(USERS, emptyUsers);
        (users.users || []).forEach((u) => {
            if (typeof u.nickname === 'string') found.push(`users.json:${u.id}:nickname`);
            if (Array.isArray(u.courses)) found.push(`users.json:${u.id}:courses`);
            if (u.remarks && typeof u.remarks === 'object' && !sealed(u.remarks)) {
                found.push(`users.json:${u.id}:remarks`);
            }
        });
        let names = [];
        try { names = await fsp.readdir(GROUPS); } catch (_) { names = []; }
        for (const name of names.filter((f) => f.endsWith('.json')).sort()) {
            const g = await readRaw(path.join(GROUPS, name), () => null);
            if (!g || !g.selfRemarks || typeof g.selfRemarks !== 'object') continue;
            Object.keys(g.selfRemarks).forEach((uid) => {
                if (!sealed(g.selfRemarks[uid])) found.push(`groups/${name}:${uid}:selfRemark`);
            });
        }
        return found;
    }

    /**
     * 就地把明文迁成密文。**幂等**：已经加密过的文件原样不动。
     *
     * 动手前把原文件抄一份 `<文件>.plaintext-<时间戳>` —— 那是回滚路径，
     * 但它本身也是明文，确认备份可用后**必须删掉**（迁移说明里写了）。
     */
    async function migrateVault(stamp) {
        if (!vault) throw fail(500, '没有配置根密钥，无法迁移');
        const at = String(stamp || now());
        const report = { backups: [], users: 0, groups: 0, fields: 0 };

        const backupOf = async (file) => {
            const dest = `${file}.plaintext-${at}`;
            await fsp.copyFile(file, dest);
            report.backups.push(path.basename(dest));
        };

        // ---- users.json
        const rawUsers = await readRaw(USERS, () => null);
        if (rawUsers && Array.isArray(rawUsers.users)) {
            const dirty = rawUsers.users.filter((u) => plainUserFields(u) > 0);
            if (dirty.length) {
                await backupOf(USERS);
                await withLock('users', () => writeCritical(USERS, rawUsers));
                report.users = dirty.length;
                report.fields += dirty.reduce((n, u) => n + plainUserFields(u), 0);
            }
        }

        // ---- groups/*.json
        let names = [];
        try { names = await fsp.readdir(GROUPS); } catch (_) { names = []; }
        for (const name of names.filter((f) => f.endsWith('.json')).sort()) {
            const file = path.join(GROUPS, name);
            const g = await readRaw(file, () => null);
            if (!g || !g.selfRemarks || typeof g.selfRemarks !== 'object') continue;
            const dirty = Object.keys(g.selfRemarks).filter((uid) => !sealed(g.selfRemarks[uid]));
            if (!dirty.length) continue;
            await backupOf(file);
            await writeJsonAtomic(file, g);
            report.groups += 1;
            report.fields += dirty.length;
        }
        return report;
    }

    // 会话表的常驻副本。
    //
    // 为什么要有它：resolveSession 每个请求都会被调用一次，而它原本每次都要
    // 「读整个 sessions.json → 整体重写一遍」——只为了把 lastSeen 改成当前时间。
    // 实测（400 个会话）读+写 1.35ms，纯读 0.07ms，慢 19 倍，而且是全局串行。
    // 一个班 50 人同时刷页，就是把这张表反复重写几十遍。
    //
    // 所以读路径全程走内存；只有 lastSeen 的刷新攒够 SLA 才落盘（见 flushSessions）。
    let cachedSessions = null;
    let sessionsDirty = false;

    /**
     * 把已加载进内存的会话表写回磁盘；定时器、退出钩子与测试共用。
     *
     * 返回 Promise 而不是「发射后不管」：关服钩子需要在进程退出前
     * 真正等到这一笔写完，否则最后一次同步就白做了。
     */
    async function flushSessions(reason) {
        if (!sessionsDirty || !cachedSessions) return false;
        sessionsDirty = false;
        const snapshot = cachedSessions;   // 取出当前引用，后续被换掉也不影响这次写入
        try {
            await withLock('sessions', () => writeCritical(SESSIONS, snapshot));
            return true;
        } catch (e) {
            sessionsDirty = true;          // 写失败就留着，下次再试
            console.error(`[store] ${reason || 'flush'} 写 sessions.json 失败：`, e.message);
            return false;
        }
    }

    async function init() {
        await fsp.mkdir(GROUPS, { recursive: true });
        // 账号表走全量读取（users.json 是权威数据，读得少、写得多）
        await readCritical(USERS, emptyUsers);
        // 会话表只在启动时读一次，之后常驻内存
        cachedSessions = await readCritical(SESSIONS, emptySessions);
        if (!cachedSessions.sessions || typeof cachedSessions.sessions !== 'object') {
            cachedSessions.sessions = {};
        }
        // 老数据里存的是明文令牌：就地换成哈希（用户无感，不用重新登录）
        const rekeyed = await upgradeSessionKeys();
        if (rekeyed) {
            console.log(`[store] 会话键已升级为 ${SESSION_KEY_ALGO}：${rekeyed} 条（用户无需重新登录）`);
        }
    }

    async function readCachedSessions() {
        if (cachedSessions) return cachedSessions;
        cachedSessions = await readCritical(SESSIONS, emptySessions);
        if (!cachedSessions.sessions || typeof cachedSessions.sessions !== 'object') {
            cachedSessions.sessions = {};
        }
        return cachedSessions;
    }

    // -------------------------------------------------- 账号

    async function readUsers() {
        const db = await readJson(USERS, emptyUsers);
        return Array.isArray(db.users) ? db.users : [];
    }

    async function getUser(id) {
        const users = await readUsers();
        return users.find((u) => u.id === id) || null;
    }

    async function findUserByNickname(nickname) {
        const key = auth.normalizeNickname(nickname);
        const users = await readUsers();
        return users.find((u) => auth.normalizeNickname(u.nickname) === key) || null;
    }

    /** 公开视图：绝不带 pwSalt / pwHash。remarks 只属于本人，不会随群组详情外泄 */
    function publicUser(u) {
        if (!u) return null;
        return {
            id: u.id,
            nickname: u.nickname,
            courses: u.courses || [],
            courseCount: (u.courses || []).length,
            remarks: (u.remarks && typeof u.remarks === 'object') ? u.remarks : {},
            admin: !!u.admin,
            super: !!u.super,
            updatedAt: u.updatedAt,
            createdAt: u.createdAt
        };
    }

    /**
     * 给群里的某个人起一个只有自己看得见的备注（像微信备注名）。
     * 传空字符串 = 取消备注。
     */
    async function setRemark(userId, targetId, remark) {
        const target = String(targetId == null ? '' : targetId);
        if (!target) throw fail(400, '没指明给谁加备注');
        if (target === userId) throw fail(400, '不用给自己加备注');
        const clean = String(remark == null ? '' : remark)
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim();
        if ([...clean].length > MAX_REMARK) throw fail(400, `备注最多 ${MAX_REMARK} 个字`);

        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const user = (db.users || []).find((u) => u.id === userId);
            if (!user) throw fail(404, '账号不存在');
            if (!user.remarks || typeof user.remarks !== 'object') user.remarks = {};
            if (clean) user.remarks[target] = clean;
            else delete user.remarks[target];
            await writeCritical(USERS, db);
            return user.remarks;
        });
    }

    /**
     * 注册：昵称全局唯一，重复抛 409。
     *
     * @param meta {ip} 来源 IP。记下来有两个用处：一是同一 IP 短时间内冒出
     *   一堆账号时能自动标注出来，二是事后能查。正常同学各自一个 IP，互不影响。
     */
    async function createUser(nickname, password, meta) {
        const clean = sanitizeNickname(nickname);
        const pass = validatePassword(password);
        const key = auth.normalizeNickname(clean);
        const ip = String((meta && meta.ip) || '');

        // 哈希在**锁外**算。
        // scrypt 一次要 50–80ms、占 16MB，而它不依赖任何共享状态；
        // 放在 users 写锁里面，等于把并发注册整条串行化 —— 白白让人排队。
        // 代价只是昵称撞车时多算一次哈希，可以忽略。
        const salt = auth.makeSalt();
        const hash = await auth.hashPassword(pass, salt);

        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            if (!Array.isArray(db.users)) db.users = [];
            if (db.users.some((u) => auth.normalizeNickname(u.nickname) === key)) {
                throw fail(409, '这个昵称已经有人在用了，换一个吧');
            }
            const ts = now();
            const user = {
                id: 'u_' + auth.newToken().slice(0, 8),
                nickname: clean,
                pwAlgo: 'scrypt',
                pwSalt: salt,
                pwHash: hash,
                courses: [],
                regIp: ip,
                // 注册即登录（接口会直接返回 token），所以这里也算第一次登录
                lastLoginAt: ts,
                lastLoginIp: ip,
                loginCount: 1,
                createdAt: ts,
                updatedAt: ts
            };
            db.users.push(user);

            // 同一个 IP 在窗口期内冒出一堆账号 -> 整簇都标出来，不只是最后这个。
            // 宁可多标几个让群主自己看，也不悄悄放过。
            let flagged = false;
            if (ip) {
                const cluster = db.users.filter((u) =>
                    u.regIp === ip && ts - (u.createdAt || 0) < SUSPECT_WINDOW);
                if (cluster.length >= SUSPECT_IP_COUNT) {
                    const reason = `${Math.round(SUSPECT_WINDOW / 3600000)} 小时内同一 IP 注册了 ${cluster.length} 个账号`;
                    cluster.forEach((u) => { u.suspect = true; u.suspectReason = reason; });
                    flagged = true;
                }
            }

            await writeCritical(USERS, db);
            return Object.assign({}, user, flagged ? { suspect: true } : {});
        });
    }

    /**
     * 注销账号 —— 不可恢复。
     *
     * 顺手处理群组，不留「无主群」：
     *  - 本人只是成员 -> 从成员与申请里摘掉
     *  - 本人是群主，群里还有别人 -> 群主转给最早加入的那位
     *  - 本人是群主且群里没别人 -> 群直接解散（没人受影响）
     *
     * @returns {{user:object, transferred:string[], disbanded:string[]}}
     */
    async function deleteUser(userId) {
        // 超管不能删：删了就再没有人能做只有超管能做的事（要换人只能上服务器 --set-super）
        const target = await getUser(userId);
        if (target && target.super) throw fail(403, '超级管理员不能被删除');
        await fsp.mkdir(GROUPS, { recursive: true });
        const files = await fsp.readdir(GROUPS);
        const transferred = [];
        const disbanded = [];

        for (const f of files) {
            if (!/^\d{6,8}\.json$/.test(f)) continue;
            const code = f.replace(/\.json$/, '');
            // 群组锁和 users 锁分开拿，不嵌套，免得交叉死锁
            await withLock(`group:${code}`, async () => {
                const g = await readJson(groupFile(code), () => null);
                if (!g || !Array.isArray(g.members)) return;
                if (!g.members.some((m) => m.userId === userId)) return;

                g.members = g.members.filter((m) => m.userId !== userId);
                g.requests = (Array.isArray(g.requests) ? g.requests : [])
                    .filter((r) => r.userId !== userId);
                // 人都走了，TA 的对外备注也别留着占位
                if (g.selfRemarks && typeof g.selfRemarks === 'object') delete g.selfRemarks[userId];

                if (g.creatorId === userId) {
                    const heir = g.members
                        .slice()
                        .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
                    if (heir) {
                        g.creatorId = heir.userId;
                        transferred.push(g.name);
                    } else {
                        await fsp.unlink(groupFile(code)).catch(() => {});
                        disbanded.push(g.name);
                        return;
                    }
                }
                g.updatedAt = now();
                await writeJsonAtomic(groupFile(code), g);
            });
        }

        const removed = await withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const user = (db.users || []).find((u) => u.id === userId);
            if (!user) throw fail(404, '账号不存在');
            db.users = db.users.filter((u) => u.id !== userId);
            // 别人给 TA 起过的备注一并清掉，不留悬空条目
            db.users.forEach((u) => {
                if (u.remarks && u.remarks[userId]) delete u.remarks[userId];
            });
            await writeCritical(USERS, db);
            return user;
        });

        await revokeUserSessions(userId);
        return { user: removed, transferred, disbanded };
    }

    /** 记一行审计日志（JSON Lines），出问题时能回溯 */
    async function appendAudit(entry) {
        const line = JSON.stringify(Object.assign({ at: now() }, entry)) + '\n';
        try {
            await fsp.appendFile(AUDIT, line, 'utf8');
        } catch (e) {
            console.error('[audit] 写日志失败：', e.message);
        }
    }

    /** 被标为异常的账号清单，给启动横幅和事后排查用 */
    async function listSuspects() {
        const users = await readUsers();
        return users
            .filter((u) => u.suspect)
            .map((u) => ({
                nickname: u.nickname,
                regIp: u.regIp || '（未记录）',
                createdAt: u.createdAt,
                reason: u.suspectReason || '同 IP 集中注册'
            }))
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }

    /** 覆盖课表 */
    async function setUserCourses(id, courses) {
        const clean = validateCourses(courses);
        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const user = (db.users || []).find((u) => u.id === id);
            if (!user) throw fail(404, '账号不存在');
            user.courses = clean;
            user.updatedAt = now();
            await writeCritical(USERS, db);
            return user;
        });
    }

    /** 改密码 */
    async function setUserPassword(id, newPassword) {
        const pass = validatePassword(newPassword);
        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const user = (db.users || []).find((u) => u.id === id);
            if (!user) throw fail(404, '账号不存在');
            const salt = auth.makeSalt();
            user.pwSalt = salt;
            user.pwHash = await auth.hashPassword(pass, salt);
            user.updatedAt = now();
            await writeCritical(USERS, db);
            // 改密码后吊销全部旧会话
            await revokeUserSessions(id);
            return user;
        });
    }

    /**
     * 管理员重置密码。
     *
     * 「重置」而不是「找回」—— 原密码没人能看见，也没人能还原：盘上只有
     * scrypt 哈希和盐，单向。所以只能把旧的扔掉、换一个新的。
     * 返回的明文**只在这一刻存在**，不落盘、不进日志，由调用方转达给本人。
     */
    async function resetUserPassword(id) {
        const got = await withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const user = (db.users || []).find((u) => u.id === id);
            if (!user) throw fail(404, '账号不存在');
            // 重置成随机临时密码 = 谁拿着它谁就能登录这个账号。
            // 对超管来说那等于把"唯一且不可撤销"的位置让出去，所以一律拒绝。
            if (user.super) throw fail(403, '不能重置超级管理员的密码');
            const password = auth.newTempPassword();
            const salt = auth.makeSalt();
            user.pwSalt = salt;
            user.pwHash = await auth.hashPassword(password, salt);
            user.updatedAt = now();
            await writeCritical(USERS, db);
            return { nickname: user.nickname, password };
        });
        // 锁外再吊销会话，别把 users 锁和 sessions 锁叠在一起
        await revokeUserSessions(id);
        return got;
    }

    /** 登录：找不到用户与密码错误返回同一文案，避免账号枚举 */
    async function verifyLogin(nickname, password) {
        const user = await findUserByNickname(nickname);
        if (!user) {
            // 仍做一次哈希，抹平「用户不存在」与「密码错误」的耗时差
            await auth.hashPassword(String(password || ''), '00'.repeat(16));
            return null;
        }
        const ok = await auth.verifyPassword(password, user.pwSalt, user.pwHash);
        return ok ? user : null;
    }

    // -------------------------------------------------- 会话

    /** lastSeen 多久才值得落一次盘。低于它就只在内存里推进，省掉整表重写 */
    const LASTSEEN_WRITE_MS = 60 * 1000;

    /**
     * 把会话表的键从「明文令牌」升级成「令牌的 sha256」。
     *
     * 为什么要有这一步：老版本的 sessions.json 里，键就是令牌原文 ——
     * 拿到这个文件的人可以直接冒充任意登录用户。服务端只需要能比对，存哈希就够。
     * 键换成哈希之后，**没有人需要重新登录**（浏览器里那个令牌照旧有效）。
     *
     * 为什么要 `keyed` 标记：令牌和 sha256 都是 64 位十六进制，光看形状分不出来。
     * 不显式记一笔，第二次启动会把哈希再哈希一遍 —— 那等于把所有人踢下线。
     */
    async function upgradeSessionKeys() {
        const db = await readCachedSessions();
        if (db.keyed === SESSION_KEY_ALGO) return 0;
        const next = {};
        let n = 0;
        Object.keys(db.sessions || {}).forEach((k) => {
            next[sessionKey(k)] = db.sessions[k];
            n += 1;
        });
        db.sessions = next;
        db.keyed = SESSION_KEY_ALGO;
        db.v = 2;
        sessionsDirty = true;
        await flushSessions('会话键升级');
        return n;
    }

    /** 新建会话：必须**立刻**落盘 —— 令牌刚发给用户，崩溃不能把它弄丢 */
    async function createSession(userId) {
        const token = auth.newToken();
        const db = await readCachedSessions();
        db.keyed = SESSION_KEY_ALGO;        // 新写的表已经是哈希键，别让下次启动再哈希一遍
        db.v = 2;
        db.sessions[sessionKey(token)] = { userId, createdAt: now(), lastSeen: now() };
        await withLock('sessions', () => writeCritical(SESSIONS, db));
        sessionsDirty = false;             // 刚写的就是最新状态
        return token;                       // 明文令牌只回给这次调用，不落盘
    }

    /**
     * 取会话对应账号，并滑动续期；过期/不存在返回 null。
     *
     * 全程读内存。lastSeen 的落盘按 LASTSEEN_WRITE_MS 节流：
     * 到期的那次会把内存里的最新值一次写下去，所以即使进程被强杀，
     * 盘上的 lastSeen 最多旧一分钟 —— 远小于 90 天的有效期，不影响任何判定。
     */
    async function resolveSession(token) {
        if (!token) return null;
        const db = await readCachedSessions();
        const key = sessionKey(token);
        const s = db.sessions[key];
        if (!s) return null;

        const t = now();
        if (t - s.lastSeen > SESSION_TTL) {
            delete db.sessions[key];
            await withLock('sessions', () => writeCritical(SESSIONS, db));
            return null;
        }
        if (t - s.lastSeen > LASTSEEN_WRITE_MS) {
            s.lastSeen = t;
            await flushSessions('滑动续期');
        }
        const user = await getUser(s.userId);
        return user || null;
    }

    async function revokeSession(token) {
        const db = await readCachedSessions();
        const key = sessionKey(token);
        if (!db.sessions[key]) return;
        delete db.sessions[key];
        await withLock('sessions', () => writeCritical(SESSIONS, db));
    }

    /** 吊销某人的全部会话（改密码 / 注销账号 / 被删号都会用到） */
    async function revokeUserSessions(userId) {
        const db = await readCachedSessions();
        let changed = false;
        Object.keys(db.sessions).forEach((t) => {
            if (db.sessions[t].userId === userId) { delete db.sessions[t]; changed = true; }
        });
        if (changed) await withLock('sessions', () => writeCritical(SESSIONS, db));
    }

    // -------------------------------------------------- 群组

    async function readGroup(code) {
        const file = await resolveGroupFile(code);
        if (!file) return null;
        return readJson(file, () => null);
    }

    /**
     * 换一个新的 8 位邀请码，旧的当场作废。
     *
     * 与「作废某一枚邀请链接」不同：这是换掉**群自己的码**，
     * 也就是「以前发出去的所有旧链接一起失效」。用途是把改版前那批
     * 6 位老码清掉 —— 10⁶ 空间配 20 次/分钟的限流，枚举完只要一个多月。
     *
     * 关键点：**只改 g.code，不动文件名**。
     * 文件名是内部存储键；改了它就要 rename，而 rename 跨崩溃不原子，
     * 一旦失败群就丢了。groupDetail 会按 code 字段找群，所以换码后一切照常。
     *
     * 成员完全不受影响（按 userId 记的），受影响的只有旧链接。
     */
    async function rotateGroupCode(code, actorId, meta) {
        const c = validateCode(code);
        const info = meta || {};
        await fsp.mkdir(GROUPS, { recursive: true });
        const files = await fsp.readdir(GROUPS);

        for (const f of files) {
            if (!/^\d{6,8}\.json$/.test(f)) continue;
            const file = path.join(GROUPS, f);
            const result = await withLock(`group:${c}`, async () => {
                const g = await readJson(file, () => null);
                if (!g || g.code !== c) return null;
                // 只有群主本人或管理员能换
                if (!info.asAdmin && g.creatorId !== actorId) {
                    throw fail(403, '只有群主能换邀请码');
                }
                let next = auth.newGroupCode();
                for (let i = 0; i < 10 && next === c; i++) next = auth.newGroupCode();

                g.code = next;
                g.codeRotatedAt = now();
                // 记下所有换掉的旧码（含文件名用的那个）。joinByInvite 靠它把旧码挡住 ——
                // 只记 g.code 字段是不够的，因为群文件的**文件名**仍是旧码，
                // 不挡的话「拿旧码来读文件」这条路径会让旧码悄悄复活。
                const retired = Array.isArray(g.codeRotatedFromList) ? g.codeRotatedFromList.slice() : [];
                if (g.codeRotatedFrom && !retired.includes(g.codeRotatedFrom)) retired.push(g.codeRotatedFrom);
                if (!retired.includes(c)) retired.push(c);
                g.codeRotatedFromList = retired;
                g.codeRotatedFrom = c;
                g.updatedAt = now();
                await writeJsonAtomic(file, g);
                return { code: next, oldCode: c };
            });
            if (result) return result;
        }
        throw fail(404, '群组不存在或已解散');
    }

    async function createGroup(creatorId, name) {
        const groupName = sanitizeGroupName(name);
        for (let attempt = 0; attempt < 10; attempt++) {
            const code = auth.newGroupCode();
            const created = await withLock(`group:${code}`, async () => {
                const existing = await readJson(groupFile(code), () => null);
                if (existing) return null;                 // 撞码，换一个
                const g = {
                    v: 2,
                    code,
                    name: groupName,
                    creatorId,
                    // 默认保持老行为：谁拿到链接都能进
                    joinMode: 'open',
                    createdAt: now(),
                    updatedAt: now(),
                    members: [{ userId: creatorId, joinedAt: now() }],
                    requests: []
                };
                await writeJsonAtomic(groupFile(code), g);
                return g;
            });
            if (created) return created;
        }
        throw fail(500, '邀请码生成失败，请重试');
    }

    // -------------------------------------------------- 邀请链接（可多枚、可过期）

    /**
     * 邀请链接与「群」的关系，是本功能的核心约定，先讲清楚：
     *
     *   g.code      —— 群的**永久地址**，也是文件名。永远有效，永远不变。
     *                  群主自己用它是为了「回到自己的群」，不当作对外分享的凭证。
     *   g.invites[] —— 对外发出去的**邀请链接**，可以同时存在很多枚，
     *                  每枚各自带有效期（null = 永久），随时可以单独作废。
     *
     * 为什么不把有效期加在 g.code 上：那样「过期」就等于这个群没了地址，
     * 而群本身不该有寿命 —— 你问得对，群为什么要有有效期。
     * 有寿命的只是发给别人的那张票。
     *
     * 过期只挡**新人入群**：已经在群里的人完全不受影响
     * （成员按 userId 记，跟票无关）。
     */

    /** 允许的有效期档位；null = 永久。前端传什么都在这里收敛 */
    const INVITE_TTL_OPTIONS = INVITE_TTLS;
    const MAX_INVITES = MAX_INVITES_PER_GROUP;

    function resolveInviteExpiry(ttl) {
        const key = String(ttl == null || ttl === '' ? 'never' : ttl);
        if (!(key in INVITE_TTL_OPTIONS)) throw fail(400, '有效期只能是 1d / 3d / 7d / 30d / never');
        const ms = INVITE_TTL_OPTIONS[key];
        return ms == null ? null : now() + ms;
    }

    /** 这枚票还能用吗（永久票永远能用）；作废过的永远不能用 */
    function inviteActive(inv, at) {
        if (!inv || inv.revokedAt) return false;
        return inv.expiresAt == null || at < inv.expiresAt;
    }

    /** 给前端的形态：带上计算结果，省得前端各自算一套 */
    function publicInvite(inv, at) {
        const expired = inv.expiresAt != null && at >= inv.expiresAt;
        return {
            code: inv.code,
            label: inv.label || '',
            createdAt: inv.createdAt || 0,
            expiresAt: inv.expiresAt == null ? null : inv.expiresAt,
            active: inviteActive(inv, at),
            expired: expired,
            revoked: !!inv.revokedAt,
            // 剩余毫秒，前端拿来显示「还剩 2 天」；永久是 null
            remainingMs: inv.expiresAt == null ? null : Math.max(0, inv.expiresAt - at)
        };
    }

    /**
     * 老群没有 invites 字段；读的时候一律补数组，别让调用方到处判空。
     *
     * 注意这里**必须**把新数组挂回 g.invites：早先偷懒写成 `: []`，
     * 结果 invitesOf(g).push(x) 推的是一个临时数组，写盘时自然没有 ——
     * 表现是「发码返回成功、但列表里永远看不到」，而且完全没有报错。
     */
    function invitesOf(g) {
        if (!Array.isArray(g.invites)) g.invites = [];
        return g.invites;
    }

    /** 这个码是不是这个群的邀请码（含群主自己的永久码） */
    function codeBelongsTo(g, code) {
        if (g.code === code) return true;
        return invitesOf(g).some((i) => i.code === code);
    }

    /** 群主的永久码不当作邀请票；这里列出需要校验有效期的那些票 */
    function findInvite(g, code) {
        return invitesOf(g).find((i) => i.code === code) || null;
    }

    /**
     * 作废旧邀请码。传 oldCode 就把那一枚标记作废（留档，方便事后看「谁给的」），
     * 也可以顺手发一枚新的。不做删除 —— 删了就没人知道这个码曾经存在过。
     */
    async function revokeInvite(groupCode, ownerId, inviteCode, opts) {
        const c = validateCode(groupCode);
        const target = String(inviteCode || '').trim();
        const options = opts || {};
        if (c === target) throw fail(400, '不能作废群主自己的永久码');

        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能作废邀请码');

            const inv = findInvite(g, target);
            if (!inv) throw fail(404, '这个邀请码不在这个群里');
            if (inv.revokedAt) return { ok: true, already: true };

            inv.revokedAt = now();
            // 顺手发一枚新的（可选），这样「作废并重发」是一次操作
            let issued = null;
            if (options.issueNew) {
                issued = newInviteRecord(g, ownerId, options.ttl, options.label);
                invitesOf(g).push(issued);
            }
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return { ok: true, revoked: target, issued: issued ? publicInvite(issued, now()) : null };
        });
    }

    /**
     * 彻底删掉一条邀请记录。
     *
     * 和 revokeInvite 的区别：作废是「标记失效但留档」（能回答「这码谁发的」），
     * 这里是「从列表里抹掉」。只允许删已经作废或过期的 ——
     * 还能用的码必须先作废再删，免得一步误操作把正在用的链接弄没了。
     */
    async function purgeInvite(groupCode, ownerId, inviteCode) {
        const c = validateCode(groupCode);
        const target = String(inviteCode || '').trim();
        if (c === target) throw fail(400, '群主自己的永久码不能删');

        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能管理邀请码');

            const list = invitesOf(g);
            const inv = list.find((i) => i.code === target);
            if (!inv) throw fail(404, '这个邀请码不在这个群里');
            if (inviteActive(inv, now())) {
                throw fail(400, '这条链接还能用，先作废再删');
            }
            g.invites = list.filter((i) => i.code !== target);
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return { ok: true, removed: target };
        });
    }

    /**
     * 批量作废：管理页上「全选有效链接 -> 作废」用。
     * @returns {{revoked:string[]}} 实际被作废的码
     */
    async function revokeInvites(groupCode, ownerId, codes) {
        const c = validateCode(groupCode);
        const want = Array.isArray(codes) ? codes.map((x) => String(x).trim()).filter(Boolean) : [];
        if (!want.length) throw fail(400, '没勾选要作废的链接');

        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能管理邀请码');

            const at = now();
            const revoked = [];
            invitesOf(g).forEach((inv) => {
                if (!want.includes(inv.code)) return;
                if (inv.revokedAt) return;                 // 已经作废的跳过，幂等
                inv.revokedAt = at;
                revoked.push(inv.code);
            });
            if (revoked.length) {
                g.updatedAt = at;
                await writeJsonAtomic(file, g);
            }
            return { revoked };
        });
    }

    /**
     * 造一枚新票，但先不落盘（调用方在锁内拼好再写）
     */
    function newInviteRecord(g, ownerId, ttl, label) {
        const clean = String(label == null ? '' : label)
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim()
            .slice(0, MAX_INVITE_LABEL);
        return {
            code: auth.newGroupCode(),
            label: clean,
            createdAt: now(),
            createdBy: ownerId,
            expiresAt: resolveInviteExpiry(ttl)
        };
    }

    /**
     * 新建一枚邀请链接。
     * @param ttl '1d' | '3d' | '7d' | '30d' | 'never'
     */
    async function addInvite(groupCode, ownerId, ttl, label) {
        const c = validateCode(groupCode);
        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能发新邀请码');

            const list = invitesOf(g);
            const at = now();
            // 配额只管「还能用的票」：作废/过期的老票不占位置，
            // 所以不用急着清历史 —— 留着才能事后查到「这个码是谁什么时候发的」。
            if (list.filter((i) => inviteActive(i, at)).length >= MAX_INVITES) {
                throw fail(400, `同时最多 ${MAX_INVITES} 个有效的邀请码，先作废几个再发`);
            }

            const inv = newInviteRecord(g, ownerId, ttl, label);
            // 撞码就重来。注意这里查的是**全部历史**，不只是还能用的那些 ——
            // 作废/过期的码是留档给人查的，但它们仍然是「曾经发出去过的码」，
            // 一旦被重新发出来，拿到旧链接的人就会莫名其妙地重新获得入口。
            // 作废码被复活是这个功能最不该出的错。
            for (let i = 0; i < 10 && g.invites.some((x) => x.code === inv.code); i++) {
                inv.code = auth.newGroupCode();
            }
            if (g.invites.some((x) => x.code === inv.code)) {
                throw fail(500, '邀请码生成失败，请重试');
            }
            invitesOf(g).push(inv);
            g.updatedAt = at;
            await writeJsonAtomic(file, g);
            return publicInvite(inv, at);
        });
    }

    /**
     * 老数据没有这两个字段，读的时候一律补默认值。
     * 默认值 == 这个功能上线之前的行为，升级不会改变已有群组的现状。
     */
    function groupSettings(g) {
        return {
            joinMode: g.joinMode === 'approval' ? 'approval' : 'open',
            // 这个字段是后加的，老群文件里没有它。默认 true 就是它上线之前的行为：
            // 成员本来就能看到并转发邀请码，升级不该让已有群悄悄变样。
            // 用 !== false 而不是 === true：万一哪个值被写坏，退回「照旧允许」，
            // 而不是把一群人的分享能力静默关掉
            memberShare: g.memberShare !== false
        };
    }

    /**
     * 入群。
     * 开放模式直接进；审批模式只登记一条申请，等群主同意。
     *
     * `code` 既可能是群主自己的永久码，也可能是某一枚有时效的邀请码 ——
     * 两种都得认，因为改版前的链接用的就是群码，不能让老链接失效。
     * @returns {{group:object, pending:boolean}}
     */
    async function joinGroup(code, userId) {
        const c = validateCode(code);
        return withLock(`group:${c}`, async () => {
            // 走 resolveGroupFile，别用 groupFile(c) ——
            // 换过码的群，码和文件名已经不一样了，直接取文件会静默 404。
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.members.some((m) => m.userId === userId)) return { group: g, pending: false };   // 幂等
            if (!Array.isArray(g.requests)) g.requests = [];

            if (groupSettings(g).joinMode === 'approval') {
                if (!g.requests.some((r) => r.userId === userId)) {
                    g.requests.push({ userId, at: now() });
                    g.updatedAt = now();
                    await writeJsonAtomic(file, g);
                }
                return { group: g, pending: true };   // 重复申请也当成功，别让人以为点坏了
            }

            if (g.members.length >= MAX_MEMBERS) throw fail(400, `群组人数已达 ${MAX_MEMBERS} 人上限`);
            g.requests = g.requests.filter((r) => r.userId !== userId);
            g.members.push({ userId, joinedAt: now() });
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return { group: g, pending: false };
        });
    }

    /**
     * 按邀请码入群 —— 这才是「有时效的邀请链接」真正的入口。
     *
     * joinGroup 是按**群码**（= 文件名）直接取文件的，遇到邀请码根本找不到文件：
     * 邀请码不是群的身份，只是群里的一个字段。所以这里必须先扫一遍群，
     * 看哪个群的 invites 里挂着这个码。
     *
     * 扫描代价用限流兜住：入群接口 20 次/分钟。反过来也正因为要扫，
     * 6 位码那种小空间才更该早点换掉。
     *
     * 三种结果，语义要分清：
     *   码不存在            -> 404「邀请链接无效」
     *   码在、但过期/已作废  -> 410「邀请链接已过期，找群主要个新的」
     *   码有效              -> 走原来的入群流程
     */
    async function joinByInvite(inviteCode, userId) {
        const c = validateCode(inviteCode);
        const at = now();

        await fsp.mkdir(GROUPS, { recursive: true });
        const files = await fsp.readdir(GROUPS);

        for (const f of files) {
            if (!/^\d{6,8}\.json$/.test(f)) continue;
            const g = await readJson(path.join(GROUPS, f), () => null);
            if (!g || !Array.isArray(g.members)) continue;

            const inv = findInvite(g, c);
            if (!inv) continue;

            // 找到了这枚票。作废与过期给不同的说法，方便用户判断该找谁
            if (inv.revokedAt) throw fail(410, '这个邀请链接已经被群主作废了，向 TA 要个新的');
            if (inv.expiresAt != null && at >= inv.expiresAt) {
                throw fail(410, '这个邀请链接已经过期了，向群主要个新的');
            }
            return joinGroup(g.code, userId);
        }

        // 也认群主自己的永久码 —— 改版前发出去的链接用的就是它，不能让它失效。
        // resolveGroupFile 默认不认「换码时被换掉的那批」，所以换过码的群
        // 拿旧码来会直接扑空 —— 这正是我们要的：换码必须真的作废旧码。
        const file = await resolveGroupFile(c);
        if (file) {
            const g = await readJson(file, () => null);
            if (g && Array.isArray(g.members)) return joinGroup(g.code, userId);
        }

        throw fail(404, '邀请链接无效，确认一下是不是复制少了数字');
    }

    /** 这个码是不是被「换群码」换掉的旧码 */
    function isRetiredCode(g, code) {
        if (g.codeRotatedFrom === code) return true;
        return Array.isArray(g.codeRotatedFromList) && g.codeRotatedFromList.includes(code);
    }

    /**
     * 把「群码」解析成磁盘上的文件路径。
     *
     * 为什么需要它：群文件名是内部存储键，**不等于**群码。
     * 新群的 code === 文件名，所以一次 stat 就命中；但「换群码」只改 g.code、
     * 不动文件名（rename 跨崩溃不原子，失败就丢群），于是老群的
     * code 与文件名就分家了。所有需要读写的路径都得走这里，
     * 直接用 groupFile(码) 会在换过码的群上扑空 —— 而且是静默 404。
     *
     * @param opts.allowRetired 是否认「换码时被换掉的老码」（默认不认）
     */
    async function resolveGroupFile(code, opts) {
        const c = validateCode(code);
        const options = opts || {};
        const direct = groupFile(c);
        const hit = await readJson(direct, () => null);
        if (hit) {
            if (!options.allowRetired && isRetiredCode(hit, c)) return null;
            return direct;
        }
        await fsp.mkdir(GROUPS, { recursive: true });
        for (const f of await fsp.readdir(GROUPS)) {
            if (!/^\d{6,8}\.json$/.test(f)) continue;
            const p = path.join(GROUPS, f);
            const g = await readJson(p, () => null);
            if (!g || g.code !== c) continue;
            if (!options.allowRetired && isRetiredCode(g, c)) return null;
            return p;
        }
        return null;
    }

    /**
     * 设自己在某个群里的「对外备注」——群里其他人默认看到的就是这个名字。
     *
     * 三级优先，越靠上的越先被采用：
     *   1. 看的人自己给 TA 起的备注（私人的，不归你管）
     *   2. 你自己设的这个对外备注
     *   3. 账号昵称
     *
     * 所以它盖得住昵称，但盖不住别人给你起的外号 —— 那本来就是他的视角。
     * 传空字符串 = 恢复用昵称。
     */
    async function setSelfRemark(code, userId, remark) {
        const c = validateCode(code);
        const clean = String(remark == null ? '' : remark)
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim();
        if ([...clean].length > MAX_REMARK) throw fail(400, `备注最多 ${MAX_REMARK} 个字`);

        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (!Array.isArray(g.members) || !g.members.some((m) => m.userId === userId)) {
                throw fail(403, '你不在这个群里');
            }
            if (!g.selfRemarks || typeof g.selfRemarks !== 'object') g.selfRemarks = {};
            if (clean) g.selfRemarks[userId] = clean;
            else delete g.selfRemarks[userId];
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return clean;
        });
    }

    /** 群主改群组设置（名称、入群方式、成员能否分享） */
    async function updateGroupSettings(code, ownerId, patch) {
        const c = validateCode(code);
        const next = {};
        if (patch && patch.joinMode !== undefined) {
            if (patch.joinMode !== 'open' && patch.joinMode !== 'approval') {
                throw fail(400, '入群方式只能是 open 或 approval');
            }
            next.joinMode = patch.joinMode;
        }
        if (patch && patch.memberShare !== undefined) {
            if (typeof patch.memberShare !== 'boolean') {
                throw fail(400, '成员分享只能是开或关');
            }
            next.memberShare = patch.memberShare;
        }
        if (patch && patch.name !== undefined) {
            // 空名字会被 sanitizeGroupName 兜成「我的组团」，这里挑明更好
            if (!String(patch.name).trim()) throw fail(400, '群名不能为空');
            next.name = sanitizeGroupName(patch.name);
        }
        if (!Object.keys(next).length) throw fail(400, '没有要改的设置');

        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能改群组设置');
            Object.assign(g, next);
            // 切成开放模式时，把积压的申请直接放进来，别让人干等
            if (next.joinMode === 'open' && Array.isArray(g.requests) && g.requests.length) {
                for (const r of g.requests) {
                    if (g.members.length >= MAX_MEMBERS) break;
                    if (!g.members.some((m) => m.userId === r.userId)) {
                        g.members.push({ userId: r.userId, joinedAt: now() });
                    }
                }
                g.requests = [];
            }
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return g;
        });
    }

    /** 群主同意入群申请 */
    async function approveRequest(code, ownerId, targetUserId) {
        const c = validateCode(code);
        const target = String(targetUserId == null ? '' : targetUserId);
        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能审批');
            if (!Array.isArray(g.requests) || !g.requests.some((r) => r.userId === target)) {
                throw fail(404, '这条申请已经不在了');
            }
            if (g.members.length >= MAX_MEMBERS) throw fail(400, `群组人数已达 ${MAX_MEMBERS} 人上限`);
            g.requests = g.requests.filter((r) => r.userId !== target);
            if (!g.members.some((m) => m.userId === target)) {
                g.members.push({ userId: target, joinedAt: now() });
            }
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return g;
        });
    }

    /** 群主拒绝/忽略一条申请 */
    async function rejectRequest(code, ownerId, targetUserId) {
        const c = validateCode(code);
        const target = String(targetUserId == null ? '' : targetUserId);
        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能审批');
            g.requests = (Array.isArray(g.requests) ? g.requests : []).filter((r) => r.userId !== target);
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return g;
        });
    }

    async function leaveGroup(code, userId) {
        const c = validateCode(code);
        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId === userId) throw fail(400, '你是群主，可以直接解散群组');
            g.members = g.members.filter((m) => m.userId !== userId);
            g.requests = (Array.isArray(g.requests) ? g.requests : []).filter((r) => r.userId !== userId);
            // 退群就把对外备注一起带走，免得以后重新进群又顶出来一个旧名字
            if (g.selfRemarks && typeof g.selfRemarks === 'object') delete g.selfRemarks[userId];
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return g;
        });
    }

    /**
     * 群主移除成员。
     * 群主自己不能走这条路 —— 想退出只能解散整个群组（§8）。
     */
    async function removeMember(code, ownerId, targetUserId) {
        const c = validateCode(code);
        const target = String(targetUserId == null ? '' : targetUserId);
        if (!target) throw fail(400, '没指明要移除谁');
        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能移除成员');
            if (target === ownerId) throw fail(400, '你是群主，不能移除自己；想结束就解散群组');
            if (!g.members.some((m) => m.userId === target)) throw fail(404, '这个人已经不在群里了');
            g.members = g.members.filter((m) => m.userId !== target);
            g.requests = (Array.isArray(g.requests) ? g.requests : []).filter((r) => r.userId !== target);
            if (g.selfRemarks && typeof g.selfRemarks === 'object') delete g.selfRemarks[target];
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return g;
        });
    }

    async function deleteGroup(code, userId) {
        const c = validateCode(code);
        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== userId) throw fail(403, '只有群主能解散群组');
            await fsp.unlink(file).catch(() => {});
            return g;
        });
    }

    /**
     * 群主把位置让给群里另一位成员。
     *
     * 在此之前，群主想交班只有一条路：把自己的账号注销掉（deleteUser 会顺手
     * 把群主转给最早入群的成员）—— 代价是课表和备注一起没了。这个函数补上
     * 「人还在、只是不当群主了」这条正常的路径。
     *
     * **只改 creatorId 和 updatedAt，别的字段一概不碰。** 这是刻意的：
     * 界面上的权限全部以 isCreator 为准，所以改完这一个字段，改名 / 审批 /
     * 邀请码 / 移人 / 解散 / 退群 该藏的藏、该露的露，一行判断都不用新写。
     *
     * 群码（g.code）也**不动**。它既是群主的永久码，也是群的永久邀请码
     * （joinByInvite 特意保留了这条兼容），换掉它会把所有已发出去的链接一起废掉。
     * 转让后老群主手里那条码仍然能拉人 —— 但普通成员本来就能分享有效邀请码，
     * 他不比任何一个群友多出权限。真想切断旧码，新群主自己去「换一个新码」。
     *
     * @returns {Promise<object>} 转让后的群记录（creatorId 已是新群主）
     */
    async function transferOwnership(code, ownerId, targetUserId) {
        const c = validateCode(code);
        const target = String(targetUserId == null ? '' : targetUserId);
        if (!target) throw fail(400, '没指明要转给谁');

        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            // 先认身份，再检验参数 —— 反过来的话，一个不是群主的人拿自己的 id
            // 来试会收到「你已经是群主了」，那是句假话
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能转让群组');
            if (target === ownerId) throw fail(400, '你已经是群主了');
            // 必须在锁内查：锁外查完、进锁之前对方可能刚退群
            if (!g.members.some((m) => m.userId === target)) {
                throw fail(404, '这个人已经不在群里了');
            }
            g.creatorId = target;
            g.updatedAt = now();
            await writeJsonAtomic(file, g);
            return g;
        });
    }

    /** 组装群组详情：成员信息实时取自账号表，改一次名处处生效 */
    async function groupDetail(code, viewerId) {
        const g = await readGroup(code);
        if (!g) throw fail(404, '群组不存在或已解散');
        const users = await readUsers();
        const byId = new Map(users.map((u) => [u.id, u]));
        const selfRemarks = (g.selfRemarks && typeof g.selfRemarks === 'object') ? g.selfRemarks : {};
        const brief = (uid) => {
            const u = byId.get(uid);
            return u ? { id: u.id, nickname: u.nickname } : null;
        };
        const members = g.members
            .map((m) => {
                const u = byId.get(m.userId);
                if (!u) return null;
                return {
                    id: u.id,
                    nickname: u.nickname,
                    // TA 自己设的「对外备注」；别人看到 TA 时优先用它
                    selfRemark: selfRemarks[u.id] || '',
                    joinedAt: m.joinedAt,
                    updatedAt: u.updatedAt,
                    courses: u.courses || [],
                    courseCount: (u.courses || []).length
                };
            })
            .filter(Boolean);
        const settings = groupSettings(g);
        const at = now();
        const invites = invitesOf(g);
        return {
            code: g.code,
            name: g.name,
            creatorId: g.creatorId,
            createdAt: g.createdAt,
            joinMode: settings.joinMode,
            isCreator: g.creatorId === viewerId,
            // 成员能不能拿到邀请码，由群主的开关说了算。关掉时**服务端就不下发** ——
            // 只在界面上藏起来的话，成员照样能从接口响应里把码读出来，这开关就是个摆设。
            // 这个标志本身对所有人可见：成员得知道「我这里为什么没有码」。
            memberShare: settings.memberShare,
            // 成员也能看到**还能用**的邀请码：这样谁都能帮群里拉人。
            // 但作废/过期的那堆只给群主看 —— 那是管理痕迹，不是分享材料。
            invites: (g.creatorId === viewerId
                ? invites.slice()
                : (settings.memberShare ? invites.filter((i) => inviteActive(i, at)) : []))
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .map((i) => publicInvite(i, at)),
            // 群主自己的永久码，不当作邀请票，但界面要能显示出来
            ownerCode: g.creatorId === viewerId ? g.code : null,
            // 申请名单只给群主看
            requests: g.creatorId === viewerId
                ? (Array.isArray(g.requests) ? g.requests : [])
                    .map((r) => {
                        const b = brief(r.userId);
                        return b ? { id: b.id, nickname: b.nickname, at: r.at } : null;
                    })
                    .filter(Boolean)
                : [],
            members
        };
    }

    async function listGroupsForUser(userId) {
        await fsp.mkdir(GROUPS, { recursive: true });
        const files = await fsp.readdir(GROUPS);
        const out = [];
        for (const f of files) {
            if (!/^\d{6,8}\.json$/.test(f)) continue;
            const g = await readJson(path.join(GROUPS, f), () => null);
            if (!g || !Array.isArray(g.members)) continue;
            const isMember = g.members.some((m) => m.userId === userId);
            // 还没通过审批的也要列出来，否则申请人不知道自己在等什么
            const isPending = !isMember &&
                Array.isArray(g.requests) && g.requests.some((r) => r.userId === userId);
            if (!isMember && !isPending) continue;
            out.push({
                code: g.code,
                name: g.name,
                memberCount: g.members.length,
                isCreator: g.creatorId === userId,
                // 成员分享被关掉时，首页那张卡片也不该印邀请码（见成员分享开关的设计）
                memberShare: groupSettings(g).memberShare,
                pending: isPending,
                updatedAt: g.updatedAt
            });
        }
        out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return out;
    }

    // -------------------------------------------------- 清理

    /** 过期会话与长期不活动的群组 */
    async function cleanup() {
        const removed = { sessions: 0, groups: 0 };
        const db = await readCachedSessions();
        Object.keys(db.sessions).forEach((t) => {
            if (now() - db.sessions[t].lastSeen > SESSION_TTL) {
                delete db.sessions[t];
                removed.sessions++;
            }
        });
        if (removed.sessions) {
            await withLock('sessions', () => writeCritical(SESSIONS, db));
            sessionsDirty = false;
        }

        await fsp.mkdir(GROUPS, { recursive: true });
        const files = await fsp.readdir(GROUPS);
        for (const f of files) {
            if (!/^\d{6,8}\.json$/.test(f)) continue;
            const p = path.join(GROUPS, f);
            const g = await readJson(p, () => null);
            if (g && now() - (g.updatedAt || g.createdAt || 0) > GROUP_TTL) {
                await fsp.unlink(p).catch(() => {});
                removed.groups++;
            }
        }
        return removed;
    }

    // ---------------------------------------------------------------- 管理

    /**
     * 记一次成功登录：最后登录时间、来源 IP、累计次数。
     *
     * 刻意不在 verifyLogin 里做 —— 那个函数还被「改密码时验旧密码」和
     * 「注销账号时验密码」调用，那两处并不是登录，记进去就把数据污染了。
     * 只有 /api/login 这条路径该调它。
     */
    async function noteLogin(userId, ip) {
        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const user = (db.users || []).find((u) => u.id === userId);
            if (!user) return null;
            user.lastLoginAt = now();
            user.lastLoginIp = String(ip || '');
            user.loginCount = (user.loginCount || 0) + 1;
            await writeCritical(USERS, db);
            return user;
        });
    }

    /**
     * 管理页要的全量账号一览。
     * 手工挑字段，**不是**把用户记录摊开 —— 免得哪天加了新字段就顺手漏出去。
     * pwSalt / pwHash 从一开始就不在这个列表里。
     *
     * 这里只把事实摆出来（时间、IP、次数），不打「可疑」标签 ——
     * 同一个同学在手机和电脑上登录，IP 本来就不一样。
     */
    async function listAdminUsers() {
        const users = await readUsers();
        const ts = now();
        return users.map((u) => {
            const courseCount = (u.courses || []).length;
            // 「最后活动」：登录过就按最后登录算，否则按注册时间
            const lastSeen = u.lastLoginAt || u.createdAt || 0;
            const idleDays = lastSeen ? Math.floor((ts - lastSeen) / 86400000) : 0;
            return {
                id: u.id,
                nickname: u.nickname,
                courseCount,
                regIp: u.regIp || '',
                regAt: u.createdAt || 0,
                lastLoginAt: u.lastLoginAt || 0,
                lastLoginIp: u.lastLoginIp || '',
                loginCount: u.loginCount || 0,
                idleDays,
                // 待清理：没传过课表，而且很久没露面
                dormant: courseCount === 0 && idleDays >= DORMANT_DAYS,
                admin: !!u.admin,
                super: !!u.super,
                suspect: !!u.suspect,
                suspectReason: u.suspectReason || ''
            };
        });
    }

    async function countAdmins() {
        const users = await readUsers();
        return users.filter((u) => u.admin).length;
    }

    /** 当前有几名超级管理员。正常应为 1（迁移前可能是 0） */
    async function countSupers() {
        const users = await readUsers();
        return users.filter((u) => u.super).length;
    }

    /**
     * 指定唯一的超级管理员：先摘掉旧的，再给新的戴上。
     *
     * 与 setUserAdmin 分开，是因为 super 有"全局唯一"这条约束：
     * 谁都不能撤销它（含本人），只能整位移交 —— 所以只有"换人"这一种操作。
     */
    async function transferSuper(id) {
        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const target = (db.users || []).find((u) => u.id === id);
            if (!target) throw fail(404, '账号不存在');
            db.users.forEach((u) => { if (u.super) delete u.super; });   // 旧的那位降为普通管理员
            target.super = true;
            target.admin = true;      // 超管必然也是管理员，不然他连管理页都进不去
            target.updatedAt = now();
            await writeCritical(USERS, db);
            return { id: target.id, nickname: target.nickname };
        });
    }

    /** 授 / 撤管理员。只翻一个布尔标记，密码仍然是原来的 scrypt 哈希，不碰 */
    async function setUserAdmin(id, admin) {        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            const user = (db.users || []).find((u) => u.id === id);
            if (!user) throw fail(404, '账号不存在');
            // super 全局唯一且不可撤销（含本人），只能整位移交 —— 见 transferSuper
            if (user.super) throw fail(403, '超级管理员的权限不能改');
            if (admin) user.admin = true;
            else delete user.admin;
            user.updatedAt = now();
            await writeCritical(USERS, db);
            return user;
        });
    }

    /** 管理页要的全量群组一览 */
    async function listAdminGroups() {
        await fsp.mkdir(GROUPS, { recursive: true });
        const files = await fsp.readdir(GROUPS);
        const users = await readUsers();
        const byId = new Map(users.map((u) => [u.id, u]));
        const out = [];
        for (const f of files) {
            if (!/^\d{6,8}\.json$/.test(f)) continue;
            const g = await readJson(path.join(GROUPS, f), () => null);
            if (!g || !Array.isArray(g.members)) continue;
            const owner = byId.get(g.creatorId);
            out.push({
                code: g.code,
                name: g.name,
                memberCount: g.members.length,
                owner: owner ? owner.nickname : '（已注销）',
                createdAt: g.createdAt || 0,
                updatedAt: g.updatedAt || 0,
                joinMode: groupSettings(g).joinMode,
                pending: Array.isArray(g.requests) ? g.requests.length : 0
            });
        }
        return out.sort((a, b) => b.createdAt - a.createdAt);
    }

    /** 管理员解散任意群组，不需要是群主 */
    async function deleteGroupAsAdmin(code) {
        const c = validateCode(code);
        return withLock(`group:${c}`, async () => {
            const file = await resolveGroupFile(c);
            if (!file) throw fail(404, '群组不存在或已解散');
            const g = await readJson(file, () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            await fsp.unlink(file).catch(() => {});
            return g;
        });
    }

    /**
     * 审计日志的末尾几条，最新的在前。
     * 只从文件尾部读 256KB —— 日志是追加写的，跑久了可能很大，
     * 没必要为了看最近 200 行把整个文件读进内存。
     */
    async function readAudit(limit) {
        const want = Math.max(1, Math.min(Number(limit) || 200, 1000));
        let st;
        try {
            st = await fsp.stat(AUDIT);
        } catch (_) {
            return [];
        }
        const CAP = 256 * 1024;
        const start = Math.max(0, st.size - CAP);
        const len = st.size - start;
        if (len <= 0) return [];

        const fh = await fsp.open(AUDIT, 'r');
        try {
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, start);
            const lines = buf.toString('utf8').split('\n').filter(Boolean);
            // 从中间截断时，第一行可能是半截，丢掉
            if (start > 0) lines.shift();
            return lines
                .slice(-want)
                .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
                .filter(Boolean)
                .reverse();
        } finally {
            await fh.close();
        }
    }

    return {
        dataDir,
        init,
        // 存储加密：启动自检与迁移命令用（没有 vault 时 pendingPlaintext 也能用）
        pendingPlaintext,
        migrateVault,
        cleanup,
        // 会话表的落盘（定时器与退出钩子用；读路径不经过它）
        flushSessions,
        // 账号
        readUsers,
        getUser,
        publicUser,
        findUserByNickname,
        createUser,
        setUserCourses,
        setUserPassword,
        setRemark,
        setSelfRemark,
        deleteUser,
        verifyLogin,
        noteLogin,
        appendAudit,
        listSuspects,
        // 管理
        listAdminUsers,
        listAdminGroups,
        countAdmins,
        countSupers,
        transferSuper,
        sessionKey,
        setUserAdmin,
        resetUserPassword,
        deleteGroupAsAdmin,
        readAudit,
        // 会话
        createSession,
        resolveSession,
        revokeSession,
        revokeUserSessions,
        // 群组
        readGroup,
        createGroup,
        rotateGroupCode,
        joinGroup,
        joinByInvite,
        addInvite,
        revokeInvite,
        purgeInvite,
        revokeInvites,
        updateGroupSettings,
        approveRequest,
        rejectRequest,
        leaveGroup,
        removeMember,
        deleteGroup,
        transferOwnership,
        groupDetail,
        listGroupsForUser
    };
}

module.exports = {
    createStore,
    sessionKey,
    fail,
    sanitizeNickname,
    validatePassword,
    validateCourses,
    sanitizeGroupName,
    validateCode,
    MAX_MEMBERS,
    MAX_COURSES,
    MAX_REMARK,
    MAX_INVITES_PER_GROUP,
    INVITE_TTLS,
    SUSPECT_IP_COUNT,
    DORMANT_DAYS,
    SESSION_TTL,
    GROUP_TTL
};
