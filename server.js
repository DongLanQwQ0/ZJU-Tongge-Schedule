/**
 * 同格 —— 找个课搭子一起上课。服务端。
 *
 * 零 npm 依赖，只用 node: 内置模块。`node server.js` 即可启动。
 *
 * 两种跑法都支持：
 *   · 正式服：容器里跑，只监听本机端口，对外由反向代理提供 HTTPS，
 *     站点通常挂在子路径下（形如 https://<主机>/tongge/）
 *   · 本机开发 / 预览：直接 `node server.js`，浏览器开 http://localhost:<端口>
 *
 * 绑 0.0.0.0 是为了让上面两种跑法都成立；正式部署时用防火墙或反代决定
 * 谁能连进来，别把这个端口直接暴露到公网。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const captcha = require('./shared/captcha.js');
const vaultLib = require('./shared/vault.js');
const { createStore, fail, validateCode } = require('./shared/store.js');
const config = require('./shared/config.js');

const PUBLIC = path.join(__dirname, 'public');
const SHARED = path.join(__dirname, 'shared');
const DATA = path.join(__dirname, 'data');
const MAX_BODY = 1024 * 1024;          // 1 MB
/**
 * 超限后还愿意读掉多少字节。
 *
 * 为什么要多读：如果一超限就回 413 并关连接，客户端多半**收不到**那个 413 ——
 * 它还在往外写，内核直接回 RST，抓到的就是 ECONNRESET，
 * 于是页面只能提示「连不上服务器」，完全猜不到是内容太大。
 * 实测（见测试）：早断和读完再回，客户端拿到的东西完全不同。
 *
 * 但不能无限读（那等于把内存/带宽白送给攻击者），所以给个上限：
 * 4 倍以内读完再好好回 413，再多就直接掐断。
 */
const MAX_DRAIN = 4 * MAX_BODY;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 60 * 1000;
// 同一个昵称连错这么多次之后，登录要过一道验证码（密码连错两次是很正常的手滑，
// 再往后就该怀疑是脚本在换着密码试了）
const LOGIN_CAPTCHA_AFTER = 2;

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

/**
 * 所有响应都该带上的安全头。
 *
 * 这一份是唯一来源 —— 以前 send() 和 sendFile() 各自 writeHead，
 * 加头就得记得改两处，早晚会漏。现在统一从这里拼。
 *
 * CSP 说明：index.html 有一段内联主题脚本（首屏防闪白）、正文里有大量
 * style="…" 内联属性，所以 script-src / style-src 只能放行 'unsafe-inline'。
 * 剩下的约束仍有价值：挡掉外部脚本注入、限制外连与嵌套。
 */
const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'"
    ].join('; ')
};

/** 超限的请求体：错误对象上带一个标记，路由层据此知道响应已经发过了 */
function tooLarge() {
    const e = fail(413, '请求内容太大了');
    e.bodySent = true;
    return e;
}

/**
 * 非正常响应的**唯一出口**（403 / 404 / 405 / 413 / 4xx / 5xx）。
 *
 * 两条规矩：
 *  1. 一律带上安全头 —— 出错也不能把 nosniff / frame-ancestors 弄丢。
 *  2. 只透传**我们自己的**业务文案（fail() 造出来的，带 e.status）。
 *     其余（比如 fs 抛的 EISDIR、ENOENT）一律换成固定文案 ——
 *     那些原文会把 errno 甚至你电脑上的绝对路径念给攻击者听。
 *     细节只留在服务端日志里。
 */
function sendDenial(res, status, message, extraHeaders, extraBody) {
    const body = JSON.stringify(Object.assign({ error: message }, extraBody || {}));
    res.writeHead(status, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    }, SEC_HEADERS, extraHeaders || {}));
    res.end(body);
}

function send(res, status, payload) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, Object.assign({
        'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    }, SEC_HEADERS));
    res.end(body);
}

function sendError(res, status, message, extraBody) {
    sendDenial(res, status, message, null, extraBody);
}

/**
 * 只接受 JSON 请求体。
 *
 * 为什么必须查：不查的话，text/plain 也能被解析成 JSON —— 而 text/plain 是
 * 浏览器 <form> 能提交、且**不触发 CORS 预检**的类型。现在因为令牌走
 * Authorization 头（跨站页面塞不进去）所以还没事，但这是 CSRF 需要的最后一块拼图：
 * 哪天令牌改存 Cookie，这个洞当天就变成真漏洞。
 */
function assertJsonContentType(req) {
    // 没带 body 的请求（GET / DELETE 之类的无体调用）没有内容类型可言，放行
    const hasBody = Number(req.headers['content-length'] || 0) > 0 ||
        req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) return;
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\s*(;|$)/i.test(ct)) {
        throw fail(415, '请求格式不对，只接受 application/json');
    }
}

function readBody(req, res) {
    assertJsonContentType(req);
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let over = false;      // 已超限：不再攒数据，只负责把剩下的读掉
        let drained = 0;

        req.on('data', (c) => {
            if (over) {
                drained += c.length;
                // 太难缠（不肯停）就掐掉，不给它无限喂数据的机会
                if (drained > MAX_DRAIN) req.destroy();
                return;
            }
            size += c.length;
            if (size > MAX_BODY) {
                over = true;
                chunks.length = 0;      // 已经不要了，立刻释放
                return;
            }
            chunks.push(c);
        });

        // 读完了才回 413：这样客户端一定收得到（它已经写完了，不会再撞 RST）
        req.on('end', () => {
            if (over) {
                sendDenial(res, 413, '请求内容太大了', { Connection: 'close' });
                reject(tooLarge());
                return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try {
                resolve(JSON.parse(text));
            } catch (e) {
                reject(fail(400, '请求内容不是合法的 JSON'));
            }
        });

        // 读不干净（对端提前跑了）：这里可能还没回过 413，补一次
        req.on('aborted', () => {
            if (over && !res.headersSent) sendDenial(res, 413, '请求内容太大了');
        });
        req.on('error', (e) => {
            if (over) {
                if (!res.headersSent) sendDenial(res, 413, '请求内容太大了');
                reject(tooLarge());
                return;
            }
            reject(e);
        });
    });
}

