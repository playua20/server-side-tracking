/**
 * Cloudflare Worker — two jobs, both outside the deployment they serve.
 *
 * 1. Every 15 min: /api/capi-retry — redelivers Conversions API events that
 *    failed. Serverless has nowhere to keep a background worker, so a failed
 *    delivery waits in the table until something calls for it. Running that
 *    sweeper here means a broken deployment does not also break its own repair.
 *    It touches the database, which incidentally covers job 2 as well.
 *
 * 2. Every 3 days: /api/keepalive — a free Supabase project is paused after a
 *    week of inactivity and has to be restored by hand, so the demo would be
 *    broken for whoever opened it next.
 *
 * Deploy:  npx wrangler deploy
 * Secret:  npx wrangler secret put CRON_TOKEN
 * Logs:    npx wrangler tail
 */
const BASE = 'https://server-side-pixel.vercel.app';
const RETRY_CRON = '*/15 * * * *';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === RETRY_CRON ? retry(env) : keepalive());
  },
  // Both jobs on demand, so the worker can be verified without waiting.
  async fetch(req, env) {
    const which = new URL(req.url).searchParams.get('job');
    const out = which === 'keepalive' ? await keepalive() : await retry(env);
    return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
  },
};

async function call(url, label) {
  const started = Date.now();
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'cron-worker' } });
    const body = await r.text();
    const out = { job: label, ok: r.ok, status: r.status, ms: Date.now() - started, body: body.slice(0, 400) };
    if (!r.ok) console.error(label + ' failed', out);
    return out;
  } catch (e) {
    console.error(label + ' threw', e.message);
    return { job: label, ok: false, error: e.message, ms: Date.now() - started };
  }
}

const keepalive = () => call(`${BASE}/api/keepalive`, 'keepalive');

function retry(env) {
  if (!env.CRON_TOKEN) return Promise.resolve({ job: 'capi-retry', ok: false, error: 'CRON_TOKEN not set' });
  return call(`${BASE}/api/capi-retry?token=${encodeURIComponent(env.CRON_TOKEN)}`, 'capi-retry');
}
