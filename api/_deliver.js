import { buildPayload, destinationFor, deliver, nextTry, MAX_ATTEMPTS } from './_capi.js';

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

async function attempt(supabase, row, conversion, click, origin) {
  const dest = destinationFor(origin);
  const payload = buildPayload({ conversion, click });
  const out = await deliver(dest.url, payload, process.env.META_ACCESS_TOKEN);
  const attempts = (row?.attempts || 0) + 1;

  const patch = {
    conversion_id: conversion.id,
    event_id: `conv-${conversion.id}`,
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
      .select('id,status,attempts,duplicates').eq('event_id', `conv-${conversionId}`).maybeSingle();

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
      results.push(await attempt(supabase, row, conversion, click, origin));
    } catch (e) {
      results.push({ id: row.id, error: e.message });
    }
  }
  return results;
}
