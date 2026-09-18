'use strict';

/**
 * 前端屏幕全量扫描。
 *
 * 这个环境里浏览器起不来（agent-browser 会挂，chrome 连 --version 都挂），
 * 所以这里自己垫一个够用的 DOM，把**真实的 app.js 原样跑起来**，逐个屏幕走一遍。
 *
 * 垫片只实现 app.js 真正用到的那部分：id / class / tag / [attr] 选择器、
 * 后代选择器、closest、事件冒泡、innerHTML（真的解析成子元素，否则渲染出来的
 * 按钮绑不上事件）、className、classList、文本节点。
 *
 * 目的不是模拟浏览器，而是回答一个具体问题：**每个屏幕能不能真的走到、渲染不报错**。
 * 前端历来出 bug 都在这一层（重复 id、按钮绑两次、动态列表没绑上事件）。
 */

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createServer } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const HTML_SRC = read('public', 'index.html');
const API_SRC = read('public', 'api.js');
const APP_SRC = read('public', 'app.js');
// 二维码是老式脚本：顶层 var qrcode 靠全局作用域暴露，app.js 里裸写 qrcode(...)
const QR_SRC = read('public', 'lib', 'qrcode.js');

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr']);

// ---------------------------------------------------------------- 解析

function parseAttrs(str) {
    const attrs = {};
    const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(str || ''))) {
        attrs[m[1]] = m[2] !== undefined ? m[2]
            : m[3] !== undefined ? m[3]
                : m[4] !== undefined ? m[4] : '';
    }
    return attrs;
}

/**
 * 够用的 HTML 解析器：处理开/闭标签与文本节点。
 * 只关心结构，不关心属性引号之外的花活。
 */
function parseHTML(src) {
    const roots = [];
    const stack = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
    let last = 0;
    let m;

    function push(node) {
        const parent = stack[stack.length - 1];
        if (parent) { parent.children.push(node); node.parentNode = parent; }
        else roots.push(node);
    }

    while ((m = re.exec(src))) {
        const text = src.slice(last, m.index);
        if (text.trim() && stack.length) {
            push({ nodeType: 3, nodeValue: text, children: [], parentNode: null });
        }
        last = re.lastIndex;

        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();

        if (closing) {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
            }
            continue;
        }
        const el = makeEl(tag, parseAttrs(m[3]));
        push(el);
        if (!VOID_TAGS.has(tag) && !m[4]) stack.push(el);
    }
    return roots;
}

// ---------------------------------------------------------------- 元素

function makeEl(tag, attrs) {
    const el = {
        nodeType: 1,
        tagName: String(tag || 'div').toUpperCase(),
        _attrs: Object.assign({}, attrs),
        _classes: new Set(String(attrs.class || '').split(/\s+/).filter(Boolean)),
        _listeners: Object.create(null),
        _html: '',
        children: [],
        parentNode: null,
        value: '',
        textContent: '',
        hidden: 'hidden' in attrs,
        disabled: false,
        offsetWidth: 0,
        style: {},
        dataset: {}
    };
    el.id = attrs.id || '';

    el.classList = {
        add() { for (const c of arguments) el._classes.add(c); },
        remove() { for (const c of arguments) el._classes.delete(c); },
        contains: (c) => el._classes.has(c),
        toggle(c, force) {
            const on = force === undefined ? !el._classes.has(c) : !!force;
            if (on) el._classes.add(c); else el._classes.delete(c);
            return on;
        }
    };
    Object.defineProperty(el, 'className', {
        get() { return [...el._classes].join(' '); },
        set(v) { el._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
    });
    // children 是原地改的数组，这几个 getter 跟着实时变
    Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
    Object.defineProperty(el, 'lastChild', { get() { return el.children[el.children.length - 1] || null; } });
    Object.defineProperty(el, 'childNodes', { get() { return el.children; } });
    Object.defineProperty(el, 'nodeName', { get() { return el.tagName; } });
    Object.defineProperty(el, 'textContent', {
        // 必须从子孙的文字节点求和 —— 渲染出来的行是靠这个判内容的
        get() {
            let s = '';
            (function walk(list) {
                for (const n of list) {
                    if (n.nodeType === 3) s += n.nodeValue;
                    else walk(n.children);
                }
            })(el.children);
            return s;
        },
        set(v) {
            for (const c of el.children) c.parentNode = null;
            el.children.length = 0;
            el.children.push({
                nodeType: 3, nodeValue: String(v == null ? '' : v),
                children: [], parentNode: el
            });
        }
    });
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._html; },
        set(v) {
            el._html = String(v == null ? '' : v);
            for (const c of el.children) c.parentNode = null;
            el.children.length = 0;
            for (const node of parseHTML(el._html)) {
                el.children.push(node);
                node.parentNode = el;
            }
        }
    });

    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
    el.setAttribute = (k, v) => { el._attrs[k] = String(v); if (k === 'id') el.id = String(v); };
    el.removeAttribute = (k) => { delete el._attrs[k]; };
    el.hasAttribute = (k) => k in el._attrs;

    el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
    el.removeEventListener = (t, fn) => {
        const a = el._listeners[t] || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
    };

    /** 派发事件并向上冒泡（真实 DOM 会冒泡，不冒泡的话委托绑定全失效） */
    el.dispatch = function (type, extra) {
        const ev = Object.assign({ type }, extra || {});
        ev.type = type;
        ev.target = el;
        ev.preventDefault = () => { ev.defaultPrevented = true; };
        ev.stopPropagation = () => { ev._stopped = true; };
        let n = el;
        while (n && !ev._stopped) {
            (n._listeners[type] || []).slice().forEach((fn) => fn(ev));
            n = n.parentNode;
        }
        return ev;
    };

    el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
    el.removeChild = (c) => {
        const i = el.children.indexOf(c);
        if (i >= 0) el.children.splice(i, 1);
        c.parentNode = null;
        return c;
    };
    el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
    el.focus = () => {};
    el.blur = () => {};
    el.scrollIntoView = () => {};
    el.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0 });
    el.closest = (sel) => {
        let n = el;
        while (n && n.nodeType === 1) {
            if (matchesChain(n, splitSelector(sel))) return n;
            n = n.parentNode;
        }
        return null;
    };
    el.querySelector = (sel) => queryAll(el, sel)[0] || null;
    el.querySelectorAll = (sel) => queryAll(el, sel);
    return el;
}

// ---------------------------------------------------------------- 选择器

function parseSimple(sel) {
    let s = String(sel).trim();
    const spec = { tag: null, id: null, classes: [], attrs: [] };
    const mTag = /^([a-zA-Z][\w-]*)/.exec(s);
    if (mTag) { spec.tag = mTag[1].toLowerCase(); s = s.slice(mTag[1].length); }
    const re = /#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(s))) {
        if (m[1]) spec.id = m[1];
        else if (m[2]) spec.classes.push(m[2]);
        else {
            const a = /^([\w-]+)(?:=["']?([^\]"']*)["']?)?$/.exec(m[3]);
            if (a) spec.attrs.push([a[1], a[2]]);
        }
    }
    return spec;
}

function matchesSimple(el, sel) {
    if (!el || el.nodeType !== 1) return false;
    const spec = parseSimple(sel);
    if (spec.tag && el.tagName !== spec.tag.toUpperCase()) return false;
    if (spec.id && el.id !== spec.id) return false;
    for (const c of spec.classes) if (!el._classes.has(c)) return false;
    for (const [k, v] of spec.attrs) {
        if (!(k in el._attrs)) return false;
        if (v !== undefined && String(el._attrs[k]) !== v) return false;
    }
    return true;
}

function matchesChain(el, parts) {
    if (!matchesSimple(el, parts[parts.length - 1])) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
        let found = false;
        while (node && node.nodeType === 1) {
            if (matchesSimple(node, parts[i])) { found = true; node = node.parentNode; break; }
            node = node.parentNode;
        }
        if (!found) return false;
    }
    return true;
}

const splitSelector = (sel) => String(sel).trim().split(/\s+/).filter(Boolean);

function collectFrom(list) {
    const out = [];
    (function walk(nodes) {
        for (const n of nodes) {
            if (n.nodeType === 1) { out.push(n); walk(n.children); }
        }
    })(list);
    return out;
}

function queryAll(root, sel) {
    const parts = splitSelector(sel);
    if (!parts.length) return [];
    // 文档用它自己的根数组，元素用它的 children
    const pool = root === doc ? collectFrom(doc._roots) : collectFrom(root.children);
    return pool.filter((el) => matchesChain(el, parts));
}

// ---------------------------------------------------------------- 文档

let doc;

function buildDocument() {
    const roots = parseHTML(HTML_SRC);
    const find = (tag) => {
        let hit = null;
        (function walk(list) {
            for (const n of list) {
                if (n.nodeType !== 1) continue;
                if (n.tagName === tag && !hit) hit = n;
                walk(n.children);
            }
        })(roots);
        return hit;
    };
    const d = {
        _roots: roots,
        _listeners: Object.create(null),
        body: find('BODY') || makeEl('body', {}),
        documentElement: find('HTML') || makeEl('html', {}),
        addEventListener(t, fn) { (d._listeners[t] = d._listeners[t] || []).push(fn); },
        removeEventListener() {},
        dispatch(t) { (d._listeners[t] || []).slice().forEach((fn) => fn({ type: t })); },
        getElementById: (id) => collectFrom(d._roots).find((el) => el.id === id) || null,
        createElement: (tag) => makeEl(tag, {}),
        querySelector(sel) { return queryAll(d, sel)[0] || null; },
        querySelectorAll(sel) { return queryAll(d, sel); },
        execCommand: () => true
    };
    return d;
}

// ---------------------------------------------------------------- 启动一份 app

function makeStorage() {
    const mem = new Map();
    return {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
        clear: () => mem.clear()
    };
}