// ---------------------------------------------------------------- 按 IP 限流

/**
 * 固定窗口计数器，按来源 IP 计数。
 *
 * 目的不是防 DDoS（这个量级的站点也没那个必要），而是让**枚举邀请码**和
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
        /**
         * 记一次并判断是否超限；超了就抛 429。
         * 语义是「这次请求消耗了一个额度」——**被拒时不要再调它**，
         * 否则一次拒绝会被记成两次，把阈值凭空砍半。
         */
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

        /**
         * 只看不记：判断当前是否已经被限住。
         *
         * 「已经超限」和「这次是压垮骆驼的那一根」是两件事。
         * 前者应该直接拒且不再计数，后者才该计数并拒绝。
         * 分开之后，连错 N 次的结果是第 N+1 次开始 429，干净可预测。
         */
        isLimited(key) {
            const now = Date.now();
            const rec = hits.get(key);
            return !!rec && now < rec.resetAt && rec.count >= max;
        },

        /** 清掉某个 key 的计数（登录成功时用） */
        reset(key) { hits.delete(key); },

        clear() { hits.clear(); }
    };
}

// ---------------------------------------------------------------- 真实来源 IP

/**
 * 默认信任的"上游"网段。
 *
 * 为什么需要这份清单：站点在反向代理后面时，`socket.remoteAddress` 拿到的是
 * 反代/网桥网关的地址 —— 于是**所有请求共用一个限流桶**，一个人的 9 次注册尝试
 * 就能把全站的注册额度吃光（登录失败限流同理，可以直接把全站锁在门外）。
 *
 * 真实来源只能从 `X-Forwarded-For` 里取，而那个头**是客户端可以自己填的**：
 * 只要直连方不可信就绝不能看它，否则攻击者写一个 `X-Forwarded-For: 1.2.3.4`
 * 就绕过了所有限流。
 *
 * 默认值覆盖"本机 + 容器网段"（Docker 里反代连进来时，容器看到的源地址是网桥网关）。
 * ⚠️ 如果这个端口还对局域网开放、或同网段跑着不受信任的容器，必须用
 * `TONGGE_TRUSTED_PROXIES` 收窄（写 `none` 就是一个都不信）。
 */
const DEFAULT_TRUSTED_PROXIES = [
    ['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['169.254.0.0', 16, 'ipv4'],
    ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6']
];

/** `::ffff:172.17.0.1` → `172.17.0.1`。Node 在双栈 socket 上就是这么给 IPv4 的 */
function normalizeIp(addr) {
    const s = String(addr == null ? '' : addr).trim();
    const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
    return m ? m[1] : s;
}

const ipFamily = (addr) => (normalizeIp(addr).includes(':') ? 'ipv6' : 'ipv4');

/**
 * 解析可信反代清单：`"127.0.0.1,10.0.0.0/8,::1"`，或 `none`（谁都不信）。
 *
 * 传空/不传就用默认网段。**非法值直接抛**：配置写错了要立刻看得见，
 * 而不是悄悄退化成"谁都不信"或"谁都信"。
 */
function parseTrustedProxies(raw) {
    const list = new net.BlockList();
    let count = 0;
    const add = (addr, prefix, family) => {
        list.addSubnet(addr, prefix, family);
        count += 1;
    };

    const spec = raw == null ? '' : String(raw).trim();
    if (spec === '') {
        DEFAULT_TRUSTED_PROXIES.forEach(([a, p, f]) => add(a, p, f));
        return { list, count, configured: false };
    }
    if (/^(none|off|false|0)$/i.test(spec)) return { list, count: 0, configured: true };

    spec.split(',').map((s) => s.trim()).filter(Boolean).forEach((item) => {
        const [addr, prefix] = item.split('/');
        const ver = net.isIP(addr);
        if (!ver) throw new Error(`TONGGE_TRUSTED_PROXIES 里不是合法 IP：${item}`);
        const family = ver === 6 ? 'ipv6' : 'ipv4';
        const bits = prefix === undefined ? (ver === 6 ? 128 : 32) : Number(prefix);
        if (!Number.isInteger(bits) || bits < 0 || bits > (ver === 6 ? 128 : 32)) {
            throw new Error(`TONGGE_TRUSTED_PROXIES 里的前缀长度不合法：${item}`);
        }
        add(addr, bits, family);
    });
    return { list, count, configured: true };
}

function isTrustedIp(addr, trusted) {
    const ip = normalizeIp(addr);
    if (!ip || !trusted || !trusted.list || net.isIP(ip) === 0) return false;
    try {
        return trusted.list.check(ip, ipFamily(ip));
    } catch (_) {
        return false;
    }
}

/**
 * 取真实来源 IP。规则只有一条：**只有直连方可信时，才看那些转发头**。
 *
 * 可信时从 `X-Forwarded-For` **从右往左**找第一个不可信的地址 —— 最左边那个
 * 是客户端自己填的（中间有多少层代理就会追加多少段），认它等于认攻击者写的值。
 * 整条链都是可信代理、或压根没有这个头，就退到 `X-Real-IP`，再不行只能认直连方。
 */
function resolveClientIp(req, trusted) {
    const peer = normalizeIp(req.socket && req.socket.remoteAddress) || 'unknown';
    if (!isTrustedIp(peer, trusted)) return peer;

    const chain = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => normalizeIp(s))
        .filter((s) => s && net.isIP(s) !== 0);
    for (let i = chain.length - 1; i >= 0; i--) {
        if (!isTrustedIp(chain[i], trusted)) return chain[i];
    }

    const real = normalizeIp(req.headers['x-real-ip']);
    if (real && net.isIP(real) !== 0 && !isTrustedIp(real, trusted)) return real;

    return peer;
}

