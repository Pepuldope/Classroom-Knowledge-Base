const PRIVATE_VIEWS = new Set(["kb"]);

/** Decide whether a routed view may expose user-owned Classroom data. */
export function privateViewDecision(view, accessToken) {
  if (!PRIVATE_VIEWS.has(view) || String(accessToken || "").trim()) {
    return { allowed: true, fallback: null, message: "" };
  }
  return {
    allowed: false,
    fallback: "planner",
    message: "Sign in with Google to open your private Knowledge Base.",
  };
}
