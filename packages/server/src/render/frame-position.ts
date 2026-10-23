/**
 * The script that keeps a reader's place in an HTML artifact across versions.
 *
 * An HTML artifact scrolls inside its sandboxed frame, at an opaque origin, so
 * the app cannot see how far down the reader is. When a new version arrives
 * the app has to load a new document, and a new document starts at the top:
 * somebody reading the middle of a page an agent is still writing is thrown
 * back to the beginning every time it saves.
 *
 * So the framed copy carries this, appended after the publisher's bytes like
 * the comment bridge (see comments/bridge.ts). It does two things:
 *
 *   it tells the app where the page is scrolled to, as two numbers
 *   it scrolls to where the app asks, once the next version has loaded
 *
 * Nothing else. It reads no content and sends no text, so a page that lies
 * through it can only lie about its own scroll position, which it is told
 * back and nobody else ever sees. It changes nothing in the publisher's
 * document, and does nothing outside a frame.
 *
 * Unlike the comment bridge it is in every reader's framed copy, not only a
 * commenter's: keeping your place is for everybody who can read the page.
 */

/** How the two sides address each other. Its own channel, apart from the comment bridge's. */
export const POSITION_CHANNEL = 'open-artifact.position.v1';

export const POSITION_SCRIPT = `<script>
(function () {
  'use strict';

  var CHANNEL = ${JSON.stringify(POSITION_CHANNEL)};

  // Pasted into a tab rather than framed by the app. Nothing to talk to.
  if (window.parent === window) return;

  // At most once a frame, however fast the reader scrolls.
  var queued = false;
  function report() {
    queued = false;
    // targetOrigin cannot be anything but '*' talking to an opaque origin, and
    // two numbers are nothing the frame does not already have.
    try {
      window.parent.postMessage({ channel: CHANNEL, type: 'scrolled', x: window.scrollX, y: window.scrollY }, '*');
    } catch (error) { /* the app is gone; nothing to do about it */ }
  }

  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(report);
  }, { passive: true });

  window.addEventListener('message', function (event) {
    // Only the window that framed this document.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.type !== 'restore') return;
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
    window.scrollTo(data.x, data.y);
  });
})();
</script>`;
