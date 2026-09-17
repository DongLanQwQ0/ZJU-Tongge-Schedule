# 项目定位改为「服务器正式服」— 设计

> 日期：2026-09-17　状态：已批准，待实现

## 背景

代码与文档还停在**「局域网自用」**这一定位上：

- 服务端探测本机网卡，把「同学能连的局域网地址」塞进免鉴权接口 `/api/meta`
- 启动横幅教人「把 `http://10.x.x.x:3000` 发给同学」，还提醒 Windows 防火墙
- 前端在本机 `localhost` 打开时，把邀请链接换成局域网地址（怕同学扫码打不开）
- README / ROADMAP 把「密码明文过网」列为**最大短板**
- 根目录 compose 的端口是 `3000:3000`，含义是「谁都能直连」

而它**实际上已经是正式服**：公网服务器 + 反向代理 + HTTPS，站点挂在**子路径**下
（形如 `https://<主机>/tongge/`），容器只监听 `127.0.0.1:3560`。

### 触发这次改动的证据

线上 `GET /tongge/api/meta` 无需登录，任何访问者都能拿到：

```json
{"lanUrls":["http://172.25.0.2:3000"],
 "interfaces":[{"name":"eth0","address":"172.25.0.2","virtual":false}],
 "port":3000}
```

一个正式服没必要把容器内网地址告诉陌生人。

## 目标

1. 文档与代码统一到「服务器正式服」这**一种**定位，不再出现局域网 / 同一个 WiFi 的话术
2. **两种运行方式都保留**：`docker compose up -d --build` 一键部署；`node server.js` 原生开服并可直接访问
3. `/api/meta` 不再输出网络拓扑信息
4. 测试保持全绿

## 非目标

- 不动鉴权、限流、存储与业务逻辑
- 不改历史设计文档 `docs/superpowers/specs/2026-09-15-*.md`（那是当时的设计记录）
- 不在公开 README 里写死服务器 IP —— 免得把「任何人都能注册」的入口摆到明面上
- 不新增运行时或依赖

## 设计

### 服务端 `server.js`

| 项 | 处理 |
|---|---|
| `VIRTUAL_IFACE` / `lanInterfaces()` / `lanUrls()` | 删除 |
| `require('node:os')` | 若删完再无用处则一并移除 |
| `GET /api/meta` | 改成健康探针语义：`{ ok: true, app, tagline }`。**端点保留**——Dockerfile 与 compose 的 `HEALTHCHECK` 都打它，且它是唯一免鉴权接口 |
| 启动横幅 | 只打印本机地址 `http://localhost:<port>`，并说明对外由反向代理提供 HTTPS、站点挂在 `/tongge/` 这类子路径下；保留「待复核账号」提示；删掉局域网地址、防火墙、虚拟网卡那些话 |
| `module.exports` | 去掉 `lanUrls` |

### 前端 `public/app.js`、`public/api.js`

- 删 `metaCache` 与 `shareCandidates()`
- `joinUrl()` 只保留「按 `document.baseURI` 拼」这一条路。**保持 `async`**，因为调用点用了 `.then()`，改同步会连带改调用方
- 删 `API.meta()`（前端不再需要）；服务端的 `/api/meta` 路由保留给健康检查
- 「连不上服务器，检查一下是不是同一个 WiFi」改为不依赖网络的措辞

### 配置

- `docker-compose.yml`：`ports` 改 `127.0.0.1:3560:3000`，注释写清「正式服只给反代」与「要直连就改回 `3000:3000`」
- 删除 `deploy/1panel/`（与根目录 compose 重复；其独特内容已在根 README 的部署章与备份章）
- `entrypoint.sh` 的「容器里看不到局域网地址」提示换成反向代理提示
- `package.json` 的 description 去掉「局域网」
- `shared/auth.js` 注释去掉「局域网自用」

### 文档

- **README**：定位、快速开始、部署详解、已知限制、故障排查、后续规划按正式服重写；
  「明文 HTTP 是最大短板」改为「反代终止 TLS，容器只监听环回」；本机 `node server.js` 降为「开发 / 本地预览」
- **docs/ROADMAP.md**：现状盘点表与「传输加密」一节按新事实更新，优先级去掉已完成项

## 测试

- `test/server.test.js` 的 `/api/meta` 断言改为新字段，并**显式断言不再出现 `lanUrls` / `interfaces`**（防止日后回退）
- 目标：`npm test` 全绿（当前 170 项）

## 风险与取舍

- **反代必须剥离子路径前缀**（`/tongge/api/*` → `/*` 转给容器）。README 里写明这一点，否则相对路径会 404
- **删掉 lanUrls 后，本机用 `localhost` 打开时邀请链接不再自动换成内网地址**。这是有意的：
  正式服不需要它。要在手机上真机测扫码，手工把地址换成内网 IP 即可。若日后确实需要，
  再按「仅本机调试」的开关加回来，而不是常驻一段网卡探测
- Docker 端口默认只给反代，**在没配反代的裸服务器上 `docker compose up` 后无法直接访问**。
  这是安全侧的取舍：公网机器上忘了配反代就等于明文裸奔。compose 注释里给了直连写法
