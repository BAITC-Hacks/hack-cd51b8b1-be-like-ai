# Source in the current Bash terminal: source scripts/activate_env.sh
task_env_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$task_env_root/.venv/bin/activate"
export HF_HUB_DISABLE_TELEMETRY=1
export PYANNOTE_METRICS_ENABLED=0
task_cuda_paths="$(python - <<'PY'
from pathlib import Path
import sysconfig
root = Path(sysconfig.get_path('purelib')) / 'nvidia'
print(':'.join(str(p) for p in sorted(root.glob('*/lib')) if p.is_dir()))
PY
)"
export LD_LIBRARY_PATH="$task_cuda_paths${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
unset task_env_root task_cuda_paths
