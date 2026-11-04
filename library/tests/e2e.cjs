// JOYA Library end-to-end tests against a scratch instance (tests/scratch.sh up <dir>).
//   NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright \
//     node library/tests/e2e.cjs <scratch dir> [shots dir]
// Needs the scratch library seeded with: allocation-walkthrough (public, 70 s), board-demo (public, demos,
// 40 s), draft-pre-read (unlisted, 20 s), secret-cut (private), and a user "tester" whose password is in
// <scratch>/test-pass.txt (never a production account).
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const path = require('path');

const SCR = path.resolve(process.argv[2]);
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : null;
const BASE = 'http://localhost:' + (process.env.JOYA_SCRATCH_WEB || '18790');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PASS = fs.readFileSync(path.join(SCR, 'test-pass.txt'), 'utf8').trim();
const manifest = () => JSON.parse(fs.readFileSync(path.join(SCR, 'state/library.json'), 'utf8'));
const tokenOf = (slug) => manifest().videos.find((v) => v.slug === slug).token;

let failures = 0, passes = 0;
const errors = [];
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -- ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step || 300); }
  return fn();
}
async function stats(ids) {
  const r = await fetch(BASE + '/api/stats?ids=' + encodeURIComponent(ids.join(',')));
  return (await r.json()).counts;
}
function watchErrors(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/status of 404/.test(m.text()) && /\/nope\/|\/404\.html/.test(url + page.url())) return; // the 404 page itself
    if (/status of 401/.test(m.text()) && /\/api\/studio\/login$/.test(url)) return;          // the wrong-password test
    if (/status of 409/.test(m.text()) && /offset=5$/.test(url)) return;                         // the wrong-offset test
    errors.push(label + ': ' + m.text() + ' @ ' + url);
  });
  page.on('pageerror', (e) => errors.push(label + ': ' + e.message));
}
async function newCtx(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ userAgent: UA, viewport: { width: 1366, height: 768 } }, opts || {}));
  return ctx;
}
async function playFast(page, rate) {
  await page.click('.mlp-big');
  await page.evaluate((r) => { const v = document.querySelector('.mlp video'); v.muted = true; v.playbackRate = r; }, rate || 2);
}
async function login(page) {
  await page.goto(BASE + '/studio/');
  await page.fill('#name', 'tester');
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL(BASE + '/studio/'), page.click('button[type=submit]')]);
}

