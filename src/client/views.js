// The three list/detail views: issue list, issue detail, and the conclusion card.
// Long transcripts are handled with a density switch, a role filter, a round
// jump bar, per-turn collapse, and a full-text drawer.

import { paragraphs, preview, relativeTime, roleColor, initialOf, STATUS, STAGE_LABEL, elapsedText } from './shared.js'

export function createViews(React, { RoundTable, SeatStrip, Markdownish }) {
  const h = React.createElement

  function StatusPill({ status, stale }) {
    const meta = STATUS[status] ?? { label: status, tone: 'idle' }
    return h('span', { className: 'rtr-status', 'data-tone': meta.tone }, meta.label, stale ? ' · 结论待复核' : '')
  }

  // ---------------------------------------------------------------- issue list

  function IssueList({ state, onOpen, onCreate, onDelete, busy }) {
    const [query, setQuery] = React.useState('')
    const [filter, setFilter] = React.useState('all')
    const issues = state.issues.filter((issue) => {
      if (filter !== 'all' && issue.status !== filter) return false
      if (!query.trim()) return true
      const haystack = `${issue.title} ${issue.goal} ${issue.participants.map((role) => role.name).join(' ')}`
      return haystack.toLowerCase().includes(query.trim().toLowerCase())
    })

    return h(
      'div',
      { className: 'rtr-view' },
      h(
        'div',
        { className: 'rtr-list-head' },
        h('div', null,
          h('h2', null, '议题'),
          h('p', { className: 'rtr-hint' }, `${state.issues.length} 个议题 · 每个议题就是一场圆桌会议`)),
        h('div', { className: 'rtr-row' },
          h('input', {
            className: 'rtr-input rtr-search',
            placeholder: '搜索议题、角色…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { className: 'rtr-btn rtr-btn-primary', onClick: onCreate, disabled: busy }, '新建议题'),
        ),
      ),
      h(
        'div',
        { className: 'rtr-filter-row' },
        [['all', '全部'], ['draft', '未开始'], ['discussing', '待决定'], ['running', '讨论中'], ['voting', '表决中'], ['decided', '已表决']].map(([key, label]) =>
          h('button', { key, className: 'rtr-pill', 'data-on': filter === key ? '' : undefined, onClick: () => setFilter(key) }, label)),
      ),
      issues.length === 0
        ? h('div', { className: 'rtr-empty' },
            h('div', null, filter === 'all' && !query ? '还没有议题。从「新建议题」开始：可以用 AI 帮你把想法写成议题。' : '没有符合条件的议题。'),
            h('div', { style: { marginTop: 10 } }, h('button', { className: 'rtr-btn rtr-btn-primary', onClick: onCreate, disabled: busy }, '新建议题')))
        : h('div', { className: 'rtr-issue-list' },
            issues.map((issue) =>
              h(
                'article',
                { key: issue.id, className: 'rtr-issue', 'data-status': issue.status },
                h(
                  'button',
                  { className: 'rtr-issue-main', onClick: () => onOpen(issue.id) },
                  h('div', { className: 'rtr-issue-title' },
                    h('strong', null, issue.title),
                    issue.conclusionStale ? h('span', { className: 'rtr-tag' }, '结论待复核') : null),
                  h('div', { className: 'rtr-issue-meta' },
                    h(StatusPill, { status: issue.status }),
                    h('span', { className: 'rtr-hint' },
                      `${issue.round}/${issue.plannedRounds} 轮 · ${issue.turnCount} 条发言 · ${relativeTime(issue.updatedAt)}`),
                    issue.conclusionTitle && !issue.conclusionStale
                      ? h('span', { className: 'rtr-hint rtr-issue-conclusion' }, `结论：${issue.conclusionTitle}`)
                      : null,
                  ),
                  h(SeatStrip, { participants: issue.participants, turns: [] }),
                ),
                h('button', { className: 'rtr-btn rtr-btn-ghost rtr-issue-delete', onClick: () => onDelete(issue), title: '删除议题' }, '删除'),
              ),
            ),
          ),
    )
  }

  // -------------------------------------------------------------- issue detail

  function Turn({ turn, dense, expanded, onToggle }) {
    const collapsed = !dense && !expanded
    return h(
      'div',
      { className: 'rtr-turn', 'data-dense': dense ? '' : undefined },
      h('span', { className: 'rtr-turn-avatar', style: { background: roleColor(turn.roleId) }, 'aria-hidden': true }, initialOf(turn.roleName)),
      h(
        'div',
        { className: 'rtr-turn-body' },
        h('div', { className: 'rtr-turn-head' },
          h('strong', null, turn.roleName),
          h('span', { className: 'rtr-hint' }, `第 ${turn.round} 轮`)),
        turn.error
          ? h('div', { className: 'rtr-turn-error' }, `这次发言失败：${turn.error}`)
          : h(
              'div',
              { className: collapsed ? 'rtr-turn-text rtr-clamped' : 'rtr-turn-text' },
              paragraphs(turn.text).map((part, index) => h('p', { key: index }, part)),
            ),
        !dense && !turn.error
          ? h('button', { className: 'rtr-btn rtr-btn-ghost rtr-turn-toggle', onClick: () => onToggle(turn) }, expanded ? '收起' : '展开全文')
          : null,
      ),
    )
  }

  function Transcript({ issue, roleFilter, roundFilter, dense, onRoleFilter, onRoundFilter, onDensity, onOpenDrawer }) {
    const [expandedKey, setExpandedKey] = React.useState(null)
    const rounds = [...new Set(issue.turns.map((turn) => turn.round))]
    const turns = issue.turns.filter((turn) => (!roleFilter || turn.roleId === roleFilter) && (!roundFilter || turn.round === roundFilter))

    return h(
      'div',
      { className: 'rtr-transcript' },
      h(
        'div',
        { className: 'rtr-transcript-bar' },
        h('div', { className: 'rtr-row' },
          h('span', { className: 'rtr-hint' }, '轮次'),
          h('button', { className: 'rtr-pill', 'data-on': roundFilter === null ? '' : undefined, onClick: () => onRoundFilter(null) }, '全部'),
          rounds.map((round) =>
            h('button', { key: round, className: 'rtr-pill', 'data-on': roundFilter === round ? '' : undefined, onClick: () => onRoundFilter(round) }, `第 ${round} 轮`)),
          h('span', { className: 'rtr-spacer' }),
          h('button', { className: 'rtr-pill', 'data-on': dense ? '' : undefined, onClick: () => onDensity(dense ? 'comfy' : 'dense') }, dense ? '紧凑' : '详细'),
          h('button', { className: 'rtr-pill', onClick: () => onOpenDrawer() }, '全屏阅读'),
        ),
        roleFilter
          ? h('div', { className: 'rtr-row rtr-filter-note' },
              h('span', null, `只看「${issue.participants.find((role) => role.roleId === roleFilter)?.name ?? ''}」`),
              h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => onRoleFilter(null) }, '取消筛选'))
          : null,
      ),
      turns.length === 0
        ? h('div', { className: 'rtr-empty' }, '这个筛选下还没有发言。')
        : turns.map((turn) => {
            const key = `${turn.round}-${turn.roleId}-${turn.at}`
            return h(Turn, {
              key,
              turn,
              dense,
              expanded: expandedKey === key,
              onToggle: () => setExpandedKey(expandedKey === key ? null : key),
            })
          }),
    )
  }

  function verifyDrawer({ open, onClose, title, body, issue }) {
    if (!open) return null
    return h(
      'div',
      { className: 'rtr-drawer-backdrop', onClick: onClose, role: 'presentation' },
      h(
        'aside',
        { className: 'rtr-drawer', onClick: (event) => event.stopPropagation(), 'aria-label': '全文阅读' },
        h('header', { className: 'rtr-drawer-head' },
          h('strong', null, title),
          h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: onClose }, '关闭')),
        h('div', { className: 'rtr-drawer-body' }, body),
      ),
    )
  }

  return { StatusPill, IssueList, Transcript, Turn, verifyDrawer }
}
