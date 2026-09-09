// harness.mjs — the twenty-five lines every browser gate was copying.
//
// Ten scripts under scripts/ each hand-rolled the same setup: stub
// /api/oauth-config, stub the rest of /api, stub accounts.google.com, stub the
// Classroom endpoints by sniffing the URL, write an auth-session record
// straight into IndexedDB, reload, wait. Every new gate paid that cost again,
// and a change to the sign-in path meant editing ten copies of it — which is
// most of why "just add a test for that" was never cheap here.
//
// Nothing in here is clever. It is the duplication, named once.

/**
 * Stub everything the app talks to.
 *
 * Defaults are the boring case: signed in, one course, no work, no chat
 * history. Pass only what your gate actually cares about.
 */
export async function mockBackend(page, {
  courses = [],
  courseWork = [],
  submissions = [],
  announcements = [],
  materials = [],
  enrichments = [],
  chat = [],
  onChat = null,
} = {}) {
  await page.route("**/api/oauth-config*", (r) => json(r, { hasRefreshTokens: false }));
  await page.route("**/api/prefs**", (r) => json(r, {}));
  await page.route("**/api/chat**", async (r) => {
    if (onChat) await onChat(r);
    return json(r, { messages: chat });
  });
  await page.route("**/api/enrich**", (r) => json(r, { enrichments }));
  await page.route("**/api/user**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  // Anything not named above is a 404 rather than a real request escaping the
  // test — a gate that quietly hits the network is a gate that fails on a train.
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  await page.route("**/accounts.google.com/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("https://www.googleapis.com/oauth2/v3/userinfo", (r) =>
    json(r, { sub: "harness-user", email: "student@example.edu", name: "Test Student" }));
  await page.route("https://classroom.googleapis.com/**", (r) => {
    const url = r.request().url();
    if (url.includes("/courseWork?")) return json(r, { courseWork });
    if (url.includes("studentSubmissions")) return json(r, { studentSubmissions: submissions });
    if (url.includes("courseWorkMaterials")) return json(r, { courseWorkMaterial: materials });
    if (url.includes("/announcements")) return json(r, { announcements });
    if (url.includes("/courses?")) return json(r, { courses });
    return json(r, {});
  });
}

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Sign in, through the app's own storage module.
 *
 * The copies of this wrote the IndexedDB record by hand, which meant every gate
 * encoded the store name, the key path and the record shape. Importing
 * auth-session.js keeps one definition of what a session looks like.
 */
export async function signIn(page, token = "harness-token", ttlSeconds = 3600) {
  await page.evaluate(async ([value, ttl]) => {
    localStorage.setItem("cwa_user_hint", "student@example.edu");
    const { storeAuthSession } = await import("/auth-session.js");
    await storeAuthSession(value, ttl);
  }, [token, ttlSeconds]);
}

/** Put a knowledge-base bundle in the local store, the way a build would. */
export async function seedKb(page, bundle) {
  await page.evaluate(async (value) => {
    const local = await import("/kb-local.js");
    await local.saveKbBundle(value);
  }, bundle);
}

/**
 * A page that is loaded, stubbed, signed in and past the welcome screen.
 *
 * `errors` collects uncaught page errors so a gate can assert on them without
 * wiring its own listener — several forgot to, and silently passed while the
 * page threw.
 */
export async function openSignedInPage(browser, {
  base = process.env.BASE_URL || "http://localhost:4321",
  viewport = { width: 1280, height: 900 },
  hasTouch = false,
  isMobile = false,
  ...backend
} = {}) {
  const page = await browser.newPage({ viewport, hasTouch, isMobile });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await mockBackend(page, backend);
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await signIn(page);
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === true, null, { timeout: 15000 });
  return { page, errors };
}

// ---------------------------------------------------------------------------
// Geometry. Measuring beats screenshotting: a screenshot shows you "messy" and
// costs a lot to look at, while these say "465px of furniture above a 776px
// sheet" — which is the sentence that actually leads to a fix.
// ---------------------------------------------------------------------------

/** Overlapping visible controls inside a container, as readable strings. */
export async function overlappingControls(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [`${sel} not found`];
    const name = (el) => (el.id ? `#${el.id}` : `.${(el.className || "").toString().split(" ")[0]}`)
      + `[${(el.textContent || "").trim().slice(0, 22)}]`;
    const boxes = [...root.querySelectorAll("a, button, input, select, summary, textarea")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ label: name(el), r: el.getBoundingClientRect() }));
    const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const clashes = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const overlap = area(boxes[i].r, boxes[j].r);
        if (overlap > 16) clashes.push(`${boxes[i].label} ∩ ${boxes[j].label} = ${Math.round(overlap)}px²`);
      }
    }
    return clashes;
  }, selector);
}

/** Boxes whose content is wider than they are, and which do not scroll. */
export async function overflowingBoxes(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const name = (el) => (el.id ? `#${el.id}` : `.${(el.className || "").toString().split(" ")[0]}`);
    return [...root.querySelectorAll("*")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible")
      .map((el) => `${name(el)} content ${el.scrollWidth}px in ${el.clientWidth}px`);
  }, selector);
}

/** The height of each direct child of a container, named. */
export async function bandHeights(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    return [...root.children].map((el) => ({
      name: el.id ? `#${el.id}` : `.${(el.className || "").toString().split(" ")[0] || el.tagName.toLowerCase()}`,
      height: Math.round(el.getBoundingClientRect().height),
    }));
  }, selector);
}

/** How many vertical pixels sit between a container's top and one of its parts. */
export async function spaceAbove(page, containerSelector, partSelector) {
  return page.evaluate(([container, part]) => {
    const root = document.querySelector(container);
    const target = document.querySelector(part);
    if (!root || !target) return -1;
    return Math.round(target.getBoundingClientRect().top - root.getBoundingClientRect().top);
  }, [containerSelector, partSelector]);
}
