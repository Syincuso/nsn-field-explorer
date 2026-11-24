/* Demo vendor bill for the reviewer video and store images: a NetSuite Next record page with invented data (the
 * same bill as the store screenshots). It builds the page with the markup NetSuite uses in edit mode
 * (data-nsps-* / data-field-*) and mocks the page functions the extension reads: nlapi* (the form's values),
 * getMachineByName for the sublist columns, and require() for N/record (the saved record, for Not on form and
 * Compare), N/search (select names), N/format (dates) and N/query (custom field setup links).
 * The form has unsaved edits, so Pin > Compare with the saved record has something to show: Due Date, Terms,
 * Amount, Memo and 3-Way Match changed, item line 2's quantity went from 5 to 6, and item line 5 was added.
 * Nothing is saved anywhere, and the buttons do nothing. */
(function () {
  var TYPE = 'vendorbill', ID = '1042';

  /* Select options: field -> { value: text }. */
  var OPT = {
    customform: { 102: 'Standard Vendor Bill' }, entity: { 318: 'Northwind Office Supply' }, terms: { 1: 'Net 15', 2: 'Net 30' },
    account: { 112: '2000 Accounts Payable' }, currency: { 1: 'USD' }, approvalstatus: { 1: 'Pending Approval' },
    custbody_received_by: { 44: 'Dana Ortiz' }, subsidiary: { 1: 'Honeycomb Mfg.' }, department: { 3: 'Operations' },
    class: { 7: 'Facilities' }, location: { 2: 'Denver HQ' }, custbody_cost_center: { 210: 'CC-210 Workplace' },
    postingperiod: { 143: 'Nov 2026' }
  };

  /* Body fields: [id, label, type, value on the form, required, saved value if the form changed it].
   * Laid out three to a row; null leaves a cell empty. */
  var SECTIONS = [
    ['Primary Information', [
      ['customform', 'Custom Form', 'select', '102', true], ['entity', 'Vendor', 'select', '318', true], ['tranid', 'Reference No.', 'text', 'VB-1042', true],
      ['trandate', 'Date', 'date', '11/3/2026', true], ['duedate', 'Due Date', 'date', '12/3/2026', false, '11/18/2026'], ['terms', 'Terms', 'select', '2', false, '1'],
      ['account', 'Account', 'select', '112', true], ['usertotal', 'Amount', 'currency', '4411.50', false, '4086'], ['currency', 'Currency', 'select', '1', true],
      ['exchangerate', 'Exchange Rate', 'currency', '1.00', true], ['memo', 'Memo', 'textarea', 'Q4 office furniture and supplies', false, 'Q4 office furniture'], ['approvalstatus', 'Approval Status', 'select', '1'],
      ['custbody_po_reference', 'PO Reference', 'text', 'PO-20871'], ['custbody_received_by', 'Received By', 'select', '44'], ['custbody_three_way_match', '3-Way Match', 'checkbox', 'T', false, 'F']
    ]],
    ['Classification', [
      ['subsidiary', 'Subsidiary', 'select', '1', true], ['department', 'Department', 'select', '3'], ['class', 'Class', 'select', '7'],
      ['location', 'Location', 'select', '2'], ['custbody_cost_center', 'Cost Center', 'select', '210'], null,
      ['custbody_ap_note', 'AP Note', 'text', 'Matched to receipt RCPT-5521'], ['custbody_vendor_invoice', 'Vendor Invoice', 'text', 'INV-88412'], null,
      ['custbody_hold_reason', 'Hold Reason', 'text', '']
    ]]
  ];
  var BILLING = [['postingperiod', 'Posting Period', 'select', '143', true], ['discountdate', 'Discount Date', 'date', '']];
  /* Bare hidden inputs, as NetSuite renders them. The extension lists baserecordtype and leaves out the type
   * inputs and the session plumbing. */
  var HIDDEN = [['baserecordtype', 'vendorbill'], ['type', 'vendbill'], ['ntype', '17'], ['createddate', '11/3/2026 9:14 am'],
    ['lastmodifieddate', '11/4/2026 3:02 pm'], ['nluser', '1088'], ['_csrf', 'demo-session-token']];

  /* Sublists: columns [id, label, type]; each line is [values in column order] plus the names of its select values. */
  var ITEM_COLS = [['item', 'Item', 'select'], ['description', 'Description', 'textarea'], ['quantity', 'Quantity', 'float'], ['units', 'Units', 'select'],
    ['rate', 'Rate', 'currency'], ['amount', 'Amount', 'currency'], ['department', 'Department', 'select'], ['location', 'Location', 'select'],
    ['class', 'Class', 'select'], ['custcol_project', 'Project', 'select'], ['custcol_asset_tag', 'Asset Tag', 'text'], ['taxcode', 'Tax Code', 'select'],
    ['isbillable', 'Billable', 'checkbox'], ['custcol_gl_review', 'GL Review', 'checkbox']];
  var NAMES = { units: { 1: 'Each', 2: 'Case' }, department: { 3: 'Operations', 5: 'Admin' }, location: { 2: 'Denver HQ', 4: 'Boulder Lab' },
    class: { 7: 'Facilities' }, custcol_project: { 31: 'HQ Refit 2026' }, taxcode: { 5: 'Not Taxable' },
    item: { 801: 'OF-DESK-60', 802: 'OF-CHAIR-ERG', 803: 'OF-ARM-DUAL', 804: 'SUP-PAPER-10', 805: 'SUP-TONER-BK' },
    account: { 615: '6150 Freight and Delivery' } };
  var ITEM_LINES = [
    ['801', 'Standing desk, 60 in', '4', '1', '489.00', '1956.00', '3', '2', '7', '31', 'AT-3301', '5', 'F', 'T'],
    ['802', 'Ergonomic task chair', '6', '1', '245.00', '1470.00', '3', '2', '7', '31', 'AT-3302', '5', 'F', 'F'],
    ['803', 'Monitor arm, dual', '6', '1', '72.50', '435.00', '3', '2', '7', '31', 'AT-3303', '5', 'F', 'F'],
    ['804', 'Copy paper, 10 ream case', '12', '2', '28.75', '345.00', '5', '2', '7', '', '', '5', 'F', 'F'],
    ['805', 'Toner cartridge, black', '2', '1', '40.25', '80.50', '5', '4', '7', '', '', '5', 'F', 'F']
  ];
  function lines(cols, rows) {
    return rows.map(function (r) {
      var v = {}, t = {};
      cols.forEach(function (c, i) { v[c[0]] = r[i]; if (c[2] === 'select') t[c[0]] = r[i] && NAMES[c[0]] ? NAMES[c[0]][r[i]] || '' : ''; });
      return { v: v, t: t };
    });
  }
  var SUBS = {
    item: { cols: ITEM_COLS, lines: lines(ITEM_COLS, ITEM_LINES) },
    expense: { cols: [['account', 'Account', 'select'], ['amount', 'Amount', 'currency'], ['memo', 'Memo', 'text'], ['department', 'Department', 'select'], ['location', 'Location', 'select']] },
    landedcost: { cols: [['landedcostcategory', 'Cost Category', 'select'], ['amount', 'Amount', 'currency']], lines: [] },
    installment: { cols: [['duedate', 'Due Date', 'date'], ['amount', 'Amount', 'currency']], lines: [] }
  };
  SUBS.expense.lines = lines(SUBS.expense.cols, [['615', '125.00', 'White-glove delivery', '3', '2']]);
  /* The saved record's lines: item line 2 had quantity 5 (amount 1225) and line 5 is new on the form. */
  var SAVED_LINES = {
    item: lines(ITEM_COLS, [ITEM_LINES[0], ITEM_LINES[1].slice(0, 2).concat(['5'], ITEM_LINES[1].slice(3, 5), ['1225.00'], ITEM_LINES[1].slice(6)), ITEM_LINES[2], ITEM_LINES[3]]),
    expense: SUBS.expense.lines, landedcost: [], installment: []
  };

  /* Fields the saved record has but the form doesn't show (the Not on form tab): [id, label, type, value, name].
   * The unlabelled ones are shown as likely internal. */
  var EXTRA = [
    ['createdfrom', 'Created From', 'select', '20871', 'Purchase Order #PO-20871'],
    ['nextapprover', 'Next Approver', 'select', '57', 'Jordan Rivera'],
    ['transactionnumber', 'Transaction Number', 'text', 'VENDBILL1042'],
    ['custbody_vendor_rating', 'Vendor Rating', 'text', 'A'],
    ['custbody_ap_batch', 'AP Batch', 'text', 'APB-2026-11-04'],
    ['entitynexus', '', 'select', '1', 'US'],
    ['isbasecurrency', '', 'checkbox', true]
  ];

  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  function optText(id, v) { return own(OPT, id) && own(OPT[id], v) ? OPT[id][v] : ''; }
  function money(v) { return v === '' || v == null ? '' : Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function parseDate(s) {
    var m = /^(\d+)\/(\d+)\/(\d{4})(?: (\d+):(\d+) (am|pm))?$/.exec(s || '');
    if (!m) return null;
    var h = m[4] ? (+m[4] % 12) + (m[6] === 'pm' ? 12 : 0) : 0;
    return new Date(+m[3], +m[1] - 1, +m[2], h, m[5] ? +m[5] : 0);
  }
  var FIELDS = [];
  SECTIONS.forEach(function (s) { s[1].forEach(function (f) { if (f) FIELDS.push(f); }); });
  BILLING.forEach(function (f) { FIELDS.push(f); });
  var FORM = {};
  FIELDS.forEach(function (f) { FORM[f[0]] = f; });

  /* ---------- the page functions the extension reads (edit mode: the form's live values) ---------- */
  window.nlapiGetRecordType = function () { return TYPE; };
  window.nlapiGetRecordId = function () { return ID; };
  window.nlapiGetFieldValue = function (id) {
    if (own(FORM, id)) return FORM[id][3];
    var e = document.getElementsByName(id)[0];
    return e ? e.value : null;
  };
  window.nlapiGetFieldText = function (id) { return own(FORM, id) && FORM[id][2] === 'select' ? optText(id, FORM[id][3]) : ''; };
  window.nlapiGetLineItemCount = function (s) { return own(SUBS, s) ? SUBS[s].lines.length : -1; };
  window.nlapiGetLineItemValue = function (s, f, l) { var x = own(SUBS, s) && SUBS[s].lines[l - 1]; return x && own(x.v, f) ? x.v[f] : null; };
  window.nlapiGetLineItemText = function (s, f, l) { var x = own(SUBS, s) && SUBS[s].lines[l - 1]; return x && own(x.t, f) ? x.t[f] : ''; };
  window.getMachineByName = function (s) {
    if (!own(SUBS, s)) return null;
    var c = SUBS[s].cols;
    return {
      countFormElements: function () { return c.length; },
      getFormElementName: function (i) { return c[i - 1][0]; },
      getFormElementLabel: function (i) { return c[i - 1][1]; },
      getFormElementType: function (i) { return c[i - 1][2]; }
    };
  };

  /* ---------- the saved record (N/record), as record.load gives it: typed values ---------- */
  var SAVED = {};
  function typed(type, v) {
    if (type === 'checkbox') return v === true || v === 'T';
    if (type === 'currency' || type === 'float') return v === '' || v == null ? '' : Number(v);
    if (/^date/.test(type)) return typeof v === 'string' ? parseDate(v) : v;
    return v;
  }
  function addSaved(id, label, type, v, name) { SAVED[id] = { label: label, type: type, value: typed(type, v), name: name || (type === 'select' ? optText(id, v) : '') }; }
  FIELDS.forEach(function (f) { addSaved(f[0], f[1], f[2], f.length > 5 ? f[5] : f[3]); });
  addSaved('baserecordtype', '', 'text', 'vendorbill');
  addSaved('createddate', '', 'datetime', '11/3/2026 9:14 am');
  addSaved('lastmodifieddate', '', 'datetime', '11/4/2026 3:02 pm');
  EXTRA.forEach(function (f) { addSaved(f[0], f[1], f[2], f[3], f[4]); });
  function savedLine(o) {
    var l = own(SAVED_LINES, o.sublistId) && SAVED_LINES[o.sublistId][o.line];
    if (!l) throw new Error('You have attempted an invalid sublist or line item operation.');
    return l;
  }
  function col(s, id) { var c = SUBS[s].cols; for (var i = 0; i < c.length; i++) if (c[i][0] === id) return c[i]; return null; }
  var record = {
    getFields: function () { return Object.keys(SAVED); },
    getField: function (o) { var f = own(SAVED, o.fieldId) && SAVED[o.fieldId]; return f ? { id: o.fieldId, label: f.label, type: f.type } : null; },
    getValue: function (o) { return own(SAVED, o.fieldId) ? SAVED[o.fieldId].value : undefined; },
    getText: function (o) { var f = own(SAVED, o.fieldId) && SAVED[o.fieldId]; return f ? (f.name || String(f.value == null ? '' : f.value)) : undefined; },
    getSublists: function () { return Object.keys(SUBS); },
    getLineCount: function (o) { return own(SAVED_LINES, o.sublistId) ? SAVED_LINES[o.sublistId].length : -1; },
    getSublistFields: function (o) { return own(SUBS, o.sublistId) ? SUBS[o.sublistId].cols.map(function (c) { return c[0]; }) : []; },
    getSublistField: function (o) { savedLine(o); var c = col(o.sublistId, o.fieldId); return c ? { id: c[0], label: c[1], type: c[2] } : null; },
    getSublistValue: function (o) { var c = col(o.sublistId, o.fieldId); return c ? typed(c[2], savedLine(o).v[o.fieldId]) : undefined; },
    getSublistText: function (o) { var l = savedLine(o); return own(l.t, o.fieldId) ? l.t[o.fieldId] : String(own(l.v, o.fieldId) ? l.v[o.fieldId] : ''); }
  };
  var recordMod = { load: { promise: function () { return new Promise(function (res) { setTimeout(function () { res(record); }, 300); }); } } };
  /* N/search: select names in one lookup, as lookupFields returns them. */
  var searchMod = { lookupFields: { promise: function (o) {
    var out = {};
    o.columns.forEach(function (c) { var f = own(SAVED, c) && SAVED[c]; if (f && f.name) out[c] = [{ value: String(f.value), text: f.name }]; });
    return new Promise(function (res) { setTimeout(function () { res(out); }, 150); });
  } } };
  /* N/format with the date preference M/D/YYYY and 12-hour times. */
  var formatMod = { Type: { DATE: 'date', DATETIME: 'datetime' }, format: function (o) {
    var d = o.value, s = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(), h = d.getHours(), m = d.getMinutes();
    return o.type === 'datetime' ? s + ' ' + (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'am' : 'pm') : s;
  } };
  /* N/query: the custom field definitions behind the setup links (script IDs upper case). */
  var CUSTOM = { CUSTBODY_PO_REFERENCE: 201, CUSTBODY_RECEIVED_BY: 202, CUSTBODY_THREE_WAY_MATCH: 203, CUSTBODY_COST_CENTER: 204,
    CUSTBODY_AP_NOTE: 205, CUSTBODY_VENDOR_INVOICE: 206, CUSTBODY_HOLD_REASON: 207, CUSTBODY_VENDOR_RATING: 208, CUSTBODY_AP_BATCH: 209,
    CUSTCOL_PROJECT: 301, CUSTCOL_ASSET_TAG: 302, CUSTCOL_GL_REVIEW: 303 };
  var queryMod = { runSuiteQL: { promise: function (o) {
    var rows = [];
    if (/FROM customfield/i.test(o.query)) (o.params || []).forEach(function (p) {
      if (own(CUSTOM, p)) rows.push({ id: CUSTOM[p], scriptid: p, fieldtype: /^CUSTCOL/.test(p) ? 'COLUMN' : 'BODY' });
    });
    return new Promise(function (res) { setTimeout(function () { res({ asMappedResults: function () { return rows; } }); }, 120); });
  } } };
  var MODULES = { 'N/record': recordMod, 'N/search': searchMod, 'N/format': formatMod, 'N/query': queryMod };
  window.require = function (deps, cb, eb) {
    setTimeout(function () {
      if (own(MODULES, deps[0])) cb(MODULES[deps[0]]);
      else if (eb) eb(new Error('Module not found: ' + deps[0]));
    }, 20);
  };

  /* ---------- the page ---------- */
  function make(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function link(text) { var a = make('a', 'lnk', text); a.href = '#'; return a; }
  /* A value as NetSuite shows it: select names as links, checkboxes as a box, amounts with separators. */
  function shown(type, v, text) {
    if (type === 'select') return v ? link(text) : make('span');
    if (type === 'checkbox') return make('span', 'cb' + (v === 'T' ? ' on' : ''));
    return make('span', '', type === 'currency' ? money(v) : v);
  }
  function field(f) {
    if (!f) return make('div', 'fld');
    var w = make('div', 'fld');
    w.setAttribute('data-nsps-type', 'field'); w.setAttribute('data-field-name', f[0]); w.setAttribute('data-field-type', f[2]);
    w.setAttribute('data-nsps-label', f[1]); w.setAttribute('data-mode', 'edit');
    if (f[4]) w.setAttribute('data-required', 'true');
    w.appendChild(make('div', 'lbl', f[1]));
    var v = make('div', 'val'); v.appendChild(shown(f[2], f[3], optText(f[0], f[3]))); w.appendChild(v);
    return w;
  }
  function chevron() {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'chev'); p.setAttribute('d', 'm6 9 6 6 6-6'); s.appendChild(p);
    return s;
  }
  function section(title, fields) {
    var s = make('section', 'sec'), h = make('h2'), g = make('div', 'grid');
    h.appendChild(chevron()); h.appendChild(document.createTextNode(title)); s.appendChild(h);
    fields.forEach(function (f) { g.appendChild(field(f)); });
    s.appendChild(g);
    return s;
  }
  /* A tab bar of a[data-nsps-type="tab"|"subtab"] links over <name>_wrapper > <name>_div (tabs) or <name>_layer
   * (subtabs) panes, as on NetSuite Next. */
  function tabBar(kind, items, paneOf) {
    var bar = make('div', kind === 'tab' ? 'tabs' : 'subtabs');
    bar.setAttribute('role', 'tablist');
    items.forEach(function (it, i) {
      var a = make('a', '', it[1]);
      a.href = '#'; a.id = it[0] + 'txt'; a.setAttribute('role', 'tab');
      a.setAttribute('data-nsps-type', kind); a.setAttribute('data-nsps-id', it[0]); a.setAttribute('aria-selected', String(i === 0));
      a.addEventListener('click', function (e) {
        e.preventDefault();
        items.forEach(function (x) {
          document.getElementById(x[0] + 'txt').setAttribute('aria-selected', String(x === it));
          paneOf(x[0]).style.display = x === it ? '' : 'none';
        });
      });
      bar.appendChild(a);
    });
    return bar;
  }
  function sublist(sid) {
    var s = SUBS[sid], layer = make('div', 'layer'), wrap = make('div', 'tw'), t = make('table', 'lines'), head = t.insertRow(-1);
    layer.id = sid + '_layer';
    var mark = make('div'); mark.setAttribute('data-nsps-type', 'sublist'); mark.setAttribute('data-nsps-id', sid);
    layer.appendChild(mark);
    t.id = sid + '_splits'; t.setAttribute('data-sublist-id', sid);
    /* Edit-mode header cells carry data-label but no data-nsps-id, and the cells no data-field-name, as on NetSuite. */
    s.cols.forEach(function (c) {
      var td = head.insertCell(-1);
      td.setAttribute('data-nsps-type', 'columnheader'); td.setAttribute('data-label', c[1]); td.textContent = c[1];
      if (c[2] === 'currency' || c[2] === 'float') td.className = 'num';
    });
    s.lines.forEach(function (l) {
      var tr = t.insertRow(-1);
      s.cols.forEach(function (c, i) {
        var td = tr.insertCell(-1);
        td.appendChild(i === 0 && c[2] === 'select' ? link(l.t[c[0]]) : shown(c[2] === 'select' ? 'text' : c[2], c[2] === 'select' ? l.t[c[0]] : l.v[c[0]]));
        if (c[2] === 'currency' || c[2] === 'float') td.className = 'num';
      });
    });
    if (!s.lines.length) { var e = t.insertRow(-1).insertCell(-1); e.colSpan = s.cols.length; e.className = 'none'; e.textContent = 'No records to show.'; }
    wrap.appendChild(t); layer.appendChild(wrap);
    return layer;
  }
  function subtabs(items) {
    var box = make('div'), layers = {};
    items.forEach(function (it, i) { layers[it[0]] = sublist(it[0]); if (i) layers[it[0]].style.display = 'none'; });
    box.appendChild(tabBar('subtab', items, function (n) { return layers[n]; }));
    items.forEach(function (it) { box.appendChild(layers[it[0]]); });
    return box;
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('tranid').textContent = FORM.tranid[3];
    document.getElementById('status').textContent = optText('approvalstatus', FORM.approvalstatus[3]);
    document.getElementById('kdate').textContent = FORM.trandate[3];
    document.getElementById('kvendor').textContent = optText('entity', FORM.entity[3]);
    var form = document.getElementById('main');
    SECTIONS.forEach(function (s) { form.appendChild(section(s[0], s[1])); });
    var TABS = [['itemstab', 'Expenses and Items'], ['billingtab', 'Billing'], ['relatedtab', 'Related Records'], ['commtab', 'Communication']], panes = {};
    TABS.forEach(function (t, i) {
      var wrap = make('div', 'pane'), div = make('div');
      wrap.id = t[0] + '_wrapper'; div.id = t[0] + '_div';
      if (i) wrap.style.display = 'none';
      wrap.appendChild(div); panes[t[0]] = wrap;
    });
    panes.itemstab.firstChild.appendChild(subtabs([['item', 'Items (' + SUBS.item.lines.length + ')'], ['expense', 'Expenses (' + SUBS.expense.lines.length + ')'], ['landedcost', 'Landed Cost']]));
    var g = make('div', 'grid'); BILLING.forEach(function (f) { g.appendChild(field(f)); });
    panes.billingtab.firstChild.appendChild(g);
    panes.billingtab.firstChild.appendChild(subtabs([['installment', 'Installments']]));
    panes.relatedtab.firstChild.appendChild(make('p', 'none', 'No records to show.'));
    panes.commtab.firstChild.appendChild(make('p', 'none', 'No records to show.'));
    var box = make('section', 'sec tabbox');
    box.appendChild(tabBar('tab', TABS, function (n) { return panes[n]; }));
    TABS.forEach(function (t) { box.appendChild(panes[t[0]]); });
    form.appendChild(box);
    HIDDEN.forEach(function (h) { var i = make('input'); i.type = 'hidden'; i.name = h[0]; i.value = h[1]; form.appendChild(i); });
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a.lnk')) e.preventDefault(); });
  });
})();

/* Generated by Claude and Ammon Wendel. Questions or help: info@syincuso.com */
