// dsh-issue-roundtable — client half.
//
// One built client module: the business panel for a workbench where several
// role-played speakers debate a topic over rounds and then vote a proposal
// through. Everything durable lives in the host half; this file only renders
// and polls.

window.__ModuleLoader__.load({
  id: 'dsh-issue-roundtable',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/issue-roundtable'

    // ---------------------------------------------------------------- helpers

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

    function initialOf(name) {
      const text = String(name ?? '').trim()
      return text ? text.slice(0, 1) : '?'
    }

    function elapsedText(ms) {
      const seconds = Math.max(0, Math.round(ms / 1000))
      if (seconds < 60) return `${seconds} 秒`
      const minutes = Math.floor(seconds / 60)
      return `${minutes} 分 ${seconds % 60} 秒`
    }

    const STAGE_LABEL = {
      research: '检索背景资料',
      debate: '角色发言',
      synthesis: '书记员收敛方案',
      vote: '全体表决',
      runoff: '平票复选',
      result: '已产生结论',
      failed: '讨论中断',
      cancelled: '已取消',
    }

    const STATUS_LABEL = {
      running: '进行中',
      done: '已结束',
      failed: '失败',
      cancelled: '已取消',
    }

    const css = `
.rtr{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);box-sizing:border-box}
.rtr *{box-sizing:border-box}
.rtr-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 16px;min-height:44px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);position:sticky;top:0;z-index:5}
.rtr-bar h1{font-size:14px;font-weight:600;margin:0}
.rtr-bar .rtr-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.rtr-bar .rtr-spacer{flex:1}
.rtr-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.rtr-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.rtr-btn:disabled{opacity:.55;cursor:default}
.rtr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.rtr-btn-primary:hover:not(:disabled){filter:brightness(1.05)}
.rtr-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:4px 8px}
.rtr-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.rtr-body{flex:1;min-height:0;overflow:auto;padding:16px}
.rtr-inner{max-width:920px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.rtr-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px}
.rtr-card h2{font-size:13px;font-weight:600;margin:0 0 8px;display:flex;align-items:center;gap:8px}
.rtr-card p{margin:0 0 6px}
.rtr-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.rtr-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.rtr-textarea,.rtr-input{width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;resize:vertical}
.rtr-textarea{min-height:84px}
.rtr-textarea:focus,.rtr-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:var(--dsw-alias-brand-primary)}
.rtr-pill{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
.rtr-pill[data-on]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rtr-roles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px}
.rtr-role{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;cursor:pointer;display:flex;gap:8px;align-items:flex-start;background:transparent;text-align:left;color:inherit;font:inherit}
.rtr-role[data-on]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.rtr-avatar{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.rtr-role strong{display:block;font-weight:600;font-size:13px}
.rtr-role small{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;display:block}
.rtr-turn{display:flex;gap:10px;padding:10px 0;border-top:1px dashed var(--dsw-alias-border-l1)}
.rtr-turn:first-child{border-top:0}
.rtr-turn-text{white-space:pre-wrap;word-break:break-word;flex:1;min-width:0}
.rtr-turn[data-speaking]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent);border-radius:8px;padding:10px 8px}
.rtr-turn-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.rtr-round{display:flex;align-items:center;gap:10px;margin:18px 0 4px;color:var(--dsw-alias-label-secondary);font-size:12px}
.rtr-round::after{content:'';flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.rtr-proposal{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start}
.rtr-proposal[data-winner]{border-color:var(--dsw-alias-state-success-primary)}
.rtr-badge{flex:none;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2)}
.rtr-votes{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.rtr-votecount{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rtr-win{color:var(--dsw-alias-state-success-primary);font-weight:600}
.rtr-vote{border-top:1px dashed var(--dsw-alias-border-l1);padding:8px 0;font-size:12px}
.rtr-vote:first-child{border-top:0}
.rtr-vote b{font-weight:600}
.rtr-error{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap}
.rtr-banner{border-radius:10px;padding:10px 12px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rtr-history-item{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px dashed var(--dsw-alias-border-l1)}
.rtr-history-item:first-child{border-top:0}
.rtr-history-item button.rtr-open{flex:1;text-align:left;background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;min-width:0}
.rtr-history-item .rtr-open strong{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rtr-editor{display:flex;flex-direction:column;gap:10px}
.rtr-editor-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
.rtr-editor-head{display:flex;gap:8px;align-items:center}
.rtr-editor-head .rtr-input{flex:1}
.rtr-editor small{color:var(--dsw-alias-label-secondary);font-size:11px}
.rtr-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:36px 12px}
.rtr-sticky-actions{display:flex;gap:8px;flex-wrap:wrap}
@media (max-width:720px){
  .rtr-body{padding:12px}
  .rtr-roles{grid-template-columns:1fr}
  .rtr-card{padding:12px}
}
`

    let styleInstalled = false
    function installStyle() {
      if (styleInstalled && document.querySelector('style[data-issue-roundtable]')) return
      let node = document.querySelector('style[data-issue-roundtable]')
      if (!node) {
        node = document.createElement('style')
        node.setAttribute('data-issue-roundtable', '')
        document.head.appendChild(node)
      }
      node.textContent = css
      styleInstalled = true
    }

    // ---------------------------------------------------------------- pieces

    function Avatar({ name }) {
      return h('span', { className: 'rtr-avatar', 'aria-hidden': true }, initialOf(name))
    }

    function Card({ title, extra, children }) {
      return h(
        'section',
        { className: 'rtr-card' },
        title || extra
          ? h('h2', null, title ? h('span', null, title) : null, extra ? h('span', { className: 'rtr-spacer', style: { flex: 1 } }) : null, extra || null)
          : null,
        children,
      )
    }

    function Turn({ turn }) {
      return h(
        'div',
        { className: 'rtr-turn' },
        h(Avatar, { name: turn.roleName }),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('strong', { style: { fontWeight: 600 } }, turn.roleName),
            turn.focus ? h('small', { className: 'rtr-hint' }, turn.focus) : null,
          ),
          turn.error
            ? h('div', { className: 'rtr-turn-error' }, `这次发言失败：${turn.error}`)
            : h('div', { className: 'rtr-turn-text' }, turn.text),
        ),
      )
    }

    function Speaking({ speaking }) {
      return h(
        'div',
        { className: 'rtr-turn', 'data-speaking': '' },
        h(Avatar, { name: speaking.roleName }),
        h(
          'div',
          { style: { flex: 1 } },
          h('strong', { style: { fontWeight: 600 } }, speaking.roleName),
          h('div', { className: 'rtr-hint' }, `正在发言（第 ${speaking.round} 轮）…`),
        ),
      )
    }

    function ProposalCard({ proposal, tally, winner, recommended }) {
      const count = tally?.counts?.[proposal.id] ?? 0
      const voters = tally?.voters?.[proposal.id] ?? []
      return h(
        'div',
        { className: 'rtr-proposal', 'data-winner': winner ? '' : undefined },
        h('span', { className: 'rtr-badge' }, proposal.id),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('strong', { style: { fontWeight: 600 } }, proposal.title),
            winner ? h('span', { className: 'rtr-win' }, '· 胜出') : null,
            recommended && !winner ? h('span', { className: 'rtr-hint' }, '· 书记员推荐') : null,
          ),
          proposal.summary ? h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 4 } }, proposal.summary) : null,
          proposal.keyPoints?.length
            ? h(
                'ul',
                { style: { margin: '6px 0 0', paddingLeft: 18 } },
                proposal.keyPoints.map((point, index) => h('li', { key: index }, point)),
              )
            : null,
          proposal.tradeoffs ? h('div', { className: 'rtr-hint', style: { marginTop: 6 } }, `取舍：${proposal.tradeoffs}`) : null,
          tally
            ? h(
                'div',
                { className: 'rtr-votes' },
                h('span', { className: 'rtr-votecount' }, `得票 ${count}`),
                voters.length ? h('span', { className: 'rtr-votecount' }, `· ${voters.join('、')}`) : null,
              )
            : null,
        ),
      )
    }

    function Conclusion({ run }) {
      const conclusion = run.conclusion
      if (!conclusion) return null
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        const lines = [
          `议题：${run.topic}`,
          `结论：${conclusion.title}（方案 ${conclusion.proposalId}）`,
          conclusion.summary,
          conclusion.keyPoints?.length ? `要点：\n- ${conclusion.keyPoints.join('\n- ')}` : '',
          conclusion.tradeoffs ? `取舍：${conclusion.tradeoffs}` : '',
          `票数：${Object.entries(conclusion.counts ?? {}).map(([id, count]) => `${id} ${count} 票`).join('，')}${
            conclusion.abstain ? `，弃权 ${conclusion.abstain}` : ''
          }`,
          conclusion.dissent?.length
            ? `少数意见：\n${conclusion.dissent.map((item) => `- ${item.roleName}（投 ${item.proposalId}）：${item.reason}`).join('\n')}`
            : '',
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
        Card,
        { title: '表决结果' },
        h('div', { className: 'rtr-row', style: { marginBottom: 8 } },
          h('span', { className: 'rtr-badge' }, conclusion.proposalId),
          h('strong', { style: { fontSize: 14 } }, conclusion.title),
          h('span', { className: 'rtr-hint', style: { flex: 1 } }, conclusion.note)),
        h('div', { style: { whiteSpace: 'pre-wrap', marginBottom: 8 } }, conclusion.summary),
        conclusion.keyPoints?.length
          ? h('div', { style: { marginBottom: 6 } },
              h('div', { className: 'rtr-hint' }, '方案要点'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } }, conclusion.keyPoints.map((point, index) => h('li', { key: index }, point))))
          : null,
        conclusion.tradeoffs ? h('div', { className: 'rtr-hint', style: { marginBottom: 6 } }, `取舍：${conclusion.tradeoffs}`) : null,
        h('div', { className: 'rtr-row', style: { marginTop: 8 } },
          Object.entries(conclusion.counts ?? {}).map(([id, count]) =>
            h('span', { key: id, className: 'rtr-pill', 'data-on': id === conclusion.proposalId ? '' : undefined }, `${id}：${count} 票`)),
          conclusion.abstain ? h('span', { className: 'rtr-pill' }, `弃权：${conclusion.abstain}`) : null),
        conclusion.dissent?.length
          ? h(
              'div',
              { style: { marginTop: 12 } },
              h('div', { className: 'rtr-hint' }, '少数意见（保留，用于复盘）'),
              conclusion.dissent.map((item, index) =>
                h('div', { key: index, className: 'rtr-vote' }, h('b', null, `${item.roleName}（投 ${item.proposalId}）`), '：', item.reason)),
            )
          : null,
        conclusion.openQuestions?.length
          ? h(
              'div',
              { style: { marginTop: 12 } },
              h('div', { className: 'rtr-hint' }, '还没解决的关键问题'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } }, conclusion.openQuestions.map((item, index) => h('li', { key: index }, item))),
            )
          : null,
        h('div', { className: 'rtr-row', style: { marginTop: 12 } }, h('button', { className: 'rtr-btn', onClick: copy }, copied ? '已复制' : '复制结论')),
      )
    }

    function DebateView({ run }) {
      const rounds = []
      for (const turn of run.turns) {
        if (!rounds.includes(turn.round)) rounds.push(turn.round)
      }
      return h(
        'div',
        { className: 'rtr-inner' },
        h(
          Card,
          { title: '议题' },
          h('div', { style: { whiteSpace: 'pre-wrap', fontWeight: 600 } }, run.topic),
          h(
            'div',
            { className: 'rtr-row', style: { marginTop: 8 } },
            h('span', { className: 'rtr-pill' }, `状态：${STATUS_LABEL[run.status] ?? run.status}`),
            h('span', { className: 'rtr-pill' }, `阶段：${STAGE_LABEL[run.stage] ?? run.stage}`),
            h('span', { className: 'rtr-pill' }, `${run.totalRounds} 轮 · ${run.participants.length} 个角色`),
            h('span', { className: 'rtr-pill' }, `用时 ${elapsedText(run.elapsedMs ?? 0)}`),
            h('span', { className: 'rtr-pill' }, run.researchEnabled ? '已启用联网检索' : '未启用检索'),
          ),
          run.model ? h('div', { className: 'rtr-hint', style: { marginTop: 8 } }, `模型：${run.model.provider} / ${run.model.model}`) : null,
          run.error ? h('div', { className: 'rtr-error', style: { marginTop: 8 } }, run.error) : null,
        ),
        run.research?.sources?.length
          ? h(
              Card,
              { title: '背景资料' },
              h('div', { className: 'rtr-hint' }, run.research.note),
              h(
                'ul',
                { style: { margin: '6px 0 0', paddingLeft: 18 } },
                run.research.sources.map((source, index) =>
                  h(
                    'li',
                    { key: index, style: { marginBottom: 4 } },
                    h('a', { href: source.url, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary)' } }, source.title || source.url),
                    source.snippet ? h('div', { className: 'rtr-hint' }, source.snippet) : null,
                  ),
                ),
              ),
            )
          : run.research
            ? h(Card, { title: '背景资料' }, h('div', { className: 'rtr-hint' }, run.research.note))
            : null,
        h(
          Card,
          { title: '讨论过程' },
          rounds.length === 0 ? h('div', { className: 'rtr-empty' }, '等待第一位角色发言…') : null,
          rounds.map((round) =>
            h(
              'div',
              { key: round },
              h('div', { className: 'rtr-round' }, `第 ${round} / ${run.totalRounds} 轮`),
              run.turns.filter((turn) => turn.round === round).map((turn, index) => h(Turn, { key: `${round}-${index}-${turn.roleId}`, turn })),
            ),
          ),
          run.speaking && run.status === 'running' ? h(Speaking, { speaking: run.speaking }) : null,
        ),
        run.proposals?.length
          ? h(
              Card,
              { title: '候选方案', extra: h('span', { className: 'rtr-hint' }, '书记员收敛，全体表决') },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                run.proposals.map((proposal) =>
                  h(ProposalCard, {
                    key: proposal.id,
                    proposal,
                    tally: run.tally,
                    winner: run.tally?.winnerId === proposal.id ? run.status === 'done' || run.tally?.runoff : false,
                    recommended: false,
                  }))),
            )
          : null,
        run.votes?.length
          ? h(
              Card,
              { title: '投票明细' },
              run.votes.map((vote, index) =>
                h(
                  'div',
                  { key: index, className: 'rtr-vote' },
                  h('b', null, vote.roleName),
                  vote.proposalId ? ` → 方案 ${vote.proposalId}` : ' → 弃权',
                  vote.runoff ? h('span', { className: 'rtr-hint' }, '（复选）') : null,
                  h('div', { className: 'rtr-hint' }, vote.reason),
                ),
              ),
              run.runoffVotes?.length
                ? h(
                    'div',
                    { style: { marginTop: 10 } },
                    h('div', { className: 'rtr-hint' }, '复选投票'),
                    run.runoffVotes.map((vote, index) =>
                      h(
                        'div',
                        { key: `runoff-${index}`, className: 'rtr-vote' },
                        h('b', null, vote.roleName),
                        vote.proposalId ? ` → 方案 ${vote.proposalId}` : ' → 弃权',
                        h('div', { className: 'rtr-hint' }, vote.reason),
                      ),
                    ),
                  )
                : null,
            )
          : null,
        run.conclusion ? h(Conclusion, { run }) : null,
      )
    }

    function RoleEditor({ roles, onCancel, onSave, busy }) {
      const [draft, setDraft] = React.useState(() => roles.map((role) => ({ ...role })))
      const [error, setError] = React.useState('')
      const update = (index, patch) => setDraft((current) => current.map((role, at) => (at === index ? { ...role, ...patch } : role)))
      const remove = (index) => setDraft((current) => current.filter((_, at) => at !== index))
      const add = () =>
        setDraft((current) =>
          current.length >= 8
            ? current
            : [...current, { id: `role-${Date.now().toString(36)}`, name: '', focus: '', persona: '' }],
        )
      const submit = async () => {
        setError('')
        try {
          await onSave(draft)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }
      return h(
        Card,
        { title: '角色设定', extra: h('span', { className: 'rtr-hint' }, '每个角色就是一位独立的发言 agent') },
        h('div', { className: 'rtr-hint', style: { marginBottom: 10 } },
          '名称决定它怎么被点名，关注点决定它盯住什么，立场描述决定它怎么说话。角色差异越大，讨论越有价值。'),
        h(
          'div',
          { className: 'rtr-editor' },
          draft.map((role, index) =>
            h(
              'div',
              { key: index, className: 'rtr-editor-item' },
              h(
                'div',
                { className: 'rtr-editor-head' },
                h('input', {
                  className: 'rtr-input',
                  value: role.name,
                  placeholder: `角色 ${index + 1} 名称，例如「安全合规负责人」`,
                  onChange: (event) => update(index, { name: event.target.value }),
                  maxLength: 40,
                }),
                h('input', {
                  className: 'rtr-input',
                  style: { maxWidth: 220 },
                  value: role.focus ?? '',
                  placeholder: '关注点，例如「风险与合规」',
                  onChange: (event) => update(index, { focus: event.target.value }),
                  maxLength: 60,
                }),
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => remove(index), disabled: draft.length <= 1 }, '删除'),
              ),
              h('textarea', {
                className: 'rtr-textarea',
                value: role.persona,
                placeholder: '立场与说话方式：它站在谁那边、最在意什么、习惯怎么反驳别人（至少 20 字）',
                onChange: (event) => update(index, { persona: event.target.value }),
                maxLength: 1400,
                rows: 3,
              }),
            ),
          ),
        ),
        h('div', { className: 'rtr-row', style: { marginTop: 10 } },
          h('button', { className: 'rtr-btn', onClick: add, disabled: draft.length >= 8 }, '增加角色'),
          h('span', { className: 'rtr-spacer', style: { flex: 1 } }),
          h('button', { className: 'rtr-btn', onClick: onCancel, disabled: busy }, '取消'),
          h('button', { className: 'rtr-btn rtr-btn-primary', onClick: submit, disabled: busy }, busy ? '保存中…' : '保存角色')),
        error ? h('div', { className: 'rtr-error', style: { marginTop: 8 } }, error) : null,
      )
    }

    function Setup({ state, topic, setTopic, rounds, setRounds, research, setResearch, selected, toggleRole, onStart, busy, error, maxRounds }) {
      const selectedCount = state.roles.filter((role) => selected.includes(role.id)).length
      return h(
        'div',
        { className: 'rtr-inner' },
        h(
          Card,
          { title: '议题' },
          h('textarea', {
            className: 'rtr-textarea',
            value: topic,
            placeholder: '写清楚要决策的问题，例如「我们是否要在 2026 年把移动端从原生改成 H5，预算上限 300 万」',
            onChange: (event) => setTopic(event.target.value),
            maxLength: 2000,
            rows: 4,
          }),
          h('div', { className: 'rtr-hint', style: { marginTop: 6 } }, `${topic.trim().length} / 2000 字`),
        ),
        h(
          Card,
          { title: '讨论设置' },
          h('div', { className: 'rtr-row' },
            h('span', { className: 'rtr-hint' }, '轮数'),
            [1, 2, 3, 4, 5].map((count) =>
              h('button', {
                key: count,
                className: 'rtr-pill',
                'data-on': rounds === count ? '' : undefined,
                onClick: () => setRounds(count),
                disabled: count > maxRounds,
              }, `${count} 轮`)),
            h('span', { className: 'rtr-spacer', style: { flex: 1 } }),
            h('button', {
              className: 'rtr-pill',
              'data-on': research ? '' : undefined,
              onClick: () => setResearch(!research),
              title: '开启后每个角色发言前共享一份联网检索的资料',
            }, research ? '联网检索：开' : '联网检索：关')),
          h('div', { className: 'rtr-hint', style: { marginTop: 8 } },
            '每位角色每轮都会真实调用一次模型：轮数 × 角色数 次发言，加 1 次书记员收敛，再加每位角色 1 次投票。'),
        ),
        h(
          Card,
          { title: '参与角色', extra: h('span', { className: 'rtr-hint' }, `已选 ${selectedCount} / ${state.roles.length}`) },
          h('div', { className: 'rtr-roles' },
            state.roles.map((role) =>
              h(
                'button',
                {
                  key: role.id,
                  className: 'rtr-role',
                  'data-on': selected.includes(role.id) ? '' : undefined,
                  onClick: () => toggleRole(role.id),
                },
                h(Avatar, { name: role.name }),
                h('div', { style: { minWidth: 0 } },
                  h('strong', null, role.name),
                  h('small', null, role.focus || '未设置关注点'),
                  h('small', { style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, role.persona)),
              ),
            )),
          selectedCount < 2 ? h('div', { className: 'rtr-hint', style: { marginTop: 8 } }, '至少选择 2 个角色才能开始表决。') : null,
        ),
        error ? h('div', { className: 'rtr-card rtr-error' }, error) : null,
        h(
          'div',
          { className: 'rtr-sticky-actions' },
          h(
            'button',
            {
              className: 'rtr-btn rtr-btn-primary',
              onClick: onStart,
              disabled: busy || topic.trim().length < 4 || selectedCount < 2 || !state.model,
            },
            busy ? '正在启动…' : '开始圆桌讨论',
          ),
          state.model
            ? h('span', { className: 'rtr-hint' }, `模型：${state.model.provider} / ${state.model.model}`)
            : h('span', { className: 'rtr-error' }, '没有可用模型，请先在设置里选择默认模型'),
        ),
      )
    }

    function History({ items, onOpen, onDelete }) {
      return h(
        Card,
        { title: '历史讨论', extra: h('span', { className: 'rtr-hint' }, `${items.length} 条`) },
        items.length === 0
          ? h('div', { className: 'rtr-empty' }, '还没有历史讨论。开始第一场吧。')
          : items.map((item) =>
              h(
                'div',
                { key: item.id, className: 'rtr-history-item' },
                h('button', { className: 'rtr-open', onClick: () => onOpen(item.id) },
                  h('strong', null, item.topic),
                  h('small', { className: 'rtr-hint' }, `${item.conclusionTitle || '未产生结论'} · ${(item.participants || []).join('、')}`)),
                h('span', { className: 'rtr-pill' }, STATUS_LABEL[item.status] ?? item.status),
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => onDelete(item) }, '删除'),
              ),
            ),
      )
    }

    // ------------------------------------------------------------------ panel

    function Panel(props) {
      const active = props.active !== false
      const [state, setState] = React.useState(null)
      const [run, setRun] = React.useState(null)
      const [runId, setRunId] = React.useState(null)
      const [view, setView] = React.useState('home')
      const [topic, setTopic] = React.useState('')
      const [rounds, setRounds] = React.useState(3)
      const [research, setResearch] = React.useState(true)
      const [selected, setSelected] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')

      installStyle()

      const loadState = React.useCallback(async () => {
        try {
          const data = await api('/state')
          setState(data)
          setLoadError('')
          setRounds((current) => (data.settings?.rounds && current === 3 ? data.settings.rounds : current))
          setResearch((current) => (data.settings?.research === false ? false : current))
          setSelected((current) => (current.length ? current : (data.settings?.roleIds ?? data.roles.map((role) => role.id))))
          if (data.activeRun && data.activeRun.status === 'running') {
            setRun(data.activeRun)
            setRunId(data.activeRun.id)
            setView('debate')
          }
          return data
        } catch (failure) {
          setLoadError(failure instanceof Error ? failure.message : String(failure))
          return null
        }
      }, [])

      React.useEffect(() => {
        void loadState()
      }, [loadState])

      React.useEffect(() => {
        if (!runId || !active) return undefined
        let stopped = false
        const timer = setInterval(async () => {
          try {
            const data = await api(`/run?id=${encodeURIComponent(runId)}`)
            if (stopped) return
            setRun(data.run)
            if (data.run.status !== 'running') {
              clearInterval(timer)
              void loadState()
            }
          } catch {
            // Transient failures keep the last snapshot on screen.
          }
        }, 1500)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [runId, active, loadState])

      const toggleRole = (id) => setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

      const start = async () => {
        setBusy(true)
        setError('')
        try {
          await post('/settings', { rounds, research, roleIds: selected })
          const data = await post('/start', { topic, rounds, research, roleIds: selected })
          setRun(data.run)
          setRunId(data.runId)
          setView('debate')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const cancel = async () => {
        if (!runId) return
        setBusy(true)
        try {
          await post('/cancel', { id: runId })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const saveRoles = async (roles) => {
        setBusy(true)
        try {
          const data = await post('/roles', { roles })
          setState((current) => ({ ...(current ?? {}), roles: data.roles }))
          setSelected((current) => {
            const kept = current.filter((id) => data.roles.some((role) => role.id === id))
            return kept.length ? kept : data.roles.map((role) => role.id)
          })
          setEditing(false)
        } finally {
          setBusy(false)
        }
      }

      const openHistory = async (id) => {
        setError('')
        try {
          const data = await api(`/debate?id=${encodeURIComponent(id)}`)
          setRun(data.debate)
          setRunId(null)
          setView('debate')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      const removeHistory = async (item) => {
        if (!item?.id) return
        try {
          await post('/delete', { id: item.id })
          if (run?.id === item.id) {
            setRun(null)
            setRunId(null)
            setView('home')
          }
          void loadState()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      const newTopic = () => {
        setView('home')
        setRun(null)
        setRunId(null)
        setTopic('')
        setError('')
      }

      const toolbar = h(
        'header',
        { className: 'rtr-bar', 'data-dsh-workbench-toolbar': '' },
        h('h1', null, '议题圆桌'),
        state?.model ? h('span', { className: 'rtr-sub' }, `${state.model.provider} · ${state.model.model}`) : null,
        h('span', { className: 'rtr-sub' }, state ? `${state.roles.length} 个角色` : ''),
        h('span', { className: 'rtr-spacer' }),
        view === 'debate' ? h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: newTopic }, '新议题') : null,
        h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => setEditing((current) => !current) }, editing ? '收起角色' : '角色设定'),
        view === 'debate' && run?.status === 'running'
          ? h('button', { className: 'rtr-btn', onClick: cancel, disabled: busy }, '取消讨论')
          : null,
        h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => { void loadState(); setView('home') } }, '刷新'),
      )

      let content
      if (loadError && !state) {
        content = h('div', { className: 'rtr-inner' }, h(Card, { title: '圆桌暂不可用' }, h('div', { className: 'rtr-error' }, loadError), h('div', { className: 'rtr-hint', style: { marginTop: 6 } }, '请确认工作台插件已加载，然后点右上角「刷新」。')))
      } else if (editing && state) {
        content = h('div', { className: 'rtr-inner' }, h(RoleEditor, { roles: state.roles, onCancel: () => setEditing(false), onSave: saveRoles, busy }))
      } else if (view === 'debate' && run) {
        content = h(DebateView, { run })
      } else if (state) {
        content = h(Setup, {
          state,
          topic,
          setTopic,
          rounds,
          setRounds,
          research,
          setResearch,
          selected,
          toggleRole,
          onStart: start,
          busy,
          error,
          maxRounds: state.maxRounds ?? 5,
        })
      } else {
        content = h('div', { className: 'rtr-empty' }, '正在加载工作台…')
      }

      return h(
        'div',
        { className: 'rtr' },
        toolbar,
        h('div', { className: 'rtr-body' }, content,
          state && view !== 'debate' && !editing ? h('div', { className: 'rtr-inner', style: { marginTop: 14 } }, h(History, { items: state.history ?? [], onOpen: openHistory, onDelete: removeHistory })) : null,
        ),
      )
    }

    // ------------------------------------------------------------------- apply

    function apply(ctx) {
      ctx.effect(() =>
        ctx.desktopWorkbenches.register(
          {
            title: '议题圆桌',
            panelTitle: '议题圆桌',
            description: '为议题定义多个不同角色的发言 agent，让它们多轮交锋，最后由全体投票表决出一个方案。',
            // Registry identity, not a publication step: Desktop 0.12.x drops a
            // provider it cannot attribute to one repository (0.13.x would derive
            // local:<package>, but pre-0.13 has no such path). The owner here is
            // the author's own GitHub namespace and the repository name matches the
            // npm package, so identity stays stable if the repository is created,
            // or if the Desktop is upgraded. Nothing is uploaded by this field.
            repository: 'https://github.com/ludwen/dsh-issue-roundtable',
            customFrame: true,
            headerLayout: 'compact',
          },
          Panel,
        ),
      )
    }

    return { apply, inject: ['desktopWorkbenches'] }
  },
})
