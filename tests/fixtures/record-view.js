/* View-mode NetSuite mock, modelled on a real NetSuite Next vendor bill in view mode:
 *  - nlapiGetFieldValue returns null, nlapiGetLineItemCount returns -1, no getMachineByName machines;
 *  - NetSuite's AMD require() can load N/record, whose load.promise() returns the full record.
 * ?recfail=1 makes record.load reject, to test the fallback to page text. */
(function () {
  var fail = /[?&]recfail=1/.test(location.search);
  /* ?slowlookup=1: the background name request takes 0.8 s. ?extrarow=1: the page table gets an extra
   * line row, so its rows no longer pair up with the record's lines. */
  var slowLookup = /[?&]slowlookup=1/.test(location.search);
  if (/[?&]extrarow=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var tb = document.getElementById('item_splits'), tr = tb.insertRow(1);
    ['item', 'description', 'amount', 'custcol_a', 'custcol_b'].forEach(function (f) { var td = tr.insertCell(-1); td.setAttribute('data-field-name', f); td.textContent = 'EXTRA'; });
  });
  /* ?protokeys=1: planted body fields and page-table cells whose IDs are names of built-in object
   * properties (as from an inline HTML field). */
  if (/[?&]protokeys=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('.form');
    ['hasOwnProperty', '__proto__', 'constructor'].forEach(function (id) {
      var d = document.createElement('div');
      d.setAttribute('data-nsps-type', 'field'); d.setAttribute('data-field-name', id); d.setAttribute('data-field-type', 'text');
      d.setAttribute('data-nsps-label', 'Planted ' + id); d.setAttribute('data-mode', 'view'); d.textContent = 'planted';
      form.appendChild(d);
    });
    var tb = document.getElementById('item_splits');
    [1, 2].forEach(function (r) { var td = tb.rows[r].insertCell(-1); td.setAttribute('data-field-name', 'hasOwnProperty'); td.textContent = 'x'; });
  });
  window.__subTextCalls = 0;
  /* Real view mode returns null for almost everything, but a few fields (subsidiary) give a bare ID. */
  window.nlapiGetFieldValue = function (id) { return id === 'subsidiary' ? '56' : null; };
  window.nlapiGetFieldText = function () { return null; };
  window.nlapiGetRecordType = function () { return 'vendorbill'; };
  window.nlapiGetRecordId = function () { return '2002'; };
  window.nlapiGetLineItemCount = function () { return -1; };
  window.nlapiGetLineItemValue = function () { return null; };
  window.nlapiGetLineItemText = function () { return null; };

  var F = {
    tranid: { v: 'VB-2002', label: 'Reference No.', type: 'text' },
    entity: { v: '7', t: 'Acme Supply', label: 'Vendor', type: 'select' },
    subsidiary: { v: '56', t: 'Acme Corp', label: 'Subsidiary', type: 'select' },
    trandate: { v: new Date(2026, 7, 19), t: '8/19/2026', label: 'Date', type: 'date' },
    paymenthold: { v: false, label: 'Payment Hold', type: 'checkbox' },
    memo: { v: '', label: 'Memo', type: 'text' },
    custbody_tags: { v: ['1', '2'], t: ['Red', 'Blue'], label: 'Tags', type: 'multiselect' },
    custbody_empty: { v: '', label: 'Empty field', type: 'text' },
    custbody_hidden: { v: 'not on the form', label: 'Hidden field', type: 'text' },
    custbody_approver: { v: '9', t: 'Pat Lee', label: 'Approver', type: 'select' },
    custbody_due: { v: new Date(2026, 8, 18), t: '9/18/2026', label: 'Due', type: 'date' },
    nexus: { v: '3', t: 'Nevada', label: 'Nexus', type: 'select' },
    /* Like real NetSuite: an internal field the record has, with no label. */
    sys_id: { v: '15152967719228612', label: '', type: '' }
  };
  /* ?hiddenfield=1: a standard and a custom field set to display type Hidden on the form; NetSuite renders
   * them as bare hidden inputs, and the saved record has both. */
  if (/[?&]hiddenfield=1/.test(location.search)) {
    F.externalid = { v: 'EXT-9', label: 'External ID', type: 'text' };
    F.custbody_vendor_hddn = { v: '7', t: 'Acme Supply', label: 'Vendor (hidden)', type: 'select' };
    /* As on real NetSuite, the record also reports page plumbing (no label) and unlabelled system dates. */
    F.nlrole = { v: '1559', label: '', type: 'text' };
    F.createddate = { v: new Date(2026, 7, 19, 16, 23), label: '', type: 'datetime' };
    document.addEventListener('DOMContentLoaded', function () {
      var form = document.querySelector('.form');
      [['externalid', 'EXT-9'], ['custbody_vendor_hddn', '7'], ['nlrole', '1559'], ['createddate', '8/19/2026 4:23 pm']].forEach(function (p) {
        var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; form.appendChild(i);
      });
    });
  }
  /* ?typeinputs=1: the record-type fields a real vendor bill has (sandbox, 2026-11-09): unlabelled in the
   * record and bare hidden inputs on the page. ?typeinputs=2: the record has them, the page does not. */
  var qRt = /[?&]typeinputs=([12])/.exec(location.search);
  if (qRt) {
    var RT = [['type', 'vendbill'], ['dbstrantype', 'VendBill'], ['ntype', '17'], ['baserecordtype', 'vendorbill']];
    RT.forEach(function (p) { F[p[0]] = { v: p[1], label: '', type: p[0] === 'ntype' ? 'select' : 'text' }; });
    if (qRt[1] === '1') document.addEventListener('DOMContentLoaded', function () {
      var form = document.querySelector('.form');
      RT.forEach(function (p) { var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; form.appendChild(i); });
    });
  }
  /* ?tokens=1: the session and security tokens a real NetSuite page carries as bare hidden inputs (names
   * as on NetSuite, values made up), and the saved record reports _csrf and _eml_nkey_ too, with values and
   * no labels. ?tokens=2: only the record has them (plus nlapiPI, nluser and nsbrowserenv), so nothing on
   * the page hides them from Not on form.
   * None may be listed, searched, exported or pinned. window.__tokens lists them for the tests. */
  var qTok = /[?&]tokens=([12])/.exec(location.search);
  if (qTok) {
    window.__tokens = [['_csrf', '9f2c4e7a1b6d8f03c5e2a94b7d1f6e08a3c9b25d4e7f1a6c'], ['_eml_nkey_', '1234567_SB1_7b3e9a2c5f8d1e64:a9c2e7f4b1d8'],
      ['wfinstances', 'e8d1c6b3a0f7942516d3c8b0'], ['nsapiCT', '1762961234567a9b8c7d6e5f4'], ['nlapiPI', 'b5a4c3d2e1f0918273645a5b6c7d8e9f'],
      ['nluser', 'd7e6f5a4b3c2918a0b1c2d3e'], ['nsbrowserenv', 'c1d2e3f4a5b6978695a4b3c2d1e0f9a8'], ['entryformquerystring', 'f0e9d8c7b6a5e=4d3c2b1a0918f7e6'],
      ['_button', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'], ['selectedtab', '0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f']];
    F._csrf = { v: window.__tokens[0][1], label: '', type: 'text' };
    F._eml_nkey_ = { v: window.__tokens[1][1], label: '', type: 'text' };
    /* With no page input to hide them, the record's session plumbing must still stay out of Not on form. */
    if (qTok[1] === '2') [4, 5, 6].forEach(function (k) { F[window.__tokens[k][0]] = { v: window.__tokens[k][1], label: '', type: 'text' }; });
    if (qTok[1] === '1') document.addEventListener('DOMContentLoaded', function () {
      var form = document.querySelector('.form');
      window.__tokens.forEach(function (p) { var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; form.appendChild(i); });
    });
  }
  /* record.getText makes a blocking server call per field on real NetSuite (about 350 ms each), so the
   * explorer must not use it for body fields. Count calls so tests can insist on zero. */
  window.__getTextCalls = 0;
  window.__lookups = [];
  var SUB = {
    /* Real NetSuite lists empty sublists first; the explorer should still open on one with lines. */
    recmachcustrecord_2663_transaction: { fields: ['id', 'owner'], meta: {}, lines: [], text: [] },
    item: {
      fields: ['line', 'item', 'description', 'amount', 'custcol_a', 'custcol_b'],
      meta: { line: ['', 'integer'], item: ['Item', 'select'], description: ['Description', 'textarea'], amount: ['Amount', 'currency'], custcol_a: ['Notes', 'text'], custcol_b: ['Notes', 'text'] },
      lines: [
        { line: 1, item: '11', description: 'First', amount: 5010.38, custcol_a: 'alpha', custcol_b: 'beta' },
        { line: 2, item: '12', description: 'Second', amount: -5, custcol_a: 'gamma', custcol_b: 'delta' }
      ],
      text: [{ item: 'Widget', amount: '5,010.38' }, { item: 'Gadget', amount: '-5.00' }]
    },
    expense: { fields: ['account', 'amount'], meta: { account: ['Account', 'select'], amount: ['Amount', 'currency'] }, lines: [], text: [] }
  };
  /* ?hidcols=1: the saved record has item columns the form does not display (no header, no cells), as real
   * records do: rate (labelled) and custcol_c, labelled "Notes" like two shown columns. With line (no label,
   * in every run) none of them is on the form, so none may get the eye. */
  /* ?wide=1: as on a real purchase order (view mode), the item table is wider than the page and sits in a
   * scrolling container that clips it, so a ring drawn around the whole table can't be seen. */
  if (/[?&]wide=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    var tb = document.getElementById('item_splits'), box = document.createElement('div');
    box.id = 'item_scroll'; box.style.overflow = 'auto'; box.style.width = '320px';
    tb.style.minWidth = '2000px';
    tb.parentNode.insertBefore(box, tb); box.appendChild(tb);
  });
  /* ?dispid=1: the Item header names the _display field (columnheader_item_item_display), which the explorer
   * folds into the item column. */
  if (/[?&]dispid=1/.test(location.search)) document.addEventListener('DOMContentLoaded', function () {
    document.querySelector('[data-nsps-id="columnheader_item_item"]').setAttribute('data-nsps-id', 'columnheader_item_item_display');
  });
  if (/[?&]hidcols=1/.test(location.search)) {
    SUB.item.fields.push('rate', 'custcol_c');
    SUB.item.meta.rate = ['Rate', 'currency']; SUB.item.meta.custcol_c = ['Notes', 'text'];
    SUB.item.lines[0].rate = 5010.38; SUB.item.lines[0].custcol_c = 'hidden1';
    SUB.item.lines[1].rate = -5; SUB.item.lines[1].custcol_c = 'hidden2';
  }
  function badLine() { var e = new Error('You have attempted an invalid sublist or line item operation.'); e.name = 'SSS_INVALID_SUBLIST_OPERATION'; throw e; }
  var rec = {
    type: 'vendorbill', id: 2002,
    getValue: function (o) { return F[o.fieldId] ? F[o.fieldId].v : undefined; },
    getText: function (o) { window.__getTextCalls++; var f = F[o.fieldId]; if (!f) return undefined; return f.t !== undefined ? f.t : (typeof f.v === 'boolean' ? (f.v ? 'T' : 'F') : String(f.v)); },
    getFields: function () { return Object.keys(F); },
    getField: function (o) { var f = F[o.fieldId]; return f ? { id: o.fieldId, label: f.label, type: f.type } : null; },
    getSublists: function () { return Object.keys(SUB); },
    getLineCount: function (o) { return SUB[o.sublistId] ? SUB[o.sublistId].lines.length : -1; },
    getSublistFields: function (o) { return SUB[o.sublistId] ? SUB[o.sublistId].fields.slice() : []; },
    getSublistField: function (o) {
      var s = SUB[o.sublistId]; if (!s || !s.lines[o.line]) badLine();
      var m = s.meta[o.fieldId]; return m ? { id: o.fieldId, label: m[0], type: m[1] } : null;
    },
    getSublistValue: function (o) { var s = SUB[o.sublistId]; if (!s || !s.lines[o.line]) badLine(); return s.lines[o.line][o.fieldId]; },
    getSublistText: function (o) {
      window.__subTextCalls++;
      var s = SUB[o.sublistId]; if (!s || !s.lines[o.line]) badLine();
      var t = s.text[o.line] && s.text[o.line][o.fieldId]; return t !== undefined ? t : String(s.lines[o.line][o.fieldId]);
    },
    setValue: function () { throw new Error('TEST FAILURE: the explorer must never write to the record'); },
    save: function () { throw new Error('TEST FAILURE: the explorer must never save the record'); }
  };
  window.__recordLoads = 0;
  var recordModule = {
    load: function () { throw new Error('TEST FAILURE: use load.promise so the page does not freeze'); }
  };
  recordModule.load.promise = function (o) {
    window.__recordLoads++;
    return new Promise(function (res, rej) {
      setTimeout(function () {
        if (fail) { var e = new Error('You do not have permission to view this record.'); e.name = 'INSUFFICIENT_PERMISSION'; rej(e); return; }
        if (o.type !== 'vendorbill' || String(o.id) !== '2002') { rej(new Error('wrong record ' + o.type + ' ' + o.id)); return; }
        res(rec);
      }, 80);
    });
  };
  /* N/format: formats dates in the page (no server call). */
  var formatModule = {
    Type: { DATE: 'date', DATETIME: 'datetime' },
    format: function (o) { var d = o.value; return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(); }
  };
  /* N/search lookupFields: select fields come back as [{ value, text }]. Like real NetSuite, a column that
   * can't be searched (here: nexus) makes the whole request fail. */
  var searchModule = { lookupFields: {} };
  searchModule.lookupFields.promise = function (o) {
    window.__lookups.push(o.columns.slice());
    return new Promise(function (res, rej) {
      setTimeout(function () {
        if (o.columns.indexOf('nexus') >= 0) { var e = new Error('An nlobjSearchColumn contains an invalid column: nexus'); e.name = 'SSS_INVALID_SRCH_COL'; rej(e); return; }
        var out = {};
        o.columns.forEach(function (c) {
          var f = F[c]; if (!f) return;
          out[c] = Array.isArray(f.v) ? f.v.map(function (v, i) { return { value: v, text: f.t[i] }; }) : [{ value: f.v, text: f.t }];
        });
        res(out);
      }, slowLookup ? 800 : 30);
    });
  };
  /* NetSuite's AMD loader */
  window.require = function (deps, cb, eb) {
    setTimeout(function () {
      var mods = { 'N/record': recordModule, 'N/format': formatModule, 'N/search': searchModule, 'N/query': window.__nsQuery };
      if (deps.length === 1 && mods[deps[0]]) cb(mods[deps[0]]);
      else if (eb) eb(new Error('Module not found: ' + deps.join(',')));
    }, 10);
  };
})();
