// dsh-issue-roundtable — host half.
//
// Owns the roundtable's durable state and its debate engine:
//   - role groups + roles inside them (the role library the panel manages)
//   - an issue list; each issue is one roundtable meeting: a frozen participant
//     order, every turn ever spoken, the clerk's proposals, the votes and the
//     conclusion
//   - a model-backed engine that speaks rounds, can be told to continue past
//     the planned rounds, and then runs synthesis + vote
//   - AI assist for drafting an issue (multi-turn) and for designing a role
//
// Every turn is a real model call. The engine lives in the host process, so
// closing the panel or refreshing the page never kills a meeting.

import Schema from '@deepseek-ai/schemastery'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'issue-roundtable'
export const inject = ['connection']

export const Config = Schema.object({
  root: Schema.string().required(),
  researchMaxResults: Schema.natural().min(1).max(10).default(6),
  maxIssues: Schema.natural().default(200),
  transcriptChars: Schema.natural().default(14000),
})

const API = '/api/issue-roundtable'
const MAX_ROLES = 12
const MAX_ROUNDS = 8
const MAX_PARTICIPANTS = 8
const DEFAULT_GROUP = 'core'

const now = () => new Date().toISOString()

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const clampText = (value, max) => {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const asId = (value, fallback) => {
  const safe = (typeof value === 'string' ? value.trim() : '').replace(/[^a-zA-Z0-9_-]/g, '')
  return safe || fallback
}

const uniqueId = (taken, wanted, fallback) => {
  const base = asId(wanted, fallback)
  let id = base
  let n = 1
  while (taken.has(id)) id = `${base}-${++n}`
  return id
}

// ---------------------------------------------------------------- defaults

export function defaultGroups() {
  return [
    { id: DEFAULT_GROUP, name: '核心决策', description: '产品 / 技术 / 财务这类常规决策角色' },
    { id: 'risk', name: '风险与合规', description: '法务、安全、合规视角' },
    { id: 'customer', name: '客户与一线', description: '真实使用与一线执行视角' },
  ]
}

export function defaultRoles() {
  return [
    {
      id: 'product',
      groupId: DEFAULT_GROUP,
      name: '产品经理',
      focus: '用户价值与需求',
      persona:
        '你从用户和产品价值出发考虑问题。你关心这件事解决了谁的什么问题、体验是否成立、节奏和取舍是否清晰。' +
        '你不喜欢为了技术完美牺牲用户可感知的收益，也不接受没有依据的需求想象。表达直接，习惯用一个具体的用户场景说明观点。',
    },
    {
      id: 'engineering',
      groupId: DEFAULT_GROUP,
      name: '技术负责人',
      focus: '可行性与长期成本',
      persona:
        '你判断技术可行性与长期维护成本：实现路径、依赖、性能上限、可回滚性和迭代空间，并主动指出别人方案里被低估的复杂度。' +
        '你愿意为方案找替代实现，但拒绝「先上再补」的空头承诺；估算会标清是估算还是实测。',
    },
    {
      id: 'finance',
      groupId: DEFAULT_GROUP,
      name: '财务负责人',
      focus: '预算与投入产出',
      persona:
        '你只关心钱从哪来、花多少、多久看到回报。你要求把成本拆成一次性投入和持续成本，把收益说成可核对的数字或明确假设。' +
        '你对模糊的「长期价值」天然怀疑，但接受有条件投入：先小额验证再追加。',
    },
    {
      id: 'legal',
      groupId: 'risk',
      name: '法务顾问',
      focus: '合规与责任边界',
      persona:
        '你盯住合规红线与责任归属：数据、资质、合同、对外承诺。你会把「能不能做」拆成「在什么前提下能做」，' +
        '并要求把不可越过的边界写进方案，而不是留到最后再补。',
    },
    {
      id: 'user',
      groupId: 'customer',
      name: '用户代表',
      focus: '真实使用体验',
      persona:
        '你代表真实使用者的感受和操作习惯：用户实际会怎么用、在哪一步卡住、会不会放弃。' +
        '你反对把复杂流程推给用户的方案，不讲技术和财务，只讲使用现场。',
    },
  ]
}

// --------------------------------------------------------------- validation

export function normalizeGroups(input) {
  if (!Array.isArray(input)) throw new HttpError('分组列表格式不正确。')
  const groups = []
  const taken = new Set()
  for (const raw of input.slice(0, 40)) {
    const name = clampText(typeof raw?.name === 'string' ? raw.name.trim() : '', 40).trim()
    if (!name) continue
    const id = uniqueId(taken, raw?.id, `group-${groups.length + 1}`)
    taken.add(id)
    groups.push({ id, name, description: clampText(typeof raw?.description === 'string' ? raw.description.trim() : '', 200).trim() })
  }
  if (!groups.length) throw new HttpError('至少保留一个角色分组。')
  return groups
}

export function normalizeRoles(input, groups) {
  if (!Array.isArray(input)) throw new HttpError('角色列表格式不正确。')
  if (input.length > MAX_ROLES) throw new HttpError(`角色库最多 ${MAX_ROLES} 个角色。`)
  const groupIds = new Set(groups.map((group) => group.id))
  const roles = []
  const taken = new Set()
  for (const [index, raw] of input.entries()) {
    const name = clampText(typeof raw?.name === 'string' ? raw.name.trim() : '', 40).trim()
    if (!name) throw new HttpError(`第 ${index + 1} 个角色缺少名称。`)
    const persona = clampText(typeof raw?.persona === 'string' ? raw.persona.trim() : '', 1400).trim()
    if (persona.length < 20) throw new HttpError(`角色「${name}」的立场描述太短，请至少写 20 个字。`)
    const id = uniqueId(taken, raw?.id, `role-${index + 1}`)
    taken.add(id)
    roles.push({
      id,
      name,
      focus: clampText(typeof raw?.focus === 'string' ? raw.focus.trim() : '', 60).trim(),
      persona,
      groupId: groupIds.has(raw?.groupId) ? raw.groupId : groups[0].id,
    })
  }
  return roles
}

/** Pull the first balanced JSON object out of a model reply (tolerates fences). */
export function extractJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const slice = source.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          try {
            return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
          } catch {
            return null
          }
        }
      }
    }
  }
  return null
}

export function normalizeProposals(input) {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F']
  const list = Array.isArray(input) ? input : []
  const proposals = []
  for (const raw of list.slice(0, letters.length)) {
    if (!raw || typeof raw !== 'object') continue
    const title = clampText(typeof raw.title === 'string' ? raw.title.trim() : '', 40).trim()
    if (!title) continue
    proposals.push({
      id: letters[proposals.length],
      title,
      summary: clampText(typeof raw.summary === 'string' ? raw.summary.trim() : '', 900).trim(),
      keyPoints: Array.isArray(raw.keyPoints)
        ? raw.keyPoints.map((point) => clampText(typeof point === 'string' ? point.trim() : '', 160)).filter(Boolean).slice(0, 6)
        : [],
      tradeoffs: clampText(typeof raw.tradeoffs === 'string' ? raw.tradeoffs.trim() : '', 400).trim(),
    })
  }
  return proposals
}

