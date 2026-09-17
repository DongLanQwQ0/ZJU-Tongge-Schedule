# 同格 —— 找个课搭子一起上课
#
# 零依赖应用：基础镜像里只放 node 运行时 + 仓库代码，不跑 npm install。
#
# 构建：
#   docker build -t tongge:1.0 .
#
# 运行（根密钥必须从环境注入，见 docker-compose.yml）：
#   docker run -d --name tongge -p 3000:3000 \
#     -e TONGGE_ROOT_KEY=<64 位 hex> -v tongge-data:/app/data tongge:1.0

FROM node:22-alpine

# tini 负责回收僵尸进程并把 SIGTERM 正确转给 node。
# 少了它，`docker stop` 会等满 10 秒然后 SIGKILL —— 那样关服钩子里的
# 会话表 flush 就跑不到，最后一次登录状态会丢。
RUN apk add --no-cache tini

# 交互式进入容器时中文注释/日志不至于乱码（服务本身不需要 locale）
ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

# 先 COPY 代码，再 COPY 数据 —— 代码改了不必让数据层缓存失效
COPY server.js package.json ./
COPY shared/ ./shared/
COPY public/ ./public/

# 自带的种子数据目录（可选）。
#
# 镜像里**不带** data/ —— 早期版本把数据一起烧进镜像，好让首次部署自带账号，
# 代价是镜像层里留着密码哈希和**明文会话令牌**。镜像会被推 registry、被复制、
# 被留档，那等于把站点交出去。现在改成显式导入：
#   docker run --rm -v tongge-data:/data -v "$PWD/data:/seed" alpine \
#     sh -c 'cp -R /seed/. /data/'
# 入口脚本仍然支持 /opt/seed（有就铺，卷里非空就绝不动），所以那条路照样能用。
RUN mkdir -p /opt/seed

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# chmod +x 是必须的，不是多余：Windows 上的 git 不记录可执行位，
# 这个文件在索引里是 100644，COPY 进镜像后没有执行权限，
# 会以「permission denied」失败。
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app
# 注意：这里**不能**顺手 chmod /opt/seed。
#   cp 会连权限一起复制，种子里一旦少了写位，铺到 /app/data 之后
#   node 用户就写不了 users.json —— 表现为注册/传课表全线 500。
#   种子的只读性由入口脚本那一步「读进来」来保证就够了。

USER node

EXPOSE 3000

# /api/meta 是唯一不需要鉴权的接口，正好拿来当探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/meta').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
