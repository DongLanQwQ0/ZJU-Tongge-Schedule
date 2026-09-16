/**
 * 同格 —— 找个课搭子一起上课。前端主逻辑。
 *
 * 依赖：共享纯函数（DSH.periods / DSH.ics / DSH.weeks / DSH.compare）、API、qrcode、html2canvas。
 */
(function () {
    'use strict';

    var periods = window.DSH.periods;
    var ics = window.DSH.ics;
    var weeks = window.DSH.weeks;
    var cmp = window.DSH.compare;
    var config = window.DSH.config || {};

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ------------------------------------------------------------ Toast

    var toastTimer = null;
    function toast(msg, isError) {
        var el = $('#toast');
        el.textContent = msg;
        el.className = 'show' + (isError ? ' err' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.className = ''; }, 3200);
    }

    // ------------------------------------------------------------ 通用弹窗

    /**
     * 一次性强调：把 class 摘掉、强制重排、再加回来，动画才会重跑。
     * 不去掉直接重加是不行的 —— 浏览器认为 class 没变，不会重新播。
     */
    function bump(el, cls) {
        if (!el) return;
        var c = cls || 'bump';
        el.classList.remove(c);
        void el.offsetWidth;      // 强制重排，动画状态机归零
        el.classList.add(c);
        setTimeout(function () { el.classList.remove(c); }, 600);
    }

    /**
     * 关弹窗：先播一段淡出再真正 hidden，和打开时的弹入对称。
     *
     * 用 animationend 收尾 + 超时兜底。兜底是必须的：系统开了「减弱动态效果」
     * 或者动画被别处禁掉时，animationend 可能不来，没有兜底弹窗就永远关不掉。
     */
    function closeModal(el) {
        if (!el || el.hidden) return;
        el.classList.add('closing');
        var done = false;
        function fin() {
            if (done) return;
            done = true;
            el.removeEventListener('animationend', fin);
            el.classList.remove('closing');
            el.hidden = true;
        }
        el.addEventListener('animationend', fin);
        setTimeout(fin, 220);
    }

    /** 动态创建的弹窗用完要整个摘掉，同样先淡出 */
    function dismiss(modal) {
        modal.classList.add('closing');
        var done = false;
        function fin() {
            if (done) return;
            done = true;
            if (modal.parentNode) modal.parentNode.removeChild(modal);
        }
        modal.addEventListener('animationend', fin);
        setTimeout(fin, 220);
    }

    /**
     * 数字滚动。管理页那几个统计数字如果直接跳变，很容易看漏；
     * 让它从旧值数到新值，眼睛能跟上。
     */
    function countUp(el, to) {
        var from = Number(el.getAttribute('data-v') || 0);
        el.setAttribute('data-v', String(to));
        if (from === to) { el.textContent = String(to); return; }
        var t0 = performance.now();
        var dur = 420;
        (function step(t) {
            var k = Math.min(1, (t - t0) / dur);
            var eased = 1 - Math.pow(1 - k, 3);        // easeOutCubic
            el.textContent = String(Math.round(from + (to - from) * eased));
            if (k < 1) requestAnimationFrame(step);
        })(t0);
    }

    function askText(opts) {
        return new Promise(function (resolve) {
            var modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML =
                '<div class="inner" style="text-align:left;max-width:360px">' +
                '<h2 style="font-size:16px;margin-bottom:10px"></h2>' +
                '<p class="tiny" style="margin-bottom:10px"></p>' +
                '<input class="input" maxlength="10">' +
                '<div class="row" style="margin-top:14px">' +
                '<button class="btn secondary" data-x="cancel">取消</button>' +
                '<button class="btn" data-x="ok">确定</button>' +
                '</div></div>';
            $('h2', modal).textContent = opts.title || '';
            var hint = $('p', modal);
            if (opts.hint) hint.textContent = opts.hint; else hint.remove();

            var input = $('input', modal);
            if (opts.password) input.type = 'password';
            input.placeholder = opts.placeholder || '';
            input.maxLength = opts.maxlength || 20;
            if (opts.mono) input.classList.add('mono');
            if (opts.value) input.value = opts.value;

            function done(val) {
                dismiss(modal);
                resolve(val);
            }
            modal.addEventListener('click', function (e) {
                var x = e.target.getAttribute && e.target.getAttribute('data-x');
                if (x === 'cancel') done(null);
                if (x === 'ok') {
                    var v = input.value.trim();
                    if (!v) { input.classList.add('invalid'); input.focus(); return; }
                    if (opts.pattern && !opts.pattern.test(v)) {
                        input.classList.add('invalid');
                        toast(opts.patternHint || '格式不对', true);
                        return;
                    }
                    done(v);
                }
            });
            input.addEventListener('input', function () { input.classList.remove('invalid'); });
            input.addEventListener('keydown', function (e) { if (e.key === 'Enter') $('[data-x=ok]', modal).click(); });
            document.body.appendChild(modal);
            setTimeout(function () { input.focus(); }, 50);
        });
    }

    function askConfirm(title, message, okText) {
        return new Promise(function (resolve) {
            var modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML =
                '<div class="inner" style="max-width:340px">' +
                '<h2 style="font-size:16px;margin-bottom:8px"></h2>' +
                '<p class="tiny" style="margin-bottom:16px"></p>' +
                '<div class="row">' +
                '<button class="btn secondary" data-x="cancel">取消</button>' +
                '<button class="btn" data-x="ok"></button>' +
                '</div></div>';
            $('h2', modal).textContent = title;
            $('p', modal).textContent = message;
            $('[data-x=ok]', modal).textContent = okText || '确定';
            modal.addEventListener('click', function (e) {
                var x = e.target.getAttribute && e.target.getAttribute('data-x');
                if (x === 'cancel') { dismiss(modal); resolve(false); }
                if (x === 'ok') { dismiss(modal); resolve(true); }
            });
            document.body.appendChild(modal);
        });
    }

    // ------------------------------------------------------------ 状态

    var state = {
        me: null,
        groups: [],
        group: null,
        weekIndex: null,
        compareWith: null,
        pendingCode: null,
        local: { a: [], b: [], nameA: '', nameB: '', weekIndex: null },
        currentWindow: null,
        admin: null,
        screen: null,
        // 当前邀请卡片里展示的是哪一枚码。null = 群主自己的永久码
        activeInvite: null,
        newInviteTtl: 'never'
    };

    function qs(name) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
        return m ? decodeURIComponent(m[1]) : null;
    }

    // ------------------------------------------------------------ 屏幕切换与浏览器历史

    var backTo = null;
    var navStarted = false;   // 第一次切屏用 replaceState，否则第一下返回就白按
    var navSilent = false;    // popstate 触发的重画不要再压新记录
    var navDepth = 0;         // 本次会话自己压了多少层，存在历史记录里

    /** 只负责把某一屏画出来，不碰历史 */
    function renderScreen(id, opts) {
        opts = opts || {};
        state.screen = id;
        $$('.screen').forEach(function (s) { s.classList.toggle('active', s.id === 'screen-' + id); });
        var topbar = $('#topbar');
        topbar.hidden = id === 'auth';
        $('#btn-back').hidden = !opts.back;
        backTo = opts.back || null;
        $('#topbar-title').textContent = opts.title || '同格';
        $('#topbar-who').textContent = state.me ? state.me.nickname : '';
        $('#btn-logout').hidden = !state.me;
        // 管理入口挂在顶栏上，任何页面都够得着；普通人看不到这个按钮
        $('#btn-admin').hidden = !(state.me && state.me.admin);
        window.scrollTo(0, 0);
    }

    /**
     * 切屏，并记一条浏览器历史 —— 这样手机上的侧滑返回是「退回上一屏」，
     * 而不是直接退出网页。切屏逻辑本身在 renderScreen 里。
     *
     * @param opts.replace 用 replaceState 覆盖当前记录。用于「不该能后退回去」的跳转：
     *                     过口令门、登录成功、退出登录、登录过期被踢回登录页。
     */
    function show(id, opts) {
        opts = opts || {};
        var changed = state.screen !== id;
        renderScreen(id, opts);
        if (!changed || navSilent) return;

        if (!navStarted) {
            navStarted = true;
            navDepth = 0;
            history.replaceState({ dsh: id, d: 0 }, '');
            return;
        }
        if (opts.replace) {
            history.replaceState({ dsh: id, d: navDepth }, '');
            return;
        }
        navDepth += 1;
        history.pushState({ dsh: id, d: navDepth }, '');
    }

    /** 返回手势落下后，按那条历史记录把屏幕重新画出来 */
    function restoreScreen(id) {
        if (id === 'local') {
            show('local', { title: '本地快速比对', back: goHome });
            initLocalOnce();
            return;
        }
        if (id === 'admin') {
            if (state.me && state.me.admin) return openAdmin();
            return fallbackHome();
        }
        if (id === 'group') {
            if (state.group) return openGroup(state.group.code);
            return fallbackHome();
        }
        if (id === 'invites') {
            // 返回手势落到邀请页时，群数据可能还在但已被解散
            if (state.group && state.group.isCreator) return openInvites();
            return fallbackHome();
        }
        if (id === 'compare') {
            // 用群组里最新的那份成员数据，别拿旧快照
            var m = state.group && state.compareWith && state.group.members.filter(function (x) {
                return x.id === state.compareWith.id;
            })[0];
            if (m) return openCompare(m);
            return fallbackHome();
        }
        if (id === 'auth') return show('auth', { title: '同格' });
        return fallbackHome();
    }

    /** 历史记录指向的屏幕已经没法还原（比如群组被解散了）：把这条记录改写成首页 */
    function fallbackHome() {
        history.replaceState({ dsh: 'home', d: navDepth }, '');
        return goHome();
    }

    function initHistory() {
        // 进入应用时先占住当前这条记录，这样第一下返回不会把我们顶出网页
        history.replaceState({ dsh: state.screen || 'auth', d: 0 }, '');

        window.addEventListener('popstate', function (e) {
            var st = e.state;
            // 返回到「进入本应用之前」的那条记录：交给浏览器，正常离开
            if (!st || !st.dsh) return;
            navDepth = st.d || 0;
            navSilent = true;
            try { restoreScreen(st.dsh); } finally { navSilent = false; }
        });
    }

    // ------------------------------------------------------------ 校验

    var NICK_RE = /^[^\s/\\:*?"<>|][^\u0000-\u001f/\\:*?"<>|]{0,9}$/;

    function cleanName(raw) {
        return String(raw || '').replace(/[/\\:*?"<>|]/g, '_').trim() || '';
    }

    function readIcsFile(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function (e) {
                try { resolve(ics.parseICS(e.target.result)); }
                catch (err) { reject(err); }
            };
            reader.onerror = function () { reject(new Error('文件读取失败')); };
            reader.readAsText(file);
        });
    }

    /** 从 .ics 文件名里智能提取昵称（Elychron / Celechron 导出常见格式） */
    function extractNameFromFileName(fileName) {
        var name = String(fileName).replace(/\.(ics|txt)$/i, '');
        name = name.replace(/(elychron|celechron)?[_\-\s]*schedule[_\-\s]*\d*/gi, '');
        name = name.replace(/(的)?(课表|课程表|schedule)/gi, '');
        name = name.trim().replace(/^[_\-\s]+|[_\-\s]+$/g, '');
        return (name.length >= 1 && name.length <= 6) ? name : '';
    }

    async function ingestFile(file) {
        var slots = await readIcsFile(file);
        if (!slots.length) throw new Error('没解析出课程，确认是 .ics 课表文件吗？');
        return ics.toStoredSlots(slots);
    }

    // ------------------------------------------------------------ 登录 / 注册

    var authMode = 'login';

    /** 把错误直接摆在表单里。传空串就清掉 */
    function authError(msg) {
        var el = $('#auth-error');
        el.textContent = msg || '';
        el.hidden = !msg;
    }

    function clearAuthMarks() {
        authError('');
        ['#auth-nickname', '#auth-password', '#auth-confirm'].forEach(function (sel) {
            $(sel).classList.remove('invalid');
        });
    }

    function initAuth() {
        $('#auth-tabs').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-mode]');
            if (!btn) return;
            authMode = btn.getAttribute('data-mode');
            $$('#auth-tabs button').forEach(function (b) { b.classList.toggle('on', b === btn); });
            var isReg = authMode === 'register';
            $('#auth-confirm-field').hidden = !isReg;
            $('#auth-tip').hidden = !isReg;
            $('#auth-submit').textContent = isReg ? '注册并登录' : '登录';
            $('#auth-password').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
            clearAuthMarks();
        });

        // 回车提交交给 form 自己处理，不用逐个 input 挂 keydown
        $('#auth-form').addEventListener('submit', function (e) {
            e.preventDefault();
            doAuth();
        });

        // 一开始重新输入就把上一次的红字擦掉，别让它一直杵在那
        ['#auth-nickname', '#auth-password', '#auth-confirm'].forEach(function (sel) {
            $(sel).addEventListener('input', function () {
                $(sel).classList.remove('invalid');
                authError('');
            });
        });
    }

    async function doAuth() {
        var nickEl = $('#auth-nickname');
        var pwEl = $('#auth-password');
        var confirmEl = $('#auth-confirm');
        var nickname = nickEl.value.trim();
        var password = pwEl.value;
        var confirm = confirmEl.value;
        var btn = $('#auth-submit');
        var isReg = authMode === 'register';

        clearAuthMarks();

        if (!NICK_RE.test(nickname)) {
            nickEl.classList.add('invalid');
            nickEl.focus();
            return authError('昵称 1–10 个字，不能含 / \\ : * ? " < > |');
        }
        if (password.length < 6) {
            pwEl.classList.add('invalid');
            pwEl.focus();
            return authError('密码至少 6 位');
        }
        if (isReg && password !== confirm) {
            confirmEl.classList.add('invalid');
            confirmEl.focus();
            return authError('两次输入的密码不一样');
        }

        btn.disabled = true;
        btn.textContent = isReg ? '注册中…' : '登录中…';
        try {
            var r = isReg
                ? await API.register(nickname, password)
                : await API.login(nickname, password);
            API.setToken(r.token);
            state.me = await API.me();
            toast(isReg ? '注册成功，欢迎！' : '欢迎回来，' + state.me.nickname);
            await goHome({ replace: true });   // 登录页不该能后退回去
            if (state.pendingCode) {
                var code = state.pendingCode;
                state.pendingCode = null;
                await joinByCode(code);
            }
        } catch (e) {
            // 具体原因留在表单里（toast 三秒就没了，容易错过）
            authError(e.message);
            toast(e.message, true);
            if (e.status === 401) {
                // 密码清掉并聚焦，省得对着同一个错密码反复试
                pwEl.classList.add('invalid');
                pwEl.value = '';
                pwEl.focus();
            } else if (e.status === 429) {
                // 被节流了，提示改个说法免得让人以为密码错了
                authError(e.message);
            } else if (e.status === 0) {
                authError('连不上服务器，检查一下是不是同一个 WiFi');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = isReg ? '注册并登录' : '登录';
        }
    }

    function logout() {
        API.logout().catch(function () {}).then(function () {
            API.setToken('');
            state.me = null;
            state.groups = [];
            state.group = null;
            show('auth', { title: '同格', replace: true });
        });
    }

    // ------------------------------------------------------------ 首页

    async function goHome(opts) {
        show('home', { title: '同格', replace: opts && opts.replace });
        renderCourseStatus();
        await loadGroups();
    }

    // ------------------------------------------------------------ 管理页

    var AUDIT_LABEL = {
        register: '注册',
        register_blocked: '注册被限流',
        delete_account: '注销账号',
        admin_grant: '授予管理员',
        admin_revoke: '撤销管理员',
        admin_grant_cli: '授予管理员（命令行）',
        admin_revoke_cli: '撤销管理员（命令行）',
        admin_delete_user: '删除账号',
        admin_delete_group: '解散群组',
        admin_reset_password: '重置密码'
    };

    /** 审计日志一行的说明文字，只挑存在的字段拼 */
    function auditDetail(e) {
        var bits = [];
        if (e.by) bits.push('by ' + e.by);
        if (e.nickname && e.nickname !== e.target) bits.push(e.nickname);
        if (e.target) bits.push('→ ' + e.target);
        if (e.group) bits.push('群「' + e.group + '」');
        if (e.code && !e.group) bits.push('码 ' + e.code);
        if (e.ip) bits.push(e.ip);
        if (e.reason) bits.push(e.reason);
        if (e.transferred && e.transferred.length) bits.push('移交 ' + e.transferred.join('、'));
        if (e.disbanded && e.disbanded.length) bits.push('解散 ' + e.disbanded.join('、'));
        return bits.join(' · ');
    }

    async function openAdmin() {
        show('admin', { title: '管理', back: goHome });
        $('#admin-users').innerHTML = '<div class="spinner">加载中…</div>';
        try {
            state.admin = await API.adminOverview();
        } catch (e) {
            // 401 已经由 onUnauthorized 统一处理（跳登录页）。
            // 这里再 fallbackHome() 会把人从登录页又拽回一个「已登出」的首页 ——
            // 全量测试里就是这么抓出来的。
            if (e.status === 401) return;
            toast(e.message, true);
            return fallbackHome();
        }
        $('#admin-user-filter').value = '';
        renderAdmin();
    }

    function adminUserRow(u) {
        var tags = '';
        if (u.admin) tags += '<span class="chip-lv same">管理员</span>';
        if (u.suspect) tags += '<span class="chip-lv cross">待复核</span>';
        if (u.dormant) tags += '<span class="chip-lv unknown">待清理</span>';
        else if (!u.courseCount) tags += '<span class="chip-lv nearby">未传课表</span>';

        // loginCount 为 0 只代表「这个统计上线之后没登录过」，不代表没登录过 ——
        // 老账号本来就没有记录，别把「没记录」说成「没来过」
        var seen = u.lastLoginAt
            ? '最后登录 ' + fmtTime(u.lastLoginAt) + (u.lastLoginIp ? ' · ' + esc(u.lastLoginIp) : '')
            : '无登录记录（统计上线前注册的）';
        var logins = u.loginCount ? '登录 ' + u.loginCount + ' 次' : '无登录记录';
        var idle = u.idleDays >= 1 ? u.idleDays + ' 天没露面' : '最近还活跃';

        return '<div class="item admin-row">' +
            '<div class="grow"><div class="title">' + esc(u.nickname) + '</div>' +
            '<div class="sub">' + u.courseCount + ' 个时段 · ' + logins + ' · ' + idle + '</div>' +
            '<div class="sub">' + seen + '</div>' +
            '<div class="sub">注册 ' + fmtTime(u.regAt) +
            (u.regIp && u.regIp !== u.lastLoginIp ? ' · ' + esc(u.regIp) : '') + '</div>' +
            (tags ? '<div class="overlap">' + tags + '</div>' : '') +
            '</div>' +
            '<div class="row-acts">' +
            '<button class="row-note" data-reset="' + esc(u.id) + '">重置密码</button>' +
            '<button class="row-note" data-grant="' + esc(u.id) + '">' +
            (u.admin ? '撤管' : '授权') + '</button>' +
            '<button class="row-remove" data-deluser="' + esc(u.id) + '">删除</button>' +
            '</div></div>';
    }

    function adminGroupRow(g) {
        return '<div class="item admin-row">' +
            '<div class="grow"><div class="title">' + esc(g.name) + '</div>' +
            '<div class="sub">码 ' + esc(g.code) + ' · ' + g.memberCount + ' 人 · 群主 ' + esc(g.owner) +
            (g.pending ? ' · <b>' + g.pending + ' 条待批</b>' : '') +
            (g.joinMode === 'approval' ? ' · 需审批' : '') +
            '</div></div>' +
            '<button class="row-remove" data-delgroup="' + esc(g.code) + '">解散</button>' +
            '</div>';
    }

    function renderAdmin() {
        var a = state.admin;
        if (!a) return;
        var me = state.me ? state.me.nickname : '';
        $('#admin-me').textContent = me ? (me + '（你）') : '';

        $('#admin-stats').innerHTML = [
            ['账号', a.stats.userCount],
            ['管理员', a.stats.adminCount],
            ['已传课表', a.stats.courseUploaded],
            ['群组', a.stats.groupCount],
            ['待复核', a.stats.suspectCount],
            ['待清理', a.stats.dormantCount]
        ].map(function (p) {
            return '<div class="stat"><b data-v="0">0</b><span>' + p[0] + '</span></div>';
        }).join('');
        // 数字从旧值滚到新值，眼睛能跟上变化
        $$('#admin-stats .stat b').forEach(function (el, i) {
            countUp(el, [
                a.stats.userCount, a.stats.adminCount, a.stats.courseUploaded,
                a.stats.groupCount, a.stats.suspectCount, a.stats.dormantCount
            ][i]);
        });

        $('#admin-user-count').textContent = a.users.length + ' 个';
        $('#admin-group-count').textContent = a.groups.length + ' 个';

        renderAdminUsers('');

        $('#admin-groups').innerHTML = a.groups.length
            ? a.groups.map(adminGroupRow).join('')
            : '<div class="empty">一个群组都没有</div>';

        var sc = $('#admin-suspect-card');
        sc.hidden = !a.suspects.length;
        $('#admin-suspect-count').textContent = a.suspects.length + ' 个';
        $('#admin-suspects').innerHTML = a.suspects.map(function (s) {
            return '<div class="item admin-row"><div class="grow">' +
                '<div class="title">' + esc(s.nickname) + '</div>' +
                '<div class="sub">' + esc(s.regIp) + ' · ' + esc(s.reason) +
                ' · ' + fmtTime(s.createdAt) + '</div></div></div>';
        }).join('');

        // 待清理：只列出来给人看，不自动删 —— 到底是不是废号，人和人之间的
        // 情况只有群主知道（有人就是注册了先放着，开学才传课表）
        var dorm = a.users.filter(function (u) { return u.dormant; });
        $('#admin-dormant-card').hidden = !dorm.length;
        $('#admin-dormant-count').textContent = dorm.length + ' 个';
        $('#admin-dormant').innerHTML = dorm.map(function (u) {
            return '<div class="item admin-row"><div class="grow">' +
                '<div class="title">' + esc(u.nickname) + '</div>' +
                '<div class="sub">' + u.idleDays + ' 天没露面 · 注册 ' + fmtTime(u.regAt) +
                (u.regIp ? ' · ' + esc(u.regIp) : '') + '</div>' +
                '<div class="sub">' + (u.loginCount ? '登录 ' + u.loginCount + ' 次' : '无登录记录') +
                ' · 一次课表都没传过</div>' +
                '</div><div class="row-acts">' +
                '<button class="row-remove" data-deluser="' + esc(u.id) + '">删除</button>' +
                '</div></div>';
        }).join('');

        $('#admin-audit').innerHTML = a.audit.length
            ? a.audit.map(function (e) {
                return '<div class="item admin-row"><div class="grow">' +
                    '<div class="title adt">' + esc(AUDIT_LABEL[e.event] || e.event) + '</div>' +
                    '<div class="sub">' + fmtTime(e.at) + (auditDetail(e) ? ' · ' + esc(auditDetail(e)) : '') +
                    '</div></div></div>';
            }).join('')
            : '<div class="empty">还没有日志</div>';
    }

    function renderAdminUsers(q) {
        var users = (state.admin && state.admin.users) || [];
        if (q) {
            var k = q.toLowerCase();
            users = users.filter(function (u) {
                return u.nickname.toLowerCase().indexOf(k) >= 0 ||
                    (u.regIp || '').indexOf(k) >= 0;
            });
        }
        $('#admin-users').innerHTML = users.length
            ? users.map(adminUserRow).join('')
            : '<div class="empty">没有匹配的账号</div>';
        // 边打字边筛的时候别让整个列表重播入场动画
        $('#admin-users').classList.toggle('no-anim', !!q);
    }

    /**
     * 事件委托：监听器只挂在**不会被替换**的容器上，一次就够。
     *
     * 之前是每次 innerHTML 之后遍历新元素逐个 addEventListener —— 结果
     * renderAdmin() 里先调 renderAdminUsers() 绑一遍、末尾又绑一遍，
     * 同一颗按钮挂了两份监听，点一下弹两个确认框。
     * 交给容器就不会有这个问题：重画多少次，监听都只有一份。
     */
    function initAdminDelegates() {
        $('#admin-users').addEventListener('click', function (e) {
            var t = e.target.closest('[data-grant],[data-reset],[data-deluser]');
            if (!t) return;
            if (t.hasAttribute('data-grant')) return toggleAdmin(t.getAttribute('data-grant'));
            if (t.hasAttribute('data-reset')) return adminResetPassword(t.getAttribute('data-reset'));
            return adminDeleteUser(t.getAttribute('data-deluser'));
        });
        $('#admin-groups').addEventListener('click', function (e) {
            var t = e.target.closest('[data-delgroup]');
            if (t) adminDeleteGroup(t.getAttribute('data-delgroup'));
        });
    }

    function adminUserById(id) {
        return ((state.admin && state.admin.users) || []).filter(function (u) { return u.id === id; })[0];
    }

    async function toggleAdmin(id) {
        var u = adminUserById(id);
        if (!u) return;
        var on = !u.admin;
        var ok = await askConfirm(
            on ? '授予管理员' : '撤销管理员',
            on
                ? '「' + u.nickname + '」将能看到全部账号、群组和审计日志，也能删账号。'
                : '「' + u.nickname + '」将失去管理页的访问权限，账号本身不受影响。',
            on ? '授予' : '撤销'
        );
        if (!ok) return;
        try {
            await API.adminSetAdmin(id, on);
            toast(on ? '已授予「' + u.nickname + '」管理员' : '已撤销「' + u.nickname + '」的管理员');
            state.admin = await API.adminOverview();
            renderAdmin();
        } catch (e) { toast(e.message, true); }
    }

    async function adminDeleteUser(id) {
        var u = adminUserById(id);
        if (!u) return;
        var ok = await askConfirm(
            '删除账号',
            '「' + u.nickname + '」（' + u.courseCount + ' 个课表时段）会被彻底删除，' +
            'TA 建的群会移交给最早入群的成员，无法恢复。',
            '删除'
        );
        if (!ok) return;
        try {
            var r = await API.adminDeleteUser(id);
            var extra = [];
            if (r.transferred && r.transferred.length) extra.push('移交 ' + r.transferred.join('、'));
            if (r.disbanded && r.disbanded.length) extra.push('解散空群 ' + r.disbanded.join('、'));
            toast('已删除「' + u.nickname + '」' + (extra.length ? '（' + extra.join('；') + '）' : ''));
            state.admin = await API.adminOverview();
            renderAdmin();
        } catch (e) { toast(e.message, true); }
    }

    /**
     * 重置密码。弹一次确认，然后把新密码显示出来 —— 这一步是**唯一**
     * 能看到明文的地方，关掉就再也拿不回来了，所以界面上要说清楚。
     */
    async function adminResetPassword(id) {
        var u = adminUserById(id);
        if (!u) return;
        var ok = await askConfirm(
            '重置密码',
            '「' + u.nickname + '」现在的密码会被作废，TA 的所有登录状态也会立刻失效。' +
            '原密码谁也看不到、也还原不了，只能换一个新的。',
            '重置'
        );
        if (!ok) return;
        try {
            var r = await API.adminResetPassword(id);
            await showTempPassword(r.nickname, r.password);
            state.admin = await API.adminOverview();
            renderAdmin();
        } catch (e) { toast(e.message, true); }
    }

    /** 新密码只出现这一次，所以给个大号可复制的框，而不是一闪而过的 toast */
    function showTempPassword(nickname, password) {
        return new Promise(function (resolve) {
            var modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML =
                '<div class="inner" style="max-width:340px">' +
                '<h2 style="font-size:16px;margin-bottom:8px">新的临时密码</h2>' +
                '<p class="tiny" style="margin-bottom:12px">' +
                '发给「<b></b>」本人，让 TA 登录后自己改掉。' +
                '<br><b>关掉这个框就再也看不到它了。</b></p>' +
                '<div class="secret" id="tp-value"></div>' +
                '<div class="row" style="margin-top:12px">' +
                '<button class="btn secondary" data-x="copy">复制</button>' +
                '<button class="btn" data-x="ok">我记下了</button>' +
                '</div></div>';
            $('p b', modal).textContent = nickname;

            var val = $('.secret', modal);
            val.textContent = password;
            val.addEventListener('click', function () { copyText(password); });

            modal.addEventListener('click', function (e) {
                var x = e.target.getAttribute && e.target.getAttribute('data-x');
                if (x === 'copy') {
                    copyText(password);
                    e.target.textContent = '已复制';
                    return;
                }
                if (x === 'ok') {
                    dismiss(modal);
                    resolve(true);
                }
            });
            document.body.appendChild(modal);
        });
    }

    async function adminDeleteGroup(code) {
        var g = ((state.admin && state.admin.groups) || []).filter(function (x) { return x.code === code; })[0];
        if (!g) return;
        var ok = await askConfirm(
            '解散群组',
            '「' + g.name + '」（' + g.memberCount + ' 人）会被解散，' +
            '群里的课表本身不受影响，但邀请码立刻失效，无法恢复。',
            '解散'
        );
        if (!ok) return;
        try {
            await API.adminDeleteGroup(code);
            toast('已解散「' + g.name + '」');
            state.admin = await API.adminOverview();
            renderAdmin();
        } catch (e) { toast(e.message, true); }
    }

    function renderCourseStatus() {
        var n = state.me && state.me.courseCount ? state.me.courseCount : 0;
        var txt = n ? ('已上传 ' + n + ' 个时段') : '未上传';
        $('#home-course-status').textContent = txt;
        var badge = $('#home-badge');
        var badgeTxt = n ? ('已解析 ' + n + ' 个时段') : '未上传';
        // 只有数字真的变了才弹一下。每次回首页都弹就成了骚扰
        var changed = badge.textContent !== badgeTxt;
        badge.textContent = badgeTxt;
        badge.className = 'badge' + (n ? ' ok' : '');
        if (changed && n) bump(badge);
        $('#home-drop-text').textContent = n ? '点击替换 .ics 课表文件' : '点击选择 .ics / .txt 课表文件';
        $('#home-account-name').textContent = state.me ? state.me.nickname : '';
        // 管理入口只给超级用户看；服务端每个 /api/admin/* 还会再查一次身份
        $('#admin-entry-card').hidden = !(state.me && state.me.admin);
    }

    async function uploadMyCourses(file, badgeEl, dropEl) {
        try {
            var stored = await ingestFile(file);
            await API.setCourses(stored);
            state.me = await API.me();
            toast('课表已更新：' + stored.length + ' 个时段');
            if (badgeEl) { badgeEl.textContent = '已解析 ' + stored.length + ' 个时段'; badgeEl.className = 'badge ok'; }
            if (dropEl) { dropEl.classList.add('active'); bump(dropEl, 'ring'); }
            if (badgeEl) bump(badgeEl);
            renderCourseStatus();
            if (state.group) await openGroup(state.group.code, true);
            return true;
        } catch (e) {
            toast(e.message, true);
            return false;
        }
    }

    async function loadGroups() {
        var box = $('#home-groups');
        try {
            var r = await API.myGroups();
            state.groups = r.groups || [];
        } catch (e) {
            box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
            return;
        }
        if (!state.groups.length) {
            box.innerHTML = '<div class="empty">还没有加入任何群组</div>';
            return;
        }
        box.innerHTML = state.groups.map(function (g) {
            return '<button class="item" data-code="' + esc(g.code) + '">' +
                '<div class="grow"><div class="title">' + esc(g.name) +
                (g.pending ? ' <span class="chip-lv nearby">等群主同意</span>' : '') + '</div>' +
                '<div class="sub">邀请码 ' + esc(g.code) + ' · ' + g.memberCount + ' 人' +
                (g.isCreator ? ' · 你是群主' : '') + '</div></div>' +
                '<span class="chev">›</span></button>';
        }).join('');
        $$('#home-groups .item').forEach(function (el) {
            el.addEventListener('click', function () { openGroup(el.getAttribute('data-code')); });
        });
    }

    /** 注销账号：先把后果说清楚，再要一次密码 */
    async function deleteAccount() {
        var owned = (state.groups || []).filter(function (g) { return g.isCreator && !g.pending; });
        var hint = '账号、课表、备注都会被删除，无法恢复。';
        if (owned.length) {
            hint += '\n你是 ' + owned.length + ' 个群的群主（' +
                owned.map(function (g) { return g.name; }).join('、') +
                '），群主会自动转给群里最早加入的成员；只有你自己的群会直接解散。';
        }
        var pw = await askText({
            title: '注销账号',
            hint: hint,
            placeholder: '输入密码确认',
            password: true,
            maxlength: 64
        });
        if (pw == null) return;
        try {
            var r = await API.deleteAccount(pw);
            API.setToken('');
            state.me = null;
            state.groups = [];
            state.group = null;
            state.weekIndex = null;
            var extra = '';
            if (r.transferred && r.transferred.length) extra += '，' + r.transferred.length + ' 个群已移交';
            if (r.disbanded && r.disbanded.length) extra += '，' + r.disbanded.length + ' 个空群已解散';
            toast('账号已注销' + extra);
            show('auth', { title: '同格', replace: true });
        } catch (e) { toast(e.message, true); }
    }

    function initHome() {
        $('#btn-delete-account').addEventListener('click', deleteAccount);

        $('#home-file').addEventListener('change', function (e) {
            var f = e.target.files[0];
            if (f) uploadMyCourses(f, $('#home-badge'), $('#home-drop'));
            e.target.value = '';
        });

        $('#btn-create-group').addEventListener('click', async function () {
            var name = await askText({
                title: '创建群组', placeholder: '群组名（选填）', maxlength: 20,
                hint: '留空就叫「我的组团」。创建后会生成 8 位邀请码。'
            });
            if (name === null) return;
            try {
                var g = await API.createGroup(name);
                state.weekIndex = null;
                toast('群组已创建，邀请码 ' + g.code);
                await loadGroups();
                await openGroup(g.code);
            } catch (e) { toast(e.message, true); }
        });

        $('#btn-join-group').addEventListener('click', async function () {
            var code = await askText({
                title: '加入群组', placeholder: '8 位邀请码', maxlength: 8, mono: true,
                pattern: /^\d{6}$|^\d{8}$/, patternHint: '邀请码是 8 位数字（改版前的 6 位老码也能用）',
                hint: '输入同学给你的邀请码，或直接扫二维码。'
            });
            if (code === null) return;
            await joinByCode(code);
        });

        $('#btn-logout').addEventListener('click', logout);
        $('#btn-local').addEventListener('click', function () { show('local', { title: '本地快速比对', back: goHome }); initLocalOnce(); });
        $('#btn-open-admin').addEventListener('click', function () { openAdmin(); });
        $('#btn-admin').addEventListener('click', function () { openAdmin(); });
        initAdminDelegates();
        $('#admin-user-filter').addEventListener('input', function (e) {
            renderAdminUsers(e.target.value.trim());
        });
    }

    async function joinByCode(code) {
        try {
            var r = await API.joinGroup(code);
            await loadGroups();
            if (r.pending) {
                toast('已申请加入「' + r.name + '」，等群主同意');
                await goHome();
                return true;
            }
            toast('已加入「' + r.name + '」');
            await openGroup(code);
            return true;
        } catch (e) {
            if (e.status === 401) { state.pendingCode = code; return false; }
            toast(e.message, true);
            return false;
        }
    }

    // ------------------------------------------------------------ 周次胶囊

    function weekWindowOf(membersCourses) {
        return weeks.semesterWindow(membersCourses);
    }

    /**
     * @param {Array<Array>} groups 若干份课表
     * @param {Function} onPick
     */
    function renderWeeks(container, win, activeIndex, onPick) {
        container.innerHTML = '';
        if (!win || !win.baseMonday) return;
        var busy = {};
        (win.activeSet || []).forEach(function (i) { busy[i] = true; });

        weeks.weekOptions(win).forEach(function (opt) {
            var b = document.createElement('button');
            // 第一行教学周，第二行具体日期 + 年内周次。
            // 悬停提示在手机上看不到，所以日期必须直接写在胶囊上。
            // 取值都带兜底：万一浏览器缓存里是旧版 weeks.js（缺 shortRange/isCurrent），
            // 也还能显示日期，不至于只剩一个分隔点。
            var dtText = opt.shortRange || opt.range || '';
            var yearText = opt.yearLabel || (opt.yearWeek ? '年' + opt.yearWeek + '周' : '');
            b.innerHTML =
                '<span class="wk">' + esc(opt.label) + '</span>' +
                '<span class="dt">' + (opt.isCurrent ? '本周 · ' : '') +
                esc(dtText) + (yearText ? ' · ' + esc(yearText) : '') + '</span>';
            b.title = opt.label + '（' + opt.range + '）· 年内第 ' + opt.yearWeek + ' 周';
            if (opt.isCurrent) b.classList.add('week-current');
            if (opt.index === activeIndex) b.classList.add('on');
            if (win.activeSet && !busy[opt.index]) b.classList.add('empty-week');
            b.addEventListener('click', function () { onPick(opt.index); });
            container.appendChild(b);
        });

        var active = $('.weeks button.on', container);
        if (active && active.scrollIntoView) {
            active.scrollIntoView({ block: 'nearest', inline: 'center' });
        }
    }

    /** 计算学期窗口，并附带每周是否有课的标记（用于把空周淡显） */
    function buildWindow(membersCourses) {
        var win = weeks.semesterWindow(membersCourses);
        if (!win.baseMonday) return win;
        var set = {};
        membersCourses.forEach(function (slots) {
            weeks.activeWeeks(slots, win.baseMonday).forEach(function (i) { set[i] = true; });
        });
        win.activeSet = Object.keys(set).map(Number);
        return win;
    }

    // ------------------------------------------------------------ 群组页

    async function openGroup(code, keepSilent) {
        if (!keepSilent) show('group', { title: '群组', back: goHome });
        $('#group-members').innerHTML = '<div class="spinner">加载中…</div>';
        try {
            var detail = await API.groupDetail(code);
            state.group = detail;
            renderGroup();
        } catch (e) {
            toast(e.message, true);
            if (!keepSilent) goHome();
        }
    }

    /**
     * 只把群组数据重新拉一遍再重画，不走 show()。
     * 新增/作废邀请码后用这个：不闪屏、不重置已选周次，用户感觉是「就地更新」。
     */
    async function reloadGroup() {
        if (!state.group) return;
        state.group = await API.groupDetail(state.group.code);
        renderGroup();
    }

    var uploadBusy = false;

    function memberHasMe(m) { return state.me && m.id === state.me.id; }

    /** 群组页那行上传状态提示 */
    function renderUploadHint() {
        var el = $('#group-upload-hint');
        if (!el) return;
        if (uploadBusy) {
            el.className = 'tiny upload-hint busy';
            el.textContent = '正在解析并上传…';
            return;
        }
        el.className = 'tiny upload-hint';
        var n = (state.me && state.me.courseCount) || 0;
        if (!n) {
            el.textContent = '还没上传 —— 传了群里才看得到你的课表';
        } else {
            el.innerHTML = '当前 <b>' + n + '</b> 个时段 · ' + fmtTime(state.me.updatedAt) +
                ' 更新<br>重新上传会覆盖旧的';
        }
    }

    /**
     * 显示名，三级优先，越靠上的越先被采用：
     *   1. 我给 TA 起的备注   —— 只在我这儿生效
     *   2. TA 自己设的对外备注 —— 群里所有人都看得到
     *   3. 账号昵称
     *
     * 2 之所以排在 1 后面：我给你起的外号是我的视角，不该被你自己改掉。
     * @returns {{shown:string, real:string}} real 是「显示名和真名不一样」时补的真名
     */
    function nameParts(m) {
        var mine = (state.me && state.me.remarks && state.me.remarks[m.id]) || '';
        var shown = mine || m.selfRemark || m.nickname;
        return { shown: shown, real: shown === m.nickname ? '' : m.nickname };
    }

    function displayName(m) { return nameParts(m).shown; }

    /** 给 TA 起/改/清备注。传空字符串即取消 */
    async function editRemark(m) {
        var cur = (state.me && state.me.remarks && state.me.remarks[m.id]) || '';
        var name = await askText({
            title: '给 TA 起个备注',
            hint: '只有你自己看得见，别人看到的名字不受影响。留空就是取消备注。',
            placeholder: m.nickname,
            value: cur,
            maxlength: 12
        });
        if (name == null) return;
        if (name === cur) return;
        try {
            var r = await API.setRemark(m.id, name);
            state.me.remarks = r.remarks || {};
            renderGroup();
            toast(name ? '以后 TA 在你这里叫「' + name + '」' : '已取消备注');
        } catch (e) { toast(e.message, true); }
    }

    /**
     * 设我在这群里的对外备注（「备注自己」）。
     * 和上面那个正好相反：改的是别人看到我的名字，群里所有人共享一份。
     */
    async function editSelfRemark() {
        if (!state.group || !state.me) return;
        var me = state.group.members.filter(memberHasMe)[0];
        var cur = (me && me.selfRemark) || '';
        var name = await askText({
            title: '我在这群里的名字',
            hint: '群里同学都会看到这个名字，留空就用你的昵称。' +
                  '只有一点：别人自己给你起过备注的话，他那边还是显示他的备注。',
            placeholder: state.me.nickname,
            value: cur,
            maxlength: 12
        });
        if (name == null || name === cur) return;
        try {
            var r = await API.setSelfRemark(state.group.code, name);
            if (me) me.selfRemark = r.selfRemark || '';
            renderGroup();
            toast(name ? '这群里你会显示为「' + name + '」' : '已恢复用昵称');
        } catch (e) { toast(e.message, true); }
    }

    /**
     * 一行成员。
     * @param stats 重合统计；为 null 表示「自己还没上传课表」，算不出来
     * @param canRemove 群主才看得到移除按钮
     */
    function memberRowHtml(m, stats, canRemove) {
        var extra = '';
        if (stats) {
            var badges = '';
            ['same', 'nearby', 'area', 'cross', 'unknown'].forEach(function (lv) {
                if (stats[lv] > 0) {
                    badges += '<span class="chip-lv ' + lv + '">' + LV_TEXT[lv] + ' ' + stats[lv] + '</span>';
                }
            });
            extra = stats.total
                ? '<div class="overlap">' + badges + '<span class="chip-lv total">共 ' + stats.total + ' 节</span></div>'
                : '<div class="no-overlap">本周无重合</div>' +
                  (m.courseCount ? '' : '<div class="no-overlap">（TA 还没上传课表）</div>');
        }
        // 算不出重合时不给比对入口（点进去只会是一张空表）
        var head = stats
            ? 'data-member="' + esc(m.id) + '" role="button" tabindex="0"'
            : '';
        var np = nameParts(m);
        return '<div class="item" ' + head + '>' +
            '<div class="grow"><div class="title">' + esc(np.shown) + '</div>' +
            '<div class="sub">' + (np.real ? esc(np.real) + ' · ' : '') +
            m.courseCount + ' 个时段 · ' + fmtTime(m.updatedAt) + '</div>' +
            extra + '</div>' +
            '<button class="row-note" data-note="' + esc(m.id) + '">备注</button>' +
            (canRemove ? '<button class="row-remove" data-remove="' + esc(m.id) + '">移除</button>' : '') +
            '<span class="chev">›</span></div>';
    }

    function renderGroup() {
        var g = state.group;
        var all = g.members.map(function (m) { return m.courses || []; });
        var win = buildWindow(all);
        var me = g.members.filter(memberHasMe)[0];
        var iAmOwner = !!(state.me && g.creatorId === state.me.id);
        var meHasCourses = !!(me && me.courses.length);

        if (state.weekIndex == null || state.weekIndex > win.weekCount) {
            var def = weeks.resolveDefaultWeek(all, win);
            state.weekIndex = def.weekIndex;
            state.fellBack = def.fellBack;
            state.noClass = !def.hasClass;
        }
        var monday = win.baseMonday ? weeks.mondayOfWeek(win.baseMonday, state.weekIndex) : null;

        $('#group-name').firstChild.nodeValue = g.name;
        $('#btn-rename-group').hidden = !iAmOwner;
        renderUploadHint();
        $('#btn-group-delete').hidden = !iAmOwner;

        // 邀请卡片：展示哪一枚码、有没有可用的码，都在这里定
        var disp = currentDisplayCode();
        var codeEl = $('#group-code');
        var noteEl = $('#group-current-note');
        var qrBox = $('#group-qr');
        var urlEl = $('#group-url');
        var canShare = !!disp;

        // 分享按钮在没有可用码时必须禁用 —— 否则用户会复制出一个打不开的链接
        ['#btn-copy-code', '#btn-copy-link', '#btn-zoom-qr'].forEach(function (sel) {
            var b = $(sel);
            if (b) b.disabled = !canShare;
        });

        if (disp) {
            codeEl.textContent = disp.code;
            urlEl.hidden = false;
            renderQr(disp.code);
            // 讲清楚这个码是谁的、还能用多久
            if (disp.isOwnerCode) {
                noteEl.textContent = '这是你自己的永久码，永不过期。发给同学的码在「管理邀请链接」里。';
            } else if (disp.invite.expiresAt == null) {
                noteEl.textContent = '这条链接永久有效。';
            } else {
                noteEl.textContent = '这条链接' + inviteStateText(disp.invite) + '。';
            }
        } else {
            // 没有可用码：多半是群主发的链接都过期/作废了
            codeEl.textContent = '——';
            noteEl.textContent = '现在没有能用的邀请链接了。';
            urlEl.hidden = true;
            qrBox.innerHTML = '<div class="tiny">没有可用的邀请链接</div>';
        }
        // 管理入口只有群主看得到；成员在邀请卡片上就能拿到能用的码
        $('#btn-manage-invites').hidden = !iAmOwner;


        var notice = $('#group-notice');
        if (state.fellBack) {
            notice.hidden = false;
            notice.textContent = '当前周没有课，已显示 第 ' + state.weekIndex + ' 周。';
        } else if (state.noClass) {
            notice.hidden = false;
            notice.textContent = '该学期暂无课程数据。';
        } else {
            notice.hidden = true;
        }

        renderWeeks($('#group-weeks'), win, state.weekIndex, function (i) {
            state.weekIndex = i;
            state.fellBack = false;
            renderGroup();
        });

        // 二维码与邀请码必须在「还没上传课表」时也能看到 —— 刚建完群正是这个状态，
        // 所以上面的邀请卡片渲染放在这些早退分支之前。

        renderGroupSettings(g, iAmOwner);
        renderRequests(g, iAmOwner);

        // 自己没上传课表时算不出重合，但成员列表照常渲染
        //（群主得能移除人，也不该因为自己没传课表就失去「备注自己」的能力）
        var html = [];
        var myName = me ? me.nickname : '';
        var mySelf = (me && me.selfRemark) || '';
        html.push('<div class="item me">' +
            '<div class="grow">' +
            '<div class="title">' + esc(mySelf || myName) + '（你）</div>' +
            '<div class="sub">' + (mySelf ? esc(myName) + ' · ' : '') +
            (meHasCourses
                ? me.courseCount + ' 个时段 · ' + fmtTime(me.updatedAt)
                : '还没上传课表 · 传了才看得到重合') +
            '</div></div>' +
            '<button class="row-self-note">备注自己</button></div>');

        // 自己排第一，其余按重合总量从多到少
        var others = g.members.filter(function (m) { return !memberHasMe(m); });
        var decorated = others.map(function (m) {
            return {
                m: m,
                stats: meHasCourses ? cmp.overlapInWeek(me.courses, m.courses || [], monday) : null
            };
        });
        if (meHasCourses) decorated.sort(function (a, b) { return b.stats.total - a.stats.total; });

        if (!decorated.length) {
            html.push('<div class="empty">群里还没有其他人，把邀请码发出去吧。</div>');
        }
        decorated.forEach(function (d) {
            html.push(memberRowHtml(d.m, d.stats, iAmOwner));
        });

        $('#group-members').innerHTML = html.join('');

        $$('#group-members .item[data-member]').forEach(function (el) {
            function open() {
                var id = el.getAttribute('data-member');
                var m = state.group.members.filter(function (x) { return x.id === id; })[0];
                if (m) openCompare(m);
            }
            el.addEventListener('click', open);
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
            });
        });

        $$('#group-members .row-note').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();   // 别顺手打开比对页
                var id = btn.getAttribute('data-note');
                var m = state.group.members.filter(function (x) { return x.id === id; })[0];
                if (m) editRemark(m);
            });
        });

        // 「备注自己」：改我在群里的名字，和上面那颗正好相反
        $$('#group-members .row-self-note').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                editSelfRemark();
            });
        });

        $$('#group-members .row-remove').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                // 别让点击冒泡到整行，否则会顺手打开比对页
                e.stopPropagation();
                removeMemberById(btn.getAttribute('data-remove'));
            });
        });
    }

    /** 群组设置（只有群主看得到） */
    function renderGroupSettings(g, iAmOwner) {
        var card = $('#group-settings-card');
        card.hidden = !iAmOwner;
        if (!iAmOwner) return;

        $$('#join-mode button').forEach(function (b) {
            b.classList.toggle('on', b.getAttribute('data-mode') === g.joinMode);
        });
    }

    /** 待审批的入群申请（只有群主看得到） */
    function renderRequests(g, iAmOwner) {
        var card = $('#group-requests-card');
        var list = g.requests || [];
        card.hidden = !iAmOwner || !list.length;
        if (card.hidden) return;

        $('#group-requests-count').textContent = list.length + ' 个';
        $('#group-requests').innerHTML = list.map(function (r) {
            return '<div class="item"><div class="grow">' +
                '<div class="title">' + esc(r.nickname) + '</div>' +
                '<div class="sub">' + fmtTime(r.at) + ' 申请</div></div>' +
                '<button class="row-ok" data-ok="' + esc(r.id) + '">同意</button>' +
                '<button class="row-no" data-no="' + esc(r.id) + '">拒绝</button></div>';
        }).join('');

        $$('#group-requests .row-ok').forEach(function (b) {
            b.addEventListener('click', function () { decideRequest(b.getAttribute('data-ok'), true); });
        });
        $$('#group-requests .row-no').forEach(function (b) {
            b.addEventListener('click', function () { decideRequest(b.getAttribute('data-no'), false); });
        });
    }

    async function decideRequest(id, approve) {
        if (!state.group) return;
        var r = (state.group.requests || []).filter(function (x) { return x.id === id; })[0];
        try {
            if (approve) {
                await API.approveRequest(state.group.code, id);
                toast('已让 ' + (r ? r.nickname : 'TA') + ' 进群');
            } else {
                await API.rejectRequest(state.group.code, id);
                toast('已拒绝 ' + (r ? r.nickname : 'TA'));
            }
            await openGroup(state.group.code, true);
        } catch (e) {
            toast(e.message, true);
        }
    }

    async function renameGroup() {
        if (!state.group) return;
        var name = await askText({
            title: '群组改名',
            hint: '最多 20 个字，群里所有人都能看到新名字',
            placeholder: '群组名称',
            value: state.group.name,
            maxlength: 20
        });
        if (name == null || name === state.group.name) return;
        try {
            await API.groupSettings(state.group.code, { name: name });
            state.group = await API.groupDetail(state.group.code);
            renderGroup();
            toast('已改名为「' + state.group.name + '」');
        } catch (e) { toast(e.message, true); }
    }

    function initGroupSettings() {
        $('#btn-rename-group').addEventListener('click', renameGroup);
        $('#join-mode').addEventListener('click', async function (e) {
            var btn = e.target.closest('button[data-mode]');
            if (!btn || !state.group) return;
            var mode = btn.getAttribute('data-mode');
            if (mode === state.group.joinMode) return;
            try {
                await API.groupSettings(state.group.code, { joinMode: mode });
                state.group = await API.groupDetail(state.group.code);
                renderGroup();
                toast(mode === 'approval' ? '以后要你同意才能进群' : '以后拿到链接就能直接进群');
            } catch (err) { toast(err.message, true); }
        });
    }

    /** 群主把某个成员移出群组 */
    async function removeMemberById(id) {
        if (!state.group) return;
        var m = state.group.members.filter(function (x) { return x.id === id; })[0];
        if (!m) return;
        var ok = await askConfirm(
            '移除成员',
            '把「' + m.nickname + '」移出「' + state.group.name + '」？TA 会从成员列表里消失，' +
            '要重新输邀请码才能进群。',
            '确认移除'
        );
        if (!ok) return;
        try {
            await API.removeMember(state.group.code, id);
            toast('已把 ' + m.nickname + ' 移出群组');
            if (state.compareWith && state.compareWith.id === id) state.compareWith = null;
            await openGroup(state.group.code, true);
        } catch (e) {
            toast(e.message, true);
        }
    }

    var LV_TEXT = { same: '同教室', nearby: '同楼栋', area: '同区域', cross: '不同区域', unknown: '未知' };

    function fmtTime(ts) {
        if (!ts) return '未更新';
        var d = new Date(ts);
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    // ------------------------------------------------------------ 二维码

    var metaCache = null;

    async function shareCandidates() {
        if (!metaCache) {
            try { metaCache = await API.meta(); } catch (e) { metaCache = { lanUrls: [] }; }
        }
        return metaCache.lanUrls || [];
    }

    /**
     * 二维码/链接里该用哪个地址。
     *
     * 自己用 localhost 打开时必须换成局域网地址，否则同学扫了打不开。
     * 服务端返回的 lanUrls 已经排过序（虚拟网卡在后），直接取第一个就行 ——
     * 以前这里还挂了一排「换一个地址试试」的按钮，纯属多余：
     * 正常人就该拿到第一个可用地址，给一排按钮只会让人不知道该点哪个。
     */
    async function joinOrigin() {
        if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
            return location.origin;
        }
        var list = await shareCandidates();
        return list[0] || location.origin;
    }

    async function joinUrl(code) {
        return (await joinOrigin()) + '/?code=' + code;
    }

    // -------------------------------------------------------- 邀请链接（可多枚、可过期）

    /** 剩余时间说人话：不显示「还剩 86399000 毫秒」这种 */
    function fmtRemaining(ms) {
        if (ms == null) return '';
        if (ms <= 0) return '已过期';
        var m = Math.floor(ms / 60000);
        if (m < 60) return '还剩 ' + Math.max(1, m) + ' 分钟';
        var h = Math.floor(m / 60);
        if (h < 24) return '还剩 ' + h + ' 小时';
        return '还剩 ' + Math.floor(h / 24) + ' 天';
    }

    /** 一枚码现在的状态，一句话讲清「能不能用、为什么」 */
    function inviteStateText(inv) {
        if (inv.revoked) return '已作废';
        if (inv.expired) return '已过期';
        if (inv.expiresAt == null) return '永久有效';
        return fmtRemaining(inv.remainingMs) + '（' + fmtTime(inv.expiresAt) + ' 到期）';
    }

    function inviteStateClass(inv) {
        return inv.active ? 'chip-lv same' : 'chip-lv cross';
    }

    /** 能用的码，越新越靠前；群主自己的永久码单独走 ownerCode */
    function activeInvites() {
        var g = state.group;
        if (!g || !g.invites) return [];
        return g.invites.filter(function (i) { return i.active; });
    }

    /**
     * 决定邀请卡片上该展示哪一枚码：
     *  1. 用户手动选过的（state.activeInvite）
     *  2. 还能用的里面最新的那枚
     *  3. 群主自己的永久码（老群没有 invites，全靠它）
     *  4. 都没有 -> null，卡片改成提示「让群主要个新链接」
     */
    function currentInvite() {
        var g = state.group;
        if (!g) return null;
        var list = activeInvites();
        if (state.activeInvite) {
            var picked = list.filter(function (i) { return i.code === state.activeInvite; })[0];
            if (picked) return picked;
            state.activeInvite = null;
        }
        if (list.length) return list[0];
        return null;
    }

    /**
     * 邀请卡片上那个码是什么。
     * @returns {{code:string, invite:object|null, isOwnerCode:boolean}|null}
     */
    function currentDisplayCode() {
        var g = state.group;
        if (!g) return null;
        var inv = currentInvite();
        if (inv) return { code: inv.code, invite: inv, isOwnerCode: false };
        // 没有可用的邀请码了：群主退回自己的永久码，成员就只能求助群主
        if (g.isCreator && g.ownerCode) {
            return { code: g.ownerCode, invite: null, isOwnerCode: true };
        }
        return null;
    }

    // -------------------------------------------------------- 邀请链接管理页

    /** 群里所有邀请记录，按创建时间倒序 */
    function inviteList() {
        var g = state.group;
        return (g && g.invites) ? g.invites.slice().sort(function (a, b) {
            return (b.createdAt || 0) - (a.createdAt || 0);
        }) : [];
    }

    function inviteRowHtml(inv, mode) {
        // 有效链接：能展示、能作废，还能勾选批量作废
        if (mode === 'active') {
            return '<div class="item admin-row">' +
                '<label class="inv-pick"><input type="checkbox" data-pick="' + esc(inv.code) + '"></label>' +
                '<div class="grow">' +
                '<div class="title mono">' + esc(inv.code) +
                (inv.label ? ' <span class="sub">' + esc(inv.label) + '</span>' : '') + '</div>' +
                '<div class="sub">' + esc(inviteStateText(inv)) + ' · 建于 ' + fmtTime(inv.createdAt) + '</div>' +
                '</div>' +
                '<div class="row-acts">' +
                '<button class="row-note" data-use="' + esc(inv.code) + '">展示</button>' +
                '<button class="row-remove" data-revoke="' + esc(inv.code) + '">作废</button>' +
                '</div></div>';
        }
        // 已失效：只读，但可以彻底删掉（前提是已经失效）
        return '<div class="item admin-row">' +
            '<div class="grow">' +
            '<div class="title mono">' + esc(inv.code) +
            (inv.label ? ' <span class="sub">' + esc(inv.label) + '</span>' : '') + '</div>' +
            '<div class="sub">' + esc(inviteStateText(inv)) + ' · 建于 ' + fmtTime(inv.createdAt) + '</div>' +
            '<div class="overlap"><span class="' + inviteStateClass(inv) + '">' +
            (inv.revoked ? '已作废' : '已过期') + '</span></div>' +
            '</div>' +
            '<div class="row-acts">' +
            '<button class="row-remove" data-purge="' + esc(inv.code) + '">删除</button>' +
            '</div></div>';
    }

    function renderManageInvites() {
        var g = state.group;
        if (!g) return;

        var all = inviteList();
        var live = all.filter(function (i) { return i.active; });
        var dead = all.filter(function (i) { return !i.active; });

        var ownerCodeEl = $('#inv-owner-code');
        if (ownerCodeEl) ownerCodeEl.textContent = g.ownerCode || g.code;

        // ---- 有效链接 ----
        var countEl = $('#inv-count');
        if (countEl) countEl.textContent = live.length + ' 条';
        var box = $('#inv-active-list');
        box.innerHTML = live.length
            ? live.map(function (i) { return inviteRowHtml(i, 'active'); }).join('')
            : '<div class="empty">还没有有效的邀请链接，下面发一条吧</div>';

        // 批量作废那一条只在有多条时才出现，免得零碎
        $('#inv-bulk-bar').hidden = live.length < 2;

        $$('#inv-active-list [data-use]').forEach(function (b) {
            b.addEventListener('click', function () { useInvite(b.getAttribute('data-use')); });
        });
        $$('#inv-active-list [data-revoke]').forEach(function (b) {
            b.addEventListener('click', function () { revokeInvite(b.getAttribute('data-revoke')); });
        });

        // ---- 已失效存档 ----
        var hbox = $('#inv-history-list');
        hbox.innerHTML = dead.length
            ? dead.map(function (i) { return inviteRowHtml(i, 'dead'); }).join('')
            : '<div class="empty">没有失效的记录</div>';
        $$('#inv-history-list [data-purge]').forEach(function (b) {
            b.addEventListener('click', function () { purgeInvite(b.getAttribute('data-purge')); });
        });

        syncInviteBulk();
    }

    /** 批量作废栏：全选框与按钮的可用状态跟着勾选走 */
    function syncInviteBulk() {
        var picks = $$('#inv-active-list [data-pick]');
        var btn = $('#btn-inv-revoke-selected');
        if (!btn) return;
        var chosen = picks.filter(function (p) { return p.checked; });
        btn.disabled = !chosen.length;
        btn.textContent = chosen.length ? '作废选中的 ' + chosen.length + ' 条' : '作废选中的';
        var allBox = $('#btn-inv-selectall');
        if (allBox) {
            allBox.textContent = (picks.length && chosen.length === picks.length) ? '取消全选' : '全选';
        }
    }

    /** 把某条链接设为群组页上展示/分享的那条 */
    function useInvite(code) {
        state.activeInvite = code;
        show('group', { title: '群组', back: goHome, replace: true });
        renderGroup();
        toast('已切到 ' + code + '，群组页上分享的就是它');
    }

    /**
     * 换掉群自己的码：以前发出去的所有链接一起失效。
     *
     * 为什么要有这个按钮：改版前建的群码是 6 位（10⁶ 空间），配 20 次/分钟的
     * 限流，枚举完只要一个多月。换掉之后就是 8 位，代价是老链接全废。
     */
    async function rotateGroupCode() {
        var g = state.group;
        if (!g) return;
        var ok = await askConfirm(
            '换掉群自己的码',
            '现在这个码 ' + g.code + ' 会立刻作废，以前发出去的所有链接都会失效，' +
            '需要你把新码重新发给还没进群的同学。已经进群的人不受影响。',
            '换新的'
        );
        if (!ok) return;
        try {
            var r = await API.rotateGroupCode(g.code);
            state.activeInvite = null;
            // 群码变了：整页按新码重新打开
            await openGroup(r.code);
            toast('已换成新码：' + r.code + '，请重新发给同学');
        } catch (e) { toast(e.message, true); }
    }

    async function generateInvite() {
        var g = state.group;
        if (!g) return;
        var label = ($('#inv-label') && $('#inv-label').value.trim()) || '';
        try {
            var r = await API.addInvite(g.code, state.newInviteTtl, label);
            if ($('#inv-label')) $('#inv-label').value = '';
            state.activeInvite = r.invite.code;
            await reloadGroup();
            renderManageInvites();
            toast('新链接已生成：' + r.invite.code);
        } catch (e) { toast(e.message, true); }
    }

    async function revokeInvite(inviteCode) {
        var g = state.group;
        if (!g) return;
        var ok = await askConfirm(
            '作废这条邀请链接',
            '作废后 ' + inviteCode + ' 就不能再进群了。已经进群的人不受影响，' +
            '但如果还有同学没进来，得重新发一条给 TA。',
            '作废'
        );
        if (!ok) return;
        try {
            await API.revokeInvite(g.code, inviteCode);
            if (state.activeInvite === inviteCode) state.activeInvite = null;
            await reloadGroup();
            renderManageInvites();
            toast('已作废 ' + inviteCode);
        } catch (e) { toast(e.message, true); }
    }

    async function revokeSelectedInvites() {
        var g = state.group;
        if (!g) return;
        var codes = $$('#inv-active-list [data-pick]')
            .filter(function (p) { return p.checked; })
            .map(function (p) { return p.getAttribute('data-pick'); });
        if (!codes.length) return;
        var ok = await askConfirm(
            '作废 ' + codes.length + ' 条链接',
            codes.join('、') + ' 都会立刻失效，新人进不来。' +
            '已经在群里的人不受影响。',
            '全部作废'
        );
        if (!ok) return;
        try {
            var r = await API.revokeInvites(g.code, codes);
            codes.forEach(function (c) { if (state.activeInvite === c) state.activeInvite = null; });
            await reloadGroup();
            renderManageInvites();
            toast('已作废 ' + r.revoked.length + ' 条');
        } catch (e) { toast(e.message, true); }
    }

    async function purgeInvite(inviteCode) {
        var g = state.group;
        if (!g) return;
        var ok = await askConfirm(
            '删除这条记录',
            '把 ' + inviteCode + ' 从记录里抹掉。它已经失效了，删不删都不影响谁能进群，' +
            '但删掉之后就查不到「这个码是谁什么时候发的」了。',
            '删除'
        );
        if (!ok) return;
        try {
            await API.purgeInvite(g.code, inviteCode);
            await reloadGroup();
            renderManageInvites();
            toast('已删除 ' + inviteCode);
        } catch (e) { toast(e.message, true); }
    }

    async function openInvites() {
        if (!state.group) return fallbackHome();
        if (!state.group.isCreator) return toast('只有群主能管理邀请链接', true);
        show('invites', { title: '邀请链接', back: function () { show('group', { title: '群组', back: goHome, replace: true }); } });
        renderManageInvites();
    }

    function initManageInvites() {
        $$('#inv-ttl button').forEach(function (b) {
            b.addEventListener('click', function () {
                $$('#inv-ttl button').forEach(function (x) { x.classList.remove('on'); });
                b.classList.add('on');
                state.newInviteTtl = b.getAttribute('data-ttl');
            });
        });
        $('#btn-inv-gen').addEventListener('click', generateInvite);
        $('#btn-inv-rotate').addEventListener('click', rotateGroupCode);

        // 勾选走事件委托：列表是整体重画的，逐个绑会漏
        $('#inv-active-list').addEventListener('change', function (e) {
            if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-pick')) syncInviteBulk();
        });
        $('#btn-inv-selectall').addEventListener('click', function () {
            var picks = $$('#inv-active-list [data-pick]');
            var allOn = picks.length && picks.every(function (p) { return p.checked; });
            picks.forEach(function (p) { p.checked = !allOn; });
            syncInviteBulk();
        });
        $('#btn-inv-revoke-selected').addEventListener('click', revokeSelectedInvites);

        $('#btn-inv-toggle-history').addEventListener('click', function () {
            var box = $('#inv-history-box');
            box.hidden = !box.hidden;
            $('#btn-inv-toggle-history').textContent = box.hidden ? '显示已失效的记录' : '收起已失效的记录';
        });
    }

    function qrSvg(text, cellSize) {
        try {
            var qr = qrcode(0, 'M');
            qr.addData(text);
            qr.make();
            return qr.createSvgTag(cellSize || 4, 2);
        } catch (e) {
            return '<div class="tiny">二维码生成失败</div>';
        }
    }

    async function renderQr(code) {
        var origin = await joinOrigin();
        var url = origin + '/?code=' + code;

        $('#group-qr').innerHTML = qrSvg(url, 4);
        $('#group-code').title = url;
        $('#group-url').textContent = url;
    }

    function zoomQr() {
        var disp = currentDisplayCode();
        if (!disp) return toast('现在没有能用的邀请链接', true);
        joinUrl(disp.code).then(function (url) {
            $('#qr-modal-code').textContent = disp.code;
            $('#qr-modal-qr').innerHTML = qrSvg(url, 6);
            $('#qr-modal').hidden = false;
        });
    }

    // ------------------------------------------------------------ 分享文案

    // 每次复制随机挑一句，发出去的话不会千篇一律
    var SHARE_HEADS = [
        '🎓 组团上课，来对一下课表？',
        '🎓 发车了，组团上课',
        '课表碰一碰，看看能不能撞到一块儿 👀',
        '来！看看咱俩的课表能撞出几节课',
        '找上课搭子 🎓',
        '把课表丢进来，看看我们一周能撞上几回'
    ];
    var SHARE_TAILS = [
        '打开 → 注册昵称密码 → 传 .ics 就进来了',
        '注册个昵称密码，传上课表就进群了',
        '注册 → 传 .ics → 进群，三步搞定'
    ];

    function pickOne(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    /** 复制给同学的整段话：链接 + 口令 + 邀请码 + 一句怎么用 */
    function shareMessage(url, code) {
        return [
            pickOne(SHARE_HEADS),
            url,
            '邀请码：' + code,
            pickOne(SHARE_TAILS)
        ].join('\n');
    }

    function copyText(text, okMsg) {
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); toast(okMsg); }
            catch (e) { toast('复制失败，请手动选取', true); }
            document.body.removeChild(ta);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
        } else fallback();
    }

    function initGroup() {
        initGroupSettings();
        $('#btn-copy-code').addEventListener('click', function () {
            var disp = currentDisplayCode();
            if (disp) copyText(disp.code, '邀请码已复制');
        });
        $('#btn-copy-link').addEventListener('click', function () {
            var disp = currentDisplayCode();
            if (!disp) return;
            joinUrl(disp.code).then(function (u) {
                copyText(shareMessage(u, disp.code), '分享文案已复制，直接发群里就行');
            });
        });
        $('#btn-zoom-qr').addEventListener('click', zoomQr);

        // 多个链接的增删作废都在独立的「邀请链接」页里，这里只留入口
        $('#btn-manage-invites').addEventListener('click', openInvites);

        $('#qr-modal-close').addEventListener('click', function () { closeModal($('#qr-modal')); });
        $('#qr-modal').addEventListener('click', function (e) {
            if (e.target === $('#qr-modal')) closeModal($('#qr-modal'));
        });

        $('#btn-group-upload').addEventListener('click', function () { $('#group-file').click(); });
        $('#group-file').addEventListener('change', async function (e) {
            var f = e.target.files[0];
            e.target.value = '';
            if (!f) return;
            var btn = $('#btn-group-upload');
            uploadBusy = true;
            btn.disabled = true;
            renderUploadHint();
            try {
                await uploadMyCourses(f);
            } finally {
                uploadBusy = false;
                btn.disabled = false;
                renderUploadHint();
            }
        });

        $('#btn-group-leave').addEventListener('click', async function () {
            if (!state.group) return;
            if (!await askConfirm('退出群组', '退出后将不再看到这个群组，可以重新用邀请码加入。', '退群')) return;
            try {
                await API.leaveGroup(state.group.code);
                toast('已退出群组');
                state.group = null;
                await goHome();
            } catch (e) { toast(e.message, true); }
        });

        $('#btn-group-delete').addEventListener('click', async function () {
            if (!state.group) return;
            if (!await askConfirm('解散群组', '群组和成员关系会被删除，且无法恢复。', '确认解散')) return;
            try {
                await API.deleteGroup(state.group.code);
                toast('群组已解散');
                state.group = null;
                await goHome();
            } catch (e) { toast(e.message, true); }
        });
    }

    // ------------------------------------------------------------ 网格渲染

    var DAY_NAMES = periods.DAY_NAMES;

    function tableHead() {
        var h = '<thead><tr><th class="period-col">节次</th>';
        for (var d = 1; d <= 7; d++) h += '<th>' + DAY_NAMES[d] + '</th>';
        return h + '</tr></thead>';
    }

    /**
     * 一个课块。
     * @param who 'me' | 'ta' —— 决定边框颜色与标签，永远不靠颜色以外的线索区分
     */
    function blockHtml(entry, who, level, label) {
        var cls = 'course who-' + who + (level === 'single' ? ' bg-single' : ' bg-' + level);
        var dark = (level === 'nearby' || level === 'single');
        var head = '';
        if (label) head += '<span class="parity' + (dark ? ' dark' : '') + '">' + esc(label) + '</span>';
        head += '<span class="tag">' + (who === 'me' ? '[你]' : '[TA]') + '</span>' +
            '<span class="name">' + esc(entry.course) + '</span>';
        var loc = entry.isFirst ? esc(entry.location) : '同上';
        return '<div class="' + cls + '"><div>' + head + '</div>' +
            '<span class="loc">' + loc + '</span></div>';
    }

    /**
     * 把一个格子内两人的课按「上半我的、下半他的」拼起来。
     * 只有一方有课时不分半，直接铺满。
     */
    function cellHtml(cell, label) {
        var me = cell.a.map(function (e) { return blockHtml(e, 'me', cell.level, label); }).join('');
        var ta = cell.b.map(function (e) { return blockHtml(e, 'ta', cell.level, label); }).join('');
        if (me && ta) {
            return '<div class="pair"><div class="half">' + me + '</div>' +
                '<div class="half">' + ta + '</div></div>';
        }
        return me + ta;
    }

    /** 屏幕上显示的网格：单一周、双人对照 */
    function renderScreenTable(table, cells) {
        var html = tableHead() + '<tbody>';
        for (var p = 1; p <= periods.MAX_PERIOD; p++) {
            var info = periods.periodInfo(p);
            html += '<tr><td class="period-col">' + p +
                '<span class="t">' + info.start + '</span></td>';
            for (var d = 1; d <= 7; d++) {
                var c = cells[d + '-' + p];
                var inner = '';
                if (c && c.level !== 'empty') inner = cellHtml(c);
                html += '<td>' + inner + '</td>';
            }
            html += '</tr>';
        }
        table.innerHTML = html + '</tbody>';
    }

    /** 导出用的网格：全学期代表周，单双周分别标注（注意：不带 sticky-head 类） */
    function renderExportTable(table, exportCells) {
        var html = tableHead() + '<tbody>';
        for (var p = 1; p <= periods.MAX_PERIOD; p++) {
            var info = periods.periodInfo(p);
            html += '<tr><td class="period-col">' + p +
                '<span class="t">' + info.start + '</span></td>';
            for (var d = 1; d <= 7; d++) {
                var c = exportCells[d + '-' + p];
                var inner = '';
                if (c) {
                    // 单双周不一致时会有两套 variants，各是一组「上我下他」
                    c.variants.forEach(function (v) {
                        inner += cellHtml(v.cell, v.label);
                    });
                }
                html += '<td>' + inner + '</td>';
            }
            html += '</tr>';
        }
        table.innerHTML = html + '</tbody>';
    }

    // ------------------------------------------------------------ 比对页

    function openCompare(member) {
        state.compareWith = member;
        show('compare', { title: '课表比对', back: function () { openGroup(state.group.code, true); } });
        renderCompare();
    }

    function renderCompare() {
        var me = state.group.members.filter(memberHasMe)[0];
        var ta = state.compareWith;
        if (!me || !ta) return;

        $('#compare-title').textContent = me.nickname + ' ↔ ' + displayName(ta);

        var win = buildWindow([me.courses || [], ta.courses || []]);
        if (state.weekIndex == null || state.weekIndex > win.weekCount) {
            state.weekIndex = weeks.resolveDefaultWeek([me.courses || [], ta.courses || []], win).weekIndex;
        }
        var monday = win.baseMonday ? weeks.mondayOfWeek(win.baseMonday, state.weekIndex) : null;
        var grid = cmp.compareInWeek(me.courses || [], ta.courses || [], monday);

        renderWeeks($('#compare-weeks'), win, state.weekIndex, function (i) {
            state.weekIndex = i;
            renderCompare();
        });

        var notice = $('#compare-notice');
        var total = grid.stats.total;
        if (!total) {
            notice.hidden = false;
            notice.textContent = (me.courses || []).length && (ta.courses || []).length
                ? '这一周你们没有重合的课时。'
                : '还有一方没有上传课表。';
        } else {
            notice.hidden = true;
        }

        $('#compare-stats').textContent = '第 ' + state.weekIndex + ' 周 · 重合 ' + total + ' 节' +
            (total ? '（同教室 ' + grid.stats.same + ' · 同楼栋 ' + grid.stats.nearby +
                ' · 同区域 ' + grid.stats.area + ' · 不同区域 ' + grid.stats.cross +
                (grid.stats.unknown ? ' · 未知 ' + grid.stats.unknown : '') + '）' : '');

        renderScreenTable($('#compare-table'), grid.cells);
    }

    // ------------------------------------------------------------ 导出图片

    // 导出画布宽度。必须先给离屏容器一个确定宽度：
    // 绝对定位 + width:auto 的元素会按内容「收缩适应」，而表格是 width:100%，
    // 结果是 scrollWidth 被撑到上万像素（实测 11266px），导出一张几乎全空的巨图。
    var EXPORT_WIDTH = 1080;

    async function exportImage(slotsA, slotsB, nameA, nameB, baseMonday) {
        if (typeof html2canvas === 'undefined') return toast('截图库未加载', true);
        if (!baseMonday) return toast('没有可导出的课表数据', true);

        var ex = cmp.buildExportGrid(slotsA, slotsB, baseMonday);
        if (!Object.keys(ex.cells).length) return toast('没有可导出的课表数据', true);

        var host = $('#export-host');
        host.innerHTML = '';

        var title = document.createElement('div');
        title.className = 'export-title';
        var d = new Date();
        title.innerHTML = '<h1>' + esc(nameA) + ' 与 ' + esc(nameB) + ' 组团课表</h1>' +
            '<p>全学期' + (ex.parity ? ' · 单双周' : '') + ' · 导出于 ' +
            d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + '</p>';

        var legend = $('#compare-legend').cloneNode(true);
        legend.removeAttribute('id');
        legend.classList.remove('card');

        var wrap = document.createElement('div');
        wrap.className = 'grid-wrap';
        var table = document.createElement('table');
        // 关键：导出模板只带 .schedule，不带 .sticky-head，避免表头被 html2canvas 挤到第二行
        table.className = 'schedule';
        renderExportTable(table, ex.cells);
        wrap.appendChild(table);

        host.appendChild(title);
        host.appendChild(legend);
        host.appendChild(wrap);
        host.hidden = false;
        host.style.width = EXPORT_WIDTH + 'px';
        void host.offsetWidth;   // 强制一次布局，让下面的 scrollWidth 可信
        var canvasW = Math.max(EXPORT_WIDTH, wrap.scrollWidth + 52);
        host.style.width = canvasW + 'px';

        try {
            var canvas = await html2canvas(host, {
                scale: 2,
                backgroundColor: '#f2f2f7',
                useCORS: true,
                width: host.scrollWidth,
                height: host.scrollHeight,
                windowWidth: host.scrollWidth
            });
            var a = document.createElement('a');
            a.download = cleanName(nameA) + '_与_' + cleanName(nameB) + '_组团课表' +
                (ex.parity ? '_单双周' : '') + '.png';
            a.href = canvas.toDataURL('image/png');
            a.click();
            toast('已导出：' + a.download);
        } catch (e) {
            console.error(e);
            toast('截图生成失败，请重试', true);
        } finally {
            host.hidden = true;
            host.innerHTML = '';
            host.style.width = '';
        }
    }

    function initCompare() {
        $('#btn-export').addEventListener('click', function () {
            var me = state.group && state.group.members.filter(memberHasMe)[0];
            var ta = state.compareWith;
            if (!me || !ta) return toast('请先选择要比对的成员', true);
            if (!(me.courses || []).length || !(ta.courses || []).length) {
                return toast('还有一方没有上传课表', true);
            }
            var win = buildWindow([me.courses || [], ta.courses || []]);
            exportImage(me.courses || [], ta.courses || [], me.nickname, ta.nickname, win.baseMonday);
        });
    }

    // ------------------------------------------------------------ 本地比对

    var localInited = false;

    function initLocalOnce() {
        if (localInited) return;
        localInited = true;

        $$('#screen-local input[type=file]').forEach(function (input) {
            input.addEventListener('change', async function (e) {
                var f = e.target.files[0];
                e.target.value = '';
                if (!f) return;
                var which = input.getAttribute('data-local');
                try {
                    var slots = await readIcsFile(f);
                    if (!slots.length) throw new Error('没解析出课程，确认文件格式');
                    state.local[which] = slots;
                    var badge = $('#local-status-' + which);
                    badge.textContent = '已解析 ' + slots.length + ' 个时段';
                    badge.className = 'badge ok';
                    $('#local-drop-' + which).classList.add('active');
                    var auto = extractNameFromFileName(f.name);
                    if (auto && !$('#local-name-' + which).value) $('#local-name-' + which).value = auto;
                } catch (err) {
                    toast(err.message, true);
                }
            });
        });

        $('#btn-local-run').addEventListener('click', function () {
            var A = state.local.a, B = state.local.b;
            if (!A.length || !B.length) return toast('请先上传双方的 .ics 课表文件', true);

            state.local.nameA = $('#local-name-a').value.trim() || '我';
            state.local.nameB = $('#local-name-b').value.trim() || 'TA';

            var win = buildWindow([A, B]);
            state.local.win = win;
            state.local.weekIndex = weeks.resolveDefaultWeek([A, B], win).weekIndex;

            $('#local-legend').hidden = false;
            $('#local-weeks').hidden = false;
            $('#local-week-note').hidden = false;
            $('#local-wrap').hidden = false;
            $('#local-export-card').hidden = false;
            renderLocalGrid();
        });

        $('#btn-local-export').addEventListener('click', function () {
            exportImage(state.local.a, state.local.b, state.local.nameA, state.local.nameB,
                state.local.win && state.local.win.baseMonday);
        });
    }

    function renderLocalGrid() {
        var A = state.local.a, B = state.local.b;
        var win = state.local.win;
        var monday = weeks.mondayOfWeek(win.baseMonday, state.local.weekIndex);

        renderWeeks($('#local-weeks'), win, state.local.weekIndex, function (i) {
            state.local.weekIndex = i;
            renderLocalGrid();
        });

        var grid = cmp.compareInWeek(A, B, monday);
        renderScreenTable($('#local-table'), grid.cells);
    }

    /** 恢复登录状态 / 处理邀请链接 */
    async function restoreSession() {
        if (!API.getToken()) {
            show('auth', { title: '同格', replace: true });
            return;
        }
        try {
            state.me = await API.me();
            await goHome({ replace: true });
            if (state.pendingCode) {
                var c = state.pendingCode;
                state.pendingCode = null;
                await joinByCode(c);
            }
        } catch (e) {
            if (e.status !== 401 && e.status !== 0) toast(e.message, true);
            show('auth', { title: '同格', replace: true });
        }
    }

    // ------------------------------------------------------------ 启动

    function bindGlobal() {
        $('#btn-back').addEventListener('click', function () {
            // 和手机返回手势走同一条路：有历史就退一层
            if (navDepth > 0) history.back();
            else if (backTo) backTo();
        });
        window.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                $$('.modal').forEach(function (m) { closeModal(m); });
            }
        });

        $$('.js-ics-help').forEach(function (b) {
            b.addEventListener('click', function () { $('#ics-modal').hidden = false; });
        });
        $('#ics-modal-close').addEventListener('click', function () { closeModal($('#ics-modal')); });
        // 点遮罩空白处也能关掉
        $$('.modal').forEach(function (m) {
            m.addEventListener('click', function (e) { if (e.target === m) closeModal(m); });
        });
        API.onUnauthorized(function () {
            state.me = null;
            toast('登录状态过期了，请重新登录', true);
            show('auth', { title: '同格', replace: true });
        });

        initMascot();
    }

    // ------------------------------------------------------------ 页脚吉祥物

    /* 左右各一只：左边土豆，右边粉猪，凑成一对。
       每边各自随机轮换，换图时前后不重复。
       先 new Image() 加载好再换 src —— 否则换的瞬间会闪一下空白。
       只在页脚那么一小块地方出现，不挡任何元素。 */
    var POTATOES = [
        'img/mascot/potato-duo.gif',
        'img/mascot/potato-poses.gif',
        'img/mascot/potato-hug.gif',
        'img/mascot/potato-sleep.gif',
        'img/mascot/potato-collage.gif',
        'img/mascot/potato-cheer.gif'
    ];
    var PIGS = [
        'img/mascot/pig-stand.gif',
        'img/mascot/pig-walk.gif',
        'img/mascot/pig-pose.gif',
        'img/mascot/pig-left.gif',
        'img/mascot/pig-pair.gif',
        'img/mascot/pig-face.gif'
    ];

    /* 整张铺满、没有透明背景的那几张：给个圆角，免得看着像一块贴歪的方块。
       只有 potato-cheer 是这种 —— 它是个「深炸」梗图，从第 4 帧起整个画面
       都在烧，根本没有背景可以抠，索性当贴纸用。 */
    var FULL_BLEED = { 'img/mascot/potato-cheer.gif': true };

    var MASCOT_EVERY = 25000;

    function initMascot() {
        // 右边错开半轮，免得两只同时换、看着像在抽搐
        startMascot('#foot-mascot-left', POTATOES, 0);
        startMascot('#foot-mascot-right', PIGS, MASCOT_EVERY / 2);
    }

    /**
     * 一个坑位：立刻随机上一张，然后每 MASCOT_EVERY 换一张。
     * @param offset 首次开始轮换的延迟，用来错开左右两边
     */
    function startMascot(sel, pool, offset) {
        var el = $(sel);
        if (!el || !pool.length) return;

        var cur = Math.floor(Math.random() * pool.length);

        function swapTo(i) {
            var src = pool[i];
            var probe = new Image();
            probe.onload = function () {
                el.src = src;
                el.classList.toggle('tile', !!FULL_BLEED[src]);
                el.hidden = false;
            };
            probe.src = src;
        }

        swapTo(cur);

        setTimeout(function () {
            setInterval(function () {
                var next = cur;
                while (next === cur && pool.length > 1) {
                    next = Math.floor(Math.random() * pool.length);
                }
                cur = next;
                swapTo(cur);
            }, MASCOT_EVERY);
        }, offset);
    }

    // ------------------------------------------------------------ 主题

    var THEME_KEY = 'dsh_theme';

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function applyTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        // 手机浏览器的地址栏颜色跟着走
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', t === 'dark' ? '#000000' : '#f2f2f7');
        $('#btn-theme').textContent = t === 'dark' ? '☀️' : '🌙';
    }

    function initTheme() {
        applyTheme(currentTheme());
        $('#btn-theme').addEventListener('click', function () {
            var next = currentTheme() === 'dark' ? 'light' : 'dark';
            Store.set(THEME_KEY, next);
            applyTheme(next);
        });

        // 跟随系统变化 —— 只在他没手动选过时生效
        if (window.matchMedia) {
            var mq = window.matchMedia('(prefers-color-scheme: dark)');
            var onChange = function (e) {
                if (Store.get(THEME_KEY)) return;
                applyTheme(e.matches ? 'dark' : 'light');
            };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }
    }

    // ------------------------------------------------------------ 内测提示

    var BETA_KEY = 'dsh_beta_seen_1';

    /** 每台设备只弹一次（存本地），弹过就不再打扰 */
    function maybeShowBeta() {
        if (Store.get(BETA_KEY)) return;
        Store.set(BETA_KEY, '1');
        $('#beta-modal').hidden = false;
    }

    function initBeta() {
        $('#beta-owner').textContent = config.owner || '发起人';
        $('#beta-close').addEventListener('click', function () { closeModal($('#beta-modal')); });
    }

    async function boot() {
        initAuth();
        initHome();
        initGroup();
        initManageInvites();
        initCompare();
        bindGlobal();
        initTheme();
        initBeta();
        initHistory();

        var code = qs('code');
        if (code) state.pendingCode = code;

        maybeShowBeta();
        await restoreSession();
    }

    document.addEventListener('DOMContentLoaded', boot);
})();
