const CLEARED_MESSAGE = "Your local knowledge base was cleared and is now empty. Build it again from Google Classroom when ready.";

export function kbLocalStatusModel(state = "") {
  if (state === "cleared") return { message: CLEARED_MESSAGE, tone: "polite" };
  return { message: "", tone: "polite" };
}
