#!/usr/bin/env node
// Guards the invariant check-locales.mjs cannot see: that every string the app actually
// hands to t() has a key in src/locales/fr.js. t() falls back to English silently — no
// exception, nothing in the console — so a key missing from fr.js is invisible until a
// human happens to look at that exact screen. That is exactly how a Coach subtitle stayed
// in English through a whole translation pass: the string was real, t() was called on it,
// and nothing failing anywhere told anyone.
//
//   node scripts/check-fr-coverage.mjs
//
// Two ways a string reaches t(), both collected below:
//
//   1. Literal calls — t('…') / t("…") — found by scanning source text for `t(` and
//      reading its first argument (never a later one: `t('…', someLabel ? 'RIR' : 'RPE')`
//      passes 'RIR'/'RPE' as *interpolation values*, not as a second translatable string).
//      That first argument is sometimes a ternary picking between two literals for
//      pluralisation (`t(n === 1 ? '{0} thing' : '{0} things', n)`) — both branches are
//      collected when the argument is *exactly* that shape, condition and all. Anything
//      looser — a literal used only as a comparison inside the condition
//      (`effortOf(st) === 'none' ? … : …` — 'none' is a value, not a string handed to t()),
//      or an inline lookup object (`t({ 'id': 'Label', … }[key] || 'fallback')`) — is left
//      alone rather than guessed at, and joins the dynamic calls (`t(ex.bp)`, `t(g.key)`…)
//      this script was never going to be able to check anyway.
//
//   2. Table lookups — t(TABLE[key]) — where the string t() actually receives depends on a
//      variable, so no amount of scanning `t(` finds it; the string is one hop away, inside
//      a lookup table this script has to be told about by name. KNOWN_TABLES below is that
//      list, read directly from each table's own source file (never imported — several of
//      them live in .jsx files, which plain Node can't import without a JSX transform).
//
//      This is the tool's known limit: a table not listed here is invisible to it, the same
//      way an unlisted locale key is invisible to t() at runtime. When a new such table
//      appears — a display-name map, a set of category labels, anything whose values are fed
//      to t() through a variable rather than written inline — add its file and export name(s)
//      to KNOWN_TABLES. Forgetting to add it defeats the point of this script exactly as
//      quietly as the bug it exists to catch.
//
// What this script deliberately does NOT do: walk src/lib/exercises-data.js. Its ~1300
// exercise records carry body parts, target muscles and equipment as free-text data, not
// code — and unlike the tables above, that vocabulary grows on its own every time an
// exercise is added upstream. Treating it as translatable text would fail this script on
// the next routine dataset bump, for a string nobody wrote and no one asked to translate.
// (Renamed here as BODYPARTS/equipmentOf in src/lib/exercises.js — also skipped, being
// derived straight from that same dataset.)

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')

