/**
 * 存储加密：一把根密钥 + 按用途绑定的 AAD。
 *
 * 只做"文件被拿走读不出"这一档（数据卷 / 备份 / 部署包 / 镜像层）。
 * "拿到执行权限"这一档挡不住 —— 运行时在用的钥匙对能跑命令的人必然可读，
 * 这是信息论限制，不是实现取舍。详见
 * docs/superpowers/specs/2026-09-17-storage-encryption-design.md。
 *
 * 服务端专用（依赖 node:crypto）。浏览器端不加载本模块 —— 和 auth.js 一样，
 * 不要加进 server.js 的 SHARED_PUBLIC 白名单。
 *
 * 钥匙从环境变量 TONGGE_ROOT_KEY 来，**绝不在数据卷里**。这一点是整个方案
 * 有效性的全部基础：钥匙和数据躺在一起，加密就等于没做。
 *
 * 唯一的例外是本机开发：NODE_ENV 不是 production 时，也认仓库根的
 * `.tongge/key.env`（见 fromLocalFile）—— 免得每次开发都要先 export 一遍。
 * 容器里 NODE_ENV=production，所以这条捷径进不了正式服。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const IV_BYTES = 12;            // GCM 的标准长度（96 位）
const TAG_BYTES = 16;
const VERSION = 1;
const AAD_PREFIX = `tongge:v${VERSION}`;

/**
 * 加密用途。它不是"分类标签"，而是**参与 AAD 计算的域名**：
 * 换个用途就解不开，所以把昵称的密文冒充备注是行不通的。
 */
const KINDS = Object.freeze({
    NICKNAME: 'nickname',
    COURSE: 'course',
    REMARKS: 'remarks',
    SELF_REMARK: 'selfremark'
});
const KIND_SET = new Set(Object.values(KINDS));

class VaultError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'VaultError';
        this.code = code;
    }
}

/** 生成一把新的根密钥（十六进制）。给部署命令用，也方便测试。 */
function randomKeyHex() {
    return crypto.randomBytes(KEY_BYTES).toString('hex');
}

/**
 * 解析根密钥。**宁可拒绝启动也不接受"差不多能用"的钥匙** ——
 * 少一位 hex 就该报错，而不是被 Buffer 静默截断成另一把钥匙。
 */
function parseKeyHex(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s.length !== KEY_HEX_LEN || !/^[0-9a-f]+$/i.test(s)) {
        throw new VaultError('BAD_KEY', `根密钥必须是 ${KEY_HEX_LEN} 位十六进制（${KEY_BYTES} 字节）`);
    }
    return Buffer.from(s, 'hex');
}

/**
 * 从环境取根密钥。
 * 缺失返回 null —— 由调用方决定怎么处理（正式服：打印生成命令并拒绝启动）；
 * 但有值却格式不对时直接抛，那种情况不该被当成"没配置"。
 */
function fromEnv(env) {
    const raw = (env || process.env).TONGGE_ROOT_KEY;
    if (raw == null || String(raw).trim() === '') return null;
    return parseKeyHex(raw);
}

/** 本机开发用的钥匙文件（相对仓库根） */
const LOCAL_KEY_FILE = path.join('.tongge', 'key.env');

/**
 * 从本机开发的钥匙文件取根密钥；没有这个文件就返回 null。
 *
 * 正式服的钥匙在 `/etc/tongge/key.env`（部署目录**之外**），但本机开发每次都要先
 * export 一遍太别扭，于是允许放在仓库根的 `.tongge/key.env`。
 *
 * **只在 NODE_ENV !== 'production' 时读。** 这一条是关键：镜像里 NODE_ENV 是
 * production，所以正式服永远只认环境变量，不会因为部署目录里恰好躺着一个
 * key.env 就悄悄换了钥匙（本地与线上各一把，混起来就是解密全线失败）。
 *
 * 文件在、但里面的值格式不对时**照样抛** —— 和 fromEnv 一样，
 * 不能把"配错了"当成"没配"。
 */
