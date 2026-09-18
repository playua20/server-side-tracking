/**
 * Browser tests against a deployed instance.
 *
 *   node --env-file=.env.local tests/browser.mjs [base-url]
 *
 * Drives the dashboard the way a visitor does — arrive on a landing URL with ad
 * macros, send a lead, fire the postback the page prints, watch the delivery
 * appear — at desktop and phone width, and checks that nothing overflows
 * sideways at any width in between. Rows created here are deleted afterwards.
 *
 * Needs playwright (devDependency) and the same env as tests/api.mjs.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://server-side-pixel.vercel.app').replace(/\/$/, '');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const TAG = 'btest-' + Math.random().toString(36).slice(2, 8);
// Playwright announces HeadlessChrome, which the endpoint ignores as a crawler.
// A suite checking what a visitor sees has to arrive as one.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// CHROME_PATH lets the suite use a browser that is already on the machine,
// instead of making `npx playwright install` a prerequisite.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);

try {
  for (const [label, width] of [['desktop', 1280], ['phone', 390]]) {
    console.log(`\n${label} (${width}px)`);
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1, userAgent: BROWSER_UA });
    const errors = [], failures = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => failures.push(`${r.url()} ${r.failure()?.errorText}`));
    page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) failures.push(`${r.url()} → ${r.status()}`); });

    const clickid = `${TAG}-${label}`;
    await page.goto(`${BASE}/?clickid=${clickid}&fbclid=IwAR-${clickid}&sub1=camp-${TAG}&sub3=ad-${TAG}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.tile').length > 0, null, { timeout: 20000 });

    ok('tiles render', (await page.locator('.tile').count()) === 6);
    ok('all three charts are drawn', await page.evaluate(() => document.querySelectorAll('canvas').length === 3));
    ok('the click id comes from the URL', (await page.locator('#cid').textContent()) === clickid);
    ok('the status line is not an error', !(await page.locator('#status').textContent()).startsWith('error'));

    // Wait for the row itself, not for a duration: the page refreshes once
    // immediately and again a beat later, and the write can land in between.
    await page.locator('#lead').click();
    const landed = await page.waitForFunction(
      () => document.querySelector('#recent tbody tr')?.textContent.includes('lead'),
      null, { timeout: 20000 }).then(() => true, () => false);
    ok('the lead appears in the live tail', landed);

    // The network's half, fired from outside the browser using the page's own command.
    const url = (await page.locator('#pbCmd').textContent()).match(/https?:\/\/[^"]+/)[0];
    const answer = await (await fetch(url)).json();
    ok('the printed postback command works', answer.ok === true && answer.matched === true);
    ok('and the conversion was reported outward', answer.capi?.status === 'delivered', JSON.stringify(answer.capi));

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#capi tbody tr').length > 0, null, { timeout: 20000 });
    await page.locator('#capi [data-open]').first().click();
    const payload = await page.locator('#capi tr.payload .code').first().textContent();
    ok('the payload opens and is the real one', payload.includes('"event_name": "Lead"') && payload.includes('fb.1.'));
    ok('it carries no readable e-mail or phone', !/@|\+\d{8}/.test(payload));
    ok('the per-ad report shows this campaign', (await page.locator('#byAd tbody').textContent()).includes('camp-' + TAG));

    ok('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    ok('no failed requests', failures.length === 0, failures.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\nthe snippet on a page that is not ours');
  {
    // A stand-in lander: nothing but the snippet and a form, on a blank origin,
    // which is also the cross-domain case.
    const site = TAG + '-lander';
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, userAgent: BROWSER_UA });
    await page.goto('about:blank');
    await page.setContent(`<form id="order" name="order"><input name="email"><button>send</button></form>
      <script src="${BASE}/t.js" data-site="${site}" data-lead-form="#order" defer></script>`);
    await page.waitForFunction(() => typeof window.track === 'function', null, { timeout: 15000 });
    ok('the snippet exposes window.track', true);

    // Stop the navigation only — our handler runs on capture, so it has fired.
    await page.evaluate(() => document.addEventListener('submit', e => e.preventDefault()));
    await page.locator('#order button').click();

    const waitFor = async (type) => {
      for (let i = 0; i < 20; i++) {
        const { data } = await db.from('events').select('type,site,device,country').eq('site', site).eq('type', type).maybeSingle();
        if (data) return data;
        await new Promise(r => setTimeout(r, 500));
      }
      return null;
    };
    const lead = await waitFor('lead');
    ok('submitting the form records a lead', Boolean(lead), JSON.stringify(lead));

    await page.evaluate(() => window.track('click', { sub1: 'manual-call' }));
    ok('a manual window.track call records too', Boolean(await waitFor('click')));

    const del = await db.from('events').delete().eq('site', site).select('id');
    console.log(`  (removed ${del.data?.length || 0} events from the stand-in lander)`);
    await page.close();
  }

  console.log('\nno sideways scrolling, 320px to 1440px');
  {
    const bad = [];
    for (const path of ['/', '/events.html']) {
      for (const width of [1440, 1280, 1100, 1000, 980, 900, 860, 840, 800, 768, 720, 700, 640, 560, 480, 430, 390, 360, 320]) {
        // A fresh tab per width: resizing one tab leaves the charts holding the
        // previous width for a moment, which reads as an overflow that no
        // visitor would ever see.
        const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1, userAgent: BROWSER_UA });
        await page.goto(BASE + path, { waitUntil: 'load' });
        // Only the page itself must never scroll sideways. A table inside a
        // labelled scroll box is allowed to: campaign ids and payload strings
        // are arbitrary data, and boxing them is the deliberate answer.
        const measure = () => page.evaluate(() => {
          const el = document.documentElement;
          return { page: el.scrollWidth - el.clientWidth, boxes: [] };
        });
        // Poll until the layout settles: charts resize a beat after load, and on
        // a slow load that beat can be a second or more. Only an overflow that
        // is still there after five seconds is a real one — a test that reports
        // the settling moment is a test nobody trusts.
        await page.waitForTimeout(300);
        let over = await measure();
        for (let waited = 0; (over.page || over.boxes.length) && waited < 5000; waited += 500) {
          await page.waitForTimeout(500);
          over = await measure();
        }
        if (over.page || over.boxes.length) bad.push(`${path} @${width}: page +${over.page}, tables ${JSON.stringify(over.boxes)}`);
        await page.close();
      }
    }
    ok('nothing overflows on either page at any width', bad.length === 0, bad.slice(0, 3).join(' | '));
  }
} finally {
  await browser.close();
  console.log('\ncleanup');
  const ids = (await db.from('conversions').select('id').like('clickid', TAG + '%')).data?.map(r => r.id) || [];
  const d1 = ids.length ? await db.from('capi_deliveries').delete().in('conversion_id', ids).select('id') : { data: [] };
  const d2 = await db.from('conversions').delete().like('clickid', TAG + '%').select('id');
  const d3 = await db.from('events').delete().like('clickid', TAG + '%').select('id');
  console.log(`  removed: ${d1.data?.length || 0} deliveries, ${d2.data?.length || 0} conversions, ${d3.data?.length || 0} events`);
  console.log(`\n${pass} passed, ${fail} failed`);
}

process.exit(fail ? 1 : 0);
