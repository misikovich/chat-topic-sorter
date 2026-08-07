llama serve \
  -hf unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL \
  --alias qwen3.5-9b \
  --host 127.0.0.1 \
  --port 8080 \
  -c 8192 \
  -np 2