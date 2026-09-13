// deep-links.js — every note and assignment has an address, so it can open in
// a new tab.
//
// Peter, 2026-09-13: "You should be able to middle click things to open them in
// a separate tab." Nothing on the site was a link — notes and assignments were
// buttons and clickable <div>s — so a middle-click did nothing (or started
// autoscroll), and there was no URL to open even if it had.
//
// Two mechanisms, because two kinds of element:
// - Leaf controls (a related-note chip, a source, a [1] citation) are real
//   <a href> links. Middle-click, Ctrl/⌘-click, "Open link in new tab" and
//   "Copy link address" all come from the browser. A plain click is intercepted
//   and opens in place, as before.
// - Cards (a search result, a Planner assignment) contain buttons of their own
//   — Pin, related chips — and a link may not contain buttons. They carry
//   `data-href`, and one document-level handler turns a middle-click or
//   Ctrl/⌘-click on them into a new tab.

const NOTE = "note";
const ASSIGNMENT = "assignment";

export function noteHref(key) {
  return key ? `#${NOTE}=${encodeURIComponent(key)}` : "";
}

export function assignmentHref(id) {
  return id ? `#${ASSIGNMENT}=${encodeURIComponent(id)}` : "";
}

/** `#note=…` / `#assignment=…` back into what to open; anything else is null. */
export function parseDeepLink(hash) {
  const m = /^#(note|assignment)=(.+)$/.exec(String(hash || ""));
  if (!m) return null;
  let value;
  try { value = decodeURIComponent(m[2]); } catch { return null; }
  if (!value.trim()) return null;
  return m[1] === NOTE ? { type: NOTE, key: value } : { type: ASSIGNMENT, id: value };
}

/** Does this click ask for a new tab rather than opening in place? */
export function wantsNewTab(event) {
  if (!event) return false;
  if (event.type === "auxclick") return event.button === 1;
  return event.button === 0 && !!(event.ctrlKey || event.metaKey || event.shiftKey);
}

/**
 * Make `anchor` a real link to `href` that still opens in place on a plain
 * click. Returns the anchor.
 */
export function linkTo(anchor, href, openInPlace) {
  anchor.href = href;
  anchor.addEventListener("click", (event) => {
    if (wantsNewTab(event)) { event.stopPropagation(); return; } // the browser opens the tab
    event.preventDefault();
    event.stopPropagation(); // a link inside a card must not also open the card
    openInPlace(event);
  });
  // A middle-click on a link inside a clickable card belongs to the link.
  anchor.addEventListener("auxclick", (event) => event.stopPropagation());
  return anchor;
}

/** The [data-href] card an event landed on, unless a real link or control inside it took it. */
function cardTarget(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  const card = target.closest("[data-href]");
  if (!card) return null;
  const inner = target.closest("a[href], button, input, select, textarea, summary");
  if (inner && inner !== card && card.contains(inner)) return null;
  return card;
}

let installed = false;

/** One listener set for the whole document; safe to call more than once. */
export function installNewTabCards(doc = document, win = window) {
  if (installed) return;
  installed = true;
  // Middle-button down on a card would otherwise start Windows autoscroll.
  doc.addEventListener("mousedown", (event) => {
    if (event.button === 1 && cardTarget(event)) event.preventDefault();
  });
  doc.addEventListener("auxclick", (event) => {
    if (!wantsNewTab(event)) return;
    const card = cardTarget(event);
    if (!card) return;
    event.preventDefault();
    win.open(new URL(card.dataset.href, win.location.href).href, "_blank", "noopener");
  });
  // Capture phase, so the card's own click handler never opens it in this tab too.
  doc.addEventListener("click", (event) => {
    if (!wantsNewTab(event)) return;
    const card = cardTarget(event);
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    win.open(new URL(card.dataset.href, win.location.href).href, "_blank", "noopener");
  }, true);
}
