/*
 * Applies the saved theme before the first paint, so a page that offers the
 * System / Dark / Light switch never flashes the wrong one. Loaded as a
 * blocking script in <head> -- the CSP forbids inline scripts, and a deferred
 * one would run after the page had already been painted once.
 *
 * "system" (or nothing saved) leaves the attribute off, and the stylesheet's
 * prefers-color-scheme rules decide -- live, as the system setting changes.
 */
(function () {
  try {
    var t = window.localStorage.getItem("joya-theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    /* storage blocked: System it is */
  }
  // The sidebar collapsed to icons is remembered the same way, and applied
  // before paint for the same reason: a rail that visibly shrinks on every
  // page load reads as the page jumping.
  try {
    if (window.localStorage.getItem("joya-side") === "collapsed") {
      document.documentElement.setAttribute("data-side", "collapsed");
    }
  } catch (e) {
    /* storage blocked: the sidebar stays open */
  }
})();
