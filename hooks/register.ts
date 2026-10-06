import type { EngineInterface, PluginOptions, Register, SessionMessage } from 'claude-code'
import type { Stage } from '../types'

// Soft: ask the model to wrap up at its next natural stopping point.
// Firm: it is still going; stop starting anything and hand off now.
// Both are capped at a share of the window so a smaller window still works.
const SOFT_TOKENS = 300_000
const FIRM_TOKENS = 450_000
const SOFT_SHARE = 0.6
const FIRM_SHARE = 0.8
// A context must grow this much past its own starting size before it is asked to hand
// off: without it, a seed above a threshold loops forever. The floor matters for small
// thresholds, where a quarter of the threshold is less than reading the handoff costs.
const MIN_GROWTH_SHARE = 0.25
const MIN_GROWTH_TOKENS = 40_000
// How far past the firm threshold the model may go before its other tool calls are refused.
const GATE_MARGIN_TOKENS = 40_000
// What stays open past it: loading the handoff tool, and the task tools, so the list the
// record carries is the one the model meant to leave and background work can be stopped
// cleanly. None of them costs much.
const GATE_OPEN = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop'])

// Every file call spells this folder out as fixed text, so a reader of the source sees where
// each write lands; this constant names it in what the model and the user read.
const ARCHIVE_DIR = '.claude/handoffs'
const TOOL = 'handoff_ready'
const IMAGE_TOOL = 'handoff_image'
const MIN_HANDOFF_CHARS = 200
// The verbatim record of the user's messages: each one, and all of them together,
// kept within these bounds. The first message (the original request) always stays.
const MAX_MESSAGE_CHARS = 2_000
const MAX_LOG_CHARS = 12_000
const MAX_FILES = 40
// Skills carried into the fresh context word for word, together; past this, by name only.
const MAX_SKILL_CHARS = 40_000
const SKILL_LEAD = 'Base directory for this skill:'

const NOTICE = '[CONTEXT HANDOFF]'
const SEED_LEAD = 'This session continues earlier work from a handoff written by the previous context.'
const RECORD_LEAD = '## Recorded by context-handoff'
const SEED_GUIDE = `You are the same assistant, continuing the same work for the same user; the previous
context handed off because its window was filling up. How to read what follows:
- The user's messages are their exact words. Where anything else here disagrees with them,
  they win.
- Sections marked "recorded" were captured by code at the handoff: exact, but only as of then.
- The handoff at the end was written by the previous context: its best understanding, not
  ground truth. Check what it marks unverified before building on it.
- Do not recap this to the user or announce the handoff; carry on as if nothing happened.`
const RESUME =
  'Continue the work from the handoff above, starting with its Next step. If the Next step ' +
  'is to wait for the user, tell them in a line or two where things stand and stop.'

const HANDOFF_TEMPLATE = `Write the handoff as Markdown with these sections, for a reader with none of your
context: name things fully, give paths, define your shorthand. It is the judgment half: the
user's messages, skills, approved plan, task list, git state, files, commands, images,
subagents, earlier handoffs and the path of the full session transcript are recorded with it
word for word, so refer to them, don't copy them. If this
context began from a handoff, carry forward every decision, gotcha and open question from it
that still holds; drop only what is resolved, and say it is resolved.
1. Goal: what the user wants in the end and what counts as done, with the standing
   instructions and preferences that shape the work (scope limits, "always" / "never", style),
   and what they approved or ruled out (committing, pushing, deleting, spending, publishing).
2. Status: each task or subtask, marked done / in progress / not started, and where the
   one in progress stands exactly (what is half-done, what state files are in).
3. Decisions: what was decided and why, including approaches tried and rejected, and why.
4. Outputs: what each changed file now does differently, and any artifact, commit, pull
   request or URL produced.
5. Verification: what is proven and how (the exact commands to build, test or reproduce,
   and their last result), and what is still unverified.
6. Open questions: anything unresolved, waiting on the user, or assumed but not checked.
7. Gotchas: anything non-obvious the next instance would otherwise rediscover the hard way.
8. Next step: the exact next action, then the remaining plan in order. If the user's latest
   message is not fully answered, answering it comes first. If the work is done or needs
   the user, write "Wait for the user:" and what they need to answer or review.`

const POLICY = `# Context handoff
When a message headed ${NOTICE} appears, the context window is filling up.
- Do not start a new subtask. Finish the unit of work in progress, or park it in a
  clean, resumable state. Never cut a task in half just to hit a token number.
- Then call the ${TOOL} tool with the handoff as its \`handoff\` argument, and end your turn
  without further work. ${HANDOFF_TEMPLATE}
- The conversation is then replaced by the handoff and continues on its own; the user
  does not need to act. Pass \`skills\`: the loaded skills that still apply to the
  remaining work; skills the user asked for are kept regardless.
Never call ${TOOL} unless a ${NOTICE} message asked for it.`

const REASK =
  `${NOTICE} Your turn ended without a handoff, and the end of a turn is a natural stopping ` +
  `point. Call ${TOOL} with the handoff now. If you were waiting for the user, make that the Next step.`

const FORK_PROMPT =
  `${NOTICE} Write the handoff for this conversation now. Reply with the handoff Markdown ` +
  `alone, nothing before or after it.\n\n${HANDOFF_TEMPLATE}`

// Held by the host, not in module variables: a hot reload or /reload-plugins between
// the handoff and the reset must not forget that a handoff is pending.
const STAGE = { plugin: 'context-handoff', key: 'stage' } as const
const HANDOFF = { plugin: 'context-handoff', key: 'handoff' } as const
const BASELINE = { plugin: 'context-handoff', key: 'baseline' } as const
const REASKED = { plugin: 'context-handoff', key: 'reasked' } as const
const USER_LOG = { plugin: 'context-handoff', key: 'userLog' } as const
const HELD = { plugin: 'context-handoff', key: 'held' } as const
const SKILLS = { plugin: 'context-handoff', key: 'skills' } as const
const KEEP_SKILLS = { plugin: 'context-handoff', key: 'keepSkills' } as const
const CHAIN = { plugin: 'context-handoff', key: 'chain' } as const
const ARCHIVED = { plugin: 'context-handoff', key: 'archived' } as const
const USER_NEW = { plugin: 'context-handoff', key: 'userNew' } as const
const CAPTURING = { plugin: 'context-handoff', key: 'capturing' } as const
const PREFIXED = { plugin: 'context-handoff', key: 'prefixed' } as const
const TRANSCRIPTS = { plugin: 'context-handoff', key: 'transcripts' } as const
const IN_FLIGHT = { plugin: 'context-handoff', key: 'inFlight' } as const
const WAKEUPS = { plugin: 'context-handoff', key: 'wakeups' } as const
const MESSAGES_FILE = { plugin: 'context-handoff', key: 'messagesFile' } as const
const SAVED = { plugin: 'context-handoff', key: 'saved' } as const
const RESTORED = { plugin: 'context-handoff', key: 'restored' } as const
const HANDOFFS = { plugin: 'context-handoff', key: 'handoffs' } as const
const APPLYING = { plugin: 'context-handoff', key: 'applying' } as const
const HOLDING = { plugin: 'context-handoff', key: 'holding' } as const
// How long a handoff, from acceptance through its application, may hold the user's messages.
const APPLY_WINDOW_MS = 60_000
// A captured message past this is cut in the state that holds it until the next handoff.
const MAX_CAPTURE_CHARS = 100_000

