import { afterEach, assert, beforeEach, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as main from './worker.ts'
import { projectDirName } from './locate.ts'
import { assistant, backgroundSession, basicSession, jsonl, prompt, subagentMeta, toolUse } from './fixtures.ts'
import type { TrajectoryAnswer } from './protocol.ts'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'

let home: string
let work: string
let worker: TestWorker | undefined
const saved = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'traj-home-')))
  work = realpathSync(mkdtempSync(join(tmpdir(), 'traj-ws-')))
  process.env.CLAUDE_CONFIG_DIR = home
  const dir = join(home, 'projects', projectDirName(work))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${S1}.jsonl`), jsonl(basicSession().map((l) => ({ ...(l as object), cwd: work }))))
})
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved
})

function host(focused = true) {
  return mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'ws-1', kind: 'worktree', name: 'app', path: work, branch: 'refs/heads/main', hostId: 'local' },
          { id: 'ws-remote', kind: 'worktree', name: 'app', path: work, branch: 'main', hostId: 'ssh-box' }
        ],
        truncated: false
      },
      'workspace.readContext': focused ? { branch: 'main', displayName: 'app', terminals: [] } : null
    }
  })
}

test('answers the focused workspace’s newest session', async () => {
  worker = await mountWorker(main, { host: host() })
  const a = await worker.request('trajectory.get', {})
  assert.equal(a.workspaceId, 'ws-1')
  assert.deepEqual(a.workspaces.map((w) => w.id), ['ws-1'])
  assert.equal(a.sessionId, S1)
  assert.equal(a.data?.requests, 2)
  assert.equal(a.data?.turns[0].prompt, 'Read the parser and fix it')
  assert.deepEqual(worker.refusals, [])
})

test('ids that are not listed are ignored, never used as paths', async () => {
  worker = await mountWorker(main, { host: host() })
  for (const input of [
    { sessionId: '../../../../etc/passwd' },
    { sessionId: S2 },
    { workspaceId: '/etc' },
    { workspaceId: 'ws-remote' },
    { workspaceId: 42 as unknown as string, sessionId: { toString: () => S1 } as unknown as string }
  ]) {
    const a: TrajectoryAnswer = await worker.request('trajectory.get', input)
    assert.equal(a.workspaceId, 'ws-1', JSON.stringify(input))
    assert.equal(a.sessionId, S1, JSON.stringify(input))
  }
})

test('no focused workspace asks for one', async () => {
  worker = await mountWorker(main, { host: host(false) })
  const a = await worker.request('trajectory.get', {})
  assert.equal(a.workspaceId, null)
  assert.equal(a.data, null)
  assert.ok(a.notice)
})

test('a workspace with no sessions says so', async () => {
  rmSync(join(home, 'projects'), { recursive: true })
  mkdirSync(join(home, 'projects'))
  worker = await mountWorker(main, { host: host() })
  const a = await worker.request('trajectory.get', {})
  assert.equal(a.data, null)
  assert.equal(a.sessions.length, 0)
  assert.ok(a.notice)
})

test('picks a listed session by id', async () => {
  const dir = join(home, 'projects', projectDirName(work))
  writeFileSync(join(dir, `${S2}.jsonl`), jsonl([{ ...prompt(0, 'second'), cwd: work }]))
  worker = await mountWorker(main, { host: host() })
  const a = await worker.request('trajectory.get', { sessionId: S2 })
  assert.equal(a.sessionId, S2)
  assert.equal(a.data?.turns[0].prompt, 'second')
})

test('a huge answer is trimmed to fit, oldest first', async () => {
  const { fit } = await import('./worker.ts')
  const call = (i: number) => ({ id: `c${i}`, tool: 'Bash', summary: 'x'.repeat(80), at: 0, ms: 1, done: true, isError: false, by: null, input: Array.from({ length: 8 }, (_, k): [string, string] => [`k${k}`, 'v'.repeat(160)]), lines: ['l'.repeat(160), 'l'.repeat(160), 'l'.repeat(160)], chars: 1, tokens: 1, agentType: null, sub: [], quiet: false })
  const step = (n: number) => ({ n, at: 0, firstAt: 0, endedAt: 1, status: 'done' as const, input: 1, output: 1, cacheRead: 0, text: 't'.repeat(200), stopReason: null, model: null, isCompacted: false, calls: Array.from({ length: 30 }, (_, i) => call(n * 100 + i)) })
  const a: TrajectoryAnswer = {
    workspaces: [], workspaceId: 'ws', sessions: [], sessionId: S1, notice: null,
    data: { turns: [{ n: 1, at: 0, prompt: 'p', chars: 1, tokens: 1, earlier: false, auto: null, steps: Array.from({ length: 60 }, (_, i) => step(i + 1)) }], overhead: null, fixed: null, fixedTrimmed: false, truncated: false, requests: 60, calls: 1800, tps: null, next: null }
  }
  const out = fit(a)
  assert.ok(JSON.stringify(out).length <= 384 * 1024)
  assert.ok(out.data!.truncated)
  assert.equal(out.data!.turns[0].steps.at(-1)!.n, 60)
})

test('the FIXED breakdown goes first, before any of the conversation', async () => {
  const { fit } = await import('./worker.ts')
  const a: TrajectoryAnswer = {
    workspaces: [], workspaceId: 'ws', sessions: [], sessionId: S1, notice: null,
    data: { turns: [{ n: 1, at: 0, prompt: 'p', chars: 1, tokens: 1, earlier: false, auto: null, steps: [] }, { n: 2, at: 1, prompt: 'q', chars: 1, tokens: 1, earlier: false, auto: null, steps: [] }], overhead: 9, fixed: [{ key: 'tools', name: 'x'.repeat(400 * 1024), note: null, tokens: 9 }], fixedTrimmed: false, truncated: false, requests: 0, calls: 0, tps: null, next: null }
  }
  const out = fit(a).data!
  assert.equal(out.fixed, null)
  assert.ok(out.fixedTrimmed)
  assert.equal(out.turns.length, 2)
  assert.equal(out.truncated, false)
})

// ---------------------------------------------------------------- running subagents

const sessionDir = (): string => join(home, 'projects', projectDirName(work))

// A subagent of session S1: its meta file and its transcript, written `ago` ms back.
function subagent(name: string, toolUseId: string, description: string, finished = false, ago = 0): void {
  const sub = join(sessionDir(), S1, 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, `agent-${name}.meta.json`), JSON.stringify(subagentMeta(toolUseId, description, finished)))
  const file = join(sub, `agent-${name}.jsonl`)
  writeFileSync(file, jsonl([assistant(0, `${name}-1`, [toolUse(`toolu_${name}_1`, 'Glob', { pattern: 'src/**' })], undefined, 'tool_use')].map((l) => ({ ...l, isSidechain: true }))))
  if (ago) utimesSync(file, new Date(Date.now() - ago), new Date(Date.now() - ago))
}

// Waits on what the worker does by itself: the status bar's look and file watches have no act to await.
async function until<T>(what: () => T | undefined | null | false, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; ; ) {
    const got = what()
    if (got) return got
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

type Update = { id: string; visible: boolean; text: string; tooltip: string }
const updates = (): Update[] => worker!.host.callsOf('statusBar.update') as Update[]
const every = main.STATUS.everyMs

test('the status bar counts running subagents only, names them, and hides at zero', async () => {
  main.STATUS.everyMs = 50
  try {
    subagent('aaa', 'toolu_a', 'Map the parser')
    subagent('bbb', 'toolu_b', 'Read the tests', true)
    worker = await mountWorker(main, { host: host() })
    const first = await until(() => updates()[0])
    assert.equal(first.id, 'subagents')
    assert.equal(first.visible, true)
    assert.equal(first.text, '1 subagent running')
    const lines = first.tooltip.split('\n')
    assert.equal(lines[0], `${basename(work)} · app`)
    assert.match(lines[1], /^ {2}Explore · Map the parser · \d/)
    assert.ok(!first.tooltip.includes('Read the tests'))
    assert.equal(lines.at(-1), 'Click to show in Claude Trajectory')
    // It finishes: the item hides.
    subagent('aaa', 'toolu_a', 'Map the parser', true)
    const last = await until(() => updates().find((u) => !u.visible))
    assert.equal(last.id, 'subagents')
    assert.deepEqual(worker.refusals, [])
  } finally {
    main.STATUS.everyMs = every
  }
})

test('a subagent with no end, silent for 10 minutes, is not counted', async () => {
  subagent('aaa', 'toolu_a', 'Map the parser', false, 11 * 60_000)
  worker = await mountWorker(main, { host: host() })
  const first = await until(() => updates()[0])
  assert.equal(first.visible, false)
})

test('pressing the status bar shows the running subagent’s session and row', async () => {
  const dir = sessionDir()
  writeFileSync(join(dir, `${S2}.jsonl`), jsonl(backgroundSession().map((l) => ({ ...(l as object), cwd: work }))))
  const sub = join(dir, S2, 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'agent-a1b2c3.meta.json'), JSON.stringify(subagentMeta('toolu_bg', 'Map the parser')))
  writeFileSync(join(sub, 'agent-a1b2c3.jsonl'), jsonl([]))
  worker = await mountWorker(main, { host: host() })
  await until(() => updates()[0]?.visible)
  const said = await worker.command('showRunningSubagent')
  assert.equal(typeof said, 'string')
  assert.deepEqual(worker.posts.at(-1), { event: 'trajectory.reveal', payload: { sessionId: S2 } })
  // The panel asks with what it had picked; the answer is the subagent's session, its row to open, once.
  const a = await worker.request('trajectory.get', { sessionId: S1 })
  assert.equal(a.sessionId, S2)
  assert.equal(a.reveal, 'toolu_bg')
  const again = await worker.request('trajectory.get', { sessionId: S1 })
  assert.equal(again.sessionId, S1)
  assert.equal(again.reveal, undefined)
})

test('a new line in a subagent’s file tells the panel, its folder made after the watch began', async () => {
  worker = await mountWorker(main, { host: host() })
  await worker.request('trajectory.get', {})
  const changed = (): number => worker!.posts.filter((p) => p.event === 'trajectory.changed').length
  assert.equal(changed(), 0)
  subagent('aaa', 'toolu_a', 'Map the parser')
  await until(() => changed() >= 1)
  const seen = changed()
  // Let the debounce settle, then write to the subagent's transcript.
  await new Promise((r) => setTimeout(r, 700))
  appendFileSync(join(sessionDir(), S1, 'subagents', 'agent-aaa.jsonl'), jsonl([{ ...assistant(5, 'aaa-2', [{ type: 'text', text: 'more' }]), isSidechain: true }]))
  await until(() => changed() > seen)
})

test('a running subagent in a workspace’s 21st newest session is counted, and its press opens that session', async () => {
  const dir = sessionDir()
  // S1 holds the only running subagent, written two minutes back; twenty newer sessions have none.
  const old = new Date(Date.now() - 120_000)
  writeFileSync(join(dir, `${S1}.jsonl`), jsonl(backgroundSession().map((l) => ({ ...(l as object), cwd: work }))))
  utimesSync(join(dir, `${S1}.jsonl`), old, old)
  const sub = join(dir, S1, 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'agent-a1b2c3.meta.json'), JSON.stringify(subagentMeta('toolu_bg', 'Map the parser')))
  writeFileSync(join(sub, 'agent-a1b2c3.jsonl'), jsonl([]))
  for (let i = 1; i <= 20; i++) writeFileSync(join(dir, `${String(i).padStart(8, '0')}-2222-4222-8222-222222222222.jsonl`), jsonl(basicSession().map((l) => ({ ...(l as object), cwd: work }))))
  worker = await mountWorker(main, { host: host() })
  const first = await until(() => updates()[0])
  assert.equal(first.visible, true)
  assert.equal(first.text, '1 subagent running')
  await worker.command('showRunningSubagent')
  const a = await worker.request('trajectory.get', {})
  assert.equal(a.sessionId, S1)
  assert.equal(a.reveal, 'toolu_bg')
  assert.equal(a.sessions.length, 21)
  assert.equal(a.sessions.at(-1)?.id, S1)
  // The panel then asks for it by id, and gets it again.
  const again = await worker.request('trajectory.get', { workspaceId: 'ws-1', sessionId: S1 })
  assert.equal(again.sessionId, S1)
})

test('the tooltip names the first 12 running subagents, then says how many more', async () => {
  for (let i = 0; i < 13; i++) subagent(`a${i}`, `toolu_${i}`, `Description ${i}`)
  worker = await mountWorker(main, { host: host() })
  const first = await until(() => updates()[0])
  assert.equal(first.text, '13 subagents running')
  const lines = first.tooltip.split('\n')
  assert.equal(lines.filter((l) => /^ {2}Explore · Description \d+ · /.test(l)).length, 12)
  assert.equal(lines.at(-2), '  and 1 more')
  assert.equal(lines.at(-1), 'Click to show in Claude Trajectory')
})
