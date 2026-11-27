import { afterEach, assert, mockHost, mount, mountWorker, test, type TestPanel } from 'orca/testing'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as panel from './panel.tsx'
import * as main from './worker.ts'
import { cutCells } from './format.ts'
import { projectDirName } from './locate.ts'
import { build, LIMITS, parseLines } from './transcript.ts'
import { assistant, backgroundLaunch, backgroundSession, basicSession, jsonl, prompt, subagentMeta, T0, toolUse, withShape } from './fixtures.ts'
import type { TrajectoryAnswer } from './protocol.ts'

const S1 = '11111111-1111-4111-8111-111111111111'
const answer = (extra: Partial<TrajectoryAnswer> = {}): TrajectoryAnswer => ({
  workspaces: [{ id: 'ws-1', name: 'app · main' }],
  workspaceId: 'ws-1',
  sessions: [{ id: S1, title: 'Fix the parser', updatedAt: T0 }],
  sessionId: S1,
  data: build(parseLines(jsonl(basicSession())), [], true, T0 + 86_400_000),
  notice: null,
  ...extra
})

// A request row's key: by when it was sent, so it holds as older records leave.
const firstRequest = `r${answer().data!.turns[0].steps[0].at}`

let view: TestPanel | undefined
const drawn = (text: string): boolean => JSON.stringify(view!.tree()).includes(JSON.stringify(text).slice(1, -1))
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

test('draws the rows and opens a row’s details', async () => {
  const asked: unknown[] = []
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': (input) => {
        asked.push(input)
        return answer()
      }
    }
  })
  view = await mount(panel, { host })
  assert.ok(view.find({ role: 'heading', text: 'Claude Trajectory' }))
  const tree = view.find({ label: 'Trajectory rows' })
  assert.ok(tree)
  await view.expand({ label: 'Trajectory rows' }, firstRequest)
  await view.selectItem({ label: 'Trajectory rows' }, 'ctoolu_1')
  assert.ok(drawn('Request #1'))
  assert.ok(drawn('Called by'))
  await view.select({ label: 'Details' }, 'Result')
  assert.ok(drawn('line one'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.ok(asked.length >= 1)
})

test('shows the worker’s notice when there is nothing to draw', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: { 'trajectory.get': () => answer({ sessions: [], sessionId: null, data: null, notice: 'No Claude Code sessions in this workspace yet.' }) }
  })
  view = await mount(panel, { host })
  assert.ok(drawn('No Claude Code sessions in this workspace yet.'))
  assert.deepEqual(view.errors, [])
})

test('a session picked from the list is asked for by id', async () => {
  const S2 = '22222222-2222-4222-8222-222222222222'
  const asked: { sessionId?: string | null }[] = []
  const two = answer({ sessions: [{ id: S1, title: 'Fix the parser', updatedAt: T0 }, { id: S2, title: 'Second', updatedAt: T0 - 1000 }] })
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': (input) => {
        asked.push(input as { sessionId?: string | null })
        return input?.sessionId === S2 ? { ...two, sessionId: S2, data: build(parseLines(jsonl([prompt(0, 'second')])), [], true, T0) } : two
      }
    }
  })
  view = await mount(panel, { host })
  await view.select({ label: 'Session' }, S2)
  assert.equal(asked.at(-1)?.sessionId, S2)
  assert.deepEqual(view.errors, [])
})

test('the worker failing shows an error, not a crash', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': () => {
        throw Object.assign(new Error('boom /Users/secret/path'), { code: 'action_failed' })
      }
    }
  })
  view = await mount(panel, { host })
  assert.ok(drawn('The session could not be read.'))
  assert.ok(!JSON.stringify(view.tree()).includes('/Users/secret'))
})

const twoTurns = (): TrajectoryAnswer =>
  answer({
    data: build(
      parseLines(jsonl([...basicSession(), prompt(5000, 'A second question'), assistant(6000, 'r3', [{ type: 'text', text: 'Answered.' }], { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 21000, cache_creation_input_tokens: 0 })])),
      [],
      true,
      T0 + 86_400_000
    )
  })
