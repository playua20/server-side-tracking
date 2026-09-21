import { buildPayload, destinationFor, deliver, nextTry, MAX_ATTEMPTS,
         eventIdFor, kindOf } from './_capi.js';

/**
 * The queue around the CAPI bridge.
 *
 * One conversion becomes one delivery row keyed by event_id. An attempt writes
 * back everything needed to audit it later: the payload sent, the answer, the
 * status code, the latency and the attempt number. A failure schedules the next
 * try instead of disappearing.
 */

/** Where a conversion's identifiers live: the first event carrying its clickid. */
async function clickFor(supabase, clickid) {
  if (!clickid) return null;
  const { data } = await supabase.from('events')
    .select('id,fbclid,fbp,user_agent,referer,city,country,created_at')
    .eq('clickid', clickid)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function attempt(supabase, row, conversion, click, origin, kind = 'conversion') {
  const dest = destinationFor(origin);
  const payload = buildPayload({ conversion, click, kind });
  const out = await deliver(dest.url, payload, process.env.META_ACCESS_TOKEN);
  const attempts = (row?.attempts || 0) + 1;

  const patch = {
    conversion_id: conversion.id,
    event_id: eventIdFor(conversion.id, kind),
    event_name: payload.data[0].event_name,
    destination: dest.name,
    status: out.ok ? 'delivered' : (attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'),
    http_status: out.http_status,
    attempts,
    latency_ms: out.latency_ms,
    request: payload,
    response: out.response,
    // Nothing more is due once it landed, or once we have stopped trying.
    next_try_at: out.ok || attempts >= MAX_ATTEMPTS ? null : nextTry(attempts),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from('capi_deliveries')
    .upsert(patch, { onConflict: 'event_id' })
    .select('id,status,attempts,http_status,latency_ms,destination')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Called right after a postback settles a conversion as approved.
 * Never allowed to break the postback: an affiliate network must get its 200
 * whatever the ad platform is doing.
 */
export async function deliverConversion(supabase, conversionId, origin) {
  try {
    const { data: conversion } = await supabase.from('conversions')
      .select('id,txid,clickid,status,payout,currency,em_hash,ph_hash,created_at')
      .eq('id', conversionId).maybeSingle();
    if (!conversion) return { skipped: 'no such conversion' };
    if (conversion.status !== 'approved') return { skipped: `status is ${conversion.status}` };

    const { data: existing } = await supabase.from('capi_deliveries')
      .select('id,status,attempts,duplicates').eq('event_id', eventIdFor(conversionId)).maybeSingle();

    // Deduplication, the same rule the ad platform applies on its side: one
    // event_id is one conversion. The repeat is counted, so the log shows it
    // happened rather than pretending the call never came.
    if (existing && existing.status === 'delivered') {
      await supabase.from('capi_deliveries')
        .update({ duplicates: (existing.duplicates || 0) + 1, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      return { skipped: 'duplicate event_id', delivery_id: existing.id };
    }

    const click = await clickFor(supabase, conversion.clickid);
    return await attempt(supabase, existing, conversion, click, origin);
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * A conversion we have ALREADY reported has been taken back by the network —
 * a second postback with the same txid, arriving as rejected. Tell the
 * platform, or it goes on optimising towards a conversion that turned out not
 * to exist, which is the worst kind of wrong signal because it looks like
 * success.
 *
 * Same queue, same retries, same audit trail as the original call: this is a
 * delivery like any other, and the only thing that makes it special is that
 * its event_id must differ from the one it corrects. Reusing that id would
 * have the correction dropped as a duplicate of the very thing it undoes —
 * both by us, below, and by the platform.
 */
export async function refundConversion(supabase, conversionId, origin) {
  try {
    // Nothing was ever reported, so there is nothing to take back. This is the
    // common case: a conversion that never made it past `pending` was never
    // sent, and a reversal of it owes the platform no correction at all.
    const { data: original } = await supabase.from('capi_deliveries')
      .select('id,status').eq('event_id', eventIdFor(conversionId)).maybeSingle();
    if (!original || original.status !== 'delivered') {
      return { skipped: 'nothing was delivered to compensate' };
    }

    const { data: conversion } = await supabase.from('conversions')
      .select('id,txid,clickid,status,payout,currency,em_hash,ph_hash,created_at')
      .eq('id', conversionId).maybeSingle();
    if (!conversion) return { skipped: 'no such conversion' };
    // Guards a race: if another postback approved it again between the two
    // calls, the correction is no longer owed.
    if (conversion.status === 'approved') return { skipped: 'approved again' };

    const { data: existing } = await supabase.from('capi_deliveries')
      .select('id,status,attempts,duplicates')
      .eq('event_id', eventIdFor(conversionId, 'refund')).maybeSingle();

    if (existing && existing.status === 'delivered') {
      await supabase.from('capi_deliveries')
        .update({ duplicates: (existing.duplicates || 0) + 1, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      return { skipped: 'already compensated', delivery_id: existing.id };
    }

    const click = await clickFor(supabase, conversion.clickid);
    return await attempt(supabase, existing, conversion, click, origin, 'refund');
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Reversals that owe the platform a correction and have not had one.
 *
 * The postback handler fires the compensating call the moment a reversal
 * arrives, and that covers the normal case — but not every case. A reversal
 * that landed while the destination was down leaves the correction failed; a
 * conversion reversed before this code existed never had one at all; and a
 * crash between the upsert and the call leaves the same gap. Each of those is
 * a signal the platform still believes, sitting there indefinitely.
 *
 * So the sweeper closes the gap on a schedule rather than trusting one call at
 * one moment. It is the same query the dashboard draws its warning from, which
 * is the point: the number it shows is the number this repairs, and once the
 * cron has run it goes to zero on its own.
 */
export async function compensateDue(supabase, origin, limit = 5) {
  // Conversions that are no longer approved but WERE delivered.
  const { data: delivered } = await supabase.from('capi_deliveries')
    .select('conversion_id,event_id,conversions!inner(status)')
    .eq('status', 'delivered')
    .neq('conversions.status', 'approved')
    .order('created_at', { ascending: true })
    .limit(200);

  const results = [];
  for (const row of delivered || []) {
    if (kindOf(row.event_id) === 'refund') continue;        // the fix is not the fault
    if (results.length >= limit) break;

    const { data: done } = await supabase.from('capi_deliveries')
      .select('id').eq('event_id', `${row.event_id}-refund`).eq('status', 'delivered').maybeSingle();
    if (done) continue;

    results.push({ conversion_id: row.conversion_id,
                   ...(await refundConversion(supabase, row.conversion_id, origin)) });
  }
  return results;
}

/** The retry sweeper, driven by the Cloudflare cron. */
export async function retryDue(supabase, origin, limit = 5) {
  const { data: due } = await supabase.from('capi_deliveries')
    .select('id,event_id,conversion_id,attempts,status')
    .eq('status', 'pending')
    .not('next_try_at', 'is', null)
    .lte('next_try_at', new Date().toISOString())
    .order('next_try_at', { ascending: true })
    .limit(limit);

  const results = [];
  for (const row of due || []) {
    const { data: conversion } = await supabase.from('conversions')
      .select('id,txid,clickid,status,payout,currency,em_hash,ph_hash,created_at')
      .eq('id', row.conversion_id).maybeSingle();
    if (!conversion) { results.push({ id: row.id, skipped: 'conversion gone' }); continue; }
    const click = await clickFor(supabase, conversion.clickid);
    try {
      // The kind is read back off the row's own event_id. Without it a retried
      // CORRECTION would be rebuilt and re-sent as the original conversion —
      // the queue would spend its attempts re-asserting the thing it was
      // created to withdraw.
      results.push(await attempt(supabase, row, conversion, click, origin, kindOf(row.event_id)));
    } catch (e) {
      results.push({ id: row.id, error: e.message });
    }
  }
  return results;
}
