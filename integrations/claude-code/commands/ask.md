---
description: Ask another Claude session (yours or a teammate's) a question through Thaliyola
argument-hint: <who> <question>
---
Ask another session through Thaliyola: $ARGUMENTS

The first word is who to ask: a session handle (like ramith/leadtransit-api), a person's email, or a project or project/repository. If it isn't clear, call list_sessions and pick the best match, saying which.
Call ask_session with session set to this session's Thaliyola handle, that `to`, the question, and the context the other session needs (what you know and have tried; never secrets). It waits up to 45 seconds. If the answer isn't ready, say so; it will be handed to you when it arrives, or check with get_answer.
