// gitignore matching with no RegExp: a .gitignore inside a downloaded repo is untrusted,
// and glob→regex translation backtracks exponentially on patterns like *a*a*a*a*b.
// Both matchers below backtrack only to the last star: O(pattern × name) worst case.

const STAR = { s: 1 } // * inside a segment
const ANY = { a: 1 } // ? inside a segment
const GLOBSTAR = { g: 1 } // ** as a whole segment: zero or more segments
const ONE = [STAR] // "any one segment"

// lines: gitignore lines; base: folder the .gitignore sits in, relative to the root ('' for root and chips)
export function compile(lines, base = '') {
  base = base.toLowerCase()
  const depth = base ? base.split('/').length : 0
  const rules = []
  for (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line || line[0] === '#') continue
    let end = line.length
    while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--
    line = line.slice(0, end)
    const neg = line[0] === '!'
    if (neg) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    while (line.endsWith('/')) line = line.slice(0, -1)
    if (!line) continue
    const anchored = line.includes('/')
    if (line[0] === '/') line = line.slice(1)
    let invalid = false
    let segs = line.split('/').filter(Boolean).map(s => {
      if (s === '**') return GLOBSTAR
      const t = tokenize(s)
      if (!t) invalid = true
      return t || []
    })
    if (!anchored && segs[0] === GLOBSTAR) segs = [ONE]
    if (segs.at(-1) === GLOBSTAR) segs.splice(-1, 1, ONE, GLOBSTAR) // trailing x/** = one or more inside x
    rules.push({ neg, dirOnly, anchored, segs, invalid, base, depth })
  }
  return rules
}

// returns a token list, or null when the segment is invalid (unterminated [)
function tokenize(s) {
  const t = []
  for (let i = 0; i < s.length; ) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) { t.push(s[i + 1].toLowerCase()); i += 2 }
    else if (c === '*') { if (t.at(-1) !== STAR) t.push(STAR); i++ }
    else if (c === '?') { t.push(ANY); i++ }
    else if (c === '[') {
      let j = i + 1
      const neg = s[j] === '!' || s[j] === '^'
      if (neg) j++
      const ranges = []
      let first = true
      while (j < s.length && (s[j] !== ']' || first)) {
        first = false
        let a = s[j]
        if (a === '\\' && j + 1 < s.length) a = s[++j]
        j++
        if (s[j] === '-' && j + 1 < s.length && s[j + 1] !== ']') {
          let b = s[j + 1]
          if (b === '\\' && j + 2 < s.length) b = s[++j + 1]
          j += 2
          ranges.push([a, b])
        } else ranges.push([a, a])
      }
      if (j >= s.length) return null
      t.push({ neg, ranges })
      i = j + 1
    } else { t.push(c.toLowerCase()); i++ }
  }
  return t
}

// c is already lower case; classes test both cases so [A-Z] matches 'a'
function one(tok, c) {
  if (tok === ANY) return true
  if (typeof tok === 'string') return tok === c
  const C = c.toUpperCase()
  const hit = tok.ranges.some(([a, b]) => (a <= c && c <= b) || (a <= C && C <= b))
  return hit !== tok.neg
}

// one greedy wildcard matcher, used for chars in a segment and for segments in a path
function wild(pat, items, star, eq) {
  let p = 0, x = 0, sp = -1, sx = 0
  while (x < items.length) {
    if (p < pat.length && pat[p] !== star && eq(pat[p], items[x])) { p++; x++ }
    else if (p < pat.length && pat[p] === star) { sp = p++; sx = x }
    else if (sp >= 0) { p = sp + 1; x = ++sx }
    else return false
  }
  while (p < pat.length && pat[p] === star) p++
  return p === pat.length
}

const matchSeg = (tokens, name) => wild(tokens, name, STAR, one)
const matchPath = (segs, parts) => wild(segs, parts, GLOBSTAR, matchSeg)

// path: '/'-joined, relative to the chosen folder. Last matching rule wins.
// Matching is case-insensitive (git's default on macOS and Windows).
export function isIgnored(rules, path, isDir) {
  const lower = path.toLowerCase()
  const parts = lower.split('/')
  let ignored = false
  for (const r of rules) {
    if (r.invalid || (r.dirOnly && !isDir)) continue
    if (r.base && !lower.startsWith(r.base + '/')) continue
    const rel = r.depth ? parts.slice(r.depth) : parts
    if (r.anchored ? matchPath(r.segs, rel) : matchSeg(r.segs[0], rel[rel.length - 1])) ignored = !r.neg
  }
  return ignored
}
