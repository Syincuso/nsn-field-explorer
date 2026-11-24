// Usage: node tools/build.js
// After editing ns-field-explorer.js (the source of truth), this:
//   1. refuses to continue if it has a non-ASCII or control byte (Chrome/Edge reject files containing
//      noncharacters such as U+FFFE as "isn't UTF-8 encoded"; write special characters as \u escapes),
//   2. copies it to extension/ns-field-explorer.js, which the extension injects.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

// Non-ASCII bytes, and control characters other than tab/CR/LF (an editor can turn a typed \u0005
// escape into the raw byte, which is ASCII but would silently change the code).
function firstNonAscii(buf) { return buf.findIndex(x => x > 127 || (x < 32 && x !== 9 && x !== 10 && x !== 13)); }

function main() {
  const srcPath = path.join(ROOT, 'ns-field-explorer.js');
  const buf = fs.readFileSync(srcPath), at = firstNonAscii(buf);
  if (at >= 0) throw new Error('ns-field-explorer.js has a non-ASCII or control byte (0x' + buf[at].toString(16) + ') at offset ' + at + '; use a \\u escape instead');
  fs.copyFileSync(srcPath, path.join(ROOT, 'extension', 'ns-field-explorer.js'));
  console.log('extension/ns-field-explorer.js synced (' + buf.length + ' bytes)');
}

module.exports = { firstNonAscii };
if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
