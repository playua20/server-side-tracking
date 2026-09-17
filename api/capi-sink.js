/**
 * Stand-in for the ad platform's events endpoint.
 *
 * With no pixel credentials attached, deliveries go here instead of to Meta.
 * It answers with Meta's contract — same shape on success, same shape on a bad
 * payload — so the delivery pipeline is exercised for real: a real request over
 * the network, a real status code, a real latency, real retries.
 *
 * It is a stand-in and the dashboard says so. Attach META_PIXEL_ID and
 * META_ACCESS_TOKEN and the very same code delivers to Meta instead.
 *
 * ?fail=1 answers 500, which is how the retry path is demonstrated without
 * waiting for a real outage.
 */
const trace = () => 'sink' + Math.random().toString(36).slice(2, 12);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'POST only', type: 'GraphMethodException', code: 100 } });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }

  // Graph API rejects a missing data array with a 400, so this does too.
  if (!body || !Array.isArray(body.data) || body.data.length === 0) {
    return res.status(400).json({
      error: { message: '(#100) Param data[0] must be an object', type: 'OAuthException', code: 100, fbtrace_id: trace() },
    });
  }

  const bad = body.data.find(e => !e.event_name || !e.event_time);
  if (bad) {
    return res.status(400).json({
      error: { message: '(#100) event_name and event_time are required', type: 'OAuthException', code: 100, fbtrace_id: trace() },
    });
  }

  if (String(req.query?.fail || '') === '1') {
    return res.status(500).json({
      error: { message: 'Simulated upstream failure', type: 'SinkException', code: 500, fbtrace_id: trace() },
    });
  }

  return res.status(200).json({
    events_received: body.data.length,
    messages: [],
    fbtrace_id: trace(),
    stand_in: true,   // never pretend to be Meta
  });
}
