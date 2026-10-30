// Smoke test for the host half: no DSH host, no network.
//   node test/smoke.mjs
//
// It mounts the plugin on a fake Cordis context with a scripted fake LLM
// stream, runs a full debate over the real fetch-route handlers, and asserts
// transcript, clerk proposals, votes, tally and conclusion.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, defaultRoles, extractJson, normalizeProposals, normalizeRoles } from '../dsh/index.js'

let failures = 0
const checks = []

function check(name, condition, detail) {
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

const CLERK_REPLY = JSON.stringify({
  proposals: [
    { title: '激进方案', summary: '一次投入全部预算，三个月内完成迁移。', keyPoints: ['一次到位', '风险高'], tradeoffs: '前期压力大' },
    { title: '稳健方案', summary: '先做 10% 灰度，验证后再扩大。', keyPoints: ['先验证', '周期长'], tradeoffs: '见效慢' },
  ],
  recommendedId: 'B',
  openQuestions: ['灰度指标怎么定？'],
})

/** Default script: clerk two proposals, 3 of 4 roles vote B, roles speak by round. */
function scriptedReply(options) {
  const system = options.system ?? ''
  const user = options.user ?? ''
  if (system.includes('书记员')) return CLERK_REPLY
  if (system.includes('用一票决定')) {
    const dissenter = system.includes('用户代表')
    return JSON.stringify({ proposalId: dissenter ? 'A' : 'B', reason: '按方案的风险可控程度判断。' })
  }
  const round = /第 (\d+)\/(\d+) 轮/.exec(user)?.[1] ?? '1'
  return `（第${round}轮发言）我倾向先小规模验证再扩大投入，因为主要风险集中在后期不可逆成本上。`
}

/** Tie script: two roles always vote for different proposals. */
function tieReply(options) {
  const system = options.system ?? ''
  if (system.includes('书记员')) {
    return JSON.stringify({
      proposals: [{ title: '立即执行', summary: '本月内完成全部动作。' }, { title: '暂缓观察', summary: '保留预算，等下一季度再定。' }],
      recommendedId: 'B',
      openQuestions: [],
    })
  }
  if (system.includes('用一票决定')) {
    return JSON.stringify({ proposalId: system.includes('技术负责人') ? 'B' : 'A', reason: '立场不同。' })
  }
  return '我的发言：两边的说法我都不完全同意。'
}

function createFakeContext({ root, reply = scriptedReply, web = true }) {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    get(name) {
      if (name === 'llm') return { stream: (options) => fakeStream(reply(options)) }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }
      if (name === 'web' && web) {
        return { search: async () => ({ sources: [{ url: 'https://example.com/a', title: '示例资料', snippet: '一点背景' }], truncated: false }) }
      }
      return undefined
    },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    effect: (factory) => factory(),
  }
  return { ctx, routes }
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

async function waitForRun(routes, id, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const { data } = await call(routes, `/run?id=${encodeURIComponent(id)}`)
    if (data.run.status !== 'running') return data.run
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('run did not finish in time')
}

async function tempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

// ---------------------------------------------------------------------- run

