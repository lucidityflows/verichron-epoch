"""How a value PostgreSQL can't hold is stored: exactly, encoded and marked,
never dropped or altered (EPOCH-502, docs/evidence-model.md).

`jsonb` rejects NUL (U+0000), and JSON has no binary and no infinity, so such
a value is kept as `{"$encoded": "<encoding>", "value": "<text>"}`:

- `hex`: binary; decode `value` to bytes;
- `utf8-hex`: text holding NUL; decode the bytes as UTF-8;
- `float`: an infinite number, `Infinity` or `-Infinity`.

Every stage that stores raw values uses these two functions, so the
convention has one implementation and one test (test_stored_value.py).
"""

from __future__ import annotations

import math
from typing import Any

#: The marker of an encoded value.
ENCODED = "$encoded"


def stored_value(value: Any) -> Any:
    """`value` as it can be stored: encoded and marked when PostgreSQL can't
    hold it as it is, otherwise unchanged."""
    if isinstance(value, bytes):
        return {ENCODED: "hex", "value": value.hex()}
    if isinstance(value, str) and "\x00" in value:
        return {ENCODED: "utf8-hex", "value": value.encode("utf-8").hex()}
    if isinstance(value, float) and math.isinf(value):
        # JSON has no infinity, and jsonb refuses the `Infinity` token
        # json.dumps writes (EPOCH-418).
        return {ENCODED: "float", "value": "Infinity" if value > 0 else "-Infinity"}
    return value


def is_encoded(value: Any) -> bool:
    """Whether a stored value is an encoded one."""
    return isinstance(value, dict) and set(value) == {ENCODED, "value"}


def decode_value(value: Any) -> Any:
    """The original value of a stored one: bytes for `hex`, text for
    `utf8-hex`, a float for `float`, anything unmarked as it is."""
    if is_encoded(value):
        if value[ENCODED] == "hex":
            return bytes.fromhex(value["value"])
        if value[ENCODED] == "utf8-hex":
            return bytes.fromhex(value["value"]).decode("utf-8")
        if value[ENCODED] == "float":
            return float(value["value"])
    return value
