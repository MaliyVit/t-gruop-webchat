/* Chat widget loader.
 *
 * Add to any page:   <script src="https://CHAT_DOMAIN/embed.js" defer></script>
 *
 * It injects an <iframe> pinned to the bottom-right corner that loads /widget
 * from the chat origin (taken from this script's own src, so nothing is
 * hard-coded). The iframe isolates widget CSS/JS from the host page. The widget
 * reports open/closed through postMessage and this loader resizes the frame:
 *   widget -> host:  { type: "chat:state", open: boolean }
 * Messages are accepted only from the chat origin.
 */
(() => {
  "use strict";
  if (window.__webChatLoaded) return; // guard against double inclusion
  window.__webChatLoaded = true;

  const script = document.currentScript;
  if (!script || !script.src) return;
  const chatOrigin = new URL(script.src, location.href).origin;

  // Page identity for context: origin + path only. Query strings and fragments
  // can carry personal data and are never sent.
  const sourcePage = location.origin + location.pathname;

  const iframe = document.createElement("iframe");
  iframe.src = chatOrigin + "/widget?host=" + encodeURIComponent(sourcePage);
  iframe.title = "Chat";
  iframe.setAttribute("allow", ""); // no camera, microphone, geolocation, ...
  Object.assign(iframe.style, {
    position: "fixed", border: "0", background: "transparent",
    colorScheme: "normal", zIndex: "2147483000",
  });

  let open = false;

  // Closed: just enough room for the launcher button and its badge.
  // Open: a 400x640 panel on desktop, the full viewport on small screens.
  function layout() {
    if (!open) {
      Object.assign(iframe.style, {
        left: "auto", top: "auto", right: "0", bottom: "0",
        width: "104px", height: "104px", boxShadow: "none", borderRadius: "0",
      });
    } else if (window.innerWidth <= 480) {
      Object.assign(iframe.style, {
        left: "0", top: "0", right: "0", bottom: "0",
        width: "100%", height: "100%", boxShadow: "none", borderRadius: "0",
      });
    } else {
      Object.assign(iframe.style, {
        left: "auto", top: "auto", right: "16px", bottom: "16px",
        width: "400px", height: Math.min(640, window.innerHeight - 32) + "px",
        borderRadius: "12px", boxShadow: "0 12px 40px rgba(0, 0, 0, .25)",
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== chatOrigin || event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== "chat:state") return;
    open = Boolean(data.open);
    layout();
  });
  window.addEventListener("resize", () => { if (open) layout(); });

  layout();
  if (document.body) document.body.appendChild(iframe);
  else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(iframe));
})();
