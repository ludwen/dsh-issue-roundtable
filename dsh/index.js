// dsh-issue-roundtable — host half.
//
// Owns three things:
//   1. a durable roster of debate roles and the round settings the user picked;
//   2. the debate engine: each turn is one real model call seeded with the
//      role's persona, the researched material and every earlier turn; then a
//      clerk converges the transcript into votable proposals; then every role
//      casts one independent vote; then the tally decides;
//   3. the local HTTP routes the workbench panel polls.
//
// The engine runs in the host process, not inside the panel, so switching
// workbench, closing the panel or refreshing the page never kills a debate.

import Schema from '@deepseek-ai/schemastery'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'issue-roundtable'
export const inject = ['connection']

export const Config = Schema.object({
  root: Schema.string().required(),
  researchMaxResults: Schema.natural().min(1).max(10).default(6),
  maxHistory: Schema.natural().default(40),
})

const API = '/api/issue-roundtable'
const MAX_ROLES = 8
const MAX_ROUNDS = 5

/** Default roster, used until the user edits and saves one. */
export function defaultRoles() {
  return [
    {
      id: 'product',
      name: '产品经理',
      focus: '用户价值与需求',
      persona:
        '你从用户和产品价值出发考虑问题。你关心这件事到底解决了谁的什么问题、体验是否成立、节奏和取舍是否清晰。' +
        '你不喜欢为了技术完美或流程安全牺牲用户可感知的收益，但也不接受没有依据的需求想象。' +
        '表达直接，习惯用一个具体的用户场景来说明观点。',
    },
    {
      id: 'engineering',
      name: '技术负责人',
      focus: '可行性与长期成本',
      persona:
        '你判断技术可行性与长期维护成本：实现路径、依赖、性能上限、可回滚性和后续迭代空间，并且会主动指出别人方案里被低估的复杂度。' +
        '你愿意为方案找替代实现，但拒绝「先上再补」的空头承诺；给出的估算会标清是估算还是实测。',
    },
    {
      id: 'finance',
      name: '财务负责人',
      focus: '预算与投入产出',
      persona:
        '你只关心钱从哪来、花多少、多久看到回报。你会要求把成本拆成一次性投入和持续成本，把收益说成可核对的数字或明确假设。' +
        '你对模糊的「长期价值」天然怀疑，但接受有条件投入：先小额验证再追加。',
    },
    {
      id: 'user',
      name: '用户代表',
      focus: '真实使用体验',
      persona:
        '你代表真实使用者的感受和操作习惯：用户实际会怎么用、在哪一步卡住、会不会放弃。' +
        '你反对一切把复杂流程推给用户的方案，不讲技术也不讲财务，只讲使用现场。',
    },
  ]
}

// ---------------------------------------------------------------- utilities

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const now = () => new Date().toISOString()

