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
const auth = require('./auth.js');

const SESSION_TTL = 90 * 86400000;      // 会话 90 天
const GROUP_TTL = 180 * 86400000;       // 群组 180 天不活动即清理
const MAX_MEMBERS = 50;
const MAX_COURSES = 500;
const MAX_GROUP_NAME = 20;
const MAX_REMARK = 12;      // 自己给群友起的备注，最长 12 字

// 同一 IP 在 24 小时内注册到这么多账号，就整簇标为「可疑」——
// 只标注、不自动处置，留给发起人复核（同宿舍共用一个出口 IP 也可能误标）
const SUSPECT_WINDOW = 24 * 3600000;
const SUSPECT_IP_COUNT = 6;

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

function createStore(dataDir) {
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

    async function readJson(file, fallback) {
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

    async function writeJsonAtomic(file, data) {
        const tmp = `${file}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fsp.rename(tmp, file);
    }

    const emptyUsers = () => ({ v: 1, users: [] });
    const emptySessions = () => ({ v: 1, sessions: {} });
    const groupFile = (code) => path.join(GROUPS, `${code}.json`);

    async function init() {
        await fsp.mkdir(GROUPS, { recursive: true });
        await readJson(USERS, emptyUsers);
        await readJson(SESSIONS, emptySessions);
    }

    // -------------------------------------------------- 站点访问口令

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
            await writeJsonAtomic(USERS, db);
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

        return withLock('users', async () => {
            const db = await readJson(USERS, emptyUsers);
            if (!Array.isArray(db.users)) db.users = [];
            if (db.users.some((u) => auth.normalizeNickname(u.nickname) === key)) {
                throw fail(409, '这个昵称已经有人在用了，换一个吧');
            }
            const salt = auth.makeSalt();
            const hash = await auth.hashPassword(pass, salt);
            const ts = now();
            const user = {
                id: 'u_' + auth.newToken().slice(0, 8),
                nickname: clean,
                pwAlgo: 'scrypt',
                pwSalt: salt,
                pwHash: hash,
                courses: [],
                regIp: ip,
                createdAt: ts,
                updatedAt: now()
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

            await writeJsonAtomic(USERS, db);
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
            await writeJsonAtomic(USERS, db);
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
            await writeJsonAtomic(USERS, db);
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
            await writeJsonAtomic(USERS, db);
            // 改密码后吊销全部旧会话
            await revokeUserSessions(id);
            return user;
        });
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

    async function createSession(userId) {
        const token = auth.newToken();
        await withLock('sessions', async () => {
            const db = await readJson(SESSIONS, emptySessions);
            if (!db.sessions) db.sessions = {};
            db.sessions[token] = { userId, createdAt: now(), lastSeen: now() };
            await writeJsonAtomic(SESSIONS, db);
        });
        return token;
    }

    /** 取会话对应账号，并滑动续期；过期/不存在返回 null */
    async function resolveSession(token) {
        if (!token) return null;
        const db = await readJson(SESSIONS, emptySessions);
        const s = (db.sessions || {})[token];
        if (!s) return null;
        if (now() - s.lastSeen > SESSION_TTL) {
            await withLock('sessions', async () => {
                const d2 = await readJson(SESSIONS, emptySessions);
                if (d2.sessions && d2.sessions[token]) {
                    delete d2.sessions[token];
                    await writeJsonAtomic(SESSIONS, d2);
                }
            });
            return null;
        }
        await withLock('sessions', async () => {
            const d2 = await readJson(SESSIONS, emptySessions);
            if (d2.sessions && d2.sessions[token]) {
                d2.sessions[token].lastSeen = now();
                await writeJsonAtomic(SESSIONS, d2);
            }
        });
        const user = await getUser(s.userId);
        return user || null;
    }

    async function revokeSession(token) {
        await withLock('sessions', async () => {
            const db = await readJson(SESSIONS, emptySessions);
            if (db.sessions && db.sessions[token]) {
                delete db.sessions[token];
                await writeJsonAtomic(SESSIONS, db);
            }
        });
    }

    async function revokeUserSessions(userId) {
        await withLock('sessions', async () => {
            const db = await readJson(SESSIONS, emptySessions);
            let changed = false;
            Object.keys(db.sessions || {}).forEach((t) => {
                if (db.sessions[t].userId === userId) { delete db.sessions[t]; changed = true; }
            });
            if (changed) await writeJsonAtomic(SESSIONS, db);
        });
    }

    // -------------------------------------------------- 群组

    async function readGroup(code) {
        const c = validateCode(code);
        return readJson(groupFile(c), () => null);
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

    /**
     * 老数据没有这两个字段，读的时候一律补默认值。
     * 默认值 == 这个功能上线之前的行为，升级不会改变已有群组的现状。
     */
    function groupSettings(g) {
        return { joinMode: g.joinMode === 'approval' ? 'approval' : 'open' };
    }

    /**
     * 入群。
     * 开放模式直接进；审批模式只登记一条申请，等群主同意。
     * @returns {{group:object, pending:boolean}}
     */
    async function joinGroup(code, userId) {
        const c = validateCode(code);
        return withLock(`group:${c}`, async () => {
            const g = await readJson(groupFile(c), () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.members.some((m) => m.userId === userId)) return { group: g, pending: false };   // 幂等
            if (!Array.isArray(g.requests)) g.requests = [];

            if (groupSettings(g).joinMode === 'approval') {
                if (!g.requests.some((r) => r.userId === userId)) {
                    g.requests.push({ userId, at: now() });
                    g.updatedAt = now();
                    await writeJsonAtomic(groupFile(c), g);
                }
                return { group: g, pending: true };   // 重复申请也当成功，别让人以为点坏了
            }

            if (g.members.length >= MAX_MEMBERS) throw fail(400, `群组人数已达 ${MAX_MEMBERS} 人上限`);
            g.requests = g.requests.filter((r) => r.userId !== userId);
            g.members.push({ userId, joinedAt: now() });
            g.updatedAt = now();
            await writeJsonAtomic(groupFile(c), g);
            return { group: g, pending: false };
        });
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
            const g = await readJson(groupFile(c), () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (!Array.isArray(g.members) || !g.members.some((m) => m.userId === userId)) {
                throw fail(403, '你不在这个群里');
            }
            if (!g.selfRemarks || typeof g.selfRemarks !== 'object') g.selfRemarks = {};
            if (clean) g.selfRemarks[userId] = clean;
            else delete g.selfRemarks[userId];
            g.updatedAt = now();
            await writeJsonAtomic(groupFile(c), g);
            return clean;
        });
    }

    /** 群主改群组设置（名称、入群方式） */
    async function updateGroupSettings(code, ownerId, patch) {
        const c = validateCode(code);
        const next = {};
        if (patch && patch.joinMode !== undefined) {
            if (patch.joinMode !== 'open' && patch.joinMode !== 'approval') {
                throw fail(400, '入群方式只能是 open 或 approval');
            }
            next.joinMode = patch.joinMode;
        }
        if (patch && patch.name !== undefined) {
            // 空名字会被 sanitizeGroupName 兜成「我的组团」，这里挑明更好
            if (!String(patch.name).trim()) throw fail(400, '群名不能为空');
            next.name = sanitizeGroupName(patch.name);
        }
        if (!Object.keys(next).length) throw fail(400, '没有要改的设置');

        return withLock(`group:${c}`, async () => {
            const g = await readJson(groupFile(c), () => null);
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
            await writeJsonAtomic(groupFile(c), g);
            return g;
        });
    }

    /** 群主同意入群申请 */
    async function approveRequest(code, ownerId, targetUserId) {
        const c = validateCode(code);
        const target = String(targetUserId == null ? '' : targetUserId);
        return withLock(`group:${c}`, async () => {
            const g = await readJson(groupFile(c), () => null);
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
            await writeJsonAtomic(groupFile(c), g);
            return g;
        });
    }

    /** 群主拒绝/忽略一条申请 */
    async function rejectRequest(code, ownerId, targetUserId) {
        const c = validateCode(code);
        const target = String(targetUserId == null ? '' : targetUserId);
        return withLock(`group:${c}`, async () => {
            const g = await readJson(groupFile(c), () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能审批');
            g.requests = (Array.isArray(g.requests) ? g.requests : []).filter((r) => r.userId !== target);
            g.updatedAt = now();
            await writeJsonAtomic(groupFile(c), g);
            return g;
        });
    }

    async function leaveGroup(code, userId) {
        const c = validateCode(code);
        return withLock(`group:${c}`, async () => {
            const g = await readJson(groupFile(c), () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId === userId) throw fail(400, '你是群主，可以直接解散群组');
            g.members = g.members.filter((m) => m.userId !== userId);
            g.requests = (Array.isArray(g.requests) ? g.requests : []).filter((r) => r.userId !== userId);
            // 退群就把对外备注一起带走，免得以后重新进群又顶出来一个旧名字
            if (g.selfRemarks && typeof g.selfRemarks === 'object') delete g.selfRemarks[userId];
            g.updatedAt = now();
            await writeJsonAtomic(groupFile(c), g);
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
            const g = await readJson(groupFile(c), () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== ownerId) throw fail(403, '只有群主能移除成员');
            if (target === ownerId) throw fail(400, '你是群主，不能移除自己；想结束就解散群组');
            if (!g.members.some((m) => m.userId === target)) throw fail(404, '这个人已经不在群里了');
            g.members = g.members.filter((m) => m.userId !== target);
            g.requests = (Array.isArray(g.requests) ? g.requests : []).filter((r) => r.userId !== target);
            if (g.selfRemarks && typeof g.selfRemarks === 'object') delete g.selfRemarks[target];
            g.updatedAt = now();
            await writeJsonAtomic(groupFile(c), g);
            return g;
        });
    }

    async function deleteGroup(code, userId) {
        const c = validateCode(code);
        return withLock(`group:${c}`, async () => {
            const g = await readJson(groupFile(c), () => null);
            if (!g) throw fail(404, '群组不存在或已解散');
            if (g.creatorId !== userId) throw fail(403, '只有群主能解散群组');
            await fsp.unlink(groupFile(c)).catch(() => {});
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
        return {
            code: g.code,
            name: g.name,
            creatorId: g.creatorId,
            createdAt: g.createdAt,
            joinMode: settings.joinMode,
            isCreator: g.creatorId === viewerId,
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
        await withLock('sessions', async () => {
            const db = await readJson(SESSIONS, emptySessions);
            Object.keys(db.sessions || {}).forEach((t) => {
                if (now() - db.sessions[t].lastSeen > SESSION_TTL) {
                    delete db.sessions[t];
                    removed.sessions++;
                }
            });
            if (removed.sessions) await writeJsonAtomic(SESSIONS, db);
        });

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

    return {
        dataDir,
        init,
        cleanup,
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
        appendAudit,
        listSuspects,
        // 会话
        createSession,
        resolveSession,
        revokeSession,
        revokeUserSessions,
        // 群组
        readGroup,
        createGroup,
        joinGroup,
        updateGroupSettings,
        approveRequest,
        rejectRequest,
        leaveGroup,
        removeMember,
        deleteGroup,
        groupDetail,
        listGroupsForUser
    };
}

module.exports = {
    createStore,
    fail,
    sanitizeNickname,
    validatePassword,
    validateCourses,
    sanitizeGroupName,
    validateCode,
    MAX_MEMBERS,
    MAX_COURSES,
    MAX_REMARK,
    SUSPECT_IP_COUNT,
    SESSION_TTL,
    GROUP_TTL
};