// Where a prompt came from. These are not the user's own words; every other origin is
// (the terminal, the IDE or SDK, remote control, a scheduled prompt the user set up).
const NOT_THE_USER = new Set(['plugin', 'task-notification', 'peer', 'peer-send-message', 'projects-relay',
  'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])

// A prompt a plugin submitted, as the transcript keeps it.
const fromPlugin = (text: string) => /^The [^\n]{1,80} plugin sent a message:/.test(text)

const k = (n: number) => `${Math.round(n / 1000)}k`

async function getStage($: EngineInterface): Promise<Stage> {
  return (await $.state.get(STAGE)).value ?? 'none'
}

async function getHandoff($: EngineInterface): Promise<string> {
  return (await $.state.get(HANDOFF)).value ?? ''
}

// A fresh context: nothing asked, nothing pending, its starting size measured next step.
// The user's log is the session's and carries on.
async function reset($: EngineInterface) {
  await $.state.set(STAGE, 'none')
  await $.state.set(HANDOFF, '')
  await $.state.set(BASELINE, -1)
  await $.state.set(REASKED, false)
  await $.state.set(APPLYING, 0)
  await $.state.set(HOLDING, 0)
  $.ui.status(undefined)
}

// A user-role row the model reads from its next request on, mid-turn included.
async function nudge($: EngineInterface, text: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (err) {
    $.ui.toast(`context-handoff: could not add the handoff notice (${String(err)})`)
  }
}

// A prompt of the mod's own, sent once the engine is idle (it refuses inside a turn).
function submitLater($: EngineInterface, text: string) {
  $.clock.after(500, async () => {
    try {
      await $.prompt.submit({ text })
    } catch (err) {
      $.ui.toast(`context-handoff: could not send a prompt (${String(err)})`)
    }
  })
}

// userConfig values arrive validated as numbers; anything else falls back to the default.
function tokens(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key]
  return typeof value === 'number' && value > 0 ? value : fallback
}

// ---- What the machine records, so the handoff does not depend on the model's memory ----

// Harness blocks that ride inside user messages and are not the user's words.
const HARNESS_BLOCK =
  /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|task-notification)>[\s\S]*?<\/\1>/g

/** The user's own words in this transcript: no tool results, notices, seeds or harness text. */
export function userMessages(messages: readonly SessionMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' || (m.toolResults?.length ?? 0) > 0) continue
    const text = m.text.replace(HARNESS_BLOCK, '').trim()
    if (text === '' || text.startsWith(NOTICE) || text.startsWith(SEED_LEAD) || text.startsWith(RESUME)) continue
    if (fromPlugin(text) || text.startsWith('(Re-invocation of /')) continue
    if (text.startsWith(RECORD_LEAD) || isSkillBody(text)) continue
    out.push(text)
  }
  return out
}

// A skill's text, loaded into a user-role message: not the user's words. A seed or record that
// carries skills is not one: its skills are read back with the rest of it.
function isSkillBody(text: string): boolean {
  if (text.startsWith(SEED_LEAD) || text.startsWith(RECORD_LEAD)) return false
  const at = text.indexOf(SKILL_LEAD)
  return at >= 0 && at < 400
}

type Skill = { name: string, text: string }

/** A message in the Messages API form, as `$.session.messages({ as: 'api' })` returns it. */
type ApiLike = { role: string, content: string | readonly Record<string, unknown>[] }

// Skill bodies among the texts of a conversation, each named by the Skill call it answers
// (the one whose name ends in the body's folder), or by that folder.
function skillBodies(messages: Iterable<{ role: string, calls: string[], texts: string[] }>): Skill[] {
  const found: Skill[] = []
  const calls: string[] = []
  for (const m of messages) {
    calls.push(...m.calls)
    if (m.role !== 'user') continue
    for (const text of m.texts) {
      if (!isSkillBody(text)) continue
      const body = text.slice(text.indexOf(SKILL_LEAD)).replace(HARNESS_BLOCK, '').trim()
      const dir = body.slice(SKILL_LEAD.length).split('\n')[0]!.trim().split(/[\\/]/).filter(Boolean).pop() ?? 'skill'
      const call = calls.findLast(c => c.slice(c.lastIndexOf(':') + 1) === dir)
      found.push({ name: call ?? dir, text: body })
    }
  }
  return found
}

/** Skills loaded in this transcript's rows, found by their text. */
export function skillsInTranscript(messages: readonly SessionMessage[]): Skill[] {
  return skillBodies(messages.map(m => ({
    role: m.role,
    calls: m.toolUses.flatMap(u => u.tool === 'Skill' && typeof u.input.skill === 'string' ? [u.input.skill] : []),
    texts: [m.text],
  })))
}

/** Skills in the text the model reads, where every loaded skill's body is a text block. */
export function skillsInApi(messages: readonly ApiLike[]): Skill[] {
  return skillBodies(messages.map(m => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    const skill = (b: Record<string, unknown>) => (b.input as { skill?: unknown } | undefined)?.skill
    return {
      role: m.role,
      calls: blocks.flatMap(b => b.type === 'tool_use' && b.name === 'Skill' && typeof skill(b) === 'string' ? [skill(b) as string] : []),
      texts: blocks.flatMap(b => b.type === 'text' && typeof b.text === 'string' ? [b.text] : []),
    }
  }))
}

// Every skill this context has loaded: as the skill.prompt hook saw it, then as the rows and
// the model's own input hold it. The hook misses skills loaded before the mod (or this
// version of it) was; the rows can leave out the engine's own messages; the model's input
// cannot leave out what the model reads.
async function loadedSkills($: EngineInterface, rows: readonly SessionMessage[], api: readonly ApiLike[]) {
  const hook = (await $.state.get(SKILLS)).value ?? []
  const inRows = skillsInTranscript(rows)
  const inApi = skillsInApi(api)
  return { all: mergeSkills(mergeSkills(hook, inRows), inApi), hook, inRows, inApi }
}

async function apiMessages($: EngineInterface): Promise<ApiLike[]> {
  try {
    return (await $.session.messages({ as: 'api' })) as unknown as ApiLike[]
  } catch {
    return []
  }
}

/** Later loads replace earlier ones of the same skill, which moves it to the end. */
export function mergeSkills(known: readonly Skill[], added: readonly Skill[]): Skill[] {
  const all = [...known]
  for (const skill of added) {
    const at = all.findIndex(s => s.name === skill.name)
    if (at >= 0) all.splice(at, 1)
    all.push(skill)
  }
  return all
}

const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the user asked for the skill: by its slash command, or by name beside the word "skill". */
export function userAsked(name: string, log: readonly string[]): boolean {
  const short = escapeRegExp(name.slice(name.lastIndexOf(':') + 1))
  const full = escapeRegExp(name)
  const slash = new RegExp(`(^|\\s)/(${full}|${short})(?![\\w:-])`, 'i')
  const named = new RegExp(`\\b${short}\\b[^.\\n]{0,40}\\bskills?\\b|\\bskills?\\b[^.\\n]{0,40}\\b${short}\\b`, 'i')
  return log.some(t => slash.test(t) || named.test(t))
}

/** The skills a handoff carries: the user's always, the rest as the handoff chose. */
export function carriedSkills(skills: readonly Skill[], keep: readonly string[], log: readonly string[]): Skill[] {
  const all = keep.includes('*')
  return skills.filter(s => all || keep.includes(s.name) || userAsked(s.name, log))
}

const SKILLS_HEADING = '### Skills still in use'
const TOO_LONG = 'Too long to carry here; invoke them again with the Skill tool:'

