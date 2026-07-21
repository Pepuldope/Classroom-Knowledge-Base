// Pure, browser-local study activity model used by the Knowledge Base streak card.
const DAY_MS = 24 * 60 * 60 * 1000;

function dateValue(date) {
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) ? value : NaN;
}

function isCalendarDate(date) {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(dateValue(date)) && new Date(dateValue(date)).toISOString().slice(0, 10) === date;
}

function validDates(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(isCalendarDate))].sort();
}

export function recordStudyActivity(value, date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return validDates(value);
  return validDates([...(Array.isArray(value) ? value : []), date]);
}

export function studyStreakModel(value, today) {
  const dates = validDates(value);
  const lastDate = dates.at(-1) || null;
  const todayValue = dateValue(today);
  const lastValue = dateValue(lastDate);
  let current = 0;
  if (Number.isFinite(todayValue) && Number.isFinite(lastValue) && todayValue - lastValue <= DAY_MS && todayValue >= lastValue) {
    const dateSet = new Set(dates);
    let cursor = todayValue;
    if (!dateSet.has(today)) cursor -= DAY_MS;
    while (dateSet.has(new Date(cursor).toISOString().slice(0, 10))) {
      current += 1;
      cursor -= DAY_MS;
    }
  }
  return { current, activeToday: lastDate === today, lastDate };
}
