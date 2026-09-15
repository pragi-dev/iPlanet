const INDIA_TIME_ZONE = 'Asia/Kolkata';

function indiaParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: INDIA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(now);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function iso({ year, month, day }) { return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T12:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
function addDays(date, days) { const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + days); return next.toISOString().slice(0, 10); }

export function indiaToday(now = new Date()) { const parts = indiaParts(now); return iso(parts); }
export function resolveServiceDateIntent(intent, now = new Date()) {
  const raw = String(intent || '').trim();
  if (!raw) return { date: null, ambiguous: false };
  const today = indiaToday(now); const lower = raw.toLowerCase();
  if (/\bday after tomorrow\b/.test(lower)) return { date: addDays(today, 2), ambiguous: false };
  if (/\btomorrow\b/.test(lower)) return { date: addDays(today, 1), ambiguous: false };
  if (/\b(next week|this week)\b/.test(lower)) return { date: null, ambiguous: true };
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const weekday = weekdays.find(day => new RegExp(`\\b(?:next\\s+)?${day}\\b`).test(lower));
  if (weekday) { const current = new Date(`${today}T12:00:00Z`).getUTCDay(); let offset = (weekdays.indexOf(weekday) - current + 7) % 7; if (offset === 0) offset = 7; return { date: addDays(today, offset), ambiguous: false }; }
  const explicit = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (explicit && validDate(explicit[0]) && explicit[0] >= today) return { date: explicit[0], ambiguous: false };
  const named = raw.match(/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i) || raw.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/i);
  if (named) { const monthName = Number.isNaN(Number(named[1])) ? named[1] : named[2]; const day = Number(Number.isNaN(Number(named[1])) ? named[2] : named[1]); const specifiedYear = Number(named[3] || 0); const month = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(monthName.toLowerCase()) + 1; let year = specifiedYear || Number(today.slice(0, 4)); let candidate = iso({ year, month, day }); if (!validDate(candidate)) return { date: null, ambiguous: true }; if (!specifiedYear && candidate < today) { year += 1; candidate = iso({ year, month, day }); } return { date: candidate >= today ? candidate : null, ambiguous: candidate < today }; }
  return { date: null, ambiguous: false };
}

export { INDIA_TIME_ZONE };
