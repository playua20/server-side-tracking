import { createHash } from 'node:crypto';

// Files prefixed with _ are not routed as endpoints by Vercel — this is a
// module, not a function.

/** Visitors are counted, not identified: the IP is salted and hashed, never stored raw. */
export function ipHash(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (!ip) return null;
  const salt = process.env.IP_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return createHash('sha256').update(ip + salt).digest('hex').slice(0, 32);
}

/**
 * True when this caller is over the limit for the last minute.
 * Fails open: a database hiccup must not reject a legitimate event.
 */
export async function overLimit(supabase, table, hash, max) {
  if (!hash) return false;
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabase.from(table)
    .select('*', { count: 'exact', head: true })
    .eq('ip_hash', hash).gte('created_at', since);
  if (error) return false;
  return (count || 0) >= max;
}

/**
 * Retention without a scheduler: roughly one call in a hundred prunes whatever
 * has aged out. Never allowed to fail the request that triggered it.
 */
export async function pruneSometimes(supabase, table, days) {
  if (Math.random() >= 0.01) return;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  try { await supabase.from(table).delete().lt('created_at', cutoff); } catch {}
}
