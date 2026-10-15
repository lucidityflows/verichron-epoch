#!/usr/bin/env python3
"""Entrypoint of the indicator_match stage (EPOCH-491); the stage is match_stage.py."""

import sys

from match_stage import main

if __name__ == "__main__":
    sys.exit(main())
