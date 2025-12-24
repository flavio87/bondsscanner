from pathlib import Path
from typing import Optional
import os


def load_env(path: Optional[Path] = None) -> None:
    if path is None:
        path = Path(__file__).resolve().parents[2] / ".env"
    if not path.exists():
        return
    try:
        content = path.read_text().splitlines()
    except OSError:
        return
    for line in content:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


def get_env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key, default)
