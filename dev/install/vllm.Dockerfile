# vLLM Local LLM Service for dsh-chapters testing
#
# Serves Qwen3-4B-AWQ under two model names on a single port:
#   - qwen3-4b-instruct    (general inference / agent conversations)
#   - qwen3-4b-systemone   (decision model endpoint)
#
# Both names resolve to the same underlying model weights. The distinction
# is semantic — the harness can route different request types to different
# model IDs while sharing GPU memory.
#
# Build:  docker build -f dev/install/vllm.Dockerfile -t dsh-vllm .
# Run:    docker run --gpus all -p 8080:8080 dsh-vllm

FROM vllm/vllm-openai:latest

# Model configuration
ENV MODEL_ID=Qwen/Qwen3-4B-AWQ
ENV SERVED_NAMES="qwen3-4b-instruct,qwen3-4b-systemone"
ENV MAX_MODEL_LEN=32768
ENV GPU_MEMORY_UTILIZATION=0.90
ENV TENSOR_PARALLEL_SIZE=1

# Pre-download the model at build time so startup is instant
RUN python3 -c "from huggingface_hub import snapshot_download; snapshot_download('${MODEL_ID}')" || true

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=20 --start-period=120s \
  CMD curl -fsS http://localhost:8080/health 2>/dev/null || exit 1

ENTRYPOINT ["python3", "-m", "vllm.entrypoints.openai.api_server"]
CMD [ \
  "--model", "${MODEL_ID}", \
  "--served-model-name", "${SERVED_NAMES}", \
  "--max-model-len", "${MAX_MODEL_LEN}", \
  "--gpu-memory-utilization", "${GPU_MEMORY_UTILIZATION}", \
  "--tensor-parallel-size", "${TENSOR_PARALLEL_SIZE}", \
  "--host", "0.0.0.0", \
  "--port", "8080", \
  "--trust-remote-code", \
  "--enable-auto-tool-choice" \
]