function skillsBlock(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  const full: Skill[] = []
  const named: string[] = []
  let budget = MAX_SKILL_CHARS
  for (const s of [...skills].reverse()) {
    if (s.text.length <= budget) {
      budget -= s.text.length
      full.unshift(s)
    } else {
      named.unshift(s.name)
    }
  }
  // The heading names every skill whose text follows, so the record can be read back exactly.
  const parts = [`${SKILLS_HEADING}${full.length > 0 ? `: ${full.map(s => s.name).join(', ')}` : ''}\n` +
    'These were loaded in an earlier context and still apply: follow them as if just invoked.']
  for (const s of full) parts.push(`#### ${s.name}\n${s.text}`)
  if (named.length > 0) parts.push(`${TOO_LONG} ${named.join(', ')}`)
  return parts.join('\n\n')
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`
}

/** The log so far plus the new messages, the first kept, the rest newest-first to the budget. */
export function mergeLog(log: readonly string[], added: readonly string[]): string[] {
  const all = [...log]
  all.push(...added)
  if (all.length === 0) return all
  const [first, ...rest] = all.map(t => clip(t, MAX_MESSAGE_CHARS))
  let budget = MAX_LOG_CHARS - first!.length
  const kept: string[] = []
  for (let i = rest.length - 1; i >= 0 && budget - rest[i]!.length >= 0; i--) {
    budget -= rest[i]!.length
    kept.unshift(rest[i]!)
  }
  return [first!, ...kept]
}

/** Files the main loop created or edited in this transcript, newest last. */
export function changedFiles(messages: readonly SessionMessage[], root: string): string[] {
  const files: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(use.tool) || use.isError) continue
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path !== 'string') continue
      const shown = relative(path, root)
      const at = files.indexOf(shown)
      if (at >= 0) files.splice(at, 1)
      files.push(shown)
    }
  }
  return files.slice(-MAX_FILES)
}

const MAX_READS = 20
const MAX_COMMANDS = 12
const MAX_IMAGES = 6
const MAX_ANSWER_CHARS = 3_000

const relative = (path: string, root: string) => {
  const norm = path.replaceAll('\\', '/')
  const base = root.replaceAll('\\', '/').replace(/\/$/, '')
  return norm.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? norm.slice(base.length + 1) : norm
}

/** Files the main loop read and did not change, newest last: where to look again. */
export function filesRead(messages: readonly SessionMessage[], root: string, changed: readonly string[]): string[] {
  const files: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (use.tool !== 'Read' || use.isError || typeof use.input.file_path !== 'string') continue
      const shown = relative(use.input.file_path, root)
      const at = files.indexOf(shown)
      if (at >= 0) files.splice(at, 1)
      files.push(shown)
    }
  }
  return files.filter(f => !changed.includes(f)).slice(-MAX_READS)
}

/** The last shell commands the main loop ran, a failed one marked, newest last. */
export function commandsRun(messages: readonly SessionMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (use.tool !== 'Bash' && use.tool !== 'PowerShell') continue
      if (typeof use.input.command !== 'string') continue
      const command = clip(use.input.command.replace(/\s+/g, ' ').trim(), 200)
      out.push(`${use.isError ? 'failed' : 'ok'}: ${command}`)
    }
  }
  return out.slice(-MAX_COMMANDS)
}

const MAX_TASKS = 30
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * The task list as the model last left it: the list the last record carried, then this
 * context's TodoWrite (which rewrites its list whole) and TaskCreate and TaskUpdate (one
 * task each, by id). Claude Code clears a list once every item in it is completed, and so
 * does the record. Past the cap, the oldest finished items go first.
 */
export function taskList(messages: readonly SessionMessage[], carried: readonly string[] = []): string[] {
  let todos: string[] = []
  const tasks = new Map<string, { status: string, subject: string }>()
  const clearFinished = () => {
    if (todos.every(line => line.startsWith('[completed]'))) todos = []
    if ([...tasks.values()].every(t => t.status === 'completed')) tasks.clear()
  }
  for (const line of carried) {
    const item = /^\[([\w-]+)\] (?:#(\S+) )?(.+)$/.exec(line)
    if (item === null) continue
    if (item[2] === undefined) todos.push(line)
    else tasks.set(item[2], { status: item[1]!, subject: item[3]! })
  }
  clearFinished()
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (use.isError) continue
      const input = use.input
      if (use.tool === 'TodoWrite' && Array.isArray(input.todos)) {
        todos = input.todos.flatMap(t => {
          const item = t as { content?: unknown, status?: unknown }
          return typeof item.content === 'string' ? [`[${String(item.status ?? 'pending')}] ${oneLine(item.content)}`] : []
        })
      } else if (use.tool === 'TaskCreate' && typeof input.subject === 'string') {
        // The id is the tool's to give: in its stored record, and in the text the model read.
        const record = use.result as { task?: { id?: unknown } } | undefined
        const id = typeof record?.task?.id === 'string' ? record.task.id : /#(\w+)/.exec(use.text ?? '')?.[1]
        if (id !== undefined) tasks.set(id, { status: 'pending', subject: oneLine(input.subject) })
      } else if (use.tool === 'TaskUpdate' && typeof input.taskId === 'string') {
        const task = tasks.get(input.taskId)
        if (input.status === 'deleted') tasks.delete(input.taskId)
        else if (task !== undefined) {
          if (typeof input.status === 'string') task.status = input.status
          if (typeof input.subject === 'string') task.subject = oneLine(input.subject)
        }
      }
      clearFinished()
    }
  }
  const all = [...todos, ...[...tasks].map(([id, t]) => `[${t.status}] #${id} ${t.subject}`)]
  let over = all.length - MAX_TASKS
  const kept = all.filter(line => over <= 0 || !line.startsWith('[completed]') || over-- <= 0)
  return kept.length <= MAX_TASKS ? kept : [...kept.slice(0, MAX_TASKS), `… ${kept.length - MAX_TASKS} more`]
}

/** What the user last read from the model before the handoff began: the reply they may be answering. */
export function lastAnswer(messages: readonly SessionMessage[]): string {
  let end = messages.length
  const asked = messages.findIndex(m => m.role === 'user' && m.text.slice(0, 300).includes(NOTICE))
  if (asked >= 0) end = asked
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim() !== '') return clip(m.text.trim(), MAX_ANSWER_CHARS)
  }
  return ''
}

const MAX_PLAN_CHARS = 8_000

/** The last plan the user approved (an accepted ExitPlanMode): an agreement, kept word for word. */
export function approvedPlan(messages: readonly SessionMessage[]): string {
  let plan = ''
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (use.tool === 'ExitPlanMode' && !use.isError && typeof use.input.plan === 'string') plan = use.input.plan
    }
  }
  return clip(plan.trim(), MAX_PLAN_CHARS)
}

type Image = { data: string, mediaType: string, label: string }

/** Images the user attached to their own messages (not tool output, which has a path or a tool to redo it). */
export function userImages(messages: readonly ApiLike[]): Image[] {
  const images: Image[] = []
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    const text = m.content.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join(' ')
    const label = clip(text.replace(HARNESS_BLOCK, '').replace(/\s+/g, ' ').trim(), 80)
    for (const b of m.content) {
      if (b.type !== 'image') continue
      const source = (b.source ?? b.file) as { data?: unknown, base64?: unknown, media_type?: unknown } | undefined
      const data = source?.data ?? source?.base64
      if (typeof data !== 'string') continue
      images.push({ data, mediaType: typeof source?.media_type === 'string' ? source.media_type : 'image/png', label })
    }
  }
  return images.slice(-MAX_IMAGES)
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
// A file read takes at most 4 MiB, and a pasted image's base64 can run to about 5 MB: a large
// one is kept in parts, `<name>`, `<name>.2`, ... in order.
const IMAGE_PART_CHARS = 3_000_000
const MAX_IMAGE_PARTS = 4

/** The archive name of a kept image, from the name or path a record lists; undefined for any other. */
export function imageName(text: string): { name: string, hash: string, mediaType: string } | undefined {
  const found = /image-([0-9a-f]{8})\.(png|jpg|gif|webp)\.b64(?!\w)/.exec(text)
  return found === null ? undefined : { name: found[0], hash: found[1]!, mediaType: IMAGE_TYPES[found[2]!]! }
}

type Work = { running: string[], ended: string[], wakeups: string[] }