function clampText(value, max) {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function cleanId(value, fallback) {
  const safe = (typeof value === 'string' ? value.trim() : '').replace(/[^a-zA-Z0-9_-]/g, '')
  return safe || fallback
}

function uniqueRoleId(roles, wanted, index) {
  const base = cleanId(wanted, `role-${index + 1}`)
  let id = base
  let n = 1
  while (roles.some((role) => role.id === id)) id = `${base}-${++n}`
  return id
}

/** Normalize a submitted roster; never trust the panel with unbounded values. */
export function normalizeRoles(input) {
  if (!Array.isArray(input)) throw new HttpError('角色列表格式不正确。')
  if (input.length > MAX_ROLES) throw new HttpError(`一场圆桌最多 ${MAX_ROLES} 个角色。`)
  const roles = []
  input.forEach((raw, index) => {
    const name = clampText(typeof raw?.name === 'string' ? raw.name.trim() : '', 40).trim()
    const persona = clampText(typeof raw?.persona === 'string' ? raw.persona.trim() : '', 1400).trim()
    const focus = clampText(typeof raw?.focus === 'string' ? raw.focus.trim() : '', 60).trim()
    if (!name) throw new HttpError(`第 ${index + 1} 个角色缺少名称。`)
    if (persona.length < 20) throw new HttpError(`角色「${name}」的立场描述太短，请至少写 20 个字。`)
    roles.push({ id: uniqueRoleId(roles, raw?.id, index), name, persona, focus })
  })
  if (roles.length === 0) throw new HttpError('至少需要一个角色。')
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

/** Normalize the clerk's proposals; ids are reassigned in list order. */
export function normalizeProposals(input) {
  const list = Array.isArray(input) ? input : []
  const letters = ['A', 'B', 'C', 'D', 'E', 'F']
  const proposals = []
  for (const raw of list.slice(0, letters.length)) {
    if (!raw || typeof raw !== 'object') continue
    const title = clampText(typeof raw.title === 'string' ? raw.title.trim() : '', 40).trim()
    if (!title) continue
    const summary = clampText(typeof raw.summary === 'string' ? raw.summary.trim() : '', 900).trim()
    const tradeoffs = clampText(typeof raw.tradeoffs === 'string' ? raw.tradeoffs.trim() : '', 400).trim()
    const keyPoints = Array.isArray(raw.keyPoints)
      ? raw.keyPoints.map((point) => clampText(typeof point === 'string' ? point.trim() : '', 160)).filter(Boolean).slice(0, 6)
      : []
    proposals.push({ id: letters[proposals.length], title, summary, keyPoints, tradeoffs })
  }
  return proposals
}

// ----------------------------------------------------------------- storage

function createStore(root) {
  let ready

  async function ensure() {
    if (!ready) ready = mkdir(root, { recursive: true }).catch(() => {})
    await ready
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  async function writeJson(file, value) {
    await ensure()
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  const rolesFile = join(root, 'roles.json')
  const settingsFile = join(root, 'settings.json')
  const historyFile = join(root, 'history.json')

  return {
    async load() {
      const storedRoles = await readJson(rolesFile, null)
      const storedSettings = await readJson(settingsFile, null)
      const storedHistory = await readJson(historyFile, null)
      let roles
      try {
        roles = storedRoles ? normalizeRoles(storedRoles) : defaultRoles()
      } catch {
        roles = defaultRoles()
      }
      const rounds = Number(storedSettings?.rounds)
      const settings = {
        rounds: Number.isInteger(rounds) ? Math.min(MAX_ROUNDS, Math.max(1, rounds)) : 3,
        research: storedSettings?.research === false ? false : true,
        roleIds: Array.isArray(storedSettings?.roleIds) ? storedSettings.roleIds.filter((id) => typeof id === 'string') : roles.map((role) => role.id),
      }
      const history = Array.isArray(storedHistory) ? storedHistory.filter((item) => item && typeof item.id === 'string') : []
      return { roles, settings, history }
    },
    saveRoles: (roles) => writeJson(rolesFile, roles),
    saveSettings: (settings) => writeJson(settingsFile, settings),
    saveHistory: (history) => writeJson(historyFile, history),
  }
}

// ------------------------------------------------------------- model calls

function resolveSelection(ctx, fallback) {
  if (fallback?.provider && fallback?.model) return fallback
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
  throw new HttpError('还没有可用的模型：请先在设置里选择一个默认模型，再开始讨论。', 409)
}

/**
 * One provider call. Every stream ends with a terminal `finish` chunk; this
 * workbench only needs the concatenated text plus token usage.
 */
async function callModel(ctx, options) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new HttpError('模型服务不可用（llm 服务未加载）。', 503)
  const target = resolveSelection(ctx, options.fallback)
  const request = {
    provider: target.provider,
    model: target.model,
    system: options.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.user }] }],
  }
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens
  if (options.temperature !== undefined) request.temperature = options.temperature
  if (options.signal !== undefined) request.signal = options.signal
  let text = ''
  const usage = { inputTokens: 0, outputTokens: 0 }
  const stream = llm.stream(request)
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') {
      usage.inputTokens += chunk.usage?.inputTokens ?? 0
      usage.outputTokens += chunk.usage?.outputTokens ?? 0
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const message = chunk.reason?.failure?.message ?? '模型调用失败'
        const code = chunk.reason?.failure?.code
        throw new HttpError(
          `模型调用${kind === 'aborted' ? '被中断' : '失败'}${code ? `（${code}）` : ''}：${message}`,
          kind === 'aborted' ? 409 : 502,
        )
      }
    }
  }
  return { text: text.trim(), usage, provider: target.provider, model: target.model }
}

