// Verifies the installed package loads exactly the way the Host loads it:
// through Desktop's host-module fallback, resolving @deepseek-ai/* from the
// bundled application, then mounts it on a fake context.
//
//   node test/installed.mjs <absolute-path-to-installed-dsh-issue-roundtable>
import { registerHostModuleFallback } from 'file:///C:/Program%20Files/DSH%20Desktop/resources/host-module-fallback.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

registerHostModuleFallback('C:/Program Files/DSH Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js')

const target = process.argv[2]
if (!target) throw new Error('pass the installed package directory')

const mod = await import(pathToFileURL(join(target, 'dsh', 'index.js')).href)
console.log('name:', mod.name)
console.log('inject:', JSON.stringify(mod.inject))
console.log('Config is schema:', typeof mod.Config === 'function' || typeof mod.Config === 'object')

const routes = new Map()
let dispose
const ctx = {
  logger: { warn: () => {} },
  get: () => undefined,
  connection: { fetch: { register: (route) => routes.set(route.path, route) } },
  effect: (factory) => {
    dispose = factory()
    return dispose
  },
}
const root = await mkdtemp(join(tmpdir(), 'rtr-installed-'))
mod.apply(ctx, { root, researchMaxResults: 6, maxHistory: 40 })
console.log('routes:', [...routes.keys()].sort().join(', '))

const state = routes.get('/api/issue-roundtable/state')
const response = await state.fetch(new Request('http://127.0.0.1/api/issue-roundtable/state'))
const data = await response.json()
console.log('state status:', response.status, 'roles:', data.roles?.length, 'rounds:', data.settings?.rounds)
console.log('no model configured -> model:', JSON.stringify(data.model))

const startRoute = routes.get('/api/issue-roundtable/start')
const failing = await startRoute.fetch(
  new Request('http://127.0.0.1/api/issue-roundtable/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '没有模型时应该被拒绝', rounds: 1 }),
  }),
)
const failingData = await failing.json()
console.log('start without model ->', failing.status, failingData.error)

dispose?.()
await rm(root, { recursive: true, force: true })
