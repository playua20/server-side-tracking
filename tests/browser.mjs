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
// CHROME_PATH lets the suite use a browser that is already on the machine,
// instead of making `npx playwright install` a prerequisite.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);

try {
  for (const [label, width] of [['desktop', 1280], ['phone', 390]]) {
    console.log(`\n${label} (${width}px)`);
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const errors = [], failures = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => failures.push(`${r.url()} ${r.failure()?.errorText}`));
    page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) failures.push(`${r.url()} → ${r.status()}`); });

    const clickid = `${TAG}-${label}`;
    await page.goto(`${BASE}/?clickid=${clickid}&fbclid=IwAR-${clickid}&sub1=camp-${TAG}&sub3=ad-${TAG}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.tile').length > 0, null, { timeout: 20000 });

    ok('tiles render', (await page.locator('.tile').count()) === 5);
    ok('all three charts are drawn', await page.evaluate(() => document.querySelectorAll('canvas').length === 3));
    ok('the click id comes from the URL', (await page.locator('#cid').textContent()) === clickid);
    ok('the status line is not an error', !(await page.locator('#status').textContent()).startsWith('error'));

    await page.locator('#lead').click();
    await page.waitForFunction(() => document.querySelector('#recent tbody tr'), null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    ok('the lead appears in the live tail', (await page.locator('#recent tbody tr').first().textContent()).includes('lead'));

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

  console.log('\nno sideways scrolling, 320px to 1440px');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const bad = [];
    for (const path of ['/', '/events.html']) {
      for (const width of [1440, 1280, 1100, 1000, 980, 900, 860, 840, 800, 768, 720, 700, 640, 560, 480, 430, 390, 360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(BASE + path, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        const over = await page.evaluate(() => {
          const el = document.documentElement;
          const boxes = [...document.querySelectorAll('.log, .feed')]
            .map(b => b.scrollWidth - b.clientWidth).filter(n => n > 0);
          return { page: el.scrollWidth - el.clientWidth, boxes };
        });
        if (over.page || over.boxes.length) bad.push(`${path} @${width}: page +${over.page}, tables ${JSON.stringify(over.boxes)}`);
      }
    }
    ok('nothing overflows on either page at any width', bad.length === 0, bad.slice(0, 3).join(' | '));
    await page.close();
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
