/* JOYA Studio -- uploads (chunked, resumable), the videos table, the edit page with preview,
   poster, captions, visibility, trash, and per-video analytics. Plain JS, same-origin requests only. */
(function () {
  'use strict';
  var body = document.body;
  var page = body.getAttribute('data-page');
  var main = document.getElementById('main');
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var nf = new Intl.NumberFormat('en');
  var VIS = {
    public: { shape: '●', word: 'Public', hint: 'Listed on the library home page, in its folder and in Up next. Anyone can watch.' },
    unlisted: { shape: '◐', word: 'Unlisted', hint: 'Not listed or searchable anywhere. Only people with the link can watch. Good for drafts.' },
    private: { shape: '○', word: 'Private', hint: 'Only you, here in the studio. The public link does not work.' },
    trash: { shape: '▲', word: 'In the trash', hint: '' }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function bytes(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(b / 1e3)) + ' kB';
  }
  function clock(t) {
    t = Math.max(0, Math.floor(t || 0));
    var hh = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (hh ? hh + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function spoken(t) {
    t = Math.round(t || 0);
    if (t < 60) return t + ' s';
    var m = Math.floor(t / 60), s = t % 60;
    if (m < 60) return m + ' min' + (s ? ' ' + s + ' s' : '');
    var hh = Math.floor(m / 60); m = m % 60;
    return hh + ' h' + (m ? ' ' + m + ' min' : '');
  }
  function fdate(iso) {
    if (!iso) return '';
    var p = iso.slice(0, 10).split('-');
    return +p[2] + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[+p[1] - 1] + ' ' + p[0];
  }
  function stateHtml(vis) {
    var s = VIS[vis] || VIS.private;
    return '<span class="state state-' + vis + '"><span class="shape" aria-hidden="true">' + s.shape + '</span>' + s.word + '</span>';
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function api(method, url, data, opts) {
    opts = opts || {};
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (data !== undefined && !(data instanceof Blob) && typeof data !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(data);
    } else if (data !== undefined) {
      init.body = data;
      if (opts.type) init.headers['Content-Type'] = opts.type;
    }
    return fetch(url, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && page !== 'login') { location.href = '/studio/login?next=' + encodeURIComponent(location.pathname); throw new Error('Signed out'); }
        if (!r.ok) { var e = new Error(j.error || ('The server answered ' + r.status + '.')); e.status = r.status; e.data = j; throw e; }
        return j;
      });
    });
  }

  var toastZone = null;
  function toast(text, bad) {
    if (!toastZone) {
      toastZone = h('<div class="toast-zone" role="status" aria-live="polite"></div>');
      document.body.appendChild(toastZone);
    }
    var t = h('<div class="toast' + (bad ? ' bad' : '') + '"></div>');
    t.textContent = text;
    toastZone.appendChild(t);
    setTimeout(function () { t.remove(); }, bad ? 7000 : 3500);
  }

  var signout = $('#signout');
  if (signout) signout.addEventListener('click', function () {
    api('POST', '/api/studio/logout', {}).then(function () { location.href = '/studio/login'; },
      function () { location.href = '/studio/login'; });
  });

  /* ================================================================ sign in */
  if (page === 'login') {
    var form = $('#login-form');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      var old = $('.form-error'); if (old) old.remove();
      btn.disabled = true; btn.textContent = 'Signing in…';
      api('POST', '/api/studio/login', { name: form.name.value, password: form.password.value, next: form.next.value })
        .then(function (j) { location.href = j.next || '/studio/'; })
        .catch(function (err) {
          btn.disabled = false; btn.textContent = 'Sign in';
          var p = h('<p class="form-error" role="alert"><span aria-hidden="true">▲ </span></p>');
          p.appendChild(document.createTextNode(err.message));
          form.parentNode.insertBefore(p, form);
          form.password.value = ''; form.password.focus();
        });
    });
    var nameField = $('#name');
    if (nameField && !nameField.value) nameField.focus(); else if ($('#password')) $('#password').focus();
    return;
  }

  /* ================================================================ shared bits */
  function folderOptions(folders, current) {
    return folders.map(function (f) {
      return '<option value="' + esc(f.slug) + '"' + (f.slug === current ? ' selected' : '') + '>' + esc(f.title) + '</option>';
    }).join('') + '<option value="__new">New folder…</option>';
  }
  function visFieldset(name, current, disabled) {
    return '<fieldset class="vis"><legend>Who can see it</legend>' + ['public', 'unlisted', 'private'].map(function (k) {
      var s = VIS[k];
      return '<label><input type="radio" name="' + name + '" value="' + k + '"' + (k === current ? ' checked' : '') +
        (disabled ? ' disabled' : '') + '><span class="t"><span aria-hidden="true">' + s.shape + '</span> ' + s.word +
        '</span><span class="d">' + s.hint + '</span></label>';
    }).join('') + '</fieldset>';
  }
  // A select with "New folder…": asks for a name inline and creates it.
  function wireFolderSelect(sel, onFolders) {
    var prev = sel.value;
    sel.addEventListener('change', function () {
      if (sel.value !== '__new') { prev = sel.value; return; }
      var name = window.prompt('Name of the new folder');
      if (!name || !name.trim()) { sel.value = prev; return; }
      api('POST', '/api/studio/folders', { title: name.trim() }).then(function (j) {
        var opt = document.createElement('option');
        opt.value = j.folder.slug; opt.textContent = j.folder.title;
        sel.insertBefore(opt, sel.querySelector('option[value="__new"]'));
        sel.value = j.folder.slug; prev = sel.value;
        if (onFolders) onFolders(j.folder);
        toast('Folder “' + j.folder.title + '” created.');
      }).catch(function (err) { sel.value = prev; toast(err.message, true); });
    });
  }

  /* ================================================================ list page */
  if (page === 'list') {
    var CHUNK = parseInt(body.getAttribute('data-chunk'), 10) || 8 * 1024 * 1024;
    var state = { videos: [], folders: [], jobs: [], filter: 'all', q: '' };
    main.innerHTML =
      '<div class="wrap">' +
      '<div class="page-head"><div><h1>Your videos</h1><p class="lead">Upload, edit and share. Public videos are listed in the library; unlisted ones open only by their link; private ones only here.</p></div>' +
      '<div class="file-pick"><input type="file" id="pick" accept="video/*,.mp4,.mov,.mkv,.webm,.m4v" multiple>' +
      '<label for="pick" class="btn btn-primary" id="pick-label">Upload video</label></div></div>' +
      '<section class="uploads" id="uploads" aria-label="Uploads"></section>' +
      '<div class="dropzone" id="dropzone"><strong>Drop video files anywhere on this page</strong><span>or use Upload video. MP4, MOV, MKV or WebM, up to 50 GB. A stopped upload resumes when you pick the same file again.</span></div>' +
      '<div class="vtools"><div class="filters" role="group" aria-label="Show"></div>' +
      '<div class="vsearch"><label class="sr" for="vq">Search your videos</label><input type="search" id="vq" placeholder="Search your videos" autocomplete="off"></div></div>' +
      '<div id="vlist"></div></div>';
    var pick = $('#pick');
    pick.addEventListener('change', function () { Array.prototype.forEach.call(pick.files, startUpload); pick.value = ''; });

    // Drag and drop anywhere.
    var overlay = null, dragDepth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth++;
      if (!overlay) { overlay = h('<div class="drop-overlay" aria-hidden="true"><div>Drop to upload</div></div>'); document.body.appendChild(overlay); }
    });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth--; if (dragDepth <= 0 && overlay) { overlay.remove(); overlay = null; dragDepth = 0; } });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; if (overlay) { overlay.remove(); overlay = null; }
      Array.prototype.forEach.call(e.dataTransfer.files, startUpload);
    });

    var vq = $('#vq');
    vq.addEventListener('input', function () { state.q = vq.value.trim().toLowerCase(); renderList(); });

    function load() {
      return api('GET', '/api/studio/library').then(function (j) {
        state.videos = j.videos; state.folders = j.folders; state.jobs = j.jobs;
        renderFilters(); renderList(); renderJobs();
      }).catch(function (err) { $('#vlist').innerHTML = '<p class="msg bad">' + esc(err.message) + '</p>'; });
    }

    function renderFilters() {
      var n = { all: 0, public: 0, unlisted: 0, private: 0, trash: 0 };
      state.videos.forEach(function (v) { n[v.visibility]++; if (v.visibility !== 'trash') n.all++; });
      var labels = [['all', 'All'], ['public', 'Public'], ['unlisted', 'Unlisted'], ['private', 'Private'], ['trash', 'Trash']];
      $('.filters').innerHTML = labels.map(function (x) {
        return '<button type="button" data-f="' + x[0] + '" aria-pressed="' + (state.filter === x[0]) + '">' + x[1] +
          ' <span class="n">' + n[x[0]] + '</span></button>';
      }).join('');
      $$('.filters button').forEach(function (b) {
        b.addEventListener('click', function () { state.filter = b.getAttribute('data-f'); renderFilters(); renderList(); });
      });
    }

    function renderList() {
      var list = state.videos.filter(function (v) {
        if (state.filter === 'all' ? v.visibility === 'trash' : v.visibility !== state.filter) return false;
        if (state.q && (v.title + ' ' + v.desc + ' ' + v.slug).toLowerCase().indexOf(state.q) === -1) return false;
        return true;
      });
      var box = $('#vlist');
      if (!list.length) {
        var msg = state.q ? 'No videos match “' + esc(vq.value.trim()) + '”.' :
          state.filter === 'trash' ? 'The trash is empty. Videos you move to the trash wait here, and you can restore them.' :
          state.filter === 'all' ? 'No videos yet. Upload one to start.' : 'No ' + VIS[state.filter].word.toLowerCase() + ' videos.';
        box.innerHTML = '<div class="empty"><h2>' + (state.filter === 'trash' ? 'Nothing in the trash' : 'Nothing here') + '</h2><p>' + msg + '</p></div>';
        return;
      }
      var folderName = {};
      state.folders.forEach(function (f) { folderName[f.slug] = f.title; });
      box.innerHTML = '<table class="vtable"><caption class="sr">Your videos</caption><thead><tr><th scope="col">Video</th><th scope="col">Visibility</th>' +
        '<th scope="col">Folder</th><th scope="col">Date</th><th scope="col" class="num">Views</th><th scope="col" class="num">Unique viewers</th>' +
        '<th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' + list.map(function (v) {
          var edit = '/studio/v/' + encodeURIComponent(v.slug);
          var actions = v.visibility === 'trash'
            ? '<button type="button" class="btn btn-small" data-restore="' + esc(v.slug) + '">Restore</button>'
            : '<a class="btn btn-small" href="' + edit + '">Edit<span class="sr"> ' + esc(v.title) + '</span></a>' +
              (v.url ? '<a class="btn btn-small" href="' + esc(v.url) + '" target="_blank" rel="noopener">Open<span class="sr"> ' + esc(v.title) + ' in a new tab</span></a>' : '');
          return '<tr><td class="c-video"><div class="vcell"><span class="vthumb">' +
            (v.poster ? '<img src="' + esc(v.poster) + '" alt="" loading="lazy">' : '') +
            '<span class="badge">' + clock(v.duration) + '</span></span><div>' +
            (v.visibility === 'trash' ? '<span class="vtitle">' + esc(v.title) + '</span>' : '<a class="vtitle" href="' + edit + '">' + esc(v.title) + '</a>') +
            '<p class="vdesc">' + esc(v.desc || 'No description') + '</p></div></div></td>' +
            '<td data-label="Visibility">' + stateHtml(v.visibility) + '</td>' +
            '<td data-label="Folder">' + esc(folderName[v.folder] || v.folder) + '</td>' +
            '<td data-label="Date">' + (v.visibility === 'trash' ? 'Trashed ' + fdate(v.trashed_at) : fdate(v.date)) + '</td>' +
            '<td data-label="Views" class="num">' + nf.format(v.views) + '</td>' +
            '<td data-label="Unique viewers" class="num">' + nf.format(v.uniques) + '</td>' +
            '<td class="c-act"><div class="row-actions">' + actions + '</div></td></tr>';
        }).join('') + '</tbody></table>';
      $$('[data-restore]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          b.disabled = true;
          api('POST', '/api/studio/videos/' + b.getAttribute('data-restore') + '/restore', {}).then(function () {
            toast('Restored as Private. Open it to choose who can see it.');
            load();
          }).catch(function (err) { b.disabled = false; toast(err.message, true); });
        });
      });
    }

    /* ---- uploads ---- */
    var uploads = [];
    function anyActive() { return uploads.some(function (u) { return u.state === 'uploading'; }); }
    window.addEventListener('beforeunload', function (e) { if (anyActive()) { e.preventDefault(); e.returnValue = ''; } });

    function startUpload(file) {
      if (!/^video\//.test(file.type) && !/\.(mp4|mov|mkv|webm|m4v|avi|mxf)$/i.test(file.name)) {
        toast(file.name + ' is not a video file.', true); return;
      }
      var u = { file: file, state: 'starting', received: 0, speed: 0, job: null, saved: false };
      uploads.push(u);
      u.el = h('<article class="upcard" aria-label="Upload of ' + esc(file.name) + '"></article>');
      $('#uploads').prepend(u.el);
      var base = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
      u.el.innerHTML =
        '<div class="uphead"><div><p class="upname"></p><p class="upstatus" aria-live="polite">Starting…</p></div>' +
        '<div class="upactions"><button type="button" class="btn btn-small" data-act="pause">Pause</button>' +
        '<button type="button" class="btn btn-small" data-act="cancel">Cancel</button></div></div>' +
        '<div class="upbar" role="progressbar" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>' +
        '<form class="upform" novalidate>' +
        '<div class="field span2"><label>Title</label><input type="text" name="title" maxlength="200" required></div>' +
        '<div class="field span2"><label>Description</label><textarea name="desc" rows="3" maxlength="5000" placeholder="What is it about? Who should watch it?"></textarea></div>' +
        '<div class="field"><label>Folder</label><select name="folder">' + folderOptions(state.folders, 'pre-read') + '</select></div>' +
        '<div class="field"><label>Date shown</label><input type="date" name="date" value="' + today() + '"></div>' +
        '<div class="span2">' + visFieldset('vis-' + uploads.length + '-' + Date.now(), 'private') + '</div>' +
        '<div class="upactions span2"><button type="submit" class="btn btn-primary">Save details</button>' +
        '<span class="saved-note" aria-live="polite"></span></div></form>';
      $$('label', u.el).forEach(function (l, i) {
        var f = l.parentNode.querySelector('input:not([type=radio]),textarea,select');
        if (f && l.parentNode.classList.contains('field')) { f.id = 'up' + Date.now() + '-' + i; l.htmlFor = f.id; }
      });
      $('.upname', u.el).textContent = file.name + ' · ' + bytes(file.size);
      var fm = $('form', u.el);
      fm.title.value = base.charAt(0).toUpperCase() + base.slice(1);
      wireFolderSelect(fm.folder, function (f) { state.folders.push(f); });
      fm.addEventListener('submit', function (e) { e.preventDefault(); saveMeta(u); });
      $('[data-act="pause"]', u.el).addEventListener('click', function () { togglePause(u); });
      $('[data-act="cancel"]', u.el).addEventListener('click', function () { cancelUpload(u); });
      fm.title.focus(); fm.title.select();
      api('POST', '/api/studio/uploads', { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified })
        .then(function (j) {
          u.id = j.upload.id; u.received = j.upload.received; u.chunk = j.upload.chunk || CHUNK;
          if (j.resumed && u.received > 0) toast('Resuming ' + file.name + ' from ' + Math.floor(100 * u.received / file.size) + ' %.');
          if (j.upload.meta) { fillMeta(fm, j.upload.meta); u.saved = true; $('.saved-note', u.el).textContent = 'Details saved.'; }
          u.state = 'uploading';
          u.t0 = Date.now(); u.r0 = u.received;
          pump(u);
        }).catch(function (err) { fail(u, err.message); });
    }
    function fillMeta(fm, m) {
      fm.title.value = m.title || fm.title.value; fm.desc.value = m.desc || '';
      if (m.folder) fm.folder.value = m.folder;
      if (m.date) fm.date.value = m.date;
      var r = fm.querySelector('input[type=radio][value="' + m.visibility + '"]'); if (r) r.checked = true;
    }
    function status(u, text, frac, job) {
      $('.upstatus', u.el).textContent = text;
      var bar = $('.upbar', u.el);
      bar.classList.toggle('is-job', !!job);
      if (frac != null) {
        bar.firstChild.style.width = (frac * 100).toFixed(1) + '%';
        bar.setAttribute('aria-valuenow', Math.floor(frac * 100));
      }
      bar.setAttribute('aria-label', job ? 'Processing progress' : 'Upload progress');
    }
    function uploadText(u) {
      var pct = Math.floor(100 * u.received / u.file.size);
      var el = (Date.now() - u.t0) / 1000, got = u.received - u.r0;
      var rate = el > 2 ? got / el : 0;
      var left = rate > 0 ? (u.file.size - u.received) / rate : 0;
      return 'Uploading ' + pct + ' % · ' + bytes(u.received) + ' of ' + bytes(u.file.size) +
        (left > 0 ? ' · about ' + spoken(left) + ' left' : '');
    }
    function pump(u) {
      if (u.state !== 'uploading') return;
      if (u.received >= u.file.size) return uploaded(u);
      var end = Math.min(u.file.size, u.received + u.chunk);
      var blob = u.file.slice(u.received, end);
      var xhr = new XMLHttpRequest();
      u.xhr = xhr;
      xhr.open('PUT', '/api/studio/uploads/' + u.id + '?offset=' + u.received);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = function (e) {
        var cur = u.received + (e.loaded || 0);
        status(u, uploadText({ received: cur, file: u.file, t0: u.t0, r0: u.r0 }), cur / u.file.size);
      };
      xhr.onload = function () {
        u.xhr = null;
        var j = {}; try { j = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status === 200) { u.received = j.received; u.fails = 0; if (j.job) u.job = j.job; return pump(u); }
        if (xhr.status === 409 && j.received != null) { u.received = j.received; return pump(u); }
        if (xhr.status === 401) { fail(u, 'You were signed out. Sign in again and pick the same file to resume.'); return; }
        retry(u, j.error || ('The server answered ' + xhr.status + '.'));
      };
      xhr.onerror = function () { u.xhr = null; retry(u, 'The connection dropped.'); };
      xhr.send(blob);
    }
    function retry(u, why) {
      if (u.state !== 'uploading') return;
      u.fails = (u.fails || 0) + 1;
      if (u.fails > 8) { fail(u, why + ' Pick the same file again to resume from ' + Math.floor(100 * u.received / u.file.size) + ' %.'); return; }
      var wait = Math.min(30, Math.pow(2, u.fails));
      status(u, why + ' Trying again in ' + wait + ' s…', u.received / u.file.size);
      setTimeout(function () { pump(u); }, wait * 1000);
    }
    function togglePause(u) {
      var b = $('[data-act="pause"]', u.el);
      if (u.state === 'uploading') {
        u.state = 'paused'; if (u.xhr) u.xhr.abort();
        b.textContent = 'Resume'; status(u, 'Paused at ' + Math.floor(100 * u.received / u.file.size) + ' %.', u.received / u.file.size);
      } else if (u.state === 'paused') {
        u.state = 'uploading'; b.textContent = 'Pause'; u.t0 = Date.now(); u.r0 = u.received; pump(u);
      }
    }
    function cancelUpload(u) {
      if (!window.confirm('Stop uploading ' + u.file.name + '? The part sent so far is thrown away.')) return;
      u.state = 'cancelled'; if (u.xhr) u.xhr.abort();
      if (u.id) api('DELETE', '/api/studio/uploads/' + u.id).catch(function () {});
      u.el.remove();
    }
    function fail(u, text) {
      u.state = 'failed';
      status(u, text);
      $('.upstatus', u.el).classList.add('form-error');
      $('[data-act="pause"]', u.el).hidden = true;
    }
    function uploaded(u) {
      u.state = 'uploaded';
      $('[data-act="pause"]', u.el).hidden = true;
      $('[data-act="cancel"]', u.el).hidden = true;
      if (u.job) return watchJob(u);
      status(u, u.saved ? 'Uploaded. Starting to process…' : 'Uploaded. Save the details below to start processing.', 1);
    }
    function saveMeta(u) {
      var fm = $('form', u.el);
      var vis = fm.querySelector('input[type=radio]:checked');
      var note = $('.saved-note', u.el);
      if (!fm.title.value.trim()) { note.textContent = ''; toast('Give the video a title first.', true); fm.title.focus(); return; }
      if (!u.id) { toast('Wait a moment: the upload is still starting.', true); return; }
      var btn = fm.querySelector('button[type="submit"]');
      btn.disabled = true;
      api('POST', '/api/studio/uploads/' + u.id + '/meta', {
        title: fm.title.value.trim(), desc: fm.desc.value, folder: fm.folder.value === '__new' ? 'pre-read' : fm.folder.value,
        date: fm.date.value, visibility: vis ? vis.value : 'private'
      }).then(function (j) {
        btn.disabled = false; u.saved = true;
        note.className = 'saved-note'; note.textContent = 'Details saved.';
        if (j.job) { u.job = j.job; watchJob(u); }
        else if (u.state === 'uploading') btn.textContent = 'Save details again';
      }).catch(function (err) { btn.disabled = false; note.className = 'form-error'; note.textContent = err.message; });
    }
    function watchJob(u) {
      u.state = 'processing';
      $$('input,textarea,select,button[type=submit]', $('form', u.el)).forEach(function (x) { x.disabled = true; });
      $('.saved-note', u.el).textContent = 'Details saved. To change them later, open the video once it is ready.';
      status(u, 'Waiting to process…', 0, true);
      var poll = function () {
        api('GET', '/api/studio/jobs').then(function (j) {
          var job = j.jobs.filter(function (x) { return x.id === u.job; })[0];
          if (!job) { setTimeout(poll, 2000); return; }
          if (job.status === 'done') {
            status(u, 'Ready.', 1, false);
            $('.upstatus', u.el).innerHTML = '<span class="state state-ok"><span class="shape" aria-hidden="true">●</span>Ready</span> · <a href="/studio/v/' + esc(job.slug) + '">Open the video</a>';
            load();
            return;
          }
          if (job.status === 'failed') { fail(u, job.message || 'Processing failed.'); return; }
          status(u, (job.stage || 'Waiting to process') + ' · ' + Math.floor(job.progress * 100) + ' %', job.progress, true);
          setTimeout(poll, 1500);
        }).catch(function () { setTimeout(poll, 4000); });
      };
      poll();
    }
    // Jobs that were running before this page was opened (another tab, a reload).
    function renderJobs() {
      var mine = uploads.map(function (u) { return u.job; });
      state.jobs.forEach(function (j) {
        if (mine.indexOf(j.id) !== -1 || j.status === 'done' || $('#job-' + j.id)) return;
        var el = h('<article class="upcard" id="job-' + j.id + '"><div class="uphead"><div><p class="upname"></p><p class="upstatus" aria-live="polite"></p></div>' +
          '<div class="upactions"></div></div><div class="upbar is-job" role="progressbar" aria-label="Processing progress" aria-valuemin="0" aria-valuemax="100"><span></span></div></article>');
        $('.upname', el).textContent = (j.title || j.file) + ' · ' + bytes(j.size);
        $('#uploads').appendChild(el);
        var tick = function (job) {
          var st = $('.upstatus', el);
          if (job.status === 'failed') {
            st.className = 'upstatus form-error'; st.textContent = job.message || 'Processing failed.';
            var acts = $('.upactions', el);
            if (!acts.firstChild) {
              var b = h('<button type="button" class="btn btn-small">Retry</button>');
              b.addEventListener('click', function () {
                api('POST', '/api/studio/jobs/' + job.id + '/retry', {}).then(function () { acts.innerHTML = ''; st.className = 'upstatus'; follow(); })
                  .catch(function (err) { toast(err.message, true); });
              });
              acts.appendChild(b);
            }
            return false;
          }
          if (job.status === 'done') { el.remove(); load(); return false; }
          st.textContent = (job.stage || 'Waiting to process') + ' · ' + Math.floor(job.progress * 100) + ' %';
          $('.upbar span', el).style.width = (job.progress * 100) + '%';
          return true;
        };
        var follow = function () {
          api('GET', '/api/studio/jobs').then(function (r) {
            var job = r.jobs.filter(function (x) { return x.id === j.id; })[0];
            if (job && tick(job)) setTimeout(follow, 1500);
          }).catch(function () { setTimeout(follow, 4000); });
        };
        if (tick(j)) setTimeout(follow, 1500);
      });
    }
    load();
    return;
  }

  /* ================================================================ video page */
  if (page === 'video') {
    var slug = body.getAttribute('data-slug');
    var V = null;
    var loadVideo = function () {
      return api('GET', '/api/studio/videos/' + encodeURIComponent(slug)).then(function (j) { V = j; render(); })
        .catch(function (err) { main.innerHTML = '<div class="wrap"><p class="msg bad">' + esc(err.message) + '</p></div>'; });
    };

    function render() {
      var v = V.video, trashed = v.visibility === 'trash';
      document.title = v.title + ' · JOYA Studio';
      main.innerHTML =
        '<div class="wrap">' +
        '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/studio/">Your videos</a></li><li aria-current="page">' + esc(v.title) + '</li></ol></nav>' +
        '<div class="page-head"><div><h1 id="vh">' + esc(v.title) + '</h1><p class="lead" id="vstate">' + stateHtml(v.visibility) + '</p></div>' +
        (V.links.page ? '<a class="btn" href="' + esc(V.links.page) + '" target="_blank" rel="noopener">Open the watch page<span class="sr"> in a new tab</span></a>' : '') + '</div>' +
        (trashed ? '<div class="panel danger-zone" style="margin-bottom:24px"><h2>This video is in the trash</h2><p>Nobody can watch it. Restore it to edit it; it comes back as Private.</p><div><button type="button" class="btn btn-primary" id="restore">Restore</button></div></div>' : '') +
        '<div class="vpage">' +
        // left: details
        '<div class="side-stack">' +
        '<form class="panel" id="details" novalidate><div class="panel-head"><h2>Details</h2></div>' +
        '<div class="field"><label for="f-title">Title</label><input type="text" id="f-title" name="title" maxlength="200" required></div>' +
        '<div class="field"><label for="f-desc">Description</label><textarea id="f-desc" name="desc" rows="6" maxlength="5000"></textarea></div>' +
        '<div class="upform"><div class="field"><label for="f-folder">Folder</label><select id="f-folder" name="folder">' + folderOptions(V.folders, v.folder) + '</select></div>' +
        '<div class="field"><label for="f-date">Date shown</label><input type="date" id="f-date" name="date"></div></div>' +
        visFieldset('visibility', trashed ? 'private' : v.visibility, trashed) +
        '<div class="savebar"><button type="submit" class="btn btn-primary"' + (trashed ? ' disabled' : '') + '>Save changes</button><p class="msg" id="save-msg" role="status" aria-live="polite"></p></div></form>' +
        '<section class="panel" aria-labelledby="an-h"><div class="panel-head"><h2 id="an-h">Analytics</h2><span class="hint">Counted from playback on the watch page and embeds</span></div><div id="analytics"></div></section>' +
        '</div>' +
        // right: preview, link, poster, captions, trash
        '<div class="side-stack">' +
        '<section class="panel preview" aria-labelledby="pv-h"><h2 id="pv-h">Preview</h2><div id="pv"></div>' +
        '<div class="linkbox" id="linkbox"></div></section>' +
        '<section class="panel" aria-labelledby="po-h"><h2 id="po-h">Poster</h2><div class="poster-row"><img id="poster-img" alt="The current poster">' +
        '<div class="field"><p class="hint">Pause the preview on a good frame, then use it. Or upload a JPEG, PNG or WebP image.</p><div class="btns">' +
        '<button type="button" class="btn" id="use-frame"' + (trashed ? ' disabled' : '') + '>Use the frame at <span id="frame-t">0:00</span></button>' +
        '<span class="file-pick"><input type="file" id="poster-file" accept="image/jpeg,image/png,image/webp"' + (trashed ? ' disabled' : '') + '><label for="poster-file" class="btn">Upload an image</label></span></div>' +
        '<p class="msg" id="poster-msg" role="status" aria-live="polite"></p></div></div></section>' +
        '<section class="panel" aria-labelledby="cc-h"><h2 id="cc-h">Captions</h2><ul class="cap-list" id="caps"></ul>' +
        '<form class="cap-form" id="cap-form" novalidate><div class="field"><label for="cap-lang">Language code</label><input type="text" id="cap-lang" value="en" maxlength="12"></div>' +
        '<div class="field"><label for="cap-label">Name shown</label><input type="text" id="cap-label" value="English" maxlength="40"></div>' +
        '<div class="span2"><span class="file-pick"><input type="file" id="cap-file" accept=".vtt,text/vtt"' + (trashed ? ' disabled' : '') + '><label for="cap-file" class="btn">Upload a WebVTT file (.vtt)</label></span></div>' +
        '<p class="msg span2" id="cap-msg" role="status" aria-live="polite"></p></form></section>' +
        (trashed ? '' : '<section class="panel danger-zone" aria-labelledby="tr-h"><h2 id="tr-h">Move to the trash</h2><p class="hint">Takes the video off the site straight away. It stays in the trash, where you can restore it.</p><div><button type="button" class="btn btn-danger" id="trash">Move to the trash</button></div></section>') +
        '</div></div></div>';

      var f = $('#details');
      f.title.value = v.title; f.desc.value = v.desc || ''; f.date.value = v.date || '';
      if (trashed) $$('input,textarea,select', f).forEach(function (x) { x.disabled = true; });
      wireFolderSelect(f.folder, function (fo) { V.folders.push(fo); });
      f.addEventListener('submit', function (e) { e.preventDefault(); save(); });
      $('#poster-img').src = V.poster_big;
      renderLinks(); renderCaps(); renderAnalytics(); mountPreview();
      if (trashed) {
        $('#restore').addEventListener('click', function () {
          api('POST', '/api/studio/videos/' + slug + '/restore', {}).then(function () { toast('Restored as Private.'); loadVideo(); })
            .catch(function (err) { toast(err.message, true); });
        });
      } else {
        $('#trash').addEventListener('click', function () {
          if (!window.confirm('Move “' + v.title + '” to the trash? It leaves the site now; you can restore it from the trash.')) return;
          api('POST', '/api/studio/videos/' + slug + '/trash', {}).then(function () { toast('Moved to the trash.'); loadVideo(); })
            .catch(function (err) { toast(err.message, true); });
        });
        $('#use-frame').addEventListener('click', function () {
          var vid = $('#pv video');
          var t = vid ? vid.currentTime : 0;
          posterMsg('Making the poster…', true);
          api('POST', '/api/studio/videos/' + slug + '/poster', { t: t }).then(function (j) {
            $('#poster-img').src = j.poster; posterMsg('Poster set from ' + clock(t) + '.', true);
          }).catch(function (err) { posterMsg(err.message, false); });
        });
        $('#poster-file').addEventListener('change', function () {
          var file = this.files[0]; this.value = '';
          if (!file) return;
          if (file.size > 12 * 1024 * 1024) { posterMsg('That image is larger than 12 MB.', false); return; }
          posterMsg('Uploading the poster…', true);
          api('POST', '/api/studio/videos/' + slug + '/poster', file, { type: file.type }).then(function (j) {
            $('#poster-img').src = j.poster; posterMsg('Poster replaced.', true);
          }).catch(function (err) { posterMsg(err.message, false); });
        });
        $('#cap-file').addEventListener('change', function () {
          var file = this.files[0]; this.value = '';
          if (!file) return;
          var lang = $('#cap-lang').value.trim() || 'en', label = $('#cap-label').value.trim() || lang;
          capMsg('Uploading captions…', true);
          api('PUT', '/api/studio/videos/' + slug + '/captions?lang=' + encodeURIComponent(lang) + '&label=' + encodeURIComponent(label), file, { type: 'text/vtt' })
            .then(function (j) { V.video.captions = j.captions; renderCaps(); capMsg('Captions added: ' + label + '.', true); })
            .catch(function (err) { capMsg(err.message, false); });
        });
      }
    }
    function posterMsg(t, ok) { var m = $('#poster-msg'); m.className = 'msg ' + (ok ? 'ok' : 'bad'); m.textContent = t; }
    function capMsg(t, ok) { var m = $('#cap-msg'); m.className = 'msg ' + (ok ? 'ok' : 'bad'); m.textContent = t; }

    function renderLinks() {
      var L = V.links, box = $('#linkbox'), v = V.video;
      if (!L.page) {
        box.innerHTML = '<p class="hint">' + (v.visibility === 'trash' ? 'No link while it is in the trash.' :
          'Private: no public link. Choose Unlisted to get a link you can send, or Public to list it.') + '</p>';
        return;
      }
      box.innerHTML = '<p class="hint">' + (v.visibility === 'unlisted' ? 'Unlisted link: it stays the same through edits and new uploads. Anyone who has it can watch.' : 'Public link') +
        '</p><code id="plink"></code><div class="upactions"><button type="button" class="btn btn-small" id="copy-link">Copy link</button>' +
        '<button type="button" class="btn btn-small" id="copy-embed">Copy embed code</button></div>';
      $('#plink').textContent = L.page;
      var copy = function (text, what) {
        (navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(function () { toast(what + ' copied.'); }, function () { toast('Could not copy. Select the link and copy it.', true); });
      };
      $('#copy-link').addEventListener('click', function () { copy(L.page, 'Link'); });
      $('#copy-embed').addEventListener('click', function () { copy(L.embed_code, 'Embed code'); });
    }
    function renderCaps() {
      var ul = $('#caps'), caps = V.video.captions || [];
      ul.innerHTML = caps.length ? caps.map(function (c) {
        return '<li><span><strong>' + esc(c.label) + '</strong> <span class="hint">(' + esc(c.lang) + ')</span></span>' +
          (V.video.visibility === 'trash' ? '' : '<button type="button" class="btn btn-small" data-lang="' + esc(c.lang) + '">Remove<span class="sr"> ' + esc(c.label) + ' captions</span></button>') + '</li>';
      }).join('') : '<li><span class="hint">No captions yet.</span></li>';
      $$('[data-lang]', ul).forEach(function (b) {
        b.addEventListener('click', function () {
          api('DELETE', '/api/studio/videos/' + slug + '/captions?lang=' + encodeURIComponent(b.getAttribute('data-lang')))
            .then(function (j) { V.video.captions = j.captions; renderCaps(); capMsg('Captions removed.', true); })
            .catch(function (err) { capMsg(err.message, false); });
        });
      });
    }
    function mountPreview() {
      var cfg = V.player;
      var box = $('#pv');
      box.innerHTML = '';
      var root = document.createElement('div');
      root.className = 'mlp';
      root.setAttribute('data-mlp', JSON.stringify(cfg));
      var s0 = cfg.sources[0];
      root.style.setProperty('--mlp-ar', s0.w + '/' + s0.h);
      root.style.setProperty('--mlp-r', (s0.w / s0.h).toFixed(4));
      var vid = document.createElement('video');
      vid.className = 'mlp-video'; vid.setAttribute('controls', ''); vid.setAttribute('playsinline', '');
      vid.preload = 'metadata'; vid.poster = cfg.poster;
      var src = cfg.sources[cfg.sources.length > 1 ? 1 : 0];
      vid.src = src.src;
      root.appendChild(vid); box.appendChild(root);
      if (window.JoyaPlayer) window.JoyaPlayer.init();
      var ft = $('#frame-t');
      vid.addEventListener('timeupdate', function () { if (ft) ft.textContent = clock(vid.currentTime); });
      vid.addEventListener('seeked', function () { if (ft) ft.textContent = clock(vid.currentTime); });
    }
    function save() {
      var f = $('#details'), msg = $('#save-msg');
      var vis = f.querySelector('input[name=visibility]:checked');
      if (!f.title.value.trim()) { msg.className = 'msg bad'; msg.textContent = 'The title cannot be empty.'; f.title.focus(); return; }
      var before = V.video.visibility;
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
      api('PATCH', '/api/studio/videos/' + slug, {
        title: f.title.value, desc: f.desc.value, date: f.date.value, folder: f.folder.value === '__new' ? V.video.folder : f.folder.value,
        visibility: vis ? vis.value : before
      }).then(function (j) {
        btn.disabled = false;
        V.video = Object.assign(V.video, j.video); V.links = j.links;
        $('#vh').textContent = j.video.title; document.title = j.video.title + ' · JOYA Studio';
        $('.crumbs [aria-current]').textContent = j.video.title;
        $('#vstate').innerHTML = stateHtml(j.video.visibility);
        renderLinks();
        msg.className = 'msg ok';
        msg.textContent = before !== j.video.visibility ? 'Saved. It is now ' + VIS[j.video.visibility].word.toLowerCase() + '.' : 'Saved. The pages are updated.';
      }).catch(function (err) { btn.disabled = false; msg.className = 'msg bad'; msg.textContent = err.message; });
    }

    /* ---- analytics: KPI row, views per day (one series: ink columns), sources ---- */
    function renderAnalytics() {
      var a = V.analytics, box = $('#analytics');
      var kpi = function (k, v, s) { return '<div class="kpi"><span class="k">' + k + '</span><span class="v">' + v + '</span>' + (s ? '<span class="s">' + s + '</span>' : '') + '</div>'; };
      box.innerHTML = '<div class="kpis">' +
        kpi('Views', nf.format(a.views)) +
        kpi('Unique viewers', nf.format(a.uniques)) +
        kpi('Watch time', a.watch_seconds >= 3600 ? (a.watch_seconds / 3600).toFixed(1) + ' h' : spoken(a.watch_seconds), nf.format(a.plays) + ' plays started') +
        kpi('Average view', a.views ? clock(a.avg_view_seconds) : '–', a.views ? a.avg_percent + ' % of the video' : 'No views yet') +
        '</div>' +
        '<div><h3 class="sr" id="chart-h">Views per day, last 28 days</h3><p class="hint" style="margin:16px 0 8px">Views per day, last 28 days (UTC)</p><div class="chart-wrap" id="chart-wrap"></div>' +
        '<details class="table-view"><summary>Show as a table</summary><table><thead><tr><th scope="col">Day</th><th scope="col">Views</th><th scope="col">Unique viewers</th></tr></thead><tbody>' +
        a.days.slice().reverse().map(function (d) { return '<tr><td>' + fdate(d.date) + '</td><td>' + d.views + '</td><td>' + d.uniques + '</td></tr>'; }).join('') +
        '</tbody></table></details></div>' +
        '<div><h3 style="font-size:var(--fs-md);margin:16px 0 10px">Where views came from</h3>' +
        (a.sources.length ? '<ul class="sources">' + a.sources.map(function (s) {
          var max = a.sources[0].views || 1;
          return '<li><span class="lab">' + esc(s.label) + '</span><span class="n">' + nf.format(s.views) + '</span><span class="track" aria-hidden="true"><span style="width:' + Math.max(2, 100 * s.views / max) + '%"></span></span></li>';
        }).join('') + '</ul>' : '<p class="hint">No views yet. A view counts after 30 seconds of playback, or half of a shorter video.</p>') + '</div>';
      drawChart($('#chart-wrap'), a.days);
    }
    function niceMax(m) {
      if (m <= 4) return 4;
      var p = Math.pow(10, Math.floor(Math.log10(m))), n = m / p;
      return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
    }
    function drawChart(wrap, days) {
      var W = 640, H = 200, padL = 36, padR = 8, padT = 10, padB = 26;
      var max = niceMax(Math.max.apply(null, days.map(function (d) { return d.views; })));
      var n = days.length, band = (W - padL - padR) / n, bw = Math.min(16, band - 4);
      var y = function (v) { return padT + (H - padT - padB) * (1 - v / max); };
      var ticks = [0, max / 2, max];
      var total = days.reduce(function (s, d) { return s + d.views; }, 0);
      var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" tabindex="0" role="img" aria-labelledby="chart-h" aria-describedby="chart-desc">' +
        '<desc id="chart-desc">' + total + ' views in the last 28 days. Use the left and right arrow keys to read each day.</desc>' +
        '<g class="grid">' + ticks.map(function (t) { return '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '"/>'; }).join('') + '</g>' +
        '<g class="axis">' + ticks.map(function (t) { return '<text x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + (t >= 1000 ? (t / 1000) + 'K' : t) + '</text>'; }).join('') +
        [0, 7, 14, 21, 27].map(function (i) { return '<text x="' + (padL + band * i + band / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + fdate(days[i].date).replace(/ \d{4}$/, '') + '</text>'; }).join('') + '</g>';
      days.forEach(function (d, i) {
        var x = padL + band * i + (band - bw) / 2, top = y(d.views), base = y(0);
        var hgt = Math.max(0, base - top);
        var path = d.views ? 'M' + x + ',' + base + 'V' + (top + Math.min(4, hgt)) + 'Q' + x + ',' + top + ' ' + (x + Math.min(4, bw / 2)) + ',' + top +
          'H' + (x + bw - Math.min(4, bw / 2)) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + Math.min(4, hgt)) + 'V' + base + 'Z'
          : '';
        svg += '<g class="col" data-i="' + i + '"><rect class="hitbg" x="' + (padL + band * i) + '" y="' + padT + '" width="' + band + '" height="' + (H - padT - padB) + '" fill="transparent"/>' +
          '<path class="bar' + (d.views ? '' : ' is-zero') + '" d="' + path + '"/></g>';
      });
      svg += '</svg>';
      wrap.innerHTML = svg;
      var el = $('svg', wrap), tip = null, cur = -1;
      function show(i) {
        $$('g.col', el).forEach(function (g) { g.classList.toggle('on', +g.getAttribute('data-i') === i); });
        cur = i;
        if (i < 0) { if (tip) tip.hidden = true; return; }
        var d = days[i];
        if (!tip) { tip = h('<div class="tip" aria-hidden="true"></div>'); wrap.appendChild(tip); }
        tip.hidden = false;
        tip.innerHTML = '<strong>' + nf.format(d.views) + (d.views === 1 ? ' view' : ' views') + '</strong><span class="muted">' + fdate(d.date) + ' · ' + d.uniques + ' unique</span>';
        var r = el.getBoundingClientRect(), sx = r.width / W;
        tip.style.left = ((padL + band * i + band / 2) * sx) + 'px';
        tip.style.top = (y(d.views) * sx) + 'px';
      }
      $$('g.col', el).forEach(function (g) {
        g.addEventListener('pointerenter', function () { show(+g.getAttribute('data-i')); });
      });
      el.addEventListener('pointerleave', function () { show(-1); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); show(Math.min(n - 1, cur < 0 ? n - 1 : cur + 1)); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, cur < 0 ? n - 1 : cur - 1)); }
        else if (e.key === 'Escape') show(-1);
      });
      el.addEventListener('blur', function () { show(-1); });
    }
    loadVideo();
  }
})();
