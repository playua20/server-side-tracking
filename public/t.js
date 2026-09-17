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

  var script = document.currentScript;

  // Derived from this script's own URL, so the same file works both on the demo
  // page and embedded on any other domain — nothing to edit per deployment.
  var ENDPOINT = script && script.src
    ? new URL("/api/track", script.src).href
    : "/api/track";

  var site = (script && script.getAttribute("data-site")) || location.hostname;
  var q = new URLSearchParams(location.search);

  // The _fbp cookie is set by Facebook's browser pixel; passing it along lets a
  // server-side event be matched to the same person. Absent? Then it is absent.
  function cookie(name) {
    var m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : null;
  }

  function base(type) {
    return {
      type: type,
      site: site,
      clickid: q.get("clickid") || q.get("click_id") || null,
      fbclid: q.get("fbclid") || null,
      fbp: cookie("_fbp"),
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

  // Auto pageview — but not from an automated browser. A test run opening the
  // page twenty times is not twenty visitors, and counting it would quietly
  // inflate every figure on the dashboard.
  if (!navigator.webdriver) send(base("pageview"));

  // Manual events: track("lead", { sub1: "..." })
  window.track = function (type, extra) {
    send(Object.assign(base(type || "event"), extra || {}));
  };
})();
