# context-handoff

**Claude Code sessions that don't run out of room.** When the context gets large, Claude finishes what it's doing, writes a handoff, and the session restarts on that handoff and keeps working. There's no `/clear` to type and nothing to paste, and your instructions reach the fresh context word for word.

## Why it works

- **It stops at a natural point.** Claude is asked to bring the work in progress to a clean, resumable state and start nothing new. Nothing is cut off mid-edit.
- **The model that did the work writes the handoff.** The goal, status, decisions, verification, gotchas and next step come from the one context that actually knows them, written for a reader with none of its memory.
- **What code can record, code records.** Your messages, the skills in use, the plan you approved, the task list, git state, files touched, commands run, pasted images, background work and scheduled wakeups are captured by the mod and carried over exactly. None of it depends on what a model remembers.
- **Your words always win.** Every message you sent this session is carried over verbatim, across every handoff. Plugin prompts, command output and notifications are kept out of that record. The fresh context is told that where anything disagrees with your words, they win.
- **It always happens.** If Claude doesn't hand off, the mod asks again, then a fork of the session writes the handoff, and finally other tool calls are refused. The window can't quietly fill up while it waits.
- **It's fast and hands-free.** Swapping the conversation for the handoff takes no model call, only about a tenth of a second. Work then resumes from the handoff's next step on its own.
- **Nothing is lost.** Every handoff is archived in your project, and your messages are kept there in full. The fresh context also gets the path of the session's full transcript and a search command, for any detail the handoff left out.
- **It survives restarts.** The record travels inside the handoff itself, so a session that was resumed after a restart or an update picks it up again.

## Measured

These numbers come from a real session on Claude Code 2.1.291. Both times, after the swap, work carried on without the user typing anything.

| Handoff | Conversation before | Conversation after | Swap |
|---|---|---|---|
| Written by a fork of the session | 462,807 tokens | 4,767 tokens | 133 ms |
| Written by the model, carrying a skill | 150,509 tokens | 7,290 tokens | 115 ms |

## How it works

1. **Soft notice.** Once the context passes the soft threshold (300k by default), Claude is asked to reach a natural stopping point and start nothing new.
2. **Handoff.** Claude calls `handoff_ready` with the handoff and the names of the skills that still apply. A handoff that is too short is refused, and so is calling the tool without having been asked.
3. **Reset and resume.** When the turn ends, the conversation is replaced by the handoff plus the mod's record, and work continues from the next step. If the next step is to wait for you, the fresh context says where things stand and waits.
4. **If Claude doesn't hand off:**
   - **Its turn ends without a handoff.** The end of a turn is itself a natural stopping point, so it is asked again.
   - **That turn ends without one too.** A fork of the session writes the handoff from the same context. The fork has no tools and reads the conversation from the prompt cache.
   - **It keeps working past the firm threshold** (450k by default). It is told to stop and hand off now.
   - **It goes 40k past the firm threshold.** Every other tool call is refused. It can still load the handoff tool, bring its task list up to date and ask you a question.
5. **Backstop.** If the window still fills, Claude Code's own auto-compact runs, so the session can't overflow. The mod asks for that summary in the handoff format and adds its record after it.

## What the fresh context gets

One message. It opens with which handoff this is, when it was written, at what context size and where it is archived. Then it explains how to read what follows:

- **Your messages win.** They are your exact words, and anything that disagrees with them loses.
- **Recorded sections are exact.** They were captured by code, as of the handoff.
- **The handoff can be wrong.** It is the previous context's understanding, so the fresh context checks anything marked unverified.
- **No recap.** The fresh context doesn't summarize the handoff back to you or announce it.

After that come two halves, and nothing appears in both. The model's handoff comes last, so its next step is the last thing read before work resumes.

**Written by the model.** These are the sections only something that understood the work can write:

1. **Goal.** What counts as done, plus your standing instructions, preferences and what you approved or ruled out.
2. **Status.** Each task, and exactly where the one in progress stands.
3. **Decisions.** What was decided and why, including approaches that were rejected.
4. **Outputs.** What each change does differently, and any commits, PRs or links produced.
5. **Verification.** What is proven, with the exact build and test commands and their last result.
6. **Open questions.** Anything unresolved, waiting on you, or assumed but not checked.
7. **Gotchas.** Anything the next context would otherwise rediscover the hard way.
8. **Next step.** Answering your latest message comes first if it wasn't fully answered. If the work needs you, the step is to wait for you.

The previous context writes for a reader with none of its memory. When it began from a handoff itself, it carries forward every decision, gotcha and open question that still holds, so knowledge doesn't wear away along a chain of handoffs.

**Recorded by the mod,** word for word, in reading order:

| Section | What it holds |
|---|---|
| Skills still in use | The full text of each skill that still applies. Claude names the ones that still apply, and skills you asked for (`/name`, or by name as a skill) are always kept. If Claude names none, all are kept. Skills loaded before the mod was are found too, in the text the model reads. Up to 40,000 characters; any past that are listed by name, to be loaded again. |
| Your messages | Every message you sent this session, oldest first, across every handoff. They are captured as you send them, labelled by where they came from, so plugin prompts, command output, notifications and skill text can't pass for your words. Your answers to Claude's questions count, and so do slash commands with arguments. Your first message always stays; the rest are kept newest first, up to 12,000 characters, with a count of any left out. A message over 2,000 characters is cut, and every message is kept in full in `.claude/handoffs/<session>-messages.md`. |
| Approved plan | The last plan you approved, word for word: an agreement, not a summary. |
| Task list | The task list as Claude last left it, from `TodoWrite` or from `TaskCreate` and `TaskUpdate`, carried forward across handoffs. Once every item on a list is done, the list is cleared, the same way Claude Code clears it. Up to 30 items; past that, the oldest finished ones are left out. |
| Git state | Branch, uncommitted changes and the last five commits. |
| Files edited, files read | Paths only, from the file tools. Files changed by shell commands aren't tracked, and the record says so. Contents aren't loaded, and the fresh context is told to read a file again before editing it. |
| Last commands | The last 12 shell commands and whether each one failed. |
| Images you pasted | Pasted images exist only inside the transcript, so each one (up to six) is kept in the archive and listed with the words you sent it with. The fresh context looks at one through the mod's `handoff_image` tool when it needs to, and an image costs no tokens until then. An image you gave by path is already in your message. |
| Background work | Subagents, background shells, monitors and workflows still running, with the IDs that let `TaskStop` stop them, plus earlier subagents with the IDs that let `SendMessage` continue them. |
| Scheduled wakeups | Prompts that `/loop`, `ScheduleWakeup` or `CronCreate` will send to the session later, so the fresh context knows what will wake it and why. |
| The whole session | Every transcript file the session has written. A resumed session continues in a new one, and compaction never deletes them. Together they hold every earlier message and tool result, and a search command finds any detail without reading them whole. |
| Earlier handoffs | The session's last few handoffs, to look back at when a detail matters that the latest one leaves out. |
| What you last read | Claude's last reply before the handoff began, so a question it asked you isn't lost. |

The record usually adds a few thousand tokens. At most it adds about 20,000, nearly all of that from long skills.

Your own `/compact` and auto-compact get the same record after Claude Code's summary, minus the skills, which Claude Code already carries across its own compactions.

<details>
<summary>What a fresh context reads (shortened)</summary>

````text
This session continues earlier work from a handoff written by the previous context. This is
handoff 2 of the session, written 2026-10-06 21:59 UTC at 312k tokens. It is saved in
.claude/handoffs/2026-10-06T21-59-30-836Z.md.

You are the same assistant, continuing the same work for the same user; the previous
context handed off because its window was filling up. How to read what follows:
- The user's messages are their exact words. Where anything else here disagrees with them,
  they win.
…

### Skills still in use: pdf
These were loaded in an earlier context and still apply: follow them as if just invoked.

#### pdf
Base directory for this skill: …

### The user's messages, oldest first (recorded)
Every message, in full, is in .claude/handoffs/5f0c2a91-messages.md.
1. Add PDF export to the invoices page. Never change the CSV format; other tools read it.
2. (answering your question) User has answered your questions: "Paper size?"="A4"
3. Use the blue theme, and keep the logo.

### Task list (recorded)
- [completed] #1 Render invoices to PDF
- [in_progress] #2 Add the export button
- [pending] #3 Test with 500-line invoices

### Git state (recorded)
```
## feature/pdf-export
 M src/export/pdf.ts
 M src/pages/Invoices.tsx
…
```

### Last commands run, newest last (recorded)
- ok: npm test -- export
- failed: npm run e2e -- invoices

### What the user last read from you (recorded)
The PDF renders. Should the export button sit next to CSV, or in the menu?

---

## The handoff (written by the previous context)

# Handoff: PDF export for invoices
## 1. Goal
…
## 8. Next step
Wait for the user: where the export button goes. Then fix the e2e failure (a timeout in
the invoices fixture) and run task #3.
````

</details>

## Details