// ---------------------------------------------------------------- 服务

/**
 * 根密钥 → vault 实例。
 *
 * 三条规则：
 *   options.vault === false   显式关闭加密（**只给测试用**；正式入口永远不给这个值）
 *   options.vault 是实例       直接用它
 *   其余                      从环境读 TONGGE_ROOT_KEY，**缺失或格式错一律拒绝启动**
 *
 * 正式入口不给"默认不加密"这条退路：悄悄退化成明文存盘，比启动失败危险得多 ——
 * 前者没人会发现，后者一眼就看见。
 */
function resolveVault(options) {
    if (options.vault === false) return null;
    if (options.vault) return options.vault;
    let key;
    try {
        key = vaultLib.fromEnv();
    } catch (e) {
        throw new Error(`根密钥格式不对：${e.message}`);
    }
    if (!key) {
        throw new Error([
            '没有配置根密钥 TONGGE_ROOT_KEY，拒绝启动（不允许明文存盘）。',
            '  生成一把（服务器上一般没装 node，用容器版）：',
            '    docker run --rm node:22-alpine node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
            '  写进**部署目录之外**的文件（例如 /etc/tongge/key.env），',
            '  再由 compose 的 env_file 注入；绝不要和数据卷一起备份。'
        ].join('\n'));
    }
    return vaultLib.createVault(key);
}

