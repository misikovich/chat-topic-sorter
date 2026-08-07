#!/usr/bin/env bash

BATCHSIZE="${BATCHSIZE:-4}"

llama serve \
  -hf unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL \
  --no-mmproj \
  --alias qwen3.5-9b \
  --host 127.0.0.1 \
  --port 8080 \
  -c 4096 \
  -np "$BATCHSIZE"
