// Panel test in jsdom: renders the real client bundle, drives the list / wizard /
// detail / library flows, and asserts the roundtable, transcript controls and
// long-text handling. No DSH host, no network, no real model.
//
//   node test/panel.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const P = 'C:/Users/11018790/AppData/Local/Temp/asar-extract/node_modules'
const require = createRequire(`${P}/x.js`)
const CLIENT = 'D:/myprojects/dsh-workbench/lib/client.js'

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

// ------------------------------------------------------------------ fake host

const roles = [
  { id: 'product', groupId: 'core', name: '产品经理', focus: '用户价值', persona: '你从用户价值出发考虑问题，反对没有依据的需求想象；习惯用一个具体场景说明观点。' },
  { id: 'engineering', groupId: 'core', name: '技术负责人', focus: '可行性', persona: '你判断可行性与长期维护成本，会指出别人方案里被低估的复杂度，拒绝先上再补。' },
  { id: 'legal', groupId: 'risk', name: '法务顾问', focus: '合规边界', persona: '你盯住合规红线与责任归属，把「能不能做」拆成「在什么前提下能做」。' },
]
const groups = [
  { id: 'core', name: '核心决策', description: '产品与技术' },
  { id: 'risk', name: '风险与合规', description: '法务与安全' },
]

const longSpeech = Array.from({ length: 6 }, (_, index) => `第${index + 1}段：这是很长的一段发言，用来验证折叠与全文展示是否好用。`).join('\n')

function makeIssue(overrides = {}) {
  const turns = []
  for (let round = 1; round <= 3; round += 1) {
    for (const role of roles.slice(0, 2)) {
      turns.push({ round, roleId: role.id, roleName: role.name, focus: role.focus, text: longSpeech, at: `2026-10-30T0${round}:00:00Z` })
    }
  }
  return {
    id: 'issue-1',
    title: '是否在 Q1 内投入 300 万把移动端从原生迁到 H5',
    background: '原生双端维护成本高。',
    goal: '决定是否投入与节奏',
    checklist: ['预算 300 万为假设'],
    participants: roles.slice(0, 2).map((role) => ({ roleId: role.id, name: role.name, focus: role.focus })),
    plannedRounds: 3,
    round: 3,
    turns,
    status: 'discussing',
    stage: 'idle',
    researchEnabled: true,
    research: { available: true, note: '已检索 1 条资料。', sources: [{ url: 'https://example.com/a', title: '示例资料' }] },
    proposals: [],
    votes: [],
    runoffVotes: [],
    tally: null,
    conclusion: null,
    model: { provider: 'fake', model: 'fake-1' },
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:20:00Z',
    ...overrides,
  }
}

const concluded = makeIssue({
  status: 'decided',
  proposals: [
    { id: 'A', title: '激进方案', summary: '一次投入全部预算。', keyPoints: ['一次到位'], tradeoffs: '压力大' },
    { id: 'B', title: '稳健方案', summary: '先做 10% 灰度。', keyPoints: ['先验证'], tradeoffs: '见效慢' },
  ],
  votes: [
    { roleId: 'product', roleName: '产品经理', proposalId: 'B', reason: '风险可控。' },
    { roleId: 'engineering', roleName: '技术负责人', proposalId: 'A', reason: '一次性投入更容易估算。' },
  ],
  tally: { counts: { A: 1, B: 1 }, voters: { A: ['技术负责人'], B: ['产品经理'] }, abstain: 0, winnerId: 'B', tie: false, tiedIds: ['A', 'B'] },
  conclusion: {
    proposalId: 'B',
    title: '稳健方案',
    summary: '先做 10% 灰度，验证后再扩大。',
    keyPoints: ['先验证'],
    counts: { A: 1, B: 1 },
    dissent: [{ roleName: '技术负责人', proposalId: 'A', reason: '一次性投入更容易估算。' }],
    openQuestions: ['灰度指标怎么定？'],
    note: '按多数票产生结论。',
    stale: false,
  },
})