async function createServer(options = {}) {
    const port = options.port || Number(process.env.PORT) || 3000;
    const vault = resolveVault(options);

    // 限流要按"真实来源"分桶：只有直连方可信时才采信 X-Forwarded-For。
    // 这个局部 const 会遮蔽模块级的解析函数（同名只是巧合，见上面的说明），
    // 于是本函数里所有路由都自动用上真实 IP —— 十几处调用点一个都不用改。
    const trusted = parseTrustedProxies(
        options.trustedProxies !== undefined ? options.trustedProxies : process.env.TONGGE_TRUSTED_PROXIES
    );
    const clientIp = (req) => resolveClientIp(req, trusted);

    const store = createStore(options.dataDir || DATA, { vault });

    try {
        await store.init();
    } catch (e) {
        // 根密钥不对时，解第一条密文就会抛 VaultError —— 在这里翻译成人能看懂的话
        if (e && e.name === 'VaultError') {
            throw new Error(`根密钥不对（或数据被改过），拒绝启动：${e.message}`);
        }
        throw e;
    }

    // 启动自检：还有明文就拒绝启动。
    // 不做惰性迁移（读到明文就顺手加密）——那样没被碰过的字段会一直是明文，
    // 目标就落空了；而且"一半明文一半密文"的中间态最难排查。
    if (vault) {
        const pending = await store.pendingPlaintext();
        if (pending.length) {
            throw new Error([
                `数据还没迁移：${pending.length} 处敏感字段仍是明文，拒绝启动。`,
                '  停掉服务后执行（迁移不能和服务同时跑，否则会被覆盖回明文）：',
                '    node server.js --migrate-vault --super <超管昵称>'
            ].join('\n'));
        }
    }

    // 超管数量：正常应该正好 1 个（迁移之前可能是 0）。不对就在横幅上喊一声，
    // 不拒绝启动 —— 否则第一位超管都没设的时候服务就起不来了，那没法引导。
    const superCount = await store.countSupers();

    if (!options.skipCleanup) store.cleanup().catch((e) => console.error('[cleanup]', e.message));

    // ------------------------------------------------------------ 注册验证码
    //
    // 题目与答案只活在内存里：3 分钟过期、**一次一废**（不管答对答错都作废，
    // 免得拿同一个 id 反复试答案）。正式服开着，测试里用 createServer({captcha:false}) 关掉。
    //
    // 它挡的是「随手写个脚本灌号」，挡不住愿意上 OCR/打码平台的人 ——
    // 和按 IP 的注册限流是叠加关系，不是替代。
    const captchaOn = options.captcha !== false;
    const captchaRng = options.captchaRng;      // 测试注入固定随机源，让题目可预测
    const CAPTCHA_TTL = 3 * 60 * 1000;
    const CAPTCHA_MAX = 500;                    // 同时挂着的题目上限，别让它无限长
    const captchas = new Map();

    function issueCaptcha() {
        const now = Date.now();
        captchas.forEach(function (v, k) { if (v.expireAt < now) captchas.delete(k); });
        if (captchas.size >= CAPTCHA_MAX) captchas.clear();   // 兜底：极端情况整批作废
        const made = captcha.create(captchaRng);
        const id = crypto.randomBytes(9).toString('hex');
        captchas.set(id, { answer: made.answer, expireAt: now + CAPTCHA_TTL });
        return {
            enabled: true,
            id: id,
            image: 'data:image/png;base64,' + made.png.toString('base64')
        };
    }

    /** 核销一道题：不管对错都作废，避免拿同一个 id 反复试答案 */
    function takeCaptcha(id, answer) {
        const key = String(id == null ? '' : id);
        const rec = captchas.get(key);
        if (rec) captchas.delete(key);
        if (!rec || rec.expireAt < Date.now()) return false;
        return String(answer == null ? '' : answer).trim() === rec.answer;
    }

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
    /** 这个昵称当前连错了几次（没记录就是 0 次） */
    function failCount(key) {
        const rec = loginFails.get(key);
        return rec ? rec.fails : 0;
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

    /**
     * 超管门禁。在 requireAdmin 之上再加一道：只认那唯一一位。
     *
     * 顺序照旧：先登录（401）→ 再管理员（403）→ 再超管（403），
     * 别让没登录的人靠状态码差异探出「这个接口存在」。
     */
    async function requireSuper(req) {
        const ctx = await requireAdmin(req);
        if (!ctx.user.super) throw fail(403, '这事只有超级管理员能做');
        return ctx;
    }

    const routes = [
        // ---- 元信息
        // 健康探针。Dockerfile 与 compose 的 HEALTHCHECK 都打这个接口，
        // 它也是唯一免鉴权的接口 —— 所以只回「服务活着」这件事，
        // 不回网卡、内网地址之类的拓扑信息（那些东西对访问者没用，对扫描者有用）。
        ['GET', /^\/api\/meta$/, async () => ({
            ok: true,
            app: config.appName,
            tagline: config.tagline
        })],

        // 注册验证码：一道个位数加减法，服务端画成 PNG 发下来。
        // 算式是画进像素的，响应里只有图 —— 想看答案得认图，不能直接从 JSON 里读。
        ['GET', /^\/api\/captcha$/, async () => (captchaOn
            ? issueCaptcha()
            : { enabled: false, id: '', image: '' })],

        // ---- 账号
        ['POST', /^\/api\/register$/, async (req, res) => {
            const ip = clientIp(req);
            try {
                limiter.registerBurst.check(ip);
                limiter.register.check(ip);
            } catch (e) {
                // 被限流也记一笔：连续撞限流本身就是要看的信号
                store.appendAudit({ event: 'register_blocked', ip, reason: e.message });
                throw e;
            }
            const body = await readBody(req, res);
            if (captchaOn && !takeCaptcha(body.captchaId, body.captchaAnswer)) {
                // 和撞限流一样记一笔：连着被验证码挡下，本身就是值得看的信号
                store.appendAudit({ event: 'register_blocked', ip, reason: '验证码不对' });
                throw fail(400, '验证码不对，换一张再试');
            }
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

        ['POST', /^\/api\/login$/, async (req, res) => {
            const body = await readBody(req, res);
            const key = throttleKey(body.nickname);
            const ip = clientIp(req);
            checkThrottle(key);
            // 连错两次之后，登录也得先过验证码 —— 挡的是「换着密码试同一个号」的脚本。
            // 注意这一步在核对密码**之前**：带着旧密码蒙对的人也得先算题。
            if (captchaOn && failCount(key) >= LOGIN_CAPTCHA_AFTER
                && !takeCaptcha(body.captchaId, body.captchaAnswer)) {
                throw fail(400, '密码连错两次了，先把图里的算式算出来');
            }
            const user = await store.verifyLogin(body.nickname, body.password);
            if (!user) {
                noteFail(key);
                limiter.loginFail.check(ip);   // 按 IP 再兜一层，防换昵称刷
                // 顺带告诉前端「下一次要带验证码」，它好把那一格显示出来
                const needCaptcha = captchaOn && failCount(key) >= LOGIN_CAPTCHA_AFTER;
                throw Object.assign(fail(401, '昵称或密码不对'),
                    needCaptcha ? { extra: { captchaRequired: true } } : {});
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

        ['PUT', /^\/api\/me\/courses$/, async (req, res) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            const updated = await store.setUserCourses(user.id, body.courses);
            return { ok: true, courseCount: (updated.courses || []).length };
        }],

        ['PUT', /^\/api\/me\/password$/, async (req, res) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            const ip = clientIp(req);

            // 旧密码这一关必须和登录一样有刹车。
            // 没有它的话：抓到一次令牌就能无限次猜旧密码，猜中即永久接管账号
            // —— 而且改密码会吊销本人的全部会话，受害者直接被锁在门外。
            const throttle = 'pw:' + user.id;
            if (limiter.loginFail.isLimited(throttle)) {
                store.appendAudit({ event: 'password_change_blocked', nickname: user.nickname, ip });
                throw fail(429, '原密码错误次数太多，歇十分钟再来');
            }

            const ok = await store.verifyLogin(user.nickname, body.oldPassword);
            if (!ok) {
                // 只在这条路径上计数：被拒的那次不算，成功的那次也不算
                limiter.loginFail.check(throttle);
                throw fail(401, '原密码不对');
            }
            limiter.loginFail.reset(throttle);
            await store.setUserPassword(user.id, body.newPassword);
            store.appendAudit({ event: 'password_change', nickname: user.nickname, ip });
            return { ok: true };
        }],

        // 给群友起/改/清备注（只影响自己看到的名字）
        ['PUT', /^\/api\/me\/remarks\/([A-Za-z0-9_-]{1,40})$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            const remarks = await store.setRemark(user.id, m[1], body.remark);
            return { ok: true, remarks };
        }],

        // 注销账号：不可恢复，必须带密码
        ['DELETE', /^\/api\/me$/, async (req, res) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
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
        ['POST', /^\/api\/groups$/, async (req, res) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            const g = await store.createGroup(user.id, body.name);
            return { code: g.code, name: g.name };
        }],

        ['POST', /^\/api\/groups\/(\d{6}|\d{8})\/join$/, async (req, res, m) => {
            limiter.join.check(clientIp(req));   // 枚举邀请码的主要入口，卡死在这里
            const { user } = await requireUser(req);
            // 走 joinByInvite：它先认「有时效的邀请码」，再退回群主自己的永久码。
            // 直接用 joinGroup 的话，邀请码（不是群码）根本找不到文件。
            const r = await store.joinByInvite(validateCode(m[1]), user.id);
            return { ok: true, code: r.group.code, name: r.group.name, pending: r.pending };
        }],

        ['GET', /^\/api\/groups\/(\d{6}|\d{8})$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const detail = await store.groupDetail(validateCode(m[1]), user.id);
            const isMember = detail.members.some((x) => x.id === user.id);
            if (!isMember) throw fail(403, '你还没有加入这个群组');
            return detail;
        }],

        // 群主改群组设置（入群方式 / 成员能否邀请）
        ['PUT', /^\/api\/groups\/(\d{6}|\d{8})\/settings$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            await store.updateGroupSettings(validateCode(m[1]), user.id, body);
            return { ok: true };
        }],

        // 群主换掉群自己的码：以前发出去的所有旧链接一起失效。
        // 主要给改版前那批 6 位老群用 —— 老码空间小，早点换掉更稳。
        ['POST', /^\/api\/groups\/(\d{6}|\d{8})\/rotate-code$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const r = await store.rotateGroupCode(validateCode(m[1]), user.id, {});
            store.appendAudit({
                event: 'group_rotate_code',
                by: user.nickname,
                from: r.oldCode,
                to: r.code,
                ip: clientIp(req)
            });
            return { ok: true, oldCode: r.oldCode, code: r.code };
        }],

        // 群主发一枚新的邀请链接，可带有效期：1d / 3d / 7d / 30d / never
        ['POST', /^\/api\/groups\/(\d{6}|\d{8})\/invites$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            const inv = await store.addInvite(validateCode(m[1]), user.id, body.ttl, body.label);
            store.appendAudit({
                event: 'invite_create',
                by: user.nickname,
                group: m[1],
                code: inv.code,
                expiresAt: inv.expiresAt,
                ip: clientIp(req)
            });
            return { ok: true, invite: inv };
        }],

        // 群主批量作废若干条有效链接（管理页上的多选）
        ['POST', /^\/api\/groups\/(\d{6}|\d{8})\/invites\/revoke$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            const r = await store.revokeInvites(validateCode(m[1]), user.id, body.codes);
            store.appendAudit({
                event: 'invite_revoke_bulk',
                by: user.nickname,
                group: m[1],
                codes: r.revoked,
                ip: clientIp(req)
            });
            return { ok: true, revoked: r.revoked };
        }],

        // 彻底删掉一条已作废/已过期的邀请记录（抹掉存档）
        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/invites\/(\d{6}|\d{8})\/purge$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const r = await store.purgeInvite(validateCode(m[1]), user.id, m[2]);
            store.appendAudit({
                event: 'invite_purge',
                by: user.nickname,
                group: m[1],
                code: m[2],
                ip: clientIp(req)
            });
            return r;
        }],

        // 群主作废某一枚邀请链接（可顺手发一枚新的）
        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/invites\/(\d{6}|\d{8})$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res).catch(() => ({}));
            const r = await store.revokeInvite(validateCode(m[1]), user.id, m[2], {
                issueNew: !!(body && body.issueNew),
                ttl: body && body.ttl
            });
            store.appendAudit({
                event: 'invite_revoke',
                by: user.nickname,
                group: m[1],
                code: m[2],
                ip: clientIp(req)
            });
            return { ok: true, revoked: r.revoked || m[2], invite: r.issued || null };
        }],

        // 设自己在群里的对外备注（改的是自己的名字，所以不要求群主）
        ['PUT', /^\/api\/groups\/(\d{6}|\d{8})\/self-remark$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            const body = await readBody(req, res);
            const selfRemark = await store.setSelfRemark(validateCode(m[1]), user.id, body.remark);
            return { ok: true, selfRemark };
        }],

        // 群主审批入群申请
        ['POST', /^\/api\/groups\/(\d{6}|\d{8})\/requests\/([A-Za-z0-9_-]{1,40})\/approve$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            await store.approveRequest(validateCode(m[1]), user.id, m[2]);
            return { ok: true };
        }],

        // 群主拒绝 / 忽略一条申请
        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/requests\/([A-Za-z0-9_-]{1,40})$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            await store.rejectRequest(validateCode(m[1]), user.id, m[2]);
            return { ok: true };
        }],

        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/me$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            await store.leaveGroup(validateCode(m[1]), user.id);
            return { ok: true };
        }],

        // 群主移除成员（userId 形如 u_xxxxxxxx）
        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})\/members\/([A-Za-z0-9_-]{1,40})$/, async (req, res, m) => {
            const { user } = await requireUser(req);
            await store.removeMember(validateCode(m[1]), user.id, m[2]);
            return { ok: true };
        }],

        ['DELETE', /^\/api\/groups\/(\d{6}|\d{8})$/, async (req, res, m) => {
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
                    superCount: users.filter((u) => u.super).length,
                    groupCount: groups.length,
                    suspectCount: suspects.length,
                    dormantCount: users.filter((u) => u.dormant).length,
                    courseUploaded: users.filter((u) => u.courseCount > 0).length
                }
            };
        }],

        // 授 / 撤管理员
        ['PUT', /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})\/admin$/, async (req, res, m) => {
            const { user } = await requireAdmin(req);
            const body = await readBody(req, res);
            const on = !!body.admin;
            const targetId = m[1];

            // 超管的权限谁都动不了（包括他自己）——"唯一"这条约束靠这里守住。
            // 要换人只能走服务器上的 CLI：node server.js --set-super <昵称>
            const target = await store.getUser(targetId);
            if (target && target.super) {
                throw fail(403, '超级管理员的权限不能改；要换人请在服务器上跑 --set-super');
            }

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
        ['DELETE', /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})$/, async (req, res, m) => {
            const { user } = await requireAdmin(req);
            if (m[1] === user.id) throw fail(400, '不能删自己，换个管理员账号来操作');
            // 删掉超管 = 这个站点再也没有人能恢复备注、也没有人能接手超管位
            const doomed = await store.getUser(m[1]);
            if (doomed && doomed.super) throw fail(403, '超级管理员不能被删除');
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
        ['POST', /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})\/reset-password$/, async (req, res, m) => {
            const { user: admin } = await requireAdmin(req);
            // 谁都不能重置超管的密码（含超管自己）：拿到临时密码就等于接管那个账号，
            // 而超管位是"唯一且不可撤销"的，那等于把超管位让出去。
            // 超管要改自己的密码，走 /api/me/password（那里要旧密码）。
            const victim = await store.getUser(m[1]);
            if (victim && victim.super) {
                throw fail(403, '不能重置超级管理员的密码；让他自己走「改密码」');
            }
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

        // 超管读某个账号的私密备注明文。
        //
        // 服务器本来就有解密能力（钥匙在它的环境里），假装"谁也看不到"只会让人
        // 以为这套东西是端到端加密。所以把这条能力**显式化 + 每次留审计**，
        // 只有唯一那位超管能用。审计里只记条数，绝不记备注内容。
        ['GET', /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})\/notes$/, async (req, res, m) => {
            const { user } = await requireSuper(req);
            const target = await store.getUser(m[1]);
            if (!target) throw fail(404, '账号不存在');
            const remarks = target.remarks && typeof target.remarks === 'object' ? target.remarks : {};
            // 这里 await：审计要先落盘再回内容。看别人的私密备注这种事，
            // 不能出现"内容给出去了、记录还没来得及写"的窗口。
            await store.appendAudit({
                event: 'notes_view',
                by: user.nickname,
                target: target.nickname,
                count: Object.keys(remarks).length,
                ip: clientIp(req)
            });
            return { ok: true, userId: target.id, nickname: target.nickname, remarks };
        }],

        // 管理员给任意群换一个 8 位新码（旧码当场作废）。
        // 主要用途：清掉改版前那批 6 位老码 —— 它们的空间小得多。
        ['POST', /^\/api\/admin\/groups\/(\d{6}|\d{8})\/rotate-code$/, async (req, res, m) => {
            const { user: admin } = await requireAdmin(req);
            const r = await store.rotateGroupCode(validateCode(m[1]), admin.id, { asAdmin: true });
            store.appendAudit({
                event: 'admin_rotate_group_code',
                by: admin.nickname,
                from: r.oldCode,
                to: r.code,
                ip: clientIp(req)
            });
            return { ok: true, oldCode: r.oldCode, code: r.code };
        }],

        // 解散任意群组，不需要是群主
        ['DELETE', /^\/api\/admin\/groups\/(\d{6}|\d{8})$/, async (req, res, m) => {
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

        res.writeHead(200, Object.assign({
            'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            // /lib/ 是内置的第三方库，几乎不变，可以长缓存；
            // /img/mascot/ 是页脚那几张吉祥物 gif，一张一兆，也不变，同样长缓存；
            // /shared/ 是我们自己的业务代码（比对规则就在里面），必须每次回源 ——
            // 否则改完规则用户刷新页面拿到的还是旧逻辑，得等一天缓存过期。
            'Cache-Control': (pathname.startsWith('/lib/') || pathname.startsWith('/img/mascot/'))
                ? 'public, max-age=86400'
                : 'no-cache'
        }, SEC_HEADERS));
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

    /**
     * /shared/ 下**允许**浏览器取的文件，只放行前端真正 <script> 加载的那 5 个。
     *
     * 以前是整个目录敞开的，连 auth.js / store.js 都能下载。那两个文件里
     * 没有密钥（我核过），所以不算泄漏；但 auth.js 的文件头自己写着
     * 「仅服务端使用，浏览器端不加载」—— 声明和事实对不上。
     * 更要紧的是：哪天有人往 shared/ 里放一个密钥常量，敞开就等于当场泄漏。
     * 白名单让那句声明变成代码事实。
     */
    const SHARED_PUBLIC = new Set(['config.js', 'periods.js', 'ics.js', 'weeks.js', 'compare.js']);

    async function serveStatic(req, res, pathname) {
        // /shared/* 直接映射到仓库里的 shared/，避免把共享模块复制一份到 public/
        if (pathname === '/shared' || pathname.startsWith('/shared/')) {
            const rel = pathname.slice('/shared'.length);
            const name = rel.replace(/^[/\\]+/, '');
            if (!SHARED_PUBLIC.has(name)) return sendError(res, 404, '共享模块不存在');
            const full = resolveUnder(SHARED, rel);
            if (!full) return sendError(res, 403, '路径不合法');
            if (await sendFile(res, full, pathname)) return;
            return sendError(res, 404, '共享模块不存在');
        }

        let rel = pathname === '/' ? '/index.html' : pathname;
        try { rel = decodeURIComponent(rel); } catch (_) { /* 保持原样 */ }

        const full = resolveUnder(PUBLIC, rel);
        if (!full) return sendError(res, 403, '路径不合法');
        if (await sendFile(res, full, pathname)) return;

        // 前端是单页应用，**未知的页面路径**才回落到 index.html。
        //
        // 不能无条件回落：以前 /../server.js 这种明显是穿越尝试的请求也回 200，
        // 于是「被挡住了」和「真的读到了源码」在响应上长得一模一样 ——
        // 安全结论只能靠人去比对响应体长度（我做审计时就是这么踩进去的）。
        // 而且哪天有人改坏了路径处理，真漏洞会静默生效、毫无信号。
        //
        // 所以三种情况直接 404，不给首页：
        //   1. 末段带扩展名 —— 那是在要一个文件，不是要页面
        //   2. normalize 之后和原样不一样 —— 形状就是穿越（含 . / .. / 双斜杠）
        //   3. 带 NUL —— 截断攻击的老手法
        if (looksLikeFile(rel) || looksSuspicious(rel)) {
            return sendError(res, 404, '页面不存在');
        }
        return sendIndex(res);
    }

    /** 末段带扩展名 = 想要一个文件，不该拿到首页 */
    function looksLikeFile(rel) {
        const last = rel.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
        return /\.[a-z0-9]{1,10}$/i.test(last);
    }

    /**
     * 形状像穿越 / 截断的路径。
     *
     * 用「normalize 前后是否一致」来判断，比自己拆段数空串可靠 ——
     * 后者会把正常路径开头的那个 '/' 也算成空段，于是 /some/deep/page 被误伤。
     */
    function looksSuspicious(rel) {
        if (rel.includes('\0')) return true;
        const stripped = rel.replace(/^[/\\]+/, '');
        if (!stripped) return false;
        return path.normalize(stripped).replace(/\\/g, '/') !== stripped.replace(/\\/g, '/');
    }

    async function sendIndex(res) {
        try {
            const html = await fsp.readFile(path.join(PUBLIC, 'index.html'));
            res.writeHead(200, Object.assign({
                'Content-Type': MIME['.html'],
                'Content-Length': html.length,
                'Cache-Control': 'no-cache'
            }, SEC_HEADERS));
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
                // readBody 超限时已经自己回过 413 了，这里不能再回一次
                if (e && e.bodySent) return;
                const status = e && e.status ? e.status : 500;
                if (status >= 500) console.error(`[api] ${method} ${pathname}`, e);
                // 只有我们自己造的（带 status）才把文案透出去；
                // 其余是 fs / 运行时抛的原文，里头可能有 errno 甚至绝对路径。
                const msg = (e && e.status) ? e.message : '服务器内部错误';
                return sendError(res, status, msg, e && e.extra);
            }
        }
        return sendError(res, 404, '接口不存在');
    });

    // 每日清理一次过期会话与群组
    const timer = setInterval(() => {
        store.cleanup().catch((e) => console.error('[cleanup]', e.message));
    }, 24 * 3600 * 1000);
    timer.unref();

    // 会话表攒下的 lastSeen 定期落盘（10 秒一次，脏了才写）
    const flushTimer = setInterval(() => {
        store.flushSessions('定时').catch(() => {});
    }, 10 * 1000);
    flushTimer.unref();

    // 关服前把还没落盘的会话写下去，免得下次启动读到偏旧的 lastSeen
    server.on('close', () => {
        clearInterval(flushTimer);
        store.flushSessions('关服').catch(() => {});
    });

    server.store = store;
    server.port = port;
    server.encrypted = !!vault;
    server.superCount = superCount;
    server.trustedProxies = trusted;
    return server;
}

