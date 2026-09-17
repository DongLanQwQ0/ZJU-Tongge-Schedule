/**
 * 注册用的算术验证码：把一道个位数加减法画成 PNG 图片。
 *
 * 为什么自己画而不引 npm 验证码库：
 *   1. 项目卖点之一是零 npm 依赖（Docker 镜像几秒构建、不跑 npm install），
 *      引 canvas 那类库还会把 node:22-alpine 搞得要装编译工具链；
 *   2. 更要紧的是「答案不能被读走」：这类库多数把字符写成 SVG 的 <text>，
 *      攻击者看一眼页面源码就知道答案。这里整个算式是画进像素的，
 *      前端拿到的只有一张图。
 *
 * 只出灰度 PNG：node:zlib 压缩像素 + 自己算 CRC32，不依赖任何原生模块。
 *
 * 仅服务端使用（依赖 node:zlib）。浏览器端不加载本模块，
 * 也不在 /shared/* 的白名单里。
 */
'use strict';

const zlib = require('node:zlib');

/** 5×7 点阵字形。算术题只需要这 13 个符号 */
const GLYPHS = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
    '×': ['00000', '10001', '01010', '00100', '01010', '10001', '00000'],
    '÷': ['00100', '00000', '11111', '00000', '00100', '00000', '00000']
};

const GW = 5;                 // 字模宽（点）
const GH = 7;                 // 字模高（点）
const SCALE = 5;              // 一个点放大成 5×5 像素 —— 够大够清楚
const PAD = 8;                // 四周留白（像素）
const GAP = 3;                // 字符间距（点）
const INK = 20;               // 笔画灰度（近黑）
const PAPER = 245;            // 底色灰度（浅灰）

/**
 * 把 text 画到灰度画布上。每个字符上下左右抖一下，免得整行排得像印刷体。
 * @returns {{w:number,h:number,px:Uint8Array}}
 */
function draw(text, rng) {
    const chars = String(text).split('');
    // 式子长了就缩小一档，免得在 375px 手机上被挤到看不清（4 个点时仍然清楚）
    const scale = chars.length > 7 ? 4 : SCALE;
    const w = (chars.length * (GW + GAP) - GAP) * scale + PAD * 2;
    const h = GH * scale + PAD * 2;
    const px = new Uint8Array(w * h).fill(PAPER);

    chars.forEach((ch, i) => {
        const glyph = GLYPHS[ch];
        if (!glyph) return;
        const jx = Math.round((rng() - 0.5) * 2) * scale;   // ±1 点
        const jy = Math.round((rng() - 0.5) * 2) * scale;
        const x0 = PAD + i * (GW + GAP) * scale + jx;
        const y0 = PAD + jy;
        for (let r = 0; r < GH; r += 1) {
            for (let c = 0; c < GW; c += 1) {
                if (glyph[r][c] !== '1') continue;
                for (let dy = 0; dy < scale; dy += 1) {
                    for (let dx = 0; dx < scale; dx += 1) {
                        const x = x0 + c * scale + dx;
                        const y = y0 + r * scale + dy;
                        if (x < 0 || y < 0 || x >= w || y >= h) continue;
                        px[y * w + x] = INK;
                    }
                }
            }
        }
    });

    // 噪点：撒太密反而看不清，按面积给一个很小的比例
    const dots = Math.round(w * h * 0.004);
    for (let i = 0; i < dots; i += 1) {
        const x = Math.floor(rng() * w);
        const y = Math.floor(rng() * h);
        px[y * w + x] = 150 + Math.floor(rng() * 60);
    }
    return { w: w, h: h, px: px };
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (function () {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** 灰度 8 位 PNG（颜色类型 0）：每行 = 一个 filter 字节 + 该行像素 */
function toPng(w, h, px) {
    const stride = w + 1;
    const raw = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y += 1) {
        raw[y * stride] = 0;                                   // filter: none
        Buffer.from(px.buffer, px.byteOffset + y * w, w).copy(raw, y * stride + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;                                               // 位深
    ihdr[9] = 0;                                               // 颜色类型：灰度
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// ---------------------------------------------------------------- 出题

/** v 能被 2..9 里哪些数整除（商还得 ≥ 2，别一路除到 1 之后没得玩） */
function divisors(v) {
    const out = [];
    for (let b = 2; b <= 9; b += 1) if (v % b === 0 && v / b >= 2) out.push(b);
    return out;
}

/**
 * 出一道题（2–4 次四则运算），画成 PNG。
 *
 * 出题规则就是「五秒内能算出来」：
 *   · 每个数都是个位数，中间结果始终是 0–30 的整数；
 *   · 除法只挑能整除的因数，乘法保证积不超过 30；
 *   · 减法不出负数，也不会把中间值减到 0/1（否则后面乘除都没得接）。
 *
 * @param rng 注入随机源。测试里传固定函数（比如 () => 0）就能让题目可预测
 * @returns {{text:string, answer:string, png:Buffer}}
 */
function create(rng) {
    const r = typeof rng === 'function' ? rng : Math.random;
    const pick = function (n) { return Math.floor(r() * n); };

    const opCount = 2 + pick(3);              // 2..4 次运算
    let v = 1 + pick(9);                      // 起手 1..9
    let text = String(v);
    let sawAddSub = false;

    for (let i = 0; i < opCount; i += 1) {
        // 只允许「先乘除、后加减」的次序。
        // 否则「5+4÷3-1」这种式子，程序从左往右算是 2，人按运算优先级算出来是分数 ——
        // 题目和答案就对不上了。限制次序之后两种读法必然一致。
        //
        // 注意加法要卡 v < 30：v 一旦到 30，min(9, 30-v) 是 0，pick(0) 返回 0，
        // b 就成了 1，结果会被顶到 31 去。
        const cand = [];
        if (v < 30) cand.push('+');
        if (v >= 2) cand.push('-');
        if (!sawAddSub) {
            if (v >= 2 && Math.floor(30 / v) >= 2) cand.push('×');
            if (divisors(v).length) cand.push('÷');
        }
        const op = cand[pick(cand.length)];
        if (op === '+' || op === '-') sawAddSub = true;

        let b;
        if (op === '+') b = 1 + pick(Math.min(9, 30 - v));
        else if (op === '-') b = 1 + pick(Math.min(9, v - 1));
        else if (op === '×') b = 2 + pick(Math.min(9, Math.floor(30 / v)) - 1);
        else b = divisors(v)[pick(divisors(v).length)];

        if (op === '+') v += b;
        else if (op === '-') v -= b;
        else if (op === '×') v *= b;
        else v /= b;

        text += op + b;
    }

    text += '=';
    const img = draw(text, r);
    return { text: text, answer: String(v), png: toPng(img.w, img.h, img.px) };
}

module.exports = { create: create, draw: draw, toPng: toPng, GLYPHS: GLYPHS };
