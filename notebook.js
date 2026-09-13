// notebook.js — the Study → Notebook tab, as pure functions.
//
// It replaced "Saved", which listed whole tutor answers with nothing but a date:
// no title, no question, no class, no way back to the notes the answer came
// from, no search. Pinned notes were worse off — "☆ Pin note" stored and synced
// a pin that nothing in the app ever displayed.
//
// Everything a record carries is a string, because the prefs sync
// (prefs-sync.js) merges string fields and nothing else. `sources` is the one
// structured field, so it travels as a compact JSON string and is parsed here.

export const NOTEBOOK_TITLE_MAX = 120;
export const NOTEBOOK_QUESTION_MAX = 400;
export const NOTEBOOK_SOURCES_MAX = 2000;
const OTHER = "Other";

const clean = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const fold = (value) => String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * The stable identity of a note across rebuilds: course | year | title | topic.
 * The same key a pin has always used, so existing pins resolve.
 */
export function noteKey(note) {
  const title = typeof note?.t === "string" ? note.t.trim() : typeof note?.title === "string" ? note.title.trim() : "";
  const id = typeof note?.id === "string" ? note.id.trim() : "";
  const key = id || [note?.course, note?.y, title, note?.topic].map((v) => String(v || "").trim()).join("|");
  return title && key ? key.slice(0, 240) : "";
}

/** Course and year back out of a key; a pin record carries nothing else. */
export function parseNoteKey(key) {
  const parts = String(key || "").split("|");
  if (parts.length < 3) return { course: "", y: "", title: "", topic: "" };
  return { course: parts[0].trim(), y: parts[1].trim(), title: parts[2].trim(), topic: parts.slice(3).join("|").trim() };
}

/** key → index in the current bundle, so a source or pin can open its note. */
export function noteKeyIndex(notes) {
  const map = new Map();
  (Array.isArray(notes) ? notes : []).forEach((note, index) => {
    const key = noteKey(note);
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

/** Encode the notes an answer was grounded in, within the sync field cap. */
export function encodeSources(sources) {
  const out = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    const k = clean(s?.k, 240);
    const t = clean(s?.t, 160);
    if (!k || !t || out.some((x) => x.k === k)) continue;
    const next = [...out, { k, t }];
    if (JSON.stringify(next).length > NOTEBOOK_SOURCES_MAX) break;
    out.push({ k, t });
  }
  return out.length ? JSON.stringify(out) : "";
}

export function decodeSources(value) {
  try {
    const parsed = JSON.parse(typeof value === "string" && value ? value : "[]");
    return Array.isArray(parsed)
      ? parsed.map((s) => ({ k: clean(s?.k, 240), t: clean(s?.t, 160) })).filter((s) => s.k && s.t)
      : [];
  } catch { return []; }
}

/** A title for an answer that was never given one. */
export function defaultAnswerTitle({ question = "", text = "" } = {}) {
  const q = clean(question, NOTEBOOK_TITLE_MAX);
  if (q) return q;
  const firstLine = String(text || "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) || "";
  return clean(firstLine, 80) || "Saved answer";
}

/** Normalise a saved answer. Old records (id, text, savedAt only) still load. */
export function notebookAnswerModel(item) {
  if (!item || typeof item.id !== "string" || !item.id.trim() || typeof item.text !== "string" || !item.text.trim()) return null;
  const question = clean(item.question, NOTEBOOK_QUESTION_MAX);
  const text = item.text.trim();
  return {
    id: item.id.trim(),
    text,
    savedAt: Number.isFinite(Number(item.savedAt)) ? Number(item.savedAt) : 0,
    title: clean(item.title, NOTEBOOK_TITLE_MAX) || defaultAnswerTitle({ question, text }),
    question,
    course: clean(item.course, 160),
    sources: typeof item.sources === "string" ? item.sources : "",
  };
}

/** The class an answer belongs to: the open note's, else its sources' commonest. */
export function answerCourse({ focusCourse = "", sources = [] } = {}) {
  if (clean(focusCourse, 160)) return clean(focusCourse, 160);
  const counts = new Map();
  for (const s of Array.isArray(sources) ? sources : []) {
    const course = clean(s?.course, 160) || parseNoteKey(s?.k).course;
    if (course) counts.set(course, (counts.get(course) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
}

/** Rename one answer. A blank title falls back to the default rather than vanishing. */
export function renameAnswer(list, id, title) {
  return (Array.isArray(list) ? list : []).map((item) => {
    if (item?.id !== id) return item;
    const model = notebookAnswerModel(item);
    const next = clean(title, NOTEBOOK_TITLE_MAX);
    return { ...item, title: next || defaultAnswerTitle(model || {}) };
  });
}

/**
 * What the Notebook shows: answers and pins, grouped by class, filtered by a
 * search over title, question, text and class. Groups alphabetical with "Other"
 * last; newest answers first inside a group, then pins, most recent pin first.
 */
export function notebookModel({ answers = [], pins = [], notes = [], query = "" } = {}) {
  const index = noteKeyIndex(notes);
  const needle = fold(query).trim();
  const matches = (...fields) => !needle || fold(fields.join(" ")).includes(needle);
  const groups = new Map();
  const add = (course, item) => {
    const label = course || OTHER;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  };
  let total = 0;

  for (const raw of Array.isArray(answers) ? answers : []) {
    const a = notebookAnswerModel(raw);
    if (!a) continue;
    total++;
    const sources = decodeSources(a.sources).map((s) => ({ title: s.t, key: s.k, noteIndex: index.has(s.k) ? index.get(s.k) : null }));
    if (!matches(a.title, a.question, a.text, a.course, sources.map((s) => s.title).join(" "))) continue;
    add(a.course, { kind: "answer", id: a.id, title: a.title, question: a.question, text: a.text, savedAt: a.savedAt, sources });
  }
  const pinList = Array.isArray(pins) ? pins : [];
  pinList.forEach((pin, order) => {
    const key = typeof pin?.id === "string" ? pin.id : "";
    const title = clean(pin?.title, 240);
    if (!key || !title) return;
    total++;
    const parsed = parseNoteKey(key);
    if (!matches(title, parsed.course, parsed.topic)) return;
    add(parsed.course, { kind: "pin", id: key, title, y: parsed.y, topic: parsed.topic, order, noteIndex: index.has(key) ? index.get(key) : null });
  });

  const shown = [...groups.values()].reduce((n, items) => n + items.length, 0);
  return {
    total,
    shown,
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a === OTHER) - (b === OTHER) || a.localeCompare(b))
      .map(([course, items]) => ({
        course,
        items: items.sort((x, y) => (x.kind === y.kind
          ? (x.kind === "answer" ? y.savedAt - x.savedAt : y.order - x.order)
          : x.kind === "answer" ? -1 : 1)),
      })),
  };
}
