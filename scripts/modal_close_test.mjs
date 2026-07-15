import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:4321";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();

async function verify(tag, viewport, isMobile) {
  const ctx = await browser.newContext({ viewport, isMobile });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-view="kb"]', { timeout: 10000 });
  await page.click('[data-view="kb"]');
  await page.waitForSelector("#kbSearchInput:visible", { timeout: 10000 });
  await sleep(700);
  await page.fill("#kbSearchInput", "algebra");
  await sleep(2200);
  await page.locator("#kbResults .kb-result-card").first().click();
  await sleep(900);
  // Try clicking the close button — previously it intercepted with the title.
  let clicked = false, err = "";
  try {
    await page.click("#kbNoteClose", { timeout: 4000 });
    clicked = true;
  } catch (e) { err = e.message.split("\n")[0]; }
  await sleep(300);
  const closed = await page.evaluate(() => {
    const m = document.querySelector("#kbNoteModal");
    return m ? m.hidden : true;
  });
  console.log(tag, JSON.stringify({ clickedClose: clicked, modalClosed: closed, err }));
  await ctx.close();
}
await verify("DESKTOP-1280", { width: 1280, height: 900 }, false);
await verify("MOBILE-390", { width: 390, height: 780 }, true);
await browser.close();
