// One issue = one roundtable meeting: the table, the flow controls (start /
// continue / vote / cancel), the transcript, proposals, votes and conclusion.

import { STATUS, STAGE_LABEL, relativeTime, paragraphs } from './shared.js'

export function createIssueDetail(React, { RoundTable, SeatStrip, StatusPill, Transcript, Drawer, roleColor, initialOf }) {
  const h = React.createElement

  function Stat({ label, value }) {
    return h('div', { className: 'rtr-stat' }, h('span', { className: 'rtr-stat-label' }, label), h('strong', null, value))
  }

  function ConclusionCard({ issue, onContinue, onClear, busy }) {
    const conclusion = issue.conclusion
    if (!conclusion) return null
    const [copied, setCopied] = React.useState(false)
    const copy = async () => {
      const lines = [
        `议题：${issue.title}`,
        `结论：${conclusion.title}（方案 ${conclusion.proposalId}）`,
        conclusion.summary,
        conclusion.keyPoints?.length ? `要点：\n- ${conclusion.keyPoints.join('\n- ')}` : '',
        conclusion.dissolve ?? '',
        `票数：${Object.entries(conclusion.counts ?? {}).map(([id, count]) => `${id} ${count} 票`).join('，')}${conclusion.abstain ? `，弃权 ${conclusion.abstain}` : ''}`,
        conclusion.dissent?.length ? `少数意见：\n${conclusion.dissent.map((item) => `- ${item.roleName}（投 ${item.proposalId}）：${item.reason}`).join('\n')}` : '',
        conclusion.openQuestions?.length ? `待解决：\n- ${conclusion.openQuestions.join('\n- ')}` : '',
      ].filter(Boolean)
      try {
        await navigator.clipboard.writeText(lines.join('\n\n'))
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      } catch {
        setCopied(false)
      }
    }

    return h(
      'section',
      { className: 'rtr-conclusion', 'data-stale': conclusion.stale ? '' : undefined },
      h('header', { className: 'rtr-conclusion-head' },
        h('span', { className: 'rtr-badge-lg' }, conclusion.proposalId),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('strong', { className: 'rtr-conclusion-title' }, conclusion.title),
          h('div', { className: 'rtr-hint' }, conclusion.note)),
        conclusion.stale ? h('span', { className: 'rtr-tag' }, '讨论已追加，结论待复核') : null),
      h('div', { className: 'rtr-conclusion-body' }, paragraphs(conclusion.summary).map((part, index) => h('p', { key: index }, part))),
      conclusion.keyPoints?.length
        ? h('ul', { className: 'rtr-points' }, conclusion.keyPoints.map((point, index) => h('li', { key: index }, point)))
        : null,
      conclusion.tradeoffs ? h('div', { className: 'rtr-hint', style: { marginTop: 6 } }, `取舍：${conclusion.tradeoffs}`) : null,
      h('div', { className: 'rtr-row', style: { marginTop: 10 } },
        Object.entries(conclusion.counts ?? {}).map(([id, count]) =>
          h('span', { key: id, className: 'rtr-pill', 'data-on': id === conclusion.proposalId ? '' : undefined }, `${id}：${count} 票`)),
        conclusion.abstain ? h('span', { className: 'rtr-pill' }, `弃权：${conclusion.abstain}`) : null),
      conclusion.dissent?.length
        ? h('div', { className: 'rtr-dissent' },
            h('div', { className: 'rtr-hint' }, '少数意见（保留，用于复盘）'),
            conclusion.dissent.map((item, index) =>
              h('div', { key: index, className: 'rtr-vote' }, h('b', null, `${item.roleName}（投 ${item.proposalId}）`), '：', item.reason)))
        : null,
      conclusion.openQuestions?.length
        ? h('div', { className: 'rtr-openq' },
            h('div', { className: 'rtr-hint' }, '还没解决的关键问题'),
            h('ul', { className: 'rtr-points' }, conclusion.openQuestions.map((item, index) => h('li', { key: index }, item))))
        : null,
      h('div', { className: 'rtr-row', style: { marginTop: 12 } },
        h('button', { className: 'rtr-btn', onClick: copy }, copied ? '已复制' : '复制结论'),
        h('button', { className: 'rtr-btn', onClick: () => onContinue(2), disabled: busy }, '继续讨论 2 轮'),
        h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: onClear, disabled: busy }, '清除结论重新表决')),
    )
  }

  function IssueDetail({ issue, onBack, onStart, onContinue, onVote, onCancel, onClear, busy, error }) {
    const [roleFilter, setRoleFilter] = React.useState(null)
    const [roundFilter, setRoundFilter] = React.useState(null)
    const [dense, setDense] = React.useState(false)
    const [drawer, setDrawer] = React.useState(false)

    const running = issue.status === 'running' || issue.status === 'voting'
    const finishedRounds = [...new Set(issue.turns.map((turn) => turn.round))]
    const stage = STAGE_LABEL[issue.stage] ?? ''

    return h(
      'div',
      { className: 'rtr-view rtr-detail' },
      h(
        'div',
        { className: 'rtr-detail-head' },
        h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: onBack }, '‹ 返回议题列表'),
        h('div', { className: 'rtr-detail-title' },
          h('h2', null, issue.title),
          h('div', { className: 'rtr-row' },
            h(StatusPill, { status: issue.status, stale: issue.conclusion?.stale }),
            h('span', { className: 'rtr-hint' }, `${issue.round}/${issue.plannedRounds} 轮 · ${issue.turns.length} 条发言 · 更新于 ${relativeTime(issue.updatedAt)}`),
            issue.researchEnabled ? h('span', { className: 'rtr-hint' }, '含联网资料') : null)),
      ),
      issue.background || issue.goal || issue.checklist?.length
        ? h('section', { className: 'rtr-brief' },
            issue.goal ? h('div', null, h('span', { className: 'rtr-stat-label' }, '希望产出'), h('div', null, issue.goal)) : null,
            issue.background ? h('div', null, h('span', { className: 'rtr-stat-label' }, '背景'), h('div', { className: 'rtr-brief-text' }, paragraphs(issue.background).map((part, index) => h('p', { key: index }, part)))) : null,
            issue.checklist?.length ? h('div', null, h('span', { className: 'rtr-stat-label' }, '核对清单'), h('ul', { className: 'rtr-points' }, issue.checklist.map((item, index) => h('li', { key: index }, item)))) : null)
        : null,
      h('div', { className: 'rtr-stage' },
        h('div', { className: 'rtr-stage-left' },
          h(RoundTable, {
            participants: issue.participants,
            turns: issue.turns,
            speaking: issue.speaking,
            selectedRoleId: roleFilter,
            onSelectRole: (roleId) => setRoleFilter(roleFilter === roleId ? null : roleId),
            status: issue.status,
          })),
        h('div', { className: 'rtr-stage-right' },
          h('div', { className: 'rtr-stats' },
            h(Stat, { label: '轮次', value: `${issue.round}/${issue.plannedRounds}` }),
            h(Stat, { label: '发言', value: `${issue.turns.length}` }),
            h(Stat, { label: '角色', value: `${issue.participants.length}` }),
            h(Stat, { label: '阶段', value: stage || STATUS[issue.status]?.label || '—' })),
          h('div', { className: 'rtr-actions' },
            issue.turns.length === 0
              ? h('button', { className: 'rtr-btn rtr-btn-primary', onClick: onStart, disabled: busy || !issue.model },
                  busy ? '启动中…' : '开始讨论')
              : null,
            issue.turns.length > 0 && !running
              ? h('button', { className: 'rtr-btn', onClick: () => onContinue(2), disabled: busy }, '继续讨论 +2 轮')
              : null,
            issue.turns.length > 0 && !running
              ? h('button', { className: 'rtr-btn rtr-btn-primary', onClick: onVote, disabled: busy },
                  issue.conclusion ? '重新表决' : '进行表决')
              : null,
            running ? h('button', { className: 'rtr-btn', onClick: onCancel, disabled: busy }, '取消讨论') : null),
          h('p', { className: 'rtr-hint rtr-action-hint' },
            '5 轮还没讨论出结果时，可以继续追加轮次；表决后继续讨论会把结论标记为「待复核」。'),
          error ? h('div', { className: 'rtr-error' }, error) : null,
          issue.error ? h('div', { className: 'rtr-error' }, issue.error) : null,
          issue.research?.sources?.length
            ? h('div', { className: 'rtr-sources' },
                h('div', { className: 'rtr-hint' }, issue.research.note),
                issue.research.sources.slice(0, 6).map((source, index) =>
                  h('a', { key: index, href: source.url, target: '_blank', rel: 'noreferrer' }, source.title || source.url)))
            : null)),
      ),
      issue.conclusion ? h(ConclusionCard, { issue, onContinue, onClear, busy }) : null,
      issue.proposals?.length
        ? h('section', { className: 'rtr-proposals' },
            h('div', { className: 'rtr-section-head' }, h('h3', null, '候选方案'), h('span', { className: 'rtr-hint' }, '书记员收敛，全体表决')),
            issue.proposals.map((proposal) =>
              h('div', { key: proposal.id, className: 'rtr-proposal', 'data-winner': issue.conclusion?.proposalId === proposal.id ? '' : undefined },
                h('span', { className: 'rtr-badge-lg' }, proposal.id),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { className: 'rtr-row' },
                    h('strong', null, proposal.title),
                    issue.conclusion?.proposalId === proposal.id ? h('span', { className: 'rtr-win' }, '· 胜出') : null),
                  paragraphs(proposal.summary).map((part, index) => h('p', { key: index }, part)),
                  proposal.keyPoints?.length ? h('ul', { className: 'rtr-points' }, proposal.keyPoints.map((point, index) => h('li', { key: index }, point))) : null,
                  proposal.tradeoffs ? h('div', { className: 'rtr-hint', style: { marginTop: 4 } }, `取舍：${proposal.tradeoffs}`) : null,
                  issue.tally?.counts?.[proposal.id] !== undefined
                    ? h('div', { className: 'rtr-hint', style: { marginTop: 4 } }, `得票 ${issue.tally.counts[proposal.id]}${issue.tally.voters?.[proposal.id]?.length ? ` · ${issue.tally.voters[proposal.id].join('、')}` : ''}`)
                    : null)))
          )
        : null,
      issue.votes?.length
        ? h('section', { className: 'rtr-votes-box' },
            h('div', { className: 'rtr-section-head' }, h('h3', null, '投票明细')),
            issue.votes.map((vote, index) =>
              h('div', { key: index, className: 'rtr-vote' },
                h('b', null, vote.roleName),
                vote.proposalId ? ` → 方案 ${vote.proposalId}` : ' → 弃权',
                h('div', { className: 'rtr-hint' }, vote.reason))),
            issue.runoffVotes?.length
              ? h('div', { style: { marginTop: 10 } },
                  h('div', { className: 'rtr-hint' }, '复选投票'),
                  issue.runoffVotes.map((vote, index) =>
                    h('div', { key: `runoff-${index}`, className: 'rtr-vote' },
                      h('b', null, vote.roleName),
                      vote.proposalId ? ` → 方案 ${vote.proposalId}` : ' → 弃权',
                      h('div', { className: 'rtr-hint' }, vote.reason))))
              : null)
        : null,
      h('section', { className: 'rtr-transcript-box' },
        h('div', { className: 'rtr-section-head' }, h('h3', null, '发言记录'), h('span', { className: 'rtr-hint' }, `${issue.turns.length} 条`)),
        h(Transcript, {
          issue,
          roleFilter,
          roundFilter,
          dense,
          onRoleFilter: setRoleFilter,
          onRoundFilter: setRoundFilter,
          onDensity: setDense,
          onOpenDrawer: () => setDrawer(true),
        })),
      drawer
        ? h('div', { className: 'rtr-drawer-backdrop', onClick: () => setDrawer(false), role: 'presentation' },
            h('aside', { className: 'rtr-drawer', onClick: (event) => event.stopPropagation() },
              h('header', { className: 'rtr-drawer-head' },
                h('strong', null, issue.title),
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => setDrawer(false) }, '关闭')),
              h('div', { className: 'rtr-drawer-body' },
                h(Transcript, {
                  issue,
                  roleFilter,
                  roundFilter,
                  dense,
                  onRoleFilter: setRoleFilter,
                  onRoundFilter: setRoundFilter,
                  onDensity: setDense,
                  onOpenDrawer: () => setDrawer(false),
                }))))
        : null,
    )
  }

  return { IssueDetail, ConclusionCard, Stat }
}
