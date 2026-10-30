// Smoke test for the host half: no DSH host, no network, no real model.
//   node test/smoke.mjs
//
// Mounts the plugin on a fake Cordis context with a scripted fake LLM stream,
// then walks the whole feature set over the real fetch-route handlers:
// library (groups + roles), issue create/update, rounds, continue past the
// planned rounds, vote (incl. runoff), AI assist for issue drafting and role
// design, plus validation and 404 paths.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, extractJson, normalizeGroups, normalizeProposals, normalizeRoles } from '../dsh/index.js'

let failures = 0
const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) failures += 1
}

// --------------------------------------------------------------- fake host

function fakeStream(text) {
  return (async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 40 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const CLERK = JSON.stringify({
  proposals: [
    { title: '激进方案', summary: '一次投入全部预算，三个月内完成。', keyPoints: ['一次到位'], tradeoffs: '前期压力大' },
    { title: '稳健方案', summary: '先做 10% 灰度，验证后再扩大。', keyPoints: ['先验证'], tradeoffs: '见效慢' },
  ],
  recommendedId: 'B',
  openQuestions: ['灰度指标怎么定？'],
})

function scripted(options) {
  const system = options.system ?? ''
  // `callModel` always hands the model `messages`; a one-shot prompt arrives
  // as its single user message, so read the last user text either way.
  const allUser = (options.messages ?? []).filter((message) => message.role === 'user')
  const lastUser = allUser.at(-1)
  const lastText = lastUser?.content?.[0]?.text ?? ''
  const userPrompt = allUser.map((message) => message.content?.[0]?.text ?? '').join('\n')
  if (system.includes('议题顾问')) {
    const userTurns = (options.messages ?? []).filter((message) => message.role === 'user').length
    if (userTurns <= 1) {
      return JSON.stringify({
        reply: '先确认一件事：这次决策的时间窗有多长？',
        ready: false,
        draft: { title: '是否在 Q1 内完成移动端迁移', background: '现状为原生双端维护。', goal: '给出可执行的迁移节奏', checklist: ['预算上限待确认'] },
      })
    }
    return JSON.stringify({
      reply: '信息够了，已按 300 万预算与 Q1 时间窗定稿。',
      ready: true,
      draft: {
        title: '是否在 Q1 内投入 300 万把移动端从原生迁到 H5',
        background: '原生双端维护成本高；H5 可复用一套前端。',
        goal: '决定是否投入、按什么节奏投入',
        checklist: ['预算 300 万为假设', '要求可回滚'],
      },
    })
  }
  if (system.includes('角色设计师')) {
    return JSON.stringify({
      suggestions: [
        {
          name: '安全负责人',
          focus: '数据与攻击面',
          persona: '你只关心数据流向、权限边界与攻击面，任何方案都要先画出信任边界；你习惯用最坏情况来反驳乐观估计。',
          tags: ['安全'],
        },
        {
          name: '运维负责人',
          focus: '上线与稳定性',
          persona: '你关心上线窗口、回滚路径与监控覆盖，会追问故障时的止损动作；你反对没有演练过的方案。',
          tags: ['稳定性'],
        },
      ],
    })
  }
  if (system.includes('团队设计器')) {
    return JSON.stringify({
      group: { name: '个股投研', description: '判断某只股票值不值得买' },
      reply: '覆盖宏观、行业、公司基本面、估值、风险五个互补视角。',
      roles: [
        { name: '宏观策略师', focus: '周期与流动性', persona: '你从上层的周期与流动性看个股：先判断现在是不是买股票的时点，再用宏观假设压过公司故事；你习惯先给一个基准情景，再给出乐观与悲观两个区间，并用流动性数据说明为什么现在能买或不能买。', tags: ['宏观'] },
        { name: '行业分析师', focus: '景气与格局', persona: '你盯住行业景气度、供需与竞争格局：会追问这家公司的增长到底来自行业红利还是自身份额提升，并核对产能、价格与库存三个指标；你不接受只讲赛道不讲份额的叙事。', tags: ['行业'] },
        { name: '基本面分析师', focus: '财报质量', persona: '你只看财报与经营数据：收入质量、经营性现金流、资本开支回报与负债结构，会用三个关键比率反驳任何没有数字支撑的故事，并标出你用的口径与假设。', tags: ['基本面'] },
        { name: '量化交易员', focus: '赔率与仓位', persona: '你关心赔率、波动与仓位：认为再好的公司买贵了也是坏交易，习惯用概率与回撤分布说话，并要求每个建议都给出进场区间、止损位和预期持有周期。', tags: ['量化'] },
        { name: '风控负责人', focus: '下行与集中度', persona: '你先问最坏情况：如果逻辑证伪会跌多少、组合能不能扛住、集中度是否过高；任何方案都要先过下行测试与压力情景，否则你不签字，并会要求给出明确的退出条件。', tags: ['风控'] },
      ],
    })
  }
  if (system.includes('团队编辑器')) {
    const targets = [...userPrompt.matchAll(/--- id: ([^\n]+)/g)].map((match) => match[1].trim())
    return JSON.stringify({
      reply: '统一提高了保守程度，各自视角保持不变。',
      roles: targets.map((id) => ({ id, name: '保持不变', focus: '不变', persona: '你改写后更保守：任何乐观假设都要先给出下行情形与止损条件，并用数字说明能承受多大回撤。', changed: '加入下行情形与止损条件' })),
    })
  }
  if (system.includes('书记员')) return CLERK
  if (system.includes('用一票决定')) {
    return JSON.stringify({ proposalId: system.includes('财务负责人') || system.includes('用户代表') ? 'A' : 'B', reason: '按风险可控程度判断。' })
  }
  const round = /第 (\d+) 轮/.exec(lastText)?.[1] ?? '1'
  const continued = lastText.includes('追加讨论')
  return `${continued ? '（追加）' : ''}（第${round}轮发言）我倾向先小规模验证再扩大投入，主要风险在后期不可逆成本。`
}

function createFakeContext({ root, reply = scripted, web = true }) {
  const routes = new Map()
  const calls = []
  const ctx = {
    logger: { warn: () => {} },
    get(name) {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'fake', name: 'Fake' }],
          listModels: async () => [{ id: 'fake-1', name: 'Fake 1' }, { id: 'discuss-model', name: 'Disc' }],
          stream: (options) => {
            calls.push({ system: (options.system ?? '').slice(0, 12) })
            return fakeStream(reply(options))
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }
      if (name === 'web' && web) {
        return { search: async () => ({ sources: [{ url: 'https://example.com/a', title: '示例资料', snippet: '背景' }], truncated: false }) }
      }
      return undefined
    },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    effect: (factory) => factory(),
  }
  return { ctx, routes, calls }
}

