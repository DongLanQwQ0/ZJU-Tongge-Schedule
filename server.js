/**
 * 同格 —— 找个课搭子一起上课。局域网服务端。
 *
 * 零 npm 依赖，只用 node: 内置模块。`node server.js` 即可启动。
 * 绑定 0.0.0.0，同学连同一个 WiFi 用局域网地址访问即可。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createStore, fail, validateCode } = require('./shared/store.js');
const config = require('./shared/config.js');

const PUBLIC = path.join(__dirname, 'public');
const SHARED = path.join(__dirname, 'shared');
const DATA = path.join(__dirname, 'data');
const MAX_BODY = 1024 * 1024;          // 1 MB
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 60 * 1000;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

// ---------------------------------------------------------------- 小工具

function send(res, status, payload) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function sendError(res, status, message) {
    send(res, status, { error: message });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(fail(413, '请求内容太大了'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try {
                resolve(JSON.parse(text));
            } catch (e) {
                reject(fail(400, '请求内容不是合法的 JSON'));
            }
        });
        req.on('error', reject);
    });
}

/** 这些网卡名或网段基本不是「同学能连上的那个」 */
const VIRTUAL_IFACE = /(vEthernet|Loopback|Virtual|VMware|VirtualBox|Hyper-V|Bluetooth|Npcap|TAP-|Tailscale|ZeroTier|WSL|本地连接\s*\*)/i;

/**
 * 列出可供同学访问的局域网地址。
 * 排序时把虚拟网卡（尤其是 Windows 移动热点的 192.168.137.x）排到后面，
 * 否则二维码可能指向一个同学根本连不上的地址。
 */
function lanInterfaces() {
    const out = [];
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach((name) => {
        (ifaces[name] || []).forEach((ni) => {
            if (ni.family !== 'IPv4' || ni.internal) return;
            out.push({
                name: name,
                address: ni.address,
                virtual: VIRTUAL_IFACE.test(name) || /^192\.168\.137\./.test(ni.address)
            });
        });
    });
    out.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0));
    return out;
}

function lanUrls(port) {
    return lanInterfaces().map((i) => `http://${i.address}:${port}`);
}

// ---------------------------------------------------------------- 按 IP 限流

/**
 * 固定窗口计数器，按来源 IP 计数。
 *
 * 目的不是防 DDoS（校园网里也没那个必要），而是让**枚举邀请码**和
 * **批量注册**这两件事不划算：8 位邀请码在 20 次/分钟下要枚举上百年。
 *
 * 记忆体是进程内的一张表，重启即清；每次检查顺手清掉过期条目，不会无限涨。
 */
function createLimiter({ windowMs, max, message }) {
    const hits = new Map();

    function sweep(now) {
        hits.forEach((rec, key) => { if (now >= rec.resetAt) hits.delete(key); });
    }

    return {
        /** 记一次并判断是否超限；超了就抛 429 */
        check(key) {
            const now = Date.now();
            if (hits.size > 5000) sweep(now);       // 兜底，别让表无限涨
            const rec = hits.get(key);
            if (!rec || now >= rec.resetAt) {
                hits.set(key, { count: 1, resetAt: now + windowMs });
                return;
            }
            rec.count += 1;
            if (rec.count > max) throw fail(429, message);
        },
        clear() { hits.clear(); }
    };
}

function clientIp(req) {
    // 本服务直接对外，不经过反向代理，所以 socket 地址就是真实来源
    return String((req.socket && req.socket.remoteAddress) || 'unknown');
}

// ---------------------------------------------------------------- 服务

