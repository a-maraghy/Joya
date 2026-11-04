"use strict";
/*
 * The JOYA AI chat.
 *
 * Talks to /console/:id/send, which answers with newline-delimited JSON straight
 * from the Claude CLI and holds the connection open for the length of the turn.
 * Rendering as it arrives is the point: a turn can run for minutes, and a
 * spinner tells you nothing about whether it is doing the right thing. Watching
 * which files it reads is most of how you tell whether it understood you.
 *
 * Loaded on every page and returns immediately when there is no chat on screen.
 */
/* ------------------------------------------------------------- markdown ---
 *
 * A deliberately small renderer for the subset an answer actually uses:
 * fenced and inline code, headings, lists, quotes, rules, bold, italic and
 * links. Anything else stays as written.
 *
 * It escapes first and formats second, always. Every branch below operates on
 * text that is already HTML-safe, so a reply containing markup renders as the
 * characters that were typed rather than as elements -- which matters more here
 * than in most places, because a great deal of what this thing reports is the
 * contents of files it just read.
 */
var MD = (function () {
  /* Spans of code are lifted out before emphasis is applied and put back after,
     so a `*` inside code is never read as markup. The marker has to be a
     sequence the surrounding prose cannot contain, which rules out anything
     printable -- " 0 " occurs in ordinary text all the time. Built with
     fromCharCode rather than typed, so no control character ends up sitting in
     this file where an editor might quietly eat it. */
  var MARK = String.fromCharCode(0);
  var MARK_RE = new RegExp(MARK + "(\\d+)" + MARK, "g");

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inline(text) {
    var out = esc(text);
    // Code first: what is inside a span of code must not then be read as
    // emphasis. The placeholder keeps it out of the way of everything after.
    var codes = [];
    out = out.replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push(code);
      return MARK + (codes.length - 1) + MARK;
    });

    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

    // Only http(s), and rel-hardened: an answer can contain a link somebody
    // else wrote, and target=_blank without noopener hands them the tab.
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, href) {
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });

    return out.replace(MARK_RE, function (_, i) {
      return "<code>" + codes[i] + "</code>";
    });
  }

  return function render(src) {
    var lines = String(src == null ? "" : src).split("\n");
    var html = "";
    var list = null;      // "ul" | "ol" | null
    var para = [];
    var fence = null;     // language of an open code fence, or null
    var code = [];

    function flushPara() {
      if (para.length) {
        html += "<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>";
        para = [];
      }
    }
    function closeList() {
      if (list) {
        html += "</" + list + ">";
        list = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      var fenceMark = line.match(/^\s*```(.*)$/);
      if (fenceMark) {
        if (fence === null) {
          flushPara();
          closeList();
          fence = fenceMark[1] || "";
          code = [];
        } else {
          html += "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
          fence = null;
        }
        continue;
      }
      if (fence !== null) {
        code.push(line);
        continue;
      }

      if (!line.trim()) {
        flushPara();
        closeList();
        continue;
      }

      var heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushPara();
        closeList();
        var level = Math.min(heading[1].length + 1, 4);
        html += "<h" + level + ">" + inline(heading[2]) + "</h" + level + ">";
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
        flushPara();
        closeList();
        html += "<hr>";
        continue;
      }

      var quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushPara();
        closeList();
        html += "<blockquote>" + inline(quote[1]) + "</blockquote>";
        continue;
      }

      var bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      var numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushPara();
        var want = bullet ? "ul" : "ol";
        if (list !== want) {
          closeList();
          html += "<" + want + ">";
          list = want;
        }
        html += "<li>" + inline((bullet || numbered)[1]) + "</li>";
        continue;
      }

      closeList();
      para.push(line);
    }

    // An unterminated fence still shows what was inside it: a turn that is
    // still streaming is mid-code-block far more often than it is broken.
    if (fence !== null && code.length) {
      html += "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
    }
    flushPara();
    closeList();
    return html;
  };
})();

/* Stored messages arrive as plain text and are rendered here, so there is one
   markdown implementation rather than one per side. */
(function () {
  var pending = document.querySelectorAll(".bubble[data-md]");
  Array.prototype.forEach.call(pending, function (el) {
    el.innerHTML = MD(el.textContent);
    el.removeAttribute("data-md");
  });
})();

(function () {
  var compose = document.getElementById("chat-compose");
  if (!compose) return;

  var scroll = document.getElementById("chat-scroll");
  var input = document.getElementById("chat-input");
  var sendBtn = document.getElementById("chat-send");
  var stopBtn = document.getElementById("chat-stop");
  var status = document.getElementById("chat-status");
  var sessionId = compose.getAttribute("data-session");
  var csrf = compose.getAttribute("data-csrf");
  var running = false;

  /* Speech, not music. The browser's default is around 128kbps, which is four
     times what a transcription model can use and turns a half-minute of
     talking into a body big enough to be worth arguing about. 24kbps opus
     transcribes identically and keeps a long utterance well inside every limit
     between here and the model. */
  function recorderFor(stream) {
    try {
      return new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
    } catch (e) {
      return new MediaRecorder(stream);   // a browser that dislikes the option
    }
  }

  function atBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  }

  /* Follow the output only if the reader is already at the bottom. Yanking the
     view back while somebody is reading earlier output is maddening. */
  function toBottom(force) {
    if (force || atBottom()) scroll.scrollTop = scroll.scrollHeight;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function addMessage(role, text) {
    var wrap = el("div", "msg " + role);
    wrap.appendChild(el("div", role === "system" ? "note" : "bubble", text || ""));
    scroll.appendChild(wrap);
    toBottom(true);
    return wrap.firstChild;
  }

  /* Tool calls are folded into one line per turn -- "Ran 8 commands", click to
     expand. The full list is noise while you are reading an answer, but it is
     the only record of what actually happened, so it is hidden rather than
     discarded. */
  function addTool(ctx, name, summary) {
    if (!ctx.activity) {
      var box = el("details", "activity");
      var head = el("summary", null, "");
      box.appendChild(head);
      var body = el("div", "activity-body");
      box.appendChild(body);
      scroll.appendChild(box);
      ctx.activity = { box: box, head: head, body: body, count: 0 };
    }
    var a = ctx.activity;
    a.count += 1;
    a.head.textContent = a.count === 1 ? "1 step" : a.count + " steps";

    var row = el("div", "tool-row");
    row.appendChild(el("span", "tool-name", name));
    if (summary) row.appendChild(el("span", "tool-arg", summary));
    a.body.appendChild(row);
    toBottom();
  }

  /* One line describing what a tool was asked to do. Whichever field is most
     telling, in the order that usually matters. */
  function summarise(args) {
    if (!args) return "";
    if (args.command) return String(args.command).slice(0, 160);
    if (args.file_path) return String(args.file_path);
    if (args.path) return String(args.path);
    if (args.pattern) return String(args.pattern).slice(0, 80);
    if (args.url) return String(args.url);
    if (args.prompt) return String(args.prompt).slice(0, 120);
    try {
      return JSON.stringify(args).slice(0, 120);
    } catch (e) {
      return "";
    }
  }

  /* One frame, one paint. Text is written plain while it streams -- rendering
     markdown on every frame would re-parse the whole answer sixty times a
     second -- and the formatted version replaces it once the turn is done. */
  function schedule(ctx) {
    if (ctx.frame) return;
    ctx.frame = requestAnimationFrame(function () {
      ctx.frame = 0;
      if (ctx.bubble) ctx.bubble.textContent = ctx.text;
      toBottom();
    });
  }

  function finalise(ctx) {
    if (ctx.frame) {
      cancelAnimationFrame(ctx.frame);
      ctx.frame = 0;
    }
    if (ctx.text) live.flush(ctx.text);
    if (!ctx.bubble) return;
    ctx.bubble.className = "bubble";
    if (ctx.text) ctx.bubble.innerHTML = MD(ctx.text);
  }

  function setRunning(state) {
    running = state;
    sendBtn.disabled = state;
    stopBtn.hidden = !state;
    input.disabled = state;
    if (!state) status.textContent = "";
  }

  function handleEvent(ev, ctx) {
    if (ev.type === "stream_event" && ev.event) {
      var d = ev.event.delta;
      if (ev.event.type === "content_block_delta" && d && d.type === "text_delta" && d.text) {
        if (!ctx.bubble) {
          ctx.bubble = addMessage("assistant", "");
          ctx.bubble.className = "bubble streaming";
          ctx.text = "";
        }
        // Deltas arrive faster than the screen refreshes. Appending on each one
        // means a layout and a paint per token; buffering and flushing on the
        // next frame means one of each per frame, which is all the eye can use
        // and a great deal less work on a long answer.
        ctx.text += d.text;
        schedule(ctx);
        // Sentence by sentence as it arrives, so the first words are spoken
        // while the rest is still being written.
        live.feed(ctx.text);
      }
      if (
        ev.event.type === "content_block_start" &&
        ev.event.content_block &&
        ev.event.content_block.type === "thinking"
      ) {
        status.textContent = "thinking…";
      }
      return;
    }

    if (ev.type === "assistant" && ev.message && ev.message.content) {
      ev.message.content.forEach(function (block) {
        if (block.type === "tool_use") {
          status.textContent = block.name + "…";
          addTool(ctx, block.name, summarise(block.input));
          // A tool call closes the current prose block, so the next text opens
          // a new bubble beneath it and the order on screen matches reality.
          finalise(ctx);
          ctx.bubble = null;
          ctx.text = "";
        } else if (block.type === "text" && block.text && !ctx.bubble) {
          // Only when the partial deltas did not already render it.
          ctx.bubble = addMessage("assistant", "");
          ctx.text = block.text;
          ctx.bubble.textContent = block.text;
        }
      });
      return;
    }

    if (ev.type === "result") {
      if (!ctx.bubble && ev.result) {
        ctx.bubble = addMessage("assistant", "");
        ctx.text = ev.result;
      }
      finalise(ctx);
      var bits = [];
      if (ev.duration_ms) bits.push(Math.round(ev.duration_ms / 100) / 10 + "s");
      if (ev.total_cost_usd) bits.push("$" + Number(ev.total_cost_usd).toFixed(4));
      if (ev.num_turns) bits.push(ev.num_turns + " turns");
      if (bits.length) scroll.appendChild(el("div", "msg-meta", bits.join(" · ")));
      if (ev.is_error) addMessage("system", "That turn reported an error.");
      toBottom();
      return;
    }

    /* Ask-first mode: the turn is paused until this is answered, so the
       question is a card in the transcript rather than a dialog somewhere
       else. It disappears the moment it is answered. */
    if (ev.type === "joya_permission") {
      var card = el("div", "permission");
      card.appendChild(el("div", "perm-title", ev.title || "May it run this?"));
      var what = el("div", "perm-what");
      what.appendChild(el("span", "tool-name", ev.tool));
      what.appendChild(el("span", "tool-arg", summarise(ev.input)));
      card.appendChild(what);
      if (ev.description) card.appendChild(el("div", "perm-desc", ev.description));

      var row = el("div", "perm-actions");
      var allow = el("button", "btn primary small", "Allow");
      var deny = el("button", "btn small", "Skip");
      allow.type = "button";
      deny.type = "button";

      // Allow asks for Windows Hello (or the authenticator code) first: the
      // server answers 428 with a challenge (lib/stepup.js), public/step-up.js asks.
      function sendAnswer(decision, extra) {
        var body = { request_id: String(ev.request_id), decision: decision };
        Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
        return post("/console/" + sessionId + "/permission", body).then(function (r) {
          if (r.ok) return r;
          return r.json().catch(function () { return {}; }).then(function (j) {
            var e = new Error(j.error || "HTTP " + r.status);
            e.status = r.status;
            if (j.step_up) e.stepUp = j.step_up;
            throw e;
          });
        });
      }
      function answer(decision) {
        allow.disabled = true;
        deny.disabled = true;
        sendAnswer(decision)
          .catch(function (e) {
            if (e.status === 428 && e.stepUp && window.JoyaStepUp)
              return window.JoyaStepUp.ask(e.stepUp, function (proof) { return sendAnswer(decision, { step_up: JSON.stringify(proof) }); });
            throw e;
          })
          .then(function () {
            card.className = "permission answered";
            row.textContent = decision === "allow" ? "Allowed" : "Skipped";
            status.textContent = "working…";
          }, function (e) {
            allow.disabled = false;
            deny.disabled = false;
            if (!(e && e.code === "step-up-cancelled")) addMessage("system", "Could not send that answer" + (e && e.message ? ": " + e.message : "."));
          });
      }

      allow.addEventListener("click", function () { answer("allow"); });
      deny.addEventListener("click", function () { answer("deny"); });
      row.appendChild(allow);
      row.appendChild(deny);
      card.appendChild(row);
      scroll.appendChild(card);
      status.textContent = "waiting for you…";
      toBottom(true);
      return;
    }

    if (ev.type === "joya_error") {
      addMessage("system", "Could not run that turn: " + ev.error);
      return;
    }

    if (ev.type === "joya_done" && ev.exit_code !== 0) {
      addMessage(
        "system",
        ev.stderr ? "Ended with an error:\n" + ev.stderr : "The turn ended unexpectedly."
      );
    }
  }

  function post(path, extra) {
    var body = new URLSearchParams();
    body.set("_csrf", csrf);
    Object.keys(extra || {}).forEach(function (k) {
      body.set(k, extra[k]);
    });
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  /**
   * The same thing, as JSON, for the two routes that carry a payload.
   *
   * An attachment or a recording is base64 in the body, and the form parser
   * this app mounts globally caps a form at 64KB -- so those routes were
   * answering 413 to anything bigger, even though each of them mounts a JSON
   * parser that allows 44MB. That parser was never reached: it ignores a body
   * sent as a form, which is what every call here was sending. Which is to say
   * an attachment over about 48KB has never worked.
   */
  function postJson(path, extra) {
    var payload = { _csrf: csrf };
    Object.keys(extra || {}).forEach(function (k) {
      payload[k] = extra[k];
    });
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  function send(text) {
    var ready = attached.filter(function (a) { return !a.pending && a.path; });
    if (running || (!text.trim() && !ready.length)) return;
    if (attached.some(function (a) { return a.pending; })) {
      status.textContent = "still uploading…";
      return;
    }

    // Attachments reach the model as paths it can open with its own tools,
    // listed above the message so it knows they belong to what was just said.
    var body = text;
    if (ready.length) {
      body =
        "Attached files:\n" +
        ready.map(function (a) { return "- " + a.path; }).join("\n") +
        (text.trim() ? "\n\n" + text : "");
    }

    addMessage("user", body);
    input.value = "";
    input.style.height = "";
    attached = [];
    drawAttachments();
    setRunning(true);
    status.textContent = "working…";

    var ctx = { bubble: null, activity: null, text: "", frame: 0 };

    post("/console/" + sessionId + "/send", { prompt: body })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(
            function (d) {
              throw new Error(d.error || "Request refused.");
            },
            function () {
              throw new Error("Request refused.");
            }
          );
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              if (buffer.trim()) {
                try {
                  handleEvent(JSON.parse(buffer), ctx);
                } catch (e) {
                  /* a trailing partial line is not ours to interpret */
                }
              }
              return;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split("\n");
            buffer = lines.pop();
            lines.forEach(function (line) {
              if (!line.trim()) return;
              try {
                handleEvent(JSON.parse(line), ctx);
              } catch (e) {
                /* not an event we emitted */
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        addMessage("system", e.message || "The connection dropped.");
      })
      .then(function () {
        setRunning(false);
        toBottom(true);
        // The turn is over. If nothing is still being spoken, the microphone
        // opens again here; if something is, it opens when the queue drains.
        live.done();
      });
  }

  /* ------------------------------------------------------- attachments -- */

  var attachBox = document.getElementById("chat-attachments");
  var fileInput = document.getElementById("chat-file");
  var attachBtn = document.getElementById("chat-attach");
  var micBtn = document.getElementById("chat-mic");
  var attached = [];

  function drawAttachments() {
    attachBox.textContent = "";
    attachBox.hidden = attached.length === 0;
    attached.forEach(function (item, i) {
      var chip = el("span", "attachment" + (item.pending ? " pending" : ""));
      chip.appendChild(el("span", "attachment-name", item.name));
      if (!item.pending) {
        var x = el("button", "attachment-x", "×");
        x.type = "button";
        x.title = "Remove";
        x.addEventListener("click", function () {
          attached.splice(i, 1);
          drawAttachments();
        });
        chip.appendChild(x);
      }
      attachBox.appendChild(chip);
    });
  }

  /* Uploaded rather than inlined: the console reads files from disk with its
     own tools, exactly as it would a file that was already there, so a path is
     more useful to it than a blob would be. */
  function upload(file) {
    var item = { name: file.name || "file", pending: true };
    attached.push(item);
    drawAttachments();

    var reader = new FileReader();
    reader.onload = function () {
      var b64 = String(reader.result).split(",")[1] || "";
      postJson("/console/" + sessionId + "/upload", { name: item.name, data: b64 })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) throw new Error(d.error);
          item.pending = false;
          item.path = d.path;
          drawAttachments();
        })
        .catch(function (e) {
          attached.splice(attached.indexOf(item), 1);
          drawAttachments();
          addMessage("system", "Could not attach " + item.name + ": " + e.message);
        });
    };
    reader.readAsDataURL(file);
  }

  attachBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    Array.prototype.forEach.call(fileInput.files, upload);
    fileInput.value = "";
  });

  input.addEventListener("paste", function (ev) {
    var items = (ev.clipboardData && ev.clipboardData.files) || [];
    if (!items.length) return;
    ev.preventDefault();
    Array.prototype.forEach.call(items, upload);
  });

  ["dragover", "drop"].forEach(function (name) {
    compose.addEventListener(name, function (ev) {
      ev.preventDefault();
      compose.classList.toggle("dropping", name === "dragover");
      if (name === "drop" && ev.dataTransfer && ev.dataTransfer.files) {
        Array.prototype.forEach.call(ev.dataTransfer.files, upload);
      }
    });
  });
  compose.addEventListener("dragleave", function () {
    compose.classList.remove("dropping");
  });

  /* -------------------------------------------------------------- voice -- */

  var recorder = null;
  var chunks = [];

  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  micBtn.addEventListener("click", function () {
    if (micBtn.disabled) return;
    if (recorder && recorder.state === "recording") return stopRecording();
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return addMessage("system", "This browser cannot record audio.");
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        chunks = [];
        recorder = recorderFor(stream);
        recorder.ondataavailable = function (e) {
          if (e.data.size) chunks.push(e.data);
        };
        recorder.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          micBtn.classList.remove("recording");
          status.textContent = "transcribing…";

          var blob = new Blob(chunks, { type: String(recorder.mimeType || "audio/webm").split(";")[0] });
          var reader = new FileReader();
          reader.onload = function () {
            postJson("/console/" + sessionId + "/transcribe", {
              data: String(reader.result).split(",")[1] || "",
              mime: blob.type,
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                status.textContent = "";
                if (d.error) throw new Error(d.error);
                // Dropped into the box rather than sent, so a mis-heard word
                // can be fixed before it goes anywhere.
                input.value = input.value ? input.value + " " + d.text : d.text;
                resize();
                input.focus();
              })
              .catch(function (e) {
                status.textContent = "";
                addMessage("system", "Could not transcribe that: " + e.message);
              });
          };
          reader.readAsDataURL(blob);
        };
        recorder.start();
        micBtn.classList.add("recording");
        status.textContent = "recording — tap the mic to stop";
      })
      .catch(function () {
        addMessage("system", "Microphone access was refused.");
      });
  });

  sendBtn.addEventListener("click", function () {
    send(input.value);
  });

  /* The textarea grows with the message, up to a point, so a long paste is
     readable without pushing the transcript off screen. */
  function resize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }
  input.addEventListener("input", resize);

  /* Enter sends, Shift+Enter breaks the line -- the convention every chat uses,
     and the reason this is a textarea rather than an input. */
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      send(input.value);
    }
  });

  stopBtn.addEventListener("click", function () {
    status.textContent = "stopping…";
    post("/console/" + sessionId + "/stop", {}).catch(function () {
      /* the stream ending is the real signal that it stopped */
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-suggest]"), function (btn) {
    btn.addEventListener("click", function () {
      input.value = btn.getAttribute("data-suggest");
      input.focus();
    });
  });

  /* --------------------------------------------------------- live mode -- *
   *
   * Talk to it, hear the answer, keep talking. The microphone, the streaming
   * reply, knowing when you have stopped speaking, and speaking back. Hearing
   * and speaking are OpenAI's (transcription, and the realtime voice reading
   * each sentence word for word), always through this panel's server -- the
   * browser never talks to OpenAI. Without a key the Live button stays off.
   *
   * Half duplex, deliberately. The microphone is closed while the answer is
   * playing, because a laptop speaker three inches from a laptop microphone
   * means the machine hears itself, transcribes itself, and answers itself.
   * Echo cancellation makes that less likely, not impossible, and the failure
   * is a loop that costs real money.
   *
   * The reply is spoken sentence by sentence as it streams, not at the end,
   * and the next sentences are fetched while this one plays, so there is no
   * round trip between them.
   */
  var live = (function () {
    var btn = document.getElementById("chat-live");
    var idle = { on: false, feed: function () {}, flush: function () {}, done: function () {} };
    // A disabled button is the no-key state: the page already says where to add one.
    if (!btn || btn.disabled || !window.AudioContext || !navigator.mediaDevices) return idle;

    var on = false;
    var stream = null;
    var ac = null;
    var analyser = null;
    var rec = null;
    var chunks = [];
    var poll = 0;
    var heard = false;      // speech has been detected since the recorder started
    var quietFor = 0;       // consecutive quiet samples
    var floor = 0.006;      // noise floor, learned on the way in
    var calibrating = 0;

    var SAMPLE_MS = 50;
    var END_MS = 450;       // silence that ends an utterance
    var RESET_MS = 6000;    // silence with no speech at all: drop what we have
    var MIN_MS = 300;       // shorter than this is a cough, not a sentence
    var BARGE_MS = 330;     // sustained speech over the answer before it yields

    var spoken = 0;         // how much of the current reply has been queued
    var queue = [];         // sentences waiting to be spoken, fetched a few ahead
    var gen = 0;            // bumped on barge-in/stop: anything older is dropped
    var AHEAD = 3;
    var audio = null;
    var busy = false;       // a clip is playing or being fetched
    var speaking = false;   // audio is on the speaker right now
    var loudFor = 0;        // consecutive loud samples while it is speaking

    /* ---- what is worth saying aloud ----
       A reply is written to be read: it has code blocks, tables, backticks and
       URLs in it. Read out, those are noise -- "backtick sudo systemctl
       backtick" helps nobody -- so they are replaced by something a listener
       can actually use, and the screen keeps the real thing. */
    function speakable(text) {
      return String(text)
        .replace(/```[\s\S]*?```/g, " (code) ")
        .replace(/`[^`\n]+`/g, function (m) { return m.replace(/`/g, ""); })
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " a link ")
        .replace(/^\s*[#>]+\s*/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/[*_~|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    /** Complete sentences in `text` after `from`, and where they end. */
    function sentences(text, from) {
      var rest = text.slice(from);
      var out = [];
      var at = 0;
      var re = /[^.!?\n]*[.!?\n]+/g;
      var m;
      while ((m = re.exec(rest))) {
        var piece = m[0].trim();
        at = re.lastIndex;
        if (piece) out.push(piece);
      }
      return { list: out, consumed: from + at };
    }

    function enqueue(piece) {
      var say = speakable(piece);
      // A line that was nothing but a code fence or a rule has nothing in it to
      // say; queueing it would spend a second of silence on punctuation.
      if (say.length < 2 || !/[a-z0-9]/i.test(say)) return;
      queue.push({ text: say.slice(0, 780) });
      prefetch();
      pump();
    }

    /* Ask for the next few sentences now, so each is ready when its turn
       comes. 204 means the voice would not read it word for word: skipped. */
    function fetchClip(text) {
      var ctrl = window.AbortController ? new AbortController() : null;
      var clip = fetch("/console/" + sessionId + "/speak", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ _csrf: csrf, text: text }),
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then(function (res) {
          if (res.status === 204 || !res.ok) return null;
          return res.blob();
        })
        .catch(function () { return null; });
      return { clip: clip, ctrl: ctrl };
    }

    function prefetch() {
      for (var i = 0; i < queue.length && i < AHEAD; i++) {
        if (!queue[i].clip) {
          var f = fetchClip(queue[i].text);
          queue[i].clip = f.clip;
          queue[i].ctrl = f.ctrl;
        }
      }
    }

    function dropQueue() {
      gen++;
      queue.forEach(function (q) {
        if (q.ctrl) { try { q.ctrl.abort(); } catch (e) { /* done */ } }
      });
      queue = [];
    }

    function pump() {
      if (busy || !queue.length || !on) return;
      busy = true;
      // The microphone stays open while it talks. That is what lets you cut in,
      // and cutting in is most of the difference between a conversation and a
      // pair of walkie-talkies. The threshold goes up rather than the mic going
      // off, so the answer bleeding back through the speaker is not mistaken
      // for you -- echo cancellation reduces that, it does not remove it.
      speaking = true;
      loudFor = 0;
      // Stop capturing, keep measuring: the meter is what notices you cutting
      // in, the recorder is what would otherwise capture the answer itself.
      recording(false);
      if (!poll) poll = setInterval(tick, SAMPLE_MS);
      var item = queue.shift();
      var my = gen;
      prefetch();
      item.clip
        .then(function (blob) {
          if (!blob || my !== gen) return;
          return new Promise(function (resolve) {
            audio = new Audio(URL.createObjectURL(blob));
            audio.onended = audio.onerror = function () {
              URL.revokeObjectURL(audio.src);
              resolve();
            };
            audio.play().catch(resolve);
          });
        })
        .catch(function () {
          /* One sentence failing to speak is not worth ending the mode over. */
        })
        .then(function () {
          if (my !== gen) return;
          busy = false;
          audio = null;
          if (queue.length) return pump();
          speaking = false;
          loudFor = 0;
          // Nothing left to say: the floor is yours again, but only once the
          // turn itself has finished.
          if (!running) listen(true);
        });
    }

    /**
     * You started talking over it, so it stops.
     *
     * Everything queued goes too, not just the clip playing -- the sentences
     * behind it were an answer to what you have evidently stopped waiting for,
     * and hearing them arrive after you interrupted is worse than silence. The
     * turn is stopped as well where one is running: it would otherwise go on
     * writing, and on paying for, a reply nobody is listening to.
     */
    function bargeIn() {
      if (!speaking) return;
      dropQueue();
      if (audio) {
        try { audio.pause(); } catch (e) { /* already ended */ }
        audio = null;
      }
      busy = false;
      speaking = false;
      loudFor = 0;
      // Capture from this instant, so the interruption is recorded and the
      // half sentence it landed on top of is not.
      recording(true);
      status.textContent = "listening…";
      if (running && stopBtn && !stopBtn.hidden) stopBtn.click();
    }

    /* ---- hearing ---- */

    function level() {
      var buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    }

    function tick() {
      if (!on || !analyser) return;
      var rms = level();

      // The first half second sets the noise floor, so a noisy room does not
      // read as somebody talking and a silent one does not need a loud voice.
      if (calibrating > 0) {
        calibrating--;
        floor = Math.max(floor * 0.8 + rms * 0.2, 0.004);
        return;
      }

      // While it is talking, only a clearly louder and sustained voice counts.
      // A single loud frame is a door or a keystroke; a third of a second of
      // one is a person deciding they have heard enough.
      if (speaking) {
        loudFor = rms > floor * 6 + 0.01 ? loudFor + SAMPLE_MS : 0;
        if (loudFor >= BARGE_MS) bargeIn();
        return;
      }

      if (rms > floor * 3 + 0.004) {
        heard = true;
        quietFor = 0;
        status.textContent = "listening…";
      } else {
        quietFor += SAMPLE_MS;
        if (heard && quietFor >= END_MS) return finishUtterance();
        if (!heard && quietFor >= RESET_MS) return restartRecorder();
      }
    }

    function restartRecorder() {
      if (!rec) return;
      quietFor = 0;
      heard = false;
      if (rec.state !== "inactive") rec.stop();     // onstop starts a fresh one
    }

    function finishUtterance() {
      if (!rec || rec.state === "inactive") return;
      rec.stop();
    }

    function newRecorder(send_it) {
      chunks = [];
      heard = false;
      quietFor = 0;
      var started = Date.now();
      rec = recorderFor(stream);
      rec.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      var r = rec;
      rec.onstop = function () {
        var enough = Date.now() - started > MIN_MS && chunks.length;
        var type = String(r.mimeType || "audio/webm").split(";")[0];
        var blob = enough ? new Blob(chunks, { type: type }) : null;
        if (on && send_it && blob && heard) transcribeAndSend(blob);
        else if (on) newRecorder(true);
      };
      rec.start();
    }

    function transcribeAndSend(blob) {
      listen(false);
      status.textContent = "transcribing…";
      var reader = new FileReader();
      reader.onload = function () {
        postJson("/console/" + sessionId + "/transcribe", {
          data: String(reader.result).split(",")[1] || "",
          mime: blob.type,
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) throw new Error(d.error);
            var said = String(d.text || "").trim();
            // A bracketed label ("[music]") is a noise, not something said.
            // Sending those would answer a cough.
            if (!said || /^[\[(]/.test(said)) throw new Error("nothing said");
            // "Stop listening" said aloud (public/voice-stop.js) ends live
            // mode as the button would, and is not sent.
            if (window.VoiceStop && window.VoiceStop.heard(said)) return stoppedByVoice();
            spoken = 0;
            send(said);
          })
          .catch(function () {
            if (on) listen(true);
          });
      };
      reader.readAsDataURL(blob);
    }

    /**
     * Capture on or off, independently of whether we are measuring the room.
     *
     * These are two different things and conflating them is how a speech
     * assistant ends up talking to itself: the level meter has to keep running
     * while the answer plays, so that cutting in can be noticed, but the
     * recorder must not -- or the next utterance would arrive with the machine's
     * own sentence at the front of it, be transcribed, and be sent back as
     * something you said.
     */
    function recording(want) {
      if (want) {
        if (rec && rec.state === "recording") return;
        newRecorder(true);
      } else {
        if (rec && rec.state !== "inactive") {
          rec.onstop = null;    // a deliberate close sends nothing
          rec.stop();
        }
        rec = null;
      }
    }

    /** Open or close the microphone without leaving the mode. */
    function listen(want) {
      if (!on) want = false;
      if (want) {
        if (rec && rec.state === "recording") return;
        calibrating = 10;
        recording(true);
        if (!poll) poll = setInterval(tick, SAMPLE_MS);
        status.textContent = "listening…";
      } else {
        if (poll) { clearInterval(poll); poll = 0; }
        recording(false);
      }
    }

    function start() {
      navigator.mediaDevices
        .getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        .then(function (s) {
          stream = s;
          ac = new AudioContext();
          analyser = ac.createAnalyser();
          analyser.fftSize = 1024;
          ac.createMediaStreamSource(stream).connect(analyser);
          on = true;
          btn.classList.add("on");
          btn.setAttribute("aria-pressed", "true");
          listen(true);
        })
        .catch(function () {
          addMessage("system", "Live mode needs the microphone, and it was refused.");
        });
    }

    function stop() {
      on = false;
      listen(false);
      dropQueue();
      if (audio) { audio.pause(); audio = null; }
      busy = false;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      if (ac) { ac.close(); ac = null; }
      analyser = null;
      btn.classList.remove("on");
      btn.setAttribute("aria-pressed", "false");
      status.textContent = "";
    }

    /** The stop command was heard: off, with a note that fades. */
    function stoppedByVoice() {
      stop();
      status.textContent = "stopped listening";
      setTimeout(function () { if (!on && status.textContent === "stopped listening") status.textContent = ""; }, 4000);
    }

    btn.addEventListener("click", function () {
      on ? stop() : start();
    });

    return {
      get on() { return on; },
      /** Called as the reply grows: queue whole sentences, keep the remainder. */
      feed: function (text) {
        if (!on) return;
        var found = sentences(text, spoken);
        spoken = found.consumed;
        found.list.forEach(enqueue);
      },
      /** The turn is over: say whatever was left without its full stop. */
      flush: function (text) {
        if (!on) return;
        var rest = text.slice(spoken).trim();
        spoken = text.length;
        if (rest) enqueue(rest);
      },
      /** Nothing more is coming; listen again once the queue has drained. */
      done: function () {
        if (on && !busy && !queue.length) listen(true);
      },
    };
  })();

  toBottom(true);
  input.focus();
})();

/* A details-based menu closes on its own summary but not on anything else, so
   these two habits -- click away, press Escape -- are added back. Without them
   the menu still works; it just outstays its welcome. */
(function () {
  document.addEventListener("click", function (ev) {
    Array.prototype.forEach.call(document.querySelectorAll("details.menu[open]"), function (menu) {
      if (!menu.contains(ev.target)) menu.open = false;
    });
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    Array.prototype.forEach.call(document.querySelectorAll("details.menu[open]"), function (menu) {
      menu.open = false;
      var summary = menu.querySelector("summary");
      if (summary) summary.focus();
    });
  });
})();

/* Filter the chat list by name. Hides rows rather than rebuilding the list, so
   the current chat keeps its place and nothing reflows beyond the sidebar. */
(function () {
  var filter = document.getElementById("chat-filter");
  if (!filter) return;

  filter.addEventListener("input", function () {
    var needle = filter.value.trim().toLowerCase();
    Array.prototype.forEach.call(document.querySelectorAll(".chat-item"), function (item) {
      var hay = item.getAttribute("data-search") || "";
      item.hidden = needle !== "" && hay.indexOf(needle) === -1;
    });

    // Searching should look everywhere, including the drawer things were put
    // away in.
    var archive = document.querySelector(".chat-archive");
    if (archive && needle) archive.open = true;
  });
})();

/* Selects that apply on change, so the chat header needs no Apply button. */
(function () {
  Array.prototype.forEach.call(
    document.querySelectorAll("select[data-autosubmit]"),
    function (sel) {
      sel.addEventListener("change", function () {
        if (sel.form) sel.form.submit();
      });
    }
  );

  Array.prototype.forEach.call(
    document.querySelectorAll("[data-set-access]"),
    function (link) {
      link.addEventListener("click", function (ev) {
        ev.preventDefault();
        var form = document.querySelector(".chat-controls");
        if (!form) return;
        var sel = form.querySelector('select[name="access"]');
        if (!sel || sel.disabled) return;
        sel.value = link.getAttribute("data-set-access");
        form.submit();
      });
    }
  );
})();

/* ------------------------------------------------------- WhatsApp linking --
 *
 * WhatsApp rotates its pairing code every twenty seconds, so a code rendered
 * when the page loaded is dead before most people have found Linked Devices on
 * their phone. That is what made linking look broken: the bridge was fine, the
 * picture was stale. This keeps the picture current, and reloads the page the
 * moment the phone accepts it.
 */
(function () {
  var box = document.getElementById("wa-link");
  if (!box) return;

  var img = document.getElementById("wa-qr");
  var age = document.getElementById("wa-age");
  var hint = document.getElementById("wa-hint");
  var slug = box.getAttribute("data-slug");
  var seen = img.getAttribute("src");
  var since = Date.now();
  var failures = 0;

  /* A ring that empties over the code's twenty-second life, so a code about to
     turn over is visibly about to turn over. */
  function tick() {
    var left = Math.max(0, 20 - Math.round((Date.now() - since) / 1000));
    age.textContent = left ? left + "s" : "…";
  }

  function poll() {
    fetch("/channels/" + encodeURIComponent(slug) + "/whatsapp/status", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (r) {
        if (!r.ok) throw new Error("status " + r.status);
        return r.json();
      })
      .then(function (d) {
        failures = 0;

        // Linked: the rest of the page is now wrong, so let the server draw it.
        if (d.linked) {
          hint.textContent = "Linked" + (d.number ? " as +" + d.number : "") + ". Reloading…";
          return window.location.reload();
        }

        if (d.status === "logged_out") return window.location.reload();

        if (d.qr && d.qr !== seen) {
          seen = d.qr;
          img.src = d.qr;
          since = Date.now();
        }
        // The bridge dropped the code entirely -- reconnecting, usually. The
        // page it draws for that state explains itself better than this one.
        if (!d.qr && d.status !== "qr") return window.location.reload();
        tick();
      })
      .catch(function () {
        // A blip is not worth alarming anyone over; a run of them is.
        if (++failures >= 4) {
          hint.textContent = "Lost contact with the bridge. Check its logs.";
        }
      });
  }

  setInterval(tick, 1000);
  setInterval(poll, 2500);
  tick();
})();

/* ------------------------------------------------- channel type switching --
 *
 * The channel form carries both a Telegram card and a WhatsApp one and hides
 * the irrelevant half with CSS. Hidden is not the same as absent: the fields
 * are still submitted and still validated, so a Telegram user ID typed before
 * switching to WhatsApp blocked the form with "an invalid form control is not
 * focusable" -- a complaint about something the reader could no longer see.
 *
 * Disabling them takes them out of both. Progressive enhancement: with no
 * script the form still works, it is merely fussier than it needs to be.
 */
(function () {
  var radios = document.querySelectorAll('input[name="type"]');
  if (!radios.length) return;

  function sync() {
    var chosen = document.querySelector('input[name="type"]:checked');
    var type = chosen ? chosen.value : "telegram";
    [
      [".only-telegram", type !== "telegram"],
      [".only-whatsapp", type !== "whatsapp"],
    ].forEach(function (pair) {
      var card = document.querySelector(pair[0]);
      if (!card) return;
      Array.prototype.forEach.call(card.querySelectorAll("input, select, textarea"), function (f) {
        f.disabled = pair[1];
      });
    });
  }

  Array.prototype.forEach.call(radios, function (r) {
    r.addEventListener("change", sync);
  });
  sync();
})();
