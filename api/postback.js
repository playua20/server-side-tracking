import { createClient } from '@supabase/supabase-js';
import { ipHash, overLimit, pruneSometimes } from './_shared.js';
import { hashEmail, hashPhone } from './_capi.js';
import { deliverConversion, refundConversion } from './_deliver.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * S2S postback receiver — the money half of a tracker.
 *
 * An affiliate network calls this when a lead is approved, rejected or still
 * pending. It knows only its own clickid and transaction id; everything about
 * the traffic source (campaign, adset, ad) is already on the click we stored,
 * so matching by clickid is what turns "a conversion happened" into "this ad
 * paid".
 *
 * Networks call it with a plain GET, retry on any non-200, and expect a tiny
 * body — so the contract here is: always answer fast, answer 200 for anything
 * we have accepted (including a retry), and never make a retry create a second
 * payout.
 */
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const MAX_PAYOUT = 10000;
const MAX_PER_MINUTE = 10;   // the demo token is public, so the caller is limited
const KEEP_DAYS = 30;
const TOKEN = process.env.POSTBACK_TOKEN || '';

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Networks send GET; some send POST. Both are the same call.
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const p = { ...(req.query || {}), ...(typeof req.body === 'object' ? req.body : {}) };

  // A postback endpoint without a shared secret is an invitation to write
  // yourself any revenue you like. Networks all support a static token.
  if (!TOKEN || String(p.token || '') !== TOKEN) {
    return res.status(401).json({ ok: false, error: 'bad or missing token' });
  }

  const clickid = str(p.clickid || p.click_id || p.cid, 128);
  const txid = str(p.txid || p.transaction_id || p.conversion_id, 128);
  const status = String(p.status || 'approved').toLowerCase();
  const payout = Number(p.payout ?? p.sum ?? 0);
  const currency = /^[A-Za-z]{3}$/.test(p.currency || '') ? String(p.currency).toUpperCase() : 'USD';

  if (!clickid) return res.status(400).json({ ok: false, error: 'clickid is required' });
  if (!txid) return res.status(400).json({ ok: false, error: 'txid is required (idempotency)' });
  if (!STATUSES.has(status)) return res.status(400).json({ ok: false, error: 'status must be pending, approved or rejected' });
  if (!Number.isFinite(payout) || payout < 0 || payout > MAX_PAYOUT) {
    return res.status(400).json({ ok: false, error: 'payout out of range' });
  }

  try {
    const ip_hash = ipHash(req);
    if (await overLimit(supabase, 'conversions', ip_hash, MAX_PER_MINUTE)) {
      return res.status(429).json({ ok: false, error: 'too many postbacks' });
    }

    // Was this txid seen before? Comparing created_at with updated_at cannot
    // answer that — they differ by milliseconds on an insert too — so ask
    // directly. It is one indexed lookup, and it lets the answer say what the
    // status used to be, which is what you want when auditing a network.
    const { data: existing } = await supabase.from('conversions')
      .select('id,status').eq('txid', txid).maybeSingle();

    // Attribution: the FIRST event carrying this clickid is the click itself,
    // and it holds the ad ids. A later lead event on the same clickid inherits
    // them, so the earliest row is the safest source.
    const { data: click } = await supabase.from('events')
      .select('id,sub1,sub2,sub3,country')
      .eq('clickid', clickid)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    // Only the columns present here are written. That matters on a retry: a
    // network often repeats a postback with fewer parameters, and a row built
    // with explicit nulls would erase what the first call had established —
    // the hashed identifiers, or the attribution, if the click has since been
    // pruned. Absent stays absent instead of overwriting.
    const row = {
      txid, clickid, status, payout, currency, ip_hash,
      updated_at: new Date().toISOString(),
    };

    // Hashed at the door: if a network passes the lead's e-mail or phone, the
    // readable value is never written anywhere — not even for a moment.
    const em_hash = hashEmail(str(p.email, 255));
    const ph_hash = hashPhone(str(p.phone, 64));
    if (em_hash) row.em_hash = em_hash;
    if (ph_hash) row.ph_hash = ph_hash;

    if (click) {
      row.event_id = click.id;
      row.sub1 = click.sub1;
      row.sub2 = click.sub2;
      row.sub3 = click.sub3;
      row.country = click.country;
      row.matched = true;
    }

    // The retry case. onConflict on the unique txid turns a repeated postback
    // into an update of the same conversion — which is also how a real status
    // change arrives (pending → approved, or approved → rejected as a reversal).
    const { data, error } = await supabase.from('conversions')
      .upsert(row, { onConflict: 'txid' })
      .select('id')
      .single();
    if (error) throw error;

    await pruneSometimes(supabase, 'conversions', KEEP_DAYS);

    // An approved conversion is also news for the ad platform, so the same call
    // that settles the money triggers the outbound delivery. It is awaited to
    // keep it inside the function's lifetime — serverless kills whatever is
    // still running after the response — but its outcome never changes ours:
    // the network must get its 200 regardless of what Meta is doing.
    let capi;
    const origin = `https://${req.headers.host}`;
    if (status === 'approved') {
      capi = await deliverConversion(supabase, data.id, origin);
    } else if (existing && existing.status === 'approved') {
      // A REVERSAL: this conversion was approved, so the platform has already
      // been told about it, and the same call that takes the money back has to
      // take the signal back too. Otherwise the platform keeps optimising
      // towards a conversion that no longer exists.
      // Awaited for the same reason as above — serverless kills whatever is
      // still running after the response — and its outcome never changes ours.
      capi = await refundConversion(supabase, data.id, origin);
    }

    return res.status(200).json({
      ok: true,
      conversion_id: data.id,
      status,
      matched: Boolean(click),          // false = a postback for a click we never saw
      repeated: Boolean(existing),      // true = this txid was already recorded
      ...(existing && existing.status !== status ? { was: existing.status } : {}),
      ...(capi ? { capi } : {}),
    });
  } catch (e) {
    // A 500 makes the network retry, which is what we want for a transient
    // database error — the upsert above makes that retry harmless.
    return res.status(500).json({ ok: false, error: e.message });
  }
}