async function createServer(options = {}) {
    const port = options.port || Number(process.env.PORT) || 3000;
    const store = createStore(options.dataDir || DATA);
    await store.init();
    if (!options.skipCleanup) store.cleanup().catch((e) => console.error('[cleanup]', e.message));

    // 限流阈值：故意放得很宽，正常人碰不到，只有脚本会撞上。
    // 测试里可以传 options.limits 覆盖。
    const limits = Object.assign({
        global: { windowMs: 60000, max: 600, message: '请求太频繁了，缓一缓再来' },
        join: { windowMs: 60000, max: 20, message: '试得太频繁了，等一分钟再试' },
        // 注册卡两道：短窗口挡脚本连点，长窗口挡慢慢薅
        registerBurst: { windowMs: 10 * 60000, max: 8, message: '注册太频繁了，歇十分钟再来' },
        register: { windowMs: 3600000, max: 20, message: '注册太频繁了，等一会儿再试' },
        loginFail: { windowMs: 600000, max: 30, message: '失败次数太多，等十分钟再试' }
    }, options.limits || {});
    const limiter = {
        global: createLimiter(limits.global),
        join: createLimiter(limits.join),
        registerBurst: createLimiter(limits.registerBurst),
        register: createLimiter(limits.register),
        loginFail: createLimiter(limits.loginFail)
    };

    // 登录节流：同一昵称连续失败 5 次锁 60 秒（内存计数，重启即清）
    const loginFails = new Map();

    function throttleKey(nickname) { return String(nickname || '').trim().toLowerCase(); }

    function checkThrottle(key) {
        const rec = loginFails.get(key);
        if (rec && rec.until && Date.now() < rec.until) {
            throw fail(429, '试得太频繁了，等一分钟再试');
        }
    }
    function noteFail(key) {
        const rec = loginFails.get(key) || { fails: 0, until: 0 };
        rec.fails += 1;
        if (rec.fails >= LOGIN_MAX_FAILS) {
            rec.until = Date.now() + LOGIN_LOCK_MS;
            rec.fails = 0;
        }
        loginFails.set(key, rec);
    }
    function clearFail(key) { loginFails.delete(key); }

    // 统一的鉴权：从 Authorization: Bearer <token> 取会话
    async function requireUser(req) {
        const h = req.headers.authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(h);
        if (!m) throw fail(401, '请先登录');
        const user = await store.resolveSession(m[1].trim());
        if (!user) throw fail(401, '登录状态过期了，请重新登录');
        return { user, token: m[1].trim() };
    }

    /**
     * 管理员门禁。在 requireUser 之上加一道。
     * 注意：先确认登录（401），再确认权限（403）—— 别让没登录的人
     * 通过状态码差异探出「这个接口存在」。
     */
    async function requireAdmin(req) {
        const ctx = await requireUser(req);
        if (!ctx.user.admin) throw fail(403, '需要管理员权限');
        return ctx;
    }

    const routes = [
        // ---- 元信息
        ['GET', /^\/api\/meta$/, async () => ({
            lanUrls: lanUrls(port),
            interfaces: lanInterfaces().map((i) => ({ name: i.name, address: i.address, virtual: i.virtual })),
            port: port
        })],

        // ---- 账号
        ['POST', /^\/api\/register$/, async (req) => {
            const ip = clientIp(req);
            try {
                limiter.registerBurst.check(ip);
                limiter.register.check(ip);
            } catch (e) {
                // 被限流也记一笔：连续撞限流本身就是要看的信号
                store.appendAudit({ event: 'register_blocked', ip, reason: e.message });
                throw e;
            }
            const body = await readBody(req);
            const user = await store.createUser(body.nickname, body.password, { ip });
            store.appendAudit({
                event: 'register',
                nickname: user.nickname,
                ip,
                suspect: !!user.suspect,
                reason: user.suspectReason || null
            });
            if (user.suspect) {
                console.warn(`[audit] 可疑注册：${user.nickname}（${ip}）—— ${user.suspectReason}`);
            }
            const token = await store.createSession(user.id);
            return { userId: user.id, nickname: user.nickname, token };
        }],

        ['POST', /^\/api\/login$/, async (req) => {
            const body = await readBody(req);
            const key = throttleKey(body.nickname);
            const ip = clientIp(req);
            checkThrottle(key);
            const user = await store.verifyLogin(body.nickname, body.password);
            if (!user) {
                noteFail(key);
                limiter.loginFail.check(ip);   // 按 IP 再兜一层，防换昵称刷
                throw fail(401, '昵称或密码不对');
            }
            clearFail(key);
            await store.noteLogin(user.id, ip);
            const token = await store.createSession(user.id);
            return { userId: user.id, nickname: user.nickname, token };
        }],

        ['POST', /^\/api\/logout$/, async (req) => {
            const { token } = await requireUser(req);
            await store.revokeSession(token);
            return { ok: true };
        }],

        ['GET', /^\/api\/me$/, async (req) => {
            const { user } = await requireUser(req);
            const pub = store.publicUser(user);
            // 列表页不需要完整课表体积，但仍需知道课程数
            return pub;
        }],

        ['PUT', /^\/api\/me\/courses$/, async (req) => {
            const { user } = await requireUser(req);
            const body = await readBody(req);
            const updated = await store.setUserCourses(user.id, body.courses);
            return { ok: true, courseCount: (updated.courses || []).length };
        }],

        ['PUT', /^\/api\/me\/password$/, async (req) => {
            const { user } = await requireUser(req);
            const body = await readBody(req);
            const ok = await store.verifyLogin(user.nickname, body.oldPassword);
            if (!ok) throw fail(401, '原密码不对');
            await store.setUserPassword(user.id, body.newPassword);
            return { ok: true };
        }],

        // 给群友起/改/清备注（只影响自己看到的名字）
        ['PUT', /^\/api\/me\/remarks\/([A-Za-z0-9_-]{1,40})$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req);
            const remarks = await store.setRemark(user.id, m[1], body.remark);
            return { ok: true, remarks };
        }],

        // 注销账号：不可恢复，必须带密码
        ['DELETE', /^\/api\/me$/, async (req) => {
            const { user } = await requireUser(req);
            const body = await readBody(req);
            if (!(await store.verifyLogin(user.nickname, body.password))) {
                throw fail(401, '密码不对，注销已取消');
            }
            const r = await store.deleteUser(user.id);
            store.appendAudit({
                event: 'delete_account',
                nickname: r.user.nickname,
                ip: clientIp(req),
                transferred: r.transferred,
                disbanded: r.disbanded
            });
            console.warn(`[audit] 账号已注销：${r.user.nickname}` +
                (r.transferred.length ? ` 群主移交：${r.transferred.join('、')}` : '') +
                (r.disbanded.length ? ` 解散空群：${r.disbanded.join('、')}` : ''));
            return { ok: true, transferred: r.transferred, disbanded: r.disbanded };
        }],

        ['GET', /^\/api\/me\/groups$/, async (req) => {
            const { user } = await requireUser(req);
            return { groups: await store.listGroupsForUser(user.id) };
        }],

        // ---- 群组
        ['POST', /^\/api\/groups$/, async (req) => {
            const { user } = await requireUser(req);
            const body = await readBody(req);
            const g = await store.createGroup(user.id, body.name);
            return { code: g.code, name: g.name };
        }],

        ['POST', /^\/api\/groups\/(\d{6}|\d{8})\/join$/, async (req, _res, m) => {
            limiter.join.check(clientIp(req));   // 枚举邀请码的主要入口，卡死在这里
            const { user } = await requireUser(req);
            const r = await store.joinGroup(validateCode(m[1]), user.id);
            return { ok: true, code: r.group.code, name: r.group.name, pending: r.pending };
        }],

        ['GET', /^\/api\/groups\/(\d{6}|\d{8})$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            const detail = await store.groupDetail(validateCode(m[1]), user.id);
            const isMember = detail.members.some((x) => x.id === user.id);
            if (!isMember) throw fail(403, '你还没有加入这个群组');
            return detail;
        }],

        // 群主改群组设置（入群方式 / 成员能否邀请）
        ['PUT', /^\/api\/groups\/(\d{6}|\d{8})\/settings$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req);
            await store.updateGroupSettings(validateCode(m[1]), user.id, body);
            return { ok: true };
        }],

        // 设自己在群里的对外备注（改的是自己的名字，所以不要求群主）
        ['PUT', /^\/api\/groups\/(\d{6}|\d{8})\/self-remark$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req);
            const selfRemark = await store.setSelfRemark(validateCode(m[1]), user.id, body.remark);
            return { ok: true, selfRemark };
        }],

        // 群主审批入群申请
        ['POST', /^\/api\/groups\/(\d{6}|\d{8})\/requests\/([A-Za-z0-9_-]{1,40})\/approve$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            await store.approveRequest(validateCode(m[1]), user.id, m[2]);
            return { ok: true };
        }],

        // 群主拒绝 / 忽略一条申请
        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/requests\/([A-Za-z0-9_-]{1,40})$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            await store.rejectRequest(validateCode(m[1]), user.id, m[2]);
            return { ok: true };
        }],

        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/me$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            await store.leaveGroup(validateCode(m[1]), user.id);
            return { ok: true };
        }],

        // 群主移除成员（userId 形如 u_xxxxxxxx）
        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/members\/([A-Za-z0-9_-]{1,40})$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            await store.removeMember(validateCode(m[1]), user.id, m[2]);
            return { ok: true };
        }],

        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})$/, async (req, _res, m) => {
            const { user } = await requireUser(req);
            await store.deleteGroup(validateCode(m[1]), user.id);
            return { ok: true };
        }],

        // ---- 管理（全部要管理员，见 requireAdmin）
        ['GET', /^\/api\/admin\/overview$/, async (req) => {
            await requireAdmin(req);
            const [users, groups, suspects, audit] = await Promise.all([
                store.listAdminUsers(),
                store.listAdminGroups(),
                store.listSuspects(),
                store.readAudit(200)
            ]);
            return {
                users,
                groups,
                suspects,
                audit,
                stats: {
                    userCount: users.length,
                    adminCount: users.filter((u) => u.admin).length,
                    groupCount: groups.length,
                    suspectCount: suspects.length,
                    dormantCount: users.filter((u) => u.dormant).length,
                    courseUploaded: users.filter((u) => u.courseCount > 0).length
                }
            };
        }],

        // 授 / 撤管理员
        ['PUT', /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})\/admin$/, async (req, _res, m) => {
            const { user } = await requireAdmin(req);
            const body = await readBody(req);
            const on = !!body.admin;
            const targetId = m[1];

            // 撤自己之前先确认还有别人能管 —— 否则这扇门就永久锁死了
            if (!on && targetId === user.id) {
                if (await store.countAdmins() <= 1) {
                    throw fail(400, '你是唯一的管理员，先给别人授权再撤自己');
                }
            }
            const u = await store.setUserAdmin(targetId, on);
            store.appendAudit({
                event: on ? 'admin_grant' : 'admin_revoke',
                by: user.nickname,
                target: u.nickname,
                ip: clientIp(req)
            });
            return { ok: true };
        }],

        // 删账号（比用户自己注销更强，但仍要求管理员身份）
        ['DELETE', /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})$/, async (req, _res, m) => {
            const { user } = await requireAdmin(req);
            if (m[1] === user.id) throw fail(400, '不能删自己，换个管理员账号来操作');
            const r = await store.deleteUser(m[1]);
            store.appendAudit({
                event: 'admin_delete_user',
                by: user.nickname,
                target: r.user.nickname,
                transferred: r.transferred,
                disbanded: r.disbanded,
                ip: clientIp(req)
            });
            return { ok: true, transferred: r.transferred, disbanded: r.disbanded };
        }],

        // 重置密码：没有「找回」这回事，只有换一个新的
        ['POST', /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})\/reset-password$/, async (req, _res, m) => {
            const { user: admin } = await requireAdmin(req);
            const r = await store.resetUserPassword(m[1]);
            store.appendAudit({
                event: 'admin_reset_password',
                by: admin.nickname,
                target: r.nickname,
                ip: clientIp(req)
            });
            // 明文只在这一个响应里出现，别的地方一概不留
            return { ok: true, nickname: r.nickname, password: r.password };
        }],

        // 解散任意群组，不需要是群主
        ['DELETE', /^\/api\/admin\/groups\/(\d{6}|\d{8})$/, async (req, _res, m) => {
            const { user } = await requireAdmin(req);
            const g = await store.deleteGroupAsAdmin(validateCode(m[1]));
            store.appendAudit({
                event: 'admin_delete_group',
                by: user.nickname,
                group: g.name,
                code: g.code,
                ip: clientIp(req)
            });
            return { ok: true };
        }]
    ];

    async function sendFile(res, full, pathname) {
        let stat;
        try {
            stat = await fsp.stat(full);
        } catch (_) {
            return false;
        }
        if (stat.isDirectory()) return false;

        res.writeHead(200, {
            'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            // /lib/ 是内置的第三方库，几乎不变，可以长缓存；
            // /img/mascot/ 是页脚那几张吉祥物 gif，一张一兆，也不变，同样长缓存；
            // /shared/ 是我们自己的业务代码（比对规则就在里面），必须每次回源 ——
            // 否则改完规则用户刷新页面拿到的还是旧逻辑，得等一天缓存过期。
            'Cache-Control': (pathname.startsWith('/lib/') || pathname.startsWith('/img/mascot/'))
                ? 'public, max-age=86400'
                : 'no-cache'
        });
        fs.createReadStream(full).pipe(res);
        return true;
    }

    /** 把 URL 路径安全地映射到某个根目录之下，越界返回 null */
    function resolveUnder(root, relPath) {
        const safe = path.normalize(relPath).replace(/^[/\\]+/, '');
        const full = path.join(root, safe);
        if (full !== root && !full.startsWith(root + path.sep)) return null;
        return full;
    }

    async function serveStatic(req, res, pathname) {
        // /shared/* 直接映射到仓库里的 shared/，避免把共享模块复制一份到 public/
        if (pathname === '/shared' || pathname.startsWith('/shared/')) {
            const full = resolveUnder(SHARED, pathname.slice('/shared'.length));
            if (!full) return sendError(res, 403, '路径不合法');
            if (await sendFile(res, full, pathname)) return;
            return sendError(res, 404, '共享模块不存在');
        }

        let rel = pathname === '/' ? '/index.html' : pathname;
        try { rel = decodeURIComponent(rel); } catch (_) { /* 保持原样 */ }

        const full = resolveUnder(PUBLIC, rel);
        if (!full) return sendError(res, 403, '路径不合法');
        if (await sendFile(res, full, pathname)) return;

        // 前端是单页应用，未知路径回落到 index.html
        return sendIndex(res);
    }

    async function sendIndex(res) {
        try {
            const html = await fsp.readFile(path.join(PUBLIC, 'index.html'));
            res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length, 'Cache-Control': 'no-cache' });
            res.end(html);
        } catch (_) {
            sendError(res, 500, '前端文件缺失：public/index.html');
        }
    }

    const server = http.createServer(async (req, res) => {
        let pathname = '/';
        try {
            pathname = new URL(req.url, 'http://localhost').pathname;
        } catch (_) {
            return sendError(res, 400, '请求地址不合法');
        }

        if (!pathname.startsWith('/api/')) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, '方法不允许');
            return serveStatic(req, res, pathname);
        }

        // 全局限流：阈值放得很宽，只在有人拿脚本刷的时候才拦得住
        try {
            limiter.global.check(clientIp(req));
        } catch (e) {
            return sendError(res, e.status || 429, e.message);
        }

        for (const [method, pattern, handler] of routes) {
            if (req.method !== method) continue;
            const m = pattern.exec(pathname);
            if (!m) continue;
            try {
                const result = await handler(req, res, m);
                return send(res, 200, result);
            } catch (e) {
                const status = e && e.status ? e.status : 500;
                if (status >= 500) console.error(`[api] ${method} ${pathname}`, e);
                return sendError(res, status, (e && e.message) || '服务器内部错误');
            }
        }
        return sendError(res, 404, '接口不存在');
    });

    // 每日清理一次过期会话与群组
    const timer = setInterval(() => {
        store.cleanup().catch((e) => console.error('[cleanup]', e.message));
    }, 24 * 3600 * 1000);
    timer.unref();

    server.store = store;
    server.port = port;
    return server;
}

