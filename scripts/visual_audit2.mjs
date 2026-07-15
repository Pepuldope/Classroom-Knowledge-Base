// visual_audit2.mjs — robust geometry/state audit.
// Handles Vercel's intermittent "Security Checkpoint" by retrying until the
// real app (header "Classroom Analyzer") is present. Runs deterministic layout
// checks (no vision needed): horizontal overflow, modal within viewport,
// footer visible, related-panel overlap, result cards present.
//
// Resilience: every interaction uses force-clicks + waitModalClosed, and each
// step is wrapped so one flake never aborts the whole report — the audit's job
// is to EMIT findings, not to be a brittle click-through.
import { chromium } from "playwright";

const URL = process.env.KB_LIVE_URL || "https://classroom-knowledge-google.vercel.app";
const sleeps = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = [];
const rec = (sev, state, msg, extra) => findings.push({ sev, state, msg, ...(extra || {}) });

async function loadApp(page) {
  for (let i = 0; i < 6; i++) {
    await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await sleeps(3000);
    const st = await page.evaluate(() => {
      const h1 = document.querySelector("header h1");
      return { title: h1 ? h1.textContent : "", checkpoint: document.body.textContent.includes("verifying your browser") };
    });
    if (!st.checkpoint && st.title.includes("Classroom")) return true;
    rec("med", "load", `attempt ${i + 1}: checkpoint shown (${st.checkpoint}) title="${st.title}"`);
    await sleeps(2000);
  }
  return false;
}

async function geom(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const doc = document.documentElement;
    return { vw, vh, horizOverflow: doc.scrollWidth - vw };
  });
}

async function waitModalClosed(page, modalSel) {
  await page.waitForFunction(
    (s) => {
      const m = document.querySelector(s);
      if (!m) return true;
      const cs = getComputedStyle(m);
      return m.hidden || cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0";
    },
    modalSel,
    { timeout: 5000 }
  ).catch(() => {});
}

async function modalCheck(page, modalSel, state) {
  const hidden = await page.evaluate((s) => (document.querySelector(s) ? document.querySelector(s).hidden : true), modalSel);
  if (hidden) return;
  const info = await page.evaluate((s) => {
    const card = document.querySelector(s + " .modal-card");
    const r = card.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const footer = card.querySelector("footer") || card.lastElementChild;
    const fr = footer ? footer.getBoundingClientRect() : null;
    const body = card.querySelector(".archive-note-body");
    return {
      cardWithin: r.left >= 0 && r.top >= 0 && r.right <= vw + 1 && r.bottom <= vh + 1,
      footerVisible: fr ? fr.bottom <= vh + 1 && fr.top >= 0 : null,
      bodyScrollable: body ? body.scrollHeight > body.clientHeight : null,
    };
  }, modalSel);
  if (!info.cardWithin) rec("high", state, "modal card overflows viewport");
  if (info.footerVisible === false) rec("high", state, "modal footer (buttons) cut off / off-screen");
}

async function openFirstResult(page) {
  const card = page.locator("#kbResults .kb-result-card").first();
  if (await card.count() === 0) return false;
  await card.click({ force: true });
  await sleeps(900);
  return true;
}

