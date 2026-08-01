// live-http.mjs — shared helpers for tests that hit the LIVE deployed site.
//
// Why this exists: a live check can fail for two very different reasons.
//
//   1. The app is broken            → a real regression, must block the loop.
//   2. The edge refused *us*        → Vercel bot/DDoS mitigation challenged the
//                                     test runner. The site is fine for users.
//
// Case 2 looks identical to case 1 if you only read the status code, so the
// autonomous loop used to escalate it into a hard blocker.
//
// Case 2 is not hypothetical here: run logs from 2026-07-26 through 2026-08-01
// repeatedly show HTTP 403 with `x-vercel-mitigated: challenge` against this
// project's production alias. It is Vercel's managed bot protection reacting to
// the runner's datacenter IP in headless Chromium, which cannot solve a
// challenge. A Vercel Firewall bypass rule for the runner IP (added 2026-08-01)
// should make it rare, but rules can lapse — e.g. if the runner's IP changes.
//
// It is INTERMITTENT and NOT caused by deploying. In the 2026-08-01 incident no
// `vercel deploy` ran between the passing pre-deploy check and the failing
// post-deploy one. Do not read "passed before deploy, failed after" as evidence
// that the deploy broke something — that inference cost a day of chasing a
// site that was serving 200 throughout.
//
// So: retry with backoff, and if it STILL looks like mitigation, exit with
// EX_TEMPFAIL (75) meaning "inconclusive" rather than 1 meaning "regression".
// scripts/test.sh maps 75 to a warning, not a gate failure.

/** Exit code meaning "checks could not run", distinct from 1 = real failure. */
export const EXIT_INCONCLUSIVE = 75;

const RETRY_DELAYS_MS = [5000, 20000, 60000];

/** Markers Vercel puts in a challenge/mitigation response body. */
const CHALLENGE_BODY = /vercel security checkpoint|_vercel\/challenge|attack challenge mode/i;

const lower = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[String(k).toLowerCase()] = v;
  return out;
};

/**
 * Decide whether a response is edge mitigation against the runner rather than
 * an application response.
 *
 * Deliberately conservative: the app's own endpoints answer 403 with a JSON
 * body (see api/_helpers.js), and those MUST still count as real failures.
 * We only claim mitigation on positive evidence.
 */
export function isEdgeMitigation(status, headers, body = "") {
  if (status !== 403 && status !== 429) return false;
  const h = lower(headers);
  // Strongest signal: Vercel says so outright.
  if (h["x-vercel-mitigated"]) return true;
  if (h["x-vercel-challenge-token"] || h["x-vercel-challenge-nonce"]) return true;
  // Challenge interstitial served as HTML.
  if (CHALLENGE_BODY.test(String(body))) return true;
  // An API route answering with an HTML page never comes from our code.
  const ctype = String(h["content-type"] || "");
  if (ctype.includes("text/html") && !String(body).trim().startsWith("{")) return true;
  return false;
}

/** Raised when live checks cannot be trusted because the edge blocked us. */
export class EdgeMitigationError extends Error {
  constructor(url, status) {
    super(`edge mitigation: ${status} from ${url} (runner challenged, not an app regression)`);
    this.name = "EdgeMitigationError";
    this.url = url;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const headers = Object.fromEntries(res.headers.entries());
    // Only read the body when we might need it to classify.
    const body = res.status === 403 || res.status === 429 ? await res.text().catch(() => "") : "";
    return { status: res.status, headers, body };
  } catch (e) {
    return { status: 0, headers: {}, body: "", error: e };
  }
}

/**
 * Poll the live origin until it serves a non-mitigated response.
 *
 * Call this ONCE before the real assertions. After a deploy the edge cache is
 * cold, so this doubles as a warm-up: the first request repopulates the cache
 * and subsequent checks are served as HITs, which are far less likely to be
 * challenged.
 *
 * Throws EdgeMitigationError if every attempt is challenged.
 */
export async function waitForLiveReady(baseUrl, { log = console.log } = {}) {
  const url = baseUrl.replace(/\/$/, "") + "/";
  let last = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      log(`  … edge returned ${last.status}; retrying in ${delay / 1000}s (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1})`);
      await sleep(delay);
    }
    last = await probe(url);
    if (last.status >= 200 && last.status < 400) {
      if (attempt > 0) log(`  ✓ edge recovered after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
      return;
    }
    // A non-mitigation error is the app's problem — let the real checks report it.
    if (!isEdgeMitigation(last.status, last.headers, last.body)) return;
  }
  throw new EdgeMitigationError(url, last.status);
}

/**
 * Wrap a live-test main body so mitigation exits 75 instead of 1.
 * Anything else propagates unchanged — real regressions stay loud.
 */
export async function runLiveChecks(fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof EdgeMitigationError) {
      console.error(`\n[live] CHECKS INCONCLUSIVE — ${e.message}`);
      console.error("[live] The site is not known to be broken; the test runner was blocked by");
      console.error("[live] Vercel edge mitigation. Do NOT file this as a production blocker.");
      console.error("[live] Verify by hand from a normal network: curl -sI " + e.url);
      process.exit(EXIT_INCONCLUSIVE);
    }
    throw e;
  }
}
