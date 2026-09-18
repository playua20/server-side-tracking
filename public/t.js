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

  // currentScript is null in some embeddings — a script written with
  // document.write, or injected dynamically. Falling back to finding our own
  // tag keeps both the endpoint and the data-* attributes working there.
  var script = document.currentScript ||
    document.querySelector('script[src*="/t.js"]');

  // Derived from this script's own URL, so the same file works both on the demo
  // page and embedded on any other domain — nothing to edit per deployment.
  var ENDPOINT = script && script.src
    ? new URL("/api/track", script.src).href
    : "/api/track";

  var site = (script && script.getAttribute("data-site")) || location.hostname;
  var q = new URLSearchParams(location.search);

  // The _fbp cookie is set by Facebook's browser pixel; passing it along lets a
  // server-side event be matched to the same person. Absent? Then it is absent.
  // Reading it THROWS on an opaque origin — a sandboxed iframe, a document
  // written at runtime — and an unguarded read there would take the whole
  // snippet down with it, on someone else's page.
  function cookie(name) {
    try {
      var m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function base(type) {
    return {
      type: type,
      site: site,
      clickid: q.get("clickid") || q.get("click_id") || null,
      fbclid: q.get("fbclid") || null,
      fbp: cookie("_fbp"),
      // Where the visitor came from. Empty means they arrived directly — typed
      // the address, opened a bookmark, or came from an app that strips it.
      ref: document.referrer || null,
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

  // Manual events: track("lead", { sub1: "..." }). Never throws into the host
  // page: this runs inside somebody's form handler, and an exception there
  // would break their submit, not just our tracking.
  window.track = function (type, extra) {
    try {
      send(Object.assign(base(type || "event"), extra || {}));
    } catch (e) { /* the page's own work matters more than our event */ }
  };

  // Optional: data-lead-form="#order" wires a real form's submit to a lead,
  // so a lander needs no handler of its own. sendBeacon is built for exactly
  // this moment — it survives the page unloading as the form navigates away.
  var sel = script && script.getAttribute("data-lead-form");
  if (sel) {
    document.addEventListener("submit", function (e) {
      var form = e.target;
      if (form && form.matches && form.matches(sel)) {
        window.track("lead", { sub5: form.getAttribute("name") || form.id || null });
      }
    }, true);  // capture: fires even if the page's own handler stops propagation
  }
})();
