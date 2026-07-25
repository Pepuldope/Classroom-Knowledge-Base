import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:4321";
const MIN_CONTRAST = 4.5;

function contrastRatio(foreground, background) {
  const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = (value) => {
    const [r, g, b] = rgb(value);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

test("representative text remains readable in explicit light and dark themes", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    const samples = await page.evaluate(() => {
      const welcome = document.querySelector("#welcome");
      if (welcome) welcome.hidden = false;
      if (!document.querySelector(".ai-msg.assistant")) {
        const assistant = document.createElement("div");
        assistant.className = "ai-msg assistant";
        assistant.textContent = "Grounded answer";
        document.body.append(assistant);
      }
      return [
        ["welcome title", ".welcome-title"],
        ["onboarding step", ".step-text"],
        ["status", ".status"],
        ["tutor context", ".ai-context"],
        ["tutor answer", ".ai-msg.assistant"],
      ];
    });
    assert.ok(samples.length > 0);

    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      const results = await page.evaluate((sampleList) => sampleList.map(([name, selector]) => {
        const element = document.querySelector(selector);
        if (!element) return { name, selector, missing: true };
        const parent = element.closest("li, .welcome-card, body") || element.parentElement;
        const text = getComputedStyle(element);
        const background = getComputedStyle(parent).backgroundColor;
        return { name, selector, foreground: text.color, background };
      }), samples);
      for (const result of results) {
        assert.equal(result.missing, undefined, `${theme}: missing ${result.selector}`);
        assert.ok(result.background !== "rgba(0, 0, 0, 0)", `${theme}: transparent background for ${result.name}`);
        assert.ok(
          contrastRatio(result.foreground, result.background) >= MIN_CONTRAST,
          `${theme}: ${result.name} contrast ${contrastRatio(result.foreground, result.background).toFixed(2)}:1 (${result.foreground} on ${result.background})`,
        );
      }
    }
  } finally {
    await browser.close();
  }
});