async function run() {
  const browser = await chromium.launch();
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  const page = await ctxD.newPage();
  const mpage = await ctxM.newPage();

  if (!(await loadApp(page))) { rec("crit", "load", "app never loaded (persistent checkpoint)"); }
  else {
    try {
      await page.click('[data-view="kb"]', { force: true });
      await sleeps(1800);
      let g = await geom(page); if (g.horizOverflow > 1) rec("med", "d-kb-landing", `horizontal overflow ${g.horizOverflow}px`, g);
      await page.fill("#kbSearchInput", "algebra");
      await sleeps(1400);
      const rc = await page.evaluate(() => ({
        cards: document.querySelectorAll("#kbResults .kb-result-card").length,
        count: document.querySelector("#kbResultCount")?.textContent || "",
        chips: document.querySelectorAll("#kbFilterChips .kb-chip").length,
      }));
      if (rc.cards === 0) rec("high", "d-kb-results", "no result cards rendered despite populated KB", rc);
      else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleeps(400);
        g = await geom(page); if (g.horizOverflow > 1) rec("med", "d-kb-results-bottom", `overflow at bottom ${g.horizOverflow}px`);
        await page.evaluate(() => window.scrollTo(0, 0));
        if (await openFirstResult(page)) {
          await modalCheck(page, "#kbNoteModal", "d-kb-note-modal");
          await page.evaluate(() => { const b = document.querySelector("#kbNoteBody"); if (b) b.scrollTop = b.scrollHeight; });
          await sleeps(300);
          const fc = await page.evaluate(() => {
            const fr = document.querySelector("#kbNoteModal .modal-card footer").getBoundingClientRect();
            return { footerVisible: fr.bottom <= window.innerHeight + 1 };
          });
          if (!fc.footerVisible) rec("high", "d-kb-note-modal-scrolled", "footer covered when body scrolled");
          await page.keyboard.press("Escape"); await sleeps(500);
          await waitModalClosed(page, "#kbNoteModal");
          const related = await page.evaluate(() => {
            const rel = document.querySelector("#kbNoteRelated");
            if (!rel || rel.hidden) return { present: false };
            const rr = rel.getBoundingClientRect();
            const body = document.querySelector("#kbNoteBody").getBoundingClientRect();
            return { present: true, overlapsBody: rr.top < body.bottom && rr.left < body.right && rr.right > body.left && rr.bottom > body.top };
          });
          if (related.present && related.overlapsBody) rec("high", "d-kb-note-modal", "related panel overlaps note body");
        }
      }
      await page.click("#kbTutorOpen", { force: true }); await sleeps(500);
      await modalCheck(page, "#kbTutorModal", "d-kb-tutor-modal");
      await page.click("#kbTutorClose", { force: true }); await sleeps(300);
      await waitModalClosed(page, "#kbTutorModal");
      await page.fill("#kbSearchInput", ""); await sleeps(1000);
      const courseCard = page.locator("#kbBrowseCourses .kb-course-card").first();
      if (await courseCard.count()) {
        await courseCard.click({ force: true }); await sleeps(1200);
        const fold = await page.evaluate(() => {
          const dets = document.querySelectorAll("#kbBrowseNotes details");
          return { total: dets.length, openCount: [...dets].filter((d) => d.open).length };
        });
        if (fold.total === 0) rec("med", "d-kb-course", "course notes not grouped");
        if (fold.openCount === fold.total && fold.total > 3) rec("low", "d-kb-course", "all groups expanded by default");
      }
    } catch (e) { rec("med", "d-run", "desktop run error: " + e.message.split("\n")[0]); }
  }

  // mobile
  if (await loadApp(mpage)) {
    try {
      await mpage.click('[data-view="kb"]', { force: true }); await sleeps(1800);
      let g = await geom(mpage); if (g.horizOverflow > 1) rec("high", "m-kb-landing", `MOBILE overflow ${g.horizOverflow}px`);
      await mpage.fill("#kbSearchInput", "algebra"); await sleeps(1400);
      g = await geom(mpage); if (g.horizOverflow > 1) rec("high", "m-kb-results", `MOBILE overflow ${g.horizOverflow}px`);
      if (await openFirstResult(mpage)) {
        await modalCheck(mpage, "#kbNoteModal", "m-kb-note-modal");
        await mpage.click("#kbNoteClose", { force: true }); await sleeps(300);
        await waitModalClosed(mpage, "#kbNoteModal");
      }
      await mpage.click("#kbTutorOpen", { force: true }); await sleeps(500);
      await modalCheck(mpage, "#kbTutorModal", "m-kb-tutor-modal");
      await mpage.click("#kbTutorClose", { force: true }); await sleeps(300);
      await waitModalClosed(mpage, "#kbTutorModal");
    } catch (e) { rec("med", "m-run", "mobile run error: " + e.message.split("\n")[0]); }
  }

  await browser.close();
  console.log(JSON.stringify({ total: findings.length, findings }, null, 2));
}
run().catch((e) => { console.error(e); process.exit(1); });
