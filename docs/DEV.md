# 同格 · 开发笔记

> 这份是**改代码的人**看的：设计取舍、接口一览、测试、目录结构、版本管理、后续规划。
> 用户怎么用看 [README](../README.md)，怎么部署看 [DEPLOY.md](DEPLOY.md)。

---

## 几个设计上的取舍

- **单双周不做奇偶推算**，直接按 `.ics` 里的真实日期判断。调休、临时加课、停课都天然正确。
- **屏幕按周显示，导出是全学期**。导出的图包含单周/双周两套，只有真正有差异的格子才标注
  「单周 / 双周」；两套一致的课不产生任何标注。导出与当前选中的周次无关。
- **导出会剔除只出现一次的条目**。教务导出的 `.ics` 里混着期末考试和调休补课，它们只出现一次
  却会和常规课撞格。实测：不过滤时导出图有 28 处假标注，过滤后剩 5 处真单双周。
  该过滤**只作用于导出**，屏幕上仍按真实日期原样显示。
- **管理页的筛选排序全在浏览器里算**，`/api/admin/overview` 没有查询参数。
  它本来就把全部账号（连同注册时间、登录次数、没露面天数那些字段）一次性发过来了，
  加查询参数只会给每次输入添一个来回。等账号真上千条再谈。
  两个坑记在这里：**注册时间区间必须按本地日解析**（`new Date('2026-09-15')` 是 UTC 午夜，
  东八区会把当天 00:00–08:00 注册的账号漏掉），**数字框留空是「不限」而不是 0**。

---

## 换群自己的码（实现备注）

改版前建的群，码是 **6 位**（10⁶ 空间）。配 20 次/分钟的限流，枚举完只要一个多月，
比 8 位的「上百年」弱得多。管理页里的「换一个新码」可以把它换成 8 位，
代价是**以前发出去的所有链接一起失效**，需要把新码重新发给还没进群的同学。

实现上只改 `g.code`、**不动文件名**：文件名是内部存储键，改它就要 rename，
而 rename 跨崩溃不原子，失败一次群就丢了。代价是码和文件名会分家，
所以所有按码取群的路径都走 `resolveGroupFile()`（先按文件名试，再扫 code 字段），
换过码的群照样能正常改设置、移人、发链接。

---

## 给开发者：接口一览

