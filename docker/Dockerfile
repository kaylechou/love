FROM node:22-bookworm-slim

WORKDIR /app

# 无外部依赖，直接拷贝
COPY docker/server.mjs docker/d1-shim.mjs docker/package.json ./

# worker 本体（构建时从仓库根目录拷贝）
COPY worker.js ./

# 数据目录（挂载卷）
VOLUME ["/data"]
ENV PORT=8080 \
    DB_PATH=/data/fellowship.db \
    WORKER_PATH=/app/worker.js \
    TZ=Asia/Shanghai

EXPOSE 8080
CMD ["node", "server.mjs"]
