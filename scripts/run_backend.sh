#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
if [[ -f activate_hackalem.sh ]]; then
  source ./activate_hackalem.sh
else
  source .venv/bin/activate
fi
export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export PYANNOTE_METRICS_ENABLED=0
task_cuda_paths="$(python - <<'PY'
from pathlib import Path
import sysconfig
print(':'.join(str(p) for p in sorted((Path(sysconfig.get_path('purelib')) / 'nvidia').glob('*/lib'))))
PY
)"
export LD_LIBRARY_PATH="$task_cuda_paths${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [[ -z "${HACKALEM_ACCESS_TOKEN:-}" ]]; then
  printf 'Set HACKALEM_ACCESS_TOKEN to a private access code before starting the shared server.\n' >&2
  exit 1
fi
exec python -m uvicorn backend.app:create_app --factory --host 0.0.0.0 --port 8000 --workers 1
