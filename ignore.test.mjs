// node ignore.test.mjs   (Node 22.7+ or 20.19+). Prints nothing and exits 0 when everything passes.
import assert from 'node:assert/strict'
import { compile, isIgnored } from './ignore.js'

// ign(lines, path, isDir): is path ignored by these root-level lines? Mirrors the walker:
// a path counts as ignored if it or any parent directory is ignored (excluded dirs are never entered).
const ign = (lines, path, isDir = false, rules = compile(lines)) => {
  const parts = path.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const last = i === parts.length
    if (isIgnored(rules, parts.slice(0, i).join('/'), last ? isDir : true)) return true
  }
  return false
}
const yes = (lines, path, isDir) => assert.equal(ign(lines, path, isDir), true, `${lines} should ignore ${path}`)
const no = (lines, path, isDir) => assert.equal(ign(lines, path, isDir), false, `${lines} should keep ${path}`)

// venv/ at any depth, including three nested project folders
yes(['venv/'], 'venv', true)
yes(['venv/'], 'a/venv', true)
yes(['venv/'], 'b/c/venv/lib/site.py')
yes(['venv/'], 'd/e/f/venv/bin/python')
no(['venv/'], 'venv') // a file named venv
no(['venv/'], 'src/venv.py')

yes(['/build'], 'build', true)
no(['/build'], 'src/build', true)
yes(['*.pyc'], 'x.pyc')
yes(['*.pyc'], 'a/b/x.pyc')
no(['*.log', '!keep.log'], 'keep.log')
yes(['*.log', '!keep.log'], 'other.log')

yes(['docs/**/*.md'], 'docs/a/b/c.md')
yes(['docs/**/*.md'], 'docs/c.md')
no(['docs/**/*.md'], 'docs.md')
yes(['**/foo'], 'foo')
yes(['**/foo'], 'a/b/foo')

const logs = compile(['logs/**'])
assert.equal(isIgnored(logs, 'logs', true), false)
assert.equal(isIgnored(logs, 'logs/x.txt', false), true)
assert.equal(isIgnored(logs, 'logs/sub', true), true)
no(['logs/**', '!logs/.gitkeep'], 'logs/.gitkeep')
yes(['logs/**', '!logs/.gitkeep'], 'logs/x.txt')

yes(['thumbs.db'], 'Thumbs.db')
yes(['*.log'], 'ERROR.LOG')
yes(['[A-Z]*.tmp'], 'a.tmp')
yes(['\\#notes'], '#notes')
yes(['*.py[co]'], 'x.pyc')
no(['[!a]b'], 'ab')
yes(['.env*'], '.env')
yes(['.env*'], '.env.local')
yes(['.env*'], '.ENV')
no(['.env*', '!.env.example'], '.env.example')
yes(['.settings/'], 'proj/.settings', true)
no(['# comment', ''], 'comment')

// nested .gitignore: rules stay inside their folder
const sub = compile(['/out'], 'sub')
assert.equal(isIgnored(sub, 'sub/out', true), true)
assert.equal(isIgnored(sub, 'out', true), false)
const myenv = compile(['*'], 'myenv')
assert.equal(isIgnored(myenv, 'myenv/bin', true), true)
assert.equal(isIgnored(myenv, 'myenv', true), false)
assert.equal(isIgnored(myenv, 'src', true), false)
assert.equal(isIgnored(myenv, 'README.md', false), false)
const a = compile(['*.log'], 'a')
assert.equal(isIgnored(a, 'a/x.log', false), true)
assert.equal(isIgnored(a, 'b/x.log', false), false)

// chips come after .gitignore rules, so they win
assert.equal(isIgnored([...compile(['dist/']), ...compile(['!dist/'])], 'dist', true), false)

// invalid pattern never throws and never matches
const bad = compile(['foo[1'])
assert.equal(bad[0].invalid, true)
assert.equal(isIgnored(bad, 'foo[1', false), false)

// hostile pattern runs in linear-ish time (a backtracking regex would take seconds)
const t = performance.now()
assert.equal(isIgnored(compile(['*a'.repeat(15) + '*b']), 'a'.repeat(5000), false), false)
assert.ok(performance.now() - t < 50, 'hostile pattern too slow')
