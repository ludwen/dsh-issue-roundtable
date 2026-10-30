// Shared helpers for the roundtable panel.
// Plain functions only — no JSX — so the bundle stays a single readable file.

const API = '/api/issue-roundtable'

async function api(path, init) {
  const response = await fetch(API + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json', ...(init.headers || {}) } }),
  })
  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`)
  return data
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

const initialOf = (name) => String(name ?? '').trim().slice(0, 1) || '?'

function elapsedText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

function relativeTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - Date.parse(iso)
  if (!Number.isFinite(diff)) return ''
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(iso).toLocaleDateString()
}

/** Deterministic pastel color for one role, kept stable across reloads. */
function roleColor(id) {
  const palette = ['#4C6FFF', '#12A594', '#B45309', '#8E4EC6', '#0E7C86', '#C2410C', '#2F6F3E', '#A31621', '#455A64', '#7C4DFF']
  const text = String(id ?? '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100000
  return palette[hash % palette.length]
}

const STATUS = {
  draft: { label: '未开始', tone: 'idle' },
  running: { label: '讨论中', tone: 'busy' },
  voting: { label: '表决中', tone: 'busy' },
  discussing: { label: '待决定', tone: 'warn' },
  decided: { label: '已表决', tone: 'done' },
  failed: { label: '失败', tone: 'error' },
  cancelled: { label: '已取消', tone: 'idle' },
}

const STAGE_LABEL = {
  research: '检索资料',
  debate: '角色发言',
  synthesis: '书记员收敛',
  vote: '全体表决',
  runoff: '平票复选',
  idle: '',
}

/** Split long speech text into paragraphs; keeps the model's own line breaks. */
const paragraphs = (text) =>
  String(text ?? '')
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean)

/** Preview: first N characters of the first paragraph, single line. */
function preview(text, limit = 90) {
  const first = paragraphs(text)[0] ?? ''
  return first.length > limit ? `${first.slice(0, limit)}…` : first
}

export { API, api, post, initialOf, elapsedText, relativeTime, roleColor, STATUS, STAGE_LABEL, paragraphs, preview }
