// End-to-end acceptance against a running Host: creates an issue, speaks the
// planned rounds, CONTINUES past the plan, then votes — asserting real model
// output at every step. Costs tokens and takes a few minutes.
//
//   node test/live.mjs "http://127.0.0.1:43129/?token=<launch-token>"
import { readFileSync } from 'node:fs'

const LOG = `${process.env.APPDATA}/dsh-desktop/logs/harness.log`

function lastTokenUrl() {
  const lines = readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((line) => line.includes('dsh web: http'))
  return lines.at(-1)?.match(/https?:\/\/\S+/)?.[0]
}

const baseUrl = process.argv[2] ?? lastTokenUrl()
if (!baseUrl) throw new Error('no launch token URL found; pass one explicitly')
const origin = new URL(baseUrl).origin
let cookie = ''

async function login() {
  const response = await fetch(baseUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error(`no auth cookie from ${baseUrl} (status ${response.status})`)
  cookie = setCookie.split(';')[0]
}

async function api(path, init = {}) {
  const response = await fetch(`${origin}/api/issue-roundtable${path}`, {
    ...init,
    headers: { cookie, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${data.error ?? ''}`)
  return data
}

const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

async function waitSettled(id, label, timeoutMs = 12 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  let issue
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    issue = (await api(`/issue?id=${encodeURIComponent(id)}`)).issue
    process.stdout.write(`  ${label} ${issue.status}/${issue.stage} 轮次=${issue.round}/${issue.plannedRounds} 发言=${issue.turns.length}\n`)
    if (issue.status !== 'running' && issue.status !== 'voting') return issue
  }
  throw new Error(`${label} did not settle in time`)
}

await login()
console.log('authenticated against', origin)

const state = await api('/state')
check('宿主路由可读', state.groups?.length === 3 && state.roles?.length >= 4, { groups: state.groups?.length, roles: state.roles?.length })
check('当前有可用模型', Boolean(state.model?.provider), state.model)

// 1) AI designs a role on the live host.
const roleAssist = await api('/assist/role', {
  method: 'POST',
  body: JSON.stringify({
    input: '我需要一个只关心一线客服压力和执行成本的人',
    existingNames: state.roles.map((role) => role.name),
    groupName: '客户与一线',
  }),
})
check('AI 角色助手返回候选', roleAssist.suggestions?.length >= 1, roleAssist.suggestions?.length)
check('候选角色字段完整', roleAssist.suggestions?.every((item) => item.name && item.focus && item.persona.length >= 40), roleAssist.suggestions?.[0]?.name)

// 2) AI drafts an issue over two turns.
const draft1 = await api('/assist/issue', {
  method: 'POST',
  body: JSON.stringify({ input: '我们要不要给圆桌加一个「自由辩论」模式，让角色可以互相追问' }),
})
check('议题助手第一轮会追问', draft1.ready === false && draft1.reply.length > 10, draft1.reply?.slice(0, 60))
const draft2 = await api('/assist/issue', {
  method: 'POST',
  body: JSON.stringify({
    input: '限制每角色最多追问两次，整体不超过 8 轮，超时要强制收敛',
    history: [
      { role: 'user', content: '我们要不要给圆桌加一个自由辩论模式' },
      { role: 'assistant', content: draft1.reply },
    ],
  }),
})
check('议题助手多轮后定稿', draft2.ready === true, draft2.ready)
check('定稿有标题/背景/目标', Boolean(draft2.draft?.title && draft2.draft.background && draft2.draft.goal), draft2.draft?.title)

// 3) Create the issue with a deliberate participant order.
const created = await api('/issue/create', {
  method: 'POST',
  body: JSON.stringify({
    title: draft2.draft.title,
    background: draft2.draft.background,
    goal: draft2.draft.goal,
    checklist: draft2.draft.checklist,
    roleIds: ['engineering', 'product'],
    plannedRounds: 1,
    research: true,
  }),
})
const issueId = created.issue.id
check('创建议题成功', Boolean(issueId) && created.issue.status === 'draft', created.issue.status)
check(
  '参与顺序按选择冻结（技术先于产品）',
  created.issue.participants.map((role) => role.roleId).join('>') === 'engineering>product',
  created.issue.participants.map((role) => role.roleId),
)

await api('/issue/start', { method: 'POST', body: JSON.stringify({ id: issueId }) })
let issue = await waitSettled(issueId, '首轮')
check('首轮讨论结束', issue.status === 'discussing' && issue.turns.length === 2, { status: issue.status, turns: issue.turns.length })
check('发言是真实模型产出', issue.turns.every((turn) => !turn.error && turn.text.length > 60), issue.turns.map((turn) => turn.text.length))
check('第二位发言回应了第一位', /(技术|上面|刚才|你提到|同意|反对)/.test(issue.turns[1].text), issue.turns[1].text.slice(0, 50))

// 4) Continue past the plan — the core new capability.
const beforeTurns = issue.turns.length
await api('/issue/continue', { method: 'POST', body: JSON.stringify({ id: issueId, rounds: 1 }) })
issue = await waitSettled(issueId, '追加')
check('追加轮次后总发言增加', issue.turns.length === beforeTurns + 2, { before: beforeTurns, after: issue.turns.length })
check('追加轮次进入第 2 轮', issue.round === 2 && issue.turns.at(-1).round === 2, issue.turns.at(-1)?.round)
check('追加轮次计划轮数累加', issue.plannedRounds === 2, issue.plannedRounds)
check('追加发言不是重复上一轮', issue.turns.at(-1).text !== issue.turns[0].text, null)

// 5) Vote.
await api('/issue/vote', { method: 'POST', body: JSON.stringify({ id: issueId }) })
issue = await waitSettled(issueId, '表决')
check('书记员产出候选方案', issue.proposals.length >= 2, issue.proposals.length)
check('每位角色投出一票', issue.votes.length === 2 && issue.votes.every((vote) => vote.proposalId && vote.reason), issue.votes?.length)
check('产生结论', Boolean(issue.conclusion?.title), issue.conclusion?.title)
check(
  '结论记录票数',
  Object.values(issue.conclusion?.counts ?? {}).reduce((sum, value) => sum + value, 0) > 0,
  issue.conclusion?.counts,
)

// 6) Continue after a verdict -> the conclusion is marked stale, not deleted.
await api('/issue/continue', { method: 'POST', body: JSON.stringify({ id: issueId, rounds: 1 }) })
issue = await waitSettled(issueId, '结论后追加')
check('结论后追加会把结论标记为待复核', issue.conclusion?.stale === true, issue.conclusion?.stale)
check('旧结论内容仍保留', Boolean(issue.conclusion?.title), issue.conclusion?.title)

// 7) The list summary reflects the meeting.
const list = await api('/state')
const listed = list.issues.find((item) => item.id === issueId)
check('议题列表反映轮次与发言数', listed.turnCount === issue.turns.length && listed.round === issue.round, listed)

console.log('\n议题：', issue.title)
console.log('发言数：', issue.turns.length, '· 轮次：', `${issue.round}/${issue.plannedRounds}`)
console.log('结论：', `${issue.conclusion?.proposalId}. ${issue.conclusion?.title}`, '（待复核）')
console.log('票数：', JSON.stringify(issue.conclusion?.counts))

for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  → ${JSON.stringify(item.detail)}`}`)
const failed = results.filter((item) => !item.ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
if (failed) process.exitCode = 1