// Directories and files the walk never descends into / never reads as source.
const SKIP_DIRS = new Set(['locales', 'instr'])
const SKIP_FILES = new Set(['exercises-data.js'])
const isSourceFile = name => (name.endsWith('.js') || name.endsWith('.jsx')) && !name.endsWith('.test.js')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
    } else if (isSourceFile(entry.name) && !SKIP_FILES.has(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

// Constant tables whose values are handed to t() one hop away, by variable — see header.
// Extending this list is the documented, expected way to teach the script about a new one.
//
// By default every string nested anywhere inside the table is collected (see stringsOfTable
// below) — right for a flat array (MONTHS), an object of strings (MUSCLE_NAME) or an object/
// array of [a, b, …] tuples where every element ends up in t() (CATEGORY_TEXT's [title, sub];
// GOALS' own [code, label] — CoachIntake.jsx passes *both* to t(): the label via
// `GOALS.map(([v, label]) => … t(label) …)`, the code via `t(p.goal)` in Coach.jsx's
// summarise()). When a table mixes translatable strings with values that never reach t() —
// EXPERIENCE's code half is only ever compared (`p.experience === v`), never translated;
// GLYPH_GROUPS is a list of {key, items} where only `key` goes through `t(g.key)`, `items`
// are icon names — give that entry a `pick(value)` returning just the strings that matter,
// instead of collecting everything the shape contains.
const KNOWN_TABLES = [
  { file: 'lib/format.js', exports: ['MONTHS', 'MONTHS_LONG', 'DAYS', 'DAYN'] },
  { file: 'lib/muscles.js', exports: ['MUSCLE_NAME'] },
  { file: 'lib/progression.js', exports: ['POLICY_NAME', 'POLICY_DESC'] },
  { file: 'views/Coach.jsx', exports: ['CATEGORY_TEXT'] },
  { file: 'views/CoachIntake.jsx', exports: ['GOALS'] },
  { file: 'views/CoachIntake.jsx', exports: ['EXPERIENCE'], pick: value => value.map(([, label]) => label) },
  { file: 'lib/glyphs.js', exports: ['GLYPH_GROUPS'], pick: value => value.map(group => group.key) },
]

// Evaluate a matched slice of source as a JS literal — reusing the engine's own quote/escape
// rules (curly apostrophes, \u escapes, …) instead of reimplementing them. Safe here: every
// slice comes from this repo's own source files, never from anything a user supplies.
const evalLiteral = src => Function('"use strict"; return (' + src + ')')()

// Find the end of a balanced (…)/[…]/{…} region starting at `open` (pointing at the opening
// bracket), skipping over string contents so a bracket-looking character inside a string
// can't end the region early. Returns the index just past the matching closing bracket.
function scanBalanced(src, open) {
  let depth = 0, i = open
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      continue
    }
    if (c === src[open] || c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i + 1 }
  }
  return src.length
}

// Default extraction for a KNOWN_TABLES entry with no `pick`: every string reachable from the
// value — the value itself if it's a string (MUSCLE_NAME, POLICY_NAME…), or every element if
// it's itself an array (CATEGORY_TEXT's [title, subtitle] pairs, GOALS' [code, label] pairs —
// both halves are collected, and both really are handed to t(), see the KNOWN_TABLES comment
// above; also lets a plain array table like MONTHS pass through unchanged, since
// Object.values/array-spread already hand us its members directly). Only right when *every*
// string nested in the shape is actually translatable — an entry where that is not true (a
// code that is only ever compared, an icon name sitting next to the label that matters) needs
// its own `pick` instead of this default; see tableStrings.
const stringsOfTable = value => {
  const entries = Array.isArray(value) ? value : Object.values(value)
  return entries.flatMap(v => (Array.isArray(v) ? v : [v]))
}

function tableStrings() {
  const strings = new Set()
  for (const { file, exports, pick } of KNOWN_TABLES) {
    const path = join(srcDir, file)
    const src = readFileSync(path, 'utf8')
    for (const name of exports) {
      const decl = new RegExp('(?:export\\s+)?const\\s+' + name + '\\s*=\\s*')
      const m = decl.exec(src)
      if (!m) {
        console.error(`KNOWN_TABLES: could not find "const ${name}" in ${file} — table renamed or removed?`)
        process.exit(1)
      }
      const open = m.index + m[0].length
      if (src[open] !== '[' && src[open] !== '{') {
        console.error(`KNOWN_TABLES: ${name} in ${file} doesn't start with [ or { — update the script's parser`)
        process.exit(1)
      }
      const end = scanBalanced(src, open)
      const value = evalLiteral(src.slice(open, end))
      for (const s of (pick ? pick(value) : stringsOfTable(value))) strings.add(s)
    }
  }
  return strings
}

// A quoted string literal starting exactly at position `i` (single or double quotes) — or
// null if `i` isn't the start of one. Used to test specific positions, not to scan blindly:
// see literalCallStrings for why scanning the whole first argument over-collects.
function literalAt(s, i) {
  const q = s[i]
  if (q !== "'" && q !== '"') return null
  let j = i + 1
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++ }
  return j < s.length ? { text: s.slice(i, j + 1), end: j + 1 } : null
}

