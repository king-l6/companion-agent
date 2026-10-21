#!/usr/bin/env bash
# 下载本地音色服务所需的全部模型（约 300MB）
# - pyannote segmentation + CAM++：说话人分离
# - SenseVoice int8：参考音频自动转写
# - ZipVoice distill int8 + vocos：零样本音色克隆
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models

fetch() {
  local out="$1" url="$2"
  if [ ! -s "models/$out" ]; then
    echo "downloading $out ..."
    curl -L --fail --retry 3 --progress-bar -o "models/$out" "$url"
  fi
}

# 1. 说话人分离
if [ ! -f models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx ]; then
  fetch segmentation.tar.bz2 \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  tar -xjf models/segmentation.tar.bz2 -C models
  rm -f models/segmentation.tar.bz2
fi

fetch campplus.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx

# 2. ZipVoice 音色克隆
if [ ! -d models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia ]; then
  fetch zipvoice.tar.bz2 \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2
  tar -xjf models/zipvoice.tar.bz2 -C models
  rm -f models/zipvoice.tar.bz2
fi

fetch vocos_24khz.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx

# 3. SenseVoice 语音识别（生成参考文本）
if [ ! -d models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17 ]; then
  fetch sensevoice.tar.bz2 \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
  tar -xjf models/sensevoice.tar.bz2 -C models
  rm -f models/sensevoice.tar.bz2
fi

echo "models ready:"
du -sh models