/**
 * 解析命令行参数：
 *   --port <端口>
 *   --make-admin <昵称>     把这个账号设为管理员
 *   --revoke-admin <昵称>   取消管理员
 *
 * 授权走命令行而不是网页，是因为这是**本机操作** —— 能敲这条命令就说明
 * 你本来就摸得到 data/ 目录，不需要再发明一套引导密码。
 * 也正因如此，这里全程不碰密码：只翻 user.admin 这一个布尔值。
 */
function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port') opts.port = Number(argv[++i]);
        else if (argv[i] === '--make-admin') opts.makeAdmin = argv[++i];
        else if (argv[i] === '--revoke-admin') opts.revokeAdmin = argv[++i];
    }
    return opts;
}

/** 按昵称找账号（忽略大小写，和登录口径一致） */
async function findByName(store, nickname) {
    const want = String(nickname || '').trim();
    if (!want) return null;
    const users = await store.readUsers();
    return users.find((u) => u.nickname.toLowerCase() === want.toLowerCase()) || null;
}

async function runAdminCli(opts) {
    const store = createStore(opts.dataDir || DATA);
    await store.init();

    const on = opts.makeAdmin !== undefined;
    const nickname = on ? opts.makeAdmin : opts.revokeAdmin;
    const user = await findByName(store, nickname);
    if (!user) {
        console.error(`\n  找不到昵称是「${nickname}」的账号。`);
        console.error('  先在网页上把这个账号注册出来，再回来执行这条命令。\n');
        process.exit(1);
    }

    await store.setUserAdmin(user.id, on);
    await store.appendAudit({
        event: on ? 'admin_grant_cli' : 'admin_revoke_cli',
        by: 'cli',
        target: user.nickname
    });
    console.log(`\n  ${on ? '已设为管理员' : '已取消管理员'}：${user.nickname}  (${user.id})`);
    console.log(`  当前管理员共 ${await store.countAdmins()} 个。\n`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    // 授权是离线操作，做完就退出，不启动服务器
    if (opts.makeAdmin !== undefined || opts.revokeAdmin !== undefined) {
        return runAdminCli(opts);
    }

    const server = await createServer(opts);
    const ifaces = lanInterfaces();
    const suspects = await server.store.listSuspects().catch(() => []);
    server.listen(server.port, '0.0.0.0', () => {
        console.log('');
        console.log(`  ${config.appName} · ${config.tagline}`);
        console.log(`  发起人     ${config.owner}`);
        console.log('  ─────────────────────────────────────────────');
        console.log(`  本机访问   http://localhost:${server.port}`);
        if (ifaces.length) {
            ifaces.forEach((i, idx) => {
                const tag = i.virtual ? '  ← 虚拟网卡，同学多半连不上' : (idx === 0 ? '  ← 把二维码发给同学时用这个' : '');
                console.log(`  同学访问   http://${i.address}:${server.port}  (${i.name})${tag}`);
            });
        } else {
            console.log('  同学访问   （未检测到局域网地址，检查是否连着 WiFi）');
        }
        console.log('  ─────────────────────────────────────────────');
        console.log('  把上面的地址发给同学，他们打开就能注册。');
        if (suspects.length) {
            console.log(`  ⚠ 有 ${suspects.length} 个账号被标为「待复核」（同 IP 集中注册），明细见 data/audit.log：`);
            suspects.slice(0, 8).forEach((s) => console.log(`      ${s.nickname}  ${s.regIp}  ${s.reason}`));
            if (suspects.length > 8) console.log(`      …还有 ${suspects.length - 8} 个`);
        }
        console.log('  ─────────────────────────────────────────────');
        console.log('  首次运行 Windows 会弹防火墙提示，请选「允许访问」。');
        console.log('  按 Ctrl+C 停止服务。');
        console.log('');
    });
}

if (require.main === module) {
    main().catch((e) => {
        console.error('启动失败：', e);
        process.exit(1);
    });
}

module.exports = { createServer, lanUrls };
