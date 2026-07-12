import { chromium } from "playwright";

const BASE = "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push("CONSOLE " + m.type() + ": " + m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e)));
page.on("requestfailed", (r) => logs.push("REQFAIL: " + r.url() + " " + (r.failure()?.errorText)));
page.on("response", (r) => { if (r.url().includes("/api/kb-related")) logs.push("RESP kb-related: " + r.status() + " " + r.url()); });

await page.goto(BASE + "/kb-test-harness.html", { waitUntil: "networkidle" });
await page.fill("#kbSearchInput", "STAR method");
await page.click("#kbSearchInput");
await page.keyboard.press("Enter");
await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
await page.click("#kbResults .kb-result-card");
await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
await page.waitForTimeout(4000);

const title = await page.locator("#kbNoteTitle").textContent();
const bodyLen = (await page.locator("#kbNoteBody").textContent()).length;
console.log("noteTitle=", title, "bodyLen=", bodyLen);
const relHidden = await page.getAttribute("#kbNoteRelated", "hidden");
const items = await page.locator("#kbNoteRelatedList .kb-related-item").count();
console.log("relHidden=", relHidden, "items=", items);
console.log("---LOGS---");
console.log(logs.join("\n"));
await browser.close();
