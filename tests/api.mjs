/**
 * End-to-end API tests against a deployed instance.
 *
 *   node --env-file=.env.local tests/api.mjs [base-url]
 *
 * They run against the real thing — real HTTP, real Postgres — and delete every
 * row they create. Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (for the
 * assertions and the cleanup), POSTBACK_TOKEN and CRON_TOKEN.
 */
import { createClient } from '@supabase/supabase-js';

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://server-side-pixel.vercel.app').replace(/\/$/, '');
const { POSTBACK_TOKEN: TOKEN, CRON_TOKEN: CRON, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TOKEN || !CRON) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, POSTBACK_TOKEN, CRON_TOKEN');
  process.exit(2);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};
const section = t => console.log('\n' + t);

// The tracking endpoint ignores crawlers, so a suite that wants its events
// stored has to look like a browser. Anything else would be testing the filter
// rather than the thing behind it.
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const get = async path => { const r = await fetch(BASE + path); return [r.status, await r.json().catch(() => ({}))]; };
const post = async (path, body, type = 'text/plain', ua = BROWSER) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': type, 'User-Agent': ua }, body });
  return [r.status, await r.json().catch(() => ({}))];
};

// Everything this run creates is tagged, so cleanup needs no bookkeeping.
const TAG = 'itest-' + Math.random().toString(36).slice(2, 8);

