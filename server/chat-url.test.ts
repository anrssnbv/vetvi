import test from "node:test";
import assert from "node:assert/strict";
import { taskChatUrl } from "../src/chat-url.js";

const project = { id: "project-nit", title: "НИТ & бюджет / 2026 #1" };
const task = { id: "task-main", title: "Таблица + бюджет? 🗂" };
const context = (url: string) => new URLSearchParams(new URL(url, "http://example.test").hash.slice(1));

test("task chat handoff preserves names and IDs in a same-origin fragment only", () => {
  const url = taskChatUrl(project, task);
  const parsed = new URL(url, "http://example.test");
  assert.equal(parsed.origin, "http://example.test");
  assert.equal(parsed.pathname, "/chat/");
  assert.equal(parsed.search, "");
  assert.deepEqual(Object.fromEntries(context(url)), {
    vetvi_project_id: project.id, vetvi_project_name: project.title,
    vetvi_task_id: task.id, vetvi_task_name: task.title,
  });
  assert.equal(taskChatUrl(project, task), url);
});

test("renames retain binding IDs; same-name tasks and subtasks have separate identities", () => {
  const first = context(taskChatUrl(project, task));
  const renamed = context(taskChatUrl({ ...project, title: "Новое название" }, { ...task, title: "Переименована" }));
  for (const key of ["vetvi_project_id", "vetvi_task_id"]) assert.equal(renamed.get(key), first.get(key));
  const subtask = context(taskChatUrl(project, { ...task, id: "task-child" }));
  assert.equal(subtask.get("vetvi_project_id"), first.get("vetvi_project_id"));
  assert.notEqual(subtask.get("vetvi_task_id"), first.get("vetvi_task_id"));
  const other = context(taskChatUrl({ ...project, id: "different-project" }, task));
  assert.notEqual(other.get("vetvi_project_id"), first.get("vetvi_project_id"));
});
