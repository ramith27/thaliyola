---
description: Ask another Claude session (yours or a teammate's) a question through Thaliyola
argument-hint: [everyone | expert <topic>] <who> <question>
---
Ask another session through Thaliyola: $ARGUMENTS

If the first word is "expert", the next words up to the question name a topic (a service, table, tag or project): ask_session with to "expert:<topic>" goes to the people who know it best (their online sessions first, else the top person); say who it went to.
If the first word is "everyone", ask every online session at the target (pass everyone: true) and report each answer with who gave it; then the next word is the target.
The first word (after "everyone") is who to ask: a session handle (like ramith/leadtransit-api), a person's email, or a project or project/repository. If it isn't clear, call list_sessions and pick the best match, saying which.
Call ask_session with session set to this session's Thaliyola handle, that `to`, the question, and the context the other session needs (what you know and have tried; never secrets). It waits up to 45 seconds. If the answer isn't ready, say so; it will be handed to you when it arrives, or check with get_answer.
