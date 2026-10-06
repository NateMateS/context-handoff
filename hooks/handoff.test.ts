import { expect, mock, test } from 'claude-code/testing'
import { imageName, parseRecord, taskList, userAsked } from './register'

const TOOL = 'mcp__context-handoff__handoff_ready'
const IMAGE_TOOL = 'mcp__context-handoff__handoff_image'
const HANDOFF = `# Handoff\n${'Goal, status, decisions, files, verification, next step. '.repeat(8)}`

type Body = Parameters<typeof test>[1]
type Engine = Parameters<Extract<Body, Function>>[0]
type On = Parameters<Extract<Body, Function>>[1]

// A session double: usage, a project root, a file system, and a count of
// the notices sent. The kit has no transcript store for a plugin's append, so every
// notice fails into the mod's fallback toast; counting those counts the notices.
function harness($: Engine, on: On, window = 1_000_000) {
  const s = {
    tokens: 100_000,
    nudges: 0,
    toasts: [] as string[],
    instructions: '',
    files: new Map<string, string>(),
    failWrites: false,
    compacts: 0,
    failCompact: false,
    // The transcript a /compact runs over, what the mod sent as prompts, the seed it built.
    transcript: [] as { role: 'user' | 'assistant', text: string, toolUses: any[], toolResults?: any[] }[],
    submitted: [] as string[],
    seed: '',
    fork: '' as string,
    agents: [] as { id: string, type: string, description: string, status: string }[],
  }
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: s.tokens, window } } }))
  on('session.root', () => ({ value: 'H:/proj' }))
  on('ui.toast', ($, e) => {
    const text = JSON.stringify(e)
    if (text.includes('handoff notice')) s.nudges++
    else s.toasts.push(text)
    return { value: undefined }
  })
  // The engine hands paths over in the platform's spelling.
  const key = (p: string) => p.replaceAll('\\', '/')
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.exists', ($, e) => ({ value: s.files.has(key(e.path)) }))
  on('fs.read', ($, e) => ({ value: s.files.get(key(e.path)) ?? '' } as never))
  on('fs.write', ($, e) => {
    if (s.failWrites) throw new Error('EACCES')
    s.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('session.compact', ($, e) => {
    s.instructions = e.instructions ?? ''
    return { messages: [{ role: 'user' as const, text: 'core summary', toolUses: [] }] }
  })
  on('ui.status', () => ({ value: undefined }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => { s.submitted.push(e.text); return { text: e.text } })
  on('model.fork', () => ({ value: s.fork === '' ? { isAnswered: false, reason: 'empty-reply' } : { isAnswered: true, text: s.fork } } as never))
  on('agent.list', () => ({ value: s.agents } as never))
  // /compact, as the engine runs it: a manual compaction through every plugin's hook.
  on('command.run', async (_, e) => {
    if (e.command === 'compact') {
      s.compacts++
      if (s.failCompact) throw new Error('busy')
      const r = await $.session.compact({ trigger: 'manual', messages: s.transcript })
      s.seed = r.messages?.[0]?.text ?? ''
    }
    return {}
  })

  return {
    s,
    clock,
    turnEnds: async () => {
      await $.turn.complete({ turnId: 't', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
      await clock.advance(5_000)
    },
    command: (args: string) => $.command.run({ command: 'handoff', args } as never),
    step: async () => {
      for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })) { /* drain */ }
    },
    ready: async (handoff?: string) =>
      JSON.stringify(await $.tool.call({ tool: TOOL, input: handoff === undefined ? {} : { handoff } })),
    compact: (trigger: 'plugin' | 'manual' | 'auto') =>
      $.session.compact({ trigger, messages: [{ role: 'user', text: 'old', toolUses: [] }] }),
  }
}

test('nudges past the soft threshold, then swaps the transcript for the handoff', async ($, on) => {
  const { s, step, ready, compact } = harness($, on)

  // Below the threshold: no nudge, and the tool refuses to fire unasked.
  await step()
  expect(s.nudges).toBe(0)
  expect(await ready(HANDOFF)).toContain('Not requested')

  // Past 300k: one nudge, not repeated on the next step.
  s.tokens = 320_000
  await step()
  await step()
  expect(s.nudges).toBe(1)

  // Asked now, but the handoff is missing or too short.
  expect(await ready()).toContain('too thin')
  expect(await ready('# Handoff\nshort')).toContain('too thin')

  // In full: accepted and archived, with no file of the model's involved.
  expect(await ready(HANDOFF)).toContain('Handoff accepted')
  expect([...s.files.keys()].some(k => k.startsWith('H:/proj/.claude/handoffs/'))).toBe(true)

  // The next compaction is the handoff alone.
  const compacted = await compact('plugin')
  expect(compacted.messages?.length).toBe(1)
  expect(compacted.messages?.[0]?.text).toContain('# Handoff')
})

test('a failed archive write does not lose the handoff', async ($, on) => {
  const { s, step, ready, compact } = harness($, on)
  s.failWrites = true
  s.tokens = 320_000
  await step()
  expect(await ready(HANDOFF)).toContain('Handoff accepted')
  expect((await compact('plugin')).messages?.[0]?.text).toContain('# Handoff')
})

test('escalates to firm past the firm threshold, once', async ($, on) => {
  const { s, step } = harness($, on)
  s.tokens = 320_000
  await step()
  s.tokens = 460_000
  await step()
  await step()
  expect(s.nudges).toBe(2)
})

test('a context that starts above the threshold waits for real growth', async ($, on) => {
  const { s, step, compact } = harness($, on)
  // A /compact starts a new context, measured at its next step.
  await compact('manual')
  s.tokens = 320_000
  await step()
  expect(s.nudges).toBe(0)
  expect(s.toasts.some(t => t.includes('past the'))).toBe(true)
  // 80k of work since then (over 25% of the 300k soft threshold): now it is asked.
  s.tokens = 400_000
  await step()
  expect(s.nudges).toBe(1)
})

test('thresholds follow userConfig and shrink with a small window',
  { options: { softTokens: 50_000, firmTokens: 90_000 } },
  async ($, on) => {
    const { s, step } = harness($, on, 100_000)
    // Soft = min(50k, 60% of 100k) = 50k; firm = min(90k, 80% of 100k) = 80k.
    s.tokens = 49_000
    await step()
    expect(s.nudges).toBe(0)
    s.tokens = 51_000
    await step()
    expect(s.nudges).toBe(1)
    s.tokens = 81_000
    await step()
    expect(s.nudges).toBe(2)
  })

test('the auto compaction backstop asks for the handoff template', async ($, on) => {
  const { s, compact } = harness($, on)
  await compact('auto')
  expect(s.instructions).toContain('Next step')
})

test("the seed carries the user's messages and changed files verbatim, across handoffs", async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.transcript = [
    { role: 'user', text: 'Build the parser. Never touch the lexer.<system-reminder>harness</system-reminder>', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Edit', input: { file_path: 'H:/proj/src/parse.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'ok' }] },
    { role: 'user', text: '[CONTEXT HANDOFF] 320k tokens used.', toolUses: [] },
  ]
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toContain('# Handoff')
  expect(s.seed).toContain('1. Build the parser. Never touch the lexer.')
  expect(s.seed).not.toContain('harness')
  expect(s.seed).not.toContain('320k tokens used')
  expect(s.seed).toContain('### Files edited in the previous context (recorded)\nOnly edits made with the file tools; ' +
    'files changed by shell commands are not listed.')
  expect(s.seed).toContain('- src/parse.ts')
  expect(s.submitted.at(-1)).toContain('Continue the work from the handoff above')

  // The next context: its seed, then a new instruction. The log keeps both messages.
  s.transcript = [
    { role: 'user', text: s.seed, toolUses: [] },
    { role: 'user', text: 'Also add tests.', toolUses: [] },
  ]
  s.tokens = 50_000
  await step()
  s.tokens = 400_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toContain('1. Build the parser.')
  expect(s.seed).toContain('2. Also add tests.')
})

