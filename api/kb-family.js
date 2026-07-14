// kb-family.js — derive a coarse "class type" (family) facet from a course
// name. The live vault corpus arrives WITHOUT a `family` field on notes, so the
// focus-area-7 class-type filter would be empty. We derive it from the course
// name with a small ordered rule list. Pure + exported so both the storage
// layer (appendBundle persists the family) and the search layer (kb-search
// derives it on the fly) can reuse the exact same mapping.

// Order matters: first match wins. Coarser/dominant subjects first.
const FAMILY_RULES = [
  [/beng|b\.?eng|engineering/i, "Engineering"],
  [/digi|datab[aá]zy|informat|computer|program/i, "Digital/IT"],
  [/ela|english|jazyk|kuj|sloven|language/i, "Language"],
  [/fyzika|physics|chem|biol|math|matemat|maturita/i, "Science/Math"],
  [/glo|geograf|hist|dejepis|spolo|humanit/i, "Humanities"],
  [/business|ekonom|strateg/i, "Business"],
  [/bud[uú]cnos?[ťt]|future|career|kari[eé]r/i, "Careers"],
  [/v[šs]?pv|u[cč]itel|pedagog/i, "Teaching"],
  [/šport|sport|telocvik|\bpe\b/i, "PE"],
  [/v[ýy]tvar|hudob|hudba|art|music|drama/i, "Arts"],
];

// Returns "" when no rule matches (caller decides whether to store or skip).
export function deriveFamily(course = "") {
  const c = String(course || "");
  for (const [re, fam] of FAMILY_RULES) if (re.test(c)) return fam;
  return "";
}
