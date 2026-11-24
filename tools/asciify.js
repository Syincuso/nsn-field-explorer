// Usage: node tools/asciify.js [file]   (default: ns-field-explorer.js)
// Editing tools sometimes turn a typed \uXXXX escape into the raw character. In this script every
// non-ASCII character lives inside a string or regex literal, where the escape means the same thing,
// so this rewrites each one back to a \uXXXX escape. It refuses to touch raw control characters
// (other than tab/CR/LF), which need a human look.
const fs = require('fs'), path = require('path');
const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'ns-field-explorer.js'));
const src = fs.readFileSync(file, 'utf8');
const ctl = [...src].findIndex(c => { const n = c.charCodeAt(0); return n < 32 && n !== 9 && n !== 10 && n !== 13; });
if (ctl >= 0) { console.error('Raw control character at index ' + ctl + '; fix it by hand'); process.exit(1); }
let n = 0;
const out = src.replace(/[^\x00-\x7F]/g, c => { n++; return String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'); });
if (n) fs.writeFileSync(file, out);
console.log(path.basename(file) + ': ' + n + ' character(s) escaped');
