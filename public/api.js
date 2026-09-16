/**
 * 本地状态与网络层。
 *
 * 这一层是未来迁移微信小程序时唯一需要改写的部分：
 * 把 request() 换成 wx.request，把 Store 换成 wx.getStorageSync 即可。
 */
(function () {
    'use strict';

    var TOKEN_KEY = 'dsh_token';

    /**
     * localStorage 安全封装。
     * 隐私模式 / 存储被禁用时全程抛异常，这里降级为内存存储，功能仍可用（只是不记忆）。
     */
    var Store = (function () {
        var mem = Object.create(null);
        var alive = true;

        function get(key) {
            if (alive) {
                try {
                    var v = localStorage.getItem(key);
                    if (v !== null) return v;
                } catch (e) { alive = false; }
            }
            return key in mem ? mem[key] : null;
        }

        function set(key, value) {
            mem[key] = value;
            if (!alive) return;
            try { localStorage.setItem(key, value); } catch (e) { alive = false; }
        }

        function remove(key) {
            delete mem[key];
            if (!alive) return;
            try { localStorage.removeItem(key); } catch (e) { alive = false; }
        }

        return { get: get, set: set, remove: remove, isPersistent: function () { return alive; } };
    })();

    var token = Store.get(TOKEN_KEY) || '';
    var onUnauthorized = null;

    function getToken() { return token; }

    function setToken(t) {
        token = t || '';
        if (token) Store.set(TOKEN_KEY, token);
        else Store.remove(TOKEN_KEY);
    }

    /**
     * 统一请求。
     * @throws {Error & {status:number}} status 为 0 表示网络不可达
     */
    async function request(path, method, body) {
        method = method || 'GET';
        var headers = {};
        if (token) headers.Authorization = 'Bearer ' + token;
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        var res;
        try {
            res = await fetch(path, {
                method: method,
                headers: headers,
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch (e) {
            var netErr = new Error('连不上服务器，检查网络连接');
            netErr.status = 0;
            throw netErr;
        }

        var text = await res.text();
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: text }; }

        if (!res.ok) {
            var err = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
            err.status = res.status;
            if (res.status === 401 && token) {
                setToken('');
                if (onUnauthorized) onUnauthorized(err);
            }
            throw err;
        }
        return data;
    }

    window.Store = Store;
    window.API = {
        request: request,
        getToken: getToken,
        setToken: setToken,
        onUnauthorized: function (fn) { onUnauthorized = fn; },
        meta: function () { return request('/api/meta'); },

        register: function (nickname, password) {
            return request('/api/register', 'POST', { nickname: nickname, password: password });
        },
        login: function (nickname, password) {
            return request('/api/login', 'POST', { nickname: nickname, password: password });
        },
        logout: function () { return request('/api/logout', 'POST', {}); },
        me: function () { return request('/api/me'); },
        setCourses: function (courses) { return request('/api/me/courses', 'PUT', { courses: courses }); },
        deleteAccount: function (password) { return request('/api/me', 'DELETE', { password: password }); },
        setRemark: function (userId, remark) {
            return request('/api/me/remarks/' + encodeURIComponent(userId), 'PUT', { remark: remark });
        },
        changePassword: function (oldPassword, newPassword) {
            return request('/api/me/password', 'PUT', { oldPassword: oldPassword, newPassword: newPassword });
        },
        myGroups: function () { return request('/api/me/groups'); },

        // 管理页（服务端还会再查一次管理员身份，前端藏入口只是不碍眼）
        adminOverview: function () { return request('/api/admin/overview'); },
        adminSetAdmin: function (userId, admin) {
            return request('/api/admin/users/' + encodeURIComponent(userId) + '/admin', 'PUT', { admin: !!admin });
        },
        adminDeleteUser: function (userId) {
            return request('/api/admin/users/' + encodeURIComponent(userId), 'DELETE', {});
        },
        adminDeleteGroup: function (code) {
            return request('/api/admin/groups/' + encodeURIComponent(code), 'DELETE', {});
        },

        createGroup: function (name) { return request('/api/groups', 'POST', { name: name }); },
        joinGroup: function (code) { return request('/api/groups/' + code + '/join', 'POST', {}); },
        groupDetail: function (code) { return request('/api/groups/' + code); },
        groupSettings: function (code, patch) { return request('/api/groups/' + code + '/settings', 'PUT', patch); },
        setSelfRemark: function (code, remark) {
            return request('/api/groups/' + code + '/self-remark', 'PUT', { remark: remark });
        },
        approveRequest: function (code, userId) {
            return request('/api/groups/' + code + '/requests/' + encodeURIComponent(userId) + '/approve', 'POST', {});
        },
        rejectRequest: function (code, userId) {
            return request('/api/groups/' + code + '/requests/' + encodeURIComponent(userId), 'DELETE', {});
        },
        leaveGroup: function (code) { return request('/api/groups/' + code + '/me', 'DELETE', {}); },
        removeMember: function (code, userId) {
            return request('/api/groups/' + code + '/members/' + encodeURIComponent(userId), 'DELETE', {});
        },
        deleteGroup: function (code) { return request('/api/groups/' + code, 'DELETE', {}); }
    };
})();
