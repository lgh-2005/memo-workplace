#!/bin/bash
# v2.9.0 外刊全自动入库 · 网站服务器拉取脚本
#
# 由 cron 定时执行：从采集服务器（香港）rsync 最新 release（release-format v2
# 瘦索引 + 分片 gzip 全文），校验指纹后原子替换 corpus/external/current。
# 服务端按 mtime 热重载，无需重启 workbench。
#
# 依赖：rsync、ssh（免密，密钥见 ~/.ssh/hk_pull）
# 用法：/opt/workbench/scripts/pull_external.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/workbench}"
REMOTE="${EXTERNAL_REMOTE:-root@107.151.245.79}"
REMOTE_DIR="${EXTERNAL_REMOTE_DIR:-/root/corpus_scraper/release/current}"
CURRENT="${APP_DIR}/corpus/external/current"
BACKUPS="${APP_DIR}/corpus/external/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="${APP_DIR}/corpus/external/current.staging-${STAMP}"
KEEP=5

log() { echo "[pull_external $(date -u +%FT%TZ)] $*"; }

log "开始拉取 ${REMOTE}:${REMOTE_DIR}"

rm -rf "$STAGING"
mkdir -p "$STAGING"
rsync -az --delete --partial --timeout=120 \
  -e "ssh -i /root/.ssh/hk_pull -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \
  "${REMOTE}:${REMOTE_DIR}/" "$STAGING/" || { log "rsync 失败"; rm -rf "$STAGING"; exit 1; }

# --- 校验：manifest 必须存在且条数 > 0，索引与全文分片齐备 ---
if [ ! -f "$STAGING/manifest.json" ] || [ ! -f "$STAGING/articles_index.jsonl" ]; then
  log "校验失败：缺少 manifest.json 或 articles_index.jsonl"; rm -rf "$STAGING"; exit 1
fi

COUNT="$(grep -c '"id"' "$STAGING/articles_index.jsonl" || true)"
if [ "${COUNT:-0}" -le 0 ]; then
  log "校验失败：索引为空"; rm -rf "$STAGING"; exit 1
fi

# 逐分片 sha256 与 manifest 核对（防传输截断）
VERIFY="$(python3 - "$STAGING" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
m = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
bad = []
for name, meta in (m.get("files") or {}).items():
    p = root / name
    if not p.exists():
        bad.append(f"missing {name}"); continue
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    if meta.get("sha256") and h != meta["sha256"]:
        bad.append(f"sha mismatch {name}")
print(json.dumps({"ok": not bad, "errors": bad, "articles": m.get("article_count")}, ensure_ascii=False))
PY
)"
log "校验结果：${VERIFY}"
echo "$VERIFY" | grep -q '"ok": true' || { log "指纹校验失败，放弃更新"; rm -rf "$STAGING"; exit 1; }

# --- 归档当前版本（保留最近 KEEP 份） ---
mkdir -p "$BACKUPS"
if [ -d "$CURRENT" ]; then
  OLD_ID="$(python3 -c "import json,sys;print(json.load(open('$CURRENT/manifest.json')).get('release_id','unknown'))" 2>/dev/null || echo unknown)"
  mv "$CURRENT" "$BACKUPS/${OLD_ID}-${STAMP}"
fi

mv "$STAGING" "$CURRENT"
log "已更新 corpus/external/current（release=$(python3 -c "import json;print(json.load(open('$CURRENT/manifest.json')).get('release_id'))" 2>/dev/null || echo '?')）"

# 只保留最近 KEEP 份历史
ls -1dt "$BACKUPS"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf

# --- 只读冒烟（服务端应热重载；失败仅告警） ---
HTTP="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "http://127.0.0.1:5178/api/kb/status" || echo 000)"
log "冒烟 /api/kb/status -> HTTP $HTTP（401/200 均视为服务在线）"
log "完成"
