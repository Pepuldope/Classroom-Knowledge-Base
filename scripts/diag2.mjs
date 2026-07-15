// diag2.mjs — debug what happens after a KB search on the live site.
import { chromium } from "playwright";
const URL = "https://classroom-knowledge-google.vercel.app";
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
await p.goto(URL, { waitUntil: "networkidle" });
await new Promise((r) => setTimeout(r, 2000));
await p.click('[data-view="kb"]');
await new Promise((r) => setTimeout(r, 1800));
await p.fill("#kbSearchInput", "algebra");
await new Promise((r) => setTimeout(r, 1500));
const info = await p.evaluate(() => {
  const res = document.querySelector("#kbResults");
  return {
    resultsHidden: res ? res.hidden : "no-el",
    resultsText: res ? res.textContent.slice(0, 250) : "",
    cards: document.querySelectorAll("#kbResults .kb-result-card").length,
    countText: document.querySelector("#kbResultCount")?.textContent || "",
    chips: document.querySelectorAll("#kbFilterChips .kb-chip").length,
    metaBar: document.querySelector("#kbMetaBar")?.textContent.slice(0, 120) || "",
    inputVal: document.querySelector("#kbSearchInput")?.value,
  };
});
console.log("SEARCH INFO", JSON.stringify(info, null, 2));
console.log("ERRORS", JSON.stringify(errs.slice(0, 8), null, 2));
await b.close();