/**
 * Node 18+ 自带只读的 navigator / performance 等全局，直接赋值会抛
 * "Cannot set property ... which has only a getter"，只能 defineProperty 覆盖。
 */
function setGlobal(k, v) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}

/**
 * app.js 的页脚吉祥物会 setTimeout(12.5s) 再 setInterval(25s) 换图。
 * 不清掉测试进程永远不退出。这里把 app.js 建的所有定时器登记下来，
 * 结束时统一清 —— 不用 unref（undici 内部对 unref 过的东西会炸 deref）。
 * 原始实现必须先抓在手里，覆盖版里再调同名函数就是自己调自己。
 */
const liveTimers = new Set();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

function bootApp(baseUrl, opts = {}) {
    doc = buildDocument();
    // app.js 现在用相对路径 + document.baseURI 拼邀请链接（子路径部署要靠它），
    // 垫片里得补上，否则 new URL('./?code=1', undefined) 会抛 Invalid URL。
    doc.baseURI = baseUrl + '/';

    const win = {
        DSH: {
            config: require('../shared/config.js'),
            periods: require('../shared/periods.js'),
            ics: require('../shared/ics.js'),
            weeks: require('../shared/weeks.js'),
            compare: require('../shared/compare.js')
        },
        _l: Object.create(null),
        matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
        addEventListener(t, fn) { (win._l[t] = win._l[t] || []).push(fn); },
        removeEventListener() {},
        dispatch(t, extra) {
            (win._l[t] || []).slice().forEach((fn) => fn(Object.assign({ type: t }, extra || {})));
        },
        scrollTo() {}
    };

    const storage = makeStorage();
    if (opts.token) storage.setItem('dsh_token', opts.token);

    const hist = {
        _stack: [{ dsh: 'auth', d: 0 }],
        // 垫片只实现 app.js 真正用到的那部分，这里补两样：
        //   · state：app.js 清邀请码那步会把 history.state 原样传回去（导航栈在里面）
        //   · 第三个参数（新地址）：不记下来的话，「地址栏擦干净了没有」在测试里根本看不到
        state: null,
        lastUrl: null,
        pushState(s, _title, url) {
            hist._stack.push(s);
            hist.state = s;
            if (url != null) hist.applyUrl(url);
        },
        replaceState(s, _title, url) {
            hist._stack[hist._stack.length - 1] = s;
            hist.state = s;
            if (url != null) hist.applyUrl(url);
        },
        applyUrl(url) {
            hist.lastUrl = String(url);
            const u = new URL(String(url), baseUrl + '/');
            loc.pathname = u.pathname;
            loc.search = u.search;
            loc.hash = u.hash;
            loc.href = u.href;
        },
        back() {}
    };
    const locUrl = new URL(baseUrl);
    const loc = {
        search: opts.search || '',
        hash: '',
        href: baseUrl + '/',
        pathname: '/',
        hostname: locUrl.hostname,
        host: locUrl.host,
        origin: locUrl.origin,
        protocol: locUrl.protocol
    };
    const nav = { clipboard: null, userAgent: 'node', language: 'zh-CN' };

    function ImageShim() {
        this.onload = null;
        this.onerror = null;
        this._src = '';
        Object.defineProperty(this, 'src', {
            get() { return this._src; },
            set(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
        });
    }
    function FileReaderShim() {}

    setGlobal('window', win);
    setGlobal('document', doc);
    setGlobal('localStorage', storage);
    setGlobal('history', hist);
    setGlobal('location', loc);
    setGlobal('navigator', nav);
    // performance 不要覆盖：Node 内部的 fetch 会调 performance.markResourceTiming，
    // 换成自己的对象会让它炸掉。Node 自带的 performance.now() 已经够 app.js 用。
    setGlobal('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
    setGlobal('cancelAnimationFrame', () => {});
    setGlobal('Image', ImageShim);
    setGlobal('FileReader', FileReaderShim);
    // app.js 建的所有定时器都登记下来，结束时统一清掉
    setGlobal('setTimeout', (fn, ms) => {
        const t = realSetTimeout(fn, ms);
        liveTimers.add(t);
        return t;
    });
    setGlobal('clearTimeout', (t) => { liveTimers.delete(t); realClearTimeout(t); });
    setGlobal('setInterval', (fn, ms) => {
        const t = realSetInterval(fn, ms);
        liveTimers.add(t);
        return t;
    });
    setGlobal('clearInterval', (t) => { liveTimers.delete(t); realClearInterval(t); });
    // api.js 里的路径是相对的（'api/me'），必须按 document.baseURI 解析；
    // 原来的 baseUrl + url 会拼出 http://127.0.0.1:41234api/me 这种非法地址，
    // 请求全部失败，于是每个用例都停在登录页。
    setGlobal('fetch', (url, init) => globalThis.__realFetch(
        String(url).startsWith('http')
            ? String(url)
            : new URL(String(url), doc.baseURI).href, init));

    // 真实源码，原样跑
    // 二维码库要在 app.js 之前进全局：它是老式脚本，顶层 var 必须落到全局作用域，
    // 严格模式下的 eval 做不到这件事，所以用 runInThisContext。
    vm.runInThisContext(QR_SRC, { filename: 'public/lib/qrcode.js' });
    assert.equal(typeof globalThis.qrcode, 'function', '二维码库没挂到全局');

    // eslint-disable-next-line no-eval
    eval(API_SRC);
    // api.js 挂在 window.API / window.Store 上。浏览器里 window 就是全局对象，
    // 所以 app.js 裸写 API 能解析；垫片里 window 是独立对象，得手动接上。
    setGlobal('API', win.API);
    setGlobal('Store', win.Store);
    // eslint-disable-next-line no-eval
    eval(APP_SRC);

    const api = {
        doc,
        el: (sel) => doc.querySelector(sel),
        all: (sel) => doc.querySelectorAll(sel),
        click(sel) {
            const e = typeof sel === 'string' ? doc.querySelector(sel) : sel;
            assert.ok(e, `找不到要点击的元素：${sel}`);
            e.dispatch('click', {});
        },
        submit(sel) {
            const e = doc.querySelector(sel);
            assert.ok(e, `找不到表单：${sel}`);
            e.dispatch('submit', {});
        },
        activeScreen() {
            const s = doc.querySelectorAll('.screen').find((x) => x._classes.has('active'));
            return s ? s.id.replace(/^screen-/, '') : null;
        },
        title: () => doc.querySelector('#topbar-title').textContent,
        win,
        storage,
        history: hist,
        location: loc
    };
    return api;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询到条件成立为止。
 *
 * 固定 sleep 在 CPU 重的路径上会偶发不够 —— 改密码那条路要跑三次 scrypt
 * （验旧密码 / 算新哈希 / 拿新密码重新登录），几百毫秒起步，机器一忙就超。
 * 「等一下再看」永远不如「等到真的变了」稳。
 */
async function until(fn, timeoutMs = 4000, stepMs = 25) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (fn()) return true;
        if (Date.now() > deadline) return false;
        await tick(stepMs);
    }
}

/** 起一份 app 并等它启动完 */
async function started(baseUrl, opts) {
    const a = bootApp(baseUrl, opts);
    a.doc.dispatch('DOMContentLoaded');
    await tick(220);
    return a;
}

// ---------------------------------------------------------------- 服务器

let server;
let base;

before(async () => {
    globalThis.__realFetch = globalThis.fetch;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-screens-'));
    server = await createServer({ vault: false, captcha: false,
        dataDir, port: 0, skipCleanup: true,
        limits: {
            registerBurst: { windowMs: 60000, max: 1000, message: 'x' },
            register: { windowMs: 3600000, max: 1000, message: 'x' },
            join: { windowMs: 60000, max: 1000, message: 'x' },
            loginFail: { windowMs: 600000, max: 1000, message: 'x' }
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((r) => server.close(r));
    // 把 app.js 留下的定时器全清掉，否则进程不退出
    purgeTimers();
});

/**
 * 每个用例结束后把 app.js 建的定时器全清掉。
 *
 * 不清的话，页脚吉祥物那个 setTimeout(12.5s) 会在十几个用例之后才触发，
 * 那会儿 globalThis 上挂的已经是另一个用例的 document 了 —— 节点跑飞，
 * node:test 判成「测试结束后还产生了异步活动」（undici 内部炸 deref）。
 * 用例之间必须互不残留。
 */
function purgeTimers() {
    for (const t of liveTimers) { realClearTimeout(t); realClearInterval(t); }
    liveTimers.clear();
}

afterEach(purgeTimers);

let seq = 0;
async function raw(pathname, opts = {}) {
    const headers = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await globalThis.__realFetch(base + pathname, {
        method: opts.method || 'GET', headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const COURSE = {
    course: '大学英语Ⅲ', day: 1, startPeriod: 3, endPeriod: 4,
    startTime: '10:00', endTime: '11:35', location: '紫金港东6-328',
    dates: ['20260914', '20260921']
};

async function user(withCourses = false) {
    seq += 1;
    const nickname = `扫${seq}`;
    const r = await raw('/api/register', { method: 'POST', body: { nickname, password: 'pw123456' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (withCourses) {
        await raw('/api/me/courses', { method: 'PUT', token: r.body.token, body: { courses: [COURSE] } });
    }
    return { id: r.body.userId, nickname, token: r.body.token };
}

// ---------------------------------------------------------------- 垫片自检

test('垫片自检：选择器 / 后代 / 冒泡 / innerHTML 解析', async () => {
    const a = bootApp(base);

    // 断言的是「screen 元素都能被选择器找到」，不写死条数 ——
    // 加一屏就要来改数字，只会让人嫌烦而绕过它。
    const screens = a.all('.screen');
    assert.ok(screens.length >= 6, `index.html 里的 screen 太少：${screens.length}`);
    assert.ok(screens.some((s) => s.id === 'screen-auth'), '缺登录页');
    assert.ok(screens.some((s) => s.id === 'screen-group'), '缺群组页');
    assert.ok(a.el('#auth-nickname'), '按 id 找得到元素');
    assert.equal(a.all('#auth-tabs button').length, 2, '后代选择器');
    assert.equal(a.all('[data-mode]').length >= 2, true, '属性选择器');

    // innerHTML 必须真的解析成子元素，否则渲染出来的按钮绑不上事件
    const box = a.el('#group-members');
    box.innerHTML = '<div class="item" data-member="u1"><div class="title">甲</div>' +
        '<button class="row-note" data-note="u1">备注</button></div>';
    assert.equal(box.querySelectorAll('.item').length, 1, 'innerHTML 的子元素应可查');
    assert.equal(box.querySelectorAll('.item .title').length, 1, '嵌套后代选择器');
    assert.equal(box.querySelectorAll('[data-note="u1"]').length, 1, '带值的属性选择器');
    assert.equal(box.querySelector('.row-note').closest('.item').getAttribute('data-member'), 'u1', 'closest');

    // 冒泡：绑在父节点上的委托必须能收到子节点的点击
    let hit = null;
    box.addEventListener('click', (e) => { hit = e.target.closest('[data-note]'); });
    box.querySelector('.row-note').dispatch('click', {});
    assert.ok(hit, '事件应当冒泡到父节点');
});

// ---------------------------------------------------------------- 屏幕逐个走

test('未登录启动 -> 落在登录页', async () => {
    const a = await started(base);
    assert.equal(a.activeScreen(), 'auth');
    assert.equal(a.title(), '同格');
    assert.equal(a.el('#topbar').hidden, true, '登录页不显示顶栏');
});

test('带令牌启动 -> 直接进首页', async () => {
    const u = await user(true);
    const a = await started(base, { token: u.token });
    assert.equal(a.activeScreen(), 'home');
    assert.equal(a.el('#topbar').hidden, false);
    assert.match(a.el('#home-course-status').textContent, /已上传 1 个时段/);
    assert.equal(a.el('#topbar-who').textContent, u.nickname);
});

test('登录：密码错 -> 表单内红字 + 清空密码框 + 不跳走', async () => {
    const u = await user();
    const a = await started(base);

    a.el('#auth-nickname').value = u.nickname;
    a.el('#auth-password').value = 'cuowumima123';   // 必须够 6 位，否则会被前端本地校验拦下
    a.submit('#auth-form');
    await tick(200);

    const err = a.el('#auth-error');
    assert.equal(err.hidden, false, '错误提示应当显示出来');
    assert.match(err.textContent, /昵称或密码不对/);
    assert.equal(a.el('#auth-password').value, '', '失败后应清空密码框');
    assert.equal(a.el('#auth-password')._classes.has('invalid'), true);
    assert.equal(a.activeScreen(), 'auth', '不该跳到首页');
});

test('登录：成功 -> 进首页，红字清掉，令牌落本地', async () => {
    const u = await user();
    const a = await started(base);

    a.el('#auth-nickname').value = u.nickname;
    a.el('#auth-password').value = 'pw123456';
    a.submit('#auth-form');
    await tick(300);

    assert.equal(a.activeScreen(), 'home');
    assert.equal(a.el('#auth-error').hidden, true);
    assert.ok(a.storage.getItem('dsh_token'), '令牌应写进本地存储');
});

test('注册：切页签 -> 出现确认密码框 -> 注册即进首页', async () => {
    const a = await started(base);

    assert.equal(a.el('#auth-confirm-field').hidden, true);
    a.click('#auth-tabs button[data-mode=register]');
    assert.equal(a.el('#auth-confirm-field').hidden, false, '注册页要有确认密码');
    assert.equal(a.el('#auth-tip').hidden, false, '注册页要出说明');
    assert.match(a.el('#auth-submit').textContent, /注册/);

    seq += 1;
    a.el('#auth-nickname').value = `新${seq}`;
    a.el('#auth-password').value = 'pw123456';
    a.el('#auth-confirm').value = 'pw123456';
    a.submit('#auth-form');
    await tick(300);

    assert.equal(a.activeScreen(), 'home');
    assert.equal(a.el('#admin-entry-card').hidden, true, '普通人看不到管理入口');
    assert.equal(a.el('#btn-admin').hidden, true, '顶栏管理按钮也不该在');
});

test('注册：两次密码不一致 -> 拦在本地，不发请求', async () => {
    const a = await started(base);
    a.click('#auth-tabs button[data-mode=register]');

    a.el('#auth-nickname').value = '不一致的人';
    a.el('#auth-password').value = 'pw123456';
    a.el('#auth-confirm').value = 'pw654321';
    a.submit('#auth-form');
    await tick(120);

    assert.match(a.el('#auth-error').textContent, /两次输入的密码不一样/);
    assert.equal(a.activeScreen(), 'auth');
});

test('首页：五个入口卡片都在，本地比对页能打开', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });

    assert.equal(a.activeScreen(), 'home');
    for (const id of ['#home-groups', '#home-drop', '#btn-create-group', '#btn-join-group',
        '#btn-local']) {
        assert.ok(a.el(id), `首页缺少 ${id}`);
    }

    a.click('#btn-local');
    await tick(150);
    assert.equal(a.activeScreen(), 'local');
    assert.equal(a.title(), '本地快速比对');
});

test('管理入口：普通人没有，管理员有', async () => {
    const plain = await user();
    const a1 = await started(base, { token: plain.token });
    assert.equal(a1.el('#admin-entry-card').hidden, true);
    assert.equal(a1.el('#btn-admin').hidden, true);

    const boss = await user();
    await server.store.setUserAdmin(boss.id, true);
    const a2 = await started(base, { token: boss.token });
    assert.equal(a2.el('#admin-entry-card').hidden, false);
    assert.equal(a2.el('#btn-admin').hidden, false);
});

test('管理页：顶栏按钮进得去，概览/账号/群组/日志都渲染', async () => {
    const boss = await user(true);
    await server.store.setUserAdmin(boss.id, true);
    const a = await started(base, { token: boss.token });

    a.click('#btn-admin');
    await tick(350);

    assert.equal(a.activeScreen(), 'admin');
    assert.equal(a.title(), '管理');
    assert.ok(a.el('#admin-me').textContent.includes(boss.nickname));

    // 统计格子有 6 个，且数字被 countUp 写过
    const stats = a.all('#admin-stats .stat');
    assert.equal(stats.length, 6);
    stats.forEach((s) => assert.match(s.querySelector('b').textContent, /^\d+$/));

    assert.match(a.el('#admin-user-count').textContent, /个/);
    assert.match(a.el('#admin-group-count').textContent, /个/);
    assert.ok(a.all('#admin-users .item').length >= 1, '账号列表应有行');
    assert.ok(a.all('#admin-audit .item').length >= 1, '审计日志应有行');
});

test('管理页：筛选会重建列表，清空后恢复', async () => {
    const boss = await user();
    await server.store.setUserAdmin(boss.id, true);
    const a = await started(base, { token: boss.token });
    a.click('#btn-admin');
    await tick(350);

    const before = a.all('#admin-users .item').length;
    const filter = a.el('#admin-user-filter');

    filter.value = '绝对不存在的昵称xyz';
    filter.dispatch('input', {});
    await tick(60);
    assert.equal(a.all('#admin-users .item').length, 0, '筛不到就应为空');
    assert.equal(a.el('#admin-users')._classes.has('no-anim'), true, '筛选时应关掉入场动画');

    filter.value = '';
    filter.dispatch('input', {});
    await tick(60);
    assert.equal(a.all('#admin-users .item').length, before);
    assert.equal(a.el('#admin-users')._classes.has('no-anim'), false);
});

test('管理页：点「授权」只弹一个确认框（重复绑定回归）', async () => {
    const boss = await user();
    await server.store.setUserAdmin(boss.id, true);
    const target = await user();
    const a = await started(base, { token: boss.token });
    a.click('#btn-admin');
    await tick(350);

    const rows = a.all('#admin-users .item');
    const row = rows.find((r) => r.textContent.includes(target.nickname));
    assert.ok(row, '应能找到目标账号那一行');

    const btn = row.querySelector('[data-grant]');
    assert.ok(btn, '行里应有授权按钮');

    // 数一下容器上有几个 click 监听：委托绑定只该有一份
    const n = (a.el('#admin-users')._listeners.click || []).length;
    assert.equal(n, 1, `#admin-users 上应只有 1 个 click 委托，实际 ${n} 个`);

    a.click(btn);
    await tick(50);
    const modals = a.all('.modal').filter((m) => !m.hidden);
    assert.equal(modals.length, 1, `点一次只该弹一个确认框，实际 ${modals.length} 个`);
});

test('弹窗：打开 -> 关闭有动画 -> 动画后再隐藏', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });

    assert.equal(a.el('#ics-modal').hidden, true);
    a.click('#btn-ics-help');
    assert.equal(a.el('#ics-modal').hidden, false);
    a.click('#ics-modal-close');
    assert.equal(a.el('#ics-modal')._classes.has('closing'), true, '关闭应先播淡出');
    await tick(350);
    assert.equal(a.el('#ics-modal').hidden, true, '动画结束后必须真的隐藏');
    assert.equal(a.el('#ics-modal')._classes.has('closing'), false);
});

test('弹窗：animationend 不来也有超时兜底', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    a.click('#btn-ics-help');

    const modal = a.el('#ics-modal');
    modal._listeners.animationend = [];   // 掐掉动画回调，只留 setTimeout
    a.click('#ics-modal-close');
    await tick(350);
    assert.equal(modal.hidden, true, '兜底超时必须把它关上');
});

test('弹窗：Esc 一把关掉所有', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    a.click('#btn-ics-help');
    assert.equal(a.el('#ics-modal').hidden, false);

    a.win.dispatch('keydown', { key: 'Escape' });
    await tick(350);
    assert.equal(a.el('#ics-modal').hidden, true);
});

test('主题切换：来回切都记得住', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });

    const first = a.doc.documentElement.getAttribute('data-theme');
    assert.ok(first === 'light' || first === 'dark');
    a.click('#btn-theme');
    const second = a.doc.documentElement.getAttribute('data-theme');
    assert.notEqual(first, second);
    assert.equal(a.storage.getItem('dsh_theme'), second, '选过要记住');
    a.click('#btn-theme');
    assert.equal(a.doc.documentElement.getAttribute('data-theme'), first);
});

