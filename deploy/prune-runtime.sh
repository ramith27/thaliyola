#!/usr/bin/env bash
# Removes onnxruntime binaries a CPU-only server never loads: GPU providers
# (CUDA/TensorRT, ~300 MB) and other operating systems and architectures.
# Usage: deploy/prune-runtime.sh <node_modules dir>
set -euo pipefail
dir="$1"
case "$(uname -m)" in x86_64) keep=x64 ;; aarch64 | arm64) keep=arm64 ;; *) keep="" ;; esac
find "$dir" -type d -path '*onnxruntime-node/bin/napi-v*' -prune -print | while read -r bin; do
  rm -rf "$bin/darwin" "$bin/win32"
  if [ -n "$keep" ]; then
    find "$bin/linux" -mindepth 1 -maxdepth 1 -type d ! -name "$keep" -exec rm -rf {} +
  fi
  find "$bin" -name 'libonnxruntime_providers_cuda*' -o -name 'libonnxruntime_providers_tensorrt*' | xargs -r rm -f
done
