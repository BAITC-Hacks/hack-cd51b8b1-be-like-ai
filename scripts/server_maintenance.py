"""Pause/resume the existing single-worker API for GPU tests without printing its access code."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time


def matching_pids(root):
    matches = []
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            argv = (proc / 'cmdline').read_bytes().split(b'\0')
            if b'uvicorn' in argv and b'backend.app:create_app' in argv and (proc / 'cwd').resolve() == root:
                matches.append(int(proc.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return matches


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['pause', 'resume'])
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    directory = root / 'data' / 'maintenance'
    directory.mkdir(parents=True, exist_ok=True)
    private = directory / 'runtime.json'
    matches = matching_pids(root)
    if args.action == 'pause':
        if len(matches) != 1:
            raise SystemExit(f'Expected exactly one matching API process; found {len(matches)}')
        pid = matches[0]
        environ = dict(entry.split(b'=', 1) for entry in (Path('/proc') / str(pid) / 'environ').read_bytes().split(b'\0') if b'=' in entry)
        allowed = {key.decode(): value.decode() for key, value in environ.items()
                   if key.startswith(b'HACKALEM_') or key in (b'PATH', b'LD_LIBRARY_PATH')}
        if not allowed.get('HACKALEM_ACCESS_TOKEN'):
            raise SystemExit('Access code unavailable; refusing to stop a service that cannot be restored securely')
        fd = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(allowed, output)
        os.chmod(private, 0o600)
        os.kill(pid, signal.SIGTERM)
        for _ in range(30):
            if not matching_pids(root):
                print('API PAUSED; private runtime settings saved with mode 0600', flush=True)
                return
            time.sleep(1)
        raise SystemExit('API has not exited; inspect before continuing')
    if matches:
        raise SystemExit('API is already running')
    environment = {**os.environ, **json.loads(private.read_text())}
    with (directory / 'server.log').open('ab') as output:
        process = subprocess.Popen(['bash', 'scripts/run_backend.sh'], cwd=root, env=environment,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(30):
        if process.poll() is not None:
            raise SystemExit('API exited during startup; see data/maintenance/server.log')
        with socket.socket() as connection:
            connection.settimeout(.5)
            if connection.connect_ex(('127.0.0.1', 8000)) == 0:
                print(f'API RESUMED pid={process.pid}', flush=True)
                return
        time.sleep(1)
    raise SystemExit('API did not become reachable; inspect data/maintenance/server.log')


if __name__ == '__main__':
    main()
