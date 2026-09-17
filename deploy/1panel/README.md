# 同格 · 找个课搭子一起上课 —— 部署包

> 这份说明是**部署机器上那份部署包**的原文，原样保留，讲的是 1Panel 那套布局
> （项目放在 `/opt/tongge`，只监听 `127.0.0.1:3560`，由反代对外）。
> 仓库总览、本地怎么跑、各部署方式的取舍见[根目录 README](../../README.md)。

这个包里已经是**可直接部署的完整应用**，不需要 `npm install`（零依赖），
并且**已经包含现有数据**（账号、群组、会话、审计）。

## 一条命令起服务

```bash
docker compose up -d --build
```

看启动日志：

```bash
docker compose logs -f tongge
```

然后访问 `http://<服务器IP>:3000`。

不想用 compose 也行：

```bash
docker build -t tongge:1.0 .
docker run -d --name tongge -p 3000:3000 -v tongge-data:/app/data tongge:1.0
```

## 换端口

改 `docker-compose.yml` 里的 `ports` 左边那个数字，例如改成 8080：

```yaml
ports:
  - "8080:3000"
```

## 数据放在哪

| 位置 | 内容 |
|---|---|
| 镜像里的 `/opt/seed` | 打包时带进去的**初始数据**（只当原料，不直接使用） |
| 卷 `tongge-data` → `/app/data` | **运行期真实数据**，容器重建也不会丢 |

`entrypoint.sh` 只在**首次启动**把种子铺到卷上，之后一律跳过：

| 场景 | 行为 |
|---|---|
| 首次启动、卷是空的 | 铺入种子（账号 / 群组 / 会话 / 审计都带过来） |
| 容器重启、换镜像版本 | **跳过**，同学新传的课表与账号一个不动 |
| 卷里只有 `groups/` | 认作已有数据，同样跳过 |

### 想干净上线（不带任何活跃登录态）

```bash
docker build -t tongge:1.0 --build-arg INCLUDE_SESSIONS=false .
```

账号和群组照旧，只是所有人需要重新登录一次。

## 备份与恢复

```bash
# 备份
docker run --rm -v tongge-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/tongge-$(date +%Y%m%d).tar.gz -C /data .

# 恢复（先停服）
docker compose stop
docker run --rm -v tongge-data:/data -v "$PWD:/backup" alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/tongge-YYYYMMDD.tar.gz -C /data"
docker compose start
```

程序自己每次写 `users.json` / `sessions.json` 都会留一份 `.bak`，
文件损坏时会自动从 `.bak` 恢复 —— 那防的是「写坏」，不防「误删」，两者都要有。

## ⚠️ 这个包和镜像里有凭据

- `data/users.json` 是**密码哈希**，`data/sessions.json` 是**明文会话令牌**。
- **不要推到公开仓库**，也不要把这个包随手丢到公开网盘。
- 谁拿到它，谁就拿到了所有账号的登录态 —— 等同于拿到了站点。

## ⚠️ 放到公网前请想清楚

这套限流阈值是按**「认识的人之间、同一个局域网自用」**定的。
一旦映射到公网，前提就不成立了：

- 密码与令牌走 **HTTP 明文**。公网上必须套一层反向代理加 HTTPS，
  否则同链路上任何人抓到令牌就等于拿到账号。
- 入群接口 20 次/分钟、全局 600 次/分钟是**按 IP** 的。
  公网上攻击者换 IP 成本很低，「8 位邀请码枚举要上百年」的结论不再成立。
- 「任何人都能注册账号」在公网意味着会被批量灌号。

建议：只在内网用，或前面挂 Nginx/Caddy（HTTPS + 真实 IP 传递 + 更严的限流）。

## 容器里的一个已知现象

启动横幅会显示「未检测到局域网地址」，这是**正常的**：
容器里只有 `eth0`（172.x），没有可供同学连的网卡。
**用端口映射把服务暴露到宿主机**，把宿主机 IP 发给同学即可。
页面上「复制链接」拿到的地址需要用宿主机 IP。

## 版本与排查

- 镜像基础：`node:22-alpine`；应用零 npm 依赖。
- 排查数据：`data/groups/` 下的**文件名不一定等于群码**（换过码的群，
  文件名仍是旧码，那是内部存储键）。以文件里的 `code` 字段为准。
- 审计日志：`data/audit.log`（JSON Lines，一行一条）。
