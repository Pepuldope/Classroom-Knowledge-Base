const CLEARED_MESSAGE = "Your local knowledge base was cleared and is now empty. Build it again from Google Classroom when ready.";

export function kbLocalStatusModel(state = "") {
  if (state === "cleared") return { message: CLEARED_MESSAGE, tone: "polite", focusTarget: "kbBuildBtn" };
  return { message: "", tone: "polite" };
}

export function kbBuildProgressStatusModel({ message = "", done = 0, total = 0 } = {}) {
  const label = String(message || "Building your knowledge base…").trim();
  const count = Number.isFinite(done) && Number.isFinite(total) && total > 0
    ? ` (${Math.max(0, Math.floor(done))} of ${Math.floor(total)} courses)`
    : "";
  return { message: `${label}${count}`, tone: "polite", live: "polite" };
}
