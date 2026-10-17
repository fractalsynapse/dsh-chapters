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

# No ENTRYPOINT: the base image's `ENTRYPOINT ["vllm","serve"]` would swallow a
# CMD and its argv, so we override it with our own launcher.
# Shell-form CMD only: Docker runs it through /bin/sh so ${VAR} expands from the
# container environment (compose sets it per service). Exec-form JSON arrays are
# NOT interpolated — the old form handed vLLM the literal string "${MAX_MODEL_LEN}"
# and argparse killed every boot (#19).
ENTRYPOINT []
# SERVED_NAMES is a comma-separated list and --served-model-name is VARIADIC:
# passing "a,b" as one argv element registers a single alias literally named
# "a,b", so requests for either bare name 404 (measured on vLLM 0.31).
# Word-split it into repeated flags — shell-form CMD gives us /bin/sh.
# (POSIX sh has no ${VAR/IFS/x} substitution; set IFS around the loop.)
CMD OLDIFS=$IFS; IFS=,; for n in $SERVED_NAMES; do set -- "$@" --served-model-name "$n"; done; IFS=$OLDIFS; \
  python3 -m vllm.entrypoints.openai.api_server \
  --model "$MODEL_ID" \
  "$@" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --tensor-parallel-size "$TENSOR_PARALLEL_SIZE" \
  --host 0.0.0.0 \
  --port 8080 \
  --trust-remote-code \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
