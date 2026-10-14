#!/usr/bin/env bash
# v3.5.3：服务端神经语音（Piper）运行时安装脚本。
#
# 在 ECS 上执行一次即可：安装 Python 虚拟环境 + piper-tts，并从国内可达镜像
# 下载中英/美英两套 medium 语音模型。产物全部落在 $PIPER_HOME（默认 runtime/piper），
# 该目录是部署产物，不进 git、不参与 data 备份（避免 venv 符号链接污染备份校验）。
#
# 用法： bash tools/tts/setup_piper.sh
set -Eeuo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIPER_HOME="${PIPER_HOME:-$APP_ROOT/runtime/piper}"
VENV="$PIPER_HOME/venv"
VOICES="$PIPER_HOME/voices"
MIRROR_BASE="${PIPER_VOICE_MIRROR:-https://hf-mirror.com/rhasspy/piper-voices/resolve/main}"

PY="${PYTHON:-python3}"

echo "[piper] app root  : $APP_ROOT"
echo "[piper] piper home: $PIPER_HOME"

mkdir -p "$PIPER_HOME" "$VOICES"

if [ ! -x "$VENV/bin/python" ]; then
  echo "[piper] creating venv"
  "$PY" -m venv "$VENV"
fi

echo "[piper] installing piper-tts (pip)"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet piper-tts

download_voice() {
  local key="$1" url_path="$2" name="$3"
  local onnx="$VOICES/$name.onnx" conf="$VOICES/$name.onnx.json"
  for pair in "$onnx:$MIRROR_BASE/$url_path/$name.onnx" "$conf:$MIRROR_BASE/$url_path/$name.onnx.json"; do
    local dst="${pair%%:*}" src="${pair#*:}"
    if [ -s "$dst" ]; then
      echo "[piper] voice $key present: $(basename "$dst")"
      continue
    fi
    echo "[piper] downloading $(basename "$dst")"
    curl -fsSL --retry 3 --connect-timeout 20 -o "$dst.part" "$src"
    mv "$dst.part" "$dst"
  done
}

# 美音（默认）与英音（可切换）
download_voice en_US "en/en_US/lessac/medium" "en_US-lessac-medium"
download_voice en_GB "en/en_GB/alba/medium"   "en_GB-alba-medium"

echo "[piper] verifying synthesis"
cat > "$PIPER_HOME/_selfcheck.json" <<JSON
{"id":"selfcheck","text":"Welcome to your English study workbench.","voice":"en_US","out":"$PIPER_HOME/_selfcheck.wav"}
JSON
"$VENV/bin/python" "$APP_ROOT/tools/tts/piper_worker.py" \
  --en_US "$VOICES/en_US-lessac-medium.onnx" \
  --en_GB "$VOICES/en_GB-alba-medium.onnx" \
  < "$PIPER_HOME/_selfcheck.json"
ls -la "$PIPER_HOME/_selfcheck.wav"
rm -f "$PIPER_HOME/_selfcheck.json" "$PIPER_HOME/_selfcheck.wav"

echo "[piper] done. voice dir: $VOICES"
echo "[piper] python: $VENV/bin/python"
