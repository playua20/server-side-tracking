import { createHash } from 'node:crypto';

/**
 * Conversions API bridge — the outward half.
 *
 * A browser pixel is blocked often enough that ad platforms now expect the
 * SERVER to report conversions. Sending is one fetch; the work is building a
 * payload the platform accepts, and running the delivery so that it can be
 * retried and audited. This module does the first part and the transport; the
 * endpoints own the queue.
 *
 * Destination:
 *   META_PIXEL_ID + META_ACCESS_TOKEN present → the real Graph API.
 *   Otherwise → our own /api/capi-sink, which answers with the same contract.
 * The dashboard states which one was used. Nothing pretends to be Meta.
 */

const GRAPH_VERSION = 'v21.0';
const TIMEOUT_MS = 8000;
// Meta rejects an event older than 7 days; clamping is friendlier than failing.
const MAX_AGE_S = 7 * 24 * 3600 - 300;

/** Meta requires normalisation BEFORE hashing, or the match silently fails. */
const sha256 = v => createHash('sha256').update(v).digest('hex');
export const hashEmail = e => (e ? sha256(String(e).trim().toLowerCase()) : null);
export const hashPhone = p => {
  const digits = String(p || '').replace(/\D/g, '');
  return digits ? sha256(digits) : null;
};
const hashText = v => (v ? sha256(String(v).trim().toLowerCase()) : null);

/**
 * `fbc` is not the raw fbclid: the platform wants fb.<subdomainIndex>.<clickTime>.<fbclid>
 * and reads the timestamp from it. Getting this format wrong is the classic
 * reason a server event never matches the click it belongs to.
 */
export function buildFbc(fbclid, clickTimeMs) {
  if (!fbclid) return null;
  return `fb.1.${Math.floor((clickTimeMs || Date.now()) / 1000)}.${fbclid}`;
}

export function isMetaConfigured() {
  return Boolean(process.env.META_PIXEL_ID && process.env.META_ACCESS_TOKEN);
}

export function destinationFor(origin) {
  return isMetaConfigured()
    ? { name: 'meta', url: `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.META_PIXEL_ID}/events` }
    : { name: 'sink', url: `${origin}/api/capi-sink` };
}

/**
 * One conversion + the click it was matched to → the request body Meta expects.
 * Raw personal data never leaves the server: e-mail, phone, names and city are
 * hashed, and only the fields we actually have are included (an empty field is
 * worse than an absent one — it counts against the match quality score).
 */
/**
 * The two kinds of call a conversion can produce.
 *
 * `refund` is the compensating one, sent when a postback REVERSES a conversion
 * we have already reported. Without it the platform keeps optimising on a
 * conversion that turned out not to exist — the worst kind of wrong signal,
 * because it looks like success.
 *
 * It must carry its own event_id: the platform deduplicates on that key (so do
 * we, in _deliver.js), so reusing the original's id would have the correction
 * silently dropped as a repeat of the thing it is meant to undo.
 *
 * ⚠ Against the real Graph API this shape is an approximation, and the page
 * says so rather than implying otherwise. Meta's own documented way to remove
 * an event it has already counted is the Deletion API, a different verb on a
 * different endpoint. What is built here — detecting the reversal, giving the
 * correction its own identity, queueing it, retrying it, auditing it — is the
 * part a production integration keeps; only the transport would change. The
 * default destination is our stand-in, whose contract this is.
 */
export const KINDS = {
  conversion: { suffix: '',        eventName: 'Lead'   },
  refund:     { suffix: '-refund', eventName: 'Refund' },
};

export const eventIdFor = (conversionId, kind = 'conversion') =>
  `conv-${conversionId}${(KINDS[kind] || KINDS.conversion).suffix}`;

/** Which kind a stored delivery row is, read back from its own event_id. */
export const kindOf = eventId =>
  String(eventId || '').endsWith(KINDS.refund.suffix) ? 'refund' : 'conversion';

export function buildPayload({ conversion, click, kind = 'conversion' }) {
  const spec = KINDS[kind] || KINDS.conversion;
  const eventName = spec.eventName;
  const nowS = Math.floor(Date.now() / 1000);
  const createdS = Math.floor(new Date(conversion.created_at || Date.now()).getTime() / 1000);
  const event_time = Math.max(nowS - MAX_AGE_S, Math.min(createdS, nowS));

  const user_data = {};
  const fbc = buildFbc(click?.fbclid, click?.created_at ? new Date(click.created_at).getTime() : null);
  if (fbc) user_data.fbc = fbc;
  if (click?.fbp) user_data.fbp = click.fbp;
  if (click?.user_agent) user_data.client_user_agent = click.user_agent;
  // Hashed identifiers, as arrays — the shape Meta documents. These arrive
  // already hashed: the postback hashes at the door, so no readable address is
  // ever stored, and nothing here can leak one by accident.
  if (conversion.em_hash) user_data.em = [conversion.em_hash];
  if (conversion.ph_hash) user_data.ph = [conversion.ph_hash];
  if (click?.city) user_data.ct = [hashText(click.city)];
  if (click?.country) user_data.country = [hashText(click.country)];

  const data = {
    event_name: eventName,
    event_time,
    // Shared with the browser pixel: same id on both sides → one conversion.
    event_id: eventIdFor(conversion.id, kind),
    action_source: 'website',
    user_data,
    custom_data: {
      // A correction carries the amount it takes back, signed, and keeps the
      // original's order_id so the two can be tied together on the far side.
      value: kind === 'refund'
        ? -Math.abs(Number(conversion.payout || 0))
        : Number(conversion.payout || 0),
      currency: conversion.currency || 'USD',
      ...(conversion.clickid ? { order_id: conversion.txid } : {}),
      ...(kind === 'refund' ? { reversal_of: eventIdFor(conversion.id) } : {}),
    },
  };
  if (click?.referer) data.event_source_url = click.referer;

  const body = { data: [data] };
  // Test Events in Meta's UI only shows events carrying this code.
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
  return body;
}

/** Fires the request and reports what happened — never throws. */
export async function deliver(url, payload, token) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(token ? `${url}?access_token=${encodeURIComponent(token)}` : url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, http_status: r.status, response: json, latency_ms: Date.now() - started };
  } catch (e) {
    // A timeout or a DNS failure is a failed attempt, not a crash: the row stays
    // in the queue and the retry sweeper picks it up.
    return { ok: false, http_status: null, response: { error: e.name === 'AbortError' ? 'timeout' : e.message }, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 1 min, 5, 25, 2 h, 10 h — capped, so a dead destination stops being hammered. */
export function nextTry(attempts) {
  const minutes = [1, 5, 25, 120, 600];
  return new Date(Date.now() + (minutes[Math.min(attempts, minutes.length) - 1] || 600) * 60_000).toISOString();
}

export const MAX_ATTEMPTS = 5;