- **Loop guard.** A fresh context has to grow at least 40k tokens past its own starting size before it can be asked to hand off again, or a quarter of the soft threshold if that's more. A handoff that starts above the threshold can't chain into endless handoffs.
- **Nothing you type is lost.** A message sent while a handoff is being applied is held and passed on to the fresh context.
- **Restarts.** If Claude Code restarts, for example after an update, the mod restores its record from the last handoff in the resumed conversation. That covers your messages, the skills, the task list, the handoff count and chain, and the transcript files. `/handoff` says when this happened.
- **Status line.** While a handoff is pending, the status line shows `handoff: at next stopping point`, `handoff: now`, `handoff: requested` or `handoff: applying`.
- **Archive.** Every handoff is saved in `.claude/handoffs/` in your project, along with your messages in full and your pasted images. The archive can hold private text, so the mod gives that folder its own `.gitignore` to keep it out of your commits. Delete that `.gitignore` to commit the archive anyway.
- **Subagents** are never asked to hand off, and their compactions are left alone.
- **Fails safe.** If a handoff can't be applied, the mod stops holding your messages and hands back any it held. The handoff stays pending: the next turn end tries again, and `/compact` applies it at once.
- **`/clear`** starts new work, so the record starts over.
- **One compaction mod at a time.** Another plugin that also takes over compaction will conflict with this one, so run only one of them.

## What a handoff doesn't reload

Two things are restored another way:

- **File contents read earlier.** A handoff gives their paths, not their contents. Claude Code only lets the model edit a file it has read in the current conversation, so it reads the file again first. That costs some tokens; nothing is lost.
- **Deferred tools that were loaded** (such as WebSearch) have to be loaded again. Claude Code lists them again on the next turn, along with the subagent types, MCP server instructions, environment and model.

## What it does on your machine

The mod makes no network requests of its own and sends nothing anywhere else. Everything it adds to the conversation goes to Claude in this same session, the way the rest of the conversation does. [PRIVACY.md](PRIVACY.md) is the full privacy policy.

**Files it writes.** All of them go in `.claude/handoffs/` in your project:

- `<date and time>.md`: each handoff, as Claude wrote it.
- `<session id>-messages.md`: every message you sent in the session, in full.
- `image-<hash>.png.b64` (or `.jpg`, `.gif`, `.webp`): each image you pasted, as base64 text, named by a hash of its contents. A large one is split into parts (`.b64.2`, ...) that each fit one of the mod's file reads.
- `.gitignore`, written once and containing `*`: it keeps the archive out of your commits. It is the only file the mod writes that another tool acts on. Delete it if you want to commit the archive.

It reads back only that archive and the session's own conversation.

**Programs it runs.** `git status --short --branch` and `git log --oneline -5` in your project, for the git state in the record. Both only read. It runs no other program.

**Commands it runs.** `/compact`, once per handoff, to swap the conversation for the handoff. The mod's own hook answers that compaction, so Claude Code doesn't summarize anything.

**What it adds to the conversation.**

- The handoff notices, once the context passes a threshold. Each says how many tokens are in use and asks for a handoff.
- If a turn ends without a handoff, a prompt asking for one again; `/handoff now` sends the same request.
- After the swap, a prompt to continue from the handoff's next step.
- Any message you typed while the handoff was being applied, word for word.
- An image you pasted earlier, when Claude asks for it through `handoff_image`.
- A short section of the system prompt describing what a handoff must contain.

**Model requests.** If Claude still hasn't handed off after being asked twice, one fork of the session writes the handoff. It's a single request on the session's own connection, with no tools.

**Tools.** The mod adds two tools and answers both itself. `handoff_ready` takes the handoff. `handoff_image` shows Claude an image you pasted before a handoff: it reads only images the archive holds, by name, and refuses one whose contents no longer match that name. Once the context is 40k tokens past the firm threshold, it refuses other tool calls with a message asking for the handoff. `ToolSearch`, `AskUserQuestion` and the task tools still run. It never answers in place of any other tool, and never changes a permission decision or a setting.

**What its hooks change.**

| Hook | What it does |
|---|---|
| `prompt.compose` | Adds the handoff section to the system prompt. |
| `skill.prompt` | Records each skill's text as it loads, so a handoff can carry it. Passes the skill on unchanged. |
| `command.run` | Answers `/handoff`, and records slash commands you type with arguments. Passes every other command on unchanged. |
| `prompt.submit` | Records your messages. While a handoff is being applied, holds what you type and sends it to the fresh context. |
| `tool.call` | Answers `handoff_ready` and `handoff_image`, records your answers to Claude's questions, and refuses tool calls as described above. |
| `turn.step`, `turn.complete` | Measure the context and add the notices. At the end of a turn, they ask again, start the fork, or apply the handoff. |
| `session.compact` | During a handoff, replaces the conversation with the handoff and the record. After any other compaction, adds the record after Claude Code's summary. |
| `session.start`, `session.end`, `classic.Stop` | Register `handoff_ready`, `handoff_image` and `/handoff`, clear the record on `/clear`, and note the transcript file, background work and wakeups. |