try {
  section('track: the public endpoint accepts events and refuses junk');
  {
    const [c1] = await post('/api/track', JSON.stringify({ type: 'lead', site: TAG, clickid: TAG,
      fbclid: 'IwAR-' + TAG, fbp: 'fb.1.1758150000.1234567890', sub1: 'camp-' + TAG, sub3: 'ad-' + TAG }));
    ok('a valid event is stored', c1 === 200);
    const [c2, b2] = await post('/api/track', JSON.stringify({ type: 'whatever' }));
    ok('an unknown event type is refused', c2 === 400, b2.error);
    const [c3] = await post('/api/track', JSON.stringify({ type: 'test', sub1: 'x'.repeat(2100) }));
    ok('an oversized body is refused', c3 === 413);

    // Crawlers answer 200 so they learn nothing, but nothing is written.
    const before = (await db.from('events').select('*', { count: 'exact', head: true })).count;
    for (const ua of ['Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
                      'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0.0.0 Safari/537.36',
                      'TelegramBot (like TwitterBot)', '']) {
      const [code, body] = await post('/api/track', JSON.stringify({ type: 'pageview', site: TAG + '-bot' }), 'text/plain', ua);
      ok(`ignored: ${ua.slice(0, 34) || '(no user-agent)'}`, code === 200 && body.ignored === 'bot');
    }
    const after = (await db.from('events').select('*', { count: 'exact', head: true })).count;
    ok('and none of them reached the table', after === before, `${before} → ${after}`);
  }

  section('events: keyset pagination walks the table exactly once');
  {
    const seen = [];
    let [, page] = await get('/api/events?limit=3');
    ok('the first page carries the filter lists', Array.isArray(page.types) && Array.isArray(page.countries));
    let guard = 0;
    while (true) {
      seen.push(...page.rows.map(r => r.id));
      if (!page.next || ++guard > 200) break;
      [, page] = await get('/api/events?limit=3&before=' + encodeURIComponent(page.next));
    }
    const all = (await db.from('events').select('id')
      .order('created_at', { ascending: false }).order('id', { ascending: false })).data.map(r => r.id);
    ok('every row, in order, no duplicates', JSON.stringify(seen) === JSON.stringify(all), `${seen.length} vs ${all.length}`);
    const [, garbage] = await get('/api/events?limit=3&before=nonsense');
    ok('a malformed cursor is ignored, not obeyed', garbage.rows.length === 3);
  }

  section('capi-sink: the stand-in answers with the platform contract');
  {
    const valid = JSON.stringify({ data: [{ event_name: 'Lead', event_time: 1 }] });
    const [c1, b1] = await post('/api/capi-sink', JSON.stringify({ nope: 1 }), 'application/json');
    ok('a malformed payload is a 400 with an error object', c1 === 400 && b1.error?.code === 100);
    const [c2, b2] = await post('/api/capi-sink', valid, 'application/json');
    ok('a valid payload is accepted', c2 === 200 && b2.events_received === 1);
    ok('it never claims to be Meta', b2.stand_in === true);
    const [c3] = await post('/api/capi-sink?fail=1', valid, 'application/json');
    ok('?fail=1 fails, so retries can be exercised', c3 === 500);
    const [c4] = await get('/api/capi-sink');
    ok('GET is rejected', c4 === 405);
  }

  section('postback: validation');
  {
    const q = extra => `/api/postback?${extra}`;
    ok('no token → 401', (await get(q(`clickid=${TAG}&txid=${TAG}-a`)))[0] === 401);
    ok('wrong token → 401', (await get(q(`token=nope&clickid=${TAG}&txid=${TAG}-a`)))[0] === 401);
    ok('no clickid → 400', (await get(q(`token=${TOKEN}&txid=${TAG}-a`)))[0] === 400);
    ok('no txid → 400', (await get(q(`token=${TOKEN}&clickid=${TAG}`)))[0] === 400);
    ok('unknown status → 400', (await get(q(`token=${TOKEN}&clickid=${TAG}&txid=${TAG}-a&status=paid`)))[0] === 400);
    ok('payout out of range → 400', (await get(q(`token=${TOKEN}&clickid=${TAG}&txid=${TAG}-a&payout=99999`)))[0] === 400);
  }

  section('postback: attribution, idempotency, reversal');
  {
    const [c1, b1] = await get(`/api/postback?token=${TOKEN}&clickid=${TAG}&txid=${TAG}-1&payout=9.99&status=approved&email=Test%40Example.COM&phone=%2B38%20067%20123-45-67`);
    ok('accepted', c1 === 200 && b1.ok);
    ok('matched to the click we stored', b1.matched === true);
    ok('reported outward in the same call', b1.capi?.status === 'delivered', JSON.stringify(b1.capi));

    // The retry deliberately omits e-mail and phone: a network often repeats a
    // postback with fewer parameters, and that must not erase what we have.
    const [, b2] = await get(`/api/postback?token=${TOKEN}&clickid=${TAG}&txid=${TAG}-1&payout=9.99&status=approved`);
    ok('a retry does not create a second conversion', b2.repeated === true);
    ok('and its delivery is suppressed as a duplicate', b2.capi?.skipped === 'duplicate event_id');
    const kept = (await db.from('conversions').select('em_hash,ph_hash,sub1,matched').eq('txid', TAG + '-1').maybeSingle()).data;
    ok('a thinner retry does not erase the hashes or the attribution',
      kept.em_hash?.length === 64 && kept.ph_hash?.length === 64 && kept.sub1 === 'camp-' + TAG && kept.matched === true,
      JSON.stringify({ em: !!kept.em_hash, ph: !!kept.ph_hash, sub1: kept.sub1, matched: kept.matched }));

    const [, b3] = await get(`/api/postback?token=${TOKEN}&clickid=${TAG}&txid=${TAG}-2&payout=4.5&status=pending`);
    ok('a pending conversion is not reported outward', b3.capi === undefined);
    const [, b4] = await get(`/api/postback?token=${TOKEN}&clickid=${TAG}&txid=${TAG}-2&payout=4.5&status=rejected`);
    ok('a reversal updates the same conversion', b4.repeated === true && b4.was === 'pending');

    const [, b5] = await get(`/api/postback?token=${TOKEN}&clickid=no-such-click-${TAG}&txid=${TAG}-3&payout=1&status=approved`);
    ok('a postback for an unseen click is kept, flagged unmatched', b5.matched === false);
  }

  section('capi: what was actually sent');
  {
    const conv = (await db.from('conversions').select('id,em_hash,ph_hash').eq('txid', TAG + '-1').maybeSingle()).data;
    const del = (await db.from('capi_deliveries').select('*').eq('event_id', 'conv-' + conv.id).maybeSingle()).data;
    const sent = del.request.data[0];
    const raw = JSON.stringify(del.request).toLowerCase();
    ok('event_id is the dedupe key shared with the pixel', sent.event_id === 'conv-' + conv.id);
    ok('fbc is fb.1.<clickTime>.<fbclid>', new RegExp(`^fb\\.1\\.\\d{10}\\.IwAR-${TAG}$`).test(sent.user_data.fbc), sent.user_data.fbc);
    ok('fbp is passed through unchanged', sent.user_data.fbp === 'fb.1.1758150000.1234567890');
    ok('e-mail and phone are 64-char hashes', sent.user_data.em?.[0]?.length === 64 && sent.user_data.ph?.[0]?.length === 64);
    ok('no readable e-mail or phone in the payload', !raw.includes('test@example.com') && !raw.includes('380671234567'));
    ok('the database stores hashes only', conv.em_hash?.length === 64 && conv.ph_hash?.length === 64);
    ok('value and currency are carried', sent.custom_data.value === 9.99 && sent.custom_data.currency === 'USD');
    ok('event_time is recent and inside the 7-day window', sent.event_time > Math.floor(Date.now() / 1000) - 600);
    ok('the answer is recorded', del.http_status === 200 && del.response?.events_received === 1, del.latency_ms + 'ms');
  }

  section('capi-retry: a failed delivery is swept up later');
  {
    const conv = (await db.from('conversions').select('id').eq('txid', TAG + '-3').maybeSingle()).data;
    // Put the row into the state a real upstream outage leaves behind.
    await db.from('capi_deliveries').update({
      status: 'pending', http_status: 500, attempts: 1,
      response: { error: { message: 'simulated outage' } },
      next_try_at: new Date(Date.now() - 60_000).toISOString(),
    }).eq('event_id', 'conv-' + conv.id);

    ok('the sweeper refuses an unauthenticated call', (await get('/api/capi-retry'))[0] === 401);
    const [c, b] = await get('/api/capi-retry?token=' + CRON);
    ok('authenticated, and it picked the due delivery', c === 200 && b.retried >= 1, JSON.stringify(b.results?.[0] || {}));
    const after = (await db.from('capi_deliveries').select('status,attempts,http_status').eq('event_id', 'conv-' + conv.id).maybeSingle()).data;
    ok('now delivered, with the attempt counter advanced', after.status === 'delivered' && after.attempts === 2, JSON.stringify(after));
  }

  section('stats: the dashboard gets what it draws');
  {
    const [, st] = await get('/api/stats');
    for (const k of ['total', 'visitors', 'byType', 'byCountry', 'byDevice', 'byHour', 'recent', 'conversions', 'byAd', 'capi', 'deliveries', 'sites']) {
      ok(`${k} present`, st[k] !== undefined);
    }
    ok('revenue counts approved conversions only', st.conversions.revenue >= 9.99);
    ok('the per-ad report includes this run\'s campaign', st.byAd.some(a => a.campaign === 'camp-' + TAG));
  }

  section('stats: the period and source filters actually filter');
  {
    const [, all] = await get('/api/stats?period=all');
    const [, mine] = await get(`/api/stats?site=${TAG}`);
    ok('this run\'s source is offered in the list', (all.sites || []).includes(TAG), JSON.stringify(all.sites));
    ok('filtering by source narrows the totals', mine.total < all.total && mine.total >= 1, `${mine.total} of ${all.total}`);
    ok('and only this run\'s events are counted', mine.byType.every(t => ['lead', 'pageview', 'click', 'test'].includes(t.type)) && mine.total === 1, JSON.stringify(mine.byType));
    ok('its one event is the click we stored', mine.recent[0]?.site === TAG);

    const [, hour] = await get('/api/stats?period=24h');
    ok('a period never exceeds all time', hour.total <= all.total);
    const [, junk] = await get('/api/stats?period=nonsense&site=<script>');
    ok('rubbish filters fall back instead of failing', junk.period === '30d' && junk.site === null, JSON.stringify({ p: junk.period, s: junk.site }));

    const [, logged] = await get(`/api/events?limit=50&site=${TAG}`);
    ok('the log filters by source as well', logged.rows.length === 1 && logged.rows[0].site === TAG, `${logged.rows.length} row(s)`);
    ok('the log offers the source list too', (logged.sites || []).includes(TAG));
  }
} finally {
  section('cleanup');
  const ids = (await db.from('conversions').select('id').or(`txid.like.${TAG}%,clickid.like.%${TAG}`)).data?.map(r => r.id) || [];
  const d1 = ids.length ? await db.from('capi_deliveries').delete().in('conversion_id', ids).select('id') : { data: [] };
  const d2 = await db.from('conversions').delete().or(`txid.like.${TAG}%,clickid.like.%${TAG}`).select('id');
  const d3 = await db.from('events').delete().eq('site', TAG).select('id');
  console.log(`  removed: ${d1.data?.length || 0} deliveries, ${d2.data?.length || 0} conversions, ${d3.data?.length || 0} events`);
  console.log(`\n${pass} passed, ${fail} failed`);
}

process.exit(fail ? 1 : 0);