test('a turn that ends without a handoff is asked once more, then a fork writes it', async ($, on) => {
  const { s, step, turnEnds } = harness($, on)
  s.tokens = 320_000
  await step()
  await turnEnds()
  expect(s.submitted.at(-1)).toContain('Your turn ended without a handoff')
  s.fork = HANDOFF
  await turnEnds()
  expect(s.seed).toContain('# Handoff')
  expect(s.submitted.at(-1)).toContain('Continue the work')
})

test('a fork that fails leaves the session as it was, with a notice', async ($, on) => {
  const { s, step, turnEnds } = harness($, on)
  s.tokens = 320_000
  await step()
  await turnEnds()
  await turnEnds()
  expect(s.seed).toBe('')
  expect(s.toasts.some(t => t.includes('auto-compact remains the backstop'))).toBe(true)
})

test('a message sent while the handoff is applied reaches the fresh context', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  const dropped = await $.prompt.submit({ text: 'and use tabs', origin: { kind: 'composer' } } as never)
  expect(JSON.stringify(dropped)).toContain('Handing off')
  await turnEnds()
  expect(s.seed).toContain('## The user wrote this while the handoff was being applied\n\nand use tabs')
})

test('background work still running is recorded in the seed', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.agents = [
    { id: 'b1', type: 'Explore', description: 'find the parser', status: 'running' },
    { id: 'b2', type: 'Explore', description: 'old search', status: 'completed' },
  ]
  // Shells, monitors and wakeups are known from the turn end's Stop input; its subagents,
  // from the agent list.
  on('classic.Stop', () => ({}) as never)
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await $.classic.Stop({
    transcript_path: 'C:/t/sess-1.jsonl',
    background_tasks: [
      { id: 'b1', type: 'subagent', status: 'running', description: 'find the parser', agent_type: 'Explore' },
      { id: 'b3', type: 'shell', status: 'running', description: 'Build the app', command: 'npm run\nbuild' },
      { id: 'b4', type: 'monitor', status: 'running', description: 'Watch the deploy' },
    ],
    session_crons: [{ id: 'c1', schedule: '*/20 * * * *', recurring: true, prompt: '/loop check CI' }],
  } as never)
  await turnEnds()
  const running = s.seed.split('### Background work still running')[1]!.split('###')[0]!
  expect(running).toContain('- Explore: find the parser (id b1, running)')
  expect(running).toContain('- shell: Build the app, `npm run build` (id b3, running)')
  expect(running).toContain('- monitor: Watch the deploy (id b4, running)')
  expect(running.match(/find the parser/g)?.length).toBe(1)
  expect(s.seed).toContain('### Scheduled wakeups (recorded)')
  expect(s.seed).toContain('- recurring, `*/20 * * * *` (id c1): /loop check CI')
  // A finished one is listed apart, as an earlier subagent, not as running work.
  expect(running).not.toContain('old search')
  expect(s.seed).toContain('old search (id b2, completed)')
})

