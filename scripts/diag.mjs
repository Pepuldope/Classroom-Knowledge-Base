// diag.mjs — inspect why #viewToggle stays hidden on the live site.
import { chromium } from "playwright";
const URL = "https://classroom-knowledge-google.vercel.app";
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
await p.goto(URL, { waitUntil: "networkidle" });
await new Promise((r) => setTimeout(r, 2500));
const info = await p.evaluate(() => {
  const t = document.querySelector("#viewToggle");
  return {
    toggleHidden: t ? t.hidden : "no-el",
    toggleDisplay: t ? getComputedStyle(t).display : "?",
    hasSetView: typeof window.setView,
    bodyClass: document.body.className,
    toggleBtns: document.querySelectorAll(".view-toggle-btn").length,
  };
});
console.log("INFO", JSON.stringify(info, null, 2));
console.log("CONSOLE ERRORS:", JSON.stringify(errs.slice(0, 10), null, 2));
await b.close();
