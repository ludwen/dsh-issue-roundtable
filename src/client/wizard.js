// Issue wizard: AI drafts the issue over several turns, the user confirms it,
// picks roles (optionally by group), then orders the speaking sequence and
// sets the planned rounds.

import { paragraphs, roleColor, initialOf } from './shared.js'

export function createWizard(React, { api, post }) {
  const h = React.createElement

  function AssistantChat({ onDraft }) {
    const [input, setInput] = React.useState('')
    const [log, setLog] = React.useState([])
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')

    const send = async () => {
      const text = input.trim()
      if (!text || busy) return
      setBusy(true)
      setError('')
      const nextLog = [...log, { role: 'user', content: text }]
      setLog(nextLog)
      setInput('')
      try {
        const data = await post('/assist/issue', {
          input: text,
          history: log,
          draft: onDraft.current ? onDraft.current() : null,
        })
        setLog([...nextLog, { role: 'assistant', content: data.reply, ready: data.ready }])
        if (data.draft) onDraft.apply(data.draft, data.ready)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusy(false)
      }
    }

    return h(
      'div',
      { className: 'rtr-assist' },
      h('div', { className: 'rtr-assist-hint' },
        h('strong', null, 'AI 帮你写议题'),
        h('span', { className: 'rtr-hint' }, '先把想法说出来，AI 会追问关键信息，再逐轮打磨成可直接讨论的议题。')),
      log.length
        ? h('div', { className: 'rtr-chat' },
            log.map((message, index) =>
              h('div', { key: index, className: 'rtr-chat-msg', 'data-role': message.role },
                h('span', { className: 'rtr-chat-who' }, message.role === 'user' ? '你' : '议题顾问'),
                h('div', { className: 'rtr-chat-text' }, paragraphs(message.content).map((part, at) => h('p', { key: at }, part))),
                message.ready ? h('span', { className: 'rtr-tag' }, '已可定稿') : null)))
        : null,
      error ? h('div', { className: 'rtr-error' }, error) : null,
      h('div', { className: 'rtr-chat-input' },
        h('textarea', {
          className: 'rtr-textarea',
          rows: 2,
          placeholder: log.length ? '回答或补充要求…' : '例如：我们纠结要不要把移动端改成 H5，预算 300 万左右，Q1 想上线',
          value: input,
          onChange: (event) => setInput(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          },
        }),
        h('button', { className: 'rtr-btn rtr-btn-primary', onClick: send, disabled: busy || !input.trim() }, busy ? '思考中…' : '发送')),
      h('span', { className: 'rtr-hint' }, 'Ctrl/⌘ + Enter 发送'),
    )
  }

  function RolePicker({ state, selected, onToggle, onOrder }) {
    const [groupId, setGroupId] = React.useState('all')
    const [dragIndex, setDragIndex] = React.useState(null)
    const groups = state.groups
    const roles = state.roles.filter((role) => groupId === 'all' || role.groupId === groupId)
    const ordered = selected.map((id) => state.roles.find((role) => role.id === id)).filter(Boolean)
    const move = (from, to) => {
      const next = [...selected]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      onOrder(next)
    }

    return h(
      'div',
      { className: 'rtr-picker' },
      h('div', { className: 'rtr-row rtr-filter-row' },
        h('button', { className: 'rtr-pill', 'data-on': groupId === 'all' ? '' : undefined, onClick: () => setGroupId('all') }, '全部分组'),
        groups.map((group) =>
          h('button', { key: group.id, className: 'rtr-pill', 'data-on': groupId === group.id ? '' : undefined, onClick: () => setGroupId(group.id) },
            `${group.name}（${state.roles.filter((role) => role.groupId === group.id).length}）`))),
      h('div', { className: 'rtr-roles' },
        roles.map((role) => {
          const index = selected.indexOf(role.id)
          return h(
            'button',
            {
              key: role.id,
              className: 'rtr-role',
              'data-on': index >= 0 ? '' : undefined,
              onClick: () => onToggle(role.id),
              type: 'button',
            },
            h('span', { className: 'rtr-turn-avatar', style: { background: roleColor(role.id) }, 'aria-hidden': true }, initialOf(role.name)),
            h('div', { style: { minWidth: 0, textAlign: 'left' } },
              h('strong', null, role.name),
              h('small', null, role.focus || '未设置关注点'),
              h('small', { className: 'rtr-role-clamp' }, role.persona)),
            index >= 0 ? h('span', { className: 'rtr-order-badge' }, `${index + 1}`) : null,
          )
        })),
      ordered.length
        ? h(
            'div',
            { className: 'rtr-order' },
            h('div', { className: 'rtr-hint' }, `发言顺序（拖拽或点箭头调整，共 ${ordered.length} 位）`),
            ordered.map((role, index) =>
              h(
                'div',
                {
                  key: role.id,
                  className: 'rtr-order-item',
                  draggable: true,
                  onDragStart: () => setDragIndex(index),
                  onDragOver: (event) => event.preventDefault(),
                  onDrop: () => {
                    if (dragIndex !== null) move(dragIndex, index)
                    setDragIndex(null)
                  },
                },
                h('span', { className: 'rtr-order-num' }, `${index + 1}`),
                h('span', { className: 'rtr-turn-avatar', style: { background: roleColor(role.id) }, 'aria-hidden': true }, initialOf(role.name)),
                h('span', { className: 'rtr-order-name' }, role.name),
                h('span', { className: 'rtr-hint', style: { flex: 1 } }, role.focus || ''),
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => index > 0 && move(index, index - 1), disabled: index === 0 }, '↑'),
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => index < ordered.length - 1 && move(index, index + 1), disabled: index === ordered.length - 1 }, '↓'),
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => onToggle(role.id) }, '✕'),
              ),
            ),
          )
        : h('div', { className: 'rtr-hint' }, '至少选择 2 个角色；选中后在这里调整发言顺序。'),
    )
  }

  function IssueWizard({ state, onCancel, onCreate, busy, error }) {
    const [tab, setTab] = React.useState('assist')
    const [draft, setDraft] = React.useState({ title: '', background: '', goal: '', checklist: [] })
    const [selected, setSelected] = React.useState([])
    const [rounds, setRounds] = React.useState(3)
    const [research, setResearch] = React.useState(true)
    const draftRef = React.useRef(draft)
    draftRef.current = draft
    const readyRef = React.useRef(false)

    const onDraft = {
      current: () => draftRef.current,
      apply: (next, ready) => {
        setDraft(next)
        readyRef.current = ready
        if (next?.title) setTab('manual')
      },
    }

    const toggle = (id) =>
      setSelected((current) => {
        if (current.includes(id)) return current.filter((item) => item !== id)
        if (current.length >= (state.limits?.maxParticipants ?? 8)) return current
        return [...current, id]
      })

    const canCreate = draft.title.trim().length >= 4 && selected.length >= 2

    return h(
      'div',
      { className: 'rtr-view rtr-wizard' },
      h('div', { className: 'rtr-detail-head' },
        h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: onCancel }, '‹ 返回议题列表'),
        h('h2', null, '新议题')),
      h('div', { className: 'rtr-tabs' },
        h('button', { className: 'rtr-tab', 'data-on': tab === 'assist' ? '' : undefined, onClick: () => setTab('assist') }, 'AI 起草'),
        h('button', { className: 'rtr-tab', 'data-on': tab === 'manual' ? '' : undefined, onClick: () => setTab('manual') }, '议题内容'),
        h('button', { className: 'rtr-tab', 'data-on': tab === 'roles' ? '' : undefined, onClick: () => setTab('roles') }, `角色与顺序（${selected.length}）`)),

      tab === 'assist' ? h(AssistantChat, { onDraft }) : null,

      tab === 'manual'
        ? h('div', { className: 'rtr-form' },
            h('label', { className: 'rtr-field' }, h('span', null, '议题（一个可以被赞成或反对的问题）'),
              h('input', { className: 'rtr-input', value: draft.title, maxLength: 200,
                placeholder: '例如：是否在 Q1 内投入 300 万把移动端从原生迁到 H5',
                onChange: (event) => setDraft({ ...draft, title: event.target.value }) })),
            h('label', { className: 'rtr-field' }, h('span', null, '背景（现状、约束、为什么现在讨论）'),
              h('textarea', { className: 'rtr-textarea', rows: 4, maxLength: 2000, value: draft.background,
                onChange: (event) => setDraft({ ...draft, background: event.target.value }) })),
            h('label', { className: 'rtr-field' }, h('span', null, '希望产出（要可判断，例如「决定是否投入与节奏」）'),
              h('input', { className: 'rtr-input', maxLength: 600, value: draft.goal,
                onChange: (event) => setDraft({ ...draft, goal: event.target.value }) })),
            draft.checklist?.length
              ? h('div', { className: 'rtr-field' }, h('span', null, '核对清单（AI 标出的待确认点）'),
                  h('ul', { className: 'rtr-points' }, draft.checklist.map((item, index) => h('li', { key: index }, item)))
                )
              : null,
          )
        : null,

      tab === 'roles'
        ? h('div', { className: 'rtr-form' },
            h(RolePicker, { state, selected, onToggle: toggle, onOrder: setSelected }),
            h('div', { className: 'rtr-row rtr-settings-row' },
              h('span', { className: 'rtr-hint' }, '计划轮数'),
              [1, 2, 3, 4, 5, 6, 7, 8].map((count) =>
                h('button', { key: count, className: 'rtr-pill', 'data-on': rounds === count ? '' : undefined, onClick: () => setRounds(count) }, `${count} 轮`)),
              h('span', { className: 'rtr-spacer' }),
              h('button', { className: 'rtr-pill', 'data-on': research ? '' : undefined, onClick: () => setResearch(!research) },
                research ? '联网检索：开' : '联网检索：关')),
            h('p', { className: 'rtr-hint' },
              '轮数只是起点：讨论跑完后可以继续追加轮次，直到大家都收敛再表决。'),
          )
        : null,

      error ? h('div', { className: 'rtr-error' }, error) : null,

      h('div', { className: 'rtr-wizard-foot' },
        h('div', { className: 'rtr-hint' },
          `议题「${draft.title.trim() || '未填写'}」 · ${selected.length} 位角色 · ${rounds} 轮`),
        h('button', {
          className: 'rtr-btn rtr-btn-primary',
          disabled: busy || !canCreate,
          onClick: () => onCreate({ title: draft.title.trim(), background: draft.background.trim(), goal: draft.goal.trim(), checklist: draft.checklist, roleIds: selected, plannedRounds: rounds, research }),
        }, busy ? '创建中…' : '创建议题')),
      !canCreate ? h('p', { className: 'rtr-hint rtr-wizard-tip' },
        ['需要填写议题标题（至少 4 字）', '需要至少 2 个角色'].filter((_, index) => (index === 0 ? draft.title.trim().length < 4 : selected.length < 2)).join('；')) : null,
    )
  }

  return { IssueWizard, RolePicker, AssistantChat }
}