let issueState = makeIssue()
const state = {
  groups,
  roles,
  issues: [
    { id: 'issue-1', title: '是否在 Q1 内投入 300 万把移动端从原生迁到 H5', goal: '决定是否投入与节奏', status: 'discussing', round: 3, plannedRounds: 3, turnCount: 6, updatedAt: '2026-10-30T00:20:00Z', participants: roles.slice(0, 2).map((r) => ({ id: r.id, name: r.name, focus: r.focus })), conclusionTitle: '', conclusionStale: false },
    { id: 'issue-2', title: '要不要上自动化测试', goal: '决定投入方式', status: 'decided', round: 2, plannedRounds: 2, turnCount: 4, updatedAt: '2026-10-29T00:00:00Z', participants: [{ id: 'engineering', name: '技术负责人' }], conclusionTitle: '稳健方案', conclusionStale: false },
  ],
  model: { provider: 'fake', model: 'fake-1' },
  runningIssueId: null,
  limits: { maxRoles: 12, maxRounds: 8, maxParticipants: 8 },
}

const calls = []
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace('/api/issue-roundtable', '')
  calls.push({ path, method: init.method ?? 'GET' })
  let payload = {}
  if (path.startsWith('/state')) payload = state
  else if (path.startsWith('/issue?id=')) payload = { issue: issueState, summary: {} }
  else if (path.startsWith('/assist/issue')) {
    const body = JSON.parse(init.body)
    const prior = (body.history ?? []).length
    payload = prior
      ? { reply: '信息够了，已定稿。', ready: true, draft: { title: '是否在 Q1 内投入 300 万把移动端迁到 H5', background: '原生双端维护成本高。', goal: '决定是否投入与节奏', checklist: ['预算 300 万为假设'] } }
      : { reply: '先确认：时间窗有多长？', ready: false, draft: { title: '是否迁移移动端到 H5', background: '', goal: '', checklist: ['时间窗待确认'] } }
  } else if (path.startsWith('/assist/team')) {
    payload = {
      reply: '覆盖宏观、行业、基本面、量化、风控五个互补视角。',
      mode: 'full',
      group: { name: '个股投研', description: '判断某只股票值不值得买' },
      roles: [
        { id: 't1', name: '宏观策略师', focus: '周期与流动性', persona: '你从上层的周期与流动性看个股，先判断时点，再用宏观假设压过公司故事，习惯用数字反驳乐观估计。' },
        { id: 't2', name: '基本面分析师', focus: '财报质量', persona: '你只看财报与经营数据：收入质量、现金流与资本开支回报，会用比率反驳没有数字支撑的故事。' },
      ],
    }
  } else if (path.startsWith('/assist/revise')) {
    const body = JSON.parse(init.body)
    payload = {
      reply: '统一提高了保守程度。',
      revised: body.roleIds.map((id) => {
        const role = state.roles.find((item) => item.id === id)
        return { id, name: role.name, focus: role.focus, persona: '你改写后更保守：任何乐观假设都要先给出下行情形与止损条件，并用数字说明能承受多大回撤。', changed: '加入下行情形', before: { name: role.name, focus: role.focus, persona: role.persona } }
      }),
      missing: [],
    }
  } else if (path.startsWith('/assist/role')) {
    payload = { suggestions: [{ id: 's1', name: '安全负责人', focus: '数据与攻击面', persona: '你只关心数据流向与权限边界，会先用最坏情况反驳乐观估计。' }] }
  } else if (path.startsWith('/issue/create')) {
    const body = JSON.parse(init.body)
    payload = { issue: { ...makeIssue(), id: 'issue-new', title: body.title, turns: [], round: 0, status: 'draft', conclusion: null, proposals: [] } }
  } else if (path.startsWith('/issue/continue')) {
    issueState = makeIssue({ plannedRounds: 5, round: 5 })
    payload = { issue: issueState }
  } else if (path.startsWith('/issue/')) payload = { issue: issueState }
  else if (path.startsWith('/library')) {
    const body = JSON.parse(init.body)
    Object.assign(state, { groups: body.groups, roles: body.roles })
    payload = { groups: body.groups, roles: body.roles }
  }
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) }
}

