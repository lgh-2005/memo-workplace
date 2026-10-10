#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${WORKBENCH_ROOT:-/opt/workbench}"
SERVICE_NAME="${WORKBENCH_SERVICE:-workbench.service}"
REMOTE_REF="${WORKBENCH_REF:-master}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="${APP_ROOT}/data/backups"
RELEASE_DIR="${APP_ROOT}/.releases/${STAMP}"
HEALTH_URL="${WORKBENCH_HEALTH_URL:-http://127.0.0.1:5178/api/auth/status}"

cd "$APP_ROOT"
mkdir -p "$BACKUP_DIR" "$RELEASE_DIR"
echo "[deploy] backing up data"
BACKUP_TMP="${APP_ROOT}/.data_backup_v333_${STAMP}.tar.gz"
tar -czf "$BACKUP_TMP" -C "$APP_ROOT" data
mv "$BACKUP_TMP" "${BACKUP_DIR}/data_backup_v333_${STAMP}.tar.gz"
echo "[deploy] saving current code release"
git archive HEAD | tar -x -C "$RELEASE_DIR"
echo "[deploy] fetching ${REMOTE_REF}"
git fetch origin "$REMOTE_REF"
TMP_RELEASE="$(mktemp -d)"
trap 'rm -rf "$TMP_RELEASE"' EXIT
git archive "origin/${REMOTE_REF}" | tar -x -C "$TMP_RELEASE"
echo "[deploy] applying product files while preserving runtime data"
command -v rsync >/dev/null 2>&1 || { echo "[deploy] rsync is required to preserve runtime data" >&2; exit 1; }
rsync -a --exclude data/ --exclude corpus/records.jsonl --exclude corpus/exams.jsonl \
  --exclude corpus/external/current/ --exclude corpus/external/releases/ \
  --exclude scripts/pull_external.sh "$TMP_RELEASE/" "$APP_ROOT/"
git reset --mixed "origin/${REMOTE_REF}" >/dev/null
echo "[deploy] restarting ${SERVICE_NAME}"
systemctl restart "$SERVICE_NAME"
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    echo "[deploy] healthy: $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo "[deploy] health check failed; run scripts/rollback.sh ${STAMP}"
exit 1