test('/handoff shows the status, and /handoff now asks for a handoff', async ($, on) => {
  const { s, clock, ready, command } = harness($, on)
  expect(JSON.stringify(await command(''))).toContain('soft 300k, firm 450k')
  expect(await ready(HANDOFF)).toContain('Not requested')
  expect(JSON.stringify(await command('now'))).toContain('Asking Claude to hand off')
  await clock.advance(1_000)
  expect(s.submitted.at(-1)).toContain('The user asked for a handoff now')
  expect(await ready(HANDOFF)).toContain('Handoff accepted')
})

test("a /compact of the user's own keeps the record after the summary", async ($, on) => {
  const { s, compact } = harness($, on)
  const r = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Keep it short.', toolUses: [] }] })
  expect(r.messages?.length).toBe(2)
  expect(r.messages?.[1]?.text).toContain('1. Keep it short.')
})

test('well past the firm threshold, other tool calls are refused until the handoff', async ($, on) => {
  const { s, step, ready } = harness($, on)
  on('tool.call', () => ({ result: 'ran' }))
  const read = async () => JSON.stringify(await $.tool.call({ tool: 'Read', file_path: 'a' }))
  s.tokens = 460_000
  await step()
  expect(await read()).toContain('ran')
  s.tokens = 495_000
  expect(await read()).toContain('No more tool calls')
  // The task list can still be brought up to date before the handoff.
  for (const tool of ['TaskUpdate', 'TaskCreate', 'TaskList', 'TodoWrite', 'TaskStop']) {
    expect(JSON.stringify(await $.tool.call({ tool, input: {} } as never))).toContain('ran')
  }
  expect(await ready(HANDOFF)).toContain('Handoff accepted')
})

test('a handoff carries the skills that still apply, and always the ones the user asked for', async ($, on) => {
  const { s, step, turnEnds, command } = harness($, on)
  await $.skill.prompt({ skill: 'ideal-audit', text: 'Base directory for this skill: /s/ideal-audit\n\nAUDIT RULES' })
  await $.skill.prompt({ skill: 'pdf', text: 'Base directory for this skill: /s/pdf\n\nPDF RULES' })
  await $.skill.prompt({ skill: 'frontend-design', text: 'Base directory for this skill: /s/fd\n\nDESIGN RULES' })
  expect(JSON.stringify(await command(''))).toContain('skills loaded: ideal-audit (record); pdf (record); frontend-design (record)')
  s.transcript = [
    { role: 'user', text: 'Is the mod ideal? /ideal-audit', toolUses: [] },
    { role: 'user', text: 'Base directory for this skill: /s/ideal-audit\n\nAUDIT RULES', toolUses: [] },
  ]
  s.tokens = 320_000
  await step()
  // The model keeps frontend-design, drops pdf, and leaves out ideal-audit, which the user asked for.
  const r = await $.tool.call({ tool: TOOL, input: { handoff: HANDOFF, skills: ['frontend-design'] } })
  expect(JSON.stringify(r)).toContain('Handoff accepted')
  await turnEnds()
  expect(s.seed).toContain('AUDIT RULES')
  expect(s.seed).toContain('DESIGN RULES')
  expect(s.seed).not.toContain('PDF RULES')
  // A skill's text is not one of the user's messages.
  expect(s.seed).toContain('1. Is the mod ideal? /ideal-audit')
  expect(s.seed).not.toContain('2. Base directory')
})