async function main() {
  // --- pure helpers ---
  const parsed = extractJson('前言\n```json\n{"proposals":[{"title":"甲","summary":"做甲"}],"recommendedId":"A"}\n```')
  check('extractJson 能穿过代码块与前缀', parsed?.proposals?.[0]?.title === '甲', parsed)
  check('extractJson 容忍尾随逗号', Boolean(extractJson('{"a":[1,2,]}')), null)

  const proposals = normalizeProposals([{ title: 'A', summary: 'x' }, { title: 'B', summary: 'y' }, { title: '' }])
  check('候选方案按出现顺序重编 ID', proposals.length === 2 && proposals[1].id === 'B', proposals)

  const roles = normalizeRoles([
    { name: '甲', persona: '一二三四五六七八九十一二三四五六七八九十' },
    { name: '甲', persona: '一二三四五六七八九十一二三四五六七八九十' },
  ])
  check('重名角色得到不同 ID', roles[0].id !== roles[1].id, roles)

  let rejection = ''
  try {
    normalizeRoles([{ name: '甲', persona: '短' }])
  } catch (error) {
    rejection = error.message
  }
  check('立场太短会被拒绝', rejection.includes('太短'), rejection)

  // --- one full debate: 2 rounds × 4 roles, clerk, 4 votes, conclusion ---
  const root = await tempRoot('rtr-')
  const { ctx, routes } = createFakeContext({ root })
  apply(ctx, { root, researchMaxResults: 6, maxHistory: 40 })
  check('注册了 roundtable 路由', routes.has('/api/issue-roundtable/state'), [...routes.keys()])

  const state = await call(routes, '/state')
  check('初始角色是内置的四位', state.data.roles.length === 4 && state.data.roles[0].name === defaultRoles()[0].name, state.data.roles)
  check('初始模型可读', state.data.model?.provider === 'fake', state.data.model)

  const started = await call(routes, '/start', {
    method: 'POST',
    body: { topic: '是否把移动端改成 H5，预算 300 万', rounds: 2, roleIds: state.data.roles.map((role) => role.id), research: true },
  })
  check('开始讨论返回 runId', started.status === 200 && Boolean(started.data.runId), started.data)

  const finished = await waitForRun(routes, started.data.runId)
  check('讨论正常结束', finished.status === 'done', { status: finished.status, error: finished.error })
  check('2 轮 × 4 角色 = 8 条发言', finished.turns.length === 8, finished.turns.length)
  check('发言落在正确轮次', finished.turns[7].round === 2, finished.turns[7])
  check('每位角色每轮都带立场发言', finished.turns.every((turn) => !turn.error && turn.text.length > 0), finished.turns.map((t) => t.error))
  check('拿到联网资料', finished.research?.sources?.length === 1, finished.research)
  check('书记员产出 2 个候选方案', finished.proposals.length === 2, finished.proposals)
  check('每位角色投出一票', finished.votes.length === 4 && finished.votes.every((vote) => vote.proposalId), finished.votes)
  check('结论是多数票方案', finished.conclusion?.proposalId === 'B', finished.conclusion)
  check('结论记录票数与少数意见', finished.conclusion?.counts?.B === 3 && finished.conclusion.dissent.length >= 1, finished.conclusion)

  const history = await call(routes, '/history')
  check('历史写入了这场讨论', history.data.history.length === 1 && history.data.history[0].id === started.data.runId, history.data.history)

  const debate = await call(routes, `/debate?id=${started.data.runId}`)
  check('可按 ID 重新读到完整讨论', debate.data.debate.turns.length === 8, debate.data.debate?.turns?.length)

  // --- tie -> runoff -> conclusion ---
  const tieRoot = await tempRoot('rtr-tie-')
  const tie = createFakeContext({ root: tieRoot, reply: tieReply, web: false })
  apply(tie.ctx, { root: tieRoot, researchMaxResults: 6, maxHistory: 40 })
  const tieState = await call(tie.routes, '/state')
  const tieStart = await call(tie.routes, '/start', {
    method: 'POST',
    body: { topic: '要不要现在裁员', rounds: 1, roleIds: tieState.data.roles.slice(0, 2).map((role) => role.id), research: true },
  })
  const tieRun = await waitForRun(tie.routes, tieStart.data.runId)
  check('没有检索服务时降级为说明', tieRun.research?.available === false, tieRun.research)
  check('1:1 平票进入复选', Array.isArray(tieRun.runoffVotes) && tieRun.runoffVotes.length === 2, tieRun.runoffVotes?.length)
  check('复选仍平票时给出结论', Boolean(tieRun.conclusion) && tieRun.tally.tie === true, { tally: tieRun.tally, error: tieRun.error })
  check('平票结论说明由谁裁定', String(tieRun.conclusion?.note ?? '').includes('书记员'), tieRun.conclusion?.note)

  // --- validation and errors ---
  const badStart = await call(routes, '/start', { method: 'POST', body: { topic: '短', rounds: 2 } })
  check('过短议题被拒绝', badStart.status === 400 && badStart.data.error.includes('太短'), badStart.data)

  const badRoles = await call(routes, '/roles', { method: 'POST', body: { roles: [{ name: '', persona: 'x' }] } })
  check('空名称被拒绝', badRoles.status === 400, badRoles.data)

  const badRounds = await call(routes, '/settings', { method: 'POST', body: { rounds: 9 } })
  check('非法轮数被拒绝', badRounds.status === 400, badRounds.data)

  const missing = await call(routes, '/run?id=nope')
  check('未知 run 返回 404', missing.status === 404, missing.data)

  await rm(root, { recursive: true, force: true })
  await rm(tieRoot, { recursive: true, force: true })

  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  → ${JSON.stringify(item.detail)}`}`)
  }
  console.log(`\n${checks.filter((item) => item.ok).length}/${checks.length} 项通过`)
  if (failures) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
