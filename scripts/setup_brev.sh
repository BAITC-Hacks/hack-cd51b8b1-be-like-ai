#!/usr/bin/env bash
# Standalone bootstrap for the Ubuntu GPU VM. No meeting data is uploaded.
set -Eeuo pipefail
trap 'printf "Setup failed at line %s. See the error above.\n" "$LINENO" >&2' ERR

if [[ "$(uname -s)" != Linux ]]; then
  printf 'Run this script in the Linux terminal on your Brev GPU server.\n' >&2
  exit 1
fi

task_root="${HACKALEM_ROOT:-$HOME/workspace/hackalem-ai}"
mkdir -p "$task_root"
cd "$task_root"

nvidia-smi
python3 --version
sudo apt-get update
sudo apt-get install -y python3-venv ffmpeg libsndfile1 fonts-dejavu-core git tmux

if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install torch==2.8.0 torchaudio==2.8.0 \
  --index-url https://download.pytorch.org/whl/cu128
python -m pip install \
  'numpy>=2,<3' \
  torch==2.8.0 torchaudio==2.8.0 torchcodec==0.7.0 \
  faster-whisper==1.2.1 ctranslate2==4.6.0 \
  pyannote.audio==4.0.1 transformers==4.57.1 \
  'huggingface-hub>=0.34,<1' 'accelerate>=1,<2'
python -m pip check

# Source this file in each new terminal before launching inference.
cat > activate_hackalem.sh <<'ACTIVATE'
task_env_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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
ACTIVATE
source ./activate_hackalem.sh

python - <<'PY'
import ctypes
import importlib.metadata
import torch

print('PyTorch:', torch.__version__)
print('CUDA available:', torch.cuda.is_available())
if not torch.cuda.is_available():
    raise SystemExit('CUDA is unavailable to PyTorch; do not continue to model setup.')
print('GPU:', torch.cuda.get_device_name(0))
x = torch.ones((64, 64), device='cuda')
assert (x @ x)[0, 0].item() == 64.0
torch.cuda.synchronize()
ctypes.CDLL('libcublas.so.12')
ctypes.CDLL('libcudnn.so.9')

from faster_whisper import WhisperModel
from pyannote.audio import Pipeline
from torchcodec.decoders import AudioDecoder
from transformers import AutoModelForCausalLM, AutoTokenizer

for name in ('torchaudio', 'torchcodec', 'faster-whisper', 'pyannote.audio', 'transformers'):
    print(f'{name}: {importlib.metadata.version(name)}')
print('GPU computation and inference-library imports: OK')
print('Model weights have not been downloaded or tested yet.')
PY

python -m pip freeze > runtime-lock.txt
printf '\nSetup completed. In each new terminal run:\nsource "%s/activate_hackalem.sh"\n' "$task_root"