服务端是 `server.js` 里一张路由表，鉴权走 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` | 健康探针 + 页脚版本号：`{ ok, app, tagline, version, build }`。唯一免鉴权接口，Docker 健康检查也打它 |
| GET | `/api/captcha` | 注册验证码：`{ enabled, id, image }`，`image` 是一张 PNG 的 data URL |
| POST | `/api/register` `/api/login` `/api/logout` | 账号（注册要带上 `captchaId` + `captchaAnswer`） |
| GET / DELETE | `/api/me` | 当前账号 / 注销 |
| PUT | `/api/me/courses` `/api/me/password` | 上传课表 / 改密码 |
| PUT | `/api/me/remarks/:targetId` | 个人备注（只有自己可见） |
| GET | `/api/me/groups` | 我加入的群 |
| POST | `/api/groups` | 建群 |
| POST | `/api/groups/:code/join` | 入群（或提交申请） |
| GET | `/api/groups/:code` | 群详情（含重合统计） |
| PUT | `/api/groups/:code/settings` | 群设置（改名 / 入群策略 / 备注） |
| POST | `/api/groups/:code/transfer` | 转让群主（**要密码**，复用改密码那条限流桶） |
| POST | `/api/groups/:code/rotate-code` | 换群码 |
| POST / DELETE | `/api/groups/:code/invites…` | 邀请链接：新建 / 作废 / 删除存档 |
| POST / DELETE | `/api/groups/:code/requests/:userId` | 审批进群申请 |
| DELETE | `/api/groups/:code/members/:userId` | 移除成员 |
| GET | `/api/admin/overview` | 管理员视图：账号 / 群组 / 审计 |
| PUT / DELETE / POST | `/api/admin/users/:id…` | 授权、删除账号、重置密码 |
| POST / DELETE | `/api/admin/groups/:code…` | 换群码、解散群组 |

授权管理员走命令行（因为这是**本机操作**——能敲这条命令就说明你本来就摸得到 `data/`）：

```bash
node server.js --make-admin 你的昵称     # 设为管理员
node server.js --revoke-admin 你的昵称   # 取消管理员
```

先在网页上把账号注册出来，再执行这条命令。

---

## 测试

```bash
npm test        # node --test，零依赖
```

实测：**282 项全部通过**（Node 24）。覆盖 ICS 解析、地点分级、教学周、重合统计、
导出视图、账号/会话/群组存储、注册验证码（出题/画图/过期/一次性核销）、管理页、
群主转让（密码校验 + 限流共用桶 + 越权矩阵 + 群码不变）、
前端接线与六个屏幕的 DOM 全量扫描，以及一次完整的 HTTP 端到端旅程和一组安全回归
（穿越矩阵、限流、415/413、响应头）、存储加密（AAD 跨用户/跨群/跨用途必须失败、
迁移幂等与回滚、四种"拒绝启动"）、会话令牌哈希化（含老数据升级不踢人下线）、
超管守卫（撤不掉/删不掉/重置不了）、真实来源 IP（反代后分桶 + 伪造头必须无视）、
页脚版本号（版本只认 package.json，提交号在假仓库里验松散 ref / packed-refs / 分离头指针）。

> 如果 `npm test` 报「找不到测试文件」（旧版 Node 不会展开 `--test` 里的通配符），
> 直接写全：`node --test test/*.test.js`。

> 仓库根目录的三份 `.ics` 是真实课表（含真实姓名），已被 `.gitignore` 的 `*.ics` 通配符排除。
> 缺少它们时，依赖真实数据的少数测试会自动跳过。
> 测试按目录扫描这些文件、靠内容认它们，**文件名不会出现在代码里**——
> 所以你换成什么名字重新导出都不影响。

---

## 目录结构

```
server.js          零依赖 HTTP 服务（API + 静态文件）
shared/config.js    全局配置：发起人昵称等，改这一处
shared/            纯函数层：ics / periods / weeks / compare（前后端与未来小程序共用）
                    只有这里被列进白名单的这 5 个文件能通过 /shared/* 下载
shared/auth.js     密码哈希与会话令牌生成（仅服务端）
shared/captcha.js  注册验证码：个位数四则运算 + 手写 PNG 编码（仅服务端，零依赖）
shared/vault.js    存储加密：AES-256-GCM + AAD 域分离 + 根密钥解析（仅服务端）
shared/build.js    版本号与构建号（读 package.json 与 .git，页脚那行灰字用它；仅服务端）
shared/store.js    原子写（带重试）+ 写队列 + 校验 + .bak 备份 + 读写边界上的加解密
public/            前端：index.html / app.js / style.css / api.js
public/lib/        本地内置的 html2canvas 与二维码生成器（不依赖 CDN）
public/img/        导出教程截图与吉祥物
data/              运行时生成：users.json / sessions.json / groups/*.json
                    敏感字段（昵称/课表/备注）是密文；users/sessions 另留一份 .bak
test/              node --test，含一组安全回归（穿越矩阵、限流、415/413、响应头、加密）
docs/              设计文档与 docs/ROADMAP.md（待办与规划）
docs/superpowers/  设计规格（specs/，每份都标了日期与当时的取舍）
Dockerfile         node:22-alpine 镜像。**不带 data/**（镜像里不留哈希与令牌）
docker-compose.yml 一条命令起服务，数据落在命名卷 tongge-data，端口只绑本机给反代用
entrypoint.sh      首次启动把种子铺到数据卷（已有数据则绝不覆盖）
.dockerignore      挡住真实课表与 data/
dist/              本地打包产物（镜像 tar 与 zip），不进版本库
```

---

## 版本管理与推送

**只推送 `main` 分支。**

```
main            要推送的分支，干净的起点（单个初始提交）
local-archive   早期开发历史，仅本地保留，永不推送
```

为什么这么分：仓库根目录那几份真实课表虽然已经被 `.gitignore` 挡在库外，但**早期提交里
还留着同学的真名**（当时的测试夹具和文档）。与其重写历史（会改掉全部提交哈希），
不如从当前这份已经全部化名的状态重新起一个根提交，只把这个提交推上去。

⚠️ **不要用 `git push --all`，也不要用 GUI 里的「推送所有分支」**——那会把
`local-archive` 连它背后的 44 个提交一起推上去，化名就白改了。

```bash
git remote add origin <你的仓库地址>
git push -u origin main
```

之后正常 `git add` / `git commit` / `git push` 就行，历史会从 `main` 这个根提交往后长。

---

## 后续规划

方向、坑和优先级写在 **[docs/ROADMAP.md](docs/ROADMAP.md)** 里，那里每一条都标了
「现在是什么样」，免得误以为已经做过了。摘要（按优先级）：

1. **备份 + 写前快照**——成本最低，救的是最不可逆的损失
2. **限流改成按真实 IP / 按账号双轨**（真实 IP 已支持，见 [关于真实 IP](#关于真实-ip)；
   「按账号」那一轨还没做）
3. **超时与抗打加固**（`headersTimeout` / `requestTimeout` / 单 IP 并发上限）
4. **审计聚合与自动封禁**——在有人开始攻击之后再补就晚了
5. **接入学校身份认证**——收益大但外部依赖重，可以晚
6. **课表匹配（找相似课表的人）**——功能上最有意思，风险上也最重，放最后且单独评审

> ~~传输加密~~ **已完成**：正式服由反向代理提供 HTTPS，容器只监听本机环回。

> 第 6 项要注意：现在的可见范围是「同群成员」，本质上是熟人网络。
> **一旦开放陌生人匹配，就从「熟人可见」变成「陌生人可见」**，
> 而课表里含真实姓名、每周行踪、常去的楼栋教室。这条上线前应当单独做一次评审。
