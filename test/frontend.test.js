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
    const paths = [...new Set(
        [...api.matchAll(/request\(\s*'(\/?api\/[^']*)'/g)]
            .map((x) => (x[1].startsWith('/') ? x[1] : '/' + x[1]))
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
