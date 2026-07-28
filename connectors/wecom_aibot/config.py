"""Configuration for the WeCom AiBot to ArcForge channel bridge.

Secrets are read from the environment first. When the connector runs beside
the desktop app it can fall back to the desktop SQLite settings database, but
the database values are never logged or exposed through the WebView.
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse, urlunparse


def _env(name: str, fallback: str = "") -> str:
    value = os.getenv(name)
    return value.strip() if value is not None and value.strip() else fallback


def _env_bool(name: str, fallback: bool = False) -> bool:
    value = _env(name).lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return fallback


def _desktop_db_path() -> Path | None:
    explicit = _env("ARCFORGE_CONFIG_DB")
    if explicit:
        return Path(explicit).expanduser()
    home = _env("ARCFORGE_HOME") or _env("LIVEAGENT_HOME")
    if not home:
        home = str(Path.home() / ".arcforge")
    return Path(home).expanduser() / "config.sqlite"


def _read_desktop_settings(path: Path | None) -> dict[str, object]:
    if path is None or not path.is_file():
        return {}
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1.0)
        try:
            row = db.execute(
                "SELECT enabled, bot_id, tenant_id, connector_id, "
                "allow_group_messages, aibot_secret, channel_token "
                "FROM wecom_settings WHERE config_id = 'default'"
            ).fetchone()
            if row is None:
                return {}
            remote_row = db.execute(
                "SELECT payload_json FROM remote_settings WHERE config_id = 'default'"
            ).fetchone()
        finally:
            db.close()
    except (OSError, sqlite3.Error):
        return {}

    remote: dict[str, object] = {}
    if remote_row and isinstance(remote_row[0], str):
        try:
            parsed = json.loads(remote_row[0])
            if isinstance(parsed, dict):
                remote = parsed
        except json.JSONDecodeError:
            pass
    return {
        "enabled": bool(row[0]),
        "bot_id": str(row[1] or "").strip(),
        "tenant_id": str(row[2] or "").strip(),
        "connector_id": str(row[3] or "").strip(),
        "allow_group_messages": bool(row[4]),
        "secret": str(row[5] or "").strip(),
        "channel_token": str(row[6] or "").strip(),
        "gateway_url": str(
            remote.get("gatewayUrl") or remote.get("gateway_url") or ""
        ).strip(),
    }


def _channel_url(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("ArcForge Gateway URL is required")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.netloc:
        raise ValueError("ArcForge Gateway URL must be an http(s) or ws(s) URL")
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme, parsed.scheme)
    path = parsed.path.rstrip("/")
    if not path.endswith("/ws/v2/channel"):
        path += "/ws/v2/channel"
    return urlunparse((scheme, parsed.netloc, path, "", parsed.query, ""))


@dataclass(frozen=True)
class ConnectorConfig:
    bot_id: str
    secret: str
    gateway_url: str
    channel_token: str
    tenant_id: str
    connector_id: str
    allow_group_messages: bool = False
    max_text_bytes: int = 128 * 1024
    dedupe_ttl_seconds: int = 24 * 60 * 60
    delta_interval_seconds: float = 0.12


def load_config() -> ConnectorConfig:
    desktop = _read_desktop_settings(_desktop_db_path())
    explicit_environment_credentials = any(
        _env(name)
        for name in (
            "WECOM_AIBOT_BOT_ID",
            "WECOM_AIBOT_SECRET",
            "ARCFORGE_GATEWAY_CHANNEL_TOKEN",
        )
    )
    if desktop.get("enabled") is False and not explicit_environment_credentials:
        raise ValueError("WeCom connector is disabled in desktop settings")
    bot_id = _env("WECOM_AIBOT_BOT_ID", str(desktop.get("bot_id", "")))
    secret = _env("WECOM_AIBOT_SECRET", str(desktop.get("secret", "")))
    gateway_url = _env(
        "ARCFORGE_GATEWAY_CHANNEL_URL",
        _env("ARCFORGE_GATEWAY_URL", str(desktop.get("gateway_url", ""))),
    )
    channel_token = _env(
        "ARCFORGE_GATEWAY_CHANNEL_TOKEN", str(desktop.get("channel_token", ""))
    )
    tenant_id = _env(
        "ARCFORGE_GATEWAY_CHANNEL_TENANT_ID", str(desktop.get("tenant_id", ""))
    ) or bot_id
    connector_id = _env(
        "ARCFORGE_GATEWAY_CHANNEL_CONNECTOR_ID",
        str(desktop.get("connector_id", "wecom-desktop")),
    ) or "wecom-desktop"
    allow_groups = _env_bool(
        "ARCFORGE_GATEWAY_CHANNEL_ALLOW_GROUP_MESSAGES",
        bool(desktop.get("allow_group_messages", False)),
    )
    if not bot_id or not secret:
        raise ValueError("WECOM_AIBOT_BOT_ID and WECOM_AIBOT_SECRET are required")
    if not channel_token:
        raise ValueError("ARCFORGE_GATEWAY_CHANNEL_TOKEN is required")
    return ConnectorConfig(
        bot_id=bot_id,
        secret=secret,
        gateway_url=_channel_url(gateway_url),
        channel_token=channel_token,
        tenant_id=tenant_id,
        connector_id=connector_id,
        allow_group_messages=allow_groups,
        max_text_bytes=max(1, int(_env("ARCFORGE_GATEWAY_CHANNEL_MAX_TEXT_BYTES", "131072"))),
        dedupe_ttl_seconds=max(60, int(_env("ARCFORGE_GATEWAY_CHANNEL_DEDUPE_TTL_SECONDS", "86400"))),
        delta_interval_seconds=max(0.02, float(_env("ARCFORGE_GATEWAY_CHANNEL_DELTA_INTERVAL_SECONDS", "0.12"))),
    )
