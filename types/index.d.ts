export type Stage = 'none' | 'soft' | 'firm'

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': {
      stage: Stage
      // The accepted handoff text, held until the conversation is replaced by it.
      handoff: string
      // Context tokens when this context began (-1: measure at the next step). The
      // notices wait for real growth past it, so a seed that already sits above a
      // threshold cannot hand off again and again.
      baseline: number
      // Whether this context was asked again at the end of a turn that ended
      // without a handoff. A second such turn end gets a handoff written by a fork.
      reasked: boolean
      // The user's own messages, verbatim and oldest first, carried across every
      // handoff of the session so no instruction depends on a model's paraphrase.
      userLog: string[]
      // What arrived while a handoff was being applied, sent on to the fresh context.
      held: string
      // Every skill loaded in this session and still in play, with the text the model
      // read for it, so a handoff can carry the ones that still apply.
      skills: { name: string, text: string }[]
      // The skills the accepted handoff keeps, by name; ['*'] keeps every one.
      keepSkills: string[]
      // This session's archived handoffs, newest last, so a fresh context can look back.
      chain: string[]
      // Digests of the user's messages already written in full to the session's message file.
      archived: string[]
      // The user's own words captured since the last handoff: prompts as submitted, answers
      // to the model's questions, slash commands with arguments.
      userNew: string[]
      // Whether a prompt has been captured at the source in this session.
      capturing: boolean
      // Whether the messages sent before the mod loaded were taken from the transcript.
      prefixed: boolean
      // The session's transcript files, oldest first: a resumed session goes on in a new one.
      transcripts: string[]
      // Background work in flight when the last turn ended, other than subagents (which the
      // agent list names): shells, monitors, workflows. One line each, with its task id.
      inFlight: { id: string, line: string }[]
      // The session's scheduled wakeups when the last turn ended (CronCreate, ScheduleWakeup, /loop).
      wakeups: string[]
      // The file holding every one of the user's messages in full, relative to the project.
      messagesFile: string
      // Where the accepted handoff was archived; '' when the archive could not be written.
      saved: string
      // Whether the record was taken back from the conversation after a restart emptied it.
      restored: boolean
      // How many handoffs this session has had.
      handoffs: number
      // When the current application of a handoff began (epoch ms); 0 when none is under way.
      applying: number
      // Since when the user's messages are held for the fresh context (epoch ms); 0 when not.
      holding: number
    }
  }
}
