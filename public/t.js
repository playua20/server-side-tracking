/*!
 * t.js — tracking snippet (the "pixel").
 * Drop it into any lander, one line, before </body>:
 *   <script src="https://YOUR-APP.vercel.app/t.js" data-site="my-lander" defer></script>
 *
 * On load it sends a pageview; window.track(type, extra) sends custom events
 * (e.g. a lead on form submit). Geo/device are filled server-side.
 */
(function () {
  "use strict";

  // ← after deploy, set this to your Vercel URL, e.g. https://track-demo.vercel.app/api/track
  var ENDPOINT = "/api/track";

  var script = document.currentScript;
  var site = (script && script.getAttribute("data-site")) || location.hostname;
  var q = new URLSearchParams(location.search);

  function base(type) {
    return {
      type: type,
      site: site,
      clickid: q.get("clickid") || q.get("click_id") || null,
      sub1: q.get("sub1"), sub2: q.get("sub2"), sub3: q.get("sub3"),
      sub4: q.get("sub4"), sub5: q.get("sub5")
    };
  }

  // text/plain is a CORS-safelisted type: cross-origin beacons with application/json
  // are blocked by browsers, and a simple request also skips the preflight.
  function send(payload) {
    var body = JSON.stringify(payload);
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" })))) {
        fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body, keepalive: true });
      }
    } catch (e) { /* never break the host page */ }
  }

  // Auto pageview.
  send(base("pageview"));

  // Manual events: track("lead", { sub1: "..." })
  window.track = function (type, extra) {
    send(Object.assign(base(type || "event"), extra || {}));
  };
})();
