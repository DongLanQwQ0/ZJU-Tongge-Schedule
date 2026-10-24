'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const cutoff = Date.parse('2027-01-24T00:00:00+08:00');
function migration(host = '111.228.3.50', now = cutoff - 1, embedded = false, search = '', oldAvailable = false) {
    const calls = [], events = {};
    let currentTime = now;
    const context = {Date: {parse:Date.parse, now:() => currentTime}, URLSearchParams, AbortController,
        fetch:async () => ({ok:true,json:async () => ({oldAvailable})}),
        window:{__tonggeServerBase:embedded ? 'https://111.228.3.50/tongge/' : null,
            location:{hostname:host, search, replace:url => calls.push(url)},
            setTimeout, clearTimeout, setInterval:fn => {events.tick = fn;}},
        document:{addEventListener:(name, fn) => {events[name]=fn;},
            createElement:() => ({setAttribute(){}}), body:{firstChild:null, insertBefore:node => {events.notice=node;}}}};
    vm.runInNewContext(read('migration.js'), context);
    return {calls, events, window:context.window, time:value => {currentTime=value;}};
}
test('deadline is exactly Beijing midnight; no early redirect or permanent failure latch', () => {
    const before = migration();
    assert.deepEqual(before.calls, []);
    before.events.DOMContentLoaded();
    assert.match(before.events.notice.innerHTML, /下载最新版 APK/);
    assert.match(before.events.notice.innerHTML, /2027 年 1 月 24 日/);
    before.time(cutoff); before.events.tick();
    assert.deepEqual(before.calls, ['http://123.207.180.163/tongge/']);
    assert.deepEqual(migration('111.228.3.50', cutoff).calls, before.calls);
});
test('before deadline either official address can fail over, without private URL data', () => {
    for (const [host, other] of [['111.228.3.50','http://123.207.180.163'], ['123.207.180.163','https://111.228.3.50']]) {
        const value = migration(host, cutoff - 100000, false, '?token=private&code=invite');
        value.window.TonggeMigration.onFailure(); value.window.TonggeMigration.onFailure();
        assert.deepEqual(value.calls, [other + '/tongge/?tongge-failover=' + (cutoff - 100000)]);
    }
});
test('both servers failing cannot create a redirect loop; later outage allows a new attempt', () => {
    const value = migration('123.207.180.163', cutoff - 100000, false, '?tongge-failover=' + (cutoff - 100001));
    value.window.TonggeMigration.onFailure(); assert.deepEqual(value.calls, []);
    value.time(cutoff - 60000); value.window.TonggeMigration.onFailure();
    assert.equal(value.calls.length, 1);
});
test('after deadline the new address never falls back to retired old server', () => {
    const value = migration('123.207.180.163', cutoff);
    value.window.TonggeMigration.onFailure(); assert.deepEqual(value.calls, []);
});
test('APK, custom hosts, and local previews do not run browser migration', () => {
    for (const value of [migration('111.228.3.50', cutoff, true), migration('localhost', cutoff), migration('custom.example', cutoff)]) {
        assert.deepEqual(value.calls, []); assert.equal(value.window.TonggeMigration, undefined);
    }
    assert.ok(read('index.html').includes('<script src="migration.js"></script>'));
});
function api(fetch, native = false, timers = {setTimeout, clearTimeout}, now = cutoff - 1,
        documentBase = 'https://111.228.3.50/tongge/') {
    const calls = [];
    const window = {location:{}, TonggeMigration:{onFailure:() => calls.push('fail')},
        __tonggeServerBase:native ? 'https://111.228.3.50/tongge/' : null};
    vm.runInNewContext(read('api.js'), {window, fetch, URL, AbortController, ...timers, Date:{parse:Date.parse,now:() => now},
        document:{baseURI:documentBase}, localStorage:{getItem:() => null, setItem(){}, removeItem(){}}});
    return {api:window.API, calls, window};
}
test('network/body failures and 5xx request failover, never replay a POST', async () => {
    for (const failure of ['network','body',503]) {
        let attempts = 0;
        const value = api(async () => { attempts++;
            if (failure === 'network') throw Error('offline');
            return {status:failure === 'body' ? 200 : failure, ok:false,
                text:async () => {if (failure === 'body') throw Error('stream closed'); return '{}';}};
        });
        await assert.rejects(value.api.request('api/groups', 'POST', {name:'one'}));
        assert.equal(attempts, 1); assert.deepEqual(value.calls, ['fail']);
    }
});
test('authentication, permission and validation errors do not switch servers', async () => {
    for (const status of [400,401,403,404,409,429]) {
        const value = api(async () => ({status,ok:false,text:async () => '{}'}));
        await assert.rejects(value.api.me()); assert.deepEqual(value.calls, []);
    }
});
test('Android failures request native reconnect, not external website navigation', async () => {
    const value = api(async () => {throw Error('offline');}, true);
    await assert.rejects(value.api.me());
    assert.equal(value.window.location.href, 'tongge://reconnect');
    assert.deepEqual(value.calls, []);
});
test('hung API fetch is bounded and triggers failover', async () => {
    let timeout;
    const value = api((_url, {signal}) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('timeout')))), false,
        {setTimeout:fn => {timeout=fn; return 1;}, clearTimeout(){}});
    const pending = value.api.me(); timeout();
    await assert.rejects(pending); assert.deepEqual(value.calls, ['fail']);
});

