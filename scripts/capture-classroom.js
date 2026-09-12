// capture-classroom.js — take one real snapshot of the Classroom API.
//
// WHY THIS EXISTS
//   Every browser gate that touches Classroom invents its own responses. The
//   shapes were written from memory, so the ingest path in archive-builder.js
//   has never been run against anything Google actually returned. This captures
//   the real thing ONCE so it can be redacted into fixtures and replayed.
//
//   It captures RAW, including your real course names and assignment text. The
//   output is NOT safe to commit — this repo is public. Pipe it through
//   scripts/redact-classroom.mjs, which is the only thing that writes into
//   tests/fixtures/classroom/.
//
// HOW TO RUN IT
//   Sign in on https://classroom-knowledge.vercel.app, open devtools on that
//   tab, paste this whole file into the console, and run:
//
//     await captureClassroom()            // every active course
//     await captureClassroom({ max: 3 })  // just the first three
//
//   It prints a summary, leaves the payload on `window.__capture`, and copies
//   it to the clipboard. Save that as scratchpad/_classroom-raw.json and hand
//   it to the redactor. `_*.json` is gitignored, so a stray save cannot leak.
//
// WHAT IT MIRRORS
//   The six requests archive-builder.js makes per build, with the same query
//   strings and the same pagination, so the snapshot matches what the app sees
//   rather than what this script finds convenient. Keep those URLs in step with
//   buildFromClassroom() — if they drift, the fixtures stop being real.

const CLASSROOM_BASE = "https://classroom.googleapis.com/v1";
const PAGE_SIZE = 100;

/**
 * Every page of one list endpoint, concatenated.
 *
 * `listKey` differs from the path on purpose: /topics returns `topic`, and
 * /courseWorkMaterials returns `courseWorkMaterial`. Those singulars are the
 * exact trap a hand-written stub gets wrong, so they are named here once.
 */
async function fetchAllPages(token, urlBuilder, listKey) {
  const items = [];
  const pages = [];
  let pageToken;
  do {
    const url = urlBuilder(pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      // 403/404 on a single facet is normal — archived courses deny some
      // endpoints, and archive-builder.js skips them rather than failing the
      // build. Record it: that branch has never been exercised by a gate, so
      // knowing which facets really do deny us is part of the point.
      return { items, pages, denied: { status: r.status, body: (await r.text()).slice(0, 400) } };
    }
    const body = await r.json();
    pages.push(body);
    const page = body[listKey];
    if (Array.isArray(page)) items.push(...page);
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return { items, pages, denied: null };
}

/** The five per-course facets, exactly as buildFromClassroom() asks for them. */
function facetsFor(courseId) {
  const q = (pt) => (pt ? `&pageToken=${pt}` : "");
  return {
    topics: {
      listKey: "topic",
      url: (pt) => `${CLASSROOM_BASE}/courses/${courseId}/topics?pageSize=${PAGE_SIZE}${q(pt)}`,
    },
    courseWork: {
      listKey: "courseWork",
      url: (pt) => `${CLASSROOM_BASE}/courses/${courseId}/courseWork?pageSize=${PAGE_SIZE}&courseWorkStates=PUBLISHED${q(pt)}`,
    },
    courseWorkMaterials: {
      listKey: "courseWorkMaterial",
      url: (pt) => `${CLASSROOM_BASE}/courses/${courseId}/courseWorkMaterials?pageSize=${PAGE_SIZE}&courseWorkMaterialStates=PUBLISHED${q(pt)}`,
    },
    announcements: {
      listKey: "announcements",
      url: (pt) => `${CLASSROOM_BASE}/courses/${courseId}/announcements?pageSize=${PAGE_SIZE}&announcementStates=PUBLISHED${q(pt)}`,
    },
    submissions: {
      listKey: "studentSubmissions",
      url: (pt) => `${CLASSROOM_BASE}/courses/${courseId}/courseWork/-/studentSubmissions?userId=me&pageSize=${PAGE_SIZE}${q(pt)}`,
    },
  };
}

/** The access token the app is already holding, via its own storage module. */
async function liveToken() {
  const { loadStoredAuthSession } = await import("/auth-session.js");
  const session = await loadStoredAuthSession();
  if (!session || !session.token) {
    throw new Error("No stored auth session — sign in on this tab first, then re-run.");
  }
  if (session.expiresAt && session.expiresAt < Date.now()) {
    throw new Error("Stored token has expired — reload the page to refresh it, then re-run.");
  }
  return session.token;
}

async function captureClassroom({ max = Infinity } = {}) {
  const token = await liveToken();

  const coursesCall = await fetchAllPages(
    token,
    (pt) => `${CLASSROOM_BASE}/courses?courseStates=ACTIVE&pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`,
    "courses",
  );
  if (coursesCall.denied) {
    throw new Error(`/courses denied: ${coursesCall.denied.status} ${coursesCall.denied.body}`);
  }

  const courses = coursesCall.items.slice(0, max);
  const out = {
    capturedAt: new Date().toISOString(),
    // Kept so the redactor and the fixtures can be traced back to a build of
    // the app, and so a stale snapshot is obvious rather than silent.
    origin: location.origin,
    pageSize: PAGE_SIZE,
    coursesPages: coursesCall.pages,
    courses,
    courseData: {},
  };

  for (const course of courses) {
    const facets = facetsFor(course.id);
    const entry = {};
    for (const [name, { url, listKey }] of Object.entries(facets)) {
      const call = await fetchAllPages(token, url, listKey);
      entry[name] = call.items;
      // The raw pages matter as much as the flattened items: they carry
      // nextPageToken, and whether a facet paginated at all is the fact no
      // gate has ever had.
      entry[`${name}__pages`] = call.pages;
      if (call.denied) entry[`${name}__denied`] = call.denied;
    }
    out.courseData[course.id] = entry;
    console.log(
      `${course.name}: ${entry.courseWork.length} coursework, ` +
      `${entry.courseWorkMaterials.length} materials, ` +
      `${entry.announcements.length} announcements, ` +
      `${entry.topics.length} topics, ` +
      `${entry.submissions.length} submissions`,
    );
  }

  // The two facts that decide whether the fixtures are worth anything.
  const paginated = Object.values(out.courseData)
    .flatMap((c) => Object.entries(c).filter(([k]) => k.endsWith("__pages")).map(([k, v]) => [k, v.length]))
    .filter(([, n]) => n > 1);
  const denied = Object.values(out.courseData)
    .flatMap((c) => Object.keys(c).filter((k) => k.endsWith("__denied")));

  console.log(`\ncaptured ${courses.length} course(s)`);
  console.log(`facets that actually paginated: ${paginated.length ? paginated.map(([k, n]) => `${k}=${n}`).join(", ") : "none"}`);
  console.log(`facets that denied us (403/404): ${denied.length ? denied.join(", ") : "none"}`);
  console.log("\npayload on window.__capture — save as scratchpad/_classroom-raw.json");
  console.warn("RAW: contains your real course content. Do NOT commit it. Redact first.");

  window.__capture = out;
  try {
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    console.log("copied to clipboard");
  } catch {
    console.log("clipboard blocked — use: copy(JSON.stringify(window.__capture, null, 2))");
  }
  return out;
}

window.captureClassroom = captureClassroom;
console.log("ready — run: await captureClassroom()");