// Subagents from the agent list, live; shells, monitors and workflows as the last turn end
// (the handoff's own) left them; and the wakeups that will prompt this session later.
async function backgroundWork($: EngineInterface): Promise<Work> {
  const inFlight = (await $.state.get(IN_FLIGHT)).value ?? []
  const wakeups = (await $.state.get(WAKEUPS)).value ?? []
  try {
    const agents = await $.agent.list()
    const line = (a: (typeof agents)[number]) => `${a.type}: ${a.description} (id ${a.id}, ${a.status})`
    const live = (s: string) => s === 'pending' || s === 'running' || s === 'waiting'
    const ids = new Set(agents.map(a => a.id))
    return {
      running: [...agents.filter(a => live(a.status)).map(line), ...inFlight.filter(t => !ids.has(t.id)).map(t => t.line)],
      ended: agents.filter(a => !live(a.status)).slice(-10).map(line),
      wakeups,
    }
  } catch {
    return { running: inFlight.map(t => t.line), ended: [], wakeups }
  }
}

/** One line for each piece of background work a Stop hook's input reports, subagents aside. */
export function inFlightLines(tasks: readonly { id: string, type: string, status: string, description: string, command?: string }[]) {
  return tasks.filter(t => t.type !== 'subagent').map(t => {
    const what = oneLine(t.description)
    const command = t.command === undefined || oneLine(t.command) === what ? '' : `, \`${clip(oneLine(t.command), 200)}\``
    return { id: t.id, line: `${t.type}: ${clip(what, 200)}${command} (id ${t.id}, ${t.status})` }
  })
}

/** One line for each scheduled wakeup a Stop hook's input reports. */
export function wakeupLines(crons: readonly { id: string, schedule: string, recurring: boolean, prompt: string }[]) {
  return crons.map(c => `${c.recurring ? 'recurring' : 'once'}, \`${c.schedule}\` (id ${c.id}): ${clip(oneLine(c.prompt), 300)}`)
}

type Carried = {
  log: readonly string[]
  omitted: number
  fullText: string
  answer: string
  skills: string
  tasks: readonly string[]
  git: string
  changed: readonly string[]
  read: readonly string[]
  commands: readonly string[]
  images: readonly string[]
  work: Work
  chain: readonly string[]
  plan: string
  transcripts: readonly string[]
}

const bullets = (items: readonly string[]) => items.map(i => `- ${i}`).join('\n')

// The headings a record is read back by, after a restart.
const LOG_HEADING = '### The user\'s messages, oldest first (recorded)'
const TASKS_HEADING = '### Task list (recorded)'
const WHOLE_HEADING = '### The whole session, word for word (recorded)'
const CHAIN_HEADING = '### Earlier handoffs in this session, newest last (recorded)'

// Reading order: what to follow (skills), what the user said, where things stand, what they
// last read. A handoff comes after all of it, so its Next step is the last thing read.
function recordBlock(r: Carried): string {
  const parts: string[] = []
  if (r.skills !== '') parts.push(r.skills)
  if (r.log.length > 0) {
    const notes = [
      r.omitted > 0 ? `${r.omitted} earlier messages are not shown here.` : '',
      r.fullText !== '' ? `Every message, in full, is in ${r.fullText}.` : '',
    ].filter(Boolean).join(' ')
    // Each message's further lines are indented, so no line of it can pass for a heading.
    parts.push(`${LOG_HEADING}\n${notes === '' ? '' : `${notes}\n`}` +
      r.log.map((t, i) => `${i + 1}. ${t.replaceAll('\n', '\n   ')}`).join('\n'))
  }
  if (r.plan !== '') parts.push(`### The plan the user approved (recorded)\n${r.plan}`)
  if (r.tasks.length > 0) parts.push(`${TASKS_HEADING}\n${bullets(r.tasks)}`)
  if (r.git !== '') parts.push(`### Git state (recorded)\n\`\`\`\n${r.git}\n\`\`\``)
  if (r.changed.length > 0) {
    parts.push('### Files edited in the previous context (recorded)\nOnly edits made with the file tools; ' +
      'files changed by shell commands are not listed. Their contents are not loaded here: read a file ' +
      `again before editing it.\n${bullets(r.changed)}`)
  }
  if (r.read.length > 0) {
    parts.push(`### Other files opened with Read in the previous context (recorded)\n${bullets(r.read)}`)
  }
  if (r.commands.length > 0) parts.push(`### Last commands run, newest last (recorded)\n${bullets(r.commands)}`)
  if (r.images.length > 0) {
    parts.push('### Images the user attached (recorded)\nKept as base64 text; to see one, call ' +
      `mcp__context-handoff__${IMAGE_TOOL} with its path.\n${bullets(r.images)}`)
  }
  if (r.work.running.length > 0) {
    parts.push('### Background work still running (recorded)\nIts results arrive in this ' +
      `context as notifications; TaskStop stops one by its id.\n${bullets(r.work.running)}`)
  }
  if (r.work.wakeups.length > 0) {
    parts.push('### Scheduled wakeups (recorded)\nEach submits its prompt to this session when it ' +
      `fires.\n${bullets(r.work.wakeups)}`)
  }
  if (r.work.ended.length > 0) {
    parts.push('### Earlier subagents (recorded)\nSendMessage with an id continues that agent with ' +
      `its own context.\n${bullets(r.work.ended)}`)
  }
  if (r.transcripts.length > 0) {
    const several = r.transcripts.length > 1 ? ', oldest first: the session moved to a new file when it was resumed' : ''
    parts.push(`${WHOLE_HEADING}\nEvery earlier message and tool result, one JSON object per line, each handoff ` +
      `starting at a "compact_boundary" line${several}:\n${bullets(r.transcripts)}\n` +
      'When you need a detail nothing here has, search rather than reading whole: ' +
      `\`grep -n -i -o -E '.{0,300}TERM.{0,300}' ${r.transcripts.map(t => `"${t}"`).join(' ')} | head -20\`.`)
  }
  if (r.chain.length > 0) {
    parts.push(`${CHAIN_HEADING}\nRead one when a past decision or detail matters that the handoff below ` +
      `leaves out.\n${bullets(r.chain)}`)
  }
  if (r.answer !== '') parts.push(`### What the user last read from you (recorded)\n${r.answer}`)
  return parts.join('\n\n')
}

const HANDOFF_MARK = '\n\n---\n\n## The handoff (written by the previous context)\n\n'

/** The fresh context's one message: how to read it, the record, then the handoff, Next step last. */
export function seedText(record: string, handoff: string, meta = ''): string {
  return `${SEED_LEAD}${meta === '' ? '' : ` ${meta}`}\n\n${SEED_GUIDE}\n\n${record}${HANDOFF_MARK}${handoff}`
}

// ---- Reading a record back. A restart empties the host's state, but the conversation it
// resumes still holds the last seed, or the record after a compaction: the record carries
// itself forward from there ----

type Prior = {
  log: string[]
  skills: Skill[]
  chain: string[]
  handoffs: number
  transcripts: string[]
  messagesFile: string
  tasks: string[]
}

