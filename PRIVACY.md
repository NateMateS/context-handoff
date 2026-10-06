# Privacy policy

context-handoff is a Claude Code plugin that runs entirely on your own machine. Its developer runs no service and receives none of your data: the plugin has no telemetry, no accounts and no network requests of its own.

## What it reads

- **This session's conversation**, through Claude Code: your messages, the images you paste, Claude's replies, and the tool calls the session makes. It needs these to carry your words, task list, files touched and commands run into the fresh context after a handoff.
- **Git state** of your project, from `git status --short --branch` and `git log --oneline -5`.
- **Its own archive** in `.claude/handoffs/`, described below.

It doesn't look for personal data in any of this. Whatever your messages contain, such as a name or an email address, is handled the same way as the rest of them.

## What it stores, and where

Everything stays in `.claude/handoffs/` inside your project:

- each handoff Claude writes;
- every message you sent in the session, in full;
- the images you pasted, as base64 text;
- a `.gitignore` that keeps this folder out of your commits.

While a session runs, Claude Code also holds the plugin's working state, such as your recent messages and the skills in use, in memory. That state ends with the session.

## How it's used

Only to rebuild the conversation after a handoff: the record goes back into the same Claude Code session. That session sends it to Claude the same way it sends the rest of your conversation, under the terms you already use Claude Code with. The plugin sends nothing anywhere else, and nothing to its developer.

## How long it's kept

The archive stays until you delete it. The plugin never deletes, expires or uploads it. To remove everything, delete `.claude/handoffs/`; `/clear` starts the record over for new work.

## Children

The plugin isn't intended for people under 18.

## Contact

Questions and problems: [GitHub Issues](https://github.com/NateMateS/context-handoff/issues). Security concerns: see [SECURITY.md](SECURITY.md).

Changes to this policy are made in this file, and its history is in the repository.
