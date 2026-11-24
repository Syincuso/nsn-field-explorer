/* NSN Field Explorer: a field explorer for NetSuite Next (and classic forms).
 * Shows body field IDs, labels, types and values; sublist field IDs and line values;
 * hover-to-inspect on the form; click-to-copy IDs or snippets; JSON / CSV / XML export.
 * Run it again to close the panel. */
(function () {
  'use strict';
  var HOST_ID = 'nsfe-host';
  /* The open panel is the element with HOST_ID that carries __nsfeCleanup. Page markup (for example an
   * inline HTML field on a classic form) can copy the id but not that function, so a page element that
   * happens to use the id is never taken for the panel and removed. */
  var prev = null;
  Array.prototype.some.call(document.querySelectorAll('[id="' + HOST_ID + '"]'), function (el) {
    return typeof el.__nsfeCleanup === 'function' && !!(prev = el);
  });
  if (prev) { prev.__nsfeCleanup(); prev.remove(); return; }

  var S = { emptySubs: false, help: false, preview: '', pvLast: 'json', jsonView: 'text', tab: 'body', prevTab: 'body', dlAsk: false, sub: '', q: '', hideEmpty: false, kind: 'all', cmpAll: false, cmpSrc: 'pin', cmpSavedKey: '', fmt: 'id', theme: 'auto', compact: false, inspect: false, sortKey: '', sortDir: 0 };
  var LINE_CAP = 50;
  var cleanupFns = [], closed = false;
  /* Real NetSuite field and sublist IDs only use letters, digits and underscores. Anything else
   * on the page (for example markup planted in an inline HTML field) is ignored, so it cannot
   * spoof an ID or break out of the quotes in a copied SuiteScript snippet. */
  var ID_RE = /^[A-Za-z0-9_]+$/;
  function validId(s) { return typeof s === 'string' && ID_RE.test(s); }
  /* Maps keyed by field or sublist ID. The IDs come from the page, and an ID such as hasOwnProperty,
   * constructor or __proto__ passes validId, so a plain {} would break (an overwritten method, a replaced
   * prototype, or an inherited key taken for a real one). These maps have no prototype and are read
   * through has(). */
  function newMap() { return Object.create(null); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  /* Per-render memo (see render): one render reads each field and sublist once, although the search
   * counts, the table and the exports all ask for them. Null outside render. */
  var MEMO = null;
  function memo(key, f) {
    if (!MEMO) return f();
    if (!has(MEMO, key)) MEMO[key] = f();
    return MEMO[key];
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* NetSuite joins multi-select values with \u0005. Everything the panel shows or copies (table, CSV,
   * XML, JSON) uses MULTI_SEP instead, for example "1 | 2" and "Red | Blue". */
  var MULTI_SEP = ' | ';
  function disp(s) { return String(s == null ? '' : s).replace(/\u0005/g, MULTI_SEP); }
  /* Calls done(true) only when the text actually reached the clipboard. */
  function copyText(text, doc, done) {
    var ok = false, ta = null;
    try {
      doc = doc || document;
      ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      doc.body.appendChild(ta);
      ta.select();
      ok = doc.execCommand('copy');
    } catch (e) {}
    try { if (ta) ta.remove(); } catch (e) {}
    if (ok || !navigator.clipboard || !navigator.clipboard.writeText) { done(ok); return; }
    try { navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); }); }
    catch (e2) { done(false); }
  }

  /* ---------- find the window that holds the NetSuite form ---------- */
  function findTarget() {
    var best = null, bestScore = -1;
    (function walk(win, depth) {
      try {
        var d = win.document;
        if (typeof win.nlapiGetFieldValue === 'function') {
          var score = d.querySelectorAll('[data-nsps-type="field"][data-field-name]').length;
          if (score > bestScore) { best = win; bestScore = score; }
        }
        if (depth < 5) {
          Array.prototype.forEach.call(d.querySelectorAll('iframe,frame'), function (f) {
            try { if (f.contentWindow && f.contentWindow.document) walk(f.contentWindow, depth + 1); } catch (e) {}
          });
        }
      } catch (e) {}
    })(window, 0);
    return best;
  }
  function meta(w) {
    var m = { url: '' };
    try { m.type = w.nlapiGetRecordType(); } catch (e) {}
    try { m.id = w.nlapiGetRecordId(); } catch (e) {}
    try { m.tranid = w.nlapiGetFieldValue('tranid'); } catch (e) {}
    if (m.tranid == null) { var r = loadedRec(w), x = r && recValue(r, 'tranid'); if (x != null) m.tranid = x; }
    try { m.url = w.location.href; } catch (e) {}
    return m;
  }

  /* ---------- view mode: read the saved record through N/record ----------
   * In view mode NetSuite gives the page no live field API: nlapiGetFieldValue returns null, line
   * counts are -1 and there are no sublist machines. The page's own AMD loader can still load
   * N/record, so the record is loaded once per record (asynchronously, read-only: nothing is ever
   * set or saved) and used for values, select text and sublist lines. Refresh loads it again. */
  /* One loaded record plus caches of what has been read from it. The saved record doesn't change while
   * it is loaded, so values, field metadata, sublist columns and lines are read once (Refresh starts over).
   * doc is the form's document it was loaded for: after a save (or any reload of the form) the page has a new
   * document with the same type and id, and the record is loaded again (recMine). view: the form was in view
   * mode. fmtDone: N/format has loaded (or failed to), so dates formatted from now on can be cached.
   * work / workAsk / savedSubs: idle-time reads for Compare with the saved record (queueWork). */
  function blankRec(key, state, doc) {
    return { key: key || '', state: state || '', doc: doc || null, view: false, rec: null, err: '', vals: newMap(), meta: newMap(), cols: newMap(), lines: newMap(), base: null,
      names: newMap(), asked: newMap(), pendingNames: 0, fallback: [], draining: false, fmt: null, fmtDone: false, srch: null, pageCells: null, fieldSet: null,
      lineNames: newMap(), work: [], workAsk: newMap(), workBusy: false, workAt: 0, savedSubs: newMap() };
  }
  var REC = blankRec();
  /* Only body fields count: in view mode the filter controls on subtabs (contact, searchid,
   * Activity_STATUS...) are still editable and carry data-mode="edit" data-field-context="sublist". */
  var BODY_FIELD = '[data-nsps-type="field"]:not([data-field-context="sublist"])';
  function isViewMode(w) {
    var d = w.document;
    return !!d.querySelector(BODY_FIELD + '[data-mode="view"]') && !d.querySelector(BODY_FIELD + '[data-mode="edit"]');
  }
  function recKey(w) {
    var t = '', i = '';
    try { t = w.nlapiGetRecordType(); i = w.nlapiGetRecordId(); } catch (e) {}
    return t && i && validId(String(t)) && /^\d+$/.test(String(i)) ? t + ':' + i : '';
  }
  /* True when REC belongs to the form now in w: same record and the same document. */
  function recMine(w) {
    var d = null;
    try { d = w.document; } catch (e) {}
    return !!REC.key && REC.key === recKey(w) && REC.doc === d;
  }
  function loadedRec(w) { return REC.state === 'ready' && recMine(w) ? REC.rec : null; }
  function errMsg(e) { return e && e.message ? (e.name && e.name !== 'Error' ? e.name + ': ' : '') + e.message : String(e); }
  /* Loads in view mode automatically; in edit mode only when asked (force), for the Not on form tab. */
  function ensureRecord(w, onChange, force) {
    var key = recKey(w);
    /* Another record, or the same one in a new document (saved, reloaded): drop what was read before. */
    if (REC.state && !recMine(w)) REC = blankRec();
    if (!key || REC.state || !(force || isViewMode(w)) || typeof w.require !== 'function') return;
    var mine = blankRec(key, 'loading', w.document), parts = key.split(':');
    mine.view = isViewMode(w);
    REC = mine;
    function done(state, rec, err) {
      if (REC !== mine) return;
      mine.state = state; mine.rec = rec; mine.err = err || '';
      onChange();
      if (state === 'ready') setTimeout(function () { warmRecord(w, mine); }, 300);
    }
    /* Helpers that avoid record.getText, which makes a blocking server call per select/date field
     * (about 350 ms each on a real vendor bill, which froze the page): N/format formats dates in the
     * page, and N/search fetches select names for many fields in one background request. */
    function fmtDone(f) {
      if (mine.fmtDone) return;
      mine.fmt = f || null; mine.fmtDone = true;
      if (REC === mine && mine.state === 'ready') { onChange(); drainWork(); }
    }
    try { w.require(['N/format'], function (f) { fmtDone(f); }, function () { fmtDone(null); }); } catch (e) { fmtDone(null); }
    setTimeout(function () { fmtDone(mine.fmt); }, 5000);
    try { w.require(['N/search'], function (s) { mine.srch = s; if (mine.state === 'ready' && REC === mine) onChange(); }, function () {}); } catch (e) {}
    try {
      w.require(['N/record'], function (record) {
        try {
          if (!record || !record.load || !record.load.promise) { done('error', null, 'N/record.load.promise is not available'); return; }
          record.load.promise({ type: parts[0], id: parts[1] }).then(function (r) { done('ready', r); }, function (e) { done('error', null, errMsg(e)); });
        } catch (e) { done('error', null, errMsg(e)); }
      }, function (e) { done('error', null, errMsg(e)); });
    } catch (e) { done('error', null, errMsg(e)); }
  }
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
  /* Same string format the live nlapi functions return: checkboxes T/F, multi-select joined by \u0005. */
  function norm(v) {
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 'T' : 'F';
    if (Array.isArray(v)) return v.map(norm).join('\u0005');
    return String(v);
  }
  /* Label and type of a body field of the loaded record (cached; getField is cheap). */
  function recMeta(r, id) {
    if (!has(REC.meta, id)) {
      var f = null;
      try { f = r.getField({ fieldId: id }); } catch (e) {}
      REC.meta[id] = f ? { label: f.label || '', type: f.type || '' } : null;
    }
    return REC.meta[id];
  }
  /* A date as text without a server call: N/format with the user's preferences, else M/D/YYYY. */
  function fmtDate(d, type) {
    var dt = /time/.test(type || '');
    if (REC.fmt && REC.fmt.format && REC.fmt.Type) {
      try { return String(REC.fmt.format({ value: d, type: dt ? REC.fmt.Type.DATETIME : REC.fmt.Type.DATE })); } catch (e) {}
    }
    var s = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(), h = d.getHours(), m = d.getMinutes();
    return dt ? s + ' ' + (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'am' : 'pm') : s;
  }
  /* Value of a body field of the loaded record, in the nlapi string format, or null if the record has
   * no such field. Cached. Never calls getText (see ensureRecord). */
  function recValue(r, id) {
    if (!has(REC.vals, id)) {
      var v, out = null;
      try { v = r.getValue({ fieldId: id }); } catch (e) { v = undefined; }
      if (v !== undefined) out = isDate(v) ? fmtDate(v, (recMeta(r, id) || {}).type) : norm(v);
      /* A date formatted before N/format has loaded (M/D/YYYY) is not kept: the user's format may differ. */
      if (isDate(v) && !REC.fmtDone) return out;
      REC.vals[id] = out;
    }
    return REC.vals[id];
  }
  /* Select names the page doesn't show (Not on form fields, multi-selects): fetched in the background
   * with N/search lookupFields, one request for all of them. If NetSuite rejects a column, the request
   * is split in half and retried, so one unsearchable field can't block the others. */
  function recName(id) { return has(REC.names, id) ? REC.names[id] : null; }
  /* True while a name has been asked for and hasn't arrived. A name the search rejected only counts on
   * the Not on form tab, the only place it is fetched (elsewhere the page text is shown instead). */
  function namePending(id) {
    return REC.state === 'ready' && has(REC.asked, id) && !has(REC.names, id) && (REC.fallback.indexOf(id) < 0 || S.tab === 'rec');
  }
  function whenIdle(f) { if (window.requestIdleCallback) window.requestIdleCallback(f, { timeout: 4000 }); else setTimeout(f, 30); }
  /* Names the search rejected (for example nexus): fetched with record.getText, which blocks for
   * roughly 350 ms, so one field per idle moment and only while the Not on form tab is open. */
  function drainFallback() {
    var mine = REC;
    if (mine.draining || !mine.fallback.length || mine.state !== 'ready') return;
    mine.draining = true;
    whenIdle(function () {
      mine.draining = false;
      if (REC !== mine || closed || S.tab !== 'rec') return;
      var id = mine.fallback.shift();
      try { mine.names[id] = norm(mine.rec.getText({ fieldId: id })); } catch (e) { mine.names[id] = ''; }
      render();
    });
  }
  function requestNames(ids) {
    var mine = REC, parts = mine.key.split(':'), s = mine.srch;
    if (mine.state !== 'ready' || !s || !s.lookupFields || !s.lookupFields.promise) return;
    var todo = ids.filter(function (id) { return !has(mine.asked, id); });
    if (!todo.length) return;
    todo.forEach(function (id) { mine.asked[id] = 1; });
    function run(cols) {
      return s.lookupFields.promise({ type: parts[0], id: parts[1], columns: cols }).then(function (res) {
        cols.forEach(function (c) {
          var x = res && has(res, c) ? res[c] : null;
          mine.names[c] = Array.isArray(x) ? x.map(function (o) { return o && o.text != null ? String(o.text) : ''; }).join('\u0005') : '';
        });
      }, function () {
        /* A field the search rejects gets its name the slow way later (drainFallback). */
        if (cols.length < 2) { mine.fallback.push(cols[0]); return; }
        var half = Math.ceil(cols.length / 2);
        return Promise.all([run(cols.slice(0, half)), run(cols.slice(half))]);
      });
    }
    mine.pendingNames++;
    var finish = function () { mine.pendingNames--; if (REC === mine && !closed) render(); };
    try { run(todo).then(finish, finish); } catch (e) { finish(); }
  }
  /* After the record loads, read every body value and sublist cell into the caches while the browser is
   * idle (requestIdleCallback), so the first search or tab switch doesn't stall reading them, and the
   * reading never competes with dragging or typing. A single NetSuite call can still take 100-200 ms. */
  function warmRecord(w, mine) {
    var r = mine.rec, tasks = [];
    /* Date-time fields are skipped: on a real vendor bill getValue on createddate / lastmodifieddate took
     * 200-270 ms each, and they are only needed if Not on form or search shows them. */
    try {
      (r.getFields() || []).forEach(function (id) {
        if (validId(id)) tasks.push(function () { var m = recMeta(r, id); if (!(m && /^datetime/.test(m.type))) recValue(r, id); });
      });
    } catch (e) {}
    /* Edit mode: the form's own machines have the lines, and without data-field-name cells every select and date
     * cell would need getSublistText. */
    if (mine.view) try {
      r.getSublists().forEach(function (sid) {
        if (!validId(sid)) return;
        tasks.push(function () {
          var cols = recCols(w, r, sid) || [], n = 0;
          try { n = Math.min(r.getLineCount({ sublistId: sid }), LINE_CAP); } catch (e) {}
          for (var i = 0; i < n; i++) cols.forEach(function (c) { (function (c, i) { tasks.push(function () { recLine(r, sid, c, i, w); }); })(c, i); });
        });
      });
    } catch (e) {}
    /* A read index, not tasks.shift(): shift is O(n), and a big sublist queues thousands of tasks. Tasks
     * may queue more tasks (one per line cell), which land at the end. */
    var next = 0;
    function step(deadline) {
      if (REC !== mine || closed) return;
      var t0 = Date.now(), f;
      do { f = tasks[next]; tasks[next++] = null; f(); }
      while (next < tasks.length && (deadline && !deadline.didTimeout ? deadline.timeRemaining() > 4 : Date.now() - t0 < 8));
      if (next < tasks.length) whenIdle(step);
    }
    if (tasks.length) whenIdle(step);
  }
  /* Text of the view-mode table cell for a sublist line and column, or null if the page doesn't show
   * that column. Line rows are the table's rows that have data-field-name cells (header, totals and
   * "no records" rows have none). The page is only trusted when it has exactly one row per record line;
   * otherwise a row could be paired with the wrong line, so the record is asked instead. */
  function pageCell(w, sid, fid, i) {
    if (!REC.pageCells) REC.pageCells = newMap();
    if (!has(REC.pageCells, sid)) {
      var rows = [], tb = w.document.querySelector('table[data-sublist-id="' + sid + '"]'), lines = -1;
      if (tb) Array.prototype.forEach.call(tb.rows, function (tr) {
        if (tr.querySelector('td[data-nsps-type="columnheader"]')) return;
        var cells = newMap(), any = false;
        Array.prototype.forEach.call(tr.cells, function (td) { var f = td.getAttribute('data-field-name'); if (validId(f)) { cells[f] = td.textContent.trim(); any = true; } });
        if (any) rows.push(cells);
      });
      try { lines = REC.rec.getLineCount({ sublistId: sid }); } catch (e) {}
      REC.pageCells[sid] = rows.length && rows.length === lines ? rows : null;
    }
    var row = REC.pageCells[sid] && REC.pageCells[sid][i];
    return row && has(row, fid) ? row[fid] : null;
  }
  function recLine(r, sid, c, i, w) {
    var key = sid + '|' + c.id + '|' + i;
    if (has(REC.lines, key)) return REC.lines[key];
    var v = '', t = '', shown;
    try { v = r.getSublistValue({ sublistId: sid, fieldId: c.id, line: i }); } catch (e) {}
    /* Edit mode: the page table has no data-field-name cells to read names from, and getSublistText can block,
     * so dates are formatted with fmtDate and select names left empty (search, Sublists and exports). */
    if (!REC.view) {
      if (isDate(v)) { var d = fmtDate(v, c.type); if (!REC.fmtDone) return { v: d, t: '' }; v = d; }
      return (REC.lines[key] = { v: norm(v), t: '' });
    }
    /* Names and dates: use what the page's own table shows when it shows the column (free); only hidden
     * columns ask the record (getSublistText can block for over 100 ms on some select columns). */
    if (isDate(v) || /select/.test(c.type)) shown = w ? pageCell(w, sid, c.id, i) : null;
    if (isDate(v)) { if (shown != null && shown !== '') v = shown; else { try { v = r.getSublistText({ sublistId: sid, fieldId: c.id, line: i }); } catch (e) {} } }
    else if (/select/.test(c.type)) { if (shown != null) t = shown; else { try { t = r.getSublistText({ sublistId: sid, fieldId: c.id, line: i }); } catch (e) {} } }
    return (REC.lines[key] = { v: norm(v), t: norm(t) });
  }
  /* Columns of a sublist from the loaded record: the columns shown on the page first (in page order,
   * with the page's labels), then every other field the record has on that sublist. */
  function recCols(w, r, sid) {
    if (!has(REC.cols, sid)) REC.cols[sid] = readRecCols(w, r, sid);
    return REC.cols[sid];
  }
  function readRecCols(w, r, sid) {
    var fields, count = 0, hdr = newMap(), order = [], cols = [], seen = newMap(), pre = 'columnheader_' + sid + '_';
    try { if (r.getSublists().indexOf(sid) < 0) return null; fields = r.getSublistFields({ sublistId: sid }) || []; } catch (e) { return null; }
    try { count = r.getLineCount({ sublistId: sid }); } catch (e) {}
    Array.prototype.forEach.call(w.document.querySelectorAll('table[data-sublist-id="' + sid + '"] td[data-nsps-type="columnheader"]'), function (h) {
      var n = h.getAttribute('data-nsps-id') || '', id = n.indexOf(pre) === 0 ? n.slice(pre.length) : '';
      if (validId(id) && !has(hdr, id)) { hdr[id] = h.getAttribute('data-label') || ''; order.push(id); }
    });
    function add(id) {
      if (has(seen, id) || !validId(id) || fields.indexOf(id) < 0) return;
      seen[id] = 1;
      var f = null;
      if (count > 0) { try { f = r.getSublistField({ sublistId: sid, fieldId: id, line: 0 }); } catch (e) {} }
      cols.push({ id: id, label: (has(hdr, id) && hdr[id]) || (f && f.label) || '', type: (f && f.type) || '', hasDisplay: false });
    }
    order.forEach(add);
    fields.forEach(add);
    cols.fromRecord = true;
    return cols;
  }
  /* Value shown in the Inspect tooltip. */
  function fieldVal(w, id) {
    var v = null;
    try { v = w.nlapiGetFieldValue(id); } catch (e) {}
    if (v == null) { var r = loadedRec(w), x = r && recValue(r, id); if (x != null) v = x; }
    return v == null ? '' : String(v);
  }
  function lineVal(w, sid, id, line) {
    var r = loadedRec(w), v = null;
    if (r && !machine(w, sid)) return recLine(r, sid, { id: id, type: '' }, line - 1, w).v;
    try { v = w.nlapiGetLineItemValue(sid, id, line); } catch (e) {}
    return v == null ? '' : String(v);
  }
  /* Page text of a read-only field. NetSuite shows an empty field as "-No value" (with a dash). */
  function pageText(el) {
    var s = ((el.querySelector('.uir-field, .inputreadonly') || {}).textContent || '').trim();
    return /^[\u2013\u2014-]?\s*No value$/i.test(s) ? '' : s;
  }

  /* ---------- data collection ---------- */
  function sublistIds(w) {
    var ids = [], r = loadedRec(w);
    function add(s) { if (validId(s) && ids.indexOf(s) < 0) ids.push(s); }
    if (r) { try { r.getSublists().forEach(add); } catch (e) {} }
    Array.prototype.forEach.call(w.document.querySelectorAll('[data-nsps-type="sublist"][data-nsps-id]'), function (e) { add(e.getAttribute('data-nsps-id')); });
    return ids;
  }
  function machine(w, sid) {
    var m = null;
    try { m = w.getMachineByName && w.getMachineByName(sid); } catch (e) {}
    return m && m.countFormElements ? m : null;
  }
  function sublistCols(w, sid) { return memo('cols|' + sid, function () { return readSublistCols(w, sid); }); }
  function readSublistCols(w, sid) {
    var m = machine(w, sid);
    if (!m) { var r = loadedRec(w); return r ? recCols(w, r, sid) : null; }
    var items = [], labels = newMap(), cols = [], n = m.countFormElements(), i;
    for (i = 1; i <= n; i++) {
      var nm = m.getFormElementName(i);
      if (!nm) continue;
      items.push({ name: nm, label: m.getFormElementLabel(i) || '', type: m.getFormElementType(i) || '' });
    }
    items.forEach(function (it) { if (/_display$/.test(it.name)) labels[it.name.replace(/_display$/, '')] = it.label; });
    items.forEach(function (it) {
      if (/_display$/.test(it.name)) return;
      cols.push({ id: it.name, label: it.label || (has(labels, it.name) && labels[it.name]) || '', type: it.type, hasDisplay: has(labels, it.name) });
    });
    /* The machine reports some columns without a label, and some selects as "integer" (item, on a
     * vendor bill). The line-entry field for the column, inside #<sublist>_layer, has both. */
    var layer = w.document.getElementById(sid + '_layer');
    if (layer) cols.forEach(function (c) {
      if (!validId(c.id) || (c.label && /select/.test(c.type))) return;
      var el = layer.querySelector('[data-nsps-type="field"][data-field-context="sublist"][data-field-name="' + c.id + '"]');
      if (!el) return;
      if (!c.label) c.label = el.getAttribute('data-nsps-label') || '';
      var t = el.getAttribute('data-field-type') || '';
      if (/select/.test(t) && !/select/.test(c.type)) c.type = t;
    });
    return cols;
  }
  /* Columns of a sublist with the values of its first `cap` lines. Each call returns new column objects:
   * the ones from sublistCols are cached and shared, so a 500-line export must not write its values
   * onto the 50-line table's columns. */
  function sublistData(w, sid, cap) {
    cap = cap || LINE_CAP;
    return memo('data|' + sid + '|' + cap, function () { return readSublistData(w, sid, cap); });
  }
  function readSublistData(w, sid, cap) {
    var cols = sublistCols(w, sid);
    if (!cols) return null;
    var r = cols.fromRecord ? loadedRec(w) : null, count = -1;
    if (r) { try { count = r.getLineCount({ sublistId: sid }); } catch (e) {} }
    else { try { count = w.nlapiGetLineItemCount(sid); } catch (e) {} }
    if (count < 0) return null;
    var shown = Math.min(count, cap);
    var out = cols.map(function (c) {
      var vals = [];
      for (var ln = 1; ln <= shown; ln++) {
        if (r) { vals.push(recLine(r, sid, c, ln - 1, w)); continue; }
        var v = '', t = '';
        try { v = w.nlapiGetLineItemValue(sid, c.id, ln); } catch (e) {}
        if (c.hasDisplay || /select/.test(c.type)) { try { t = w.nlapiGetLineItemText(sid, c.id, ln); } catch (e2) {} }
        vals.push({ v: v == null ? '' : String(v), t: t == null ? '' : String(t) });
      }
      return { id: c.id, label: c.label, type: c.type, hasDisplay: c.hasDisplay, vals: vals };
    });
    return { id: sid, count: count, shown: shown, cols: out };
  }
  /* needRec: also build the Not on form list (only for that tab and for search). */
  var CUSTOM_ID = /^(custbody|custentity|custrecord|custevent|custitem|custcol|custpage|cseg)/i;
  var SYSTEM_DATES = /^(createddate|lastmodifieddate)$/;
  /* The record type the title bar shows (nlapiGetRecordType) is also a hidden input, baserecordtype. NetSuite
   * gives it no label, so without this it would pass for plumbing and never be listed. The other type inputs
   * on a real bill (type=vendbill, dbstrantype=VendBill, ntype=17) stay out. */
  var REC_TYPE_ID = 'baserecordtype', REC_TYPE_LABEL = 'Record Type';
  /* Every field ID the loaded record has (cached). */
  function recFieldSet(r) {
    if (!REC.fieldSet) { REC.fieldSet = newMap(); try { (r.getFields() || []).forEach(function (f) { REC.fieldSet[f] = 1; }); } catch (e) {} }
    return REC.fieldSet;
  }
  /* Body fields (and, with needRec, the Not on form list). The body part doesn't depend on needRec, so
   * within one render a needRec result also answers a plain call. */
  function collectBody(w, needRec) {
    if (MEMO && !needRec && has(MEMO, 'body|1')) return MEMO['body|1'];
    return memo('body|' + (needRec ? 1 : 0), function () { return readBody(w, needRec); });
  }
  function readBody(w, needRec) {
    var d = w.document, body = [], seen = newMap(), r = loadedRec(w), want = [];
    /* Fields with data-field-context="sublist" are line-entry fields of a sublist (on the Sublists tab) or
     * filter controls on subtabs (contact, searchid, Activity_STATUS...), which are not record fields.
     * Neither belongs in Body. */
    var els = Array.prototype.filter.call(d.querySelectorAll('[data-nsps-type="field"][data-field-name]'), function (el) {
      return el.getAttribute('data-field-context') !== 'sublist';
    });
    els.forEach(function (el) {
      var id = el.getAttribute('data-field-name'), sub = false;
      if (!validId(id) || has(seen, id)) return;
      seen[id] = 1;
      var type = el.getAttribute('data-field-type') || '', val = null, txt = '';
      try { val = w.nlapiGetFieldValue(id); } catch (e) {}
      try { if (/select/.test(type)) txt = w.nlapiGetFieldText(id); } catch (e2) {}
      if (r && !sub && (val == null || (!txt && /select/.test(type)))) {
        /* View mode: no live value, or (for a few fields such as subsidiary) a live ID without its text.
         * The value comes from the record; the name and date text come from what the page shows, which is
         * free (record.getText would block on the server). Multi-select names are fetched in the
         * background, because the page lists them with commas rather than as separate values. */
        var shown = pageText(el), rv = /^date/.test(type) && shown ? shown : recValue(r, id);
        if (val == null && rv != null) {
          val = /^date/.test(type) && shown ? shown : rv;
          if (type === 'multiselect') { var nm = recName(id); txt = nm != null ? nm : shown; if (nm == null && rv) want.push(id); }
          else if (/select/.test(type)) txt = shown;
        } else if (rv != null && rv === String(val) && /select/.test(type)) txt = shown;
      }
      if (val == null) {
        /* Spelled window.CSS so no local name can hide it (until 2026-11-06 the stylesheet text was a local
         * named CSS, and this escape never ran). */
        var inp = el.querySelector('[name="' + (window.CSS && window.CSS.escape ? window.CSS.escape(id) : id) + '"]');
        val = inp ? inp.value : pageText(el);
      }
      body.push({
        id: id, label: el.getAttribute('data-nsps-label') || '', type: type,
        required: el.getAttribute('data-required') === 'true', mode: el.getAttribute('data-mode') || '',
        value: String(val), text: txt == null ? '' : String(txt), custom: CUSTOM_ID.test(id)
      });
    });
    /* Fields the form sets to display type Hidden are only hidden inputs on the page, mixed in with the
     * page's own plumbing. On a real vendor bill both kinds are in record.getFields() and N/currentRecord
     * gives no labels for either, so a hidden input joins Body (marked hidden) only when it is:
     *  - a custom field (CUSTOM_ID: custbody..., custrecord..., custpage..., cseg...; not customsublist...), or
     *  - a field the loaded saved record gives a label (Amount, Currency, Approval Status, External ID...),
     *    or one of the unlabelled system dates (createddate, lastmodifieddate).
     * The rest (nluser, nlrole, nsbrowserenv, ...loaded) is left out. Every loose input still counts as on
     * the page, so it is never listed under Not on form. In edit mode the saved record is only loaded for
     * Not on form, so until then standard hidden fields can't be told from plumbing and are left out. */
    /* nlapi..., nluser and nsbrowserenv are NetSuite page/session plumbing, never record data, so they are
     * skipped even when a loaded record reports them (as _csrf, _eml_nkey_ and the other _ names are). */
    var skip = /^(_|nsapi|nlapi|nluser$|nsbrowserenv$|wf|inpt_|hddn_|refreshmessages|dadSave|selectedtab|whence|customwhence|entryformquerystring|oldapprovalstatus|submitter)|_formattedValue$|_display$/i;
    var fields = r ? recFieldSet(r) : null;
    Array.prototype.forEach.call(d.querySelectorAll('input[name],select[name],textarea[name]'), function (i) {
      var n = i.name;
      if (!validId(n) || has(seen, n)) return;
      if (i.closest && i.closest('[data-nsps-type="field"], [data-nsps-type="sublist"], table[data-sublist-id], .uir-machine-table-container')) return;
      seen[n] = 1;
      if (skip.test(n)) return;
      var meta0 = r && has(fields, n) ? recMeta(r, n) : null, isType = n === REC_TYPE_ID;
      if (!isType && !CUSTOM_ID.test(n) && !(meta0 && (meta0.label || SYSTEM_DATES.test(n)))) return;
      var m = r ? recMeta(r, n) : null, ft = (m && m.type) || (isType ? 'text' : ''), type = ft ? ft + ', hidden' : 'hidden', nm = null;
      if (m && /select/.test(m.type)) { nm = recName(n); if (nm == null && i.value) want.push(n); }
      body.push({ id: n, label: (m && m.label) || (isType ? REC_TYPE_LABEL : ''), type: type, hidden: true, required: false, mode: '', value: String(i.value), text: nm || '', custom: CUSTOM_ID.test(n) });
    });
    /* Not on form: fields the saved record has that the form doesn't show (NetSuite plumbing skipped).
     * Select names arrive in the background (requestNames); until then the internal ID is shown. */
    var rec = [];
    if (r && needRec) {
      if (!REC.base) {
        var all = [];
        try { all = r.getFields() || []; } catch (e) {}
        REC.base = all.filter(function (id) { return validId(id) && !skip.test(id); });
      }
      REC.base.forEach(function (id) {
        if (has(seen, id)) return;
        var m = recMeta(r, id) || { label: '', type: '' }, v = recValue(r, id);
        if (v == null) return;
        var nm = /select/.test(m.type) ? recName(id) : null;
        if (/select/.test(m.type) && nm == null && v !== '') want.push(id);
        /* No label and not custom: most likely a NetSuite internal (sys_id, haslines, templatestored...).
         * Still listed, with a green field ID instead of blue so the real fields stand out. */
        var label = m.label || (id === REC_TYPE_ID ? REC_TYPE_LABEL : '');
        var internal = !label && !CUSTOM_ID.test(id) && !SYSTEM_DATES.test(id);
        rec.push({ id: id, label: label, type: m.type, required: false, mode: '', value: v, text: nm || '', custom: CUSTOM_ID.test(id), internal: internal });
      });
    }
    if (want.length) requestNames(want);
    /* Mark values whose name is still on its way, for the spinner. */
    var wanted = newMap();
    want.forEach(function (id) { wanted[id] = 1; });
    body.concat(rec).forEach(function (f) { if (has(wanted, f.id)) f.pending = namePending(f.id); });
    return { body: body, rec: rec };
  }

  /* ---------- exports ---------- */
  function csvCell(s) {
    s = String(s == null ? '' : s);
    /* A leading ' stops Excel and Sheets from running a value such as =HYPERLINK(...) as a formula.
     * Plain numbers (e.g. a -5 amount) are left alone so they stay numeric. */
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n'); }
  /* View Raw CSV on the Sublists tab: the sublist as a table of its own (tidy data, like a saved search with
   * Main Line false): a header of "line_number" (not "line", which is a NetSuite field ID) and the field IDs, then one row per line, every line read (d is
   * sublistData(w, sid, 500)), in line order. The filters pick the columns, in page order; sorting does not
   * apply. A cell holds what the table shows: the name for a select, else the value. */
  function sublistCsvRows(d, keep) {
    var cols = d.cols.filter(function (c) { return validId(c.id) && keep(c, lineText(c)); }), rows = [['line_number'].concat(cols.map(function (c) { return c.id; }))];
    for (var i = 0; i < d.shown; i++) rows.push([String(i + 1)].concat(cols.map(function (c) { var x = c.vals[i]; return disp(x.t || x.v); })));
    return rows;
  }
  /* What a sublist CSV holds, for the footer and the toasts: "item, all 120 lines", "item, first 500 of 812 lines". */
  function sublistScope(d) {
    return d.id + ', ' + (d.count > d.shown ? 'first ' + d.shown + ' of ' + d.count + ' lines' : !d.count ? 'no lines' : d.count === 1 ? '1 line' : 'all ' + d.count + ' lines');
  }
  /* XML-safe text: multi-select separators (\u0005) become MULTI_SEP; other characters XML 1.0 forbids are dropped. */
  function ea(s) {
    return esc(disp(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ''));
  }
  function allSublists(w) {
    var out = [];
    sublistIds(w).forEach(function (sid) { var d = sublistData(w, sid, 500); if (d && d.count > 0) out.push(d); });
    return out;
  }
  /* The search box, Hide empty and the Fields filter (all / custom / standard), as one test used by the tables and the exports. */
  function makeKeep() {
    var q = S.q.toLowerCase();
    return function (f, vals) {
      if (S.kind !== 'all' && CUSTOM_ID.test(f.id) !== (S.kind === 'custom')) return false;
      if (S.hideEmpty && !vals.some(function (v) { return v !== ''; })) return false;
      if (!q) return true;
      return (f.id + ' ' + f.label + ' ' + vals.join(' ')).toLowerCase().indexOf(q) >= 0;
    };
  }
  /* '' when no filter is on, else for example: search "notes", Custom only */
  function filterNote() {
    var p = [];
    if (S.q) p.push('search "' + S.q + '"');
    if (S.hideEmpty) p.push('Hide empty');
    if (S.kind === 'custom') p.push('Custom only');
    if (S.kind === 'standard') p.push('Standard only');
    return p.join(', ');
  }
  /* What JSON and XML export: record data only, meaning body fields that pass the filters, and per sublist
   * the fields (columns) that pass, for all lines (a sublist with no passing field is left out). Other
   * inputs are left out: on a real record they were about 90 of 120 entries, all page plumbing
   * (...loaded, ...dotted, nluser, sortcol...). Their own tab still lists them, with CSV. */
  function exportParts(w) {
    var keep = makeKeep(), b = collectBody(w);
    return {
      fields: b.body.filter(function (f) { return keep(f, [f.value, f.text]); }),
      subs: allSublists(w).map(function (s) { return { s: s, cols: s.cols.filter(function (c) { return keep(c, lineText(c)); }) }; })
        .filter(function (x) { return x.cols.length; })
    };
  }
  /* The object the JSON export writes (render turns it into the text); the View Raw tree (treeHtml) shows this same object. */
  function jsonData(w) {
    var p = exportParts(w), o = { record: meta(w), exportedAt: new Date().toISOString() }, note = filterNote();
    if (note) o.filters = { search: S.q, hideEmpty: S.hideEmpty, kind: S.kind };
    o.body = newMap(); o.sublists = newMap();
    p.fields.forEach(function (f) { o.body[f.id] = { label: f.label, type: f.type, value: disp(f.value), text: disp(f.text) }; });
    p.subs.forEach(function (x) {
      var s = x.s, lines = [];
      for (var i = 0; i < s.shown; i++) {
        var line = newMap();
        x.cols.forEach(function (c) {
          var v = disp(c.vals[i].v), t = disp(c.vals[i].t);
          if (v !== '' || t !== '') line[c.id] = t && t !== v ? { value: v, text: t } : v;
        });
        lines.push(line);
      }
      o.sublists[s.id] = lines;
    });
    return o;
  }
  function buildXml(w) {
    var m = meta(w), p = exportParts(w), note = filterNote();
    var x = ['<?xml version="1.0" encoding="UTF-8"?>'];
    /* A comment may not contain "--". */
    if (note) x.push('<!-- Filtered: ' + ea(note).replace(/-{2,}/g, '- -') + ' -->');
    x.push('<record type="' + ea(m.type) + '" id="' + ea(m.id) + '" tranid="' + ea(m.tranid) + '">', '  <fields>');
    p.fields.forEach(function (f) {
      x.push('    <field id="' + ea(f.id) + '" label="' + ea(f.label) + '" type="' + ea(f.type) + '"' + (f.text && f.text !== f.value ? ' text="' + ea(f.text) + '"' : '') + '>' + ea(f.value) + '</field>');
    });
    x.push('  </fields>', '  <sublists>');
    p.subs.forEach(function (xs) {
      var s = xs.s;
      s = { id: s.id, count: s.count, shown: s.shown, cols: xs.cols };
      x.push('    <sublist id="' + ea(s.id) + '" count="' + s.count + '">');
      for (var i = 0; i < s.shown; i++) {
        x.push('      <line num="' + (i + 1) + '">');
        s.cols.forEach(function (c) {
          var v = c.vals[i];
          if (v.v !== '' || v.t !== '') x.push('        <field id="' + ea(c.id) + '" label="' + ea(c.label) + '"' + (v.t && v.t !== v.v ? ' text="' + ea(v.t) + '"' : '') + '>' + ea(v.v) + '</field>');
        });
        x.push('      </line>');
      }
      x.push('    </sublist>');
    });
    x.push('  </sublists>', '</record>');
    return x.join('\n');
  }
  function snippet(id, sid, line) {
    /* Never wrap an unexpected ID in code; fall back to the plain text. */
    if (S.fmt === 'id' || !validId(id) || (sid && !validId(sid))) return id;
    if (S.fmt === 'ss1') return sid ? "nlapiGetLineItemValue('" + sid + "', '" + id + "', " + (line || 1) + ")" : "nlapiGetFieldValue('" + id + "')";
    return sid ? "rec.getSublistValue({ sublistId: '" + sid + "', fieldId: '" + id + "', line: " + ((line || 1) - 1) + " })" : "rec.getValue({ fieldId: '" + id + "' })";
  }

  /* ---------- panel ---------- */
  var host = document.createElement('div');
  host.id = HOST_ID;
  /* Set first, so the toggle check at the top recognises this panel even if a later step failed. */
  host.__nsfeCleanup = function () {
    closed = true;
    detachInspect(); document.removeEventListener('keydown', onKey, true);
    cleanupFns.forEach(function (f) { f(); });
  };
  host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483646;';
  var root = host.attachShadow({ mode: 'open' });
  /* The Syincuso mark (brand kit, logos/syincuso-mark-on-*.svg). Its colours come from --logo and --logoc, so it is black on the
   * light title bar and white on the dark one. */
  var LOGO_SVG = '<svg class="logo" viewBox="57.6 48.7 110 110" aria-hidden="true">' +
    '<path class="m" fill="#0b0b0b" d="M108.04468,85.492441h8.30223a2.6458333,2.6458333 135 0 0 2.64583,-2.645833v-2.565356a2.6458333,2.6458333 45 0 0 -2.64583,-2.645833h-8.30223a2.6458333,2.6458333 135 0 0 -2.64583,2.645833l0,2.565356a2.6458333,2.6458333 45 0 0 2.64583,2.645833zM83.28949,50.777262c-11.402066,-0.28799 -20.878718,8.72177 -21.166667,20.123837v34.862991a2.6458333,2.6458333 45 0 0 2.645833,2.64583h8.426877a2.6458333,2.6458333 135 0 0 2.645833,-2.64583v-8.735904a1.7414882,1.7414882 146.64708 0 1 2.430163,-1.599533l12.546224,5.401737a24.118799,24.118799 56.647077 0 1 14.580977,22.1528v13.28705c-1.6e-4,8.11702 -6.580267,14.69713 -14.69729,14.69729h-0.162264c-8.117226,1.3e-4 -14.697649,-6.58006 -14.69781,-14.69729v-8.59742a2.6458333,2.6458333 45 0 0 -2.645833,-2.64583h-8.426877a2.6458333,2.6458333 135 0 0 -2.645833,2.64583l0,7.74682c-2e-6,11.69003 9.476638,21.16667 21.166667,21.16667h14.53658c11.69003,0 21.16667,-9.47664 21.16667,-21.16667V94.997819a2.6458333,2.6458333 45 0 0 -2.64583,-2.645833h-8.30235a2.6458333,2.6458333 135 0 0 -2.64583,2.645833v2.814818a1.7497651,1.7497651 146.5222 0 1 -2.4347,1.610137L90.44957,94.099253A24.00471,24.00471 56.522198 0 1 75.841366,72.010075V71.1724c1.31e-4,-8.206854 6.65322,-14.859712 14.860074,-14.859558 7.188522,-0.0267 13.18645,5.131078 14.45162,11.957437 0.26593,1.434848 1.43025,2.63082 2.8915,2.63082h8.30235c1.46125,0 2.63351,-1.190308 2.41226,-2.633722 -1.5518,-10.123624 -10.42475,-17.755534 -20.9331,-17.490115zM140.22912,108.40985h6.94806a15.875,15.875 45 0 1 15.875,15.875v0.18707a15.875,15.875 135 0 1 -15.875,15.875h-6.94806a15.875,15.875 45 0 1 -15.875,-15.875v-0.18707a15.875,15.875 135 0 1 15.875,-15.875z"/>' +
    '<path class="c" fill="#b22222" d="M143.34889,112.04282h0.52806a7.9374998,7.9374998 45 0 1 7.9375,7.9375v8.78583a7.9374998,7.9374998 135 0 1 -7.9375,7.9375h-0.52806a7.9374998,7.9374998 45 0 1 -7.9375,-7.9375v-8.78583a7.9374998,7.9374998 135 0 1 7.9375,-7.9375z"/></svg>';
  /* Stroke icons for the title bar and toolbar (inline SVG: no files, and presentation attributes pass the CSP). */
  function svgIcon(d, cls) { return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var ICON = {
    gear: svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    help: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14"/><path d="M12 17h.01"/>'),
    refresh: svgIcon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    min: svgIcon('<path d="M6 12h12"/>'),
    max: svgIcon('<path d="M6 12h12M12 6v12"/>'),
    close: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
    search: svgIcon('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', 'qi'),
    filter: svgIcon('<path d="M4 6h16M7 12h10M10 18h4"/>'),
    inspect: svgIcon('<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
    pin: svgIcon('<path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v7"/>'),
    code: svgIcon('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>')
  };
  /* Links back to Syincuso, the maker (title bar mark, footer wordmark, Help > About). utm_content says which one
   * was clicked, so the site's visit statistics show which bring people. They open only when clicked: the
   * extension itself sends nothing anywhere. */
  function brandUrl(where, hash) { return 'https://syincuso.com/?utm_source=nsn-field-explorer&utm_medium=extension&utm_content=' + where + (hash || ''); }
  var BRAND_TIP = 'Made by Syincuso. Opens syincuso.com in a new tab.';
  function brandLink(cls, where, inner) {
    return '<a class="' + cls + '" href="' + brandUrl(where) + '" target="_blank" rel="noopener noreferrer" title="' + BRAND_TIP + '" aria-label="Syincuso website (new tab)">' + inner + '</a>';
  }
  /* Styles are applied through the CSSOM (constructable stylesheet) because NetSuite's CSP blocks inline <style> tags. */
  var PANEL_CSS =
    ':host{all:initial}*{box-sizing:border-box}' +
    /* Colours and fonts follow the Syincuso brand kit. --acc is firebrick for fills, bars and focus; --acct is the
     * accent for text (field IDs, active tab, links): oxblood on light, muted gold on dark, since thin firebrick
     * text is too faint on black. --bdc is the stronger border for controls; --err is for required, removed and clear. */
    '.p{--bg:#fff;--fg:#0b0b0b;--mut:#5c5c5c;--bd:#e6e4df;--bdc:#b8b8b8;--acc:#b22222;--acch:#9a1d1d;--acct:#801818;--ring:#b22222;--err:#b22222;--chg:#7d6315;--int:#1a7f37;--cp:#8250df;--hd:#f5f3ee;--hi:#f4ecd2;--mk:#c9a227;--mkb:#f4ecd2;--hbg:#fff;--hfg:#0b0b0b;--hmut:#5c5c5c;--hhov:#e6e4df;--hbar:#c9a227;--logo:#0b0b0b;--logoc:#b22222;--zb:#faf9f6;--sbt:#c9c6bf;--sbh:#b22222;--sba:#801818;--ld:#b22222;container-type:inline-size;font:12px/1.35 "Open Sans",system-ui,"Segoe UI",Arial,sans-serif;color:var(--fg);background:var(--bg);border:1px solid var(--bd);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.28);width:600px;height:72vh;min-width:380px;min-height:220px;max-width:96vw;max-height:96vh;display:flex;flex-direction:column;position:relative;overflow:hidden}' +
    /* Resize handles on every edge and corner (see resize() below). */
    '.rz{position:absolute;z-index:3}.rz[data-rz=n],.rz[data-rz=s]{left:10px;right:10px;height:6px;cursor:ns-resize}.rz[data-rz=n]{top:0}.rz[data-rz=s]{bottom:0}' +
    '.rz[data-rz=e],.rz[data-rz=w]{top:10px;bottom:10px;width:6px;cursor:ew-resize}.rz[data-rz=e]{right:0}.rz[data-rz=w]{left:0}' +
    '.rz[data-rz=ne],.rz[data-rz=nw],.rz[data-rz=se],.rz[data-rz=sw]{width:12px;height:12px}' +
    '.rz[data-rz=nw]{top:0;left:0;cursor:nwse-resize}.rz[data-rz=se]{bottom:0;right:0;cursor:nwse-resize}.rz[data-rz=ne]{top:0;right:0;cursor:nesw-resize}.rz[data-rz=sw]{bottom:0;left:0;cursor:nesw-resize}' +
    /* Dark colours follow the system unless the Display setting (Help page) picks Light or Dark. */
    '@media(prefers-color-scheme:dark){.p:not(.light){--zb:#232323;--ld:#c9a227;--sbt:#4a4a4a;--sbh:#c9a227;--sba:#a6841c;--bg:#1c1c1c;--fg:#f5f3ee;--mut:#b8b8b8;--bd:#333;--bdc:#5c5c5c;--acc:#b22222;--acch:#9a1d1d;--acct:#c9a227;--ring:#c9a227;--err:#ff6b6b;--chg:#c9a227;--int:#3fb950;--cp:#bc8cff;--hd:#0b0b0b;--hi:#3a3016;--mkb:#b22222;--mkf:#fff;--mk:#e04646;--hbg:#0b0b0b;--hfg:#fff;--hmut:#b8b8b8;--hhov:#333;--hbar:#b22222;--logo:#fff;--logoc:#c9a227}}.p.dark{--zb:#232323;--ld:#c9a227;--sbt:#4a4a4a;--sbh:#c9a227;--sba:#a6841c;--bg:#1c1c1c;--fg:#f5f3ee;--mut:#b8b8b8;--bd:#333;--bdc:#5c5c5c;--acc:#b22222;--acch:#9a1d1d;--acct:#c9a227;--ring:#c9a227;--err:#ff6b6b;--chg:#c9a227;--int:#3fb950;--cp:#bc8cff;--hd:#0b0b0b;--hi:#3a3016;--mkb:#b22222;--mkf:#fff;--mk:#e04646;--hbg:#0b0b0b;--hfg:#fff;--hmut:#b8b8b8;--hhov:#333;--hbar:#b22222;--logo:#fff;--logoc:#c9a227}' +
    /* Compact: smaller text and tighter rows. */
    '.p.compact{font-size:11px}.p.compact td{padding:1px 5px}.p.compact th{padding:2px 5px}.p.compact td.id{font-size:10px}' +
    '.p.compact .tbar{padding:4px 8px;gap:6px}.p.compact .seg button,.p.compact .subtabs button{padding:2px 8px}.p.compact .tb{width:26px;height:26px}.p.compact .qbox input[type=search]{padding-top:3px;padding-bottom:3px}.p.compact select{padding:1px 6px}' +
    /* Small menus under their buttons: Settings (.menu, gear in the title bar), Filters (.fpop) and Pin (.ppop).
     * setPop() places the open one under its button. */
    '.pop{position:absolute;top:38px;right:8px;z-index:4;display:flex;flex-direction:column;align-items:flex-start;gap:9px;padding:12px;min-width:220px;max-width:calc(100% - 16px);background:var(--bg);border:1px solid var(--bd);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.22)}' +
    '.pop b{font:600 12px Poppins,"Open Sans",system-ui,"Segoe UI",Arial,sans-serif}.pop label{color:var(--fg)}.pop .row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;width:100%}' +
    '.pop .hint{margin:0;color:var(--mut);white-space:normal;max-width:260px}' +
    'button.pri{background:var(--acc);border-color:var(--acc);color:#fff}button.pri:hover{background:var(--acch);border-color:var(--acch)}' +
    /* Title bar: on light, white with the black Syincuso mark (firebrick "o") and a gold bar under it; on dark, rich black with the
     * white mark (gold "o") and a firebrick bar, as the brand kit pairs them. */
    '.h{display:flex;align-items:center;gap:8px;padding:5px 6px 5px 9px;background:var(--hbg);color:var(--hfg);border-bottom:3px solid var(--hbar);cursor:move;user-select:none}' +
    '.brand{display:flex;flex:none;border-radius:4px}.brand:focus-visible{outline:2px solid var(--ring);outline-offset:2px}' +
    '.logo{width:18px;height:18px;flex:none;display:block}.logo .m{fill:var(--logo)}.logo .c{fill:var(--logoc)}' +
    '.h b{font:600 13px/1.2 Poppins,"Open Sans",system-ui,"Segoe UI",Arial,sans-serif;white-space:nowrap}.meta{color:var(--hmut);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    /* The record type, #ID and document number in the title bar copy their value on a click (setMeta). They look like the
     * muted text they replace; each part gets its own ellipsis (the ID never shrinks), and .meta is padded so the focus
     * ring is not clipped. */
    '.meta{display:flex;align-items:center;gap:4px;min-width:0;padding:3px;margin-left:-3px}.meta>*{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.meta button{border:0;background:transparent;color:inherit;font-weight:400;padding:0 3px;border-radius:4px}.meta button.mc-id{flex:none}' +
    '.meta button:hover{background:var(--hhov);color:var(--hfg)}.meta button:focus-visible{outline:2px solid var(--ring);outline-offset:0}' +
    /* The toolbar: section switch, search, then Filters / Inspect / Pin / View Raw as icon buttons. It wraps to
     * two rows on a narrow panel (switch above, search and icons below). */
    '.tbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-bottom:1px solid var(--bd)}' +
    '.seg{display:inline-flex;flex:none;max-width:100%;overflow-x:auto;background:var(--hd);border:1px solid var(--bd);border-radius:10px;padding:2px;gap:2px}' +
    '.seg button{border:0;background:transparent;border-radius:8px;padding:3px 10px;color:var(--mut);white-space:nowrap}.seg button:hover{color:var(--fg)}' +
    '.seg button.on,.seg button.on:hover{background:var(--bg);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.14)}' +
    '.tools{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto}' +
    '.tb{position:relative;border:0;background:transparent;color:var(--mut);border-radius:8px;width:30px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center}' +
    '.tb:hover{background:var(--hd);color:var(--fg)}.tb.on,.tb.on:hover{background:var(--acc);color:#fff}.tb.pinned{color:var(--acct)}.tb svg,.ic svg{width:16px;height:16px;display:block}' +
    '.dot{position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;background:var(--acc);border:1.5px solid var(--bg)}' +
    '.istrip{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--hi);border-bottom:1px solid var(--bd)}.istrip svg{width:15px;height:15px;flex:none}.istrip span{flex:1;min-width:0}' +
    'button,select,input[type=search]{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--bdc);border-radius:9px;padding:3px 9px}button{font-weight:600}' +
    'button{cursor:pointer}button:hover{border-color:var(--acc)}button.on{background:var(--acc);color:#fff;border-color:var(--acc)}button.on:hover{background:var(--acch);border-color:var(--acch)}' +
    'button:focus-visible{outline:2px solid var(--ring);outline-offset:1px}' +
    /* Keyboard focus: the --ring outline on everything that can take focus. Inside the scrolling section switch,
     * the sublist row and table cells it is drawn inwards, where nothing clips it. */
    'a:focus-visible,input[type=checkbox]:focus-visible,.pop:focus-visible{outline:2px solid var(--ring);outline-offset:1px}' +
    '.seg button:focus-visible,.subtabs button:focus-visible,td:focus-visible,th:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}' +
    '.stl{display:contents}td{scroll-margin-top:30px}' +
    'input[type=search]{flex:1;min-width:0;padding:5px 26px 5px 30px;background:var(--hd);border-color:transparent;border-radius:10px}input[type=search]:focus{background:var(--bg);border-color:var(--acc)}input[type=search]:focus,select:focus-visible{outline:2px solid var(--ring);outline-offset:-1px}' +
    /* The search box's own red clear button (.qx), in place of the browser's grey one, which Chrome and Firefox
     * style differently and can't be coloured reliably. */
    '.qbox{position:relative;display:flex;flex:1 1 120px;min-width:0}.qbox .qi{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--mut);pointer-events:none}' +
    'input[type=search]::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;display:none}' +
    '.qx{position:absolute;top:50%;right:3px;transform:translateY(-50%);border:0;background:transparent;color:var(--err);font-size:17px;font-weight:700;line-height:1;padding:0 4px;border-radius:4px}' +
    '.qx:hover{background:rgba(178,34,34,.12);color:var(--err)}' +
    'label{display:flex;align-items:center;gap:4px;color:var(--mut);white-space:nowrap}label input{margin:0}' +
    /* Title-bar icon buttons, underlined tabs with match-count badges, and the grouped Copy buttons. */
    '.ic{border:0;background:transparent;color:var(--hmut);padding:0;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:7px}.ic:hover{background:var(--hhov);color:var(--hfg)}' +
    /* Match counts in the section switch, and the sublist picker: the switch's pill and selected style
     * without its track, so it reads as the second level. It wraps instead of scrolling; empty sublists fold
     * into one "+N empty" button. */
    '.n{display:inline-block;margin-left:4px;font-size:11px;color:var(--mut);font-weight:600}.n:empty{display:none}.tabs button.zero:not(.on){opacity:.5}' +
    '.subtabs{display:flex;flex-wrap:wrap;gap:4px;padding:6px 10px;border-bottom:1px solid var(--bd)}' +
    '.subtabs button{border:0;background:transparent;border-radius:8px;padding:3px 10px;color:var(--mut);white-space:nowrap}.subtabs button:hover{background:var(--hd);color:var(--fg)}' +
    '.subtabs button.on,.subtabs button.on:hover{background:var(--bg);color:var(--fg);box-shadow:0 0 0 1px var(--bd),0 1px 2px rgba(0,0,0,.14)}' +
    '.subtabs .n{margin-left:5px}.subtabs button.zero:not(.on){opacity:.5}.subtabs .more{color:var(--acct)}' +
    '.grp{display:inline-flex;align-items:center}.grp .mut{margin-right:6px}.grp button{border-radius:0;margin-left:-1px}' +
    '.grp button:first-of-type{border-radius:9px 0 0 9px;margin-left:0}.grp button:last-of-type{border-radius:0 9px 9px 0}.grp button:hover{position:relative}' +
    'td.sec{color:var(--mut);white-space:nowrap}tr.int td.id{color:var(--int)}td.id.cp{color:var(--cp)}' +
    /* Export preview (View button): a format switch, Copy and Close above the text. */
    /* Help page (? button). */
    '.help{padding:2px 14px 12px;line-height:1.5}.help h3{margin:12px 0 3px;font:600 12px Poppins,"Open Sans",system-ui,"Segoe UI",Arial,sans-serif}.help ul{margin:0;padding-left:18px}.help li{margin:1px 0}' +
    '.help code,.help kbd{font:11px ui-monospace,Consolas,monospace;background:var(--hd);border:1px solid var(--bd);border-radius:3px;padding:0 3px}' +
    '.help .ex-id{font:11px ui-monospace,Consolas,monospace;color:var(--acct)}.help .ex-int{font:11px ui-monospace,Consolas,monospace;color:var(--int)}.help .ex-cp{font:11px ui-monospace,Consolas,monospace;color:var(--cp);font-weight:600}.help .ex-chg{color:var(--chg)}' +
    '.ic.on,.ic.on:hover{background:var(--acc);color:#fff}' +
    '.pvask{margin:0;padding:6px 10px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:var(--hi);border-bottom:1px solid var(--bd);white-space:normal}' +
    '.pvnote{margin:0;padding:6px 10px;color:var(--mut);border-bottom:1px solid var(--bd);white-space:normal}.pvnote b{color:var(--fg)}' +
    '.pvnote .lk{border:0;background:none;padding:0;border-radius:2px;font-weight:600;color:var(--acct);text-decoration:underline;cursor:pointer}.pvnote .lk:hover{color:var(--acc)}' +
    '.pvbar button{white-space:nowrap}.pvbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:1;background:var(--bg)}' +
    '.code{margin:0;padding:8px 10px;font:11px/1.45 ui-monospace,Consolas,monospace;white-space:pre;color:var(--fg);user-select:text;cursor:text}' +
    /* View Raw JSON as a tree (treeHtml): keys in the accent colour, line numbers and sizes muted, strings green,
     * numbers purple, true / false gold, null muted italic. The triangle turns when an item opens. Focus rings the
     * item's own row, not its children. */
    '.jt,.jt ul{list-style:none;margin:0;padding:0}.jt{padding:6px 6px 12px;font:11px/1.6 ui-monospace,Consolas,monospace;color:var(--fg)}.jt ul{padding-left:16px}' +
    '.jt li{outline:none}.jr{white-space:nowrap;padding:0 8px 0 2px;border-radius:4px;cursor:copy;scroll-margin-top:40px}.jt li[aria-expanded]>.jr{cursor:pointer}.jr:hover{background:var(--hi)}' +
    '.jt li:focus-visible>.jr{outline:2px solid var(--ring);outline-offset:-2px}' +
    '.tw{display:inline-block;width:14px;color:var(--mut);text-align:center}.jt li[aria-expanded]>.jr .tw::before{content:"\\25B8";display:inline-block}' +
    '.jt li[aria-expanded=true]>.jr .tw::before{transform:rotate(90deg)}' +
    '.jk{color:var(--acct)}.ji{color:var(--mut)}.jp{color:var(--mut)}.jc{color:var(--mut)}' +
    '.j-str{color:var(--int)}.j-num{color:var(--cp)}.j-bool{color:var(--chg)}.j-null{color:var(--mut);font-style:italic}' +
    /* Loading: a thin moving bar under the title bar (--ld: firebrick under the light theme's gold line, gold under the
     * dark theme's firebrick one, so it never blends in), and a small spinner on values still on their way. */
    '.load{height:3px;position:relative;overflow:hidden;background:var(--hd)}.load::before{content:"";position:absolute;top:0;bottom:0;left:-35%;width:35%;background:var(--ld);animation:nsfe-slide 1.1s ease-in-out infinite}' +
    '@keyframes nsfe-slide{to{left:100%}}' +
    '.pend::after{content:"";display:inline-block;width:8px;height:8px;margin-left:6px;vertical-align:-1px;border:2px solid var(--bd);border-top-color:var(--acc);border-radius:50%;animation:nsfe-spin .8s linear infinite}' +
    '@keyframes nsfe-spin{to{transform:rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){.load::before{animation:none;left:0;width:100%;opacity:.5}.pend::after{animation:none}}' +
    /* Pill scrollbars: a rounded thumb floating in a clear track, firebrick on hover (gold in the dark theme).
     * Chrome and Edge draw the shape; Chrome ignores these rules once the standard properties are set, so only
     * Firefox (no ::-webkit-scrollbar) gets the standard thin bar in the same colours. */
    '.main::-webkit-scrollbar{width:12px;height:12px}.seg::-webkit-scrollbar{height:6px}' +
    '.main::-webkit-scrollbar-track,.main::-webkit-scrollbar-corner,.seg::-webkit-scrollbar-track{background:transparent}' +
    '.main::-webkit-scrollbar-thumb{background:var(--sbt);border-radius:999px;border:3px solid transparent;background-clip:padding-box;min-height:32px}' +
    '.seg::-webkit-scrollbar-thumb{background:var(--sbt);border-radius:999px}' +
    '.main::-webkit-scrollbar-thumb:hover,.seg::-webkit-scrollbar-thumb:hover{background-color:var(--sbh)}.main::-webkit-scrollbar-thumb:active,.seg::-webkit-scrollbar-thumb:active{background-color:var(--sba)}' +
    '@supports not selector(::-webkit-scrollbar){.main,.seg{scrollbar-width:thin;scrollbar-color:var(--sbt) transparent}.main:hover,.seg:hover{scrollbar-color:var(--sbh) transparent}}' +
    '.main{flex:1;overflow:auto}table{border-collapse:collapse;width:100%}' +
    'th{position:sticky;top:0;z-index:1;background:var(--bg);text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--mut);padding:6px 8px;border-bottom:1px solid var(--bd);white-space:nowrap}' +
    /* Column width grip on the right edge of each header (see colResize); a resized table switches to a fixed layout. */
    '.cw{position:absolute;top:0;right:0;bottom:0;width:6px;cursor:col-resize;touch-action:none}.cw:hover,.cw.on{box-shadow:inset -2px 0 var(--acc)}' +
    'table.cwset{table-layout:fixed}table.cwset th{overflow:hidden;text-overflow:ellipsis}table.cwset td{max-width:none}' +
    /* Striped rows instead of row borders (row 1 is the header). */
    'td{padding:5px 8px;vertical-align:top;max-width:260px;overflow-wrap:break-word}tr:nth-child(odd) td{background:var(--zb)}tr:hover td{background:var(--hi)}' +
    'td.id{font:11px ui-monospace,Consolas,monospace;color:var(--acct);cursor:pointer}td.id:hover,td.v:hover{background:var(--hi)}td.v{cursor:copy}' +
    /* Search matches: champagne behind the text with a thin gold edge under it (dark: firebrick, white text, red edge);
     * no padding, so nothing moves. */
    'mark{background:var(--mkb);color:var(--mkf,inherit);box-shadow:inset 0 -2px var(--mk);padding:0;border-radius:1px}' +
    '.cu{font-weight:600}.mut{color:var(--mut)}.t{color:var(--mut);display:block;font-size:11px}.req{color:var(--err)}' +
    '.empty{padding:18px;color:var(--mut);text-align:center}' +
    '.toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:#0b0b0b;color:#fff;border:1px solid #333;padding:4px 10px;border-radius:12px;opacity:0;transition:opacity .15s;pointer-events:none;max-width:90%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.p.min{height:auto!important;min-height:0}.p.min>:not(.h){display:none}' +
    /* Locate (eye) button at the end of a field ID cell (Body, Sublists, search results), always shown in the muted colour. */
    '.loc{display:inline-flex;vertical-align:middle;border:0;background:transparent;color:var(--mut);font-weight:400;padding:1px 2px;margin-left:3px;border-radius:3px;cursor:pointer}' +
    '.loc svg{width:14px;height:14px;display:block}.p.compact .loc svg{width:12px;height:12px}' +
    '.loc:hover,.loc:focus{color:var(--acct);background:var(--hi)}' +
    /* Setup-page link for custom fields, next to the eye. */
    '.cf{display:inline-flex;vertical-align:middle;color:var(--mut);padding:1px 2px;margin-left:2px;border-radius:3px}.cf svg{width:13px;height:13px;display:block}' +
    '.cf:hover,.cf:focus{color:var(--acct);background:var(--hi)}' +
    /* Compare. */
    'td.chg{white-space:nowrap}tr.c-added td.chg{color:var(--int)}tr.c-removed td.chg{color:var(--err)}tr.c-changed td.chg{color:var(--chg)}td.old{color:var(--mut)}' +
    'th[data-sort]{cursor:pointer}th[data-sort]:hover,th.sorted{color:var(--acct)}' +
    '.toast.s{opacity:.95}.ftw{display:flex;align-items:baseline;gap:8px;padding:3px 8px;border-top:1px solid var(--bd)}.ft{flex:1;min-width:0;color:var(--mut)}' +
    '.docs{white-space:nowrap}.docs a{color:var(--acct);text-decoration:none;margin-left:8px}.docs a:hover{text-decoration:underline;text-decoration-color:var(--acc)}' +
    /* The footer wordmark (SYiNCUSO: Poppins Bold, 0.03em tracking, as in the logo) and Help links. Brand links:
     * text in the text colour, underline firebrick on light and gold on dark (--ring). */
    '.by{white-space:nowrap;color:var(--mut);text-decoration:none;margin-left:10px}.by .wm{font:700 11px Poppins,"Open Sans",system-ui,"Segoe UI",Arial,sans-serif;letter-spacing:.03em;color:var(--fg)}' +
    '.by:hover .wm,.by:focus-visible .wm{text-decoration:underline;text-decoration-color:var(--ring);text-underline-offset:2px}' +
    '.help a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--ring);text-underline-offset:2px}.help a:hover{text-decoration-thickness:2px}.sp{flex:1}' +
    /* Narrow panel: the Type column moves under the label (CSS only, so copies and exports are unchanged), and
     * at phone width the logo stands in for the name so the title bar's buttons fit. */
    '@container (max-width:520px){th[data-sort=type],td.ty{display:none}td[data-t]::after{content:attr(data-t);display:block;color:var(--mut);font-size:11px}}' +
    '@container (max-width:430px){.h b{display:none}.h{gap:4px}}' +
    '.hid{display:none}';
  root.innerHTML =
    '<div class="p">' +
    ' <div class="h" data-drag>' + brandLink('brand', 'title', LOGO_SVG) + '<b>NSN Field Explorer</b><span class="meta"></span>' +
    '  <button class="ic" data-act="settings" title="Settings: theme, compact view and what a click copies" aria-label="Settings" aria-haspopup="true">' + ICON.gear + '</button>' +
    '  <button class="ic" data-act="help" title="Help: how to use the panel" aria-label="Help">' + ICON.help + '</button>' +
    '  <button class="ic" data-act="refresh" title="Refresh: read the form, saved record and setup links again" aria-label="Refresh">' + ICON.refresh + '</button>' +
    '  <button class="ic" data-act="min" title="Collapse to the title bar" aria-label="Collapse">' + ICON.min + '</button>' +
    '  <button class="ic" data-act="close" title="Close" aria-label="Close">' + ICON.close + '</button></div>' +
    ' <div class="menu pop hid" role="dialog" aria-label="Settings" tabindex="-1"><b>Settings</b>' +
    '  <label>Theme <select data-sel="theme"><option value="auto">Auto (system)</option><option value="light">Light</option><option value="dark">Dark</option></select></label>' +
    '  <label><input type="checkbox" data-chk="compact">Compact view</label>' +
    '  <label title="What clicking a field ID, or a field in Inspect, copies">Click copies <select data-sel="fmt"><option value="id">Field ID</option><option value="ss1">SuiteScript 1.0</option><option value="ss2">SuiteScript 2.x</option></select></label>' +
    ' </div>' +
    ' <div class="load hid" title="Loading field values\u2026"></div>' +
    /* One toolbar: the section switch, the search, then Filters / Inspect / Pin / View Raw. Hide empty and
     * Fields are in the Filters menu, pinning in the Pin menu, Click copies in Settings. */
    ' <div class="tbar"><div class="seg tabs" role="tablist" aria-label="Sections">' +
    '  <button data-tab="all" role="tab" class="hid" title="Search results from every section">All<span class="n"></span></button>' +
    '  <button data-tab="body" role="tab">Body<span class="n"></span></button>' +
    '  <button data-tab="sub" role="tab">Sublists<span class="n"></span></button>' +
    '  <button data-tab="rec" role="tab" title="Fields the saved record has that this form does not show">Not on form<span class="n"></span></button>' +
    '  <button data-tab="cmp" role="tab" class="hid" title="Differences between the pinned record and this one">Compare<span class="n"></span></button>' +
    ' </div>' +
    '  <span class="qbox">' + ICON.search + '<input type="search" data-q placeholder="Search field ID, label or value" aria-label="Search fields">' +
    '<button class="qx hid" data-act="qclear" title="Clear the search" aria-label="Clear the search">\u00D7</button></span>' +
    ' <div class="tools">' +
    '  <button class="tb" data-act="filter" title="Filters: hide empty fields, show only custom or standard ones" aria-label="Filters" aria-haspopup="true">' + ICON.filter + '<span class="dot hid"></span></button>' +
    '  <button class="tb" data-act="inspect" title="Inspect: hover a field on the form to see its ID; click to copy" aria-label="Inspect">' + ICON.inspect + '</button>' +
    '  <button class="tb" data-act="pin" aria-label="Pin" aria-haspopup="true">' + ICON.pin + '</button>' +
    '  <button class="tb" data-act="view" title="View Raw: the record as JSON, CSV or XML to copy or save (the search and filters apply)" aria-label="View Raw">' + ICON.code + '</button>' +
    ' </div></div>' +
    ' <div class="fpop pop hid" role="dialog" aria-label="Filters" tabindex="-1"><b>Filters</b>' +
    '  <label><input type="checkbox" data-chk="hideEmpty">Hide empty</label>' +
    '  <div class="row" title="Custom: custom fields and segments (custbody\u2026, custcol\u2026, custentity\u2026, cseg\u2026). Standard: all other fields."><span>Fields</span><span class="seg" role="group" aria-label="Fields">' +
    '<button data-kind="all">All</button><button data-kind="custom">Custom</button><button data-kind="standard">Standard</button></span></div>' +
    '  <p class="hint">Filters apply to every section and to View Raw.</p>' +
    '  <button data-act="clearfilters" class="hid">Clear filters</button>' +
    ' </div>' +
    ' <div class="ppop pop hid" role="dialog" aria-label="Pin" tabindex="-1"></div>' +
    ' <div class="istrip hid" role="status">' + ICON.inspect + '<span>Inspect is on: hover a field on the form to see its ID; click to copy it.</span><button data-act="inspectoff">Stop</button></div>' +
    ' <div class="subtabs hid"></div>' +
    ' <div class="main"></div>' +
    ' <div class="ftw"><div class="ft"></div><span class="docs"></span>' + brandLink('by', 'footer', 'by <span class="wm">SYiNCUSO</span>') + '</div>' +
    ' <div class="toast" role="status" aria-live="polite"></div>' +
    ' <div class="rz" data-rz="n"></div><div class="rz" data-rz="s"></div><div class="rz" data-rz="e"></div><div class="rz" data-rz="w"></div>' +
    ' <div class="rz" data-rz="ne"></div><div class="rz" data-rz="nw"></div><div class="rz" data-rz="se"></div><div class="rz" data-rz="sw"></div>' +
    '</div>';
  try { var sheet = new CSSStyleSheet(); sheet.replaceSync(PANEL_CSS); root.adoptedStyleSheets = [sheet]; }
  catch (e) { var st = document.createElement('style'); st.textContent = PANEL_CSS; root.insertBefore(st, root.firstChild); }
  document.body.appendChild(host);

  var $ = function (sel) { return root.querySelector(sel); };
  var main = $('.main'), toastEl = $('.toast'), toastTimer;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('s'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('s'); }, 1800); }
  /* copyText selects a hidden textarea, which takes the focus: give it back, so a keyboard copy keeps its place. */
  function copy(text, label, doc) {
    var a = root.activeElement || outerFocus();
    copyText(text, doc, function (ok) { toast(ok ? 'Copied ' + label : 'Copy blocked by the browser'); });
    /* Always focus again: a field in a frame still counts as its document's active element after the frame lost focus. */
    try { if (a && a.isConnected) a.focus({ preventScroll: true }); } catch (e) {}
  }
  /* The element focused outside the panel, followed down through same-origin frames (a field on the form, when
   * a delayed copy (waiting for names) runs after the user clicked into the form), or null. */
  function outerFocus() {
    var el = document.activeElement, d;
    if (!el || el === document.body || el === host) return null;
    try { while (/^I?FRAME$/.test(el.tagName) && (d = el.contentDocument) && d.activeElement && d.activeElement !== d.body) el = d.activeElement; } catch (e) {}
    return el;
  }

  /* ---------- sorting (click a column header: ascending, descending, then page order) ---------- */
  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
  /* One collator for every comparison: localeCompare with options builds a new one per call. */
  var COLLATOR = null;
  try { COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); } catch (e) {}
  /* Stable sort by S.sortKey; empty values always go last, in either direction. Two numbers (thousands
   * commas allowed) compare as numbers, anything else as text. Each row's key and number are worked
   * out once, not on every comparison. */
  function sortRows(rows, keyOf) {
    if (!S.sortKey || !S.sortDir) return rows;
    return rows.map(function (r, i) {
      var k = keyOf(r, S.sortKey), n;
      k = k == null ? '' : String(k);
      n = k.replace(/,/g, '');
      return { r: r, i: i, k: k, n: NUM_RE.test(n) ? parseFloat(n) : null };
    })
      .sort(function (x, y) {
        if (x.k === '' || y.k === '') return (x.k === '') - (y.k === '') || x.i - y.i;
        var c = x.n !== null && y.n !== null ? x.n - y.n : COLLATOR ? COLLATOR.compare(x.k, y.k) : x.k.localeCompare(y.k);
        return c * S.sortDir || x.i - y.i;
      })
      .map(function (o) { return o.r; });
  }
  function th(label, key) {
    var on = S.sortKey === key && S.sortDir;
    return '<th data-sort="' + esc(key) + '"' + (on ? ' class="sorted" aria-sort="' + (S.sortDir > 0 ? 'ascending' : 'descending') + '"' : '') + ' title="Click to sort">' + esc(label) +
      (on ? (S.sortDir > 0 ? ' \u25B2' : ' \u25BC') : '') + '<span class="cw" title="Drag to resize; double-click to reset"></span></th>';
  }

  /* ---------- search across every section ---------- */
  function lineText(cc) { return cc.vals.map(function (x) { return x.t || x.v; }); }
  var SECTION = { body: 'Body', rec: 'Not on form' };
  /* Every field that passes the filters, from Body, Not on form (only if the saved record
   * is already loaded, so edit mode never loads it just for a search) and every sublist. */
  function searchAll(w, keep) {
    var c = collectBody(w, true), out = { body: [], rec: [], sub: [] };
    ['body', 'rec'].forEach(function (k) { out[k] = c[k].filter(function (f) { return keep(f, [f.value, f.text]); }); });
    sublistIds(w).forEach(function (sid) {
      var d = sublistData(w, sid, LINE_CAP);
      if (d) d.cols.forEach(function (cc) { if (keep(cc, lineText(cc))) out.sub.push({ sid: sid, cc: cc }); });
    });
    return out;
  }
  /* For a sublist column found by the search: the lines whose value matched (or, if only the ID or
   * label matched, the first non-empty lines), as "L2: value", up to three. */
  function lineHits(cc, q) {
    var hits = [], all = [];
    cc.vals.forEach(function (x, i) {
      var s = disp(x.t || x.v);
      if (s === '') return;
      var item = { line: i + 1, s: s, raw: disp(x.v) };
      all.push(item);
      if (q && s.toLowerCase().indexOf(q) >= 0) hits.push(item);
    });
    return (hits.length ? hits : all).slice(0, 3);
  }
  /* Row attributes: likely NetSuite internals (Not on form fields with no label) get a green field ID. */
  function rowAttrs(f) {
    return f && f.internal ? ' class="int" title="No label: most likely a NetSuite internal field, not data you entered"' : '';
  }
  /* Class (and tooltip) for a field ID cell: custom IDs are bold; custpage IDs are also purple, because a
   * script added them to the form and they are never saved on the record. */
  var CUSTPAGE_ID = /^custpage/i;
  function idCls(id) {
    if (CUSTPAGE_ID.test(id)) return 'id cu cp" title="custpage: added to the form by a script. Not saved on the record, so searches, SuiteQL and record.load do not see it';
    return CUSTOM_ID.test(id) ? 'id cu' : 'id';
  }
  /* Value HTML with a spinner right after it while its name is still loading. */
  function pend(html, on) { return on ? '<span class="pend">' + html + '</span>' : html; }
  /* Search highlight: text as HTML, with every case-insensitive occurrence of the search (HL, the lower-case
   * query, set by renderNow) wrapped in <mark>. The text is split around the matches and each piece goes
   * through esc, so neither the text nor the query reaches the HTML or a regex unescaped. Not searching: esc. */
  var HL = '';
  function hl(s) {
    s = String(s == null ? '' : s);
    if (!HL) return esc(s);
    var lo = s.toLowerCase(), n = HL.length, out = '', at = 0, i;
    /* A few characters lower-case to two (U+0130); keep those as they are so offsets match the text. */
    if (lo.length !== s.length) lo = s.replace(/[\s\S]/g, function (c) { var l = c.toLowerCase(); return l.length === 1 ? l : c; });
    while ((i = lo.indexOf(HL, at)) >= 0) { out += esc(s.slice(at, i)) + '<mark>' + esc(s.slice(i, i + n)) + '</mark>'; at = i + n; }
    return at ? out + esc(s.slice(at)) : esc(s);
  }
  function setBadges(counts) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function (b) {
      var k = b.getAttribute('data-tab'), n = b.querySelector('.n');
      if (n) n.textContent = counts && counts[k] != null ? String(counts[k]) : '';
      b.classList.toggle('zero', !!counts && counts[k] === 0);
    });
  }

  /* ---------- link to the Records Catalog for the record type ----------
   * The account's own Records Catalog covers standard and custom record types. (A Records Browser link
   * was tried and dropped: its folders are named after a NetSuite version and lag behind releases.) */
  function docLink(w, type) {
    var o = '';
    type = String(type || '').toLowerCase();
    if (!type || !validId(type)) return '';
    try { o = w.location.origin; } catch (e) {}
    if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(o)) return '';
    return o + '/app/recordscatalog/rcbrowser.nl?whence=#/record_ss/' + type;
  }
  var lastDocs = '';
  function setDocLinks(url) {
    var html = !url ? '' : '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="Open this record type in the Records Catalog (new tab)">Records Catalog</a>';
    if (html !== lastDocs) { lastDocs = html; $('.docs').innerHTML = html; }
  }

  /* ---------- rendering ---------- */
  /* The current table as CSV rows; turned into text only when View Raw shows CSV. lastCsvSub / lastCsvScope:
   * the sublist a Sublists-tab CSV holds and what it covers (sublistScope), '' for any other preview. */
  var lastCsvRows = [], lastPreview = '', lastCsvSub = '', lastCsvScope = '';
  var TAB_NAME = { all: 'search results', body: 'Body', sub: 'Sublists', rec: 'Not on form', cmp: 'Compare' };
  /* The help page (? button in the title bar). Keep it short; the README has the details. */
  var HELP_HTML =
    '<div class="pvbar"><b>How to use NSN Field Explorer</b><span class="sp"></span><button data-act="helpclose">Close</button></div>' +
    '<div class="help">' +
    '<h3>The toolbar</h3><ul>' +
    '<li><b>Body / Sublists / Not on form</b>: the sections of the record. <b>All</b> appears while you search, <b>Compare</b> once a record is pinned (or you compare with the saved record).</li>' +
    '<li><b>Filters</b> (three lines), <b>Inspect</b> (crosshair), <b>Pin</b> (pushpin) and <b>View Raw</b> (&lt;&nbsp;&gt;): described below. A dot on Filters means a filter is on; the pin is highlighted while a record is pinned.</li>' +
    '<li>On a narrow panel the toolbar wraps onto two rows and the Type column moves under each label.</li></ul>' +
    '<h3>Sections</h3><ul>' +
    '<li><b>Body</b>: every field on the form. Fields the form hides are listed too (their type ends in <code>, hidden</code>) when they are custom or the saved record gives them a label; in edit mode, standard hidden fields appear once you have opened Not on form. The record type in the title bar is a field too: <code>baserecordtype</code>.</li>' +
    '<li><b>Sublists</b>: pick a sublist in the row under the toolbar. The number is its line count. Sublists with lines come first; empty ones fold into a <b>+N empty</b> button (while searching, <b>+N more</b> for the ones with no matches). Each line is a column (first 50 lines shown; View Raw CSV has every line, one row each).</li>' +
    '<li><b>Not on form</b>: fields the saved record has that the form leaves out. In edit mode, opening it loads the saved record, so it shows saved values, not changes you have not saved.</li>' +
    '<li><b>All</b>: appears while you search, with the matches from every section.</li>' +
    '<li><b>Compare</b>: appears once you pin a record: click <b>Pin</b>, then pin the record in its menu. Open another record, or change this one, and Compare lists what is different: body fields added, removed or changed, sublist lines added or removed, and sublist cells changed. <b>Show unchanged</b> also lists the body fields that match. Against an earlier pin of the same record, lines are matched by their line key, so an inserted line is not reported as every line changing; two different records are compared line by line in order. The pin stays while this browser tab is open; <b>Unpin</b> in the Pin menu clears it.</li><li><b>Compare with the saved record</b> (Pin menu, edit mode on a saved record): lists what you have changed on the form and not saved yet, the <b>Saved record</b> next to <b>This form</b>. It loads the saved record, like Not on form. Only fields and sublist columns the saved record has are compared, and not hidden fields or the created and last modified dates. A saved name the background search cannot find shows as its internal ID. If a record is pinned too, the bar above the comparison switches between <b>Pinned record</b> and <b>Saved record</b>.</li></ul>' +
    '<h3>Find things</h3><ul>' +
    '<li>Type in the search box to search field IDs, labels and values in every section at once. Each section, and each sublist, shows its number of matches; click a section to see only its matches, and clear the box (or click the red <b>\u00D7</b> in it) to go back. Not on form is included once the saved record is loaded. On Compare, the search narrows the differences. The matching text is highlighted in the field IDs, labels and values; copies and View Raw are not affected.</li>' +
    '<li><b>Filters</b>: <b>Hide empty</b> and <b>Fields</b> (All, Custom or Standard) narrow every section, and View Raw too. A dot on the Filters button means one is on; <b>Clear filters</b> turns them off.</li>' +
    '<li>Click a column header to sort: \u25B2, then \u25BC, then back to the page order. Empty values go last.</li>' +
    '<li>Drag the right edge of a column header to change the column width; double-click the edge to reset it. Widths are remembered for each section.</li></ul>' +
    '<h3>Copy, inspect and export</h3><ul>' +
    '<li>Click a <span class="ex-id">field ID</span> to copy it. Set <b>Click copies</b> (in <b>Settings</b>) to SuiteScript 1.0 or 2.x to copy a ready-made line instead; Inspect follows the same setting. Click a value to copy the value.</li>' +
    '<li><b>Inspect</b>: hover a field or sublist cell on the NetSuite form to see its ID, label, type and value; click to copy. A strip under the toolbar shows while it is on; <kbd>Esc</kbd> or <b>Stop</b> turns it off.</li>' +
    '<li><b>Eye icon</b> (at the end of the field ID): shows that field on the form. It opens the NetSuite tab the field is on, scrolls to it and outlines it for a moment. Only fields that can be shown get one: a field on another NetSuite tab does, a field the form hides or a Not on form field does not.</li>' +
    '<li><b>View Raw</b>: the record as JSON, CSV (the table you are looking at, in the order shown) or XML. JSON and XML hold the body fields, hidden ones too, and every sublist line (up to 500). On <b>Sublists</b>, the CSV is the sublist picked: one row per line, every line (up to 500, not just the 50 shown), in line order, with its number in <code>line_number</code> and one column per field, holding what the table shows (the name for a list field); it is saved as <code>vendorbill-123-item.csv</code>, and the footer says how many lines it holds. On the other tabs a note under the format buttons says so, with a link to Sublists. <b>Copy</b> copies the format shown and <b>Download</b> saves it as a file (for example <code>vendorbill-123.json</code>, or <code>vendorbill-new.json</code> for an unsaved record). On <b>Body</b>, Download on the CSV first asks whether to save the sublists too: <b>Body and sublists</b> also saves each sublist with lines as its own CSV, one row per line (the browser may ask to allow several downloads); <b>Cancel</b> saves nothing. The search and filters apply, and a filtered export says so.</li>' +
    '<li><b>Tree</b> / <b>Text</b> (JSON only): Tree shows the same JSON as an outline you can open and close. The top level (record, filters when a filter is on, body, sublists) starts open, and so does each sublist of up to 50 lines; the details of every field start open too; lines start closed, with a short preview, and opening one shows its fields in full. What you open stays open while you look at the same record; another record, or Refresh, starts again. Click a <span class="ex-id">name</span> to open or close it, or a value to copy it. Copy and Download still give the text. Your choice is remembered.</li></ul>' +
    '<h3>What you see</h3><ul>' +
    '<li><span class="ex-id">Field ID</span> (dark red, or gold in the dark theme): a field. <b>Bold</b>: a custom field or segment. <span class="req">*</span>: required.</li>' +
    '<li><span class="ex-int">Green ID</span> (Not on form): no label, most likely a NetSuite internal field.</li>' +
    '<li><span class="ex-cp">Purple ID</span> (<code>custpage\u2026</code>): a script added it to the form. It is not saved on the record, so searches, SuiteQL and <code>record.load</code> do not see it.</li>' +
    '<li>Small grey text under a value: the internal ID behind the name. Multi-select values are separated by <code> | </code>.</li>' +
    '<li>A moving bar under the title, or a spinner next to a value: still loading.</li>' +
    '<li>On Compare, the Change column is <span class="ex-int">green</span> for added, <span class="req">red</span> for removed and <span class="ex-chg">gold</span> for changed.</li>' +
    '<li>The footer (bottom left): how many fields or lines are shown, and anything that went wrong, such as a record that could not be loaded. If setup links are missing, hover it to see NetSuite\'s own message.</li></ul>' +
    '<h3>View mode and edit mode</h3><ul>' +
    '<li>View mode: NetSuite gives the page no live values, so the panel reads the saved record (read-only). The footer says so. If the record cannot be loaded, the panel shows the page text and the footer says why.</li>' +
    '<li>Edit mode: values are live, including changes you have not saved yet.</li></ul>' +
    '<h3>The panel</h3><ul>' +
    '<li>Drag the title bar to move it, any edge or corner to resize it, <b>\u2013</b> to collapse it and <b>+</b> to expand it again. Position, size and collapsed state are remembered. Below 430 px wide the logo stands in for the name.</li>' +
    '<li>Click the record type, the internal ID (<b>#1001</b>) or the document number in the title bar to copy it. You get the plain value (<code>1001</code>, without the <b>#</b>), whatever Click copies is set to. A new record shows only its type.</li>' +
    '<li><b>Settings</b> (gear in the title bar): theme (Auto follows the system, or Light or Dark), Compact view and Click copies. All are remembered.</li>' +
    '<li><b>Arrow icon</b> (after a custom field\'s ID): opens the setup page of that custom field or segment in a new tab. <code>custpage</code> fields, script parameters and workflow fields have none. If your role cannot read custom field definitions, there are no arrows and the footer says so; segments still get theirs if only custom fields are refused.</li>' +
    '<li><b>Records Catalog</b> (in the footer) opens this record type in the Records Catalog in a new tab.</li>' +
    '<li><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> or the extension\'s button in the browser toolbar opens and closes the panel. <b>Refresh</b> (\u21BB) reads the form, the saved record and the setup links again.</li>' +
    '<li>Read-only: the panel never changes or saves anything in NetSuite.</li></ul>' +
    '<h3>Keyboard</h3><ul>' +
    '<li><kbd>Tab</kbd> moves between the title bar buttons, the sections, the search, the toolbar, the sublists and the table.</li>' +
    '<li>Sections and sublists: <kbd>\u2190</kbd> and <kbd>\u2192</kbd> (or <kbd>Home</kbd> and <kbd>End</kbd>) move to the next one and open it.</li>' +
    '<li>The table is one stop: the arrow keys move between cells. <kbd>Enter</kbd> or <kbd>Space</kbd> on a column header sorts, and on a field ID or a value copies it, the same as a click. <kbd>\u2192</kbd> from a field ID reaches its eye and setup arrow.</li>' +
    '<li>The JSON tree is one stop too: <kbd>\u2191</kbd> and <kbd>\u2193</kbd> move, <kbd>\u2192</kbd> opens an item (or moves into an open one), <kbd>\u2190</kbd> closes it (or moves to its parent), <kbd>Home</kbd> and <kbd>End</kbd> jump to the first and last item, and <kbd>Enter</kbd> or <kbd>Space</kbd> opens or closes an item, or copies a value.</li>' +
    '<li>Settings, Filters and Pin: <kbd>Enter</kbd> opens the menu and moves into it; <kbd>Esc</kbd> closes it and goes back to its button.</li></ul>' +
    '<h3>About</h3><ul>' +
    '<li>NSN Field Explorer is free and made by <b>Syincuso</b>. Syincuso builds custom tools that fit the way your team works and plug into the systems you already use, NetSuite included. You pay once and own them, with no subscription.</li>' +
    '<li>Need a tool built for your team? <a href="' + brandUrl('help', '#contact') + '" target="_blank" rel="noopener noreferrer">Tell us what you need</a> or email <a href="mailto:info@syincuso.com?subject=NSN%20Field%20Explorer">info@syincuso.com</a>.</li>' +
    /* Credit to the open-source tools that inspired this one. None of their code is used (checked 2026-11-12). */
    '<li>Inspired by two open-source tools: <a href="https://github.com/michoelchaikin/netsuite-field-explorer" target="_blank" rel="noopener noreferrer">NetSuite Field Explorer</a> by Michoel Chaikin and <a href="https://github.com/alien4u/ns-field-explorer-ex" target="_blank" rel="noopener noreferrer">NetSuite Field Explorer EX</a> by Alien Technology. NSN Field Explorer was designed from scratch and is not a copy of their code.</li></ul>' +
    '</div>';
  /* The export preview that replaces the table while S.preview is 'json', 'csv' or 'xml'. For JSON a Tree / Text
   * switch (S.jsonView) follows the format switch; tree is the object behind the text, shown by treeHtml instead
   * of the text when S.jsonView is 'tree'. Copy and Download always use the text. note: HTML for a line under
   * the bar (what the CSV holds), or ''. */
  function previewHtml(txt, note, tree) {
    var jv = function (v, name, tip) {
      return '<button data-jv="' + v + '" aria-pressed="' + (S.jsonView === v) + '"' + (S.jsonView === v ? ' class="on"' : '') + ' title="' + tip + '">' + name + '</button>';
    };
    return '<div class="pvbar"><span class="grp">' + ['json', 'csv', 'xml'].map(function (f) {
      return '<button data-pv="' + f + '"' + (S.preview === f ? ' class="on"' : '') + '>' + f.toUpperCase() + '</button>';
    }).join('') + '</span>' +
      (S.preview === 'json' ? '<span class="grp" role="group" aria-label="Show the JSON as">' + jv('tree', 'Tree', 'An expandable tree') + jv('text', 'Text', 'Plain text, as Copy gives it') + '</span>' : '') +
      '<span class="sp"></span><button data-act="pvdl" title="Save the ' + S.preview.toUpperCase() + ' as a file">Download</button>' +
      '<button data-act="pvcopy">Copy ' + S.preview.toUpperCase() + '</button><button data-act="pvclose" title="Back to the fields">Close</button></div>' +
      (S.dlAsk ? '<p class="pvask" role="group" aria-label="Download the sublists too?">Download the sublists too? Each sublist with lines is saved as its own CSV, one row per line. ' +
        '<button type="button" class="pri" data-act="dlall">Body and sublists</button><button type="button" data-act="dlbody">Body only</button><button type="button" data-act="dlcancel">Cancel</button></p>' : '') +
      (note ? '<p class="pvnote">' + note + '</p>' : '') + (tree ? treeHtml(tree) : '<pre class="code">' + esc(txt) + '</pre>');
  }

  /* ---------- View Raw JSON as a tree ----------
   * A WAI-ARIA tree (ul role=tree, li role=treeitem with aria-level and, on objects and arrays, aria-expanded) of
   * the object jsonData builds, so it holds exactly what the JSON text holds, filters included. Each item carries
   * its path as JSON in data-path (["sublists","item",0]); JT.open remembers what was opened or closed, keyed by
   * that path, while the page shows the same record (JT.rec, type:id; jtReset on another record and on Refresh),
   * so a render (names or setup links arriving) draws the same tree. Only
   * open items have their children in the DOM: a closed one gets them when it is first opened, and loses them
   * again when it is closed. Open by default: the top level (record, filters, body, sublists) and each sublist of up
   * to LINE_CAP lines, and every field's details (jtIsField); sublist lines start closed, showing a one-line preview. JT.stop is the path of
   * the item in the Tab order (one Tab stop, roving tabindex). JT.data is the object on show (null when no tree is
   * drawn) and JT.shown the record whose tree the last render drew ('' if none), so render only keeps the scroll
   * position from one tree of a record to the next. */
  var JT = { data: null, open: newMap(), stop: '', rec: '', shown: '' };
  function jtReset() { JT.open = newMap(); JT.stop = ''; }
  var JT_PEEK = 80;
  function jtKey(p) { return JSON.stringify(p); }
  function jtPathOf(li) {
    try { var p = JSON.parse(li.getAttribute('data-path')); return Array.isArray(p) ? p : null; } catch (e) { return null; }
  }
  function jtNode(v) { return v !== null && typeof v === 'object'; }
  /* The value at a path in the data on show (undefined if there is none). */
  function jtGet(p) {
    var v = JT.data, i;
    if (!p) return undefined;
    for (i = 0; i < p.length; i++) {
      if (!jtNode(v) || !has(v, p[i])) return undefined;
      v = v[p[i]];
    }
    return v;
  }
  /* Member names (indexes for an array) in the order JSON.stringify writes them; like it, skips undefined. */
  function jtMembers(v) {
    if (Array.isArray(v)) return v.map(function (x, i) { return i; });
    return Object.keys(v).filter(function (k) { return v[k] !== undefined && typeof v[k] !== 'function'; });
  }
  function jtIsLines(p, v) { return p.length === 2 && p[0] === 'sublists' && Array.isArray(v); }
  function jtIsOpen(p, v) {
    var k = jtKey(p);
    if (has(JT.open, k)) return JT.open[k];
    return p.length === 1 || (jtIsLines(p, v) && v.length <= LINE_CAP) || jtIsField(p);
  }
  /* A field's details (a body field's label, type, value and text; a line field's value and text) start open, so
   * opening a line shows its fields in full. Lines themselves start closed (a sublist can have 500). */
  function jtIsField(p) { return (p.length === 2 && p[0] === 'body') || (p.length === 4 && p[0] === 'sublists'); }
  function nOf(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  /* "7 fields", "2 sublists", "120 lines", else {4} for an object and [3] for an array. Spoken (the aria-label),
   * without braces: "4 fields" for an object and "3 items" for an array. */
  function jtSize(p, v, spoken) {
    var n = jtMembers(v).length;
    if (p.length === 1 && p[0] === 'body') return nOf(n, 'field');
    if (p.length === 1 && p[0] === 'sublists') return nOf(n, 'sublist');
    if (jtIsLines(p, v)) return nOf(n, 'line');
    if (spoken) return nOf(n, Array.isArray(v) ? 'item' : 'field');
    return Array.isArray(v) ? '[' + n + ']' : '{' + n + '}';
  }
  /* A closed object's members on one line, cut at JT_PEEK characters: {label: "Vendor", type: "select", ...} */
  function jtPeek(v) {
    var ks = jtMembers(v), parts = [], len = 0, i, x, s;
    for (i = 0; i < ks.length && len <= JT_PEEK; i++) {
      x = v[ks[i]];
      s = ks[i] + ': ' + (jtNode(x) ? (Array.isArray(x) ? '[\u2026]' : '{\u2026}') : JSON.stringify(x));
      parts.push(s);
      len += s.length + 2;
    }
    s = parts.join(', ');
    if (s.length > JT_PEEK) s = s.slice(0, JT_PEEK) + '\u2026';
    else if (i < ks.length) s += ', \u2026';
    return '{' + s + '}';
  }
  var JT_TYPE = { string: 'j-str', number: 'j-num', boolean: 'j-bool' };
  function jtValue(v) {
    return '<span class="' + (has(JT_TYPE, typeof v) && v !== null ? JT_TYPE[typeof v] : 'j-null') + '">' + esc(JSON.stringify(v)) + '</span>';
  }
  /* One item and, if it is open, its children. A sublist line is named Line 1, Line 2... (as in CSV and XML). */
  function jtItem(p, v) {
    var last = p[p.length - 1], line = p.length === 3 && p[0] === 'sublists' && typeof last === 'number';
    var name = line ? 'Line ' + (last + 1) : String(last), node = jtNode(v), open = node && jtIsOpen(p, v);
    var h = '<li role="treeitem" aria-level="' + p.length + '" tabindex="-1" data-path="' + esc(jtKey(p)) + '"' +
      (node ? ' aria-expanded="' + open + '" aria-label="' + esc(name + ', ' + jtSize(p, v, true)) + '"' : '') + '>' +
      '<div class="jr"><span class="tw" aria-hidden="true"></span><span class="' + (typeof last === 'number' ? 'ji' : 'jk') + '">' + esc(name) + '</span><span class="jp">:</span> ' +
      (!node ? jtValue(v) : open || Array.isArray(v) ? '<span class="jc">' + esc(jtSize(p, v)) + '</span>' : '<span class="jc">' + esc(jtPeek(v)) + '</span>') + '</div>';
    return h + (open ? jtKids(p, v) : '') + '</li>';
  }
  function jtKids(p, v) {
    return '<ul role="group">' + jtMembers(v).map(function (k) { return jtItem(p.concat([k]), v[k]); }).join('') + '</ul>';
  }
  function treeHtml(o) {
    JT.data = o;
    return '<ul class="jt" role="tree" aria-label="Record JSON">' + jtMembers(o).map(function (k) { return jtItem([k], o[k]); }).join('') + '</ul>';
  }
  /* Opens or closes an item in place (no render): it is drawn again from JT.data, keeping focus and the Tab stop. */
  function jtSet(li, open) {
    var p = jtPathOf(li), v = jtGet(p);
    if (!jtNode(v) || !li.hasAttribute('aria-expanded')) return li;
    JT.open[jtKey(p)] = open;
    var had = root.activeElement === li, stop = li.tabIndex === 0, nl;
    li.insertAdjacentHTML('afterend', jtItem(p, v));
    nl = li.nextElementSibling;
    li.remove();
    if (stop) nl.tabIndex = 0;
    if (had) nl.focus({ preventScroll: true });
    return nl;
  }
  /* A click on an item's row, Enter or Space: an object or array opens or closes, a value is copied. */
  function jtActivate(li) {
    if (li.hasAttribute('aria-expanded')) { jtSet(li, li.getAttribute('aria-expanded') !== 'true'); return; }
    var v = jtGet(jtPathOf(li));
    if (v !== undefined && !jtNode(v)) copy(v === null ? 'null' : String(v), 'value');
  }
  function jtRove(li) {
    var tree = li.closest('.jt');
    if (tree) Array.prototype.forEach.call(tree.querySelectorAll('[tabindex="0"]'), function (x) { if (x !== li) x.tabIndex = -1; });
    li.tabIndex = 0;
    JT.stop = li.getAttribute('data-path') || '';
  }
  function jtGo(li) {
    jtRove(li);
    li.focus({ preventScroll: true });
    try { li.querySelector('.jr').scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  }
  /* Up / Down: the item above or below; Home / End: the first or last; Right opens a closed item, or goes to the
   * first child of an open one; Left closes an open item, or goes to the parent; Enter / Space: as a click. */
  function jtKeydown(e, li) {
    var k = e.key, items = Array.prototype.slice.call(li.closest('.jt').querySelectorAll('[role="treeitem"]')), i = items.indexOf(li);
    var ex = li.getAttribute('aria-expanded'), to = null;
    if (k === 'ArrowDown') to = items[i + 1];
    else if (k === 'ArrowUp') to = items[i - 1];
    else if (k === 'Home') to = items[0];
    else if (k === 'End') to = items[items.length - 1];
    else if (k === 'ArrowRight') { if (ex === 'false') jtSet(li, true); else if (ex === 'true') to = li.querySelector('[role="treeitem"]'); }
    else if (k === 'ArrowLeft') { if (ex === 'true') jtSet(li, false); else to = li.parentNode.closest('[role="treeitem"]'); }
    else if (k === 'Enter' || k === ' ') jtActivate(li);
    else return;
    e.preventDefault();
    if (to) jtGo(to);
  }
  /* The item with this path, else its nearest ancestor on show (a filter removed it), else null. */
  function jtFind(tree, key) {
    var p = null, items = tree.querySelectorAll('[role="treeitem"]'), i;
    try { p = JSON.parse(key); } catch (e) {}
    while (Array.isArray(p) && p.length) {
      key = jtKey(p);
      for (i = 0; i < items.length; i++) if (items[i].getAttribute('data-path') === key) return items[i];
      p.pop();
    }
    return null;
  }
  /* After each render: the tree's Tab stop is the item last visited, else the first. */
  function treeSetup() {
    var tree = main.querySelector('.jt'), el = tree && (jtFind(tree, JT.stop) || tree.querySelector('[role="treeitem"]'));
    if (el) el.tabIndex = 0;
  }
  /* Every render gets a fresh memo (see memo()); a render nested inside another (a synchronous record
   * error) gets its own and hands the outer one back. The Inspect cache is cleared, since the values it
   * shows may have changed. */
  function render() {
    var outer = MEMO, spot = focusSpot(), sx = main.scrollLeft, sy = main.scrollTop, treeWas = JT.shown;
    MEMO = newMap();
    insp.lastT = null;
    try { renderNow(); } finally { MEMO = outer; }
    /* A new table is laid out at its automatic width before applyColWidths widens it again, which clamped a
     * sideways scroll; put it back (the browser clamps it to the new table). The JSON tree keeps its place from a tree
     * of the same record; coming from Text, a table or another record, it starts at the top. */
    if (sx && main.scrollLeft !== sx) main.scrollLeft = sx;
    if (JT.shown && treeWas !== JT.shown) main.scrollTop = 0;
    else if (JT.shown && sy && main.scrollTop !== sy) main.scrollTop = sy;
    tabStops();
    gridSetup();
    treeSetup();
    if (spot) refocus(spot);
  }
  /* The title bar's record type, internal ID and document number: one button each (data-mcopy names the part), and a
   * click copies the plain value (1001, not #1001), whatever Click copies says. The type must be a valid ID and the ID
   * digits; a new record has no ID, and no form shows nothing. The spaces between the buttons keep textContent as it
   * was ("vendorbill #1001  VB-1001"); the flex layout drops them. Rebuilt only when it changes, so a background render
   * leaves a focused part alone (and focusSpot finds it by data-mcopy if it is rebuilt). */
  var metaHtml = '';
  function metaPart(k, name, v, shown) {
    return '<button type="button" class="mc-' + k + '" data-mcopy="' + k + '" data-v="' + esc(v) + '" title="Copy ' + name + '" aria-label="Copy ' + name + ' ' + esc(v) + '">' + esc(shown) + '</button>';
  }
  function setMeta(m) {
    var html = '', type = m && m.type != null ? String(m.type) : '', id = m && m.id != null ? String(m.id) : '', tid = m && m.tranid != null ? String(m.tranid) : '';
    if (m) {
      html = validId(type) ? metaPart('type', 'record type', type, type) : '<span>record</span>';
      if (/^\d+$/.test(id)) html += ' ' + metaPart('id', 'internal ID', id, '#' + id);
      if (/\S/.test(tid)) html += '  ' + metaPart('tranid', 'document number', tid, tid);
    }
    if (html !== metaHtml) { $('.meta').innerHTML = html; metaHtml = html; }
  }
  function renderNow() {
    var w = findTarget();
    /* No tree unless the View Raw branch below draws one. */
    JT.data = null; JT.shown = '';
    $('[data-tab="all"]').classList.toggle('hid', !S.q);
    $('.qx').classList.toggle('hid', !S.q);
    if (S.tab === 'all' && !S.q) S.tab = S.prevTab || 'body';
    var src = cmpSource(w);
    if (S.tab === 'cmp' && !src) S.tab = 'body';
    renderPin(w);
    Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function (b) { var on = b.getAttribute('data-tab') === S.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    $('[data-act="inspect"]').classList.toggle('on', S.inspect);
    $('.istrip').classList.toggle('hid', !S.inspect);
    renderFilters();
    $('[data-act="view"]').classList.toggle('on', !!S.preview && !S.help);
    $('[data-act="help"]').classList.toggle('on', S.help);
    /* Toggle the class, not style.display: an empty inline display would not override class "hid". */
    $('.subtabs').classList.toggle('hid', S.tab !== 'sub');
    $('.load').classList.add('hid');
    if (!w) { main.innerHTML = S.help ? HELP_HTML : '<div class="empty">No NetSuite form found in this browser tab. Open a record page (view or edit) and click Refresh (circular arrow).</div>'; setMeta(null); setDocLinks(''); return; }
    ensureRecord(w, function () { if (!closed) render(); }, S.tab === 'rec' || (S.tab === 'cmp' && src === 'saved'));
    var m = meta(w), rs = recMine(w) ? REC.state : '', view = isViewMode(w);
    setMeta(m);
    setDocLinks(docLink(w, m.type));
    if (S.inspect) attachInspect(w);
    var q = S.q.toLowerCase();
    HL = q;
    var keep = makeKeep();
    var html = '', csv = [], count = 0, ft = '';
    /* While searching, every tab shows how many matches it has. */
    var found = q ? searchAll(w, keep) : null;
    setBadges(found ? {
      all: found.body.length + found.rec.length + found.sub.length,
      body: found.body.length, sub: found.sub.length, rec: rs === 'ready' ? found.rec.length : null
    } : null);
    /* The Compare badge is the number of differences, worked out when the Compare tab is shown; it is
     * cleared when the page shows another record. */
    var here = (m.type || '') + ':' + (m.id || '');
    if (here !== cmp.at) cmp.count = null;
    /* Another record: the JSON tree opens as it does by default again. */
    if (here !== JT.rec) { jtReset(); JT.rec = here; }
    $('[data-tab="cmp"] .n').textContent = cmp.count == null ? '' : String(cmp.count);
    $('[data-tab="cmp"]').classList.remove('zero');
    if (S.tab === 'all') {
      html = '<table><tr>' + th('Section', 'sec') + th('Field ID', 'id') + th('Label', 'label') + th('Type', 'type') + th('Value', 'value') + '</tr>';
      csv.push(['section', 'id', 'label', 'type', 'value', 'text']);
      var hitsRows = [];
      ['body', 'rec'].forEach(function (k) {
        found[k].forEach(function (f) {
          hitsRows.push({ sec: SECTION[k], id: f.id, label: f.label, type: f.type, f: f, custom: f.custom,
            value: disp(f.text && f.text !== f.value ? f.text : f.value) });
        });
      });
      found.sub.forEach(function (o) {
        var hits = lineHits(o.cc, q);
        hitsRows.push({ sec: 'Sublist: ' + o.sid, sid: o.sid, id: o.cc.id, label: o.cc.label, type: o.cc.type, hits: hits, custom: CUSTOM_ID.test(o.cc.id),
          value: hits.map(function (x) { return 'L' + x.line + ': ' + x.s; }).join('; ') });
      });
      sortRows(hitsRows, function (r, k) { return r[k]; }).forEach(function (r) {
        count++;
        var raw = r.f ? disp(r.f.value) : (r.hits[0] ? r.hits[0].raw : '');
        csv.push([r.sec, r.id, r.label, r.type, r.f ? disp(r.f.value) : r.value, r.f ? disp(r.f.text) : '']);
        html += '<tr' + rowAttrs(r.f) + '><td class="sec">' + esc(r.sec) + '</td><td class="' + idCls(r.id) + '" data-id="' + esc(r.id) + '"' + (r.sid ? ' data-sub="' + esc(r.sid) + '"' : '') + '>' + hl(r.id) + ((r.sid || (r.f && r.sec === SECTION.body && !r.f.hidden)) && locatable(w, r.id, r.sid || '') ? LOC_BTN : '') + setupBtn(w, r.id) +
          '</td><td data-t="' + esc(r.type) + '">' + hl(r.label) + '</td><td class="mut ty">' + esc(r.type) + '</td><td class="v"' + (r.f && r.f.pending ? ' title="Loading the name\u2026"' : '') + ' data-val="' + esc(raw) + '">' +
          /* Sublist hits: only the values are marked, not their "L2: " prefixes. */
          (r.hits ? r.hits.map(function (x) { return 'L' + x.line + ': ' + hl(x.s); }).join('; ') : pend(hl(r.value), r.f && r.f.pending)) +
          (r.f && r.f.text && r.f.text !== r.f.value ? '<span class="t">' + hl(disp(r.f.value)) + '</span>' : '') + '</td></tr>';
      });
      html += '</table>';
      if (!count) html = '<div class="empty">Nothing matches \u201C' + esc(S.q) + '\u201D in any section.</div>';
      ft = count + ' match' + (count === 1 ? '' : 'es') + ' in all sections' +
        (rs !== 'ready' && recKey(w) ? ' (open Not on form to include fields the form does not show)' : '');
    } else if (S.tab === 'cmp' && src === 'saved' && (rs !== 'ready' || !REC.fmtDone)) {
      /* Ready but N/format not in yet: still loading (dates would be compared in the wrong format). */
      html = cmpBar(w, src) + '<div class="empty">' + recWait(rs === 'ready' ? 'loading' : rs, w) + '</div>';
      ft = rs === 'loading' ? 'Loading the saved record\u2026' : 'Could not compare with the saved record';
    } else if (S.tab === 'cmp') {
      /* Pinned: the pin against the page. Saved (edit mode): the saved record against the form as it is now. */
      var saved = src === 'saved', pair = saved ? savedPair(w, loadedRec(w)) : null;
      var every = saved ? compareRows(pair.saved, pair.cur) : compareRows(PIN, snapshot(w, !view)), diffs = every.filter(function (r) { return r.chg; });
      if (saved) savedLineNames(pair, every);
      /* No badge while the saved record is still being read: the count would only grow. */
      cmp.count = saved && pair.pending ? null : diffs.length; cmp.at = here;
      $('[data-tab="cmp"] .n').textContent = cmp.count == null ? '' : String(cmp.count);
      var crow = sortRows((S.cmpAll ? every : diffs).filter(function (r) { return keep({ id: r.line ? '' : r.id, label: r.label }, [r.pin, r.cur]); }),
        function (r, k) { return r[k]; });
      html = cmpBar(w, src);
      csv.push(['where', 'id', 'label', saved ? 'saved' : 'pinned', saved ? 'form' : 'current', 'change']);
      if (!crow.length) html += '<div class="empty">' + (diffs.length ? 'No differences match the search or filters.' : saved && pair.pending ? 'No differences so far; still reading the saved record\u2026' : saved ? 'No differences: this form matches the saved record.' : 'No differences: this record matches the pinned one.') + '</div>';
      else {
        html += '<table><tr>' + th('Where', 'sec') + th('Field ID', 'id') + th('Label', 'label') + th(saved ? 'Saved record' : 'Pinned', 'pin') + th(saved ? 'This form (unsaved edits)' : 'Current', 'cur') + th('Change', 'chg') + '</tr>';
        crow.forEach(function (r) {
          count++;
          csv.push([r.sec, r.line ? '' : r.id, r.label, r.pin, r.cur, r.chg || 'same']);
          /* A line added or removed has no field ID cell; data-key lets a render keep keyboard focus on its row. */
          html += '<tr' + (r.chg ? ' class="c-' + r.chg + '"' : '') + (r.line ? ' data-key="' + esc(r.sec + ':' + r.chg) + '"' : '') + '><td class="sec">' + esc(r.sec) + '</td>' +
            (r.line ? '<td class="mut">line</td>' : '<td class="' + idCls(r.id) + '" data-id="' + esc(r.id) + '"' + (r.sid ? ' data-sub="' + esc(r.sid) + '"' : '') + '>' + hl(r.id) + setupBtn(w, r.id) + '</td>') +
            '<td>' + hl(r.label) + '</td><td class="v old" data-val="' + esc(r.pin) + '">' + hl(r.pin) + '</td><td class="v" data-val="' + esc(r.cur) + '">' + hl(r.cur) + '</td>' +
            '<td class="chg">' + esc(r.chg || 'same') + '</td></tr>';
        });
        html += '</table>';
      }
      ft = diffs.length + ' difference' + (diffs.length === 1 ? '' : 's') + (saved ? ' between the saved record and this form' : ' from the pinned ' + pinName(PIN)) + (crow.length !== diffs.length || S.cmpAll ? ' (' + crow.length + ' shown)' : '') +
        (saved && pair.pending ? ' \u2022 reading the saved record\u2026' : '') +
        /* N/format never loaded (fmtDone by its timeout or an error): saved dates are M/D/YYYY. */
        (saved && REC.fmtDone && !REC.fmt ? ' \u2022 saved dates shown as M/D/YYYY (N/format did not load), so a date may differ only in format' : '');
    } else if (S.tab === 'rec' && rs !== 'ready') {
      html = '<div class="empty">' + recWait(rs, w) + '</div>';
    } else if (S.tab === 'body' || S.tab === 'rec') {
      var c = collectBody(w, S.tab === 'rec');
      var list = S.tab === 'body' ? c.body : c.rec;
      html = '<table><tr>' + th('Field ID', 'id') + th('Label', 'label') + th('Type', 'type') + th('Value', 'value') + '</tr>';
      csv.push(['id', 'label', 'type', 'required', 'value', 'text']);
      var rows = sortRows(list.filter(function (f) { return keep(f, [f.value, f.text]); }), function (f, k) {
        return k === 'value' ? disp(f.text && f.text !== f.value ? f.text : f.value) : f[k];
      });
      rows.forEach(function (f) {
        count++;
        csv.push([f.id, f.label, f.type, f.required, disp(f.value), disp(f.text)]);
        html += '<tr' + rowAttrs(f) + '><td class="' + idCls(f.id) + '" data-id="' + esc(f.id) + '">' + hl(f.id) + (S.tab === 'body' && !f.hidden && locatable(w, f.id, '') ? LOC_BTN : '') + setupBtn(w, f.id) + '</td><td data-t="' + esc(f.type) + '">' + hl(f.label) + (f.required ? ' <span class="req">*</span>' : '') +
          '</td><td class="mut ty">' + esc(f.type) + '</td><td class="v"' + (f.pending ? ' title="Loading the name\u2026"' : '') + ' data-val="' + esc(disp(f.value)) + '">' + pend(hl(disp(f.text && f.text !== f.value ? f.text : f.value)), f.pending) +
          (f.text && f.text !== f.value ? '<span class="t">' + hl(disp(f.value)) + '</span>' : '') + '</td></tr>';
      });
      html += '</table>';
      ft = count + ' of ' + list.length + ' fields';
    } else {
      var ids = sublistIds(w).filter(function (s) { return !!sublistCols(w, s); }), counts = newMap();
      ids.forEach(function (s) {
        var n = -1, r = !machine(w, s) && loadedRec(w);
        try { n = r ? r.getLineCount({ sublistId: s }) : w.nlapiGetLineItemCount(s); } catch (e) {}
        counts[s] = n;
      });
      /* Default to the first sublist that has lines (NetSuite may list empty ones first). */
      if (ids.indexOf(S.sub) < 0) S.sub = ids.filter(function (s) { return counts[s] > 0; })[0] || ids[0] || '';
      /* While searching, open a sublist that has matches if the current one has none. */
      if (found && found.sub.length && !found.sub.some(function (o) { return o.sid === S.sub; })) S.sub = found.sub[0].sid;
      /* The sublist picker: one pill per sublist with its line count (its match count while searching).
       * Sublists with lines (or matches) come first; the empty ones fold into one "+N empty" button
       * (S.emptySubs), and stay open while one of them is selected. The tooltip has the page's own label. */
      var hitsBy = newMap();
      if (found) found.sub.forEach(function (o) { hitsBy[o.sid] = (hitsBy[o.sid] || 0) + 1; });
      var pills = ids.map(function (s, i) {
        var n = found ? (hitsBy[s] || 0) : counts[s];
        return { s: s, n: n, zero: found ? !hitsBy[s] : counts[s] <= 0, i: i };
      });
      pills.sort(function (a, b) { return (a.zero - b.zero) || (a.i - b.i); });
      var nEmpty = pills.filter(function (p) { return p.zero; }).length;
      var openEmpty = S.emptySubs || pills.some(function (p) { return p.zero && p.s === S.sub; });
      /* The pills are a tablist (roving tabindex, arrow keys); "+N empty" is an ordinary button after it, so the
       * tablist holds only tabs. .stl is display:contents, so all of them still wrap as one row. */
      $('.subtabs').innerHTML = '<div class="stl" role="tablist" aria-label="Sublists">' + pills.filter(function (p) { return !p.zero || openEmpty; }).map(function (p) {
        var s = p.s, tabEl = w.document.getElementById(s + 'txt'), lbl = tabEl && tabEl.getAttribute('data-nsps-label');
        return '<button data-subtab="' + esc(s) + '" role="tab" aria-selected="' + (s === S.sub) + '" class="' + (s === S.sub ? 'on' : '') + (p.zero ? ' zero' : '') + '" title="' +
          esc((lbl ? lbl + ' (' + s + ')' : s) + (found ? ': ' + p.n + ' match' + (p.n === 1 ? '' : 'es') : ': ' + (counts[s] >= 0 ? counts[s] : '?') + ' line' + (counts[s] === 1 ? '' : 's'))) + '">' +
          esc(s) + '<span class="n">' + (p.n >= 0 ? p.n : '') + '</span></button>';
      }).join('') + '</div>' + (nEmpty ? '<button class="more" data-act="emptysubs" aria-expanded="' + openEmpty + '" title="' + (openEmpty ? 'Hide' : 'Show') + ' the sublists with ' + (found ? 'no matches' : 'no lines') + '">' +
        (openEmpty ? 'Hide ' + nEmpty + (found ? '' : ' empty') : '+' + nEmpty + (found ? ' more' : ' empty')) + '</button>' : '');
      var d = S.sub ? sublistData(w, S.sub, LINE_CAP) : null;
      if (!d) { html = '<div class="empty">' + (rs === 'loading' ? 'Loading the saved record\u2026' : 'No sublist data on this form.') + '</div>'; }
      else {
        var head = ['id', 'label', 'type'], hr = '<tr>' + th('Field ID', 'id') + th('Label', 'label') + th('Type', 'type'), i;
        for (i = 1; i <= d.shown; i++) { hr += th('L' + i, 'L' + i); head.push('line ' + i); }
        csv.push(head);
        html = '<table>' + hr + '</tr>';
        var srows = sortRows(d.cols.filter(function (cc) { return keep(cc, lineText(cc)); }), function (cc, k) {
          var n = /^L(\d+)$/.exec(k);
          if (!n) return cc[k];
          var x = cc.vals[+n[1] - 1];
          return x ? disp(x.t || x.v) : '';
        });
        srows.forEach(function (cc) {
          var vals = lineText(cc);
          count++;
          var row = [cc.id, cc.label, cc.type].concat(vals.map(disp));
          csv.push(row);
          html += '<tr><td class="' + idCls(cc.id) + '" data-id="' + esc(cc.id) + '" data-sub="' + esc(d.id) + '">' + hl(cc.id) + (locatable(w, cc.id, d.id) ? LOC_BTN : '') + setupBtn(w, cc.id) + '</td><td data-t="' + esc(cc.type) + '">' + hl(cc.label) + '</td><td class="mut ty">' + esc(cc.type) + '</td>';
          cc.vals.forEach(function (x, k) { html += '<td class="v" data-val="' + esc(disp(x.v)) + '" title="' + esc(disp(x.v)) + '">' + hl(disp(x.t || x.v)) + '</td>'; });
          html += '</tr>';
        });
        html += '</table>';
        ft = count + ' of ' + d.cols.length + ' fields, ' + d.count + ' line' + (d.count === 1 ? '' : 's') + (d.count > d.shown ? ' (first ' + d.shown + ' shown)' : '');
      }
    }
    if (view) {
      if (rs === 'loading') ft += ' \u2022 view mode: loading the saved record\u2026';
      else if (rs === 'ready') ft += ' \u2022 view mode: values from the saved record';
      else if (rs === 'error') ft += ' \u2022 view mode: could not load the record (' + REC.err + '), showing page text';
    } else if (rs === 'ready' && S.tab === 'rec') ft += ' \u2022 saved values; unsaved edits are not shown';
    if (rs === 'ready' && S.tab === 'rec') drainFallback();
    /* The loading bar runs while anything is still on its way: the record, background names, or (on
     * Not on form) the slow fallback names. */
    $('.load').classList.toggle('hid', !(rs === 'loading' || (rs === 'ready' && (REC.pendingNames || (S.tab === 'rec' && (REC.fallback.length || REC.draining)) ||
      (S.tab === 'cmp' && src === 'saved' && workPending())))));
    if (rs === 'ready' && (REC.pendingNames || (S.tab === 'rec' && REC.fallback.length))) ft += ' \u2022 loading names\u2026';
    var cfn = cfNote();
    if (cfn) ft += ' \u2022 ' + cfn.text;
    lastCsvRows = csv;
    /* The sublists question belongs to the Body CSV; anything else on show drops it. */
    if (S.dlAsk && (S.help || S.preview !== 'csv' || S.tab !== 'body')) S.dlAsk = false;
    /* View: show the export here instead of the table. CSV is the current table (it follows the tab,
     * search and filters), except on the Sublists tab, where it is the selected sublist with one row per line
     * (sublistCsvRows): its 500 lines are read only here, while View Raw shows CSV, never for the table.
     * JSON and XML are the whole record, as Copy gives them. */
    if (S.preview) {
      var sd = S.preview === 'csv' && S.tab === 'sub' && S.sub ? sublistData(w, S.sub, 500) : null;
      lastCsvSub = sd ? sd.id : ''; lastCsvScope = sd ? sublistScope(sd) : '';
      var jo = S.preview === 'json' ? jsonData(w) : null;
      lastPreview = S.preview === 'csv' ? toCsv(sd ? sublistCsvRows(sd, keep) : lastCsvRows) : jo ? JSON.stringify(jo, null, 2) : buildXml(w);
      /* The CSV note: on Sublists, which sublist it is; elsewhere, that a sublist with every line is a Sublists-tab
       * export (only when the record has a sublist), with a button that goes there. */
      var pvn = S.preview !== 'csv' ? '' : sd ? 'This CSV is the <b>' + esc(sd.id) + '</b> sublist, one row per line. Pick another sublist above to export that one.' :
        sublistIds(w).some(function (sid) { return !!sublistCols(w, sid); }) ? 'This CSV is the ' + esc(TAB_NAME[S.tab]) + ' table. To download a sublist with every line, one row per line, ' +
        '<button type="button" class="lk" data-act="pvsub">open it on Sublists</button>.' : '';
      html = previewHtml(lastPreview, pvn, jo && S.jsonView === 'tree' ? jo : null);
      if (JT.data) JT.shown = here;
      var nLines = lastPreview ? lastPreview.split('\n').length : 0;
      ft = S.preview.toUpperCase() + ': ' + (sd ? lastCsvScope : nLines.toLocaleString() + ' line' + (nLines === 1 ? '' : 's')) + ', ' + lastPreview.length.toLocaleString() + ' characters' +
        (sd ? '' : S.preview === 'csv' ? ' (the ' + TAB_NAME[S.tab] + ' table)' : ' (body fields and sublist lines)') +
        (filterNote() ? ' \u2022 filtered: ' + filterNote() : '') +
        (rs === 'ready' && REC.pendingNames ? ' \u2022 loading names\u2026' : '');
    }
    if (S.help) { html = HELP_HTML; ft = 'Help'; JT.data = null; JT.shown = ''; }
    main.innerHTML = html;
    if (!S.help && !S.preview) applyColWidths();
    var ftEl = root.querySelector('.ft');
    ftEl.textContent = ft;
    ftEl.title = !S.help && cfn ? 'NetSuite said: ' + cfn.tip : '';
  }

  /* If names are still arriving in the background (multi-selects), wait for them, up to 3 s, so a copy or
   * download isn't the half-finished version; the click still counts as recent enough for the clipboard. */
  function whenNamesReady(fn) {
    if (!(REC.state === 'ready' && REC.pendingNames)) { fn(); return; }
    toast('Waiting for names\u2026');
    var t0 = Date.now(), wait = function () { if (closed) return; if (REC.pendingNames && Date.now() - t0 < 3000) setTimeout(wait, 100); else fn(); };
    wait();
  }
  /* Saves text as a file through a temporary download link on a Blob (no server, nothing leaves the
   * browser). Named <type>-<id or new>.<ext>, and a Sublists-tab CSV <type>-<id or new>-<sublist>.csv; CSV
   * starts with a byte order mark so Excel reads accents. */
  var lastFile = '';
  var FILE_TYPES = { json: 'application/json', csv: 'text/csv;charset=utf-8', xml: 'application/xml' };
  function saveFile(text, fmt, sid) {
    if (sid == null) sid = lastCsvSub;
    var w = findTarget(), m = w ? meta(w) : {}, a, url, sub = fmt === 'csv' && validId(sid) ? '-' + sid : '';
    lastFile = (String(m.type || 'record') + '-' + String(m.id || 'new') + sub).replace(/[^A-Za-z0-9_.-]+/g, '_') + '.' + fmt;
    try {
      url = URL.createObjectURL(new Blob([(fmt === 'csv' ? String.fromCharCode(0xFEFF) : '') + text], { type: FILE_TYPES[fmt] }));
      a = document.createElement('a');
      a.href = url; a.download = lastFile; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      return true;
    } catch (e) { return false; }
  }

  /* ---------- panel events ---------- */
  root.addEventListener('click', function (e) {
    var t = e.target, tabEl = t.closest && t.closest('[data-tab]'), actEl = t.closest && t.closest('[data-act]');
    var tab = tabEl && tabEl.getAttribute('data-tab'), act = actEl && actEl.getAttribute('data-act');
    /* The three menus: their buttons open and close them; clicks inside one keep it open (its own actions
     * close it where that makes sense); any other click in the panel closes it. */
    if (act === 'settings' || act === 'filter' || act === 'pin') { setPop(openPop === act ? '' : act); return; }
    var kindEl = t.closest && t.closest('[data-kind]');
    if (kindEl) { S.kind = kindEl.getAttribute('data-kind'); render(); return; }
    if (act === 'clearfilters') { S.hideEmpty = false; S.kind = 'all'; render(); return; }
    if (act === 'dopin') { setPop('', true); pinNow(); return; }
    if (act === 'opencmp' || act === 'cmpsaved') {
      setPop('', true); S.help = false; S.preview = ''; S.tab = 'cmp'; S.sortKey = ''; S.sortDir = 0; S.cmpSrc = act === 'cmpsaved' ? 'saved' : 'pin';
      if (act === 'cmpsaved') { var cw = findTarget(); S.cmpSavedKey = canCmpSaved(cw) ? recKey(cw) : ''; }
      render(); return;
    }
    if (openPop && POPS[openPop].contains(t) && act !== 'unpin') return;
    setPop('', act === 'unpin');
    var mcEl = t.closest && t.closest('[data-mcopy]');
    if (mcEl) { var mv = mcEl.getAttribute('data-v') || ''; if (mv) copy(mv, mv); return; }
    if (act === 'emptysubs') { S.emptySubs = !S.emptySubs; render(); return; }
    if (act === 'inspectoff') { S.inspect = false; detachInspect(); render(); toast('Inspect off'); return; }
    if (act === 'qclear') {
      /* Same as emptying the box by hand: the input handler goes back to the tab the search started from. */
      var qi = $('[data-q]');
      qi.value = '';
      qi.dispatchEvent(new Event('input', { bubbles: true }));
      qi.focus();
      return;
    }
    if (act === 'help') { S.help = !S.help; render(); return; }
    if (act === 'helpclose') { S.help = false; render(); return; }
    if (tab) { S.help = false; S.tab = tab; S.sortKey = ''; S.sortDir = 0; if (tab !== 'all') S.prevTab = tab; render(); return; }
    var srcEl = t.closest && t.closest('[data-cmpsrc]');
    if (srcEl) { S.cmpSrc = srcEl.getAttribute('data-cmpsrc') === 'saved' ? 'saved' : 'pin'; S.sortKey = ''; S.sortDir = 0; render(); return; }
    var pvEl = t.closest && t.closest('[data-pv]');
    if (pvEl) { S.preview = S.pvLast = pvEl.getAttribute('data-pv'); render(); return; }
    var jvEl = t.closest && t.closest('[data-jv]');
    if (jvEl) { S.jsonView = jvEl.getAttribute('data-jv') === 'tree' ? 'tree' : 'text'; saveLayout(); render(); return; }
    /* The JSON tree: a click on an item's own row (not the space beside its children) opens, closes or copies it. */
    var jrEl = t.closest && t.closest('.jt .jr');
    if (jrEl) { jtActivate(jrEl.parentNode); return; }
    if (act === 'view') { S.help = false; S.preview = S.preview ? '' : (S.pvLast || 'json'); render(); return; }
    if (act === 'pvclose') { S.preview = ''; render(); return; }
    if (act === 'pvsub') { S.help = false; S.tab = S.prevTab = 'sub'; S.sortKey = ''; S.sortDir = 0; render(); return; }
    /* Download on the Body CSV of a record with sublist lines asks first (S.dlAsk): Body only, or Body and one CSV
     * per sublist with lines (sublistCsvRows, the same as the Sublists-tab CSV), saved a moment apart. Download
     * again while it asks puts the question away. */
    if (act === 'pvdl' && S.preview === 'csv' && S.tab === 'body') {
      var dw = findTarget();
      if (S.dlAsk) { S.dlAsk = false; render(); return; }
      if (dw && allSublists(dw).length) { S.dlAsk = true; render(); var b1 = main.querySelector('[data-act="dlall"]'); if (b1) b1.focus({ preventScroll: true }); return; }
    }
    if (act === 'dlcancel') { S.dlAsk = false; render(); var dbt = main.querySelector('[data-act="pvdl"]'); if (dbt) dbt.focus({ preventScroll: true }); return; }
    if (act === 'dlbody' || act === 'dlall') {
      S.dlAsk = false;
      whenNamesReady(function () {
        if (closed || S.preview !== 'csv') return;
        render();
        var dlBtn = main.querySelector('[data-act="pvdl"]'); if (dlBtn) dlBtn.focus({ preventScroll: true });
        var filtered = filterNote() ? ' (filtered)' : '', subs = [], keep = makeKeep(), w2 = findTarget();
        if (!saveFile(lastPreview, 'csv', '')) { toast('Download blocked by the browser'); return; }
        var first = lastFile;
        if (act === 'dlall' && w2) allSublists(w2).forEach(function (d) {
          var rows = sublistCsvRows(d, keep);
          if (!validId(d.id) || rows[0].length < 2) return;
          subs.push(d.id);
          setTimeout(function () { if (!closed) saveFile(toCsv(rows), 'csv', d.id); }, 400 * subs.length);
        });
        toast('Downloaded ' + first + filtered + (subs.length ? ' and ' + nOf(subs.length, 'sublist file') + ' (' + subs.join(', ') + '). If the browser asks, allow multiple downloads.' : ''));
      });
      return;
    }
    if (act === 'pvcopy' || act === 'pvdl') {
      /* Copies or downloads the format being viewed, once the names still arriving are in (see whenNamesReady). */
      whenNamesReady(function () {
        if (closed || !S.preview) return;
        render();
        /* A Sublists-tab CSV says which sublist and how many of its lines it holds. */
        var fmt = S.preview.toUpperCase(), note = filterNote() ? ', filtered' : '', scope = lastCsvScope ? lastCsvScope + ', ' : '';
        var dlNote = [lastCsvScope, note ? 'filtered' : ''].filter(Boolean).join(', ');
        if (act === 'pvcopy') copy(lastPreview, fmt + ' (' + scope + lastPreview.length.toLocaleString() + ' characters' + note + ')');
        else toast(saveFile(lastPreview, S.preview) ? 'Downloaded ' + lastFile + (dlNote ? ' (' + dlNote + ')' : '') : 'Download blocked by the browser');
      });
      return;
    }
    var subEl = t.closest && t.closest('[data-subtab]');
    if (subEl) { S.sub = subEl.getAttribute('data-subtab'); S.sortKey = ''; S.sortDir = 0; render(); return; }
    /* The column width grip sits inside the header: a click (the end of a drag) must not sort. */
    if (t.closest && t.closest('.cw')) return;
    var sortTh = t.closest && t.closest('th[data-sort]');
    if (sortTh) {
      var k = sortTh.getAttribute('data-sort');
      if (S.sortKey !== k) { S.sortKey = k; S.sortDir = 1; }
      else if (S.sortDir === 1) S.sortDir = -1;
      else { S.sortKey = ''; S.sortDir = 0; }
      render();
      return;
    }
    if (act === 'close') { saveLayout(); host.__nsfeCleanup(); host.remove(); return; }
    if (act === 'min') { setMin(!panelEl.classList.contains('min')); saveLayout(); return; }
    if (act === 'unpin') {
      PIN = null; cmp.count = null;
      try { sessionStorage.removeItem(PIN_KEY); } catch (e) {}
      /* render() leaves Compare unless it can still compare with the saved record. */
      render(); toast('Unpinned'); return;
    }
    if (act === 'refresh') { REC = blankRec(); CF = blankCF(); jtReset(); render(); toast('Refreshed'); return; }
    if (act === 'inspect') { S.inspect = !S.inspect; if (!S.inspect) detachInspect(); render(); toast(S.inspect ? 'Inspect on (Esc to stop)' : 'Inspect off'); return; }
    if (t.closest && t.closest('a.cf')) return;
    var td = t.closest && t.closest('td');
    if (act === 'locate' && td) { locate(td.getAttribute('data-id'), td.getAttribute('data-sub') || ''); return; }
    if (td && td.classList.contains('id')) { var cid = td.getAttribute('data-id'), csn = snippet(cid, td.getAttribute('data-sub') || '', 1); copy(csn, csn === cid ? cid : 'SuiteScript line for ' + cid); }
    else if (td && td.classList.contains('v')) { copy(td.getAttribute('data-val'), 'value'); }
  });
  root.addEventListener('input', function (e) {
    if (e.target.hasAttribute('data-q')) {
      /* Starting a search shows the All tab (results from every section); clearing it goes back. */
      var was = !!S.q;
      S.q = e.target.value;
      if (S.q && !was && S.tab !== 'cmp') { S.prevTab = S.tab === 'all' ? S.prevTab : S.tab; S.tab = 'all'; S.sortKey = ''; S.sortDir = 0; }
      if (!S.q && S.tab === 'all') { S.tab = S.prevTab || 'body'; S.sortKey = ''; S.sortDir = 0; }
      render();
    }
    var chk = e.target.getAttribute('data-chk');
    if (chk === 'compact') { S.compact = e.target.checked; applyDisplay(); saveLayout(); return; }
    if (chk) { S[chk] = e.target.checked; render(); }
  });
  root.addEventListener('change', function (e) {
    var sel = e.target.getAttribute('data-sel');
    if (sel === 'theme') { S.theme = e.target.value; applyDisplay(); saveLayout(); return; }
    if (sel === 'kind') { S.kind = e.target.value; render(); return; }
    if (sel === 'fmt') { S.fmt = e.target.value; saveLayout(); toast('Click now copies: ' + e.target.options[e.target.selectedIndex].text); }
  });

  /* ---------- keyboard ----------
   * The section switch and the sublist row are tablists: Left / Right (Home / End) move to a tab and open it,
   * and only the selected tab is in the Tab order. The table is one Tab stop (a grid with a roving tabindex):
   * the arrow keys move between cells, Right from a field ID reaches its eye and setup link, and Enter or Space
   * on a header, field ID or value does what a click does. One Tab stop per table, because a record has
   * hundreds of copyable cells. Focus is kept across renders (focusSpot / refocus), since a render replaces
   * the table and the sublist row. */
  var STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
  /* What Left and Right step through in a table row: each cell, then the eye and setup link inside it. */
  function cellStops(c) { return Array.prototype.slice.call(c.querySelectorAll('button, a[href]')); }
  function rowStops(tr) {
    var out = [];
    Array.prototype.forEach.call(tr.cells, function (c) { out.push(c); out.push.apply(out, cellStops(c)); });
    return out;
  }
  function gridOf(el) { var tb = el && el.closest && el.closest('table'); return tb && main.contains(tb) ? tb : null; }
  function rovingTo(tb, el) {
    Array.prototype.forEach.call(tb.querySelectorAll('[tabindex="0"]'), function (x) { if (x !== el) x.tabIndex = -1; });
    el.tabIndex = 0;
  }
  /* Focus a grid item without scrolling; an arrow-key move (scroll set) then brings it into view. A render only
   * puts focus back, so a table the user scrolled stays where it is. */
  function gridGo(tb, el, scroll) {
    rovingTo(tb, el);
    el.focus({ preventScroll: true });
    if (scroll) try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  }
  /* Roving tabindex for both tablists: the tab marked selected is the one in the Tab order. */
  function tabStops() {
    Array.prototype.forEach.call(root.querySelectorAll('.tabs [role="tab"], .stl [role="tab"]'), function (b) { b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1; });
  }
  /* After each render: the new table is a read-only grid whose first header cell is its Tab stop. */
  function gridSetup() {
    var tb = main.querySelector('table'), first = tb && tb.rows[0] && tb.rows[0].cells[0];
    if (!first) return;
    tb.setAttribute('role', 'grid');
    tb.setAttribute('aria-readonly', 'true');
    tb.setAttribute('aria-label', S.tab === 'sub' ? 'Sublist ' + S.sub : TAB_NAME[S.tab] || 'Fields');
    first.tabIndex = 0;
  }
  /* Where keyboard focus is in the parts a render replaces: a table cell (by its row's field, else its row
   * number, and its column), a control by its data attribute, else (a Help link) its place among them. */
  var SPOT_ATTRS = ['data-subtab', 'data-act', 'data-pv', 'data-jv', 'data-cmpsrc', 'data-chk', 'data-mcopy'], FOCUSABLE = 'a[href], button, input, select, [tabindex]';
  function rowKey(tr) { var c = tr.querySelector('td[data-id]'), k = tr.getAttribute('data-key'); return c ? (c.getAttribute('data-sub') || '') + ':' + c.getAttribute('data-id') : k ? 'key:' + k : ''; }
  /* The parts a render replaces: the table area, the sublist row and the title bar's record type, ID and document
   * number (setMeta rebuilds those when the record changes). */
  function inSpot(x) { return main.contains(x) || $('.subtabs').contains(x) || $('.meta').contains(x); }
  function focusSpot() {
    var a = root.activeElement, i;
    if (!a || !inSpot(a)) return null;
    /* A JSON tree item: by its path (refocus falls back to its nearest ancestor still on show). */
    if (a.getAttribute('role') === 'treeitem' && main.contains(a)) return { tree: a.getAttribute('data-path') || '' };
    var cell = gridOf(a) && a.closest('td, th');
    if (cell) return { row: cell.parentNode.rowIndex, key: rowKey(cell.parentNode), cell: cell.cellIndex, inner: a === cell ? -1 : cellStops(cell).indexOf(a) };
    for (i = 0; i < SPOT_ATTRS.length; i++) if (a.hasAttribute(SPOT_ATTRS[i])) return { attr: SPOT_ATTRS[i], v: a.getAttribute(SPOT_ATTRS[i]) };
    return { nth: Array.prototype.indexOf.call(main.querySelectorAll(FOCUSABLE), a) };
  }
  function refocus(s) {
    var tb = main.querySelector('table'), el = null, best = -1, jt = main.querySelector('.jt');
    if (s.tree != null && jt) {
      if ((el = jtFind(jt, s.tree) || jt.querySelector('[tabindex="0"]'))) { jtRove(el); el.focus({ preventScroll: true }); }
      return;
    }
    /* The tree is gone but View Raw is still open (Text chosen, or another format): its Tree / Text switch, else Close. */
    if (s.tree != null && (el = main.querySelector('[data-jv].on') || main.querySelector('[data-act="pvclose"]'))) { el.focus({ preventScroll: true }); return; }
    if (s.attr) {
      Array.prototype.forEach.call(root.querySelectorAll('[' + s.attr + ']'), function (x) {
        if (!el && x.getAttribute(s.attr) === s.v && inSpot(x)) el = x;
      });
      /* A title bar part that went away (a new record has no ID): another part, rather than the table. */
      if (el || (s.attr === 'data-mcopy' && (el = $('.meta button')))) { el.focus({ preventScroll: true }); return; }
    }
    if (s.nth >= 0 && (el = main.querySelectorAll(FOCUSABLE)[s.nth])) { el.focus({ preventScroll: true }); return; }
    if (!tb) return;
    if (s.row != null) {
      /* The same field's row (the nearest one if a field has several, as on Compare), else the same row number. */
      var tr = null;
      if (s.key) Array.prototype.forEach.call(tb.rows, function (r) {
        var d = Math.abs(r.rowIndex - s.row);
        if (rowKey(r) === s.key && (best < 0 || d < best)) { tr = r; best = d; }
      });
      tr = tr || tb.rows[Math.min(s.row, tb.rows.length - 1)];
      var c = tr && tr.cells[Math.min(s.cell, tr.cells.length - 1)];
      el = c && s.inner >= 0 ? cellStops(c)[s.inner] || c : c;
    }
    /* The control that had focus is gone (Close on Help or View Raw): the table's Tab stop. */
    el = el || tb.querySelector('[tabindex="0"]');
    if (el) gridGo(tb, el);
  }
  root.addEventListener('keydown', function (e) {
    var t = e.target, k = e.key;
    if (e.altKey || e.ctrlKey || e.metaKey || !t.closest) return;
    if (t.getAttribute('role') === 'tab' && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End')) {
      var tabs = Array.prototype.filter.call(t.parentNode.querySelectorAll('[role="tab"]'), function (b) { return !b.classList.contains('hid'); });
      var i = tabs.indexOf(t), n = k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : (i + STEP[k] + tabs.length) % tabs.length;
      e.preventDefault();
      /* Focus first: the click renders, and the render keeps focus where it is (a new sublist pill). */
      if (tabs[n] && tabs[n] !== t) { tabs[n].focus(); tabs[n].click(); }
      return;
    }
    if (t.getAttribute('role') === 'treeitem' && main.contains(t)) { jtKeydown(e, t); return; }
    var tb = gridOf(t), cell = tb && t.closest('td, th');
    if (!cell) return;
    if (k === 'Enter' || k === ' ') {
      /* On the cell itself (Space must not scroll the table); the eye and the setup link are a real button and
       * link and handle these keys. */
      if (t !== cell) return;
      e.preventDefault();
      if (cell.matches('th[data-sort], td.id, td.v')) cell.click();
      return;
    }
    var to = null, tr = cell.parentNode;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
      var stops = rowStops(tr), si = stops.indexOf(t);
      to = k === 'Home' ? stops[0] : k === 'End' ? stops[stops.length - 1] : stops[si + STEP[k]];
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      var r2 = tb.rows[tr.rowIndex + STEP[k]];
      to = r2 && r2.cells[Math.min(cell.cellIndex, r2.cells.length - 1)];
    } else return;
    e.preventDefault();
    if (to) gridGo(tb, to, true);
  });
  /* A click on the eye or setup link (or a cell already visited) makes it the table's Tab stop. */
  root.addEventListener('focusin', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('role') === 'treeitem' && main.contains(e.target)) { jtRove(e.target); return; }
    var tb = gridOf(e.target);
    if (tb && e.target.tabIndex !== 0 && e.target.closest('td, th')) rovingTo(tb, e.target);
  });
  /* Drag by the title bar. Pointer capture keeps the move and release events coming to the title bar
   * even when the pointer is over NetSuite's form iframe; with plain document mouse events the iframe
   * swallowed them, the drag stopped, and the panel then stuck to the mouse until the next click. */
  (function drag() {
    var h = $('[data-drag]'), sx, sy, ox, oy, on = false;
    h.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || (e.target.closest && e.target.closest('button, a'))) return;
      var r = host.getBoundingClientRect(); on = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { h.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    h.addEventListener('pointermove', function (e) {
      if (!on) return;
      host.style.left = Math.min(Math.max(0, ox + e.clientX - sx), Math.max(0, window.innerWidth - 160)) + 'px';
      host.style.top = Math.min(Math.max(0, oy + e.clientY - sy), Math.max(0, window.innerHeight - 40)) + 'px';
      host.style.right = 'auto';
    });
    function end() { if (!on) return; on = false; saveLayout(); }
    h.addEventListener('pointerup', end);
    h.addEventListener('lostpointercapture', end);
  })();

  /* Resize from any edge or corner (the .rz handles), like a window: the opposite edge stays put, the
   * panel stays inside the window and no smaller than MIN_W x MIN_H. Pointer capture, as for dragging,
   * so resizing over the form iframe works. */
  var MIN_W = 380, MIN_H = 220;
  (function resize() {
    Array.prototype.forEach.call(root.querySelectorAll('[data-rz]'), function (hd) {
      var st = null, dir = hd.getAttribute('data-rz');
      hd.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        var r = host.getBoundingClientRect();
        st = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
        host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.right = 'auto';
        try { hd.setPointerCapture(e.pointerId); } catch (x) {}
        e.preventDefault(); e.stopPropagation();
      });
      hd.addEventListener('pointermove', function (e) {
        if (!st) return;
        var dx = e.clientX - st.x, dy = e.clientY - st.y, l = st.l, t = st.t, w = st.w, h = st.h;
        var W = document.documentElement.clientWidth || window.innerWidth, H = document.documentElement.clientHeight || window.innerHeight;
        if (dir.indexOf('e') >= 0) w = Math.min(Math.max(MIN_W, st.w + dx), W - st.l);
        if (dir.indexOf('s') >= 0) h = Math.min(Math.max(MIN_H, st.h + dy), H - st.t);
        if (dir.indexOf('w') >= 0) { l = Math.min(Math.max(0, st.l + dx), st.l + st.w - MIN_W); w = st.w + st.l - l; }
        if (dir.indexOf('n') >= 0) { t = Math.min(Math.max(0, st.t + dy), st.t + st.h - MIN_H); h = st.h + st.t - t; }
        host.style.left = Math.round(l) + 'px'; host.style.top = Math.round(t) + 'px';
        panelEl.style.width = Math.round(w) + 'px'; panelEl.style.height = Math.round(h) + 'px';
      });
      function end() { if (!st) return; st = null; saveLayout(); }
      hd.addEventListener('pointerup', end);
      hd.addEventListener('lostpointercapture', end);
    });
  })();

  /* ---------- column widths: drag the grip on the right edge of a column header ----------
   * Widths are kept per table (Body and Not on form share one, since they have the same columns) and are
   * remembered with the layout. A table nobody has resized keeps the automatic layout. Once one of its
   * columns is dragged, the table switches to a fixed layout with every column's width set, so the other
   * columns don't jump; a column with no saved width (a new line column, for example) keeps its automatic
   * width. The table can then be wider than the panel, which scrolls. Double-clicking a grip goes back to
   * automatic widths for that table. Widths are set through the CSSOM (NetSuite's CSP). */
  var COLW_MIN = 40, COLW_MAX = 2000, COLW_KEY = /^[A-Za-z0-9_]{1,40}$/, COLW_KINDS = ['all', 'body', 'sub', 'cmp'];
  var COLW = newMap();
  function colKind() { return S.tab === 'rec' ? 'body' : S.tab; }
  function headCells(tb) {
    return tb && tb.rows[0] ? Array.prototype.filter.call(tb.rows[0].cells, function (c) { return c.hasAttribute('data-sort'); }) : [];
  }
  function fixCols(tb, cells, widths) {
    var sum = 0;
    cells.forEach(function (c, i) { c.style.width = widths[i] + 'px'; sum += widths[i]; });
    tb.classList.add('cwset');
    tb.style.width = sum + 'px';
  }
  /* After each render: apply the saved widths, measuring the automatic width of any column without one. */
  function applyColWidths() {
    var k = colKind(), W = has(COLW, k) ? COLW[k] : null, tb = W && main.querySelector('table'), cells = headCells(tb);
    if (!cells.length) return;
    fixCols(tb, cells, cells.map(function (c) { var key = c.getAttribute('data-sort'); return has(W, key) ? W[key] : Math.round(c.getBoundingClientRect().width); }));
  }
  /* The drag works on column keys, not on the elements it started on: a render during the drag (names or
   * setup links arriving in the background) replaces the table, and the drag then carries on with the new one. */
  (function colResize() {
    var st = null;
    function widthsOf(cells, base) {
      return cells.map(function (c) { var k = c.getAttribute('data-sort'); return has(base, k) ? base[k] : Math.round(c.getBoundingClientRect().width); });
    }
    root.addEventListener('pointerdown', function (e) {
      var g = e.button === 0 && e.target.closest && e.target.closest('.cw'), th0 = g && g.parentNode;
      if (!th0 || !th0.hasAttribute('data-sort')) return;
      var tb = th0.closest('table'), cells = headCells(tb), base = newMap();
      widthsOf(cells, base).forEach(function (w, i) { base[cells[i].getAttribute('data-sort')] = w; });
      st = { key: th0.getAttribute('data-sort'), base: base, cur: base, x: e.clientX, kind: colKind() };
      fixCols(tb, cells, widthsOf(cells, base));
      g.classList.add('on');
      try { g.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault(); e.stopPropagation();
    });
    root.addEventListener('pointermove', function (e) {
      if (!st || colKind() !== st.kind) return;
      var tb = main.querySelector('table'), cells = headCells(tb), cur = newMap();
      Object.keys(st.base).forEach(function (k) { cur[k] = st.base[k]; });
      cur[st.key] = Math.round(Math.min(COLW_MAX, Math.max(COLW_MIN, st.base[st.key] + e.clientX - st.x)));
      if (cells.length) fixCols(tb, cells, widthsOf(cells, cur));
      st.cur = cur;
    });
    function end() {
      if (!st) return;
      var s = st, W = newMap(), old = has(COLW, s.kind) ? COLW[s.kind] : null;
      st = null;
      Array.prototype.forEach.call(root.querySelectorAll('.cw.on'), function (g) { g.classList.remove('on'); });
      /* Keep the widths of columns not in this table (line columns of a longer sublist), then this table's. */
      if (old) Object.keys(old).forEach(function (key) { W[key] = old[key]; });
      Object.keys(s.cur).forEach(function (key) { W[key] = s.cur[key]; });
      COLW[s.kind] = W;
      saveLayout();
      /* A render during the drag drew the table before these widths were saved. */
      applyColWidths();
    }
    root.addEventListener('pointerup', end);
    root.addEventListener('lostpointercapture', end);
    root.addEventListener('dblclick', function (e) {
      if (!(e.target.closest && e.target.closest('.cw'))) return;
      delete COLW[colKind()];
      saveLayout(); render(); toast('Column widths reset');
    });
  })();

  /* ---------- layout: collapse, and remember position, size, collapsed state and display settings ----------
   * Stored in this browser's localStorage for the NetSuite site. A saved position is pulled back inside
   * the window, so a panel saved on a big screen can't open off-screen on a small one. */
  var LAYOUT_KEY = 'nsfe.layout', panelEl = $('.p');
  function setMin(on) {
    panelEl.classList.toggle('min', on);
    var b = $('[data-act="min"]');
    b.innerHTML = on ? ICON.max : ICON.min;
    b.title = on ? 'Expand' : 'Collapse to the title bar';
    b.setAttribute('aria-label', on ? 'Expand' : 'Collapse');
  }
  /* Display settings (Help page): theme Auto / Light / Dark and Compact, as classes on the panel. */
  function applyDisplay() {
    panelEl.classList.toggle('light', S.theme === 'light');
    panelEl.classList.toggle('dark', S.theme === 'dark');
    panelEl.classList.toggle('compact', S.compact);
  }
  /* The menus (Settings, Filters, Pin): one open at a time, placed under its own button (the toolbar wraps,
   * so its height varies); a click anywhere else (panel or page), window blur or Esc closes it. */
  var menuEl = $('.menu'), POPS = { settings: menuEl, filter: $('.fpop'), pin: $('.ppop') }, openPop = '';
  /* Opening a menu moves focus to its first control; closing it with back set (Esc, or an action in the menu)
   * returns focus to the button that opened it. A click elsewhere or window blur leaves focus where it went. */
  function setPop(name, back) {
    var prev = openPop;
    openPop = name && POPS[name] ? name : '';
    if (openPop === 'settings') { $('[data-sel="theme"]').value = S.theme; $('[data-chk="compact"]').checked = S.compact; $('[data-sel="fmt"]').value = S.fmt; }
    if (openPop === 'pin') renderPin();
    Object.keys(POPS).forEach(function (k) {
      var pop = POPS[k], btn = $('[data-act="' + k + '"]'), on = k === openPop;
      pop.classList.toggle('hid', !on);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        var b = btn.getBoundingClientRect(), pr = panelEl.getBoundingClientRect();
        pop.style.top = Math.round(b.bottom - pr.top + 6) + 'px';
        pop.style.right = Math.max(8, Math.round(pr.right - b.right)) + 'px';
      }
    });
    if (openPop && openPop !== prev) (POPS[openPop].querySelector('select, input, button:not([disabled]):not(.hid), a[href]') || POPS[openPop]).focus({ preventScroll: true });
    else if (!openPop && prev && back) $('[data-act="' + prev + '"]').focus({ preventScroll: true });
  }
  function setMenu(on) { setPop(on ? 'settings' : ''); }
  /* Filters menu and button: the current settings, a red dot while any filter is on, Clear when one is. */
  function renderFilters() {
    var on = S.hideEmpty || S.kind !== 'all';
    $('[data-act="filter"] .dot').classList.toggle('hid', !on);
    $('[data-act="filter"]').title = on ? 'Filters are on: ' + [S.hideEmpty ? 'Hide empty' : '', S.kind === 'custom' ? 'Custom only' : S.kind === 'standard' ? 'Standard only' : ''].filter(Boolean).join(', ') : 'Filters: hide empty fields, show only custom or standard ones';
    $('[data-act="filter"]').setAttribute('aria-label', on ? 'Filters (on)' : 'Filters');
    $('[data-chk="hideEmpty"]').checked = S.hideEmpty;
    Array.prototype.forEach.call(root.querySelectorAll('[data-kind]'), function (b) { b.classList.toggle('on', b.getAttribute('data-kind') === S.kind); });
    $('[data-act="clearfilters"]').classList.toggle('hid', !on);
  }
  function onDocDown(e) { if (e.target !== host) setPop(''); }
  function onBlur() { setPop(''); }
  document.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('blur', onBlur);
  cleanupFns.push(function () { document.removeEventListener('pointerdown', onDocDown, true); window.removeEventListener('blur', onBlur); });
  function saveLayout() {
    try {
      var r = host.getBoundingClientRect();
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        left: host.style.left ? Math.round(r.left) : null, top: host.style.left ? Math.round(r.top) : null,
        w: panelEl.style.width || '', h: panelEl.style.height || '', min: panelEl.classList.contains('min'),
        theme: S.theme, compact: S.compact, fmt: S.fmt, jsonView: S.jsonView, colw: COLW
      }));
    } catch (e) {}
  }
  function restoreLayout() {
    var L = null, px = /^\d+(\.\d+)?px$/;
    try { L = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch (e) {}
    if (!L || typeof L !== 'object') return;
    if (L.theme === 'light' || L.theme === 'dark') S.theme = L.theme;
    S.compact = L.compact === true;
    if (L.fmt === 'ss1' || L.fmt === 'ss2') S.fmt = L.fmt;
    if (L.jsonView === 'tree') S.jsonView = 'tree';
    /* Column widths: only known tables, ID-like column keys and whole pixel widths in range. */
    if (L.colw && typeof L.colw === 'object') COLW_KINDS.forEach(function (k) {
      var src = has(L.colw, k) ? L.colw[k] : null, W = newMap(), n = 0;
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach(function (key) {
        var v = src[key];
        if (COLW_KEY.test(key) && typeof v === 'number' && v >= COLW_MIN && v <= COLW_MAX) { W[key] = Math.round(v); n++; }
      });
      if (n) COLW[k] = W;
    });
    applyDisplay();
    if (px.test(L.w)) panelEl.style.width = L.w;
    if (px.test(L.h)) panelEl.style.height = L.h;
    if (L.min === true) setMin(true);
    if (typeof L.left === 'number' && typeof L.top === 'number') {
      host.style.left = Math.min(Math.max(0, L.left), Math.max(0, window.innerWidth - 160)) + 'px';
      host.style.top = Math.min(Math.max(0, L.top), Math.max(0, window.innerHeight - 40)) + 'px';
      host.style.right = 'auto';
    }
  }
  restoreLayout();

  /* ---------- Pin and compare ----------
   * Pin keeps a snapshot of the record on the page (body fields as the Body tab lists them, and up to 500
   * lines of every sublist) in sessionStorage: it lasts while this browser tab is open, across page loads
   * and records, and no longer. The Compare tab diffs the record on the page against it: body fields
   * added, removed or changed, and per sublist the lines added or removed and the cells changed. For the
   * same record, lines are matched by lineuniquekey (or line) when every line on both sides has one, so a
   * reordered or inserted line is not a change; those keys are unique across the account, so two different
   * records are matched by position (sandbox: bill against bill showed every line removed and added). The
   * key columns themselves are never compared. Values
   * compare as text, except that two equal numbers (100 and 100.00) count as the same. A snapshot is only
   * data read back from this origin's storage: every ID is checked with validId and every value escaped. */
  var PIN_KEY = 'nsfe.pin', PIN_MAX = 2000000, PIN = loadPin(), cmp = { count: null, at: '' };
  function loadPin() {
    var p = null;
    try { p = JSON.parse(sessionStorage.getItem(PIN_KEY) || 'null'); } catch (e) {}
    return p && p.v === 1 && isObj(p.body) && isObj(p.subs) && Array.isArray(p.order) ? cleanPin(p) : null;
  }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  /* The stored pin is untrusted: keep only entries of the right shape, so a null sublist or line (planted,
   * or from a broken write) can't stop Compare from rendering. IDs are still checked where they are used. */
  function cleanPin(p) {
    var body = newMap(), subs = newMap();
    Object.keys(p.body).forEach(function (id) { if (Array.isArray(p.body[id])) body[id] = p.body[id]; });
    Object.keys(p.subs).forEach(function (sid) {
      var s = p.subs[sid], cols = newMap();
      if (!isObj(s) || !Array.isArray(s.lines)) return;
      if (isObj(s.cols)) Object.keys(s.cols).forEach(function (id) { cols[id] = s.cols[id]; });
      subs[sid] = { cols: cols, lines: s.lines.filter(isObj) };
    });
    return { v: 1, type: p.type, id: p.id, tranid: p.tranid, at: p.at, order: p.order, body: body, subs: subs };
  }
  function pinName(p) { return String(p.type || 'record') + (p.id ? ' #' + p.id : ' (new)') + (p.tranid ? ' ' + p.tranid : ''); }
  function pinTime(p) { try { return new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  /* pageOnly (edit mode): only what the form itself has, the same before and after the saved record is loaded.
   * Once it is loaded, Body also lists standard hidden fields the record labels, and Sublists the sublists that
   * have no machine (read from the record). Left out: those hidden fields (custom ones and the record type stay),
   * and sublists without a machine. Used for pins and Compare in edit mode. */
  function snapshot(w, pageOnly) {
    var m = meta(w), snap = { v: 1, type: String(m.type || ''), id: String(m.id || ''), tranid: String(m.tranid || ''), at: Date.now(), order: [], body: newMap(), subs: newMap() };
    collectBody(w).body.forEach(function (f) {
      if (has(snap.body, f.id) || (pageOnly && f.hidden && !f.custom && f.id !== REC_TYPE_ID)) return;
      snap.body[f.id] = [f.label || '', disp(f.value), disp(f.text)];
      snap.order.push(f.id);
    });
    sublistIds(w).forEach(function (sid) {
      if (pageOnly && !machine(w, sid)) return;
      var d = sublistData(w, sid, 500), cols = newMap(), lines = [], i, line;
      if (!d) return;
      d.cols.forEach(function (c) { cols[c.id] = c.label || ''; });
      for (i = 0; i < d.shown; i++) {
        line = newMap();
        d.cols.forEach(function (c) { var x = c.vals[i]; if (x && (x.v !== '' || x.t !== '')) line[c.id] = [disp(x.v), disp(x.t)]; });
        lines.push(line);
      }
      snap.subs[sid] = { cols: cols, lines: lines };
    });
    return snap;
  }
  function pinNow() {
    var w = findTarget();
    if (!w) { toast('No NetSuite form found to pin'); return; }
    if (isViewMode(w) && REC.state === 'loading') { toast('Still loading the saved record; pin again in a moment'); return; }
    whenNamesReady(function () {
      if (closed) return;
      var txt = JSON.stringify(snapshot(w, !isViewMode(w)));
      if (txt.length > PIN_MAX) { toast('This record is too large to pin (' + (txt.length / 1e6).toFixed(1) + ' MB; the limit is 2 MB)'); return; }
      try { sessionStorage.setItem(PIN_KEY, txt); } catch (e) { toast('Could not pin: the browser refused to store it'); return; }
      PIN = loadPin(); cmp.count = null;
      render();
      toast('Pinned ' + pinName(PIN) + '. Now open Compare on another record.');
    });
  }
  /* The Pin button (highlighted while a record is pinned) and its menu: pin this record, or, once one is pinned,
   * Open Compare, Unpin, or pin this record instead. Everything from storage goes through esc. */
  var lastPinHtml = null;
  function renderPin(tw) {
    var w = tw === undefined ? findTarget() : tw, m = w ? meta(w) : null, here = m ? (m.type || 'record') + (m.id ? ' #' + m.id : '') + (m.tranid ? ' ' + m.tranid : '') : '';
    var btn = $('[data-act="pin"]');
    btn.classList.toggle('pinned', !!PIN);
    btn.title = PIN ? 'Pinned ' + pinName(PIN) + ' at ' + pinTime(PIN) + '. Click for Compare or Unpin.' : 'Pin: keep a snapshot of this record to compare with later';
    btn.setAttribute('aria-label', PIN ? 'Pin menu (a record is pinned)' : 'Pin menu');
    var h = PIN
      ? '<b>Pinned</b><p class="hint">' + esc(pinName(PIN)) + ' at ' + esc(pinTime(PIN)) + '. Kept in this browser tab only.</p>' +
        '<div class="row"><button class="pri" data-act="opencmp">Open Compare</button><button data-act="unpin">Unpin</button></div>' +
        (here && here !== pinName(PIN) ? '<button data-act="dopin">Pin ' + esc(here) + ' instead</button>' : '')
      : '<b>Pin this record</b><p class="hint">Keep a snapshot' + (here ? ' of ' + esc(here) : '') + ', then open another record (or change this one) and see the differences in Compare. Kept in this browser tab only.</p>' +
        '<button class="pri" data-act="dopin"' + (w ? '' : ' disabled') + '>Pin ' + esc(here || 'this record') + '</button>';
    /* Edit mode on a saved record: compare the form, unsaved edits included, with the saved record. */
    if (canCmpSaved(w)) h += '<p class="hint">Or see what you changed on this form since it was saved.</p><button data-act="cmpsaved">Compare with the saved record</button>';
    if (h !== lastPinHtml) { lastPinHtml = h; POPS.pin.innerHTML = h; }
    var src = cmpSource(w), tabBtn = $('[data-tab="cmp"]');
    tabBtn.classList.toggle('hid', !src);
    tabBtn.title = src === 'saved' ? 'Differences between the saved record and this form' : 'Differences between the pinned record and this one';
  }
  /* ---------- Compare with the saved record (edit mode) ----------
   * In edit mode the form can hold unsaved edits, which the panel reads live (nlapi*). "Compare with the saved
   * record" loads the saved record (ensureRecord with force, the same load Not on form uses) and diffs a
   * snapshot of it, in the shape snapshot() gives, against snapshot() of the form. Only what the form shows is
   * compared: body fields the saved record doesn't have (custpage fields, plumbing) and sublist columns it
   * doesn't have are left out on both sides. Both sides go through cmpVal, so an untouched form compares equal
   * (checkbox '' is F, multi-select order, line endings; sameVal covers number formats and %). Never calls
   * record.getText: body select names come from the page when the value is unchanged, else from the background
   * N/search lookup (requestNames); line names only for changed or removed lines, read when idle (drainWork),
   * like the date-time values and the saved lines. Not offered in view mode, where the page already shows the
   * saved values, or on a record that was never saved. */
  function canCmpSaved(w) { return !!w && !!recKey(w) && !isViewMode(w); }
  function savedOn(w) { return !!S.cmpSavedKey && canCmpSaved(w) && S.cmpSavedKey === recKey(w); }
  /* What the Compare tab compares with: 'pin', 'saved', or '' (no Compare tab). */
  function cmpSource(w) {
    var sv = savedOn(w);
    return sv && (S.cmpSrc === 'saved' || !PIN) ? 'saved' : PIN ? 'pin' : '';
  }
  /* The bar above the comparison: what is compared, a Pinned / Saved switch when both are possible, and Show unchanged. */
  function cmpBar(w, src) {
    var saved = src === 'saved', both = !!PIN && savedOn(w);
    function sw(k, label, tip) { var on = (k === 'saved') === saved; return '<button data-cmpsrc="' + k + '" aria-pressed="' + on + '"' + (on ? ' class="on"' : '') + ' title="' + tip + '">' + label + '</button>'; }
    return '<div class="pvbar">' + (both ? '<span class="grp">' + sw('pin', 'Pinned record', 'Compare with the pinned record') + sw('saved', 'Saved record', 'Compare this form with the saved record') + '</span>' : '') +
      '<span>' + (saved ? '<b>Saved record</b> vs <b>this form</b> (unsaved edits)' : 'Pinned <b>' + esc(pinName(PIN)) + '</b> at ' + esc(pinTime(PIN))) + '</span><span class="sp"></span>' +
      '<label title="Also list body fields that are the same in both"><input type="checkbox" data-chk="cmpAll"' + (S.cmpAll ? ' checked' : '') + '>Show unchanged</label></div>';
  }
  /* Why the saved record isn't there (yet), for Not on form and Compare. */
  function recWait(rs, w) {
    return rs === 'loading' ? 'Loading the saved record\u2026'
      : rs === 'error' ? 'Could not load the saved record: ' + esc(String(REC.err).replace(/\.\s*$/, '')) + '. Click Refresh to try again.'
      : !recKey(w) ? 'This record has not been saved yet, so there are no saved fields to show.'
      : 'NetSuite\'s script modules are not available on this page, so the saved record cannot be loaded.';
  }
  /* One value made comparable: line endings, an empty checkbox is F, multi-select values in sorted order. */
  function cmpVal(type, v) {
    type = String(type || '');
    v = String(v == null ? '' : v).replace(/\r\n?/g, '\n');
    if (/checkbox/.test(type) && v === '') return 'F';
    if (/multiselect/.test(type) && v.indexOf(MULTI_SEP) >= 0) return v.split(MULTI_SEP).sort().join(MULTI_SEP);
    return v;
  }
  /* Idle-time reads for Compare with the saved record. What can block runs while the browser is idle, as many
   * tasks as fit in each idle period: date-time body values (getValue, about 250 ms each on a real bill), the saved
   * sublist lines (one getSublistValue per cell, up to 500 lines) and the saved names of changed line cells
   * (getSublistText). The panel renders when the queue is empty, or at most every 750 ms while it drains. It pauses
   * while Compare isn't showing the saved record and resumes on the next such render. Tasks wait for N/format
   * (fmtDone), so the dates they read are in the user's format. */
  function queueWork(key, f) {
    if (has(REC.workAsk, key)) return;
    REC.workAsk[key] = 1;
    REC.work.push(f);
  }
  function workPending() { return REC.state === 'ready' && (REC.work.length > 0 || REC.workBusy); }
  function drainWork() {
    var mine = REC;
    if (mine.workBusy || !mine.work.length || mine.state !== 'ready' || !mine.fmtDone) return;
    mine.workBusy = true;
    whenIdle(function (deadline) {
      mine.workBusy = false;
      if (REC !== mine || closed || S.tab !== 'cmp' || cmpSource(findTarget()) !== 'saved') return;
      var t0 = Date.now();
      do { try { mine.work.shift()(); } catch (e) {} }
      while (mine.work.length && (deadline && !deadline.didTimeout ? deadline.timeRemaining() > 4 : Date.now() - t0 < 8));
      drainWork();
      if (!mine.work.length || Date.now() - mine.workAt > 750) { mine.workAt = Date.now(); render(); }
    });
  }
  /* A sublist cell of the saved record, without its text: dates through fmtDate, no server call. */
  function savedCell(r, sid, id, type, i) {
    var v = '';
    try { v = r.getSublistValue({ sublistId: sid, fieldId: id, line: i }); } catch (e) {}
    return isDate(v) ? fmtDate(v, type) : norm(v);
  }
  /* The saved name of a sublist select cell, if drainWork has read it, else null. */
  function savedLineText(k) { return has(REC.lineNames, k) ? REC.lineNames[k] : null; }
  /* Asks for the saved names shown in the rows: changed select cells, and the summary of a removed line. */
  function savedLineNames(pair, rows) {
    var mine = REC;
    rows.forEach(function (row) {
      if (!row.sid || !row.pa || (row.chg !== 'changed' && row.chg !== 'removed')) return;
      var s = pair.saved.subs[row.sid], ty = pair.types[row.sid], i = s ? s.lines.indexOf(row.pa) : -1, sid = row.sid;
      if (i < 0) return;
      (row.line ? summaryIds(row.pa) : [row.id]).forEach(function (id) {
        var k = sid + '|' + id + '|' + i, x = cell(row.pa, id);
        if (!has(ty, id) || !/select/.test(ty[id]) || !x || x[0] === '' || savedLineText(k) != null) return;
        queueWork('n|' + k, function () {
          try { mine.lineNames[k] = norm(mine.rec.getSublistText({ sublistId: sid, fieldId: id, line: i })); } catch (e) { mine.lineNames[k] = ''; }
        });
      });
    });
    drainWork();
  }
  /* Only the columns both sides have; an unchecked checkbox may be '' or missing on either side. */
  function fixLine(l, cols, ty) {
    Object.keys(l).forEach(function (id) { if (!has(cols, id)) delete l[id]; else l[id][0] = cmpVal(ty[id], l[id][0]); });
    Object.keys(cols).forEach(function (id) { if (/checkbox/.test(ty[id] || '') && !has(l, id)) l[id] = ['F', '']; });
    return l;
  }
  /* The saved lines of a sublist (up to 500), read by drainWork one line per task; done once all are in. A cell
   * that fails to read is left out (and so shows as changed), and the line is counted even if something throws,
   * so a bad value can't leave the sublist "reading" for ever. */
  function savedLines(r, sid, cols, ty, sig) {
    var ss = { sig: sig, lines: [], read: 0, n: 0, done: false }, ids = Object.keys(cols), i;
    try { ss.n = Math.min(r.getLineCount({ sublistId: sid }), 500); } catch (e) {}
    ss.done = !(ss.n > 0);
    for (i = 0; i < ss.n; i++) (function (i) {
      queueWork('l|' + sid + '|' + sig + '|' + i, function () {
        var line = newMap();
        try {
          ids.forEach(function (id) { try { var v = cmpVal(ty[id], disp(savedCell(r, sid, id, ty[id], i))); if (v !== '') line[id] = [v, '']; } catch (e) {} });
        } finally {
          try { ss.lines[i] = fixLine(line, cols, ty); } catch (e) { ss.lines[i] = line; }
          if (++ss.read === ss.n) ss.done = true;
        }
      });
    })(i);
    return ss;
  }
  /* { saved, cur, types, pending }: snapshots of the saved record and of the form, trimmed to what can be compared
   * and made comparable (cmpVal), the sublist column types, and how many fields and sublists are still being read
   * (left out until then). Left out on both sides: body fields the record doesn't have (custpage, plumbing), hidden
   * fields and the system dates (not editable on the form), sublist columns the record doesn't have, and sublists
   * without a machine (snapshot(w, true): not editable, and reading them from the record would call getSublistText
   * for every select cell, since the edit-mode table has no data-field-name cells). */
  function savedPair(w, r) {
    var cur = snapshot(w, true), fields = recFieldSet(r), types = newMap(), skip = newMap(), want = [], order = [], rsubs = newMap(), ctypes = newMap(), mine = REC, pending = 0;
    var saved = { v: 1, type: cur.type, id: cur.id, tranid: cur.tranid, at: Date.now(), order: order, body: newMap(), subs: newMap() };
    collectBody(w).body.forEach(function (f) {
      if (!has(types, f.id)) types[f.id] = f.type;
      if (f.hidden || SYSTEM_DATES.test(f.id)) skip[f.id] = 1;
    });
    cur.order.forEach(function (id) {
      var on = has(fields, id) && !has(skip, id), m = on ? recMeta(r, id) : null, type = (m && m.type) || types[id] || '', sv = null, b = cur.body[id];
      if (on) {
        if (/^datetime/.test(type) && !has(mine.vals, id)) { queueWork('b|' + id, function () { recValue(r, id); }); pending++; }
        else sv = recValue(r, id);
      }
      if (sv == null) { delete cur.body[id]; return; }
      var s = cmpVal(type, disp(sv)), txt = '';
      b[1] = cmpVal(type, b[1]);
      /* A select's saved name: the form's when the value is unchanged, else from the background lookup. */
      if (/select/.test(type) && s !== '') {
        if (sameVal(s, b[1])) txt = b[2];
        else { var nm = recName(id); if (nm != null) txt = disp(nm); else want.push(id); }
      }
      saved.body[id] = [b[0], s, txt];
      order.push(id);
    });
    cur.order = order.slice();
    if (want.length) requestNames(want);
    try { r.getSublists().forEach(function (s) { rsubs[s] = 1; }); } catch (e) {}
    Object.keys(cur.subs).forEach(function (sid) {
      if (!has(rsubs, sid)) { delete cur.subs[sid]; return; }
      var cs = cur.subs[sid], d = sublistData(w, sid, 500), fset = newMap(), ty = newMap(), cols = newMap();
      try { (r.getSublistFields({ sublistId: sid }) || []).forEach(function (f) { fset[f] = 1; }); } catch (e) {}
      if (d) d.cols.forEach(function (c) { ty[c.id] = c.type || ''; });
      Object.keys(cs.cols).forEach(function (id) { if (has(fset, id)) cols[id] = cs.cols[id]; });
      var sig = Object.keys(cols).join(','), ss = has(mine.savedSubs, sid) ? mine.savedSubs[sid] : null;
      if (!ss || ss.sig !== sig) ss = mine.savedSubs[sid] = savedLines(r, sid, cols, ty, sig);
      if (!ss.done) { delete cur.subs[sid]; pending++; return; }
      cs.lines.forEach(function (l) { fixLine(l, cols, ty); });
      cs.cols = cols;
      /* Saved names read so far (savedLineNames). */
      ss.lines.forEach(function (l, i) {
        Object.keys(l).forEach(function (id) { if (!l[id][1] && /select/.test(ty[id] || '')) { var t = savedLineText(sid + '|' + id + '|' + i); if (t) l[id][1] = disp(t); } });
      });
      saved.subs[sid] = { cols: cols, lines: ss.lines };
      ctypes[sid] = ty;
    });
    drainWork();
    return { saved: saved, cur: cur, types: ctypes, pending: pending };
  }
  function sameVal(a, b) {
    if (a === b) return true;
    var x = String(a).replace(/,/g, '').replace(/%$/, ''), y = String(b).replace(/,/g, '').replace(/%$/, '');
    return NUM_RE.test(x) && NUM_RE.test(y) && parseFloat(x) === parseFloat(y);
  }
  function cell(o, id) { var x = has(o, id) ? o[id] : null; return Array.isArray(x) ? [String(x[0] == null ? '' : x[0]), String(x[1] == null ? '' : x[1])] : null; }
  /* The column that identifies a line on both sides, or '' to match lines by position. */
  var LINE_KEYS = ['lineuniquekey', 'line'];
  /* Every earlier line must have the key; a current line without one (for example a line added on the form and not
   * saved yet) is an added line. */
  function lineKey(A, Bs) {
    function hasKey(l, c) { var x = cell(l, c); return !!x && x[0] !== ''; }
    return LINE_KEYS.filter(function (c) {
      return A.lines.length > 0 && A.lines.every(function (l) { return hasKey(l, c); }) && Bs.lines.some(function (l) { return hasKey(l, c); });
    })[0] || '';
  }
  /* [pinned line or null, current line or null, line number] for every line on either side. */
  function matchLines(La, Lb, key) {
    var out = [], used = newMap(), byKey = newMap(), i;
    if (!key) {
      for (i = 0; i < Math.max(La.length, Lb.length); i++) out.push([La[i] || null, Lb[i] || null, i + 1]);
      return out;
    }
    La.forEach(function (l, j) { byKey[cell(l, key)[0]] = j; });
    Lb.forEach(function (l, j) {
      var x = cell(l, key), k = x ? x[0] : '', a = k !== '' && has(byKey, k) ? byKey[k] : -1;
      if (a >= 0 && !has(used, a)) { used[a] = 1; out.push([La[a], l, j + 1]); } else out.push([null, l, j + 1]);
    });
    La.forEach(function (l, j) { if (!has(used, j)) out.push([l, null, j + 1]); });
    return out;
  }
  /* The columns a line summary shows: its first four, line keys left out. */
  function summaryIds(l) { return Object.keys(l).filter(function (id) { return validId(id) && LINE_KEYS.indexOf(id) < 0; }).slice(0, 4); }
  function lineSummary(cols, l) {
    return summaryIds(l).map(function (id) {
      var x = cell(l, id);
      return (has(cols, id) && cols[id] ? cols[id] : id) + ': ' + (x[1] || x[0]);
    }).join('; ');
  }
  /* Rows for the Compare tab: { sec, sid, id, label, pin, cur, chg: 'added' | 'removed' | 'changed' | '', line, pa }.
   * pa is the earlier (pinned or saved) line of a sublist row, for savedLineNames. */
  function compareRows(pin, cur) {
    var rows = [], seen = newMap(), sids = [], sameRecord = !!pin.id && pin.id === cur.id && pin.type === cur.type;
    function bodyRow(id) {
      if (!validId(id) || has(seen, id)) return;
      seen[id] = 1;
      /* Body entries are [label, value, text]; the value decides, the text (else the value) is shown. */
      var a = has(pin.body, id) && Array.isArray(pin.body[id]) ? pin.body[id] : null, b = has(cur.body, id) ? cur.body[id] : null;
      function shown(x) { return x ? String(x[2] || x[1] || '') : ''; }
      rows.push({ sec: 'Body', sid: '', id: id, label: String((b && b[0]) || (a && a[0]) || ''), pin: shown(a), cur: shown(b),
        chg: !a ? 'added' : !b ? 'removed' : sameVal(String(a[1] == null ? '' : a[1]), String(b[1])) ? '' : 'changed' });
    }
    cur.order.forEach(bodyRow);
    pin.order.forEach(bodyRow);
    Object.keys(cur.subs).concat(Object.keys(pin.subs)).forEach(function (s) { if (validId(s) && sids.indexOf(s) < 0) sids.push(s); });
    sids.forEach(function (sid) {
      var none = { cols: newMap(), lines: [] }, A = has(pin.subs, sid) ? pin.subs[sid] : none, Bs = has(cur.subs, sid) ? cur.subs[sid] : none;
      if (!Array.isArray(A.lines) || !A.cols) A = none;
      matchLines(A.lines, Bs.lines, sameRecord ? lineKey(A, Bs) : '').forEach(function (p) {
        var a = p[0], b = p[1], where = sid + ' L' + p[2];
        if (!a || !b) {
          rows.push({ sec: where, sid: sid, id: '', label: a ? 'Line removed' : 'Line added', pin: a ? lineSummary(A.cols, a) : '', cur: b ? lineSummary(Bs.cols, b) : '', chg: a ? 'removed' : 'added', line: true, pa: a });
          return;
        }
        var ids = Object.keys(b); Object.keys(a).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
        ids.forEach(function (id) {
          if (!validId(id) || LINE_KEYS.indexOf(id) >= 0) return;
          var x = cell(a, id) || ['', ''], y = cell(b, id) || ['', ''];
          if (sameVal(x[0], y[0])) return;
          rows.push({ sec: where, sid: sid, id: id, label: String((has(Bs.cols, id) && Bs.cols[id]) || (has(A.cols, id) && A.cols[id]) || ''), pin: x[1] || x[0], cur: y[1] || y[0], chg: 'changed', pa: a });
        });
      });
    });
    return rows;
  }

  /* ---------- custom field setup pages ----------
   * A custom field ID links to its setup page. The page's own N/query module maps script IDs to internal
   * IDs in one background SuiteQL request per batch of new IDs (bound parameters; script IDs are stored
   * upper case), and the page to open follows the field type it returns. Checked on the sandbox: BODY
   * bodycustfield.nl, COLUMN columncustfield.nl, ENTITY entitycustfield.nl, ITEM itemcustfield.nl,
   * EVENT eventcustfield.nl, RECORD custreccustfield.nl; segments (cseg...) come from customsegment and
   * open segments/segment.nl. Other types (script parameters, workflow fields) and custpage fields (added
   * by scripts) get no link. If the role may not read the definitions, the footer says so. customfield and
   * customsegment are looked up separately (CF.err.field / CF.err.seg), so a role refused one still gets the
   * other's links. */
  var CF_PAGE = { BODY: 'bodycustfield', COLUMN: 'columncustfield', ENTITY: 'entitycustfield', ITEM: 'itemcustfield', EVENT: 'eventcustfield', RECORD: 'custreccustfield' };
  var SETUP_ID = /^(custbody|custcol|custentity|custitem|custevent|custrecord|cseg)/i;
  function blankCF() { return { map: newMap(), asked: newMap(), want: [], err: { field: '', seg: '' } }; }
  var CF = blankCF();
  function cfKind(id) { return /^cseg/.test(id) ? 'seg' : 'field'; }
  /* The footer note when a lookup was refused. SuiteQL answers "Record 'customfield' was not found" (rather
   * than a permission error) when the role may not read the table, so both read as a permission problem;
   * NetSuite's own message goes in the tooltip. */
  function cfNote() {
    var e = CF.err.field || CF.err.seg;
    if (!e) return null;
    var perm = /PERMISSION|was not found|not have permission|INSUFFICIENT/i.test(e);
    var both = CF.err.field && CF.err.seg;
    var what = both ? 'no setup links' : CF.err.field ? 'no setup links for custom fields' : 'no setup links for segments';
    var why = both ? 'this role cannot read custom field or segment definitions' : CF.err.field ? 'this role cannot read their definitions' : 'this role cannot read segment definitions';
    return { text: what + (perm ? ': ' + why : ' (' + e + ')'),
      tip: [CF.err.field, CF.err.seg].filter(Boolean).join('\n') };
  }
  /* The setup page URL for an ID, or '' (not custom, not known yet, or none). Unknown IDs are queued. */
  function setupUrl(w, id) {
    id = String(id || '').toLowerCase();
    if (!validId(id) || !SETUP_ID.test(id)) return '';
    if (has(CF.map, id)) return CF.map[id];
    if (!has(CF.asked, id) && !CF.err[cfKind(id)]) {
      CF.asked[id] = 1; CF.want.push(id);
      if (CF.want.length === 1) { var mine = CF; setTimeout(function () { requestSetup(w, mine); }, 0); }
    }
    return '';
  }
  function requestSetup(w, cf) {
    var ids = cf.want.splice(0, cf.want.length);
    if (!ids.length || closed || cf !== CF) return;
    function finish() { ids.forEach(function (id) { if (!has(cf.map, id)) cf.map[id] = ''; }); if (!closed && cf === CF) render(); }
    function fail(e, kind) {
      var m = errMsg(e);
      if (kind) cf.err[kind] = cf.err[kind] || m;
      else ids.forEach(function (id) { cf.err[cfKind(id)] = cf.err[cfKind(id)] || m; });
    }
    if (typeof w.require !== 'function') { fail(new Error('NetSuite modules are not available')); finish(); return; }
    try {
      w.require(['N/query'], function (query) {
        var fields = ids.filter(function (id) { return cfKind(id) === 'field'; }), segs = ids.filter(function (id) { return cfKind(id) === 'seg'; }), jobs = [];
        function run(sql, list, urlOf) {
          var up = list.map(function (id) { return id.toUpperCase(); }), kind = cfKind(list[0]);
          return query.runSuiteQL.promise({ query: sql + ' WHERE UPPER(scriptid) IN (' + up.map(function () { return '?'; }).join(', ') + ')', params: up }).then(function (r) {
            r.asMappedResults().forEach(function (row) { var id = String(row.scriptid || '').toLowerCase(), u = urlOf(row); if (validId(id)) cf.map[id] = u; });
          }, function (e) { fail(e, kind); });
        }
        for (var i = 0; i < fields.length; i += 200) jobs.push(run('SELECT id, scriptid, fieldtype FROM customfield', fields.slice(i, i + 200), function (row) {
          var pg = has(CF_PAGE, String(row.fieldtype)) ? CF_PAGE[String(row.fieldtype)] : '';
          return pg && /^\d+$/.test(String(row.id)) ? '/app/common/custom/' + pg + '.nl?id=' + row.id : '';
        }));
        for (var j = 0; j < segs.length; j += 200) jobs.push(run('SELECT internalid, scriptid FROM customsegment', segs.slice(j, j + 200), function (row) {
          return /^\d+$/.test(String(row.internalid)) ? '/app/common/custom/segments/segment.nl?id=' + row.internalid : '';
        }));
        Promise.all(jobs).then(finish, function (e) { fail(e); finish(); });
      }, function (e) { fail(e); finish(); });
    } catch (e) { fail(e); finish(); }
  }
  var CF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  function setupBtn(w, id) {
    var u = setupUrl(w, id);
    return u ? '<a class="cf" href="' + esc(u) + '" tabindex="-1" target="_blank" rel="noopener noreferrer" title="Open the setup page for this field (new tab)" aria-label="Open the setup page for this field (new tab)">' + CF_ICON + '</a>' : '';
  }

  /* ---------- Locate: show a field on the form ----------
   * Opens the NetSuite tab and subtab the field sits in, scrolls it into view and flashes an outline.
   * Clicking a tab link only changes what the form shows, never a value. In NetSuite Next a tab's content
   * is <div id="<name>_div"> inside <div id="<name>_wrapper">, and its link is
   * a[data-nsps-type="tab" or "subtab"][data-nsps-id="<name>"] (seen on the sandbox: terms sits in
   * billingtab_div, linked to data-nsps-id="billingtab"; sublists sit in nested subtabs). */
  /* An eye icon (inline SVG: no style attributes, so NetSuite's CSP allows it; currentColor follows the theme). */
  var LOC_BTN = '<button class="loc" data-act="locate" tabindex="-1" title="Show this field on the form" aria-label="Show this field on the form">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3.2"/></svg></button>';
  /* The tab or subtab link for a tab content element, or null: a tab's content is <name>_div inside
   * <name>_wrapper, a subtab's (a sublist's) is <name>_layer (sandbox: expense_splits in expense_layer). */
  function tabLink(d, e) {
    var m = e.id && /^([A-Za-z0-9_]+?)_(div|wrapper|layer)$/.exec(e.id), found = null;
    if (!m) return null;
    Array.prototype.some.call(d.querySelectorAll('a[data-nsps-type="tab"][data-nsps-id="' + m[1] + '"],a[data-nsps-type="subtab"][data-nsps-id="' + m[1] + '"]'), function (a) {
      return safeTabLink(a) && !!(found = a);
    });
    return found;
  }
  /* Locate clicks tab links, so a look-alike link planted in an inline HTML field (which comes first in the
   * page if it sits above the tabs) must never be the one clicked: it could send the form somewhere else.
   * A real tab link is outside every field and inline HTML element, and its href goes nowhere. Sandbox:
   * tabs have href="#", subtabs javascript:void("item");. */
  var SAFE_TAB_HREF = /^(#.*|javascript:\s*(void\s*\(\s*(0|"[^"]*"|'[^']*')?\s*\)\s*)?;?\s*)$/i;
  function safeTabLink(a) {
    var h = a.getAttribute('href');
    return !(a.closest && a.closest('[data-nsps-type="field"], [data-field-type="inlinehtml"]')) && (h == null || h === '' || SAFE_TAB_HREF.test(h));
  }
  /* Clicks the link of every tab or subtab around el whose content is hidden, outermost first. The
   * content's own display decides (not aria-selected), so a click NetSuite dropped is simply made again. */
  function openTabsFor(w, el) {
    var d = w.document, links = [], e, a;
    for (e = el.parentElement; e; e = e.parentElement) {
      a = tabLink(d, e);
      if (a && w.getComputedStyle(e).display === 'none' && links.indexOf(a) < 0) links.unshift(a);
    }
    links.forEach(function (x) { x.click(); });
  }
  /* A sublist column's header cell, or null when the form doesn't display the column (the machine and the
   * saved record list many columns the form never shows; real purchase order, view mode: 23 headers, more
   * record columns). Never the table itself: that gave every such column an eye that flashed the whole table.
   * When the headers carry IDs (data-nsps-id="columnheader_<sublist>_<field>": view mode, sometimes edit
   * mode), only the exact ID counts (or <field>_display, for a select folded into its base column).
   * Without IDs (edit mode), the column is matched by label as infoAt matches cells: the k-th header with
   * its label. When more columns share a label than headers carry it, it can't be told which of them are
   * shown, so none may lose its eye: the extra ones go to the last header with that label. */
  function sublistHeader(w, sid, fid) {
    var tb = w.document.querySelector('table[data-sublist-id="' + sid + '"]'), pre = 'columnheader_' + sid + '_', hc, hdr, cols, col = null, k = 0, n = 0, hits = [];
    if (!tb) return null;
    hc = tb.querySelector('td[data-nsps-type="columnheader"][data-nsps-id="' + pre + fid + '"]') || tb.querySelector('td[data-nsps-type="columnheader"][data-nsps-id="' + pre + fid + '_display"]');
    if (hc) return hc;
    if (tb.querySelector('td[data-nsps-type="columnheader"][data-nsps-id^="' + pre + '"]')) return null;
    hc = tb.querySelector('td[data-nsps-type="columnheader"]'); hdr = hc && hc.parentNode; cols = sublistCols(w, sid) || [];
    cols.some(function (c) { if (c.id === fid) { col = c; return true; } return false; });
    if (!hdr || !col || !col.label) return null;
    cols.forEach(function (c) { if (c.label === col.label) { if (c === col) k = n; n++; } });
    Array.prototype.forEach.call(hdr.children, function (h) { if (h.getAttribute('data-label') === col.label) hits.push(h); });
    if (!hits.length) return null;
    return hits[k] || (n > hits.length ? hits[hits.length - 1] : null);
  }
  /* The element Locate goes to: the body field wrapper, or a sublist column's header. */
  function locTarget(w, id, sid) {
    if (!validId(id) || (sid && !validId(sid))) return null;
    return sid ? sublistHeader(w, sid, id) : w.document.querySelector(BODY_FIELD + '[data-field-name="' + id + '"]');
  }
  /* Whether Locate can show an element: it is visible now, or the only things hiding it are NetSuite tabs
   * that Locate opens. Anything else that hides it (display:none on the field itself or on a container
   * that isn't a tab, as for fields the form hides or hidden sublist columns) means there is nothing to
   * show, so the row gets no eye. Computed styles are read only for elements that aren't visible. */
  function canShow(w, el) {
    var d = w.document, e;
    if (!el) return false;
    if (el.getClientRects().length) return w.getComputedStyle(el).visibility === 'visible';
    for (e = el; e && e !== d.body && e !== d.documentElement; e = e.parentElement) {
      if (w.getComputedStyle(e).display === 'none' && !tabLink(d, e)) return false;
    }
    return true;
  }
  /* Once per field per render (render() gives each render a fresh memo). */
  function locatable(w, id, sid) {
    return memo('loc:' + sid + ':' + id, function () { try { return canShow(w, locTarget(w, id, sid)); } catch (e) { return false; } });
  }
  var flash = { el: null, prev: '', t: null };
  /* Highlights drawn on NetSuite's own elements (the Locate flash and the Inspect hover): a rounded firebrick ring just
   * outside the element with a soft halo (gold for the flash, so it catches the eye). Set through the CSSOM (the CSP
   * allows that) and put back exactly as they were, so the page is left untouched. */
  var HI_PROPS = ['outline', 'outlineOffset', 'borderRadius', 'boxShadow'];
  function hiSave(el) { var o = {}; HI_PROPS.forEach(function (p) { o[p] = el.style[p]; }); return o; }
  function hiRestore(el, o) { try { HI_PROPS.forEach(function (p) { el.style[p] = o[p]; }); } catch (e) {} }
  function hiApply(el, strong) {
    el.style.outline = (strong ? '3px' : '2px') + ' solid #b22222';
    el.style.outlineOffset = '2px';
    el.style.borderRadius = strong ? '8px' : '6px';
    el.style.boxShadow = strong ? '0 0 0 10px rgba(201,162,39,.45)' : '0 0 0 7px rgba(178,34,34,.15)';
  }
  function unflash() { clearTimeout(flash.t); if (flash.el) { hiRestore(flash.el, flash.prev); flash.el = null; } }
  cleanupFns.push(unflash);
  function locate(id, sid) {
    var w = findTarget(), d = w && w.document, el = w && locTarget(w, id, sid);
    if (!el) { if (d) toast(id + ' is not on the form'); return; }
    try { openTabsFor(w, el); } catch (e) {}
    /* Wait for the element to appear, up to 1.5 s, before scrolling to it. NetSuite sometimes ignores a tab
     * click (seen on the sandbox in view mode), so the hidden tabs are clicked again at 400 and 900 ms. */
    var t0 = Date.now(), retries = [400, 900];
    (function check() {
      if (closed) return;
      if (!el.getClientRects().length) {
        if (retries.length && Date.now() - t0 >= retries[0]) { retries.shift(); try { openTabsFor(w, el); } catch (e) {} }
        if (Date.now() - t0 < 1500) { setTimeout(check, 50); return; }
        toast(id + ' is on a NetSuite tab that did not open; try again'); return;
      }
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      unflash();
      flash.el = el; flash.prev = hiSave(el); hiApply(el, true);
      flash.t = setTimeout(unflash, 1600);
      toast('Showing ' + (sid ? sid + ': ' : '') + id + ' on the form');
    })();
  }

  /* ---------- hover inspect on the form ---------- */
  /* lastT / lastI / lastTip: the element last under the pointer, what infoAt found for it, and its
   * tooltip text. mousemove fires many times a second, and over a sublist cell infoAt reads the columns
   * and scans the table, so that is done once per element (render clears it, as values may change). */
  var insp = { w: null, d: null, cur: null, prevHi: null, tip: null, lastT: null, lastI: null, lastTip: '' };
  function infoCached(t) {
    if (t !== insp.lastT) {
      insp.lastI = insp.w ? infoAt(insp.w, t) : null;
      insp.lastTip = insp.lastI ? tipText(insp.lastI) : '';
      insp.lastT = t;
    }
    return insp.lastI;
  }
  function infoAt(w, t) {
    if (!t || !t.closest) return null;
    var td = t.closest('td'), tb = td && td.closest('table[data-sublist-id]');
    if (tb) {
      var sid = tb.getAttribute('data-sublist-id'), tr = td.parentNode;
      if (!validId(sid)) return null;
      var idx = Array.prototype.indexOf.call(tr.children, td);
      var hc = tb.querySelector('td[data-nsps-type="columnheader"]'), hdr = hc && hc.parentNode;
      var hcell = hdr && hdr.children[idx];
      var lbl = hcell ? (hcell.getAttribute('data-label') || '') : '';
      /* Prefer an exact field ID: view-mode cells carry data-field-name, and view-mode header cells carry
       * data-nsps-id="columnheader_<sublist>_<field>". Edit mode has neither, so match by label; when
       * several columns share a label, the k-th header with that label maps to the k-th column with it. */
      var fid = td.getAttribute('data-field-name'), pre = 'columnheader_' + sid + '_', hid = hcell && hcell.getAttribute('data-nsps-id');
      if (!validId(fid)) fid = hid && hid.indexOf(pre) === 0 && validId(hid.slice(pre.length)) ? hid.slice(pre.length) : '';
      var cols = sublistCols(w, sid) || [], col = null;
      if (fid) cols.forEach(function (c) { if (!col && c.id === fid) col = c; });
      if (!col && !fid && lbl) {
        var k = 0, j;
        for (j = 0; j < idx; j++) if (hdr.children[j] && hdr.children[j].getAttribute('data-label') === lbl) k++;
        cols.forEach(function (c) { if (!col && c.label === lbl && k-- === 0) col = c; });
      }
      if (!col && fid) col = { id: fid, label: lbl, type: '' };
      if (!col) return null;
      var line = 0;
      if (tr !== hdr) {
        var n = 0;
        Array.prototype.some.call(tb.rows, function (r) { if (r === hdr || r.querySelector('td[data-nsps-type="columnheader"]')) return false; n++; return r === tr; });
        line = n;
      }
      return { id: col.id, label: col.label, type: col.type, sid: sid, line: line, el: td };
    }
    var f = t.closest('[data-nsps-type="field"][data-field-name]');
    if (f && validId(f.getAttribute('data-field-name'))) return { id: f.getAttribute('data-field-name'), label: f.getAttribute('data-nsps-label') || '', type: f.getAttribute('data-field-type') || '', sid: '', line: 0, el: f };
    return null;
  }
  function clearHi() { if (insp.cur) { hiRestore(insp.cur, insp.prevHi); insp.cur = null; } if (insp.tip) insp.tip.style.display = 'none'; }
  function tipText(i) {
    var v = '';
    try { v = i.sid ? (i.line ? lineVal(insp.w, i.sid, i.id, i.line) : '') : fieldVal(insp.w, i.id); } catch (e) {}
    return (i.sid ? i.sid + (i.line ? ' line ' + i.line : ' column') + ' \u2022 ' : '') + i.id + '\n' + i.label + ' \u2022 ' + i.type + (v ? '\n= ' + String(v).slice(0, 80) : '');
  }
  function onMove(e) {
    var i = infoCached(e.target);
    if (!i) { clearHi(); return; }
    if (i.el !== insp.cur) { clearHi(); insp.cur = i.el; insp.prevHi = hiSave(i.el); hiApply(i.el, false); }
    var tip = insp.tip;
    tip.textContent = insp.lastTip; tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 14, insp.d.documentElement.clientWidth - 280) + 'px';
    tip.style.top = (e.clientY + 18) + 'px';
  }
  function onBlock(e) {
    var i = insp.w ? infoCached(e.target) : null;
    if (!i) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (e.type === 'click') {
      var s = snippet(i.id, i.sid, i.line);
      copyText(s, insp.d, function (ok) {
        if (insp.tip) insp.tip.textContent = (ok ? 'Copied: ' : 'Copy blocked: ') + s;
        toast(ok ? 'Copied ' + s : 'Copy blocked by the browser');
      });
    }
  }
  function onKey(e) { if (e.key === 'Escape' && openPop) { setPop('', e.currentTarget === document && !!root.activeElement); return; } if (e.key === 'Escape' && S.inspect) { S.inspect = false; detachInspect(); render(); toast('Inspect off'); } }
  function attachInspect(w) {
    if (insp.d === w.document) return;
    detachInspect();
    insp.w = w; insp.d = w.document;
    insp.tip = insp.d.createElement('div');
    insp.tip.style.cssText = 'position:fixed;z-index:2147483647;display:none;white-space:pre;max-width:270px;overflow:hidden;background:#0b0b0b;color:#fff;border:1px solid #333;font:11px/1.4 ui-monospace,Consolas,monospace;padding:6px 9px;border-radius:8px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    insp.d.body.appendChild(insp.tip);
    insp.d.addEventListener('mousemove', onMove, true);
    insp.d.addEventListener('click', onBlock, true);
    insp.d.addEventListener('mousedown', onBlock, true);
    insp.d.addEventListener('keydown', onKey, true);
  }
  function detachInspect() {
    if (!insp || !insp.d) return;
    clearHi();
    try {
      insp.d.removeEventListener('mousemove', onMove, true); insp.d.removeEventListener('click', onBlock, true);
      insp.d.removeEventListener('mousedown', onBlock, true); insp.d.removeEventListener('keydown', onKey, true);
      if (insp.tip) insp.tip.remove();
    } catch (e) {}
    insp.w = insp.d = insp.tip = insp.lastT = insp.lastI = null;
  }
  document.addEventListener('keydown', onKey, true);

  root.querySelector('[data-sel="fmt"]').value = S.fmt;
  render();
})();

/* Generated by Claude and Ammon Wendel.
 * Questions or help: info@syincuso.com */