// ------------------------------------------------------------------ storage

function createStore(root) {
  let ready
  const ensure = async () => {
    if (!ready) ready = mkdir(root, { recursive: true }).catch(() => {})
    await ready
  }
  const readJson = async (file, fallback) => {
    try {
      return JSON.parse(await readFile(join(root, file), 'utf8'))
    } catch {
      return fallback
    }
  }
  const writeJson = async (file, value) => {
    await ensure()
    const path = join(root, file)
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }
  return {
    async load(maxIssues) {
      const groups = await readJson('groups.json', null)
      const roles = await readJson('roles.json', null)
      const issues = await readJson('issues.json', null)
      return {
        groups,
        roles,
        issues: Array.isArray(issues) ? issues.filter((item) => item && typeof item.id === 'string').slice(0, maxIssues) : [],
      }
    },
    saveGroups: (groups) => writeJson('groups.json', groups),
    saveRoles: (roles) => writeJson('roles.json', roles),
    saveIssues: (issues) => writeJson('issues.json', issues),
  }
}

// ------------------------------------------------------------- model calls

function resolveSelection(ctx, fallback) {
  if (fallback?.provider && fallback?.model) return fallback
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
  throw new HttpError('还没有可用的模型：请先在设置里选择一个默认模型。', 409)
}

async function callModel(ctx, options) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new HttpError('模型服务不可用（llm 服务未加载）。', 503)
  const target = resolveSelection(ctx, options.fallback)
  const request = {
    provider: target.provider,
    model: target.model,
    system: options.system,
    messages: options.messages ?? [{ role: 'user', content: [{ type: 'text', text: options.user ?? '' }] }],
  }
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens
  if (options.temperature !== undefined) request.temperature = options.temperature
  if (options.signal !== undefined) request.signal = options.signal
  let text = ''
  const usage = { inputTokens: 0, outputTokens: 0 }
  for await (const chunk of llm.stream(request)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') {
      usage.inputTokens += chunk.usage?.inputTokens ?? 0
      usage.outputTokens += chunk.usage?.outputTokens ?? 0
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const message = chunk.reason?.failure?.message ?? '模型调用失败'
        const code = chunk.reason?.failure?.code
        throw new HttpError(`模型调用${kind === 'aborted' ? '被中断' : '失败'}${code ? `（${code}）` : ''}：${message}`, kind === 'aborted' ? 409 : 502)
      }
    }
  }
  return { text: text.trim(), usage }
}

async function research(ctx, query, maxResults, signal) {
  const web = ctx.get('web')
  if (web === undefined) return { available: false, note: '当前环境没有联网检索能力，讨论只依据模型已有知识。', sources: [] }
  const sources = []
  const failures = []
  for (const q of [query, `${query} 风险 争议`]) {
    try {
      const result = await web.search({ query: q, maxResults }, signal)
      for (const source of result?.sources ?? []) {
        if (!source?.url || sources.some((item) => item.url === source.url)) continue
        sources.push({ url: source.url, title: clampText(source.title ?? source.url, 160), snippet: clampText(source.snippet ?? '', 400) })
      }
    } catch (error) {
      failures.push(clampText(error instanceof Error ? error.message : String(error), 200))
    }
  }
  if (!sources.length) {
    return { available: false, note: `联网检索未返回资料${failures.length ? `：${failures[0]}` : ''}。讨论只依据模型已有知识。`, sources: [] }
  }
  return { available: true, note: failures.length ? `部分检索失败：${failures[0]}` : `已检索到 ${sources.length} 条资料。`, sources: sources.slice(0, 12) }
}

// ------------------------------------------------------------------ prompts

function material(issue) {
  if (!issue.research?.sources?.length) return '（没有联网资料，请基于已有知识和明确标注的假设发言。）'
  return issue.research.sources
    .map((source, index) => `[${index + 1}] ${source.title} — ${source.url}${source.snippet ? `\n    ${source.snippet}` : ''}`)
    .join('\n')
}

function transcriptText(issue, limit) {
  if (!issue.turns.length) return '（还没有人发言，你是第一个。）'
  const text = issue.turns
    .map((turn) => (turn.error ? `第${turn.round}轮 · ${turn.roleName}：（这次发言失败）` : `第${turn.round}轮 · ${turn.roleName}：${turn.text}`))
    .join('\n\n')
  if (text.length <= limit) return text
  return `（更早的发言已省略，以下是最近的部分）\n\n${text.slice(text.length - limit)}`
}

function turnTask(round, plannedRounds, continued) {
  // Every round of a continued run is an append round: the plan already grew,
  // so the round numbers alone cannot tell them apart.
  if (continued) {
    return '这是追加讨论：只解决之前还没定的分歧点，不要重复已经达成一致的内容；如果已无新分歧，直接给出最终条件。'
  }
  if (round <= 1) return '先指出议题的关键分歧在哪，再给出你的立论（判断 + 理由 + 关键风险）。'
  if (round === 2) return '回应前面发言里最强的反对意见：说明你接受什么、反对什么，并修正你上一轮说得不够准确的地方。'
  if (round >= plannedRounds) return '收敛：给出你愿意支持的方案要点、必须满足的条件，以及你可以让步的部分。'
  return '推进：补充前面都没覆盖的证据或角度，并指出分歧已经缩小到哪里。'
}

function roleSystem(role) {
  return [
    `你正在参加一场多人圆桌会议，你的身份是「${role.name}」。`,
    `你的立场与人设：${role.persona}`,
    role.focus ? `你重点盯住：${role.focus}。` : '',
    '发言规则：',
    '1. 直接输出发言正文，不要写「角色名：」这类前缀，也不要复述或解释这些规则。',
    '2. 每次 200~450 字，观点必须具体：判断、理由（能给数字就给数字或明确假设）、关键风险或前提条件。',
    '3. 必须读到并回应其他人已经说过的内容，点名你同意或反对的具体观点。',
    '4. 不要重复自己说过的内容；每一轮都要推进讨论，而不是重新表态。',
    '5. 不确定的数据标注为估算或假设，不要编造精确来源。',
    '6. 你没有工具可用，只输出文字。',
  ]
    .filter(Boolean)
    .join('\n')
}

function voteSystem(role) {
  return [
    `你是「${role.name}」${role.focus ? `，重点盯住${role.focus}` : ''}，现在要用一票决定圆桌的最终方案。`,
    `你的立场与人设：${role.persona}`,
    '你只输出一个 JSON 对象，不要输出任何其它文字、解释或代码块标记。',
  ].join('\n')
}

