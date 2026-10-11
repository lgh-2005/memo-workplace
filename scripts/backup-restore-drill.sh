#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
exec node scripts/backup-restore-drill.mjs "$@"