// The first argument is a bare literal and nothing else.
function directLiteral(firstArg) {
  const trimmed = firstArg.trim()
  const lit = literalAt(trimmed, 0)
  return lit && lit.end === trimmed.length ? lit.text : null
}

// The first argument is *exactly* `<condition> ? '<literal>' : '<literal>'` — the codebase's
// pluralisation idiom. The condition can be any expression (parens/brackets and their own
// string literals are skipped over, not parsed), but everything from the top-level `?` on
// must be a literal, then `:`, then a literal, then nothing else — so a comparison literal
// inside the condition, or a lookup expression with no ternary at all (`{…}[k] || 'x'`),
// correctly yields no match here and falls through as dynamic/uncollected.
function ternaryLiterals(firstArg) {
  let depth = 0
  for (let i = 0; i < firstArg.length; i++) {
    const c = firstArg[i]
    if (c === "'" || c === '"') {
      const lit = literalAt(firstArg, i)
      if (!lit) return null
      i = lit.end - 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (depth === 0 && c === '?' && firstArg[i + 1] !== '.' && firstArg[i + 1] !== '?') {
      let j = i + 1
      while (firstArg[j] === ' ') j++
      const a = literalAt(firstArg, j)
      if (!a) return null
      j = a.end
      while (firstArg[j] === ' ') j++
      if (firstArg[j] !== ':') return null
      j++
      while (firstArg[j] === ' ') j++
      const b = literalAt(firstArg, j)
      if (!b || firstArg.slice(b.end).trim() !== '') return null
      return [a.text, b.text]
    }
  }
  return null
}

// Every literal string t() is actually called with, anywhere in `src`: for each `t(` found
// as a standalone identifier (not `.t(`, not the tail of a longer name like `sort(`), take
// its first argument only — up to the first top-level comma or the call's closing paren,
// tracking all three bracket kinds so a comma inside a nested object or array literal isn't
// mistaken for that boundary — and read it as either a direct or a ternary literal (above).
function literalCallStrings(src) {
  const strings = new Set()
  const callRe = /(?<![\w$])t\(/g
  let m
  while ((m = callRe.exec(src))) {
    let i = m.index + m[0].length
    let depth = 1
    let firstArgEnd = -1
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === "'" || c === '"' || c === '`') {
        const q = c
        i++
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
        i++
        continue
      }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break }
      else if (c === ',' && depth === 1 && firstArgEnd === -1) firstArgEnd = i
      i++
    }
    const firstArg = src.slice(m.index + m[0].length, firstArgEnd === -1 ? i : firstArgEnd)
    const direct = directLiteral(firstArg)
    if (direct) { strings.add(evalLiteral(direct)); continue }
    const ternary = ternaryLiterals(firstArg.trim())
    if (ternary) for (const lit of ternary) strings.add(evalLiteral(lit))
  }
  return strings
}

function collectUsed() {
  const used = tableStrings()
  for (const file of walk(srcDir)) {
    const src = readFileSync(file, 'utf8')
    for (const s of literalCallStrings(src)) used.add(s)
  }
  return used
}

const frPath = join(srcDir, 'locales', 'fr.js')
const { default: fr } = await import(pathToFileURL(frPath).href)
if (!fr || typeof fr !== 'object') {
  console.error(`${relative(root, frPath)}: no default-exported object`)
  process.exit(1)
}
const frKeys = new Set(Object.keys(fr))

const used = collectUsed()
const missing = [...used].filter(s => !frKeys.has(s)).sort()

if (missing.length) {
  console.error(`\nfr.js: ${frKeys.size} keys, ${used.size} strings reach t() — ${missing.length} missing.\n`)
  for (const s of missing) console.error(`  missing: ${JSON.stringify(s)}`)
  console.error('\nEvery string passed to t() (literally, or via a KNOWN_TABLES lookup) needs a key in fr.js.')
  console.error('Add the translation, or — if this is a new lookup table — extend KNOWN_TABLES (see header).')
  process.exit(1)
}

console.log(`${used.size} strings reach t() across src/ — all present in fr.js (${frKeys.size} keys).`)
