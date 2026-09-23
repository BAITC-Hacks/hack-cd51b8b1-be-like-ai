from dataclasses import dataclass, field
from pathlib import Path
import os


ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv('HACKALEM_DATA_DIR', ROOT / 'data')))
    model_dir: Path = field(default_factory=lambda: Path(os.getenv('HACKALEM_MODEL_DIR', ROOT / 'models')))
    frontend_dir: Path = field(default_factory=lambda: ROOT / 'frontend' / 'dist')
    access_token: str = field(default_factory=lambda: os.getenv('HACKALEM_ACCESS_TOKEN', ''))
    secure_cookie: bool = field(default_factory=lambda: os.getenv('HACKALEM_SECURE_COOKIE', '0') == '1')
    max_upload_bytes: int = 100 * 1024 * 1024
    max_duration_seconds: int = 3600
    llm_max_input_tokens: int = 20000
    llm_max_output_tokens: int = 6000
    device: str = field(default_factory=lambda: os.getenv('HACKALEM_DEVICE', 'cuda'))
    cors_origins: list[str] = field(default_factory=lambda: [
        x.strip() for x in os.getenv('HACKALEM_CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(',') if x.strip()
    ])

    def prepare(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / 'uploads').mkdir(exist_ok=True)

