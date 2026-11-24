/* Loaded in every fixture frame. Records what the explorer copies instead of touching the real
 * clipboard, and records CSP violations so tests can fail on them.
 *   top.__copyMode      'ok'  -> execCommand('copy') succeeds and the text is recorded
 *                       'fail'-> execCommand('copy') returns false (falls through to the Clipboard API)
 *   top.__clipboardMode 'ok' | 'fail' for navigator.clipboard.writeText */
(function () {
  var t = window.top;
  if (!t.__copies) t.__copies = [];
  if (!t.__csp) t.__csp = [];
  if (!t.__copyMode) t.__copyMode = 'ok';
  if (!t.__clipboardMode) t.__clipboardMode = 'fail';
  document.execCommand = function (cmd) {
    if (cmd !== 'copy') return false;
    var tas = document.body.querySelectorAll('textarea'), ta = tas[tas.length - 1];
    if (t.__copyMode !== 'ok') return false;
    t.__copies.push(ta ? ta.value : null);
    return true;
  };
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (text) {
      if (t.__clipboardMode === 'ok') { t.__copies.push('[api]' + text); return Promise.resolve(); }
      return Promise.reject(new Error('denied'));
    } } });
  } catch (e) {}
  document.addEventListener('securitypolicyviolation', function (e) { t.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')); });
})();
