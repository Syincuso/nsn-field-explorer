/* Checks that our code is not copied from another code base, including copies with renamed variables or
 * rewritten from modern JavaScript into this project's ES5 style. Uses Node built-ins only.
 *
 *   node tools/provenance-check.mjs <their folder> [<their folder> ...] [--ours a.js,b.js] [--top 15] [--show fnName,...]
 *
 * --show prints, for each of our functions with that name, its source, the closest of their functions and
 * their code around the longest run it shares, for reviewing a match by hand.
 *
 * Their folders hold any number of .js/.mjs/.css/.html files (for example every historical version of
 * another project's files, taken from its git history). Checks:
 *   1. whole files: identical 40+ character lines, and how much of our code is covered by runs of tokens
 *      found in theirs, exact (12 tokens) and normalised (24 tokens);
 *   2. function by function, normalised: the share of each of our functions covered by runs of 16+ tokens
 *      found anywhere in their code (a renamed copy is one long run), and the closest of their functions
 *      between half and twice its size (shared 8-token sequences over the larger function's);
 *   3. CSS rules: declarations (property:value) shared with any of their rules, selectors ignored;
 *   4. user-facing phrases from our string literals found in their files;
 *   5. a self-test that plants renamed, ES5-converted copies of their functions and must find them.
 * Normalised means: identifiers -> I, strings and template literals -> S, numbers -> N, regex -> R,
 * var/let/const -> V, === -> ==, !== -> !=; "function", "=>", "async" and "await" dropped; string
 * concatenations (S + I + S ...) collapsed to S, so a template literal and a + chain look the same. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i < 0 ? def : args.splice(i, 2)[1]; };
const TOP = +opt('--top', 15);
const SHOW = opt('--show', '').split(',').filter(Boolean);
const OURS = opt('--ours', 'ns-field-explorer.js,extension/background.js')
  .split(',').map(f => path.resolve(ROOT, f));
const THEIRS = args.length ? args : (console.error('usage: node tools/provenance-check.mjs <their folder> ... [--ours a.js,b.js] [--top 15] [--show fnName,fnName]'), process.exit(2));

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return /^(\.git|node_modules)$/.test(e.name) ? [] : walk(p);
  return /\.(m?js|jsx|ts|css|html)(\.[0-9a-f]{40})?$/.test(e.name) ? [p] : [];
});
const kind = f => (/\.(m?js|jsx|ts)(\.[0-9a-f]{40})?$/.test(f) ? 'js' : /\.css(\.[0-9a-f]{40})?$/.test(f) ? 'css' : 'html');
const read = f => fs.readFileSync(f, 'utf8');

/* ---------- tokenizer: comments dropped; strings, templates and regex literals kept whole ---------- */
const OPS = ['>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const KW = new Set('var let const function return if else for while do switch case break continue new typeof instanceof in of try catch finally throw this null undefined true false await async class extends default delete void yield import export from static get set super'.split(' '));
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '&&', '||', '??', '==', '===', '!=', '!==', '=>', 'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do']);
function tokenize(src) {
  const out = []; let i = 0; const n = src.length;
  const prev = () => out.length ? out[out.length - 1].v : '';
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out.push({ p: i, t: 'S', v: src.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1, depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (!depth && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth && src[j] === '}') depth--;
        j++;
      }
      out.push({ p: i, t: 'S', v: src.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === '/' && (out.length === 0 || REGEX_AFTER.has(prev()))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      j++; while (j < n && /[a-z]/.test(src[j])) j++;
      out.push({ p: i, t: 'R', v: src.slice(i, j) }); i = j; continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
    if (id) { out.push({ p: i, t: KW.has(id[0]) ? 'K' : 'I', v: id[0] }); i += id[0].length; continue; }
    const num = /^\.?\d[\w.]*/.exec(src.slice(i, i + 40));
    if (num) { out.push({ p: i, t: 'N', v: num[0] }); i += num[0].length; continue; }
    const op = OPS.find(o => src.startsWith(o, i)) || c;
    out.push({ p: i, t: 'P', v: op }); i += op.length;
  }
  return out;
}
const exactOf = toks => toks.map(x => x.v);
/* Normalised tokens; .src[i] is the index in toks of normalised token i (for showing where a match is). */
function normOf(toks) {
  let a = [], m = [];
  for (let k = 0; k < toks.length; k++) {
    const x = toks[k];
    if (x.v === 'function' || x.v === '=>' || x.v === 'async' || x.v === 'await') continue;
    m.push(k);
    if (x.v === 'var' || x.v === 'let' || x.v === 'const') { a.push('V'); continue; }
    a.push(x.t === 'I' ? 'I' : x.t === 'S' ? 'S' : x.t === 'N' ? 'N' : x.t === 'R' ? 'R' : x.v === '===' ? '==' : x.v === '!==' ? '!=' : x.v);
  }
  /* S + I + S ... -> S (a template literal and a concatenation look alike). */
  const b = [], bm = [];
  for (let i = 0; i < a.length; i++) {
    if ((a[i] === 'S' || a[i] === 'I' || a[i] === 'N') && a[i + 1] === '+') {
      let j = i, hasS = false;
      while (j < a.length && (a[j] === 'S' || a[j] === 'I' || a[j] === 'N') && (j === i || a[j - 1] === '+')) { if (a[j] === 'S') hasS = true; if (a[j + 1] === '+') j += 2; else { j++; break; } }
      if (hasS) { b.push('S'); bm.push(m[i]); i = j - 1; continue; }
    }
    b.push(a[i]); bm.push(m[i]);
  }
  b.src = bm;
  return b;
}
const grams = (seq, k) => { const s = new Set(); for (let i = 0; i + k <= seq.length; i++) s.add(seq.slice(i, i + k).join('\u0001')); return s; };
function coverage(seq, set, k) {
  const hit = new Uint8Array(seq.length);
  for (let i = 0; i + k <= seq.length; i++) if (set.has(seq.slice(i, i + k).join('\u0001'))) hit.fill(1, i, i + k);
  return hit;
}

/* ---------- functions: declarations, expressions, arrows with a block body, and methods ---------- */
function functions(toks, file) {
  const units = [];
  const close = open => { let d = 0; for (let j = open; j < toks.length; j++) { if (toks[j].v === '{') d++; else if (toks[j].v === '}' && --d === 0) return j; } return toks.length - 1; };
  const parenEnd = open => { let d = 0; for (let j = open; j < toks.length; j++) { if (toks[j].v === '(') d++; else if (toks[j].v === ')' && --d === 0) return j; } return -1; };
  for (let i = 0; i < toks.length; i++) {
    let start = -1, name = '', body = -1;
    if (toks[i].v === 'function') {
      start = i; let j = i + 1; if (toks[j] && toks[j].v === '*') j++;
      if (toks[j] && toks[j].t === 'I') name = toks[j++].v;
      if (toks[j] && toks[j].v === '(') { const e = parenEnd(j); if (e > 0 && toks[e + 1] && toks[e + 1].v === '{') body = e + 1; }
      if (!name) { const p = toks[i - 1], q = toks[i - 2]; if (p && (p.v === '=' || p.v === ':') && q && q.t === 'I') name = q.v; }
    } else if (toks[i].v === '=>' && toks[i + 1] && toks[i + 1].v === '{') {
      body = i + 1; let s = i - 1;
      if (toks[s] && toks[s].v === ')') { let d = 0; for (; s >= 0; s--) { if (toks[s].v === ')') d++; else if (toks[s].v === '(' && --d === 0) break; } }
      start = Math.max(0, s); const p = toks[start - 1], q = toks[start - 2]; if (p && (p.v === '=' || p.v === ':') && q && q.t === 'I') name = q.v;
    } else if (toks[i].t === 'I' && toks[i + 1] && toks[i + 1].v === '(' && /^[{},;]$|^(async|static|get|set)$/.test(toks[i - 1] ? toks[i - 1].v : '')) {
      const e = parenEnd(i + 1); if (e > 0 && toks[e + 1] && toks[e + 1].v === '{') { start = i; name = toks[i].v; body = e + 1; }
    }
    if (body > 0) { const end = close(body); units.push({ file, name: name || '(anonymous)', toks: toks.slice(start, end + 1) }); }
  }
  return units;
}

/* ---------- CSS rules: our styles live in JS string literals ---------- */
function cssRules(css) {
  const rules = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const decl = m[2].split(';').map(d => d.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\s*:\s*/, ':')).filter(d => /^[a-z-]+:./.test(d));
    if (decl.length) rules.push({ sel: m[1].trim().slice(-80), decl: new Set(decl) });
  }
  return rules;
}
const stringText = toks => toks.filter(x => x.t === 'S').map(x => x.v.slice(1, -1).replace(/\\(.)/g, '$1')).join('');

