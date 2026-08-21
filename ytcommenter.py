#!/usr/bin/env python3
"""Shared engine for the Scenteno Shorts/Posts auto-commenter.

Connects to a local Chrome over CDP (see start-chrome.bat), opens its own tab,
and for each item: checks for an existing pinned comment, posts our comment if
needed, and pins it. Every step uses explicit waits (no fixed sleeps), dumps a
screenshot + HTML to failures/ on any error, and records results in state.json
so already-done items are not re-visited.
"""

import json, os, random, sys, time, urllib.request
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

COMMENT_BOS = (
    "https://scenteno.com/yt12  Join the Brotherhood of Scent "
    "to get fragrance advice from a supportive community — and "
    "share advice, opinions, and experience with fragrance brothers."
)
COMMENT_HOD = (
    "https://www.realmenrealstyle.com/best-frags  "
    "Ready to upgrade your fragrance game? Check out House of Dastan here."
)
OUR_KEYS = ("scenteno.com/yt12", "realmenrealstyle.com/best-frags")

CDP_URL = "http://127.0.0.1:9222"
HERE = Path(__file__).parent
STATE_FILE = HERE / "state.json"
FAIL_DIR = HERE / "failures"
STEP_TIMEOUT = 15_000  # ms for any single UI wait

DONE_STATUSES = {"commented+pinned", "pinned existing", "already pinned", "promo"}

# Windows consoles / Task Scheduler default to cp1252 and crash on emoji/em-dash
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")


def log(msg):
    print(msg, flush=True)


# ---------- state ----------

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------- helpers ----------

def get_comment(title):
    if "house of dastan" in title.lower():
        return COMMENT_HOD, "realmenrealstyle.com/best-frags"
    return COMMENT_BOS, "scenteno.com/yt12"


