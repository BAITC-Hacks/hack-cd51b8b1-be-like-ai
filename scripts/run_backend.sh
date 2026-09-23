#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
source scripts/activate_env.sh
export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export PYANNOTE_METRICS_ENABLED=0
if [[ -z "${HACKALEM_ACCESS_TOKEN:-}" ]]; then
  printf 'Set HACKALEM_ACCESS_TOKEN to a private access code before starting the shared server.\n' >&2
  exit 1
fi
exec python -m uvicorn backend.app:create_app --factory --host 0.0.0.0 --port 8000 --workers 1
