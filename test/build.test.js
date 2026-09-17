'use strict';

/**
 * shared/build.js：页脚那行版本号的两个字段从哪来。
 *
 * 这里全在临时目录里造假 .git —— 不去断言真仓库的 HEAD：
 * 它每提交一次就变一次，钉死等于给自己埋雷（提交前刚跑绿的用例，
 * 提交后就红了，而且看起来像代码坏了）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const build = require('../shared/build.js');

const HASH_A = '1a'.repeat(20);   // 40 位 hex
const HASH_B = 'b'.repeat(40);

/** 造一个假仓库，返回仓库根目录 */
function tmpRepo() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gcc-build-'));
}

/** 往假仓库里写 .git 下的文件（自动建目录） */
function writeGit(repo, rel, content) {
    const full = path.join(repo, '.git', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

// ---------------------------------------------------------------- 读提交号

test('松散 ref：HEAD 指到 refs/heads/main，取它前 7 位', () => {
    const repo = tmpRepo();
    writeGit(repo, 'HEAD', 'ref: refs/heads/main\n');
    writeGit(repo, 'refs/heads/main', HASH_A + '\n');
    assert.equal(build.readGitShortHash(repo), HASH_A.slice(0, 7));
});

test('git gc 之后：松散文件没了，要从 packed-refs 里捞', () => {
    const repo = tmpRepo();
    writeGit(repo, 'HEAD', 'ref: refs/heads/main\n');
    writeGit(repo, 'packed-refs',
        '# pack-refs with: peeled fully-peeled sorted \n' +
        '0000000000000000000000000000000000000000 refs/heads/other\n' +
        HASH_B + ' refs/heads/main\n' +
        '^cccccccccccccccccccccccccccccccccccccccc\n');
    // 得挑中 main 那行，而不是文件里第一个出现的哈希（那是别的分支）
    assert.equal(build.readGitShortHash(repo), HASH_B.slice(0, 7));
});

test('分离头指针：HEAD 里直接是哈希', () => {
    const repo = tmpRepo();
    writeGit(repo, 'HEAD', HASH_A + '\n');
    assert.equal(build.readGitShortHash(repo), HASH_A.slice(0, 7));
});

test('.git 是个文件（worktree / 子模块）：顺着 gitdir 去真正的目录读', () => {
    const real = tmpRepo();
    writeGit(real, 'HEAD', 'ref: refs/heads/main\n');
    writeGit(real, 'refs/heads/main', HASH_B + '\n');

    const worktree = tmpRepo();
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(real, '.git')}\n`);
    assert.equal(build.readGitShortHash(worktree), HASH_B.slice(0, 7));
});

test('没有 .git（部署成了压缩包）→ 空串，不抛异常', () => {
    assert.equal(build.readGitShortHash(tmpRepo()), '');
});

test('HEAD 里是垃圾内容 → 空串，不抛异常', () => {
    const repo = tmpRepo();
    writeGit(repo, 'HEAD', 'ref: refs/heads/不存在的分支\n');
    assert.equal(build.readGitShortHash(repo), '');
    writeGit(repo, 'HEAD', 'whatever\n');
    assert.equal(build.readGitShortHash(repo), '');
});

// ---------------------------------------------------------------- 构建号

test('TONGGE_BUILD 优先于仓库（镜像里没有 .git，只能构建时传进来）', () => {
    const repo = tmpRepo();
    writeGit(repo, 'HEAD', 'ref: refs/heads/main\n');
    writeGit(repo, 'refs/heads/main', HASH_A + '\n');
    assert.equal(build.resolveBuildId({ env: { TONGGE_BUILD: 'ci-42' }, repoDir: repo }), 'ci-42');
    // 前后空格要抹掉：compose 传值很容易带进来
    assert.equal(build.resolveBuildId({ env: { TONGGE_BUILD: ' ci-42 ' }, repoDir: repo }), 'ci-42');
});

test('TONGGE_BUILD 是空/怪东西就回落去读仓库（它要显示在页面上，得干净）', () => {
    const repo = tmpRepo();
    writeGit(repo, 'HEAD', 'ref: refs/heads/main\n');
    writeGit(repo, 'refs/heads/main', HASH_A + '\n');
    const fallback = HASH_A.slice(0, 7);
    for (const bad of ['', '   ', '带中文', '有 空格', 'a'.repeat(33), '<script>']) {
        assert.equal(build.resolveBuildId({ env: { TONGGE_BUILD: bad }, repoDir: repo }),
            fallback, `「${bad}」应当被无视`);
    }
});

test('环境变量和仓库都没有 → 空串（页脚只显示版本号）', () => {
    assert.equal(build.resolveBuildId({ env: {}, repoDir: tmpRepo() }), '');
});

// ---------------------------------------------------------------- 版本号

test('版本号读的是 package.json —— 就这一处，别处不许再抄一份', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(build.readVersion(path.join(__dirname, '..')), pkg.version);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本号得是 x.y.z，页脚会直接显示它');
});

test('package.json 读不到 → 空串，不抛异常（页脚最多不显示版本）', () => {
    assert.equal(build.readVersion(tmpRepo()), '');
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'package.json'), '{ 这不是 json');
    assert.equal(build.readVersion(repo), '');
});
