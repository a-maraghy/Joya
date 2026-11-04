/* Memory > Sessions: select-all boxes, a live count of what is selected, and the
 * bulk buttons kept off until something is ticked. The page works without this
 * script: the server checks every request and asks before any delete. */
(function () {
  "use strict";
  function boot() {
    var form = document.querySelector("[data-mm-form]");
    if (form) {
      var count = form.querySelector("[data-mm-count]");
      var needs = form.querySelectorAll("[data-mm-needs]");
      var update = function () {
        var f = form.querySelectorAll('input[name="f"]:checked').length;
        var c = form.querySelectorAll('input[name="c"]:checked').length;
        if (count) {
          count.textContent = f + c
            ? "Selected: " + f + " fact" + (f === 1 ? "" : "s") + ", " + c + " chunk" + (c === 1 ? "" : "s")
            : "Select facts or chunks below";
        }
        Array.prototype.forEach.call(needs, function (b) { b.disabled = !(f + c); });
      };
      form.addEventListener("change", function (ev) {
        var all = ev.target.closest && ev.target.closest("[data-mm-all]");
        if (all) {
          var name = all.getAttribute("data-mm-all");
          Array.prototype.forEach.call(form.querySelectorAll('input[name="' + name + '"]'), function (b) {
            b.checked = all.checked;
          });
        }
        update();
      });
      update();
    }
    // Whole-session delete: the button wakes up once the name is typed exactly.
    var typed = document.querySelector("[data-mm-typed]");
    if (typed) {
      var btn = typed.form && typed.form.querySelector('button[type="submit"]');
      var want = typed.getAttribute("data-mm-typed");
      var check = function () { if (btn) btn.disabled = typed.value.trim() !== want; };
      typed.addEventListener("input", check);
      check();
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