test('退出登录 -> 回登录页且令牌被清', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    assert.equal(a.activeScreen(), 'home');

    a.click('#btn-logout');
    await tick(250);
    assert.equal(a.activeScreen(), 'auth');
    assert.equal(a.storage.getItem('dsh_token'), null);
});

test('首页群组列表 -> 群组页 -> 比对页，一路点得通', async () => {
    const owner = await user(true);
    const mate = await user(true);
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '扫描群' } });
    assert.equal(g.status, 200);
    await raw(`/api/groups/${g.body.code}/join`, { method: 'POST', token: mate.token, body: {} });

    const a = await started(base, { token: owner.token });
    assert.equal(a.activeScreen(), 'home');

    const items = a.all('#home-groups .item');
    assert.ok(items.length >= 1, '首页应列出刚建的群');

    a.click(items[0]);
    await tick(400);
    assert.equal(a.activeScreen(), 'group');
    assert.equal(a.el('#group-code').textContent, g.body.code);
    assert.equal(a.el('#group-name').firstChild.nodeValue, '扫描群');

    // 成员行渲染出来了，且带 data-member（可点进比对）
    const rows = a.all('#group-members .item[data-member]');
    assert.ok(rows.length >= 1, '群里应有可比的成员行');

    a.click(rows[0]);
    await tick(350);
    assert.equal(a.activeScreen(), 'compare');
    assert.match(a.el('#compare-title').textContent, /↔/);
    assert.match(a.el('#compare-stats').textContent, /第 \d+ 周/);
});

