# 群主转让 —— 设计

> 一句话：**群主能把群交给群里另一个人，交出去之前必须再输一次密码；只改 `creatorId` 一个字段，别的都不动。**

## 1. 为什么现在没有

群主交接这件事，代码里只在一个地方出现过：**注销账号**。`store.deleteUser()`（`shared/store.js:641`）
在本人是群主且群里还有别人时，把群主自动转给「最早加入的那位」；群里没别人就直接解散。

除此之外，群主**没有任何主动交班的路径**。想交出去只有两条路，都是拿账号换的：

- 把自己的账号注销掉（连带课表、备注全没）
- 在服务器上直接改 `data/groups/<码>.json`

`store.removeMember()`（`store.js:1458`）和 `store.leaveGroup()`（`store.js:1433`）都明确拒绝群主：
「你是群主，不能移除自己；想结束就解散群组」。也就是说，**一届群主毕业了，这个群要么跟着账号一起消失，
要么变成没人管得动的僵尸群**——改名、审批进群、发邀请码全都只能由那个不回来的人做。

这个设计补的就是这一条：让群主能把位置交出去，自己留下当普通成员。

## 2. 目标与非目标

**做**：

- 群主把群主身份转让给**已经在群里的某一位成员**
- 转让前必须**再输一次密码**（服务端校验，不是前端装饰）
- 转让后老群主**留在群里当普通成员**
- 转让这件事**进审计日志**

**不做**：

- ❌ 转给群外的人（得先让人进群，进群本身有邀请码/审批两道现成的关，不该在这里开口子）
- ❌ 多群主 / 共同管理（`creatorId` 是单值，改成集合是另一个量级的改动）
- ❌ 转让时自动换群码（理由见 §5）
- ❌ 撤销转让 / 后悔药（新群主可以再转回来，这就是正交路径；老群主已经失去权限，不该留一条只有他能用的后门）

## 3. 威胁模型：这一步为什么必须有密码

这是本设计里唯一一个真正的安全决策，先说清楚。

能调这个接口的人，手上已经有一个**有效的会话令牌**。如果接口只要令牌不要密码：

- 令牌泄露（XSS、共用电脑没退登录、抓包）就等于**群直接丢了**
- 而改群名、移人、解散这些操作**今天也只要令牌**——那为什么转让要额外要密码？

因为**代价和可逆性不一样**：

| 操作 | 有令牌就能做 | 可逆 |
|---|---|---|
| 改群名 | 是 | 改回来就行 |
| 移出成员 | 是 | 对方重新输邀请码能回来 |
| 解散群组 | 是 | **不可逆**，但群没了就是没了，没有第三方受害 |
| **转让群主** | **本设计要挡住** | 老群主**被剥夺**全部权限，且**夺权者获得了持续控制**——比解散更值得防：解散是破坏，转让是**接管** |

所以「再输一次密码」在这里的作用是**把令牌泄露和群主身份被夺走这两件事隔开**：光有令牌不够，
还得知道密码。项目和这个模式已经有一处先例——`DELETE /api/me`（注销账号）就是带密码的（`server.js:726`）。

**并且必须带限流。** 只校验密码而不限流，等于给了攻击者一个**无限次免费试密码的接口**：
抓到一次令牌 → 在这个接口上慢慢猜密码 → 猜中即永久接管群，还顺手拿到了这个人的全部账号权限。
`PUT /api/me/password`（`server.js:693`）就是为了同样的理由挂了 `limiter.loginFail`，
注释写得明明白白：「抓到一次令牌就能无限次猜旧密码，猜中即永久接管账号」。**这里复用同一个桶。**

## 4. 存储层：`transferOwnership()`

`shared/store.js` 新增，骨架和 `removeMember()` 逐行对齐（都是「改群文件里的一个字段」）：

