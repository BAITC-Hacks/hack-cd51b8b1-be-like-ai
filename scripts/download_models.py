"""Run explicitly during setup with network access, before starting the offline API."""
import argparse
import json
import os
from pathlib import Path
import sys

os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['PYANNOTE_METRICS_ENABLED'] = '0'
os.environ.pop('HF_HUB_OFFLINE', None)

MODELS = {'asr': 'Systran/faster-whisper-large-v3',
          'diarization': 'pyannote/speaker-diarization-community-1',
          'llm': 'Qwen/Qwen3-8B'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parents[1] / 'models')
    parser.add_argument('--only', choices=list(MODELS))
    args = parser.parse_args()
    from huggingface_hub import HfApi, snapshot_download
    selected = {args.only: MODELS[args.only]} if args.only else MODELS
    for name, repo in selected.items():
        print(f'Downloading {name}: {repo}', flush=True)
        try:
            info = HfApi().model_info(repo)
            snapshot_download(repo_id=repo, revision=info.sha, local_dir=args.directory / name)
            (args.directory / name / 'hackalem-model.json').write_text(
                json.dumps({'repo': repo, 'revision': info.sha}, indent=2), encoding='utf-8')
        except Exception as exc:
            print(f'Download failed ({type(exc).__name__}). Check network, disk space and Hugging Face model access.', file=sys.stderr)
            return 1
        print(f'{name}: downloaded at revision {info.sha}', flush=True)
    print('Weights downloaded. Next: python scripts/check_models.py')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
