/**
 * 构建标识：页脚那行灰字版本号的来源。
 *
 * 仅服务端使用（依赖 node:fs）。浏览器端不加载本模块，
 * 它拿到的是 /api/meta 里已经拼好的字符串。
 *
 * 为什么要读提交号：部署方式是「git pull + 重建镜像」，package.json 的版本号
 * 一年到头都可能不动。真出了事（页面上还是老行为、改的东西没生效），
 * 光看「v1.0.0」分不出线上跑的是哪一版；带上短提交哈希就能一眼对上：
 * 页脚那串和 `git rev-parse --short HEAD` 不一样，就是漏了 pull 或漏了 build。
 *
 * 拿不到就算了（镜像里没有 .git，也没传 TONGGE_BUILD）—— 只显示版本号，
 * 绝不因为一个装饰性的东西让服务起不来。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

/** 短提交哈希长度。7 位是 git 的默认缩写长度，够辨认又不占地方 */
const SHORT_LEN = 7;

/** 构建号只允许这些字符：它要显示在页面上，别让环境变量里的怪东西破坏版面 */
const BUILD_RE = /^[0-9a-zA-Z._-]{1,32}$/;

/**
 * 从 packed-refs 里找某个 ref 的哈希。
 *
 * git gc 之后 refs/heads/* 这些松散文件就没了，只剩打包的这一份；
 * 不查它的话，本地清理过仓库的人会看到页脚突然没了哈希。
 */
function packedRef(gitDir, ref) {
    let text;
    try {
        text = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    } catch (e) {
        return '';
    }
    for (const line of text.split('\n')) {
        // '#' 是文件头注释，'^' 是上一个提交的 peeled 行（tag 才用得上），都跳过
        if (line.startsWith('#') || line.startsWith('^')) continue;
        const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
        if (m && m[2] === ref) return m[1];
    }
    return '';
}

/** 真正干活的那层：给定 gitDir 里的 HEAD，解析出完整哈希；搞不定就回 '' */
function readHead(gitDir) {
    let head;
    try {
        head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    } catch (e) {
        return '';
    }

    const ref = /^ref:\s*(\S+)$/.exec(head);
    if (ref) {
        let hash = '';
        try {
            hash = fs.readFileSync(path.join(gitDir, ...ref[1].split('/')), 'utf8').trim();
        } catch (e) {
            hash = packedRef(gitDir, ref[1]);
        }
        return /^[0-9a-f]{40}$/.test(hash) ? hash : '';
    }
    // 分离头指针：CI、`git checkout <sha>` 之后就是这个样子
    return /^[0-9a-f]{40}$/.test(head) ? head : '';
}

/**
 * 读出仓库的短提交哈希（7 位小写 hex）；读不到回 ''。
 *
 * 不调 `git` 命令：容器里没有 git，而且为了页脚上几个字符去 spawn 一个进程
 * 不值当 —— 这些文件就是 git 自己存的东西，直接读反而更稳。
 */
function readGitShortHash(repoDir) {
    const dotGit = path.join(repoDir || REPO_ROOT, '.git');
    let gitDir = dotGit;
    try {
        // 工作树（git worktree）与子模块里，.git 是个文件，内容是「gitdir: <路径>」
        const st = fs.statSync(dotGit);
        if (st.isFile()) {
            const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
            if (!m) return '';
            gitDir = path.resolve(path.dirname(dotGit), m[1].trim());
        }
    } catch (e) {
        return '';
    }
    const hash = readHead(gitDir);
    return hash ? hash.slice(0, SHORT_LEN) : '';
}

/**
 * 构建号：优先环境变量（镜像里没有 .git，只能构建时传进来），
 * 其次读本地仓库。两处都没有就回 ''。
 *
 * @param {{env?: object, repoDir?: string}} [opts]
 * @returns {string}
 */
function resolveBuildId(opts) {
    const o = opts || {};
    const env = o.env || process.env;
    const fromEnv = env.TONGGE_BUILD === undefined ? '' : String(env.TONGGE_BUILD).trim();
    if (BUILD_RE.test(fromEnv)) return fromEnv;
    return readGitShortHash(o.repoDir || REPO_ROOT);
}

/**
 * 读 package.json 里的版本号 —— 版本号的唯一来源，改版本只改那一处。
 * 读不到（理论上不会：Dockerfile 里 COPY 了它）就回 ''，页脚不显示版本而已。
 */
function readVersion(repoDir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoDir || REPO_ROOT, 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : '';
    } catch (e) {
        return '';
    }
}

module.exports = { resolveBuildId, readGitShortHash, readVersion, SHORT_LEN };
