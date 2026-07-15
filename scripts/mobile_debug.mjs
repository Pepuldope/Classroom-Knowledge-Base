import { chromium } from "playwright";
const BASE = "http://localhost:4321";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REF = 390;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: REF, height: 780 }, isMobile: true });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.click('[data-view="kb"]');
await page.waitForSelector("#kbSearchInput:visible", { timeout: 10000 });
await sleep(700);
await page.fill("#kbSearchInput", "algebra");
await sleep(2200);
await page.locator("#kbResults .kb-result-card").first().click();
await sleep(900);
const wide = await page.evaluate((REF) => {
  const offenders = [];
  document.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.right > REF + 1) {
      offenders.push({
        tag: el.tagName,
        cls: (el.className && el.className.toString().slice(0, 40)) || "",
        id: el.id || "",
        right: Math.round(r.right),
        w: Math.round(r.width),
      });
    }
  });
  offenders.sort((a, b) => b.right - a.right);
  return { innerWidth: window.innerWidth, docScrollW: document.documentElement.scrollWidth, count: offenders.length, top: offenders.slice(0, 12) };
}, REF);
console.log(JSON.stringify(wide, null, 2));
await browser.close();
