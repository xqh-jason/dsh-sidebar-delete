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
      'error.live': 'This session (or one of its child sessions) is still running. Stop it first.',
      'error.held': 'The host still holds this session. Restart dsh and try again.',
      'error.hostUnavailable': 'Delete failed: the Host half is unavailable. The plugin may be incomplete; restart dsh and retry.',
      'error.serviceUnavailable': 'The workspace service is unavailable. The plugin may be incomplete; restart dsh and retry.',
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
      'manager.archivedHidden': 'Archived sessions are not listed here; subagent sessions appear under their parent.',
      'manager.untitled': 'Untitled session',
      'manager.subagent': 'Subagent',
      'manager.running': 'Running',
      'manager.current': 'Open now',
      'manager.blank': 'Blank',
      'manager.childCount': 'includes {n} child session(s)',
      'manager.rowMeta': '{id} · {time}',
      'manager.blockedCurrent': 'Open in the main view — switch to another session first',
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
      'error.live': '该会话（或它的子会话）仍在运行，请先停止后再删除。',
      'error.held': '宿主仍占用这个会话，暂时删不了；重启 dsh 后再试一次。',
      'error.hostUnavailable': '删除失败：Host 半不可用，插件可能没有完整安装，重启 dsh 后再试。',
      'error.serviceUnavailable': '工作区服务不可用：插件可能没有完整安装，重启 dsh 后再试。',
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
      'manager.archivedHidden': '已归档的会话不在这里显示；子代理会话会挂在它的父会话下面。',
      'manager.untitled': '未命名会话',
      'manager.subagent': '子代理',
      'manager.running': '运行中',
      'manager.current': '当前打开',
      'manager.blank': '空会话',
      'manager.childCount': '含 {n} 条子会话',
      'manager.rowMeta': '{id} · {time}',
      'manager.blockedCurrent': '当前打开的会话，先切到别的会话再删',
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
.dshsd-session-row{display:flex;align-items:flex-start;gap:8px;padding:4px 4px 4px 10px;border-radius:var(--dsw-radius-xs)}
.dshsd-session-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsd-session-main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.dshsd-session-line{display:flex;align-items:center;gap:6px;min-width:0}
.dshsd-session-title{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dshsd-session-cascade{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshsd-badges{display:inline-flex;align-items:center;gap:4px;flex:none}
.dshsd-badge{padding:0 6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-xs)}
.dshsd-session-meta{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.3}
.dshsd-session-delete{flex:none;margin-top:2px}
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
     * The one CPU-readable piece of text a rejected promise can contribute:
     * an `Error` message or a plain string, otherwise `String(reason)`.
     *
     * An empty return means "no usable text": the caller classifies such a
     * rejection as service unavailability and renders a locale sentence
     * instead of interpolating a placeholder like `[object Object]`.
     *
     * @param reason - anything a rejected promise or `fetch` produced.
     * @returns the reason's own text, or `''`.
     */
    function errorMessage(reason) {
      if (reason instanceof Error && typeof reason.message === 'string' && reason.message !== '') return reason.message
      if (typeof reason === 'string' && reason !== '') return reason
      try {
        const text = String(reason)
        return text === '[object Object]' ? '' : text
      } catch {
        return ''
      }
    }

    /**
     * Marker code on the rejections this file raises itself, so they are
     * recognized by identity and never by their (never rendered) message.
     */
    const CODE_SERVICE_UNAVAILABLE = 'dshsd/workspaces-service-unavailable'

    /**
     * A rejection saying the client half could not reach its Workspace
     * service. The message is developer-facing only (logs); the UI words this
     * through `failureText`.
     *
     * @returns the tagged error.
     */
    function serviceUnavailable() {
      const error = new Error(CODE_SERVICE_UNAVAILABLE)
      error.name = 'SidebarDeleteServiceError'
      error.code = CODE_SERVICE_UNAVAILABLE
      return error
    }

    /**
     * Classify a rejected service call into a localizable failure. No English
     * is composed here, and none is displayed: a rejection without usable text
     * (or one of this file's own markers) reports the service as unavailable.
     *
     * @param reason - the rejection reason.
     * @returns `{kind, message}` with `kind` `serviceUnavailable` or `generic`.
     */
    function failureOf(reason) {
      if (reason !== null && typeof reason === 'object' && reason.code === CODE_SERVICE_UNAVAILABLE) {
        return { kind: 'serviceUnavailable', message: '' }
      }
      const message = errorMessage(reason)
      if (message === '') return { kind: 'serviceUnavailable', message: '' }
      return { kind: 'generic', message }
    }

    /**
     * Ask the Host half to delete one Session branch.
     *
     * @param sessionId - the Session to delete.
     * @returns a plain outcome: `{ok:true}` or `{ok:false, kind, message}`
     *   where `kind` is `hostUnavailable`, `live`, `held` or `generic`. The
     *   `message` is the failing side's own text and is only ever rendered for
     *   `generic` (through `error.generic`); on the other kinds it is a
     *   diagnostic.
     */
    async function requestSessionDelete(sessionId) {
      if (typeof document === 'undefined' || typeof fetch !== 'function') {
        return { ok: false, kind: 'hostUnavailable', message: 'no-fetch' }
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
        return { ok: false, kind: 'hostUnavailable', message: `HTTP ${response.status}` }
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
        // A well-formed Host half always answers with its own JSON; anything
        // else means the route is not the plugin's, so the localized
        // "Host half unavailable" sentence is the honest report.
        return { ok: false, kind: 'hostUnavailable', message: `HTTP ${response.status}` }
      }
      const code = typeof payload.code === 'string' ? payload.code : ''
      const message = typeof payload.message === 'string' && payload.message !== '' ? payload.message : `HTTP ${response.status}`
      if (code === 'session-active') return { ok: false, kind: 'live', message }
      if (code === 'session-held') return { ok: false, kind: 'held', message }
      return { ok: false, kind: 'generic', message }
    }

    /**
     * Word one failure through the locale seat. The `live`, `held`,
     * `serviceUnavailable` and `hostUnavailable` kinds each have their own
     * sentence; every other kind goes through the caller's "…failed: {message}"
     * key, and that message is the failing service's own text — this file never
     * composes display text in English.
     *
     * `live` and `held` are the Host's two refusals: open/running work versus a
     * session the process still holds but is no longer running (restarting dsh
     * releases it).
     *
     * @param failure - an outcome from {@link requestSessionDelete} or a
     *   {@link failureOf} result.
     * @param t - locale seat.
     * @param genericKey - the locale key taking `{message}`.
     * @returns the sentence to show.
     */
    function failureText(failure, t, genericKey) {
      if (failure.kind === 'live') return t('error.live')
      if (failure.kind === 'held') return t('error.held')
      if (failure.kind === 'serviceUnavailable') return t('error.serviceUnavailable')
      if (failure.kind === 'hostUnavailable') return t('error.hostUnavailable')
      return t(genericKey, { message: failure.message })
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

    /** How much of a Session id the meta line shows. */
    const META_ID_LENGTH = 8

    /** The meta line's indent, and the extra indent one nesting level adds. */
    const SESSION_INDENT_BASE = 10
    const SESSION_INDENT_STEP = 14

    /**
     * `MM-DD HH:mm` in the reader's own zone.
     *
     * @param value - epoch milliseconds.
     * @returns the formatted time, or `''` when the value is not a date.
     */
    function formatUpdatedAt(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (part) => String(part).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Leading token of the main Session id shape (`session-<uuid>`). */
    const SESSION_ID_TOKEN = 'session-'

    /**
     * The distinctive head of a Session id: one leading `session-` is dropped
     * before the first {@link META_ID_LENGTH} characters are taken, so
     * `session-95fcd792-…` and the bare `95fcd792-…` both read `95fcd792`.
     *
     * Without that, every id of the main shape would render the same constant
     * `session-`, which is exactly the ambiguity this line exists to remove.
     * Both id shapes are handled; no shape is required.
     *
     * @param value - a Session id.
     * @returns the short id for display.
     */
    function shortSessionId(value) {
      const id = typeof value === 'string' ? value : ''
      const body = id.startsWith(SESSION_ID_TOKEN) && id.length > SESSION_ID_TOKEN.length ? id.slice(SESSION_ID_TOKEN.length) : id
      return body.slice(0, META_ID_LENGTH)
    }

    /**
     * The row's second line: the short id, and the last-update time when the
     * snapshot carries one. A missing/zero `updatedAt` (the controller stamps
     * `0` on subagent rows it synthesizes) shows the id alone rather than a
     * 1970 timestamp.
     *
     * @param row - one Session row.
     * @param t - locale seat.
     * @returns the meta text.
     */
    function rowMeta(row, t) {
      const id = shortSessionId(row.id)
      const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) && row.updatedAt > 0 ? row.updatedAt : 0
      if (updatedAt === 0) return id
      const time = formatUpdatedAt(updatedAt)
      if (time === '') return id
      return t('manager.rowMeta', { id, time })
    }

    /**
     * The state badges of one row, in display order.
     *
     * @param row - one Session row.
     * @param t - locale seat.
     * @returns the badge labels.
     */
    function rowBadges(row, t) {
      const badges = []
      if (isSessionRetained(row)) badges.push(t('manager.current'))
      if (row.running === true) badges.push(t('manager.running'))
      if (row.origin === 'subagent') badges.push(t('manager.subagent'))
      if (row.blank === true) badges.push(t('manager.blank'))
      return badges
    }

    /**
     * A session row inside the manager: two lines (title plus state badges,
     * then the short id and last-update time), indented by nesting depth, and
     * the delete action that raises the shared confirmation dialog.
     *
     * The title is the persisted `title`; `displayTitle` is deliberately not
     * used here, because the controller derives it from the cwd's directory
     * name, which is already the group heading.
     *
     * The delete action is disabled (with its reason as the label and tooltip)
     * for the row the main view holds and for a running row — the two states
     * the Host would refuse anyway.
     *
     * @param node - `{row, depth, descendants}` from {@link flattenForest}.
     * @param options - `{t, requestDelete, hint}`.
     * @returns the list item.
     */
    function sessionRow(node, options) {
      const { t, requestDelete, hint } = options
      const row = node.row
      const title = typeof row.title === 'string' && row.title !== '' ? row.title : t('manager.untitled')
      const badges = rowBadges(row, t)
      const tooltip = typeof hint === 'string' && hint !== '' ? `${title} — ${hint}` : title
      // Only the session displayed in the main view is blocked on the control:
      // that signal is exact. A row's `running` flag comes from the list
      // snapshot and can lag behind a finished turn, and a stale flag must not
      // disable the button on a session that is actually idle — the Host checks
      // for an open turn itself and answers with an accurate reason.
      const blocked = isSessionRetained(row) ? t('manager.blockedCurrent') : null
      const label = blocked === null ? t('rowAction.delete') : blocked
      return h(
        'li',
        {
          className: 'dshsd-session-row',
          key: row.id,
          style: { paddingLeft: `${SESSION_INDENT_BASE + node.depth * SESSION_INDENT_STEP}px` },
          title: tooltip,
        },
        h(
          'div',
          { className: 'dshsd-session-main' },
          h(
            'div',
            { className: 'dshsd-session-line' },
            h('span', { className: 'dshsd-session-title' }, title),
            badges.length === 0
              ? null
              : h(
                  'span',
                  { className: 'dshsd-badges' },
                  badges.map((text, index) => h('span', { className: 'dshsd-badge', key: `${row.id}:${String(index)}` }, text)),
                ),
            node.descendants > 0
              ? h('span', { className: 'dshsd-session-cascade' }, t('manager.childCount', { n: node.descendants }))
              : null,
          ),
          h('div', { className: 'dshsd-session-meta' }, rowMeta(row, t)),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshsd-icon-button dshsd-session-delete',
            'aria-label': label,
            title: label,
            disabled: blocked !== null,
            onClick: () => requestDelete(row.id, typeof row.title === 'string' ? row.title : ''),
          },
          iconTrash(14),
        ),
      )
    }

    /**
     * @param nodes - the `{row, depth, descendants}` nodes of one group.
     * @param options - `{t, requestDelete, hint}`.
     * @returns the list, or the empty note.
     */
    function sessionList(nodes, options) {
      if (nodes.length === 0) return h('p', { className: 'dshsd-empty' }, options.t('manager.empty'))
      return h('ul', { className: 'dshsd-sessions' }, nodes.map((node) => sessionRow(node, options)))
    }

    /**
     * Every `byId` row in display order: the list's own order first, then the
     * rows the controller holds only in `byId` (it synthesizes subagent rows
     * there without adding them to `ids`, so iterating `ids` alone would hide
     * exactly the sessions this panel exists to make visible).
     *
     * @param byId - the Session index.
     * @param ids - the list's ordered ids.
     * @returns the ordered row ids.
     */
    function rowOrder(byId, ids) {
      const order = []
      const seen = new Set()
      for (const id of ids) {
        if (byId[id] === undefined || seen.has(id)) continue
        seen.add(id)
        order.push(id)
      }
      for (const id of Object.keys(byId)) {
        if (seen.has(id)) continue
        seen.add(id)
        order.push(id)
      }
      return order
    }

    /**
     * Build one scope's parent/child forest. A row is a root when its
     * `parentId` is missing or points outside this scope's listed rows — a
     * parent in another section, an archived one, or a deleted one — so an
     * orphan child surfaces with its own badge instead of vanishing.
     *
     * A parent cycle leaves rows unreachable from every root; the rescue pass
     * adopts them as roots so no listed row can be dropped.
     *
     * @param scopeIds - the ids of this scope, in display order.
     * @param byId - the Session index.
     * @param archived - ids hidden everywhere.
     * @returns the roots, each `{row, depth, children, size}`.
     */
    function buildForest(scopeIds, byId, archived) {
      const listed = []
      const listedIds = new Set()
      for (const id of scopeIds) {
        const row = byId[id]
        if (row === null || row === undefined || typeof row.id !== 'string' || listedIds.has(row.id) || archived.has(row.id)) continue
        listedIds.add(row.id)
        listed.push(row)
      }
      const childrenOf = new Map()
      const roots = []
      for (const row of listed) {
        const parentId = typeof row.parentId === 'string' && row.parentId !== '' ? row.parentId : undefined
        if (parentId !== undefined && parentId !== row.id && listedIds.has(parentId)) {
          const bucket = childrenOf.get(parentId)
          if (bucket === undefined) childrenOf.set(parentId, [row])
          else bucket.push(row)
        } else {
          roots.push(row)
        }
      }
      const attached = new Set()
      const build = (row, depth, trail) => {
        attached.add(row.id)
        const children = []
        for (const child of childrenOf.get(row.id) ?? []) {
          if (trail.has(child.id)) continue
          children.push(build(child, depth + 1, new Set([...trail, child.id])))
        }
        let size = children.length
        for (const child of children) size += child.size
        return { row, depth, children, size }
      }
      const trees = roots.map((row) => build(row, 0, new Set([row.id])))
      for (const row of listed) {
        if (attached.has(row.id)) continue
        trees.push(build(row, 0, new Set([row.id])))
      }
      return trees
    }

    /**
     * @param trees - a forest from {@link buildForest}.
     * @returns the rows in depth-first order, each with its depth and the
     *   number of rows nested under it.
     */
    function flattenForest(trees) {
      const nodes = []
      const walk = (node) => {
        nodes.push({ row: node.row, depth: node.depth, descendants: node.size })
        for (const child of node.children) walk(child)
      }
      for (const tree of trees) walk(tree)
      return nodes
    }

    /**
     * Index every row's children by `parentId`, across origins (a fork child
     * and a subagent child are the same edge to the Host's deletion cascade).
     *
     * @param order - the rows to index, in display order.
     * @param byId - the Session index.
     * @returns `parentId -> rows`.
     */
    function childrenIndex(order, byId) {
      const childrenOf = new Map()
      for (const id of order) {
        const row = byId[id]
        if (row === null || row === undefined) continue
        const parentId = typeof row.parentId === 'string' && row.parentId !== '' ? row.parentId : undefined
        if (parentId === undefined || parentId === row.id) continue
        const bucket = childrenOf.get(parentId)
        if (bucket === undefined) childrenOf.set(parentId, [row])
        else bucket.push(row)
      }
      return childrenOf
    }

    /**
     * Collect one Workspace's scope: the rows it lists plus every descendant
     * of those rows, transitively — crossing `origin`, and skipping rows
     * another section already claimed or that are archived. Claiming
     * descendants here is what keeps a Workspace's subagent/fork children in
     * its own section instead of dropping them into "Ungrouped".
     *
     * @param members - the Workspace's own member ids, in its order.
     * @param byId - the Session index.
     * @param order - every row id in display order.
     * @param childrenOf - the {@link childrenIndex} of `order`.
     * @param archived - ids hidden everywhere.
     * @param claimed - ids already owned by an earlier section; extended here.
     * @returns the scope's ids: members first, then discovered descendants.
     */
    function workspaceScope(members, byId, order, childrenOf, archived, claimed) {
      const scope = new Set()
      const queue = []
      const admit = (id) => {
        if (scope.has(id) || claimed.has(id) || archived.has(id) || byId[id] === undefined) return false
        scope.add(id)
        queue.push(id)
        return true
      }
      for (const id of members) admit(id)
      for (let index = 0; index < queue.length; index += 1) {
        for (const child of childrenOf.get(queue[index]) ?? []) admit(child.id)
      }
      const scoped = []
      const seen = new Set()
      for (const id of members) {
        if (!scope.has(id) || seen.has(id)) continue
        seen.add(id)
        scoped.push(id)
      }
      for (const id of order) {
        if (!scope.has(id) || seen.has(id)) continue
        seen.add(id)
        scoped.push(id)
      }
      for (const id of scoped) claimed.add(id)
      return scoped
    }

    /**
     * Project the two snapshots into what the panel lists: the registered
     * Workspaces with their Sessions, and the ungrouped Sessions grouped by
     * recorded directory. Every Session row of `byId` is placed exactly once,
     * subagent rows included; only archived rows are hidden
     * (`manager.archivedHidden` says so on screen).
     *
     * Sections claim in order: each Workspace takes its members and their
     * descendants, and whatever is left — including a subagent whose parent
     * is not listed anywhere — lands in "Ungrouped", so no row can vanish.
     *
     * @param workspaces - the Workspace snapshot.
     * @param sessions - the Session snapshot.
     * @returns `{workspaces: [{item, nodes}], groups: [{path, nodes}]}`.
     */
    function buildManagerModel(workspaces, sessions) {
      const items = workspaces !== null && workspaces !== undefined && Array.isArray(workspaces.items) ? workspaces.items : []
      const archivedIds = workspaces !== null && workspaces !== undefined && Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []
      const archived = new Set(archivedIds)
      const byId = sessions !== null && sessions !== undefined && sessions.byId !== null && sessions.byId !== undefined ? sessions.byId : {}
      const ids = sessions !== null && sessions !== undefined && Array.isArray(sessions.ids) ? sessions.ids : Object.keys(byId)
      const order = rowOrder(byId, ids)
      const childrenOf = childrenIndex(order, byId)
      const claimed = new Set()
      const workspaceEntries = items.map((item) => {
        const members = Array.isArray(item.sessionIds) ? item.sessionIds : []
        const scoped = workspaceScope(members, byId, order, childrenOf, archived, claimed)
        return { item, nodes: flattenForest(buildForest(scoped, byId, archived)) }
      })
      const groups = []
      const byPath = new Map()
      for (const tree of buildForest(order.filter((id) => !claimed.has(id)), byId, archived)) {
        const path = typeof tree.row.cwd === 'string' && tree.row.cwd !== '' ? tree.row.cwd : null
        const key = path === null ? '\u0000none' : path
        let group = byPath.get(key)
        if (group === undefined) {
          group = { path, trees: [] }
          byPath.set(key, group)
          groups.push(group)
        }
        group.trees.push(tree)
      }
      for (const group of groups) group.nodes = flattenForest(group.trees)
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
          h('span', { className: 'dshsd-group-count' }, t('manager.sessions', { n: entry.nodes.length })),
        ),
        confirming
          ? h(
              'div',
              { className: 'dshsd-confirm-box' },
              h('p', { className: 'dshsd-text' }, t('manager.deleteWorkspaceConfirm', { title })),
              confirm.failure !== null
                ? h(
                    'p',
                    { className: 'dshsd-error', role: 'alert' },
                    failureText(confirm.failure, t, 'manager.deleteWorkspaceFailed'),
                  )
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
        sessionList(entry.nodes, { t, requestDelete }),
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
            setRegisterFailure({ path, failure: failureOf(error) })
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
              current === null || current.workspaceId !== workspaceId ? current : { ...current, pending: false, failure: failureOf(error) },
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
                  ? h('p', { className: 'dshsd-error', role: 'alert' }, failureText(orphanFailure.failure, t, 'manager.register.failed'))
                  : null,
                model.groups.length === 0 ? h('p', { className: 'dshsd-empty' }, t('manager.empty')) : null,
                model.groups.map((group) => {
                  const path = group.path
                  const busy = path !== null && registering === path
                  const failure = path !== null && registerFailure !== null && registerFailure.path === path ? registerFailure.failure : null
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
                      h('span', { className: 'dshsd-group-count' }, t('manager.sessions', { n: group.nodes.length })),
                    ),
                    failure !== null
                      ? h('p', { className: 'dshsd-error', role: 'alert' }, failureText(failure, t, 'manager.register.failed'))
                      : null,
                    sessionList(group.nodes, {
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
          failure !== null ? h('p', { className: 'dshsd-error', role: 'alert' }, failureText(failure, t, 'error.generic')) : null,
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
          throw serviceUnavailable()
        }
        await service.delete(workspaceId)
      }
      const createWorkspace = async (path) => {
        const service = workspaceService()
        if (service === null || service === undefined || typeof service.create !== 'function') {
          throw serviceUnavailable()
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
