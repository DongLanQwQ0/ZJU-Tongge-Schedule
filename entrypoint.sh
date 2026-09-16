#!/bin/sh
# 同格容器入口：把镜像里那份种子数据安全地铺到数据卷上，然后启动服务。
#
# 为什么需要这一步：
#   镜像里烧了 data/（含账号、群组、会话），但运行期数据必须落在**卷**上，
#   否则容器一重建，同学新传的课表就没了。
#   直接 VOLUME /app/data 的话，Docker 会用镜像里的内容初始化新卷 ——
#   看起来够了，但那套行为只对「匿名卷 / 命名卷」成立，
#   而且一旦有人改成 bind mount（./data:/app/data），
#   宿主机那个目录是空的，服务会从空库开始，所有账号凭空消失。
#   所以这里显式做一次、且只做一次，并把规则写清楚。

set -e

DATA_DIR="${DATA_DIR:-/app/data}"
SEED_DIR="${SEED_DIR:-/opt/seed}"

log() { echo "[entrypoint] $*"; }

mkdir -p "$DATA_DIR"

# 判断「卷里是不是已经有数据」：认 users.json 或 groups/ 里任意文件。
# 只看「目录是否为空」不够稳 —— 有些环境会先塞进 lost+found 之类的东西。
has_data() {
    [ -f "$DATA_DIR/users.json" ] || [ -f "$DATA_DIR/sessions.json" ] || \
        { [ -d "$DATA_DIR/groups" ] && [ -n "$(ls -A "$DATA_DIR/groups" 2>/dev/null)" ]; }
}

if has_data; then
    log "数据卷里已有数据，跳过种子铺入（不会覆盖现有账号与群组）"
else
    if [ -d "$SEED_DIR" ] && [ -n "$(ls -A "$SEED_DIR" 2>/dev/null)" ]; then
        log "首次启动：把镜像自带的种子数据铺到 $DATA_DIR"
        cp -R "$SEED_DIR"/. "$DATA_DIR"/
        # 具体铺了什么，留个账，方便事后核对
        if [ -f "$DATA_DIR/users.json" ]; then
            log "  已带入账号表 users.json ($(wc -c < "$DATA_DIR/users.json") 字节)"
        fi
        if [ -f "$DATA_DIR/sessions.json" ]; then
            log "  已带入会话表 sessions.json（同学无需重新登录）"
        else
            log "  未包含会话表：所有人需要重新登录一次"
        fi
        if [ -d "$DATA_DIR/groups" ]; then
            log "  已带入 $(ls -1 "$DATA_DIR/groups" 2>/dev/null | wc -l) 个群组文件"
        fi
    else
        log "没有种子数据，从空库开始（第一个注册的人即管理员候选）"
    fi
fi

# 铺完之后修一次权限。
#
# 为什么必须修：cp 会把权限一起复制。如果种子里没有写位（或者将来有人
# 给种子目录加了只读），铺到卷上的 users.json 就是只读的，
# node 用户写不进去 —— 表现是注册、传课表全线 500，而且报错很难指向这里。
# u+rwX 只给属主加位，不会把文件开放给别的用户。
if [ "$(id -u)" = "0" ]; then
    chown -R node:node "$DATA_DIR" 2>/dev/null || true
else
    chmod -R u+rwX "$DATA_DIR" 2>/dev/null || true
fi
# 目录本身收窄到 0700：容器里只有 node 一个非 root 用户，
# 这一步保证「即使有人往容器里加了别的用户」也读不到令牌与哈希。
chmod 700 "$DATA_DIR" 2>/dev/null || true

# 最后确认真的写得进去。
# 最常见的翻车方式是 bind mount：宿主机目录是 root:root，容器里跑的是 node(1000)，
# 于是服务能起来、能读旧数据，但一注册/一传课表就 500。
# 在这里失败比让它在运行期炸要好得多 —— 提示直接给出修法。
if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
    log "✘ $DATA_DIR 不可写（当前用户 uid=$(id -u)）"
    log "  这通常是 bind mount 的属主不对。任选一种修法："
    log "    · 宿主机上执行：sudo chown -R 1000:1000 <你映射的目录>"
    log "    · 或在 compose 里加：user: \"0:0\"（会以 root 跑，安全性下降）"
    log "    · 或干脆用命名卷（推荐）：-v tongge-data:/app/data"
    exit 1
fi
rm -f "$DATA_DIR/.write-test"

# 容器内基本没有「可供同学连的局域网网卡」，启动横幅会提示未检测到。
# 这里先说清楚，免得看到横幅以为坏了。
log "提示：容器默认走 bridge 网络，局域网地址在容器内不可见。"
log "      要让同学连，用 -p 3000:3000 映射到宿主机（推荐），"
log "      或 Linux 下加 --network host。"
log "启动：$*"

exec "$@"