const hostOf = (a: TrajectoryAnswer) => mockHost({ capabilities: ['workspace:read', 'agent:read'], requests: { 'trajectory.get': () => a } })

test('a folded turn says what it was about', async () => {
  view = await mount(panel, { host: hostOf(twoTurns()) })
  // Turn 1 is folded by default, the newest open.
  assert.ok(drawn('Turn 1 · Read the parser and f…'))
  assert.ok(!drawn('Turn 2 · A second question'))
  assert.deepEqual(view.errors, [])
})

test('the toolbar folds every turn, then opens them', async () => {
  view = await mount(panel, { host: hostOf(twoTurns()) })
  await view.press({ role: 'button', text: 'Fold turns' })
  assert.ok(view.find({ role: 'button', text: 'Open turns' }))
  await view.press({ role: 'button', text: 'Open turns' })
  assert.ok(view.find({ role: 'button', text: 'Fold turns' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('Calls off leaves the requests without their calls, and closes a call’s details', async () => {
  view = await mount(panel, { host: hostOf(answer()) })
  await view.expand({ label: 'Trajectory rows' }, firstRequest)
  await view.selectItem({ label: 'Trajectory rows' }, 'ctoolu_1')
  assert.ok(drawn('Called by'))
  await view.toggle({ label: 'Calls' })
  assert.ok(!drawn('Called by'))
  assert.ok(!drawn('parser.ts'))
  await view.toggle({ label: 'Calls' })
  assert.deepEqual(view.errors, [])
})

test('FIXED opens to its categories', async () => {
  view = await mount(panel, { host: hostOf(answer({ data: build(parseLines(jsonl(withShape())), [], true, T0 + 86_400_000) })) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  assert.ok(view.find({ label: 'Fixed overhead by category' }))
  for (const name of ['System prompt', 'Built-in tools', 'MCP tools', 'Skills']) assert.ok(drawn(name), name)
  assert.ok(drawn('of its input'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('FIXED without a recorded shape says so', async () => {
  view = await mount(panel, { host: hostOf(answer()) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  assert.ok(drawn('doesn’t record what it is made of'))
})

test('cuts a folded prompt by cells, and never through a character', () => {
  assert.equal(cutCells('short', 22), 'short')
  assert.equal(cutCells('小螃蟹小一點然後是打招呼的樣子', 8), '小螃蟹…')
  assert.equal(cutCells('abc😀def', 5), 'abc…')
  assert.ok(!/[\uD800-\uDBFF]$/.test(cutCells('a😀😀😀', 4).replace('…', '')))
})

test('prompts sharing a time still draw the rows', async () => {
  const data = build(parseLines(jsonl([prompt(0, 'one'), assistant(10, 'r1', [{ type: 'text', text: 'a' }]), prompt(0, 'two'), assistant(20, 'r2', [{ type: 'text', text: 'b' }])])), [], true, T0 + 86_400_000)
  view = await mount(panel, { host: hostOf(answer({ data })) })
  assert.ok(view.find({ label: 'Trajectory rows' }))
  assert.ok(drawn('Turn 1 · one'))
})

test('an open turn stays open when the oldest leaves the list', async () => {
  const session = (from: number) => build(parseLines(jsonl(Array.from({ length: 4 - from }, (_, k) => [prompt((from + k) * 100, `p${from + k}`), assistant((from + k) * 100 + 5, `r${from + k}`, [{ type: 'text', text: 'ok' }])]).flat())), [], true, T0 + 86_400_000)
  let data = session(0)
  const host = mockHost({ capabilities: ['workspace:read', 'agent:read'], requests: { 'trajectory.get': () => answer({ data }) } })
  view = await mount(panel, { host })
  const second = `t${T0 + 100}`
  await view.expand({ label: 'Trajectory rows' }, second)
  assert.ok(view.expandedOf({ label: 'Trajectory rows' }).includes(second))
  data = session(1)
  await view.press({ label: 'Refresh' })
  assert.ok(view.expandedOf({ label: 'Trajectory rows' }).includes(second))
  assert.deepEqual(view.errors, [])
})

test('FIXED says why its categories are missing when the answer left them out', async () => {
  const data = { ...build(parseLines(jsonl(withShape())), [], true, T0 + 86_400_000), fixed: null, fixedTrimmed: true }
  view = await mount(panel, { host: hostOf(answer({ data })) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  assert.ok(drawn('too large to send whole'))
  assert.ok(!drawn('doesn’t record what it is made of'))
})

test('an event draws under its own name, with no YOU row, and isn’t counted as a turn', async () => {
  const data = build(parseLines(jsonl([prompt(0, 'first'), assistant(10, 'r1', [{ type: 'text', text: 'a' }]), prompt(100, '<task-notification>x</task-notification>'), assistant(110, 'r2', [{ type: 'text', text: 'b' }])])), [], true, T0 + 86_400_000)
  view = await mount(panel, { host: hostOf(answer({ data })) })
  assert.ok(drawn('Background task'))
  assert.ok(!drawn('(empty prompt)'))
  assert.ok(drawn('1 turn · 2 requests'))
  assert.deepEqual(view.errors, [])
})

test('a FIXED category opens to what is in it', async () => {
  view = await mount(panel, { host: hostOf(answer({ data: build(parseLines(jsonl(withShape())), [], true, T0 + 86_400_000) })) })
  await view.selectItem({ label: 'Trajectory rows' }, 'fixed')
  await view.expand({ label: 'Fixed overhead by category' }, 'tools/Built-in tools')
  assert.ok(view.expandedOf({ label: 'Fixed overhead by category' }).includes('tools/Built-in tools'))
  assert.ok(drawn('Bash'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('the lanes say what they show, and the key lists only what is drawn', async () => {
  view = await mount(panel, { host: hostOf(answer()) })
  assert.ok(drawn('in order'))
  assert.ok(drawn(' model  '))
  assert.ok(!drawn(' error  '))
  assert.ok(!view.find({ label: 'To time' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('a selected request stays selected when older records leave', async () => {
  const later = T0 + 86_400_000
  const lines = [prompt(0, 'one'), assistant(10, 'r1', [{ type: 'text', text: 'first reply' }]), prompt(100, 'two'), assistant(110, 'r2', [{ type: 'text', text: 'second reply' }])]
  const whole = build(parseLines(jsonl(lines)), [], true, later)
  // The same session, its first turn no longer read: the second request is now #1.
  const tail = build(parseLines(jsonl(lines.slice(2))), [], false, later, { n: 1, open: false })
  let data = whole
  view = await mount(panel, { host: mockHost({ capabilities: ['workspace:read', 'agent:read'], requests: { 'trajectory.get': () => answer({ data }) } }) })
  await view.selectItem({ label: 'Trajectory rows' }, `r${whole.turns[1].steps[0].at}`)
  assert.ok(drawn('Request #2'))
  data = tail
  await view.press({ label: 'Refresh' })
  assert.ok(drawn('Request #1'))
  assert.ok(drawn('second reply'))
  assert.deepEqual(view.errors, [])
})

// ---------------------------------------------------------------- the status bar's row, and search

const S2 = '22222222-2222-4222-8222-222222222222'
// Two sessions; the second has a background subagent running.
const twoSessions = (extra: Partial<TrajectoryAnswer> = {}): TrajectoryAnswer =>
  answer({ sessions: [{ id: S1, title: 'Fix the parser', updatedAt: T0 }, { id: S2, title: 'Map the parser', updatedAt: T0 - 1000 }], ...extra })
const bgData = () => build(parseLines(jsonl(backgroundSession())), [], true, T0 + 60_000)

test('the status bar’s press shows the session with the subagent’s row open', async () => {
  let pressed = false
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    // As the worker answers: the pressed-for session and row, once, whatever the panel had picked.
    requests: {
      'trajectory.get': (input) => {
        if (!pressed) return twoSessions({ sessionId: (input as { sessionId?: string | null }).sessionId ?? S1 })
        pressed = false
        return twoSessions({ sessionId: S2, data: bgData(), reveal: 'toolu_bg' })
      }
    }
  })
  view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Session' }), S1)
  pressed = true
  await view.post('trajectory.reveal', { sessionId: S2 })
  assert.equal(view.valueOf({ label: 'Session' }), S2)
  assert.ok(view.expandedOf({ label: 'Trajectory rows' }).includes('ctoolu_bg'))
  assert.equal(view.valueOf({ label: 'Trajectory rows' }), 'ctoolu_bg')
  assert.ok(drawn('🚀 AGENT  🟡 running  Explore · Map the parser'))
  // It stays on that session when asked again.
  await view.press({ label: 'Refresh' })
  assert.equal(view.valueOf({ label: 'Session' }), S2)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('a press while the panel was closed lands there when it opens', async () => {
  const asked: unknown[] = []
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': (input) => {
        asked.push(input)
        return asked.length === 1 ? twoSessions({ sessionId: S2, data: bgData(), reveal: 'toolu_bg' }) : twoSessions({ sessionId: (input as { sessionId?: string }).sessionId ?? S1, data: bgData() })
      }
    }
  })
  view = await mount(panel, { host })
  await view.settled()
  assert.equal(view.valueOf({ label: 'Session' }), S2)
  assert.ok(view.expandedOf({ label: 'Trajectory rows' }).includes('ctoolu_bg'))
  assert.deepEqual(view.errors, [])
})

// From the press to the drawn row, through the real worker: the running agent
// started last was started by another subagent, so it has no row of its own.
// `later` is how many calls the outer subagent made after starting it.
async function pressNested(later: number): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'traj-home-')))
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'traj-ws-')))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  const worker = await (async () => {
    const dir = join(home, 'projects', projectDirName(work))
    const sub = join(dir, S1, 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(dir, `${S1}.jsonl`), jsonl(backgroundSession().map((l) => ({ ...(l as object), cwd: work }))))
    // The top-level subagent starts the inner one in the background.
    const side = (lines: object[]) => jsonl(lines.map((l) => ({ ...l, isSidechain: true })))
    writeFileSync(join(sub, 'agent-a1b2c3.meta.json'), JSON.stringify(subagentMeta('toolu_bg', 'Map the parser')))
    writeFileSync(join(sub, 'agent-a1b2c3.jsonl'), side([
      assistant(3000, 'inner-request', [toolUse('toolu_inner', 'Agent', { description: 'Map the lexer', subagent_type: 'Explore', run_in_background: true })], undefined, 'tool_use'),
      backgroundLaunch(3200, 'toolu_inner', 'd4e5f6'),
      ...Array.from({ length: later }, (_, i) => assistant(4000 + i * 100, `later-${i}`, [toolUse(`toolu_later_${i}`, 'Read', { file_path: 'parser.ts' })], undefined, 'tool_use'))
    ]))
    writeFileSync(join(sub, 'agent-d4e5f6.meta.json'), JSON.stringify(subagentMeta('toolu_inner', 'Map the lexer')))
    writeFileSync(join(sub, 'agent-d4e5f6.jsonl'), side([]))
    // The outer one started a minute before the inner one.
    const before = new Date(Date.now() - 60_000)
    utimesSync(join(sub, 'agent-a1b2c3.meta.json'), before, before)
    const workspaces = { workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'app', path: work, branch: 'main', hostId: 'local' }], truncated: false }
    return mountWorker(main, { host: mockHost({ results: { 'workspace.list': workspaces, 'workspace.readContext': { branch: 'main', displayName: 'app', terminals: [] } } }) })
  })()
  try {
    for (let i = 0; i < 250 && !worker.host.callsOf('statusBar.update').length; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal((worker.host.callsOf('statusBar.update')[0] as { text?: string })?.text, '2 subagents running')
    view = await mount(panel, {
      host: mockHost({ capabilities: ['workspace:read', 'agent:read'], requests: { 'trajectory.get': (input) => worker.request('trajectory.get', input) } }),
      persisted: { plugin: { showSubcalls: false } }
    })
    await view.settled()
    await worker.command('showRunningSubagent')
    await view.post('trajectory.reveal', { sessionId: S1 })
    await view.settled()
    const shows = (): void => {
      assert.ok(view!.expandedOf({ label: 'Trajectory rows' }).includes('ctoolu_bg'))
      assert.equal(view!.valueOf({ label: 'Trajectory rows' }), 'stoolu_bg/toolu_inner')
      assert.ok(drawn('TOOL  Agent'))
      // The row it sits under keeps to the subcall limit.
      const subs = JSON.stringify(view!.tree()).match(/"key":"stoolu_bg\//g) ?? []
      assert.equal(subs.length, Math.min(1 + later, LIMITS.subcalls))
    }
    shows()
    // The session goes on changing: the next answer still holds the selected row.
    await view.post('trajectory.changed', { sessionId: S1 })
    await view.settled()
    shows()
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await worker.deactivate()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

test('the status bar’s press on a nested subagent opens the row it sits under, the nested one selected', () => pressNested(0))

test('a nested subagent pressed after its parent made more calls than the row lists is still shown and selected', () => pressNested(LIMITS.subcalls))

const options = (): string[] => (view!.find({ label: 'Workspace' })!.props.options as { label: string }[]).map((o) => o.label)

test('the search box matches parts of a name, its words in any order', async () => {
  const names = ['app · main', 'app-181-feat-subagent-status', 'squad-chat · next']
  const asked: { workspaceId?: string | null }[] = []
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read'],
    requests: {
      'trajectory.get': (input) => {
        asked.push(input as { workspaceId?: string | null })
        return answer({ workspaces: names.map((name, i) => ({ id: `ws-${i + 1}`, name })) })
      }
    }
  })
  view = await mount(panel, { host })
  assert.deepEqual(options(), names)
  await view.type({ label: 'Search workspaces' }, 'status 181')
  assert.deepEqual(options(), ['app-181-feat-subagent-status'])
  await view.type({ label: 'Search workspaces' }, 'STATUS', { replace: true })
  assert.deepEqual(options(), ['app-181-feat-subagent-status'])
  await view.type({ label: 'Search workspaces' }, 'zzz', { replace: true })
  assert.deepEqual(options(), [])
  await view.type({ label: 'Search workspaces' }, '', { replace: true })
  assert.deepEqual(options(), names)
  // Enter picks the top match.
  await view.type({ label: 'Search workspaces' }, 'chat', { replace: true, submit: true })
  assert.equal(asked.at(-1)?.workspaceId, 'ws-3')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('each AGENT row says where its subagent is', async () => {
  const lines = backgroundSession()
  const call = (extra: unknown[], now: number) => answer({ data: build(parseLines(jsonl([...lines, ...extra])), [], true, T0 + now) })
  const cases: [TrajectoryAnswer, string][] = [
    [call([], 60_000), '🟡 running'],
    [call([{ type: 'user', timestamp: new Date(T0 + 9000).toISOString(), message: { role: 'user', content: '<task-notification>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>' } }], 60_000), '✅ done'],
    [call([{ type: 'user', timestamp: new Date(T0 + 9000).toISOString(), message: { role: 'user', content: '<task-notification>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>killed</status>\n</task-notification>' } }], 60_000), '❌ failed'],
    [call([], 20 * 60_000), '❔ no news']
  ]
  for (const [a, mark] of cases) {
    view = await mount(panel, { host: hostOf(a) })
    await view.expand({ label: 'Trajectory rows' }, `r${a.data!.turns[0].steps[0].at}`)
    assert.ok(drawn(`🚀 AGENT  ${mark}  Explore · Map the parser`), mark)
    await view.unmount()
    view = undefined
  }
})
