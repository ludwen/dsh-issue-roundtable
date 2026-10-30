// End-to-end acceptance against a running Host: starts a real debate through
// /api/issue-roundtable, polls it, and asserts the transcript, proposals,
// votes and conclusion are real model output.
//
//   node test/live.mjs "http://127.0.0.1:43129/?token=<launch-token>"
//
// It really calls the configured model, so it costs tokens and takes a minute
// or two. Without a token URL it reads the most recent one from the Desktop log.
import { readFileSync } from 'node:fs'

const LOG = `${process.env.APPDATA}/dsh-desktop/logs/harness.log`

function lastTokenUrl() {
  const lines = readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes('dsh web: http'))
  const last = lines.at(-1)
  return last?.match(/https?:\/\/\S+/)?.[0]
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
  const response = await fetch(origin + path, {
    ...init,
    headers: { cookie, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${data.error ?? ''}`)
  return data
}

const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

await login()
console.log('authenticated against', origin)

const state = await api('/api/issue-roundtable/state')
check('宿主路由可读，返回内置角色', state.roles?.length >= 2, state.roles?.length)
check('当前有可用模型', Boolean(state.model?.provider), state.model)

const topic = `是否应该把议题圆桌的默认轮数从 3 轮提高到 4 轮（验收 ${new Date().toISOString().slice(11, 19)}）`
const started = await api('/api/issue-roundtable/start', {
  method: 'POST',
  body: JSON.stringify({ topic, rounds: 1, research: false, roleIds: ['product', 'engineering'] }),
})
check('start 返回 runId 且立刻处于 running', Boolean(started.runId) && started.run?.status === 'running', started.runId)

const deadline = Date.now() + 8 * 60 * 1000
let run = started.run
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 6000))
  run = (await api(`/api/issue-roundtable/run?id=${encodeURIComponent(started.runId)}`)).run
  process.stdout.write(`  ${run.stage} 轮次=${run.round} 发言=${run.turns.length}\n`)
  if (run.status !== 'running') break
}

check('讨论正常结束', run.status === 'done', { status: run.status, error: run.error })
check('每位角色都产生了真实发言', run.turns.length === 2 && run.turns.every((turn) => !turn.error && turn.text.length > 60),
  run.turns.map((turn) => `${turn.roleName}:${turn.error ?? turn.text.length}`))
check('发言确实回应了前一位角色', /(上面|前面|产品经理|技术负责人|同意|反对)/.test(run.turns[1]?.text ?? ''), run.turns[1]?.text?.slice(0, 80))
check('书记员给出 2~4 个候选方案', run.proposals.length >= 2 && run.proposals.length <= 4, run.proposals.length)
check('候选方案之间有实质区别', new Set(run.proposals.map((item) => item.title)).size === run.proposals.length, run.proposals.map((item) => item.title))
check('每位角色投出一票且带理由', run.votes.length === 2 && run.votes.every((vote) => vote.proposalId && vote.reason),
  run.votes.map((vote) => `${vote.roleName}->${vote.proposalId}`))
check('结论来自多数票', Boolean(run.conclusion?.proposalId) && run.conclusion.counts[run.conclusion.proposalId] > 0,
  run.conclusion?.counts)
check('讨论写入了历史记录', (await api('/api/issue-roundtable/history')).history.some((item) => item.id === started.runId))

console.log('\n议题：', topic)
console.log('结论：', `${run.conclusion?.proposalId}. ${run.conclusion?.title}`)
console.log('方案要点：', run.conclusion?.summary?.slice(0, 160))
console.log('票数：', JSON.stringify(run.conclusion?.counts))
console.log('用时：', `${Math.round((run.elapsedMs ?? 0) / 1000)} 秒`)

for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  → ${JSON.stringify(item.detail)}`}`)
const failed = results.filter((item) => !item.ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
if (failed) process.exitCode = 1