/**
 * 解析命令行参数：
 *   --port <端口>
 *   --make-admin <昵称>     把这个账号设为管理员
 *   --revoke-admin <昵称>   取消管理员
 *   --migrate-vault         把明文数据就地转成密文（跑完即退出，不启服务）
 *   --super <昵称>          配合 --migrate-vault：指定唯一的超级管理员
 *   --set-super <昵称>      单独改超级管理员（从旧的那位移交过来）
 *   --data-dir <目录>       指定数据目录（本地演练时指向副本，不动真数据）
 *
 * 授权走命令行而不是网页，是因为这是**本机操作** —— 能敲这条命令就说明
 * 你本来就摸得到 data/ 目录，不需要再发明一套引导密码。
 * 也正因如此，这里全程不碰密码：只翻 user.admin / user.super 这两个标记。
 */
function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port') opts.port = Number(argv[++i]);
        else if (argv[i] === '--make-admin') opts.makeAdmin = argv[++i];
        else if (argv[i] === '--revoke-admin') opts.revokeAdmin = argv[++i];
        else if (argv[i] === '--migrate-vault') opts.migrateVault = true;
        else if (argv[i] === '--super') opts.super = argv[++i];
        else if (argv[i] === '--set-super') opts.setSuper = argv[++i];
        else if (argv[i] === '--data-dir') opts.dataDir = argv[++i];
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

