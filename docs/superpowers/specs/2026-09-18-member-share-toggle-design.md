# 成员分享开关 —— 设计

> 一句话：**群主能决定「邀请码是只有我能发，还是成员也能转发」；关掉之后服务端就不再把码下发给成员。**

## 1. 这个字段以前存在过，被删掉了

先把历史摆出来，否则这份设计看着像是从零加一个开关。

### 1.1 v8 那次删除

**v7**（`docs/superpowers/specs/2026-09-15-group-schedule-comparator-design.md:16`）加了群组设置
`joinMode`。**v8** 紧接着做了第二个开关 `memberCanInvite`，然后在同一个版本里把它删了：

> 删掉 `memberCanInvite`。**它只隐藏按钮、后端不校验**，成员本来就知道邀请码，
> 属于「设了但管不住」的假开关，**比没有更糟**。真正有效的入口控制只有审批与移除成员。

这次删除留下了三处残骸，都还在代码里：

| 位置 | 内容 |
|---|---|
| `shared/store.js` `groupSettings()` 注释 | 「老数据没有**这两个字段**」——函数其实只返回一个 |
| `server.js` settings 路由注释 | 「入群方式 / **成员能否邀请**」——`updateGroupSettings()` 不认这个字段 |
| `test/server.test.js:351` | 专门钉着删除：传 `memberCanInvite` 必须 400，「免得留下『设了但没用』的误会」 |

字段名因此**不叫 `memberCanInvite`，改叫 `memberShare`**：重用一个被删掉的名字，
下一个人翻到那条历史时会先困惑「这不是删了吗」，而且现有那条「传 `memberCanInvite` 必须 400」
的测试会立刻自相矛盾。新名字也让「成员**分享**」比「成员**邀请**」更准 ——
成员从来不能新建邀请码（`addInvite` 要求 `creatorId`），他能做的只有转发。

### 1.2 这次和 v8 有什么不同，以及**没有**什么不同

v8 那句「后端不校验」是症结。这次服务端**确实**不再把邀请码下发给成员（见 §4.3）。
但 v8 那句「成员本来就知道邀请码」**今天依然成立**，这是必须摊开讲的：

群码身兼两职 —— 它既是「寻址这个群的 id」（成员打开群、退群、设备注都拿它调接口），
**又是**群主那个永久邀请码（`store.js` 里明确承诺过「改版前发出去的链接用的就是它，不能让它失效」）。
于是它出现在每一个成员看得到的响应里。实测（临时起服务，走真实接口）：

```
成员看到的 memberShare : false      ← 服务端不下发邀请码，这部分是有效的
成员看到的 invites 数量 : 0
成员看到的 ownerCode   : null
成员看到的 code        : 35675950   ← 群码本身，而且它是个永久有效的邀请码
外人拿 code 直接加入   : 200 {"ok":true,...}
成员群列表里的 code    : 35675950
```

**所以这个开关不是安全边界。** 它是行政性的：防的是「十个人各发各的链接、
群主不知道谁把谁放了进来」，不是「有人铁了心要塞人进来」。

要让它变成安全边界，得把「成员寻址用的群标识」和「邀请码」拆开 ——
存储结构、全部群路由、前端状态、邀请 URL 都要动，而且要打破上面那条兼容承诺。
收益是「成员多走一步 devtools」。**这次不做**，理由记在 §7。

### 1.3 那么这次做了什么

三件事，合起来让**这个应用的界面里**成员拿不到任何能用的邀请码：

1. 服务端不再把邀请码下发给成员（§4.3）
2. 成员侧邀请卡片不再摆一个「——」加空二维码，换成说明（§6.2）
3. 首页那张群卡片不再把群码印给成员（§6.5）—— 否则一边说「只有群主能分享」，
   一边把码印在成员眼前，这个开关就还是 v8 那个假开关

剩下唯一的口子是「成员自己去读接口响应」，记在 §7。

继续沿用一条老规矩：**默认值必须等于现在的事实行为**（成员能分享），
否则这次升级会悄悄改掉所有已有群，而且没人会注意到。

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

### 4.4 `listGroupsForUser()` —— 首页那张卡片也要知道

`/api/me/groups` 的每一项补上同一个标志：

