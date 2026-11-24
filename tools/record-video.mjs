// Usage: node tools/record-video.mjs [output.webm]   (default store/video/reviewer-demo.webm)
// Records the reviewer video: a captioned walkthrough of the panel on the demo vendor bill (store/demo), with a
// visible pointer, at 1440x900. Playwright is loaded from the same folder as the tests (NSFE_PLAYWRIGHT_DIR
// overrides it) and drives the installed Chrome.
// Playwright records the page only, not the browser around it, and can't press the toolbar button or the
// Alt+Shift+F shortcut. So the video shows a drawn browser frame (tab strip and toolbar with the extension's
// real icon, served at /__frame/ on the demo server's own origin, since Chrome won't let a public address frame a
// local one) with the website in an iframe below it.
// "Clicking" the icon runs extension/ns-field-explorer.js in that iframe's main world, which is what the toolbar
// button does (background.js: scripting.executeScript, world MAIN). The first caption says the frame is drawn.
// google.com refuses to be framed, so for the recording only its X-Frame-Options and CSP headers are dropped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemo } from './demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'store', 'video', 'reviewer-demo.webm'));
const PW_DIR = process.env.NSFE_PLAYWRIGHT_DIR || ROOT;
const { chromium } = createRequire(path.join(PW_DIR, 'package.json'))('playwright');
const SRC = fs.readFileSync(path.join(ROOT, 'extension', 'ns-field-explorer.js'), 'utf8');
const ICON = fs.readFileSync(path.join(ROOT, 'extension', 'icons', 'icon32.png'));
const SIZE = { width: 1440, height: 900 };
const GOOGLE = 'https://www.google.com/';
// Pace: every pause is multiplied by this (NSFE_VIDEO_PACE=1 is the slower first cut).
const PACE = +(process.env.NSFE_VIDEO_PACE || 0.6);

/* The drawn browser frame, after Chrome on Windows with a dark green theme: a tab strip (tab search, a background
 * tab, the active tab, new tab, window controls), a toolbar (back, forward, reload, address bar with site info and
 * bookmark star, another extension, the pinned NSN Field Explorer button, extensions, profile, menu) and the
 * website in iframe#view. */
