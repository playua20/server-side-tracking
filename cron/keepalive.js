/**
 * Cloudflare Worker — keeps the Supabase project from being paused.
 *
 * A free Supabase project is paused after ~7 days without activity and has to
 * be restored by hand, so the demo would simply be broken for whoever opened
 * it next. This pings the app every 3 days, which resets that clock.
 *
 * Deliberately NOT a Vercel cron: the job that keeps the site alive should not
 * depend on the same deployment it is watching.
 *
 * Deploy:  npx wrangler login && npx wrangler deploy
 * Test:    npx wrangler dev --test-scheduled  (then curl the printed URL + "/__scheduled")
 */
const TARGET = 'https://server-side-pixel.vercel.app/api/keepalive';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ping());
  },
  // Same check on demand, so the worker can be verified without waiting 3 days.
  async fetch() {
    return new Response(JSON.stringify(await ping()), {
      headers: { 'content-type': 'application/json' },
    });
  },
};

async function ping() {
  const started = Date.now();
  try {
    const r = await fetch(TARGET, { headers: { 'user-agent': 'keepalive-worker' } });
    const body = await r.text();
    const out = { ok: r.ok, status: r.status, ms: Date.now() - started, body: body.slice(0, 200) };
    // Failures land in `wrangler tail` and in the Worker's dashboard logs.
    if (!r.ok) console.error('keepalive failed', out);
    return out;
  } catch (e) {
    console.error('keepalive threw', e.message);
    return { ok: false, error: e.message, ms: Date.now() - started };
  }
}