/**
 * 迁移 CLI：把明文数据就地转成密文，顺手指定唯一的超级管理员。
 *
 * 为什么不放进 HTTP 服务里（比如做成一个管理接口）：迁移必须在**服务停掉之后**跑 ——
 * 运行中的进程内存里是明文，任何一次写入都会把迁移结果覆盖回明文。
 * 所以它是一条独立命令，跑完就退出。整个流程见
 * docs/superpowers/specs/2026-09-17-storage-encryption-design.md 第 13 节。
 */
async function runMigrateCli(opts) {
    const vault = resolveVault({});                 // 迁移必须有钥匙
    const store = createStore(opts.dataDir || DATA, { vault });
    await store.init();

    console.log('');
    const pending = await store.pendingPlaintext();
    if (!pending.length) {
        console.log('  没有需要迁移的明文（可能已经迁移过）。');
    } else {
        console.log(`  发现 ${pending.length} 处明文，开始迁移…`);
        const report = await store.migrateVault();
        console.log(`  ✔ 已加密 ${report.fields} 个字段（${report.users} 个账号 / ${report.groups} 个群）`);
        report.backups.forEach((b) => {
            console.log(`    明文副本 ${b} —— 确认备份可用后请删掉它（它本身也是泄漏点）`);
        });
        if (!report.backups.length) console.log('  （没有产生明文副本，说明文件本来就已经是密文）');
    }

    const superName = opts.super || opts.setSuper;
    if (superName) {
        const u = await findByName(store, superName);
        if (!u) {
            console.error(`\n  找不到昵称是「${superName}」的账号，超级管理员没设成。`);
            console.error('  先在网页上把这个账号注册出来，再回来执行。\n');
            process.exit(1);
        }
        await store.transferSuper(u.id);
        await store.appendAudit({ event: 'super_set_cli', by: 'cli', target: u.nickname });
        console.log(`  ✔ 超级管理员：${u.nickname}  (${u.id})`);
    }

    const supers = await store.countSupers();
    if (supers !== 1) {
        console.log(`  ⚠ 当前超级管理员有 ${supers} 个（应为 1 个）：用 --super <昵称> 指定。`);
    }

    console.log('');
    console.log('  接下来：');
    console.log('    1. docker compose up -d              起服务（镜像刚才已经 build 过）');
    console.log('    2. 抽查文件里搜不到明文姓名');
    console.log('    3. 确认备份可用后，删掉上面那些明文副本');
    console.log('');
}

