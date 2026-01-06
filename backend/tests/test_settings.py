from pathlib import Path

from app.settings import get_env, is_envfile_key, load_env


def test_load_env_overrides_existing_env(tmp_path, monkeypatch):
    env_path = tmp_path / ".env"
    env_path.write_text("GEMINI_API_KEY=fromfile\n")
    monkeypatch.setenv("GEMINI_API_KEY", "fromenv")

    load_env(env_path)

    assert get_env("GEMINI_API_KEY") == "fromfile"
    assert is_envfile_key("GEMINI_API_KEY")


def test_load_env_sets_marker_for_new_key(tmp_path, monkeypatch):
    env_path = tmp_path / ".env"
    env_path.write_text("OPENROUTER_API_KEY=router\n")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    load_env(env_path)

    assert get_env("OPENROUTER_API_KEY") == "router"
    assert is_envfile_key("OPENROUTER_API_KEY")
