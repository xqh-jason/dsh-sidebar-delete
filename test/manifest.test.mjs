/**
 * Manifest and packaging guardrails.
 *
 * These assert the facts the harness loader and the display checklist depend on,
 * and review the browser half against the plugin rules (no Harness Client
 * package imports, no DOM outside its own component tree) so a later edit
 * cannot quietly break either.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, stat } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = (name) => readFile(new URL(name, root), 'utf8')
const manifest = JSON.parse(await read('package.json'))
const clientSource = await read('client.js')

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
  for (const file of ['index.js', 'client.js', 'src/session-store.mjs', 'src/http-fence.mjs', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'cordis.patch.yml']) {
    await stat(new URL(file, root))
  }
  for (const entry of ['index.js', 'client.js', 'src', 'locale', 'icon.svg', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(entry), `files must list ${entry}`)
  }
})

test('the patch inserts exactly this package under the row id the client uses', async () => {
  const patch = await read('cordis.patch.yml')
  assert.match(patch, /id: sidebar-delete/)
  assert.match(patch, /name: 'dsh-sidebar-delete'/)
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
  for (const key of ['confirm.title', 'confirm.desc', 'confirm.action', 'menu.session', 'rowAction.delete', 'manager.title', 'manager.entry']) {
    assert.ok(zh[key] && en[key], `missing ${key}`)
  }
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

test('the browser half registers all four slots with the agreed ids and orders', () => {
  for (const slot of [
    'sidebar.workspaces.session.menu.item',
    'sidebar.workspaces.session.row.action',
    'sidebar.footer.action',
    'shell.overlay',
  ]) {
    assert.ok(clientSource.includes(slot), `client.js must register ${slot}`)
  }
  assert.match(clientSource, /id: 'dsh-sidebar-delete\.session'/)
  assert.match(clientSource, /id: 'dsh-sidebar-delete\.session-row'/)
  assert.match(clientSource, /id: 'dsh-sidebar-delete\.manager'/)
  assert.match(clientSource, /id: 'dsh-sidebar-delete\.panel'/)
  assert.match(clientSource, /order: 500/)
  assert.match(clientSource, /order: 300/)
  assert.match(clientSource, /order: 100/)
})

test('the browser half imports no Harness Client package and writes no page DOM', () => {
  const harnessImports = clientSource.match(/require\('@deepseek-ai\/[^']+'\)/g) ?? []
  assert.deepEqual(harnessImports, [], `client.js must not require Harness packages: ${harnessImports.join(', ')}`)
  assert.ok(!clientSource.includes('document.body'), 'client.js must not touch document.body')
  assert.ok(!/require\('react-dom'\)/.test(clientSource), 'client.js must not build a second root')
})

test('the host half exports the documented plugin shape', async () => {
  const host = await read('index.js')
  assert.match(host, /export function apply\(ctx\)/)
  assert.match(host, /export const inject = \['webServer'\]/)
  assert.match(host, /\/dsh-sidebar-delete\/session/)
  assert.ok(!host.includes('export default'), 'host half must use the apply() export form')
})
