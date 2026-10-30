// Role library: groups on the left, roles on the right, plus an AI-assisted
// role creator that turns a one-line description into 2-3 candidates.

import { roleColor, initialOf } from './shared.js'

export function createLibrary(React, { post }) {
  const h = React.createElement

  function RoleCard({ role, group, onEdit, onDelete, editing }) {
    return h(
      'div',
      { className: 'rtr-lib-role', 'data-editing': editing ? '' : undefined },
      h('span', { className: 'rtr-turn-avatar', style: { background: roleColor(role.id) }, 'aria-hidden': true }, initialOf(role.name)),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('strong', null, role.name),
        h('div', { className: 'rtr-hint' }, `${group?.name ?? '未分组'}${role.focus ? ` · ${role.focus}` : ''}`),
        h('div', { className: 'rtr-lib-persona' }, role.persona)),
      h('div', { className: 'rtr-lib-actions' },
        h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: onEdit }, '编辑'),
        h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: onDelete }, '删除')),
    )
  }

  function RoleForm({ role, groups, onSave, onCancel, onAssist, busy }) {
    const [draft, setDraft] = React.useState(role)
    const [wish, setWish] = React.useState('')
    const [suggestions, setSuggestions] = React.useState([])
    const [assisting, setAssisting] = React.useState(false)
    const [error, setError] = React.useState('')

    const runAssist = async () => {
      if (!wish.trim()) return
      setAssisting(true)
      setError('')
      try {
        const data = await post('/assist/role', {
          input: wish,
          groupName: groups.find((group) => group.id === draft.groupId)?.name,
          existingNames: groups.length ? [] : [],
        })
        setSuggestions(data.suggestions)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setAssisting(false)
      }
    }

    return h(
      'div',
      { className: 'rtr-lib-form' },
      h('div', { className: 'rtr-assist' },
        h('strong', null, 'AI 帮我写角色'),
        h('div', { className: 'rtr-row' },
          h('input', { className: 'rtr-input', placeholder: '一句话描述：例如「需要一个只关心安全和上线风险的人」',
            value: wish, onChange: (event) => setWish(event.target.value) }),
          h('button', { className: 'rtr-btn', onClick: runAssist, disabled: assisting || !wish.trim() }, assisting ? '生成中…' : '生成候选')),
          suggestions.length
            ? h('div', { className: 'rtr-suggestions' },
                suggestions.map((item) =>
                  h('button', { key: item.id, className: 'rtr-suggestion', onClick: () => setDraft({ ...draft, name: item.name, focus: item.focus, persona: item.persona }) },
                    h('strong', null, item.name),
                    h('small', null, item.focus),
                    h('small', { className: 'rtr-suggestion-persona' }, item.persona))))
            : null),
        error ? h('div', { className: 'rtr-error' }, error) : null),

      h('div', { className: 'rtr-row rtr-form-row' },
        h('label', { className: 'rtr-field' }, h('span', null, '名称'),
          h('input', { className: 'rtr-input', value: draft.name, maxLength: 40, onChange: (event) => setDraft({ ...draft, name: event.target.value }) })),
        h('label', { className: 'rtr-field' }, h('span', null, '关注点'),
          h('input', { className: 'rtr-input', value: draft.focus, maxLength: 60, onChange: (event) => setDraft({ ...draft, focus: event.target.value }) })),
        h('label', { className: 'rtr-field' }, h('span', null, '分组'),
          h('select', { className: 'rtr-input', value: draft.groupId, onChange: (event) => setDraft({ ...draft, groupId: event.target.value }) },
            groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)))),
      h('label', { className: 'rtr-field' }, h('span', null, '立场与说话方式（至少 20 字）'),
        h('textarea', { className: 'rtr-textarea', rows: 5, maxLength: 1400, value: draft.persona,
          onChange: (event) => setDraft({ ...draft, persona: event.target.value }) })),
      h('div', { className: 'rtr-row' },
        h('span', { className: 'rtr-spacer', style: { flex: 1 } }),
        h('button', { className: 'rtr-btn', onClick: onCancel, disabled: busy }, '取消'),
        h('button', { className: 'rtr-btn rtr-btn-primary', onClick: () => onSave(draft), disabled: busy || !draft.name.trim() || draft.persona.trim().length < 20 }, '保存角色')),
      onAssist ? null : null,
    )
  }

  function GroupForm({ group, onSave, onCancel }) {
    const [draft, setDraft] = React.useState(group)
    return h('div', { className: 'rtr-lib-form' },
      h('div', { className: 'rtr-row rtr-form-row' },
        h('label', { className: 'rtr-field' }, h('span', null, '分组名称'),
          h('input', { className: 'rtr-input', value: draft.name, maxLength: 40, onChange: (event) => setDraft({ ...draft, name: event.target.value }) })),
        h('label', { className: 'rtr-field' }, h('span', null, '说明'),
          h('input', { className: 'rtr-input', value: draft.description ?? '', maxLength: 200, onChange: (event) => setDraft({ ...draft, description: event.target.value }) }))),
      h('div', { className: 'rtr-row' },
        h('span', { className: 'rtr-spacer', style: { flex: 1 } }),
        h('button', { className: 'rtr-btn', onClick: onCancel }, '取消'),
        h('button', { className: 'rtr-btn rtr-btn-primary', onClick: () => onSave(draft), disabled: !draft.name.trim() }, '保存分组')))
  }

  function Library({ state, onSave, busy, error }) {
    const groups = state.groups
    const [activeGroup, setActiveGroup] = React.useState('all')
    const [roleForm, setRoleForm] = React.useState(null)
    const [groupForm, setGroupForm] = React.useState(null)

    const roles = state.roles.filter((role) => activeGroup === 'all' || role.groupId === activeGroup)
    const saveRole = async (role) => {
      const next = role.id && state.roles.some((item) => item.id === role.id)
        ? state.roles.map((item) => (item.id === role.id ? role : item))
        : [...state.roles, { ...role, id: `role-${Date.now().toString(36)}` }]
      await onSave({ groups: state.groups, roles: next })
      setRoleForm(null)
    }
    const deleteRole = async (role) => {
      await onSave({ groups: state.groups, roles: state.roles.filter((item) => item.id !== role.id) })
    }
    const saveGroup = async (group) => {
      const next = group.id && state.groups.some((item) => item.id === group.id)
        ? state.groups.map((item) => (item.id === group.id ? group : item))
        : [...state.groups, { ...group, id: `group-${Date.now().toString(36)}` }]
      await onSave({ groups: next, roles: state.roles })
      setGroupForm(null)
    }
    const deleteGroup = async (group) => {
      const nextGroups = state.groups.filter((item) => item.id !== group.id)
      if (!nextGroups.length) return
      const nextRoles = state.roles.map((role) => (role.groupId === group.id ? { ...role, groupId: nextGroups[0].id } : role))
      await onSave({ groups: nextGroups, roles: nextRoles })
      if (activeGroup === group.id) setActiveGroup('all')
    }

    return h(
      'div',
      { className: 'rtr-view rtr-library' },
      h('div', { className: 'rtr-list-head' },
        h('div', null, h('h2', null, '角色库'), h('p', { className: 'rtr-hint' }, `${state.roles.length} 个角色 · ${state.groups.length} 个分组`)),
        h('div', { className: 'rtr-row' },
          h('button', { className: 'rtr-btn', onClick: () => setGroupForm({ id: '', name: '', description: '' }), disabled: busy }, '新建分组'),
          h('button', { className: 'rtr-btn rtr-btn-primary', onClick: () => setRoleForm({ id: '', name: '', focus: '', persona: '', groupId: groups[0]?.id ?? '' }), disabled: busy }, '新建角色')),
      groupForm ? h(GroupForm, { group: groupForm, onSave: saveGroup, onCancel: () => setGroupForm(null) }) : null,
      roleForm ? h(RoleForm, { role: roleForm, groups, onSave: saveRole, onCancel: () => setRoleForm(null), busy }) : null,
      h('div', { className: 'rtr-lib-body' },
        h('div', { className: 'rtr-lib-groups' },
          h('button', { className: 'rtr-lib-group', 'data-on': activeGroup === 'all' ? '' : undefined, onClick: () => setActiveGroup('all') },
            h('strong', null, '全部'), h('span', { className: 'rtr-hint' }, `${state.roles.length}`)),
          groups.map((group) =>
            h('div', { key: group.id, className: 'rtr-lib-group-row', 'data-on': activeGroup === group.id ? '' : undefined },
              h('button', { className: 'rtr-lib-group', onClick: () => setActiveGroup(group.id) },
                h('strong', null, group.name),
                h('span', { className: 'rtr-hint' }, `${state.roles.filter((role) => role.groupId === group.id).length}`),
                group.description ? h('small', null, group.description) : null),
              h('div', { className: 'rtr-lib-group-actions' },
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => setGroupForm(group) }, '改'),
                h('button', { className: 'rtr-btn rtr-btn-ghost', onClick: () => deleteGroup(group), disabled: groups.length <= 1 }, '删')))),
        ),
        h('div', { className: 'rtr-lib-roles' },
          roles.length === 0
            ? h('div', { className: 'rtr-empty' }, '这个分组下还没有角色。')
            : roles.map((role) =>
                h(RoleCard, {
                  key: role.id,
                  role,
                  group: groups.find((group) => group.id === role.groupId),
                  editing: roleForm?.id === role.id,
                  onEdit: () => setRoleForm(role),
                  onDelete: () => deleteRole(role),
                }))),
      ),
      error ? h('div', { className: 'rtr-error' }, error) : null,
    )
  }

  return { Library, RoleForm, GroupForm }
}
