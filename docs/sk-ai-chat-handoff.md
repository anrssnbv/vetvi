# Vetvi → SK AI Chat handoff

The owner requests one persistent chat per task, including one separate chat for every subtask, grouped under the task's owning project. SK AI Chat projects and the receiving handler are being implemented independently. This delivery configures the Vetvi sender only.

## URL contract

Both the embedded iframe and the standalone link open the same same-origin URL:

```text
/chat/#vetvi_project_id=<project ID>&vetvi_project_name=<project title>&vetvi_task_id=<task ID>&vetvi_task_name=<task title>
```

Encode/decode fields with `URLSearchParams`. Cyrillic, spaces, `&`, `+`, `#` and other punctuation must round-trip. Fragment fields are not sent in the initial HTTP request or access logs. They remain visible to the browser and its history; they are not secrets or authorization tokens.

| Field | Meaning |
| --- | --- |
| `vetvi_project_id` | Stable ID of the selected task's owning project, independent of the current sidebar/filter selection. |
| `vetvi_project_name` | Current project display title. |
| `vetvi_task_id` | Stable ID of the selected task itself. A subtask sends its own ID, never its parent's. |
| `vetvi_task_name` | Current task/subtask display title. |

No description, result, attachment, existing message, API key or session token is included. Vetvi and chat authentication remain independent.

## Receiving behavior to implement in SK AI Chat

1. Retain the fragment through sign-in. Handle initial load and `hashchange`, if navigation can reuse the page. Validate all fields using the chat's input boundaries; labels are untrusted text, never HTML or authority.
2. Within the authenticated chat user's scope, find the project by the durable `vetvi_project_id` binding. If none exists, reuse an unambiguously matching unbound project by name or create one, then persist the binding. Never merge distinct bound IDs merely because labels match.
3. Find the chat by its durable `vetvi_task_id` binding. Open the same conversation and existing history; create it only if no binding exists. A task and its subtasks, including same-name siblings, are separate identities. Names do not identify conversations. A renamed or moved task retains its task ID; the destination project metadata may change.
4. Make find-or-create atomic and retry-safe with uniqueness scoped by chat owner/source/entity ID. Concurrent tabs and reloads must not create duplicate projects/chats. Never select another user's project/history from these client-supplied values.
5. Update labels/project placement without discarding history. Opening, reloading, signing in or restoring a binding must not submit or retry model work, especially uncertain historical requests.

The sender does not establish shared project ACLs, account federation, synchronization or permission to import old messages/files. Existing unbound history has no reliable automatic task mapping; resolve ambiguous matches explicitly in the receiving application.

## Verification boundary

Vetvi tests cover URL encoding, identical reopen targets, rename-stable IDs, different task/subtask IDs and current owning-project selection. Browser acceptance checks both iframe and standalone URLs. Project/chat creation, ownership isolation and old-history reuse require the receiving implementation and separate end-to-end acceptance; a correct sender URL is not proof of those behaviors.