function fromLocalFile(repoDir, env) {
    if ((env || process.env).NODE_ENV === 'production') return null;
    let text;
    try {
        text = fs.readFileSync(path.join(repoDir || path.join(__dirname, '..'), LOCAL_KEY_FILE), 'utf8');
    } catch (_) {
        return null;
    }
    // 允许文件里带注释、空行，也允许以后再放别的变量
    const m = /^[ \t]*TONGGE_ROOT_KEY[ \t]*=[ \t]*(\S+)[ \t]*$/m.exec(text);
    if (!m) return null;
    return parseKeyHex(m[1]);
}

/**
 * AAD 组成：`tongge:v1:<用途>:<归属>`。
 *
 * 归属对昵称/课表/备注是用户 id；对外备注是 `<群号>:<用户id>` ——
 * 所以甲群的对外备注挪到乙群也会解密失败。
 */
function aadOf(kind, id) {
    if (!KIND_SET.has(kind)) throw new VaultError('BAD_KIND', `未知的加密用途：${kind}`);
    const own = String(id == null ? '' : id);
    if (!own) throw new VaultError('BAD_AAD', '缺少归属标识（用户 id，或 群号:用户id）');
    return `${AAD_PREFIX}:${kind}:${own}`;
}

/** 是不是一个完整的密文对象。迁移脚本靠它判断"这条已经加密过了" */
function isSealed(x) {
    return !!x && typeof x === 'object' && Number(x.v) === VERSION
        && typeof x.iv === 'string' && typeof x.ct === 'string' && typeof x.tag === 'string';
}

function createVault(key) {
    const k = Buffer.isBuffer(key) ? key : parseKeyHex(key);
    if (k.length !== KEY_BYTES) {
        throw new VaultError('BAD_KEY', `根密钥长度不对：期望 ${KEY_BYTES} 字节，实际 ${k.length}`);
    }

    /** 加密一段文本。IV 每次随机 —— GCM 下重复 IV 是灾难性的，绝不能复用 */
    function seal(kind, id, plaintext) {
        const aad = aadOf(kind, id);
        const iv = crypto.randomBytes(IV_BYTES);
        const c = crypto.createCipheriv('aes-256-gcm', k, iv);
        c.setAAD(Buffer.from(aad, 'utf8'));
        const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
        return {
            v: VERSION,
            iv: iv.toString('base64'),
            ct: ct.toString('base64'),
            tag: c.getAuthTag().toString('base64')
        };
    }

    /**
     * 解密。三种失败情形（钥匙不对 / 用途或归属不符 / 数据被改过）在 GCM 下
     * 无法区分，也不该区分 —— 统一抛 BAD_TAG，避免把差异暴露给攻击者。
     */
    function open(kind, id, blob) {
        if (!isSealed(blob)) throw new VaultError('BAD_BLOB', '密文格式不对');
        const aad = aadOf(kind, id);
        const iv = Buffer.from(blob.iv, 'base64');
        const tag = Buffer.from(blob.tag, 'base64');
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
            throw new VaultError('BAD_BLOB', '密文格式不对');
        }
        const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
        d.setAAD(Buffer.from(aad, 'utf8'));
        d.setAuthTag(tag);
        try {
            return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
        } catch (_) {
            throw new VaultError('BAD_TAG', '解密失败：钥匙不对、用途或归属不符，或数据被改过');
        }
    }

    function sealJson(kind, id, value) {
        return seal(kind, id, JSON.stringify(value === undefined ? null : value));
    }

    function openJson(kind, id, blob) {
        const text = open(kind, id, blob);
        try {
            return JSON.parse(text);
        } catch (_) {
            throw new VaultError('BAD_JSON', '解密出来的内容不是合法 JSON');
        }
    }

    // KINDS / isSealed 也挂在实例上：调用方拿到的是一把"钥匙对象"，
    // 不该再回头去 require 模块才能问"这条是不是密文"（store.js 就是这么用的）
    return { seal, open, sealJson, openJson, isSealed, KINDS };
}

module.exports = {
    KINDS,
    VERSION,
    KEY_BYTES,
    KEY_HEX_LEN,
    LOCAL_KEY_FILE,
    VaultError,
    createVault,
    randomKeyHex,
    parseKeyHex,
    fromEnv,
    fromLocalFile,
    isSealed,
    aadOf
};
