// The plugin's worker: finds the focused workspace's Claude Code sessions,
// reads the chosen one's transcript (read-only), and answers the panel with
// its trajectory. It watches that transcript and tells open panels when it
// changes, so the panel follows a session as it runs. Every few seconds it
// also looks at the subagent meta files of each recent session on this
// machine and keeps a status bar item saying how many subagents are running.
//
// It never writes a file, runs a command or opens a connection. What it sends
// the panel is short previews, cleaned and masked (src/redact.ts).

import type { OrcaWorkerApi } from 'orca/worker'
import { watch, type FSWatcher } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { claudeHome, liveSubagents, listSessions, readSubagents, SESSION_ID, TranscriptCache, type LiveSubagent } from './locate.ts'
import { isAgentTool, plural, took } from './format.ts'
import { build } from './transcript.ts'
import type { Trajectory, TrajectoryAnswer, WorkspaceInfo } from './protocol.ts'
import { cut, stripControls } from './redact.ts'

const MAX_ANSWER = 384 * 1024 // well under what a request may answer (1 MiB) and a panel may draw (512 KiB)
const DEBOUNCE_MS = 600
const TICK_MS = 15_000 // how far a running subagent's clock may fall behind while nothing is written

/** The status bar's pace and reach. Tests shorten `everyMs`. */
export const STATUS = {
  item: 'subagents', // the `contributes.statusBarItems` id
  everyMs: 5_000, // between looks at the meta files
  recentMs: 30 * 60_000, // sessions written this recently are looked at
  listed: 12 // subagents named in the tooltip
}

type Workspace = { id: string; name: string; path: string; branch: string | null; hostId: string | null }

const normBranch = (b: string | null | undefined): string => (b ?? '').replace(/^refs\/heads\//, '')
const label = (s: string): string => cut(stripControls(s).replace(/\s+/g, ' ').trim(), 80) || 'Workspace'

// "squad-chat · next": the folder, then Orca's name for the workspace when it says more.
function workspaceName(w: Workspace): string {
  const folder = basename(w.path)
  return label(w.name && w.name !== folder ? `${folder} · ${w.name}` : folder)
}

// Workspaces on this machine: a transcript can only be read where it was written.
async function localWorkspaces(orca: OrcaWorkerApi): Promise<Workspace[]> {
  const { workspaces } = await orca.host.call('workspace.list', {})
  return workspaces
    .filter((w) => (w.hostId == null || w.hostId === 'local') && typeof w.path === 'string' && isAbsolute(w.path))
    .map((w) => ({ id: w.id, name: w.name, path: w.path, branch: w.branch, hostId: w.hostId }))
}

// The workspace Orca has focused. Orca names it by display name and branch,
// which several workspaces can share; the one with the newest session wins.
async function focusedWorkspace(orca: OrcaWorkerApi, all: Workspace[], home: string): Promise<Workspace | null> {
  const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
  if (!ctx) return null
  const matches = all.filter((w) => w.name === ctx.displayName && normBranch(w.branch) === normBranch(ctx.branch))
  if (matches.length <= 1) return matches[0] ?? null
  let best: { w: Workspace; at: number } | null = null
  for (const w of matches) {
    const { sessions } = await listSessions(home, w.path)
    const at = sessions[0]?.updatedAt ?? -1
    if (!best || at > best.at) best = { w, at }
  }
  return best?.w ?? null
}

// Drops the FIXED breakdown, then the oldest turns, then the oldest requests of
// what is left, until the answer fits what a request may carry and a panel may
// draw: the conversation matters more than what the overhead is made of.
export function fit(answer: TrajectoryAnswer): TrajectoryAnswer {
  const data = answer.data
  if (!data) return answer
  while (JSON.stringify(answer).length > MAX_ANSWER) {
    if (data.fixed) {
      data.fixed = null
      data.fixedTrimmed = true
      continue
    }
    if (data.turns.length > 1) data.turns.shift()
    else if (data.turns[0] && data.turns[0].steps.length > 1) data.turns[0].steps.shift()
    else if (data.turns[0]?.steps[0]?.calls.length) data.turns[0].steps[0].calls.shift()
    else break
    data.truncated = true
  }
  return answer
}

// ---------------------------------------------------------------- running subagents

type Running = { workspaceId: string; workspace: string; sessionId: string; title: string; agents: LiveSubagent[] }

// Every local session written lately that has a subagent running, from the meta files only.
// Each one written in the window, not the picker's newest few: a workspace busy
// with many short sessions can have its running subagent in an older one.
async function runningNow(orca: OrcaWorkerApi, home: string, now: number): Promise<Running[]> {
  const out: Running[] = []
  const seen = new Set<string>() // two workspaces can share a folder
  for (const w of await localWorkspaces(orca)) {
    const { root, sessions } = await listSessions(home, w.path, { since: now - STATUS.recentMs })
    for (const s of sessions) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      const agents = await liveSubagents(root, s.dir, s.id, now)
      if (agents.length) out.push({ workspaceId: w.id, workspace: workspaceName(w), sessionId: s.id, title: s.title, agents })
    }
  }
  return out
}

