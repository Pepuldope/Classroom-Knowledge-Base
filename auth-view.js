const PRIVATE_VIEWS = new Set(["kb", "archive"]);

/** Decide whether a Classroom response means the cached account is unusable. */
export function classroomAuthRecoveryModel(status) {
  const code = Number(status);
  return code === 400 || code === 403
    ? { resetSession: true, prompt: "select_account" }
    : { resetSession: false, prompt: null };
}

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