```js
out.push({
    code: g.code,
    name: g.name,
    memberCount: g.members.length,
    isCreator: g.creatorId === userId,
    // 成员分享被关掉时，首页那张群卡片也不该印邀请码（见 §6.5）
    memberShare: groupSettings(g).memberShare,
    pending: isPending,
    updatedAt: g.updatedAt
});
```

`groupSettings(g)` 本来就在这个文件里、也已经在别处被调用，这里只是多用一次。

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

### 6.5 首页那张群卡片

`loadGroups()` 现在对**所有**群都印着邀请码：

```js
'<div class="sub">邀请码 ' + esc(g.code) + ' · ' + g.memberCount + ' 人' + …
```

这就是「假开关」最扎眼的地方：群主关掉成员分享，成员往上一滑，码还在首页写着。
改成分情况：

```js
// 群主关掉「成员分享」之后，成员连码都不该看到 —— 首页这张卡片也算。
// 卡片上的 data-code 照样留着（点它是靠它进群的），只是不往界面上印
var canSeeCode = g.isCreator || g.memberShare !== false;
…
'<div class="sub">' + (canSeeCode ? '邀请码 ' + esc(g.code) + ' · ' : '') + g.memberCount + ' 人' + …
```

注意 `data-code` **不能动** —— 整张卡片就是靠它进群的（`el.getAttribute('data-code')`），
去掉它首页就点不开了。改的只是**印出来的那行字**。

条件写成 `g.isCreator || g.memberShare !== false` 而不是直接 `g.isCreator`：
**开关默认是开的**，那时成员看到邀请码是这个功能上线前就有的行为，
没有理由顺手改掉。只有在群主**明确关掉**之后，界面才开始一致地不向成员显示码。

## 7. 已知限制（这一节是重点）

- **它不是安全边界，是行政开关。** 成员仍然能从接口响应里读到 `code`（= 群主的永久邀请码）
  并拿它把人拉进来 —— §1.2 有实测输出。界面里已经看不到码了（§6.2、§6.5），
  但「打开开发者工具看响应」这一步拦不住。它挡的是「随手转发」，不是「有意绕过」。
- **不做那个重构，是有意取舍。** 把「成员寻址用的群标识」和「邀请码」拆开能堵住上面这条，
  代价是存储结构 + 全部群路由 + 前端状态 + 邀请 URL 全要动，还要打破
  「改版前发出去的链接不失效」这条明确承诺（`store.js` 里写着）。换来的只是
  「成员多走一步 devtools」。哪天真要把它当安全边界用，再单独评审这一条。
- **v8 的结论仍然适用于「安全」这个层面。** 想要真正管住入口，用的还是那两条：
  把「谁能进群」切成**要我同意**，以及**移除成员**。这个开关不替代它们。
- **已经拿到码的人拦不住。** 成员昨天复制走的链接，今天群主关掉开关，那条照样能用。
  这不是实现缺陷，是链接类分享的固有性质：码一旦离开服务器就不可召回。
- **开关只挡「新拿码」**，不挡「用已有的码」。见 §3。
- **没有通知。** 群主关掉之后，成员要**重新进群组页或刷新首页**才看得到变化
  （这个应用没有服务端推送）。

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
| 群列表带标志 | `/api/me/groups` 每一项都有 `memberShare`；关闭后成员拿到的是 `false` |

**`test/screens.test.js`**：

| 用例 | 断言 |
|---|---|
| 成员侧关闭态 | `#invite-share-box` 隐藏、`#invite-closed` 显示、三颗分享按钮 `disabled`、文案里有「群主」 |
| 群主侧不受影响 | 群主看到的还是码 + 二维码 + 可用按钮 |
| **首页卡片不印码** | 关闭后成员的首页卡片文案里**不含**群码，但 `data-code` 还在（还能点进去） |
| **首页卡片默认照旧** | 开关没动过时，成员首页卡片仍然印着邀请码（升级不改现状） |
| 群主首页照旧 | 群主那张卡片始终印自己的码 |
| 开关即时生效 | 群主点「只有我能分享」→ 服务端字段变 `false`；成员那边重新进页面即是关闭态 |
| 开关能关回来 | 再点「成员也能分享」→ 成员又能看到码 |