```js
async function transferOwnership(code, ownerId, targetUserId) {
    const c = validateCode(code);
    const target = String(targetUserId == null ? '' : targetUserId);
    if (!target) throw fail(400, '没指明要转给谁');

    return withLock(`group:${c}`, async () => {
        const file = await resolveGroupFile(c);          // 换过码的群也要找得到
        if (!file) throw fail(404, '群组不存在或已解散');
        const g = await readJson(file, () => null);
        if (!g) throw fail(404, '群组不存在或已解散');
        if (g.creatorId !== ownerId) throw fail(403, '只有群主能转让群组');
        if (target === ownerId) throw fail(400, '你已经是群主了');
        if (!g.members.some((m) => m.userId === target)) {
            throw fail(404, '这个人已经不在群里了');
        }
        g.creatorId = target;
        g.updatedAt = now();
        await writeJsonAtomic(file, g);
        return g;
    });
}
```

检查顺序是**有意**的：先认群、再认「你是不是群主」，然后才轮到参数合法性。

- `target === ownerId` 放在群主校验**之后**：反过来的话，一个不是群主的人拿自己的 id 来试，
  会拿到 400「你已经是群主了」——虽然不泄露什么，但这是句假话。
- 目标是否在群里必须在锁内查：锁外查完、进锁前对方可能刚退群。

**只写 `g.creatorId` 和 `g.updatedAt`。** 这个克制是刻意的，收益见 §6。

## 5. 群码不动（`g.code` 不变）

`g.code` 有两个身份：它是**群主自己的永久码**（`groupDetail()` 里只有群主能拿到 `ownerCode`），
同时也是**这个群的永久邀请码**——`joinByInvite()` 特意保留了这条兼容（`store.js:1260`：
「也认群主自己的永久码 —— 改版前发出去的链接用的就是它，不能让它失效」）。

转让后不换码，意味着：

- ✅ 已经发出去的所有链接**照常能用**，新群主不用重新分发
- ✅ 新群主立刻拥有 `ownerCode`，界面上的二维码、卡片说明自动切到他名下
- ⚠️ 老群主手里那张永久码**仍然能把人拉进群**

最后一条不是漏洞：**普通成员本来就能分享有效邀请链接**（`groupDetail()` 把「还能用」的邀请码
发给所有成员，`store.js:1519` 的注释就是「这样谁都能帮群里拉人」）。老群主转让后是普通成员，
他能做的事**不多于任何一个群友**，没有留下任何残留权限。

反过来说，**自动换码的代价要大得多**：它会把所有已发出去的链接（包括别的成员正在用的）一起废掉，
逼新群主重新分发一轮。而且「要不要切断旧码」这个决定，本来就该由**新群主**来做——
现有的「换一个新码」功能就在管理页里，他随时能点。

所以：**不换码，但在确认文案里把这件事说明白**（「你现在这条永久码会变成 TA 的」）。

## 6. 服务端路由

```
POST /api/groups/:code/transfer
body: { targetId, password }
```

四步，**逐字对着 `PUT /api/me/password`（`server.js:688`）抄**：

```js
['POST', /^\/api\/groups\/(\d{6}|\d{8})\/transfer$/, async (req, res, m) => {
    const { user } = await requireUser(req);
    const body = await readBody(req, res);
    const ip = clientIp(req);

    // 和改密码同一把刹车：同一个人的密码共用一个计数器。
    // 分开建桶等于把猜密码的额度翻倍——攻击者两边各猜一半。
    const throttle = 'pw:' + user.id;
    if (limiter.loginFail.isLimited(throttle)) {
        store.appendAudit({ event: 'group_transfer_blocked', nickname: user.nickname, ip });
        throw fail(429, '密码错误次数太多，歇十分钟再来');
    }
    if (!(await store.verifyLogin(user.nickname, body.password))) {
        limiter.loginFail.check(throttle);      // 只计失败
        throw fail(401, '密码不对，转让已取消');
    }
    limiter.loginFail.reset(throttle);          // 成功了就清账

    const g = await store.transferOwnership(validateCode(m[1]), user.id, body.targetId);
    const heir = await store.getUser(String(body.targetId));
    store.appendAudit({
        event: 'group_transfer',
        by: user.nickname,                      // 老群主
        nickname: heir ? heir.nickname : '',    // 新群主
        group: g.name,
        code: g.code,
        ip
    });
    return { ok: true, code: g.code, ownerId: g.creatorId };
}],
```

