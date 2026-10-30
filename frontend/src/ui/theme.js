// Light / dark appearance. The choice is kept per browser and survives signing out,
// which otherwise clears localStorage.
const THEME_KEY = 'iplanet_theme';

function readStored() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

// Server-side renders (tests) have no document and always render light.
export const currentTheme = () => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

// Runs before the first render so the page never flashes the wrong theme.
export function initTheme() {
  apply(readStored() === 'dark' ? 'dark' : 'light');
}

export function setTheme(theme) {
  apply(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable: applies for this visit only */ }
}

// Sign-out and expired sessions clear everything except the appearance choice.
export function clearStorageKeepingTheme() {
  const theme = readStored();
  localStorage.clear();
  if (theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }
}
