#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${WORKBENCH_ROOT:-/opt/workbench}"
SERVICE_NAME="${WORKBENCH_SERVICE:-workbench.service}"
TARGET="${1:-}"
HEALTH_URL="${WORKBENCH_HEALTH_URL:-http://127.0.0.1:5178/api/auth/status}"
if [[ -z "$TARGET" ]]; then echo "usage: $0 <release-stamp>" >&2; exit 2; fi
RELEASE_DIR="${APP_ROOT}/.releases/${TARGET}"
[[ -d "$RELEASE_DIR" ]] || { echo "release not found: $RELEASE_DIR" >&2; exit 2; }
cd "$APP_ROOT"
TMP_RELEASE="$(mktemp -d)"
trap 'rm -rf "$TMP_RELEASE"' EXIT
cp -a "$RELEASE_DIR/." "$TMP_RELEASE/"
command -v rsync >/dev/null 2>&1 || { echo "[rollback] rsync is required to preserve runtime data" >&2; exit 1; }
rsync -a --exclude data/ --exclude corpus/records.jsonl --exclude corpus/exams.jsonl \
  --exclude corpus/external/current/ --exclude corpus/external/releases/ \
  --exclude scripts/pull_external.sh "$TMP_RELEASE/" "$APP_ROOT/"
systemctl restart "$SERVICE_NAME"
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null; then echo "[rollback] healthy: $TARGET"; exit 0; fi
  sleep 1
done
echo "[rollback] health check failed" >&2
exit 1
