// Test suite for NSN Field Explorer.  Usage:
//   node tests/run.mjs            run everything
//   node tests/run.mjs csv        run tests whose name contains "csv"
//   set HEADED=1 to watch the browser
//
// Browser tests drive real Chrome (Playwright, channel "chrome") against mock NetSuite Next pages in
// tests/fixtures, served from localhost with a NetSuite-style Content-Security-Policy (no inline
// scripts or styles), so a CSP regression fails here too. The script is injected with
// page.evaluate, which runs in the page's main world like the extension's chrome.scripting call.
//
// Playwright is a dev dependency (npm install); NSFE_PLAYWRIGHT_DIR points to another install of it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const PW_DIR = process.env.NSFE_PLAYWRIGHT_DIR || ROOT;
const require = createRequire(import.meta.url);
const { firstNonAscii } = require(path.join(ROOT, 'tools', 'build.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'ns-field-explorer.js'), 'utf8');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";

/* ---------- tiny test registry ---------- */
const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, browser: opts.browser !== false });
const filter = (process.argv[2] || '').toLowerCase();

/* ---------- static checks ---------- */
test('static: extension copy is identical to the source', () => {
  const a = fs.readFileSync(path.join(ROOT, 'ns-field-explorer.js'));
  const b = fs.readFileSync(path.join(ROOT, 'extension', 'ns-field-explorer.js'));
  assert.ok(a.equals(b), 'run: node tools/build.js');
}, { browser: false });
test('static: script files are pure ASCII', () => {
  for (const f of ['ns-field-explorer.js', 'extension/ns-field-explorer.js', 'extension/background.js', 'extension/manifest.json']) {
    assert.equal(firstNonAscii(fs.readFileSync(path.join(ROOT, f))), -1, f + ' has a non-ASCII byte');
  }
}, { browser: false });
test('static: manifest is valid and its files exist', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  const files = [m.background.service_worker, ...m.background.scripts, ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, 'extension', f)), 'missing ' + f);
  assert.ok(fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8').includes("'ns-field-explorer.js'"));
  new Function(SRC);
}, { browser: false });
test('static: manifest meets the Chrome, Edge and Firefox store rules', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  /* The Chrome Web Store rejects a longer description. */
  assert.ok(m.description.length <= 132, 'description is ' + m.description.length + ' characters (132 at most)');
  assert.ok(m.name.length <= 45, 'name is at most 45 characters');
  /* Firefox has no background service worker: it runs background.scripts. Chrome before 121 refused a
   * manifest with both keys. */
  assert.deepEqual(m.background.scripts, [m.background.service_worker]);
  assert.ok(+m.minimum_chrome_version >= 121, 'minimum_chrome_version is at least 121');
  /* AMO signing needs an add-on ID and, for new add-ons, the data collection declaration (Firefox 140+). */
  const g = m.browser_specific_settings && m.browser_specific_settings.gecko;
  assert.ok(g && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(g.id), 'gecko.id is an email-style ID');
  assert.deepEqual(g.data_collection_permissions, { required: ['none'] });
  assert.ok(parseFloat(g.strict_min_version) >= 140, 'strict_min_version is at least 140');
  assert.deepEqual(m.permissions.slice().sort(), ['activeTab', 'scripting'], 'no permission beyond activeTab and scripting');
  assert.equal(m.host_permissions, undefined, 'no host permissions');
  assert.equal(m.content_scripts, undefined, 'no content scripts');
  assert.match(m.homepage_url, /^https:\/\/syincuso\.com\/\?utm_source=nsn-field-explorer&utm_medium=extension&utm_content=store$/, 'homepage_url is the Syincuso site');
}, { browser: false });

/* background.js with a fake chrome API: returns the click handler and a log of action calls. */
/* withBrowser: also defines Firefox's browser.* API; the calls must then go to it, not to chrome. */
async function loadBackground(executeScript, withBrowser) {
  const vm = await import('node:vm');
  const log = [], handlers = [], used = new Set();
  /* JSON round trip: objects made inside the vm context have a different Object prototype. */
  const plain = o => JSON.parse(JSON.stringify(o));
  const fakeApi = who => {
    const rec = name => o => { used.add(who); log.push([name, plain(o)]); return Promise.resolve(); };
    return {
      action: { onClicked: { addListener: f => { used.add(who); handlers.push(f); } }, setBadgeText: rec('badge'), setTitle: rec('title'), setBadgeBackgroundColor: rec('color') },
      scripting: { executeScript: o => { used.add(who); log.push(['execute', plain(o)]); return executeScript(o); } }
    };
  };
  const ctx = { chrome: fakeApi('chrome'), console: { warn: () => {} }, Promise };
  if (withBrowser) ctx.browser = fakeApi('browser');
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8'), ctx);
  assert.equal(handlers.length, 1);
  return { click: tab => handlers[0](tab), log, used };
}
test('background: in Firefox it uses the promise-based browser API', async () => {
  const bg = await loadBackground(() => Promise.resolve([{}]), true);
  await bg.click({ id: 5 });
  assert.deepEqual(bg.log[0], ['execute', { target: { tabId: 5 }, files: ['ns-field-explorer.js'], world: 'MAIN' }]);
  assert.deepEqual([...bg.used], ['browser'], 'every call went to browser.*');
}, { browser: false });
test('background: injects the script into the MAIN world and clears any error badge', async () => {
  const bg = await loadBackground(() => Promise.resolve([{}]));
  await bg.click({ id: 7 });
  assert.deepEqual(bg.log[0], ['execute', { target: { tabId: 7 }, files: ['ns-field-explorer.js'], world: 'MAIN' }]);
  assert.deepEqual(bg.log.find(c => c[0] === 'badge'), ['badge', { tabId: 7, text: '' }]);
}, { browser: false });
test('background: a refused injection shows a red ! with the reason', async () => {
  const bg = await loadBackground(() => Promise.reject(new Error("Could not load file 'ns-field-explorer.js'. It isn't UTF-8 encoded.")));
  await bg.click({ id: 9 });
  assert.deepEqual(bg.log.find(c => c[0] === 'badge'), ['badge', { tabId: 9, text: '!' }]);
  assert.deepEqual(bg.log.find(c => c[0] === 'color'), ['color', { tabId: 9, color: '#b22222' }]);
  assert.equal(bg.log.find(c => c[0] === 'title')[1].title, "NSN Field Explorer could not run on this tab: Could not load file 'ns-field-explorer.js'. It isn't UTF-8 encoded.");
}, { browser: false });

/* ---------- browser helpers ---------- */
let base, browser;
async function open(t, form = 'edit', query = '') {
  const page = await t.context.newPage();
  page.on('pageerror', e => t.errors.push(String(e)));
  await page.goto(base + '/shell.html?form=' + form + (query ? '&' + query : ''));
  await page.waitForFunction(() => { const f = document.getElementById('classic'); return f && f.contentWindow && typeof f.contentWindow.nlapiGetRecordType === 'function' && f.contentDocument.readyState === 'complete'; });
  t.page = page;
  return page;
}
const inject = page => page.evaluate(SRC);
const frameOf = page => page.frames().find(f => /record-(edit|view)\.html/.test(f.url()));
const panel = (page, fn, arg) => page.evaluate(([fnSrc, a]) => {
  const host = document.getElementById('nsfe-host');
  if (!host) return null;
  return (new Function('r', 'a', 'return (' + fnSrc + ')(r, a)'))(host.shadowRoot, a);
}, [fn.toString(), arg]);
const ids = page => panel(page, r => [...r.querySelectorAll('td.id')].map(td => td.getAttribute('data-id')));
const footer = page => panel(page, r => r.querySelector('.ft').textContent);
const toast = page => panel(page, r => r.querySelector('.toast').textContent);
const copies = page => page.evaluate(() => window.__copies.slice());
async function lastCopyAfter(page, action) {
  const n = (await copies(page)).length;
  await action();
  await page.waitForFunction(k => window.__copies.length > k, n, { timeout: 3000 });
  return (await copies(page)).slice(-1)[0];
}
const click = (page, sel) => page.locator(sel).first().click();
/* The Filters menu holds Hide empty and Fields; the Pin menu holds pinning (command-bar layout, 0.20.0). */
const popOpen = (page, cls) => panel(page, (r, c) => !r.querySelector(c).classList.contains('hid'), cls);
const openFilters = async page => { if (!(await popOpen(page, '.fpop'))) await click(page, '[data-act="filter"]'); };
const setKind = async (page, v) => { await openFilters(page); await click(page, '[data-kind="' + v + '"]'); };
const setHideEmpty = async (page, on) => { await openFilters(page); const c = page.locator('[data-chk="hideEmpty"]'); if (on) await c.check(); else await c.uncheck(); };
const pinIt = async page => { if (!(await popOpen(page, '.ppop'))) await click(page, "[data-act='pin']"); await click(page, "[data-act='dopin']"); };
const unpin = async page => { if (!(await popOpen(page, '.ppop'))) await click(page, "[data-act='pin']"); await click(page, "[data-act='unpin']"); };
/* Exports live behind View Raw: open it (if needed), pick the format, click its Copy. */
async function rawCopyClick(page, fmt) {
  const wasOpen = await panel(page, r => !!r.querySelector('pre.code'));
  if (!wasOpen) await click(page, '[data-act="view"]');
  await click(page, '[data-pv="' + fmt + '"]');
  await click(page, '[data-act="pvcopy"]');
  return wasOpen;
}
/* Copy one format and return what was copied; closes View Raw again if it opened it. */
async function copyAs(page, fmt) {
  const n = (await copies(page)).length;
  const wasOpen = await rawCopyClick(page, fmt);
  await page.waitForFunction(k => window.__copies.length > k, n, { timeout: 5000 });
  if (!wasOpen) await click(page, '[data-act="pvclose"]');
  return (await copies(page)).slice(-1)[0];
}
/* Click copies is in the settings menu: open it, pick, close it. */
async function setFmt(page, v) { await click(page, '[data-act="settings"]'); await page.locator('[data-sel="fmt"]').selectOption(v); await click(page, '[data-act="settings"]'); }
async function rowValue(page, id) {
  return panel(page, (r, a) => { const td = [...r.querySelectorAll('td.id')].find(x => x.getAttribute('data-id') === a); return td ? td.parentNode.querySelector('td.v').textContent : null; }, id);
}
const tip = page => frameOf(page).evaluate(() => { const t = [...document.body.children].find(e => e.tagName === 'DIV' && e.style.zIndex === '2147483647'); return t && t.style.display !== 'none' ? t.textContent : null; });

