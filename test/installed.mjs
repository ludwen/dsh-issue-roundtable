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

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
}

const mod = await import(pathToFileURL(join(target, 'dsh', 'index.js')).href)
check('导出了插件 name', mod.name === 'issue-roundtable', mod.name)
check('注入了 connection', JSON.stringify(mod.inject) === '["connection"]', mod.inject)
check('Config 是 Schemastery schema', typeof mod.Config === 'function' || typeof mod.Config === 'object', typeof mod.Config)

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
mod.apply(ctx, { root, researchMaxResults: 6, maxIssues: 200, transcriptChars: 14000 })

const expected = [
  'state',
  'library',
  'issue',
  'issue/create',
  'issue/update',
  'issue/start',
  'issue/continue',
  'issue/vote',
  'issue/cancel',
  'issue/delete',
  'issue/clear-conclusion',
  'assist/issue',
  'assist/role',
  'assist/team',
  'assist/revise',
  'library/apply',
]
check('注册了全部 16 条路由', expected.length === 16 && expected.every((name) => routes.has(`/api/issue-roundtable/${name}`)), [...routes.keys()].sort())

const state = routes.get('/api/issue-roundtable/state')
const response = await state.fetch(new Request('http://127.0.0.1/api/issue-roundtable/state'))
const data = await response.json()
check('state 返回内置分组与角色', response.status === 200 && data.groups?.length === 3 && data.roles?.length >= 4, {
  groups: data.groups?.length,
  roles: data.roles?.length,
})
check('没有配置模型时 model 为 null', data.model === null, data.model)

const startRoute = routes.get('/api/issue-roundtable/issue/start')
const failing = await startRoute.fetch(
  new Request('http://127.0.0.1/api/issue-roundtable/issue/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'nope' }),
  }),
)
check('未知议题返回 404', failing.status === 404, failing.status)

const createRoute = routes.get('/api/issue-roundtable/issue/create')
const badCreate = await createRoute.fetch(
  new Request('http://127.0.0.1/api/issue-roundtable/issue/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '没有模型时创建议题', roleIds: ['product', 'engineering'] }),
  }),
)
const badCreateBody = await badCreate.json()
check('没有模型时创建议题被拒绝', badCreate.status === 409 && String(badCreateBody.error).includes('模型'), badCreateBody)

const library = routes.get('/api/issue-roundtable/library')
const libraryResponse = await library.fetch(
  new Request('http://127.0.0.1/api/issue-roundtable/library', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      groups: [...data.groups, { id: 'ops', name: '运维', description: '' }],
      roles: [...data.roles, { id: 'ops1', name: '运维负责人', focus: '上线', persona: '你关心上线窗口与回滚路径，会追问故障时的止损动作。', groupId: 'ops' }],
    }),
  }),
)
const libraryBody = await libraryResponse.json()
check('可保存分组与角色', libraryResponse.status === 200 && libraryBody.roles.length === data.roles.length + 1, {
  status: libraryResponse.status,
})

dispose?.()
await rm(root, { recursive: true, force: true })
console.log(`\n${failures ? 'FAILED' : '全部通过'}`)
if (failures) process.exitCode = 1