const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Browser</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;font:12.5px "Segoe UI",system-ui,sans-serif;background:#1f2e25;color:#dfe4dd}
svg{width:18px;height:18px;fill:none;stroke:#c9d1cb;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;display:block}
.strip{height:41px;display:flex;align-items:flex-end;padding:0 0 0 8px;position:relative}
.ts{width:28px;height:28px;margin:0 6px 6px 0;border-radius:50%;background:#2b4033;display:grid;place-items:center}.ts svg{width:14px;height:14px}
.tab{position:relative;height:34px;width:236px;display:flex;align-items:center;gap:9px;padding:0 10px 0 14px;border-radius:9px 9px 0 0}
.tab.off::after{content:"";position:absolute;right:0;top:10px;height:16px;width:1px;background:#4a5d50}
.tab.on{background:#2b4033}
.tab.on::before,.tab.on .r{content:"";position:absolute;bottom:0;width:9px;height:9px}
.tab.on::before{left:-9px;background:radial-gradient(circle at 0 0,transparent 9px,#2b4033 9.5px)}
.tab.on .r{right:-9px;background:radial-gradient(circle at 100% 0,transparent 9px,#2b4033 9.5px)}
.fav{width:16px;height:16px;border-radius:3px;flex:none;background:#5f6f64 center/16px no-repeat}
.fav.g{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Cpath fill='%23EA4335' d='M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z'/%3E%3Cpath fill='%234285F4' d='M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.7 6c4.5-4.1 6.6-10.2 6.6-17.4z'/%3E%3Cpath fill='%23FBBC05' d='M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z'/%3E%3Cpath fill='%2334A853' d='M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z'/%3E%3C/svg%3E");background-color:transparent}.fav.d{background:#f2c14e;border:4px solid #2b4256}
.tt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tab svg{width:14px;height:14px}
.plus{margin:0 0 7px 10px}
.win{position:absolute;right:0;top:0;display:flex}.win span{width:46px;height:32px;display:grid;place-items:center}.win svg{width:12px;height:12px;stroke-width:1.2}
.bar{height:46px;background:#2b4033;display:flex;align-items:center;gap:2px;padding:0 6px;border-bottom:1px solid #1a271f}
.b{width:34px;height:34px;display:grid;place-items:center;border-radius:50%;flex:none}
.omni{flex:1;height:36px;margin:0 8px 0 6px;border-radius:18px;background:#162a1e;display:flex;align-items:center;gap:6px;padding:0 6px 0 6px;font-size:14.5px;color:#e8ece6}
.omni .si{width:28px;height:28px;border-radius:50%;background:#2b4033;display:grid;place-items:center}.omni .si svg{width:15px;height:15px}
.omni .u{flex:1;padding-left:4px}.omni .h{color:#9aa79e}
.sep{width:1px;height:22px;background:#4a5d50;margin:0 6px}
#nsfe img{width:18px;height:18px;display:block}
.ext{width:18px;height:18px;border-radius:50%;background:#e8b4b8;display:grid;place-items:center;font:700 10px "Segoe UI";color:#2b4033}
.av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#e7cacb,#b9c9e8);margin:0 6px}
iframe{display:block;border:0;width:100%;height:calc(100% - 87px);background:#fff}
</style></head><body>
<div class="strip">
<span class="ts"><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></span>
<div class="tab off"><span class="fav"></span><span class="tt">New Tab</span><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg></div>
<div class="tab on"><span class="fav" id="fav"></span><span class="tt" id="title">New Tab</span><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg><span class="r"></span></div>
<span class="plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>
<div class="win"><span><svg viewBox="0 0 12 12"><path d="M1 6h10"/></svg></span><span><svg viewBox="0 0 12 12"><path d="M3 1h8v8M1 3h8v8H1z"/></svg></span><span><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1 1 11"/></svg></span></div>
</div>
<div class="bar">
<span class="b"><svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg></span>
<span class="b"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
<span class="b"><svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2-4.9M19 4v4h-4"/></svg></span>
<div class="omni"><span class="si"><svg viewBox="0 0 24 24"><path id="lock" d=""/></svg></span><span class="u" id="url"></span>
<span class="b"><svg viewBox="0 0 24 24"><path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/></svg></span></div>
<span class="b"><span class="ext">A</span></span>
<span class="b" id="nsfe" title="NSN Field Explorer"><img src="icon32.png" alt=""></span>
<span class="b" title="Extensions"><svg viewBox="0 0 24 24"><path d="M10 4a2 2 0 0 1 4 0v2h4v4h-2a2 2 0 0 0 0 4h2v4h-4v-2a2 2 0 0 0-4 0v2H6v-4h2a2 2 0 0 0 0-4H6V6h4z"/></svg></span>
<span class="sep"></span>
<span class="av"></span>
<span class="b"><svg viewBox="0 0 24 24"><path d="M12 5h.01M12 12h.01M12 19h.01" stroke-width="3"/></svg></span>
</div>
<iframe id="view" name="view" title="page"></iframe>
</body></html>`;

const server = await startDemo(0);
const base = 'http://127.0.0.1:' + server.address().port;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsfe-video-'));
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: tmp, size: SIZE } });
const FRAME = base + '/__frame/';
await context.route(u => u.href.indexOf(FRAME) === 0, r => {
  if (r.request().url().endsWith('/icon32.png')) return r.fulfill({ contentType: 'image/png', body: ICON });
  return r.fulfill({ contentType: 'text/html; charset=utf-8', body: FRAME_HTML });
});
await context.route(u => u.href.indexOf(GOOGLE) === 0, async r => {
  if (r.request().resourceType() !== 'document') return r.continue();
  const res = await r.fetch(), headers = { ...res.headers() };
  ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'].forEach(h => delete headers[h]);
  return r.fulfill({ response: res, headers });
});
const page = await context.newPage();
const T0 = Date.now(); // the video starts with the page; captions are logged against it, for chapter timestamps
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

/* ---------- the overlay: a caption bar and a pointer, drawn above everything ---------- */
async function overlay() {
  await page.evaluate(() => {
    if (document.getElementById('rv-ov')) return;
    const o = document.createElement('div'); o.id = 'rv-ov';
    Object.assign(o.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    const cap = document.createElement('div'); cap.id = 'rv-cap';
    Object.assign(cap.style, { position: 'absolute', left: '50%', bottom: '64px', transform: 'translateX(-50%)', maxWidth: '1060px',
      padding: '12px 22px', borderRadius: '10px', background: 'rgba(16, 24, 32, .92)', color: '#fff', font: '600 20px/1.35 "Segoe UI", system-ui, sans-serif',
      textAlign: 'center', boxShadow: '0 6px 24px rgba(0,0,0,.3)', opacity: '0', transition: 'opacity .35s' });
    const ns = 'http://www.w3.org/2000/svg', cur = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
    cur.id = 'rv-cur'; cur.setAttribute('viewBox', '0 0 24 24'); cur.setAttribute('width', '28'); cur.setAttribute('height', '28');
    p.setAttribute('d', 'M4 2l16 11.5-7 1.2 4.3 7.3-3 1.6-4.2-7.3L4 21z'); p.setAttribute('fill', '#fff'); p.setAttribute('stroke', '#111'); p.setAttribute('stroke-width', '1.5'); p.setAttribute('stroke-linejoin', 'round');
    cur.appendChild(p);
    Object.assign(cur.style, { position: 'absolute', left: '0', top: '0', width: '28px', height: '28px', transform: 'translate(720px,450px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.4))' });
    o.appendChild(cap); o.appendChild(cur); document.body.appendChild(o);
  });
}
async function caption(text, ms = 0) {
  if (text) { const t = Math.floor((Date.now() - T0) / 1000); console.log(Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0') + '  ' + text); }
  await page.evaluate(t => { const c = document.getElementById('rv-cap'); if (t) c.textContent = t; c.style.opacity = t ? '1' : '0'; }, text);
  if (ms) await pause(ms);
}
let at = { x: 720, y: 450 };
const pause = ms => page.waitForTimeout(Math.round(ms * PACE));
async function pointTo(x, y, ms = 520) {
  await page.evaluate(([x, y, ms]) => {
    const c = document.getElementById('rv-cur');
    c.style.transition = 'transform ' + ms + 'ms cubic-bezier(.45,0,.2,1)';
    c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }, [x, y, ms]);
  at = { x, y };
  await page.waitForTimeout(ms + 80);
}
async function ripple() {
  await page.evaluate(([x, y]) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'absolute', left: (x - 14) + 'px', top: (y - 14) + 'px', width: '28px', height: '28px', borderRadius: '50%', border: '3px solid #f2c14e' });
    document.getElementById('rv-ov').appendChild(r);
    r.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: 500 }).onfinish = () => r.remove();
  }, [at.x, at.y]);
}
async function moveTo(loc, ms) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await pointTo(Math.round(b.x + Math.min(b.width / 2, 40)), Math.round(b.y + b.height / 2), ms);
}
// Moves the pointer to a control (in the frame, the panel or the record), then clicks it.
async function click(loc, pause = 900) {
  await moveTo(loc);
  await ripple();
  await loc.click();
  await page.waitForTimeout(Math.round(pause * PACE));
}
// Drags with the real mouse (pointer events reach the panel inside the frame) while the drawn pointer follows.
async function drag(loc, dx, dy, ms = 1000) {
  await moveTo(loc);
  const x0 = at.x, y0 = at.y, steps = 24;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x0 + dx * i / steps), y = Math.round(y0 + dy * i / steps);
    await page.mouse.move(x, y);
    await page.evaluate(([x, y]) => { const c = document.getElementById('rv-cur'); c.style.transition = 'none'; c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, [x, y]);
    await page.waitForTimeout(Math.round(ms * PACE / steps));
  }
  await page.mouse.up();
  at = { x: x0 + dx, y: y0 + dy };
}
// Moves the drawn pointer and then the real mouse onto a spot, so the page sees the hover (Inspect listens there).
// The real mouse travels with the drawn pointer, so the highlight and tooltip follow it the whole way.
async function hover(loc, ms = 700) {
  await loc.scrollIntoViewIfNeeded();
  const r = await loc.boundingBox(), x1 = Math.round(r.x + Math.min(r.width / 2, 40)), y1 = Math.round(r.y + r.height / 2);
  const x0 = at.x, y0 = at.y, steps = 18;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = Math.round(x0 + (x1 - x0) * e), y = Math.round(y0 + (y1 - y0) * e);
    await page.mouse.move(x, y);
    await page.evaluate(([x, y]) => { const c = document.getElementById('rv-cur'); c.style.transition = 'none'; c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, [x, y]);
    await page.waitForTimeout(Math.round(ms / steps));
  }
  at = { x: x1, y: y1 };
}
const view = () => page.frame({ name: 'view' });
// Clicks the drawn toolbar button: runs the packaged script in the website's main world (again: closes the panel).
async function toolbar() {
  await moveTo(page.locator('#nsfe'), 650);
  await ripple();
  await page.evaluate(() => { const b = document.getElementById('nsfe'); b.style.background = '#3d5446'; setTimeout(() => { b.style.background = ''; }, 300); });
  await view().evaluate(SRC);
  await pause(700);
}
// Loads a website into the drawn frame, with its address and tab title.
async function go(url, shown, title, fav) {
  await page.evaluate(([url, shown, title, fav]) => {
    // Chrome's site-info icon: the tune icon for https, the info icon for http.
    document.getElementById('lock').setAttribute('d', /^https:/.test(url) ? 'M4 8h10M18 8h2M4 16h2M10 16h10M16 6v4M8 14v4' : 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01');
    document.getElementById('url').innerHTML = shown;
    document.getElementById('title').textContent = title;
    document.getElementById('fav').className = 'fav ' + fav;
    document.getElementById('view').src = url;
  }, [url, shown, title, fav]);
  await page.waitForTimeout(300);
  await view().waitForURL(u => u.href.indexOf(url) === 0);
  await view().waitForLoadState('load');
}
const V = page.frameLocator('#view');
const row = id => V.locator('tr', { has: V.locator('td.id', { hasText: new RegExp('^' + id + '$') }) }).first();
const scrollMain = top => view().evaluate(t => document.getElementById('nsfe-host').shadowRoot.querySelector('.main').scrollTo({ top: t, behavior: 'smooth' }), top);

try {
  await page.goto(FRAME);
  await overlay();

  /* 1. The demo vendor bill. */
  await go(base + '/', '<span class="h">127.0.0.1:' + server.address().port + '/</span>', 'VB-1042 - Demo', 'd');
  await view().waitForFunction(() => { const f = document.getElementById('classic'); return f && f.contentDocument && f.contentDocument.querySelector('#item_splits'); });
  // Open the panel where the store screenshots have it: wide, below the DEMO strip and above the captions.
  await view().evaluate(() => localStorage.setItem('nsfe.layout', JSON.stringify({ left: 560, top: 50, w: '850px', h: '600px', jsonView: 'tree' })));
  await caption('NSN Field Explorer, shown on a local demo page with invented data, because store reviewers can\'t open NetSuite. The browser frame is drawn for this video.', 5200);
  await caption('The demo page: a mock NetSuite Next vendor bill (invented data, not NetSuite).', 2600);
  await caption('Click NSN Field Explorer in the toolbar (or press Alt+Shift+F): the panel lists every field of the record.', 400);
  await toolbar();
  await pause(2600);

  await caption('Body: each field\'s ID, label, type and value. Select fields show both the name and the internal ID.', 800);
  await scrollMain(380);
  await pause(1900);
  await scrollMain(0);
  await pause(1400);

  await caption('Click a field ID or value to copy it.', 500);
  await click(row('entity').locator('td.id'), 2000);

  await caption('Inspect: hover any field on the form to see its ID, label and type. Click to copy the ID.', 400);
  await click(V.locator('[data-act="inspect"]'), 700);
  const F = V.frameLocator('#classic');
  await hover(F.locator('[data-field-name="entity"] .val'));
  await pause(2000);
  await hover(F.locator('[data-field-name="custbody_received_by"] .val'));
  await pause(1800);
  await caption('It works on sublist columns too.', 300);
  await hover(F.locator('#item_splits tr').nth(2).locator('td').nth(2));
  await pause(1800);
  await ripple();
  await page.mouse.click(at.x, at.y);
  await pause(1800);
  await click(V.locator('[data-act="inspectoff"]'), 800);

  await caption('The eye finds the field on the form, opening its tab first (Discount Date is on the Billing tab).', 500);
  await click(row('discountdate').locator('button.loc'), 2800);

  await caption('Sublists: every line of each sublist, with every column.', 400);
  await click(V.locator('[data-tab="sub"]'), 2400);
  await click(V.locator('[data-subtab="expense"]'), 1800);

  await caption('Not on form: fields the saved record has that this form doesn\'t show.', 400);
  await click(V.locator('[data-tab="rec"]'), 3000);

  await caption('Search looks through every section at once.', 400);
  const q = V.locator('.qbox input');
  await click(q, 300);
  await q.pressSequentially('amount', { delay: 90 });
  await pause(2600);
  await click(V.locator('[data-act="qclear"]'), 900);

  await caption('Compare the form\'s unsaved edits with the saved record (or with another pinned record).', 400);
  await click(V.locator('[data-act="pin"]'), 1000);
  await click(V.locator('[data-act="cmpsaved"]'), 3800);

  await caption('View Raw: the record as JSON, CSV or XML, to copy or download.', 400);
  await click(V.locator('[data-tab="body"]'), 700);
  await click(V.locator('[data-act="view"]'), 2400);
  await click(V.locator('[data-pv="csv"]'), 1900);
  await click(V.locator('[data-pv="xml"]'), 1900);
  await click(V.locator('[data-act="pvclose"]'), 900);

  await caption('Dark mode, from Settings (or Auto, to follow the system).', 400);
  await click(V.locator('[data-act="settings"]'), 500);
  const theme = V.locator('[data-sel="theme"]');
  await moveTo(theme);
  await ripple();
  await theme.selectOption('dark');
  await pause(1400);
  await click(V.locator('[data-act="settings"]'), 900);

  await caption('Resize the panel from any edge or corner.', 400);
  await drag(V.locator('[data-rz="sw"]'), 230, -150);
  await pause(900);

  await caption('Drag the title bar to move it anywhere on the page.', 400);
  await drag(V.locator('.h b'), -330, 60, 1200);
  await pause(900);

  await caption('Collapse it to the title bar, and open it again. Size, place and theme are remembered.', 400);
  await click(V.locator('[data-act="min"]'), 1600);
  await click(V.locator('[data-act="min"]'), 1400);

  await caption('Clicking the button again closes the panel. The record was only read, never changed or saved.', 600);
  await toolbar();
  await pause(2400);

  /* 2. Any other website: it finds nothing to read. */
  await caption('It only reads NetSuite records. On any other site, it finds nothing and says so:', 0);
  await go(GOOGLE, 'google.com', 'Google', 'g');
  await pause(1600);
  await toolbar();
  await pause(3400);
  await caption('Clicking the button again closes it.', 500);
  await toolbar();
  await pause(900);
  await caption('NSN Field Explorer collects no data. Its only requests are NetSuite\'s own read-only calls, to the account the user is signed in to.', 4800);
  await caption('', 600);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  server.close();
  if (video) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.copyFileSync(await video.path(), OUT); }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) { console.error('Page errors:\n' + errors.join('\n')); process.exitCode = 1; }
console.log('Video: ' + OUT);

// Generated by Claude and Ammon Wendel. Questions or help: info@syincuso.com