// A section's text: from below its heading to the next recorded heading. Message lines are
// indented and skill bodies' own headings never end in "(recorded)", so neither ends one early.
function section(record: string, heading: string): { line: string, body: string } | undefined {
  const at = record.indexOf(`\n\n${heading}`)
  if (at < 0) return undefined
  const eol = record.indexOf('\n', at + 2)
  if (eol < 0) return { line: record.slice(at + 2), body: '' }
  const rest = record.slice(eol + 1)
  const end = rest.search(/\n\n### [^\n]*\(recorded\)\n/)
  return { line: record.slice(at + 2, eol), body: end < 0 ? rest : rest.slice(0, end) }
}

/** What a seed, or the record after a compaction, carried, read back from its text. */
export function parseRecord(text: string): Prior {
  const record = text.split(HANDOFF_MARK)[0]!
  const listed = (body = '') => body.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2))

  // "N. text", each further line of a message indented three spaces.
  const log: string[] = []
  const messages = section(record, LOG_HEADING)?.body ?? ''
  for (const line of messages.split('\n')) {
    const item = /^\d+\. ([\s\S]*)$/.exec(line)
    if (item !== null) log.push(item[1]!)
    else if (log.length > 0 && line.startsWith('   ')) log[log.length - 1] += `\n${line.slice(3)}`
  }

  const skills: Skill[] = []
  const held = section(record, SKILLS_HEADING)
  if (held !== undefined) {
    const body = held.body.replace(new RegExp(`\\n\\n${escapeRegExp(TOO_LONG)}[^\\n]*$`), '')
    const names = held.line.startsWith(`${SKILLS_HEADING}: `) ? held.line.slice(SKILLS_HEADING.length + 2).split(', ') : []
    let from = names.length > 0 ? body.indexOf(`\n\n#### ${names[0]}\n`) : -1
    for (let i = 0; i < names.length && from >= 0; i++) {
      const start = from + `\n\n#### ${names[i]}\n`.length
      const end = i + 1 < names.length ? body.indexOf(`\n\n#### ${names[i + 1]}\n`, start) : -1
      skills.push({ name: names[i]!, text: body.slice(start, end < 0 ? body.length : end) })
      from = end
    }
    // A record in the older format names its skills only above each one, whose text opens with its base directory.
    if (names.length === 0) {
      const each = /\n\n#### ([^\n]+)\n(Base directory for this skill:[\s\S]*?)(?=\n\n#### [^\n]+\nBase directory for this skill:|$)/g
      for (const m of body.matchAll(each)) skills.push({ name: m[1]!, text: m[2]! })
    }
  }

  const whole = section(record, WHOLE_HEADING)?.body ?? ''
  const transcripts = listed(whole)
  // In the older format the one transcript stood inside the sentence.
  const single = /is in (.+?\.jsonl): one JSON object/.exec(whole)?.[1]
  if (transcripts.length === 0 && single !== undefined) transcripts.push(single)

  const saved = /^[^\n]*? It is saved in (\S+?\.md)\./.exec(record)?.[1]
  return {
    log,
    skills,
    chain: [...listed(section(record, CHAIN_HEADING)?.body), ...(saved === undefined ? [] : [saved])],
    handoffs: Number(/^[^\n]*?This is handoff (\d+) of the session/.exec(record)?.[1] ?? 0),
    transcripts,
    messagesFile: /Every message, in full, is in (.+?)\.$/m.exec(messages)?.[1] ?? '',
    tasks: listed(section(record, TASKS_HEADING)?.body),
  }
}

/** The last record in this context: the seed it began from, or the record after a compaction. */
function lastRecord(messages: readonly SessionMessage[]): Prior | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && (m.text.startsWith(SEED_LEAD) || m.text.startsWith(RECORD_LEAD))) return parseRecord(m.text)
  }
  return undefined
}

// Once per process: a log never written means the host's state started empty, so take the
// session's record back from the conversation, merged under whatever arrived since.
async function restore($: EngineInterface, prior: Prior | undefined) {
  if (prior === undefined || (await $.state.get(USER_LOG)).version > 0) return
  await $.state.set(USER_LOG, prior.log)
  await $.state.set(SKILLS, mergeSkills(prior.skills, (await $.state.get(SKILLS)).value ?? []))
  const chain = (await $.state.get(CHAIN)).value ?? []
  await $.state.set(CHAIN, [...prior.chain.filter(c => !chain.includes(c)), ...chain].slice(-5))
  // This process counts only its own handoffs, which may already include one accepted before now.
  await $.state.set(HANDOFFS, prior.handoffs + ((await $.state.get(HANDOFFS)).value ?? 0))
  const transcripts = (await $.state.get(TRANSCRIPTS)).value ?? []
  await $.state.set(TRANSCRIPTS, [...prior.transcripts.filter(t => !transcripts.includes(t)), ...transcripts])
  if (prior.messagesFile !== '' && !(await $.state.get(MESSAGES_FILE)).value) await $.state.set(MESSAGES_FILE, prior.messagesFile)
  await $.state.set(RESTORED, true)
}

// The one file that holds every message in full: the session's, named when it was first
// written. A record in the older format does not name it; its transcript's session id does.
// Returns that session id: the file is .claude/handoffs/<id>-messages.md.
async function messagesFile($: EngineInterface, root: string, transcripts: readonly string[]): Promise<string> {
  const known = (await $.state.get(MESSAGES_FILE)).value ?? ''
  if (known !== '') return known.replace(/^.*[\\/]/, '').replace(/-messages\.md$/, '')
  let id = await $.session.id()
  for (const t of transcripts) {
    const earlier = t.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '')
    if (await $.fs.exists(`${root}/.claude/handoffs/${earlier}-messages.md`)) {
      id = earlier
      break
    }
  }
  await $.state.set(MESSAGES_FILE, `${ARCHIVE_DIR}/${id}-messages.md`)
  return id
}

// FNV-1a: names a saved file by its content, so saving it again is a no-op.
function digest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// What the archive holds (the user's words, images) stays out of the project's history.
async function ignoreArchive($: EngineInterface, root: string) {
  if (await $.fs.exists(`${root}/.claude/handoffs/.gitignore`)) return
  await $.fs.write(`${root}/.claude/handoffs/.gitignore`, '# Written by context-handoff: handoffs may hold private text.\n*\n')
}

// The user's own words, as they arrive: held until the next handoff or compaction.
async function capture($: EngineInterface, text: string) {
  const pending = (await $.state.get(USER_NEW)).value ?? []
  // The same words can arrive twice (a slash command is also a prompt): keep them once.
  if (text === '' || pending.at(-1) === text) return
  await $.state.set(USER_NEW, [...pending, clip(text, MAX_CAPTURE_CHARS)])
  await $.state.set(CAPTURING, true)
}

// Holds the handoff and keeps a copy for people to read later.
async function accept($: EngineInterface, text: string, keepSkills: readonly string[] = ['*']): Promise<string> {
  await $.state.set(HANDOFF, text)
  await $.state.set(KEEP_SKILLS, [...keepSkills])
  // From here the old context is on its way out: hold what arrives for the fresh one.
  await $.state.set(HOLDING, Date.now())
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archived = `${ARCHIVE_DIR}/${stamp}.md`
  await $.state.set(SAVED, '')
  try {
    const root = await $.session.root()
    await ignoreArchive($, root)
    await $.fs.write(`${root}/.claude/handoffs/${stamp}.md`, text)
    await $.state.set(SAVED, archived)
    await $.state.set(CHAIN, [...((await $.state.get(CHAIN)).value ?? []), archived].slice(-5))
    await $.state.set(HANDOFFS, ((await $.state.get(HANDOFFS)).value ?? 0) + 1)
  } catch (err) {
    // The archive is for people; the handoff itself is already held.
    $.ui.toast(`context-handoff: could not archive the handoff (${String(err)})`)
  }
  $.ui.status('handoff: applying')
  return archived
}

// Replace the conversation with the held handoff, then resume in the fresh context.
async function applyHandoff($: EngineInterface) {
  // One application at a time: a turn can end, or a fork can finish, while one is under way.
  if (Date.now() - ((await $.state.get(APPLYING)).value ?? 0) < APPLY_WINDOW_MS) return
  await $.state.set(APPLYING, Date.now())
  await $.state.set(HOLDING, Date.now())
  // Run /compact rather than $.session.compact: a plugin's own compact() call skips
  // that plugin's session.compact hook, so core would summarize instead of us.
  // /compact's compaction passes every hook, ours included. It rejects inside a
  // hook the turn waits on; give the engine a moment to go idle.
  const attempt = (left: number) =>
    $.clock.after(500, async () => {
      try {
        await $.command.run({ command: 'compact' })
        await reset($)
        await $.state.set(APPLYING, 0)
        $.ui.toast('Context handed off; continuing in a fresh context.')
        await $.prompt.submit({ text: RESUME })
      } catch (err) {
        if (left > 0) return attempt(left - 1)
        // Give up cleanly: stop holding the user's messages and hand back what was held. The
        // handoff stays pending, so the next turn end tries again, and /compact applies it now.
        await $.state.set(APPLYING, 0)
        await $.state.set(HOLDING, 0)
        const held = (await $.state.get(HELD)).value ?? ''
        await $.state.set(HELD, '')
        $.ui.toast(`Handoff reset failed (${String(err)}). It is tried again when the next turn ends; /compact applies it now.`)
        if (held !== '') await $.prompt.submit({ text: `The user wrote this while a handoff was being applied:\n\n${held}` })
      }
    })
  attempt(10)
}