test('群组页：邀请码、二维码、周次胶囊都渲染出来', async () => {
    const owner = await user(true);
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '渲染群' } });
    const a = await started(base, { token: owner.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);

    assert.equal(a.activeScreen(), 'group');
    assert.ok(a.all('#group-weeks button').length >= 1, '周次胶囊应渲染');
    assert.ok(a.el('#group-qr').innerHTML.length > 0, '二维码应渲染出内容');
    assert.match(a.el('#group-url').textContent, /http/);
    assert.equal(a.el('#btn-rename-group').hidden, false, '群主看得见改名');
    assert.equal(a.el('#btn-group-delete').hidden, false, '群主看得见解散');
});

test('顶栏「更多」菜单：点 ⋯ 展开、选完一项收起', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });

    assert.equal(a.el('#more-menu').hidden, true, '默认应当是收起的');
    a.click('#btn-more');
    assert.equal(a.el('#more-menu').hidden, false, '点 ⋯ 应当展开');
    assert.equal(a.el('#btn-more').getAttribute('aria-expanded'), 'true');

    a.click('#btn-theme');                       // 点菜单里的主题那一项
    assert.ok(a.el('#more-menu')._classes.has('closing'), '收起也要先播一段动画，不能瞬变');
    await tick(300);                             // 垫片里没有动画事件，走 220ms 兜底
    assert.equal(a.el('#more-menu').hidden, true, '动画/兜底之后才真的收起');
    assert.equal(a.el('#btn-more').getAttribute('aria-expanded'), 'false');

    // 收起动画还没播完就再点一下，应当重新展开
    a.click('#btn-more');
    a.click('#btn-theme');
    assert.ok(a.el('#more-menu')._classes.has('closing'), '先处于收起中');
    a.click('#btn-more');
    assert.equal(a.el('#more-menu').hidden, false, '收起中来一下就重新展开');
    assert.ok(!a.el('#more-menu')._classes.has('closing'), '重开要把 closing 摘掉');
});

test('移除成员：确认按钮要按两次才真的移除', async () => {
    const owner = await user();
    const mate = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '要移除的群' } });
    await raw(`/api/groups/${g.body.code}/join`, { method: 'POST', token: mate.token, body: {} });

    const a = await started(base, { token: owner.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);

    const removeBtn = a.all('#group-members .row-remove')[0];
    assert.ok(removeBtn, '群主应当看得到移除按钮');
    a.click(removeBtn);
    await tick(50);

    // 注意别用「第一个可见的 .modal」—— 首次打开还会弹「内测提示」，它也是 .modal
    const modal = a.doc.querySelectorAll('.modal')
        .filter((m) => !m.hidden && m.querySelector('[data-x="ok"]'))[0];
    assert.ok(modal, '应当弹出确认框');
    const ok = modal.querySelector('[data-x="ok"]');
    assert.equal(ok.textContent, '确认移除');

    a.click(ok);                                  // 第一下：只是上膛
    await tick(80);
    assert.equal(ok.textContent, '再点一次，真的移除', '第一下之后要换文案，提示还要再点一次');
    assert.ok(!modal._classes.has('closing'), '第一下不该关掉弹窗');
    let detail = await raw(`/api/groups/${g.body.code}`, { token: owner.token });
    assert.ok(detail.body.members.some((m) => m.id === mate.id), '第一下不该真把人移出去');

    a.click(ok);                                  // 第二下：才真的移除
    await tick(250);
    detail = await raw(`/api/groups/${g.body.code}`, { token: owner.token });
    assert.ok(!detail.body.members.some((m) => m.id === mate.id), '第二下才真的移出');
});

test('注销账号：收在「账号」屏里，而且要连着确认两次', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });

    // 首页那张「账号」卡片早就没了
    assert.equal(a.el('#home-account-name'), null, '首页不该再挂着账号卡片');
    // 而且它也不该再挤在「更多」菜单里 —— 那里原来是两个红色挨着，
    // 注销就贴在「退出登录」下面，而退出恰是那个菜单里最常点的一项
    assert.equal(a.el('#more-menu').querySelector('#btn-delete-account'), null,
        '注销不该再挂在更多菜单里');
    assert.equal(a.el('#more-menu').querySelectorAll('.danger').length, 0,
        '更多菜单里不该再有红色项（退出是可逆的，红色留给注销）');
    // 入口改在账号屏
    assert.ok(a.el('#screen-account').querySelector('#btn-delete-account'), '注销入口该在账号屏里');

    // 只认「带指定子元素、且不在关闭动画里」的弹窗：
    //   · 首次打开还有一张内测提示，它也是 .modal
    //   · dismiss() 是播完动画才把弹窗摘掉，不等它走完就会选中上一张
    const pick = (sel) => a.doc.querySelectorAll('.modal')
        .filter((m) => !m.hidden && !m._classes.has('closing') && m.querySelector(sel))[0];

    // 从更多菜单进账号屏，再点注销
    a.click('#btn-more');
    a.click('#btn-account');
    await tick(50);
    assert.equal(a.activeScreen(), 'account');
    assert.match(a.el('#account-nickname').textContent, new RegExp(u.nickname), '要显示当前昵称');

    // 第一道提醒：取消之后什么也不该发生
    a.click('#btn-delete-account');
    await tick(50);
    const first = pick('[data-x="cancel"]');
    assert.ok(first, '第一道提醒应当弹出来');
    a.click(first.querySelector('[data-x="cancel"]'));
    await tick(50);
    assert.equal((await raw('/api/me', { token: u.token })).status, 200, '取消之后账号还在');

    // 两道都走完：先「我明白」，再输密码
    a.click('#btn-delete-account');
    await tick(50);
    const warn = pick('[data-x="ok"]');
    assert.ok(warn, '第一道提醒');
    a.click(warn.querySelector('[data-x="ok"]'));
    await tick(50);

    const pwBox = pick('input');
    assert.ok(pwBox, '第二道提醒要输密码');
    const input = pwBox.querySelector('input');
    assert.equal(input.type, 'password', '第二道要的是密码，不是随便一句确认');
    input.value = 'pw123456';
    a.click(pwBox.querySelector('[data-x="ok"]'));
    await tick(250);

    assert.equal((await raw('/api/me', { token: u.token })).status, 401, '两次确认之后账号才真的没了');
});

// ---------------------------------------------------------------- 账号屏与改密码

test('账号屏：菜单里进得去，返回手势回得来', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });

    a.click('#btn-more');
    a.click('#btn-account');
    await tick(50);
    assert.equal(a.activeScreen(), 'account');
    assert.equal(a.title(), '账号');

    // 返回手势：还原这一屏，而不是把人顶出网页
    a.win.dispatch('popstate', { state: { dsh: 'home', d: 0 } });
    await tick(80);
    assert.equal(a.activeScreen(), 'home');
});

