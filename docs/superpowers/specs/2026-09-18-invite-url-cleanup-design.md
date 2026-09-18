# 邀请码用过之后从地址栏摘掉 —— 设计

> 一句话：**进群（或确认链接已死）之后，把 `?code=` 从地址栏擦掉；否则每次刷新都拿同一个码再进一次群。**

## 1. 现在的行为

邀请链接长这样：`https://<站>/?code=12345678`（`joinUrl()`，`app.js:1914`）。

进站的流程：

```
boot()                          app.js:2980
  └─ var code = qs('code')      → state.pendingCode = code
  └─ restoreSession()           app.js:2678
        ├─ 有令牌 → goHome() → joinByCode(state.pendingCode)     ← 每次加载都走这里
        └─ 没令牌 → 登录页；登录成功后再 joinByCode()             app.js:501
```

`joinByCode()` 发的是 `POST /api/groups/:code/join`。

**地址栏从来没被清理过。** 原因是 `show()` 里那些历史写入**都不传 URL**：

```js
history.pushState({ dsh: id, d: navDepth }, '');     // 第三个参数没有 → URL 原样不动
history.replaceState({ dsh: id, d: 0 }, '');
```

于是 `?code=` 从进站一直挂到关页面。

### 三个后果

| | 后果 |
|---|---|
| 1 | **每次刷新都被重新拽进群组页**，还弹一句「已加入「xx」」（服务端 join 是幂等的，所以每次都「成功」） |
| 2 | **链接过期/被作废之后更糟**：`joinByInvite()` 先校验码、再判成员身份（`store.js:1260`），所以哪怕人早就进群了，每次刷新照样弹一句红字 410 |
| 3 | 地址栏一复制，等于把这个码又转手一次 —— 正好顶到刚做的成员分享开关上 |

## 2. 方案

| | 做法 | 判断 |
|---|---|---|
| **A（采用）** | 邀请码**被用掉**（进群 / 已提交申请）或**被判定为死链**（404 / 410）之后，`history.replaceState` 把 `code` 参数摘掉 | 只动该动的，别的参数和导航状态都不碰 |
| B | 进站就把码从地址栏摘掉（反正已经存进 `state.pendingCode` 了） | **否掉**：新用户在登录/注册页刷新一下就丢码（自动填密码之后刷新很常见），他会发现自己登进去了却没进群 |
| C | 不用查询串传码（改 hash 路由 / 服务端一次性票据） | 大改，且要动邀请链接的格式和已发出去的链接。YAGNI |

## 3. 什么时候擦

| 结局 | 擦不擦 | 为什么 |
|---|---|---|
| 进群成功 | **擦** | 码的任务完成了 |
| 已提交入群申请（`pending`） | **擦** | 申请已经登记，码也用掉了 |
| 链接已死（404 没这个码 / 410 过期或作废） | **擦** | 它永远不会再成功，留着只会每次刷新重弹一遍红字 |
| 没登录（401） | 不擦 | 码还在 `state.pendingCode` 里等登录；而且在登录页刷新一下不能把它弄丢 |
| 被限流（429） | 不擦 | 码是好的，等一分钟再来 |
| 群满了（400） | 不擦 | 码也是好的 —— 有人退群就还能用 |
| 网络断了（0） | 不擦 | 这次尝试根本没有结论 |

一句话：**只有「用掉了」和「链接本身不成立」才擦**；「待会儿再试」一律留着。

`400` 之所以不擦，是因为它同时覆盖两种意思：`validateCode()` 的「邀请码是 8 位数字」
（码是坏的）和 `joinGroup()` 的「群组人数已达上限」（码是好的）。分不清就别擦 ——
擦错了用户得重新找群主要一个。

## 4. 实现

`app.js` 新增一个函数，在 `joinByCode()` 的两个位置调用：

```js
/**
 * 把邀请码从地址栏摘掉。
 *
 * 不摘的话每次刷新都会拿同一个码再进一次群；链接要是已经过期，还会每次弹一句红字；
 * 成员把地址栏一复制，又等于把这个码转手了一次。
 *
 * 只动 code 这一个参数：别的查询串和 hash 都留着。
 * 第三个参数用**相对地址** —— 正式服挂在反向代理的子路径下（/tongge/），
 * 绝对路径会把子路径拼没。
 * 状态要原样传回去：那是返回手势用的导航栈（{dsh, d}），不能顺手清掉。
 */
function clearInviteCode() {
    var search = location.search || '';
    var parts = search.replace(/^\?/, '').split('&').filter(function (kv) {
        // 精确比 key，不用 indexOf('code=')：那会误伤 xcode= 这种参数
        return kv && kv.split('=')[0] !== 'code';
    });
    var next = parts.length ? '?' + parts.join('&') : '';
    if (next === search) return;        // 本来就没有，别白动一次历史记录
    history.replaceState(history.state, '', location.pathname + next + (location.hash || ''));
}
```

```js
async function joinByCode(code) {
    try {
        var r = await API.joinGroup(code);
        clearInviteCode();              // 码用掉了：进群 / 已提交申请，两种情况都算
        …
    } catch (e) {
        if (e.status === 401) { state.pendingCode = code; return false; }   // 还要登录，留着
        // 链接本身不成立了：擦掉，否则每次刷新都重弹一遍这个红字，而它永远不会再成功
        if (e.status === 404 || e.status === 410) clearInviteCode();
        toast(e.message, true);
        return false;
    }
}
```

三个细节：

- **`history.state` 要原样传回**。导航栈信息（`{dsh, d}`）就存在那里，`replaceState({}, '', …)`
  会把它清掉，返回手势立刻失效。
- **相对地址**。`location.pathname` 在反代子路径下已经是 `/tongge/`，拼相对地址天然正确。
- **精确比 key**。`indexOf('code=')` 会把 `xcode=1` 也一起删掉。

## 5. 测试要先改垫片

`test/screens.test.js` 的垫片现在把第三个参数丢了：

```js
replaceState(s) { hist._stack[hist._stack.length - 1] = s; }
```

**「地址栏擦干净了没有」在测试里根本观察不到。** 补上：记住 `lastUrl`、维护 `state`、
并把 URL 同步回 `location`（垫片本来就是「够用就补」的路子）。同时把 `history` 暴露给用例。

## 6. 测试用例

| 用例 | 断言 |
|---|---|
| 带码进群后 | `replaceState` 过、地址里**没有** `code=`、**别的参数还在**（`from=wechat`）、`history.state.dsh` 仍是当前屏 |
| 未登录时 | 停在登录页，**码必须还在**（刷新不能丢）；用界面登录成功后进群，再把码擦掉 |
| 死链（已作废的邀请码） | 没进群（403），但码也擦掉了 —— 否则每次刷新重弹红字 |
| 正常启动（没有码） | 一次 `replaceState` 都不该多（`lastUrl` 保持 null） |

## 7. 已知限制

- **只擦当前这条历史记录。** 用户要是用浏览器「后退」退回那条带码的地址，码会回来
  （那条记录本来就是他点进来的那一下）。再进一次群是幂等的，不会有新后果。
- **已经存在书签里的带码链接**不受影响，照旧能用 —— 那是链接本身的事，不是这次要解决的。
- 这不是权限问题，纯粹是「同一个码不该被反复提交」和「地址栏别当二次传播渠道」。
