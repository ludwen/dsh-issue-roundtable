// The roundtable: participants sit around an ellipse, the current speaker's
// bubble grows in the middle. Clicking a seat filters the transcript to that
// role; hovering a seat previews their last line.

export function createRoundTable(React, { roleColor, initialOf, paragraphs, preview }) {
  const h = React.createElement

  /**
   * @param {object} props
   * @param {Array} props.participants frozen participant order
   * @param {Array} props.turns every turn so far
   * @param {object} props.speaking current speaker (or null)
   * @param {string} props.selectedRoleId highlighted seat
   * @param {function} props.onSelectRole filter by this role
   * @param {string} props.status issue status
   */
  function RoundTable({ participants, turns, speaking, selectedRoleId, onSelectRole, status }) {
    const [hovered, setHovered] = React.useState(null)
    const seatCount = Math.max(participants.length, 1)

    const lastLineOf = (roleId) => {
      const found = [...turns].reverse().find((turn) => turn.roleId === roleId && !turn.error && turn.text)
      return found ? preview(found.text, 60) : '还没有发言'
    }
    const turnCountOf = (roleId) => turns.filter((turn) => turn.roleId === roleId).length

    const seats = participants.map((role, index) => {
      // Start at the top (12 o'clock) and go clockwise.
      const angle = (index / seatCount) * Math.PI * 2 - Math.PI / 2
      const left = 50 + Math.cos(angle) * 36
      const top = 50 + Math.sin(angle) * 34
      const isSpeaking = speaking?.roleId === role.roleId
      const isSelected = selectedRoleId === role.roleId
      const focused = hovered === role.roleId
      return h(
        'button',
        {
          key: role.roleId,
          className: 'rtr-seat',
          type: 'button',
          'data-speaking': isSpeaking ? '' : undefined,
          'data-selected': isSelected ? '' : undefined,
          'data-focused': focused ? '' : undefined,
          style: { left: `${left}%`, top: `${top}%`, '--seat-color': roleColor(role.roleId) },
          onClick: () => onSelectRole(role.roleId),
          onMouseEnter: () => setHovered(role.roleId),
          onMouseLeave: () => setHovered(null),
          title: `${role.name}${role.focus ? ` · ${role.focus}` : ''}`,
          'aria-label': `${role.name}，已发言 ${turnCountOf(role.roleId)} 次`,
        },
        h('span', { className: 'rtr-seat-dot', 'aria-hidden': true }, initialOf(role.name)),
        h('span', { className: 'rtr-seat-name' }, role.name),
        turnCountOf(role.roleId) > 0 ? h('span', { className: 'rtr-seat-count' }, `${turnCountOf(role.roleId)}` ) : null,
      )
    })

    const bubble = speaking
      ? h(
          'div',
          { className: 'rtr-bubble' },
          h('div', { className: 'rtr-bubble-head' },
            h('strong', null, speaking.roleName),
            h('span', { className: 'rtr-hint' }, `第 ${speaking.round} 轮 · 发言中…`)),
          h('div', { className: 'rtr-bubble-wave', 'aria-hidden': true }, h('i'), h('i'), h('i')),
        )
      : h(
          'div',
          { className: 'rtr-bubble rtr-bubble-idle' },
          h('div', { className: 'rtr-bubble-head' },
            h('strong', null, status === 'voting' ? '书记员正在收敛方案' : status === 'decided' ? '已产生结论' : '圆桌就绪')),
          h('span', { className: 'rtr-hint' },
            selectedRoleId
              ? `正在只看「${participants.find((role) => role.roleId === selectedRoleId)?.name ?? ''}」的发言，点座位可取消`
              : '点座位只看某位角色，点中间空白取消'),
        )

    return h(
      'div',
      { className: 'rtr-table' },
      h('div', { className: 'rtr-table-ring', 'aria-hidden': true }),
      h('div', { className: 'rtr-table-center' }, bubble),
      seats,
    )
  }

  /** Compact horizontal strip for lists and headers. */
  function SeatStrip({ participants, turns, speaking, onSelectRole }) {
    return h(
      'div',
      { className: 'rtr-strip' },
      participants.map((role) => {
        const isSpeaking = speaking?.roleId === role.roleId
        const count = turns.filter((turn) => turn.roleId === role.roleId).length
        return h(
          'button',
          {
            key: role.roleId,
            type: 'button',
            className: 'rtr-strip-seat',
            'data-speaking': isSpeaking ? '' : undefined,
            style: { '--seat-color': roleColor(role.roleId) },
            onClick: onSelectRole ? () => onSelectRole(role.roleId) : undefined,
            title: `${role.name}${role.focus ? ` · ${role.focus}` : ''}`,
          },
          h('span', { className: 'rtr-seat-dot', 'aria-hidden': true }, initialOf(role.name)),
          h('span', { className: 'rtr-strip-name' }, role.name),
          count ? h('span', { className: 'rtr-seat-count' }, `${count}`) : null,
        )
      }),
    )
  }

  return { RoundTable, SeatStrip, paragraphs }
}