test('a handoff that names no skills keeps them all, and a skill read only in the transcript counts', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.transcript = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'k', tool: 'Skill', input: { skill: 'review-changes' } }] },
    { role: 'user', text: 'Base directory for this skill: /x/review-changes\n\nREVIEW RULES', toolUses: [] },
  ]
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toContain('#### review-changes')
  expect(s.seed).toContain('REVIEW RULES')
})

test("a skill the hook missed and the rows leave out is still carried, from the model's own input", async ($, on) => {
  const { s, step, ready, turnEnds, command } = harness($, on)
  // Two skills loaded side by side before the mod was, held only where the model reads them.
  on('session.messages', ($, e) => ({
    value: e.as !== 'api' ? [] : [
      { role: 'user', content: 'Audit it.' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'Skill', input: { skill: 'ideal-audit' } },
        { type: 'tool_use', id: 'b', name: 'Skill', input: { skill: 'anthropic-skills:pdf' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'Launching skill: ideal-audit' },
        { type: 'tool_result', tool_use_id: 'b', content: 'Launching skill: anthropic-skills:pdf' },
        { type: 'text', text: '(Re-invocation of /ideal-audit — the skill instructions were previously loaded.)' },
        { type: 'text', text: 'Base directory for this skill: C:\\s\\ideal-audit\n\nAUDIT RULES' },
        { type: 'text', text: 'Base directory for this skill: /p/skills/pdf\n\nPDF RULES' },
      ] },
    ],
  } as never))
  expect(JSON.stringify(await command(''))).toContain('skills loaded: ideal-audit (model input); anthropic-skills:pdf (model input)')
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toContain('#### ideal-audit\nBase directory for this skill: C:\\s\\ideal-audit\n\nAUDIT RULES')
  expect(s.seed).toContain('#### anthropic-skills:pdf\nBase directory for this skill: /p/skills/pdf\n\nPDF RULES')
  expect(s.seed).not.toContain('Re-invocation')
})

test('a long message is kept whole in a file, and finished subagents are listed', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.agents = [{ id: 'a7', type: 'Explore', description: 'map the repo', status: 'completed' }]
  s.transcript = [{ role: 'user', text: `Spec: ${'x'.repeat(3_000)}`, toolUses: [] }]
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toContain('Every message, in full, is in .claude/handoffs/sess-1-messages.md')
  expect(s.files.get('H:/proj/.claude/handoffs/sess-1-messages.md')).toContain('x'.repeat(3_000))
  expect(s.files.get('H:/proj/.claude/handoffs/.gitignore')).toContain('*')
  expect(s.seed).toContain('map the repo (id a7, completed)')
})

test('userAsked matches a slash command or a named skill, not a stray word', async () => {
  expect(userAsked('ideal-audit', ['run /ideal-audit on it'])).toBe(true)
  expect(userAsked('anthropic-skills:pdf', ['use the pdf skill here'])).toBe(true)
  expect(userAsked('pdf', ['export it as a pdf'])).toBe(false)
  expect(userAsked('init', ['initialize the repo'])).toBe(false)
})

test('the record carries the last reply, task list, git state, reads, commands and images', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  const runs: { argv: readonly string[], stdin?: string, env?: Record<string, string> }[] = []
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env })
    if (e.argv[0] === 'git' && e.argv[1] === 'status') return { value: { exitCode: 0, stdout: '## main\n M src/a.ts\n', stderr: '' } } as never
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: 'abc123 fix parser\n', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('session.messages', () => ({
    value: [{ role: 'user', content: [{ type: 'text', text: '[Image #1] The roof looks broken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }],
  } as never))
  s.transcript = [
    { role: 'user', text: 'Fix the roof.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'r', tool: 'Read', input: { file_path: 'H:/proj/src/roof.ts' } },
      { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, isError: true },
      { tool_use_id: 't', tool: 'TodoWrite', input: { todos: [{ content: 'Fix the far roof', status: 'in_progress' }] } },
    ] },
    { role: 'assistant', text: 'The far roof needs a second pass. Shall I keep the slope?', toolUses: [] },
    { role: 'user', text: '[CONTEXT HANDOFF] 320k tokens used.', toolUses: [] },
    { role: 'assistant', text: 'Writing the handoff.', toolUses: [] },
  ]
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toContain('### What the user last read from you (recorded)\nThe far roof needs a second pass. Shall I keep the slope?')
  expect(s.seed).toContain('[in_progress] Fix the far roof')
  expect(s.seed).toContain('## main')
  expect(s.seed).toContain('abc123 fix parser')
  expect(s.seed).toContain('### Other files opened with Read in the previous context (recorded)\n- src/roof.ts')
  expect(s.seed).toContain('failed: npm test')
  expect(s.seed).toMatch(/\.claude\/handoffs\/image-[0-9a-f]{8}\.jpg\.b64 \(with "\[Image #1\] The roof looks broken"\)/)
  expect(s.seed).toContain('mcp__context-handoff__handoff_image')
  // Kept as text by the mod's own write: git is the only program it runs.
  expect(runs.every(r => r.argv[0] === 'git')).toBe(true)
  const path = /\.claude\/handoffs\/image-[0-9a-f]{8}\.jpg\.b64/.exec(s.seed)![0]
  expect(s.files.get(`H:/proj/${path}`)).toBe('AAAA')
  // The fresh context sees it through the mod's tool, as an image block.
  const shown = await $.tool.call({ tool: IMAGE_TOOL, input: { image: path } } as never) as { result?: unknown, isError?: boolean }
  expect(shown.isError).toBeUndefined()
  expect(shown.result).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }])
})

