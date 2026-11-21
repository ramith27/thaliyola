---
description: Declare an incident in this project through Thaliyola, or add to the open one
argument-hint: <what's broken> [sev1|sev2|sev3|sev4]
---
An incident through Thaliyola: $ARGUMENTS

1. Find this repository's project (get_project_context with the git remote) and list_incidents for it with status open.
2. If an open incident already covers this, don't declare another: add_incident_note to it with what's in my message and what you know, and tell me its title.
3. Otherwise declare_incident in that project with a short title from my message, the severity if I gave one (else sev3), and a summary of what we know so far (symptoms, since when, what's affected). Never secrets or customer data.
4. Tell me in two lines who was told and how to add to it (add_incident_note), then carry on with what I asked.
