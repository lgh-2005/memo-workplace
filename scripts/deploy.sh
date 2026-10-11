#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${WORKBENCH_ROOT:-/opt/workbench}"
SERVICE_NAME="${WORKBENCH_SERVICE:-workbench.service}"
REMOTE_REF="${WORKBENCH_REF:-master}"
DRY_RUN="${DRY_RUN:-0}"
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="${APP_ROOT}/data/backups"
RELEASE_DIR="${APP_ROOT}/.releases/${STAMP}"
HEALTH_URL="${WORKBENCH_HEALTH_URL:-http://127.0.0.1:5178/api/auth/status}"
HEALTH_BASE_URL="${WORKBENCH_HEALTH_BASE_URL:-http://127.0.0.1:5178}"

cd "$APP_ROOT"
if [[ "$DRY_RUN" == "1" ]]; then
  command -v rsync >/dev/null 2>&1 || { echo "[deploy] rsync is required" >&2; exit 1; }
  git fetch origin "$REMOTE_REF"
  TMP_RELEASE="$(mktemp -d)"
  trap 'rm -rf "$TMP_RELEASE"' EXIT
  git archive "origin/${REMOTE_REF}" | tar -x -C "$TMP_RELEASE"
  TARGET_SHA="$(git rev-parse "origin/${REMOTE_REF}")"
  node "$TMP_RELEASE/scripts/release-gate.mjs" --repo "$APP_ROOT" --refs --remote --sha "$TARGET_SHA"
  rsync --dry-run -a --itemize-changes --exclude data/ --exclude corpus/records.jsonl --exclude corpus/exams.jsonl \
    --exclude corpus/external/current/ --exclude corpus/external/releases/ \
    --exclude scripts/pull_external.sh "$TMP_RELEASE/" "$APP_ROOT/"
  echo "[deploy] dry-run passed; runtime data and external delivery files are excluded"
  exit 0
fi
echo "[deploy] fetching ${REMOTE_REF} and checking release gate"
git fetch origin "$REMOTE_REF"
TARGET_SHA="$(git rev-parse "origin/${REMOTE_REF}")"
TMP_RELEASE="$(mktemp -d)"
trap 'rm -rf "$TMP_RELEASE"' EXIT
git archive "origin/${REMOTE_REF}" | tar -x -C "$TMP_RELEASE"
node "$TMP_RELEASE/scripts/release-gate.mjs" --repo "$APP_ROOT" --refs --remote --sha "$TARGET_SHA"
mkdir -p "$BACKUP_DIR" "$RELEASE_DIR"
echo "[deploy] backing up data"
BACKUP_TMP="${APP_ROOT}/.data_backup_v341_${STAMP}.tar.gz"
tar -czf "$BACKUP_TMP" --exclude=data/backups -C "$APP_ROOT" data
BACKUP_FILE="${BACKUP_DIR}/data_backup_v341_${STAMP}.tar.gz"
mv "$BACKUP_TMP" "$BACKUP_FILE"
node "$TMP_RELEASE/scripts/backup-restore-drill.mjs" --source "$APP_ROOT/data" --archive "$BACKUP_FILE" --json >/tmp/workbench-backup-restore-${STAMP}.json
echo "[deploy] saving current code release"
git archive HEAD | tar -x -C "$RELEASE_DIR"
echo "[deploy] applying product files while preserving runtime data"
command -v rsync >/dev/null 2>&1 || { echo "[deploy] rsync is required to preserve runtime data" >&2; exit 1; }
rsync -a --exclude data/ --exclude corpus/records.jsonl --exclude corpus/exams.jsonl \
  --exclude corpus/external/current/ --exclude corpus/external/releases/ \
  --exclude scripts/pull_external.sh "$TMP_RELEASE/" "$APP_ROOT/"
git reset --mixed "origin/${REMOTE_REF}" >/dev/null
node scripts/release-gate.mjs --local
echo "[deploy] restarting ${SERVICE_NAME}"
systemctl restart "$SERVICE_NAME"
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    node scripts/online-health.mjs --url "$HEALTH_BASE_URL" --expected-version "$(node -p "require('./package.json').version")"
    echo "[deploy] healthy: $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo "[deploy] health check failed; run scripts/rollback.sh ${STAMP}"
exit 1
