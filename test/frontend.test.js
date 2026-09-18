'use strict';

/**
 * 前端静态接线检查。
 *
 * 这类问题单测抓不到，但线上必炸：
 *   - app.js 里 $('#xxx') 指向一个 index.html 里不存在的 id
 *   - 调了一个 api.js 里没定义的方法
 *   - 引用了磁盘上不存在的图片
 *   - show('xxx') 切到一个没有对应 section 的屏幕
 *   - 模板里重复的 id（querySelector 只认第一个，另一个永远死掉）
 *
 * 之前就栽过：本地比对页误粘了一整张「账号」卡片，两个 #btn-delete-account，
 * 结果那个页面的注销按钮点了没反应。这条用例就是为了不再犯。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const html = read('public', 'index.html');
const app = read('public', 'app.js');
const api = read('public', 'api.js');
const css = read('public', 'style.css');

/** index.html 里所有 id */
function htmlIds() {
    const ids = [];
    const re = /\bid="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) ids.push(m[1]);
    return ids;
}

/** 从 JS 里抓出所有 '#xxx' 字面量选择器里的 id。
 *  拼接出来的（$('#local-drop-' + side)）静态查不了，整条跳过。 */
function jsIdSelectors(src) {
    const out = new Set();
    const re = /\$\$?\(\s*'([^']*)'\s*([+,)])/g;
    let m;
    while ((m = re.exec(src))) {
        if (m[2] === '+') continue;
        (m[1].match(/#([A-Za-z0-9_-]+)/g) || []).forEach((s) => out.add(s.slice(1)));
    }
    return out;
}

// ---------------------------------------------------------------- id

test('index.html 里没有重复 id', () => {
    const seen = new Map();
    const dup = [];
    for (const id of htmlIds()) {
        if (seen.has(id)) dup.push(id);
        seen.set(id, true);
    }
    assert.deepEqual(dup, [], '重复 id 会让 querySelector 只认第一个，其余永远拿不到');
});

test('app.js 里查的每个 #id 都真的存在于 index.html', () => {
    const have = new Set(htmlIds());
    const missing = [...jsIdSelectors(app)].filter((id) => !have.has(id)).sort();
    assert.deepEqual(missing, [], '这些 id 在页面上不存在');
});

test('每个 .screen section 的 id 与 show() 用的名字对得上', () => {
    const screens = new Set(
        [...html.matchAll(/<section class="screen" id="screen-([a-z-]+)"/g)].map((m) => m[1])
    );
    assert.ok(screens.has('auth') && screens.has('home'), '至少有登录页和首页');

    // show('xxx', ...) 里的 xxx
    const used = new Set([...app.matchAll(/\bshow\(\s*'([a-z-]+)'/g)].map((m) => m[1]));
    const bad = [...used].filter((s) => !screens.has(s));
    assert.deepEqual(bad, [], '切到了一个不存在的屏幕');
});

// ---------------------------------------------------------------- API

test('app.js 调的每个 API 方法都在 api.js 里定义', () => {
    // 方法表里既有 `meta: function () {}` 也有 `setToken: setToken,`
    const defined = new Set([...api.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):\s*\S/gm)].map((m) => m[1]));
    assert.ok(defined.size > 10, `api.js 的方法表应该抓得到，实际 ${defined.size}`);

    const used = new Set([...app.matchAll(/\bAPI\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]));
    const missing = [...used].filter((m) => !defined.has(m)).sort();
    assert.deepEqual(missing, [], '这些 API 方法没定义');
});