test('a large image is kept in parts and shown whole; a damaged one is refused, not sent', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } } as never))
  const big = 'iVBORw0KGgo'.repeat(500_000)
  on('session.messages', () => ({
    value: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] }],
  } as never))
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  const path = /\.claude\/handoffs\/image-[0-9a-f]{8}\.png\.b64/.exec(s.seed)![0]
  // Each part fits one file read (4 MiB at most).
  expect(s.files.get(`H:/proj/${path}`)!.length).toBeLessThan(4 * 1024 * 1024)
  expect(s.files.has(`H:/proj/${path}.2`)).toBe(true)
  const show = async (image: unknown) =>
    await $.tool.call({ tool: IMAGE_TOOL, input: { image } } as never) as { result?: unknown, isError?: boolean }
  // Asked by its name alone, or with the label the record gives it, it comes back whole.
  const whole = await show(`${path.split('/').pop()} (with "a label")`)
  expect((whole.result as { source: { data: string } }[])[0]!.source.data).toBe(big)
  // A part gone: refused, so no broken image reaches the model.
  s.files.delete(`H:/proj/${path}.2`)
  const damaged = await show(path)
  expect(damaged.isError).toBe(true)
  expect(JSON.stringify(damaged.result)).toContain('incomplete')
  // Only an image the archive holds, by its archive name: no other file can be read through it.
  expect((await show('../../secrets.txt')).isError).toBe(true)
  expect((await show('.claude/handoffs/image-00000000.png.b64')).isError).toBe(true)
})

test('imageName reads an archive image name out of a path or a record line', () => {
  expect(imageName('.claude/handoffs/image-0a1b2c3d.webp.b64')).toEqual({ name: 'image-0a1b2c3d.webp.b64', hash: '0a1b2c3d', mediaType: 'image/webp' })
  expect(imageName('- .claude/handoffs/image-0a1b2c3d.jpg.b64 (with "x")')?.mediaType).toBe('image/jpeg')
  expect(imageName('image-0a1b2c3d.png')).toBeUndefined()
  expect(imageName('src/main.ts')).toBeUndefined()
})