/** Shared web research; a missing or failing provider degrades to a notice. */
async function research(ctx, topic, maxResults, signal) {
  const web = ctx.get('web')
  if (web === undefined) {
    return { available: false, note: '当前环境没有联网检索能力，讨论只依据模型已有知识。', queries: [], sources: [] }
  }
  const queries = [topic, `${topic} 风险 争议`]
  const sources = []
  const failures = []
  for (const query of queries) {
    try {
      const result = await web.search({ query, maxResults }, signal)
      for (const source of result?.sources ?? []) {
        if (!source?.url || sources.some((item) => item.url === source.url)) continue
        sources.push({
          url: source.url,
          title: clampText(source.title ?? source.url, 160),
          snippet: clampText(source.snippet ?? '', 400),
        })
      }
    } catch (error) {
      failures.push(clampText(error instanceof Error ? error.message : String(error), 200))
    }
  }
  if (!sources.length) {
    return {
      available: false,
      note: `联网检索未返回资料${failures.length ? `：${failures[0]}` : ''}。讨论只依据模型已有知识。`,
      queries,
      sources: [],
    }
  }
  return {
    available: true,
    note: failures.length ? `部分检索失败：${failures[0]}` : `已检索到 ${sources.length} 条资料。`,
    queries,
    sources: sources.slice(0, 12),
  }
}

// ------------------------------------------------------------------ prompts

function material(researchResult) {
  if (!researchResult?.sources?.length) return '（没有联网资料，请基于已有知识和明确标注的假设发言。）'
  return researchResult.sources
    .map((source, index) => `[${index + 1}] ${source.title} — ${source.url}${source.snippet ? `\n    ${source.snippet}` : ''}`)
    .join('\n')
}

function transcript(turns) {
  if (!turns.length) return '（还没有人发言，你是第一个。）'
  return turns
    .map((turn) => {
      if (turn.error) return `第${turn.round}轮 · ${turn.roleName}：（这次发言失败）`
      return `第${turn.round}轮 · ${turn.roleName}：${turn.text}`
    })
    .join('\n\n')
}

function turnTask(round, total) {
  if (round <= 1) return '先指出议题的关键分歧在哪，再给出你的立论（判断 + 理由 + 关键风险）。'
  if (round === 2) return '回应前面发言里最强的反对意见：说明你接受什么、反对什么，并修正你上一轮说得不够准确的地方。'
  if (round >= total) return '收敛：给出你愿意支持的方案要点、必须满足的条件，以及你可以让步的部分。'
  return '推进：补充前面都没覆盖的证据或角度，并指出分歧已经缩小到哪里。'
}