// The conversation's facts the machine can vouch for, carried into the next context.
// A handoff carries the skills that still apply. Any other compaction is core's, which
// attaches the skills it tracks itself.
async function recorded($: EngineInterface, messages: readonly SessionMessage[], handoff: boolean): Promise<string> {
  const root = await $.session.root()
  const prior = lastRecord(messages)
  await restore($, prior)
  const before = (await $.state.get(USER_LOG)).value ?? []
  const captured = (await $.state.get(USER_NEW)).value ?? []
  let mine: string[]
  if ((await $.state.get(CAPTURING)).value !== true) {
    // No prompt has reached the mod yet: read the user's words from the transcript, minus
    // what an earlier pass over the same transcript (a precompute) already took.
    const seen = new Set(before)
    mine = userMessages(messages).filter(t => !seen.has(clip(t, MAX_MESSAGE_CHARS)))
  } else {
    // Messages sent before the mod loaded exist only in the transcript: take those once.
    const scanned = (await $.state.get(PREFIXED)).value === true ? [] : userMessages(messages)
    const first = captured.length > 0 ? scanned.indexOf(captured[0]!) : -1
    mine = [...(first > 0 ? scanned.slice(0, first) : []), ...captured]
    await $.state.set(PREFIXED, true)
  }
  await $.state.set(USER_NEW, [])
  const log = mergeLog(before, mine)
  await $.state.set(USER_LOG, log)
  // Every message in full, across the session, in one file the record points to.
  let fullText = ''
  let total = 0
  const transcripts = (await $.state.get(TRANSCRIPTS)).value ?? []
  try {
    await ignoreArchive($, root)
    const id = await messagesFile($, root, transcripts)
    const old = (await $.fs.exists(`${root}/.claude/handoffs/${id}-messages.md`))
      ? await $.fs.read(`${root}/.claude/handoffs/${id}-messages.md`)
      : ''
    // After a restart the digests are gone, but the file still holds every message it was given.
    const seen = (await $.state.get(ARCHIVED)).value ?? old.split(/\n\n## Message \d+\n\n/).slice(1).map(digest)
    const fresh = mine.filter(t => !seen.includes(digest(t)))
    total = seen.length + fresh.length
    if (fresh.length > 0) {
      const added = fresh.map((t, i) => `## Message ${seen.length + i + 1}\n\n${t}`).join('\n\n')
      await $.fs.write(`${root}/.claude/handoffs/${id}-messages.md`, old === '' ? `# The user's messages, in full\n\n${added}` : `${old}\n\n${added}`)
    }
    await $.state.set(ARCHIVED, [...seen, ...fresh.map(digest)])
    if (total > 0) fullText = `${ARCHIVE_DIR}/${id}-messages.md`
  } catch {
    // The record still holds the messages, cut to fit.
  }
  const api = await apiMessages($)
  let skills = ''
  if (handoff) {
    const { all } = await loadedSkills($, messages, api)
    const carried = carriedSkills(all, (await $.state.get(KEEP_SKILLS)).value ?? ['*'], log)
    // A skill dropped here stays dropped until it is loaded again.
    await $.state.set(SKILLS, carried)
    skills = skillsBlock(carried)
  }
  const changed = changedFiles(messages, root)
  const chain = (await $.state.get(CHAIN)).value ?? []
  const saved = (await $.state.get(SAVED)).value ?? ''
  return recordBlock({
    log,
    omitted: Math.max(0, total - log.length),
    fullText,
    answer: lastAnswer(messages),
    skills,
    tasks: taskList(messages, prior?.tasks),
    git: await gitState($),
    changed,
    read: filesRead(messages, root, changed),
    commands: commandsRun(messages),
    images: await saveImages($, root, api),
    work: await backgroundWork($),
    // The handoff being applied is already in the seed, which names where it is saved.
    chain: handoff ? chain.filter(c => c !== saved) : chain,
    plan: approvedPlan(messages),
    transcripts,
  })
}

// Branch, uncommitted changes and the last commits; nothing outside a repository.
async function gitState($: EngineInterface): Promise<string> {
  try {
    const status = await $.process.run(['git', 'status', '--short', '--branch'], { timeoutMs: 5_000 })
    if (status.exitCode !== 0) return ''
    const lines = status.stdout.trimEnd().split('\n')
    const shown = lines.length > 30 ? [...lines.slice(0, 30), `… ${lines.length - 30} more`] : lines
    const log = await $.process.run(['git', 'log', '--oneline', '-5'], { timeoutMs: 5_000 })
    return [...shown, '', 'Last commits:', log.exitCode === 0 ? log.stdout.trimEnd() : '(none)'].join('\n')
  } catch {
    return ''
  }
}

// The user's pasted images live only inside the transcript. Each is kept as its base64 text,
// which the mod's own file writes can hold, named by its digest, and handoff_image shows it to
// the fresh context when asked: nothing is spent on an image until the model looks at it.
async function saveImages($: EngineInterface, root: string, api: readonly ApiLike[]): Promise<string[]> {
  const saved: string[] = []
  try {
    await ignoreArchive($, root)
  } catch {
    return saved
  }
  for (const image of userImages(api)) {
    const ext = Object.keys(IMAGE_TYPES).find(x => IMAGE_TYPES[x] === image.mediaType) ?? 'png'
    const name = `image-${digest(image.data)}.${ext}.b64`
    try {
      if (!(await $.fs.exists(`${root}/.claude/handoffs/${name}`))) {
        const parts: string[] = []
        for (let at = 0; at < image.data.length; at += IMAGE_PART_CHARS) parts.push(image.data.slice(at, at + IMAGE_PART_CHARS))
        if (parts.length > MAX_IMAGE_PARTS) continue
        // The first part goes last: once it is there, so is the whole image.
        for (let i = parts.length - 1; i > 0; i--) await $.fs.write(`${root}/.claude/handoffs/${name}.${i + 1}`, parts[i]!)
        await $.fs.write(`${root}/.claude/handoffs/${name}`, parts[0]!)
      }
      saved.push(`${ARCHIVE_DIR}/${name}${image.label === '' ? '' : ` (with "${image.label}")`}`)
    } catch {
      // One image that cannot be kept leaves the others listed.
    }
  }
  return saved
}

// The image a record lists, as the model reads an image: whole, or an error and no image.
async function showImage($: EngineInterface, request: unknown): Promise<{ result: unknown, isError?: true }> {
  const image = typeof request === 'string' ? imageName(request) : undefined
  if (image === undefined) {
    return { result: 'Pass `image`, the path of an image the record lists, such as .claude/handoffs/image-0a1b2c3d.png.b64.', isError: true }
  }
  const root = await $.session.root()
  if (!(await $.fs.exists(`${root}/.claude/handoffs/${image.name}`))) {
    return { result: `${ARCHIVE_DIR}/${image.name} is not there; it may have been deleted.`, isError: true }
  }
  let data = await $.fs.read(`${root}/.claude/handoffs/${image.name}`)
  for (let part = 2; part <= MAX_IMAGE_PARTS && (await $.fs.exists(`${root}/.claude/handoffs/${image.name}.${part}`)); part++) {
    data += await $.fs.read(`${root}/.claude/handoffs/${image.name}.${part}`)
  }
  // The name is the digest of the whole base64: a part missing or changed would send a broken
  // image, which fails the model's next request, so it is refused here instead.
  if (digest(data) !== image.hash) {
    return { result: `${ARCHIVE_DIR}/${image.name} is incomplete or was changed, so it is not shown.`, isError: true }
  }
  return { result: [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data } }] }
}