async function call(routes, path, { method = 'GET', body } = {}) {
  const route = routes.get(`/api/issue-roundtable${path.split('?')[0]}`)
  if (!route) throw new Error(`route ${path} not registered`)
  if (!route.methods.includes(method)) throw new Error(`route ${path} does not accept ${method}`)
  const request = new Request(`http://127.0.0.1/api/issue-roundtable${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const response = await route.fetch(request)
  return { status: response.status, data: await response.json() }
}

async function waitIdle(routes, id, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const { data } = await call(routes, `/issue?id=${encodeURIComponent(id)}`)
    if (data.issue.status !== 'running' && data.issue.status !== 'voting') return data.issue
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('issue did not settle in time')
}

// ---------------------------------------------------------------------- run

async function main() {
  // ---- pure helpers ----
  const parsed = extractJson('前言\n```json\n{"proposals":[{"title":"甲","summary":"做甲"}],"recommendedId":"A"}\n```')
  check('extractJson 能穿过代码块与前缀', parsed?.proposals?.[0]?.title === '甲', parsed)
  check('extractJson 容忍尾随逗号', Boolean(extractJson('{"a":[1,2,]}')), null)
  check('候选方案按出现顺序重编 ID', normalizeProposals([{ title: 'A' }, { title: 'B' }])[1].id === 'B', null)
  const groups = normalizeGroups([{ name: '甲组' }, { name: '乙组' }, { name: '' }])
  check('空名分组被丢弃', groups.length === 2, groups)
  const roles = normalizeRoles([{ name: '甲', persona: '一二三四五六七八九十一二三四五六七八九十', groupId: 'missing' }], groups)
  check('未知分组回落到第一个分组', roles[0]?.groupId === groups[0].id, roles)

  // ---- library: groups + roles ----
  const root = await mkdtemp(join(tmpdir(), 'rtr-'))
  const { ctx, routes } = createFakeContext({ root })
  apply(ctx, { root, researchMaxResults: 6, maxIssues: 200, transcriptChars: 14000 })
  check('注册了 issue-roundtable 路由', routes.has('/api/issue-roundtable/state'), [...routes.keys()].length)

  const state = await call(routes, '/state')
  check('内置角色库带分组', state.data.roles.length >= 4 && state.data.groups.length === 3, { roles: state.data.roles.length, groups: state.data.groups.length })
  check('内置角色都归属到某个分组', state.data.roles.every((role) => state.data.groups.some((group) => group.id === role.groupId)), null)
  check('state 暴露上限与解析后的模型', state.data.limits.maxRounds >= 5 && state.data.model?.resolved?.discuss?.provider === 'fake', state.data.model?.resolved)

  const library = await call(routes, '/library', {
    method: 'POST',
    body: {
      groups: [...state.data.groups, { id: 'ops', name: '运维与安全', description: '上线、稳定性、安全' }],
      roles: [
        ...state.data.roles,
        { id: 'sre', name: '运维负责人', focus: '上线与稳定性', persona: '你关心上线窗口、回滚路径与监控覆盖，会追问故障时的止损动作。', groupId: 'ops' },
      ],
    },
  })
  check('新增分组与角色保存成功', library.status === 200 && library.data.groups.length === 4 && library.data.roles.length === state.data.roles.length + 1, {
    groups: library.data.groups?.length,
    roles: library.data.roles?.length,
  })
  check('分组与角色持久化到 state', (await call(routes, '/state')).data.roles.some((role) => role.id === 'sre'), null)

  // ---- issue: create / start / rounds / continue / vote ----
  const created = await call(routes, '/issue/create', {
    method: 'POST',
    body: {
      title: '是否在 Q1 内投入 300 万把移动端迁到 H5',
      background: '原生双端维护成本高。',
      goal: '决定是否投入与节奏',
      roleIds: ['product', 'engineering', 'finance', 'user'],
      plannedRounds: 2,
      research: true,
    },
  })
  check('创建议题返回 draft 状态', created.status === 200 && created.data.issue.status === 'draft', created.data.issue?.status)
  check(
    '参与顺序按提交顺序冻结',
    created.data.issue.participants.map((role) => role.roleId).join('>') === 'product>engineering>finance>user',
    created.data.issue.participants.map((role) => role.roleId),
  )
  const issueId = created.data.issue.id

  const started = await call(routes, '/issue/start', { method: 'POST', body: { id: issueId } })
  check('开始讨论后进入 running', started.status === 200, started.data.issue?.status)
  let issue = await waitIdle(routes, issueId)
  check('按计划跑满 2 轮 × 4 角色 = 8 条发言', issue.turns.length === 8, issue.turns.length)
  check('跑完后状态是 discussing（等用户决定下一步）', issue.status === 'discussing', issue.status)
  check('拿到联网资料', issue.research?.sources?.length === 1, issue.research?.sources?.length)
  check('尚未表决时没有结论', issue.conclusion === null, issue.conclusion)

  const continued = await call(routes, '/issue/continue', { method: 'POST', body: { id: issueId, rounds: 1 } })
  check('5 轮之后仍可继续追加（计划轮数 +1）', continued.status === 200 && continued.data.issue.plannedRounds === 3, continued.data.issue?.plannedRounds)
  issue = await waitIdle(routes, issueId)
  check('追加轮次产生了第 3 轮发言', issue.turns.length === 12 && issue.turns.at(-1).round === 3, { turns: issue.turns.length, lastRound: issue.turns.at(-1)?.round })
  check('追加轮次用「追加讨论」任务', issue.turns.at(-1).text.startsWith('（追加）'), issue.turns.at(-1).text.slice(0, 20))

  const voted = await call(routes, '/issue/vote', { method: 'POST', body: { id: issueId } })
  check('表决后进入投票流程', voted.status === 200, voted.data.issue?.status)
  issue = await waitIdle(routes, issueId)
  check('书记员产出 2 个候选方案', issue.proposals.length === 2, issue.proposals?.length)
  check('每位角色投出一票', issue.votes.length === 4 && issue.votes.every((vote) => vote.proposalId), issue.votes?.length)
  check('结论按多数票产生', issue.conclusion?.proposalId === 'B' && issue.conclusion.counts.B >= 2, issue.conclusion?.counts)
  check('结论保留少数意见', issue.conclusion.dissent.length >= 1, issue.conclusion.dissent?.length)
  check('表决后状态是 decided', issue.status === 'decided', issue.status)

  const stale = await call(routes, '/issue/continue', { method: 'POST', body: { id: issueId, rounds: 1 } })
  check('已有结论后继续讨论会把结论标记为过期', stale.status === 200, stale.status)
  issue = await waitIdle(routes, issueId)
  check('结论被标记 stale', issue.conclusion?.stale === true, issue.conclusion?.stale)
  check('旧结论没有被删除，仍可回看', Boolean(issue.conclusion?.title), issue.conclusion?.title)

  const cleared = await call(routes, '/issue/clear-conclusion', { method: 'POST', body: { id: issueId } })
  check('可以清除结论重新表决', cleared.status === 200 && cleared.data.issue.conclusion === null, cleared.data.issue?.status)

  // ---- AI assist ----
  const assist1 = await call(routes, '/assist/issue', { method: 'POST', body: { input: '我想讨论要不要把移动端改成 H5' } })
  check('议题助手第一轮会追问且 ready=false', assist1.status === 200 && assist1.data.ready === false && assist1.data.reply.length > 0, assist1.data.ready)
  check('议题助手给出草稿', assist1.data.draft?.title.length > 0, assist1.data.draft)

  const assist2 = await call(routes, '/assist/issue', {
    method: 'POST',
    body: {
      input: '预算 300 万，Q1 内完成',
      history: [
        { role: 'user', content: '我想讨论要不要把移动端改成 H5' },
        { role: 'assistant', content: assist1.data.reply },
      ],
    },
  })
  check('议题助手多轮后可定稿（ready=true）', assist2.status === 200 && assist2.data.ready === true, assist2.data.ready)
  check('定稿带背景/目标/核对清单', Boolean(assist2.data.draft.background && assist2.data.draft.goal && assist2.data.draft.checklist.length), assist2.data.draft)
  check('议题助手收到多轮上下文', assist2.data.reply.includes('信息够了'), assist2.data.reply)

  const roleAssist = await call(routes, '/assist/role', { method: 'POST', body: { input: '我需要一个懂安全和上线的人', existingNames: ['产品经理'], groupName: '运维与安全' } })
  check('角色助手给出 2~3 个候选', roleAssist.status === 200 && roleAssist.data.suggestions.length === 2, roleAssist.data.suggestions?.length)
  check('候选含名称/关注点/立场', roleAssist.data.suggestions.every((item) => item.name && item.focus && item.persona.length >= 20), roleAssist.data.suggestions)

  check('空描述会被拒绝', (await call(routes, '/assist/role', { method: 'POST', body: { input: '' } })).status === 400, null)

  // ---- team assist: a whole group of roles in one call ----
  const team = await call(routes, '/assist/team', { method: 'POST', body: { input: '我想建一个个股投研组，判断某只股票值不值得买', mode: 'full' } })
  check('团队助手给出分组名', team.status === 200 && team.data.group?.name === '个股投研', team.data.group)
  check('团队助手返回 4~6 个互补角色', team.data.roles.length >= 4 && team.data.roles.length <= 6, team.data.roles?.length)
  check('团队角色都带人设（full 模式）', team.data.roles.every((role) => role.name && role.focus && role.persona.length >= 60), team.data.roles?.map((r) => (r.persona ?? '').length))
  check('团队角色视角不重复', new Set(team.data.roles.map((role) => role.name)).size === team.data.roles.length, null)
  check('团队助手给出说明', team.data.reply.length > 5, team.data.reply)

  const skeleton = await call(routes, '/assist/team', { method: 'POST', body: { input: '我想建一个个股投研组', mode: 'skeleton' } })
  check('只出框架模式也能给角色', skeleton.status === 200 && skeleton.data.mode === 'skeleton' && skeleton.data.roles.length >= 4, skeleton.data.mode)
  check('空场景被拒绝', (await call(routes, '/assist/team', { method: 'POST', body: { input: '' } })).status === 400, null)

  // 落库：把整组角色写进角色库（模拟面板确认）
  const beforeGroups = (await call(routes, '/state')).data
  const newGroup = { name: team.data.group.name, description: team.data.group.description }
  const teamRoles = team.data.roles.map((role) => ({ name: role.name, focus: role.focus, persona: role.persona, groupId: 'invest' }))
  const applied = await call(routes, '/library/apply', {
    method: 'POST',
    body: { groups: [...beforeGroups.groups, { id: 'invest', ...newGroup }], roles: [...beforeGroups.roles, ...teamRoles] },
  })
  check('整组角色一次落库', applied.status === 200 && applied.data.groups.length === beforeGroups.groups.length + 1, applied.data.groups?.length)
  check('落库后角色数增加了整组', applied.data.roles.length === beforeGroups.roles.length + teamRoles.length, applied.data.roles?.length)
  const libraryAfter = await call(routes, '/state')
  check('新组角色归属正确', libraryAfter.data.roles.filter((role) => role.groupId === 'invest').length === teamRoles.length, null)

  // ---- scoped revise: pick several roles, one instruction, preview then commit ----
  const investIds = libraryAfter.data.roles.filter((role) => role.groupId === 'invest').map((role) => role.id)
  const revise = await call(routes, '/assist/revise', {
    method: 'POST',
    body: { roleIds: investIds, groupIds: ['invest'], instruction: '这组人整体更保守一些，都要先问下行情形' },
  })
  check('范围改写返回每个选中角色', revise.status === 200 && revise.data.revised.length === investIds.length, revise.data.revised?.length)
  check('改写结果保留原 id', revise.data.revised.every((item) => investIds.includes(item.id)), revise.data.revised.map((r) => r.id))
  check('改写结果带前后对照', revise.data.revised.every((item) => item.before?.persona && item.persona !== item.before.persona), null)
  check('改写结果说明改了什么', revise.data.revised.every((item) => item.changed.length > 0), null)
  check('改写说明可见', revise.data.reply.length > 5, revise.data.reply)

  const noTargets = await call(routes, '/assist/revise', { method: 'POST', body: { roleIds: [], instruction: '改一下' } })
  check('没选角色时拒绝改写', noTargets.status === 409, noTargets.status)
  check('空指令被拒绝', (await call(routes, '/assist/revise', { method: 'POST', body: { roleIds: investIds, instruction: ' ' } })).status === 400, null)

  // 只落库被确认的那一个角色，其余保持不变
  const rolesBeforeCommit = libraryAfter.data.roles
  const confirmed = revise.data.revised[0]
  const commitRoles = rolesBeforeCommit.map((role) =>
    role.id === confirmed.id ? { ...role, name: confirmed.name === '保持不变' ? role.name : confirmed.name, focus: confirmed.focus === '不变' ? role.focus : confirmed.focus, persona: confirmed.persona } : role,
  )
  const committed = await call(routes, '/library/apply', { method: 'POST', body: { groups: libraryAfter.data.groups, roles: commitRoles } })
  check('改写结果可选择性落库', committed.status === 200 && committed.data.roles.find((role) => role.id === confirmed.id).persona === confirmed.persona, null)
  check('未确认的角色保持原样', committed.data.roles.filter((role) => role.groupId === 'invest' && role.id !== confirmed.id).every((role) => rolesBeforeCommit.find((old) => old.id === role.id).persona === role.persona), null)

  // ---- model selection: purpose-level, plus per-role override ----
  const modelState = await call(routes, '/state')
  check('/state 暴露三个用途与解析结果', modelState.data.models?.purposes?.length === 3, modelState.data.models?.purposes)
  check('未指定时回落到宿主默认模型', modelState.data.models?.resolved?.discuss?.provider === 'fake', modelState.data.models?.resolved?.discuss)

  const available = await call(routes, '/models')
  check('/models 列出可选的提供方与模型', Array.isArray(available.data.available) && available.data.available.length >= 1, available.data.available)

  const saved = await call(routes, '/models/save', {
    method: 'POST',
    body: { models: { discuss: { provider: 'fake', model: 'discuss-model' }, issueAssist: { provider: 'fake', model: 'issue-model' }, roleAssist: null } },
  })
  check('可按用途保存模型', saved.status === 200 && saved.data.models.discuss.model === 'discuss-model', saved.data.models)
  check('按用途解析生效', saved.data.resolved.discuss.model === 'discuss-model' && saved.data.resolved.issueAssist.model === 'issue-model', saved.data.resolved)
  check('未指定的用途回落到宿主默认', saved.data.resolved.roleAssist?.model === 'fake-1', saved.data.resolved.roleAssist)

  const scoped = await call(routes, '/library/apply', {
    method: 'POST',
    body: {
      groups: modelState.data.groups,
      roles: [
        ...modelState.data.roles.map((role) => (role.id === 'product' ? { ...role, model: { provider: 'fake', model: 'strong-model' } } : role)),
      ],
    },
  })
  check('角色可单独绑定模型', scoped.status === 200 && scoped.data.roles.find((role) => role.id === 'product')?.model?.model === 'strong-model', scoped.data.roles?.find((role) => role.id === 'product')?.model)
  check('其他角色不受影响', scoped.data.roles.find((role) => role.id === 'engineering')?.model === undefined, null)

  // 用带覆盖的角色跑一轮，确认发言走了角色模型
  const scopedIssue = await call(routes, '/issue/create', { method: 'POST', body: { title: '验证角色级模型选择的议题', roleIds: ['product', 'engineering'], plannedRounds: 1, research: false } })
  await call(routes, '/issue/start', { method: 'POST', body: { id: scopedIssue.data.issue.id } })
  const scopedRun = await waitIdle(routes, scopedIssue.data.issue.id)
  const productTurn = scopedRun.turns.find((turn) => turn.roleId === 'product')
  check('角色发言记录实际使用的模型', productTurn?.model?.model === 'strong-model', productTurn?.model)
  const engineeringTurn = scopedRun.turns.find((turn) => turn.roleId === 'engineering')
  check('无覆盖的角色走讨论用途模型', engineeringTurn?.model?.model === 'discuss-model', engineeringTurn?.model)

  const resetModels = await call(routes, '/models/save', { method: 'POST', body: { models: {} } })
  check('可清空用途模型回到宿主默认', resetModels.status === 200 && resetModels.data.models.discuss === null, resetModels.data.models)

  // ---- validation, list ordering, delete ----
  const badIssue = await call(routes, '/issue/create', { method: 'POST', body: { title: '短', roleIds: ['product', 'engineering'] } })
  check('过短标题被拒绝', badIssue.status === 400 && badIssue.data.error.includes('太短'), badIssue.data)

  const fewRoles = await call(routes, '/issue/create', { method: 'POST', body: { title: '只有一个角色的议题', roleIds: ['product'] } })
  check('少于 2 个角色被拒绝', fewRoles.status === 400 && fewRoles.data.error.includes('2 个角色'), fewRoles.data)

  const second = await call(routes, '/issue/create', { method: 'POST', body: { title: '另一个议题：要不要上自动化测试', roleIds: ['engineering', 'product'], plannedRounds: 3 } })
  const list = await call(routes, '/state')
  check('议题列表按创建时间倒序', list.data.issues[0].id === second.data.issue.id, list.data.issues.map((item) => item.title))
  check('列表项带摘要字段', list.data.issues.every((item) => typeof item.turnCount === 'number' && Array.isArray(item.participants)), list.data.issues[0])

  const deleted = await call(routes, '/issue/delete', { method: 'POST', body: { id: second.data.issue.id } })
  check('删除议题成功', deleted.status === 200 && deleted.data.deleted === true, deleted.data)
  check('删除后列表只剩自己创建的那些', (await call(routes, '/state')).data.issues.length >= 1, (await call(routes, '/state')).data.issues.length)

  check('未知议题返回 404', (await call(routes, '/issue?id=nope')).status === 404, null)

  const renamed = await call(routes, '/issue/update', { method: 'POST', body: { id: issueId, title: '改个标题' } })
  check('可修改空闲议题的标题', renamed.status === 200 && renamed.data.issue.title === '改个标题', renamed.data.issue?.title)

  // The engine persists issues after the response settles; give the last\n  // write a moment so the temp directory is not removed mid-write.\n  await new Promise((resolve) => setTimeout(resolve, 300))\n  await rm(root, { recursive: true, force: true }).catch(() => {})

  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  → ${JSON.stringify(item.detail)}`}`)
  console.log(`\n${checks.filter((item) => item.ok).length}/${checks.length} 项通过`)
  if (failures) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})








