/* Help ▸ Guide: search the sections, highlight what matches, hide the rest. */
(function () {
  "use strict";
  var input = document.getElementById("guide-q");
  if (!input) return;
  var empty = document.getElementById("gd-empty");
  var sections = Array.prototype.slice.call(document.querySelectorAll("section.gd"));
  var toc = document.querySelector("[data-toc]");

  function unmark(sec) {
    var marks = sec.querySelectorAll("mark.gd-hit");
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i], p = m.parentNode;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    }
  }

  function mark(sec, q) {
    var walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT, null), n, nodes = [];
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (t) {
      var node = t, i;
      while (node && (i = node.nodeValue.toLowerCase().indexOf(q)) >= 0) {
        var hit = node.splitText(i), rest = hit.splitText(q.length);
        var m = document.createElement("mark");
        m.className = "gd-hit";
        hit.parentNode.replaceChild(m, hit);
        m.appendChild(hit);
        node = rest;
      }
    });
  }

  function run() {
    var q = input.value.trim().toLowerCase(), any = false;
    sections.forEach(function (sec) {
      unmark(sec);
      var hit = !q || sec.textContent.toLowerCase().indexOf(q) >= 0;
      sec.classList.toggle("hide", !hit);
      if (hit) any = true;
      if (q && hit) mark(sec, q);
      if (toc && sec.id) {
        var a = toc.querySelector('a[href="#' + sec.id + '"]');
        if (a) a.classList.toggle("gd-off", !hit);
      }
    });
    if (empty) empty.classList.toggle("show", !any);
  }

  var timer = null;
  input.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(run, 80);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && input.value) { input.value = ""; run(); }
  });
  if (input.value) run();
})();
