// Injected into youtube.com pages by background.js. All DOM work lives here.
// Ported 1:1 from ytcommenter.py — same selectors, same rules.
(() => {
  if (window.__scentenoLoaded) return;
  window.__scentenoLoaded = true;

  const COMMENT_BOS =
    "https://scenteno.com/yt12  Join the Brotherhood of Scent to get fragrance advice " +
    "from a supportive community — and share advice, opinions, and experience with fragrance brothers.";
  const COMMENT_HOD =
    "https://www.realmenrealstyle.com/best-frags  Ready to upgrade your fragrance game? Check out House of Dastan here.";
  // Config shape: { default: text, rules: [{ keyword, text }] } — first rule whose keyword
  // appears in the title/post wins, otherwise `default`. Older {bos,hod,hodKeyword} is converted.
  const DEFAULTS = { default: COMMENT_BOS, rules: [{ keyword: "house of dastan", text: COMMENT_HOD }] };
  const LEGACY_KEYS = ["scenteno.com/yt12", "realmenrealstyle.com/best-frags"];
  // Detection key = first URL in the comment minus protocol/www (what YouTube displays)
  const keyOf = (text) => (text.match(/https?:\/\/\S+/)?.[0] || text.slice(0, 40)).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  function normalize(c) {
    if (!c) return DEFAULTS;
    if (c.bos) return { default: c.bos, rules: c.hod ? [{ keyword: c.hodKeyword || "house of dastan", text: c.hod }] : [] };
    return { default: c.default || DEFAULTS.default, rules: (c.rules || []).filter((r) => r.keyword && r.text) };
  }
  let cfg = DEFAULTS;
  const ourKeys = () => [...new Set([keyOf(cfg.default), ...cfg.rules.map((r) => keyOf(r.text)), ...LEGACY_KEYS])];
  const PROMO_KEYWORDS = ["% off", "sale", "off"];
  const STEP_TIMEOUT = 15000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.offsetParent !== null && el.getClientRects().length > 0;

  // Poll until fn() returns a truthy value. Throws a descriptive error on timeout.
  async function waitFor(fn, what, timeout = STEP_TIMEOUT) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error(`Timeout waiting for ${what}`);
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function getComment(subject) {
    const s = subject.toLowerCase();
    const rule = cfg.rules.find((r) => s.includes(r.keyword.toLowerCase()));
    const text = rule ? rule.text : cfg.default;
    return { text, key: keyOf(text) };
  }

  const threads = () => $$("ytd-comment-thread-renderer");
  const threadWith = (key) => threads().find((t) => t.innerText.includes(key));
  const pinnedPresent = () =>
    !!$("ytd-pinned-comment-badge-renderer") || threads().some((t) => t.innerText.includes("Pinned by"));

  // ---------- collect listing URLs ----------
  async function collect(part, limit, scrolls) {
    await waitFor(() => $(`a[href*="${part}"]`), `listing links (${part})`);
    for (let i = 0; i < scrolls; i++) {
      window.scrollTo(0, document.scrollingElement.scrollHeight);
      await sleep(400);
    }
    return [
      ...new Set(
        $$(`a[href*="${part}"]`)
          .map((a) => { const u = new URL(a.href); u.search = ""; u.hash = ""; return u.toString(); })
          .filter((h) => (h.split(part)[1] || "").length > 5)
      ),
    ].slice(0, limit);
  }

  // ---------- open comment section ----------
  async function openComments(kind) {
    const boxVisible = () => visible($("ytd-comment-simplebox-renderer #placeholder-area"));
    if (kind === "shorts") {
      // YouTube remembers the panel state between Shorts: after the first one, the comments
      // panel is usually already open (and the button no longer says "View N comments").
      await sleep(1500);
      if (!boxVisible()) {
        // 2026 layout: <button aria-label="View N comments"> (no id). Older: #comments-button.
        const btn = await waitFor(
          () => $$('button[aria-label^="View"][aria-label*="comment" i], #comments-button button, button[aria-label*="comments" i]')
                  .find((b) => visible(b) && !b.closest("ytd-comment-simplebox-renderer")),
          "Shorts comments button"
        );
        btn.click();
      }
    } else {
      // ytd-comments is zero-height until scrolled near; scrolling triggers the lazy load
      window.scrollTo({ top: 3000, behavior: "instant" });
    }
    try {
      await waitFor(boxVisible, "comment box");
    } catch {
      return false;
    }
    // existing threads arrive shortly after the box
    try { await waitFor(() => $("ytd-comment-thread-renderer, ytd-message-renderer"), "threads", 5000); } catch {}
    return true;
  }

  // ---------- post + pin ----------
  async function postComment(text, key) {
    const box = await waitFor(() => { const e = $("ytd-comment-simplebox-renderer #placeholder-area"); return visible(e) && e; }, "placeholder");
    box.click();
    const editable = await waitFor(() => { const e = $("ytd-comment-simplebox-renderer #contenteditable-root"); return visible(e) && e; }, "editor");
    editable.focus();
    // execCommand fires real beforeinput/input events, which YouTube listens for to enable the button
    if (!document.execCommand("insertText", false, text)) {
      editable.textContent = text;
      editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    const submit = await waitFor(() => {
      const b = $("ytd-comment-simplebox-renderer #submit-button button");
      return visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && b;
    }, "enabled Comment button");
    submit.click();
    return waitFor(() => threadWith(key), "our posted comment to appear");
  }

  async function pinThread(thread) {
    thread.scrollIntoView({ block: "center" });
    thread.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const menu = await waitFor(() => $("#action-menu button", thread), "thread action menu");
    menu.click();
    const pinItem = await waitFor(
      () => $$('tp-yt-paper-listbox [role="menuitem"], ytd-menu-popup-renderer [role="menuitem"], ytd-menu-service-item-renderer')
              .find((el) => visible(el) && el.innerText.trim().split("\n")[0] === "Pin"),
      '"Pin" menu item'
    );
    pinItem.click();
    // YouTube only asks for confirmation when another comment is already pinned; a first pin
    // applies immediately. After pinning, YouTube re-renders the comment as a NEW element at
    // the top of the list, so look for the badge anywhere on the page (we verified there was
    // no pinned comment before we started), not inside the now-detached `thread` node.
    const confirmSel = "yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button, #confirm-button button";
    const badge = () => $("ytd-pinned-comment-badge-renderer") || threads().some((t) => t.innerText.includes("Pinned by"));
    const outcome = await waitFor(
      () => (badge() && "pinned") || ($$(confirmSel).find(visible) && "dialog"),
      "pinned badge or confirm dialog"
    );
    if (outcome === "dialog") {
      $$(confirmSel).find(visible).click();
      await waitFor(badge, "pinned badge");
    }
  }

  async function process(kind, dryRun, comments) {
    cfg = normalize(comments);
    // page.title is set late on SPA loads; wait until it's a real one
    const title = await waitFor(() => {
      const t = document.title.trim();
      return t && t !== "YouTube" && t !== "- YouTube" && t;
    }, "page title", 10000).catch(() => document.title);

    let subject = title;
    if (kind === "posts") {
      await waitFor(() => $("ytd-backstage-post-renderer, ytd-post-renderer"), "post body");
      subject = document.body.innerText.substring(0, 800);
      if (PROMO_KEYWORDS.some((k) => subject.toLowerCase().includes(k.toLowerCase()))) return { status: "promo", title };
    }
    const { text, key } = getComment(subject);

    if (!(await openComments(kind))) return { status: "ERR comment box didn't load", title };
    if (pinnedPresent()) return { status: "already pinned", title };
    if (dryRun) return { status: "DRY would comment+pin", title };

    const ours = ourKeys().map(threadWith).find(Boolean);
    if (ours) { await pinThread(ours); return { status: "pinned existing", title }; }

    const thread = await postComment(text, key);
    await pinThread(thread);
    return { status: "commented+pinned", title };
  }

  // Failure evidence: the comments section (where everything we do happens) plus any open
  // dialog/menu — a full YouTube page is several MB and the first 300 KB is just headers.
  function evidenceHtml() {
    const parts = ["<!-- url: " + location.href + " | title: " + document.title + " -->"];
    for (const sel of ["ytd-popup-container", "ytd-comments#comments", "ytd-engagement-panel-section-list-renderer[target-id*='comment']"]) {
      const el = $(sel);
      if (el) parts.push("<!-- " + sel + " -->\n" + el.outerHTML.slice(0, 250000));
    }
    if (parts.length === 1) parts.push(document.documentElement.outerHTML.slice(0, 300000));
    return parts.join("\n\n").slice(0, 600000);
  }

  window.__scenteno = { collect, process }; // for manual testing from the devtools console

  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return; // loaded outside the extension (tests)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== "yt") return;
    const job = msg.cmd === "collect" ? collect(msg.part, msg.limit, msg.scrolls) : process(msg.kind, msg.dryRun, msg.comments);
    job.then((r) => sendResponse({ ok: true, result: r }))
       .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e), html: evidenceHtml() }));
    return true; // async response
  });
})();