// ---------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const softTokens = tokens(options, 'softTokens', SOFT_TOKENS)
  const firmTokens = Math.max(tokens(options, 'firmTokens', FIRM_TOKENS), softTokens)
  const thresholds = (window: number) => ({
    soft: Math.min(softTokens, window * SOFT_SHARE),
    firm: Math.min(firmTokens, window * FIRM_SHARE),
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL,
      description:
        `Call only after a ${NOTICE} message. Replaces the conversation with the ` +
        'handoff you pass, so the work continues in a fresh context.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff: { type: 'string', description: 'The full handoff, in Markdown, with every section the policy names.' },
          skills: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of the loaded skills that still apply to the remaining work; leave out ones that ' +
              'turned out irrelevant. Skills the user asked for are kept regardless. Omit to keep every loaded skill.',
          },
        },
        required: ['handoff'],
      },
    })
    await $.tool.register({
      name: IMAGE_TOOL,
      description:
        'Shows you an image the user pasted before a context handoff: one the record lists under ' +
        '"Images the user attached". Each is kept as base64 text in .claude/handoffs/, a large one in ' +
        'parts (<name>, <name>.2, ...); decode it yourself only if you need the image as a file.',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'The image\'s path as the record lists it, such as .claude/handoffs/image-0a1b2c3d.png.b64.' },
        },
        required: ['image'],
      },
    })
    // A reload drops the timers of an application under way: start it again.
    await $.state.set(APPLYING, 0)
    if ((await getHandoff($)) !== '') await applyHandoff($)
    await $.command.register({
      name: 'handoff',
      description: 'Context handoff: show the status, or "now" to hand off at the next stopping point',
      argumentHint: '[now]',
    })
    return started
  })

  // Every skill the model reads, by the text it reads, so a handoff can carry it.
  on('skill.prompt', async ($, e, next) => {
    const prompt = await next(e)
    const known = (await $.state.get(SKILLS)).value ?? []
    await $.state.set(SKILLS, mergeSkills(known, [{ name: e.skill, text: prompt.text }]))
    return prompt
  }).catch(($, e, next) => next(e))

  // A /clear starts new work: the user's log of the old work no longer applies.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      await reset($)
      await $.state.set(USER_LOG, [])
      await $.state.set(HELD, '')
      await $.state.set(SKILLS, [])
      await $.state.set(CHAIN, [])
      await $.state.set(ARCHIVED, [])
      await $.state.set(USER_NEW, [])
      await $.state.set(PREFIXED, true)
      await $.state.set(HANDOFFS, 0)
      await $.state.set(TRANSCRIPTS, [])
      await $.state.set(MESSAGES_FILE, '')
      await $.state.set(SAVED, '')
      await $.state.set(RESTORED, false)
    }
    return ended
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: 'context-handoff', text: POLICY, scope: 'session' }],
    }
  })


  // Before each model request of the main loop, mid-turn included.
  on('turn.step', async function* ($, e, next) {
    const stage = e.agentId === undefined ? await getStage($) : 'firm'
    if (stage !== 'firm' && (await getHandoff($)) === '') {
      const { context } = await $.session.usage()
      const { soft, firm } = thresholds(context.window)
      const used = context.tokens ?? 0
      let baseline = (await $.state.get(BASELINE)).value ?? 0
      if (baseline < 0) {
        baseline = used
        await $.state.set(BASELINE, used)
        if (used >= soft) {
          $.ui.toast(
            `context-handoff: this context starts at ${k(used)} tokens, past the ${k(soft)} ` +
            'threshold. It hands off again only after real progress; consider raising the ' +
            'thresholds or keeping handoffs shorter.')
        }
      }
      const grown = used - baseline >= Math.max(soft * MIN_GROWTH_SHARE, MIN_GROWTH_TOKENS)
      if (grown && used >= firm) {
        await $.state.set(STAGE, 'firm')
        $.ui.status('handoff: now')
        await nudge($,
          `${NOTICE} ${k(used)} tokens used. Stop starting work: bring what is in ` +
          `progress to a resumable state now, then call ${TOOL} with the handoff.`)
      } else if (grown && used >= soft && stage === 'none') {
        await $.state.set(STAGE, 'soft')
        $.ui.status('handoff: at next stopping point')
        await nudge($,
          `${NOTICE} ${k(used)} tokens used. Continue the current unit of work to its ` +
          `natural stopping point, start nothing new, then call ${TOOL} with the handoff.`)
      }
    }
    return yield* next(e)
  })



  // One hook per event. The engine does not chain a plugin's several hooks on one event the
  // way the test kit does: live, the gate's next() went past the handoff tool's own hook, and
  // handoff_ready went unanswered. Each event's cases are dispatched here instead.
  on('tool.call', async ($, e, next) => {
    // The handoff arrives as the tool's argument, not a file the model writes: no permission
    // prompt for the write, and no earlier context's file can be picked up by mistake.
    if (e.tool === 'mcp__context-handoff__handoff_ready') {
      if ((await getStage($)) === 'none') {
        return { result: `Not requested: no ${NOTICE} message has been sent. Carry on.`, isError: true }
      }
      const raw = e as unknown as { input?: Record<string, unknown> } & Record<string, unknown>
      const input = (raw.input ?? raw) as { handoff?: unknown, skills?: unknown }
      const text = typeof input.handoff === 'string' ? input.handoff.trim() : ''
      if (text.length < MIN_HANDOFF_CHARS) {
        return { result: 'The handoff is missing or too thin. Pass the full handoff as `handoff`.', isError: true }
      }
      const keep = Array.isArray(input.skills) ? input.skills.filter((n): n is string => typeof n === 'string') : ['*']
      const archived = await accept($, text, keep)
      return { result: `Handoff accepted (saved to ${archived}). End your turn now with a one-line summary; do no further work.` }
    }
    if (e.tool === 'mcp__context-handoff__handoff_image') {
      const raw = e as unknown as { input?: Record<string, unknown> } & Record<string, unknown>
      return showImage($, (raw.input ?? raw).image)
    }
    // The user's answers to the model's questions are decisions, though they arrive as a tool result.
    if (e.tool === 'AskUserQuestion') {
      const answered = await next(e)
      if (e.agentId === undefined) {
        const r = answered as unknown as { text?: unknown, result?: unknown, isError?: unknown }
        const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '')
        if (r.isError !== true && text.trim() !== '') await capture($, `(answering your question) ${clip(text.trim(), 1_500)}`)
      }
      return answered
    }
    // Past the firm threshold by a margin, the notice is no longer a request: every other tool
    // call of the main loop is refused, so a model that keeps going cannot run the window into
    // auto-compact. It still answers in text, and the turn-end ask and fork follow. ToolSearch
    // stays open (handoff_ready may be a deferred tool whose schema it loads), and so does the
    // task list's bookkeeping.
    if (e.agentId !== undefined || GATE_OPEN.has(e.tool)) return next(e)
    if ((await getStage($)) !== 'firm' || (await getHandoff($)) !== '') return next(e)
    const { context } = await $.session.usage()
    const used = context.tokens ?? 0
    if (used < thresholds(context.window).firm + GATE_MARGIN_TOKENS) return next(e)
    return { deny: `${NOTICE} ${k(used)} tokens used, past the handoff point. No more tool calls: call ${TOOL} with the handoff now.` }
  }).catch(($, e, next) => {
    // A failure never blocks work, and the handoff tool always gets an answer.
    if (next.called) return next(e)
    if (e.tool === 'mcp__context-handoff__handoff_ready') return { result: `Handoff check failed; call ${TOOL} again.`, isError: true }
    if (e.tool === 'mcp__context-handoff__handoff_image') return { result: 'The image could not be read.', isError: true }
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command === 'handoff') {
      if (e.args.trim() === 'now') {
        if ((await getHandoff($)) !== '') return { text: 'A handoff is already being applied.' }
        await $.state.set(STAGE, 'firm')
        $.ui.status('handoff: requested')
        submitLater($,
          `${NOTICE} The user asked for a handoff now. Bring what is in progress to a resumable ` +
          `state, then call ${TOOL} with the handoff.`)
        return { text: 'Asking Claude to hand off.' }
      }
      const { context } = await $.session.usage()
      const { soft, firm } = thresholds(context.window)
      const baseline = (await $.state.get(BASELINE)).value ?? 0
      const floor = Math.max(soft * MIN_GROWTH_SHARE, MIN_GROWTH_TOKENS)
      const rows = await $.session.messages().catch(() => [])
      await restore($, lastRecord(rows))
      // Where each skill was found, so a skill a handoff would miss shows here first. The
      // record holds what the hook saw, what the last handoff carried and what a restore took back.
      const found = await loadedSkills($, rows, await apiMessages($))
      const sources = { record: found.hook, transcript: found.inRows, 'model input': found.inApi }
      const where = (name: string) => Object.entries(sources)
        .filter(([, list]) => list.some(s => s.name === name)).map(([label]) => label).join(', ')
      const pending = ((await $.state.get(USER_NEW)).value ?? []).length
      const lines = [
        `context ${k(context.tokens ?? 0)} of ${k(context.window)}; soft ${k(soft)}, firm ${k(firm)}`,
        `stage: ${await getStage($)}${(await getHandoff($)) !== '' ? ' (handoff being applied)' : ''}`,
        baseline > 0 ? `this context started at ${k(baseline)}; it can be asked from ${k(Math.max(soft, baseline + floor))}` : '',
        `handoffs so far: ${(await $.state.get(HANDOFFS)).value ?? 0}` +
          ((await $.state.get(RESTORED)).value === true ? ' (record restored from the conversation after a restart)' : ''),
        `user messages on record: ${((await $.state.get(USER_LOG)).value ?? []).length}` +
          (pending > 0 ? `, and ${pending} since the last handoff` : ''),
        `skills loaded: ${found.all.map(s => `${s.name} (${where(s.name)})`).join('; ') || 'none'}`,
      ]
      return { text: lines.filter(Boolean).join('\n') }
    }
    // A slash command the user typed, when it carries their words: text after the name, or a skill they asked for.
    const ran = await next(e)
    if (!NOT_THE_USER.has(e.origin.kind)) {
      const skills = (await $.state.get(SKILLS)).value ?? []
      const isSkill = skills.some(sk => sk.name === e.command || sk.name.endsWith(`:${e.command}`))
      if (e.args.trim() !== '' || isSkill) await capture($, `/${e.command}${e.args.trim() === '' ? '' : ` ${e.args.trim()}`}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Where the session's transcript is, so the record can point to every earlier word of it. A
  // resumed session goes on in a new file; the earlier ones keep what came before. And what
  // is still running or scheduled as the turn ends, which no other event lists.
  on('classic.Stop', async ($, e, next) => {
    const path = e.transcript_path
    if (typeof path === 'string' && path !== '') {
      const known = (await $.state.get(TRANSCRIPTS)).value ?? []
      if (known.at(-1) !== path) await $.state.set(TRANSCRIPTS, [...known.filter(t => t !== path), path])
    }
    if (Array.isArray(e.background_tasks)) await $.state.set(IN_FLIGHT, inFlightLines(e.background_tasks))
    if (Array.isArray(e.session_crons)) await $.state.set(WAKEUPS, wakeupLines(e.session_crons))
    return next(e)
  }).catch(($, e, next) => next(e))

  // The user's words, captured where they enter, labelled by where they came from: no
  // tool output, command output or plugin prompt can pass for them. Whatever arrives
  // between the handoff and the reset would land in the old context and be wiped with it:
  // hold it and send it on with the resume prompt.
  on('prompt.submit', async ($, e, next) => {
    if (!NOT_THE_USER.has(e.origin.kind)) await capture($, e.text.trim())
    const holding = Date.now() - ((await $.state.get(HOLDING)).value ?? 0) < APPLY_WINDOW_MS
    if (e.origin.kind !== 'plugin' && holding && (await getHandoff($)) !== '') {
      const held = (await $.state.get(HELD)).value ?? ''
      await $.state.set(HELD, held === '' ? e.text : `${held}\n\n${e.text}`)
      return { drop: 'Handing off to a fresh context; this message will be sent there.' }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    // The model handed off and ended its turn: replace the conversation, then resume.
    if ((await getHandoff($)) !== '') {
      await applyHandoff($)
      return done
    }
    if ((await getStage($)) === 'none') return done
    // Asked, but the turn ended without a handoff. The end of a turn is itself a natural
    // stopping point: ask once more, and if that turn also ends without one, have a fork
    // of this context write it, so the handoff never rests on the model's compliance.
    if (!(await $.state.get(REASKED)).value) {
      await $.state.set(REASKED, true)
      submitLater($, REASK)
      return done
    }
    $.clock.after(0, async () => {
      const reply = await $.model.fork({ prompt: FORK_PROMPT })
      const text = reply.isAnswered ? reply.text.trim() : ''
      if (text.length >= MIN_HANDOFF_CHARS) {
        await accept($, text)
        await applyHandoff($)
      } else {
        $.ui.toast('context-handoff: the model did not hand off and a fork could not write the ' +
          'handoff; auto-compact remains the backstop. Run /handoff now to try again.')
      }
    })
    return done
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const handoff = await getHandoff($)
    if (handoff !== '') {
      // A precompute is kept for a later compaction; a pending handoff must not be.
      if (e.trigger === 'precompute') return { skip: 'context-handoff: a handoff is pending' }
      // The handoff alone becomes the conversation: a fresh session seeded with it and with
      // what the machine recorded. Whatever compaction carries it (ours, or auto-compact in
      // the middle of a turn) applies it, so it is consumed here and cannot apply twice.
      const held = (await $.state.get(HELD)).value ?? ''
      await $.state.set(HELD, '')
      const body = held === '' ? handoff : `${handoff}\n\n## The user wrote this while the handoff was being applied\n\n${held}`
      // The record first: after a restart it restores the count and the chain the header reads.
      const record = await recorded($, e.messages, true)
      const saved = (await $.state.get(SAVED)).value ?? ''
      const meta = `This is handoff ${(await $.state.get(HANDOFFS)).value || 1} of the session, written ` +
        `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC at ` +
        `${k((await $.session.usage()).context.tokens ?? 0)} tokens.${saved === '' ? '' : ` It is saved in ${saved}.`}`
      const seed = seedText(record, body, meta)
      await reset($)
      return {
        messages: [{
          role: 'user' as const,
          text: seed,
          toolUses: [],
        }],
      }
    }
    // Any other compaction: the user's /compact, or the backstop when the window filled
    // before a handoff landed. Never veto one near the limit (the next request could
    // fail); have the summary written as a handoff, and carry the record after it.
    // A precompute is the auto compaction computed ahead of time, so it gets the same.
    const asHandoff = e.trigger === 'auto' || e.trigger === 'precompute'
    const instructions = asHandoff ? `${e.instructions ? `${e.instructions}\n\n` : ''}${HANDOFF_TEMPLATE}` : e.instructions
    const record = await recorded($, e.messages, false)
    const compacted = await next({ ...e, instructions })
    if (e.trigger !== 'precompute') await reset($)
    if (compacted.messages === undefined) return compacted
    const after = `${RECORD_LEAD}\n${SEED_GUIDE.split('\n').slice(2, 5).join('\n')}\n\n${record}`
    return { ...compacted, messages: [...compacted.messages, { role: 'user' as const, text: after, toolUses: [] }] }
  }).catch(($, e, next) => next(e)) // a broken handoff must never stop a compaction
}