test('new-site visitors return to healthy old primary before deadline', async () => {
    const value = migration('123.207.180.163', cutoff - 100000, false, '', true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(value.calls, ['https://111.228.3.50/tongge/']);
});
test('recovery probe cannot bounce a just-failed old site back immediately', async () => {
    const value = migration('123.207.180.163', cutoff - 100000, false,
        '?tongge-failover=' + (cutoff - 100001), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(value.calls, []);
    value.time(cutoff - 60000); await value.events.tick();
    assert.deepEqual(value.calls, ['https://111.228.3.50/tongge/']);
});
test('deadline blocks old-server POST before it can transmit, also in Android', async () => {
    for (const native of [false,true]) {
        let requests = 0;
        const value = api(async () => {requests++;}, native, {setTimeout,clearTimeout}, cutoff);
        await assert.rejects(value.api.request('api/groups','POST',{name:'private'}), /旧服务器已停用/);
        assert.equal(requests, 0);
        if (native) assert.equal(value.window.location.href, 'tongge://reconnect');
        else assert.deepEqual(value.calls, ['fail']);
    }
});
test('migration health endpoint coalesces probes and reports only availability', async () => {
    const os = require('node:os');
    const {createServer} = require('../server.js');
    for (const available of [true,false,'reject','retired']) {
        let probes = 0;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(),'tongge-migration-'));
        const server = await createServer({vault:false,captcha:false,dataDir:dir,skipCleanup:true,
            migrationNow:() => available === 'retired' ? cutoff : cutoff - 1,
            migrationHealth:async () => {probes++; if (available === 'reject') throw Error('offline'); return available;}});
        try {
            await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
            const base = 'http://127.0.0.1:' + server.address().port;
            const responses = await Promise.all([fetch(base+'/api/migration'),fetch(base+'/api/migration')]);
            for (const response of responses) {
                assert.equal(response.headers.get('cache-control'),'no-store');
                assert.deepEqual(await response.json(), {oldAvailable:available === true});
            }
            assert.equal(probes,available === 'retired' ? 0 : 1);
        } finally {await new Promise(resolve => server.close(resolve));}
    }
});

test('static index.html entry also blocks expired old deployment before fetch', async () => {
    let requests = 0;
    const value = api(async () => {requests++;},false,{setTimeout,clearTimeout},cutoff,
        'https://111.228.3.50/tongge/index.html?code=private');
    await assert.rejects(value.api.request('api/groups','POST',{name:'one'}),/旧服务器已停用/);
    assert.equal(requests,0); assert.deepEqual(value.calls,['fail']);
});