test('the seed reads in order: guide, skills, messages, state, earlier handoffs, last reply, handoff', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  await $.skill.prompt({ skill: 'pdf', text: 'Base directory for this skill: /s/pdf\n\nPDF RULES' })
  s.transcript = [
    { role: 'user', text: 'Make the report.', toolUses: [] },
    { role: 'assistant', text: 'Draft is ready. Use the blue theme?', toolUses: [] },
  ]
  // A first handoff, so the second one has an earlier handoff to point to.
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  s.transcript = [{ role: 'user', text: s.seed, toolUses: [] }, { role: 'user', text: 'Yes, blue.', toolUses: [] }]
  s.tokens = 50_000
  await step()
  s.tokens = 400_000
  await step()
  await ready(`${HANDOFF}\n## 8. Next step\nExport the PDF.`)
  await turnEnds()
  const at = (t: string) => s.seed.indexOf(t)
  const order = ['How to read what follows', '#### pdf', '### The user\'s messages', '1. Make the report.',
    '2. Yes, blue.', '### Earlier handoffs in this session', '## The handoff (written by the previous context)',
    'Export the PDF.']
  for (const t of order) expect(at(t)).toBeGreaterThan(-1)
  for (let i = 1; i < order.length; i++) expect(at(order[i]!)).toBeGreaterThan(at(order[i - 1]!))
  // Only the previous handoff is listed; the one being applied is the seed itself.
  expect(s.seed.split('### Earlier handoffs')[1]!.match(/\.claude\/handoffs\/[^\s]+\.md/g)?.length).toBe(1)
  // Messages already written in full are not written again.
  expect(s.files.get('H:/proj/.claude/handoffs/sess-1-messages.md')?.match(/## Message /g)?.length).toBe(2)
})

test('the user\'s words are taken where they enter: no plugin prompt, command output or notice passes for them', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  on('tool.call', () => ({ result: 'User has answered your questions: "Theme?"="Blue, and keep the logo"' }))
  on('classic.Stop', () => ({}) as never)
  await $.prompt.submit({ text: 'Build the report.', origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'Continue the work from the handoff above.', origin: { kind: 'plugin' } } as never)
  await $.prompt.submit({ text: 'Task b1 finished.', origin: { kind: 'task-notification' } } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Theme?' }] } as never)
  await $.command.run({ command: 'review', args: 'focus on auth', origin: { kind: 'composer' } } as never)
  await $.classic.Stop({ transcript_path: 'C:/t/sess-1.jsonl' } as never)
  // What the transcript holds besides: engine and plugin rows that only look like the user's.
  s.transcript = [
    { role: 'user', text: 'Build the report.', toolUses: [] },
    { role: 'user', text: '## Context Usage\n\n**Tokens:** 358.7k / 500k', toolUses: [] },
    { role: 'user', text: 'The context-handoff plugin sent a message:\nContinue the work from the handoff above.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'p', tool: 'ExitPlanMode', input: { plan: '1. Draft\n2. Export' } }] },
  ]
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  const log = s.seed.split('### The user\'s messages')[1]!.split('###')[0]!
  expect(log).toContain('1. Build the report.')
  expect(log).toContain('2. (answering your question) User has answered your questions: "Theme?"="Blue, and keep the logo"')
  expect(log).toContain('3. /review focus on auth')
  for (const t of ['Context Usage', 'plugin sent a message', 'Continue the work', 'Task b1']) expect(log).not.toContain(t)
  expect(s.seed).toContain('### The plan the user approved (recorded)\n1. Draft\n2. Export')
  expect(s.seed).toContain('C:/t/sess-1.jsonl')
  expect(s.seed).toMatch(/^This session continues earlier work from a handoff written by the previous context\. This is handoff 1 of the session, written \d{4}-\d\d-\d\d \d\d:\d\d UTC at 320k tokens\./)
})

test('without captured prompts, the transcript scan skips plugin prompts and skill re-invocation notices', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.transcript = [
    { role: 'user', text: 'Audit the mod.', toolUses: [] },
    { role: 'user', text: 'The context-handoff plugin sent a message:\n[CONTEXT HANDOFF] Your turn ended without a handoff.', toolUses: [] },
    { role: 'user', text: '(Re-invocation of /ideal-audit — the skill instructions were previously loaded.)', toolUses: [] },
  ]
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  const log = s.seed.split('### The user\'s messages')[1]!.split('###')[0]!
  expect(log).toContain('1. Audit the mod.')
  expect(log).not.toContain('2.')
})

test('ToolSearch stays open past the gate, so a deferred handoff_ready can still be loaded', async ($, on) => {
  const { s, step } = harness($, on)
  on('tool.call', () => ({ result: 'ran' }))
  s.tokens = 460_000
  await step()
  s.tokens = 495_000
  expect(JSON.stringify(await $.tool.call({ tool: 'ToolSearch', query: 'select:handoff_ready', max_results: 1 } as never))).toContain('ran')
})

test('a handoff applied by auto-compact mid-turn is applied once, and the fresh context is not asked again', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  const auto = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  expect(auto.messages?.[0]?.text).toContain('# Handoff')
  const asked = s.submitted.length
  await turnEnds()
  expect(s.compacts).toBe(0)
  expect(s.submitted.length).toBe(asked)
})

test('a pending handoff is never precomputed', async ($, on) => {
  const { s, step, ready } = harness($, on)
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  const pre = await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  expect(JSON.stringify(pre)).toContain('a handoff is pending')
})

test('a reset that keeps failing stops holding the user\'s messages and hands back what it held', async ($, on) => {
  const { s, step, ready, turnEnds, clock } = harness($, on)
  s.failCompact = true
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  expect(JSON.stringify(await $.prompt.submit({ text: 'held one', origin: { kind: 'composer' } } as never))).toContain('Handing off')
  await turnEnds()
  await clock.advance(10_000)
  expect(s.toasts.some(t => t.includes('Handoff reset failed'))).toBe(true)
  expect(s.submitted.at(-1)).toContain('held one')
  // Messages flow again; the handoff stays pending for the next turn end.
  expect(JSON.stringify(await $.prompt.submit({ text: 'next one', origin: { kind: 'composer' } } as never))).not.toContain('Handing off')
})

