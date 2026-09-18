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
    signal: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1" fill="currentColor"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    tablet: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><line x1="12" x2="12.01" y1="18" y2="18"/>',
    chrome: '<path d="M10.88 21.94 15.46 14"/><path d="M21.17 8H12"/><path d="M3.95 6.06 8.54 14"/><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>',
    flame: '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
    window: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
    briefcase: '<path d="M12 12h.01"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M22 13a18.15 18.15 0 0 1-20 0"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
    // Semantic nods, same as the browsers: the command key for Apple systems,
    // a shell prompt for Linux. Drawn by nobody here — all Lucide geometry.
    command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
    terminal: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>',
  };

  // Event fields come from a public endpoint — never write them as raw HTML.
  const esc = v => String(v ?? '–').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const ico = (id, cls = 'ico') =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ICONS.globe}</svg>`;

  const DEVICE = { desktop: 'monitor', mobile: 'smartphone', tablet: 'tablet' };
  // Semantic nods rather than trademarks: a compass for Safari, a flame for Firefox.
  const BROWSER = { Chrome: 'chrome', Firefox: 'flame', Safari: 'compass', Edge: 'window' };
  const OS = { Windows: 'window', macOS: 'command', iOS: 'command', Android: 'smartphone', Linux: 'terminal' };

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

  // Brand marks are solid glyphs, not stroked like the Lucide set above.
  const MARKS = {
    github: '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
    telegram: '<path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>',
    globe: ICONS.globe,
    briefcase: ICONS.briefcase,
  };
  // Brand marks are filled glyphs; the Lucide ones stay stroked like the rest.
  const SOLID = new Set(['github', 'telegram']);
  const mark = id => `<svg class="ico${SOLID.has(id) ? ' solid' : ''}" viewBox="0 0 24 24" aria-hidden="true">${MARKS[id]}</svg>`;

  // One footer, written once, injected into whichever page has the element —
  // duplicated markup across two pages drifts, this cannot.
  const LINKS = [
    // Not "Portfolio": that site is a services-and-availability page whose
    // portfolio is one section. This label says the thing worth knowing.
    // The globe, not a briefcase: in a footer each icon says what KIND of
    // destination it is — a website, GitHub, Telegram — and the label says what
    // is there. A briefcase would only repeat the label.
    ['globe', 'Hire me', 'https://andriijs.netlify.app'],
    // The profile, not this repository: the footer is about the author, and the
    // page itself links to the source where that is the useful thing.
    ['github', 'GitHub', 'https://github.com/playua20'],
    ['telegram', 'Telegram', 'https://t.me/andriijs'],
  ];
  function footer() {
    const el = document.querySelector('footer.foot');
    if (!el) return;
    el.innerHTML = LINKS.map(([i, label, href]) =>
      `<a href="${href}" target="_blank" rel="noopener">${mark(i)}<span>${label}</span></a>`).join('');
  }
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', footer)
    : footer();

  w.App = { ICONS, esc, ico, mark, DEVICE, BROWSER, OS, countryName, countryCell, iconCell };
})(window);
