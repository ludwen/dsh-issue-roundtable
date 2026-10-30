import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const P = 'C:/Users/11018790/AppData/Local/Temp/asar-extract/node_modules'
const require = createRequire(`${P}/x.js`)

const { JSDOM } = require(`${P}/jsdom`)
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:43129/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node

const react = require(`${P}/react`)
const reactDomClient = require(`${P}/react-dom/client`)
globalThis.React = react
const e = react.createElement

const responses = { state: null, run: null, started: null }
const state = {
  roles: [
    { id: 'product', name: '产品经理', focus: '用户价值与需求', persona: '我关心用户价值与体验，反对没有依据的需求想象，习惯用具体场景说话。' },
    { id: 'engineering', name: '技术负责人', focus: '可行性与长期成本', persona: '我关心实现路径、依赖和可回滚性，拒绝先上再补的空头承诺。' },
    { id: 'finance', name: '财务负责人', focus: '预算与投入产出', persona: '我只关心钱从哪来、花多少、多久能看到回报，要求拆成一次性与持续成本。' },
  ],
  settings: { rounds: 3, research: true, roleIds: ['product', 'engineering', 'finance'] },
  model: { provider: 'fake', model: 'fake-1' },
  maxRounds: 5,
  activeRun: null,
  history: [
    {
      id: 'run-old',
      topic: '是否把移动端改成 H5，预算 300 万',
      status: 'done',
      conclusionTitle: '稳健方案',
      participants: ['产品经理', '技术负责人'],
      createdAt: '2026-10-30T00:00:00Z',
      finishedAt: '2026-10-30T00:10:00Z',
    },
  ],
}

function runPayload(status) {
  return {
    id: 'run-new',
    topic: '我们是否要在明年把移动端从原生改成 H5，预算上限 300 万',
    status,
    stage: status === 'done' ? 'result' : 'debate',
    round: status === 'done' ? 2 : 1,
    totalRounds: 2,
    researchEnabled: true,
    participants: state.roles.map((role) => ({ id: role.id, name: role.name, focus: role.focus })),
    research: { available: true, note: '已检索到 2 条资料。', queries: ['x'], sources: [{ url: 'https://example.com/a', title: '示例资料', snippet: '背景摘要' }] },
    turns: [
      { round: 1, roleId: 'product', roleName: '产品经理', focus: '用户价值', text: '我认为先验证再用场景说话。' },
      { round: 1, roleId: 'engineering', roleName: '技术负责人', focus: '可行性', text: 'H5 的可回滚性更好，我支持分批迁移。' },
      { round: 2, roleId: 'product', roleName: '产品经理', focus: '用户价值', text: '复述一下，我接受分批。' },
      { round: 2, roleId: 'engineering', roleName: '技术负责人', focus: '可行性', text: '' , error: '这次发言失败：超时' },
    ],
    speaking: status === 'running' ? { round: 2, roleId: 'finance', roleName: '财务负责人', startedAt: new Date().toISOString() } : null,
    proposals: status === 'done'
      ? [
          { id: 'A', title: '激进方案', summary: '一次投入全部预算，三个月内完成迁移。', keyPoints: ['一次到位', '风险高'], tradeoffs: '前期压力大' },
          { id: 'B', title: '稳健方案', summary: '先做 10% 灰度，验证后再扩大。', keyPoints: ['先验证'], tradeoffs: '见效慢' },
        ]
      : [],
    votes: status === 'done'
      ? [
          { roleId: 'product', roleName: '产品经理', label: '表决', runoff: false, proposalId: 'B', reason: '风险可控。', abstain: false },
          { roleId: 'finance', roleName: '财务负责人', label: '表决', runoff: false, proposalId: 'A', reason: '一次性预算更容易核算。', abstain: false },
          { roleId: 'engineering', roleName: '技术负责人', label: '表决', runoff: false, proposalId: null, reason: '投票失败：格式错误', abstain: true },
        ]
      : [],
    runoffVotes: [],
    tally: status === 'done'
      ? { counts: { A: 1, B: 1 }, voters: { A: ['财务负责人'], B: ['产品经理'] }, abstain: 1, winnerId: 'B', tie: false, tiedIds: ['A', 'B'] }
      : null,
    conclusion: status === 'done'
      ? {
          proposalId: 'B',
          title: '稳健方案',
          summary: '先做 10% 灰度，验证后再扩大。',
          keyPoints: ['先验证', '周期长'],
          tradeoffs: '见效慢',
          counts: { A: 1, B: 1 },
          voters: { A: ['财务负责人'], B: ['产品经理'] },
          abstain: 1,
          dissent: [{ roleName: '财务负责人', proposalId: 'A', reason: '一次性预算更容易核算。' }],
          openQuestions: ['灰度指标怎么定？'],
          decidedAt: '2026-10-30T00:10:00Z',
          note: '按多数票产生结论。',
        }
      : null,
    error: '',
    usage: [],
    model: { provider: 'fake', model: 'fake-1' },
    startedAt: '2026-10-30T00:00:00Z',
    finishedAt: status === 'done' ? '2026-10-30T00:10:00Z' : null,
    updatedAt: '2026-10-30T00:10:00Z',
    elapsedMs: 600000,
  }
}