const ISSUE_ASSIST_SYSTEM = [
  '你是圆桌会议的议题顾问，帮用户把模糊的想法写成一份可以直接开始讨论的议题。',
  '你的每一次回复都必须是一个 JSON 对象，不要输出任何其它文字或代码块标记：',
  '{"reply":"给对方看的话（可以提问、可以指出漏洞，1~4句）","ready":true|false,"draft":{"title":"不超过24字的核心问题","background":"为什么要讨论、现状与约束","goal":"希望圆桌产出什么（要可判断）","checklist":["需要澄清或已确认的要点"]}}',
  '规则：',
  '1. 信息不足时 ready=false，用 reply 追问最关键的一个问题（一次只问一个）。',
  '2. 信息足够时 ready=true，draft 要完整、具体、有边界：title 必须是一个可被赞成或反对的问题句，不是主题词。',
  '3. draft 永远给全量内容（每次都重新写出完整版本），不要只给改动。',
  '4. 主动补上用户没说的约束（预算、时间、成功标准），并标注哪些是「待确认假设」。',
  '5. checklist 用短句，标出仍需用户确认的点。',
].join('\n')

const ROLE_ASSIST_SYSTEM = [
  '你是圆桌会议的角色设计师，负责把用户的描述变成一个立场鲜明的发言角色。',
  '你只输出一个 JSON 对象，不要输出任何其它文字或代码块标记：',
  '{"suggestions":[{"name":"角色名（2~8字）","focus":"关注点什么（不超过12字）","persona":"立场与说话方式，120~200字，写清它站在谁那边、最在意什么、怎么反驳别人","tags":["标签"]}]}',
  '给出 2 到 3 个差异明显的候选：视角不同、而不是同一个人的不同措辞。persona 用第二人称「你」来写，并且要能直接驱动发言。',
].join('\n')

const TEAM_ASSIST_SYSTEM = [
  '你是圆桌会议的角色团队设计器：用户描述一个决策场景，你要给出一个可用的角色分组和该组的全部角色。',
  '你只输出一个 JSON 对象，不要输出任何其它文字或代码块标记：',
  '{"group":{"name":"分组名（2~8字）","description":"这个组负责哪类决策（不超过40字）"},',
  '"reply":"给对方看的说明（1~3句：为什么是这几个视角、覆盖了什么、还缺什么）",',
  '"roles":[{"name":"角色名（2~8字）","focus":"关注点（不超过12字）","persona":"立场与说话方式，120~200字，第二人称「你」，写清站在谁那边、最在意什么、怎么反驳别人","tags":["标签"]}]}',
  '规则：',
  '1. 角色 4~6 个，视角必须真正互补（例如投研场景：宏观、行业、公司基本面、估值/量化、风控），不要同一视角换措辞。',
  '2. 每个 persona 都要能直接驱动发言，避免「你需要关注XXX」这种空话，要写清它怎么说话、会怎么反驳。',
  '3. 用户指定的必须遵守；用户没说的，按这个场景的常规决策结构补齐，并在 reply 里说明你补了什么。',
].join('\n')

const TEAM_REVISE_SYSTEM = [
  '你是圆桌会议的角色团队编辑器：用户选中了若干角色并给了一句修改要求，你要逐个给出改写后的人设。',
  '你只输出一个 JSON 对象，不要输出任何其它文字或代码块标记：',
  '{"reply":"给对方看的说明（1~2句：你改了什么、为什么）",',
  '"roles":[{"id":"原角色 id（原样返回）","name":"角色名","focus":"关注点","persona":"改写后的完整人设","changed":"一句话说明这一处怎么改了"}]}',
  '规则：',
  '1. 每个输入角色都必须返回一条，id 原样保留，不要新增或删除角色。',
  '2. 尊重每个角色原有的视角分工：只在用户要求的维度上改写，不要把所有角色改成一个风格。',
  '3. persona 给完整全文（不是增量），保持 120~200 字、第二人称「你」。',
  '4. 如果用户的要求和角色定位冲突，在 reply 里指出，并按最接近用户意图的方式改写。',
].join('\n')

// ------------------------------------------------------------------- engine

function tallyOf(proposals, votes) {
  const counts = {}
  const voters = {}
  for (const proposal of proposals) {
    counts[proposal.id] = 0
    voters[proposal.id] = []
  }
  let abstain = 0
  for (const vote of votes) {
    if (!vote.proposalId || vote.abstain || !(vote.proposalId in counts)) {
      abstain += 1
      continue
    }
    counts[vote.proposalId] += 1
    voters[vote.proposalId].push(vote.roleName)
  }
  const max = Math.max(0, ...Object.values(counts))
  const tiedIds = Object.keys(counts).filter((id) => counts[id] === max)
  return { counts, voters, abstain, winnerId: tiedIds[0], tie: tiedIds.length > 1, tiedIds }
}

