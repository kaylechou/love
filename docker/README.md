# 团契智学 NAS / Docker 版

把 Cloudflare Worker 版完整搬到 NAS / 任意 Docker 主机上运行，**worker.js 本体零修改**。

## 架构

```
docker/
├── Dockerfile          # Node 22 镜像，零编译依赖
├── docker-compose.yml  # 一键启动
├── server.mjs          # Node.js 适配层：HTTP server + 导入 worker.js
├── d1-shim.mjs         # D1 → node:sqlite 兼容层
├── init-db.mjs         # 首次启动自动建表
└── package.json        # 无外部依赖（Node 22 内置 sqlite）
```

原理：`server.mjs` 用 Node 的 `http` 模块接请求，转成标准 Web `Request`，
调用 `worker.js` 的 `export default { fetch }`，再把 Web `Response` 写回。
`env.DB` 由 `d1-shim.mjs` 用 `node:sqlite` 实现 D1 的 `prepare/bind/all/run/first/batch` 语义。

## 快速启动（群晖 / 威联通 / 任意 Docker）

```bash
# 1. 克隆仓库
git clone https://github.com/kaylechou/love.git
cd love

# 2. 启动（首次自动建表）
docker compose -f docker/docker-compose.yml up -d --build

# 3. 打开 http://NAS_IP:8080
```

数据持久化在 `./data/fellowship.db`（SQLite 单文件，备份拷走就行）。

## 数据同步（Cloudflare ↔ NAS 双向）

**Cloudflare → NAS（自动）**：每天凌晨自动备份任务检测到课程变化时，
会同步更新 GitHub 上的 `docker/data/seed.sql`（全量课程+分类数据）。

**NAS 端同步**：在 NAS 上运行同步脚本即可（建议加到群晖计划任务每天执行）：
```bash
cd /path/to/love
bash docker/sync-from-github.sh
```
脚本会：拉取最新 seed.sql → 有变化才导入 → 自动备份旧库 → 重启容器。
用户数据表（成绩/学员/错题本/设置）不受影响，只更新课程和分类。

## 公网访问

- 内网：直接用 `http://NAS_IP:8080`
- 外网：Tailscale / frp 内网穿透，或 Cloudflare Tunnel（免费，HTTPS 自动）

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| PORT | 8080 | 监听端口 |
| DB_PATH | /data/fellowship.db | SQLite 文件路径 |
| WORKER_PATH | /app/worker.js | worker 文件路径 |
| TZ | Asia/Shanghai | 时区 |

## 与 Cloudflare 版的差异

- 定时任务（cron 自动备份 GitHub）需另行用 NAS 计划任务实现
- 推送通知等 Cloudflare 专属能力不可用（本项目未使用）
- 其余功能（课程、测验、成绩、错题本、多语言、导出）完全一致

<!-- ghcr: 镜像发布到 ghcr.io/kaylechou/love -->