function roleSystem(role) {
  return [
    `你正在参加一场多人圆桌讨论，你的身份是「${role.name}」。`,
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

function readBody(request) {
  return request.json().catch(() => {
    throw new HttpError('请求内容不是合法 JSON。')
  })
}

/** Panel-facing snapshot: everything a run has produced so far. */
function runView(run) {
  const elapsedMs = Math.max(0, Date.parse(run.finishedAt ?? now()) - Date.parse(run.startedAt))
  return {
    id: run.id,
    topic: run.topic,
    status: run.status,
    stage: run.stage,
    round: run.round,
    totalRounds: run.totalRounds,
    researchEnabled: run.researchEnabled,
    participants: run.participants.map((role) => ({ id: role.id, name: role.name, focus: role.focus })),
    research: run.research,
    turns: run.turns,
    speaking: run.speaking,
    proposals: run.proposals,
    votes: run.votes,
    runoffVotes: run.runoffVotes,
    tally: run.tally,
    conclusion: run.conclusion,
    error: run.error,
    usage: run.usage,
    model: run.model,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    updatedAt: run.updatedAt,
    elapsedMs,
  }
}

export function apply(ctx, config) {
  const store = createStore(config.root)
  const runs = new Map()
  let activeRunId = null
  let cached = null

  async function readState() {
    if (!cached) cached = await store.load()
    return cached
  }

  async function refresh() {
    cached = await store.load()
    return cached
  }

  function publish(run) {
    run.updatedAt = now()
  }

  function record(run) {
    return {
      id: run.id,
      topic: run.topic,
      status: run.status,
      rounds: run.totalRounds,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      model: run.model,
      research: run.research,
      participants: run.participants,
      turns: run.turns,
      proposals: run.proposals,
      votes: run.votes,
      runoffVotes: run.runoffVotes,
      tally: run.tally,
      conclusion: run.conclusion,
      openQuestions: run.openQuestions,
      error: run.error,
      usage: {
        inputTokens: run.usage.reduce((sum, item) => sum + item.inputTokens, 0),
        outputTokens: run.usage.reduce((sum, item) => sum + item.outputTokens, 0),
        calls: run.usage.length,
      },
    }
  }

  async function finish(run) {
    if (!run.finishedAt) run.finishedAt = now()
    run.speaking = null
    if (run.status === 'running') run.status = 'done'
    try {
      const state = await refresh()
      const list = state.history.filter((item) => item.id !== run.id)
      list.unshift(record(run))
      state.history = list.slice(0, config.maxHistory)
      await store.saveHistory(state.history)
    } catch (error) {
      ctx.logger?.warn?.(error)
    }
    if (![...runs.values()].some((item) => item.status === 'running')) activeRunId = null
  }

  // ---- one debate: research → rounds → clerk → votes → tally ----

  async function debate(run) {
    const signal = run.controller.signal
    const checkpoint = () => {
      if (signal.aborted) throw new HttpError('讨论已取消。', 409)
    }
    try {
      // Research is best-effort: a failed search must not kill the debate.
      if (run.researchEnabled) {
        run.stage = 'research'
        publish(run)
        try {
          run.research = await research(ctx, run.topic, config.researchMaxResults, signal)
        } catch (error) {
          run.research = {
            available: false,
            note: `资料检索失败：${clampText(error instanceof Error ? error.message : String(error), 200)}`,
            queries: [run.topic],
            sources: [],
          }
        }
      } else {
        run.research = { available: false, note: '本次讨论未启用联网检索。', queries: [], sources: [] }
      }
      publish(run)
      checkpoint()

      run.stage = 'debate'
      for (let round = 1; round <= run.totalRounds; round += 1) {
        run.round = round
        publish(run)
        for (const role of run.participants) {
          checkpoint()
          run.speaking = { round, roleId: role.id, roleName: role.name, startedAt: now() }
          publish(run)
          try {
            const result = await callModel(ctx, {
              fallback: run.model,
              system: roleSystem(role),
              user: [
                `【议题】\n${run.topic}`,
                `【背景资料】\n${material(run.research)}`,
                `【已有发言】\n${transcript(run.turns)}`,
                `【本轮任务】第 ${round}/${run.totalRounds} 轮\n${turnTask(round, run.totalRounds)}`,
              ].join('\n\n'),
              maxTokens: 900,
              temperature: 0.6,
              signal,
            })
            run.usage.push(result.usage)
            run.turns.push({
              round,
              roleId: role.id,
              roleName: role.name,
              focus: role.focus,
              text: result.text || '（这次没有产生可读的发言。）',
              at: now(),
              provider: result.provider,
              model: result.model,
            })
          } catch (error) {
            if (signal.aborted) throw error
            run.turns.push({
              round,
              roleId: role.id,
              roleName: role.name,
              focus: role.focus,
              text: '',
              at: now(),
              error: clampText(error instanceof Error ? error.message : String(error), 400),
            })
          }
          run.speaking = null
          publish(run)
        }
      }

      if (!run.turns.some((turn) => !turn.error && turn.text)) {
        throw new HttpError('所有角色都没有成功发言，无法进入表决。', 502)
      }
      checkpoint()

      // Clerk: converge the transcript into votable proposals.
      run.stage = 'synthesis'
      publish(run)
      const clerk = await synthesize(run, signal)
      run.proposals = clerk.proposals
      run.openQuestions = clerk.openQuestions
      run.recommendedId = clerk.recommendedId
      publish(run)
      checkpoint()

      // Votes are independent of each other, so they run together.
      run.stage = 'vote'
      publish(run)
      run.votes = await collectVotes(run, run.proposals, signal, '表决')
      run.tally = tallyOf(run.proposals, run.votes)
      publish(run)
      checkpoint()

      // A tie is a real outcome of a vote: one runoff among the tied proposals.
      if (run.tally.tie && run.tally.tiedIds.length > 1) {
        const tied = run.proposals.filter((proposal) => run.tally.tiedIds.includes(proposal.id))
        run.stage = 'runoff'
        publish(run)
        run.runoffVotes = await collectVotes(run, tied, signal, '平票复选')
        const runoffTally = tallyOf(tied, run.runoffVotes)
        if (!runoffTally.tie && runoffTally.counts[runoffTally.winnerId] > 0) {
          run.tally = { ...runoffTally, runoff: true }
        } else {
          // Still tied after a runoff: say so and let the clerk's recommendation decide.
          const chosen = tied.find((proposal) => proposal.id === clerk.recommendedId) ?? tied[0]
          run.tally = { ...runoffTally, tie: true, tieBrokenBy: 'clerk', winnerId: chosen.id, tiedIds: runoffTally.tiedIds }
        }
        publish(run)
        checkpoint()
      }

      const winner = run.proposals.find((proposal) => proposal.id === run.tally.winnerId) ?? run.proposals[0]
      const dissent = run.votes
        .filter((vote) => vote.proposalId && vote.proposalId !== winner.id)
        .map((vote) => ({ roleName: vote.roleName, proposalId: vote.proposalId, reason: vote.reason }))
      run.conclusion = {
        proposalId: winner.id,
        title: winner.title,
        summary: winner.summary,
        keyPoints: winner.keyPoints,
        tradeoffs: winner.tradeoffs,
        counts: run.tally.counts,
        voters: run.tally.voters,
        abstain: run.tally.abstain,
        dissent,
        openQuestions: clerk.openQuestions,
        decidedAt: now(),
        note:
          run.tally.tieBrokenBy === 'clerk'
            ? '复选后仍然平票，按书记员的推荐意见裁定。'
            : run.tally.runoff
              ? '首轮平票，经一轮复选后产生结论。'
              : '按多数票产生结论。',
      }
      run.stage = 'result'
      run.status = 'done'
    } catch (error) {
      const cancelled = signal.aborted
      run.speaking = null
      run.status = cancelled ? 'cancelled' : 'failed'
      run.stage = cancelled ? 'cancelled' : 'failed'
      run.error = cancelled ? '讨论已取消。' : clampText(error instanceof Error ? error.message : String(error), 600)
    } finally {
      run.speaking = null
      await finish(run)
    }
  }

  async function synthesize(run, signal) {
    const prompt = [
      `【议题】\n${run.topic}`,
      `【背景资料】\n${material(run.research)}`,
      `【讨论全文】\n${transcript(run.turns)}`,
      '【任务】',
      '把这场讨论收敛成 2 到 4 个互不相同的候选方案，用来进行全体表决。要求：',
      '- 不是把各人的立场照抄一遍，而是能直接拿去决策的完整方案：做什么、怎么做、代价、收益、前提。',
      '- 方案之间必须真有取舍差别；如果讨论其实只剩一个方向，就给出「激进版 / 稳健版」这类可比较的版本。',
      '只输出一个 JSON 对象，不要输出任何其它文字或代码块标记。',
      'JSON 格式：',
      '{"proposals":[{"title":"不超过20字","summary":"3~5句：做什么、怎么做、代价与收益","keyPoints":["要点"],"tradeoffs":"主要取舍"}],"recommendedId":"A","openQuestions":["还没解决的关键问题"]}',
    ].join('\n\n')
    let parsed = null
    for (let attempt = 0; attempt < 2 && parsed === null; attempt += 1) {
      try {
        const result = await callModel(ctx, {
          fallback: run.model,
          system: '你是圆桌讨论的书记员，负责把讨论收敛成可表决的候选方案。你只输出一个 JSON 对象。',
          user: prompt,
          maxTokens: 1200,
          temperature: 0.2,
          signal,
        })
        run.usage.push(result.usage)
        parsed = extractJson(result.text)
      } catch (error) {
        if (signal.aborted) throw error
        if (attempt === 1) throw error
      }
    }
    const proposals = normalizeProposals(parsed?.proposals)
    if (proposals.length < 2) {
      // A malformed clerk reply must not leave the roundtable with nothing to
      // vote on: each participant's last position becomes a proposal.
      const fallback = run.participants.slice(0, 4).map((role) => {
        const last = [...run.turns].reverse().find((turn) => turn.roleId === role.id && !turn.error && turn.text)
        return {
          title: `${role.name}的主张`,
          summary: clampText(last?.text || `${role.name}没有留下有效发言。`, 700),
          keyPoints: [],
          tradeoffs: '',
        }
      })
      const normalized = normalizeProposals(fallback)
      return {
        proposals: normalized,
        recommendedId: normalized[0]?.id,
        openQuestions: ['书记员没能按格式收敛方案，下面按各角色最后的主张直接表决。'],
      }
    }
    const recommended = String(parsed?.recommendedId ?? '').trim().toUpperCase()
    return {
      proposals,
      recommendedId: proposals.some((proposal) => proposal.id === recommended) ? recommended : proposals[0].id,
      openQuestions: Array.isArray(parsed?.openQuestions)
        ? parsed.openQuestions.map((item) => clampText(typeof item === 'string' ? item : '', 300)).filter(Boolean).slice(0, 6)
        : [],
    }
  }

  async function collectVotes(run, proposals, signal, label) {
    const runoff = label === '平票复选'
    const ballot = proposals
      .map(
        (proposal) =>
          `${proposal.id}. ${proposal.title}\n    方案：${proposal.summary}${proposal.tradeoffs ? `\n    取舍：${proposal.tradeoffs}` : ''}`,
      )
      .join('\n')
    return Promise.all(
      run.participants.map(async (role) => {
        const base = { roleId: role.id, roleName: role.name, label, runoff, proposalId: null, reason: '', abstain: false, at: now() }
        if (signal.aborted) return { ...base, abstain: true, reason: '讨论已取消。' }
        const last = [...run.turns].reverse().find((turn) => turn.roleId === role.id && !turn.error && turn.text)
        try {
          const result = await callModel(ctx, {
            fallback: run.model,
            system: voteSystem(role),
            user: [
              `【议题】\n${run.topic}`,
              `【候选方案】\n${ballot}`,
              `【你在讨论中的最后发言】\n${clampText(last?.text || '（你没有留下发言）', 900)}`,
              `【任务】\n这是${label}。选出你认为最该落地的方案；reason 用 1~2 句说明基于方案本身的判断依据，不要因为别人选了而从众。`,
              '只输出：{"proposalId":"A","reason":"..."}',
            ].join('\n\n'),
            maxTokens: 400,
            temperature: 0.2,
            signal,
          })
          run.usage.push(result.usage)
          const parsed = extractJson(result.text) ?? {}
          const wanted = String(parsed.proposalId ?? parsed.proposal_id ?? parsed.id ?? '').trim().toUpperCase()
          const hit = proposals.find((proposal) => proposal.id === wanted)
          if (!hit) {
            return { ...base, abstain: true, reason: `投票格式无法识别：${clampText(result.text, 200)}` }
          }
          return { ...base, proposalId: hit.id, reason: clampText(parsed.reason ?? parsed.rationale ?? '', 500) || '未给出理由。' }
        } catch (error) {
          if (signal.aborted) return { ...base, abstain: true, reason: '讨论已取消。' }
          return { ...base, abstain: true, reason: `投票失败：${clampText(error instanceof Error ? error.message : String(error), 200)}` }
        }
      }),
    )
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

  const historyView = (item) => ({
    id: item.id,
    topic: item.topic,
    status: item.status,
    createdAt: item.createdAt,
    finishedAt: item.finishedAt,
    conclusionTitle: item.conclusion?.title ?? '',
    participants: (item.participants ?? []).map((role) => role.name),
  })

  route('/state', ['GET'], async () => {
    const state = await readState()
    let model = null
    try {
      model = resolveSelection(ctx)
    } catch {
      model = null
    }
    return respond({
      roles: state.roles,
      settings: state.settings,
      model,
      maxRounds: MAX_ROUNDS,
      activeRun: activeRunId ? runView(runs.get(activeRunId)) : null,
      history: state.history.map(historyView),
    })
  })

  route('/roles', ['POST'], async (request) => {
    const body = await readBody(request)
    const state = await readState()
    const roles = normalizeRoles(body?.roles)
    state.roles = roles
    await store.saveRoles(roles)
    return respond({ roles })
  })

  route('/settings', ['POST'], async (request) => {
    const body = await readBody(request)
    const state = await readState()
    const rounds = Number(body?.rounds)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new HttpError(`轮数需要在 1 到 ${MAX_ROUNDS} 之间。`)
    const roleIds = Array.isArray(body?.roleIds) ? body.roleIds.filter((id) => typeof id === 'string') : state.settings.roleIds
    state.settings = { rounds, research: body?.research !== false, roleIds }
    await store.saveSettings(state.settings)
    return respond({ settings: state.settings })
  })

  route('/start', ['POST'], async (request) => {
    const body = await readBody(request)
    const state = await readState()
    if ([...runs.values()].some((run) => run.status === 'running')) {
      throw new HttpError('已经有一场讨论在进行，请等它结束或先取消。', 409)
    }
    const topic = clampText(typeof body?.topic === 'string' ? body.topic.trim() : '', 2000).trim()
    if (topic.length < 4) throw new HttpError('议题太短，至少写 4 个字。')
    const rounds = Number(body?.rounds ?? state.settings.rounds)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new HttpError(`轮数需要在 1 到 ${MAX_ROUNDS} 之间。`)
    const wanted = Array.isArray(body?.roleIds) ? body.roleIds : state.settings.roleIds
    const participants = state.roles.filter((role) => wanted.includes(role.id))
    if (participants.length < 2) throw new HttpError('至少需要 2 个角色参与讨论。')
    let model
    try {
      model = resolveSelection(ctx)
    } catch (error) {
      throw new HttpError(error instanceof Error ? error.message : String(error), 409)
    }
    const researchEnabled = body?.research === undefined ? state.settings.research !== false : body.research !== false
    const run = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      topic,
      status: 'running',
      stage: 'research',
      round: 0,
      totalRounds: rounds,
      researchEnabled,
      participants,
      turns: [],
      research: null,
      speaking: null,
      proposals: [],
      votes: [],
      runoffVotes: [],
      tally: null,
      conclusion: null,
      openQuestions: [],
      recommendedId: null,
      error: '',
      usage: [],
      model,
      createdAt: now(),
      startedAt: now(),
      finishedAt: null,
      updatedAt: now(),
      controller: new AbortController(),
    }
    runs.set(run.id, run)
    activeRunId = run.id
    state.settings = { rounds, research: researchEnabled, roleIds: wanted.filter((id) => participants.some((role) => role.id === id)) }
    await store.saveSettings(state.settings).catch(() => {})
    // The engine keeps running after this response; the panel polls for progress.
    void debate(run)
    return respond({ runId: run.id, run: runView(run) })
  })

  route('/run', ['GET'], async (request) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const run = runs.get(id)
    if (!run) throw new HttpError('找不到这场讨论。', 404)
    return respond({ run: runView(run) })
  })

  route('/cancel', ['POST'], async (request) => {
    const body = await readBody(request)
    const run = runs.get(typeof body?.id === 'string' ? body.id : '')
    if (!run) throw new HttpError('找不到这场讨论。', 404)
    if (run.status === 'running') run.controller.abort()
    return respond({ cancelled: true })
  })

  route('/history', ['GET'], async () => {
    const state = await readState()
    return respond({ history: state.history.map(historyView) })
  })

  route('/debate', ['GET'], async (request) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const live = runs.get(id)
    if (live) return respond({ debate: runView(live) })
    const state = await readState()
    const item = state.history.find((entry) => entry.id === id)
    if (!item) throw new HttpError('找不到这条讨论记录。', 404)
    return respond({ debate: item })
  })

  route('/delete', ['POST'], async (request) => {
    const body = await readBody(request)
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) throw new HttpError('缺少要删除的记录。')
    runs.delete(id)
    const state = await refresh()
    const size = state.history.length
    state.history = state.history.filter((entry) => entry.id !== id)
    if (state.history.length !== size) await store.saveHistory(state.history)
    return respond({ deleted: state.history.length !== size })
  })

  // Abort in-flight debates when the plugin unloads, so the panel shows a
  // cancelled state instead of a debate that silently never finishes.
  ctx.effect(
    () => () => {
      for (const run of runs.values()) {
        if (run.status === 'running') run.controller.abort()
      }
    },
    'issue-roundtable: stop running debates',
  )
}

/** Exported for tests; the panel never imports the host half. */
export const internals = { extractJson, normalizeProposals, normalizeRoles, defaultRoles }