/* ---------- load ---------- */
const theirFiles = THEIRS.flatMap(d => walk(path.resolve(d)));
const theirJs = theirFiles.filter(f => kind(f) === 'js').map(f => ({ f, toks: tokenize(read(f)) }));
const theirCss = theirFiles.filter(f => kind(f) !== 'js').flatMap(f => { const s = read(f); return cssRules(kind(f) === 'css' ? s : (s.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n')).map(r => ({ ...r, f })); })
  .concat(theirJs.flatMap(({ f, toks }) => cssRules(stringText(toks)).map(r => ({ ...r, f }))));
const theirText = theirFiles.map(read).join('\n').toLowerCase().replace(/\s+/g, ' ');
const srcOf = (file, toks, a, b) => read(file).slice(toks[a].p, toks[b].p + toks[b].v.length);
const shortName = f => path.basename(f).replace(/\.[0-9a-f]{40}$/, '');
const ours = OURS.filter(f => fs.existsSync(f)).map(f => ({ f, toks: tokenize(read(f)) }));

/* Their function units, de-duplicated across versions by normalised text, with an index of their
 * normalised 8-token sequences. */
const seenUnit = new Map();
for (const { f, toks } of theirJs) for (const u of functions(toks, f)) {
  const norm = normOf(u.toks); if (norm.length < 25) continue;
  const key = norm.join(' '); if (!seenUnit.has(key)) seenUnit.set(key, { ...u, norm, g: grams(norm, 8) });
}
const theirUnits = [...seenUnit.values()];
const index = new Map();
theirUnits.forEach((u, n) => u.g.forEach(g => { let a = index.get(g); if (!a) index.set(g, a = []); a.push(n); }));
/* Runs: normalised 16-token sequences anywhere in their code (whole files, so a copy of part of a function counts). */
const RUN = 16;
const runSet = grams(theirJs.flatMap(x => normOf(x.toks).concat(['\u0000'])), RUN);
function runs(norm) {
  const hit = coverage(norm, runSet, RUN); let longest = 0, cur = 0, n = 0;
  for (const h of hit) { cur = h ? cur + 1 : 0; if (cur > longest) longest = cur; n += h; }
  return { share: n / norm.length, longest };
}
/* Closest of their functions between half and twice the size: shared 8-token sequences over the larger set. */
function similar(norm) {
  const g = grams(norm, 8), count = new Map();
  for (const x of g) for (const n of new Set(index.get(x) || [])) count.set(n, (count.get(n) || 0) + 1);
  let best = { score: 0, u: null };
  for (const [n, c] of count) {
    const u = theirUnits[n]; if (u.norm.length < norm.length / 2 || u.norm.length > norm.length * 2) continue;
    const score = c / Math.max(g.size, u.g.size); if (score > best.score) best = { score, u };
  }
  return best;
}

const indent = t => t.split('\n').map(l => '      | ' + l).join('\n');
const pct = x => (100 * x).toFixed(1) + '%';
const say = s => console.log(s);
say(`Their side: ${theirFiles.length} files (${theirJs.length} JS), ${theirUnits.length} distinct functions of 25+ normalised tokens, ${theirCss.length} CSS rules.`);

/* 5 first: the self-test proves both function checks find renamed, ES5-converted copies. */
function disguise(toks) {
  const names = new Map(); let k = 0;
  return toks.flatMap(x => {
    if (x.t === 'I') { if (!names.has(x.v)) names.set(x.v, 'q' + (k++).toString(36)); return [{ t: 'I', v: names.get(x.v) }]; }
    if (x.v === 'const' || x.v === 'let') return [{ t: 'K', v: 'var' }];
    if (x.v === '===') return [{ t: 'P', v: '==' }];
    if (x.v === '=>') return [{ t: 'K', v: 'function' }];
    if (x.t === 'S' && x.v[0] === '`') return [{ t: 'S', v: "'a'" }, { t: 'P', v: '+' }, { t: 'I', v: 'qz' }, { t: 'P', v: '+' }, { t: 'S', v: "'b'" }];
    return [x];
  });
}
const pool = theirUnits.filter(u => u.norm.length >= 60 && u.norm.length <= 800);
const sample = pool.filter((u, i) => i % Math.max(1, Math.floor(pool.length / 25)) === 0).slice(0, 25);
const planted = sample.map(u => { const n = normOf(disguise(u.toks)); return { run: runs(n).share, sim: similar(n).score }; });
const range = a => pct(Math.min(...a)) + ' to ' + pct(Math.max(...a));
say(`
## Self-test: ${planted.length} of their functions (60-800 tokens), renamed and rewritten to ES5, then searched for`);
say(`  copied-run share ${range(planted.map(p => p.run))}; similar-size function score ${range(planted.map(p => p.sim))} (a copy scores near 100%)`);

for (const { f, toks } of ours) {
  const name = path.relative(ROOT, f).replace(/\\/g, '/');
  say(`\n## ${name}`);
  /* 1. whole file */
  const lines = read(f).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length >= 40);
  const same = lines.filter(l => theirText.includes(l.toLowerCase()));
  const ex = coverage(exactOf(toks), grams(theirJs.flatMap(x => exactOf(x.toks)), 12), 12);
  const nseq = normOf(toks), nc = coverage(nseq, grams(theirJs.flatMap(x => normOf(x.toks)), 24), 24);
  const share = h => pct(h.reduce((a, b) => a + b, 0) / Math.max(1, h.length));
  say(`  identical 40+ char lines: ${same.length} of ${lines.length}; exact 12-token runs cover ${share(ex)}; normalised 24-token runs cover ${share(nc)}`);
  same.slice(0, 5).forEach(l => say('    = ' + l.slice(0, 140)));
  const exRuns = []; let st0 = -1;
  for (let k = 0; k <= ex.length; k++) { if (ex[k] && st0 < 0) st0 = k; if (!ex[k] && st0 >= 0) { exRuns.push([st0, k]); st0 = -1; } }
  exRuns.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 3)
    .forEach(([a, b]) => say(`    exact run, ${b - a} tokens: ` + srcOf(f, toks, a, b - 1).replace(/\s+/g, ' ').slice(0, 150)));
  /* 2. function by function */
  const units = functions(toks, f).map(u => ({ ...u, norm: normOf(u.toks) })).filter(u => u.norm.length >= 25);
  const scored = units.map(u => ({ u, r: runs(u.norm), m: similar(u.norm) }));
  const band = (key, lo, hi) => scored.filter(s => key(s) >= lo && key(s) < hi).length;
  const bands = key => `>=50% ${band(key, 0.5, 2)}, 25-50% ${band(key, 0.25, 0.5)}, 10-25% ${band(key, 0.1, 0.25)}, <10% ${band(key, 0, 0.1)}`;
  say(`  functions: ${units.length}`);
  say(`    share covered by copied runs (${RUN}+ normalised tokens): ${bands(s => s.r.share)}`);
  say(`    closest similar-size function: ${bands(s => s.m.score)}`);
  const lineOf = s => read(f).slice(0, s.u.toks[0].p).split('\n').length;
  const label = s => `${s.u.name} line ${lineOf(s)} (${s.u.norm.length} tokens)`;
  scored.slice().sort((a, b) => b.r.share - a.r.share).slice(0, TOP).filter(s => s.r.share > 0)
    .forEach(s => say(`    run ${pct(s.r.share).padStart(6)}  longest ${String(s.r.longest).padStart(3)}  ${label(s)}`));
  scored.slice().sort((a, b) => b.m.score - a.m.score).slice(0, TOP).filter(s => s.m.score > 0)
    .forEach(s => say(`    fn  ${pct(s.m.score).padStart(6)}  ${label(s)}  ~  ${shortName(s.m.u.file)}: ${s.m.u.name} (${s.m.u.norm.length} tokens)`));
  for (const s of scored.filter(s => SHOW.includes(s.u.name))) {
    say(`
  ---- ${s.u.name}: ours (${name})`);
    say(indent(srcOf(f, s.u.toks, 0, s.u.toks.length - 1)));
    if (s.m.u) { say(`  ---- closest similar-size function, ${pct(s.m.score)}: ${shortName(s.m.u.file)} ${s.m.u.name}`); say(indent(srcOf(s.m.u.file, s.m.u.toks, 0, s.m.u.toks.length - 1))); }
    const hit = coverage(s.u.norm, runSet, RUN); let best = [0, 0], st = -1;
    for (let k = 0; k <= hit.length; k++) { if (hit[k] && st < 0) st = k; if (!hit[k] && st >= 0) { if (k - st > best[1] - best[0]) best = [st, k]; st = -1; } }
    if (best[1] > best[0]) {
      const key = s.u.norm.slice(best[0], best[0] + RUN).join('\u0001');
      for (const t of theirJs) {
        const n = normOf(t.toks); let at = -1;
        for (let k = 0; k + RUN <= n.length && at < 0; k++) if (n.slice(k, k + RUN).join('\u0001') === key) at = k;
        if (at < 0) continue;
        const len = best[1] - best[0], a = n.src[at], b = n.src[at + RUN - 1];
        say(`  ---- longest shared run, ${len} normalised tokens (overlapping ${RUN}-token windows, which may come from different places in their code): ours`);
        say(indent(srcOf(f, s.u.toks, s.u.norm.src[best[0]], s.u.norm.src[best[1] - 1])));
        say(`  ---- theirs, where its first ${RUN} tokens occur: ${shortName(t.f)}`);
        say(indent(srcOf(t.f, t.toks, a, b)));
        break;
      }
    }
  }
  /* 3. CSS */
  const rules = cssRules(stringText(toks));
  if (rules.length) {
    const hits = rules.map(r => {
      let best = { n: 0 };
      for (const t of theirCss) { let n = 0; for (const d of r.decl) if (t.decl.has(d)) n++; if (n > best.n) best = { n, t }; }
      return { r, ...best };
    }).filter(h => h.n >= 3 && h.n / h.r.decl.size >= 0.5).sort((a, b) => b.n - a.n);
    say(`  CSS rules: ${rules.length}; with 3+ declarations and half or more of them in one of their rules: ${hits.length}`);
    hits.slice(0, TOP).forEach(h => say(`    ${h.n}/${h.r.decl.size}  ${h.r.sel}  ~  ${shortName(h.t.f)} ${h.t.sel}  [${[...h.r.decl].filter(d => h.t.decl.has(d)).join('; ')}]`));
  }
  /* 4. phrases */
  const phrases = new Set();
  for (const x of toks) if (x.t === 'S') x.v.slice(1, -1).replace(/<[^>]*>/g, '\n').split(/[\n.:;!?()]/).map(s => s.trim().toLowerCase())
    .filter(s => s.length >= 18 && / /.test(s) && !/[{}=]/.test(s)).forEach(s => phrases.add(s));
  const ph = [...phrases].filter(p => theirText.includes(p));
  say(`  phrases of 18+ characters also in their files: ${ph.length} of ${phrases.size}`);
  ph.slice(0, 8).forEach(p => say('    " ' + p));
}
/* Generated by Claude and Ammon Wendel. Questions or help: info@syincuso.com */
