from pathlib import Path
from typing import Optional
import os

_ENVFILE_PREFIX = "__ENVFILE__"


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
        if key:
            os.environ[key] = value
            os.environ[f"{_ENVFILE_PREFIX}{key}"] = "1"


def get_env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key, default)


def is_envfile_key(key: str) -> bool:
    return os.environ.get(f"{_ENVFILE_PREFIX}{key}") == "1"