(async () => {
  const browser = await chromium.launch();
  const draft = '/u/' + tokenOf('draft-pre-read') + '/draft-pre-read/';

  console.log('# Listings never show unlisted or private videos');
  for (const p of ['/', '/pre-read/', '/demos/', '/pre-read/allocation-walkthrough/', '/demos/board-demo/', '/404.html']) {
    const html = await (await fetch(BASE + p)).text();
    ok(!/draft-pre-read|Draft pre-read|secret-cut|Secret cut/.test(html) && !html.includes(tokenOf('draft-pre-read')), 'no unlisted/private on ' + p);
  }
  const all = await (await fetch(BASE + '/api/stats')).json();
  ok(Object.keys(all.counts).sort().join() === 'allocation-walkthrough,board-demo', '/api/stats lists public only', all);
  ok(Object.keys(await stats(['secret-cut', 'draft-pre-read'])).length === 0, 'stats refuse private and unlisted by slug');
  ok((await fetch(BASE + draft)).status === 200, 'unlisted reachable by its link');
  ok((await fetch(BASE + draft + 'embed/')).status === 200, 'unlisted embed reachable by its link');
  for (const p of ['/u/', '/u/' + tokenOf('draft-pre-read') + '/', '/pre-read/draft-pre-read/', '/embed/draft-pre-read/',
    '/pre-read/secret-cut/', '/secret-cut/', '/embed/secret-cut/', '/_store/secret-cut/360p.mp4', '/sitemap.xml']) {
    ok((await fetch(BASE + p, { redirect: 'manual' })).status === 404, '404 for ' + p);
  }
  ok((await fetch(BASE + '/studio/media/secret-cut/360p.mp4', { redirect: 'manual' })).status === 303, 'private media needs a sign-in');

  console.log('# Home search: unlisted is not found');
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage(); watchErrors(page, 'search');
    await page.goto(BASE + '/?q=draft');
    ok(await page.isVisible('#nomatch'), 'searching "draft" finds nothing');
    await page.goto(BASE + '/?q=walkthrough');
    ok((await page.locator('#grid > .card:not([hidden])').count()) === 1, 'searching "walkthrough" finds 1');
    await page.fill('#tq', 'demo');
    await page.waitForTimeout(400);
    ok((await page.locator('#grid > .card:not([hidden])').count()) === 1 && page.url().includes('q=demo'), 'live search from the top bar');
    await ctx.close();
  }

  console.log('# View counting: threshold, 30-minute dedup, unique viewers, seeks do not count');
  const key = 'u:' + tokenOf('draft-pre-read');
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage(); watchErrors(page, 'count1');
    await page.goto(BASE + draft);
    ok((await stats([key]))[key].v === 0, 'starts at 0 views');
    await playFast(page, 2);
    await page.waitForFunction(() => document.querySelector('.mlp video').currentTime >= 7, null, { timeout: 20000 });
    await page.evaluate(() => document.querySelector('.mlp video').pause());
    await page.waitForTimeout(800);
    ok((await stats([key]))[key].v === 0, 'under the threshold (7 s of a 20 s video): no view');
    await page.evaluate(() => document.querySelector('.mlp video').play());
    await page.waitForFunction(() => document.querySelector('.mlp video').currentTime >= 12, null, { timeout: 20000 });
    const c = await until(async () => { const s = (await stats([key]))[key]; return s.v === 1 ? s : null; }, 8000);
    ok(c && c.v === 1 && c.u === 1, 'past the threshold: 1 view, 1 unique viewer', c);
    const shown = await until(async () => page.textContent('#desc .views'), 4000);
    ok(/1 view · 1 unique viewer/.test(shown || ''), 'watch page shows the count', shown);
    // Up next: the end screen offers the next video with a countdown (autoplay on by default).
    await page.evaluate(() => { const v = document.querySelector('.mlp video'); v.currentTime = v.duration - 1.5; v.play(); });
    await page.waitForSelector('.mlp-next:not([hidden])', { timeout: 10000 });
    const cnt = await until(async () => page.textContent('.mlp-next-count'), 3000);
    ok(/Playing in \d+ s/.test(cnt || ''), 'Up next counts down at the end', cnt);
    await page.click('.mlp-next .mlp-chip:not(.mlp-chip-solid)');
    await page.waitForTimeout(1500);
    ok(page.url().includes('draft-pre-read'), 'Cancel keeps you on the video');
    // Same device again within 30 minutes: not a new view.
    await page.goto(BASE + draft);
    await playFast(page, 2);
    await page.waitForFunction(() => document.querySelector('.mlp video').currentTime >= 12, null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    ok((await stats([key]))[key].v === 1, 'same device within 30 minutes: still 1 view');
    await ctx.close();
  }
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage(); watchErrors(page, 'count2');
    await page.goto(BASE + draft);
    await playFast(page, 2);
    await page.waitForFunction(() => document.querySelector('.mlp video').currentTime >= 12, null, { timeout: 20000 });
    const c = await until(async () => { const s = (await stats([key]))[key]; return s.v === 2 ? s : null; }, 8000);
    ok(c && c.v === 2 && c.u === 2, 'another device: 2 views, 2 unique viewers', c);
    await ctx.close();
  }
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage(); watchErrors(page, 'count3');
    await page.goto(BASE + draft);
    await playFast(page, 2);
    await page.evaluate(() => { const v = document.querySelector('.mlp video'); v.currentTime = 17; });
    await page.waitForFunction(() => document.querySelector('.mlp video').ended, null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    ok((await stats([key]))[key].v === 2, 'skipping to the end is not a view');
    await ctx.close();
  }
  {
    // A bot user agent is never counted.
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(BASE + '/embed/board-demo/');
    await playFast(page, 4);
    await page.waitForFunction(() => document.querySelector('.mlp video').currentTime >= 25, null, { timeout: 20000 });
    await page.waitForTimeout(1200);
    ok((await stats(['board-demo']))['board-demo'].v === 0, 'headless/bot user agent: no view');
    await ctx.close();
  }
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage(); watchErrors(page, 'embed');
    await page.goto(BASE + '/embed/board-demo/');
    await playFast(page, 2);
    await page.waitForFunction(() => document.querySelector('.mlp video').currentTime >= 22, null, { timeout: 25000 });
    const c = await until(async () => { const s = (await stats(['board-demo']))['board-demo']; return s.v === 1 ? s : null; }, 8000);
    ok(c && c.v === 1, 'embeds count too', c);
    await ctx.close();
  }

  console.log('# Watch page: theater, keys, share, continue watching');
  {
    const ctx = await newCtx(browser, { viewport: { width: 1920, height: 1080 } }); const page = await ctx.newPage(); watchErrors(page, 'watch');
    await page.goto(BASE + '/pre-read/allocation-walkthrough/');
    await page.click('.mlp-big');
    await page.evaluate(() => { const v = document.querySelector('.mlp video'); v.muted = true; v.currentTime = 20; });
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('.mlp video').pause());
    await page.keyboard.press('t');
    ok(await page.evaluate(() => document.body.classList.contains('theater')), 't turns on theater mode');
    ok((await page.getAttribute('.mlp-theater', 'aria-pressed')) === 'true', 'theater button pressed');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'watch-theater-1920.png') });
    await page.keyboard.press('t');
    ok(!(await page.evaluate(() => document.body.classList.contains('theater'))), 't again: default view');
    await page.keyboard.press('?');
    ok(await page.isVisible('.mlp-help'), '? shows the shortcuts');
    await page.keyboard.press('Escape');
    await page.click('#share-btn');
    await page.check('#share-at');
    const shareUrl = await page.inputValue('#share-url');
    ok(/\?t=2\d$/.test(shareUrl), 'share link at the current time', shareUrl);
    ok((await page.inputValue('#share-embed')).includes('/embed/allocation-walkthrough/'), 'embed code');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.goto(BASE + '/');
    ok(await page.isVisible('#cw'), 'Continue watching appears on the home page');
    ok((await page.locator('#cw .card').count()) === 1, 'it holds the half-watched video');
    await page.goto(BASE + '/?sort=views');
    ok((await page.inputValue('#sort')) === 'views', 'sort from the address');
    const first = await until(async () => page.getAttribute('#grid > .card:first-child', 'data-id'), 3000);
    ok(first === 'board-demo', 'Most viewed puts the viewed video first', first);
    await ctx.close();
  }

  console.log('# Studio: sign-in, CSRF, writes need a session');
  {
    let r = await fetch(BASE + '/api/studio/videos/board-demo', { method: 'PATCH', body: '{}', headers: { 'Content-Type': 'application/json', Origin: BASE } });
    ok(r.status === 401, 'PATCH without a session: 401', r.status);
    r = await fetch(BASE + '/api/studio/uploads', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Origin: BASE } });
    ok(r.status === 401, 'upload without a session: 401', r.status);
    r = await fetch(BASE + '/api/studio/login', { method: 'POST', body: JSON.stringify({ name: 'tester', password: PASS }), headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
    ok(r.status === 403, 'login from another origin: 403');
    const ctx = await newCtx(browser); const page = await ctx.newPage(); watchErrors(page, 'studio');
    await page.goto(BASE + '/studio/');
    ok(page.url().includes('/studio/login'), 'studio redirects to sign-in');
    await page.fill('#name', 'tester'); await page.fill('#password', 'wrong password here');
    await page.click('button[type=submit]');
    await page.waitForSelector('.form-error');
    ok(/do not match/.test(await page.textContent('.form-error')), 'wrong password is refused');
    await page.fill('#password', PASS);
    await Promise.all([page.waitForURL(BASE + '/studio/'), page.click('button[type=submit]')]);
    ok(true, 'signed in');
    const cookies = await ctx.cookies();
    const sess = cookies.find((c) => c.name === 'mlsess');
    ok(sess && sess.httpOnly && sess.sameSite === 'Strict' && sess.secure, 'session cookie HttpOnly + Secure + SameSite=Strict', sess && { h: sess.httpOnly, s: sess.sameSite, sec: sess.secure });
    const ch = 'mlsess=' + sess.value;
    r = await fetch(BASE + '/api/studio/videos/board-demo', { method: 'PATCH', body: JSON.stringify({ title: 'Hacked' }), headers: { 'Content-Type': 'application/json', Cookie: ch, Origin: 'https://evil.example' } });
    ok(r.status === 403, 'write with another Origin: 403');
    r = await fetch(BASE + '/api/studio/videos/board-demo', { method: 'PATCH', body: JSON.stringify({ title: 'Hacked' }), headers: { 'Content-Type': 'application/json', Cookie: ch } });
    ok(r.status === 403, 'write with no Origin or fetch metadata: 403');
    ok(manifest().videos.find((v) => v.slug === 'board-demo').title === 'Board demo', 'title unchanged');
    ok((await fetch(BASE + '/studio/media/secret-cut/360p.mp4', { headers: { Cookie: ch, Range: 'bytes=0-99' } })).status === 206, 'private media plays in the studio (range)');

    console.log('# Resumable chunked upload (API)');
    const res = await page.evaluate(async () => {
      const blob = new Blob([new Uint8Array(3 * 1024 * 1024 + 123)], { type: 'video/mp4' });
      const j1 = await (await fetch('/api/studio/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'resume-test.mp4', size: blob.size, type: 'video/mp4', lastModified: 42 }) })).json();
      const id = j1.upload.id, step = 1024 * 1024;
      let r = await fetch('/api/studio/uploads/' + id + '?offset=0', { method: 'PUT', body: blob.slice(0, step) });
      const after1 = (await r.json()).received;
      const wrong = await fetch('/api/studio/uploads/' + id + '?offset=5', { method: 'PUT', body: blob.slice(5, 10) });
      const wrongJ = await wrong.json();
      const j2 = await (await fetch('/api/studio/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'resume-test.mp4', size: blob.size, type: 'video/mp4', lastModified: 42 }) })).json();
      let off = j2.upload.received;
      while (off < blob.size) {
        r = await fetch('/api/studio/uploads/' + id + '?offset=' + off, { method: 'PUT', body: blob.slice(off, off + step) });
        off = (await r.json()).received;
      }
      const cancel = await fetch('/api/studio/uploads/' + id, { method: 'DELETE' });
      return { after1, wrong: wrong.status, wrongRecv: wrongJ.received, resumed: j2.resumed, same: j2.upload.id === id, from: j2.upload.received, end: off, size: blob.size, cancel: cancel.status };
    });
    ok(res.after1 === 1048576 && res.wrong === 409 && res.wrongRecv === 1048576, 'a chunk at the wrong offset is refused with the right offset', res);
    ok(res.resumed && res.same && res.from === 1048576 && res.end === res.size, 'picking the same file again resumes', res);

    console.log('# Upload -> encode -> publish (UI)');
    await page.goto(BASE + '/studio/');
    await page.setInputFiles('#pick', path.join(SCR, 'media/d.mp4'));
    await page.waitForSelector('.upcard form');
    await page.fill('.upcard input[name=title]', 'Uploaded clip');
    await page.fill('.upcard textarea[name=desc]', 'Made in the studio test.');
    await page.check('.upcard input[type=radio][value=public]');
    await page.click('.upcard button[type=submit]');
    await page.waitForSelector('.upcard .state-ok', { timeout: 120000 });
    ok(true, 'upload processed and ready');
    const up = manifest().videos.find((v) => v.title === 'Uploaded clip');
    ok(up && up.visibility === 'public' && up.renditions.length >= 1, 'in the manifest as public', up && up.slug);
    const home = await (await fetch(BASE + '/')).text();
    ok(home.includes('Uploaded clip'), 'listed on the home page');
    const pub = '/pre-read/' + up.slug + '/';
    ok((await fetch(BASE + pub)).status === 200, 'public page works');
    if (SHOTS) { await page.setViewportSize({ width: 1366, height: 768 }); await page.screenshot({ path: path.join(SHOTS, 'studio-upload-done-1366.png'), fullPage: true }); }

    console.log('# Edit: visibility, token stability, trash and restore, poster, captions');
    await page.goto(BASE + '/studio/v/' + up.slug);
    await page.waitForSelector('#details');
    await page.check('input[name=visibility][value=unlisted]');
    await page.click('#details button[type=submit]');
    await page.waitForSelector('#save-msg.ok');
    const tok = tokenOf(up.slug);
    const ul = '/u/' + tok + '/' + up.slug + '/';
    ok((await fetch(BASE + ul)).status === 200 && (await fetch(BASE + pub)).status === 404, 'unlisted: link works, public URL gone');
    ok(!(await (await fetch(BASE + '/')).text()).includes('Uploaded clip'), 'unlisted: off the home page');
    ok(!(await (await fetch(BASE + '/pre-read/allocation-walkthrough/')).text()).includes('Uploaded clip'), 'unlisted: not in Up next');
    await page.check('input[name=visibility][value=private]');
    await page.click('#details button[type=submit]');
    await page.waitForFunction(() => /private/.test(document.querySelector('#save-msg').textContent));
    ok((await fetch(BASE + ul)).status === 404, 'private: the unlisted link stops working');
    await page.check('input[name=visibility][value=unlisted]');
    await page.click('#details button[type=submit]');
    await page.waitForFunction(() => /unlisted/.test(document.querySelector('#save-msg').textContent));
    ok(tokenOf(up.slug) === tok && (await fetch(BASE + ul)).status === 200, 'unlisted again: the same link');
    await page.check('input[name=visibility][value=public]');
    await page.fill('#f-title', 'Uploaded clip, edited');
    await page.click('#details button[type=submit]');
    await page.waitForFunction(() => /public/.test(document.querySelector('#save-msg').textContent));
    ok((await (await fetch(BASE + '/')).text()).includes('Uploaded clip, edited'), 'public again, with the new title');
    await page.evaluate(() => { const v = document.querySelector('#pv video'); v.currentTime = 6; });
    await page.waitForTimeout(500);
    await page.click('#use-frame');
    await page.waitForFunction(() => /Poster set|could not|failed/i.test(document.querySelector('#poster-msg').textContent), null, { timeout: 15000 });
    ok(/Poster set from 0:06/.test(await page.textContent('#poster-msg')), 'poster from the frame at 0:06');
    const vtt = path.join(SCR, 'tmp', 'cap.vtt');
    fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nHello from the test.\n');
    await page.fill('#cap-lang', 'en'); await page.fill('#cap-label', 'English');
    await page.setInputFiles('#cap-file', vtt);
    await page.waitForFunction(() => /Captions added|must|could/i.test(document.querySelector('#cap-msg').textContent), null, { timeout: 15000 });
    ok(manifest().videos.find((v) => v.slug === up.slug).captions.length === 1, 'captions added');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'studio-edit-1366.png'), fullPage: true });
    page.once('dialog', (d) => d.accept());
    await page.click('#trash');
    await page.waitForSelector('#restore', { timeout: 15000 }).catch(async () => { console.log('    (debug) main:', (await page.textContent('#main')).slice(0, 300)); });
    const t = manifest().videos.find((v) => v.slug === up.slug);
    ok(t.trashed && (await fetch(BASE + pub)).status === 404 && !(await (await fetch(BASE + '/')).text()).includes('Uploaded clip'), 'trash: off the site, kept in the store');
    ok(fs.existsSync(path.join(SCR, 'state/store', up.slug, 'poster.jpg')), 'trash keeps the files');
    await page.goto(BASE + '/studio/');
    await page.click('.filters button[data-f=trash]');
    ok((await page.locator('.vtable tbody tr').count()) === 1, 'the trash lists it');
    await page.click('[data-restore]');
    await until(async () => !manifest().videos.find((v) => v.slug === up.slug).trashed, 5000);
    const back = manifest().videos.find((v) => v.slug === up.slug);
    ok(!back.trashed && back.visibility === 'private', 'restore brings it back as Private');

    console.log('# Analytics');
    await page.goto(BASE + '/studio/v/draft-pre-read');
    await page.waitForSelector('.kpis');
    const kp = await page.textContent('.kpis');
    ok(/Views\s*2/.test(kp) && /Unique viewers\s*2/.test(kp), 'views and unique viewers', kp);
    ok((await page.locator('.chart g.col').count()) === 28, '28 days in the chart');
    await page.goto(BASE + '/studio/v/board-demo');
    await page.waitForSelector('.sources');
    ok(/Embedded/.test(await page.textContent('.sources')), 'sources name the embed');
    await page.click('#signout');
    await page.waitForURL(/\/studio\/login/);
    ok((await fetch(BASE + '/api/studio/library', { headers: { Cookie: ch } })).status === 401, 'sign-out ends the session');
    await ctx.close();
  }

  if (SHOTS) {
    console.log('# Screens at 1920 / 1366 / 390, light and dark');
    const pages = [['home', '/'], ['folder', '/pre-read/'], ['watch', '/pre-read/allocation-walkthrough/'], ['unlisted', draft],
      ['search', '/?q=zzz'], ['notfound', '/nope/'], ['embed', '/embed/board-demo/'], ['login', '/studio/login']];
    for (const scheme of ['light', 'dark']) {
      for (const [w, hgt] of [[1920, 1080], [1366, 768], [390, 844]]) {
        const ctx = await newCtx(browser, { viewport: { width: w, height: hgt }, colorScheme: scheme, deviceScaleFactor: w === 390 ? 2 : 1, isMobile: w === 390, hasTouch: w === 390 });
        const page = await ctx.newPage(); watchErrors(page, 'shots ' + scheme + ' ' + w);
        for (const [name, p] of pages) {
          await page.goto(BASE + p);
          await page.waitForTimeout(250);
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          ok(over <= 0, 'no sideways scroll: ' + name + ' ' + w + ' ' + scheme, over);
          await page.screenshot({ path: path.join(SHOTS, name + '-' + w + '-' + scheme + '.png'), fullPage: name !== 'embed' });
        }
        await login(page);
        for (const [name, p] of [['studio', '/studio/'], ['studio-video', '/studio/v/draft-pre-read']]) {
          await page.goto(BASE + p);
          await page.waitForTimeout(700);
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          ok(over <= 0, 'no sideways scroll: ' + name + ' ' + w + ' ' + scheme, over);
          await page.screenshot({ path: path.join(SHOTS, name + '-' + w + '-' + scheme + '.png'), fullPage: true });
        }
        await ctx.close();
      }
    }
  }

  await browser.close();
  ok(errors.length === 0, 'no console errors', errors.slice(0, 10));
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