/* ---------- edit mode ---------- */
test('edit: panel opens on the form inside the Next iframe', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await panel(page, r => r.querySelector('.meta').textContent), 'vendorbill #1001  VB-1001');
  assert.deepEqual(await ids(page), ['tranid', 'entity', 'memo', 'custbody_tags', 'custbody_quote', 'custbody_adj', 'custbody_empty']);
  assert.equal(await footer(page), '7 of 7 fields');
});
/* The title bar's record type, #ID and document number are buttons that copy their plain value. */
const metaParts = page => panel(page, r => [...r.querySelectorAll('.meta button')].map(b => [b.getAttribute('data-mcopy'), b.textContent, b.getAttribute('aria-label')]));
const focusedMeta = page => panel(page, r => r.activeElement && r.activeElement.getAttribute('data-mcopy'));
const metaToast = (page, v) => page.waitForFunction(s => document.getElementById('nsfe-host').shadowRoot.querySelector('.toast').textContent === s, 'Copied ' + v);
test('edit: a click on the record type, #ID or document number in the title bar copies its plain value, without a drag', async t => {
  const page = await open(t); await inject(page);
  assert.deepEqual(await metaParts(page), [['type', 'vendorbill', 'Copy record type vendorbill'], ['id', '#1001', 'Copy internal ID 1001'], ['tranid', 'VB-1001', 'Copy document number VB-1001']]);
  await setFmt(page, 'ss2');
  const before = await page.locator('#nsfe-host').boundingBox();
  for (const [k, v] of [['type', 'vendorbill'], ['id', '1001'], ['tranid', 'VB-1001']]) {
    assert.equal(await lastCopyAfter(page, () => click(page, '[data-mcopy="' + k + '"]')), v, k + ' copies its plain value, whatever Click copies says');
    await metaToast(page, v);
  }
  const b = await page.locator('[data-mcopy="id"]').boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5); await page.mouse.down(); await page.mouse.move(b.x + 120, b.y + 80, { steps: 4 }); await page.mouse.up();
  assert.deepEqual(await page.locator('#nsfe-host').boundingBox(), before, 'pressing a part does not start a drag');
});
test('edit: the title bar parts work from the keyboard, and focus on one survives a background render', async t => {
  const page = await open(t);
  await frameOf(page).evaluate(() => { window.__cfHold = true; });
  await inject(page);
  await page.locator('[data-mcopy="type"]').focus();
  assert.equal(await lastCopyAfter(page, () => page.keyboard.press('Enter')), 'vendorbill');
  assert.equal(await focusedMeta(page), 'type', 'focus stays on the part after the copy');
  await page.keyboard.press('Tab');
  assert.equal(await focusedMeta(page), 'id', 'Tab moves on to the ID');
  assert.equal(await lastCopyAfter(page, () => page.keyboard.press(' ')), '1001', 'Space copies too');
  /* The document number changes, then the setup links arrive: the render rebuilds the parts and focus stays on the ID. */
  await panel(page, r => { r.querySelector('[data-mcopy="id"]').__old = true; });
  await frameOf(page).evaluate(() => { const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'tranid' ? 'VB-1001-B' : fv(id)); window.__cfRelease(); });
  await page.waitForFunction(() => document.getElementById('nsfe-host').shadowRoot.querySelector('.main a.cf'));
  assert.equal(await panel(page, r => r.querySelector('.meta').textContent), 'vendorbill #1001  VB-1001-B');
  assert.equal(await panel(page, r => !r.activeElement.__old && r.activeElement.getAttribute('data-mcopy')), 'id', 'the new ID button has focus');
});
test('edit: a new record shows only its type in the title bar; no form shows nothing', async t => {
  const page = await open(t);
  await frameOf(page).evaluate(() => { window.nlapiGetRecordId = () => ''; const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'tranid' ? '' : fv(id)); });
  await inject(page);
  assert.deepEqual(await metaParts(page), [['type', 'vendorbill', 'Copy record type vendorbill']]);
  assert.equal(await panel(page, r => r.querySelector('.meta').textContent), 'vendorbill');
  await frameOf(page).evaluate(() => { delete window.nlapiGetFieldValue; });
  await click(page, '[data-act="refresh"]');
  assert.equal(await panel(page, r => r.querySelector('.meta').innerHTML), '');
});
test('edit: title bar values are escaped, and an invalid record type is not a button', async t => {
  const page = await open(t, 'edit', 'rectype=' + encodeURIComponent('x"><img src=y>'));
  await frameOf(page).evaluate(() => { const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'tranid' ? 'A"<b>&' : fv(id)); });
  await inject(page);
  assert.deepEqual(await metaParts(page), [['id', '#1001', 'Copy internal ID 1001'], ['tranid', 'A"<b>&', 'Copy document number A"<b>&']]);
  assert.equal(await panel(page, r => r.querySelectorAll('.meta img, .meta b').length), 0);
  assert.equal(await lastCopyAfter(page, () => click(page, '[data-mcopy="tranid"]')), 'A"<b>&');
});
test('edit: on a narrow panel a long document number is cut with an ellipsis and the ID stays whole', async t => {
  const page = await open(t);
  await page.evaluate(() => localStorage.setItem('nsfe.layout', JSON.stringify({ w: '380px' })));
  await frameOf(page).evaluate(() => { const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'tranid' ? 'VB-1001-WITH-A-VERY-LONG-DOCUMENT-NUMBER' : fv(id)); });
  await inject(page);
  const m = await panel(page, r => {
    const box = s => r.querySelector(s).getBoundingClientRect(), tr = r.querySelector('[data-mcopy="tranid"]'), id = r.querySelector('[data-mcopy="id"]');
    return { metaRight: box('.meta').right, gearLeft: box('[data-act="settings"]').left, cut: tr.scrollWidth > tr.clientWidth, ellipsis: getComputedStyle(tr).textOverflow, idWhole: id.scrollWidth <= id.clientWidth };
  });
  assert.ok(m.metaRight <= m.gearLeft, 'the parts stay left of the title bar buttons: ' + JSON.stringify(m));
  assert.deepEqual([m.cut, m.ellipsis, m.idWhole], [true, 'ellipsis', true]);
});
test('edit: line-entry fields stay on the Sublists tab and never hide a body field', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await panel(page, r => { const td = [...r.querySelectorAll('td.id')].find(x => x.getAttribute('data-id') === 'memo'); return td.parentNode.children[1].textContent; }), 'Memo');
  const body = await ids(page);
  assert.ok(!body.includes('custcol_a') && !body.includes('contactrole'), 'no line-entry fields or subtab filter controls in Body: ' + body.join());
  assert.equal(await panel(page, r => r.querySelectorAll('[data-tab="other"]').length), 0, 'there is no Other inputs tab');
});
const docLinks = page => panel(page, r => [...r.querySelectorAll('.docs a')].map(a => [a.textContent, a.getAttribute('href'), a.target, a.rel]));
test('edit: the footer links the record type to the Records Catalog', async t => {
  const page = await open(t); await inject(page);
  const origin = new URL(page.url()).origin;
  assert.deepEqual(await docLinks(page), [['Records Catalog', origin + '/app/recordscatalog/rcbrowser.nl?whence=#/record_ss/vendorbill', '_blank', 'noopener noreferrer']]);
  assert.equal(await footer(page), '7 of 7 fields', 'the footer text itself is unchanged');
});
test('edit: a custom record type gets its Records Catalog link too', async t => {
  const page = await open(t, 'edit', 'rectype=customrecord_example_scorecard'); await inject(page);
  assert.match((await docLinks(page))[0][1], /#\/record_ss\/customrecord_example_scorecard$/);
});
test('edit: an invalid record type gets no link', async t => {
  const page = await open(t, 'edit', 'rectype=' + encodeURIComponent('x"><img src=y>')); await inject(page);
  assert.deepEqual(await docLinks(page), []);
});
test('view: the Records Catalog link is there in view mode too', async t => {
  const page = await openView(t);
  assert.deepEqual((await docLinks(page)).map(l => l[0]), ['Records Catalog']);
});
const PAGE_ORDER = ['tranid', 'entity', 'memo', 'custbody_tags', 'custbody_quote', 'custbody_adj', 'custbody_empty'];
const headerText = (page, key) => panel(page, (r, k) => r.querySelector('th[data-sort="' + k + '"]').textContent, key);
test('edit: clicking a header sorts ascending, then descending, then back to page order', async t => {
  const page = await open(t); await inject(page);
  assert.deepEqual(await ids(page), PAGE_ORDER);
  await click(page, 'th[data-sort="id"]');
  assert.deepEqual(await ids(page), [...PAGE_ORDER].sort());
  assert.equal(await headerText(page, 'id'), 'Field ID ▲');
  await click(page, 'th[data-sort="id"]');
  assert.deepEqual(await ids(page), [...PAGE_ORDER].sort().reverse());
  assert.equal(await headerText(page, 'id'), 'Field ID ▼');
  await click(page, 'th[data-sort="id"]');
  assert.deepEqual(await ids(page), PAGE_ORDER);
  assert.equal(await headerText(page, 'id'), 'Field ID');
});
const ariaSort = page => panel(page, r => Object.fromEntries([...r.querySelectorAll('th[data-sort][aria-sort]')].map(th => [th.getAttribute('data-sort'), th.getAttribute('aria-sort')])));
const focusedSort = page => panel(page, r => r.activeElement && r.activeElement.getAttribute('data-sort'));
test('edit: headers carry aria-sort, and Enter or Space on a focused header sorts like a click', async t => {
  const page = await open(t); await inject(page);
  assert.deepEqual(await ariaSort(page), {}, 'aria-sort only on the sorted header');
  assert.equal(await panel(page, r => r.querySelector('.main table').getAttribute('role')), 'grid', 'the table is a grid');
  await page.locator('th[data-sort="id"]').focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await ids(page), [...PAGE_ORDER].sort());
  assert.equal((await ariaSort(page)).id, 'ascending');
  assert.equal(await focusedSort(page), 'id', 'focus stays on the header after the table is drawn again');
  await page.keyboard.press(' ');
  assert.deepEqual(await ids(page), [...PAGE_ORDER].sort().reverse());
  assert.deepEqual(await ariaSort(page), { id: 'descending' });
  await page.keyboard.press('ArrowRight');
  assert.equal(await focusedSort(page), 'label', 'arrows move along the header row');
  await page.keyboard.press('Enter');
  assert.deepEqual(await ariaSort(page), { label: 'ascending' });
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  assert.deepEqual(await ids(page), PAGE_ORDER, 'third press: back to page order');
  assert.deepEqual(await ariaSort(page), {});
});
test('edit: sorting by value keeps empty values last in both directions', async t => {
  const page = await open(t); await inject(page);
  await click(page, 'th[data-sort="value"]');
  assert.equal((await ids(page)).slice(-1)[0], 'custbody_empty');
  await click(page, 'th[data-sort="value"]');
  assert.equal((await ids(page)).slice(-1)[0], 'custbody_empty');
});
test('edit: Copy CSV follows the sorted order; switching tabs resets the sort', async t => {
  const page = await open(t); await inject(page);
  await click(page, 'th[data-sort="label"]');
  const csv = await copyAs(page, 'csv');
  assert.deepEqual(csv.split('\n').slice(1).map(r => r.split(',')[0]), ['custbody_adj', 'custbody_empty', 'memo', 'custbody_quote', 'tranid', 'custbody_tags', 'entity']);
  await click(page, '[data-tab="sub"]');
  await click(page, '[data-tab="body"]');
  assert.deepEqual(await ids(page), PAGE_ORDER);
});
test('edit: sublist rows sort by a line column, numbers as numbers', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-tab="sub"]');
  await click(page, 'th[data-sort="L2"]');
  /* line 2 values: item Gadget, amount 12.50, custcol_a gamma, custcol_b delta */
  assert.deepEqual(await ids(page), ['amount', 'custcol_b', 'item', 'custcol_a']);
  await click(page, 'th[data-sort="id"]');
  assert.deepEqual(await ids(page), ['amount', 'custcol_a', 'custcol_b', 'item']);
});
test('view: sorting works on record-backed values', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="sub"]');
  await click(page, 'th[data-sort="L1"]');
  /* line 1: line 1, item Widget, description First, amount 5010.38, custcol_a alpha, custcol_b beta */
  assert.deepEqual(await ids(page), ['line', 'amount', 'custcol_a', 'custcol_b', 'description', 'item']);
});
test('edit: planted field and sublist IDs are ignored', async t => {
  const page = await open(t); await inject(page);
  assert.ok(!(await ids(page)).some(i => i.includes("'")));
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('[data-subtab]')].map(b => b.getAttribute('data-subtab'))), ['item']);
});
test('edit: planted IDs named like built-in object properties do not break the panel', async t => {
  const page = await open(t, 'edit', 'protokeys=1'); await inject(page);
  const planted = ['hasOwnProperty', '__proto__', 'constructor', 'toString'];
  let got = await ids(page);
  for (const id of ['tranid', 'entity', 'memo', 'custbody_tags', ...planted]) assert.ok(got.includes(id), id + ' listed');
  await page.locator('[data-q]').fill('planted');
  const j = JSON.parse(await copyAs(page, 'json'));
  assert.deepEqual(Object.keys(j.body).sort(), [...planted].sort());
  await page.locator('[data-q]').fill('');
  /* Not on form loads the saved record; its caches are keyed by field ID too. */
  await click(page, '[data-tab="rec"]');
  await page.waitForFunction(() => /saved values/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  assert.ok((await ids(page)).includes('custbody_secret'));
  await click(page, '[data-tab="body"]');
  got = await ids(page);
  for (const id of ['tranid', 'entity', ...planted]) assert.ok(got.includes(id), id + ' still listed after the record loads');
});
test('view: planted IDs named like built-in object properties do not break the panel', async t => {
  const page = await openView(t, 'protokeys=1');
  const got = await ids(page);
  for (const id of ['tranid', 'entity', 'hasOwnProperty', '__proto__', 'constructor']) assert.ok(got.includes(id), id + ' listed');
  assert.equal(await rowValue(page, 'entity'), 'Acme Supply7');
  await click(page, '[data-tab="sub"]');
  assert.equal(await rowValue(page, 'item'), 'Widget');
  await click(page, '[data-tab="rec"]'); await settled(page);
  assert.ok((await ids(page)).includes('custbody_hidden'));
});
test('edit: a page element that happens to use the panel id is left alone', async t => {
  const page = await open(t);
  const hosts = () => page.evaluate(() => [...document.querySelectorAll('[id="nsfe-host"]')].map(e => e.shadowRoot ? 'panel' : e.textContent));
  await page.evaluate(() => { const d = document.createElement('div'); d.id = 'nsfe-host'; d.textContent = 'page content'; document.body.prepend(d); });
  await inject(page);
  assert.deepEqual(await hosts(), ['page content', 'panel']);
  await inject(page);
  assert.deepEqual(await hosts(), ['page content']);
});
test('edit: a render while searching reads each field and sublist cell once', async t => {
  const page = await open(t); await inject(page);
  const fr = frameOf(page);
  /* Calls made by one render, triggered by clicking a tab. */
  const renderCalls = async tab => {
    await page.waitForTimeout(150); /* let background lookups (setup links) finish their own render first */
    await fr.evaluate(() => { for (const k in window.__calls) window.__calls[k] = 0; });
    await click(page, '[data-tab="' + tab + '"]');
    return fr.evaluate(() => Object.assign({}, window.__calls));
  };
  const plainBody = await renderCalls('body');
  await page.locator('[data-q]').fill('a');
  const searchBody = await renderCalls('body');
  assert.equal(searchBody.fieldValue, plainBody.fieldValue, 'body fields read once per render');
  const searchSub = await renderCalls('sub');
  await page.locator('[data-q]').fill('');
  const plainSub = await renderCalls('sub');
  assert.ok(plainSub.lineValue > 0);
  assert.equal(searchSub.lineValue, plainSub.lineValue, 'line values read once per render');
  assert.equal(searchSub.lineText, plainSub.lineText, 'line names read once per render');
});
test('edit: Inspect works out the hovered cell once, not on every mouse move', async t => {
  const page = await open(t); await inject(page);
  await setFmt(page, 'ss2');
  await click(page, '[data-act="inspect"]');
  const fr = frameOf(page), box = await fr.locator('#l1-a').boundingBox();
  await page.mouse.move(box.x + 3, box.y + 3);
  assert.match(await tip(page), /^item line 1 • custcol_a\n/);
  await fr.evaluate(() => { window.__calls.machine = 0; });
  for (let i = 1; i <= 5; i++) await page.mouse.move(box.x + 3 + i, box.y + 3);
  assert.match(await tip(page), /^item line 1 • custcol_a\n/);
  const c = await lastCopyAfter(page, () => page.mouse.click(box.x + 9, box.y + 3));
  assert.equal(c, "rec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_a', line: 0 })");
  assert.equal(await fr.evaluate(() => window.__calls.machine), 0, 'no column lookups while the pointer stays on one cell');
  await page.mouse.move((await fr.locator('#l2-amount').boundingBox()).x + 3, (await fr.locator('#l2-amount').boundingBox()).y + 3);
  assert.match(await tip(page), /^item line 2 • amount\n/);
});
test('edit: select and multi-select values show text with the ID underneath', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await rowValue(page, 'entity'), 'Acme Supply7');
  assert.equal(await rowValue(page, 'custbody_tags'), 'Red | Blue1 | 2');
});
test('edit: multi-select values are separated by | in the panel, JSON and click-to-copy', async t => {
  const page = await open(t); await inject(page);
  const o = JSON.parse(await copyAs(page, 'json'));
  assert.deepEqual(o.body.custbody_tags, { label: 'Tags', type: 'multiselect', value: '1 | 2', text: 'Red | Blue' });
  assert.equal(await lastCopyAfter(page, () => page.locator('td.id[data-id="custbody_tags"] ~ td.v').click()), '1 | 2');
});
const activeTab = page => panel(page, r => r.querySelector('[data-tab].on').getAttribute('data-tab'));
const badges = page => panel(page, r => Object.fromEntries([...r.querySelectorAll('[data-tab]')].map(b => [b.getAttribute('data-tab'), b.querySelector('.n').textContent])));
const resultRows = page => panel(page, r => [...r.querySelectorAll('tr')].slice(1).map(tr => [...tr.children].map(td => td.textContent)));
test('edit: search looks in every section and shows where each match is', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await page.locator('[data-tab="all"]').isVisible(), false);
  await page.locator('[data-q]').fill('notes');
  assert.equal(await activeTab(page), 'all');
  assert.deepEqual(await resultRows(page), [
    ['Sublist: item', 'custcol_a', 'Notes', 'text', 'L1: alpha; L2: gamma'],
    ['Sublist: item', 'custcol_b', 'Notes', 'text', 'L1: beta; L2: delta']
  ]);
  assert.deepEqual(await badges(page), { all: '2', body: '0', sub: '2', rec: '', cmp: '' });
  assert.equal(await footer(page), '2 matches in all sections (open Not on form to include fields the form does not show)');
  await page.locator('[data-q]').fill('gadget');
  assert.deepEqual(await resultRows(page), [['Sublist: item', 'item', 'Item', 'select', 'L2: Gadget']], 'only the matching line is shown');
  await page.locator('[data-q]').fill('acme');
  assert.deepEqual(await resultRows(page), [['Body', 'entity', 'Vendor', 'select', 'Acme Supply7']]);
  await page.locator('[data-q]').fill('nluser');
  assert.equal(await panel(page, r => r.querySelector('.empty') && r.querySelector('.empty').textContent), 'Nothing matches “nluser” in any section.', 'page plumbing is not listed anywhere');
  await page.locator('[data-q]').fill('zzz-nothing');
  assert.equal(await panel(page, r => r.querySelector('.empty').textContent), 'Nothing matches “zzz-nothing” in any section.');
});
test('edit: clicking a tab while searching narrows to it; clearing the search goes back', async t => {
  const page = await open(t); await inject(page);
  await page.locator('[data-q]').fill('notes');
  assert.equal(await activeTab(page), 'all');
  await click(page, '[data-tab="body"]');
  assert.deepEqual(await ids(page), []);
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await ids(page), ['custcol_a', 'custcol_b']);
  assert.equal(await badges(page).then(b => b.sub), '2', 'badges stay while searching');
  await page.locator('[data-q]').fill('');
  assert.equal(await activeTab(page), 'sub', 'stays on the tab the user picked');
  assert.equal(await page.locator('[data-tab="all"]').isVisible(), false);
  assert.equal(await badges(page).then(b => b.sub), '');
  await click(page, '[data-tab="body"]');
  await page.locator('[data-q]').fill('x');
  await page.locator('[data-q]').fill('');
  assert.equal(await activeTab(page), 'body', 'back to the tab before the search');
});
const focusedTab = page => panel(page, r => r.activeElement && r.activeElement.getAttribute('data-tab'));
const tabStops = (page, sel) => panel(page, (r, s) => [...r.querySelectorAll(s)].map(b => b.getAttribute('role') + ':' + b.tabIndex), sel);
test('edit: the section switch is a tablist: arrows (Home, End) move and open, skipping hidden tabs', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await panel(page, r => r.querySelector('.seg.tabs').getAttribute('role')), 'tablist');
  assert.deepEqual(await tabStops(page, '[data-tab]'), ['tab:-1', 'tab:0', 'tab:-1', 'tab:-1', 'tab:-1'], 'only the selected tab is in the Tab order');
  await page.locator('[data-tab="body"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual([await activeTab(page), await focusedTab(page)], ['sub', 'sub']);
  assert.deepEqual(await ids(page), ['item', 'amount', 'custcol_a', 'custcol_b'], 'and opens it');
  assert.equal(await panel(page, r => r.querySelector('[data-tab="sub"]').getAttribute('aria-selected')), 'true');
  await page.keyboard.press('End');
  assert.equal(await activeTab(page), 'rec', 'End: the last visible tab (Compare is hidden)');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual([await activeTab(page), await focusedTab(page)], ['body', 'body'], 'wraps around, past the hidden All and Compare');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await activeTab(page), 'rec');
  await page.keyboard.press('Home');
  assert.equal(await activeTab(page), 'body');
  assert.deepEqual(await tabStops(page, '[data-tab]'), ['tab:-1', 'tab:0', 'tab:-1', 'tab:-1', 'tab:-1']);
  await page.locator('[data-q]').fill('notes');
  await page.locator('[data-tab="all"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await activeTab(page), 'body', 'while searching, All is one of the tabs');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await activeTab(page), 'all');
});
test('edit: a sublist search result copies the sublist snippet; CSV has a section column', async t => {
  const page = await open(t); await inject(page);
  await setFmt(page, 'ss2');
  await page.locator('[data-q]').fill('beta');
  assert.equal(await lastCopyAfter(page, () => click(page, 'td.id[data-id="custcol_b"]')), "rec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_b', line: 0 })");
  assert.equal(await lastCopyAfter(page, () => page.locator('td.id[data-id="custcol_b"] ~ td.v').click()), 'beta');
  const csv = await copyAs(page, 'csv');
  assert.deepEqual(csv.split('\n'), ['section,id,label,type,value,text', 'Sublist: item,custcol_b,Notes,text,L1: beta,']);
});
/* Search highlight: the text of each <mark> per cell, keyed "<data-id>/<column>". */
const marks = page => panel(page, r => {
  const o = {};
  r.querySelectorAll('.main mark').forEach(m => { const td = m.closest('td'), tr = td.parentNode, id = tr.querySelector('td.id'); const k = (id ? id.getAttribute('data-id') : '?') + '/' + td.cellIndex; (o[k] = o[k] || []).push(m.textContent); });
  return o;
});
const cellTexts = page => panel(page, r => [...r.querySelectorAll('.main tr')].slice(1).map(tr => [...tr.children].map(td => td.textContent)));
test('edit: search matches are marked in Body, All and Sublists; the text, copies and CSV are unchanged', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await panel(page, r => r.querySelectorAll('.main mark').length), 0, 'nothing marked while not searching');
  await click(page, '[data-tab="sub"]');
  const plain = await cellTexts(page), plainCsv = await copyAs(page, 'csv');
  await page.locator('[data-q]').fill('A');
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await cellTexts(page), plain, 'every row still matches, and each cell reads exactly as before');
  const m = await marks(page);
  assert.deepEqual(m['custcol_a/0'], ['a'], 'the field ID, case-insensitively');
  assert.deepEqual(m['amount/1'], ['A'], 'the label keeps its own case');
  assert.equal(await panel(page, r => r.querySelector('td.id[data-id="custcol_a"] ~ td.v').innerHTML), '<mark>a</mark>lph<mark>a</mark>', 'every occurrence in a value');
  assert.deepEqual(await panel(page, r => { const td = r.querySelector('td.id[data-id="custcol_a"]'); return [!!td.querySelector('.loc'), !!td.querySelector('a.cf'), td.querySelectorAll('.loc mark, a.cf mark, mark .loc, mark a.cf').length]; }),
    [true, true, 0], 'the eye and the setup link stay, outside the marks');
  assert.equal(await copyAs(page, 'csv'), plainCsv, 'the CSV of the highlighted table is the same');
  assert.equal(await lastCopyAfter(page, () => page.locator('td.id[data-id="custcol_a"] mark').first().click()), 'custcol_a', 'clicking a mark in a field ID copies the ID');
  assert.equal(await lastCopyAfter(page, () => page.locator('td.id[data-id="custcol_a"] ~ td.v mark').first().click()), 'alpha', 'and in a value copies the value');
  /* All: the sublist hits are marked, not their "L2: " prefixes. */
  await click(page, '[data-tab="all"]');
  await page.locator('[data-q]').fill('GAM');
  assert.deepEqual(await resultRows(page), [['Sublist: item', 'custcol_a', 'Notes', 'text', 'L2: gamma']]);
  assert.equal(await panel(page, r => r.querySelector('td.v').innerHTML), 'L2: <mark>gam</mark>ma');
  /* Body: the value and the grey internal ID under it. */
  await page.locator('[data-q]').fill('acme');
  assert.deepEqual(await resultRows(page), [['Body', 'entity', 'Vendor', 'select', 'Acme Supply7']]);
  await click(page, '[data-tab="body"]');
  assert.deepEqual(await marks(page), { 'entity/3': ['Acme'] });
  await page.locator('[data-q]').fill('7');
  await click(page, '[data-tab="body"]');
  assert.deepEqual(await marks(page), { 'entity/3': ['7'] }, 'the internal ID line is marked too');
  assert.equal(await panel(page, r => r.querySelector('td.id[data-id="entity"] ~ td.v .t').innerHTML), '<mark>7</mark>');
  await page.locator('[data-q]').fill('');
  assert.equal(await panel(page, r => r.querySelectorAll('.main mark').length), 0, 'cleared: no marks');
});
test('edit: search characters such as ( . " < are matched as plain text and never become markup', async t => {
  const page = await open(t);
  await frameOf(page).evaluate(() => { const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'custbody_quote' ? 'a <b>bold</b> & (x.y)' : fv(id)); });
  await inject(page);
  const q = async s => { await page.locator('[data-q]').fill(s); await click(page, '[data-tab="body"]'); return marks(page); };
  assert.deepEqual(await q('("'), { 'memo/3': ['("'] });
  assert.deepEqual(await q('.'), { 'tranid/1': ['.'], 'memo/3': ['.'], 'custbody_quote/3': ['.'] }, 'a dot is a dot, not any character (Reference No., evil.example, x.y)');
  assert.deepEqual(await q('(x'), { 'custbody_quote/3': ['(x'] });
  assert.deepEqual(await q('<b>'), { 'custbody_quote/3': ['<b>'] });
  assert.deepEqual(await panel(page, r => { const td = r.querySelector('td.id[data-id="custbody_quote"] ~ td.v'); return [td.textContent, td.querySelectorAll('b').length, td.innerHTML]; }),
    ['a <b>bold</b> & (x.y)', 0, 'a <mark>&lt;b&gt;</mark>bold&lt;/b&gt; &amp; (x.y)']);
  assert.equal(await lastCopyAfter(page, () => page.locator('td.id[data-id="custbody_quote"] ~ td.v mark').click()), 'a <b>bold</b> & (x.y)');
  assert.deepEqual(await q('&'), { 'custbody_quote/3': ['&'] });
  assert.deepEqual(await q('\\'), {}, 'a backslash matches nothing and breaks nothing');
  assert.deepEqual(t.errors, []);
});
test('edit: search matches are marked on Compare, against a pin and against the saved record', async t => {
  const page = await open(t, 'edit', 'saved=1'); await inject(page);
  await pinIt(page); await toastIs(page, /^Pinned/);
  await changeRecord(page);
  await click(page, '[data-act="refresh"]');
  await click(page, '[data-tab="cmp"]');
  await page.locator('[data-q]').fill('MEMO');
  assert.deepEqual((await cmpRows(page)).map(r => r[1]), ['memo']);
  assert.deepEqual(await marks(page), { 'memo/1': ['memo'], 'memo/2': ['Memo'], 'memo/4': ['memo'] }, 'field ID, label and the current value');
  assert.equal(await lastCopyAfter(page, () => page.locator('td.id[data-id="memo"] ~ td.v:not(.old)').click()), 'new memo');
  await page.locator('[data-q]').fill('');
  await cmpSaved(page); await cmpReady(page);
  await page.locator('[data-q]').fill('beta c');
  assert.deepEqual(await marks(page), { 'entity/4': ['Beta C'] }, 'saved mode: the form value');
  await page.locator('[data-q]').fill('acme');
  assert.deepEqual(await marks(page), { 'entity/3': ['Acme'] }, 'saved mode: the saved value');
});
test('edit: the ? button opens a short help page; Close, ? again or a tab closes it', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="help"]');
  const heads = await panel(page, r => [...r.querySelectorAll('.help h3')].map(h => h.textContent));
  assert.deepEqual(heads, ['The toolbar', 'Sections', 'Find things', 'Copy, inspect and export', 'What you see', 'View mode and edit mode', 'The panel', 'Keyboard', 'About']);
  assert.equal(await footer(page), 'Help');
  assert.equal(await panel(page, r => r.querySelector('[data-act="help"]').classList.contains('on')), true);
  await click(page, '[data-act="helpclose"]');
  assert.deepEqual(await ids(page), PAGE_ORDER, 'back to the fields');
  await click(page, '[data-act="help"]');
  await click(page, '[data-act="help"]');
  assert.deepEqual(await ids(page), PAGE_ORDER, '? toggles it');
  await click(page, '[data-act="help"]');
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await ids(page), ['item', 'amount', 'custcol_a', 'custcol_b'], 'a tab closes it');
});
test('edit: the toolbar is one row: section switch, search, then Filters, Inspect, Pin and View Raw', async t => {
  const page = await open(t); await inject(page);
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('.h .ic')].map(b => b.getAttribute('data-act'))), ['settings', 'help', 'refresh', 'min', 'close']);
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('.tbar .tools .tb')].map(b => b.getAttribute('data-act') + ':' + b.getAttribute('aria-label'))),
    ['filter:Filters', 'inspect:Inspect', 'pin:Pin menu', 'view:View Raw'], 'icon buttons, each with a name for screen readers');
  assert.deepEqual(await panel(page, r => { const h = r.querySelector('.tbar').getBoundingClientRect(); return [...r.querySelectorAll('.tbar .seg.tabs, .tbar .qbox, .tbar .tools')].map(e => Math.round(e.getBoundingClientRect().top - h.top) < 12); }),
    [true, true, true], 'all on one row at the default 600 px width');
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="xml"]');
  assert.equal(await panel(page, r => r.querySelector('[data-act="pvcopy"]').textContent), 'Copy XML', 'Copy names the format being viewed');
  await click(page, '[data-act="pvclose"]');
  assert.equal(await panel(page, r => r.querySelectorAll('[data-act="json"],[data-act="csv"],[data-act="xml"]').length), 0, 'exports only behind View Raw');
  assert.equal(await panel(page, r => r.querySelector('[data-q]').placeholder), 'Search field ID, label or value');
  await click(page, '[data-act="refresh"]');
  assert.equal(await toast(page), 'Refreshed');
});
test('edit: menus open one at a time; the filter dot, Clear filters, the Inspect strip and the narrow layout', async t => {
  const page = await open(t); await inject(page);
  const dot = () => panel(page, r => !r.querySelector('[data-act="filter"] .dot').classList.contains('hid'));
  assert.equal(await dot(), false, 'no dot while no filter is on');
  await setKind(page, 'custom');
  assert.equal(await dot(), true, 'a red dot while a filter is on');
  assert.equal(await panel(page, r => r.querySelector('[data-act="filter"]').title), 'Filters are on: Custom only');
  await click(page, '[data-act="clearfilters"]');
  assert.equal(await dot(), false);
  assert.equal(await footer(page), '7 of 7 fields');
  assert.equal(await popOpen(page, '.fpop'), true, 'the menu stays open while you use it');
  await click(page, '[data-act="settings"]');
  assert.deepEqual([await popOpen(page, '.fpop'), await popOpen(page, '.menu')], [false, true], 'opening Settings closes Filters');
  await page.keyboard.press('Escape');
  assert.equal(await popOpen(page, '.menu'), false, 'Esc closes it');
  await click(page, '[data-act="pin"]');
  assert.match(await panel(page, r => r.querySelector('.ppop').textContent), /^Pin this recordKeep a snapshot of vendorbill #1001 VB-1001,/);
  await click(page, '[data-tab="body"]');
  assert.equal(await popOpen(page, '.ppop'), false, 'a click elsewhere in the panel closes it');
  const strip = () => panel(page, r => !r.querySelector('.istrip').classList.contains('hid'));
  await click(page, '[data-act="inspect"]');
  assert.equal(await strip(), true, 'a strip shows while Inspect is on');
  await click(page, '[data-act="inspectoff"]');
  assert.deepEqual([await strip(), await panel(page, r => r.querySelector('[data-act="inspect"]').classList.contains('on'))], [false, false], 'Stop turns it off');
  /* Narrow: the Type column hides and the type shows under the label, through CSS only. */
  await page.evaluate(() => { document.getElementById('nsfe-host').shadowRoot.querySelector('.p').style.width = '420px'; });
  const narrow = await panel(page, r => { const td = r.querySelector('td.id[data-id="entity"]').parentNode.children[1]; return [getComputedStyle(r.querySelector('td.ty')).display, getComputedStyle(td, '::after').content, td.textContent, getComputedStyle(r.querySelector('.h b')).display]; });
  assert.deepEqual(narrow, ['none', '"select"', 'Vendor', 'none'], 'type under the label, not in the cell text; the title text gives way to the logo');
});
const previewText = page => panel(page, r => { const p = r.querySelector('pre.code'); return p ? p.textContent : null; });
test('edit: View shows JSON, CSV and XML in the panel, the same as Copy', async t => {
  const page = await open(t); await inject(page);
  const copiedJson = await copyAs(page, 'json');
  await click(page, '[data-act="view"]');
  assert.equal(await panel(page, r => r.querySelector('[data-act="view"]').classList.contains('on')), true);
  const json = await previewText(page);
  assert.deepEqual(Object.keys(JSON.parse(json).body), Object.keys(JSON.parse(copiedJson).body));
  assert.match(await footer(page), /^JSON: \d+ lines, [\d,]+ characters \(body fields and sublist lines\)$/);
  await click(page, '[data-pv="csv"]');
  const csv = await previewText(page);
  assert.equal(csv.split('\n')[0], 'id,label,type,required,value,text');
  assert.equal(csv, await copyAs(page, 'csv'), 'same as Copy CSV');
  assert.match(await footer(page), /\(the Body table\)$/);
  await click(page, '[data-pv="xml"]');
  const xml = await previewText(page);
  assert.ok(await page.evaluate(x => !new DOMParser().parseFromString(x, 'application/xml').querySelector('parsererror'), xml));
  assert.equal(await lastCopyAfter(page, () => click(page, '[data-act="pvcopy"]')), xml, 'Copy in the preview copies what is shown');
  await click(page, '[data-act="pvclose"]');
  assert.equal(await previewText(page), null);
  assert.deepEqual(await ids(page), PAGE_ORDER, 'back to the table');
});
test('edit: the CSV preview follows the tab and the search; View remembers the last format', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="csv"]');
  await click(page, '[data-tab="sub"]');
  assert.equal((await previewText(page)).split('\n')[0], 'line_number,item,amount,custcol_a,custcol_b', 'Sublists: one row per line');
  await page.locator('[data-q]').fill('notes');
  assert.deepEqual((await previewText(page)).split('\n'), ['section,id,label,type,value,text', 'Sublist: item,custcol_a,Notes,text,L1: alpha; L2: gamma,', 'Sublist: item,custcol_b,Notes,text,L1: beta; L2: delta,']);
  await click(page, '[data-act="view"]');
  assert.equal(await previewText(page), null, 'View again closes it');
  await click(page, '[data-act="view"]');
  assert.equal(await panel(page, r => r.querySelector('[data-pv].on').getAttribute('data-pv')), 'csv');
});
test('edit: the search and filters apply to JSON and XML too, and say so', async t => {
  const page = await open(t); await inject(page);
  await page.locator('[data-q]').fill('notes');
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="json"]');
  const o = JSON.parse(await previewText(page));
  assert.deepEqual(o.filters, { search: 'notes', hideEmpty: false, kind: 'all' });
  assert.deepEqual(o.body, {}, 'no body field matches "notes"');
  assert.deepEqual(o.sublists, { item: [{ custcol_a: 'alpha', custcol_b: 'beta' }, { custcol_a: 'gamma', custcol_b: 'delta' }] }, 'only the matching columns, all lines');
  assert.match(await footer(page), /filtered: search "notes"$/);
  await click(page, '[data-pv="xml"]');
  const xml = await previewText(page);
  assert.ok(await page.evaluate(x => !new DOMParser().parseFromString(x, 'application/xml').querySelector('parsererror'), xml));
  assert.equal(xml.split('\n')[1], '<!-- Filtered: search &quot;notes&quot; -->');
  assert.ok(!xml.includes('id="tranid"') && xml.includes('<field id="custcol_b" label="Notes">beta</field>'));
  await page.locator('[data-q]').fill('');
  await setKind(page, 'custom');
  await setHideEmpty(page, true);
  await click(page, '[data-pv="json"]');
  const c = JSON.parse(await previewText(page));
  assert.deepEqual(Object.keys(c.body), ['custbody_tags', 'custbody_quote', 'custbody_adj'], 'custom and not empty');
  assert.deepEqual(Object.keys(c.sublists.item[0]), ['custcol_a', 'custcol_b']);
  assert.equal(await copyAs(page, 'json').then(s => JSON.parse(s).filters.kind), 'custom', 'Copy JSON is filtered too');
  assert.match(await toast(page), /^Copied JSON \([\d,]+ characters, filtered\)$/);
  await setKind(page, 'all');
  await setHideEmpty(page, false);
  const full = JSON.parse(await previewText(page));
  assert.equal(full.filters, undefined, 'no filters entry when nothing is filtered');
  assert.deepEqual(Object.keys(full.body), PAGE_ORDER, 'every body field again');
});
/* ---------- View Raw JSON as a tree (T7) ---------- */
const jp = p => JSON.stringify(p);
const treeSel = p => '.jt [data-path=' + JSON.stringify(jp(p)) + ']';
const treeRow = (page, p) => click(page, treeSel(p) + ' > .jr');
/* One tree item: level, expanded, its row text, how many items it holds (all levels) and its tabindex; null if not drawn. */
const treeItem = (page, p) => panel(page, (r, k) => {
  const li = [...r.querySelectorAll('.jt [role="treeitem"]')].find(x => x.getAttribute('data-path') === k);
  return li ? { level: li.getAttribute('aria-level'), exp: li.getAttribute('aria-expanded'), row: li.querySelector('.jr').textContent, items: li.querySelectorAll('[role="treeitem"]').length, tab: li.tabIndex } : null;
}, jp(p));
/* The paths of the items one level under p ([] for the top level), as drawn. */
const treeKids = (page, p) => panel(page, (r, k) => {
  const ul = k === '[]' ? r.querySelector('.jt') : ([...r.querySelectorAll('.jt [role="treeitem"]')].find(x => x.getAttribute('data-path') === k) || { querySelector: () => null }).querySelector(':scope > ul');
  return ul ? [...ul.children].map(li => JSON.parse(li.getAttribute('data-path')).slice(-1)[0]) : null;
}, jp(p));
const focusedPath = page => panel(page, r => r.activeElement && r.activeElement.getAttribute('data-path'));
const tabStopsIn = (page, sel) => panel(page, (r, s) => [...r.querySelectorAll(s + ' [tabindex="0"]')].map(e => e.getAttribute('data-path')), sel);
/* Opens every closed item, one click at a time (each click draws that item's children). */
const expandAll = page => panel(page, r => { let li, n = 0; while ((li = r.querySelector('.jt [aria-expanded="false"]')) && n++ < 5000) li.querySelector('.jr').click(); return n; });
/* Checks every item on show against the JSON text: the same members in the same order, aria-level, values as JSON
 * writes them, and an open item's children all drawn (a closed one's none). exportedAt is not compared: the copy
 * was made at another moment. */
