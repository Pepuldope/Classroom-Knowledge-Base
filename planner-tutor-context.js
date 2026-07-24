export function plannerTutorContextModel(assignment = {}) {
  const title = String(assignment.title || "Assignment").trim() || "Assignment";
  const course = String(assignment.courseName || "").trim();
  const materials = Array.isArray(assignment.materials)
    ? assignment.materials.map((m) => String(m?.title || "Attached material").trim() || "Attached material")
    : [];
  const countLabel = `${materials.length} attached material${materials.length === 1 ? "" : "s"}`;
  return {
    badge: "Grounded in this assignment",
    summary: [title, course, countLabel].filter(Boolean).join(" · "),
    sources: [title, ...materials],
  };
}
