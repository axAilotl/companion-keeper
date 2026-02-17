#!/usr/bin/env python3
"""Companion Preservation Toolkit — Gradio UI launcher.

Usage:
    python app.py [--host HOST] [--port PORT] [--share]

Or via the unified CLI:
    python -m toolkit.cli ui [--host HOST] [--port PORT] [--share]
"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Launch the Companion Preservation Toolkit UI.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=7860, help="Port (default: 7860)")
    parser.add_argument("--share", action="store_true", help="Create a public Gradio link")
    args = parser.parse_args(argv)

    from toolkit.ui import build_ui

    app = build_ui()
    app.launch(server_name=args.host, server_port=args.port, share=args.share)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