export function apply(ctx, config) {
  const store = createStore(config.root)
  const controllers = new Map()
  let state = { groups: defaultGroups(), roles: defaultRoles(), issues: [] }
  let loaded = null

  async function loadState() {
    if (!loaded) {
      loaded = store.load(config.maxIssues).then((stored) => {
        let groups
        try {
          groups = stored.groups ? normalizeGroups(stored.groups) : defaultGroups()
        } catch {
          groups = defaultGroups()
        }
        let roles
        try {
          roles = stored.roles ? normalizeRoles(stored.roles, groups) : defaultRoles().filter((role) => groups.some((group) => group.id === role.groupId))
        } catch {
          roles = defaultRoles()
        }
        if (!roles.length) roles = defaultRoles()
        state = { groups, roles, issues: stored.issues }
        return state
      })
    }
    return loaded
  }

  const saveIssues = () => store.saveIssues(state.issues)
  const findIssue = (id) => state.issues.find((issue) => issue.id === id)

  function issueSummary(issue) {
    return {
      id: issue.id,
      title: issue.title,
      goal: issue.goal,
      status: issue.status,
      round: issue.round,
      plannedRounds: issue.plannedRounds,
      turnCount: issue.turns.length,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      participants: issue.participants.map((role) => ({ id: role.roleId, name: role.name, focus: role.focus })),
      conclusionTitle: issue.conclusion?.title ?? '',
      conclusionStale: Boolean(issue.conclusion?.stale),
    }
  }

  // ---- the debate engine: speak `count` more rounds, then stop for review -----

  async function runRounds(issue, count, { continued }) {
    const controller = new AbortController()
    controllers.set(issue.id, controller)
    const signal = controller.signal
    const checkpoint = () => {
      if (signal.aborted) throw new HttpError('讨论已取消。', 409)
    }
    issue.status = 'running'
    issue.stage = 'debate'
    issue.error = ''
    issue.updatedAt = now()
    await saveIssues()
    try {
      if (!issue.research && issue.researchEnabled) {
        issue.stage = 'research'
        await saveIssues()
        try {
          issue.research = await research(ctx, issue.title, config.researchMaxResults, signal)
        } catch (error) {
          issue.research = { available: false, note: `资料检索失败：${clampText(error instanceof Error ? error.message : String(error), 200)}`, sources: [] }
        }
      }
      checkpoint()
      issue.stage = 'debate'
      for (let index = 0; index < count; index += 1) {
        issue.round += 1
        issue.updatedAt = now()
        await saveIssues()
        for (const role of issue.participants) {
          checkpoint()
          issue.speaking = { round: issue.round, roleId: role.roleId, roleName: role.name, startedAt: now() }
          issue.updatedAt = now()
          let turn
          try {
            const result = await callModel(ctx, {
              fallback: issue.model,
              system: roleSystem(role),
              user: [
                `【议题】${issue.title}`,
                issue.background ? `【背景】\n${issue.background}` : '',
                issue.goal ? `【希望产出】${issue.goal}` : '',
                `【背景资料】\n${material(issue)}`,
                `【已有发言】\n${transcriptText(issue, config.transcriptChars)}`,
                `【本轮任务】第 ${issue.round} 轮（计划 ${issue.plannedRounds} 轮）\n${turnTask(issue.round, issue.plannedRounds, continued)}`,
              ]
                .filter(Boolean)
                .join('\n\n'),
              maxTokens: 900,
              temperature: 0.6,
              signal,
            })
            turn = {
              round: issue.round,
              roleId: role.roleId,
              roleName: role.name,
              focus: role.focus,
              text: result.text || '（这次没有产生可读的发言。）',
              at: now(),
            }
            issue.usage.push(result.usage)
          } catch (error) {
            if (signal.aborted) throw error
            turn = {
              round: issue.round,
              roleId: role.roleId,
              roleName: role.name,
              focus: role.focus,
              text: '',
              at: now(),
              error: clampText(error instanceof Error ? error.message : String(error), 400),
            }
          }
          issue.turns.push(turn)
          issue.speaking = null
          issue.updatedAt = now()
          await saveIssues()
        }
      }
      issue.stage = 'idle'
      issue.status = 'discussing'
      if (issue.conclusion) issue.conclusion.stale = true
      issue.updatedAt = now()
      await saveIssues()
    } catch (error) {
      issue.speaking = null
      const cancelled = signal.aborted
      issue.status = cancelled ? 'cancelled' : 'failed'
      issue.stage = 'idle'
      issue.error = cancelled ? '讨论已取消。' : clampText(error instanceof Error ? error.message : String(error), 600)
      await saveIssues()
    } finally {
      controllers.delete(issue.id)
    }
  }

  async function synthesize(issue, signal) {
    const prompt = [
      `【议题】${issue.title}`,
      issue.background ? `【背景】\n${issue.background}` : '',
      issue.goal ? `【希望产出】${issue.goal}` : '',
      `【讨论全文】\n${transcriptText(issue, config.transcriptChars)}`,
      '【任务】',
      '把这场讨论收敛成 2 到 4 个互不相同的候选方案，用来进行全体表决。要求：',
      '- 不是把各人的立场照抄一遍，而是能直接拿去决策的完整方案：做什么、怎么做、代价、收益、前提。',
      '- 方案之间必须真有取舍差别；如果讨论其实只剩一个方向，就给出「激进版 / 稳健版」这类可比较的版本。',
      '只输出一个 JSON 对象，不要输出任何其它文字或代码块标记。',
      'JSON 格式：',
      '{"proposals":[{"title":"不超过20字","summary":"3~5句：做什么、怎么做、代价与收益","keyPoints":["要点"],"tradeoffs":"主要取舍"}],"recommendedId":"A","openQuestions":["还没解决的关键问题"]}',
    ]
      .filter(Boolean)
      .join('\n\n')
    let parsed = null
    for (let attempt = 0; attempt < 2 && parsed === null; attempt += 1) {
      try {
        const result = await callModel(ctx, {
          fallback: issue.model,
          system: '你是圆桌讨论的书记员，负责把讨论收敛成可表决的候选方案。你只输出一个 JSON 对象。',
          user: prompt,
          maxTokens: 1200,
          temperature: 0.2,
          signal,
        })
        issue.usage.push(result.usage)
        parsed = extractJson(result.text)
      } catch (error) {
        if (signal.aborted) throw error
        if (attempt === 1) throw error
      }
    }
    const proposals = normalizeProposals(parsed?.proposals)
    if (proposals.length >= 2) {
      const recommended = String(parsed?.recommendedId ?? '').trim().toUpperCase()
      return {
        proposals,
        recommendedId: proposals.some((proposal) => proposal.id === recommended) ? recommended : proposals[0].id,
        openQuestions: Array.isArray(parsed?.openQuestions)
          ? parsed.openQuestions.map((item) => clampText(typeof item === 'string' ? item : '', 300)).filter(Boolean).slice(0, 6)
          : [],
      }
    }
    const fallback = normalizeProposals(
      issue.participants.slice(0, 4).map((role) => {
        const last = [...issue.turns].reverse().find((turn) => turn.roleId === role.roleId && !turn.error && turn.text)
        return { title: `${role.name}的主张`, summary: clampText(last?.text || `${role.name}没有留下有效发言。`, 700) }
      }),
    )
    return {
      proposals: fallback,
      recommendedId: fallback[0]?.id,
      openQuestions: ['书记员没能按格式收敛方案，下面按各角色最后的主张直接表决。'],
    }
  }

  async function collectVotes(issue, proposals, label, runoff, signal) {
    const ballot = proposals
      .map((proposal) => `${proposal.id}. ${proposal.title}\n    方案：${proposal.summary}${proposal.tradeoffs ? `\n    取舍：${proposal.tradeoffs}` : ''}`)
      .join('\n')
    return Promise.all(
      issue.participants.map(async (role) => {
        const base = { roleId: role.roleId, roleName: role.name, label, runoff, proposalId: null, reason: '', abstain: false, at: now() }
        if (signal.aborted) return { ...base, abstain: true, reason: '讨论已取消。' }
        const last = [...issue.turns].reverse().find((turn) => turn.roleId === role.roleId && !turn.error && turn.text)
        try {
          const result = await callModel(ctx, {
            fallback: issue.model,
            system: voteSystem(role),
            user: [
              `【议题】${issue.title}`,
              `【候选方案】\n${ballot}`,
              `【你在讨论中的最后发言】\n${clampText(last?.text || '（你没有留下发言）', 900)}`,
              `【任务】\n这是${label}。选出你认为最该落地的方案；reason 用 1~2 句说明基于方案本身的判断依据。`,
              '只输出：{"proposalId":"A","reason":"..."}',
            ].join('\n\n'),
            maxTokens: 400,
            temperature: 0.2,
            signal,
          })
          issue.usage.push(result.usage)
          const parsed = extractJson(result.text) ?? {}
          const wanted = String(parsed.proposalId ?? parsed.proposal_id ?? parsed.id ?? '').trim().toUpperCase()
          const hit = proposals.find((proposal) => proposal.id === wanted)
          if (!hit) return { ...base, abstain: true, reason: `投票格式无法识别：${clampText(result.text, 200)}` }
          return { ...base, proposalId: hit.id, reason: clampText(parsed.reason ?? parsed.rationale ?? '', 500) || '未给出理由。' }
        } catch (error) {
          return { ...base, abstain: true, reason: `投票失败：${clampText(error instanceof Error ? error.message : String(error), 200)}` }
        }
      }),
    )
  }

  async function vote(issue) {
    const controller = new AbortController()
    controllers.set(issue.id, controller)
    const signal = controller.signal
    issue.status = 'voting'
    issue.stage = 'synthesis'
    issue.error = ''
    issue.updatedAt = now()
    await saveIssues()
    try {
      const clerk = await synthesize(issue, signal)
      issue.proposals = clerk.proposals
      issue.recommendedId = clerk.recommendedId
      issue.openQuestions = clerk.openQuestions
      issue.stage = 'vote'
      issue.updatedAt = now()
      await saveIssues()
      issue.votes = await collectVotes(issue, issue.proposals, '表决', false, signal)
      issue.runoffVotes = []
      let tally = tallyOf(issue.proposals, issue.votes)
      if (tally.tie && tally.tiedIds.length > 1) {
        issue.stage = 'runoff'
        const tied = issue.proposals.filter((proposal) => tally.tiedIds.includes(proposal.id))
        issue.runoffVotes = await collectVotes(issue, tied, '平票复选', true, signal)
        const runoffTally = tallyOf(tied, issue.runoffVotes)
        if (!runoffTally.tie && runoffTally.counts[runoffTally.winnerId] > 0) {
          tally = { ...runoffTally, runoff: true }
        } else {
          const chosen = tied.find((proposal) => proposal.id === clerk.recommendedId) ?? tied[0]
          tally = { ...runoffTally, tie: true, tieBrokenBy: 'clerk', winnerId: chosen.id, tiedIds: runoffTally.tiedIds }
        }
      }
      issue.tally = tally
      const winner = issue.proposals.find((proposal) => proposal.id === tally.winnerId) ?? issue.proposals[0]
      issue.conclusion = {
        proposalId: winner.id,
        title: winner.title,
        summary: winner.summary,
        keyPoints: winner.keyPoints,
        tradeoffs: winner.tradeoffs,
        counts: tally.counts,
        voters: tally.voters,
        abstain: tally.abstain,
        dissent: issue.votes
          .filter((item) => item.proposalId && item.proposalId !== winner.id)
          .map((item) => ({ roleName: item.roleName, proposalId: item.proposalId, reason: item.reason })),
        openQuestions: clerk.openQuestions,
        decidedAt: now(),
        stale: false,
        note:
          tally.tieBrokenBy === 'clerk'
            ? '复选后仍然平票，按书记员的推荐意见裁定。'
            : tally.runoff
              ? '首轮平票，经一轮复选后产生结论。'
              : '按多数票产生结论。',
      }
      issue.status = 'decided'
      issue.stage = 'idle'
      issue.updatedAt = now()
      await saveIssues()
    } catch (error) {
      issue.status = 'failed'
      issue.stage = 'idle'
      issue.error = clampText(error instanceof Error ? error.message : String(error), 600)
      await saveIssues()
    } finally {
      controllers.delete(issue.id)
    }
  }

  // ------------------------------------------------------------------ routes

  const respond = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

  const guarded = (fn) => async (request) => {
    try {
      return await fn(request)
    } catch (error) {
      if (!(error instanceof HttpError)) ctx.logger?.warn?.(error)
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof HttpError ? error.message : `圆桌内部错误：${error instanceof Error ? error.message : String(error)}`
      return respond({ error: message }, status)
    }
  }

  const route = (path, methods, fn) => {
    ctx.connection.fetch.register({ path: `${API}${path}`, methods, requestBody: 'buffered', fetch: guarded(fn) })
  }

  const readBody = (request) =>
    request.json().catch(() => {
      throw new HttpError('请求内容不是合法 JSON。')
    })

  const requireIssue = async (request, body) => {
    await loadState()
    const id = typeof body?.id === 'string' ? body.id : new URL(request.url).searchParams.get('id') ?? ''
    const issue = findIssue(id)
    if (!issue) throw new HttpError('找不到这个议题。', 404)
    return issue
  }

  route('/state', ['GET'], async () => {
    await loadState()
    let model = null
    try {
      model = resolveSelection(ctx)
    } catch {
      model = null
    }
    return respond({
      groups: state.groups,
      roles: state.roles,
      issues: state.issues.map(issueSummary),
      model,
      runningIssueId: [...controllers.keys()][0] ?? null,
      limits: { maxRoles: MAX_ROLES, maxRounds: MAX_ROUNDS, maxParticipants: MAX_PARTICIPANTS },
    })
  })

  route('/library', ['POST'], async (request) => {
    await loadState()
    const body = await readBody(request)
    const groups = normalizeGroups(body?.groups ?? state.groups)
    const roles = normalizeRoles(body?.roles ?? state.roles, groups)
    state.groups = groups
    state.roles = roles
    await store.saveGroups(groups)
    await store.saveRoles(roles)
    return respond({ groups, roles })
  })

  route('/issue', ['GET'], async (request) => {
    const issue = await requireIssue(request)
    return respond({ issue, summary: issueSummary(issue) })
  })

  route('/issue/create', ['POST'], async (request) => {
    await loadState()
    const body = await readBody(request)
    const title = clampText(typeof body?.title === 'string' ? body.title.trim() : '', 200).trim()
    if (title.length < 4) throw new HttpError('议题标题太短，至少写 4 个字。')
    const roleIds = Array.isArray(body?.roleIds) ? body.roleIds.filter((id) => typeof id === 'string') : []
    const participants = roleIds
      .map((id) => state.roles.find((role) => role.id === id))
      .filter(Boolean)
      .slice(0, MAX_PARTICIPANTS)
      .map((role) => ({ roleId: role.id, name: role.name, focus: role.focus, persona: role.persona, groupId: role.groupId }))
    if (participants.length < 2) throw new HttpError('至少选择 2 个角色参与讨论。')
    const plannedRounds = Number(body?.plannedRounds ?? 3)
    if (!Number.isInteger(plannedRounds) || plannedRounds < 1 || plannedRounds > MAX_ROUNDS) {
      throw new HttpError(`轮数需要在 1 到 ${MAX_ROUNDS} 之间。`)
    }
    let model
    try {
      model = resolveSelection(ctx)
    } catch (error) {
      throw new HttpError(error instanceof Error ? error.message : String(error), 409)
    }
    const issue = {
      id: uniqueId(new Set(state.issues.map((item) => item.id)), body?.id, `issue-${Date.now().toString(36)}`),
      title,
      background: clampText(typeof body?.background === 'string' ? body.background.trim() : '', 2000).trim(),
      goal: clampText(typeof body?.goal === 'string' ? body.goal.trim() : '', 600).trim(),
      checklist: Array.isArray(body?.checklist)
        ? body.checklist.map((item) => clampText(typeof item === 'string' ? item : '', 200)).filter(Boolean).slice(0, 12)
        : [],
      participants,
      plannedRounds,
      researchEnabled: body?.research !== false,
      research: null,
      turns: [],
      round: 0,
      status: 'draft',
      stage: 'idle',
      speaking: null,
      proposals: [],
      votes: [],
      runoffVotes: [],
      tally: null,
      conclusion: null,
      openQuestions: [],
      recommendedId: null,
      usage: [],
      error: '',
      model,
      createdAt: now(),
      updatedAt: now(),
    }
    state.issues.unshift(issue)
    state.issues = state.issues.slice(0, config.maxIssues)
    await saveIssues()
    return respond({ issue, summary: issueSummary(issue) })
  })

  route('/issue/update', ['POST'], async (request) => {
    const body = await readBody(request)
    const issue = await requireIssue(request, body)
    if (issue.status === 'running' || issue.status === 'voting') throw new HttpError('讨论进行中，不能修改议题。', 409)
    if (typeof body?.title === 'string') {
      const title = clampText(body.title.trim(), 200).trim()
      if (title.length < 4) throw new HttpError('议题标题太短，至少写 4 个字。')
      issue.title = title
    }
    if (typeof body?.background === 'string') issue.background = clampText(body.background.trim(), 2000).trim()
    if (typeof body?.goal === 'string') issue.goal = clampText(body.goal.trim(), 600).trim()
    if (Array.isArray(body?.checklist)) {
      issue.checklist = body.checklist.map((item) => clampText(typeof item === 'string' ? item : '', 200)).filter(Boolean).slice(0, 12)
    }
    issue.updatedAt = now()
    await saveIssues()
    return respond({ issue, summary: issueSummary(issue) })
  })

  route('/issue/start', ['POST'], async (request) => {
    const body = await readBody(request)
    const issue = await requireIssue(request, body)
    if (controllers.has(issue.id)) throw new HttpError('这场讨论正在进行中。', 409)
    if (issue.turns.length) throw new HttpError('这场讨论已经开始过了，请用「继续讨论」。', 409)
    const rounds = Number(body?.rounds ?? issue.plannedRounds) || issue.plannedRounds
    void runRounds(issue, rounds, { continued: false })
    return respond({ issue: issueView(issue), summary: issueSummary(issue) })
  })

  route('/issue/continue', ['POST'], async (request) => {
    const body = await readBody(request)
    const issue = await requireIssue(request, body)
    if (controllers.has(issue.id)) throw new HttpError('这场讨论正在进行中。', 409)
    if (!issue.turns.length) throw new HttpError('还没有任何发言，请先开始讨论。', 409)
    const rounds = Number(body?.rounds ?? 2)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new HttpError(`追加轮数需要在 1 到 ${MAX_ROUNDS} 之间。`)
    issue.plannedRounds += rounds
    issue.conclusion = issue.conclusion ? { ...issue.conclusion, stale: true } : null
    void runRounds(issue, rounds, { continued: true })
    return respond({ issue: issueView(issue), summary: issueSummary(issue) })
  })

  route('/issue/vote', ['POST'], async (request) => {
    const body = await readBody(request)
    const issue = await requireIssue(request, body)
    if (controllers.has(issue.id)) throw new HttpError('这场讨论正在进行中。', 409)
    if (!issue.turns.some((turn) => !turn.error && turn.text)) throw new HttpError('还没有有效发言，无法表决。', 409)
    void vote(issue)
    return respond({ issue: issueView(issue), summary: issueSummary(issue) })
  })

  route('/issue/cancel', ['POST'], async (request) => {
    const issue = await requireIssue(request, await readBody(request))
    controllers.get(issue.id)?.abort()
    return respond({ cancelled: true })
  })

  route('/issue/delete', ['POST'], async (request) => {
    const body = await readBody(request)
    await loadState()
    const id = typeof body?.id === 'string' ? body.id : ''
    controllers.get(id)?.abort()
    const size = state.issues.length
    state.issues = state.issues.filter((issue) => issue.id !== id)
    if (state.issues.length !== size) await saveIssues()
    return respond({ deleted: state.issues.length !== size })
  })

  route('/issue/clear-conclusion', ['POST'], async (request) => {
    const body = await readBody(request)
    const issue = await requireIssue(request, body)
    if (controllers.has(issue.id)) throw new HttpError('讨论进行中，不能清除结论。', 409)
    issue.conclusion = null
    issue.tally = null
    issue.votes = []
    issue.runoffVotes = []
    issue.proposals = []
    issue.status = issue.turns.length ? 'discussing' : 'draft'
    issue.updatedAt = now()
    await saveIssues()
    return respond({ issue, summary: issueSummary(issue) })
  })

  // ---- AI assists: issue drafting (multi-turn) and role design ----

  route('/assist/issue', ['POST'], async (request) => {
    const body = await readBody(request)
    const input = clampText(typeof body?.input === 'string' ? body.input.trim() : '', 1200).trim()
    if (!input) throw new HttpError('请先写下你的想法或回答。')
    const messages = []
    const history = Array.isArray(body?.history) ? body.history.slice(-12) : []
    for (const item of history) {
      const text = clampText(typeof item?.content === 'string' ? item.content : '', 1500)
      if (text) messages.push({ role: item?.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text }] })
    }
    if (!messages.length && body?.draft?.title) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `（当前议题草稿）标题：${body.draft.title}\n背景：${body.draft.background ?? ''}\n目标：${body.draft.goal ?? ''}`,
          },
        ],
      })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
    const result = await callModel(ctx, { system: ISSUE_ASSIST_SYSTEM, messages, maxTokens: 900, temperature: 0.4 })
    const parsed = extractJson(result.text)
    const draft =
      parsed?.draft && typeof parsed.draft === 'object'
        ? {
            title: clampText(typeof parsed.draft.title === 'string' ? parsed.draft.title.trim() : '', 200).trim(),
            background: clampText(typeof parsed.draft.background === 'string' ? parsed.draft.background.trim() : '', 2000).trim(),
            goal: clampText(typeof parsed.draft.goal === 'string' ? parsed.draft.goal.trim() : '', 600).trim(),
            checklist: Array.isArray(parsed.draft.checklist)
              ? parsed.draft.checklist.map((item) => clampText(typeof item === 'string' ? item : '', 200)).filter(Boolean).slice(0, 12)
              : [],
          }
        : null
    return respond({
      reply: clampText(typeof parsed?.reply === 'string' ? parsed.reply : result.text, 1200),
      ready: parsed?.ready === true && Boolean(draft?.title),
      draft,
    })
  })

  route('/assist/role', ['POST'], async (request) => {
    const body = await readBody(request)
    const input = clampText(typeof body?.input === 'string' ? body.input.trim() : '', 600).trim()
    if (input.length < 2) throw new HttpError('请描述一下这个角色关心什么。')
    const existing = Array.isArray(body?.existingNames) ? body.existingNames.slice(0, 20).join('、') : ''
    const result = await callModel(ctx, {
      system: ROLE_ASSIST_SYSTEM,
      user: [`【用户想要的角色】\n${input}`, existing ? `【已有角色（避免重复）】\n${existing}` : '', body?.groupName ? `【所属分组】${body.groupName}` : '']
        .filter(Boolean)
        .join('\n\n'),
      maxTokens: 900,
      temperature: 0.6,
    })
    const parsed = extractJson(result.text)
    const suggestions = (Array.isArray(parsed?.suggestions) ? parsed.suggestions : [])
      .slice(0, 3)
      .map((item, index) => ({
        id: `suggestion-${index}`,
        name: clampText(typeof item?.name === 'string' ? item.name.trim() : '', 40).trim(),
        focus: clampText(typeof item?.focus === 'string' ? item.focus.trim() : '', 60).trim(),
        persona: clampText(typeof item?.persona === 'string' ? item.persona.trim() : '', 1400).trim(),
        tags: Array.isArray(item?.tags) ? item.tags.map((tag) => clampText(typeof tag === 'string' ? tag : '', 20)).filter(Boolean).slice(0, 4) : [],
      }))
      .filter((item) => item.name && item.persona.length >= 20)
    if (!suggestions.length) throw new HttpError(`没能生成可用角色，模型返回：${clampText(result.text, 300)}`, 502)
    return respond({ suggestions })
  })

  // ---- team assist: design a whole group of roles, or rewrite a chosen scope ----

  route('/assist/team', ['POST'], async (request) => {
    await loadState()
    const body = await readBody(request)
    const input = clampText(typeof body?.input === 'string' ? body.input.trim() : '', 1200).trim()
    if (input.length < 2) throw new HttpError('请描述这个团队要覆盖什么决策场景。')
    const skeleton = body?.mode === 'skeleton'
    const existingGroups = state.groups.map((group) => group.name).join('、')
    const existingRoles = state.roles.map((role) => role.name).join('、')
    const result = await callModel(ctx, {
      system: TEAM_ASSIST_SYSTEM,
      user: [
        `【用户想要的团队】\n${input}`,
        existingGroups ? `【已有分组（避免重名）】\n${existingGroups}` : '',
        existingRoles ? `【已有角色（避免重复视角）】\n${existingRoles}` : '',
        skeleton
          ? '【输出模式】只出框架：persona 允许留空字符串，但 name 与 focus 必须给全，reply 里说明每个角色打算怎么发言。'
          : '【输出模式】完整人设：每个角色的 persona 必须写满 120~200 字。',
      ]
        .filter(Boolean)
        .join('\n\n'),
      maxTokens: skeleton ? 700 : 2000,
      temperature: 0.6,
    })
    const parsed = extractJson(result.text)
    if (!parsed || typeof parsed !== 'object') throw new HttpError(`没能生成团队，模型返回：${clampText(result.text, 300)}`, 502)
    const group = parsed.group && typeof parsed.group === 'object'
      ? {
          name: clampText(typeof parsed.group.name === 'string' ? parsed.group.name.trim() : '', 40).trim(),
          description: clampText(typeof parsed.group.description === 'string' ? parsed.group.description.trim() : '', 200).trim(),
        }
      : null
    const roles = (Array.isArray(parsed.roles) ? parsed.roles : [])
      .slice(0, MAX_ROLES)
      .map((item, index) => ({
        id: `team-role-${index}`,
        name: clampText(typeof item?.name === 'string' ? item.name.trim() : '', 40).trim(),
        focus: clampText(typeof item?.focus === 'string' ? item.focus.trim() : '', 60).trim(),
        persona: clampText(typeof item?.persona === 'string' ? item.persona.trim() : '', 1400).trim(),
        tags: Array.isArray(item?.tags) ? item.tags.map((tag) => clampText(typeof tag === 'string' ? tag : '', 20)).filter(Boolean).slice(0, 4) : [],
      }))
      .filter((item) => item.name)
    if (!group?.name) throw new HttpError(`模型没有给出可用的分组名：${clampText(result.text, 300)}`, 502)
    if (roles.length < 2) throw new HttpError(`只生成了 ${roles.length} 个角色，至少需要 2 个可用角色。`, 502)
    return respond({
      reply: clampText(typeof parsed?.reply === 'string' ? parsed.reply : '', 1200),
      mode: skeleton ? 'skeleton' : 'full',
      group,
      roles,
    })
  })

  route('/assist/revise', ['POST'], async (request) => {
    await loadState()
    const body = await readBody(request)
    const instruction = clampText(typeof body?.instruction === 'string' ? body.instruction.trim() : '', 600).trim()
    if (instruction.length < 2) throw new HttpError('请说明要往哪个方向改。')
    const targets = state.roles.filter((role) => Array.isArray(body?.roleIds) && body.roleIds.includes(role.id))
    if (!targets.length) throw new HttpError('请先选中要修改的角色（或选中整个分组）。', 409)
    if (targets.length > MAX_ROLES) throw new HttpError(`一次最多改写 ${MAX_ROLES} 个角色。`)
    const scopeLabel = Array.isArray(body?.groupIds) && body.groupIds.length
      ? `分组：${state.groups.filter((group) => body.groupIds.includes(group.id)).map((group) => group.name).join('、')}`
      : '指定角色'
    const result = await callModel(ctx, {
      system: TEAM_REVISE_SYSTEM,
      user: [
        `【修改范围】${scopeLabel}，共 ${targets.length} 个角色`,
        targets.map((role) => `--- id: ${role.id}\n名称：${role.name}\n关注点：${role.focus || '（无）'}\n现有人设：${role.persona}`).join('\n'),
        `【用户的修改要求】\n${instruction}`,
      ].join('\n\n'),
      maxTokens: Math.min(2400, 260 + targets.length * 320),
      temperature: 0.4,
    })
    const parsed = extractJson(result.text)
    if (!parsed || typeof parsed !== 'object') throw new HttpError(`没能生成改写结果，模型返回：${clampText(result.text, 300)}`, 502)
    const byId = new Map(targets.map((role) => [role.id, role]))
    const revised = (Array.isArray(parsed.roles) ? parsed.roles : [])
      .map((item) => {
        const id = typeof item?.id === 'string' ? item.id.trim() : ''
        const before = byId.get(id)
        if (!before) return null
        return {
          id,
          name: clampText(typeof item?.name === 'string' ? item.name.trim() : '', 40).trim() || before.name,
          focus: clampText(typeof item?.focus === 'string' ? item.focus.trim() : '', 60).trim() || before.focus,
          persona: clampText(typeof item?.persona === 'string' ? item.persona.trim() : '', 1400).trim(),
          changed: clampText(typeof item?.changed === 'string' ? item.changed.trim() : '', 200).trim(),
          before: { name: before.name, focus: before.focus, persona: before.persona },
        }
      })
      .filter((item) => item && item.persona.length >= 20)
    if (!revised.length) throw new HttpError(`改写结果为空（模型没有返回可用人设）：${clampText(result.text, 300)}`, 502)
    const missing = targets.filter((role) => !revised.some((item) => item.id === role.id)).map((role) => role.name)
    return respond({
      reply: clampText(typeof parsed?.reply === 'string' ? parsed.reply : '', 1000),
      revised,
      missing,
    })
  })

  // ---- batch commit: apply a whole team, or a set of revisions, in one write ----

  route('/library/apply', ['POST'], async (request) => {
    await loadState()
    const body = await readBody(request)
    const nextGroups = normalizeGroups(body?.groups ?? state.groups)
    const nextRoles = normalizeRoles(body?.roles ?? state.roles, nextGroups)
    state.groups = nextGroups
    state.roles = nextRoles
    await store.saveGroups(nextGroups)
    await store.saveRoles(nextRoles)
    return respond({ groups: nextGroups, roles: nextRoles })
  })

  // ---- model tools: let the roundtable agent manage the library itself ----

  registerLibraryTools()

  async function registerLibraryTools() {
    await loadState()
    const tools = ctx.get('tools')
    if (tools === undefined) return

    const describeLibrary = async () => {
      await loadState()
      return state
    }

    const applyLibrary = async (groups, roles) => {
      const nextGroups = normalizeGroups(groups)
      const nextRoles = normalizeRoles(roles, nextGroups)
      state.groups = nextGroups
      state.roles = nextRoles
      await store.saveGroups(nextGroups)
      await store.saveRoles(nextRoles)
      return { groups: nextGroups, roles: nextRoles }
    }

    ctx.effect(() => {
      const disposers = []

      disposers.push(
        tools.register({
          name: 'roundtable_library',
          description:
            '议题圆桌的角色库：读取分组与角色，或在一个调用里整体替换它们。' +
            '创建团队时先用 assist 生成内容，再把这个工具写回；修改时先读、再改、再整体写回。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['read', 'write'], description: 'read 读取当前分组与角色；write 用 groups+roles 整体替换' },
              groups: {
                type: 'array',
                description: 'write 时必填：完整的分组列表（第一个分组会成为新角色的默认分组）',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: '已有分组请原样带回 id；新建可省略' },
                    name: { type: 'string', description: '分组名，2~8 字' },
                    description: { type: 'string', description: '这个组负责哪类决策' },
                  },
                  required: ['name'],
                },
              },
              roles: {
                type: 'array',
                description: 'write 时必填：完整的角色列表（不在列表里的角色会被删除）',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: '已有角色请原样带回 id；新建可省略' },
                    name: { type: 'string', description: '角色名，2~8 字' },
                    focus: { type: 'string', description: '关注点，不超过 12 字' },
                    persona: { type: 'string', description: '立场与说话方式，120~200 字，第二人称「你」' },
                    groupId: { type: 'string', description: '所属分组 id；省略则进第一个分组' },
                  },
                  required: ['name', 'persona'],
                },
              },
            },
            required: ['action'],
          },
          async execute(args) {
            if (args?.action !== 'write') {
              const current = await describeLibrary()
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ groups: current.groups, roles: current.roles }),
                  },
                ],
              }
            }
            if (!Array.isArray(args?.groups) || !Array.isArray(args?.roles)) {
              throw new Error('write 需要同时给出 groups 与 roles 两个数组。')
            }
            const applied = await applyLibrary(args.groups, args.roles)
            return {
              content: [
                {
                  type: 'text',
                  text: `已保存：${applied.groups.length} 个分组、${applied.roles.length} 个角色。分组：${applied.groups
                    .map((group) => `${group.name}(${applied.roles.filter((role) => role.groupId === group.id).length})`)
                    .join('、')}`,
                },
              ],
            }
          },
        }),
      )

      disposers.push(
        tools.register({
          name: 'roundtable_team',
          description:
            '为议题圆桌设计一个角色分组及其全部角色（例如「个股投研组」）。' +
            '返回候选分组与角色，供你核对；确认后用 roundtable_library 的 write 落库。',
          parameters: {
            type: 'object',
            properties: {
              scenario: { type: 'string', description: '这个团队要覆盖的决策场景，例如「个股投研：判断某只股票值不值得买」' },
              mode: {
                type: 'string',
                enum: ['full', 'skeleton'],
                description: 'full 写满人设；skeleton 只出名称与关注点，便于用户在面板里补全',
              },
            },
            required: ['scenario'],
          },
          async execute(args) {
            const scenario = clampText(typeof args?.scenario === 'string' ? args.scenario.trim() : '', 1200).trim()
            if (scenario.length < 2) throw new Error('请给出这个团队要覆盖的决策场景。')
            const skeleton = args?.mode === 'skeleton'
            const current = await describeLibrary()
            const result = await callModel(ctx, {
              system: TEAM_ASSIST_SYSTEM,
              user: [
                `【用户想要的团队】\n${scenario}`,
                current.groups.length ? `【已有分组（避免重名）】\n${current.groups.map((group) => group.name).join('、')}` : '',
                current.roles.length ? `【已有角色（避免重复视角）】\n${current.roles.map((role) => role.name).join('、')}` : '',
                skeleton
                  ? '【输出模式】只出框架：persona 允许留空字符串，但 name 与 focus 必须给全，reply 里说明每个角色打算怎么发言。'
                  : '【输出模式】完整人设：每个角色的 persona 必须写满 120~200 字。',
              ]
                .filter(Boolean)
                .join('\n\n'),
              maxTokens: skeleton ? 700 : 2000,
              temperature: 0.6,
            })
            const parsed = extractJson(result.text)
            if (!parsed?.group?.name) throw new Error(`模型没有给出可用的分组：${clampText(result.text, 300)}`)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    reply: clampText(typeof parsed.reply === 'string' ? parsed.reply : '', 800),
                    group: { name: clampText(parsed.group.name, 40), description: clampText(parsed.group.description ?? '', 200) },
                    roles: (Array.isArray(parsed.roles) ? parsed.roles : []).slice(0, MAX_ROLES).map((item) => ({
                      name: clampText(item?.name ?? '', 40),
                      focus: clampText(item?.focus ?? '', 60),
                      persona: clampText(item?.persona ?? '', 1400),
                    })),
                  }),
                },
              ],
            }
          },
        }),
      )

      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'issue-roundtable: library tools')
  }

  ctx.effect(
    () => () => {
      for (const controller of controllers.values()) controller.abort()
    },
    'issue-roundtable: stop running meetings',
  )
}

function issueView(issue) {
  return issue
}

/** Exported for tests; the panel never imports the host half. */
export const internals = { extractJson, normalizeProposals, normalizeGroups, normalizeRoles, defaultGroups, defaultRoles }
