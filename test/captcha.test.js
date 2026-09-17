/**
 * 注册验证码：出题（PNG）、校验、一次性核销，以及它在注册接口上的拦截效果。
 *
 * 出题用的是注入式随机源：captchaRng 固定成 () => 0 之后，题目永远是「1+1+1=3」，
 * 测试才算得出正确答案。
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const captcha = require('../shared/captcha.js');
const { createServer } = require('../server.js');

// ---------------------------------------------------------------- 出题与画图

/** 按标准优先级求值，顺便检查每一步中间结果都是非负整数 */
function evalExpr(expr) {
    const tokens = expr.replace(/=$/, '').match(/\d+|[+\-×÷]/g);
    const nums = [Number(tokens[0])];
    const ops = [];
    for (let i = 1; i < tokens.length; i += 2) {
        ops.push(tokens[i]);
        nums.push(Number(tokens[i + 1]));
    }
    for (let i = 0; i < ops.length;) {
        if (ops[i] === '×' || ops[i] === '÷') {
            const v = ops[i] === '×' ? nums[i] * nums[i + 1] : nums[i] / nums[i + 1];
            assert.ok(Number.isInteger(v) && v >= 0, `${expr} 出现了非非负整数中间值`);
            nums.splice(i, 2, v);
            ops.splice(i, 1);
        } else i += 1;
    }
    let v = nums[0];
    ops.forEach((op, i) => {
        v = op === '+' ? v + nums[i + 1] : v - nums[i + 1];
        assert.ok(Number.isInteger(v) && v >= 0, `${expr} 出现了负数中间值`);
    });
    return v;
}

test('出题：2–4 次四则运算，答案与按优先级算出来的一致', () => {
    for (let i = 0; i < 200; i += 1) {
        const c = captcha.create();
        const ops = (c.text.replace(/=$/, '').match(/[+\-×÷]/g) || []).length;
        assert.ok(ops >= 2 && ops <= 4, `运算次数应在 2–4：${c.text}`);
        assert.match(c.text, /^[0-9+\-×÷]+=$/, `式子格式不对：${c.text}`);
        assert.equal(c.answer, String(evalExpr(c.text)), `${c.text} 的答案对不上`);
        const ans = Number(c.answer);
        assert.ok(ans >= 0 && ans <= 30, `${c.text} 的结果超出 0–30`);
    }
});

test('出题：加减出现之后不再接乘除（否则人按优先级算会和答案不一致）', () => {
    for (let i = 0; i < 200; i += 1) {
        const body = captcha.create().text.replace(/=$/, '');
        const at = body.search(/[+\-]/);
        if (at < 0) continue;
        assert.ok(!/[×÷]/.test(body.slice(at)), `加减之后不该再出现乘除：${body}`);
    }
});

test('出题：操作数都是个位数', () => {
    for (let i = 0; i < 200; i += 1) {
        const body = captcha.create().text.replace(/=$/, '');
        for (const n of body.match(/\d+/g)) {
            assert.ok(n.length === 1, `出现了多位数：${body}`);
            assert.ok(Number(n) >= 1, `出现了 0：${body}`);
        }
    }
});

test('出题：注入固定随机源时题目可预测（HTTP 用例靠它）', () => {
    const c = captcha.create(() => 0);
    assert.equal(c.text, '1+1+1=');
    assert.equal(c.answer, '3');
});

