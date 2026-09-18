/**
 * 同格 —— 找个课搭子一起上课。前端主逻辑。
 *
 * 依赖：共享纯函数（DSH.periods / DSH.ics / DSH.weeks / DSH.compare / DSH.stats）、API、qrcode、html2canvas。
 */
(function () {
    'use strict';

    var periods = window.DSH.periods;
    var ics = window.DSH.ics;
    var weeks = window.DSH.weeks;
    var cmp = window.DSH.compare;
    var stats = window.DSH.stats;
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

    /**
     * 一个「确定 / 取消」的确认框。
     *
     * @param opts.doubleConfirm 传文案时启用「按两次」：第一下只是上膛（按钮变红、文案换掉），
     *        第二下才真的执行。用在不可逆的操作上（比如把人移出群组），防误触。
     */
    function askConfirm(title, message, okText, opts) {
        opts = opts || {};
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
            var okBtn = $('[data-x=ok]', modal);
            okBtn.textContent = okText || '确定';
            var armed = !opts.doubleConfirm;      // 不需要按两次的，一上来就是「已上膛」
            modal.addEventListener('click', function (e) {
                var x = e.target.getAttribute && e.target.getAttribute('data-x');
                if (x === 'cancel') { dismiss(modal); resolve(false); return; }
                if (x !== 'ok') return;
                if (!armed) {
                    armed = true;
                    okBtn.textContent = opts.doubleConfirm;
                    okBtn.classList.add('armed');
                    return;
                }
                dismiss(modal);
                resolve(true);
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
        stats: null,
        screen: null,
        // 当前邀请卡片里展示的是哪一枚票。null = 按「最新一枚还能用的」自动挑
        activeInvite: null,
        newInviteTtl: 'never'
    };

    function qs(name) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
        return m ? decodeURIComponent(m[1]) : null;
    }

    /**
     * 把邀请码从地址栏摘掉。
     *
     * 不摘的话每次刷新都会拿同一个码再进一次群；链接要是已经过期，还会每次弹一句红字
     * （joinByInvite 先校验码再判成员身份，所以进过群也没用）；成员把地址栏一复制，
     * 又等于把这个码转手了一次。
     *
     * 只动 code 这一个参数：别的查询串和 hash 都留着。
     * 第三个参数传**相对地址** —— 正式服挂在反向代理的子路径下（/tongge/），
     * 绝对路径会把子路径拼没。
     */
    function clearInviteCode() {
        var search = location.search || '';
        var parts = search.replace(/^\?/, '').split('&').filter(function (kv) {
            // 精确比 key，不用 indexOf('code=')：那会把 xcode= 这种参数一起删掉
            return kv && kv.split('=')[0] !== 'code';
        });
        var next = parts.length ? '?' + parts.join('&') : '';
        if (next === search) return;        // 本来就没有，别白动一次历史记录
        // 状态原样传回去：导航栈（{dsh, d}）就存在那里，清掉的话返回手势立刻失效
        history.replaceState(history.state, '', location.pathname + next + (location.hash || ''));
    }

    // ------------------------------------------------------------ 屏幕切换与浏览器历史

    var backTo = null;
    var navStarted = false;   // 第一次切屏用 replaceState，否则第一下返回就白按
    var navSilent = false;    // popstate 触发的重画不要再压新记录
    var navDepth = 0;         // 本次会话自己压了多少层，存在历史记录里

    /**
     * 左上角那颗求 Star：**每次加载**先展开 10 秒把话说清楚，再收回成一颗 ⭐。
     *
     * 计时从「顶栏第一次出现」算起，而不是页面加载那一刻 —— 顶栏在登录页是藏起来的，
     * 从加载就开始计时的话，登录慢一点的人永远看不到那句说明。
     */
    var STAR_OPEN_MS = 10 * 1000;
    var starRevealed = false;
    function revealStar() {
        if (starRevealed) return;                 // 一次加载只展开一次
        var el = $('#btn-star');
        if (!el) return;
        starRevealed = true;
        el.classList.add('open');
        setTimeout(function () { el.classList.remove('open'); }, STAR_OPEN_MS);
    }

    /** 只负责把某一屏画出来，不碰历史 */
    function renderScreen(id, opts) {
        opts = opts || {};
        state.screen = id;
        $$('.screen').forEach(function (s) { s.classList.toggle('active', s.id === 'screen-' + id); });
        var topbar = $('#topbar');
        topbar.hidden = id === 'auth';
        if (!topbar.hidden) revealStar();
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
        if (id === 'account') {
            // 返回手势落到账号屏：登录状态还在就能还原，否则回首页
            if (state.me) return openAccount();
            return fallbackHome();
        }
        if (id === 'stats') {
            // 统计是管理员专属：权限中途没了（被撤管 / 会话过期）就回首页
            if (state.me && state.me.admin) return openStats();
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
        ['#auth-nickname', '#auth-password', '#auth-confirm', '#auth-captcha'].forEach(function (sel) {
            $(sel).classList.remove('invalid');
        });
    }

    // 注册验证码：服务端出一道四则运算并画成 PNG，前端只负责显示和「换一张」
    var captchaOn = false;
    var captchaId = '';
    // 登录什么时候开始要验证码由服务端定（同一个昵称连错两次），这里只跟着它的标志走
    var loginCaptchaNeeded = false;

    /** 这一格该不该出现：注册一定要；登录则看服务端有没有判「要验证码」 */
    function captchaVisible() {
        return captchaOn && (authMode === 'register' || loginCaptchaNeeded);
    }

    async function refreshCaptcha() {
        var img = $('#auth-captcha-img');
        try {
            var r = await API.captcha();
            captchaOn = r.enabled !== false;
            captchaId = r.id || '';
            if (captchaOn && r.image) img.src = r.image;
        } catch (e) {
            // 出题接口都挂了就别拿它拦着人登录/注册；真需要拦，服务端会自己回 400
            captchaOn = false;
            captchaId = '';
        }
        $('#auth-captcha-field').hidden = !captchaVisible();
        $('#auth-captcha-label').textContent = authMode === 'register'
            ? '验证码 · 算一算图里的式子'
            : '验证码 · 密码连错两次了，算一算再试';
        $('#auth-captcha').value = '';
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
            // 切到注册一定要题；切回登录时，如果之前被判过「要验证码」就留着
            if (isReg || loginCaptchaNeeded) refreshCaptcha();
            else $('#auth-captcha-field').hidden = true;
            $('#auth-submit').textContent = isReg ? '注册并登录' : '登录';
            $('#auth-password').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
            clearAuthMarks();
        });

        // 回车提交交给 form 自己处理，不用逐个 input 挂 keydown
        $('#auth-form').addEventListener('submit', function (e) {
            e.preventDefault();
            doAuth();
        });

        // 看不清 / 想换一题：点图就换。服务端一次性核销，换一张就是换一个 id
        $('#auth-captcha-img').addEventListener('click', function () { refreshCaptcha(); });

        // 一开始重新输入就把上一次的红字擦掉，别让它一直杵在那
        ['#auth-nickname', '#auth-password', '#auth-confirm', '#auth-captcha'].forEach(function (sel) {
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
        if (captchaVisible() && !$('#auth-captcha').value.trim()) {
            $('#auth-captcha').classList.add('invalid');
            $('#auth-captcha').focus();
            return authError('把图里的算式算出来填上');
        }

        btn.disabled = true;
        btn.textContent = isReg ? '注册中…' : '登录中…';
        try {
            var box = captchaVisible()
                ? { id: captchaId, answer: $('#auth-captcha').value.trim() }
                : null;
            var r = isReg
                ? await API.register(nickname, password, box)
                : await API.login(nickname, password, box);
            API.setToken(r.token);
            loginCaptchaNeeded = false;          // 登进去了，连错计数也就清了
            state.me = await API.me();
            toast(isReg ? '注册成功，欢迎！' : '欢迎回来，' + state.me.nickname);
            await goHome({ replace: true });   // 登录页不该能后退回去
            if (state.pendingCode) {
                var code = state.pendingCode;
                state.pendingCode = null;
                await joinByCode(code);
            }
        } catch (e) {
            // 服务端判「下次要带验证码」就把它显示出来；刷新过页面、本地没状态时它会直接回 400
            if (e.captchaRequired || (!isReg && e.status === 400)) loginCaptchaNeeded = true;
            // 验证码是一次性的：只要它露在界面上，失败之后就换一张
            if (captchaVisible()) await refreshCaptcha();
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
                authError('连不上服务器，检查网络后重试');
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
        admin_reset_password: '重置密码',
        group_transfer: '转让群主',
        group_transfer_blocked: '转让被拦（密码错太多）'
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

    // ------------------------------------------------------------ 管理页筛选

    /**
     * 管理页的筛选与排序状态。
     *
     * 全部在浏览器里算：/api/admin/overview 本来就把全部账号、连同 regAt /
     * lastLoginAt / loginCount / idleDays / courseCount / admin / suspect / dormant
     * 一次性发过来了，再往服务端加查询参数只会给每次输入加一个来回。
     */
    var adminFilter = defaultAdminFilter();

    function defaultAdminFilter() {
        return {
            q: '',
            status: 'all',      // all | admin | suspect | dormant | nocourse | hascourse
            sort: 'regAt',
            dir: 'desc',        // 默认最新注册在前：查批量注册时这个顺序才有用
            regFrom: '', regTo: '',
            idleMin: '',
            loginMin: '', loginMax: '',
            courseMin: '', courseMax: ''
        };
    }

    /** 输入框里的数字：空字符串是「不限」，不是 0 —— 用 Number('') 会得到 0 */
    function parseNum(v) {
        var s = String(v == null ? '' : v).trim();
        if (!s) return null;
        var n = Number(s);
        return isFinite(n) ? n : null;
    }

    /**
     * 'YYYY-MM-DD' -> 当天 00:00 的**本地**时间戳。
     *
     * 不能用 new Date('2026-09-15')：那会被解析成 UTC 午夜。东八区下，
     * 9 月 15 日 00:00–08:00 注册的账号会落到这个值之前，被错误地排除在
     * 「9 月 15 日」之外 —— 而那批深夜注册恰恰是最该被筛出来的。
     */
    function dayStart(s) {
        var p = String(s || '').split('-');
        if (p.length !== 3) return null;
        var d = new Date(+p[0], +p[1] - 1, +p[2]);
        return isNaN(d.getTime()) ? null : d.getTime();
    }

    /** 区间判定：min > max 就交换。填反了意思很清楚，不该变成一个错误态 */
    function inRange(v, min, max) {
        var lo = min, hi = max;
        if (lo != null && hi != null && lo > hi) { var t = lo; lo = hi; hi = t; }
        if (lo != null && v < lo) return false;
        if (hi != null && v > hi) return false;
        return true;
    }

    var ADMIN_SORT_KEY = {
        regAt: function (u) { return u.regAt || 0; },
        lastLoginAt: function (u) { return u.lastLoginAt || 0; },
        loginCount: function (u) { return u.loginCount || 0; },
        courseCount: function (u) { return u.courseCount || 0; },
        idleDays: function (u) { return u.idleDays || 0; },
        nickname: function (u) { return u.nickname || ''; }
    };

    /** 有没有一条筛选是生效的 —— 决定列表要不要关掉入场动画 */
    function adminFilterActive() {
        var f = adminFilter;
        return !!(f.q || f.status !== 'all' || f.regFrom || f.regTo ||
            parseNum(f.idleMin) != null || parseNum(f.loginMin) != null ||
            parseNum(f.loginMax) != null || parseNum(f.courseMin) != null ||
            parseNum(f.courseMax) != null);
    }

    /**
     * 账号筛选 + 排序（纯函数，不改入参）。
     *
     * 账号列表、待清理、异常注册三处共用它 —— 同一个页面上只能有一套规则，
     * 否则「按登录次数降序」之后账号列表重排了、下面那张卡片还是老顺序，
     * 看上去就是随机的。
     */
    function filterAdminUsers(users) {
        var f = adminFilter;
        var q = f.q.toLowerCase();
        var regFrom = dayStart(f.regFrom);
        // 上界取当天最后一毫秒：选「到 9 月 18 日」时，18 日当天注册的必须算在内
        var regToDay = dayStart(f.regTo);
        var regTo = regToDay == null ? null : regToDay + 86400000 - 1;
        var idleMin = parseNum(f.idleMin);
        var loginMin = parseNum(f.loginMin), loginMax = parseNum(f.loginMax);
        var courseMin = parseNum(f.courseMin), courseMax = parseNum(f.courseMax);

        var out = users.filter(function (u) {
            if (q) {
                // 两个 IP 都认：可疑 IP 常常来自登录记录而不是注册记录，
                // 只认一个的话「搜不到」会被读成「没这个人」
                var hay = (u.nickname + ' ' + (u.regIp || '') + ' ' + (u.lastLoginIp || '')).toLowerCase();
                if (hay.indexOf(q) < 0) return false;
            }
            if (f.status === 'admin' && !u.admin) return false;
            if (f.status === 'suspect' && !u.suspect) return false;
            if (f.status === 'dormant' && !u.dormant) return false;
            if (f.status === 'nocourse' && (u.courseCount || 0) > 0) return false;
            if (f.status === 'hascourse' && !((u.courseCount || 0) > 0)) return false;
            if (regFrom != null && (u.regAt || 0) < regFrom) return false;
            if (regTo != null && (u.regAt || 0) > regTo) return false;
            if (idleMin != null && (u.idleDays || 0) < idleMin) return false;
            if (!inRange(u.loginCount || 0, loginMin, loginMax)) return false;
            if (!inRange(u.courseCount || 0, courseMin, courseMax)) return false;
            return true;
        });

        var key = ADMIN_SORT_KEY[f.sort] || ADMIN_SORT_KEY.regAt;
        var sign = f.dir === 'asc' ? 1 : -1;
        out.sort(function (a, b) {                     // filter 返回的是新数组，排它不影响 state
            var x = key(a), y = key(b);
            if (typeof x === 'string' || typeof y === 'string') {
                return String(x).localeCompare(String(y), 'zh') * sign;
            }
            if (x === y) return 0;                     // 并列时保持服务端原顺序（V8 稳定排序）
            return (x < y ? -1 : 1) * sign;
        });
        return out;
    }

    /** 账号卡片：筛出多少个 / 一共多少个 */
    function accountCountText(shown, total) {
        if (!adminFilterActive() || shown === total) return total + ' 个';
        return '筛出 ' + shown + ' 个 · 共 ' + total + ' 个';
    }

    /**
     * 待清理 / 异常注册卡片：把**被筛掉**的数量说出来。
     *
     * 筛选态下光看一个「0 个」很容易读成「已经没有这种账号了」，
     * 而真相是它们被当前筛选挡住了。这个数字就是用来堵这个误读的。
     */
    function subsetCountText(shown, total) {
        if (!adminFilterActive() || shown === total) return shown + ' 个';
        return '筛出 ' + shown + ' 个 · 另有 ' + (total - shown) + ' 个被当前筛选挡住';
    }

    /** 进页面和点「清空筛选」都走这里：筛选是临时的查看动作，不是配置 */
    function resetAdminFilter() {
        adminFilter = defaultAdminFilter();
        $('#admin-user-filter').value = '';
        $('#admin-sort').value = adminFilter.sort;
        $('#admin-sort-dir').textContent = '↓ 降序';
        $$('#admin-status button').forEach(function (b) {
            b.classList.toggle('on', b.getAttribute('data-status') === 'all');
        });
        ['#admin-reg-from', '#admin-reg-to', '#admin-idle-min', '#admin-login-min',
            '#admin-login-max', '#admin-course-min', '#admin-course-max'
        ].forEach(function (sel) { $(sel).value = ''; });
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
        // 筛选是临时的查看动作，不是配置：每次进来都从默认条件开始，
        // 免得下次看到一份被上次筛过的列表却想不起来自己筛过什么
        resetAdminFilter();
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

        $('#admin-group-count').textContent = a.groups.length + ' 个';

        renderAdminUsers();
        renderAdminSubsets();

        $('#admin-groups').innerHTML = a.groups.length
            ? a.groups.map(adminGroupRow).join('')
            : '<div class="empty">一个群组都没有</div>';

        $('#admin-audit').innerHTML = a.audit.length
            ? a.audit.map(function (e) {
                return '<div class="item admin-row"><div class="grow">' +
                    '<div class="title adt">' + esc(AUDIT_LABEL[e.event] || e.event) + '</div>' +
                    '<div class="sub">' + fmtTime(e.at) + (auditDetail(e) ? ' · ' + esc(auditDetail(e)) : '') +
                    '</div></div></div>';
            }).join('')
            : '<div class="empty">还没有日志</div>';
    }

    /** 列表重画时关掉入场动画：否则每敲一个字、每点一下胶囊都要重播一次 */
    function setAdminListAnim() {
        var on = adminFilterActive();
        ['#admin-users', '#admin-dormant', '#admin-suspects'].forEach(function (sel) {
            var el = $(sel);
            if (el) el.classList.toggle('no-anim', on);
        });
    }

    function renderAdminUsers() {
        var all = (state.admin && state.admin.users) || [];
        var users = filterAdminUsers(all);
        $('#admin-users').innerHTML = users.length
            ? users.map(adminUserRow).join('')
            : '<div class="empty">没有匹配的账号</div>';
        $('#admin-user-count').textContent = accountCountText(users.length, all.length);
        setAdminListAnim();
    }

    /**
     * 「待清理」和「异常注册」两张卡片。
     *
     * 它们跟着筛选一起缩，所以**什么时候藏卡片**要按全量判断，不能按筛完的结果：
     * 否则筛「管理员」时这两张卡会整个消失，「被挡住 N 个」那句提示就没地方写了 ——
     * 而那句提示正是为了不让人把「被筛掉了」读成「已经没有这种账号了」。
     */
    function renderAdminSubsets() {
        var a = state.admin;
        if (!a) return;
        var users = filterAdminUsers(a.users);

        // 待清理：只列出来给人看，不自动删 —— 到底是不是废号，人和人之间的
        // 情况只有群主知道（有人就是注册了先放着，开学才传课表）
        var dorm = users.filter(function (u) { return u.dormant; });
        $('#admin-dormant-card').hidden = !a.stats.dormantCount;
        $('#admin-dormant-count').textContent = subsetCountText(dorm.length, a.stats.dormantCount);
        $('#admin-dormant').innerHTML = dorm.length
            ? dorm.map(function (u) {
                return '<div class="item admin-row"><div class="grow">' +
                    '<div class="title">' + esc(u.nickname) + '</div>' +
                    '<div class="sub">' + u.idleDays + ' 天没露面 · 注册 ' + fmtTime(u.regAt) +
                    (u.regIp ? ' · ' + esc(u.regIp) : '') + '</div>' +
                    '<div class="sub">' + (u.loginCount ? '登录 ' + u.loginCount + ' 次' : '无登录记录') +
                    ' · 一次课表都没传过</div>' +
                    '</div><div class="row-acts">' +
                    '<button class="row-remove" data-deluser="' + esc(u.id) + '">删除</button>' +
                    '</div></div>';
            }).join('')
            : '<div class="empty">当前筛选下没有待清理的账号</div>';

        // 异常注册从 users 里派生，而不是用 a.suspects —— listSuspects() 返回的是
        // 精简副本（只有昵称/IP/原因，没有 id、idleDays、courseCount），根本没法参与筛选。
        // users[] 里本来就有 suspect + suspectReason，判定条件（u.suspect）完全一样。
        var suspects = users.filter(function (u) { return u.suspect; });
        $('#admin-suspect-card').hidden = !a.stats.suspectCount;
        $('#admin-suspect-count').textContent = subsetCountText(suspects.length, a.stats.suspectCount);
        $('#admin-suspects').innerHTML = suspects.length
            ? suspects.map(function (s) {
                return '<div class="item admin-row"><div class="grow">' +
                    '<div class="title">' + esc(s.nickname) + '</div>' +
                    '<div class="sub">' + esc(s.regIp || '（未记录）') + ' · ' +
                    esc(s.suspectReason || '同 IP 集中注册') + ' · ' + fmtTime(s.regAt) + '</div></div></div>';
            }).join('')
            : '<div class="empty">当前筛选下没有待复核的账号</div>';
    }

    /**
     * 筛选条件变了只重画「会被筛到的部分」。
     *
     * 不走整个 renderAdmin()：那会把概览那六个数字再 countUp 一遍、
     * 审计日志再排一次 —— 每敲一个字都滚一次数字，纯属干扰。
     */
    function applyAdminFilter() {
        renderAdminUsers();
        renderAdminSubsets();
    }

    /** 筛选控件的接线。用到的容器都是 index.html 里的固定元素，绑一次就够 */
    function initAdminFilter() {
        $('#admin-user-filter').addEventListener('input', function (e) {
            adminFilter.q = e.target.value.trim();
            applyAdminFilter();
        });

        // 状态胶囊：和 #join-mode / #inv-ttl 同一套写法，挂在不会被替换的容器上
        $('#admin-status').addEventListener('click', function (e) {
            var btn = e.target.closest && e.target.closest('button[data-status]');
            if (!btn) return;
            var s = btn.getAttribute('data-status');
            if (s === adminFilter.status) return;
            adminFilter.status = s;
            $$('#admin-status button').forEach(function (b) {
                b.classList.toggle('on', b.getAttribute('data-status') === s);
            });
            applyAdminFilter();
        });

        $('#admin-sort').addEventListener('change', function (e) {
            adminFilter.sort = e.target.value;
            applyAdminFilter();
        });

        $('#admin-sort-dir').addEventListener('click', function () {
            adminFilter.dir = adminFilter.dir === 'asc' ? 'desc' : 'asc';
            $('#admin-sort-dir').textContent = adminFilter.dir === 'asc' ? '↑ 升序' : '↓ 降序';
            applyAdminFilter();
        });

        $('#admin-more-toggle').addEventListener('click', function () {
            var box = $('#admin-more');
            box.hidden = !box.hidden;
            $('#admin-more-toggle').textContent = box.hidden ? '更多筛选' : '收起筛选';
        });

        // 数字框边敲边筛；日期框浏览器只保证 change，所以两种事件都听
        [['#admin-reg-from', 'regFrom'], ['#admin-reg-to', 'regTo'],
            ['#admin-idle-min', 'idleMin'],
            ['#admin-login-min', 'loginMin'], ['#admin-login-max', 'loginMax'],
            ['#admin-course-min', 'courseMin'], ['#admin-course-max', 'courseMax']
        ].forEach(function (pair) {
            var el = $(pair[0]);
            var onEdit = function (e) {
                adminFilter[pair[1]] = e.target.value;
                applyAdminFilter();
            };
            el.addEventListener('input', onEdit);
            el.addEventListener('change', onEdit);
        });

        $('#admin-filter-reset').addEventListener('click', function () {
            resetAdminFilter();
            applyAdminFilter();
            toast('筛选已清空');
        });
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
            // 卡片上印的是**一枚能用的票**（服务端算好的 shareCode），不是群码 ——
            // 群码已经不能用来入群了（它是群的地址），印出来等于让人去复制一段
            // 打不开的链接。成员分享被关掉、或者一枚票都没有时，shareCode 就是 null，
            // 这行字整段不印。
            // 注意 data-code 不能动：整张卡片就是靠它进群的。改的只是印出来的那行字
            return '<button class="item" data-code="' + esc(g.code) + '">' +
                '<div class="grow"><div class="title">' + esc(g.name) +
                (g.pending ? ' <span class="chip-lv nearby">等群主同意</span>' : '') + '</div>' +
                '<div class="sub">' + (g.shareCode ? '邀请码 ' + esc(g.shareCode) + ' · ' : '') +
                g.memberCount + ' 人' +
                (g.isCreator ? ' · 你是群主' : '') + '</div></div>' +
                '<span class="chev">›</span></button>';
        }).join('');
        $$('#home-groups .item').forEach(function (el) {
            el.addEventListener('click', function () { openGroup(el.getAttribute('data-code')); });
        });
    }

    /** 注销账号：连着两道提醒 —— 先把后果摆清楚，再要一次密码 */
    async function deleteAccount() {
        var owned = (state.groups || []).filter(function (g) { return g.isCreator && !g.pending; });
        var hint = '账号、课表、备注都会被删除，无法恢复。';
        if (owned.length) {
            hint += '\n你是 ' + owned.length + ' 个群的群主（' +
                owned.map(function (g) { return g.name; }).join('、') +
                '），群主会自动转给群里最早加入的成员；只有你自己的群会直接解散。';
        }

        // 第一道提醒：这一步不收集任何东西，只是把后果摆出来 ——
        // 从菜单手滑点进来的人，到这儿就会退出去
        if (!await askConfirm('注销账号', hint, '我明白，继续')) return;

        // 第二道提醒：真要注销，还得再输一次密码
        var pw = await askText({
            title: '注销账号 · 最后一步',
            hint: '输入密码确认。这一步之后，账号、课表和备注就真的没了。',
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

    // ------------------------------------------------------------ 账号屏

    /**
     * 账号屏。注销从「更多」菜单搬到了这里。
     *
     * 搬家的理由不是「更安全」（两道提醒本来就够），是**层级**：
     * 原来它和「退出登录」一起红着、挨着排在 ⋯ 菜单里 —— 菜单一共 5 项、红色占 2 项，
     * 而退出登录恰好是那个菜单里最常点的一项。可逆的退出不该和不可逆的注销
     * 共享同一个红色信号，也不该挤在一起。
     */
    async function openAccount() {
        show('account', { title: '账号', back: goHome });
        renderAccount();
    }

    function renderAccount() {
        $('#account-nickname').textContent = (state.me && state.me.nickname) || '';
    }

    function initAccount() {
        $('#btn-change-password').addEventListener('click', changePassword);
        $('#btn-delete-account').addEventListener('click', function () { deleteAccount(); });
    }

    /**
     * 改密码：三个框（旧 / 新 / 再输一遍）。
     *
     * **改完之后这台设备也会被踢下线**：服务端 setUserPassword() 结尾是
     * revokeUserSessions(id)，把该用户的全部会话一起吊销，当前这条也在内
     * （server.test.js 明确钉着「成功后旧会话全失效」）。所以成功之后要拿新密码
     * **静默重登**一次，否则用户改完密码随手点一下就被扔回登录页，像是出了 bug。
     *
     * 不去改服务端让它保留当前会话：吊销全部是更值钱的性质 —— 万一改密码的人
     * 是偷到令牌的，他改完就失去访问，不能把新密码据为己有。为省一次自动登录
     * 去削弱它不划算。
     */
    async function changePassword() {
        var pw = await askNewPassword();
        if (!pw) return;

        try {
            await API.changePassword(pw.oldPassword, pw.newPassword);
        } catch (e) {
            // 401 旧密码不对、429 错太多次被限速 —— 原样告诉用户，让他重来
            toast(e.message, true);
            return;
        }

        // 令牌这会儿已经随全部会话一起失效了，用新密码把自己登回来
        try {
            var r = await API.login(state.me.nickname, pw.newPassword);
            API.setToken(r.token);
            toast('密码已改 · 其他设备上的登录都失效了');
        } catch (e) {
            // 静默重登也可能失败（比如这个昵称刚被要求过验证码）。
            // 那就老实退回登录页 —— 别把人留在一个点什么都报错的界面上
            API.setToken('');
            state.me = null;
            toast('密码已改，请用新密码重新登录');
            show('auth', { title: '同格', replace: true });
        }
    }

    /**
     * 改密码的弹窗：三个框。
     *
     * 三类最蠢的错在本地就拦掉（太短 / 两次不一致 / 新密码和旧的一样）：
     * 这些没必要往服务端跑一趟，而且错了还得把旧密码再打一遍。
     *
     * 里面的元素一律用 **class 选择器**，不用 id —— 这个弹窗是拼字符串拼出来的，
     * 而 frontend.test.js 会检查「app.js 里查的每个 #id 都在 index.html 里」，
     * 用 id 反而会逼着这些临时元素去 index.html 占坑。
     *
     * @returns {Promise<{oldPassword:string, newPassword:string}|null>} 取消为 null
     */
    function askNewPassword() {
        return new Promise(function (resolve) {
            var modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML =
                '<div class="inner" style="text-align:left;max-width:360px">' +
                '<h2 style="font-size:16px;margin-bottom:8px">修改密码</h2>' +
                '<p class="tiny" style="margin-bottom:14px">' +
                '改完之后，其他设备上的登录会全部失效 —— 这台会帮你自动登回来。</p>' +
                '<label class="field"><span>现在的密码</span>' +
                '<input class="input" type="password" data-k="old" maxlength="64" autocomplete="current-password"></label>' +
                '<label class="field"><span>新密码</span>' +
                '<input class="input" type="password" data-k="new" maxlength="64" autocomplete="new-password"></label>' +
                '<label class="field"><span>再输一遍新密码</span>' +
                '<input class="input" type="password" data-k="again" maxlength="64" autocomplete="new-password"></label>' +
                '<p class="tiny pw-err" hidden></p>' +
                '<div class="row" style="margin-top:14px">' +
                '<button class="btn secondary" data-x="cancel">取消</button>' +
                '<button class="btn" data-x="ok">改密码</button>' +
                '</div></div>';

            var field = function (k) { return $('input[data-k="' + k + '"]', modal); };
            var err = $('.pw-err', modal);

            function fail(msg, el) {
                err.textContent = msg;
                err.hidden = false;
                el.classList.add('invalid');
                el.focus();
            }
            function done(val) {
                dismiss(modal);
                resolve(val);
            }

            // 一动手就把红字和红框撤掉，别让用户对着上一条错误发呆
            $$('input', modal).forEach(function (i) {
                i.addEventListener('input', function () {
                    i.classList.remove('invalid');
                    err.hidden = true;
                });
            });

            modal.addEventListener('click', function (e) {
                var x = e.target.getAttribute && e.target.getAttribute('data-x');
                if (x === 'cancel') return done(null);
                if (x !== 'ok') return;

                var oldPw = field('old').value;
                var np = field('new').value;
                var again = field('again').value;
                if (!oldPw) return fail('先填一下现在的密码', field('old'));
                if (np.length < 6) return fail('新密码至少 6 位', field('new'));
                if (np !== again) return fail('两次输入的新密码不一样', field('again'));
                if (np === oldPw) return fail('新密码不能和现在的密码一样', field('new'));
                done({ oldPassword: oldPw, newPassword: np });
            });

            document.body.appendChild(modal);
            setTimeout(function () { field('old').focus(); }, 50);
        });
    }

    function initHome() {
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
        $('#btn-admin-stats').addEventListener('click', function () { openStats(); });
        initAdminDelegates();
        initAdminFilter();
        initStats();
    }

    // ------------------------------------------------------------ 统计页

    /** 动作 key -> 中文。列表顺序＝这个对象的键顺序：先「产出」，后管理动作 */
    var STATS_ACTION_LABEL = {
        course_upload: '传课表',
        group_create: '建群',
        group_join: '入群',
        group_leave: '退群',
        invite_create: '生成邀请链接',
        group_transfer: '转让群主',
        password_change: '改密码',
        account_delete: '注销账号',
        admin_action: '管理动作'
    };

    /** 当前看的窗口。7 / 30 / 90 是服务端的白名单，前端只在这三档里切 */
    var statsDays = 30;

    async function openStats() {
        if (!state.me || !state.me.admin) return fallbackHome();
        // 返回键回管理页：统计是从那儿进来的，回首页会让人以为自己退了两层
        show('stats', { title: '统计', back: openAdmin });
        $('#stats-today').innerHTML = '<div class="spinner">统计中…</div>';
        await loadStats();
    }

    async function loadStats() {
        try {
            state.stats = await API.adminStats(statsDays);
        } catch (e) {
            // 401 由 onUnauthorized 统一处理（跳登录页），这里再 fallback 会把人拽回「已登出」的首页
            if (e.status === 401) return;
            toast(e.message, true);
            $('#stats-today').innerHTML = '<div class="empty">拉不到统计数据</div>';
            return;
        }
        renderStats();
    }

    function statTile(n, label) {
        return '<div class="stat"><b>' + (n == null ? 0 : n) + '</b><span>' + label + '</span></div>';
    }

    /**
     * 迷你折线。用 innerHTML 拼 `<svg>`，而不是 createElementNS：
     * 这样测试里的 DOM 垫片也能断言（垫片没有 SVG 那套 DOM API），
     * 而浏览器解析 HTML 里的 `<svg>` 本来就是支持的。
     *
     * 没有数据（或整段全是 0）时**不画线**，给一句说明 —— 一条贴着底边的线
     * 会被读成「真的没人来过」，而实际情况往往是「还没开始记」。
     */
    function drawSpark(sel, values) {
        var box = $(sel);
        if (!box) return;
        var vals = values || [];
        if (!vals.length || stats.seriesMax(vals) === 0) {
            box.innerHTML = '<div class="spark-empty tiny">还没有数据</div>';
            return;
        }
        box.innerHTML = '<svg viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true">' +
            '<path d="' + stats.sparkPath(vals, 300, 60) + '"></path></svg>';
    }

    function renderStats() {
        var s = state.stats;
        if (!s) return;
        var sum = s.summary || {};
        var range = sum.range || {};
        var today = sum.today || {};
        var days = s.days || statsDays;

        $('#stats-window').textContent = s.from + ' ~ ' + s.to;
        $('#stats-today').innerHTML = [
            statTile(today.active, '今日活跃'),
            statTile(today.newUsers, '今日新增'),
            statTile(range.activeUnique, days + ' 天活跃'),
            statTile(range.newUsers, days + ' 天新增'),
            statTile(range.requests, days + ' 天请求'),
            statTile(range.avgRequestsPerActive, '人均请求')
        ].join('');

        // 口径写在界面上：不写清楚「留存」这两个字，谁都能读出自己的意思
        var ret = sum.retention7 || { cohort: 0, returned: 0, rate: 0 };
        $('#stats-retention').textContent = ret.cohort
            ? '7 日留存：7 天前新增的 ' + ret.cohort + ' 个账号里，今天还有 ' + ret.returned +
              ' 个在活跃（' + Math.round(ret.rate * 100) + '%）。'
            : '7 日留存：7 天前还没有新增记录，暂时算不出来。';

        drawSpark('#stats-active-spark', s.series.map(function (r) { return r.active; }));
        drawSpark('#stats-new-spark', s.series.map(function (r) { return r.newUsers; }));

        // 白名单里的每一项都列出来（0 也显示）：「这个动作没人做」和「这个动作没统计」
        // 是两件不同的事，列表里缺一行会让人以为是后者
        var acts = sum.actions || {};
        $('#stats-actions-sub').textContent = days + ' 天合计';
        $('#stats-actions').innerHTML = Object.keys(STATS_ACTION_LABEL).map(function (k) {
            return '<div class="item"><div class="grow"><div class="title">' + STATS_ACTION_LABEL[k] +
                '</div></div><b class="num">' + (acts[k] || 0) + '</b></div>';
        }).join('');

        $('#stats-top-sub').textContent = '按活跃天数排的前 10';
        $('#stats-courses').textContent = '人均 ' + (sum.avgCourses == null ? 0 : sum.avgCourses) +
            ' 个课时段 · ' + (sum.courseUploaded || 0) + ' 人传过课表';
        $('#stats-top').innerHTML = (s.top && s.top.length)
            ? s.top.map(function (t) {
                return '<div class="item"><div class="grow"><div class="title">' + esc(t.nickname) +
                    '</div><div class="sub">活跃 ' + t.activeDays + ' 天 · 请求 ' + t.requests +
                    (t.lastAt ? ' · 最后 ' + fmtTime(t.lastAt) : '') + '</div></div></div>';
            }).join('')
            : '<div class="empty">还没有统计数据 —— 从这一版上线那天开始记</div>';
    }

    function initStats() {
        $('#stats-range').addEventListener('click', function (e) {
            var btn = e.target.closest && e.target.closest('button[data-days]');
            if (!btn) return;
            var d = Number(btn.getAttribute('data-days'));
            if (!d || d === statsDays) return;
            statsDays = d;
            $$('#stats-range button').forEach(function (b) { b.classList.toggle('on', b === btn); });
            loadStats();
        });
    }

    async function joinByCode(code) {
        try {
            var r = await API.joinGroup(code);
            // 码用掉了：进群和「已提交申请」都算，它的任务到此结束
            clearInviteCode();
            await loadGroups();
            if (r.pending) {
                toast('已申请加入「' + r.name + '」，等群主同意');
                await goHome();
                return true;
            }
            toast('已加入「' + r.name + '」');
            // 用**服务端回给我们的群码**去打开，而不是地址栏里那串 ——
            // 地址栏里那串是**票**（群码已经不能入群了）。拿票去拉群详情会 404，
            // 页面就掉回首页，看着像「明明加进去了却打不开」
            await openGroup(r.code || code);
            return true;
        } catch (e) {
            if (e.status === 401) { state.pendingCode = code; return false; }
            // 链接本身不成立（404 没这个码 / 410 过期或被作废）：也擦掉。
            // 留着它只会每次刷新都重弹一遍这个红字，而它永远不会再成功。
            // 其余情况（限流 429、群满 400、网络断了 0）码还是好的，留着让用户能再试
            if (e.status === 404 || e.status === 410) clearInviteCode();
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
            // 备注 / 移除 竖着排：横排时两颗紧挨着，手指点在交界处很容易点错
            '<div class="row-acts">' +
            '<button class="row-note" data-note="' + esc(m.id) + '">备注</button>' +
            (canRemove ? '<button class="row-remove" data-remove="' + esc(m.id) + '">移除</button>' : '') +
            '</div>' +
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
        // 转让：群主才有资格，而且群里得真有别人可转。
        // 没别人时藏掉 —— 留一颗点了必然报错的按钮等于设陷阱，和下面 #btn-group-leave 同理
        var transferable = g.members.filter(function (m) { return !memberHasMe(m); });
        $('#btn-transfer-group').hidden = !iAmOwner || !transferable.length;
        renderUploadHint();
        $('#btn-group-delete').hidden = !iAmOwner;
        // 群主没有「退群」这条路 —— 服务端也会拒（「你是群主，可以直接解散群组」），
        // 与其让他点了之后吃一个红字报错，不如直接把这颗按钮藏掉
        $('#btn-group-leave').hidden = iAmOwner;

        // 邀请卡片有三种状态，都在这里定：
        //   1. 有能用的票      -> 码 + 二维码 + 三颗可用按钮
        //   2. 成员分享被关掉  -> #invite-closed（成员专用）
        //   3. 一枚能用的票都没有 -> #invite-empty（群主看到出口，成员看到「找群主要」）
        // 第 3 种以前是「——」占位符 + 一张空二维码 + 三颗灰按钮 ——
        // 那不像「暂时没码」，像「页面坏了」。以前群主有「自己的永久码」兜底，
        // 所以只有成员会看到它 —— 那个不对称也一起修了（见 §6.2 的空态）
        // 卡片本身留着：它是群组页的一部分，凭空消失更让人摸不着头脑
        var memberShareOff = !iAmOwner && g.memberShare === false;
        var shareBox = $('#invite-share-box');
        var closedBox = $('#invite-closed');
        var emptyBox = $('#invite-empty');
        var canShare = false;

        if (memberShareOff) {
            shareBox.hidden = true;
            closedBox.hidden = false;
            emptyBox.hidden = true;
        } else {
            closedBox.hidden = true;
            var disp = currentDisplayCode();
            var codeEl = $('#group-code');
            var noteEl = $('#group-current-note');
            var qrBox = $('#group-qr');
            var urlEl = $('#group-url');
            canShare = !!disp;

            if (disp) {
                emptyBox.hidden = true;
                shareBox.hidden = false;
                codeEl.textContent = disp.code;
                urlEl.hidden = false;
                renderQr(disp.code);
                // 讲清楚这枚码还能用多久（没有「群主自己的永久码」这种东西了）
                if (disp.invite.expiresAt == null) {
                    noteEl.textContent = '这条链接永久有效。';
                } else {
                    noteEl.textContent = '这条链接' + inviteStateText(disp.invite) + '。';
                }
            } else {
                // 一枚能用的票都没有：整块换成说明，不摆占位符和空二维码
                shareBox.hidden = true;
                emptyBox.hidden = false;
                qrBox.innerHTML = '';
                renderInviteEmpty(iAmOwner);
            }
        }

        // 分享按钮在没有可用码时必须禁用 —— 否则用户会复制出一个打不开的链接。
        // 成员分享被关掉、或者没有票时 canShare 保持 false，这里自动兜住：
        // 哪怕上面哪个分支漏了，也点不出一个能用的链接
        ['#btn-copy-code', '#btn-copy-link', '#btn-zoom-qr'].forEach(function (sel) {
            var b = $(sel);
            if (b) b.disabled = !canShare;
        });
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
        // memberShare === false 才是关；缺字段的老群按开着显示（和服务端的默认值一致）
        $$('#share-mode button').forEach(function (b) {
            b.classList.toggle('on',
                b.getAttribute('data-share') === (g.memberShare === false ? 'owner' : 'all'));
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

    /**
     * 选人弹框：把候选人列出来让人点。
     *
     * 这里不用 askText 那种「把名字敲进去」——群里显示的是备注名（我给 TA 起的、
     * 或 TA 给自己设的），照着显示名去敲真名很容易敲错。点一下没有认错人的余地。
     *
     * @param {{title:string, hint:string, members:Array}} opts
     * @returns {Promise<object|null>} 选中的成员；取消为 null
     */
    function pickMember(opts) {
        return new Promise(function (resolve) {
            var modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML =
                '<div class="inner" style="text-align:left;max-width:360px">' +
                '<h2 style="font-size:16px;margin-bottom:10px"></h2>' +
                '<p class="tiny" style="margin-bottom:10px"></p>' +
                '<div class="list pick-list"></div>' +
                '<div class="row" style="margin-top:12px">' +
                '<button class="btn secondary" data-x="cancel">取消</button>' +
                '</div></div>';
            $('h2', modal).textContent = opts.title || '';
            var hint = $('p', modal);
            if (opts.hint) hint.textContent = opts.hint; else hint.remove();

            // 按加入时间从早到晚：交接时「谁在群里待得久」常常就是选人的依据
            $('.pick-list', modal).innerHTML = opts.members
                .slice()
                .sort(function (a, b) { return (a.joinedAt || 0) - (b.joinedAt || 0); })
                .map(function (m) {
                    var np = nameParts(m);
                    return '<button class="item pick" data-pick="' + esc(m.id) + '">' +
                        '<div class="grow"><div class="title">' + esc(np.shown) + '</div>' +
                        '<div class="sub">' + (np.real ? esc(np.real) + ' · ' : '') +
                        '加入于 ' + fmtTime(m.joinedAt) + ' · ' + m.courseCount + ' 个时段' +
                        '</div></div></button>';
                }).join('');

            function done(val) {
                dismiss(modal);
                resolve(val);
            }
            modal.addEventListener('click', function (e) {
                var pick = e.target.closest && e.target.closest('[data-pick]');
                if (pick) {
                    var id = pick.getAttribute('data-pick');
                    return done(opts.members.filter(function (x) { return x.id === id; })[0] || null);
                }
                var x = e.target.getAttribute && e.target.getAttribute('data-x');
                if (x === 'cancel') done(null);
            });
            document.body.appendChild(modal);
        });
    }

    /**
     * 转让群主：**选人 → 输密码**，两步。
     *
     * 密码那一步由服务端校验（POST /api/groups/:code/transfer），不是在这儿做个样子 ——
     * 转让意味着控制权易手（老群主权限全失、接手的人持续掌控），光有令牌不该够。
     *
     * 不再叠第三层确认：移出成员用「按两次」是因为那颗按钮没有别的闸；
     * 这里密码本身就是最强的「我是认真的」。和注销账号同构。
     */
    async function transferGroup() {
        if (!state.group) return;
        var g = state.group;
        var others = g.members.filter(function (m) { return !memberHasMe(m); });
        if (!others.length) return toast('群里还没有别人，没人可以接手', true);

        var target = await pickMember({
            title: '把群主转让给谁',
            hint: 'TA 会成为群主。转让后你留在这个群里，只是变成普通成员。',
            members: others
        });
        if (!target) return;

        var shown = displayName(target);
        var pw = await askText({
            title: '转让群主 · 最后一步',
            hint: '「' + shown + '」会成为群主：能改群名、审批进群、管理邀请链接、移除成员、解散群组。' +
                  '你会变成普通成员，这些权限立刻失效。' +
                  // 「你那条永久码会变成 TA 的」这句随群码改制删掉了：现在没有「群主自己的永久码」，
                  // 分享链接属于群、不属于谁当群主 —— 换了群主它们照旧有效，
                  // 只是你不再能收回它们。这才是交接时真正值得知道的事
                  '群里的分享链接不会因为换人就失效，但你不能再收回它们了。',
            placeholder: '输入密码确认',
            password: true,
            maxlength: 64
        });
        if (pw == null) return;

        try {
            await API.transferGroup(g.code, target.id, pw);
            state.group = await API.groupDetail(g.code);
            // 首页群列表上那行「你是群主」也得跟着变，所以这份数据要一起刷新
            await loadGroups();
            renderGroup();
            toast('已把群主转让给「' + shown + '」');
        } catch (e) { toast(e.message, true); }
    }

    function initGroupSettings() {
        $('#btn-rename-group').addEventListener('click', renameGroup);
        $('#btn-transfer-group').addEventListener('click', transferGroup);
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

        // 成员能不能分享邀请码。关掉之后成员那边只看得到一句说明
        $('#share-mode').addEventListener('click', async function (e) {
            var btn = e.target.closest('button[data-share]');
            if (!btn || !state.group) return;
            var onlyOwner = btn.getAttribute('data-share') === 'owner';
            if (onlyOwner === (state.group.memberShare === false)) return;
            try {
                await API.groupSettings(state.group.code, { memberShare: !onlyOwner });
                state.group = await API.groupDetail(state.group.code);
                renderGroup();
                toast(onlyOwner ? '以后只有你能发邀请链接了' : '成员又能分享邀请链接了');
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
            '确认移除',
            { doubleConfirm: '再点一次，真的移除' }   // 不可逆，所以要按两次
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

    /**
     * 二维码/链接里该用哪个地址。
     *
     * 一律用当前页面的地址：页面挂在哪个路径下（正式服是 /tongge/），邀请链接就落在
     * 哪个路径下，套反向代理的子路径也不会拼错。
     *
     * 以前本机 localhost 打开时会换成服务端探测到的局域网地址（怕同学扫码打不开），
     * 那是「局域网自用」时代的做法。现在是正式服 + 反代，入口就是站点本身，
     * 那段网卡探测已经删掉。要在手机上真机测扫码，手工把地址换成内网 IP 即可。
     *
     * 保持 async 是因为调用点用了 .then()，改同步就得连带改调用方。
     */
    async function joinUrl(code) {
        return new URL('./?code=' + encodeURIComponent(code), document.baseURI).href;
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

    /** 能用的票，越新越靠前（卡片展示第一枚） */
    function activeInvites() {
        var g = state.group;
        if (!g || !g.invites) return [];
        return g.invites.filter(function (i) { return i.active; });
    }

    /**
     * 决定邀请卡片上该展示哪一枚码：
     *  1. 用户手动选过的（state.activeInvite）
     *  2. 还能用的里面最新的那枚
     *  3. 都没有 -> null，卡片改成说明（群主那边是「生成一条」，成员那边是「找群主要」）
     *
     * 这里**不再**回落到群码：群码不是票，它进不了群（2026-09-18 §3.1）。
     * 以前只有群主有这条回落，于是「群里没有票」时群主看到的正常、成员看到的是
     * 一张坏卡片 —— 那个不对称就是这次要修的毛病。
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
     * 邀请卡片上那个码是什么。没有能用的票时返回 null（交给 §空态渲染）。
     * @returns {{code:string, invite:object}|null}
     */
    function currentDisplayCode() {
        var g = state.group;
        if (!g) return null;
        var inv = currentInvite();
        if (inv) return { code: inv.code, invite: inv };
        return null;
    }

    /**
     * 「一枚能用的票都没有」时，邀请卡片上那块说明。
     *
     * 两种角色给的出口不同，这里必须分开写：
     *   群主 —— 当场就能生成（点一下的事），所以给按钮
     *   成员 —— 本来就无权发新票（store.addInvite 只认 creatorId），
     *          所以只能告诉他去找谁，别让人在那儿干等
     */
    function renderInviteEmpty(isOwner) {
        var emoji = $('#invite-empty-emoji');
        var text = $('#invite-empty-text');
        var btn = $('#btn-invite-create');
        if (!text) return;
        if (isOwner) {
            if (emoji) emoji.textContent = '🔗';
            text.innerHTML = '这个群现在没有任何分享链接，谁也进不来。<br>' +
                '链接可以随时收回、也可以随时重发，所以别怕发出去。';
            if (btn) btn.hidden = false;
        } else {
            if (emoji) emoji.textContent = '🫥';
            text.innerHTML = '群主似乎没有分享他的群群~<br>' +
                '想进来的同学，让 TA 找群主要一条 —— TA 那边随手就能生成，' +
                '你负责把人喊来就好 (๑•̀ㅂ•́)و✧';
            if (btn) btn.hidden = true;
        }
    }

    /**
     * 群主在空态里一键生成一条永久链接。
     * 走的是管理页同一条接口（不新增路由），生成完就地重画。
     */
    async function createOwnInvite() {
        var g = state.group;
        if (!g) return;
        if (!g.isCreator) return toast('只有群主能发新邀请码', true);
        var btn = $('#btn-invite-create');
        if (btn) btn.disabled = true;
        try {
            var r = await API.addInvite(g.code, 'never', '');
            state.activeInvite = r.invite.code;   // 生成完就展示它，省得群主再去找
            await reloadGroup();
            toast('链接生成好了：' + r.invite.code);
        } catch (e) {
            toast(e.message, true);
        } finally {
            if (btn) btn.disabled = false;
        }
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

    // 这里原本有一个「换掉群自己的码」的按钮与函数。群码不能再入群之后
    // （2026-09-18-group-code-not-a-ticket-design.md §3.4），换码什么也收不回来，
    // 只会改掉群的地址 —— 想收回某条链接，直接在列表里作废那一枚。

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
        var url = await joinUrl(code);

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

    // 每次复制都随机挑：头 / 颜文字 / 说明 / 尾巴 四段各自独立随机，
    // 组合起来不会千篇一律（同一个人发十次，十次都不一样）。
    var SHARE_HEADS = [
        '🎓 组团上课，来对一下课表？',
        '🎓 发车了，组团上课',
        '课表碰一碰，看看能不能撞到一块儿 👀',
        '来！看看咱俩的课表能撞出几节课',
        '找上课搭子 🎓',
        '把课表丢进来，看看我们一周能撞上几回'
    ];
    // 颜文字随机挂在头一行后面。没写进 SHARE_HEADS，是为了别让「哪句话配哪个表情」
    // 变成固定搭配 —— 池子分开，组合数才是乘出来的
    var SHARE_FACES = [
        '(๑•̀ㅂ•́)و✧',
        '٩(๑•̀ω•́๑)۶',
        'qwq',
        '(๑•́ ₃ •̀๑)',
        'ʕ•ᴥ•ʔ',
        'ヾ(≧▽≦*)o',
        '(｡･ω･｡)ﾉ♡',
        '(・∀・)'
    ];
    // 一句「这是干嘛的」。光甩个链接，同学不知道点开要做什么，多半当成广告划过去
    var SHARE_WHYS = [
        '（就是互相看看有没有能一起上的课、教室离得近不近，顺便找个搭子）',
        '（传完课表就能看到和谁重了几节课、在哪个楼 —— 找搭子、找同路都方便）',
        '（纯自用的小工具，不传原始课表文件，只比重合了几节）',
        '（看完就知道咱俩一周能撞上几节课，上课路上也能有个伴）'
    ];
    var SHARE_TAILS = [
        '打开 → 注册昵称密码 → 传 .ics 就进来了',
        '注册个昵称密码，传上课表就进群了',
        '注册 → 传 .ics → 进群，三步搞定',
        '点开链接 → 注册 → 传 .ics，一分钟的事'
    ];

    function pickOne(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    /**
     * 复制给同学的整段话：群名 + 链接 + 邀请码 + 为什么值得点 + 一句怎么用。
     *
     * 头一行随机挂一个颜文字；「为什么」那句是给人一个点开的理由 ——
     * 只丢一个链接，多数人会当广告划过去。
     *
     * 群名单独占一行：同一个人可能在好几个群里，收到的人得先知道这是哪个群，
     * 再去点链接。群名理论上有空的时候，整行省掉，不留空行。
     *
     * 群名只进文案、**不进 URL** —— 群名里有中文甚至 emoji，塞进 query 会膨胀成
     * 一长串百分号编码，二维码会明显变密、不好扫。
     */
    function shareMessage(url, code, groupName) {
        var lines = [pickOne(SHARE_HEADS) + ' ' + pickOne(SHARE_FACES)];
        var name = String(groupName || '').trim();
        if (name) lines.push('「' + name + '」邀请你加入');
        lines.push(url, '邀请码：' + code, pickOne(SHARE_WHYS), pickOne(SHARE_TAILS));
        return lines.join('\n');
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
            var groupName = (state.group && state.group.name) || '';
            joinUrl(disp.code).then(function (u) {
                copyText(shareMessage(u, disp.code, groupName), '分享文案已复制，直接发群里就行');
            });
        });
        $('#btn-zoom-qr').addEventListener('click', zoomQr);

        // 多个链接的增删作废都在独立的「邀请链接」页里，这里只留入口
        $('#btn-manage-invites').addEventListener('click', openInvites);
        // 空态里那颗「生成一条」：群主专属，不走管理页也能补一条出来
        $('#btn-invite-create').addEventListener('click', createOwnInvite);

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

    // ------------------------------------------------------------ 页脚版本号

    /**
     * 页脚最底下那行灰字：v<版本> · <构建号>（例如 v1.0.0 · 62c0a05）。
     *
     * 从服务端拿（/api/meta），不写死在 HTML 里 —— 写死的那串是「页面生成时的
     * 版本」，页脚还在浏览器缓存里、或者部署时漏了重建镜像，它照样显示新号，
     * 那这行字就白加了。服务端读的是它自己那份 package.json 与提交号，
     * 所以显示的必然是此刻真正在跑的那一版。
     *
     * 拿不到（离线、接口挂了、服务端太老没有这两个字段）就不显示：
     * 留一行空的灰字看着更像出了 bug。
     */
    async function initVersion() {
        var el = $('#foot-ver');
        if (!el) return;

        var meta;
        try { meta = await API.meta(); } catch (e) { return; }

        var parts = [];
        if (meta && meta.version) parts.push('v' + meta.version);
        if (meta && meta.build) parts.push(meta.build);
        if (!parts.length) return;

        var text = parts.join(' · ');
        el.textContent = text;
        el.title = '服务端当前版本：' + text;
        el.hidden = false;
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
        $('#theme-icon').textContent = t === 'dark' ? '☀️' : '🌙';
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

    /**
     * 分享这个站点本身（不带邀请码，就是站点首页）。
     *
     * 手机上走 navigator.share 弹系统分享面板，桌面上大多没有这个 API 就退回复制。
     * **一定要带上描述**：光甩一个链接，群里的人不知道点开是干嘛的。
     * 注意 share() 必须在点击手势里同步调用，前面不能 await 任何东西，否则会被拒。
     */
    async function shareSite() {
        var url = new URL('./', document.baseURI).href;
        var cfg = (window.DSH && window.DSH.config) || {};
        var title = cfg.appName ? cfg.appName + ' · ' + cfg.tagline : '同格';
        var desc = cfg.desc || '';
        if (navigator.share) {
            try {
                await navigator.share({
                    title: title,
                    text: desc ? title + '\n' + desc : title,
                    url: url
                });
                return;
            } catch (e) {
                // 用户自己点了取消也会走到这里，那就别再弹「已复制」打扰他
                if (e && e.name === 'AbortError') return;
            }
        }
        copyText([title, desc, url].filter(Boolean).join('\n'), '链接已复制，发给同学就行');
    }

    /**
     * 顶栏「更多」菜单：账号 / 分享 / 主题 / 管理 / 退出都收在这里。
     *
     * 这里**一个红色项都没有**了：退出登录是可逆的，红色留给账号屏里那个注销。
     *
     * 选完一项、点别处、按 Esc 都收起 —— 手机上留个浮层在那儿会挡住下面的内容。
     * 判断「点别处」用 closest 而不是 stopPropagation：后者会把顶栏其它按钮一起堵掉。
     */
    function initMoreMenu() {
        var btn = $('#btn-more');
        var menu = $('#more-menu');
        if (!btn || !menu) return;

        /**
         * 收起也要有动画，和展开对称：加 .closing 先播一段，再由 animationend 收尾。
         * 兜底的 setTimeout 是必须的 —— 系统开了「减弱动态效果」或动画被别处禁掉时
         * animationend 不会来，没有兜底菜单就永远收不回去（和 closeModal 同一个道理）。
         */
        var closeTimer = null;
        function finishClose() {
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
            menu.classList.remove('closing');
            menu.hidden = true;
        }
        function setOpen(open) {
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
            if (open) {
                menu.hidden = false;
                menu.classList.remove('closing');
            } else if (!menu.hidden) {
                menu.classList.add('closing');
                closeTimer = setTimeout(finishClose, 220);
            }
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        menu.addEventListener('animationend', function () {
            if (menu.classList.contains('closing')) finishClose();
        });

        btn.addEventListener('click', function () {
            // 收起动画还没播完就再点一下：应当重新展开，而不是被当成又一次「收起」
            setOpen(menu.hidden || menu.classList.contains('closing'));
        });
        // 菜单里任何一项点下去都收起（主题、管理、退出都一样）
        menu.addEventListener('click', function () { setOpen(false); });
        // 分享：分享的是站点首页，不是当前这一屏（当前屏的地址里可能带邀请码）
        $('#btn-share').addEventListener('click', function () { shareSite(); });
        // 账号（昵称 / 改密码 / 注销）单开一屏 —— 注销就是从这儿搬过去的，
        // 理由见 openAccount() 的注释
        $('#btn-account').addEventListener('click', function () { openAccount(); });
        document.addEventListener('click', function (e) {
            if (menu.hidden) return;
            var t = e.target;
            if (t && t.closest && (t.closest('#more-menu') || t.closest('#btn-more'))) return;
            setOpen(false);
        });
        window.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !menu.hidden) setOpen(false);
        });
    }

    async function boot() {
        initAuth();
        initHome();
        initGroup();
        initAccount();
        initManageInvites();
        initCompare();
        bindGlobal();
        initTheme();
        initMoreMenu();
        initBeta();
        initHistory();

        var code = qs('code');
        if (code) state.pendingCode = code;

        maybeShowBeta();
        // 不 await：页脚那行版本号晚一点出现没人会注意，别让它拖住首页
        initVersion().catch(function () {});
        await restoreSession();
    }

    document.addEventListener('DOMContentLoaded', boot);
})();
