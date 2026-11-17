// Apply the saved theme before the stylesheet paints. Kept external for the CSP.
try {
  const saved = localStorage.getItem('climate.theme');
  const theme = saved === 'dark' || saved === 'light' ? saved
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
} catch { /* Use the default light palette when storage is unavailable. */ }