test('出图：是一张合法的灰度 PNG，尺寸和字符数对得上', () => {
    const c = captcha.create(() => 0);
    assert.deepEqual([...c.png.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数不对');
    assert.equal(c.png.subarray(12, 16).toString('latin1'), 'IHDR');
    // '1+1+1=' 六个字符、每点 5 像素：(6×(5+3)−3)×5+16 = 241；高 7×5+16 = 51
    assert.equal(c.png.readUInt32BE(16), 241);
    assert.equal(c.png.readUInt32BE(20), 51);
    assert.equal(c.png[24], 8, '位深应为 8');
    assert.equal(c.png[25], 0, '颜色类型应为灰度');
    // 尾部 12 字节 = 长度(4) + 'IEND'(4) + CRC(4)
    assert.equal(c.png.subarray(c.png.length - 8, c.png.length - 4).toString('latin1'), 'IEND');
});

test('出图：长式子会自动降一档缩放，免得在窄屏上放不下', () => {
    const six = captcha.draw('1+1+1=', () => 0.5);          // 6 字符 → 每点 5 像素
    const ten = captcha.draw('1+1+1+1+1=', () => 0.5);      // 10 字符 → 每点 4 像素
    assert.equal(six.h, 51);
    assert.equal(ten.h, 44);
    assert.ok(ten.w <= 330, `最长的式子也该塞得进 375px 屏：${ten.w}`);
});

test('字形：题目用到的符号一个不缺，且都不是空白', () => {
    for (const ch of '0123456789+-=×÷') {
        const g = captcha.GLYPHS[ch];
        assert.ok(g, `缺字形：${ch}`);
        assert.ok(g.join('').includes('1'), `字形是空的：${ch}`);
    }
});

// ---------------------------------------------------------------- 接在注册接口上

let server;
let base;

before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-captcha-'));
    server = await createServer({
        dataDir: dataDir,
        port: 0,
        skipCleanup: true,
        captchaRng: () => 0,                 // 题目固定为 1+1+1=3
        limits: {
            registerBurst: { windowMs: 60000, max: 1000, message: 'x' },
            register: { windowMs: 3600000, max: 1000, message: 'x' },
            join: { windowMs: 60000, max: 1000, message: 'x' }
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
    if (server) await new Promise((r) => server.close(r));
});

async function api(pathname, opts) {
    const o = opts || {};
    const headers = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + pathname, {
        method: o.method || 'GET',
        headers: headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test('GET /api/captcha：免登录，给一张 PNG 和一个题目编号', async () => {
    const r = await api('/api/captcha');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.match(r.body.id, /^[0-9a-f]{18}$/);
    assert.match(r.body.image, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
});

test('注册：不带验证码 -> 400，答错 -> 400，答对 -> 放行', async () => {
    const none = await api('/api/register', {
        method: 'POST', body: { nickname: '验证甲', password: 'pw123456' }
    });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /验证码/);

    const q1 = await api('/api/captcha');
    const wrong = await api('/api/register', {
        method: 'POST',
        body: { nickname: '验证乙', password: 'pw123456', captchaId: q1.body.id, captchaAnswer: '99' }
    });
    assert.equal(wrong.status, 400);

    const q2 = await api('/api/captcha');
    const right = await api('/api/register', {
        method: 'POST',
        body: { nickname: '验证丙', password: 'pw123456', captchaId: q2.body.id, captchaAnswer: '3' }
    });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.ok(right.body.token, '应当直接发下会话令牌');
});

test('验证码是一次性的：同一个 id 第二次用不认', async () => {
    const q = await api('/api/captcha');
    const first = await api('/api/register', {
        method: 'POST',
        body: { nickname: '一次性甲', password: 'pw123456', captchaId: q.body.id, captchaAnswer: '3' }
    });
    assert.equal(first.status, 200);

    const again = await api('/api/register', {
        method: 'POST',
        body: { nickname: '一次性乙', password: 'pw123456', captchaId: q.body.id, captchaAnswer: '3' }
    });
    assert.equal(again.status, 400, '用过的验证码不该还能再用');
});

test('瞎编的 id 一律挡掉', async () => {
    const r = await api('/api/register', {
        method: 'POST',
        body: { nickname: '瞎编甲', password: 'pw123456', captchaId: 'deadbeefdeadbeef00', captchaAnswer: '3' }
    });
    assert.equal(r.status, 400);
});

test('登录：同一个昵称连错两次之后，登录必须带验证码', async () => {
    const q0 = await api('/api/captcha');
    const reg = await api('/api/register', {
        method: 'POST',
        body: { nickname: '连错哥', password: 'pw123456', captchaId: q0.body.id, captchaAnswer: '3' }
    });
    assert.equal(reg.status, 200);

    const bad1 = await api('/api/login', { method: 'POST', body: { nickname: '连错哥', password: '不是密码' } });
    assert.equal(bad1.status, 401);
    assert.ok(!bad1.body.captchaRequired, '第一次错还不该要验证码');

    const bad2 = await api('/api/login', { method: 'POST', body: { nickname: '连错哥', password: '还不是' } });
    assert.equal(bad2.status, 401);
    assert.equal(bad2.body.captchaRequired, true, '第二次错之后要告诉前端「下次带验证码」');

    // 第三次：密码是对的，但没带验证码 —— 照样得先算题
    const noBox = await api('/api/login', { method: 'POST', body: { nickname: '连错哥', password: 'pw123456' } });
    assert.equal(noBox.status, 400);
    assert.match(noBox.body.error, /算式/);

    // 带上验证码（这个服务里题目固定是 1+1+1=3）就放行
    const q = await api('/api/captcha');
    const ok = await api('/api/login', {
        method: 'POST',
        body: { nickname: '连错哥', password: 'pw123456', captchaId: q.body.id, captchaAnswer: '3' }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token);
});

test('登录：验证码填错不放行，而且那一张会作废', async () => {
    const q0 = await api('/api/captcha');
    await api('/api/register', {
        method: 'POST',
        body: { nickname: '再连错', password: 'pw123456', captchaId: q0.body.id, captchaAnswer: '3' }
    });
    for (const pw of ['错一', '错二']) {
        await api('/api/login', { method: 'POST', body: { nickname: '再连错', password: pw } });
    }

    const q = await api('/api/captcha');
    const wrong = await api('/api/login', {
        method: 'POST',
        body: { nickname: '再连错', password: 'pw123456', captchaId: q.body.id, captchaAnswer: '7' }
    });
    assert.equal(wrong.status, 400);

    // 同一个 id 再用一次（这回答案是对的）也不认 —— 一次性核销
    const reuse = await api('/api/login', {
        method: 'POST',
        body: { nickname: '再连错', password: 'pw123456', captchaId: q.body.id, captchaAnswer: '3' }
    });
    assert.equal(reuse.status, 400, '用过的验证码不该还能用');
});

test('登录：没连错过的账号不该平白多一道题', async () => {
    const q0 = await api('/api/captcha');
    await api('/api/register', {
        method: 'POST',
        body: { nickname: '一次就中', password: 'pw123456', captchaId: q0.body.id, captchaAnswer: '3' }
    });
    const ok = await api('/api/login', { method: 'POST', body: { nickname: '一次就中', password: 'pw123456' } });
    assert.equal(ok.status, 200, '一次就对的不该被要验证码');
});

test('关掉验证码时（captcha:false）：接口要说实话，注册也不再要它', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-captcha-off-'));
    const off = await createServer({
        dataDir: dir, port: 0, skipCleanup: true, captcha: false,
        limits: {
            registerBurst: { windowMs: 60000, max: 1000, message: 'x' },
            register: { windowMs: 3600000, max: 1000, message: 'x' }
        }
    });
    await new Promise((r) => off.listen(0, '127.0.0.1', r));
    const port = off.address().port;
    try {
        const meta = await fetch('http://127.0.0.1:' + port + '/api/captcha').then((r) => r.json());
        assert.equal(meta.enabled, false, '关掉时前端靠这个字段把输入框收起来');

        const reg = await fetch('http://127.0.0.1:' + port + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: '免验证码', password: 'pw123456' })
        });
        assert.equal(reg.status, 200, '关掉之后不该再拦注册');
    } finally {
        await new Promise((r) => off.close(r));
    }
});
