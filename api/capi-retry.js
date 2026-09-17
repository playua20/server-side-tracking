import { createClient } from '@supabase/supabase-js';
import { retryDue } from './_deliver.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Retry sweeper, called by the Cloudflare cron.
 *
 * Serverless has nowhere to keep a background worker, so a failed delivery is
 * not retried in-process — it waits in the table with next_try_at set, and this
 * endpoint picks up whatever is due. That is also why the cron lives on
 * Cloudflare: the thing that repairs deliveries should not depend on the
 * deployment whose deliveries broke.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = String(req.query?.token || req.headers['x-cron-token'] || '');
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return res.status(401).json({ ok: false, error: 'bad or missing token' });
  }

  const origin = `https://${req.headers.host}`;
  try {
    const results = await retryDue(supabase, origin, 5);
    return res.status(200).json({ ok: true, retried: results.length, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
