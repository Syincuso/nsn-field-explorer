/* Edit-mode NetSuite mock: nlapi* returns live values and getMachineByName exposes the line sublist,
 * which is how a real record in edit mode behaves. */
(function () {
  var BODY = {
    tranid: 'VB-1001', entity: '7', memo: '=HYPERLINK("http://evil.example","click")',
    custbody_tags: '1\u00052', custbody_quote: 'say "hi", ok', custbody_adj: '-5', custbody_empty: ''
  };
  var TEXT = { entity: 'Acme Supply', custbody_tags: 'Red\u0005Blue' };
  /* As on a real vendor bill: the machine gives "item" no label and type "integer"; the line-entry
   * field in #item_layer has label "Item" and type "select". */
  var COLS = [['item', '', 'integer'], ['amount', 'Amount', 'currency'], ['custcol_a', 'Notes', 'text'], ['custcol_b', 'Notes', 'text']];
  var LINES = [
    { item: '11', amount: '-5', custcol_a: 'alpha', custcol_b: 'beta' },
    { item: '12', amount: '12.50', custcol_a: 'gamma', custcol_b: 'delta' }
  ];
  var LINETEXT = [{ item: 'Widget' }, { item: 'Gadget' }];
  /* ?hidcols=1: like a real edit-mode machine, getMachineByName lists columns the form does not display, and
   * the page table has no header (and no cells) for them: line and itemtype (no label), rate (labelled), and
   * custcol_hid, labelled "Amount" like the shown amount column and listed before it. None of them is on
   * the form, so none may get the eye, and the Amount header must still map to amount. */
  if (/[?&]hidcols=1/.test(location.search)) {
    COLS.splice(1, 0, ['custcol_hid', 'Amount', 'currency']);
    COLS.push(['line', '', 'integer'], ['itemtype', '', 'text'], ['rate', 'Rate', 'currency']);
    LINES[0].custcol_hid = '99'; LINES[0].line = '1'; LINES[0].itemtype = 'InvtPart'; LINES[0].rate = '-5';
    LINES[1].custcol_hid = '98'; LINES[1].line = '2'; LINES[1].itemtype = 'InvtPart'; LINES[1].rate = '12.50';
  }
  /* ?hidcols=2: columns whose header cells exist but are hidden other than by a tab: custcol_vc by
   * visibility:collapse (header and cells), custcol_hattr by the hidden attribute, custcol_cls by a
   * stylesheet class (display:none from fixture.css). None is visible, so none may get the eye. */
  var hidCols2 = /[?&]hidcols=2/.test(location.search);
  if (hidCols2) {
    COLS.push(['custcol_vc', 'Collapsed', 'text'], ['custcol_hattr', 'Hidden attr', 'text'], ['custcol_cls', 'Class hidden', 'text']);
    LINES[0].custcol_vc = 'v1'; LINES[0].custcol_hattr = 'h1'; LINES[0].custcol_cls = 'c1';
    LINES[1].custcol_vc = 'v2'; LINES[1].custcol_hattr = 'h2'; LINES[1].custcol_cls = 'c2';
    document.addEventListener('DOMContentLoaded', function () {
      var tb = document.getElementById('item_splits');
      [['custcol_vc', 'Collapsed'], ['custcol_hattr', 'Hidden attr'], ['custcol_cls', 'Class hidden']].forEach(function (p) {
        Array.prototype.forEach.call(tb.rows, function (tr, r) {
          var td = tr.insertCell(-1);
          if (r === 0) { td.setAttribute('data-nsps-type', 'columnheader'); td.setAttribute('data-label', p[1]); td.textContent = p[1]; }
          else td.textContent = LINES[r - 1][p[0]];
          if (p[0] === 'custcol_vc') td.style.visibility = 'collapse';
          else if (p[0] === 'custcol_hattr') td.hidden = true;
          else td.className = 'nsfe-test-hidcol';
        });
      });
    });
  }
  /* ?lukey=1: the item sublist has a lineuniquekey column, as real sublists do. */
  if (/[?&]lukey=1/.test(location.search)) { COLS.push(['lineuniquekey', 'Line Unique Key', 'text']); LINES[0].lineuniquekey = 'k1'; LINES[1].lineuniquekey = 'k2'; }
  /* ?lines=N: the item sublist has N lines (more than the 50 the table shows, or the 500 an export reads). Line 75
   * has a formula in Notes (custcol_b), for the CSV formula guard. */
  var nLines = /[?&]lines=(\d+)/.exec(location.search);
  if (nLines) for (var ln = 3; ln <= +nLines[1]; ln++) {
    LINES.push({ item: String(100 + ln), amount: String(ln), custcol_a: 'a' + ln, custcol_b: ln === 75 ? '=1+2' : '' });
    LINETEXT.push({ item: 'Part ' + ln });
  }
  /* ?saved=1: the saved record matches the form (for Compare with the saved record), with a date and a checkbox
   * body field and a checkbox line column added to the form. Unchecked is 'F' in the body and '' on line 2, as
   * NetSuite may give either. Also a percent field ('10.0%' on the form, 10 saved), a date-time field, and two
   * hidden inputs the saved record has: externalid (labelled, so Body lists it once the record is loaded) and the
   * system date createddate (date-time, unlabelled). */
  var savedMode = /[?&]saved=1/.test(location.search);
  if (savedMode) {
    BODY.trandate = '8/19/2026'; BODY.paymenthold = 'F'; BODY.custbody_pct = '10.0%'; BODY.custbody_when = '8/19/2026 4:23 pm';
    COLS.push(['custcol_ok', 'OK', 'checkbox']); LINES[0].custcol_ok = 'T'; LINES[1].custcol_ok = '';
    document.addEventListener('DOMContentLoaded', function () {
      var form = document.querySelector('.form');
      [['trandate', 'date', 'Date'], ['paymenthold', 'checkbox', 'Payment Hold'], ['custbody_pct', 'percent', 'Share'], ['custbody_when', 'datetimetz', 'When']].forEach(function (p) {
        var d = document.createElement('div');
        d.setAttribute('data-nsps-type', 'field'); d.setAttribute('data-field-name', p[0]); d.setAttribute('data-field-type', p[1]);
        d.setAttribute('data-nsps-label', p[2]); d.setAttribute('data-mode', 'edit');
        d.appendChild(document.createElement('input')).name = p[0];
        form.insertBefore(d, document.getElementById('item_layer'));
      });
      [['externalid', 'EXT-1'], ['createddate', '8/19/2026 4:20 pm']].forEach(function (p) {
        var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; form.appendChild(i);
      });
    });
  }
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  /* Call counters, so tests can check how much work one render does. */
  window.__calls = { fieldValue: 0, lineValue: 0, lineText: 0, machine: 0 };
  window.nlapiGetFieldValue = function (id) { window.__calls.fieldValue++; return own(BODY, id) ? BODY[id] : null; };
  window.nlapiGetFieldText = function (id) { return own(TEXT, id) ? TEXT[id] : ''; };
  /* ?rectype=...: another record type (for the Records Catalog link). */
  var qType = /[?&]rectype=([^&]*)/.exec(location.search);
  window.nlapiGetRecordType = function () { return qType ? decodeURIComponent(qType[1]) : 'vendorbill'; };
  window.nlapiGetRecordId = function () { return '1001'; };
  window.nlapiGetLineItemCount = function (s) { return s === 'item' ? LINES.length : -1; };
  window.nlapiGetLineItemValue = function (s, f, l) { window.__calls.lineValue++; return s === 'item' && LINES[l - 1] && own(LINES[l - 1], f) ? LINES[l - 1][f] : null; };
  window.nlapiGetLineItemText = function (s, f, l) { window.__calls.lineText++; return s === 'item' && LINETEXT[l - 1] && own(LINETEXT[l - 1], f) ? LINETEXT[l - 1][f] : ''; };
  window.getMachineByName = function (s) {
    window.__calls.machine++;
    if (s !== 'item') return null;
    return {
      countFormElements: function () { return COLS.length; },
      getFormElementName: function (i) { return COLS[i - 1][0]; },
      getFormElementLabel: function (i) { return COLS[i - 1][1]; },
      getFormElementType: function (i) { return COLS[i - 1][2]; }
    };
  };
  /* Edit mode has live values, so the explorer must not load the record, except when the user opens the
   * Not on form tab. Every load is counted. The saved record has one field the form doesn't show. */
  window.__recordLoads = 0;
  var SAVED = {
    tranid: ['VB-1001', 'Reference No.', 'text'], memo: ['saved memo', 'Memo', 'textarea'],
    custbody_secret: ['saved secret', 'Secret', 'text'], custbody_owner: ['42', 'Owner', 'select', 'Pat Lee'],
    _eml_nkey_: ['internal', '', 'text']
  };
  /* The saved record's sublists (only with ?saved=1): item as on the form, with record types (numbers, booleans),
   * and expense, which the form doesn't show. */
  var SUBS = {};
  if (savedMode) {
    SAVED = {
      tranid: ['VB-1001', 'Reference No.', 'text'], entity: ['7', 'Vendor', 'select', 'Acme Supply'], memo: [BODY.memo, 'Memo', 'textarea'],
      custbody_tags: [['1', '2'], 'Tags', 'multiselect', 'Red\u0005Blue'], custbody_quote: [BODY.custbody_quote, 'Quote test', 'text'],
      custbody_adj: [-5, 'Adjustment', 'currency'], custbody_empty: ['', 'Empty field', 'text'],
      trandate: [new Date(2026, 7, 19), 'Date', 'date'], paymenthold: [false, 'Payment Hold', 'checkbox'],
      custbody_pct: [10, 'Share', 'percent'], custbody_when: [new Date(2026, 7, 19, 16, 23), 'When', 'datetimetz'],
      externalid: ['EXT-1', 'External ID', 'text'], createddate: [new Date(2026, 7, 19, 16, 20), '', 'datetime'],
      custbody_secret: ['saved secret', 'Secret', 'text']
    };
    SUBS = {
      item: { meta: { item: ['Item', 'select'], amount: ['Amount', 'currency'], custcol_a: ['Notes', 'text'], custcol_b: ['Notes', 'text'], custcol_ok: ['OK', 'checkbox'], lineuniquekey: ['Line Unique Key', 'text'] },
        lines: [{ item: '11', amount: -5, custcol_a: 'alpha', custcol_b: 'beta', custcol_ok: true, lineuniquekey: 'k1' }, { item: '12', amount: 12.5, custcol_a: 'gamma', custcol_b: 'delta', custcol_ok: false, lineuniquekey: 'k2' }],
        text: [{ item: 'Widget' }, { item: 'Gadget' }] },
      expense: { meta: { account: ['Account', 'select'], amount: ['Amount', 'currency'] }, lines: [{ account: '5', amount: 10 }], text: [{ account: 'Travel' }] }
    };
    /* &savedthrow=1: one saved cell (line 2, custcol_a) is a value that throws when turned into text. */
    if (/[?&]savedthrow=1/.test(location.search)) SUBS.item.lines[1].custcol_a = { toString: function () { throw new Error('bad value'); } };
  }
  /* N/format, formatting as the user preference M/D/YYYY h:mm am. ?nofmt=1: the module can't be loaded. */
  var noFmt = /[?&]nofmt=1/.test(location.search);
  var fmtMod = { Type: { DATE: 'date', DATETIME: 'datetime' }, format: function (o) {
    var d = o.value, s = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(), h = d.getHours(), m = d.getMinutes();
    return o.type === 'datetime' ? s + ' ' + (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'am' : 'pm') : s;
  } };
  /* record.getText blocks on real NetSuite: tests insist on zero calls outside Not on form. getSublistText and
   * getValue on date-time fields (about 250 ms each on a real bill) are counted too. */
  window.__getTextCalls = 0; window.__subTextCalls = 0; window.__dtValueCalls = 0;
  function line(o) { var s = SUBS[o.sublistId], l = s && s.lines[o.line]; if (!l) throw new Error('You have attempted an invalid sublist or line item operation.'); return l; }
  var saved = {
    getFields: function () { return Object.keys(SAVED); },
    getField: function (o) { var f = SAVED[o.fieldId]; return f ? { id: o.fieldId, label: f[1], type: f[2] } : null; },
    getValue: function (o) { var f = SAVED[o.fieldId]; if (f && /^datetime/.test(f[2])) window.__dtValueCalls++; return f ? f[0] : undefined; },
    getText: function (o) { window.__getTextCalls++; var f = SAVED[o.fieldId]; return f ? (f[3] || f[0]) : undefined; },
    getSublists: function () { return Object.keys(SUBS); },
    getLineCount: function (o) { return SUBS[o.sublistId] ? SUBS[o.sublistId].lines.length : -1; },
    getSublistFields: function (o) { return SUBS[o.sublistId] ? Object.keys(SUBS[o.sublistId].meta) : []; },
    getSublistField: function (o) { line(o); var m = SUBS[o.sublistId].meta[o.fieldId]; return m ? { id: o.fieldId, label: m[0], type: m[1] } : null; },
    getSublistValue: function (o) { return line(o)[o.fieldId]; },
    getSublistText: function (o) { window.__subTextCalls++; var l = line(o), t = SUBS[o.sublistId].text[o.line]; return t && t[o.fieldId] !== undefined ? t[o.fieldId] : String(l[o.fieldId] == null ? '' : l[o.fieldId]); },
    setValue: function () { throw new Error('TEST FAILURE: the explorer must never write to the record'); }
  };
  var mod = { load: function () { throw new Error('TEST FAILURE: use load.promise'); } };
  mod.load.promise = function () { window.__recordLoads++; return new Promise(function (res) { setTimeout(function () { res(saved); }, 50); }); };
  var srch = { lookupFields: {} };
  srch.lookupFields.promise = function (o) {
    return Promise.resolve(o.columns.reduce(function (out, c) { var f = SAVED[c]; if (f && f[3]) out[c] = [{ value: f[0], text: f[3] }]; return out; }, {}));
  };
  window.require = function (deps, cb, eb) {
    setTimeout(function () {
      if (deps[0] === 'N/record') cb(mod);
      else if (deps[0] === 'N/search') cb(srch);
      else if (deps[0] === 'N/format' && !noFmt) cb(fmtMod);
      else if (deps[0] === 'N/query' && window.__nsQuery) cb(window.__nsQuery);
      else if (eb) eb(new Error('Module not found: ' + deps[0]));
    }, 10);
  };
  /* ?hiddenfield=1: fields the form sets to display type Hidden, which NetSuite renders as bare hidden inputs. */
  if (/[?&]hiddenfield=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('.form');
    /* customsublist9loaded is NetSuite plumbing that only looks custom. */
    [['custbody_flag', 'T'], ['custpage_script_note', 'x'], ['customsublist9loaded', 'F']].forEach(function (p) {
      var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; form.appendChild(i);
    });
  });
  /* ?typeinputs=1: the record-type inputs a real vendor bill has (sandbox, 2026-11-09), all unlabelled.
   * Only baserecordtype (the type the panel's title bar shows) should be listed. */
  if (/[?&]typeinputs=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('.form');
    [['type', 'vendbill'], ['dbstrantype', 'VendBill'], ['ntype', '17'], ['baserecordtype', 'vendorbill']].forEach(function (p) {
      var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; form.appendChild(i);
    });
  });
  /* ?tokens=1: the session and security tokens a real NetSuite page carries as bare hidden inputs (names
   * as on NetSuite, values made up), and the saved record (Not on form) also reports _csrf and _eml_nkey_
   * with no label. None may be listed, searched, exported or pinned. window.__tokens lists them for the tests. */
  if (/[?&]tokens=1/.test(location.search)) {
    window.__tokens = [['_csrf', '9f2c4e7a1b6d8f03c5e2a94b7d1f6e08a3c9b25d4e7f1a6c'], ['_eml_nkey_', '1234567_SB1_7b3e9a2c5f8d1e64:a9c2e7f4b1d8'],
      ['wfinstances', 'e8d1c6b3a0f7942516d3c8b0'], ['nsapiCT', '1762961234567a9b8c7d6e5f4'], ['nlapiPI', 'b5a4c3d2e1f0918273645a5b6c7d8e9f'],
      ['nluser', 'd7e6f5a4b3c2918a0b1c2d3e'], ['nsbrowserenv', 'c1d2e3f4a5b6978695a4b3c2d1e0f9a8'], ['entryformquerystring', 'f0e9d8c7b6a5e=4d3c2b1a0918f7e6'],
      ['_button', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'], ['selectedtab', '0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f']];
    SAVED._csrf = [window.__tokens[0][1], '', 'text'];
    SAVED._eml_nkey_ = [window.__tokens[1][1], '', 'text'];
    document.addEventListener('DOMContentLoaded', function () {
      var form = document.querySelector('.form');
      window.__tokens.forEach(function (p) {
        var i = form.querySelector('input[type="hidden"][name="' + p[0] + '"]');
        if (!i) { i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; form.appendChild(i); }
        i.value = p[1];
      });
    });
  }
  /* ?segment=1: a custom segment (cseg...) and the standard Custom Form field (customform), which only
   * looks custom. Added after the other body fields. */
  if (/[?&]segment=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('.form');
    [['cseg1', 'Region'], ['customform', 'Custom Form']].forEach(function (p) {
      var d = document.createElement('div');
      d.setAttribute('data-nsps-type', 'field'); d.setAttribute('data-field-name', p[0]); d.setAttribute('data-field-type', 'select');
      d.setAttribute('data-nsps-label', p[1]); d.setAttribute('data-mode', 'edit');
      form.appendChild(d);
    });
  });
  /* ?tabs=1: NetSuite Next tab markup, as seen on the sandbox. A tab's content is <name>_wrapper > <name>_div
   * and a subtab's is <name>_layer; each pairs with a[data-nsps-type="tab"|"subtab"][data-nsps-id="<name>"].
   *  - Billing tab: the Terms field, below a tall spacer so Locate has to scroll.
   *  - Vantage tab (custom341): custbody_slow, shown 400 ms after the click, like NetSuite's ShowTab on
   *    custom tabs in view mode.
   *  - Flaky tab (custom1008): custbody_flaky; NetSuite sometimes drops a tab click, so this tab ignores
   *    its first click.
   *  - item subtab: the item sublist table moves into item_layer, hidden until its subtab link is clicked.
   *  - custbody_formhidden and the first Notes column are hidden by the form itself (no tab can show them).
   * Tab clicks are counted in window.__tabClicks. */
  if (/[?&]tabs=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('.form');
    window.__tabClicks = [];
    function field(id, label) {
      var f = document.createElement('div');
      f.setAttribute('data-nsps-type', 'field'); f.setAttribute('data-field-name', id); f.setAttribute('data-field-type', 'text');
      f.setAttribute('data-nsps-label', label); f.setAttribute('data-mode', 'edit');
      f.appendChild(document.createElement('input')).name = id;
      return f;
    }
    function tabContent(name, child) {
      var wrap = document.createElement('div'), div = document.createElement('div');
      wrap.id = name + '_wrapper'; div.id = name + '_div'; wrap.style.display = 'none';
      div.appendChild(child); wrap.appendChild(div);
      return wrap;
    }
    var panes = { billingtab: tabContent('billingtab', field('terms', 'Terms')), custom341: tabContent('custom341', field('custbody_slow', 'Slow tab field')),
      custom1008: tabContent('custom1008', field('custbody_flaky', 'Flaky tab field')) };
    var bar = document.createElement('div');
    function link(type, name, text, selected, onClick) {
      var a = document.createElement('a');
      a.href = '#'; a.id = name + 'txt'; a.textContent = text; a.setAttribute('role', 'tab');
      a.setAttribute('data-nsps-type', type); a.setAttribute('data-nsps-id', name); a.setAttribute('aria-selected', String(selected));
      a.addEventListener('click', function (e) { e.preventDefault(); window.__tabClicks.push(name); onClick(a); });
      return a;
    }
    function selectTab(a) { bar.querySelectorAll('a').forEach(function (x) { x.setAttribute('aria-selected', String(x === a)); }); }
    function show(name) { Object.keys(panes).forEach(function (k) { panes[k].style.display = k === name ? 'block' : 'none'; }); }
    bar.appendChild(link('tab', 'main', 'Main', true, function (a) { selectTab(a); show(''); }));
    bar.appendChild(link('tab', 'billingtab', 'Billing', false, function (a) { selectTab(a); show('billingtab'); }));
    bar.appendChild(link('tab', 'custom341', 'Vantage', false, function (a) { selectTab(a); setTimeout(function () { show('custom341'); }, 400); }));
    var flakyClicks = 0;
    bar.appendChild(link('tab', 'custom1008', 'Flaky', false, function (a) { if (++flakyClicks === 1) return; selectTab(a); show('custom1008'); }));
    var spacer = document.createElement('div'); spacer.className = 'spacer';
    form.appendChild(bar); form.appendChild(spacer); form.appendChild(panes.billingtab); form.appendChild(panes.custom341); form.appendChild(panes.custom1008);
    /* The item sublist inside its subtab layer. */
    var layer = document.getElementById('item_layer'), table = document.getElementById('item_splits');
    layer.appendChild(table); layer.style.display = 'none';
    layer.parentNode.insertBefore(link('subtab', 'item', 'Items', false, function (a) { a.setAttribute('aria-selected', 'true'); layer.style.display = 'block'; }), layer);
    /* Hidden by the form itself, not by a tab: Locate can't show these, so they get no eye. */
    var hid = field('custbody_formhidden', 'Hidden by the form'); hid.style.display = 'none';
    form.insertBefore(hid, bar);
    document.querySelectorAll('td[data-nsps-type="columnheader"][data-label="Notes"]')[0].style.display = 'none';
    /* &plant=1: look-alike Billing tab links planted ahead of the real one, as from inline HTML: one that
     * would navigate, and one inside an inline HTML field (data-field-type="inlinehtml", which on the
     * sandbox is not inside a field wrapper). Locate must click neither; clicks are counted in __plantedClicks. */
    if (/[?&]plant=1/.test(location.search)) {
      window.__plantedClicks = 0;
      var nav = document.createElement('a'), box = document.createElement('div'), quiet = document.createElement('a');
      nav.href = '?planted=1'; quiet.href = '#';
      box.setAttribute('data-field-type', 'inlinehtml'); box.setAttribute('data-field-name', 'custpage_planted');
      [nav, quiet].forEach(function (a) {
        a.textContent = 'Billing'; a.setAttribute('data-nsps-type', 'tab'); a.setAttribute('data-nsps-id', 'billingtab');
        a.addEventListener('click', function (e) { e.preventDefault(); window.__plantedClicks++; });
      });
      box.appendChild(quiet);
      document.body.insertBefore(box, document.body.firstChild);
      document.body.insertBefore(nav, document.body.firstChild);
    }
  });
  /* ?protokeys=1: planted fields (as from an inline HTML field) whose IDs are names of built-in object
   * properties. They pass the ID check, so they must not break the explorer's lookups. */
  if (/[?&]protokeys=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var box = document.querySelector('.inlinehtml');
    ['hasOwnProperty', '__proto__', 'constructor', 'toString'].forEach(function (id) {
      var d = document.createElement('div');
      d.setAttribute('data-nsps-type', 'field'); d.setAttribute('data-field-name', id); d.setAttribute('data-field-type', 'text');
      d.setAttribute('data-nsps-label', 'Planted ' + id); d.setAttribute('data-mode', 'edit'); d.textContent = 'planted';
      box.appendChild(d);
    });
  });
  /* Fill the inputs so the page looks like the data. */
  document.addEventListener('DOMContentLoaded', function () {
    Object.keys(BODY).forEach(function (k) { var el = document.querySelector('[name="' + k + '"]'); if (el) el.value = BODY[k].replace(/\u0005/g, ','); });
  });
})();
