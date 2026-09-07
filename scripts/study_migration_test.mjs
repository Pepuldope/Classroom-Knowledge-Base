// study_migration_test.mjs — a pre-merge Archive bundle survives the upgrade.
//
// Users on the old build have their past years in the `bundle` IndexedDB record
// and their Classroom notes in `kb-bundle`. The Archive view that read the
// first one is gone, so if the migration does not run, those notes are still on
// disk but unreachable — invisible data loss, which is the worst kind.
//
// This drives the real boot path: seed the legacy records, load the page, and
// check what app.js did with them.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/study_migration_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";

const legacyNote = (p, t, course, y) => ({
  p, t, course, y,
  topic: "Old topic",
  kind: "note",
  s: null, // the Archive never derived summaries — the migration must
  x: `Body of ${t}. It has a first sentence worth summarising.`,
});

const LEGACY_ARCHIVE = {
  version: 1,
  source: "vault",
  generatedAt: "2025-06-01T00:00:00.000Z",
  years: ["2022-23"],
  courses: [{ name: "Dejepis", y: "2022-23", family: null, noteCount: 2 }],
  clusters: [{ topics: [{ y: "2022-23", course: "Dejepis", topic: "Old topic" }] }],
  notes: [
    legacyNote("2022-23/dejepis/a", "Ancient Rome", "Dejepis", "2022-23"),
    legacyNote("2022-23/dejepis/b", "Medieval Europe", "Dejepis", "2022-23"),
  ],
};

const CURRENT_KB = {
  version: 1,
  source: "classroom",
  generatedAt: "2026-09-01T00:00:00.000Z",
  years: ["2024-25"],
  courses: [],
  clusters: [],
  notes: [{
    p: "2024-25/ml/a", t: "Intro do ML", course: "ML Y4 Omega", y: "2024-25",
    topic: "Zaklady", kind: "note", s: "Framework strojoveho ucenia.", x: "Body.",
  }],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });

  // Seed both stores exactly as an old build would have left them.
  await page.evaluate(async ({ legacy, current }) => {
    const { idbPut } = await import("/archive.js");
    const { saveKbBundle } = await import("/kb-local.js");
    await idbPut({ id: "bundle", data: legacy });
    await idbPut({ id: "meta", noteCount: legacy.notes.length, years: legacy.years });
    await saveKbBundle(current);
  }, { legacy: LEGACY_ARCHIVE, current: CURRENT_KB });

  // Reload so app.js runs its boot migration for real.
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1200);

  const after = await page.evaluate(async () => {
    const { idbGet } = await import("/archive.js");
    const { loadKbBundle } = await import("/kb-local.js");
    const kb = await loadKbBundle();
    return {
      legacyBundle: await idbGet("bundle"),
      legacyMeta: await idbGet("meta"),
      paths: (kb?.notes || []).map((n) => n.p).sort(),
      years: kb?.years || [],
      clusters: (kb?.clusters || []).length,
      summaries: (kb?.notes || []).filter((n) => n.s).length,
      courses: (kb?.courses || []).map((c) => c.name).sort(),
    };
  });

  assert.deepEqual(
    after.paths,
    ["2022-23/dejepis/a", "2022-23/dejepis/b", "2024-25/ml/a"],
    "both corpora should be present after migration",
  );
  assert.deepEqual(after.years, ["2022-23", "2024-25"], "years should union");
  assert.deepEqual(after.courses, ["Dejepis", "ML Y4 Omega"], "course facets should be recomputed");
  assert.equal(after.summaries, 3, "migrated notes should gain the derived summary the Archive never stored");
  assert.equal(after.clusters, 1, "cross-link clusters should survive");
  // idbGet resolves undefined for a missing record, not null.
  assert.ok(!after.legacyBundle, "the legacy bundle record should be removed once merged");
  assert.ok(!after.legacyMeta, "the legacy meta record should be removed too");
  console.log(`✓ migrated ${after.paths.length} notes across ${after.years.length} years, legacy records cleared`);

  // Running again must not resurrect or duplicate anything.
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(900);
  const second = await page.evaluate(async () => {
    const { loadKbBundle } = await import("/kb-local.js");
    const kb = await loadKbBundle();
    return (kb?.notes || []).length;
  });
  assert.equal(second, 3, "a second load must not duplicate notes");
  console.log("✓ migration is idempotent across reloads");
} finally {
  await browser.close();
}

console.log("\narchive migration passed");
