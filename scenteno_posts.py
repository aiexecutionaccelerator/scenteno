#!/usr/bin/env python3
"""Comment + pin on the 10 newest @Scenteno Community posts.  Flags: --dry-run, --force"""
from ytcommenter import run

run("posts", "https://www.youtube.com/@Scenteno/posts", "/post/",
    promo_keywords=("% off", "sale", "OFF"), scrolls=20)
