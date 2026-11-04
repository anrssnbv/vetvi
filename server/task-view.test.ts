import test from "node:test";
import assert from "node:assert/strict";
import { isOverdue, localDate, sectionProjects, sectionTasks, sidebarGroups, type ViewTask } from "../src/task-view.js";

const now = Date.parse("2026-11-03T05:00:00Z");
function task(id: string, extra: Partial<ViewTask> = {}): ViewTask {
  return { id, projectId: "nit", parentId: null, status: "planned",
    dueDate: "2026-11-02", dueAt: null, archivedAt: null, deletedAt: null, ...extra };
}

test("overdue uses current deadlines and Almaty day, excluding closed and stored tasks", () => {
  assert.equal(localDate(Date.parse("2026-11-02T19:01:00Z")), "2026-11-03");
  assert.equal(isOverdue(task("old"), now), true);
  for (const extra of [
    { dueDate: "2026-11-03" }, { dueDate: "2026-11-04" },
    { status: "done" }, { status: "cancelled" },
    { archivedAt: "2026-11-02T10:00:00Z" }, { deletedAt: "2026-11-02T10:00:00Z" },
    { dueDate: null, dueAt: "2026-11-03T05:01:00Z" },
  ]) assert.equal(isOverdue(task("moved", extra), now), false);
  assert.equal(isOverdue(task("time", { dueDate: null, dueAt: "2026-11-03T04:59:00Z" }), now), true);
});

test("sections exclude whole stored branches from active and overdue counts without completing them", () => {
  const tasks = [task("active"), task("archive", { archivedAt: "2026-11-02T10:00:00Z" }),
    task("archived-child", { parentId: "archive" }),
    task("trash", { deletedAt: "2026-11-02T10:00:00Z", archivedAt: "2026-11-02T09:00:00Z" }),
    task("trashed-child", { parentId: "trash" })];
  assert.deepEqual(sectionTasks(tasks, "active", "overdue", now).map(t => t.id), ["active"]);
  assert.deepEqual(sectionTasks(tasks, "archive", "overdue", now).map(t => t.id), ["archive", "archived-child"]);
  assert.deepEqual(sectionTasks(tasks, "trash", "overdue", now).map(t => t.id), ["trash", "trashed-child"]);
  assert(tasks.every(t => t.status === "planned"));
});

test("overdue children appear independently of a parent with a future deadline", () => {
  const tasks = [task("parent", { dueDate: "2099-01-01" }), task("child", { parentId: "parent" })];
  assert.deepEqual(sectionTasks(tasks, "active", "overdue", now).map(t => t.id), ["child"]);
});

test("only projects with matching tasks remain in overdue, archive and trash, including empty results", () => {
  const projects = [{ id: "empty" }, { id: "nit" }, { id: "other" }];
  for (const [storage, due] of [["active", "overdue"], ["archive", ""], ["trash", ""]] as const) {
    assert.deepEqual(sectionProjects(projects, [task("match")], storage, due), [{ id: "nit" }]);
    assert.deepEqual(sectionProjects(projects, [], storage, due), []);
  }
  assert.deepEqual(sectionProjects(projects, [], "active", ""), projects);
});

test("new projects are top-level groups without exposing generated categories or duplicating the project", () => {
  const personal = { id: "old", title: "Регламент", categoryId: "imported" };
  const shared = { id: "nit", title: "НИТ", categoryId: "shared-category:nit", personal: false };
  const privateProject = { id: "private", title: "Мой проект", categoryId: "shared-category:private", personal: true };
  const projects = [personal, shared, privateProject];
  const categories = [{ id: "imported", title: "Личные задачи" },
    { id: "shared-category:nit", title: "Проекты" },
    { id: "shared-category:private", title: "Личные задачи" }];
  const groups = sidebarGroups(projects, categories);
  assert.deepEqual(groups.map(group => group.title), ["Личные задачи", "НИТ", "Мой проект"]);
  assert.deepEqual(groups[0]!.projects, [personal]);
  assert.equal(groups[1]!.project, shared);
  assert.equal(groups[2]!.project, privateProject);
  assert.deepEqual(groups[1]!.projects, []);
  assert.deepEqual(sidebarGroups([shared], categories).map(group => group.title), ["НИТ"]);
  assert.deepEqual(sidebarGroups([], categories), []);
});

test("trash includes deleted empty projects so they remain discoverable and recoverable", () => {
  const deleted = { id: "deleted-empty", deletedAt: "2026-11-03T06:00:00Z" };
  const active = { id: "active-empty", deletedAt: null };
  assert.deepEqual(sectionProjects([deleted, active], [], "trash", ""), [deleted]);
});
