#!/usr/bin/env bash
# 启动本地音色服务（默认 http://127.0.0.1:8100）
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "缺少 .venv，请先执行：" >&2
  echo "  uv venv --python 3.11 .venv" >&2
  echo "  uv pip install --python .venv/bin/python -r requirements.txt" >&2
  exit 1
fi

# Hugging Face 直连不通时走镜像；Xet 存储需要额外鉴权，关掉
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"

exec .venv/bin/python -m uvicorn app:app \
  --host "${VOICE_HOST:-127.0.0.1}" \
  --port "${VOICE_PORT:-8100}"
