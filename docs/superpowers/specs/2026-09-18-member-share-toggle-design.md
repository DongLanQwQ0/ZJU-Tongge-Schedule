# 成员分享开关 —— 设计

> 一句话：**群主能决定「邀请码是只有我能发，还是成员也能转发」；关掉之后服务端就不再把码下发给成员。**

## 1. 这个字段本来就在设计里

`shared/store.js:1177` 那个 `groupSettings()` 的注释写着：

> 老数据没有**这两个字段**，读的时候一律补默认值。

函数却只返回 `joinMode` 一个。同样地，`server.js:773` 的路由注释写着
「群主改群组设置（**入群方式 / 成员能否邀请**）」，而 `updateGroupSettings()`
只认 `joinMode` 和 `name`。

也就是说，第二个开关当初就打算做，只是没做。这个设计把它补上，
并且**默认值必须等于现在的事实行为**（成员能分享）——否则这次升级会悄悄改掉所有已有群。

## 2. 现在的行为

`groupDetail()`（`store.js:1552` 附近）在组装群详情时，按「你是谁」发不同的邀请码：

```js
invites: (g.creatorId === viewerId
    ? invites.slice()                                  // 群主：全部，含已作废的
    : invites.filter((i) => inviteActive(i, at)))      // 成员：只有还能用的
```

成员因此在群组页的邀请卡片上直接看得到可用的邀请码、二维码和分享按钮
（`app.js:1540` 的注释：「成员在邀请卡片上就能拿到能用的码」）。
成员**不能新建**邀请码（`addInvite` 要求 `creatorId`），他能做的只有**转发已有的**。

## 3. 开关的语义边界

| | 管 | 不管 |
|---|---|---|
| **管** | 成员**能不能拿到**邀请码去转发 | — |
| **不管** | — | 已经发出去的链接**还作不作数** |

第二条是刻意的，也是本设计里最需要说清的一点：**关掉开关不会让任何已发出的链接失效。**
外面已经流传的链接照旧能把人拉进来 —— 因为「谁能发」和「哪条链接有效」是两件事。
想掐断某条链接，用现成的「作废」；想全换一遍，用「换一个新码」。

把两件事合到一个开关上（关掉就顺手废一批链接）看起来更"安全"，
实际上更糟：群主只是想「别让成员到处发」，结果自己上周发给室友的链接也一起死了，
而且没有任何提示。分开之后每个动作都有明确的按钮和明确的后果。

**开关也不改变群主自己的任何东西**：他照旧看得到码、发得了链接、管得了邀请页。

## 4. 存储层

### 4.1 `groupSettings()` —— 补上默认值

```js
function groupSettings(g) {
    return {
        joinMode: g.joinMode === 'approval' ? 'approval' : 'open',
        // 这个字段是后加的，老群文件里没有它。默认 true 就是它上线之前的行为：
        // 成员本来就能看到并转发邀请码，升级不该让已有群悄悄变样
        memberShare: g.memberShare !== false
    };
}
```

用 `!== false` 而不是 `=== true`：将来任何意外写坏的值都退回「照旧允许」，
而不是把一群人的分享能力静默关掉。

### 4.2 `updateGroupSettings()` —— 收下这个字段

```js
if (patch && patch.memberShare !== undefined) {
    if (typeof patch.memberShare !== 'boolean') throw fail(400, '成员分享只能是开或关');
    next.memberShare = patch.memberShare;
}
```

和 `joinMode` 一样是白名单式校验：只有明确传了这个字段才动它，
所以「只改群名」的请求不会顺手把开关重置。

### 4.3 `groupDetail()` —— 关闭时不下发

```js
joinMode: settings.joinMode,
// 成员能不能拿到邀请码，由群主的开关说了算。关掉时**服务端就不下发** ——
// 只在界面上藏起来的话，成员照样能从接口响应里把码读出来，这开关就是个摆设
memberShare: settings.memberShare,
isCreator: g.creatorId === viewerId,
invites: (g.creatorId === viewerId
    ? invites.slice()
    : (settings.memberShare ? invites.filter((i) => inviteActive(i, at)) : []))
```

`memberShare` 对所有人可见（成员得知道「为什么我这里没有码」），
但**码本身**只对群主和有权限的成员可见。

## 5. 服务端路由

**不用改。** `/api/groups/:code/settings` 把 body 整个透传给
`updateGroupSettings()`，鉴权（`creatorId !== ownerId` → 403）也已经在那里面了。
只把它那条「（入群方式 / 成员能否邀请）」的注释改成实际措辞，别让注释继续骗人。

## 6. 界面

### 6.1 群组设置卡片

`#group-settings-card` 加第二个 `label.field`，**结构和 `#join-mode` 一模一样**
（分段控件是这个应用的二选一惯用法，同一张卡片里已经有一个）：

```html
<label class="field">
    <span>谁能分享邀请</span>
    <div class="segmented" id="share-mode">
        <button data-share="all" class="on">成员也能分享</button>
        <button data-share="owner">只有我能分享</button>
    </div>
</label>
```

