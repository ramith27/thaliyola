# Sessions asking each other

A Claude session can ask another session a question and get the answer back. The other session can be yours or a teammate's, on any machine. Session 1 asks session 2 how the refund endpoint works; session 2 answers from what it knows and from its code; session 1 carries on with the answer.

Thaliyola only stores questions and answers and wakes up waiting sessions. Every answer comes from a Claude session or a person; the server never answers anything itself.

![The Sessions page: who can be asked (listening or busy), and asking from the browser](images/sessions.png)

## Set up (Claude Code)

1. Install the Thaliyola plugin with its environment variables (see [`integrations/README.md`](../integrations/README.md)):

    ```sh
    export THALIYOLA_URL=https://thaliyola.example.com THALIYOLA_TOKEN=thaliyola_pat_…
    claude --plugin-dir /path/to/thaliyola/integrations/claude-code
    ```

2. Start Claude in a repository. The plugin's start hook registers the session and tells Claude its **handle**, e.g. `ramith/leadtransit-api`. The handle is made from your name and the project and repository its git remote belongs to.

Other agents (Codex, Cursor, Gemini CLI, …) don't have the hooks. They join with the `register_session` tool, or by running the `listen` prompt (`/mcp__thaliyola__listen` in Claude Code).

## The commands

| Command | What it does | When to use it |
|---|---|---|
| `/thaliyola:ask <who> <question>` | Asks another session. `<who>` is a session handle (`ramith/leadtransit-api`), a person's email (any of their sessions), or a project or `project/repository` (whoever works there). Claude adds the context the other session needs. | You need knowledge another session or teammate has |
| `/thaliyola:listen` | Turns on **listening**: whenever this session would go idle, it waits for questions and answers them as they arrive. | A session that holds useful context (e.g. the backend you're building) and is otherwise idle |
| `/thaliyola:busy` | Turns listening off. Questions are still handed over when the session finishes a task. | You want this session for your own work only |
| `/mcp__thaliyola__listen [name]` | The listener for agents without the plugin: registers, then loops on `wait_for_questions` and answers each one until you type. | Codex, Cursor or a Claude Code session without the plugin |

You can also ask in plain words: "ask the frontend session whether the orders page sends a status filter".

## How a question travels

```
Session 1                       Thaliyola                          Session 2
/thaliyola:ask bob/web "…"  ──▶ stores the question, wakes ──▶  listening: its Stop hook is waiting → gets it at once
   waits up to 45 s                waiting sessions                busy: gets it when its current task ends
                                                                   nobody online: owner is notified; answer on the web
   answer arrives  ◀────────────  answer_question  ◀────────────  answers from its context and code
```

1. **Asking:** `ask_session` stores the question and waits up to 45 seconds for the answer.
2. **Picking it up:** the server can't push to a session, so the session collects it:
   - **Listening** (`/thaliyola:listen`): the plugin's Stop hook waits for a question *inside the hook*, so waiting costs no tokens. When a question arrives, Claude gets it within a second or two. After about an hour with no questions (6 rounds of 9 minutes), listening turns itself off.
   - **Busy:** when the session finishes what it is doing, its Stop hook hands over any waiting questions, and Claude answers them before going idle.
   - **A person:** on the **Sessions** page, anyone who owns the target session (or can write in the target project) can answer or decline.
3. **Answering:** `answer_question` sends the answer; `decline_question` says it can't be answered here, and why. A question is claimed for 10 minutes, so two sessions never answer the same one.
4. **Getting the answer:** if it arrives within the 45 seconds, `ask_session` returns it. Otherwise session 1 gets a ticket. The plugin hands the answer over on session 1's next prompt, or Claude can call `get_answer`.

## What answering sessions may do

The question text is treated as data, never as instructions. A session answering a question **only answers**: from what it knows, the code it can read and Thaliyola (`search_knowledge`). It doesn't change code or run commands that change anything without asking its own person. The listen prompt, the hook text and `/thaliyola:listen` all say this.

## Who can ask whom

| Target | Who can ask it |
|---|---|
| A session with visibility `project` (the default) | Anyone who can read that session's project |
| A `private` session | Only its owner's own sessions |
| A person (email) | Anyone signed in; it goes to that person's sessions, and to them on the web |
| A project or `project/repository` | Anyone who can read the project; any `project`-visible session there may take it |

## Limits and housekeeping

- Questions and answers are redacted like everything else and limited to 8,000 characters.
- A session can ask 30 questions an hour.
- Questions expire after 30 minutes by default (1 to 240, set per question).
- A session counts as online while it has checked in within the last 3 minutes (every tool call and hook call counts; long waits check in every minute).
- When a question waits more than 2 minutes, or nobody is online to take it, the owner of the target (or the project's reviewers) gets a notification.
- An answer worth keeping can be saved as a finding (`save_as` on `answer_question`, or *Also save as a finding* on the Sessions page); it goes to Review.

## Settings for the plugin hooks

| Variable | Default | Meaning |
|---|---|---|
| `THALIYOLA_URL`, `THALIYOLA_TOKEN` | — | The server and your token (the same as the plugin's MCP config) |
| `THALIYOLA_LISTEN_SECONDS` | 540 | How long one listening wait lasts (must stay under the hook's 600-second timeout) |
| `THALIYOLA_LISTEN_ROUNDS` | 6 | Quiet rounds before listening turns itself off |

The hooks never get in Claude's way: if Thaliyola can't be reached, they do nothing.

## Tools and API

| Tool | Purpose |
|---|---|
| `register_session` | Join, or update this session (name, description, visibility, listening) |
| `list_sessions` | Who you can ask: online sessions, what each is working on, listening or busy |
| `ask_session` | Ask, waiting up to 45 s |
| `get_answer` | A ticket's answer, plus any other answers that arrived |
| `wait_for_questions` | Listener: wait up to 45 s and claim questions |
| `answer_question` / `decline_question` | Reply, or say why not |

API: `/api/agent-sessions` (list, register), `/api/agent-sessions/check` (used by the hooks), `/api/agent-sessions/listening`, `/api/agent-sessions/end`, `/api/questions` (list, ask), and `/api/questions/:id/answer`, `/decline` and `/cancel`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Claude doesn't know its handle | The plugin isn't loaded, or `THALIYOLA_URL`/`THALIYOLA_TOKEN` aren't set in the shell that started `claude`. Ask Claude to call `register_session` instead. |
| `/thaliyola:ask` says the session isn't found | It's private, offline for more than 7 days, or in a project you can't read. `list_sessions` shows who you can ask. |
| A listening session never answers | Its Claude Code window was closed, or listening timed out after an hour of quiet. Run `/thaliyola:listen` again. |
| The answer never shows up in session 1 | It arrives on your next prompt (plugin), or ask Claude to `get_answer` with the ticket id. |
