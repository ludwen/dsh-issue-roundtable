// Runs the real workbench service from the installed Desktop against our
// client module: proves register() is accepted (identity, descriptor,
// duplicate checks) and the provider lands in the catalog, without a browser.
//
//   node test/register.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const WORKBENCHES = 'C:/Users/11018790/AppData/Local/Temp/asar-extract/node_modules/dsh-desktop-workbenches/client.js'
const MODULES = 'C:/Users/11018790/AppData/Local/Temp/asar-extract/node_modules'
const CLIENT = 'D:/myprojects/dsh-workbench/lib/client.js'

const require = createRequire(`${MODULES}/x.js`)
const fs = { readFileSync }

globalThis.window = { __ModuleLoader__: { load: () => {} }, localStorage: { getItem: () => null, setItem: () => {} } }
globalThis.document = { createElement: () => ({ style: {} }), head: { appendChild() {} }, querySelector: () => null }

const captured = []
globalThis.window.__ModuleLoader__ = { load: (entry) => captured.push(entry) }
new Function('window', 'document', fs.readFileSync(WORKBENCHES, 'utf8'))(window, document)
const host = captured[0].factory((name) => {
  if (name === 'react') return require(`${MODULES}/react`)
  if (name === '@deepseek-ai/cordis') return { Service: class { static tracker = Symbol() } }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: () => null, Toast: () => null }
  return {}
})

// Load our real client module and take its registered panel.
const ours = []
globalThis.window.__ModuleLoader__ = { load: (entry) => ours.push(entry) }
new Function('window', 'document', fs.readFileSync(CLIENT, 'utf8'))(window, document)
const registered = {}
const ourModule = ours[0].factory((name) => (name === 'react' ? require(`${MODULES}/react`) : {}))
ourModule.apply({
  effect: (factory) => factory(),
  desktopWorkbenches: {
    register: (descriptor, Component) => {
      registered.descriptor = descriptor
      registered.Component = Component
      return () => {}
    },
  },
})

// Mount the real Workbenches service on a fake context, with installs stubbed.
const ctx = {
  fiber: { entry: { options: { name: 'dsh-issue-roundtable' } } },
  effect: () => () => {},
  locale: { register: () => () => {}, bind: () => (key) => key },
  modules: { entries: { state: { getSnapshot: () => ({ failures: [] }) } } },
  remote: { pluginManager: { listBundles: async () => ({ ok: true, value: [] }) } },
}
const request = async () => ({ ok: true, status: 200, json: async () => ({ installs: {}, packages: {} }) })
const service = new host.Workbenches(ctx, request)
service.remoteCatalog = []
service.native = { status: 'ready', bundles: { 'dsh-issue-roundtable': { name: 'dsh-issue-roundtable', installed: true, enabled: true, version: '0.1.0' } } }

let rejected = ''
try {
  service.register(registered.descriptor, registered.Component)
} catch (error) {
  rejected = error.message
}
console.log('register rejected:', rejected || '(no)')
console.log('catalog keys:', [...service.catalog.keys()])
const entry = [...service.catalog.values()][0]
console.log('entry:', entry && JSON.stringify({
  id: entry.id,
  title: entry.title,
  sourcePackage: entry.sourcePackage,
  customFrame: entry.customFrame,
  headerLayout: entry.headerLayout,
  layout: entry.layout,
  hasComponent: typeof entry.Component === 'function',
}))
const market = service.marketCatalog()
console.log('market entries:', market.map((item) => `${item.id} (installed=${item.installed}, local=${item.local})`))
service.dispose?.()
