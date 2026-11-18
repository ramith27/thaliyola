---
description: Hand this session's unfinished work to another session or teammate through Thaliyola
argument-hint: <who> [notes]
---
Hand this session's work over through Thaliyola: $ARGUMENTS

The first word is who takes it: a session handle (like ramith/leadtransit-api), a person's email, or a project or project/repository. If it isn't clear, call list_sessions and pick the best match, saying which.

Write the handoff from what happened in this session: what you were doing and where it stands (done, half-done, broken), the decisions made and why, what's left as numbered next steps, and the files involved (repository-relative paths). Add anything from my notes after the first word. Never include secrets.

Call handoff_session with session set to this session's Thaliyola handle, that `to`, the summary, next_steps and files. Then tell me in two lines who it went to and that their acceptance (and your file claims moving to them) will show up on my next prompt.
