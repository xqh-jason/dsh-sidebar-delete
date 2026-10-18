/**
 * Manifest and packaging guardrails.
 *
 * These assert the facts the harness loader and the display checklist depend on,
 * and review the browser half against the plugin rules (no Harness Client
 * package imports, no DOM outside its own component tree, slot registrations
 * exactly as agreed, embedded dictionaries equal to the shipped locale files)
 * so a later edit cannot quietly break either.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, stat } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = (name) => readFile(new URL(name, root), 'utf8')
const manifest = JSON.parse(await read('package.json'))
const clientSource = await read('client.js')
/** Browser half with comments stripped, so a commented-out registration cannot satisfy a check. */
const clientCode = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** @returns every leaf key path of a nested locale dictionary. */
function keyPaths(value, prefix = '') {
  const paths = []
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (entry !== null && typeof entry === 'object') paths.push(...keyPaths(entry, path))
    else paths.push(path)
  }
  return paths.sort()
}

/**
 * Read one `const <name> = { 'key': 'value', … }` block out of the browser half.
 *
 * One entry per line is the file's own layout; a reformat makes this fail
 * loudly rather than silently skipping the comparison.
 *
 * @param source - client.js source.
 * @param marker - the `const … = {` line prefix.
 * @returns the key/value entries.
 */
function embeddedDict(source, marker) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.trim().startsWith(marker))
  assert.notEqual(start, -1, `missing dictionary ${marker}`)
  const entries = {}
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '}') break
    const match = /^\s*'([^']+)':\s*'(.*)',\s*$/.exec(line)
    assert.notEqual(match, null, `unparsable dictionary line in ${marker}: ${line.trim()}`)
    entries[match[1]] = match[2]
  }
  return entries
}

/** @returns the slot registrations the browser half declares, as triples. */
function slotRegistrations(source) {
  const pattern = /name:\s*'([^']+)',\s*id:\s*'([^']+)',\s*order:\s*(\d+)/g
  const found = []
  for (const match of source.matchAll(pattern)) found.push(`${match[1]} ${match[2]} ${match[3]}`)
  return found.sort()
}

test('manifest declares the bundle patch and the browser half', async () => {
  assert.equal(manifest.name, 'dsh-sidebar-delete')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.dsh?.client?.immediately, true)
  assert.deepEqual(manifest.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  assert.ok(manifest.engines?.node?.includes('22.19'), 'engines must document the Node floor')
  await stat(new URL('cordis.patch.yml', root))
})

test('every runtime file is exported and shipped', async () => {
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.ok(manifest.exports['./locale/*.json'])
  for (const file of ['index.js', 'client.js', 'src/session-store.mjs', 'src/http-fence.mjs', 'src/delete-session.mjs', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'cordis.patch.yml']) {
    await stat(new URL(file, root))
  }
  for (const entry of ['index.js', 'client.js', 'src', 'locale', 'icon.svg', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(entry), `files must list ${entry}`)
  }
})

test('the patch inserts this package under the row id the host half is mounted as', async () => {
  const patch = await read('cordis.patch.yml')
  assert.match(patch, /id: sidebar-delete\n\s+name: 'dsh-sidebar-delete'/)
})

test('locale dictionaries carry display metadata and identical key sets', async () => {
  const zh = JSON.parse(await read('locale/zh.json'))
  const en = JSON.parse(await read('locale/en.json'))
  assert.deepEqual(keyPaths(zh), keyPaths(en), 'en and zh must define the same keys')
  for (const [id, dict] of [['zh', zh], ['en', en]]) {
    assert.equal(typeof dict.meta?.title, 'string', `${id} meta.title`)
    assert.ok(dict.meta.title.length > 0)
    assert.equal(typeof dict.meta?.description, 'string', `${id} meta.description`)
    assert.ok(dict.meta.description.length > 0)
    assert.ok(!/blue circle|decoration/i.test(dict.meta.description), `${id} description must describe this plugin`)
  }
})

test('the embedded dictionaries equal the shipped locale files', async () => {
  const zhFile = JSON.parse(await read('locale/zh.json'))
  const enFile = JSON.parse(await read('locale/en.json'))
  const pairs = [
    ['zh', embeddedDict(clientSource, 'const zh = {'), zhFile],
    ['en', embeddedDict(clientSource, 'const en = {'), enFile],
  ]
  for (const [id, embedded, file] of pairs) {
    const fileCopy = { ...file }
    delete fileCopy.meta
    assert.deepEqual(embedded, fileCopy, `${id} dictionary drifted from locale/${id}.json`)
  }
})

test('every locale key the browser half asks for exists', async () => {
  const zhFile = JSON.parse(await read('locale/zh.json'))
  const used = [...clientCode.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1])
  assert.ok(used.length >= 20, 'the browser half should ask for its copy through t()')
  const missing = [...new Set(used)].filter((key) => !(key in zhFile))
  assert.deepEqual(missing, [], `t() keys missing from locale/zh.json: ${missing.join(', ')}`)
})

test('the icon is a small SVG shipped from inside the package', async () => {
  const icon = await read('icon.svg')
  assert.match(icon, /<svg/)
  const info = await stat(new URL('icon.svg', root))
  assert.ok(info.size < 256 * 1024, 'icon must stay under 256 KiB')
})

test('the browser half is a Module Loader package of the expected shape', () => {
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(clientSource, /id: 'dsh-sidebar-delete'/)
  assert.match(clientSource, /factory:/)
})

test('the browser half registers exactly the four agreed slots', () => {
  assert.deepEqual(slotRegistrations(clientCode), [
    'shell.overlay dsh-sidebar-delete.panel 100',
    'sidebar.footer.action dsh-sidebar-delete.manager 100',
    'sidebar.workspaces.session.menu.item dsh-sidebar-delete.session 500',
    'sidebar.workspaces.session.row.action dsh-sidebar-delete.session-row 300',
  ])
  // One inject + one register per slot: a slot dropped from `apply` (even with
  // its name left behind in a comment) must fail here.
  assert.equal((clientCode.match(/ctx\.slots\.inject\(/g) ?? []).length, 4, 'four ctx.slots.inject calls')
  assert.equal((clientCode.match(/ctx\.slots\.register\(/g) ?? []).length, 4, 'four ctx.slots.register calls')
})

test('the browser half imports no Harness Client package and writes no page DOM', () => {
  const harnessImports = clientSource.match(/require\(\s*['"]@deepseek-ai\/[^'"]+['"]\)/g) ?? []
  assert.deepEqual(harnessImports, [], `client.js must not require Harness packages: ${harnessImports.join(', ')}`)
  const requires = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], 'the only runtime import is react')
  assert.ok(!clientSource.includes('document.body'), 'client.js must not touch document.body')
  assert.ok(!/require\(\s*['"]react-dom['"]\s*\)/.test(clientSource), 'client.js must not build a second root')
})

test('the host half exports the documented plugin shape', async () => {
  const host = await read('index.js')
  assert.match(host, /export function apply\(ctx\)/)
  assert.match(host, /export const inject = \['webServer'\]/)
  assert.match(host, /\/dsh-sidebar-delete\/session/)
  assert.ok(!host.includes('export default'), 'host half must use the apply() export form')
  assert.ok(host.includes('api-session/removed'), 'host half must mirror the removal event')
})