const checkTree = (page, json) => panel(page, (r, text) => {
  const o = JSON.parse(text), errs = [];
  let values = 0, nodes = 0;
  const at = p => p.reduce((v, k) => (v == null ? undefined : v[k]), o);
  const walk = (ul, base) => {
    const v = at(base), keys = Array.isArray(v) ? v.map((x, i) => i) : Object.keys(v), lis = [...ul.children];
    if (lis.length !== keys.length) errs.push(JSON.stringify(base) + ': ' + lis.length + ' items for ' + keys.length + ' members');
    lis.forEach((li, i) => {
      const k = li.getAttribute('data-path'), p = JSON.parse(k), x = at(p), sub = li.querySelector(':scope > ul');
      if (k !== JSON.stringify(base.concat([keys[i]]))) errs.push('order: ' + k);
      if (li.getAttribute('aria-level') !== String(p.length)) errs.push('level: ' + k);
      if (x !== null && typeof x === 'object') {
        nodes++;
        if ((li.getAttribute('aria-expanded') === 'true') !== !!sub) errs.push('children drawn only when open: ' + k);
        if (sub) walk(sub, p);
      } else {
        values++;
        if (li.hasAttribute('aria-expanded') || sub) errs.push('a value is not expandable: ' + k);
        if (p[0] !== 'exportedAt' && li.querySelector(':scope > .jr > [class^="j-"]').textContent !== JSON.stringify(x)) errs.push('value: ' + k);
      }
    });
  };
  walk(r.querySelector('.jt'), []);
  return { errs, values, nodes };
}, json);
const pvCopy = page => lastCopyAfter(page, () => click(page, '[data-act="pvcopy"]'));
const noTime = s => s.replace(/"exportedAt": "[^"]*"/, '"exportedAt": ""');
test('edit: View Raw JSON has a Tree / Text switch, only for JSON, remembered with the layout', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="view"]');
  const sw = () => panel(page, r => [...r.querySelectorAll('[data-jv]')].map(b => b.getAttribute('data-jv') + ':' + b.classList.contains('on') + ':' + b.getAttribute('aria-pressed')));
  assert.deepEqual(await sw(), ['tree:false:false', 'text:true:true'], 'Text by default');
  assert.ok(await previewText(page), 'Text shows the JSON text');
  await click(page, '[data-pv="csv"]');
  assert.deepEqual(await sw(), [], 'no switch for CSV');
  await click(page, '[data-pv="xml"]');
  assert.deepEqual(await sw(), [], 'no switch for XML');
  await click(page, '[data-pv="json"]');
  await click(page, '[data-jv="tree"]');
  assert.deepEqual(await sw(), ['tree:true:true', 'text:false:false']);
  assert.equal(await previewText(page), null, 'no text in Tree');
  assert.equal(await panel(page, r => r.querySelector('.main ul.jt').getAttribute('role')), 'tree');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('nsfe.layout')).jsonView), 'tree', 'saved');
  assert.match(await footer(page), /^JSON: \d+ lines, [\d,]+ characters \(body fields and sublist lines\)$/, 'the footer describes the text, as before');
  /* The keyboard reaches the switch, and focus stays on it when it is used. */
  await page.locator('[data-jv="text"]').focus();
  await page.keyboard.press('Enter');
  assert.ok(await previewText(page), 'Enter on Text shows the text');
  assert.equal(await panel(page, r => r.activeElement.getAttribute('data-jv')), 'text', 'focus stays on the switch');
  await click(page, '[data-jv="tree"]');
  /* Close the panel and open it again: View Raw JSON opens as a tree. */
  await inject(page); await inject(page);
  await click(page, '[data-act="view"]');
  assert.equal(await panel(page, r => !!r.querySelector('.jt') && !r.querySelector('pre.code')), true, 'Tree remembered');
  /* A bad saved value is ignored. */
  await page.evaluate(() => { const L = JSON.parse(localStorage.getItem('nsfe.layout')); L.jsonView = '<b>'; localStorage.setItem('nsfe.layout', JSON.stringify(L)); });
  await inject(page); await inject(page);
  await click(page, '[data-act="view"]');
  assert.deepEqual(await sw(), ['tree:false:false', 'text:true:true']);
});
test('edit: the JSON tree holds what the JSON text holds, and follows the search and filters', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  let json = await pvCopy(page);
  assert.deepEqual(await treeKids(page, []), Object.keys(JSON.parse(json)), 'top level: the same keys in the same order');
  assert.deepEqual(await treeKids(page, ['body']), PAGE_ORDER, 'every body field');
  let c = await checkTree(page, json);
  assert.deepEqual(c.errs, []);
  /* Default: the top level, the sublists and every field's details open; lines closed with a preview. */
  assert.deepEqual(await treeItem(page, ['body']), { level: '1', exp: 'true', row: 'body: 7 fields', items: 35, tab: -1 }, '7 fields, each with its 4 details');
  assert.deepEqual(await treeItem(page, ['sublists']), { level: '1', exp: 'true', row: 'sublists: 1 sublist', items: 3, tab: -1 });
  assert.deepEqual(await treeItem(page, ['sublists', 'item']), { level: '2', exp: 'true', row: 'item: 2 lines', items: 2, tab: -1 });
  const line = await treeItem(page, ['sublists', 'item', 0]);
  assert.deepEqual([line.level, line.exp, line.items], ['3', 'false', 0], 'a line starts closed, with nothing drawn under it');
  assert.match(line.row, /^Line 1: \{item: \{…\}, amount: "-5", custcol_a: "alpha", custcol_b: "beta"\}$/);
  assert.deepEqual([(await treeItem(page, ['body', 'entity'])).exp, (await treeItem(page, ['body', 'entity'])).row], ['true', 'entity: {4}'], 'a body field starts open');
  assert.deepEqual(await treeKids(page, ['body', 'entity']), ['label', 'type', 'value', 'text']);
  await treeRow(page, ['body', 'entity']);
  assert.match((await treeItem(page, ['body', 'entity'])).row, /^entity: \{label: "Vendor", type: "select", value: "\d+", text: ".+"\}$/, 'closed: a preview');
  assert.equal((await treeItem(page, ['record', 'type'])).row, 'type: "vendorbill"');
  assert.equal(await panel(page, r => r.querySelector('.jt [data-path=\'["record","type"]\'] .j-str').textContent), '"vendorbill"', 'a string');
  /* Everything opened: still the same as the text. */
  await expandAll(page);
  c = await checkTree(page, json);
  assert.deepEqual(c.errs, []);
  assert.equal(await panel(page, r => r.querySelectorAll('.jt [aria-expanded="false"]').length), 0);
  /* The search: only the matching columns, all lines; the filters entry is a node too. */
  await page.locator('[data-q]').fill('notes');
  json = await pvCopy(page);
  assert.deepEqual(JSON.parse(json).filters, { search: 'notes', hideEmpty: false, kind: 'all' });
  assert.deepEqual(await treeKids(page, ['body']), [], 'no body field matches');
  assert.equal((await treeItem(page, ['body'])).row, 'body: 0 fields');
  assert.deepEqual(await treeKids(page, ['filters']), ['search', 'hideEmpty', 'kind']);
  assert.equal(await panel(page, r => r.querySelector('.jt [data-path=\'["filters","hideEmpty"]\'] .j-bool').textContent), 'false', 'a boolean');
  assert.deepEqual(await treeKids(page, ['sublists', 'item', 0]), ['custcol_a', 'custcol_b'], 'opened before, so still open');
  assert.deepEqual((await checkTree(page, json)).errs, []);
  /* Hide empty and Custom only. */
  await page.locator('[data-q]').fill('');
  await setKind(page, 'custom');
  await setHideEmpty(page, true);
  await click(page, '[data-act="filter"]');
  json = await pvCopy(page);
  assert.deepEqual(await treeKids(page, ['body']), ['custbody_tags', 'custbody_quote', 'custbody_adj']);
  assert.deepEqual((await checkTree(page, json)).errs, []);
});
test('edit: the JSON tree draws an item\'s children only when it is opened; a big sublist starts closed', async t => {
  const page = await open(t, 'edit', 'lines=120'); await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  assert.deepEqual(await treeItem(page, ['sublists', 'item']), { level: '2', exp: 'false', row: 'item: 120 lines', items: 0, tab: -1 }, 'more than 50 lines: closed, nothing drawn');
  const all = () => panel(page, r => r.querySelectorAll('.jt [role="treeitem"]').length);
  const before = await all();
  assert.ok(before < 60, 'only the top level and the body fields drawn: ' + before);
  await treeRow(page, ['sublists', 'item']);
  const open1 = await treeItem(page, ['sublists', 'item']);
  assert.deepEqual([open1.exp, open1.items], ['true', 120], 'the 120 lines, each closed');
  assert.equal(await all(), before + 120);
  await treeRow(page, ['sublists', 'item', 0]);
  assert.deepEqual(await treeKids(page, ['sublists', 'item', 0]), ['item', 'amount', 'custcol_a', 'custcol_b']);
  assert.deepEqual([(await treeItem(page, ['sublists', 'item', 0, 'item'])).row, await treeKids(page, ['sublists', 'item', 0, 'item'])], ['item: {2}', ['value', 'text']], 'a line field starts open');
  /* A click on a value copies it, as in the tables. */
  assert.equal(await lastCopyAfter(page, () => treeRow(page, ['sublists', 'item', 0, 'custcol_a'])), 'alpha');
  assert.equal(await toast(page), 'Copied value');
  await treeRow(page, ['sublists', 'item', 0]);
  assert.equal((await treeItem(page, ['sublists', 'item', 0])).items, 0, 'closing removes its children again');
  await treeRow(page, ['sublists', 'item']);
  assert.equal(await all(), before);
  assert.deepEqual((await checkTree(page, await pvCopy(page))).errs, []);
});
test('edit: the JSON tree is one Tab stop; arrows, Home, End, Enter and Space work as in a tree', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  assert.equal(await panel(page, r => r.querySelector('.jt').getAttribute('aria-label')), 'Record JSON');
  assert.deepEqual(await tabStopsIn(page, '.main'), [jp(['record'])], 'one Tab stop: the first item');
  assert.equal(await panel(page, r => [...r.querySelectorAll('.jt [role="treeitem"]')].every(li => li.hasAttribute('aria-level'))), true);
  const label = p => panel(page, (r, k) => [...r.querySelectorAll('.jt [role="treeitem"]')].find(x => x.getAttribute('data-path') === k).getAttribute('aria-label'), jp(p));
  assert.equal(await label(['body']), 'body, 7 fields');
  assert.equal(await label(['record']), 'record, 4 fields', 'spoken sizes have no braces');
  assert.equal(await label(['sublists', 'item']), 'item, 2 lines');
  assert.equal(await label(['sublists', 'item', 0]), 'Line 1, 4 fields');
  assert.equal(await label(['body', 'entity']), 'entity, 4 fields');
  await page.locator('[data-act="pvclose"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await focusedPath(page), jp(['record']), 'Tab from Close reaches the tree');
  const key = async (k, want, msg) => { await page.keyboard.press(k); assert.equal(await focusedPath(page), jp(want), msg || k); };
  await key('Home', ['record'], 'Home on the first item stays there');
  await key('ArrowUp', ['record'], 'Up on the first item stays there');
  /* Left on a top-level value, or on a closed top-level item, has no parent to go to. */
  await panel(page, r => r.querySelector('.jt [data-path=\'["exportedAt"]\']').focus());
  await key('ArrowLeft', ['exportedAt'], 'Left on a top-level value stays');
  await key('ArrowRight', ['exportedAt'], 'Right on a value does nothing');
  await key('ArrowUp', ['record', 'tranid'], 'Up from exportedAt: the last child of the open record');
  await key('Home', ['record']);
  await page.keyboard.press('ArrowLeft');
  await key('ArrowLeft', ['record'], 'Left on a closed top-level item stays');
  await page.keyboard.press('ArrowRight');
  assert.equal((await treeItem(page, ['record'])).exp, 'true');
  await key('ArrowDown', ['record', 'url'], 'Down: the first child of an open item');
  await key('ArrowLeft', ['record'], 'Left on a value: its parent');
  await key('ArrowLeft', ['record'], 'Left on an open item closes it');
  assert.deepEqual(await treeItem(page, ['record']), { level: '1', exp: 'false', row: (await treeItem(page, ['record'])).row, items: 0, tab: 0 });
  await key('ArrowDown', ['exportedAt'], 'Down skips the closed item\'s children');
  await key('ArrowUp', ['record']);
  await key('ArrowRight', ['record'], 'Right on a closed item opens it');
  assert.equal((await treeItem(page, ['record'])).exp, 'true');
  await key('ArrowRight', ['record', 'url'], 'Right on an open item: its first child');
  await key('ArrowDown', ['record', 'type']);
  assert.equal(await lastCopyAfter(page, () => page.keyboard.press('Enter')), 'vendorbill', 'Enter on a value copies it');
  assert.equal(await focusedPath(page), jp(['record', 'type']), 'focus stays after the copy');
  await key('End', ['sublists', 'item', 1], 'End: the last item');
  await key('ArrowRight', ['sublists', 'item', 1]);
  assert.equal((await treeItem(page, ['sublists', 'item', 1])).exp, 'true');
  await key('Home', ['record'], 'Home: the first item');
  await key('ArrowDown', ['record', 'url']);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  assert.equal(await focusedPath(page), jp(['body']));
  await page.keyboard.press('Enter');
  assert.deepEqual([(await treeItem(page, ['body'])).exp, (await treeItem(page, ['body'])).items], ['false', 0], 'Enter closes');
  await page.keyboard.press(' ');
  assert.deepEqual([(await treeItem(page, ['body'])).exp, (await treeItem(page, ['body'])).items], ['true', 35], 'Space opens');
  assert.equal(await focusedPath(page), jp(['body']));
  assert.deepEqual(await tabStopsIn(page, '.main'), [jp(['body'])], 'still one Tab stop: the item last visited');
  /* Shift+Tab leaves the tree; Tab comes back to the same item. */
  await page.keyboard.press('Shift+Tab');
  assert.notEqual(await focusedPath(page), jp(['body']));
  await page.keyboard.press('Tab');
  assert.equal(await focusedPath(page), jp(['body']));
  assert.equal(await panel(page, r => getComputedStyle(r.activeElement.querySelector('.jr')).outlineStyle), 'solid', 'the focus ring is on the row');
});
test('edit: focus, open items and the scroll position in the JSON tree survive a background render', async t => {
  const page = await open(t, 'edit', 'lines=120');
  await frameOf(page).evaluate(() => { window.__cfHold = true; });
  await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  await treeRow(page, ['sublists', 'item']);
  await treeRow(page, ['sublists', 'item', 40]);
  await page.locator(treeSel(['sublists', 'item', 40, 'amount'])).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await focusedPath(page), jp(['sublists', 'item', 40, 'custcol_a']));
  const scroll = () => panel(page, r => r.querySelector('.main').scrollTop);
  await panel(page, r => { r.querySelector('.main').scrollTop = 500; r.querySelector('.jt').__old = true; });
  const before = await scroll();
  assert.ok(before > 0);
  /* The setup links arrive: the panel renders again and draws a new tree. */
  await frameOf(page).evaluate(() => window.__cfRelease());
  await page.waitForFunction(() => { const j = document.getElementById('nsfe-host').shadowRoot.querySelector('.jt'); return j && !j.__old; });
  assert.equal(await focusedPath(page), jp(['sublists', 'item', 40, 'custcol_a']), 'focus on the same item');
  assert.deepEqual(await tabStopsIn(page, '.main'), [jp(['sublists', 'item', 40, 'custcol_a'])]);
  assert.equal((await treeItem(page, ['sublists', 'item'])).exp, 'true', 'the big sublist the user opened is still open');
  assert.equal((await treeItem(page, ['sublists', 'item', 40])).exp, 'true');
  assert.equal(await scroll(), before, 'the same scroll position');
  /* A filter removes the item last visited: the Tab stop moves to its nearest ancestor; open items stay open. */
  await setKind(page, 'standard');
  assert.deepEqual(await treeKids(page, ['sublists', 'item', 40]), ['item', 'amount']);
  assert.deepEqual(await tabStopsIn(page, '.main'), [jp(['sublists', 'item', 40])]);
});
test('edit: the JSON tree starts from its defaults on another record and after Refresh; only the same record\'s tree keeps the scroll', async t => {
  const page = await open(t, 'edit', 'lines=120'); await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  await treeRow(page, ['sublists', 'item']);
  await treeRow(page, ['sublists', 'item', 3]);
  await treeRow(page, ['body']);
  const state = async () => [(await treeItem(page, ['body'])).exp, (await treeItem(page, ['sublists', 'item'])).exp, await treeItem(page, ['sublists', 'item', 3]).then(x => x && x.exp)];
  assert.deepEqual(await state(), ['false', 'true', 'true'], 'opened and closed by the user');
  const scroll = () => panel(page, r => r.querySelector('.main').scrollTop);
  const scrollTo = y => panel(page, (r, v) => { r.querySelector('.main').scrollTop = v; }, y);
  await scrollTo(400);
  /* A render of the same record keeps both. */
  await click(page, '[data-pv="json"]');
  assert.deepEqual(await state(), ['false', 'true', 'true']);
  assert.equal(await scroll(), 400, 'the same tree keeps its place');
  /* From Text, the tree starts at the top. */
  await click(page, '[data-jv="text"]');
  await scrollTo(300);
  assert.equal(await scroll(), 300);
  await click(page, '[data-jv="tree"]');
  assert.equal(await scroll(), 0, 'Text to Tree: from the top');
  assert.deepEqual(await state(), ['false', 'true', 'true'], 'still the same record: still as the user left it');
  /* Another record: the defaults again, from the top. */
  await scrollTo(400);
  await frameOf(page).evaluate(() => { window.nlapiGetRecordId = () => '1002'; });
  await click(page, '[data-pv="json"]');
  assert.deepEqual(await state(), ['true', 'false', null], 'defaults: body open, the 120-line sublist closed, its lines not drawn');
  assert.equal(await scroll(), 0);
  /* Refresh: the defaults again. */
  await treeRow(page, ['sublists', 'item']);
  await treeRow(page, ['body']);
  assert.deepEqual(await state(), ['false', 'true', 'false']);
  await click(page, '[data-act="refresh"]');
  assert.deepEqual(await state(), ['true', 'false', null], 'Refresh starts over');
});
test('edit: JSON tree values with < and & are shown as text, never as markup', async t => {
  const page = await open(t);
  await frameOf(page).evaluate(() => { const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'tranid' ? 'A"<b>x</b>&amp;<img src=y>' : fv(id)); });
  await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  assert.equal((await treeItem(page, ['record', 'tranid'])).row, 'tranid: "A\\"<b>x</b>&amp;<img src=y>"');
  assert.equal((await treeItem(page, ['body', 'tranid', 'value'])).row, 'value: "A\\"<b>x</b>&amp;<img src=y>"');
  assert.match((await treeItem(page, ['body', 'tranid'])).row, /^tranid: \{4\}$/);
  await treeRow(page, ['body', 'tranid']);
  assert.match((await treeItem(page, ['body', 'tranid'])).row, /value: "A\\"<b>x<\/b>&amp;<img src=y>"/, 'in the preview too');
  assert.equal(await panel(page, r => r.querySelectorAll('.jt b, .jt img').length), 0, 'no elements made from the value');
  assert.equal(await lastCopyAfter(page, () => treeRow(page, ['record', 'tranid'])), 'A"<b>x</b>&amp;<img src=y>', 'a click copies the value as it is');
});
test('edit: focus in the JSON tree goes to the Tree / Text switch when the tree is replaced by the text', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  await page.locator(treeSel(['body'])).focus();
  /* A click that does not move focus (as a script or assistive technology may do it). */
  await panel(page, r => r.querySelector('[data-jv="text"]').click());
  assert.ok(await previewText(page));
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-jv')), 'text', 'focus on the pressed switch, not lost');
});
test('edit: in Tree view, Copy JSON and Download give the same text as in Text view', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="view"]');
  const text = await previewText(page), copiedText = await pvCopy(page);
  assert.equal(noTime(copiedText), noTime(text));
  await click(page, '[data-jv="tree"]');
  const copiedTree = await pvCopy(page);
  assert.equal(noTime(copiedTree), noTime(text), 'the same text, byte for byte apart from the export time');
  assert.match(await toast(page), /^Copied JSON \([\d,]+ characters\)$/);
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), click(page, '[data-act="pvdl"]')]);
  assert.equal(d.suggestedFilename(), 'vendorbill-1001.json');
  assert.equal(noTime(fs.readFileSync(await d.path(), 'utf8')), noTime(text));
  assert.equal(await panel(page, r => !!r.querySelector('.jt')), true, 'still the tree');
});
test('edit: the JSON tree handles IDs named like built-in object properties', async t => {
  const page = await open(t, 'edit', 'protokeys=1'); await inject(page);
  await page.locator('[data-q]').fill('planted');
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="json"]');
  await click(page, '[data-jv="tree"]');
  const json = await pvCopy(page), planted = Object.keys(JSON.parse(json).body);
  assert.deepEqual(planted.slice().sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  assert.deepEqual(await treeKids(page, ['body']), planted);
  await expandAll(page);
  assert.deepEqual((await checkTree(page, json)).errs, []);
  assert.deepEqual(await treeKids(page, ['body', '__proto__']), ['label', 'type', 'value', 'text']);
  /* Closing one keeps the others open; values copy. */
  await treeRow(page, ['body', 'constructor']);
  assert.equal((await treeItem(page, ['body', 'constructor'])).exp, 'false');
  assert.equal((await treeItem(page, ['body', '__proto__'])).exp, 'true');
  const v = JSON.parse(json).body.__proto__.value;
  assert.equal(await lastCopyAfter(page, () => treeRow(page, ['body', '__proto__', 'value'])), v);
});
test('view: the JSON tree shows the saved record\'s values, the same as the JSON text', async t => {
  const page = await openView(t);
  await click(page, '[data-act="view"]');
  await click(page, '[data-jv="tree"]');
  await settled(page);
  const json = await pvCopy(page), o = JSON.parse(json);
  assert.deepEqual(await treeKids(page, ['body']), Object.keys(o.body));
  assert.deepEqual(await treeKids(page, ['sublists']), Object.keys(o.sublists));
  for (const s of Object.keys(o.sublists)) assert.match((await treeItem(page, ['sublists', s])).row, new RegExp('^' + s + ': ' + o.sublists[s].length + ' lines?$'));
  await expandAll(page);
  const c = await checkTree(page, json);
  assert.deepEqual(c.errs, []);
  assert.ok(c.values > 20, 'many values checked: ' + c.values);
});
/* Clicks Download in View Raw and returns [file name, file text]. When the Body CSV asks about the sublists,
 * answers Body only. */
