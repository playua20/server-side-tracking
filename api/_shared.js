import { createHash } from 'node:crypto';

// Files prefixed with _ are not routed as endpoints by Vercel — this is a
// module, not a function.

/**
 * Crawlers, link-preview fetchers and headless automation — counted as visitors,
 * they quietly inflate every figure on the dashboard. A browser always sends a
 * user-agent, so an empty one is a script too.
 *
 * Deliberately NOT in the list: curl, wget and the other hand-run tools. They
 * are somebody deliberately calling the endpoint — the README's own examples do
 * exactly that — and treating a deliberate call as a crawler would make the
 * documented flow silently do nothing.
 */
const BOTS = /bot\b|bots?\/|crawl|spider|slurp|scrape|fetcher|monitor|uptime|preview|facebookexternalhit|whatsapp|telegram|discord|slack|twitterbot|embedly|pinterest|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|ahrefs|semrush|mj12|dotbot|petal|bytespider|gptbot|claudebot|ccbot|applebot|yandex|baidu|duckduck/i;

export const isBot = ua => !ua || BOTS.test(ua);

/**
 * True when this request was handled by a LOCAL dev server rather than by the
 * deployment.
 *
 * Why it matters: .env.local points at the real database, so a page opened on
 * `npm run dev` writes to the live dashboard. Such a request never passed
 * through Vercel's edge, so it carries no x-vercel-ip-country — and it lands
 * as a country-less row that shows up on the public dashboard as "Unknown".
 *
 * Keyed on the request's own Host, which only a local server can produce, so
 * the check FAILS OPEN: if it ever stops matching, events are still recorded.
 * Keying on the ABSENCE of an edge header would fail closed instead, and the
 * failure mode there is every event silently discarded.
 *
 * `ALLOW_LOCAL_TRACK=1` turns it off, for deliberately running the suites
 * against a local server.
 */
/* The WHOLE host must be a loopback name with an optional port. A prefix test
   is wrong in both directions: `127.` followed by an anchor never matches a
   real `127.0.0.1:3000`, and a bare prefix would swallow `localhost.evil.com`. */
const LOCAL_HOST = /^(?:localhost|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|::1)(?::\d+)?$/i;

export const isLocalHost = host =>
  process.env.ALLOW_LOCAL_TRACK !== '1' && LOCAL_HOST.test(String(host || ''));

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
