/* NetSuite Next puts the classic form in an iframe. ?form=edit|view picks the record page; the rest of
 * the query string is passed through (for example recfail=1). */
(function () {
  var q = new URLSearchParams(location.search), form = q.get('form') || 'edit';
  q.delete('form');
  document.getElementById('classic').src = 'record-' + form + '.html' + (q.toString() ? '?' + q.toString() : '');
})();