`renderGroupSettings()` 里照 `#join-mode` 的写法同步 `.on`：

```js
$$('#share-mode button').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-share') === (g.memberShare === false ? 'owner' : 'all'));
});
```

点击处理照抄 `#join-mode` 那段（同一个容器委托 + 立刻 `renderGroup()`）。

### 6.2 成员侧：换掉卡片里的内容，而不是整张卡片

`index.html` 里把可分享的那一整块（提示语 + 码 + 二维码 + 链接 + 三颗按钮 + 说明行）
包进 `#invite-share-box`，后面跟一个 `#invite-closed`：

```html
<div class="card invite" id="group-invite-card">
    <div id="invite-share-box">
        <div class="tiny">把邀请码或二维码发给同学</div>
        <div class="code" id="group-code">······</div>
        <div class="qr" id="group-qr"></div>
        <div class="tiny" id="group-url" style="margin-top:10px;word-break:break-all"></div>
        <div class="row" style="margin-top:12px">…三颗分享按钮…</div>
        <p class="tiny" id="group-current-note" style="margin-top:10px"></p>
    </div>
    <div class="invite-closed" id="invite-closed" hidden>
        <div class="closed-emoji">🔒</div>
        <p>…见 6.3…</p>
    </div>
    <button class="link-btn center" id="btn-manage-invites" style="margin-top:6px" hidden>管理邀请链接</button>
</div>
```

**卡片留着，只换内容。** 整张卡片消失的话，成员会以为页面坏了；
留一个「——」加一张空二维码更糟 —— 那不像「群主没让你发」，像「这个群没有码」。

`renderGroup()` 里的分支：

```js
// 群主关掉「成员分享」之后，成员这边没有任何可分享的东西
var memberShareOff = !iAmOwner && g.memberShare === false;
if (memberShareOff) {
    box.hidden = true;
    closed.hidden = false;
} else {
    box.hidden = false;
    closed.hidden = true;
    …原来的码 / 二维码 / 说明渲染…
}
```

三颗分享按钮的 `disabled` 判定沿用 `canShare = !!disp`：关闭时 `canShare` 保持 `false`，
按钮自动被禁掉（`app.js:1516` 那段不用改）。**双保险**——即使有哪个分支漏了，
按钮也点不出一个能用的链接。

### 6.3 成员看到的文案

```
🔒 群主关掉了「成员分享」
想让同学进来？用群主发出来的那条链接，或者直接找他要一条 ——
他那边随时能生成。你负责把人喊来，码的事交给群主 (๑•̀ㅂ•́)و✧
```

两条路都说到（用群主发的 / 找群主要），尾巴一个颜文字。调子照
`#beta-modal` 那条「内测中，别嫌弃呀 🐣」写，那个 modal 的 `.beta-emoji`
（40px emoji）也是现成的样式先例。

### 6.4 样式

```css
.invite-closed { padding: 6px 4px 2px; }
.invite-closed .closed-emoji { font-size: 32px; line-height: 1; margin-bottom: 8px; }
.invite-closed p { font-size: 12px; line-height: 1.7; color: var(--text-2); }
```

`.invite` 自带的 `text-align: center` 会把它居中对齐，不用另写。

## 7. 已知限制

- **已经拿到码的人拦不住。** 成员今天复制走的链接，明天群主关掉开关，那条链接照样能用。
  这不是实现缺陷，是链接类分享的固有性质：码一旦离开服务器就不可召回。
- **开关只挡「新拿码」**，不挡「用已有的码」。见 §3。
- **没有通知。** 群主关掉之后，成员的界面要重新进群组页才看得到变化（这个应用没有服务端推送）。

## 8. 测试

**`test/server.test.js`**：

| 用例 | 断言 |
|---|---|
| 默认开着 | 新建群 `memberShare === true`；成员看得到 `invites` |
| **老群升级不变** | 把群文件里的 `memberShare` 字段删掉，读出来仍是 `true`、成员仍看得到码 |
| 只有群主能改 | 成员 PUT `{memberShare:false}` → 403，且字段没变 |
| 非法值 | `'yes'` / `0` / `null` → 400 |
| 关闭后 | 非群主 `invites` 是**空数组**、`memberShare` 为 `false`；群主的 `invites` 照旧 |
| 只改群名不误伤 | PUT `{name:'新名'}` 之后 `memberShare` 保持原值 |
| 已发出的链接仍能用 | 关掉开关之前取一枚邀请码，关掉之后拿它 join 仍然 200 |
| 再打开 | 改回 `true`，成员又能看到码 |

**`test/screens.test.js`**：

| 用例 | 断言 |
|---|---|
| 成员侧关闭态 | `#invite-share-box` 隐藏、`#invite-closed` 显示、三颗分享按钮 `disabled`、文案里有「群主」 |
| 群主侧不受影响 | 群主看到的还是码 + 二维码 + 可用按钮 |
| 开关即时生效 | 群主点「只有我能分享」→ 服务端字段变 `false`；成员那边重新进页面即是关闭态 |
| 开关能关回来 | 再点「成员也能分享」→ 成员又能看到码 |
