"""`pillow_heif`, provided by pi-heif (EPOCH-439, licensing audit B1).

iLEAPP's HEIC plugins (geodMapTiles, springboard, photosDbexif) import
`register_heif_opener` from `pillow_heif` and only decode. pi-heif is the same
project's decode-only build, without the GPLv2 x265 encoder, so it is used under
the old name. Every public name pi_heif has is available here.
"""

import pi_heif as _pi_heif

globals().update({name: getattr(_pi_heif, name) for name in dir(_pi_heif) if not name.startswith("_")})
__all__ = sorted(name for name in dir(_pi_heif) if not name.startswith("_"))