async function downloadAs(page, fmt) {
  const wasOpen = await panel(page, r => !!r.querySelector('pre.code'));
  if (!wasOpen) await click(page, '[data-act="view"]');
  await click(page, '[data-pv="' + fmt + '"]');
  const dl = page.waitForEvent('download', { timeout: 5000 });
  await click(page, '[data-act="pvdl"]');
  if (await panel(page, r => !!r.querySelector('.pvask'))) await click(page, '[data-act="dlbody"]');
  const d = await dl;
  return [d.suggestedFilename(), fs.readFileSync(await d.path(), 'utf8')];
}
test('edit: Download on the Body CSV asks whether to save the sublists too, each as its own CSV', async t => {
  const page = await open(t); await inject(page);
  const ask = () => panel(page, r => { const a = r.querySelector('.main .pvask'); return a ? a.textContent : null; });
  const got = [];
  page.on('download', d => d.path().then(p => got.push([d.suggestedFilename(), fs.readFileSync(p, 'utf8')]), () => {}));
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="json"]');
  assert.equal((await downloadAs(page, 'json'))[0], 'vendorbill-1001.json', 'JSON never asks');
  got.length = 0;
  await click(page, '[data-pv="csv"]');
  const body = await previewText(page);
  await click(page, '[data-act="pvdl"]');
  assert.equal(await ask(), 'Download the sublists too? Each sublist with lines is saved as its own CSV, one row per line. Body and sublistsBody onlyCancel');
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-act')), 'dlall', 'focus on the first answer');
  assert.equal(got.length, 0, 'nothing saved yet');
  await click(page, '[data-act="dlcancel"]');
  assert.equal(await ask(), null, 'Cancel puts the question away');
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-act')), 'pvdl', 'focus back on Download');
  await page.waitForTimeout(500);
  assert.equal(got.length, 0, 'Cancel saves nothing');
  await click(page, '[data-act="pvdl"]');
  await click(page, '[data-act="pvdl"]');
  assert.equal(await ask(), null, 'Download again puts the question away');
  await click(page, '[data-act="pvdl"]');
  await click(page, '[data-act="dlall"]');
  for (let i = 0; i < 40 && got.length < 2; i++) await page.waitForTimeout(100);
  assert.deepEqual(got.map(x => x[0]), ['vendorbill-1001.csv', 'vendorbill-1001-item.csv']);
  assert.equal(got[0][1].slice(1), body, 'the Body CSV as shown');
  assert.deepEqual(got[1][1].slice(1).split('\n'), ['line_number,item,amount,custcol_a,custcol_b', '1,Widget,-5,alpha,beta', '2,Gadget,12.50,gamma,delta'], 'the sublist, one row per line');
  assert.equal(await toast(page), 'Downloaded vendorbill-1001.csv and 1 sublist file (item). If the browser asks, allow multiple downloads.');
  assert.equal(await ask(), null);
  /* Body only, and other tabs, save one file. */
  got.length = 0;
  await click(page, '[data-act="pvdl"]');
  await click(page, '[data-act="dlbody"]');
  await page.waitForTimeout(800);
  assert.deepEqual(got.map(x => x[0]), ['vendorbill-1001.csv']);
  assert.equal(await toast(page), 'Downloaded vendorbill-1001.csv');
  await click(page, '[data-act="pvdl"]');
  await click(page, '[data-tab="sub"]');
  assert.equal(await ask(), null, 'another tab drops the question');
  await click(page, '[data-tab="rec"]');
  const dl = page.waitForEvent('download', { timeout: 5000 });
  await click(page, '[data-act="pvdl"]');
  assert.equal(await ask(), null, 'Not on form does not ask');
  await (await dl).path();
});
test('edit: Download saves the format being viewed as <type>-<id>.<ext>, same content as Copy', async t => {
  const page = await open(t); await inject(page);
  for (const fmt of ['json', 'xml', 'csv']) {
    const copied = await copyAs(page, fmt);
    const [name, text] = await downloadAs(page, fmt);
    assert.equal(name, 'vendorbill-1001.' + fmt);
    if (fmt === 'csv') {
      assert.equal(text.charCodeAt(0), 0xFEFF, 'CSV starts with a byte order mark for Excel');
      assert.equal(text.slice(1), copied);
    } else if (fmt === 'json') {
      const strip = x => { const o = JSON.parse(x); delete o.exportedAt; return o; };
      assert.deepEqual(strip(text), strip(copied), 'JSON file matches Copy (apart from the export time)');
    } else assert.equal(text, copied, fmt + ' file matches Copy');
    assert.equal(await toast(page), 'Downloaded vendorbill-1001.' + fmt);
    await click(page, '[data-act="pvclose"]');
  }
  assert.equal(await panel(page, r => r.querySelector('[data-act="view"]') && !r.querySelector('[data-act="pvdl"]')), true, 'Download lives only inside View Raw');
});
test('edit: a filtered download says so; a new record is named -new', async t => {
  const page = await open(t); await inject(page);
  await setKind(page, 'custom');
  const [name, text] = await downloadAs(page, 'json');
  assert.equal(JSON.parse(text).filters.kind, 'custom');
  assert.equal(await toast(page), 'Downloaded ' + name + ' (filtered)');
  await frameOf(page).evaluate(() => { window.nlapiGetRecordId = () => ''; });
  assert.equal((await downloadAs(page, 'xml'))[0], 'vendorbill-new.xml');
});
/* Sublists tab: View Raw CSV is the sublist itself, one row per line and one column per field (T6). */
test('edit: on Sublists, View Raw CSV has one row per line, every line, named <type>-<id>-<sublist>.csv', async t => {
  const page = await open(t, 'edit', 'lines=120'); await inject(page);
  await click(page, '[data-tab="sub"]');
  assert.match(await footer(page), /\(first 50 shown\)$/, 'the table still shows 50 lines');
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="csv"]');
  const csv = await previewText(page), rows = csv.split('\n');
  assert.equal(rows[0], 'line_number,item,amount,custcol_a,custcol_b', 'header: line_number, then the field IDs');
  assert.equal(rows.length, 121, 'all 120 lines, not just the 50 shown');
  assert.equal(rows[1], '1,Widget,-5,alpha,beta', 'a select holds its name, as the table shows it');
  assert.equal(rows[2], '2,Gadget,12.50,gamma,delta');
  assert.equal(rows[75], "75,Part 75,75,a75,'=1+2", 'formula guard');
  assert.equal(rows[120], '120,Part 120,120,a120,');
  assert.match(await footer(page), /^CSV: item, all 120 lines, [\d,]+ characters$/);
  assert.equal(await copyAs(page, 'csv'), csv, 'Copy gives what is shown');
  assert.match(await toast(page), /^Copied CSV \(item, all 120 lines, [\d,]+ characters\)$/);
  const [name, text] = await downloadAs(page, 'csv');
  assert.equal(name, 'vendorbill-1001-item.csv');
  assert.equal(text.charCodeAt(0), 0xFEFF, 'byte order mark');
  assert.equal(text.slice(1), csv);
  assert.equal(await toast(page), 'Downloaded vendorbill-1001-item.csv (item, all 120 lines)');
  /* Sorting the table does not reorder the lines (or the columns). */
  await click(page, '[data-act="pvclose"]');
  await click(page, 'th[data-sort="label"]');
  await click(page, 'th[data-sort="label"]');
  await click(page, '[data-act="view"]');
  assert.equal(await previewText(page), csv, 'sorting does not change the sublist CSV');
  /* Other tabs keep the table CSV and the plain file name. */
  await click(page, '[data-tab="body"]');
  assert.equal((await previewText(page)).split('\n')[0], 'id,label,type,required,value,text');
  assert.match(await footer(page), /\(the Body table\)$/);
  assert.equal((await downloadAs(page, 'csv'))[0], 'vendorbill-1001.csv');
  assert.equal(await toast(page), 'Downloaded vendorbill-1001.csv');
});
test('edit: a sublist CSV stops at 500 lines and says so', async t => {
  const page = await open(t, 'edit', 'lines=812'); await inject(page);
  await click(page, '[data-tab="sub"]');
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="csv"]');
  const rows = (await previewText(page)).split('\n');
  assert.equal(rows.length, 501);
  assert.equal(rows[500], '500,Part 500,500,a500,');
  assert.match(await footer(page), /^CSV: item, first 500 of 812 lines, [\d,]+ characters$/);
});
test('edit: the filters and the search pick the sublist CSV columns; every line stays', async t => {
  const page = await open(t, 'edit'); await inject(page);
  await click(page, '[data-tab="sub"]');
  await setKind(page, 'custom');
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="csv"]');
  assert.deepEqual((await previewText(page)).split('\n'), ['line_number,custcol_a,custcol_b', '1,alpha,beta', '2,gamma,delta']);
  assert.match(await footer(page), /^CSV: item, all 2 lines, [\d,]+ characters • filtered: Custom only$/);
  await downloadAs(page, 'csv');
  assert.equal(await toast(page), 'Downloaded vendorbill-1001-item.csv (item, all 2 lines, filtered)');
  await setKind(page, 'all');
  /* A search moves to All (its own CSV); back on Sublists, it narrows the columns, not the lines. */
  await page.locator('[data-q]').fill('alpha');
  assert.equal((await previewText(page)).split('\n')[0], 'section,id,label,type,value,text');
  await click(page, '[data-tab="sub"]');
  assert.deepEqual((await previewText(page)).split('\n'), ['line_number,custcol_a', '1,alpha', '2,gamma']);
});
test('edit: the CSV note says which table it is, and links from other tabs to the sublist CSV', async t => {
  const page = await open(t); await inject(page);
  const note = () => panel(page, r => { const n = r.querySelector('.main .pvnote'); return n ? n.textContent : null; });
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="json"]');
  assert.equal(await note(), null, 'no note on JSON');
  await click(page, '[data-pv="csv"]');
  assert.equal(await note(), 'This CSV is the Body table. To download a sublist with every line, one row per line, open it on Sublists.');
  const csv = await previewText(page);
  assert.equal(csv.split('\n')[0], 'id,label,type,required,value,text', 'the note is not part of the CSV');
  assert.equal(await copyAs(page, 'csv'), csv, 'nor of the copy');
  await click(page, '[data-act="pvsub"]');
  assert.equal(await panel(page, r => r.querySelector('[data-tab="sub"]').getAttribute('aria-selected')), 'true', 'the link opens Sublists');
  assert.equal((await previewText(page)).split('\n')[0], 'line_number,item,amount,custcol_a,custcol_b', 'still on CSV, now the sublist');
  assert.equal(await note(), 'This CSV is the item sublist, one row per line. Pick another sublist above to export that one.');
  await click(page, '[data-pv="xml"]');
  assert.equal(await note(), null, 'no note on XML');
});
test('edit: JSON and XML export record data only, not page plumbing', async t => {
  const page = await open(t); await inject(page);
  const o = JSON.parse(await copyAs(page, 'json'));
  assert.deepEqual(Object.keys(o.body), PAGE_ORDER);
  const xml = await copyAs(page, 'xml');
  for (const id of ['nluser', 'contactrole', 'memo_line', 'item_entry']) assert.ok(!xml.includes('id="' + id + '"'), id);
});
test('edit: the record type (baserecordtype, as in the title bar) is a Body field; the other type inputs are not', async t => {
  const page = await open(t, 'edit', 'typeinputs=1'); await inject(page);
  assert.deepEqual(await ids(page), [...PAGE_ORDER, 'baserecordtype']);
  const row = await panel(page, r => r.querySelector('td.id[data-id="baserecordtype"]').parentNode.innerText.split('\t').map(x => x.trim()));
  assert.deepEqual(row, ['baserecordtype', 'Record Type', 'text, hidden', 'vendorbill']);
  assert.match(await panel(page, r => r.querySelector('.meta').textContent), /^vendorbill/, 'same value as the title bar');
  await page.locator('[data-q]').fill('vendorbill');
  assert.deepEqual(await ids(page), ['baserecordtype'], 'search finds it');
  await page.locator('[data-q]').fill('vendbill');
  assert.deepEqual(await ids(page), [], 'type, dbstrantype and ntype stay out');
});
test('edit: fields hidden on the form that are custom fields are listed in Body, marked hidden', async t => {
  const page = await open(t, 'edit', 'hiddenfield=1'); await inject(page);
  assert.deepEqual(await ids(page), [...PAGE_ORDER, 'custbody_flag', 'custpage_script_note']);
  const row = id => panel(page, (r, a) => [...r.querySelectorAll('tr')].find(tr => tr.querySelector('td.id[data-id="' + a + '"]')).innerText.split('\t').map(x => x.trim()), id);
  assert.deepEqual(await row('custbody_flag'), ['custbody_flag', '', 'hidden', 'T']);
  const look = id => panel(page, (r, a) => { const td = r.querySelector('td.id[data-id="' + a + '"]'); return [td.className, getComputedStyle(td).color, td.title]; }, id);
  const cp = await look('custpage_script_note');
  assert.equal(cp[0], 'id cu cp'); assert.equal(cp[1], 'rgb(130, 80, 223)', 'custpage IDs are purple');
  assert.match(cp[2], /^custpage: added to the form by a script\. Not saved on the record/);
  const cb = await look('custbody_flag');
  assert.equal(cb[0], 'id cu'); assert.equal(cb[1], 'rgb(128, 24, 24)', 'other custom fields stay oxblood'); assert.equal(cb[2], '');
  assert.ok(!(await ids(page)).includes('nluser'), 'plumbing stays out');
  const o = JSON.parse(await copyAs(page, 'json'));
  assert.deepEqual(o.body.custbody_flag, { label: '', type: 'hidden', value: 'T', text: '' }, 'and it is exported');
});
/* Session and security tokens (?tokens=1 or 2 in both fixtures, listed in the frame's __tokens) must never
 * be listed, found by search, exported, copied as CSV or pinned, by name or by value. */
