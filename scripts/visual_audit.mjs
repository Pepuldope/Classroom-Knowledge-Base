// visual_audit.mjs — capture every key view + edge states of the LIVE site
// for the human visual-appeal pass. Desktop + mobile viewports.
// Usage: node scripts/visual_audit.mjs [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.KB_LIVE_URL || "https://classroom-knowledge-google.vercel.app";
const OUT = process.argv[2] || "/tmp/kb_visual";
mkdirSync(OUT, { recursive: true });

const sleeps = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(page, name, { full = false } = {}) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log("shot:", name);
}

async function main() {
  const browser = await chromium.launch();
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  const page = await ctxD.newPage();
  const mpage = await ctxM.newPage();

  // ---- DESKTOP ----
  await page.goto(URL, { waitUntil: "networkidle" });
  await sleeps(500);
  await snap(page, "d-01-planner");

  // KB view (knowledge base populated)
  await page.click('[data-view="kb"]');
  await sleeps(1500); // allow first paint + fetch
  await snap(page, "d-02-kb-landing");

  // type a query to get results (also exercises loading + results states)
  await page.fill("#kbSearchInput", "algebra");
  await sleeps(1200);
  await snap(page, "d-03-kb-results");

  // scroll to bottom of KB results to check overflow / sticky elements
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleeps(400);
  await snap(page, "d-04-kb-results-bottom");

  // open a note modal
  const card = page.locator("#kbResults .kb-result-card").first();
  if (await card.count()) {
    await card.click();
    await sleeps(1000);
    await snap(page, "d-05-kb-note-modal");
    // scroll within the modal to bottom
    await page.evaluate(() => {
      const b = document.querySelector("#kbNoteBody");
      if (b) b.scrollTop = b.scrollHeight;
    });
    await sleeps(400);
    await snap(page, "d-06-kb-note-modal-scrolled");
    // close
    await page.click("#kbNoteClose");
    await sleeps(300);
  }

  // tutor modal
  await page.click("#kbTutorOpen");
  await sleeps(500);
  await snap(page, "d-07-kb-tutor-modal");
  // type a message (may not return without token; just capture the input state)
  await page.fill("#kbTutorInput", "Explain quadratic equations");
  await page.click("#kbTutorForm button[type=submit]");
  await sleeps(2500);
  await snap(page, "d-08-kb-tutor-thinking");
  await page.click("#kbTutorClose");
  await sleeps(300);

  // filter chips: click a course filter
  await page.click("#kbSearchInput", { clear: true }).catch(() => {});
  await page.fill("#kbSearchInput", "note");
  await sleeps(1000);
  const chip = page.locator("#kbFilterChips .kb-chip").first();
  if (await chip.count()) {
    await chip.click();
    await sleeps(800);
    await snap(page, "d-09-kb-filtered");
  }

  // browse by course (clear query)
  await page.fill("#kbSearchInput", "");
  await sleeps(1000);
  await snap(page, "d-10-kb-browse");

  // open a course to see sprint/topic folding
  const courseCard = page.locator("#kbBrowseCourses .kb-course-card").first();
  if (await courseCard.count()) {
    await courseCard.click();
    await sleeps(1200);
    await snap(page, "d-11-kb-course-folded");
    // expand more groups
    const details = page.locator("#kbBrowseNotes details").nth(2);
    if (await details.count()) {
      await details.click();
      await sleeps(300);
    }
    await snap(page, "d-12-kb-course-expanded");
  }

  // Archive view
  await page.click('[data-view="archive"]');
  await sleeps(1200);
  await snap(page, "d-13-archive-onboarding");

  // ---- MOBILE ----
  await mpage.goto(URL, { waitUntil: "networkidle" });
  await sleeps(500);
  await snap(mpage, "m-01-planner");
  await mpage.click('[data-view="kb"]');
  await sleeps(1500);
  await snap(mpage, "m-02-kb-landing");
  await mpage.fill("#kbSearchInput", "algebra");
  await sleeps(1200);
  await snap(mpage, "m-03-kb-results");
  await mpage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleeps(400);
  await snap(mpage, "m-04-kb-results-bottom");
  const mcard = mpage.locator("#kbResults .kb-result-card").first();
  if (await mcard.count()) {
    await mcard.click();
    await sleeps(1000);
    await snap(mpage, "m-05-kb-note-modal");
    await mpage.click("#kbNoteClose");
    await sleeps(300);
  }
  await mpage.click("#kbTutorOpen");
  await sleeps(500);
  await snap(mpage, "m-06-kb-tutor-modal");
  await mpage.click("#kbTutorClose");
  await sleeps(300);

  await browser.close();
  console.log("DONE ->", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