要点：

- **`verifyLogin` 是纯凭据校验**，不记登录活动——这正是它被「改密码验旧密码」复用的原因
  （`store.js:1603` 的注释说明登录统计刻意不放在里面）。用它不会污染登录次数/最后登录时间。
- **密码校验排在群主/成员校验之前**，是照 `/api/me/password` 抄的结果。看起来像「先花一次
  scrypt 才发现你没权限」，但代价是自限的：限流桶的键是 `'pw:' + user.id`，**谁调接口就烧谁的额度**，
  不是群主的账号烧不掉群主的额度。反过来的顺序（先查群主）会多一次读盘+锁，并不更省。
  两条路径的响应分别是 401（密码错）和 403（不是群主），都是正确的拒绝语义。
- 密码错时 401 的文案是「密码不对，**转让已取消**」——和注销那条「密码不对，注销已取消」同样口径，
  让用户明确知道**什么事都没发生**。
- 审计只写**一行**：`by`（谁交出去的）+ `nickname`（谁接的）+ 群名 + 码。一行的信息量已经覆盖
  双方，写两行只会让日志里出现两条语义重复的记录。`auditDetail()` 会渲染成
  「by 老王 · 接手人 · 群「xx」 · 码 12345678」。
- **审计里绝不含密码**（这点有测试钉住）。

## 7. 前端

### 7.1 入口

`public/index.html:227`，加在「改名」右边（`.link-btn.inline` 自带 `margin-left:8px`）：

```html
<h2 id="group-name">群组<button class="link-btn inline" id="btn-rename-group" hidden>改名</button><button class="link-btn inline" id="btn-transfer-group" hidden>转让</button></h2>
```

注意 `renderGroup()` 里那句 `$('#group-name').firstChild.nodeValue = g.name`——它依赖
h2 的**第一个孩子是文本节点**。按钮只能往文本节点后面加，结构不能动。

### 7.2 什么时候显示

```js
$('#btn-rename-group').hidden = !iAmOwner;
$('#btn-transfer-group').hidden = !iAmOwner || others.length === 0;
```

**群里没有别人时直接藏掉。** 留一颗点了必然报错的按钮，等于给用户设一个陷阱——
这和 `#btn-group-leave` 对群主藏起来的理由完全一样（`app.js:1249` 的注释：「与其让他点了之后
吃一个红字报错，不如直接把这颗按钮藏掉」）。

### 7.3 两步交互

1. **选人**：新写的 `pickMember()` 弹框（结构照 `askText()` / `askConfirm()`），
   列出除自己外的成员，按**加入时间**从早到晚。每行：显示名（`displayName()`，认「备注」和
   「对外备注」）+ 真名（不同时补上）+ 加入时间 + 课表时段数。
   加入时间是有用的信息——交接时「谁在群里待得久」常常就是选人的依据。
2. **输密码**：`askText({ password: true, maxlength: 64 })`，提示语里把后果写全：

   > 「XX」会成为群主：能改群名、审批进群、管理邀请码、移除成员、解散群组。
   > 你会变成普通成员，这些权限立刻失效。**你现在这条永久码会变成 TA 的。**

**为什么不叠第三次确认？** 移出成员用 `doubleConfirm`（按两次）是因为那颗按钮**没有别的闸**；
这里密码本身就是最强的「我是认真的」——再加一层是把用户当可疑对象。
注销账号是「确认后果 → 输密码」两步，这里同构。

### 7.4 成功之后

```js
await API.transferGroup(g.code, target.id, pw);
state.group = await API.groupDetail(g.code);
await loadGroups();       // 首页列表那行「你是群主」也得跟着变
renderGroup();
```