// A seed in the current format: the record a resumed session opens with after a restart.
const PRIOR_SEED = [
  'This session continues earlier work from a handoff written by the previous context. This is handoff 2 of the ' +
    'session, written 2026-10-06 21:59 UTC at 150k tokens. It is saved in .claude/handoffs/B.md.',
  '',
  'How to read what follows.',
  '',
  '### Skills still in use: pdf, review',
  'These were loaded in an earlier context and still apply: follow them as if just invoked.',
  '',
  '#### pdf',
  'Base directory for this skill: /s/pdf',
  '',
  '### Steps',
  '',
  '#### Example',
  'PDF RULES',
  '',
  '#### review',
  'REVIEW RULES',
  '',
  '### The user\'s messages, oldest first (recorded)',
  'Every message, in full, is in .claude/handoffs/old-messages.md.',
  '1. Build the parser.',
  '2. Also add tests.',
  '   ',
  '   Keep them fast.',
  '',
  '### Task list (recorded)',
  '- [in_progress] #1 Ship it',
  '',
  '### The whole session, word for word (recorded)',
  'Every earlier message and tool result, one JSON object per line, each handoff starting at a "compact_boundary" line:',
  '- C:/t/old.jsonl',
  'When you need a detail nothing here has, search rather than reading whole: `grep "C:/t/old.jsonl"`.',
  '',
  '### Earlier handoffs in this session, newest last (recorded)',
  'Read one when a past decision or detail matters that the handoff below leaves out.',
  '- .claude/handoffs/A.md',
  '',
  '### What the user last read from you (recorded)',
  'Shipping next.',
  '',
  '---',
  '',
  '## The handoff (written by the previous context)',
  '',
  HANDOFF,
].join('\n')

const OLD_MESSAGES = '# The user\'s messages, in full\n\n## Message 1\n\nBuild the parser.\n\n## Message 2\n\nAlso add tests.\n\nKeep them fast.'

test('after a restart the record is taken back from the seed the session resumed with', async ($, on) => {
  const { s, step, ready, turnEnds, command } = harness($, on)
  // The test's state starts empty, as a new process's does; the conversation opens with the last seed.
  s.files.set('H:/proj/.claude/handoffs/old-messages.md', OLD_MESSAGES)
  s.transcript = [
    { role: 'user', text: PRIOR_SEED, toolUses: [] },
    { role: 'user', text: 'Now ship it.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'c', tool: 'TaskCreate', input: { subject: 'Tag the release', description: 'v1' },
        result: { task: { id: '2', subject: 'Tag the release' } }, text: 'Task #2 created successfully: Tag the release' },
      { tool_use_id: 'u', tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
    ] },
  ]
  on('session.messages', ($, e) => ({ value: e.as === 'api' ? [] : s.transcript } as never))
  on('classic.Stop', () => ({}) as never)
  // The resumed session goes on in a new transcript file.
  await $.classic.Stop({ transcript_path: 'C:/t/new.jsonl' } as never)
  const status = JSON.stringify(await command(''))
  expect(status).toContain('handoffs so far: 2 (record restored from the conversation after a restart)')
  expect(status).toContain('user messages on record: 2')
  expect(status).toContain('skills loaded: pdf (record); review (record)')

  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toMatch(/This is handoff 3 of the session, written [^\n]+ It is saved in \.claude\/handoffs\/[^\s]+\.md\./)
  expect(s.seed).toContain('Every message, in full, is in .claude/handoffs/old-messages.md.\n' +
    '1. Build the parser.\n2. Also add tests.\n   \n   Keep them fast.\n3. Now ship it.')
  // The same file goes on, numbered on, with nothing written twice.
  const file = s.files.get('H:/proj/.claude/handoffs/old-messages.md')!
  expect(file.match(/## Message /g)?.length).toBe(3)
  expect(file).toContain('## Message 3\n\nNow ship it.')
  expect(s.seed).toContain('### Skills still in use: pdf, review\n')
  expect(s.seed).toContain('#### pdf\nBase directory for this skill: /s/pdf\n\n### Steps\n\n#### Example\nPDF RULES\n\n#### review\nREVIEW RULES')
  expect(s.seed).toContain('### Task list (recorded)\n- [completed] #1 Ship it\n- [pending] #2 Tag the release')
  expect(s.seed).toContain('oldest first: the session moved to a new file when it was resumed:\n- C:/t/old.jsonl\n- C:/t/new.jsonl')
  const earlier = s.seed.split('### Earlier handoffs')[1]!.split('###')[0]!
  expect(earlier).toContain('- .claude/handoffs/A.md\n- .claude/handoffs/B.md')
  expect(earlier.match(/\.md/g)?.length).toBe(2)

  // What is written reads back as it was.
  const back = parseRecord(s.seed)
  expect(back.log).toEqual(['Build the parser.', 'Also add tests.\n\nKeep them fast.', 'Now ship it.'])
  expect(back.skills).toEqual([
    { name: 'pdf', text: 'Base directory for this skill: /s/pdf\n\n### Steps\n\n#### Example\nPDF RULES' },
    { name: 'review', text: 'REVIEW RULES' },
  ])
  expect(back.handoffs).toBe(3)
  expect(back.transcripts).toEqual(['C:/t/old.jsonl', 'C:/t/new.jsonl'])
  expect(back.chain.slice(0, 2)).toEqual(['.claude/handoffs/A.md', '.claude/handoffs/B.md'])
  expect(back.chain).toHaveLength(3)
  expect(back.tasks).toEqual(['[completed] #1 Ship it', '[pending] #2 Tag the release'])
})

test('a seed in the older format is read back too', async ($, on) => {
  const { s, step, ready, turnEnds } = harness($, on)
  s.files.set('H:/proj/.claude/handoffs/old-messages.md', OLD_MESSAGES)
  s.transcript = [{
    role: 'user',
    toolUses: [],
    text: 'This session continues earlier work from a handoff written by the previous context. This is handoff 2 of ' +
      'the session, written 2026-10-06 21:59 UTC at 150k tokens.\n\nHow to read what follows.\n\n' +
      '### Skills still in use\nThese were loaded in an earlier context and still apply: follow them as if just invoked.\n\n' +
      '#### plugin-authoring\nBase directory for this skill: C:\\s\\plugin-authoring\n\n## A mod\n\n#### Not a skill\ntext\n\n' +
      '### The user\'s messages, oldest first (recorded)\n1. Build the parser.\n2. Also add tests.\n   \n   Keep them fast.\n\n' +
      '### The whole session, word for word (recorded)\nEvery earlier message and tool result is in C:/t/old.jsonl: one ' +
      'JSON object per line, each handoff starting at a "compact_boundary" line.\n\n' +
      '### Earlier handoffs in this session, newest last (recorded)\nRead one when it matters.\n- .claude/handoffs/A.md' +
      `\n\n---\n\n## The handoff (written by the previous context)\n\n${HANDOFF}`,
  }, { role: 'user', text: 'Now ship it.', toolUses: [] }]
  s.tokens = 320_000
  await step()
  await ready(HANDOFF)
  await turnEnds()
  expect(s.seed).toContain('This is handoff 3 of the session')
  expect(s.seed).toContain('1. Build the parser.\n2. Also add tests.\n   \n   Keep them fast.\n3. Now ship it.')
  expect(s.seed).toContain('#### plugin-authoring\nBase directory for this skill: C:\\s\\plugin-authoring\n\n## A mod\n\n#### Not a skill\ntext')
  // That record named no messages file; its transcript's session id finds the one it kept.
  expect(s.seed).toContain('Every message, in full, is in .claude/handoffs/old-messages.md.')
  expect(s.files.get('H:/proj/.claude/handoffs/old-messages.md')).toContain('## Message 3\n\nNow ship it.')
  expect(s.seed).toContain('- C:/t/old.jsonl')
  expect(s.seed.split('### Earlier handoffs')[1]).toContain('- .claude/handoffs/A.md')
})

test('the task list follows TaskCreate and TaskUpdate by id, and TodoWrite whole', () => {
  const use = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ tool_use_id: tool, tool, input, ...extra })
  const tasks = taskList([{ role: 'assistant', text: '', toolUses: [
    use('TaskCreate', { subject: 'Write\nthe parser' }, { text: 'Task #7 created successfully: Write the parser' }),
    use('TaskCreate', { subject: 'Scrap it' }, { result: { task: { id: '8' } } }),
    use('TaskUpdate', { taskId: '7', status: 'in_progress' }),
    use('TaskUpdate', { taskId: '8', status: 'deleted' }),
    use('TaskUpdate', { taskId: '9', status: 'completed' }),
    use('TodoWrite', { todos: [{ content: 'Old list', status: 'pending' }] }),
    use('TodoWrite', { todos: [{ content: 'New list', status: 'completed' }, { content: 'Next step', status: 'pending' }] }),
  ] }] as never, ['[pending] Carried todo', '[pending] #3 Carried task'])
  expect(tasks).toEqual(['[completed] New list', '[pending] Next step', '[pending] #3 Carried task', '[in_progress] #7 Write the parser'])
})

