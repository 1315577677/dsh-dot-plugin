import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('package files include the nested built runtime', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.private, undefined, 'the package must be installable from a tarball')
  assert.ok(manifest.files.includes('lib/**/*.js'), 'nested lib/*.js must ship for orchestrator and memory')
  assert.ok(manifest.files.includes('README.zh-CN.md'))
  assert.equal(manifest.main, './lib/index.js')
})

test('the bundle patch and client bundle exist where the manifest points', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(path.join(root, 'cordis.patch.yml')))
  assert.ok(existsSync(path.join(root, 'lib', 'client.js')))
  assert.ok(existsSync(path.join(root, 'lib', 'orchestrator', 'worker-manager.js')))
  assert.ok(existsSync(path.join(root, 'lib', 'memory', 'store.js')))
})

test('both README languages exist and cross-link', () => {
  const en = readFileSync(path.join(root, 'README.md'), 'utf8')
  const zh = readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8')
  assert.match(en, /README\.zh-CN\.md/)
  assert.match(zh, /\(README\.md\)/)
  assert.match(en, /docs\/screenshots\/dot-chat\.png/)
})