/** What the status bar item says about the running subagents. Plain text: a tooltip takes no colour. */
function statusOf(running: readonly Running[], now: number): { visible: boolean; text: string; tooltip: string } {
  const count = running.reduce((n, r) => n + r.agents.length, 0)
  if (!count) return { visible: false, text: 'No subagents running', tooltip: 'No subagents running' }
  const text = `${plural(count, 'subagent')} running${running.length > 1 ? ` · ${plural(running.length, 'session')}` : ''}`
  const lines: string[] = []
  let named = 0
  for (const r of running) {
    // A workspace with two sessions running says which is which.
    const twin = running.some((o) => o !== r && o.workspaceId === r.workspaceId)
    lines.push(twin ? `${r.workspace} · ${r.title}` : r.workspace)
    for (const a of r.agents) {
      if (named++ >= STATUS.listed) continue
      lines.push(`  ${[a.agentType ?? 'Agent', a.description, took(Math.max(0, now - a.startedAt))].filter(Boolean).join(' · ')}`)
    }
  }
  if (named > STATUS.listed) lines.push(`  and ${named - STATUS.listed} more`)
  lines.push('Click to show in Claude Trajectory')
  return { visible: true, text, tooltip: lines.join('\n') }
}

let stop: (() => void) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const cache = new TranscriptCache()
  let watchers: FSWatcher[] = []
  let watched: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let tick: ReturnType<typeof setTimeout> | null = null
  let watchedId: string | null = null

  const unwatch = (): void => {
    for (const w of watchers) w.close()
    watchers = []
    watched = null
    watchedId = null
    if (timer) clearTimeout(timer)
    timer = null
    if (tick) clearTimeout(tick)
    tick = null
  }

  const watchOne = (path: string, on: (name: string | null) => void): FSWatcher | null => {
    try {
      const w = watch(path, { persistent: false }, (_event, name) => on(typeof name === 'string' ? name : null))
      w.on('error', () => w.close())
      watchers.push(w)
      return w
    } catch {
      return null // not there yet, or the file went away
    }
  }

  // Tells open panels the session changed, at most once per DEBOUNCE_MS.
  const follow = (sessionId: string, file: string, dir: string): void => {
    if (watched === file) return
    unwatch()
    watched = file
    watchedId = sessionId
    const changed = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        orca.panels.post('trajectory.changed', { sessionId })
      }, DEBOUNCE_MS)
    }
    watchOne(file, changed)
    // The session's subagents folder appears with its first subagent, maybe
    // after the watch began: until then, watch the folder it will appear in.
    const sessionDir = join(dir, sessionId)
    const subDir = join(sessionDir, 'subagents')
    let parent: FSWatcher | null = null
    const attach = (): boolean => {
      if (!watchOne(subDir, changed)) return false
      parent?.close()
      parent = null
      changed() // what was written before the watch began
      return true
    }
    if (watchOne(subDir, changed)) return
    const waitFor = (): void => {
      if (attach()) return
      parent?.close()
      parent = watchOne(sessionDir, (name) => (name === null || name === 'subagents') && attach())
      parent ??= watchOne(dir, (name) => (name === null || name === sessionId) && waitFor())
      attach() // it may have appeared while the watch was being set up
    }
    waitFor()
  }

  // A running subagent's clock moves while nothing is written: ask the panel to draw again.
  const keepTime = (sessionId: string, data: Trajectory): void => {
    if (tick) clearTimeout(tick)
    tick = null
    const running = data.turns.some((t) => t.steps.some((s) => s.calls.some((c) => isAgentTool(c.tool) && !c.done && !c.quiet)))
    if (!running) return
    tick = setTimeout(() => {
      tick = null
      if (watchedId === sessionId) orca.panels.post('trajectory.changed', { sessionId })
    }, TICK_MS)
  }

  // ------------------------------------------------ the status bar

  let running: Running[] = []
  let pushed: string | null = null // what the item last showed: Orca forgets it on a restart, so the first look always pushes
  let looking: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let failed: string | null = null // the last failure logged: once, not every few seconds
  // The row the status bar was pressed for, until a panel asks: one that is closed lands there when it opens.
  let reveal: { workspaceId: string; sessionId: string; callId: string } | null = null

  const look = async (): Promise<void> => {
    try {
      const now = Date.now()
      running = await runningNow(orca, claudeHome(), now)
      const state = statusOf(running, now)
      const key = JSON.stringify(state)
      if (key !== pushed && !stopped) {
        await orca.host.call('statusBar.update', { id: STATUS.item, ...state })
        pushed = key
      }
      failed = null
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      if (why !== failed) orca.log(`could not look for running subagents: ${why}`)
      failed = why
    } finally {
      if (!stopped) looking = setTimeout(() => void look(), STATUS.everyMs)
    }
  }
  void look()

  stop = (): void => {
    stopped = true
    if (looking) clearTimeout(looking)
    looking = null
    unwatch()
  }

  orca.commands.register('showRunningSubagent', () => {
    // The one started last: most likely the one just asked about.
    const pick = running
      .flatMap((r) => r.agents.map((a) => ({ r, a })))
      .sort((x, y) => y.a.startedAt - x.a.startedAt)[0]
    if (!pick) return 'No subagent is running.'
    reveal = { workspaceId: pick.r.workspaceId, sessionId: pick.r.sessionId, callId: pick.a.toolUseId }
    orca.panels.post('trajectory.reveal', { sessionId: pick.r.sessionId })
    return `Showing ${pick.r.workspace} in Claude Trajectory, or when its panel next opens.`
  })

  orca.panels.handle('trajectory.get', async (input) => {
    const want = typeof input === 'object' && input !== null ? input : {}
    // A pressed status bar item wins over what the panel last picked, once.
    const shown = reveal
    reveal = null
    const wantWs = shown?.workspaceId ?? (typeof want.workspaceId === 'string' && want.workspaceId.length <= 1024 ? want.workspaceId : null)
    const wantSession = shown?.sessionId ?? (typeof want.sessionId === 'string' && SESSION_ID.test(want.sessionId) ? want.sessionId : null)
    // The call whose row is shown is kept past the answer's limits. It is only compared with call ids.
    const keepCall = shown?.callId ?? (typeof want.keep === 'string' && want.keep.length <= 128 ? want.keep : null)
    const home = claudeHome()

    const all = await localWorkspaces(orca)
    const workspaces: WorkspaceInfo[] = all.map((w) => ({ id: w.id, name: workspaceName(w) }))
    // Only a workspace Orca listed: the id picks one, it is never a path.
    const ws = (wantWs ? all.find((w) => w.id === wantWs) : null) ?? (await focusedWorkspace(orca, all, home))
    const answer: TrajectoryAnswer = { workspaces, workspaceId: ws?.id ?? null, sessions: [], sessionId: null, data: null, notice: null }
    if (!ws) {
      unwatch()
      return { ...answer, notice: 'Pick a workspace on this machine to see its Claude Code sessions.' }
    }

    // The session asked for is listed even when older than the picker's newest:
    // the status bar can point at one, and the panel then keeps asking for it.
    const { root, sessions } = await listSessions(home, ws.path, { also: wantSession })
    answer.sessions = sessions.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    // Only a session found in that workspace's folder: the id picks one, it is never a path.
    const session = (wantSession ? sessions.find((s) => s.id === wantSession) : null) ?? sessions[0] ?? null
    if (!session) {
      unwatch()
      return { ...answer, notice: 'No Claude Code sessions in this workspace yet.' }
    }
    answer.sessionId = session.id
    if (shown && shown.sessionId === session.id) answer.reveal = shown.callId

    let data: Trajectory
    try {
      const { records, complete, before } = await cache.read(session.file)
      const agentCalls = new Set<string>()
      for (const r of records) if (r.k === 'asst') for (const t of r.tools) if (isAgentTool(t.tool)) agentCalls.add(t.id)
      const subagents = agentCalls.size ? await readSubagents(root, session.dir, session.id, agentCalls) : []
      data = build(records, subagents, complete, Date.now(), before, keepCall)
    } catch (err) {
      cache.clear()
      orca.log(`could not read session ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
      return { ...answer, notice: 'This session’s transcript could not be read.' }
    }
    follow(session.id, session.file, session.dir)
    keepTime(session.id, data)
    return fit({ ...answer, data })
  })
}

export function deactivate(): void {
  stop?.()
  stop = null
}
