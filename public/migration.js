/* Official-server migration. APK assets use their native server selection instead. */
(function () {
    'use strict';
    if (window.__tonggeServerBase) return;
    var OLD_BASE = 'https://111.228.3.50/tongge/';
    var NEW_BASE = 'http://123.207.180.163/tongge/';
    var CUTOVER = Date.parse('2027-01-24T00:00:00+08:00');
    var old = window.location.hostname === '111.228.3.50';
    if (!old && window.location.hostname !== '123.207.180.163') return;
    var lastAttempt = Number(new URLSearchParams(window.location.search).get('tongge-failover')) || 0;
    var leaving = false;
    var checking = false;
    function leave(target) {
        if (leaving) return;
        leaving = true;
        // No tokens, query parameters or private invitation fragments cross servers.
        window.location.replace(target);
    }
    window.TonggeMigration = {
        onFailure: function () {
            if (Date.now() >= CUTOVER) { if (old) leave(NEW_BASE); return; }
            // One alternate per outage; if both fail, keep the error instead of redirecting forever.
            if (!lastAttempt || Date.now() - lastAttempt >= 30000)
                leave((old ? NEW_BASE : OLD_BASE) + '?tongge-failover=' + Date.now());
        }
    };
    function checkDate() { if (old && Date.now() >= CUTOVER) leave(NEW_BASE); }
    checkDate();
    async function preferOld() {
        checkDate();
        if (old || leaving || checking || Date.now() >= CUTOVER
                || (lastAttempt && Date.now() - lastAttempt < 30000)) return;
        // A new-site backend probes the old server, avoiding browser cross-origin/CORS failures.
        checking = true;
        var controller = new AbortController();
        var timer = window.setTimeout(function () { controller.abort(); }, 4000);
        try {
            var response = await fetch(NEW_BASE + 'api/migration', {signal:controller.signal, cache:'no-store'});
            var result = await response.json();
            if (response.ok && result.oldAvailable === true && Date.now() < CUTOVER) leave(OLD_BASE);
        } catch (_) { /* Keep the working fallback; next foreground check retries the old server. */ }
        finally { checking = false; window.clearTimeout(timer); }
    }
    preferOld();
    window.setInterval(preferOld, 30000);
    document.addEventListener('visibilitychange', preferOld);
    document.addEventListener('DOMContentLoaded', function () {
        if (leaving) return;
        var notice = document.createElement('aside');
        notice.className = 'migration-notice';
        notice.setAttribute('aria-label', '服务器迁移');
        notice.innerHTML = '<strong>同格将于 2027 年 1 月 24 日迁移</strong>' +
            '<p>强烈建议<a href="https://github.com/DongLanQwQ0/ZJU-Tongge-Schedule-Android/releases/latest/download/Tongge.apk">下载最新版 APK</a>，并收藏<a href="' + NEW_BASE + '">新网址</a>。</p>' +
            '<p>此前优先使用旧服务器，连接失败时轮换尝试；当天起仅使用新地址。</p>';
        if (Date.now() >= CUTOVER) return;
        document.body.insertBefore(notice, document.body.firstChild);
    });
})();