test('改密码：成功后这台设备不掉线，其他会话全失效', async () => {
    const u = await user();
    // 另开一个「别的设备」的会话，用来验证它确实被踢掉
    const other = await raw('/api/login', { method: 'POST', body: { nickname: u.nickname, password: 'pw123456' } });
    assert.equal(other.status, 200);

    const a = await started(base, { token: u.token });
    a.click('#btn-more');
    a.click('#btn-account');
    await tick(50);
    a.click('#btn-change-password');
    await tick(50);

    const box = a.doc.querySelectorAll('.modal')
        .filter((m) => !m.hidden && !m._classes.has('closing') && m.querySelector('[data-k="old"]'))[0];
    assert.ok(box, '应当弹出改密码的框');
    box.querySelector('[data-k="old"]').value = 'pw123456';
    box.querySelector('[data-k="new"]').value = 'pw654321';
    box.querySelector('[data-k="again"]').value = 'pw654321';

    const before = a.storage.getItem('dsh_token');
    a.click(box.querySelector('[data-x="ok"]'));
    // 这条路上要跑三次 scrypt，等令牌真的被换掉，别拿固定 sleep 赌
    assert.ok(await until(() => a.storage.getItem('dsh_token') !== before),
        '没等到自动重登换上新的令牌');
    assert.match(a.el('#toast').textContent, /其他设备/, '要说清其他设备的登录已经失效');

    // 这台设备：令牌已经换成新的了，继续能用
    assert.equal((await raw('/api/me', { token: a.storage.getItem('dsh_token') })).status, 200,
        '改完密码这台设备该被自动登回来，而不是被扔到登录页');
    assert.equal(a.activeScreen(), 'account', '不该被踢回登录页');

    // 别的设备：旧令牌失效
    assert.equal((await raw('/api/me', { token: other.body.token })).status, 401, '其他会话必须失效');

    // 新旧密码：新的能登、旧的不能
    assert.equal((await raw('/api/login', { method: 'POST', body: { nickname: u.nickname, password: 'pw654321' } })).status, 200);
    assert.equal((await raw('/api/login', { method: 'POST', body: { nickname: u.nickname, password: 'pw123456' } })).status, 401);
});

test('改密码：本地先拦掉太短 / 两次不一致 / 和旧的一样，一个请求都不发', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    a.click('#btn-more');
    a.click('#btn-account');
    await tick(50);

    const openBox = async () => {
        a.click('#btn-change-password');
        await tick(50);
        return a.doc.querySelectorAll('.modal')
            .filter((m) => !m.hidden && !m._classes.has('closing') && m.querySelector('[data-k="old"]'))[0];
    };
    const fill = (box, o, n, again) => {
        box.querySelector('[data-k="old"]').value = o;
        box.querySelector('[data-k="new"]').value = n;
        box.querySelector('[data-k="again"]').value = again;
    };
    const isOpen = (box) => !box._classes.has('closing') && !!box.parentNode;

    // 新密码太短
    let box = await openBox();
    fill(box, 'pw123456', '12345', '12345');
    a.click(box.querySelector('[data-x="ok"]'));
    await tick(50);
    assert.equal(isOpen(box), true, '太短时不该关掉弹窗');
    assert.match(box.querySelector('.pw-err').textContent, /6 位/);

    // 两次不一致
    fill(box, 'pw123456', 'pw654321', 'pw654322');
    a.click(box.querySelector('[data-x="ok"]'));
    await tick(50);
    assert.match(box.querySelector('.pw-err').textContent, /不一样/);

    // 和旧的一样
    fill(box, 'pw123456', 'pw123456', 'pw123456');
    a.click(box.querySelector('[data-x="ok"]'));
    await tick(50);
    assert.match(box.querySelector('.pw-err').textContent, /不能和现在/);

    // 一路被拦，旧密码必须还有效（说明一个请求都没发出去）
    assert.equal((await raw('/api/login', { method: 'POST', body: { nickname: u.nickname, password: 'pw123456' } })).status, 200);

    // 取消也一样：什么都不发生
    a.click(box.querySelector('[data-x="cancel"]'));
    await tick(50);
    assert.equal((await raw('/api/me', { token: u.token })).status, 200);

    // 监听只该绑一份（这套测试里的老回归项）
    assert.equal((a.el('#btn-change-password')._listeners.click || []).length, 1);
});

test('改密码：旧密码不对时明确报错，账号密码都不变', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    a.click('#btn-more');
    a.click('#btn-account');
    await tick(50);
    a.click('#btn-change-password');
    await tick(50);

    const box = a.doc.querySelectorAll('.modal')
        .filter((m) => !m.hidden && !m._classes.has('closing') && m.querySelector('[data-k="old"]'))[0];
    box.querySelector('[data-k="old"]').value = 'cuowumima';
    box.querySelector('[data-k="new"]').value = 'pw654321';
    box.querySelector('[data-k="again"]').value = 'pw654321';
    a.click(box.querySelector('[data-x="ok"]'));
    // 等到失败真的回来了再断言 —— 否则「什么都没发生」和「还没发生」看起来一模一样
    assert.ok(await until(() => /原密码/.test(a.el('#toast').textContent)),
        `没等到报错，toast 现在是：${a.el('#toast').textContent}`);

    // 旧密码没错：两个都还能用，本机也没掉线
    assert.equal((await raw('/api/login', { method: 'POST', body: { nickname: u.nickname, password: 'pw123456' } })).status, 200,
        '旧密码没被改掉');
    assert.equal((await raw('/api/me', { token: u.token })).status, 200, '本机会话还在');
});


test('群组页：群主看不到「退群」，成员看得到；解散只有群主有', async () => {
    const owner = await user();
    const mate = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '退群可见性' } });
    await raw(`/api/groups/${g.body.code}/join`, { method: 'POST', token: mate.token, body: {} });

    const a1 = await started(base, { token: owner.token });
    a1.click(a1.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a1.el('#btn-group-leave').hidden, true, '群主看不到退群（服务端也拒，别让他点了吃报错）');
    assert.equal(a1.el('#btn-group-delete').hidden, false, '群主看得到解散');

    const a2 = await started(base, { token: mate.token });
    a2.click(a2.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a2.el('#btn-group-leave').hidden, false, '成员看得到退群');
    assert.equal(a2.el('#btn-group-delete').hidden, true, '成员看不到解散');
});

// ---------------------------------------------------------------- 群主转让

/**
 * 只认「带指定子元素、且不在关闭动画里」的弹窗。
 * dismiss() 是播完动画才把弹窗摘掉（220ms），不等它走完就会选中上一张；
 * 动态弹窗叠在一起时这一条是必须的。
 */
function modalWith(a, sel) {
    return a.doc.querySelectorAll('.modal')
        .filter((m) => !m.hidden && !m._classes.has('closing') && m.querySelector(sel))[0];
}

test('转让群主：按钮只在「群主且群里有别人」时出现', async () => {
    const owner = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '转让可见性' } });

    // 群里只有自己：没人可转，藏掉（留一颗点了必然报错的按钮等于设陷阱）
    const a1 = await started(base, { token: owner.token });
    a1.click(a1.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a1.el('#btn-transfer-group').hidden, true, '群里没别人时不该有这颗按钮');
    assert.equal(a1.el('#btn-rename-group').hidden, false, '改名还在（对照）');

    // 来了一个人：出现
    const mate = await user();
    await raw(`/api/groups/${g.body.code}/join`, { method: 'POST', token: mate.token, body: {} });
    const a2 = await started(base, { token: owner.token });
    a2.click(a2.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a2.el('#btn-transfer-group').hidden, false, '有别人可转时应当出现');

    // 普通成员：没有入口
    const a3 = await started(base, { token: mate.token });
    a3.click(a3.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a3.el('#btn-transfer-group').hidden, true, '成员没有转让入口');
});

test('转让群主：选人 -> 输密码 -> 界面立刻变成普通成员', async () => {
    const owner = await user();
    const mate = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '转让流程群' } });
    await raw(`/api/groups/${g.body.code}/join`, { method: 'POST', token: mate.token, body: {} });

    const a = await started(base, { token: owner.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a.el('#btn-transfer-group').hidden, false);

    // 第一步：选人
    a.click('#btn-transfer-group');
    await tick(50);
    const chooser = modalWith(a, '[data-pick]');
    assert.ok(chooser, '应当弹出选人框');
    const rows = chooser.querySelectorAll('[data-pick]');
    assert.equal(rows.length, 1, '只有一位候选人（自己不在候选里）');
    assert.match(chooser.textContent, new RegExp(mate.nickname), '候选人要写清楚是谁');
    assert.match(chooser.textContent, /加入于/, '带上入群时间，交接时这是选人的依据');
    a.click(rows[0]);
    await tick(50);

    // 第二步：输密码。这里没有第三层确认，密码本身就是那道闸
    const pwBox = modalWith(a, 'input');
    assert.ok(pwBox, '选完人要输密码');
    const input = pwBox.querySelector('input');
    assert.equal(input.type, 'password', '这一步要的是密码');
    assert.match(pwBox.textContent, /会变成普通成员/, '要说清权限会没');
    assert.match(pwBox.textContent, /永久码/, '要说清永久码易主');
    input.value = 'pw123456';
    a.click(pwBox.querySelector('[data-x="ok"]'));
    await tick(400);

    // 服务端真的换了群主
    const detail = await raw(`/api/groups/${g.body.code}`, { token: mate.token });
    assert.equal(detail.body.creatorId, mate.id, '新群主应当接手');

    // 界面整个翻过来，靠的全是 isCreator
    assert.equal(a.el('#btn-rename-group').hidden, true, '改名没了');
    assert.equal(a.el('#btn-transfer-group').hidden, true, '转让没了');
    assert.equal(a.el('#btn-group-delete').hidden, true, '解散没了');
    assert.equal(a.el('#group-settings-card').hidden, true, '群组设置没了');
    assert.equal(a.el('#btn-manage-invites').hidden, true, '邀请管理没了');
    assert.equal(a.el('#btn-group-leave').hidden, false, '退群出现了 —— 交完班想走随时能走');
});

test('转让群主：选人框取消 / 密码框取消，都不发请求', async () => {
    const owner = await user();
    const mate = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '转让取消群' } });
    await raw(`/api/groups/${g.body.code}/join`, { method: 'POST', token: mate.token, body: {} });

    const a = await started(base, { token: owner.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);

    const creatorId = async () =>
        (await raw(`/api/groups/${g.body.code}`, { token: owner.token })).body.creatorId;

    // 选人框上取消
    a.click('#btn-transfer-group');
    await tick(50);
    a.click(modalWith(a, '[data-x="cancel"]').querySelector('[data-x="cancel"]'));
    await tick(300);
    assert.equal(await creatorId(), owner.id, '取消选人后群主不变');

    // 选了人，但在密码那一步取消
    a.click('#btn-transfer-group');
    await tick(50);
    a.click(modalWith(a, '[data-pick]').querySelectorAll('[data-pick]')[0]);
    await tick(50);
    a.click(modalWith(a, 'input').querySelector('[data-x="cancel"]'));
    await tick(300);
    assert.equal(await creatorId(), owner.id, '密码那步取消也不发请求');
    assert.equal(a.el('#btn-transfer-group').hidden, false, '界面上也还是群主');
});