test('api.js 里每个方法都请求了一个真实存在的路由', () => {
    const server = read('server.js');
    const routes = [];
    const re = /\[\s*'(GET|POST|PUT|DELETE)',\s*\/\^(.+?)\$\/,/g;
    let m;
    while ((m = re.exec(server))) routes.push(m[2].replace(/\\\//g, '/'));
    // 不写死条数 —— 加一条路由就要来改测试数字，只会让人嫌烦而绕过它。
    // 这里只确认「正则确实抓到了路由」，别让提取本身悄悄失配。
    assert.ok(routes.length >= 20, `路由提取似乎失配了，只抓到 ${routes.length} 条`);
    assert.ok(routes.every((r) => r.startsWith('/api/')), '所有路由都应挂在 /api/ 下');

    // api.js 里请求的字面量路径。拼接出来的（'api/groups/' + code + ...）
    // 只取静态前缀，用前缀去配路由 —— 够抓「路由改名了但前端没跟」这类错。
    // 前端写的是相对路径（子路径部署要用），这里统一补前导斜杠再和绝对路由对照。
    // query 不算路径的一部分：服务端是按 pathname 匹配路由的（server.js 里
    // new URL(req.url).pathname），带着 ?days= 去比对只会假红。
    const paths = [...new Set(
        [...api.matchAll(/request\(\s*'(\/?api\/[^']*)'/g)]
            .map((x) => (x[1].startsWith('/') ? x[1] : '/' + x[1]).split('?')[0])
    )];
    assert.ok(paths.length > 8, '应能抓到一批 api 路径');

    for (const p of paths) {
        const ok = routes.some((r) => r.startsWith(p));
        assert.ok(ok, `api.js 请求的 ${p} 在 server.js 里找不到对应路由`);
    }
});

// ---------------------------------------------------------------- 资源

test('index.html 引用的脚本与样式都在磁盘上', () => {
    const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
        .filter((s) => !/^(https?:)?\/\//.test(s) && !s.startsWith('#'))
        .map((s) => s.split('?')[0]);
    assert.ok(srcs.length > 4);

    const missing = srcs.filter((s) => {
        // 服务器把 /shared/* 映射到仓库根的 shared/，其余映射到 public/。
        // index.html 里写的是相对路径（shared/config.js），所以在根路径部署下
        // 请求的仍是 /shared/*，这里按「去掉前导斜杠就是仓库内路径」来判定。
        const rel = /^\/?shared\//.test(s) ? s.replace(/^\//, '') : path.join('public', s);
        return !fs.existsSync(path.join(ROOT, rel));
    });
    assert.deepEqual(missing, [], '这些静态资源不存在');
});

test('shared/ 下的脚本带 ?v= 版本号（缓存事故的防线）', () => {
    const shared = [...html.matchAll(/src="(\/?shared\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(shared.length >= 5, '应当引用了 shared/ 下的模块');
    for (const s of shared) {
        assert.match(s, /\?v=\d+$/, `${s} 没有 ?v= 版本号`);
    }
});

test('app.js 引用的吉祥物图片都在磁盘上', () => {
    const files = [...app.matchAll(/'(img\/mascot\/[a-z-]+\.gif)'/g)].map((m) => m[1]);
    assert.ok(files.length >= 10, '吉祥物应该有一批');
    const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, 'public', f)));
    assert.deepEqual(missing, [], '这些图片不存在');
});

test('页脚里的 CoPig 那行确实在页面上', () => {
    assert.match(html, /CoPig/);
    assert.match(html, /DongLanQwQ/);
    assert.match(html, /鸣谢/);
});

test('页脚有一行灰字版本号，且是从服务端拿的（不写死在页面里）', () => {
    // 坑留在页脚最底下，默认 hidden：取不到版本就空着，
    // 别留一行「什么都没有」的灰字在那儿
    assert.match(html, /<div class="foot-sub foot-ver" id="foot-ver" hidden><\/div>/);
    // 内容由 app.js 从 /api/meta 填进去。写死在 HTML 里就只能靠人记得改，
    // 而这一行的意义恰恰是「页面上显示的 = 此刻真正在跑的那一版」
    assert.match(app, /\$\('#foot-ver'\)/);
    assert.match(app, /API\.meta\(\)/);
    assert.match(api, /meta: function \(\)/);

    // 灰字：比页脚其它几行更淡、更小
    const rule = /\.foot-sub\.foot-ver\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, 'style.css 里得有 .foot-sub.foot-ver 这条规则');
    assert.match(rule[1], /color:\s*var\(--text-2\)/);
    assert.match(rule[1], /opacity:\s*\.\d+/);
});

test('顶栏和页脚都有去 GitHub 点 Star 的入口', () => {
    const REPO = 'https://github.com/DongLanQwQ0/ZJU-Tongge-Schedule';
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const stars = links.filter((u) => u === REPO);
    // 顶栏一颗（登录后一直可见）+ 页脚一行（连登录页都看得到）
    assert.ok(stars.length >= 2, `应当有顶栏 + 页脚两处入口，实际 ${stars.length} 处`);
    // 顺带钉死地址：仓库名打错一个字，那颗星就会静默指向不存在的页面

    // 外链一律带 rel=noopener —— 少了它，对方页面能通过 window.opener 操作我们这页
    for (const tag of html.matchAll(/<a[^>]*github\.com[^>]*>/g)) {
        assert.match(tag[0], /rel="noopener/, `外链缺 rel=noopener：${tag[0]}`);
    }
});

// ---------------------------------------------------------------- 动画

test('导出的保险丝还在（必须能压掉一切动画与过渡）', () => {
    const i = css.indexOf('#export-host, #export-host *');
    assert.ok(i > 0, '导出容器必须有禁用动画的兜底规则');
    const block = css.slice(i, i + 200);
    assert.match(block, /animation:\s*none/);
    assert.match(block, /transition:\s*none/);
});

test('减弱动效时整个关掉动画', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('动画相关的兜底规则排在所有动效之后', () => {
    // #export-host 的禁用规则必须是文件里最后一段动效规则，否则会被后面的覆盖
    const fuse = css.indexOf('#export-host, #export-host *');
    const lastKeyframes = css.lastIndexOf('@keyframes');
    assert.ok(lastKeyframes < fuse, '导出保险丝必须排在所有 @keyframes 之后');
});

test('JS 里用到的动画 class 在 CSS 里都有定义', () => {
    for (const cls of ['bump', 'ring', 'closing', 'no-anim']) {
        assert.ok(css.includes('.' + cls), `CSS 里缺少 .${cls}`);
    }
});

// ---------------------------------------------------------------- 图标

/**
 * 这个站的文案里可以带表情和颜文字 —— 那是它说话的口气（分享文案专门随机挂一个）。
 * 不许的是**拿表情当图标用**：图标一律是 index.html 那份 Lucide sprite 里的
 * <use href="#i-*">。所以这里只盯两件事：
 *   1. 图标位上写的是不是 sprite；
 *   2. 有没有「只赋值一个表情」的写法（textContent = '🔗' 这种就是字符图标）。
 */
const EMOJI_RANGES = [
    [0x1F000, 0x1FAFF],   // 表情 / 象形 / 补充符号
    [0x2600, 0x27BF],     // 杂项符号与装饰符（星、太阳、对勾、音符…）
    [0x2B00, 0x2BFF],     // 杂项符号与箭头
    [0x2300, 0x23FF],     // 杂项技术符号（⎋ ⌘…）
    [0x2460, 0x24FF],     // 带圈字母数字
    [0x25A0, 0x25FF],     // 几何图形
    [0x200D, 0x200D], [0x20E3, 0x20E3], [0x3030, 0x3030], [0x303D, 0x303D],
    [0x3297, 0x3297], [0x3299, 0x3299], [0xFE0F, 0xFE0F]
];
// 箭头（→ ↑）不在范围内：它们是文案里的连接符（「注册 → 传 .ics」），不是图标
const emojiChars = (s) => [...s].filter((c) => EMOJI_RANGES.some(([a, b]) => {
    const cp = c.codePointAt(0);
    return cp >= a && cp <= b;
}));

/** 图标位：菜单图标、圆形图标按钮、提示块顶上的标记、图标+文字的按钮、行尾箭头 */
const ICON_SLOTS = new RegExp('<(?:span|div|svg|button|a)\\b[^>]*class="[^"]*\\b' +
    '(menu-ico|icon-btn|note-mark|auth-mark|btn-ico|chev)\\b[^"]*"[^>]*>' +
    '([\\s\\S]*?)(?:</svg>|</span>|</div>|</button>|</a>)', 'g');

test('图标位里只有 Lucide sprite，没有表情和字符图标', () => {
    const bad = [];
    for (const m of html.matchAll(ICON_SLOTS)) {
        const inner = m[2];
        if (!/#i-[a-z0-9-]+/.test(inner)) {
            bad.push(`${m[1]} 里没有 sprite 图标：${inner.trim().slice(0, 50)}`);
        }
        const emoji = emojiChars(inner);
        if (emoji.length) bad.push(`${m[1]} 里还留着表情：${emoji.join(' ')}`);
    }
    assert.deepEqual(bad, [], '图标位要用 <svg class="ico"><use href="#i-...">');
});

test('app.js 不拿表情当图标（只有表情、没有别的字的那种赋值）', () => {
    const emojiOnly = (v) => {
        const t = String(v).replace(/<[^>]*>/g, '').replace(/\s+/g, '');
        return t.length > 0 && emojiChars(t).length === [...t].length;
    };
    const bad = [...app.matchAll(/\.(?:textContent|innerHTML)\s*=\s*'([^']*)'/g)]
        .filter((m) => emojiOnly(m[1]))
        .map((m) => m[1]);
    assert.deepEqual(bad, [], '这些地方把表情当图标塞进了界面，换成 icon(\'...\') 里的 sprite');
});

/** index.html 里定义了哪些 #i-* */
function spriteIds() {
    return new Set([...html.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
}

test('用到的每个图标都在 sprite 里有定义', () => {
    const have = spriteIds();
    assert.ok(have.size >= 15, `sprite 里的图标应该抓得到，实际 ${have.size}`);

    // 静态标记：<use href="#i-xxx">
    const used = [...html.matchAll(/<use href="#(i-[a-z0-9-]+)"/g)].map((m) => m[1]);
    // 动态渲染：icon('xxx')，以及三元 icon(dir === 'asc' ? 'a' : 'b') 里的两个名字。
    // 第二个参数是 class，不参与匹配。
    for (const m of app.matchAll(/\bicon\(([^()]*)\)/g)) {
        const first = /^\s*'([a-z][a-z0-9-]*)'/.exec(m[1]);
        if (first) used.push('i-' + first[1]);
        for (const t of m[1].matchAll(/[?:]\s*'([a-z][a-z0-9-]*)'/g)) used.push('i-' + t[1]);
    }
    assert.ok(used.length >= 15, `图标引用应该抓得到，实际 ${used.length}`);

    const missing = [...new Set(used)].filter((id) => !have.has(id)).sort();
    assert.deepEqual(missing, [], '这些图标没在 sprite 里定义（<symbol id="...">）');
});

test('装饰背景：只在深色主题出现，压在内容之下，且不吃点击', () => {
    // 浅色主题是白卡片的工具页，底下铺照片只会脏 —— 默认必须是关掉的
    assert.match(css, /\.bg-photo\s*\{\s*display:\s*none/);

    const dark = /\[data-theme="dark"\]\s*\.bg-photo\s*\{([^}]*)\}/.exec(css);
    assert.ok(dark, '深色主题里得有一条 .bg-photo 的规则');
    assert.match(dark[1], /position:\s*fixed/, '要固定一层，不能跟着页面滚');
    assert.match(dark[1], /z-index:\s*-1/, '必须压在内容之下');
    assert.match(dark[1], /pointer-events:\s*none/, '纯装饰层不能吃点击');
    assert.match(html, /<div class="bg-photo" aria-hidden="true"><\/div>/, 'index.html 里得有这一层');
});

test('页脚净空：只在深色主题留一段，把署名顶到灯上方', () => {
    assert.match(html, /<div class="foot-clearance" aria-hidden="true"><\/div>/,
        'index.html 里得有这段占位');
    assert.match(css, /\.foot-clearance\s*\{\s*display:\s*none/, '浅色主题底下没有灯，不留净空');

    const dark = /\[data-theme="dark"\]\s*\.foot-clearance\s*\{([^}]*)\}/.exec(css);
    assert.ok(dark, '深色主题里得有一条 .foot-clearance 的规则');
    // 灯是固定的、亮部落在这个比例上；净空被调小之后署名会重新糊在灯上，
    // 所以下限得钉住（实测手机 172px / 桌面 160px 时，署名稳稳在灯上方）
    const m = /height:\s*clamp\((\d+)px/.exec(dark[1]);
    assert.ok(m, '净空高度应当写成带下限的 clamp（跟着视口缩，但不能小到失去意义）');
    assert.ok(Number(m[1]) >= 100, `净空下限太小（${m[1]}px），页脚会重新压到灯上`);
});

test('style.css 里引用的图片都在 public/ 下', () => {
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)]
        .map((m) => m[1].replace(/['"]/g, '').trim())
        .filter((u) => !/^(data:|https?:|\/\/)/.test(u));
    assert.ok(urls.length >= 1, 'style.css 里至少引了一张图（装饰背景）');
    const missing = urls.filter((u) => !fs.existsSync(path.join(ROOT, 'public', u)));
    assert.deepEqual(missing, [], '这些图片在 public/ 下不存在');
});

test('图标尺寸由 .ico 一处控制，sprite 本身不占布局', () => {
    const ico = /\.ico\s*\{([^}]*)\}/.exec(css);
    assert.ok(ico, 'style.css 里得有 .ico 这条规则');
    // 用 em：图标跟着旁边那行字的字号缩，不用逐个尺寸调
    assert.match(ico[1], /width:\s*1\.15em/);

    const sprite = /\.sprite\s*\{([^}]*)\}/.exec(css);
    assert.ok(sprite, 'style.css 里得有 .sprite 这条规则');
    assert.match(sprite[1], /width:\s*0/);
    assert.match(sprite[1], /height:\s*0/);
});