/**
 * 进程级兜底。
 *
 * 没有它的话，任何一个没被 catch 住的错误都会让 Node 进程**整个退出** ——
 * 所有同学立刻连不上，而且必须有人走到这台电脑前手动重启。
 * 「半夜爬起来重启」和「记一笔日志继续跑」是很不一样的体验。
 *
 * 注意：兜底**必须记日志**。把异常吞掉又不留痕，等于把 bug 藏起来。
 */
function installCrashGuards(store) {
    let handled = false;
    const crash = (kind, err) => {
        if (handled) return;          // 同类事件连环触发时只处理第一次
        handled = true;
        console.error(`[fatal] ${kind}：`, err);
        const write = store
            ? store.appendAudit({ event: 'crash', kind, message: String((err && err.message) || err) })
            : Promise.resolve();
        write.catch(() => {}).then(() => process.exit(1));
        setTimeout(() => process.exit(1), 1500).unref();
    };
    process.on('uncaughtException', (err) => crash('uncaughtException', err));
    process.on('unhandledRejection', (err) => crash('unhandledRejection', err));
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    // 授权 / 迁移都是离线操作，做完就退出，不启动服务器
    if (opts.makeAdmin !== undefined || opts.revokeAdmin !== undefined) {
        return runAdminCli(opts);
    }
    if (opts.migrateVault) {
        return runMigrateCli(opts);
    }

    const server = await createServer(opts);
    installCrashGuards(server.store);
    const suspects = await server.store.listSuspects().catch(() => []);
    server.listen(server.port, '0.0.0.0', () => {
        console.log('');
        console.log(`  ${config.appName} · ${config.tagline}`);
        console.log(`  发起人     ${config.owner}`);
        console.log('  ─────────────────────────────────────────────');
        console.log(`  本机访问   http://localhost:${server.port}`);
        console.log(`  存储加密   ${server.encrypted ? '已开启（TONGGE_ROOT_KEY）' : '⚠ 未开启（只应出现在测试里）'}`);
        const tp = server.trustedProxies;
        console.log(`  限流依据   ${tp.count === 0
            ? '直连地址（不信任任何转发头）'
            : `真实 IP（可信网段 ${tp.count} 个${tp.configured ? '，来自 TONGGE_TRUSTED_PROXIES' : '，默认：本机 + 容器网段'}）`}`);
        if (server.superCount !== 1) {
            console.log(`  ⚠ 超级管理员有 ${server.superCount} 个（应为 1 个）：`);
            console.log('      在服务器上执行  node server.js --set-super <昵称>  指定一位。');
        }
        console.log('  正式服     对外由反向代理提供 HTTPS，站点形如 https://<主机>/tongge/');
        console.log('             这里不再打印网卡地址：正式服的入口是反代，不是本机端口。');
        if (suspects.length) {
            console.log(`  ⚠ 有 ${suspects.length} 个账号被标为「待复核」（同 IP 集中注册），明细见 data/audit.log：`);
            suspects.slice(0, 8).forEach((s) => console.log(`      ${s.nickname}  ${s.regIp}  ${s.reason}`));
            if (suspects.length > 8) console.log(`      …还有 ${suspects.length - 8} 个`);
        }
        console.log('  ─────────────────────────────────────────────');
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

module.exports = { createServer, resolveClientIp, parseTrustedProxies };