test('分享：菜单里那一项会把站点地址复制出来（垫片里没有系统分享面板）', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });

    let copied = null;
    globalThis.navigator.clipboard = {
        writeText: (t) => { copied = t; return Promise.resolve(); }
    };
    a.click('#btn-share');
    await tick(50);

    assert.ok(copied, '应当复制出内容');
    assert.match(copied, /与一个或一群有趣的人同行/, '要带上那句初衷');
    assert.match(copied, /传上课表|哪几节课/, '要带上功能描述 —— 光有链接没人知道点开干嘛');
    assert.ok(copied.includes(base), `要带上本站地址：${copied}`);
    assert.ok(!copied.includes('code='), '分享站点首页，不该把当前屏的邀请码带出去');
});

test('求 Star 的入口：顶栏第一次出现时是展开的', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    assert.ok(a.el('#btn-star').classList.contains('open'), '顶栏出现时应当展开说明');
    // 「10 秒后收起」没在这里等：等 10 秒会让整个套件变慢，而那句 setTimeout 很直白
});

test('群组页：复制链接会把群名一起带上', async () => {
    const owner = await user();
    await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '信工饭饭' } });

    const a = await started(base, { token: owner.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);

    // 垫片里没有 clipboard，挂一个假的把复制内容截下来
    let copied = null;
    globalThis.navigator.clipboard = {
        writeText: (t) => { copied = t; return Promise.resolve(); }
    };
    a.click('#btn-copy-link');
    await tick(50);

    assert.ok(copied, '应当复制了内容');
    assert.match(copied, /「信工饭饭」邀请你加入/, '分享文案里要带上群名');
    assert.match(copied, /邀请码：/, '要带上邀请码');
    assert.ok(
        copied.split('\n').some((l) => l.startsWith('（')),
        '要带一句「这是干嘛的」说明，不然收到的人不知道点开做什么'
    );

    const urlLine = copied.split('\n').find((l) => /^https?:\/\//.test(l));
    assert.ok(urlLine, '要带上链接');
    assert.ok(!urlLine.includes('name='), '群名只进文案，不进 URL（否则二维码会变密）');
});

test('邀请链接管理页：能进、能看到列表、非群主进不去', async () => {
    const owner = await user(true);
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '邀请管理群' } });
    // 发两条：一条永久、一条 1 天
    await raw(`/api/groups/${g.body.code}/invites`, {
        method: 'POST', token: owner.token, body: { ttl: 'never', label: '常驻' }
    });
    await raw(`/api/groups/${g.body.code}/invites`, {
        method: 'POST', token: owner.token, body: { ttl: '1d' }
    });

    const a = await started(base, { token: owner.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a.activeScreen(), 'group');
    assert.equal(a.el('#btn-manage-invites').hidden, false, '群主看得见管理入口');

    a.click('#btn-manage-invites');
    await tick(250);
    assert.equal(a.activeScreen(), 'invites');
    assert.equal(a.title(), '邀请链接');

    // 两条都渲染出来，且都带勾选框（只列有效的，才能多选管理）
    assert.equal(a.all('#inv-active-list .item').length, 2, '两条有效链接都应列出');
    assert.equal(a.all('#inv-active-list [data-pick]').length, 2, '每条都该有勾选框');
    // 永久那条显示「永久有效」，1 天那条显示剩余时间
    const texts = a.all('#inv-active-list .sub').map((x) => x.textContent).join(' | ');
    assert.match(texts, /永久有效/);
    assert.match(texts, /还剩/);
    // 有两条以上才出现批量作废栏
    assert.equal(a.el('#inv-bulk-bar').hidden, false, '多条时应出现批量操作');

    // 勾一条 -> 按钮文案跟着变（这是「仅对有效的进行管理」的落点）
    const box = a.el('#inv-active-list [data-pick]');
    box.checked = true;
    box.dispatch('change', {});
    assert.match(a.el('#btn-inv-revoke-selected').textContent, /1 条/);

    // 全选 -> 两条都勾上
    a.click('#btn-inv-selectall');
    assert.equal(a.all('#inv-active-list [data-pick]').filter((p) => p.checked).length, 2);
    // 再点一次 = 取消全选
    a.click('#btn-inv-selectall');
    assert.equal(a.all('#inv-active-list [data-pick]').filter((p) => p.checked).length, 0);
});

test('邀请链接管理页：成员没有入口，也拿不到管理页', async () => {
    const owner = await user(true);
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '成员不许管' } });
    const mate = await user(true);
    await raw(`/api/groups/${g.body.code}/join`, { method: 'POST', token: mate.token });

    const a = await started(base, { token: mate.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a.el('#btn-manage-invites').hidden, true, '成员看不见管理入口');
});

test('历史返回：popstate 能还原各个屏幕', async () => {
    const u = await user(true);
    await server.store.setUserAdmin(u.id, true);   // 管理页要管理员才进得去
    const a = await started(base, { token: u.token });
    assert.equal(a.activeScreen(), 'home');

    a.click('#btn-admin');
    await tick(350);
    assert.equal(a.activeScreen(), 'admin');

    a.win.dispatch('popstate', { state: { dsh: 'home', d: 0 } });
    await tick(250);
    assert.equal(a.activeScreen(), 'home');

    a.win.dispatch('popstate', { state: { dsh: 'local', d: 1 } });
    await tick(150);
    assert.equal(a.activeScreen(), 'local');

    a.win.dispatch('popstate', { state: { dsh: 'auth', d: 0 } });
    await tick(150);
    assert.equal(a.activeScreen(), 'auth');
});

test('历史返回：state.group 没了就安全退回首页，不卡死', async () => {
    const u = await user(true);
    const a = await started(base, { token: u.token });
    a.win.dispatch('popstate', { state: { dsh: 'group', d: 1 } });
    await tick(250);
    assert.equal(a.activeScreen(), 'home', '没群可还原时应退回首页');
});

test('会话失效：令牌无效时被送回登录页并清掉令牌', async () => {
    const a = await started(base, { token: 'garbage-token-not-in-store' });
    assert.equal(a.activeScreen(), 'auth', '无效令牌应落在登录页');
    assert.equal(a.storage.getItem('dsh_token'), null, '失效令牌要从本地清掉');
});

test('会话失效：用着用着被吊销，也会自愈回登录页', async () => {
    const u = await user(true);
    await server.store.setUserAdmin(u.id, true);
    const a = await started(base, { token: u.token });
    assert.equal(a.activeScreen(), 'home');

    // 服务端把这个会话吊销，浏览器这边毫不知情
    await raw('/api/logout', { method: 'POST', token: u.token });
    a.click('#btn-admin');
    await tick(600);   // 先撞一次 401，再拉一次首页数据再撞一次，最后落到登录页

    assert.equal(a.activeScreen(), 'auth', '令牌失效后最终必须回到登录页');
    assert.equal(a.storage.getItem('dsh_token'), null);
});

test('页脚吉祥物：左右各挂一张，且没有报错', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    await tick(80);

    const left = a.el('#foot-mascot-left');
    const right = a.el('#foot-mascot-right');
    assert.ok(left && right, '页脚左右两个坑都要在');
    // 若 src 已经设上，就必须是真实存在的图
    for (const el of [left, right]) {
        if (el.src) assert.match(el.src, /^img\/mascot\/[a-z-]+\.gif$/);
    }
});

test('页脚版本号：服务端给什么就显示什么（连登录页都看得到）', async () => {
    const pkg = JSON.parse(read('package.json'));
    // 特意不登录：这行字在登录页也该有，否则「线上是哪一版」只在登录后能看到
    const a = await started(base);
    await tick(80);

    const el = a.el('#foot-ver');
    assert.ok(el, '页脚要留出 #foot-ver 这个坑');
    assert.equal(el.hidden, false, '拿到版本号之后要显示出来');
    // 版本号来自服务端读的那份 package.json —— 页面里写死的那个字符串不算数
    assert.match(el.textContent, new RegExp('^v' + pkg.version.replace(/\./g, '\\.')));
});

// ---------------------------------------------------------------- 邀请码与地址栏

test('邀请链接：进群之后地址栏里的码要擦掉，别每次加载都重新进一次群', async () => {
    const owner = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '擦码群' } });
    const code = g.body.code;
    const mate = await user();

    // 带着同学发来的链接进来（后面还缀着别人的参数）
    const a = await started(base, { token: mate.token, search: `?code=${code}&from=wechat` });
    await tick(350);

    assert.equal((await raw(`/api/groups/${code}`, { token: mate.token })).status, 200, '应当已经进群');
    assert.ok(a.history.lastUrl, '应当 replaceState 过一次，把地址栏改掉');
    assert.equal(a.history.lastUrl.includes('code='), false, '码不该还挂在地址栏上');
    assert.match(a.history.lastUrl, /from=wechat/, '不该顺手把别人的参数一起删掉');
    assert.equal(a.history.state.dsh, 'group', '导航状态要留着，否则返回手势会失效');
    assert.equal(a.location.search, '?from=wechat', '垫片里的 location 也要跟着更新');
});