const TOKEN_NAMES = ['_csrf', '_eml_nkey_', 'wfinstances', 'nsapiCT', 'nlapiPI', 'nluser', 'nsbrowserenv', 'entryformquerystring', '_button', 'selectedtab'];
async function expectNoTokens(page, recLoaded) {
  const tokens = await frameOf(page).evaluate(() => window.__tokens);
  assert.deepEqual(tokens.map(p => p[0]), TOKEN_NAMES, 'the fixture plants every token');
  const check = (where, text) => {
    const found = tokens.flatMap(([n, v]) => [text.includes(n) ? n : '', text.includes(v) ? n + ' value' : '']).filter(Boolean);
    assert.deepEqual(found, [], where + ' shows ' + found.join(', '));
  };
  const shown = async where => {
    const listed = await ids(page);
    assert.ok(listed.length > 0, where + ' lists fields');
    assert.deepEqual(listed.filter(id => TOKEN_NAMES.includes(id)), [], where + ' lists a token');
    check(where, await panel(page, r => r.innerHTML));
  };
  await shown('Body');
  check('Body CSV', await copyAs(page, 'csv'));
  check('JSON', await copyAs(page, 'json'));
  check('XML', await copyAs(page, 'xml'));
  await click(page, '[data-tab="rec"]'); await recLoaded();
  await shown('Not on form');
  check('Not on form CSV', await copyAs(page, 'csv'));
  /* Search looks in every section, Not on form included now that the saved record is loaded. */
  const fragments = tokens.map(([, v]) => v.slice(6, 18));
  for (const q of ['csrf', 'eml_nkey', ...TOKEN_NAMES, ...fragments]) {
    await page.locator('[data-q]').fill(q);
    assert.equal(await panel(page, r => r.querySelector('.empty') && r.querySelector('.empty').textContent), 'Nothing matches “' + q + '” in any section.', 'search for ' + q);
  }
  await click(page, '[data-act="qclear"]');
  await pinIt(page); await toastIs(page, /^Pinned/);
  const pin = await page.evaluate(() => sessionStorage.getItem('nsfe.pin'));
  assert.ok(pin && JSON.parse(pin).order.length > 0, 'pinned');
  check('Pin', pin);
}
test('edit: session tokens on the page or in the saved record are never listed, searched, exported or pinned', async t => {
  const page = await open(t, 'edit', 'tokens=1'); await inject(page);
  await expectNoTokens(page, () => page.waitForFunction(() => /saved values/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent)));
  assert.equal(await frameOf(page).evaluate(() => window.__recordLoads), 1, 'the saved record (with _csrf and _eml_nkey_) was loaded');
});
test('edit: a search containing -- still gives valid XML', async t => {
  const page = await open(t); await inject(page);
  await page.locator('[data-q]').fill('a--b');
  const xml = await copyAs(page, 'xml');
  assert.ok(await page.evaluate(x => !new DOMParser().parseFromString(x, 'application/xml').querySelector('parsererror'), xml));
});
test('edit: filters (search, hide empty, custom or standard fields)', async t => {
  const page = await open(t); await inject(page);
  await page.locator('[data-q]').fill('quote');
  assert.deepEqual(await ids(page), ['custbody_quote']);
  await page.locator('[data-q]').fill('');
  await setHideEmpty(page, true);
  assert.ok(!(await ids(page)).includes('custbody_empty'));
  await setKind(page, 'custom');
  assert.deepEqual(await ids(page), ['custbody_tags', 'custbody_quote', 'custbody_adj']);
  await setKind(page, 'standard');
  assert.deepEqual(await ids(page), ['tranid', 'entity', 'memo']);
  assert.match(await footer(page), /^3 of 7 fields/);
  const o = JSON.parse(await copyAs(page, 'json'));
  assert.deepEqual(Object.keys(o.body), ['tranid', 'entity', 'memo'], 'JSON follows the Standard filter');
  assert.equal(o.filters.kind, 'standard');
  assert.deepEqual(Object.keys(o.sublists.item[0]), ['item', 'amount'], 'only the standard sublist columns');
  const xml = await copyAs(page, 'xml');
  assert.ok(xml.includes('Standard only') && !xml.includes('id="custbody_'), 'XML follows it too');
});
test('edit: custom segments count as custom and Custom Form as standard', async t => {
  const page = await open(t, 'edit', 'segment=1'); await inject(page);
  await setKind(page, 'custom');
  assert.deepEqual(await ids(page), ['custbody_tags', 'custbody_quote', 'custbody_adj', 'custbody_empty', 'cseg1']);
  await setKind(page, 'standard');
  assert.deepEqual(await ids(page), ['tranid', 'entity', 'memo', 'customform']);
  await setKind(page, 'all');
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('td.id.cu')].map(td => td.getAttribute('data-id'))),
    ['custbody_tags', 'custbody_quote', 'custbody_adj', 'custbody_empty', 'cseg1'], 'custom fields are bold');
});
/* Hovers a row so its locate button shows, then clicks it. */
async function locateRow(page, id, sub) {
  const sel = 'td.id[data-id="' + id + '"]' + (sub ? '[data-sub="' + sub + '"]' : '');
  await page.locator(sel).first().hover();
  await page.locator(sel + ' [data-act="locate"]').first().click();
}
const toastIs = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('nsfe-host').shadowRoot.querySelector('.toast').textContent), re.source);
const outlined = page => frameOf(page).evaluate(() => [...document.querySelectorAll('*')].filter(e => e.style.outline.includes('3px')).map(e => e.getAttribute('data-field-name') || e.getAttribute('data-label') || e.id));
test('edit: Locate opens the tab a field is on, scrolls to it and flashes it, without copying', async t => {
  const page = await open(t, 'edit', 'tabs=1'); await inject(page);
  const fr = frameOf(page);
  assert.equal(await fr.evaluate(() => document.querySelector('[data-field-name="terms"]').getClientRects().length), 0, 'hidden behind its tab at first');
  const n = (await copies(page)).length;
  await locateRow(page, 'terms');
  await toastIs(page, /^Showing terms on the form$/);
  assert.deepEqual(await fr.evaluate(() => window.__tabClicks), ['billingtab'], 'only the Billing tab was clicked');
  assert.deepEqual(await outlined(page), ['terms']);
  assert.deepEqual(await fr.evaluate(() => { const st = document.querySelector('[data-field-name="terms"]').style; return [st.outline, st.outlineOffset, st.borderRadius, st.boxShadow]; }),
    ['rgb(178, 34, 34) solid 3px', '2px', '8px', 'rgba(201, 162, 39, 0.45) 0px 0px 0px 10px'], 'a rounded firebrick ring with a gold halo');
  assert.ok(await fr.evaluate(() => { const r = document.querySelector('[data-field-name="terms"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'scrolled into view');
  assert.equal((await copies(page)).length, n, 'Locate does not copy the ID');
  await page.waitForTimeout(1800);
  assert.deepEqual(await outlined(page), [], 'the outline goes away');
  assert.deepEqual(await fr.evaluate(() => { const st = document.querySelector('[data-field-name="terms"]').style; return [st.outlineOffset, st.borderRadius, st.boxShadow]; }), ['', '', ''], 'and the field is left as it was');
  await locateRow(page, 'terms');
  await toastIs(page, /^Showing terms/);
  assert.deepEqual(await fr.evaluate(() => window.__tabClicks), ['billingtab'], 'an open tab is not clicked again');
});
test('edit: Locate never clicks a look-alike tab link planted ahead of the real one', async t => {
  const page = await open(t, 'edit', 'tabs=1&plant=1'); await inject(page);
  const fr = frameOf(page);
  assert.equal(await fr.evaluate(() => document.querySelectorAll('a[data-nsps-id="billingtab"]').length), 3, 'two planted links come first');
  await locateRow(page, 'terms');
  await toastIs(page, /^Showing terms on the form$/);
  assert.equal(await fr.evaluate(() => window.__plantedClicks), 0, 'no planted link was clicked');
  assert.deepEqual(await fr.evaluate(() => window.__tabClicks), ['billingtab'], 'the real Billing tab was clicked');
  assert.deepEqual(await outlined(page), ['terms']);
  assert.ok(!/planted/.test(fr.url()), 'the form did not navigate');
});
test('edit: Locate waits for a tab that opens slowly', async t => {
  const page = await open(t, 'edit', 'tabs=1'); await inject(page);
  await locateRow(page, 'custbody_slow');
  await toastIs(page, /^Showing custbody_slow on the form$/);
  assert.deepEqual(await outlined(page), ['custbody_slow']);
});
test('edit: Locate clicks a tab again when NetSuite ignores the first click', async t => {
  const page = await open(t, 'edit', 'tabs=1'); await inject(page);
  await locateRow(page, 'custbody_flaky');
  await toastIs(page, /^Showing custbody_flaky on the form$/);
  assert.deepEqual(await frameOf(page).evaluate(() => window.__tabClicks), ['custom1008', 'custom1008']);
  assert.deepEqual(await outlined(page), ['custbody_flaky']);
});
test('edit: Locate opens the subtab a sublist is on', async t => {
  const page = await open(t, 'edit', 'tabs=1'); await inject(page);
  await click(page, '[data-tab="sub"]');
  await locateRow(page, 'amount', 'item');
  await toastIs(page, /^Showing item: amount on the form$/);
  assert.deepEqual(await frameOf(page).evaluate(() => window.__tabClicks), ['item']);
  assert.deepEqual(await outlined(page), ['Amount']);
});
test('edit: no eye for a field or column the form hides other than on a tab', async t => {
  const page = await open(t, 'edit', 'tabs=1'); await inject(page);
  const withLoc = () => panel(page, r => [...r.querySelectorAll('td.id')].filter(td => td.querySelector('[data-act="locate"]')).map(td => td.getAttribute('data-id')));
  const body = await ids(page);
  assert.ok(body.includes('custbody_formhidden') && body.includes('terms'), 'both are listed');
  assert.deepEqual(await withLoc(), body.filter(id => id !== 'custbody_formhidden'), 'fields on closed tabs keep their eye; the form-hidden field has none');
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await withLoc(), ['item', 'amount', 'custcol_b'], 'columns in a closed subtab keep their eye; the hidden Notes column has none');
  await page.locator('[data-q]').fill('formhidden');
  assert.deepEqual(await withLoc(), [], 'search results follow the same rule');
});
test('edit: Locate on a sublist column finds its header, even when labels repeat', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-tab="sub"]');
  await locateRow(page, 'custcol_b', 'item');
  await toastIs(page, /^Showing item: custcol_b on the form$/);
  assert.deepEqual(await frameOf(page).evaluate(() => { const h = [...document.querySelectorAll('td[data-nsps-type="columnheader"]')]; return h.map((x, i) => x.style.outline.includes('3px') ? i : -1).filter(i => i >= 0); }), [3], 'the second Notes header');
});
/* Sublist columns the form does not display (user report: "some line columns are visible but they are not";
 * real purchase order in view mode: 23 headers, more record columns). They get no eye, and Locate never falls
 * back to flashing the whole table. */
const subWithLoc = page => panel(page, r => [...r.querySelectorAll('td.id[data-sub]')].filter(td => td.querySelector('[data-act="locate"]')).map(td => td.getAttribute('data-id')));
const outlinedHeaders = page => frameOf(page).evaluate(() => [...document.querySelectorAll('td[data-nsps-type="columnheader"]')].map((x, i) => x.style.outline.includes('3px') ? i : -1).filter(i => i >= 0));
test('edit: no eye on machine columns the form does not display (no header cell)', async t => {
  const page = await open(t, 'edit', 'hidcols=1'); await inject(page);
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await ids(page), ['item', 'custcol_hid', 'amount', 'custcol_a', 'custcol_b', 'line', 'itemtype', 'rate'], 'every machine column is listed');
  const got = await subWithLoc(page);
  for (const id of ['item', 'amount', 'custcol_a', 'custcol_b']) assert.ok(got.includes(id), id + ' is shown and keeps its eye; got ' + JSON.stringify(got));
  for (const id of ['line', 'itemtype', 'rate']) assert.ok(!got.includes(id), id + ' has no header and no eye; got ' + JSON.stringify(got));
});
test('edit: Locate flashes the header, not the whole table, when a hidden column shares its label', async t => {
  const page = await open(t, 'edit', 'hidcols=1'); await inject(page);
  await click(page, '[data-tab="sub"]');
  await locateRow(page, 'amount', 'item');
  await toastIs(page, /^Showing item: amount on the form$/);
  assert.deepEqual(await outlinedHeaders(page), [1], 'the Amount header; flashed: ' + JSON.stringify(await outlined(page)));
});
test('edit: no eye on columns whose header is hidden by the hidden attribute, a class or visibility:collapse', async t => {
  const page = await open(t, 'edit', 'hidcols=2'); await inject(page);
  await click(page, '[data-tab="sub"]');
  const got = await subWithLoc(page);
  assert.deepEqual(got, ['item', 'amount', 'custcol_a', 'custcol_b'], 'got ' + JSON.stringify(got));
});
test('view: no eye on record columns the form does not display (no header cell)', async t => {
  const page = await openView(t, 'hidcols=1');
  await click(page, '[data-tab="sub"]');
  const all = await ids(page);
  for (const id of ['line', 'rate', 'custcol_c']) assert.ok(all.includes(id), id + ' is listed');
  const got = await subWithLoc(page);
  assert.deepEqual(got, ['item', 'description', 'amount', 'custcol_a', 'custcol_b'], 'only the columns with a header on the form get the eye; got ' + JSON.stringify(got));
});
test('view: a wide item table in a scrolling container: only shown columns get the eye, and Locate scrolls to the header', async t => {
  const page = await openView(t, 'wide=1&hidcols=1');
  const fr = frameOf(page);
  assert.ok(await fr.evaluate(() => { const b = document.getElementById('item_scroll'); return b.scrollWidth > b.clientWidth + 1000; }), 'the table is much wider than its container');
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await subWithLoc(page), ['item', 'description', 'amount', 'custcol_a', 'custcol_b']);
  await locateRow(page, 'custcol_b', 'item');
  await toastIs(page, /^Showing item: custcol_b on the form$/);
  assert.deepEqual(await outlinedHeaders(page), [4], 'the custcol_b header; flashed: ' + JSON.stringify(await outlined(page)));
  assert.ok(await fr.evaluate(() => { const b = document.getElementById('item_scroll').getBoundingClientRect(), h = document.querySelector('[data-nsps-id="columnheader_item_custcol_b"]').getBoundingClientRect(); return h.left >= b.left && h.right <= b.right; }), 'the container scrolled the header into view');
});
test('view: a header whose ID names the _display field still gives its base column the eye', async t => {
  const page = await openView(t, 'dispid=1');
  await click(page, '[data-tab="sub"]');
  assert.ok((await subWithLoc(page)).includes('item'));
  await locateRow(page, 'item', 'item');
  await toastIs(page, /^Showing item: item on the form$/);
  assert.deepEqual(await outlinedHeaders(page), [0]);
});
test('edit: Locate is offered only for fields on the form, and closing the panel clears the outline', async t => {
  const page = await open(t, 'edit', 'hiddenfield=1'); await inject(page);
  const withLoc = () => panel(page, r => [...r.querySelectorAll('td.id')].filter(td => td.querySelector('[data-act="locate"]')).map(td => td.getAttribute('data-id')));
  assert.deepEqual(await withLoc(), PAGE_ORDER, 'not on hidden fields');
  assert.equal(await panel(page, r => r.querySelector('td.id[data-id="tranid"]').innerText), 'tranid', 'the button adds no text to the ID cell');
  assert.deepEqual(await panel(page, r => { const b = r.querySelector('td.id[data-id="memo"] .loc'), i = b.querySelector('svg').getBoundingClientRect(); return [getComputedStyle(b).visibility, i.width, i.height]; }), ['visible', 14, 14], 'a 14 px eye icon, shown without hovering the row');
  await click(page, '[data-tab="rec"]');
  await page.waitForFunction(() => { const t = document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent; return /fields/.test(t) && !/loading/.test(t); });
  assert.deepEqual(await withLoc(), [], 'not on Not on form');
  await click(page, '[data-tab="body"]');
  await page.locator('[data-q]').fill('notes');
  assert.deepEqual(await withLoc(), ['custcol_a', 'custcol_b'], 'search results: sublist columns get it');
  await page.locator('[data-q]').fill('');
  await locateRow(page, 'memo');
  await toastIs(page, /^Showing memo/);
  assert.deepEqual(await outlined(page), ['memo'], 'the body memo, not the line memo');
  await click(page, '[data-act="close"]');
  assert.deepEqual(await outlined(page), [], 'closing clears the outline');
});
/* Setup-page links per field ID cell, once the background lookup has answered. */
const setupLinks = page => panel(page, r => Object.fromEntries([...r.querySelectorAll('td.id')].filter(td => td.querySelector('a.cf')).map(td => [td.getAttribute('data-id'), td.querySelector('a.cf').getAttribute('href')])));
const suiteql = page => frameOf(page).evaluate(() => window.__suiteql.slice());
const waitSetup = (page, n) => page.waitForFunction(k => { const h = document.getElementById('nsfe-host'); return h && h.shadowRoot.querySelectorAll('a.cf').length === k; }, n, { timeout: 5000 });
test('edit: custom field IDs link to their setup page, from one background lookup', async t => {
  const page = await open(t, 'edit', 'segment=1&hiddenfield=1'); await inject(page);
  await waitSetup(page, 4);
  assert.deepEqual(await setupLinks(page), {
    custbody_tags: '/app/common/custom/bodycustfield.nl?id=101',
    custbody_quote: '/app/common/custom/bodycustfield.nl?id=103',
    custbody_empty: '/app/common/custom/bodycustfield.nl?id=104',
    cseg1: '/app/common/custom/segments/segment.nl?id=7'
  }, 'a WORKFLOW-type field (custbody_adj), an unknown one (custbody_flag), standard fields and custpage fields get none');
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('.main a.cf')].map(a => getComputedStyle(a).visibility + ' ' + (a.getBoundingClientRect().width > 0))),
    ['visible true', 'visible true', 'visible true', 'visible true'], 'the arrows show without hovering their rows');
  const q = await suiteql(page);
  assert.equal(q.length, 2, 'one customfield and one customsegment query');
  assert.match(q[0][0], /^SELECT id, scriptid, fieldtype FROM customfield WHERE UPPER\(scriptid\) IN \(\?(, \?)*\)$/, 'bound parameters, no IDs in the SQL');
  assert.deepEqual(q[0][1].sort(), ['CUSTBODY_ADJ', 'CUSTBODY_EMPTY', 'CUSTBODY_FLAG', 'CUSTBODY_QUOTE', 'CUSTBODY_TAGS']);
  assert.deepEqual(q[1][1], ['CSEG1']);
  const a = await panel(page, r => { const x = r.querySelector('td.id[data-id="custbody_tags"] a.cf'); return [x.target, x.rel]; });
  assert.deepEqual(a, ['_blank', 'noopener noreferrer']);
  await click(page, '[data-tab="sub"]');
  await waitSetup(page, 1);
  assert.deepEqual(await setupLinks(page), { custcol_a: '/app/common/custom/columncustfield.nl?id=202' }, 'custcol_b is not in customfield');
  await click(page, '[data-tab="body"]');
  await click(page, '[data-tab="sub"]');
  assert.equal((await suiteql(page)).length, 3, 'each ID is asked for once');
});
test('edit: clicking a setup link opens it in a new tab and copies nothing', async t => {
  const page = await open(t); await inject(page);
  await t.context.route('**/app/common/custom/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Transaction Body Field</title>' }));
  await waitSetup(page, 3);
  const n = (await copies(page)).length;
  await page.locator('td.id[data-id="custbody_quote"]').hover();
  const [popup] = await Promise.all([t.context.waitForEvent('page'), page.locator('td.id[data-id="custbody_quote"] a.cf').click()]);
  await popup.waitForLoadState();
  assert.match(popup.url(), /\/app\/common\/custom\/bodycustfield\.nl\?id=103$/);
  await popup.close();
  assert.equal((await copies(page)).length, n, 'no copy');
});
test('edit: when the role may not read custom fields, there are no links and the footer says why', async t => {
  const page = await open(t, 'edit', 'cffail=1'); await inject(page);
  await page.waitForFunction(() => /setup links/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  assert.equal(await footer(page), '7 of 7 fields \u2022 no setup links for custom fields: this role cannot read their definitions');
  assert.equal(await panel(page, r => r.querySelector('.ft').title), 'NetSuite said: SSS_PERMISSION_VIOLATION: You need the Custom Fields permission', 'the NetSuite error is in the tooltip');
  assert.deepEqual(await setupLinks(page), {});
  await click(page, '[data-tab="sub"]');
  await page.waitForTimeout(100);
  assert.equal((await suiteql(page)).length, 1, 'no more lookups after a refusal');
});
test('edit: the title-bar mark, footer wordmark and Help > About link to syincuso.com in a new tab', async t => {
  const page = await open(t); await inject(page);
  const links = (sel = 'a.brand, a.by') => panel(page, (r, q) => [...r.querySelectorAll(q)].map(a => [a.className || a.textContent, a.getAttribute('href'), a.target, a.rel]), sel);
  const site = where => 'https://syincuso.com/?utm_source=nsn-field-explorer&utm_medium=extension&utm_content=' + where;
  assert.deepEqual(await links(), [['brand', site('title'), '_blank', 'noopener noreferrer'], ['by', site('footer'), '_blank', 'noopener noreferrer']]);
  assert.equal(await panel(page, r => r.querySelector('a.by').textContent), 'by SYiNCUSO');
  const before = await page.locator('#nsfe-host').boundingBox();
  const mark = await page.locator('a.brand').boundingBox();
  await page.evaluate(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; });
  await page.mouse.move(mark.x + 5, mark.y + 5); await page.mouse.down(); await page.mouse.move(mark.x + 120, mark.y + 80, { steps: 4 });
  assert.deepEqual(await page.locator('#nsfe-host').boundingBox(), before, 'pressing the mark does not start a drag');
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await click(page, '[data-act="help"]');
  assert.deepEqual(await links('.help a'), [['Tell us what you need', site('help') + '#contact', '_blank', 'noopener noreferrer'], ['info@syincuso.com', 'mailto:info@syincuso.com?subject=NSN%20Field%20Explorer', '', ''],
    ['NetSuite Field Explorer', 'https://github.com/michoelchaikin/netsuite-field-explorer', '_blank', 'noopener noreferrer'], ['NetSuite Field Explorer EX', 'https://github.com/alien4u/ns-field-explorer-ex', '_blank', 'noopener noreferrer']], 'and credits to the tools that inspired it');
});
test('edit: when only customfield is refused ("was not found"), segments still get links', async t => {
  const page = await open(t, 'edit', 'segment=1&cffail=2'); await inject(page);
  await waitSetup(page, 1);
  await page.waitForFunction(() => /setup links/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  assert.deepEqual(await setupLinks(page), { cseg1: '/app/common/custom/segments/segment.nl?id=7' });
  assert.match(await footer(page), / \u2022 no setup links for custom fields: this role cannot read their definitions$/);
  assert.equal(await panel(page, r => r.querySelector('.ft').title), "NetSuite said: SSS_SEARCH_ERROR_OCCURRED: Search error occurred: Record 'customfield' was not found.");
  await click(page, '[data-tab="sub"]');
  await page.waitForTimeout(100);
  assert.equal((await suiteql(page)).filter(q => /FROM customfield/.test(q[0])).length, 1, 'customfield is not asked again');
});
test('view: setup links work in view mode, Not on form too', async t => {
  const page = await openView(t);
  await waitSetup(page, 2);
  assert.deepEqual(await setupLinks(page), { custbody_tags: '/app/common/custom/bodycustfield.nl?id=101', custbody_empty: '/app/common/custom/bodycustfield.nl?id=104' });
  await click(page, '[data-tab="rec"]'); await settled(page);
  await page.waitForFunction(() => document.getElementById('nsfe-host').shadowRoot.querySelector('td.id[data-id="custbody_approver"] a.cf'));
  assert.equal((await setupLinks(page)).custbody_approver, '/app/common/custom/bodycustfield.nl?id=107');
});
/* Pin and compare. changeRecord() edits the mock after pinning: three body values (one only in number
 * format), a removed and an added body field, one changed line value and a third line. */
async function changeRecord(page) {
  await frameOf(page).evaluate(() => {
    const fv = window.nlapiGetFieldValue, ft = window.nlapiGetFieldText;
    const body = { memo: 'new memo', entity: '8', custbody_adj: '-5.00' };
    window.nlapiGetFieldValue = id => (id in body ? body[id] : fv(id));
    window.nlapiGetFieldText = id => (id === 'entity' ? 'Beta Corp' : ft(id));
    document.querySelector('[data-field-name="custbody_empty"]').remove();
    const d = document.createElement('div');
    d.setAttribute('data-nsps-type', 'field'); d.setAttribute('data-field-name', 'custbody_new'); d.setAttribute('data-field-type', 'text');
    d.setAttribute('data-nsps-label', 'New field'); d.setAttribute('data-mode', 'edit');
    const i = document.createElement('input'); i.name = 'custbody_new'; i.value = 'fresh'; d.appendChild(i);
    document.querySelector('.form').appendChild(d);
    const lv = window.nlapiGetLineItemValue, lt = window.nlapiGetLineItemText;
    window.nlapiGetLineItemCount = s => (s === 'item' ? 3 : -1);
    window.nlapiGetLineItemValue = (s, f, l) => (s === 'item' && l === 2 && f === 'amount' ? '13' : s === 'item' && l === 3 ? ({ item: '13', amount: '1' }[f] || '') : lv(s, f, l));
    window.nlapiGetLineItemText = (s, f, l) => (s === 'item' && l === 3 ? (f === 'item' ? 'Gizmo' : '') : lt(s, f, l));
  });
}
const cmpRows = page => panel(page, r => [...r.querySelectorAll('.main table tr')].slice(1).map(tr => [...tr.children].map(td => td.innerText.trim())));
const pinText = page => panel(page, r => { const b = r.querySelector('[data-act="pin"]'); return b.classList.contains('pinned') ? 'Pinned (' + b.title.replace(/ at .*/, '') + ')' : 'Pin'; });
const cmpVisible = page => panel(page, r => !r.querySelector('[data-tab="cmp"]').classList.contains('hid'));
test('edit: Pin, change the record, and Compare lists what changed', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await cmpVisible(page), false, 'no Compare tab before pinning');
  await pinIt(page);
  await toastIs(page, /^Pinned vendorbill #1001 VB-1001\./);
  assert.equal(await pinText(page), 'Pinned (Pinned vendorbill #1001 VB-1001)');
  assert.equal(await cmpVisible(page), true);
  await click(page, '[data-tab="cmp"]');
  assert.match(await panel(page, r => r.querySelector('.main .empty').textContent), /^No differences: this record matches the pinned one\.$/);
  await changeRecord(page);
  await click(page, '[data-act="refresh"]');
  assert.deepEqual(await cmpRows(page), [
    ['Body', 'entity', 'Vendor', 'Acme Supply', 'Beta Corp', 'changed'],
    ['Body', 'memo', 'Memo', '=HYPERLINK("http://evil.example","click")', 'new memo', 'changed'],
    ['Body', 'custbody_new', 'New field', '', 'fresh', 'added'],
    ['Body', 'custbody_empty', 'Empty field', '', '', 'removed'],
    ['item L2', 'amount', 'Amount', '12.50', '13', 'changed'],
    ['item L3', 'line', 'Line added', '', 'Item: Gizmo; Amount: 1', 'added']
  ], 'custbody_adj -5 vs -5.00 is the same number, so not listed');
  assert.equal(await footer(page), '6 differences from the pinned vendorbill #1001 VB-1001');
  assert.equal(await badges(page).then(b => b.cmp), '6');
  await page.locator('[data-chk="cmpAll"]').check();
  const all = await cmpRows(page);
  assert.ok(all.some(r => r[1] === 'tranid' && r[5] === 'same'), 'Show unchanged lists the same body fields too');
  assert.match(await footer(page), /^6 differences from the pinned vendorbill #1001 VB-1001 \(\d+ shown\)$/);
  await page.locator('[data-chk="cmpAll"]').uncheck();
  await page.locator('[data-q]').fill('memo');
  assert.equal(await panel(page, r => r.querySelector('[data-tab="cmp"]').classList.contains('on')), true, 'searching stays on Compare');
  assert.deepEqual((await cmpRows(page)).map(r => r[1]), ['memo']);
  await page.locator('[data-q]').fill('');
  const csv = await copyAs(page, 'csv');
  assert.equal(csv.split('\n')[0], 'where,id,label,pinned,current,change');
  assert.equal(csv.split('\n').length, 7);
});
test('edit: on the same record, lines match by line key, so reordered lines are not a change', async t => {
  const page = await open(t, 'edit', 'lukey=1'); await inject(page);
  await pinIt(page); await toastIs(page, /^Pinned/);
  await frameOf(page).evaluate(() => { const lv = window.nlapiGetLineItemValue, lt = window.nlapiGetLineItemText; window.nlapiGetLineItemValue = (s, f, l) => lv(s, f, s === 'item' ? 3 - l : l); window.nlapiGetLineItemText = (s, f, l) => lt(s, f, s === 'item' ? 3 - l : l); });
  await click(page, '[data-tab="cmp"]');
  assert.match(await panel(page, r => r.querySelector('.main .empty').textContent), /^No differences/, 'the two lines swapped places, nothing changed');
});
test('edit: a different record is matched line by line, and line keys are never compared', async t => {
  const page = await open(t, 'edit', 'lukey=1'); await inject(page);
  await pinIt(page); await toastIs(page, /^Pinned/);
  await frameOf(page).evaluate(() => {
    window.nlapiGetRecordId = () => '1002';
    const lv = window.nlapiGetLineItemValue;
    window.nlapiGetLineItemValue = (s, f, l) => (s === 'item' && f === 'lineuniquekey' ? 'z' + l : s === 'item' && f === 'amount' && l === 1 ? '-6' : lv(s, f, l));
  });
  await click(page, '[data-tab="cmp"]');
  assert.deepEqual(await cmpRows(page), [['item L1', 'amount', 'Amount', '-5', '-6', 'changed']], 'other keys, same lines by position: only the real change');
});
test('edit: the pin outlives the panel and a page reload, and Clear removes it', async t => {
  const page = await open(t); await inject(page);
  await pinIt(page);
  await toastIs(page, /^Pinned/);
  await click(page, '[data-act="close"]');
  await inject(page);
  assert.equal(await pinText(page), 'Pinned (Pinned vendorbill #1001 VB-1001)', 'still pinned after closing the panel');
  await page.reload();
  await page.waitForFunction(() => { const f = document.getElementById('classic'); return f && f.contentWindow && typeof f.contentWindow.nlapiGetRecordType === 'function' && f.contentDocument.readyState === 'complete'; });
  await inject(page);
  assert.equal(await cmpVisible(page), true, 'still pinned after a reload (sessionStorage)');
  await click(page, '[data-tab="cmp"]');
  await unpin(page);
  await toastIs(page, /^Unpinned$/);
  assert.equal(await cmpVisible(page), false);
  assert.equal(await panel(page, r => r.querySelector('[data-tab="body"]').classList.contains('on')), true, 'back to Body');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('nsfe.pin')), null);
  assert.equal(await pinText(page), 'Pin');
});
test('edit: a planted or broken pin in storage is ignored or cleaned', async t => {
  const page = await open(t);
  await page.evaluate(() => sessionStorage.setItem('nsfe.pin', '{not json'));
  await inject(page);
  assert.equal(await cmpVisible(page), false, 'broken JSON: no pin');
  await click(page, '[data-act="close"]');
  await page.evaluate(() => sessionStorage.setItem('nsfe.pin', JSON.stringify({ v: 1, type: '<b>x</b>', id: '1', at: 0, order: ['x"><img src=y>', 'memo'],
    body: { 'x"><img src=y>': ['L', '1', ''], memo: ['Memo', '<img src=z>', ''] }, subs: { 'bad id': { cols: {}, lines: [{}] } } })));
  await inject(page);
  await click(page, '[data-tab="cmp"]');
  const rows = await cmpRows(page);
  assert.ok(!rows.some(r => r[1].includes('img')), 'planted IDs are skipped');
  assert.ok(rows.some(r => r[1] === 'memo' && r[3] === '<img src=z>'), 'values are shown as text');
  assert.equal(await panel(page, r => r.querySelectorAll('.main img, .ppop img').length), 0, 'nothing from storage became markup');
  /* Malformed sublists, lines and columns are dropped instead of breaking Compare (page errors fail the test). */
  await click(page, '[data-act="close"]');
  await page.evaluate(() => sessionStorage.setItem('nsfe.pin', JSON.stringify({ v: 1, type: 'vendorbill', id: '1', at: 0, order: ['memo'], body: { memo: ['Memo', 'old', ''], x: null },
    subs: { item: null, expense: { cols: null, lines: [null, 5, 'x', [1], { amount: ['1', ''] }] }, links: { cols: {}, lines: 'nope' }, other: [] } })));
  await inject(page);
  await click(page, '[data-tab="cmp"]');
  const rows2 = await cmpRows(page);
  assert.ok(rows2.some(r => r[1] === 'memo' && r[3] === 'old'), 'the valid body field is compared');
  assert.ok(rows2.length > 1, 'Compare rendered its rows');
});
test('view: pinning the record in view mode and comparing it with itself finds no differences', async t => {
  const page = await openView(t);
  await pinIt(page);
  await toastIs(page, /^Pinned vendorbill #2002/);
  await click(page, '[data-tab="cmp"]');
  assert.match(await panel(page, r => r.querySelector('.main .empty').textContent), /^No differences/);
  assert.equal(await badges(page).then(b => b.cmp), '0');
});
/* Compare with the saved record (edit mode). ?saved=1: the mock's saved record matches the form, with numbers,
 * Dates, booleans and a multi-select array where the form has strings, plus fields and a sublist the form
 * doesn't show; it counts getSublistText and date-time getValue calls (both block on real NetSuite). */
const cmpSaved = async page => { if (!(await popOpen(page, '.ppop'))) await click(page, "[data-act='pin']"); await click(page, "[data-act='cmpsaved']"); };
const cmpHead = page => panel(page, r => [...r.querySelectorAll('.main th')].map(th => th.textContent.trim()));
const cmpBarText = page => panel(page, r => r.querySelector('.main .pvbar').textContent.trim());
const mainHas = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('nsfe-host').shadowRoot.querySelector('.main').textContent), re.source);
/* Everything read: no loading bar, and the footer no longer says reading or loading. */
const cmpReady = page => page.waitForFunction(() => {
  const r = document.getElementById('nsfe-host').shadowRoot, ft = r.querySelector('.ft').textContent;
  return /between the saved record/.test(ft) && !/reading|loading/.test(ft) && r.querySelector('.load').classList.contains('hid');
});
const counts = page => frameOf(page).evaluate(() => ({ loads: window.__recordLoads, getText: window.__getTextCalls, subText: window.__subTextCalls, dtValue: window.__dtValueCalls }));
test('edit: Compare with the saved record finds no differences on an untouched form', async t => {
  const page = await open(t, 'edit', 'saved=1&lukey=1');
  /* The form lists the multi-select values in another order than the saved record. */
  await frameOf(page).evaluate(() => {
    const sep = String.fromCharCode(5), fv = window.nlapiGetFieldValue, ft = window.nlapiGetFieldText;
    window.nlapiGetFieldValue = id => (id === 'custbody_tags' ? '2' + sep + '1' : fv(id));
    window.nlapiGetFieldText = id => (id === 'custbody_tags' ? 'Blue' + sep + 'Red' : ft(id));
  });
  await inject(page);
  assert.equal(await cmpVisible(page), false, 'no Compare tab before it is asked for');
  await cmpSaved(page);
  assert.equal(await cmpVisible(page), true, 'Compare shows without a pin');
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-act')), 'pin', 'focus goes back to the Pin button');
  await cmpReady(page);
  assert.equal(await panel(page, r => r.querySelector('.main .empty').textContent), 'No differences: this form matches the saved record.');
  assert.match(await cmpBarText(page), /^Saved record vs this form \(unsaved edits\)/);
  assert.equal(await footer(page), '0 differences between the saved record and this form');
  assert.equal(await badges(page).then(b => b.cmp), '0');
  await page.locator('[data-chk="cmpAll"]').check();
  assert.deepEqual((await cmpHead(page)).slice(3, 5), ['Saved record', 'This form (unsaved edits)']);
  const rows = await cmpRows(page);
  assert.deepEqual(rows.map(r => r[1]), ['tranid', 'entity', 'memo', 'custbody_tags', 'custbody_quote', 'custbody_adj', 'custbody_empty', 'trandate', 'paymenthold', 'custbody_pct', 'custbody_when'],
    'only fields on the form: not custbody_secret (saved only), externalid (hidden) or createddate (system date)');
  assert.ok(rows.every(r => r[5] === 'same'), 'select, multi-select, currency, percent, date, date-time and checkbox all match: ' + JSON.stringify(rows.filter(r => r[5] !== 'same')));
  assert.deepEqual(rows.find(r => r[1] === 'entity'), ['Body', 'entity', 'Vendor', 'Acme Supply', 'Acme Supply', 'same']);
  /* Warming the record (300 ms after the load, when idle) and the Sublists tab must not read line names in edit mode. */
  await page.waitForTimeout(800);
  await click(page, '[data-tab="sub"]');
  await click(page, '[data-subtab="expense"]');
  assert.deepEqual(await counts(page), { loads: 1, getText: 0, subText: 0, dtValue: 1 }, 'one date-time read (custbody_when, when idle), never createddate');
});
test('edit: Compare with the saved record lists unsaved edits, and a new line without a line key is added', async t => {
  const page = await open(t, 'edit', 'saved=1&lukey=1'); await inject(page);
  /* A new line inserted first (no lineuniquekey yet); the two saved lines move down, with one edit each. */
  await frameOf(page).evaluate(() => {
    const fv = window.nlapiGetFieldValue, ft = window.nlapiGetFieldText, lv = window.nlapiGetLineItemValue, lt = window.nlapiGetLineItemText, fresh = { item: '13', amount: '1' };
    window.nlapiGetFieldValue = id => (id === 'memo' ? 'edited memo' : id === 'entity' ? '8' : fv(id));
    window.nlapiGetFieldText = id => (id === 'entity' ? 'Beta Corp' : ft(id));
    window.nlapiGetLineItemCount = s => (s === 'item' ? 3 : -1);
    window.nlapiGetLineItemValue = (s, f, l) => (s !== 'item' ? lv(s, f, l) : l === 1 ? (fresh[f] || '') : l === 2 && f === 'item' ? '12' : l === 3 && f === 'amount' ? '13' : lv(s, f, l - 1));
    window.nlapiGetLineItemText = (s, f, l) => (s !== 'item' ? lt(s, f, l) : l === 1 ? (f === 'item' ? 'Gizmo' : '') : l === 2 && f === 'item' ? 'Gadget' : lt(s, f, l - 1));
  });
  await cmpSaved(page);
  /* The saved names arrive after the values: Acme Supply from the background search, Widget from drainWork. */
  await mainHas(page, /Acme Supply[\s\S]*Widget/);
  await cmpReady(page);
  assert.deepEqual(await cmpRows(page), [
    ['Body', 'entity', 'Vendor', 'Acme Supply', 'Beta Corp', 'changed'],
    ['Body', 'memo', 'Memo', '=HYPERLINK("http://evil.example","click")', 'edited memo', 'changed'],
    ['item L1', 'line', 'Line added', '', 'Item: Gizmo; Amount: 1; OK: F', 'added'],
    ['item L2', 'item', 'Item', 'Widget', 'Gadget', 'changed'],
    ['item L3', 'amount', 'Amount', '12.5', '13', 'changed']
  ], 'lines matched by line key; the expense sublist (no machine) and the unchanged checkbox column are not listed');
  assert.equal(await footer(page), '5 differences between the saved record and this form');
  assert.deepEqual(await counts(page), { loads: 1, getText: 0, subText: 1, dtValue: 1 }, 'one getSublistText, for the one changed line select (Widget)');
  const csv = await copyAs(page, 'csv');
  assert.equal(csv.split('\n')[0], 'where,id,label,saved,form,change');
});
test('edit: Compare with the saved record is only offered in edit mode on a saved record', async t => {
  const view = await openView(t);
  await click(view, "[data-act='pin']");
  assert.equal(await panel(view, r => !!r.querySelector('.ppop [data-act="dopin"]')), true);
  assert.equal(await panel(view, r => !!r.querySelector('.ppop [data-act="cmpsaved"]')), false, 'not in view mode');
  const page = await open(t);
  await frameOf(page).evaluate(() => { window.nlapiGetRecordId = () => ''; });
  await inject(page);
  await click(page, "[data-act='pin']");
  assert.equal(await panel(page, r => !!r.querySelector('.ppop [data-act="cmpsaved"]')), false, 'not on a record that was never saved');
});
test('edit: Compare with the saved record says why the saved record could not be loaded', async t => {
  const page = await open(t, 'edit', 'saved=1');
  await frameOf(page).evaluate(() => { const rq = window.require; window.require = (d, cb, eb) => (d[0] === 'N/record' ? setTimeout(() => eb(new Error('You do not have permission')), 10) : rq(d, cb, eb)); });
  await inject(page);
  await cmpSaved(page);
  await mainHas(page, /Could not load/);
  assert.equal(await panel(page, r => r.querySelector('.main .empty').textContent), 'Could not load the saved record: You do not have permission. Click Refresh to try again.');
  assert.equal(await footer(page), 'Could not compare with the saved record');
});
test('edit: a saved cell that fails to read does not leave Compare reading for ever; no N/format is noted', async t => {
  const page = await open(t, 'edit', 'saved=1&lukey=1&savedthrow=1&nofmt=1'); await inject(page);
  await cmpSaved(page);
  await cmpReady(page);
  assert.deepEqual(await cmpRows(page), [['item L2', 'custcol_a', 'Notes', '', 'gamma', 'changed']], 'the rest of the line was still read');
  assert.equal(await footer(page), '1 difference between the saved record and this form • saved dates shown as M/D/YYYY (N/format did not load), so a date may differ only in format');
});
test('edit: the Compare badge stays blank until the saved record has been read', async t => {
  const page = await open(t, 'edit', 'saved=1&lukey=1'); await inject(page);
  /* Every state the panel shows on the way: [footer, Compare badge]. */
  await page.evaluate(() => {
    const r = document.getElementById('nsfe-host').shadowRoot;
    window.__seen = [];
    new MutationObserver(() => window.__seen.push([r.querySelector('.ft').textContent, r.querySelector('[data-tab="cmp"] .n').textContent])).observe(r, { subtree: true, childList: true, characterData: true });
  });
  await cmpSaved(page);
  await cmpReady(page);
  const reading = (await page.evaluate(() => window.__seen)).filter(s => /reading the saved record/.test(s[0]));
  assert.ok(reading.length > 0, 'the saved record was still being read at first');
  assert.deepEqual([...new Set(reading.map(s => s[1]))], [''], 'no badge while reading');
  assert.equal(await badges(page).then(b => b.cmp), '0');
});
test('edit: after a save (a new document, same record) the saved record is loaded again', async t => {
  const page = await open(t, 'edit', 'saved=1&lukey=1'); await inject(page);
  await cmpSaved(page); await cmpReady(page);
  assert.equal((await counts(page)).loads, 1);
  await frameOf(page).evaluate(() => location.reload());
  await page.waitForFunction(() => { const f = document.getElementById('classic'), w = f && f.contentWindow; return w && w.__recordLoads === 0 && typeof w.nlapiGetRecordType === 'function' && f.contentDocument.readyState === 'complete'; });
  await click(page, '[data-tab="cmp"]');
  await cmpReady(page);
  assert.equal((await counts(page)).loads, 1, 'the new document loaded its own copy of the record');
  assert.equal(await panel(page, r => r.querySelector('.main .empty').textContent), 'No differences: this form matches the saved record.');
});
test('edit: a pin taken before the saved record loads still matches after it loads', async t => {
  const page = await open(t, 'edit', 'saved=1&lukey=1'); await inject(page);
  await pinIt(page); await toastIs(page, /^Pinned/);
  /* Not on form loads the record: Body then lists externalid (hidden, labelled) and Sublists the expense sublist. */
  await click(page, '[data-tab="rec"]');
  await page.waitForFunction(() => /saved values/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  await click(page, '[data-tab="body"]');
  assert.ok((await ids(page)).includes('externalid'), 'Body lists the hidden field once the record is loaded');
  await click(page, '[data-tab="cmp"]');
  assert.equal(await panel(page, r => r.querySelector('.main .empty').textContent), 'No differences: this record matches the pinned one.');
  /* Percent values in another format are the same number. */
  await frameOf(page).evaluate(() => { const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'custbody_pct' ? '10%' : id === 'memo' ? 'new memo' : fv(id)); });
  await click(page, '[data-tab="cmp"]');
  assert.deepEqual((await cmpRows(page)).map(r => r[1]), ['memo'], 'only the memo changed; 10.0% and 10% are the same');
  assert.equal((await counts(page)).subText, 0, 'the pinned Compare never reads line names');
});
test('edit: with a pin too, the Compare bar switches between the pinned and the saved record', async t => {
  const page = await open(t, 'edit', 'saved=1&lukey=1'); await inject(page);
  await pinIt(page); await toastIs(page, /^Pinned/);
  await frameOf(page).evaluate(() => { const fv = window.nlapiGetFieldValue; window.nlapiGetFieldValue = id => (id === 'custbody_quote' ? 'changed' : fv(id)); });
  await cmpSaved(page);
  await cmpReady(page);
  const on = () => panel(page, r => [...r.querySelectorAll('[data-cmpsrc]')].map(b => b.textContent + (b.classList.contains('on') ? '*' : '')));
  assert.deepEqual(await on(), ['Pinned record', 'Saved record*']);
  assert.deepEqual((await cmpHead(page)).slice(3, 5), ['Saved record', 'This form (unsaved edits)']);
  assert.deepEqual(await cmpRows(page), [['Body', 'custbody_quote', 'Quote test', 'say "hi", ok', 'changed', 'changed']]);
  await click(page, '[data-cmpsrc="pin"]');
  assert.deepEqual(await on(), ['Pinned record*', 'Saved record']);
  assert.deepEqual((await cmpHead(page)).slice(3, 5), ['Pinned', 'Current']);
  assert.match(await footer(page), /^1 difference from the pinned vendorbill #1001 VB-1001/);
  /* Keyboard: the switch is a plain button that keeps focus across the render; the table is a grid. */
  await page.locator('[data-cmpsrc="saved"]').focus();
  await page.keyboard.press('Enter');
  assert.match(await footer(page), /^1 difference between the saved record and this form/);
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-cmpsrc')), 'saved', 'focus stays on the switch');
  assert.deepEqual(await panel(page, r => { const tb = r.querySelector('.main table'); return [tb.getAttribute('role'), tb.querySelectorAll('[tabindex="0"]').length]; }), ['grid', 1]);
  await unpin(page); await toastIs(page, /^Unpinned$/);
  assert.equal(await cmpVisible(page), true, 'still comparing with the saved record after unpinning');
  assert.equal(await panel(page, r => r.querySelectorAll('[data-cmpsrc]').length), 0, 'no switch without a pin');
  assert.match(await footer(page), /between the saved record and this form/);
});
test('edit: CSV escapes formulas but not numbers, and quotes correctly', async t => {
  const page = await open(t); await inject(page);
  const csv = await copyAs(page, 'csv');
  const rows = csv.split('\n');
  assert.equal(rows[0], 'id,label,type,required,value,text');
  assert.equal(rows.find(r => r.startsWith('memo,')), 'memo,Memo,textarea,false,"\'=HYPERLINK(""http://evil.example"",""click"")",');
  assert.equal(rows.find(r => r.startsWith('custbody_adj,')), 'custbody_adj,Adjustment,currency,false,-5,');
  assert.equal(rows.find(r => r.startsWith('custbody_quote,')), 'custbody_quote,Quote test,text,false,"say ""hi"", ok",');
  assert.match(await toast(page), /^Copied CSV \([\d,]+ characters\)$/);
});
test('edit: CSV separates multi-select values with |, not the raw separator', async t => {
  const page = await open(t); await inject(page);
  const csv = await copyAs(page, 'csv');
  assert.ok(!csv.includes('\u0005'));
  assert.equal(csv.split('\n').find(r => r.startsWith('custbody_tags,')), 'custbody_tags,Tags,multiselect,false,1 | 2,Red | Blue');
});
test('edit: XML export is valid and separates multi-select values with |', async t => {
  const page = await open(t); await inject(page);
  const xml = await copyAs(page, 'xml');
  assert.ok(await page.evaluate(x => !new DOMParser().parseFromString(x, 'application/xml').querySelector('parsererror'), xml), 'XML does not parse');
  assert.ok(xml.includes('<field id="custbody_tags" label="Tags" type="multiselect" text="Red | Blue">1 | 2</field>'));
  assert.ok(xml.includes('<sublist id="item" count="2">'));
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml));
});
test('edit: JSON export includes body and sublist lines', async t => {
  const page = await open(t); await inject(page);
  const o = JSON.parse(await copyAs(page, 'json'));
  assert.equal(o.record.tranid, 'VB-1001');
  assert.equal(o.body.entity.text, 'Acme Supply');
  assert.equal(o.sublists.item.length, 2);
  assert.deepEqual(o.sublists.item[0].item, { value: '11', text: 'Widget' });
});
test('edit: click copies field ID, SuiteScript 1.0 and 2.x snippets', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await lastCopyAfter(page, () => click(page, 'td.id[data-id="memo"]')), 'memo');
  await setFmt(page, 'ss1');
  assert.equal(await lastCopyAfter(page, () => click(page, 'td.id[data-id="memo"]')), "nlapiGetFieldValue('memo')");
  await setFmt(page, 'ss2');
  assert.equal(await lastCopyAfter(page, () => click(page, 'td.id[data-id="memo"]')), "rec.getValue({ fieldId: 'memo' })");
  await click(page, '[data-tab="sub"]');
  assert.equal(await lastCopyAfter(page, () => click(page, 'td.id[data-id="amount"]')), "rec.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: 0 })");
});
test('edit: clicking a value copies the raw value', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await lastCopyAfter(page, () => page.locator('td.id[data-id="entity"] ~ td.v').click()), '7');
});
const focusedCell = page => panel(page, r => { const a = r.activeElement; if (!a) return null; const tr = a.closest('tr'), id = tr && tr.querySelector('td[data-id]'); return (id ? id.getAttribute('data-id') : 'head') + ':' + (a.matches('td.id') ? 'id' : a.matches('td.v') ? 'v' : a.matches('button.loc') ? 'eye' : a.tagName.toLowerCase()); });
test('edit: the table is one Tab stop; arrows move between cells, Enter or Space copies like a click', async t => {
  const page = await open(t); await inject(page);
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('.main [tabindex="0"]')].map(e => e.tagName + ':' + e.getAttribute('data-sort'))), ['TH:id'], 'one Tab stop: the first header');
  assert.equal(await panel(page, r => [...r.querySelectorAll('.main button.loc')].every(b => b.tabIndex === -1)), true, 'the eyes are reached with the arrows, not Tab');
  await page.locator('[data-act="view"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await focusedCell(page), 'head:th', 'Tab from the toolbar goes into the table');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.equal(await focusedCell(page), 'memo:id');
  const n = (await copies(page)).length;
  assert.equal(await lastCopyAfter(page, () => page.keyboard.press('Enter')), 'memo', 'Enter on a field ID copies it');
  assert.equal(await toast(page), 'Copied memo', 'the same toast as a click');
  assert.equal(await focusedCell(page), 'memo:id', 'focus stays on the cell after copying');
  await setFmt(page, 'ss2');
  await page.locator('td.id[data-id="memo"]').focus();
  assert.equal(await lastCopyAfter(page, () => page.keyboard.press(' ')), "rec.getValue({ fieldId: 'memo' })", 'Space too, following Click copies');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focusedCell(page), 'memo:eye', 'Right from a field ID reaches its eye');
  await page.keyboard.press('End');
  assert.equal(await focusedCell(page), 'memo:v');
  await page.keyboard.press('ArrowUp');
  assert.equal(await focusedCell(page), 'entity:v');
  assert.equal(await lastCopyAfter(page, () => page.keyboard.press('Enter')), '7', 'Enter on a value copies the raw value');
  assert.equal((await copies(page)).length, n + 3);
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('.main [tabindex="0"]')].length), 1, 'still one Tab stop: the cell last visited');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focusedCell(page), 'entity:eye');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.ok((await outlined(page)).includes('entity'), 'Enter on the eye shows the field on the form');
  assert.equal((await copies(page)).length, n + 3, 'and copies nothing');
});
const subtabs = page => panel(page, r => [...r.querySelectorAll('[data-subtab]')].map(b => b.getAttribute('data-subtab') + ':' + b.querySelector('.n').textContent + (b.classList.contains('on') ? ':on' : '') + (b.classList.contains('zero') ? ':zero' : '')));
test('edit: the sublist tabs row is visible only on the Sublists tab', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await page.locator('.subtabs').isVisible(), false);
  await click(page, '[data-tab="sub"]');
  assert.equal(await page.locator('.subtabs').isVisible(), true);
  assert.deepEqual(await subtabs(page), ['item:2:on']);
  await click(page, '[data-tab="body"]');
  assert.equal(await page.locator('.subtabs').isVisible(), false);
});
test('edit: sublist tab shows columns and line values', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await ids(page), ['item', 'amount', 'custcol_a', 'custcol_b']);
  assert.equal(await footer(page), '4 of 4 fields, 2 lines');
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('tr')].find(tr => tr.querySelector('td.id[data-id="item"]')).innerText.split('\t').map(x => x.trim())), ['item', 'Item', 'select', 'Widget', 'Gadget'], 'label and select type filled in from the line-entry field');
});
test('edit: Inspect on the item column works although the machine has no label for it', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="inspect"]');
  const fr = frameOf(page);
  await fr.locator('#l1-item').hover();
  assert.equal(await tip(page), 'item line 1 • item\nItem • select\n= 11');
});
test('edit: Inspect shows a tooltip, copies on click and blocks the page click', async t => {
  const page = await open(t); await inject(page);
  await setFmt(page, 'ss2');
  await click(page, '[data-act="inspect"]');
  const fr = frameOf(page);
  await fr.evaluate(() => { window.__pageClicks = 0; document.querySelector('[data-field-name="memo"]:not([data-field-context])').addEventListener('click', () => window.__pageClicks++); });
  await fr.locator('[data-field-name="memo"]:not([data-field-context])').hover();
  assert.match(await tip(page), /^memo\nMemo • textarea\n= =HYPERLINK/);
  const c = await lastCopyAfter(page, () => fr.locator('[data-field-name="memo"]:not([data-field-context])').click());
  assert.equal(c, "rec.getValue({ fieldId: 'memo' })");
  assert.equal(await fr.evaluate(() => window.__pageClicks), 0);
});
test('edit: Inspect ignores the planted field', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="inspect"]');
  const fr = frameOf(page);
  await fr.locator('#spoof').hover();
  assert.equal(await tip(page), null);
  assert.equal(await fr.evaluate(() => document.getElementById('spoof').style.outline), '');
});
test('edit: Inspect on a sublist cell resolves the right column when two share a label', async t => {
  const page = await open(t); await inject(page);
  await setFmt(page, 'ss2');
  await click(page, '[data-act="inspect"]');
  const fr = frameOf(page);
  await fr.locator('#l2-b').hover();
  assert.match(await tip(page), /^item line 2 • custcol_b\nNotes • text\n= delta$/);
  assert.equal(await lastCopyAfter(page, () => fr.locator('#l2-b').click()), "rec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_b', line: 1 })");
});
test('edit: Esc turns Inspect off', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="inspect"]');
  const fr = frameOf(page);
  await fr.locator('[data-field-name="memo"]:not([data-field-context])').hover();
  await page.keyboard.press('Escape');
  assert.equal(await panel(page, r => r.querySelector('[data-act="inspect"]').classList.contains('on')), false);
  assert.equal(await tip(page), null);
});
test('edit: copy failure is reported, Clipboard API fallback works', async t => {
  const page = await open(t); await inject(page);
  await page.evaluate(() => { window.__copyMode = 'fail'; window.__clipboardMode = 'fail'; });
  await rawCopyClick(page, 'csv');
  await page.waitForTimeout(100);
  assert.equal(await toast(page), 'Copy blocked by the browser');
  await page.evaluate(() => { window.__clipboardMode = 'ok'; });
  const c = await copyAs(page, 'csv');
  assert.ok(c.startsWith('[api]id,label'));
  assert.match(await toast(page), /^Copied CSV \([\d,]+ characters\)$/);
});
test('edit: running the script again closes the panel and cleans up', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="inspect"]');
  await frameOf(page).locator('[data-field-name="memo"]:not([data-field-context])').hover();
  await inject(page);
  assert.equal(await page.evaluate(() => !!document.getElementById('nsfe-host')), false);
  assert.equal(await frameOf(page).evaluate(() => [...document.body.children].filter(e => e.style.zIndex === '2147483647').length), 0);
  assert.equal(await frameOf(page).evaluate(() => document.querySelector('[data-field-name="memo"]:not([data-field-context])').style.outline), '');
});
const hostRect = page => page.evaluate(() => { const r = document.getElementById('nsfe-host').getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
const isMin = page => panel(page, r => r.querySelector('.p').classList.contains('min'));
async function dragHandle(page, dir, dx, dy) {
  const b = await page.locator('[data-rz="' + dir + '"]').boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}
test('edit: the panel resizes from every edge and corner; the opposite edge stays put', async t => {
  const page = await open(t); await inject(page);
  const a = await hostRect(page);                       /* starts at the top right: 600 wide */
  await dragHandle(page, 'w', -150, 0);                 /* left edge, out over the form iframe */
  let r = await hostRect(page);
  assert.deepEqual([r.left, r.w, r.left + r.w], [a.left - 150, a.w + 150, a.left + a.w], 'w: right edge fixed');
  await dragHandle(page, 's', 0, -100);                 /* bottom edge up */
  r = await hostRect(page);
  assert.deepEqual([r.top, r.h], [a.top, a.h - 100], 's: top edge fixed');
  await dragHandle(page, 'n', 0, 50);                   /* top edge down */
  r = await hostRect(page);
  assert.deepEqual([r.top, r.h], [a.top + 50, a.h - 150], 'n: bottom edge fixed');
  await dragHandle(page, 'se', -80, 40);                /* corner: both directions at once */
  const r2 = await hostRect(page);
  assert.deepEqual([r2.left, r2.top, r2.w, r2.h], [r.left, r.top, r.w - 80, r.h + 40], 'se');
  await dragHandle(page, 'nw', -30, -30);
  const r3 = await hostRect(page);
  assert.deepEqual([r3.left, r3.top, r3.w, r3.h], [r2.left - 30, r2.top - 30, r2.w + 30, r2.h + 30], 'nw');
  /* the panel still works after resizing, and the release did not leave it stuck to the mouse */
  await page.mouse.move(200, 700, { steps: 3 });
  assert.deepEqual(await hostRect(page), r3);
  assert.equal(await footer(page), '7 of 7 fields');
});
test('edit: resizing stops at the minimum size and at the window edge', async t => {
  const page = await open(t); await inject(page);
  await dragHandle(page, 'e', -2000, 0);
  await dragHandle(page, 's', 0, -2000);
  let r = await hostRect(page);
  assert.deepEqual([r.w, r.h], [380, 220]);
  await dragHandle(page, 'nw', -5000, -5000);
  r = await hostRect(page);
  assert.deepEqual([r.left, r.top], [0, 0]);
});
test('edit: collapse shrinks the panel to its title bar and expands it again', async t => {
  const page = await open(t); await inject(page);
  const full = await hostRect(page);
  await click(page, '[data-act="min"]');
  assert.equal(await isMin(page), true);
  assert.equal(await page.locator('.main').isVisible(), false);
  assert.ok((await hostRect(page)).h < 60, 'collapsed height');
  assert.equal(await panel(page, r => r.querySelector('[data-act="min"]').title), 'Expand');
  await click(page, '[data-act="min"]');
  assert.equal(await page.locator('.main').isVisible(), true);
  assert.equal((await hostRect(page)).h, full.h);
});
test('edit: position, size and collapsed state are remembered the next time it opens', async t => {
  const page = await open(t); await inject(page);
  const box = await page.locator('[data-drag] b').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x - 295, box.y + 105, { steps: 5 });
  await page.mouse.up();
  const moved = await hostRect(page);
  /* the drag ended over the form iframe: the panel must have moved and must not follow the mouse now */
  assert.ok(Math.abs(moved.left - (1400 - 12 - 600 - 300)) <= 2 && Math.abs(moved.top - (12 + 100)) <= 2, JSON.stringify(moved));
  await page.mouse.move(100, 600, { steps: 3 });
  assert.deepEqual(await hostRect(page), moved, 'panel stuck to the mouse after the drag');
  /* resize with the bottom-right corner to exactly 700 x 400 */
  const before = await hostRect(page);
  await dragHandle(page, 'se', 700 - before.w, 400 - before.h);
  await click(page, '[data-act="min"]');
  await click(page, '[data-act="close"]');
  await inject(page);
  const again = await hostRect(page);
  assert.deepEqual([again.left, again.top], [moved.left, moved.top]);
  assert.equal(await isMin(page), true);
  await click(page, '[data-act="min"]');
  assert.deepEqual([(await hostRect(page)).w, (await hostRect(page)).h], [700, 400]);
});
test('edit: a saved position outside the window is pulled back in; bad saved data is ignored', async t => {
  const page = await open(t);
  await page.evaluate(() => localStorage.setItem('nsfe.layout', JSON.stringify({ left: 9000, top: 9000, w: '9000px; color:red', h: 'x', min: 'yes' })));
  await inject(page);
  const r = await hostRect(page), vp = page.viewportSize();
  assert.ok(r.left < vp.width - 100 && r.top < vp.height - 30, JSON.stringify(r));
  assert.equal(await isMin(page), false);
  assert.equal(await panel(page, x => x.querySelector('.p').style.width), '');
  await inject(page);
  await page.evaluate(() => localStorage.setItem('nsfe.layout', '{not json'));
  await inject(page);
  assert.equal(await footer(page), '7 of 7 fields');
});
/* Column widths: header widths of the table on screen, and dragging a header's grip by dx. */
const colWidths = page => panel(page, r => { const tb = r.querySelector('.main table'); return { fixed: !!tb && tb.classList.contains('cwset'), w: Object.fromEntries([...r.querySelectorAll('.main th[data-sort]')].map(th => [th.getAttribute('data-sort'), Math.round(th.getBoundingClientRect().width)])) }; });
async function dragGrip(page, key, dx) {
  /* The setup links arrive in the background and widen the ID column, which moves the grips: wait for them. */
  await page.waitForFunction(() => { const r = document.getElementById('nsfe-host').shadowRoot; return r.querySelector('.main a.cf'); });
  const box = await page.locator('th[data-sort="' + key + '"] .cw').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}
test('edit: dragging a header edge sets the column width, without sorting; it is remembered per tab', async t => {
  const page = await open(t); await inject(page);
  await page.waitForFunction(() => document.getElementById('nsfe-host').shadowRoot.querySelector('.main a.cf'));
  const before = await colWidths(page);
  assert.equal(before.fixed, false, 'automatic layout until a column is resized');
  await dragGrip(page, 'label', 80);
  const after = await colWidths(page);
  assert.ok(after.fixed, 'fixed layout after a resize');
  assert.ok(Math.abs(after.w.label - (before.w.label + 80)) <= 2, 'label grew by 80: ' + JSON.stringify([before.w, after.w]));
  assert.ok(Math.abs(after.w.id - before.w.id) <= 2, 'the other columns keep their width');
  assert.equal(await panel(page, r => r.querySelectorAll('th.sorted').length), 0, 'the drag did not sort');
  /* A render (Refresh), and closing and opening the panel, keep it. */
  await click(page, '[data-act="refresh"]');
  assert.ok(Math.abs((await colWidths(page)).w.label - after.w.label) <= 2, 'kept after Refresh');
  await click(page, '[data-act="close"]');
  await inject(page);
  assert.ok(Math.abs((await colWidths(page)).w.label - after.w.label) <= 2, 'kept after closing and opening');
  /* Not on form shares Body's widths; Sublists has its own. */
  await click(page, '[data-tab="sub"]');
  assert.equal((await colWidths(page)).fixed, false, 'Sublists keeps automatic widths');
  /* No narrower than 40 px. */
  await click(page, '[data-tab="body"]');
  await dragGrip(page, 'type', -1000);
  assert.ok(Math.abs((await colWidths(page)).w.type - 40) <= 1, 'clamped to 40 px');
  /* Double-click a grip: back to automatic widths for this tab. */
  await page.locator('th[data-sort="label"] .cw').dblclick();
  assert.equal((await colWidths(page)).fixed, false, 'automatic again after a double-click');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('nsfe.layout')).colw.body), undefined, 'the saved widths are gone');
});
test('edit: a render in the middle of a column drag (setup links arriving) does not lose the drag', async t => {
  const page = await open(t);
  /* Hold the setup lookup until the mouse is down, so the render it causes lands mid-drag. */
  await frameOf(page).evaluate(() => { window.__cfHold = true; });
  await inject(page);
  const cf = () => panel(page, r => r.querySelectorAll('.main a.cf').length);
  assert.equal(await cf(), 0, 'no setup links yet');
  const box = await page.locator('th[data-sort="label"] .cw').boundingBox();
  const start = (await colWidths(page)).w.label;
  await page.mouse.move(box.x + 3, box.y + 8);
  await page.mouse.down();
  await frameOf(page).evaluate(() => window.__cfRelease());
  await page.waitForFunction(() => document.getElementById('nsfe-host').shadowRoot.querySelector('.main a.cf'));
  assert.ok(await cf() > 0, 'the table was re-rendered during the drag');
  await page.mouse.move(box.x + 3 + 50, box.y + 8, { steps: 4 });
  await page.mouse.up();
  const w = await colWidths(page);
  assert.ok(w.fixed, 'fixed layout');
  assert.ok(Math.abs(w.w.label - (start + 50)) <= 2, 'label is the start width plus 50: ' + JSON.stringify([start, w.w]));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('nsfe.layout')).colw.body.label), w.w.label, 'saved');
});
const waitCf = page => page.waitForFunction(() => document.getElementById('nsfe-host').shadowRoot.querySelector('.main a.cf'));
test('edit: a background render (setup links arriving) leaves focus on a form field where it is', async t => {
  const page = await open(t);
  await frameOf(page).evaluate(() => { window.__cfHold = true; });
  await inject(page);
  await frameOf(page).locator('[name="memo"]').focus();
  await frameOf(page).evaluate(() => window.__cfRelease());
  await waitCf(page);
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'IFRAME', 'the top page still has focus in the form iframe');
  assert.deepEqual(await frameOf(page).evaluate(() => [document.hasFocus(), document.activeElement.getAttribute('name')]), [true, 'memo']);
});
test('edit: a background render keeps focus on the eye clicked, without scrolling the table back', async t => {
  const page = await open(t);
  await page.evaluate(() => localStorage.setItem('nsfe.layout', JSON.stringify({ w: '400px', h: '240px', colw: { body: { label: 1500 } } })));
  await frameOf(page).evaluate(() => { window.__cfHold = true; });
  await inject(page);
  await click(page, 'td.id[data-id="memo"] button.loc');
  const scroll = () => panel(page, r => { const m = r.querySelector('.main'); return [m.scrollTop, m.scrollLeft]; });
  await panel(page, r => { const m = r.querySelector('.main'); m.scrollTop = m.scrollHeight; m.scrollLeft = 300; });
  const before = await scroll();
  assert.ok(before[0] > 0 && before[1] > 0, 'the table is scrolled down and sideways: ' + before);
  await frameOf(page).evaluate(() => window.__cfRelease());
  await waitCf(page);
  assert.deepEqual(await scroll(), before, 'not scrolled back to the eye');
  assert.equal(await focusedCell(page), 'memo:eye', 'focus is back on the same eye');
});
test('edit: a resized sublist column stays when the sublist is shown again; bad saved widths are ignored', async t => {
  const page = await open(t);
  await page.evaluate(() => localStorage.setItem('nsfe.layout', JSON.stringify({ colw: { body: { label: 5, 'x"><b>': 100, id: '200px', type: 99999 }, evil: { id: 100 }, sub: null } })));
  await inject(page);
  assert.equal((await colWidths(page)).fixed, false, 'no valid saved width: automatic layout');
  await click(page, '[data-tab="sub"]');
  await dragGrip(page, 'L1', 60);
  const w1 = (await colWidths(page)).w.L1;
  await click(page, '[data-tab="body"]');
  await click(page, '[data-tab="sub"]');
  assert.ok(Math.abs((await colWidths(page)).w.L1 - w1) <= 2, 'L1 width kept');
});
test('edit: the red X clears the search and goes back to the tab the search started from', async t => {
  const page = await open(t); await inject(page);
  const qx = () => panel(page, r => { const b = r.querySelector('.qx'); return { shown: !b.classList.contains('hid'), color: getComputedStyle(b).color }; });
  assert.equal((await qx()).shown, false, 'hidden while the box is empty');
  await click(page, '[data-tab="sub"]');
  await page.locator('[data-q]').fill('memo');
  const on = await qx();
  assert.equal(on.shown, true, 'shown while searching');
  assert.equal(on.color, 'rgb(178, 34, 34)', 'firebrick');
  assert.equal(await panel(page, r => r.querySelector('[data-tab].on').getAttribute('data-tab')), 'all');
  await click(page, '.qx');
  assert.equal(await page.locator('[data-q]').inputValue(), '', 'box emptied');
  assert.equal((await qx()).shown, false, 'hidden again');
  assert.equal(await panel(page, r => r.querySelector('[data-tab].on').getAttribute('data-tab')), 'sub', 'back on Sublists');
  assert.equal(await panel(page, r => r.querySelector('[data-tab="all"]').classList.contains('hid')), true, 'All tab hidden');
});
const panelLook = page => panel(page, r => { const p = r.querySelector('.p'), cs = getComputedStyle(p); return { cls: ['light', 'dark', 'compact'].filter(c => p.classList.contains(c)), bg: cs.backgroundColor, size: cs.fontSize }; });
const menuOpen = page => panel(page, r => !r.querySelector('.menu').classList.contains('hid'));
test('edit: the loading bar is firebrick on light and gold on dark, so it stands out from the title bar line', async t => {
  const page = await open(t); await inject(page);
  const bar = () => panel(page, r => getComputedStyle(r.querySelector('.load'), '::before').backgroundColor);
  assert.equal(await bar(), 'rgb(178, 34, 34)', 'firebrick under the gold line');
  await click(page, '[data-act="settings"]');
  await page.locator('[data-sel="theme"]').selectOption('dark');
  assert.equal(await bar(), 'rgb(201, 162, 39)', 'gold under the firebrick line');
});
test('edit: search marks are champagne in the light theme and firebrick with white text in the dark theme', async t => {
  const page = await open(t); await inject(page);
  await page.locator('[data-q]').fill('vend');
  const look = () => panel(page, r => { const m = r.querySelector('.main mark'), cs = getComputedStyle(m); return [cs.backgroundColor, cs.color, cs.boxShadow]; });
  assert.deepEqual((await look()).filter((x, i) => i !== 1), ['rgb(244, 236, 210)', 'rgb(201, 162, 39) 0px -2px 0px 0px inset'], 'champagne, gold edge');
  await click(page, '[data-act="settings"]');
  await page.locator('[data-sel="theme"]').selectOption('dark');
  assert.deepEqual(await look(), ['rgb(178, 34, 34)', 'rgb(255, 255, 255)', 'rgb(224, 70, 70) 0px -2px 0px 0px inset'], 'firebrick, white text, red edge');
});
const ring = page => panel(page, r => { const a = r.activeElement, cs = a && getComputedStyle(a); return a && [a.tagName.toLowerCase() + (a.getAttribute('data-tab') ? ':' + a.getAttribute('data-tab') : ''), cs.outlineStyle, cs.outlineColor]; });
test('edit: keyboard focus shows the --ring outline (firebrick on light, gold on dark) on tabs, buttons, cells, menus and the search', async t => {
  const page = await open(t); await inject(page);
  const RED = 'rgb(178, 34, 34)', GOLD = 'rgb(201, 162, 39)';
  await page.locator('[data-q]').focus();
  assert.deepEqual(await ring(page), ['input', 'solid', RED], 'the search box');
  await page.keyboard.press('Shift+Tab');
  assert.deepEqual(await ring(page), ['button:body', 'solid', RED], 'the selected section tab');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await ring(page), ['button:sub', 'solid', RED], 'still shown after the arrows');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.deepEqual(await ring(page), ['button', 'solid', RED], 'a toolbar button');
  await page.locator('[data-act="view"]').focus();
  await page.keyboard.press('Tab');
  assert.deepEqual(await ring(page), ['button', 'solid', RED], 'the sublist pill');
  await page.keyboard.press('Tab');
  assert.deepEqual(await ring(page), ['th', 'solid', RED], 'the table header');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await ring(page), ['td', 'solid', RED], 'a cell');
  await page.locator('[data-act="settings"]').focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await ring(page), ['select', 'solid', RED], 'a menu control');
  await page.locator('[data-sel="theme"]').selectOption('dark');
  await page.keyboard.press('Tab');
  assert.deepEqual(await ring(page), ['input', 'solid', GOLD], 'gold on dark (the Compact checkbox)');
  await page.keyboard.press('Escape');
  assert.deepEqual(await ring(page), ['button', 'solid', GOLD], 'the gear, after Esc');
});
test('edit: theme (Auto, Light, Dark) and Compact are set in the settings menu and remembered', async t => {
  const page = await open(t);
  await page.emulateMedia({ colorScheme: 'dark' });
  await inject(page);
  assert.deepEqual(await panelLook(page), { cls: [], bg: 'rgb(28, 28, 28)', size: '12px' }, 'Auto follows the dark system setting');
  assert.equal(await menuOpen(page), false);
  await click(page, '[data-act="settings"]');
  assert.equal(await menuOpen(page), true);
  assert.equal(await page.locator('[data-sel="theme"]').inputValue(), 'auto');
  await page.locator('[data-sel="theme"]').selectOption('light');
  assert.deepEqual(await panelLook(page), { cls: ['light'], bg: 'rgb(255, 255, 255)', size: '12px' }, 'Light wins over the dark system setting');
  await page.locator('[data-chk="compact"]').check();
  assert.deepEqual((await panelLook(page)).size, '11px');
  assert.equal(await menuOpen(page), true, 'changing a setting keeps the menu open');
  await click(page, '[data-act="close"]');
  await page.emulateMedia({ colorScheme: 'light' });
  await inject(page);
  assert.deepEqual(await panelLook(page), { cls: ['light', 'compact'], bg: 'rgb(255, 255, 255)', size: '11px' }, 'restored on reopen');
  await click(page, '[data-act="settings"]');
  assert.equal(await page.locator('[data-sel="theme"]').inputValue(), 'light', 'the menu shows the saved setting');
  assert.equal(await page.locator('[data-chk="compact"]').isChecked(), true);
  await page.locator('[data-sel="theme"]').selectOption('dark');
  await page.locator('[data-chk="compact"]').uncheck();
  assert.deepEqual(await panelLook(page), { cls: ['dark'], bg: 'rgb(28, 28, 28)', size: '12px' }, 'Dark wins over the light system setting');
  assert.equal(await footer(page), '7 of 7 fields', 'the table stays as it was');
});
test('edit: Click copies is in the settings menu, not the toolbar, and is remembered', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await panel(page, r => !!r.querySelector('.menu [data-sel="fmt"]') && !r.querySelector('.tbar [data-sel="fmt"]')), true);
  await setFmt(page, 'ss2');
  assert.equal(await menuOpen(page), false);
  assert.equal(await lastCopyAfter(page, () => click(page, 'td.id[data-id="memo"]')), "rec.getValue({ fieldId: 'memo' })");
  await click(page, '[data-act="close"]'); await inject(page);
  await click(page, '[data-act="settings"]');
  assert.equal(await page.locator('[data-sel="fmt"]').inputValue(), 'ss2', 'restored on reopen');
  await click(page, '[data-act="settings"]');
  assert.equal(await lastCopyAfter(page, () => click(page, 'td.id[data-id="memo"]')), "rec.getValue({ fieldId: 'memo' })", 'and used');
});
test('edit: the settings menu closes with the gear, Esc, a click elsewhere in the panel, or a click on the form', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="settings"]');
  await click(page, '[data-act="settings"]');
  assert.equal(await menuOpen(page), false, 'gear toggles it');
  await click(page, '[data-act="settings"]');
  await page.keyboard.press('Escape');
  assert.equal(await menuOpen(page), false, 'Esc');
  await click(page, '[data-act="settings"]');
  await click(page, '[data-tab="sub"]');
  assert.equal(await menuOpen(page), false, 'a click elsewhere in the panel');
  assert.equal(await panel(page, r => r.querySelector('[data-tab="sub"]').classList.contains('on')), true, 'and that click still works');
  await click(page, '[data-act="settings"]');
  await frameOf(page).locator('[name="memo"]').click();
  await page.waitForFunction(() => document.getElementById('nsfe-host').shadowRoot.querySelector('.menu').classList.contains('hid'));
  await click(page, '[data-act="settings"]');
  await page.mouse.click(5, 5);
  assert.equal(await menuOpen(page), false, 'a click on the page outside the form');
  assert.equal(await panel(page, r => r.querySelector('[data-act="settings"]').classList.contains('on')), false);
});
const focusedCtl = page => panel(page, r => { const a = r.activeElement; return a ? ['data-act', 'data-sel', 'data-chk'].filter(x => a.hasAttribute(x)).map(x => x + '=' + a.getAttribute(x)).join() : null; });
test('edit: opening a menu moves focus into it; Esc closes it and returns focus to its button', async t => {
  const page = await open(t); await inject(page);
  for (const [act, cls, first] of [['settings', '.menu', 'data-sel=theme'], ['filter', '.fpop', 'data-chk=hideEmpty'], ['pin', '.ppop', 'data-act=dopin']]) {
    await page.locator('[data-act="' + act + '"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await popOpen(page, cls), true, act + ' opens with Enter');
    assert.equal(await focusedCtl(page), first, act + ': focus on its first control');
    await page.keyboard.press('Escape');
    assert.equal(await popOpen(page, cls), false, act + ' closes with Esc');
    assert.equal(await focusedCtl(page), 'data-act=' + act, act + ': focus back on its button');
  }
  await click(page, '[data-act="filter"]');
  assert.equal(await focusedCtl(page), 'data-chk=hideEmpty', 'opened with the mouse, focus goes in too');
  await page.keyboard.press('Space');
  assert.equal(await panel(page, r => r.querySelector('[data-chk="hideEmpty"]').checked), true, 'the menu works from the keyboard');
  assert.equal(await popOpen(page, '.fpop'), true, 'and stays open');
  await page.keyboard.press('Escape');
  assert.equal(await focusedCtl(page), 'data-act=filter', 'Esc goes back to the button');
  await click(page, '[data-act="pin"]');
  await page.keyboard.press('Enter');
  assert.equal(await popOpen(page, '.ppop'), false, 'pinning closes the menu');
  assert.equal(await focusedCtl(page), 'data-act=pin', 'and focus goes back to the Pin button');
});
test('edit: a bad saved theme is ignored', async t => {
  const page = await open(t);
  await page.evaluate(() => localStorage.setItem('nsfe.layout', JSON.stringify({ theme: 'x" onclick="1', compact: 'yes' })));
  await inject(page);
  assert.deepEqual((await panelLook(page)).cls, []);
});
test('edit: close button removes the panel', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-act="close"]');
  assert.equal(await page.evaluate(() => !!document.getElementById('nsfe-host')), false);
});

