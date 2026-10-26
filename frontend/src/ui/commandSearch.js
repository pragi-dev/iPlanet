// Matching rule for the command bar: every term must appear in the entry.
export function searchTerms(query) {
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matches(entry, terms) {
  if (!terms.length) return true;
  const haystack = `${entry.title} ${entry.subtitle || ''} ${entry.keywords || ''}`.toLowerCase();
  return terms.every(term => haystack.includes(term));
}
