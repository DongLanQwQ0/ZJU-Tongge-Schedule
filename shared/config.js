/**
 * 全局配置 —— 要改的东西都集中在这里。
 *
 * 纯数据模块，和 shared/ 下其它文件一样是 UMD：
 * 浏览器里挂在 window.DSH.config，Node 里 require('./shared/config.js') 即可。
 * 服务端启动横幅、前端提示文案都读这里，避免同一个名字散落在好几处。
 */
(function (root, factory) {
    'use strict';
    var isNode = typeof module === 'object' && module.exports;
    var mod = factory();
    if (isNode) module.exports = mod;
    else (root.DSH = root.DSH || {}).config = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    return {
        /**
         * 发起人昵称 —— 就是把这套东西搭起来、发给大家的那个人。
         * 会出现在「遇到问题找谁」这类文案里。
         */
        owner: 'DongLanQwQ',

        /** 服务名，出现在页面标题与启动横幅里 */
        appName: '组团上课网格比对器'
    };
});