## Install

Requires Claude Code with mods (function-hook plugins). Tested on 2.1.291 and 2.1.292. In a terminal session:

```
/plugin install context-handoff --marketplace NateMateS/context-handoff
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session). It's listed as `context-handoff@natemates`. Then set the two thresholds, or keep the defaults.

## Use

There's nothing to do. To check on it or hand off early:

| Command | What it does |
|---|---|
| `/handoff` | Shows the context size, both thresholds, the stage, how many handoffs and messages are on record, and each loaded skill with where it was found |
| `/handoff now` | Asks Claude to hand off at once |

```
context 312k of 1000k; soft 300k, firm 450k
stage: soft
this context started at 9k; it can be asked from 300k
handoffs so far: 1
user messages on record: 3, and 1 since the last handoff
skills loaded: pdf (record, model input)
```

## Examples

1. **A long task that keeps going.** Ask for work bigger than one context, such as *"Move every component in `src/components` to the new design tokens, run the tests after each one, and keep going until they all pass."* When the context passes the soft threshold, the status line shows `handoff: at next stopping point`. Claude finishes the component it's on, hands off, and carries on with the next one in a fresh context.
2. **A handoff on demand.** Mid-task, run `/handoff now`. Claude brings the work to a resumable state and writes the handoff, and the session continues from its next step. `/handoff` then shows one more handoff on record.
3. **Your words, carried over exactly.** Early on, give a rule such as *"Never change the CSV format; other tools read it."* and paste a screenshot. Run `/handoff now`, then ask the fresh context *"What did I say about the CSV format, and what did my screenshot show?"* It quotes your message word for word from the record and opens the screenshot through `handoff_image`.

## Configure

Both thresholds are rows in `/config` under context-handoff, stored in `~/.claude/settings.json` under `pluginConfigs`.

| Setting | Default | What it does |
|---|---|---|
| `softTokens` | `300000` | When Claude is asked to wrap up at its next natural stopping point. Capped at 60% of the context window. |
| `firmTokens` | `450000` | When it is told to stop starting work and hand off now. Capped at 80% of the window. |

With those caps, a model with a 200k window hands off at about 120k (soft) and 160k (firm) without any configuration. To watch a handoff without filling 300k, run `/handoff now`.

## Troubleshooting

- **No handoff is asked for.** Run `/handoff` to see the context size and both thresholds. A fresh context has to grow 40k tokens past its starting size, or a quarter of the soft threshold if that's more, before it's asked again. Lower the thresholds in `/config`, or run `/handoff now`.
- **The mod doesn't seem to run.** `claude plugin list` should show `context-handoff@natemates` as enabled, and the **Errors** tab in `/plugin` lists anything that failed to load. It needs a Claude Code version with mods. After an update, run `/reload-plugins`.
- **The status line stays on `handoff: applying`.** The swap is tried again when the next turn ends, and `/compact` applies it at once. Anything you typed meanwhile is passed on.
- **An image won't open.** `handoff_image` refuses an image whose file was deleted or changed since it was saved, so a damaged image never reaches Claude.
- **Something else.** Start Claude Code with `claude --debug`: each failed hook is logged as a line starting `context-handoff:`. Report it in [Issues](https://github.com/NateMateS/context-handoff/issues), or a security problem as [SECURITY.md](SECURITY.md) describes.

## Develop

To run it from a clone, add the clone as a marketplace and install from it:

```sh
claude plugin marketplace add <path to your clone>
claude plugin install context-handoff@natemates
```

Claude Code then runs the clone itself, so `/reload-plugins` picks up your edits with no reinstall. To check them:

```sh
claude plugin validate .
claude plugin test .
```

The tests cover:

- the soft and firm notices, the loop guard and configured thresholds;
- asking again, the fork fallback, the tool gate (and the task bookkeeping it lets through) and the auto-compact backstop;
- the verbatim record across two handoffs, and the seed's reading order;
- capturing your words where they enter, and keeping plugin prompts, command output and notices out;
- carrying skills that were kept, dropped or asked for, including ones only the model's input holds;
- the last reply, task list (from `TodoWrite` and from `TaskCreate`/`TaskUpdate`, cleared once all of it is done), git state, files and commands;
- images kept in parts and shown whole through `handoff_image`, with a damaged image or an unknown name refused;
- earlier handoffs, full text of long messages written once, earlier subagents, background work and scheduled wakeups;
- held messages and a reset that keeps failing;
- restoring the record after a restart, from both the current and the older seed format;
- `/handoff`.

## License

MIT
