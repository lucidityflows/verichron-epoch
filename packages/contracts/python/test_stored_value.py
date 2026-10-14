"""The stored-value convention round-trips every value it encodes, and leaves
everything else as it is (EPOCH-502)."""

import json
import math

from stored_value import ENCODED, decode_value, is_encoded, stored_value


def test_each_value_postgresql_cant_hold_is_encoded_and_decodes_back_exactly():
    for value, encoding in [
        (b"\x00\xc8binary", "hex"),
        ("nul\x00inside", "utf8-hex"),
        (math.inf, "float"),
        (-math.inf, "float"),
    ]:
        stored = stored_value(value)
        assert stored[ENCODED] == encoding
        assert is_encoded(stored)
        # It survives JSON, which is how it reaches jsonb.
        assert decode_value(json.loads(json.dumps(stored))) == value


def test_any_other_value_is_stored_as_it_is():
    for value in ["text", "", 0, 1.5, None, True, ["a"], {"k": "v"}]:
        assert stored_value(value) == value
        assert not is_encoded(stored_value(value))
        assert decode_value(value) == value
