/**
 * Browser half of `dsh-sidebar-delete`.
 *
 * Adds three affordances to the shipped sidebar and one frame-wide surface:
 *
 * - `sidebar.workspaces.session.menu.item` — a "delete session" row in one
 *   Session's "..." menu;
 * - `sidebar.workspaces.session.row.action` — the matching hover button;
 * - `sidebar.footer.action` — the entry to the workspace / ungrouped manager;
 * - `shell.overlay` — the manager panel and the delete-confirmation dialog.
 *
 * The half is a plain-JS Module Loader package: no build step, no JSX, and no
 * Harness Client package beyond `react`. Icons, buttons and the dialog are
 * drawn here; the only cross-boundary capability is one HTTP route owned by the
 * Host half (`POST /dsh-sidebar-delete/session`), which is the only way this
 * file asks for a deletion.
 *
 * @module dsh-sidebar-delete/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-delete',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-sidebar-delete'

    /**
     * Relative path of the Host route, resolved against `document.baseURI`:
     * dsh web serves the app from the origin root, so the leading slash is
     * omitted to survive a deployment that mounts the app under a prefix.
     */
    const ROUTE_PATH = 'dsh-sidebar-delete/session'

    /** `<style>` element id, so a double mount never stacks two sheets. */
    const STYLE_ID = 'dshsd-styles'

    /** English dictionary (mirrors `locale/en.json` minus `meta`). */
    const en = {
      'menu.session': 'Delete session',
      'rowAction.delete': 'Delete session',
      'confirm.title': 'Delete session “{title}”?',
      'confirm.desc': 'This deletes the local session log and its projection cache. It cannot be undone.',
      'confirm.cascade': 'This session has {n} child session(s); they are deleted too.',
      'confirm.action': 'Delete',
      'confirm.cancel': 'Cancel',
      'confirm.pending': 'Deleting…',
      'confirm.current': 'This is the open session and cannot be deleted.',
      'error.live': 'This session is still running or open. Stop it first.',
      'error.hostUnavailable': 'Delete failed: the Host half is unavailable. The plugin may be incomplete; restart dsh and retry.',
      'error.generic': 'Delete failed: {message}',
      'manager.entry': 'Manage workspaces & sessions',
      'manager.title': 'Manage workspaces & sessions',
      'manager.close': 'Close',
      'manager.workspaces': 'Workspaces',
      'manager.ungrouped': 'Ungrouped',
      'manager.ungroupedNote': '“Ungrouped” collects sessions that are not registered under any workspace. Deleting here deletes the session itself, not a group; to turn a directory into a manageable workspace, use “Register as workspace”.',
      'manager.sessions': '{n} session(s)',
      'manager.register': 'Register as workspace',
      'manager.register.pending': 'Registering…',
      'manager.register.failed': 'Register failed: {message}',
      'manager.deleteWorkspace': 'Delete workspace',
      'manager.deleteWorkspaceConfirm': 'Delete workspace “{title}”? The folder and its sessions are kept; its sessions move to “Ungrouped”.',
      'manager.deleteWorkspaceFailed': 'Delete workspace failed: {message}',
      'manager.empty': 'No sessions here yet.',
      'manager.emptyWorkspaces': 'No workspace registered yet.',
      'manager.pending': 'Working…',
      'manager.noCwd': 'This session records no directory, so it cannot be registered.',
      'manager.archivedHidden': 'Archived sessions and child sessions are not listed here.',
    }

    /** Simplified Chinese dictionary (mirrors `locale/zh.json` minus `meta`). */
    const zh = {
      'menu.session': '删除会话',
      'rowAction.delete': '删除会话',
      'confirm.title': '删除会话「{title}」？',
      'confirm.desc': '会删除本地会话日志与投影缓存，无法恢复。',
      'confirm.cascade': '该会话还有 {n} 个子会话，会一并删除。',
      'confirm.action': '确认删除',
      'confirm.cancel': '取消',
      'confirm.pending': '正在删除…',
      'confirm.current': '这是当前打开的会话，无法删除。',
      'error.live': '该会话仍在运行或已被打开，请先停止后再删除。',
      'error.hostUnavailable': '删除失败：Host 半不可用，插件可能没有完整安装，重启 dsh 后再试。',
      'error.generic': '删除失败：{message}',
      'manager.entry': '管理工作区与会话',
      'manager.title': '管理工作区与会话',
      'manager.close': '关闭',
      'manager.workspaces': '工作区',
      'manager.ungrouped': '未分组',
      'manager.ungroupedNote': '「未分组」是尚未登记为工作区的会话集合，这里删除的是会话本身而不是分组；想让某个目录变成可管理的工作区，点它旁边的「注册为工作区」。',
      'manager.sessions': '{n} 个会话',
      'manager.register': '注册为工作区',
      'manager.register.pending': '正在注册…',
      'manager.register.failed': '注册失败：{message}',
      'manager.deleteWorkspace': '删除工作区',
      'manager.deleteWorkspaceConfirm': '删除工作区「{title}」？文件夹与会话都会保留，其会话将显示在「未分组」下。',
      'manager.deleteWorkspaceFailed': '删除工作区失败：{message}',
      'manager.empty': '这里还没有会话。',
      'manager.emptyWorkspaces': '还没有登记的工作区。',
      'manager.pending': '处理中…',
      'manager.noCwd': '该会话没有目录记录，无法注册为工作区。',
      'manager.archivedHidden': '已归档与子会话不在这个列表里显示。',
    }

    /** Theme-token-only sheet; every class is prefixed `dshsd-`. */
    const CSS = `
.dshsd-menu-item{display:flex;align-items:center;gap:6px;width:100%;padding:4px 7px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);line-height:1.4;text-align:left;background:transparent;border:none;border-radius:var(--dsw-radius-md);cursor:pointer}
.dshsd-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsd-menu-item-danger{color:var(--dsw-alias-state-error-primary)}
.dshsd-menu-item-danger:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dshsd-menu-item-separator{margin-top:5px;border-top:1px solid var(--dsw-alias-border-l1);box-sizing:border-box}
.dshsd-icon-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:var(--dsw-radius-xs);cursor:pointer}
.dshsd-icon-button:hover{color:var(--dsw-alias-label-primary)}
.dshsd-icon-button:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dshsd-icon{display:block}
.dshsd-foot{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:6px 8px;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);background:transparent;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer}
.dshsd-foot:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsd-foot[data-wide="false"]{justify-content:center;width:32px;height:32px;padding:0}
.dshsd-foot-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshsd-layer{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);pointer-events:auto}
.dshsd-layer-top{z-index:61}
.dshsd-card{display:flex;flex-direction:column;gap:12px;width:min(560px,100%);max-height:min(72vh,640px);padding:16px;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary, 13px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent)}
.dshsd-card:focus{outline:none}
.dshsd-card-confirm{width:min(420px,100%)}
.dshsd-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dshsd-card-title{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.dshsd-card-body{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto}
.dshsd-text{margin:0;color:var(--dsw-alias-label-secondary);line-height:1.5;overflow-wrap:anywhere}
.dshsd-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dshsd-error{margin:0;color:var(--dsw-alias-state-error-primary);line-height:1.5;overflow-wrap:anywhere}
.dshsd-actions{display:flex;justify-content:flex-end;gap:8px}
.dshsd-button{padding:5px 12px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);cursor:pointer}
.dshsd-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsd-button:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dshsd-button-danger{color:var(--dsw-alias-state-error-primary)}
.dshsd-button-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.dshsd-link-button{padding:2px 6px;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;background:transparent;border:none;border-radius:var(--dsw-radius-xs);cursor:pointer}
.dshsd-link-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsd-link-button:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dshsd-link-button-danger{color:var(--dsw-alias-state-error-primary)}
.dshsd-link-button-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshsd-menu-item:focus-visible,.dshsd-icon-button:focus-visible,.dshsd-foot:focus-visible,.dshsd-button:focus-visible,.dshsd-link-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-label-primary));outline-offset:1px}
.dshsd-sections{display:flex;flex-direction:column;gap:14px}
.dshsd-section{display:flex;flex-direction:column;gap:8px}
.dshsd-section-title{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:1.4}
.dshsd-group{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dshsd-group-head{display:flex;align-items:center;gap:8px;min-width:0}
.dshsd-group-title{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-weight:600}
.dshsd-group-path{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshsd-group-count{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshsd-group-action{flex:none;margin-left:auto}
.dshsd-group-action + .dshsd-group-count{margin-left:0}
.dshsd-sessions{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dshsd-session-row{display:flex;align-items:center;gap:8px;padding:3px 4px 3px 10px;border-radius:var(--dsw-radius-xs)}
.dshsd-session-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsd-session-title{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dshsd-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshsd-confirm-box{display:flex;flex-direction:column;gap:8px;padding:8px;background:var(--dsw-alias-interactive-bg-hover-danger);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
`

    // ---------------------------------------------------------------------
    // Small shared pieces
    // ---------------------------------------------------------------------

    /**
     * A tiny snapshot store: stable `getSnapshot`, synchronous `subscribe`.
     *
     * @param initialState - the first snapshot.
     * @returns the store.
     */
    function createStore(initialState) {
      let snapshot = initialState
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          if (next === snapshot) return
          snapshot = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[dsh-sidebar-delete] store listener failed', error)
            }
          }
        },
      }
    }

    /**
     * Subscribe to a selection over one store. Prefers
     * `useSyncExternalStore` (React 18) and falls back to the
     * state/effect pair, so this file works on either runtime.
     *
     * The selector must return a stable reference or a primitive, otherwise
     * React re-renders forever.
     */
    const useSelected = typeof React.useSyncExternalStore === 'function'
      ? (store, selector) =>
          React.useSyncExternalStore(
            store.subscribe,
            () => selector(store.getSnapshot()),
            () => selector(store.getSnapshot()),
          )
      : (store, selector) => {
          const [value, setValue] = React.useState(() => selector(store.getSnapshot()))
          React.useEffect(() => {
            setValue(selector(store.getSnapshot()))
            return store.subscribe(() => {
              setValue(selector(store.getSnapshot()))
            })
          }, [store, selector])
          return value
        }

    /** Identity selector: the whole plugin state. */
    const selectState = (state) => state
    /** Identity selector: the whole Session list snapshot. */
    const selectSessionSnapshot = (snapshot) => snapshot
    /** Identity selector: the whole Workspace list snapshot. */
    const selectWorkspaceSnapshot = (snapshot) => snapshot

    /**
     * Hold the `<style>` sheet for as long as the plugin is mounted, and
     * no-op where there is no DOM at all.
     *
     * @returns the disposer removing the sheet.
     */
    function installStyles() {
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    /**
     * A 14px outline trash glyph, drawn here instead of borrowed from a
     * Harness Client package.
     *
     * @param size - the square edge in pixels.
     * @returns the icon element.
     */
    function iconTrash(size) {
      return h(
        'svg',
        {
          className: 'dshsd-icon',
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M2.6 4.4h10.8' }),
        h('path', { d: 'M6.4 4.4V3.3c0-.5.4-.9.9-.9h1.4c.5 0 .9.4.9.9v1.1' }),
        h('path', { d: 'M4.2 4.4l.6 8.3c0 .6.5 1 1.1 1h4.2c.6 0 1.1-.4 1.1-1l.6-8.3' }),
        h('path', { d: 'M6.7 7.1v3.6' }),
        h('path', { d: 'M9.3 7.1v3.6' }),
      )
    }

    /**
     * A 16px outline "layers" glyph for the manager entry.
     *
     * @param size - the square edge in pixels.
     * @returns the icon element.
     */
    function iconLayers(size) {
      return h(
        'svg',
        {
          className: 'dshsd-icon',
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M8 2.3 13.6 5.1 8 7.9 2.4 5.1z' }),
        h('path', { d: 'M2.4 8.1 8 10.9l5.6-2.8' }),
        h('path', { d: 'M2.4 11.1 8 13.9l5.6-2.8' }),
      )
    }

    /** `~/...` shortening for the two directory homes dsh runs on. */
    const HOME_PREFIX = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/

    /**
     * Shorten a recorded directory for display. `/Users/<me>/x` becomes
     * `~/x`; anything else is shown verbatim.
     *
     * @param value - the recorded path.
     * @returns the display path.
     */
    function shortPath(value) {
      if (typeof value !== 'string' || value === '') return ''
      return value.replace(HOME_PREFIX, '~')
    }

    /**
     * Whether a Session row is open in the main view — the shipped
     * runtime's own notion of "the current Session"
     * (`retainedBy.mainView`, as `UiSession.isMain` reads it).
     *
     * @param row - one `byId` entry, possibly missing.
     * @returns whether the row is retained by the main view.
     */
    function isSessionRetained(row) {
      if (row === null || row === undefined || typeof row !== 'object') return false
      const retained = row.retainedBy
      if (retained === null || retained === undefined || typeof retained !== 'object') return false
      return (retained.mainView ?? 0) > 0
    }

    /**
     * Whether one Session is the open one. The shipped runtime answers this
     * with `retainedBy.mainView > 0` (`UiSession.isMain`, ui-workspace's own
     * `panelActive` checks); `usePanelInfo().activePanelId` is a central panel
     * id, never a Session id, so it is deliberately not consulted here. A
     * Session whose row is missing reads as "not open", and the Host still
     * gets the final word on every request.
     *
     * @param sessionId - the row in question.
     * @param useSessions - the framework's Session selector hook.
     * @returns whether the Session is currently open.
     */
    function useSessionOpen(sessionId, useSessions) {
      return useSessions((snapshot) => {
        const byId = snapshot === null || snapshot === undefined ? undefined : snapshot.byId
        return isSessionRetained(byId === undefined || byId === null ? undefined : byId[sessionId])
      })
    }

    /**
     * How many stored Sessions descend from one Session, following the
     * `parentId` chain (the Host deletes the whole subtree).
     *
     * @param byId - the Session list index.
     * @param sessionId - the subtree root.
     * @returns the number of descendants.
     */
    function countDescendants(byId, sessionId) {
      if (byId === null || byId === undefined || typeof byId !== 'object') return 0
      let count = 0
      for (const row of Object.values(byId)) {
        if (row === null || row === undefined) continue
        let cursor = row.parentId
        const seen = new Set()
        while (typeof cursor === 'string' && cursor !== '' && !seen.has(cursor)) {
          if (cursor === sessionId) {
            count += 1
            break
          }
          seen.add(cursor)
          const parent = byId[cursor]
          cursor = parent === null || parent === undefined ? undefined : parent.parentId
        }
      }
      return count
    }

    /**
     * @param reason - anything a rejected promise or `fetch` produced.
     * @returns a printable message.
     */
    function errorMessage(reason) {
      if (reason instanceof Error && typeof reason.message === 'string' && reason.message !== '') return reason.message
      if (typeof reason === 'string' && reason !== '') return reason
      try {
        return String(reason)
      } catch {
        return 'unknown error'
      }
    }

    /**
     * Ask the Host half to delete one Session branch.
     *
     * @param sessionId - the Session to delete.
     * @returns a plain outcome: `{ok:true}` or `{ok:false, kind, message}`
     *   where `kind` is `hostUnavailable`, `live` or `generic`.
     */
    async function requestSessionDelete(sessionId) {
      if (typeof document === 'undefined' || typeof fetch !== 'function') {
        return { ok: false, kind: 'hostUnavailable', message: 'this runtime has no browser fetch' }
      }
      let url
      try {
        url = new URL(ROUTE_PATH, document.baseURI)
      } catch (error) {
        return { ok: false, kind: 'hostUnavailable', message: errorMessage(error) }
      }
      let response
      try {
        response = await fetch(url.href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          credentials: 'same-origin',
        })
      } catch (error) {
        return { ok: false, kind: 'hostUnavailable', message: errorMessage(error) }
      }
      if (response.status === 404) {
        return { ok: false, kind: 'hostUnavailable', message: `HTTP 404 for ${url.pathname}` }
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === true) {
        return { ok: true, deleted: Array.isArray(payload.deleted) ? payload.deleted : [] }
      }
      if (payload === null || typeof payload !== 'object') {
        return { ok: false, kind: 'generic', message: `HTTP ${response.status}` }
      }
      const code = typeof payload.code === 'string' ? payload.code : ''
      const message = typeof payload.message === 'string' && payload.message !== '' ? payload.message : `HTTP ${response.status}`
      if (code === 'session-active') return { ok: false, kind: 'live', message }
      return { ok: false, kind: 'generic', message }
    }

    /**
     * Word one delete failure.
     *
     * @param failure - the outcome from {@link requestSessionDelete}.
     * @param t - locale seat.
     * @returns the message to show.
     */
    function deleteFailureText(failure, t) {
      if (failure.kind === 'hostUnavailable') return t('error.hostUnavailable')
      if (failure.kind === 'live') return t('error.live')
      return t('error.generic', { message: failure.message })
    }

    /**
     * Close on `Escape`. The confirmation dialog listens during capture and
     * stops the event, so one press closes only the top layer while the
     * manager stays open underneath.
     *
     * @param onEscape - the close callback.
     * @param capture - whether to claim the key before the layer below.
     */
    function useEscape(onEscape, capture) {
      const latest = React.useRef(onEscape)
      latest.current = onEscape
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (capture === true && typeof event.stopPropagation === 'function') event.stopPropagation()
          latest.current()
        }
        document.addEventListener('keydown', onKeyDown, capture === true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, capture === true)
        }
      }, [capture])
    }

    /**
     * Move focus into a freshly opened dialog without touching anything else.
     *
     * @returns the ref to attach to the dialog card.
     */
    function useDialogFocus() {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const node = ref.current
        if (node === null || node === undefined || typeof node.focus !== 'function') return
        try {
          node.focus({ preventScroll: true })
        } catch {
          /* a focus refusal is never worth breaking the dialog for */
        }
      }, [])
      return ref
    }

    /**
     * A session row inside the manager: title, an optional hover hint, and
     * the delete action that raises the shared confirmation dialog.
     *
     * @param row - one Session row.
     * @param options - `{t, requestDelete, hint}`.
     * @returns the list item.
     */
    function sessionRow(row, options) {
      const { t, requestDelete, hint } = options
      const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : row.id
      const tooltip = typeof hint === 'string' && hint !== '' ? `${title} — ${hint}` : title
      const displayTitle = typeof row.displayTitle === 'string' ? row.displayTitle : ''
      return h(
        'li',
        { className: 'dshsd-session-row', key: row.id },
        h('span', { className: 'dshsd-session-title', title: tooltip }, title),
        h(
          'button',
          {
            type: 'button',
            className: 'dshsd-icon-button',
            'aria-label': t('rowAction.delete'),
            title: t('rowAction.delete'),
            onClick: () => requestDelete(row.id, displayTitle),
          },
          iconTrash(14),
        ),
      )
    }

    /**
     * @param rows - the Session rows of one group.
     * @param options - `{t, requestDelete, hint}`.
     * @returns the list, or the empty note.
     */
    function sessionList(rows, options) {
      if (rows.length === 0) return h('p', { className: 'dshsd-empty' }, options.t('manager.empty'))
      return h('ul', { className: 'dshsd-sessions' }, rows.map((row) => sessionRow(row, options)))
    }

    /**
     * Project the two snapshots into what the panel lists: the registered
     * Workspaces with their listed Sessions, and the ungrouped Sessions
     * grouped by recorded directory.
     *
     * A Session is listed only when it is stored, is not a subagent child and
     * is not archived (`manager.archivedHidden` says so on screen).
     *
     * @param workspaces - the Workspace snapshot.
     * @param sessions - the Session snapshot.
     * @returns `{workspaces: [{item, sessions}], groups: [{path, sessions}]}`.
     */
    function buildManagerModel(workspaces, sessions) {
      const items = workspaces !== null && workspaces !== undefined && Array.isArray(workspaces.items) ? workspaces.items : []
      const archivedIds = workspaces !== null && workspaces !== undefined && Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []
      const archived = new Set(archivedIds)
      const byId = sessions !== null && sessions !== undefined && sessions.byId !== null && sessions.byId !== undefined ? sessions.byId : {}
      const ids = sessions !== null && sessions !== undefined && Array.isArray(sessions.ids) ? sessions.ids : Object.keys(byId)
      const listable = (row) =>
        row !== null && row !== undefined && row.origin !== 'subagent' && !archived.has(row.id)
      const claimed = new Set()
      const workspaceEntries = items.map((item) => {
        const sessionIds = Array.isArray(item.sessionIds) ? item.sessionIds : []
        for (const id of sessionIds) claimed.add(id)
        return { item, sessions: sessionIds.map((id) => byId[id]).filter(listable) }
      })
      const groups = []
      const byPath = new Map()
      for (const id of ids) {
        const row = byId[id]
        if (row === null || row === undefined || claimed.has(row.id) || !listable(row)) continue
        const path = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
        const key = path === null ? '\u0000none' : path
        let group = byPath.get(key)
        if (group === undefined) {
          group = { path, sessions: [] }
          byPath.set(key, group)
          groups.push(group)
        }
        group.sessions.push(row)
      }
      groups.sort((left, right) => {
        if (left.path === null) return 1
        if (right.path === null) return -1
        return left.path.localeCompare(right.path)
      })
      return { workspaces: workspaceEntries, groups }
    }

    /**
     * @param item - one registered Workspace.
     * @returns the name to show for it.
     */
    function workspaceTitle(item) {
      if (typeof item.title === 'string' && item.title !== '') return item.title
      const path = shortPath(item.path)
      if (path !== '') return path
      return String(item.workspaceId)
    }

    // ---------------------------------------------------------------------
    // Slot occupants
    // ---------------------------------------------------------------------

    /**
     * Slot 1 (`sidebar.workspaces.session.menu.item`, order 500): the delete
     * row. Hidden while the Session is the open one.
     *
     * @param props - owner share, the menu open-state hook, the Session hook,
     *   the injected `requestDelete`, and the locale seat.
     * @returns the row, or null.
     */
    function SessionDeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, useSessions, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const open = useSessionOpen(sessionId, useSessions)
      if (open === true) return null
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dshsd-menu-item dshsd-menu-item-danger dshsd-menu-item-separator',
          onClick: () => {
            setMenuOpen(false)
            requestDelete(sessionId, displayTitle)
          },
        },
        iconTrash(14),
        h('span', { className: 'dshsd-menu-label' }, t('menu.session')),
      )
    }

    /**
     * Slot 2 (`sidebar.workspaces.session.row.action`, order 300): the hover
     * trash button. The row's own click handler already swallows clicks in
     * this strip, so this never propagates anything.
     *
     * @param props - owner share, the Session hook, the injected
     *   `requestDelete`, and the locale seat.
     * @returns the button, or null.
     */
    function SessionDeleteRowButton({ sessionId, displayTitle, useSessions, requestDelete, t }) {
      const open = useSessionOpen(sessionId, useSessions)
      if (open === true) return null
      const label = t('rowAction.delete')
      return h(
        'button',
        {
          type: 'button',
          className: 'dshsd-icon-button',
          'aria-label': label,
          title: label,
          onClick: () => requestDelete(sessionId, displayTitle),
        },
        iconTrash(14),
      )
    }

    /**
     * Slot 3 (`sidebar.footer.action`, order 100): the manager entry. The
     * wide column shows icon plus label; the 56px rail shows the icon only.
     *
     * @param props - the column state, the injected `openManager`, and the
     *   locale seat.
     * @returns the footer action.
     */
    function ManagerFooterAction({ wide, openManager, t }) {
      const label = t('manager.entry')
      return h(
        'button',
        {
          type: 'button',
          className: 'dshsd-foot',
          'data-wide': wide === true ? 'true' : 'false',
          'aria-label': label,
          title: label,
          onClick: () => openManager(),
        },
        iconLayers(16),
        wide === true ? h('span', { className: 'dshsd-foot-label' }, label) : null,
      )
    }

    /**
     * One registered Workspace: its name, path, listed Sessions, and — when
     * the caller may delete it — the two-step delete action.
     *
     * @param props - the model entry, the confirm state and its setters, the
     *   access hook, and the locale seat.
     * @returns the Workspace block.
     */
    function WorkspaceBlock(props) {
      const { entry, confirm, onConfirmRequest, onConfirmCancel, onConfirmConfirm, useWorkspaceAccess, t, requestDelete } = props
      const item = entry.item
      const workspaceId = item.workspaceId
      const title = workspaceTitle(item)
      const canDelete = useWorkspaceAccess(workspaceId, 'workspace/delete')
      const confirming = confirm !== null && confirm.workspaceId === workspaceId
      const path = shortPath(item.path)
      return h(
        'div',
        { className: 'dshsd-group' },
        h(
          'div',
          { className: 'dshsd-group-head' },
          h('span', { className: 'dshsd-group-title', title: typeof item.path === 'string' ? item.path : undefined }, title),
          path !== '' && path !== title ? h('span', { className: 'dshsd-group-path', title: item.path }, path) : null,
          canDelete === true
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshsd-link-button dshsd-link-button-danger dshsd-group-action',
                  title: t('manager.deleteWorkspace'),
                  onClick: () => onConfirmRequest(workspaceId, title),
                },
                t('manager.deleteWorkspace'),
              )
            : null,
          h('span', { className: 'dshsd-group-count' }, t('manager.sessions', { n: entry.sessions.length })),
        ),
        confirming
          ? h(
              'div',
              { className: 'dshsd-confirm-box' },
              h('p', { className: 'dshsd-text' }, t('manager.deleteWorkspaceConfirm', { title })),
              confirm.failure !== null
                ? h('p', { className: 'dshsd-error', role: 'alert' }, t('manager.deleteWorkspaceFailed', { message: confirm.failure }))
                : null,
              h(
                'div',
                { className: 'dshsd-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dshsd-button', disabled: confirm.pending === true, onClick: onConfirmCancel },
                  t('confirm.cancel'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dshsd-button dshsd-button-danger', disabled: confirm.pending === true, onClick: onConfirmConfirm },
                  confirm.pending === true ? t('manager.pending') : t('manager.deleteWorkspace'),
                ),
              ),
            )
          : null,
        sessionList(entry.sessions, { t, requestDelete }),
      )
    }

    /**
     * Slot 4 (`shell.overlay`, id `dsh-sidebar-delete.panel`): the frame-wide
     * entry. It renders nothing until a deletion is pending or the manager is
     * open, and it opts back into pointer events for its own layer.
     *
     * @param props - the plugin store and actions, the Workspace service
     *   hops, the standard hooks, and the locale seat.
     * @returns the layer stack, or null.
     */
    function SidebarDeletePanel(props) {
      const { store, actions, useWorkspaces, useSessions, useWorkspaceAccess, deleteWorkspace, createWorkspace, t } = props
      const state = useSelected(store, selectState)
      const managerOpen = state.managerOpen === true
      const request = state.deleteRequest
      if (!managerOpen && request === null) return null
      return h(
        React.Fragment,
        null,
        managerOpen
          ? h(ManagerPanel, {
              key: 'manager',
              actions,
              deleteWorkspace,
              createWorkspace,
              useWorkspaces,
              useSessions,
              useWorkspaceAccess,
              t,
            })
          : null,
        request !== null
          ? h(DeleteSessionDialog, { key: `delete:${request.sessionId}`, request, actions, useSessions, t })
          : null,
      )
    }

    /**
     * The manager panel: registered Workspaces, their Sessions, and the
     * ungrouped Sessions grouped by directory, each with the delete action.
     *
     * @param props - the actions, the two service hops, the two list hooks,
     *   the Workspace access hook, and the locale seat.
     * @returns the dialog.
     */
    function ManagerPanel({ actions, deleteWorkspace, createWorkspace, useWorkspaces, useSessions, useWorkspaceAccess, t }) {
      const workspaces = useWorkspaces(selectWorkspaceSnapshot)
      const sessions = useSessions(selectSessionSnapshot)
      const [registering, setRegistering] = React.useState(null)
      const [registerFailure, setRegisterFailure] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null)
      const cardRef = useDialogFocus()
      const model = buildManagerModel(workspaces, sessions)

      const close = () => {
        if (confirm !== null && confirm.pending === true) return
        actions.closeManager()
      }
      useEscape(close, false)

      const runRegister = (path) => {
        if (registering !== null) return
        setRegistering(path)
        setRegisterFailure(null)
        Promise.resolve()
          .then(() => createWorkspace(path))
          .then(() => {
            setRegistering(null)
          })
          .catch((error) => {
            setRegistering(null)
            setRegisterFailure({ path, message: errorMessage(error) })
          })
      }

      const runWorkspaceDelete = () => {
        if (confirm === null || confirm.pending === true) return
        const workspaceId = confirm.workspaceId
        setConfirm({ ...confirm, pending: true, failure: null })
        Promise.resolve()
          .then(() => deleteWorkspace(workspaceId))
          .then(() => {
            setConfirm(null)
          })
          .catch((error) => {
            setConfirm((current) =>
              current === null || current.workspaceId !== workspaceId ? current : { ...current, pending: false, failure: errorMessage(error) },
            )
          })
      }

      const orphanFailure =
        registerFailure !== null && !model.groups.some((group) => group.path === registerFailure.path) ? registerFailure : null

      return h(
        'div',
        {
          className: 'dshsd-layer',
          onClick: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            className: 'dshsd-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('manager.title'),
            tabIndex: -1,
            ref: cardRef,
          },
          h(
            'div',
            { className: 'dshsd-card-head' },
            h('h2', { className: 'dshsd-card-title' }, t('manager.title')),
            h('button', { type: 'button', className: 'dshsd-link-button', onClick: close }, t('manager.close')),
          ),
          h('p', { className: 'dshsd-note' }, t('manager.ungroupedNote')),
          h(
            'div',
            { className: 'dshsd-card-body' },
            h(
              'div',
              { className: 'dshsd-sections' },
              h(
                'div',
                { className: 'dshsd-section' },
                h('h3', { className: 'dshsd-section-title' }, t('manager.workspaces')),
                model.workspaces.length === 0
                  ? h('p', { className: 'dshsd-empty' }, t('manager.emptyWorkspaces'))
                  : model.workspaces.map((entry) =>
                      h(WorkspaceBlock, {
                        key: String(entry.item.workspaceId),
                        entry,
                        confirm,
                        useWorkspaceAccess,
                        t,
                        requestDelete: actions.requestDelete,
                        onConfirmRequest: (workspaceId, title) => setConfirm({ workspaceId, title, pending: false, failure: null }),
                        onConfirmCancel: () => setConfirm(null),
                        onConfirmConfirm: runWorkspaceDelete,
                      }),
                    ),
              ),
              h(
                'div',
                { className: 'dshsd-section' },
                h('h3', { className: 'dshsd-section-title' }, t('manager.ungrouped')),
                orphanFailure !== null
                  ? h('p', { className: 'dshsd-error', role: 'alert' }, t('manager.register.failed', { message: orphanFailure.message }))
                  : null,
                model.groups.length === 0 ? h('p', { className: 'dshsd-empty' }, t('manager.empty')) : null,
                model.groups.map((group) => {
                  const path = group.path
                  const busy = path !== null && registering === path
                  const failure = path !== null && registerFailure !== null && registerFailure.path === path ? registerFailure : null
                  return h(
                    'div',
                    { className: 'dshsd-group', key: path === null ? '\u0000none' : path },
                    h(
                      'div',
                      { className: 'dshsd-group-head' },
                      h('span', { className: 'dshsd-group-title', title: path === null ? undefined : path }, path === null ? t('manager.noCwd') : shortPath(path)),
                      path !== null
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'dshsd-link-button dshsd-group-action',
                              disabled: busy,
                              title: t('manager.register'),
                              onClick: () => runRegister(path),
                            },
                            busy ? t('manager.register.pending') : t('manager.register'),
                          )
                        : null,
                      h('span', { className: 'dshsd-group-count' }, t('manager.sessions', { n: group.sessions.length })),
                    ),
                    failure !== null
                      ? h('p', { className: 'dshsd-error', role: 'alert' }, t('manager.register.failed', { message: failure.message }))
                      : null,
                    sessionList(group.sessions, {
                      t,
                      requestDelete: actions.requestDelete,
                      hint: path === null ? t('manager.noCwd') : null,
                    }),
                  )
                }),
                h('p', { className: 'dshsd-note' }, t('manager.archivedHidden')),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * The delete confirmation: the Session name, the cascade count, and the
     * one request this plugin sends. In-flight and failure state die with the
     * dialog, which is keyed by the Session it targets.
     *
     * @param props - the pending request, the store actions, the Session
     *   hook, and the locale seat.
     * @returns the dialog.
     */
    function DeleteSessionDialog({ request, actions, useSessions, t }) {
      const [pending, setPending] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const sessions = useSessions(selectSessionSnapshot)
      const cardRef = useDialogFocus()
      const byId = sessions !== null && sessions !== undefined ? sessions.byId : undefined
      const row = byId === undefined || byId === null ? undefined : byId[request.sessionId]
      const open = useSessionOpen(request.sessionId, useSessions)
      const cascade = countDescendants(byId, request.sessionId)
      const title = typeof request.displayTitle === 'string' && request.displayTitle !== '' ? request.displayTitle : request.sessionId

      const close = () => {
        if (pending === true) return
        actions.settleDelete()
      }
      useEscape(close, true)

      const confirm = () => {
        if (pending === true || open === true) return
        setPending(true)
        setFailure(null)
        requestSessionDelete(request.sessionId).then((outcome) => {
          if (outcome.ok === true) {
            actions.settleDelete()
            return
          }
          setPending(false)
          setFailure(outcome)
        })
      }

      return h(
        'div',
        {
          className: 'dshsd-layer dshsd-layer-top',
          onClick: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            className: 'dshsd-card dshsd-card-confirm',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('confirm.title', { title }),
            tabIndex: -1,
            ref: cardRef,
          },
          h('h2', { className: 'dshsd-card-title' }, t('confirm.title', { title })),
          h('p', { className: 'dshsd-text' }, t('confirm.desc')),
          cascade > 0 ? h('p', { className: 'dshsd-text' }, t('confirm.cascade', { n: cascade })) : null,
          open === true ? h('p', { className: 'dshsd-error', role: 'alert' }, t('confirm.current')) : null,
          failure !== null ? h('p', { className: 'dshsd-error', role: 'alert' }, deleteFailureText(failure, t)) : null,
          h(
            'div',
            { className: 'dshsd-actions' },
            h('button', { type: 'button', className: 'dshsd-button', disabled: pending === true, onClick: close }, t('confirm.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'dshsd-button dshsd-button-danger',
                disabled: pending === true || open === true,
                onClick: confirm,
              },
              pending === true ? t('confirm.pending') : t('confirm.action'),
            ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------

    /**
     * Register the dictionaries, the stylesheet and the four slot occupants.
     *
     * @param ctx - client root context carrying `slots` and `locale`.
     */
    function apply(ctx) {
      const store = createStore({ deleteRequest: null, managerOpen: false })
      const actions = {
        requestDelete(sessionId, displayTitle) {
          store.set({
            ...store.getSnapshot(),
            deleteRequest: { sessionId, displayTitle: typeof displayTitle === 'string' ? displayTitle : '' },
          })
        },
        settleDelete() {
          store.set({ ...store.getSnapshot(), deleteRequest: null })
        },
        openManager() {
          store.set({ ...store.getSnapshot(), managerOpen: true })
        },
        closeManager() {
          store.set({ ...store.getSnapshot(), managerOpen: false })
        },
      }

      /** Read the Workspace service late, so a composition without it still mounts. */
      const workspaceService = () => {
        try {
          return typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined
        } catch (error) {
          return undefined
        }
      }
      const deleteWorkspace = async (workspaceId) => {
        const service = workspaceService()
        if (service === null || service === undefined || typeof service.delete !== 'function') {
          throw new Error('the workspaces service is unavailable')
        }
        await service.delete(workspaceId)
      }
      const createWorkspace = async (path) => {
        const service = workspaceService()
        if (service === null || service === undefined || typeof service.create !== 'function') {
          throw new Error('the workspaces service is unavailable')
        }
        await service.create({ path })
      }

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-sidebar-delete: dictionaries')
      ctx.effect(() => installStyles(), 'dsh-sidebar-delete: styles')

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-sidebar-delete.session',
            order: 500,
            locale: NS,
            inject: () => ({ requestDelete: actions.requestDelete }),
          },
          SessionDeleteMenuItem,
        ),
      )
      ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.row.action',
            id: 'dsh-sidebar-delete.session-row',
            order: 300,
            locale: NS,
            inject: () => ({ requestDelete: actions.requestDelete }),
          },
          SessionDeleteRowButton,
        ),
      )
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-sidebar-delete.manager',
            order: 100,
            locale: NS,
            inject: () => ({ openManager: actions.openManager }),
          },
          ManagerFooterAction,
        ),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-sidebar-delete.panel',
            order: 100,
            locale: NS,
            inject: () => ({ store, actions, deleteWorkspace, createWorkspace }),
          },
          SidebarDeletePanel,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
