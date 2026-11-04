"use strict";
/*
 * "Download avatar (PNG)" (2026-10-25, lib/agent-avatar.js): the link points at the agent's avatar as an SVG
 * (/agents/<slug>/avatar.svg), which works without script; with script it is drawn onto a 640 x 640 canvas and
 * saved as a PNG -- the size Telegram wants for a bot's picture, set by hand in @BotFather (the Bot API cannot set
 * a bot's own photo). Same origin, so the canvas is never tainted; nothing leaves the page.
 */
(function () {
  var links = document.querySelectorAll("a[data-avatar-png]");
  Array.prototype.forEach.call(links, function (a) {
    a.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      var img = new Image(), size = 640;
      img.onload = function () {
        try {
          var cv = document.createElement("canvas");
          cv.width = size; cv.height = size;
          var g = cv.getContext("2d");
          g.drawImage(img, 0, 0, size, size);
          cv.toBlob(function (blob) {
            if (!blob) { window.location.href = a.href; return; }
            var url = URL.createObjectURL(blob), out = document.createElement("a");
            out.href = url;
            out.download = a.getAttribute("data-avatar-name") || "avatar.png";
            document.body.appendChild(out);
            out.click();
            out.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
          }, "image/png");
        } catch (err) {
          window.location.href = a.href; // the SVG instead
        }
      };
      img.onerror = function () { window.location.href = a.href; };
      img.src = a.getAttribute("data-avatar-png") + "?theme=light&px=" + size;
    });
  });
})();