let currentRunStatus = 'running'
globalThis.fetch = async (url, init = {}) => {
  const path = String(url)
  if (path.startsWith('/api/issue-roundtable/run')) return { ok: true, status: 200, json: async () => ({ run: runPayload(currentRunStatus) }) }
  if (path.startsWith('/api/issue-roundtable/start')) return { ok: true, status: 200, json: async () => ({ runId: 'run-new', run: runPayload('running') }) }
  if (path.startsWith('/api/issue-roundtable/cancel')) return { ok: true, status: 200, json: async () => ({ cancelled: true }) }
  if (path.startsWith('/api/issue-roundtable/debate')) return { ok: true, status: 200, json: async () => ({ debate: runPayload('done') }) }
  if (path.startsWith('/api/issue-roundtable/delete')) return { ok: true, status: 200, json: async () => ({ deleted: true }) }
  if (path.startsWith('/api/issue-roundtable/roles')) return { ok: true, status: 200, json: async () => ({ roles: state.roles }) }
  if (path.startsWith('/api/issue-roundtable/settings')) return { ok: true, status: 200, json: async () => ({ settings: state.settings }) }
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(state)) }
  void init
}

// ---------------------------------------------------------------- load panel
const captured = []
window.__ModuleLoader__ = { load: (entry) => captured.push(entry) }
new Function('window', 'document', readFileSync('D:/myprojects/dsh-workbench/lib/client.js', 'utf8'))(window, document)
const mod = captured[0].factory((name) => (name === 'react' ? react : require(name)))

const registered = {}
mod.apply({
  effect: (factory) => factory(),
  desktopWorkbenches: {
    register: (descriptor, Component) => {
      registered.descriptor = descriptor
      registered.Component = Component
      return () => {}
    },
  },
})

const host = document.createElement('div')
host.style.width = '820px'
document.body.appendChild(host)
const root = reactDomClient.createRoot(host)
root.render(e(registered.Component, { active: true, service: {}, entry: registered.descriptor, conversation: null }))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const text = () => host.textContent.replace(/\s+/g, ' ')
const results = []
const check = (name, condition, detail) => results.push({ name, ok: Boolean(condition), detail })

await wait(150)
check('业务面板唯一紧凑工具栏', host.querySelectorAll('[data-dsh-workbench-toolbar]').length === 1)
check('CSS 注入一次', document.querySelectorAll('style[data-issue-roundtable]').length === 1)
check('首页显示角色卡片', host.querySelectorAll('.rtr-role').length === 3, host.querySelectorAll('.rtr-role').length)
check('首页显示历史讨论', host.querySelectorAll('.rtr-history-item').length === 1)
check('议题为空时开始按钮禁用', [...host.querySelectorAll('button')].find((b) => b.textContent.includes('开始圆桌讨论'))?.disabled === true)

// type a topic
const area = host.querySelector('textarea.rtr-textarea')
const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
setter.call(area, '我们是否要在明年把移动端从原生改成 H5，预算上限 300 万')
area.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
await wait(80)
check('输入议题后开始按钮可用', [...host.querySelectorAll('button')].find((b) => b.textContent.includes('开始圆桌讨论'))?.disabled === false)

// switch round count
const roundBtn = [...host.querySelectorAll('button.rtr-pill')].find((b) => b.textContent === '2 轮')
roundBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(40)

// start
const startBtn = [...host.querySelectorAll('button')].find((b) => b.textContent.includes('开始圆桌讨论'))
startBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(150)
check('点击开始后进入讨论视图', text().includes('讨论过程'), text().slice(0, 120))
check('讨论视图显示议题', text().includes('移动端从原生改成 H5'))
check('进行中显示正在发言', text().includes('正在发言'), text().slice(0, 200))
check('进行中可取消讨论', Boolean([...host.querySelectorAll('button')].find((b) => b.textContent === '取消讨论')))
check('背景资料列出检索来源', Boolean(host.querySelector('a[href="https://example.com/a"]')))

// finish the run and let the poller pick it up
currentRunStatus = 'done'
await wait(1800)
check('轮询拿到结束后显示候选方案', host.querySelectorAll('.rtr-proposal').length === 2, host.querySelectorAll('.rtr-proposal').length)
check('胜出方案被标记', Boolean(host.querySelector('.rtr-proposal[data-winner]')))
check('投票明细列出弃权', text().includes('弃权'))
check('表决结果卡片出现', text().includes('表决结果') && text().includes('稳健方案'), text().slice(-160))
check('少数意见被保留', text().includes('少数意见'), null)
check('失败发言有单独提示', text().includes('这次发言失败'), null)

// role editor
const roleButton = [...host.querySelectorAll('button')].find((b) => b.textContent.includes('角色设定'))
roleButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(80)
check('角色编辑器打开', host.querySelectorAll('.rtr-editor-item').length === 3, host.querySelectorAll('.rtr-editor-item').length)
check('角色编辑器提示 ai agent', text().includes('每个角色就是一位独立的发言 agent'))

// no horizontal overflow: the panel itself must not force a horizontal scrollbar
check('根容器无横向溢出', host.scrollWidth <= host.clientWidth + 1, { scrollWidth: host.scrollWidth, clientWidth: host.clientWidth })

for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  → ${JSON.stringify(item.detail)}`}`)
const failed = results.filter((item) => !item.ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
root.unmount()
if (failed) process.exitCode = 1