test('edit: live values are used and the record is never loaded', async t => {
  const page = await open(t); await inject(page);
  await click(page, '[data-tab="sub"]');
  await click(page, '[data-act="refresh"]');
  assert.equal(await frameOf(page).evaluate(() => window.__recordLoads), 0);
  assert.ok(!(await footer(page)).includes('view mode'));
});

test('edit: Not on form loads the saved record on demand and lists only fields the form lacks', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await frameOf(page).evaluate(() => window.__recordLoads), 0);
  await click(page, '[data-tab="rec"]');
  await page.waitForFunction(() => /saved values/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  assert.deepEqual(await ids(page), ['custbody_secret', 'custbody_owner']);
  assert.equal(await rowValue(page, 'custbody_owner'), 'Pat Lee42');
  assert.equal(await footer(page), '2 of 2 fields • saved values; unsaved edits are not shown');
  assert.equal(await frameOf(page).evaluate(() => window.__recordLoads), 1);
  await click(page, '[data-tab="body"]');
  assert.match(await rowValue(page, 'memo'), /^=HYPERLINK/, 'body still shows the live (unsaved) value');
  assert.equal(await footer(page), '7 of 7 fields');
});

/* ---------- view mode ---------- */
const READY = 'view mode: values from the saved record';
async function openView(t, query) {
  const page = await open(t, 'view', query); await inject(page);
  await page.waitForFunction(() => { const h = document.getElementById('nsfe-host'); const f = h && h.shadowRoot.querySelector('.ft').textContent; return f && !/loading/.test(f) && /view mode/.test(f); });
  return page;
}
test('view: loads the saved record once and shows real values', async t => {
  const page = await openView(t);
  assert.equal(await panel(page, r => r.querySelector('.meta').textContent), 'vendorbill #2002  VB-2002');
  assert.equal(await footer(page), '8 of 8 fields • ' + READY);
  assert.equal(await rowValue(page, 'subsidiary'), 'Acme Corp56');
  assert.equal(await rowValue(page, 'entity'), 'Acme Supply7');
  assert.equal(await rowValue(page, 'trandate'), '8/19/2026');
  assert.equal(await rowValue(page, 'paymenthold'), 'F');
  assert.equal(await rowValue(page, 'custbody_tags'), 'Red | Blue1 | 2');
  assert.equal(await rowValue(page, 'memo'), '');
  assert.equal(await frameOf(page).evaluate(() => window.__recordLoads), 1);
});
test('view: editable subtab filter controls are not record fields and are not listed', async t => {
  const page = await openView(t);
  assert.ok(!(await ids(page)).includes('contact'));
  await page.locator('[data-q]').fill('activity_status'); await settled(page);
  assert.equal(await panel(page, r => r.querySelector('.empty') && r.querySelector('.empty').textContent), 'Nothing matches “activity_status” in any section.');
});
test('view: hidden fields the record has (standard or custom) are in Body, labelled from the record', async t => {
  const page = await openView(t, 'hiddenfield=1');
  await settled(page);
  const row = id => panel(page, (r, a) => [...r.querySelectorAll('tr')].find(tr => tr.querySelector('td.id[data-id="' + a + '"]')).innerText.split('\t').map(x => x.trim()), id);
  assert.deepEqual(await row('externalid'), ['externalid', 'External ID', 'text, hidden', 'EXT-9']);
  const vh = await row('custbody_vendor_hddn');
  assert.deepEqual(vh, ['custbody_vendor_hddn', 'Vendor (hidden)', 'select, hidden', 'Acme Supply\n7'], 'select name fetched in the background, ID underneath: ' + JSON.stringify(vh));
  assert.deepEqual((await row('createddate')).slice(0, 3), ['createddate', '', 'datetime, hidden'], 'unlabelled system date kept');
  assert.ok(!(await ids(page)).includes('nlrole'), 'unlabelled plumbing the record reports is left out');
  await click(page, '[data-tab="rec"]'); await settled(page);
  const rec = await ids(page);
  assert.ok(!rec.includes('externalid') && !rec.includes('nlrole'), 'neither is listed under Not on form: ' + rec.join());
});
test('view: the record type is a labelled Body field, or a labelled Not on form field when the page lacks it', async t => {
  let page = await openView(t, 'typeinputs=1'); await settled(page);
  const row = p => panel(p, r => { const td = r.querySelector('td.id[data-id="baserecordtype"]'); return td && [td.parentNode.innerText.split('\t').map(x => x.trim()), td.parentNode.className]; });
  assert.deepEqual(await row(page), [['baserecordtype', 'Record Type', 'text, hidden', 'vendorbill'], '']);
  for (const id of ['type', 'dbstrantype', 'ntype']) assert.ok(!(await ids(page)).includes(id), id + ' stays out of Body');
  page = await openView(t, 'typeinputs=2'); await settled(page);
  assert.equal(await row(page), null, 'not in Body when the page has no input');
  await click(page, '[data-tab="rec"]'); await settled(page);
  assert.deepEqual(await row(page), [['baserecordtype', 'Record Type', 'text', 'vendorbill'], ''], 'labelled, not marked internal');
});
test('view: session tokens on the page or only in the saved record are never listed, searched, exported or pinned', async t => {
  for (const q of ['tokens=1', 'tokens=2']) {
    const page = await openView(t, q); await settled(page);
    await expectNoTokens(page, () => settled(page));
    assert.ok(await frameOf(page).evaluate(() => window.__recordLoads === 1), q + ': the saved record (with _csrf and _eml_nkey_) was loaded');
  }
});
test('view: Hide empty hides fields NetSuite shows as -No value', async t => {
  const page = await openView(t);
  await setHideEmpty(page, true);
  const shown = await ids(page);
  assert.ok(!shown.includes('memo') && !shown.includes('custbody_empty'), shown.join());
  assert.ok(shown.includes('tranid'));
});
test('view: Sublists tab lists the record sublists with line values', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await subtabs(page), ['item:2:on'], 'opens on the first sublist with lines; empty ones are folded away');
  assert.equal(await panel(page, r => r.querySelector('.subtabs [data-act="emptysubs"]').textContent), '+2 empty');
  await click(page, '[data-act="emptysubs"]');
  assert.deepEqual(await subtabs(page), ['item:2:on', 'recmachcustrecord_2663_transaction:0:zero', 'expense:0:zero'], 'sublists with lines first, then the empty ones, faded');
  assert.deepEqual(await ids(page), ['item', 'description', 'amount', 'custcol_a', 'custcol_b', 'line']);
  assert.equal(await footer(page), '6 of 6 fields, 2 lines • ' + READY);
  const row = id => panel(page, (r, a) => [...r.querySelectorAll('tr')].find(tr => tr.querySelector('td.id[data-id="' + a + '"]')).innerText.split('\t').map(x => x.trim()), id);
  assert.deepEqual(await row('item'), ['item', 'Item', 'select', 'Widget', 'Gadget']);
  assert.deepEqual(await row('amount'), ['amount', 'Amount', 'currency', '5010.38', '-5']);
  assert.deepEqual(await row('custcol_b'), ['custcol_b', 'Notes', 'text', 'beta', 'delta']);
  await click(page, '[data-subtab="expense"]');
  assert.equal(await footer(page), '2 of 2 fields, 0 lines • ' + READY);
  assert.deepEqual(await subtabs(page), ['item:2', 'recmachcustrecord_2663_transaction:0:zero', 'expense:0:on:zero']);
  await click(page, '[data-act="emptysubs"]');
  assert.deepEqual(await subtabs(page), ['item:2', 'recmachcustrecord_2663_transaction:0:zero', 'expense:0:on:zero'], 'an empty sublist that is open keeps the empty ones shown');
});
test('view: the sublist row is a tablist: arrows move and open, the +N empty button is skipped and keeps focus', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('.subtabs [role="tablist"] > *')].map(b => b.getAttribute('role'))), ['tab'], 'the tablist holds only tabs');
  await page.locator('[data-act="emptysubs"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-act')), 'emptysubs', 'focus stays on it after the row is drawn again');
  assert.deepEqual(await tabStops(page, '[data-subtab]'), ['tab:0', 'tab:-1', 'tab:-1']);
  await page.locator('[data-subtab="item"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await subtabs(page), ['item:2', 'recmachcustrecord_2663_transaction:0:on:zero', 'expense:0:zero']);
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-subtab')), 'recmachcustrecord_2663_transaction', 'focus follows to the new pill');
  assert.deepEqual(await tabStops(page, '[data-subtab]'), ['tab:-1', 'tab:0', 'tab:-1']);
  await page.keyboard.press('End');
  assert.equal(await footer(page), '2 of 2 fields, 0 lines • ' + READY, 'End opens the last sublist (expense)');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await subtabs(page), ['item:2:on', 'recmachcustrecord_2663_transaction:0:zero', 'expense:0:zero'], 'wraps to the first, past the Hide button');
  assert.equal(await panel(page, r => r.activeElement && r.activeElement.getAttribute('data-subtab')), 'item');
});
test('view: while searching, sublist tabs show match counts', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="sub"]');
  await page.locator('[data-q]').fill('notes'); await settled(page);
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await subtabs(page), ['item:2:on'], 'sublists with no matches fold away');
  assert.equal(await panel(page, r => r.querySelector('.subtabs [data-act="emptysubs"]').textContent), '+2 more');
  assert.match(await panel(page, r => r.querySelector('[data-subtab="item"]').title), /: 2 matches$/);
});
test('view: JSON, XML and CSV exports use the record values', async t => {
  const page = await openView(t);
  const o = JSON.parse(await copyAs(page, 'json'));
  assert.equal(o.record.tranid, 'VB-2002');
  assert.deepEqual(o.body.subsidiary, { label: 'Subsidiary', type: 'select', value: '56', text: 'Acme Corp' });
  assert.deepEqual(o.sublists.item[1].amount, '-5');
  assert.deepEqual(o.sublists.item[0].item, { value: '11', text: 'Widget' });
  const xml = await copyAs(page, 'xml');
  assert.ok(await page.evaluate(x => !new DOMParser().parseFromString(x, 'application/xml').querySelector('parsererror'), xml));
  assert.ok(xml.includes('<record type="vendorbill" id="2002" tranid="VB-2002">'));
  assert.ok(xml.includes('<sublist id="item" count="2">'));
  const csv = await copyAs(page, 'csv');
  assert.equal(csv.split('\n').find(r => r.startsWith('memo,')), 'memo,Memo,text,false,,');
});
test('view: the sublist CSV reads the record lines without record.getText', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="sub"]');
  await click(page, '[data-act="view"]');
  await click(page, '[data-pv="csv"]');
  const rows = (await previewText(page)).split('\n');
  assert.equal(rows[0], 'line_number,item,description,amount,custcol_a,custcol_b,line', 'the line field of the record stays a normal column');
  assert.equal(rows[1], '1,Widget,First,5010.38,alpha,beta,1');
  assert.equal(rows.length, 3);
  assert.match(await footer(page), /^CSV: item, all 2 lines, /);
  assert.equal(await frameOf(page).evaluate(() => window.__getTextCalls), 0);
});
test('view: Inspect uses the cell field ID and the record value', async t => {
  const page = await openView(t);
  await setFmt(page, 'ss2');
  await click(page, '[data-act="inspect"]');
  const fr = frameOf(page);
  await fr.locator('#v1-b').hover();
  assert.equal(await tip(page), 'item line 1 • custcol_b\nNotes • text\n= beta');
  assert.equal(await lastCopyAfter(page, () => fr.locator('#v1-b').click()), "rec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_b', line: 0 })");
  await fr.locator('#v2-amount').hover();
  assert.equal(await tip(page), 'item line 2 • amount\nAmount • currency\n= -5');
  await fr.locator('[data-field-name="tranid"]').hover();
  assert.equal(await tip(page), 'tranid\nReference No. • text\n= VB-2002');
});
test('view: if the record cannot be loaded, page text is used and the reason is shown', async t => {
  const page = await openView(t, 'recfail=1');
  assert.equal(await footer(page), '8 of 8 fields • view mode: could not load the record (INSUFFICIENT_PERMISSION: You do not have permission to view this record.), showing page text');
  assert.equal(await rowValue(page, 'tranid'), 'VB-2002');
  assert.equal(await rowValue(page, 'subsidiary'), '56');
  assert.equal(await rowValue(page, 'memo'), '');
  await click(page, '[data-tab="sub"]');
  assert.equal(await panel(page, r => r.querySelector('.empty').textContent), 'No sublist data on this form.');
});
const settled = page => page.waitForFunction(() => !/loading/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
test('view: Not on form lists record fields the form does not show, without loading again', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="rec"]');
  await settled(page);
  assert.deepEqual(await ids(page), ['custbody_hidden', 'custbody_approver', 'custbody_due', 'nexus', 'sys_id']);
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('tr.int td.id')].map(td => td.getAttribute('data-id'))), ['sys_id'], 'only the unlabelled internal field is marked');
  const colors = await panel(page, r => [...r.querySelectorAll('td.id')].map(td => td.getAttribute('data-id') + ':' + getComputedStyle(td).color + ':' + getComputedStyle(td).opacity));
  assert.ok(colors.includes('sys_id:rgb(26, 127, 55):1'), 'green, full opacity: ' + colors.join());
  assert.ok(colors.includes('nexus:rgb(128, 24, 24):1'), 'others stay oxblood');
  assert.match(await panel(page, r => r.querySelector('tr.int').title), /^No label: most likely a NetSuite internal field/);
  await page.locator('[data-q]').fill('1515296'); await settled(page);
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('tr.int td.id')].map(td => td.getAttribute('data-id'))), ['sys_id'], 'green in search results too');
  await page.locator('[data-q]').fill(''); await click(page, '[data-tab="rec"]');
  assert.equal(await rowValue(page, 'custbody_hidden'), 'not on the form');
  assert.equal(await rowValue(page, 'custbody_approver'), 'Pat Lee9', 'name fetched in the background');
  assert.equal(await rowValue(page, 'custbody_due'), '9/18/2026', 'date formatted in the page');
  assert.equal(await rowValue(page, 'nexus'), 'Nevada3', 'a field the search rejects still gets its name, the slow way');
  assert.equal(await frameOf(page).evaluate(() => window.__recordLoads), 1);
});
test('view: record.getText (blocking on real NetSuite) is only used for names the search rejects, only on Not on form', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="sub"]');
  await page.locator('[data-q]').fill('a'); await settled(page);
  await page.locator('[data-q]').fill('');
  await copyAs(page, 'json');
  await click(page, '[data-tab="body"]');
  await page.waitForTimeout(300);
  assert.equal(await frameOf(page).evaluate(() => window.__getTextCalls), 0, 'not on Body, Sublists, search or export');
  await click(page, '[data-tab="rec"]'); await settled(page);
  assert.equal(await frameOf(page).evaluate(() => window.__getTextCalls), 1, 'once, for nexus');
  await click(page, '[data-tab="body"]'); await click(page, '[data-tab="rec"]'); await settled(page);
  assert.equal(await frameOf(page).evaluate(() => window.__getTextCalls), 1, 'and never again');
});
test('view: visible sublist names come from the page table; a totals row does not count as a line', async t => {
  const page = await openView(t);
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('tr')].find(tr => tr.querySelector('td.id[data-id="item"]')).innerText.split('\t').map(x => x.trim()).slice(-2)), ['Widget', 'Gadget']);
  assert.equal(await frameOf(page).evaluate(() => window.__subTextCalls), 0);
});
test('view: if the page table rows do not match the record lines, names come from the record instead', async t => {
  const page = await openView(t, 'extrarow=1');
  await click(page, '[data-tab="sub"]');
  assert.deepEqual(await panel(page, r => [...r.querySelectorAll('tr')].find(tr => tr.querySelector('td.id[data-id="item"]')).innerText.split('\t').map(x => x.trim()).slice(-2)), ['Widget', 'Gadget'], 'not EXTRA / Widget');
  assert.ok(await frameOf(page).evaluate(() => window.__subTextCalls) > 0);
});
const loadBar = page => page.locator('.load').isVisible();
const pendIds = page => panel(page, r => [...r.querySelectorAll('td.v .pend')].map(s => s.closest('tr').querySelector('td.id').getAttribute('data-id')));
test('view: a loading bar and spinners show while values are still loading, and go away when done', async t => {
  const page = await open(t, 'view', 'slowlookup=1'); await inject(page);
  assert.equal(await loadBar(page), true, 'while the record loads');
  await page.waitForFunction(() => /loading names/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  assert.equal(await loadBar(page), true, 'while names load');
  assert.deepEqual(await pendIds(page), ['custbody_tags'], 'spinner on the multi-select whose names are on their way');
  await settled(page);
  assert.equal(await loadBar(page), false);
  assert.deepEqual(await pendIds(page), []);
  await click(page, '[data-tab="rec"]');
  assert.equal(await loadBar(page), true, 'Not on form names');
  assert.ok((await pendIds(page)).includes('custbody_approver'));
  await settled(page);
  assert.equal(await loadBar(page), false);
  assert.deepEqual(await pendIds(page), [], 'including nexus, fetched the slow way');
  assert.equal(await rowValue(page, 'nexus'), 'Nevada3');
});
test('edit: no loading bar when nothing loads', async t => {
  const page = await open(t); await inject(page);
  assert.equal(await loadBar(page), false);
  assert.deepEqual(await pendIds(page), []);
});
test('view: Copy JSON while names are still loading waits for them', async t => {
  const page = await open(t, 'view', 'slowlookup=1'); await inject(page);
  await page.waitForFunction(() => /loading names/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  const n = (await copies(page)).length;
  await rawCopyClick(page, 'json');
  assert.equal(await toast(page), 'Waiting for names…');
  await page.waitForFunction(k => window.__copies.length > k, n, { timeout: 5000 });
  const o = JSON.parse((await copies(page)).slice(-1)[0]);
  assert.equal(o.body.custbody_tags.text, 'Red | Blue', 'not the page text "Red, Blue"');
});
test('view: a copy that waited for names gives focus back to the form field the user went to meanwhile', async t => {
  const page = await open(t, 'view', 'slowlookup=1'); await inject(page);
  await page.waitForFunction(() => /loading names/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  const n = (await copies(page)).length;
  await rawCopyClick(page, 'json');
  assert.equal(await toast(page), 'Waiting for names…');
  await frameOf(page).locator('select[name="contact"]').focus();
  await page.waitForFunction(k => window.__copies.length > k, n, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'IFRAME');
  assert.deepEqual(await frameOf(page).evaluate(() => [document.hasFocus(), document.activeElement.getAttribute('name')]), [true, 'contact']);
});
test('view: Download while names are still loading waits for them', async t => {
  const page = await open(t, 'view', 'slowlookup=1'); await inject(page);
  await page.waitForFunction(() => /loading names/.test(document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent));
  const [name, text] = await downloadAs(page, 'json');
  assert.equal(name, 'vendorbill-2002.json');
  assert.equal(JSON.parse(text).body.custbody_tags.text, 'Red | Blue', 'not the page text "Red, Blue"');
});
test('view: names are fetched in one background request, split only around a column NetSuite rejects', async t => {
  const page = await openView(t);
  assert.deepEqual(await frameOf(page).evaluate(() => window.__lookups), [['custbody_tags']], 'multi-select on the form');
  await click(page, '[data-tab="rec"]'); await settled(page);
  assert.deepEqual(await frameOf(page).evaluate(() => window.__lookups.slice(1)), [['custbody_approver', 'nexus'], ['custbody_approver'], ['nexus']]);
  await click(page, '[data-tab="body"]'); await click(page, '[data-tab="rec"]');
  assert.equal(await frameOf(page).evaluate(() => window.__lookups.length), 4, 'names are asked for once');
});
test('view: search includes Not on form fields, since the record is already loaded', async t => {
  const page = await openView(t);
  await page.locator('[data-q]').fill('hidden');
  await settled(page);
  assert.deepEqual(await resultRows(page), [['Not on form', 'custbody_hidden', 'Hidden field', 'text', 'not on the form']]);
  assert.equal(await footer(page), '1 match in all sections • ' + READY);
  await page.locator('[data-q]').fill('5010');
  assert.deepEqual(await resultRows(page), [['Sublist: item', 'amount', 'Amount', 'currency', 'L1: 5010.38']]);
});
test('view: Not on form explains when the record cannot be loaded', async t => {
  const page = await openView(t, 'recfail=1');
  await click(page, '[data-tab="rec"]');
  assert.equal(await panel(page, r => r.querySelector('.empty').textContent), 'Could not load the saved record: INSUFFICIENT_PERMISSION: You do not have permission to view this record. Click Refresh to try again.');
});
test('view: Refresh loads the record again', async t => {
  const page = await openView(t);
  await click(page, '[data-act="refresh"]');
  await page.waitForFunction(r => { const f = document.getElementById('nsfe-host').shadowRoot.querySelector('.ft').textContent; return f.endsWith(r); }, READY);
  assert.equal(await frameOf(page).evaluate(() => window.__recordLoads), 2);
});
test('view: closing while the record loads leaves nothing behind', async t => {
  const page = await open(t, 'view');
  await inject(page);
  await click(page, '[data-act="inspect"]');
  await inject(page);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => !!document.getElementById('nsfe-host')), false);
  assert.equal(await frameOf(page).evaluate(() => [...document.body.children].filter(e => e.style.zIndex === '2147483647').length), 0);
});

/* ---------- runner ---------- */
function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const p = path.resolve(FIX, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(FIX + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

const chosen = tests.filter(t => !filter || t.name.toLowerCase().includes(filter));
let server, failed = 0;
try {
  if (chosen.some(t => t.browser)) {
    const { chromium } = createRequire(path.join(PW_DIR, 'package.json'))('playwright');
    server = await serve();
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADED });
  }
  for (const t of chosen) {
    const ctx = { errors: [] };
    const started = Date.now();
    try {
      if (t.browser) ctx.context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await t.fn(ctx);
      if (ctx.page) {
        const csp = await ctx.page.evaluate(() => window.__csp || []);
        assert.deepEqual(csp, [], 'CSP violations');
      }
      assert.deepEqual(ctx.errors, [], 'page errors');
      console.log('  ok   ' + t.name + ' (' + (Date.now() - started) + ' ms)');
    } catch (e) {
      failed++;
      console.log('  FAIL ' + t.name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
    } finally {
      if (ctx.context) await ctx.context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
console.log('\n' + (chosen.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
