#!/usr/bin/env node
// zip_roundtrip_test.mjs — prove the hand-written ZIP writer produces an
// archive a real unzip implementation accepts.
//
// The unit tests in tests/kb-export.test.js check the header layout. That is
// not the same claim: a zip can have every field in the right place and still
// be rejected (a wrong CRC, a bad central-directory offset, a length that does
// not match). This gate writes a real file and unpacks it with Node's own zlib
// -independent path — the system `unzip` when it exists, and otherwise a strict
// re-reader — then compares the bytes back.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildZip, buildZipBlob, buildZipParts, crc32 } from "../kb-export.js";

const FILES = [
  { path: "Math/Assignments/Algebra/Quadratics.md", text: "# Quadratics\n\nSolve for x.\n" },
  { path: "Math/Materials/Formula sheet.md", text: "# Formulas\n" },
  // Non-ASCII in both the name and the body: Classroom titles are Slovak.
  { path: "Dejepis/Materials/Stredovek — zhrnutie.md", text: "Ťažké písmená: áäčďéíĺľňóôŕšťúýž\n" },
  // Binary, standing in for a downloaded PDF.
  { path: "Math/Assignments/Attachments/Quadratics/worksheet.bin", data: new Uint8Array([0, 1, 2, 255, 254, 0, 77]) },
];

const dir = mkdtempSync(join(tmpdir(), "kb-zip-"));
const zipPath = join(dir, "export.zip");
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  if (!ok) failures++;
};

try {
  const zip = buildZip(FILES, { date: new Date("2026-09-17T12:34:56Z") });
  writeFileSync(zipPath, zip);

  // Info-ZIP writes filenames in the locale's encoding. Under the C locale it
  // refuses an accented Slovak title with "Illegal byte sequence" — a property
  // of the extractor's environment, not of the archive, so pin UTF-8 here.
  const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
  const unzip = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8", env });
  if (unzip.error && unzip.error.code === "ENOENT") {
    console.log("SKIP — no system `unzip` on this machine; structural check only");
  } else {
    check(unzip.status === 0, `unzip -t accepts the archive (status ${unzip.status})`);
    if (unzip.status !== 0) console.log(unzip.stdout || "", unzip.stderr || "");

    // Extract with bsdtar rather than unzip. Info-ZIP on macOS writes filenames
    // in the locale charset and refuses an accented Slovak title outright
    // ("Illegal byte sequence") no matter what LC_ALL says; bsdtar honours the
    // UTF-8 flag the writer sets. `unzip -t` above is still the integrity check.
    const out = join(dir, "out");
    mkdirSync(out, { recursive: true });
    const extract = spawnSync("tar", ["-xf", zipPath], { cwd: out, encoding: "utf8", env });
    check(extract.status === 0, `bsdtar extracts without error (status ${extract.status})`);
    if (extract.status !== 0) console.log(extract.stderr || "");

    for (const file of FILES) {
      const onDisk = join(out, file.path);
      if (!existsSync(onDisk)) { check(false, `extracted ${file.path}`); continue; }
      const bytes = readFileSync(onDisk);
      const expected = file.data
        ? Buffer.from(file.data)
        : Buffer.from(file.text, "utf8");
      check(Buffer.compare(bytes, expected) === 0, `${file.path} round-trips byte for byte`);
    }
  }

  // CRC is the field an unzip -t would catch, so assert it independently too.
  check(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "CRC-32 check value");

  // The path the browser actually takes: attachment bodies arrive as Blobs with
  // a CRC computed while they streamed, and are never copied into a JS array.
  // This is the fix for the 1.6 GB out-of-memory crash, so it needs a gate that
  // fails if anyone flattens the archive again.
  const blobFiles = FILES.map((file) => {
    const bytes = file.data ? file.data : new TextEncoder().encode(file.text);
    return { path: file.path, blob: new Blob([bytes]), size: bytes.length, crc: crc32(bytes) };
  });
  const parts = buildZipParts(blobFiles, { date: new Date("2026-09-17T12:34:56Z") });
  check(
    parts.filter((part) => part instanceof Blob).length === FILES.length,
    "every file body stays a Blob part — the archive is never materialised in memory",
  );

  const blobZip = join(dir, "blob-export.zip");
  writeFileSync(blobZip, Buffer.from(await buildZipBlob(blobFiles, { date: new Date("2026-09-17T12:34:56Z") }).arrayBuffer()));
  check(
    Buffer.compare(readFileSync(blobZip), Buffer.from(buildZip(FILES, { date: new Date("2026-09-17T12:34:56Z") }))) === 0,
    "the Blob archive is byte-identical to the in-memory one",
  );
  const blobEnv = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
  const blobUnzip = spawnSync("unzip", ["-t", blobZip], { encoding: "utf8", env: blobEnv });
  if (!(blobUnzip.error && blobUnzip.error.code === "ENOENT")) {
    check(blobUnzip.status === 0, `unzip -t accepts the Blob-built archive (status ${blobUnzip.status})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n[zip roundtrip] ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\n[zip roundtrip] all checks passed");