test('邀请链接：还没登录时码不能丢，登录之后才擦', async () => {
    const owner = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '登录后进群' } });
    const code = g.body.code;
    const mate = await user();       // 已经注册好了，只是这次先不登录

    // 没令牌 + 带码进来：停在登录页
    const a = await started(base, { search: `?code=${code}` });
    await tick(250);
    assert.equal(a.activeScreen(), 'auth');
    assert.equal(a.history.lastUrl, null,
        '还没进群，码必须留在地址栏 —— 新用户在登录页刷新一下不能把它弄丢');

    // 用界面登录：登录成功后会自动拿地址里的码去进群
    a.el('#auth-nickname').value = mate.nickname;
    a.el('#auth-password').value = 'pw123456';
    a.submit('#auth-form');
    await tick(500);

    assert.equal((await raw(`/api/groups/${code}`, { token: mate.token })).status, 200, '登录后应当进群了');
    assert.ok(a.history.lastUrl, '这时候才该擦');
    assert.equal(a.history.lastUrl.includes('code='), false);
});

test('邀请链接：链接已经作废时也要擦掉，不然每次刷新都重弹一遍红字', async () => {
    const owner = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '死链群' } });
    const code = g.body.code;
    const inv = await raw(`/api/groups/${code}/invites`, {
        method: 'POST', token: owner.token, body: { ttl: 'never' }
    });
    // 群主把它作废掉 —— 之后这个码永远不会再成功
    await raw(`/api/groups/${code}/invites/${inv.body.invite.code}`, {
        method: 'DELETE', token: owner.token, body: {}
    });
    const late = await user();

    const a = await started(base, { token: late.token, search: `?code=${inv.body.invite.code}` });
    await tick(350);

    assert.equal((await raw(`/api/groups/${code}`, { token: late.token })).status, 403, '作废的码进不去');
    assert.equal(a.history.lastUrl.includes('code='), false,
        '死码留着只会每次刷新都重弹一遍红字，而它永远不会再成功');
});

test('邀请链接：没有码的正常启动不该去动历史记录', async () => {
    const u = await user();
    const a = await started(base, { token: u.token });
    await tick(250);

    assert.equal(a.history.lastUrl, null, '本来就没有码，别白 replaceState 一次');
});

// ---------------------------------------------------------------- 成员分享开关

test('成员分享开关：关掉后成员侧看不到码，首页那张卡片也不印', async () => {
    const owner = await user();
    const mate = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '分享开关群' } });
    const code = g.body.code;
    await raw(`/api/groups/${code}/join`, { method: 'POST', token: mate.token, body: {} });
    // 群主发一枚邀请码：成员侧那张卡片得先有东西可展示，
    // 才有「关掉之后变成什么」可言（成员看不到码时卡片本来就是空的）
    await raw(`/api/groups/${code}/invites`, { method: 'POST', token: owner.token, body: { ttl: 'never' } });

    // 默认（开关没动过）：成员在首页和群组页都看得到码 —— 这是上线前的行为，不该改
    const a1 = await started(base, { token: mate.token });
    assert.match(a1.all('#home-groups .item')[0].textContent, new RegExp(code), '默认成员看得到邀请码');
    a1.click(a1.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a1.el('#invite-share-box').hidden, false, '默认展示的是码那一块');
    assert.equal(a1.el('#invite-closed').hidden, true);
    assert.equal(a1.el('#btn-copy-code').disabled, false, '默认分享按钮可用');

    // 群主关掉
    assert.equal((await raw(`/api/groups/${code}/settings`, {
        method: 'PUT', token: owner.token, body: { memberShare: false }
    })).status, 200);

    // 成员：群组页的邀请卡换成说明，而不是一个「——」加一张空二维码
    const a2 = await started(base, { token: mate.token });
    a2.click(a2.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a2.el('#invite-share-box').hidden, true, '成员不该再看到码 / 二维码 / 按钮');
    assert.equal(a2.el('#invite-closed').hidden, false, '要换成那条说明');
    assert.match(a2.el('#invite-closed').textContent, /群主/, '说明里要讲清楚该找谁');
    assert.equal(a2.el('#btn-copy-code').disabled, true, '按钮即使露出来也点不出一个能用的链接');

    // 首页那张卡片：不再印码，但**还得能点进去**
    const card = a2.all('#home-groups .item')[0];
    assert.equal(card.textContent.includes(code), false, '首页不能一边说只有群主能分享、一边把码印出来');
    assert.match(card.textContent, /2 人/, '人数照旧显示');
    assert.equal(card.getAttribute('data-code'), code, 'data-code 必须留着，否则首页点不开群了');

    // 群主自己完全不受影响
    const a3 = await started(base, { token: owner.token });
    a3.click(a3.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(a3.el('#invite-share-box').hidden, false, '群主照旧看得到自己的码');
    assert.match(a3.all('#home-groups .item')[0].textContent, new RegExp(code), '群主首页照旧印码');
});

