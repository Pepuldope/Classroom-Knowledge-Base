// diag3.mjs — why is #viewToggle hidden on the LOCAL dev server?
import { chromium } from "playwright";
const URL = "http://localhost:4321";
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
p.on("requestfailed", (r) => errs.push("REQFAIL: " + r.url() + " " + (r.failure()?.errorText || "")));
p.on("response", (r) => { if (r.status() >= 400) errs.push("HTTP " + r.status() + " " + r.url()); });
await p.goto(URL, { waitUntil: "networkidle" });
await new Promise((r) => setTimeout(r, 3000));
const info = await p.evaluate(() => {
  const t = document.querySelector("#viewToggle");
  return {
    toggleHidden: t ? t.hidden : "no-el",
    toggleDisplay: t ? getComputedStyle(t).display : "?",
    h1: document.querySelector("header h1")?.textContent,
    toggleBtns: document.querySelectorAll(".view-toggle-btn").length,
  };
});
console.log("INFO", JSON.stringify(info, null, 2));
console.log("ERRORS", JSON.stringify(errs.slice(0, 15), null, 2));
await b.close();
