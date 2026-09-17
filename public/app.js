/*!
 * Shared helpers for the dashboard and the event log.
 *
 * Icons are Lucide geometry (ISC) inlined per icon: no external SVG behind a
 * url()/mask, nothing that can 404 on a built site, and no <use> that would
 * depend on a sprite existing before the markup is parsed.
 */
(function (w) {
  "use strict";

  const ICONS = {
    signal: '<circle cx="6" cy="18" r="2.4" fill="currentColor" stroke="none"/><path d="M12.5 18a8.5 8.5 0 0 0-6.5-8.3"/><path d="M19 18A15 15 0 0 0 6 3.2"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    tablet: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><line x1="12" x2="12.01" y1="18" y2="18"/>',
    chrome: '<path d="M10.88 21.94 15.46 14"/><path d="M21.17 8H12"/><path d="M3.95 6.06 8.54 14"/><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>',
    flame: '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
    window: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    apple: '<path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"/><path d="M10 2c1 .5 2 2 2 5"/>',
    penguin: '<path d="M12 2a5 5 0 0 0-5 5v3.5c0 1-.5 2-1.2 2.8A4 4 0 0 0 5 16v3a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-3a4 4 0 0 0-.8-2.7c-.7-.8-1.2-1.8-1.2-2.8V7a5 5 0 0 0-5-5Z"/><path d="M10 8h.01"/><path d="M14 8h.01"/>',
  };

  // Event fields come from a public endpoint — never write them as raw HTML.
  const esc = v => String(v ?? '–').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const ico = (id, cls = 'ico') =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ICONS.globe}</svg>`;

  const DEVICE = { desktop: 'monitor', mobile: 'smartphone', tablet: 'tablet' };
  // Semantic nods rather than trademarks: a compass for Safari, a flame for Firefox.
  const BROWSER = { Chrome: 'chrome', Firefox: 'flame', Safari: 'compass', Edge: 'window' };
  const OS = { Windows: 'window', macOS: 'apple', iOS: 'apple', Android: 'smartphone', Linux: 'penguin' };

  // ISO code → readable name, straight from the browser's own locale data.
  const NAMES = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  const countryName = c => {
    if (!c || c.length !== 2) return null;
    try { return NAMES ? NAMES.of(c) : null; } catch (e) { return null; }
  };

  function countryCell(code) {
    if (!code || code.length !== 2) return `<span class="cell">${ico('globe')}${esc(code)}</span>`;
    const name = countryName(code) || code;
    return `<span class="cell" title="${esc(name)}">` +
      `<img class="flag" src="https://flagcdn.com/w40/${code.toLowerCase()}.png" alt="" loading="lazy" width="18" height="13">` +
      `<span class="t">${esc(code)}</span></span>`;
  }

  // The label is dropped where the column is tight (see .dash .cell .t) — the
  // icon carries the meaning there, and the title attribute keeps it readable.
  const iconCell = (map, value, fallback) =>
    `<span class="cell" title="${esc(value)}">${ico(map[value] || fallback)}<span class="t">${esc(value)}</span></span>`;

  w.App = { ICONS, esc, ico, DEVICE, BROWSER, OS, countryName, countryCell, iconCell };
})(window);
