/**
 * 真实来源 IP 的提取规则。
 *
 * 这一组用例守的是"限流到底按谁分桶"：站点在反向代理后面时，拿不到真实来源
 * 就会变成**全站共用一个桶**。而 `X-Forwarded-For` 又是客户端能自己填的，
 * 所以规则必须是"只有直连方可信时才看它"，否则限流形同虚设。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveClientIp, parseTrustedProxies } = require('../server.js');

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

const DEFAULT = parseTrustedProxies();                      // 默认网段
const LOOPBACK = parseTrustedProxies('127.0.0.1');          // 只信本机
const NONE = parseTrustedProxies('none');                   // 谁都不信

// 默认网段条数。改 server.js 的清单时这里会失配，提醒你顺手确认相关用例
const DEFAULT_TRUSTED_COUNT = 9;

test('直连方不可信：完全忽略 X-Forwarded-For（防伪造绕过限流）', () => {
    // 公网直连 + 自己填一个 XFF：必须仍然用直连地址
    assert.equal(
        resolveClientIp(req('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' }), DEFAULT),
        '203.0.113.9'
    );
    // 配了 none 之后，连内网直连也不看那些头
    assert.equal(
        resolveClientIp(req('172.17.0.1', { 'x-forwarded-for': '1.2.3.4' }), NONE),
        '172.17.0.1'
    );
});

test('直连方可信：从右往左找第一个不可信地址（左边那个是客户端自己填的）', () => {
    // 真实链条：client 1.2.3.4 → 反代 172.17.0.1（可信）
    assert.equal(
        resolveClientIp(req('172.17.0.1', { 'x-forwarded-for': '1.2.3.4, 172.17.0.1' }), DEFAULT),
        '1.2.3.4'
    );
    // 客户端伪造：前面多塞一段，真实来源仍然是紧挨着可信代理的那个
    assert.equal(
        resolveClientIp(req('172.17.0.1', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4, 172.17.0.1' }), DEFAULT),
        '1.2.3.4'
    );
    // 只有一段（反代没追加自己）也认
    assert.equal(
        resolveClientIp(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), LOOPBACK),
        '1.2.3.4'
    );
});

test('整条链都是可信代理、或没有头：只能认直连方', () => {
    assert.equal(
        resolveClientIp(req('172.17.0.1', { 'x-forwarded-for': '10.0.0.5, 172.17.0.1' }), DEFAULT),
        '172.17.0.1'
    );
    assert.equal(resolveClientIp(req('172.17.0.1'), DEFAULT), '172.17.0.1');
    assert.equal(resolveClientIp(req('172.17.0.1', { 'x-forwarded-for': '  ,  ' }), DEFAULT), '172.17.0.1');
    // 链里有垃圾值（不是 IP）时忽略它们，不崩
    assert.equal(
        resolveClientIp(req('172.17.0.1', { 'x-forwarded-for': 'garbage, 1.2.3.4' }), DEFAULT),
        '1.2.3.4'
    );
});

test('没有 XFF 时退到 X-Real-IP（nginx 常见写法）', () => {
    assert.equal(resolveClientIp(req('127.0.0.1', { 'x-real-ip': '5.6.7.8' }), LOOPBACK), '5.6.7.8');
    // XFF 优先于 X-Real-IP
    assert.equal(
        resolveClientIp(req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '5.6.7.8' }), LOOPBACK),
        '1.1.1.1'
    );
    // X-Real-IP 是可信代理自己，等于没给
    assert.equal(resolveClientIp(req('127.0.0.1', { 'x-real-ip': '127.0.0.1' }), LOOPBACK), '127.0.0.1');
});

test('IPv4-mapped IPv6 归一化（Node 双栈 socket 会给 ::ffff:x）', () => {
    assert.equal(resolveClientIp(req('::ffff:172.17.0.1', { 'x-forwarded-for': '1.2.3.4' }), DEFAULT), '1.2.3.4');
    assert.equal(resolveClientIp(req('::ffff:203.0.113.9'), DEFAULT), '203.0.113.9');
});

test('IPv6：::1 默认可信，公网 IPv6 不可信', () => {
    assert.equal(resolveClientIp(req('::1', { 'x-forwarded-for': '2001:db8::1' }), DEFAULT), '2001:db8::1');
    assert.equal(
        resolveClientIp(req('2001:db8::9', { 'x-forwarded-for': '1.2.3.4' }), DEFAULT),
        '2001:db8::9'
    );
});

test('自定义清单：只有列出来的网段才可信', () => {
    const onlyExample = parseTrustedProxies('198.51.100.0/24');
    assert.equal(
        resolveClientIp(req('198.51.100.7', { 'x-forwarded-for': '1.2.3.4' }), onlyExample),
        '1.2.3.4'
    );
    // 172.17.0.1 是默认可信、但不在自定义清单里 -> 不信它的头
    assert.equal(
        resolveClientIp(req('172.17.0.1', { 'x-forwarded-for': '1.2.3.4' }), onlyExample),
        '172.17.0.1'
    );
});

test('配置解析：none / 空 / 单 IP / CIDR / 非法值', () => {
    assert.equal(parseTrustedProxies('none').count, 0);
    assert.equal(parseTrustedProxies('off').count, 0);
    assert.equal(parseTrustedProxies('').count, DEFAULT_TRUSTED_COUNT);
    assert.equal(parseTrustedProxies('127.0.0.1').count, 1);
    assert.equal(parseTrustedProxies('127.0.0.1, 10.0.0.0/8 ,::1').count, 3);
    assert.equal(parseTrustedProxies('127.0.0.1').configured, true);
    assert.equal(parseTrustedProxies('').configured, false);
    assert.throws(() => parseTrustedProxies('不是IP'), /不是合法 IP/);
    assert.throws(() => parseTrustedProxies('10.0.0.0/99'), /前缀长度不合法/);
});