`loadGroups()` 不能省：`groupDetail()` 之后 `renderGroup()` 会重画群组页，
但**首页的群列表**是另一份数据（`state.groups`，来自 `/api/me/groups`），
不刷新它的话退回首页还写着「你是群主」。

### 7.5 权限翻转是免费的

`renderGroup()` 全线以 `iAmOwner = (g.creatorId === state.me.id)` 为准，所以转让成功后
**一行权限判断都不用新写**，下面这些自动跟着变：

| 元素 | 转让前（群主） | 转让后（普通成员） |
|---|---|---|
| `#btn-rename-group` 改名 | 显示 | 隐藏 |
| `#btn-transfer-group` 转让 | 显示 | 隐藏 |
| `#group-settings-card` 群组设置 | 显示 | 隐藏 |
| `#btn-manage-invites` 管理邀请链接 | 显示 | 隐藏 |
| `#group-requests-card` 进群申请 | 显示 | 隐藏 |
| `#btn-group-delete` 解散群组 | 显示 | 隐藏 |
| `#btn-group-leave` 退群 | 隐藏 | **显示** |

最后一行尤其重要：老群主转让后**立刻有了「退群」这条路**——交完班想走，点一下就行，
不用再麻烦新群主把他移出去。这是「留在群里当普通成员」这个选择的自然结果。

### 7.6 其余改动

| 文件 | 改动 |
|---|---|
| `public/api.js` | 加 `transferGroup(code, targetId, password)`，照 `groupSettings()` 的写法 |
| `public/app.js` | 新写 `pickMember()` 弹框 + `transferGroup()` 流程；`initGroupSettings()` 里给 `#btn-transfer-group` 挂 click |
| `public/app.js` | `AUDIT_LABEL`（`app.js:551`）加两行：`group_transfer: '转让群主'`、`group_transfer_blocked: '转让被拦（密码错太多）'`。不加的话审计列表会直接显示英文事件 id |
| `public/style.css` | 若 `pickMember()` 的行需要新样式，优先复用 `.item` / `.title` / `.sub`，不新增类 |

## 8. 已知限制

**没有服务端推送。** 新群主那一端要**刷新或重进群组页**才看得到自己变成了群主。
老群主这边是立刻生效的。这和改群名、移人、审批进群的行为完全一致，不额外处理。

## 9. 测试

**`test/admin.test.js:111` 路由体检**：25 → **26**，清单补一行
`['POST', '/api/groups/12345678/transfer']`。

**`test/server.test.js`**（功能与越权）：

| 用例 | 断言 |
|---|---|
| 密码错误 | 401，且 `creatorId` 没变 |
| 非群主调用 | 403，即使密码是对的 |
| 转给群外的人 | 404 |
| 转给自己 | 400 |
| 成功后 | 新群主能改群名、能看到 `ownerCode`；老群主改群名 403 |
| 老群主仍是成员 | `members.length` 不变，老群主还在列表里 |
| **群码不变** | `g.code` 前后一致，新群主的 `ownerCode === code`（把 §5 的决定钉死） |
| 密码错到限流 | 连续错够次数 → 429 |
| 审计 | 有 `group_transfer`，含 by / nickname / group / code，**不含密码** |
| 老群主能退群 | 转让后 `leaveGroup` 对他不再 403（§7.5 的最后一行） |

**`test/screens.test.js`**（前端接线）：

| 用例 | 断言 |
|---|---|
| 按钮可见性 | 群主且群里有别人 → 显示；只有自己 → 隐藏；普通成员 → 隐藏 |
| 完整流程 | 选人 → 输密码 → 界面切成普通成员（改名藏、退群现） |
| 取消 | 选人框取消、密码框取消，都**不发请求** |

## 10. 文档

- `docs/DEV.md`：接口一览表加一行；测试总数更新
- `README.md:26`：群主能力那条补「转让群主」