test('a list whose every item is completed is cleared, as Claude Code clears it', () => {
  const use = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ tool_use_id: tool, tool, input, ...extra })
  const turn = (...toolUses: unknown[]) => [{ role: 'assistant', text: '', toolUses }] as never
  // Finished when the last record was written: nothing carries on.
  expect(taskList([], ['[completed] #1 Ship it', '[completed] #2 Tag it', '[completed] Old todo'])).toEqual([])
  // Finished, then new work: only the new work.
  expect(taskList(turn(
    use('TaskUpdate', { taskId: '1', status: 'completed' }),
    use('TaskCreate', { subject: 'Next' }, { result: { task: { id: '2' } } }),
  ), ['[in_progress] #1 Ship it'])).toEqual(['[pending] #2 Next'])
  // The last open task deleted, the rest done.
  expect(taskList(turn(use('TaskUpdate', { taskId: '2', status: 'deleted' })),
    ['[completed] #1 Ship it', '[pending] #2 Scrap it'])).toEqual([])
  // A TodoWrite list all done; one task still open keeps its finished neighbours.
  expect(taskList(turn(use('TodoWrite', { todos: [{ content: 'A', status: 'completed' }] })),
    ['[completed] #4 Done', '[pending] #5 Open'])).toEqual(['[completed] #4 Done', '[pending] #5 Open'])
})
