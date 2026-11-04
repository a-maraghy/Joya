/* The memory pages (lib/views-memory.js): "/" jumps to the search box of the view in front,
 * unless you are already typing somewhere. Everything else on these pages is plain links,
 * forms and <details>, so it works with the keyboard and without this script. */
(function () {
  "use strict";
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var boxes = document.querySelectorAll("[data-mem-search]");
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].offsetParent !== null && !boxes[i].closest("[hidden]")) {
        ev.preventDefault();
        boxes[i].focus();
        boxes[i].select();
        return;
      }
    }
  });
})();
