import { test } from "node:test";
import assert from "node:assert/strict";
import { browseYearFacet } from "../kb-local.js";

test("browseYearFacet lists only years represented in the selected course", () => {
  const bundle = {
    notes: [
      { course: "Math", y: "2025" },
      { course: "Math", y: "2024" },
      { course: "Science", y: "2025" },
      { course: "Math", y: "2024" },
      { course: "Math", y: "undated" },
    ],
  };

  assert.deepEqual(browseYearFacet(bundle, "Math"), ["2025", "2024", "undated"]);
});
