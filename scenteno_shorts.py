#!/usr/bin/env python3
"""Comment + pin on the 10 newest @Scenteno Shorts.  Flags: --dry-run, --force"""
from ytcommenter import run

run("shorts", "https://www.youtube.com/@Scenteno/shorts", "/shorts/")