// ---------------------------------------------------------------- load panel

const captured = []
window.__ModuleLoader__ = { load: (entry) => captured.push(entry) }
new Function('window', 'document', readFileSync(CLIENT, 'utf8'))(window, document)
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
host.style.width = '960px'
document.body.appendChild(host)
const root = reactDomClient.createRoot(host)
root.render(e(registered.Component, { active: true, service: {}, entry: registered.descriptor }))

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))
const text = () => host.textContent.replace(/\s+/g, ' ')
const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })
const click = (node) => node?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
const findByText = (selector, needle) => [...host.querySelectorAll(selector)].find((node) => node.textContent.includes(needle))
const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
const areaSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
const type = (node, value) => {
  if (!node) throw new Error('type() received a missing node')
  const setter = node.tagName === 'TEXTAREA' ? areaSetter : inputSetter
  setter.call(node, value)
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

await wait(200)

// ---- shell + issue list ----
check('唯一紧凑工具栏', host.querySelectorAll('[data-dsh-workbench-toolbar]').length === 1)
check('样式只注入一次', document.querySelectorAll('style[data-issue-roundtable]').length === 1)
check('议题列表显示 2 条', host.querySelectorAll('.rtr-issue').length === 2, host.querySelectorAll('.rtr-issue').length)
check('列表项显示角色席位条', host.querySelectorAll('.rtr-strip-seat').length >= 2, host.querySelectorAll('.rtr-strip-seat').length)
check('列表项显示结论摘要', text().includes('结论：稳健方案'), null)
check('状态筛选存在', text().includes('待决定') && text().includes('已表决'), null)

click(findByText('.rtr-pill', '已表决'))
await wait(80)
check('按状态筛选后只剩已表决', host.querySelectorAll('.rtr-issue').length === 1, host.querySelectorAll('.rtr-issue').length)
click(findByText('.rtr-pill', '全部'))
await wait(80)

type(host.querySelector('.rtr-search'), '自动化')
await wait(100)
check('搜索命中标题', host.querySelectorAll('.rtr-issue').length === 1, host.querySelectorAll('.rtr-issue').length)
type(host.querySelector('.rtr-search'), '')
await wait(100)

// ---- issue detail ----
issueState = makeIssue()
click(host.querySelectorAll('.rtr-issue-main')[0])
await wait(200)
check('详情页出现圆桌', host.querySelectorAll('.rtr-seat').length === 2, host.querySelectorAll('.rtr-seat').length)
check('圆桌中心有提示气泡', Boolean(host.querySelector('.rtr-bubble')), null)
check('席位显示发言计数', host.querySelectorAll('.rtr-seat-count').length === 2, host.querySelectorAll('.rtr-seat-count').length)
check('统计卡显示轮次', text().includes('3/3'), null)
check('发言记录列出全部 6 条', host.querySelectorAll('.rtr-turn').length === 6, host.querySelectorAll('.rtr-turn').length)
check('长发言默认折叠', host.querySelectorAll('.rtr-clamped').length === 6, host.querySelectorAll('.rtr-clamped').length)

click(host.querySelectorAll('.rtr-turn-toggle')[0])
await wait(80)
check('展开全文后该条不再折叠', host.querySelectorAll('.rtr-clamped').length === 5, host.querySelectorAll('.rtr-clamped').length)

click(host.querySelectorAll('.rtr-seat')[0])
await wait(120)
check('点座位可只看该角色', host.querySelectorAll('.rtr-turn').length === 3, host.querySelectorAll('.rtr-turn').length)
check('筛选提示可见', text().includes('只看「'), null)
click(findByText('.rtr-btn-ghost', '取消筛选'))
await wait(100)

click(findByText('.rtr-pill', '第 2 轮'))
await wait(100)
check('按轮次筛选只剩 2 条', host.querySelectorAll('.rtr-turn').length === 2, host.querySelectorAll('.rtr-turn').length)
click(findByText('.rtr-pill', '全部'))
await wait(100)

click(findByText('.rtr-pill', '详细'))
await wait(100)
check('切到紧凑后每条一行', host.querySelectorAll('.rtr-turn[data-dense]').length === 6, host.querySelectorAll('.rtr-turn[data-dense]').length)
click(findByText('.rtr-pill', '紧凑'))
await wait(100)

click(findByText('.rtr-pill', '全屏阅读'))
await wait(100)
check('全屏阅读抽屉打开', Boolean(host.querySelector('.rtr-drawer')), null)
check('抽屉内也有完整记录', host.querySelectorAll('.rtr-drawer .rtr-turn').length === 6, host.querySelectorAll('.rtr-drawer .rtr-turn').length)
click(host.querySelector('.rtr-drawer .rtr-btn-ghost'))
await wait(80)
check('抽屉可关闭', !host.querySelector('.rtr-drawer'), null)

click(findByText('.rtr-btn', '继续讨论 +2 轮'))
await wait(250)
check('继续讨论调用 /issue/continue', calls.some((call) => call.path === '/issue/continue' && call.method === 'POST'), null)
check('继续讨论后计划轮数变为 5', text().includes('5/5'), null)

// ---- voted issue ----
issueState = concluded
click(findByText('.rtr-btn-ghost', '‹ 返回议题列表'))
await wait(120)
click([...host.querySelectorAll('.rtr-issue-main')].find((node) => node.textContent.includes('自动化')))
await wait(220)
check('已表决议题显示结论卡', Boolean(host.querySelector('.rtr-conclusion')), null)
check('结论卡保留少数意见', text().includes('少数意见'), null)
check('候选方案标出胜出', Boolean(host.querySelector('.rtr-proposal[data-winner]')), null)
check('投票明细可见', text().includes('投票明细'), null)

// ---- wizard ----
click(findByText('.rtr-btn-ghost', '‹ 返回议题列表'))
await wait(120)
click(findByText('.rtr-btn-primary', '新建议题'))
await wait(150)
check('向导默认在 AI 起草', Boolean(host.querySelector('.rtr-assist')), null)

type(host.querySelector('.rtr-chat-input textarea'), '我想讨论要不要把移动端改成 H5')
await wait(80)
click(findByText('.rtr-assist .rtr-btn-primary', '发送'))
await wait(300)
check('AI 第一轮追问被记录', text().includes('先确认：时间窗有多长？'), null)
check('助手调用 /assist/issue', calls.some((call) => call.path === '/assist/issue'), null)

// Turn 2 answers the question. The draft then becomes ready, and the wizard
// is expected to switch itself to the issue editor — so the chat box is gone
// by design, not by accident.
type(host.querySelector('.rtr-chat-input textarea'), '预算 300 万，Q1 完成')
await wait(80)
click(findByText('.rtr-assist .rtr-btn-primary', '发送'))
await wait(300)
check('第二轮定稿后自动切到议题内容', text().includes('希望产出') && !host.querySelector('.rtr-chat-input'), text().slice(0, 200))
check('定稿标题落进输入框', host.querySelector('.rtr-form input.rtr-input')?.value?.includes('移动端') ?? false,
  host.querySelector('.rtr-form input.rtr-input')?.value)

click(findByText('.rtr-tab', '角色与顺序'))
await wait(150)
check('角色选择按分组展示', host.querySelectorAll('.rtr-roles .rtr-role').length === 3, host.querySelectorAll('.rtr-roles .rtr-role').length)
click(host.querySelectorAll('.rtr-role')[0])
await wait(100)
click(host.querySelectorAll('.rtr-role')[1])
await wait(100)
check('选中角色后出现发言顺序', host.querySelectorAll('.rtr-order-item').length === 2, host.querySelectorAll('.rtr-order-item').length)
check('顺序显示序号徽标', Boolean(host.querySelector('.rtr-order-badge')), null)

const firstName = host.querySelectorAll('.rtr-order-name')[0].textContent
const downButtons = [...host.querySelectorAll('.rtr-order-item')]
  .flatMap((item) => [...item.querySelectorAll('button')])
  .filter((node) => node.textContent === '↓')
click(downButtons[0])
await wait(100)
const afterName = host.querySelectorAll('.rtr-order-name')[0].textContent
check('可调整发言顺序', firstName !== afterName, { firstName, afterName })

click(findByText('.rtr-form .rtr-pill', '5 轮'))
await wait(80)
click(findByText('.rtr-wizard-foot .rtr-btn-primary', '创建议题'))
await wait(250)
check('创建调用 /issue/create', calls.some((call) => call.path === '/issue/create' && call.method === 'POST'), null)

// ---- library ----
click(findByText('.rtr-nav button', '角色库'))
await wait(200)
check('角色库列出分组', host.querySelectorAll('.rtr-lib-group').length >= 3, host.querySelectorAll('.rtr-lib-group').length)
check('角色库列出角色', host.querySelectorAll('.rtr-lib-role').length === 3, host.querySelectorAll('.rtr-lib-role').length)
click(findByText('.rtr-lib-group', '风险与合规'))
await wait(100)
check('按分组过滤角色', host.querySelectorAll('.rtr-lib-role').length === 1, host.querySelectorAll('.rtr-lib-role').length)

click(findByText('.rtr-list-head .rtr-btn', '新建角色'))
await wait(150)
type(host.querySelector('.rtr-lib-form .rtr-assist input.rtr-input'), '我需要一个懂安全的人')
await wait(80)
click(findByText('.rtr-lib-form .rtr-assist .rtr-btn', '生成候选'))
await wait(250)
check('AI 生成角色候选', host.querySelectorAll('.rtr-suggestion').length === 1, host.querySelectorAll('.rtr-suggestion').length)
click(host.querySelector('.rtr-suggestion'))
await wait(100)
check('点候选填入表单', host.querySelector('.rtr-lib-form').textContent.includes('安全负责人'), null)
check('角色表单有分组下拉', Boolean(host.querySelector('.rtr-lib-form select')), null)

// ---- team wizard: design a whole group in one shot ----
click(findByText('.rtr-list-head .rtr-btn-primary', 'AI 建团队'))
await wait(150)
check('团队向导打开', Boolean(host.querySelector('.rtr-lib-form .rtr-assist')), null)
type(host.querySelector('.rtr-lib-form textarea.rtr-textarea'), '我想建一个个股投研组')
await wait(80)
click(findByText('.rtr-assist .rtr-btn-primary', '生成整组角色'))
await wait(300)
check('生成整组预览', host.querySelectorAll('.rtr-team-role').length === 2, host.querySelectorAll('.rtr-team-role').length)
check('预览可改分组名', Boolean(host.querySelector('.rtr-team-head input.rtr-input')), null)
check('预览显示 AI 说明', host.querySelector('.rtr-team-preview').textContent.includes('互补视角'), null)
const groupNameBox = host.querySelector('.rtr-team-head input.rtr-input')
inputSetter.call(groupNameBox, '个股投研组')
groupNameBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
await wait(60)
click(findByText('.rtr-team-preview .rtr-btn-primary', '确认并创建整组'))
await wait(300)
check('整组一次落库（分组数 +1）', state.groups.some((group) => group.name === '个股投研组'), state.groups.map((g) => g.name))
check('整组角色全部落库', state.roles.filter((role) => role.name === '宏观策略师' || role.name === '基本面分析师').length === 2, state.roles.length)
check('落库后回到普通列表', !host.querySelector('.rtr-team-role'), null)

// ---- multi-select a group, then rewrite that scope in one instruction ----
click(findByText('.rtr-lib-group', '核心决策'))
await wait(100)
const groupChecks = [...host.querySelectorAll('.rtr-lib-group-row .rtr-group-check input')]
check('分组可勾选', groupChecks.length >= 2, groupChecks.length)
click(groupChecks[0])
await wait(120)
check('勾选整组后出现选择栏', Boolean(host.querySelector('.rtr-selection-bar')), null)
check('选择栏显示包含整组', host.querySelector('.rtr-selection-bar').textContent.includes('整组'), host.querySelector('.rtr-selection-bar').textContent)

const instr = host.querySelector('.rtr-selection-bar input.rtr-input')
inputSetter.call(instr, '整体更保守，都要先问下行风险')
instr.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
await wait(60)
click(findByText('.rtr-selection-bar .rtr-btn-primary', '生成改写'))
await wait(300)
check('改写预览出现', host.querySelectorAll('.rtr-diff').length >= 2, host.querySelectorAll('.rtr-diff').length)
check('预览有前后对照', host.querySelectorAll('.rtr-diff-old').length === host.querySelectorAll('.rtr-diff-new').length, null)
check('预览可逐个勾选', host.querySelectorAll('.rtr-diff input[type=checkbox]').length >= 2, null)

// uncheck one, apply the rest
click(host.querySelectorAll('.rtr-diff input[type=checkbox]')[0])
await wait(80)
click(findByText('.rtr-team-preview .rtr-btn-primary', '应用勾选的改写'))
await wait(300)
check('改写只落到勾选的角色', state.roles.some((role) => role.persona.includes('更保守')), null)
check('未勾选的角色保持原人设', state.roles.some((role) => role.persona.includes('你从用户价值出发')), null)
check('应用后预览关闭', !host.querySelector('.rtr-diff'), null)

// ---- layout guards ----
check('根容器无横向溢出', host.scrollWidth <= host.clientWidth + 1, { scrollWidth: host.scrollWidth, clientWidth: host.clientWidth })

// The roundtable container only belongs to the detail view, so assert it where
// it is expected rather than from the library view.
click(findByText('.rtr-nav button', '议题'))
await wait(150)
issueState = makeIssue()
click(host.querySelectorAll('.rtr-issue-main')[0])
await wait(200)
check('详情页的圆桌容器具备比例盒子', Boolean(host.querySelector('.rtr-table')), null)
check('座位沿圆周均匀分布', (() => {
  const seats = [...host.querySelectorAll('.rtr-seat')]
  if (seats.length < 2) return false
  const points = seats.map((seat) => {
    const left = parseFloat(seat.style.left)
    const top = parseFloat(seat.style.top)
    // Every seat sits on the same ellipse: ((x-50)/36)^2 + ((y-50)/34)^2 ≈ 1.
    const value = ((left - 50) / 36) ** 2 + ((top - 50) / 34) ** 2
    return Math.abs(value - 1) < 0.02 && left >= 8 && left <= 92 && top >= 8 && top <= 92
  })
  const positions = new Set(seats.map((seat) => `${seat.style.left}/${seat.style.top}`))
  return points.every(Boolean) && positions.size === seats.length
})(), [...host.querySelectorAll('.rtr-seat')].map((seat) => `${seat.style.left}/${seat.style.top}`))
check('详情页无横向溢出', host.scrollWidth <= host.clientWidth + 1, { scrollWidth: host.scrollWidth, clientWidth: host.clientWidth })

for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  → ${JSON.stringify(item.detail)}`}`)
const failed = results.filter((item) => !item.ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
root.unmount()
if (failed) process.exitCode = 1




