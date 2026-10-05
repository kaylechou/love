#!/bin/bash
# 团契智学 NAS 数据同步脚本
# 用法：在 NAS 上定时运行（如每天凌晨），或手动执行
# 功能：从 GitHub 拉取最新 seed.sql 并导入本地 SQLite
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$REPO_DIR/data"
SEED_URL="https://raw.githubusercontent.com/kaylechou/love/main/docker/data/seed.sql"
DB_FILE="$DATA_DIR/fellowship.db"
SEED_FILE="$DATA_DIR/seed.sql"

mkdir -p "$DATA_DIR"
cd "$REPO_DIR"

echo "[sync] 拉取最新代码..."
git pull --quiet 2>/dev/null || echo "[sync] git pull 跳过（非 git 目录请手动更新）"

echo "[sync] 下载 seed.sql..."
curl -sL "$SEED_URL" -o "$SEED_FILE.new"
if [ ! -s "$SEED_FILE.new" ]; then
  echo "[sync] seed.sql 下载失败，跳过"
  exit 1
fi

# 有变化才导入
if [ -f "$SEED_FILE" ] && cmp -s "$SEED_FILE" "$SEED_FILE.new"; then
  echo "[sync] 数据无变化，跳过导入"
  rm -f "$SEED_FILE.new"
  exit 0
fi
mv "$SEED_FILE.new" "$SEED_FILE"

echo "[sync] 备份旧库..."
[ -f "$DB_FILE" ] && cp "$DB_FILE" "$DB_FILE.bak-$(date +%Y%m%d-%H%M%S)"

echo "[sync] 导入数据..."
# 保留用户数据表（progress/students/wrongs/settings），只重建 courses/categories
sqlite3 "$DB_FILE" <<'EOF'
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS categories;
EOF
sqlite3 "$DB_FILE" < "$SEED_FILE"

echo "[sync] 重启容器..."
docker compose -f "$REPO_DIR/docker/docker-compose.yml" restart 2>/dev/null || \
docker-compose -f "$REPO_DIR/docker/docker-compose.yml" restart 2>/dev/null || \
echo "[sync] 请手动重启容器"

echo "[sync] 完成"
