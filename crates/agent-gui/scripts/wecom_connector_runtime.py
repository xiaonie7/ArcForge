"""Frozen entry point for the ArcForge WeCom connector sidecar."""

from __future__ import annotations

import json
import sys


def _self_test() -> None:
    import aibot
    import google.protobuf
    import websockets

    from connectors.wecom_aibot.worker import main as connector_main

    print(
        json.dumps(
            {
                "frozen": bool(getattr(sys, "frozen", False)),
                "dependencies": {
                    "aibot": bool(aibot),
                    "protobuf": google.protobuf.__version__,
                    "websockets": websockets.__version__,
                },
                "entrypoint": callable(connector_main),
            },
            separators=(",", ":"),
        )
    )


def main() -> None:
    if sys.argv[1:] == ["--self-test"]:
        _self_test()
        return

    from connectors.wecom_aibot.worker import main as connector_main

    connector_main()


if __name__ == "__main__":
    main()
