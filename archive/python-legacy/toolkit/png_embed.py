"""Embed/extract CCv3 character card data in PNG tEXt chunks (SillyTavern spec).

The SillyTavern convention stores a base64-encoded JSON blob in a PNG tEXt
chunk with the keyword ``chara``. This module provides two functions:

- ``embed_card_in_png`` — merge lorebook into card, encode, and write tEXt chunk
- ``extract_card_from_png`` — read tEXt chunk and decode
"""

from __future__ import annotations

import base64
import io
import json
from typing import Any, Dict, Optional

from PIL import Image
from PIL.PngImagePlugin import PngInfo


def embed_card_in_png(
    image_bytes: bytes,
    card_data: Dict[str, Any],
    lorebook_data: Optional[Dict[str, Any]] = None,
) -> bytes:
    """Embed a character card (with optional lorebook) into a PNG image.

    Returns the PNG file bytes with the ``chara`` tEXt chunk added.
    """
    card = json.loads(json.dumps(card_data))  # deep copy

    if lorebook_data and isinstance(lorebook_data, dict):
        book = lorebook_data.get("data")
        if isinstance(book, dict):
            if "data" in card and isinstance(card["data"], dict):
                card["data"]["character_book"] = book

    json_str = json.dumps(card, ensure_ascii=False)
    b64 = base64.b64encode(json_str.encode("utf-8")).decode("ascii")

    img = Image.open(io.BytesIO(image_bytes))
    img = img.convert("RGBA")

    meta = PngInfo()
    meta.add_text("chara", b64)

    out = io.BytesIO()
    img.save(out, format="PNG", pnginfo=meta)
    return out.getvalue()


def extract_card_from_png(png_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Extract a character card from a PNG image's ``chara`` tEXt chunk."""
    img = Image.open(io.BytesIO(png_bytes))
    info = img.info or {}
    b64 = info.get("chara")
    if not b64:
        return None
    try:
        raw = base64.b64decode(b64)
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None