test('成员分享开关：群主点一下就能切，两侧立刻跟着变', async () => {
    const owner = await user();
    const mate = await user();
    const g = await raw('/api/groups', { method: 'POST', token: owner.token, body: { name: '开关即时群' } });
    const code = g.body.code;
    await raw(`/api/groups/${code}/join`, { method: 'POST', token: mate.token, body: {} });

    const a = await started(base, { token: owner.token });
    a.click(a.all('#home-groups .item')[0]);
    await tick(350);

    const shareBtn = (v) => a.all('#share-mode button').find((b) => b.getAttribute('data-share') === v);
    assert.ok(shareBtn('all') && shareBtn('owner'), '设置卡片里要有这个开关');
    assert.equal(shareBtn('all')._classes.has('on'), true, '默认「成员也能分享」是亮的');

    a.click(shareBtn('owner'));
    await tick(300);
    assert.equal(shareBtn('owner')._classes.has('on'), true, '切过去之后要标出来');
    assert.equal(shareBtn('all')._classes.has('on'), false);
    assert.equal((await raw(`/api/groups/${code}`, { token: owner.token })).body.memberShare, false,
        '服务端真的关掉了');

    // 成员那边重新进来就是关闭态
    const b = await started(base, { token: mate.token });
    assert.equal(b.all('#home-groups .item')[0].textContent.includes(code), false, '成员首页也不印码了');
    b.click(b.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(b.el('#invite-closed').hidden, false);

    // 再打开：成员又看得到码
    await raw(`/api/groups/${code}/settings`, {
        method: 'PUT', token: owner.token, body: { memberShare: true }
    });
    const c = await started(base, { token: mate.token });
    c.click(c.all('#home-groups .item')[0]);
    await tick(350);
    assert.equal(c.el('#invite-closed').hidden, true, '打开之后说明该收起');
    assert.equal(c.el('#invite-share-box').hidden, false, '码那一块回来');
});

// ---------------------------------------------------------------- 管理页筛选

const COURSE2 = {
    course: '线性代数', day: 3, startPeriod: 1, endPeriod: 2,
    startTime: '08:00', endTime: '09:35', location: '紫金港西2-105',
    dates: ['20260916', '20260923']
};

/**
 * 管理页筛选自己一套干净的服务。
 *
 * 不复用共享实例：那边的账号是十几个用例堆出来的（同一个 IP 早就触发
 * 「异常注册」整簇标记，全局列表里也全是别人造的人），而筛选用例需要
 * 自己说了算的数据 —— 尤其是「什么时候注册的」「多少天没露面」，
 * 只能直接改盘上的记录才造得出来。
 */
async function filterSetup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-filter-'));
    const s = await createServer({
        vault: false, captcha: false, dataDir: dir, port: 0, skipCleanup: true,
        limits: {
            registerBurst: { windowMs: 60000, max: 1000, message: 'x' },
            register: { windowMs: 3600000, max: 1000, message: 'x' },
            loginFail: { windowMs: 600000, max: 1000, message: 'x' }
        }
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}`;

    const call = async (pathname, opts = {}) => {
        const headers = {};
        if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await globalThis.__realFetch(url + pathname, {
            method: opts.method || 'GET', headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };

    let n = 0;
    const mkUser = async (withCourses) => {
        n += 1;
        const nickname = `筛${n}`;
        const r = await call('/api/register', { method: 'POST', body: { nickname, password: 'pw123456' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        if (withCourses) {
            await call('/api/me/courses', { method: 'PUT', token: r.body.token, body: { courses: [COURSE] } });
        }
        return { id: r.body.userId, nickname, token: r.body.token };
    };

    // 直接改盘上的账号记录。注册时间、最后活动都是服务端 now() 说了算的，
    // 想造出「某天凌晨注册」「40 天没露面」只能改文件（server.test.js 里也这么干）。
    const patchUsers = (fn) => {
        const file = path.join(dir, 'users.json');
        const db = JSON.parse(fs.readFileSync(file, 'utf8'));
        fn(db.users);
        fs.writeFileSync(file, JSON.stringify(db), 'utf8');
    };

    return {
        dir, s, url, call, mkUser, patchUsers,
        close: async () => { await new Promise((r) => s.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
    };
}

/**
 * 账号列表里现在有哪些昵称。
 * 精确取 .title 而不是整行 textContent —— 否则「筛1」会误配到「筛12」。
 */
function listedNames(a) {
    return a.all('#admin-users .item').map((r) => r.querySelector('.title').textContent);
}

/** 用某个 token 起一份 app 并进管理页。等 600ms：概览那六个数字要滚 420ms 才停 */
async function openAdminAt(url, token) {
    const a = await started(url, { token });
    a.click('#btn-admin');
    await tick(600);
    assert.equal(a.activeScreen(), 'admin');
    return a;
}

/** 状态胶囊的按钮 */
function statusPill(a, s) {
    return a.all('#admin-status button').find((b) => b.getAttribute('data-status') === s);
}

/** 造一个管理员；返回 { boss, a } */
async function adminScene(t) {
    const boss = await t.mkUser(true);
    await t.s.store.setUserAdmin(boss.id, true);
    return boss;
}

test('管理页筛选：状态胶囊只留对应的人，点回「全部」恢复', async () => {
    const t = await filterSetup();
    try {
        const boss = await adminScene(t);
        const withCourse = await t.mkUser(true);
        const noCourse = await t.mkUser(false);

        const a = await openAdminAt(t.url, boss.token);
        assert.equal(listedNames(a).length, 3);

        a.click(statusPill(a, 'hascourse'));
        await tick(60);
        assert.deepEqual(listedNames(a).sort(), [boss.nickname, withCourse.nickname].sort());
        assert.equal(statusPill(a, 'hascourse')._classes.has('on'), true, '当前状态要标出来');
        assert.equal(a.el('#admin-users')._classes.has('no-anim'), true, '筛选时关掉入场动画');

        a.click(statusPill(a, 'nocourse'));
        await tick(60);
        assert.deepEqual(listedNames(a), [noCourse.nickname]);

        a.click(statusPill(a, 'all'));
        await tick(60);
        assert.equal(listedNames(a).length, 3);
        assert.equal(a.el('#admin-users')._classes.has('no-anim'), false, '清空后入场动画恢复');
    } finally { await t.close(); }
});

test('管理页筛选：排序字段与升降序方向', async () => {
    const t = await filterSetup();
    try {
        const boss = await adminScene(t);
        const busy = await t.mkUser(true);
        // 再登录两次 -> loginCount 3（注册本身算第一次）
        for (let i = 0; i < 2; i++) {
            const r = await t.call('/api/login', {
                method: 'POST', body: { nickname: busy.nickname, password: 'pw123456' }
            });
            assert.equal(r.status, 200);
        }

        const a = await openAdminAt(t.url, boss.token);
        // 默认：注册时间降序 -> 后注册的在前
        assert.deepEqual(listedNames(a), [busy.nickname, boss.nickname]);

        const sort = a.el('#admin-sort');
        sort.value = 'loginCount';
        sort.dispatch('change', {});
        await tick(60);
        assert.equal(listedNames(a)[0], busy.nickname, '降序时登录最多的在最前');

        a.click('#admin-sort-dir');
        await tick(60);
        assert.match(a.el('#admin-sort-dir').textContent, /升序/, '按钮文字要跟着方向变');
        assert.equal(listedNames(a)[0], boss.nickname, '升序时登录最少的在最前');
    } finally { await t.close(); }
});

test('管理页筛选：注册时间按本地日算，当天凌晨注册的不能被漏掉', async () => {
    const t = await filterSetup();
    try {
        const boss = await adminScene(t);
        const early = await t.mkUser(false);
        const late = await t.mkUser(false);
        const before = await t.mkUser(false);

        // 挑一个固定的过去日期，免得用例结果随「现在是几点」漂
        t.patchUsers((users) => {
            const set = (id, ts) => { users.find((x) => x.id === id).createdAt = ts; };
            set(early.id, new Date(2026, 2, 10, 0, 30).getTime());    // 当天 00:30
            set(late.id, new Date(2026, 2, 10, 23, 30).getTime());    // 当天 23:30
            set(before.id, new Date(2026, 2, 9, 23, 30).getTime());   // 前一天
        });

        const a = await openAdminAt(t.url, boss.token);
        a.click('#admin-more-toggle');
        await tick(30);
        assert.equal(a.el('#admin-more').hidden, false, '「更多筛选」要能展开');

        for (const [sel, v] of [['#admin-reg-from', '2026-03-10'], ['#admin-reg-to', '2026-03-10']]) {
            const el = a.el(sel);
            el.value = v;
            el.dispatch('change', {});
            await tick(40);
        }

        const names = listedNames(a);
        // 这条就是时区回归：用 new Date('2026-03-10') 解析会得到 UTC 午夜，
        // 东八区下等于当天 08:00 —— 00:30 注册的这个账号会被漏掉
        assert.ok(names.includes(early.nickname), '当天 00:30 注册的必须算在「当天」里');
        assert.ok(names.includes(late.nickname), '当天 23:30 注册的也要算在「当天」里');
        assert.equal(names.includes(before.nickname), false, '前一天注册的不该进来');
        assert.equal(names.includes(boss.nickname), false, '注册时间不在区间里的都该出去');
    } finally { await t.close(); }
});

test('管理页筛选：数字区间含边界，填反了自动交换', async () => {
    const t = await filterSetup();
    try {
        const boss = await adminScene(t);          // 1 个时段
        const one = await t.mkUser(true);          // 1 个时段
        const two = await t.mkUser(true);
        const none = await t.mkUser(false);        // 0 个时段
        await t.call('/api/me/courses', { method: 'PUT', token: two.token, body: { courses: [COURSE, COURSE2] } });

        const a = await openAdminAt(t.url, boss.token);
        a.click('#admin-more-toggle');
        await tick(30);

        const setRange = async (min, max) => {
            const lo = a.el('#admin-course-min'), hi = a.el('#admin-course-max');
            lo.value = min; lo.dispatch('input', {});
            hi.value = max; hi.dispatch('input', {});
            await tick(60);
        };

        await setRange('1', '2');
        const inRange = [boss.nickname, one.nickname, two.nickname].sort();
        assert.deepEqual(listedNames(a).sort(), inRange, '边界值 1 和 2 都必须在结果里');

        await setRange('2', '1');    // 填反
        assert.deepEqual(listedNames(a).sort(), inRange, '填反了应当自动交换，结果与正着填一致');

        await setRange('0', '0');
        assert.deepEqual(listedNames(a), [none.nickname], '留空过的那一端不该被当成 0');
    } finally { await t.close(); }
});

test('管理页筛选：搜索框也认最后登录 IP', async () => {
    const t = await filterSetup();
    try {
        const boss = await adminScene(t);
        const marked = await t.mkUser(false);
        t.patchUsers((users) => {
            users.find((x) => x.id === marked.id).lastLoginIp = '10.9.9.9';
        });

        const a = await openAdminAt(t.url, boss.token);
        const box = a.el('#admin-user-filter');
        box.value = '10.9.9.9';
        box.dispatch('input', {});
        await tick(60);

        assert.deepEqual(listedNames(a), [marked.nickname],
            '登录 IP 往往才是管理员手里那个可疑 IP，不能只认注册 IP');
    } finally { await t.close(); }
});

test('管理页筛选：待清理/异常注册跟着筛，并把「被挡住」的数量说出来', async () => {
    const t = await filterSetup();
    try {
        const boss = await adminScene(t);
        const dormantA = await t.mkUser(false);
        const dormantB = await t.mkUser(false);
        const suspect = await t.mkUser(true);      // 有课表，所以不会被算成待清理

        // 40 天没露面 + 一次课表都没传 = 待清理；再单独标一个待复核（它有课表）
        const old = Date.now() - 40 * 86400000;
        t.patchUsers((users) => {
            for (const id of [dormantA.id, dormantB.id]) {
                const u = users.find((x) => x.id === id);
                u.createdAt = old;
                u.lastLoginAt = old;
            }
            users.forEach((u) => { delete u.suspect; delete u.suspectReason; });
            const s = users.find((x) => x.id === suspect.id);
            s.suspect = true;
            s.suspectReason = '同 IP 集中注册';
        });

        const a = await openAdminAt(t.url, boss.token);
        assert.match(a.el('#admin-dormant-count').textContent, /2 个/);
        assert.match(a.el('#admin-suspect-count').textContent, /1 个/);
        // 概览：4 个账号 / 1 个管理员 / 2 个传了课表 / 0 个群 / 1 个待复核 / 2 个待清理
        const stats = ['4', '1', '2', '0', '1', '2'];
        assert.deepEqual(a.all('#admin-stats .stat b').map((b) => b.textContent), stats);

        // 筛「已传课表」：两个没传课表的待清理账号被挡住
        a.click(statusPill(a, 'hascourse'));
        await tick(60);

        assert.equal(a.el('#admin-dormant-card').hidden, false,
            '被筛空也不该把整张卡片藏起来 —— 否则这句提示没地方写');
        assert.match(a.el('#admin-dormant-count').textContent, /另有 2 个被当前筛选挡住/,
            '「0 个」必须说清是被筛掉了，而不是已经没有这种账号了');
        assert.equal(a.all('#admin-dormant .item').length, 0);
        assert.equal(a.all('#admin-suspects .item').length, 1, '这个待复核账号传了课表，留了下来');

        // 概览那六个数字是全站全量，不随筛选变
        assert.deepEqual(a.all('#admin-stats .stat b').map((b) => b.textContent), stats,
            '概览是「这个站现在什么状况」，跟着筛选变就没意义了');
    } finally { await t.close(); }
});

test('管理页筛选：清空筛选恢复全量，且列表委托始终只有一份', async () => {
    const t = await filterSetup();
    try {
        const boss = await adminScene(t);
        await t.mkUser(false);
        const a = await openAdminAt(t.url, boss.token);
        const total = listedNames(a).length;

        // 换着花样筛几轮
        a.click(statusPill(a, 'admin'));
        await tick(40);
        a.click('#admin-more-toggle');
        await tick(20);
        const idle = a.el('#admin-idle-min');
        idle.value = '30';
        idle.dispatch('input', {});
        await tick(40);
        a.click('#admin-sort-dir');
        await tick(40);
        assert.equal(listedNames(a).length, 0, '30 天没露面的一个都没有');

        a.click('#admin-filter-reset');
        await tick(60);
        assert.equal(listedNames(a).length, total, '清空筛选要恢复全量');
        assert.equal(a.el('#admin-user-filter').value, '', '搜索框也要清掉');
        assert.equal(statusPill(a, 'all')._classes.has('on'), true, '胶囊回到「全部」');
        assert.equal(a.el('#admin-users')._classes.has('no-anim'), false);

        // 委托只能有一份：重画多少次都不该再挂监听（历史上就是这么重复绑定弹两个框的）
        assert.equal((a.el('#admin-users')._listeners.click || []).length, 1,
            '筛选重画不该给列表再挂一份 click 委托');
    } finally { await t.close(); }
});