def wait_for_title(page, prev_title, timeout=10.0):
    """page.title() right after goto often still shows the previous page."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = page.title()
        if t and t != prev_title and t.strip() not in ("YouTube", "- YouTube"):
            return t
        time.sleep(0.25)
    return page.title()


def dump_failure(page, item_id, note):
    FAIL_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = FAIL_DIR / f"{item_id}-{stamp}"
    try:
        page.screenshot(path=str(base) + ".png", full_page=False)
        base.with_suffix(".html").write_text(page.content(), encoding="utf-8")
        base.with_suffix(".txt").write_text(note, encoding="utf-8")
        log(f"     evidence saved: {base}.png")
    except Exception as e:
        log(f"     (could not save evidence: {e})")


def human_pause(lo=4, hi=10):
    time.sleep(random.uniform(lo, hi))


# ---------- browser ----------

def ensure_signed_in(page):
    page.goto("https://www.youtube.com/", wait_until="domcontentloaded")
    try:
        page.locator("#avatar-btn").first.wait_for(state="visible", timeout=STEP_TIMEOUT)
        return True
    except PWTimeout:
        return False


def collect_urls(page, listing_url, path_part, limit, scrolls):
    page.goto(listing_url, wait_until="domcontentloaded")
    page.locator(f'a[href*="{path_part}"]').first.wait_for(state="attached", timeout=STEP_TIMEOUT)
    for _ in range(scrolls):
        page.evaluate("window.scrollTo(0, document.scrollingElement.scrollHeight)")
        time.sleep(0.4)
    return page.evaluate("""([part, limit]) => [...new Set(
        [...document.querySelectorAll('a[href*="' + part + '"]')]
          .map(a => { const u = new URL(a.href); u.search = ''; u.hash = ''; return u.toString(); })
          .filter(h => (h.split(part)[1] || '').length > 5)
    )].slice(0, limit)""", [path_part, limit])


def pinned_present(page):
    if page.locator("ytd-pinned-comment-badge-renderer").count() > 0:
        return True
    return page.locator("ytd-comment-thread-renderer", has_text="Pinned by").count() > 0


def find_our_thread(page):
    for key in OUR_KEYS:
        t = page.locator("ytd-comment-thread-renderer", has_text=key)
        if t.count() > 0:
            return t.first
    return None


def pin_thread(page, thread):
    thread.scroll_into_view_if_needed()
    thread.hover()
    thread.locator("#action-menu button").first.click(timeout=STEP_TIMEOUT)
    page.get_by_role("menuitem", name="Pin").first.click(timeout=STEP_TIMEOUT)
    # YouTube only asks for confirmation when another comment is already pinned;
    # a first pin applies immediately. Accept either outcome.
    # After pinning, YouTube re-renders the comment as a new element at the top, so
    # look for the badge anywhere (there was no pinned comment before we started).
    confirm = page.locator("yt-confirm-dialog-renderer #confirm-button")
    deadline = time.time() + STEP_TIMEOUT / 1000
    while time.time() < deadline:
        if pinned_present(page):
            return
        if confirm.count() > 0 and confirm.first.is_visible():
            confirm.first.click()
            deadline = time.time() + STEP_TIMEOUT / 1000
            continue
        time.sleep(0.25)
    raise PWTimeout("neither pinned badge nor confirm dialog appeared")


def post_comment(page, text, detect_key):
    box = page.locator("ytd-comment-simplebox-renderer #placeholder-area").first
    box.wait_for(state="visible", timeout=STEP_TIMEOUT)
    box.click()
    editable = page.locator("ytd-comment-simplebox-renderer #contenteditable-root").first
    editable.wait_for(state="visible", timeout=STEP_TIMEOUT)
    editable.click()
    editable.press_sequentially(text, delay=8)  # real key events so YT enables the button
    submit = page.locator("ytd-comment-simplebox-renderer #submit-button button").first
    submit.wait_for(state="visible", timeout=STEP_TIMEOUT)
    page.wait_for_function(
        "() => { const b = document.querySelector('ytd-comment-simplebox-renderer #submit-button button');"
        " return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; }",
        timeout=STEP_TIMEOUT)
    submit.click()
    thread = page.locator("ytd-comment-thread-renderer", has_text=detect_key).first
    thread.wait_for(state="visible", timeout=STEP_TIMEOUT)
    return thread


def open_comments(page, kind):
    """Make the comment section + comment box visible. Returns False if the comment
    box never appears (comments off, not signed in, or layout change)."""
    box = page.locator("ytd-comment-simplebox-renderer #placeholder-area").first
    if kind == "shorts":
        # YouTube remembers the panel state between Shorts: after the first one the
        # comments panel is usually already open, so only click if the box isn't there yet.
        time.sleep(1.5)
        if not box.is_visible():
            # 2026 layout: <button aria-label="View N comments"> (no id). Older: #comments-button.
            btn = page.locator('button[aria-label^="View"][aria-label*="comment" i]:visible, '
                               "#comments-button button:visible").first
            btn.wait_for(state="visible", timeout=STEP_TIMEOUT)
            btn.click()
    else:
        # ytd-comments is zero-height until scrolled near; plain scroll triggers the lazy load
        page.evaluate("window.scrollTo({top: 3000, behavior: 'instant'})")
    try:
        page.locator("ytd-comment-simplebox-renderer #placeholder-area").first.wait_for(
            state="visible", timeout=STEP_TIMEOUT)
    except PWTimeout:
        return False
    # existing threads render shortly after the box; give them a moment
    try:
        page.locator("ytd-comment-thread-renderer, ytd-message-renderer").first.wait_for(
            state="attached", timeout=5_000)
    except PWTimeout:
        pass  # zero comments — fine
    return True


def process_item(page, kind, url, item_id, prev_title, promo_keywords=(), dry_run=False):
    page.goto(url, wait_until="domcontentloaded")
    title = wait_for_title(page, prev_title)
    log(f"  → {item_id}: {title[:60]}")

    # Post pages are titled just "Post from Scenteno", so match on body text there.
    subject = title
    if kind == "posts":
        page.locator("ytd-backstage-post-renderer, ytd-post-renderer").first.wait_for(
            state="attached", timeout=STEP_TIMEOUT)
        subject = page.evaluate("document.body.innerText.substring(0, 800)")
        if any(k.lower() in subject.lower() for k in promo_keywords):
            return "promo", title
    comment_text, detect_key = get_comment(subject)

    if not open_comments(page, kind):
        dump_failure(page, item_id, "comment box never appeared")
        return "ERR comment box didn't load", title

    if pinned_present(page):
        return "already pinned", title

    if dry_run:
        return "DRY would comment+pin", title

    ours = find_our_thread(page)
    if ours is not None:
        log("     our comment exists — pinning")
        pin_thread(page, ours)
        return "pinned existing", title

    log("     posting comment")
    thread = post_comment(page, comment_text, detect_key)
    log("     pinning")
    pin_thread(page, thread)
    return "commented+pinned", title


# ---------- runner ----------

def notify(summary):
    """Optional: set ALERT_WEBHOOK (Slack/Discord incoming webhook URL) to get failure alerts."""
    url = os.environ.get("ALERT_WEBHOOK")
    if not url:
        return
    try:
        req = urllib.request.Request(url, data=json.dumps({"text": summary, "content": summary}).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log(f"(webhook failed: {e})")


def run(kind, listing_url, path_part, promo_keywords=(), limit=10, scrolls=15):
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    label = kind.upper()
    log(f"🚀 Scenteno {label} commenter{' (DRY RUN)' if dry_run else ''}")

    state = load_state()
    results = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            log(f"❌ Cannot connect to Chrome at {CDP_URL}: {e}\n   Run start-chrome.bat first.")
            notify(f"Scenteno {label}: Chrome not running")
            sys.exit(2)

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        try:
            if not ensure_signed_in(page):
                dump_failure(page, "signin", "no avatar button on youtube.com")
                log("❌ Not signed in to YouTube in the debug Chrome. Sign in and re-run.")
                notify(f"Scenteno {label}: YouTube session expired — sign in again")
                sys.exit(3)

            urls = collect_urls(page, listing_url, path_part, limit, scrolls)
            if not urls:
                dump_failure(page, "listing", "no item links on listing page")
                log("❌ No items found on listing page.")
                notify(f"Scenteno {label}: listing page returned no items")
                sys.exit(4)

            prev_title = page.title()
            for url in urls:
                item_id = url.split(path_part)[1].strip("/")
                prior = state.get(item_id, {}).get("status")
                if prior in DONE_STATUSES and not force:
                    results.append((item_id, f"skip ({prior})"))
                    continue
                try:
                    status, prev_title = process_item(page, kind, url, item_id, prev_title,
                                                      promo_keywords, dry_run)
                except Exception as e:
                    status = f"ERR {type(e).__name__}: {str(e).splitlines()[0][:90]}"
                    dump_failure(page, item_id, repr(e))
                    prev_title = page.title()
                results.append((item_id, status))
                log(f"     {item_id} → {status}")
                if not dry_run:
                    state[item_id] = {"status": status, "kind": kind,
                                      "ts": datetime.now().isoformat(timespec="seconds")}
                    save_state(state)
                human_pause()
        finally:
            page.close()

    done = sum(1 for _, r in results if r in ("commented+pinned", "pinned existing"))
    errors = [(i, r) for i, r in results if r.startswith("ERR")]
    log("\n" + "=" * 64 + f"\n📊 SCENTENO {label} REPORT\n" + "=" * 64)
    for i, r in results:
        log(f"  {i[:22]:22s} │ {r}")
    log("=" * 64 + f"\n  Done: {done}  Errors: {len(errors)}  Total: {len(results)}")
    if errors:
        notify(f"Scenteno {label}: {len(errors)} error(s)\n" + "\n".join(f"{i}: {r}" for i, r in errors))
        sys.exit(1)
