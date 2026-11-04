import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService, ServiceError, type Task, type Actor } from "./service.js";
import { backupDatabase } from "./backup.js";

const owner: Actor = { id: "owner", scopes: ["tasks:read", "tasks:write"] };
test("project trash preserves tasks and restores the project when a task is recovered", () => {
  const { s, project, create, write } = fixture();
  try {
    let root = create("Демо");
    const child = create("Подзадача", { parentId: root.id });
    const projectArgs = {
      id: project.id,
      expectedVersion: 1,
      requestId: "delete-project",
      confirmationTitle: project.title,
    };
    assert.throws(
      () => s.execute("delete_project", projectArgs, owner),
      code("OPEN_PROJECT_TASKS"),
    );
    const preview = s.execute("preview_delete", { id: root.id }, owner) as {
      ids: string[];
    };
    root = write("delete_task", root, {
      subtree: true,
      previewIds: preview.ids,
    });
    const removed = s.execute("delete_project", projectArgs, owner) as Task;
    assert(removed.deletedAt);
    assert.equal(removed.version, 2);
    assert.deepEqual(s.execute("delete_project", projectArgs, owner), removed);
    assert.equal(
      (s.execute("list_projects", {}, owner) as { total: number }).total,
      0,
    );
    assert.equal(
      (
        s.execute("list_projects", { includeDeleted: true }, owner) as {
          total: number;
        }
      ).total,
      1,
    );
    assert.equal(
      (s.execute("search_tasks", { deleted: true }, owner) as { total: number })
        .total,
      2,
    );
    const copy = new TaskService(":memory:");
    try {
      const data = s.execute("export_data", {}, owner);
      copy.execute(
        "import_data",
        { data, requestId: "import-deleted-project" },
        owner,
      );
      assert.equal(
        (copy.execute("list_projects", {}, owner) as { total: number }).total,
        0,
      );
      assert.equal(
        (
          copy.execute("search_tasks", { deleted: true }, owner) as {
            total: number;
          }
        ).total,
        2,
      );
    } finally {
      copy.close();
    }
    assert.throws(() => create("Новая задача"), code("DELETED_PROJECT"));
    assert.throws(
      () =>
        s.execute(
          "restore_project",
          { ...projectArgs, requestId: "stale-restore" },
          owner,
        ),
      code("VERSION_CONFLICT"),
    );
    assert.throws(
      () =>
        s.execute(
          "restore_project",
          { id: project.id, expectedVersion: 2, requestId: "foreign" },
          { id: "other", scopes: ["tasks:write"] },
        ),
      code("NOT_FOUND"),
    );
    root = write("restore_task", root);
    assert.equal(root.deletedAt, null);
    assert.equal(
      (s.execute("get_task", { id: child.id }, owner) as Task).deletedAt,
      null,
    );
    const restored = (
      s.execute("list_projects", {}, owner) as { items: Task[] }
    ).items[0];
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.version, 3);
    const changes = (
      s.execute("get_changes", {}, owner) as { items: { action: string }[] }
    ).items;
    assert(changes.some((c) => c.action === "delete_project"));
    assert(changes.some((c) => c.action === "restore_project"));
  } finally {
    s.close();
  }
});
test("finished project deletion verifies its title, rechecks open work and preserves recoverable tasks", () => {
  const { s, project, category, run, create, write } = fixture();
  try {
    let root = create("Завершённая ветка");
    let child = create("Завершённая подзадача", { parentId: root.id });
    child = write("complete_task", child, { result: "Получен результат" });
    root = write("complete_task", root, { result: "Ветка выполнена" });
    let archived = create("Архивная ветка", { status: "in_progress" });
    const archivedChild = create("Неактуальный потомок", { parentId: archived.id });
    archived = write("archive_task", archived);
    const cancelled = create("Отменено", { status: "cancelled" });
    let previousTrash = create("Ранее удалённая задача");
    previousTrash = write("delete_task", previousTrash, { subtree: true, previewIds: [previousTrash.id] });
    let open = create("Ещё требует действий");
    const otherProject = run("create_project", { title: "Другой проект", categoryId: category.id });
    const other = run("create_task", { title: "Чужая ветка", projectId: otherProject.id });
    const args = { id: project.id, expectedVersion: 1, confirmationTitle: project.title, requestId: "finish-project" };
    const snapshot = () => ({ ...(s.execute("export_data", {}, owner) as Record<string, unknown>), exportedAt: null });
    const before = snapshot();
    for (const confirmationTitle of [undefined, "демо", "Демо ", ""]) {
      assert.throws(() => s.execute("delete_project", { ...args, confirmationTitle }, owner), code("PROJECT_CONFIRMATION"));
    }
    assert.throws(() => s.execute("delete_project", args, owner), code("OPEN_PROJECT_TASKS"));
    assert.deepEqual(snapshot(), before);
    open = write("complete_task", open, { result: "Работа закончена" });
    let late = create("Добавлена после проверки формы");
    assert.throws(() => s.execute("delete_project", args, owner), code("OPEN_PROJECT_TASKS"));
    late = write("complete_task", late, { result: "Дальнейшие шаги не нужны" });
    const removed = s.execute("delete_project", args, owner) as Task;
    assert(removed.deletedAt);
    for (const original of [root, child, archived, archivedChild, cancelled, open, late]) {
      const task = s.execute("get_task", { id: original.id }, owner) as Task & { history: { action: string }[] };
      assert(task.deletedAt);
      assert.equal(task.version, original.version + 1);
      assert.equal(task.status, original.status);
      assert.equal(task.result, original.result);
      assert(task.history.some(event => event.action === "delete_task"));
    }
    const oldTrash = s.execute("get_task", { id: previousTrash.id }, owner) as Task;
    assert.equal(oldTrash.deletedAt, previousTrash.deletedAt);
    assert.equal(oldTrash.version, previousTrash.version);
    assert.equal((s.execute("get_task", { id: other.id }, owner) as Task).deletedAt, null);
    const changes = s.execute("get_changes", {}, owner);
    assert.deepEqual(s.execute("delete_project", args, owner), removed);
    assert.deepEqual(s.execute("get_changes", {}, owner), changes);
    assert.throws(() => s.execute("delete_project", { ...args, expectedVersion: 2, requestId: "again" }, owner), code("DELETED_PROJECT"));
    root = s.execute("get_task", { id: root.id }, owner) as Task;
    write("restore_task", root);
    assert.equal((s.execute("get_task", { id: child.id }, owner) as Task).deletedAt, null);
    assert.equal((s.execute("list_projects", {}, owner) as { total: number }).total, 2);
  } finally { s.close(); }
});

test("empty project deletion still requires its exact name and can be restored", () => {
  const { s, project } = fixture();
  try {
    const args = { id: project.id, expectedVersion: 1, requestId: "empty-delete" };
    assert.throws(() => s.execute("delete_project", args, owner), code("PROJECT_CONFIRMATION"));
    assert.throws(() => s.execute("delete_project", { ...args, expectedVersion: 2, confirmationTitle: project.title }, owner), code("VERSION_CONFLICT"));
    const deleted = s.execute("delete_project", { ...args, confirmationTitle: project.title }, owner) as Task;
    assert(deleted.deletedAt);
    assert.equal((s.execute("list_projects", { includeDeleted: true }, owner) as { total: number }).total, 1);
    const restored = s.execute("restore_project", { id: project.id, expectedVersion: deleted.version, requestId: "empty-restore" }, owner) as Task;
    assert.equal(restored.deletedAt, null);
  } finally { s.close(); }
});

test("a failure saving the project rolls back task deletion and allows an exact retry", () => {
  const { s, project, create, write } = fixture();
  try {
    let task = create("Выполнено");
    task = write("complete_task", task, { result: "Результат сохранён" });
    const snapshot = () => ({ ...(s.execute("export_data", {}, owner) as Record<string, unknown>), exportedAt: null });
    const before = snapshot();
    s.db.exec(`CREATE TRIGGER fail_project_delete BEFORE UPDATE OF data ON records
      WHEN NEW.kind = 'project' AND json_extract(NEW.data, '$.deletedAt') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected project failure'); END`);
    const args = { id: project.id, expectedVersion: 1, requestId: "atomic-project-delete", confirmationTitle: project.title };
    assert.throws(() => s.execute("delete_project", args, owner), /injected project failure/);
    assert.deepEqual(snapshot(), before);
    s.db.exec("DROP TRIGGER fail_project_delete");
    const deleted = s.execute("delete_project", args, owner) as Task;
    assert(deleted.deletedAt);
    assert.equal((s.execute("get_task", { id: task.id }, owner) as Task).version, task.version + 1);
  } finally { s.close(); }
});

function fixture(path = ":memory:") {
  const s = new TaskService(path);
  const run = (
    name: string,
    args: Record<string, unknown> = {},
    actor = owner,
  ) => s.execute(name, { requestId: randomUUID(), ...args }, actor) as Task;
  const category = run("create_category", { title: "Работа" }),
    project = run("create_project", { title: "Демо", categoryId: category.id });
  const create = (title: string, extra: Record<string, unknown> = {}) =>
    run("create_task", {
      projectId: project.id,
      title,
      criteria: ["Проверено"],
      ...extra,
    });
  const write = (
    name: string,
    task: Task,
    args: Record<string, unknown> = {},
  ) => run(name, { id: task.id, expectedVersion: task.version, ...args });
  return { s, run, create, write, category, project };
}
function code(expected: string) {
  return (e: unknown) => e instanceof ServiceError && e.code === expected;
}

test("tree movement preserves descendants, positions are separate, cycles fail", () => {
  const { s, create, write, project } = fixture();
  try {
    let root = create("Родитель"),
      child = create("Ребёнок", { parentId: root.id });
    const grandchild = create("Внук", { parentId: child.id });
    assert.throws(
      () => write("move_task", root, { parentId: grandchild.id }),
      code("TREE_CYCLE"),
    );
    const target = create("Другая ветка");
    child = write("move_task", child, { parentId: target.id });
    assert.equal(
      (s.execute("get_task", { id: grandchild.id }, owner) as Task).parentId,
      child.id,
    );
    root = write("set_position", root, { x: 34, y: -20 });
    assert.equal(root.parentId, null);
    const task = s.execute("get_task", { id: root.id }, owner) as Task & {
      position: { x: number; y: number };
    };
    assert.equal(task.position.x, 34);
    assert.equal(
      (
        s.execute("search_tasks", { projectId: project.id }, owner) as {
          total: number;
        }
      ).total,
      4,
    );
  } finally {
    s.close();
  }
});

test("idempotency, optimistic version and owner isolation enforce safe concurrent writes", () => {
  const { s, create, write, run } = fixture();
  try {
    const a = create("Задача");
    const args = {
      id: a.id,
      expectedVersion: a.version,
      requestId: "same",
      title: "Изменено",
    };
    const first = s.execute("update_task", args, owner);
    assert.deepEqual(s.execute("update_task", args, owner), first);
    assert.throws(
      () => s.execute("update_task", { ...args, title: "Другое" }, owner),
      code("IDEMPOTENCY_CONFLICT"),
    );
    assert.throws(
      () => write("update_task", a, { title: "Устарело" }),
      code("VERSION_CONFLICT"),
    );
    assert.throws(
      () => s.execute("get_task", { id: a.id }, { id: "other", scopes: ["*"] }),
      code("NOT_FOUND"),
    );
    assert.throws(
      () =>
        run(
          "update_task",
          { id: a.id, expectedVersion: 2, title: "x" },
          { id: "owner", scopes: ["tasks:read"] },
        ),
      code("FORBIDDEN"),
    );
    assert.throws(
      () => s.execute("get_task", { id: a.id }, { id: "", scopes: [] }),
      code("UNAUTHORIZED"),
    );
    assert.equal(
      (s.execute("get_changes", {}, owner) as { total: number }).total,
      4,
    );
  } finally {
    s.close();
  }
});

test("completion requires a result, blocks children and dependencies, cannot bypass update", () => {
  const { s, create, write } = fixture();
  try {
    let parent = create("Согласование"),
      child = create("Документ", { parentId: parent.id }),
      dependency = create("Подтверждение");
    assert.throws(
      () => write("update_task", parent, { status: "done" }),
      code("INVALID_TRANSITION"),
    );
    assert.throws(
      () => write("complete_task", child, { result: "   " }),
      code("VALIDATION"),
    );
    const empty = create("Нет критериев", { criteria: [] });
    const args = {
      id: empty.id,
      expectedVersion: empty.version,
      requestId: "result-only-completion",
      result: "  Получен и проверен результат  ",
    };
    const done = s.execute("complete_task", args, owner) as Task;
    assert.equal(done.status, "done");
    assert.equal(done.result, "Получен и проверен результат");
    assert.deepEqual(done.criteria, []);
    assert.deepEqual(done.evidence, []);
    assert.deepEqual(s.execute("complete_task", args, owner), done);
    const copy = new TaskService(":memory:");
    try {
      copy.execute("import_data", {
        requestId: "import-result-only",
        data: s.execute("export_data", {}, owner),
      }, owner);
      const imported = copy.execute("get_task", { id: done.id }, owner) as Task & {
        history: { action: string; confirmation: { result: string; evidence: unknown[] } }[];
      };
      assert.equal(imported.status, "done");
      assert.equal(imported.result, done.result);
      assert.deepEqual(imported.evidence, []);
      const completions = imported.history.filter((event) => event.action === "complete_task");
      assert.equal(completions.length, 1);
      assert.deepEqual(completions[0]!.confirmation, { result: done.result, evidence: [] });
    } finally {
      copy.close();
    }
    assert.throws(
      () =>
        write("complete_task", parent, {
          result: "Проверено",
          evidenceUrl: "https://example.org/proof",
        }),
      code("OPEN_CHILDREN"),
    );
    child = write("complete_task", child, {
      result: "Создан и проверен документ",
      evidenceUrl: "https://example.org/document",
    });
    parent = write("add_dependency", parent, { targetId: dependency.id });
    assert.throws(
      () =>
        write("complete_task", parent, {
          result: "Проверено",
          evidenceUrl: "https://example.org/proof",
        }),
      code("OPEN_DEPENDENCIES"),
    );
    dependency = write("complete_task", dependency, {
      result: "Согласование подтверждено",
      evidenceUrl: "https://example.org/approval",
    });
    parent = write("complete_task", parent, {
      result: "Все критерии приняты",
      evidenceUrl: "https://example.org/acceptance",
    });
    assert.equal(parent.status, "done");
    child = write("reopen_task", child, { reason: "Обнаружена ошибка" });
    assert.equal(child.status, "planned");
    assert.equal(
      (s.execute("get_task", { id: parent.id }, owner) as Task).status,
      "review",
    );
  } finally {
    s.close();
  }
});

test("dependency cycle rejected; leaf progress avoids double count and does not close parent", () => {
  const { s, create, write } = fixture();
  try {
    let a = create("A"),
      b = create("B", { parentId: a.id }),
      c = create("C", { parentId: b.id });
    a = write("add_dependency", a, { targetId: b.id });
    b = write("add_dependency", b, { targetId: c.id });
    assert.throws(
      () => write("add_dependency", c, { targetId: a.id }),
      code("DEPENDENCY_CYCLE"),
    );
    c = write("complete_task", c, {
      result: "Проверено",
      evidenceUrl: "https://example.org/c",
    });
    const detail = s.execute("get_task", { id: a.id }, owner) as Task & {
      progress: { total: number; percent: number };
    };
    assert.equal(detail.progress.total, 1);
    assert.equal(detail.progress.percent, 100);
    assert.equal(detail.status, "planned");
  } finally {
    s.close();
  }
});

test("delete requires preview, restore recovers subtree and history; archive distinct from completion", () => {
  const { s, create, write } = fixture();
  try {
    let a = create("A");
    const b = create("B", { parentId: a.id });
    assert.throws(
      () => write("delete_task", a, { subtree: true, previewIds: [a.id] }),
      code("DELETE_CONFIRMATION"),
    );
    const preview = s.execute("preview_delete", { id: a.id }, owner) as {
      ids: string[];
    };
    a = write("delete_task", a, { subtree: true, previewIds: preview.ids });
    assert.ok(a.deletedAt);
    assert.equal(
      (s.execute("search_tasks", {}, owner) as { total: number }).total,
      0,
    );
    a = write("restore_task", a);
    assert.equal(a.deletedAt, null);
    assert.equal(
      (s.execute("get_task", { id: b.id }, owner) as Task).deletedAt,
      null,
    );
    a = write("archive_task", a);
    assert.ok(a.archivedAt);
    assert.equal(a.status, "planned");
    a = write("restore_task", a);
    assert.equal(a.archivedAt, null);
    assert.ok(
      (
        s.execute("get_task", { id: a.id }, owner) as Task & {
          history: unknown[];
        }
      ).history.length >= 5,
    );
  } finally {
    s.close();
  }
});

test("SQLite restart preserves tasks, evidence, versions and history; JSON roundtrip preserves semantic state", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetvi-")),
    path = join(dir, "tasks.sqlite");
  try {
    const { s, create, write } = fixture(path);
    let a = create("Персистентная задача", { dueDate: "2026-11-01" });
    a = write("complete_task", a, {
      result: "Создан файл",
      evidenceUrl: "https://example.org/file",
    });
    s.close();
    const restarted = new TaskService(path);
    const restored = restarted.execute(
      "get_task",
      { id: a.id },
      owner,
    ) as Task & { history: unknown[] };
    assert.equal(restored.status, "done");
    assert.equal(restored.dueDate, "2026-11-01");
    assert.equal(restored.history.length, 2);
    const exported = restarted.execute("export_data", {}, owner);
    restarted.close();
    const imported = new TaskService(":memory:");
    try {
      imported.execute(
        "import_data",
        { data: exported, requestId: randomUUID() },
        owner,
      );
      const round = imported.execute("get_task", { id: a.id }, owner) as Task;
      assert.equal(round.evidence.length, 1);
      assert.equal(round.version, a.version);
      const opened = imported.execute(
        "reopen_task",
        {
          id: a.id,
          expectedVersion: a.version,
          requestId: randomUUID(),
          reason: "Новая проверка",
        },
        owner,
      ) as Task;
      assert.equal(opened.status, "planned");
    } finally {
      imported.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("input date, links, import validation and rollback prevent invalid state", () => {
  const { s, create, write } = fixture();
  try {
    assert.throws(
      () => create("Дата", { dueDate: "2026-02-30" }),
      code("VALIDATION"),
    );
    assert.throws(
      () => create("Время", { dueAt: "2026-02-30T12:00:00+05:00" }),
      code("VALIDATION"),
    );
    assert.throws(
      () => create("Ожидание", { status: "waiting" }),
      code("VALIDATION"),
    );
    const a = create("Тест");
    assert.throws(
      () => write("add_evidence", a, { url: "javascript:alert(1)" }),
      code("VALIDATION"),
    );
    assert.throws(
      () =>
        s.execute(
          "import_data",
          { requestId: randomUUID(), data: { formatVersion: 2 } },
          owner,
        ),
      code("IMPORT_VERSION"),
    );
    assert.equal(
      (s.execute("get_task", { id: a.id }, owner) as Task).version,
      1,
    );
  } finally {
    s.close();
  }
});

test("progress excludes complete cancelled, archived and deleted branches without counting parent as leaf", () => {
  const { s, create, write } = fixture();
  try {
    const root = create("Корень");
    let cancelled = create("Отменённая ветка", { parentId: root.id });
    const nested = create("Потомок отменённой", { parentId: cancelled.id });
    void nested;
    cancelled = write("update_task", cancelled, { status: "cancelled" });
    void cancelled;
    let archived = create("Архивная ветка", { parentId: root.id });
    create("Потомок архивной", { parentId: archived.id });
    archived = write("archive_task", archived);
    void archived;
    const live = create("Текущая", { parentId: root.id });
    write("complete_task", live, {
      result: "Проверено",
      evidenceUrl: "https://example.org/e",
    });
    const p = (
      s.execute("get_task", { id: root.id }, owner) as Task & {
        progress: { total: number; percent: number };
      }
    ).progress;
    assert.equal(p.total, 1);
    assert.equal(p.percent, 100);
    const only = create("Только отмена");
    let branch = create("Отмена", { parentId: only.id });
    branch = write("update_task", branch, { status: "cancelled" });
    void branch;
    assert.equal(
      (
        s.execute("get_task", { id: only.id }, owner) as Task & {
          progress: { total: number };
        }
      ).progress.total,
      0,
    );
  } finally {
    s.close();
  }
});

test("import rejects forged done records, bad versions and malformed evidence atomically; attributes imported history", () => {
  const { s, create } = fixture();
  try {
    const a = create("Импорт");
    const source = s.execute("export_data", {}, owner) as Record<
      string,
      unknown
    >;
    const attempt = (mutate: (data: Record<string, unknown>) => void) => {
      const data = structuredClone(source);
      mutate(data);
      const fresh = new TaskService(":memory:");
      try {
        assert.throws(() =>
          fresh.execute(
            "import_data",
            { requestId: randomUUID(), data },
            owner,
          ),
        );
        assert.equal(
          (fresh.execute("list_projects", {}, owner) as { total: number })
            .total,
          0,
        );
      } finally {
        fresh.close();
      }
    };
    attempt((data) => {
      (data.tasks as Task[])[0]!.status = "done";
    });
    attempt((data) => {
      (data.tasks as Task[])[0]!.version = 0;
    });
    attempt((data) => {
      (data.tasks as Task[])[0]!.evidence = [
        {
          id: "a",
          url: "https://example.org",
          note: "",
          createdAt: "yesterday",
        },
      ];
    });
    attempt((data) => {
      (data.history as Record<string, unknown>[])[0]!.taskId = "foreign-id";
    });
    const imported = new TaskService(":memory:");
    try {
      imported.execute(
        "import_data",
        { requestId: randomUUID(), data: source },
        owner,
      );
      const detail = imported.execute(
        "get_task",
        { id: a.id },
        owner,
      ) as Task & { history: Record<string, unknown>[] };
      const history = detail.history.find((h) => h.importedBy);
      assert.equal(history?.actor, "import:owner");
      assert.equal(history?.originalActor, "owner");
    } finally {
      imported.close();
    }
    const other: Actor = { id: "other", scopes: ["tasks:read", "tasks:write"] },
      remapped = new TaskService(":memory:");
    try {
      const request = { requestId: randomUUID(), data: source };
      const result = remapped.execute("import_data", request, other);
      assert.deepEqual(remapped.execute("import_data", request, other), result);
      assert.equal((source.tasks as Task[])[0]?.ownerId, "owner");
      assert.throws(
        () => remapped.execute("get_task", { id: a.id }, owner),
        code("NOT_FOUND"),
      );
      assert.equal(
        (remapped.execute("get_task", { id: a.id }, other) as Task).ownerId,
        "other",
      );
    } finally {
      remapped.close();
    }
  } finally {
    s.close();
  }
});

test("online backup is a self-contained consistent SQLite database and never overwrites", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetvi-backup-")),
    path = join(dir, "live.sqlite"),
    dest = join(dir, "backup.sqlite");
  try {
    const { s, create } = fixture(path);
    const a = create("Живой WAL");
    try {
      await backupDatabase(path, dest);
      const copy = new TaskService(dest);
      try {
        assert.equal(
          (copy.execute("get_task", { id: a.id }, owner) as Task).title,
          a.title,
        );
        assert.equal(
          (copy.execute("get_changes", {}, owner) as { total: number }).total,
          3,
        );
      } finally {
        copy.close();
      }
      await assert.rejects(backupDatabase(path, dest), /уже существует/);
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive searches select whole branches; cancelled descendants cannot hide unfinished work", () => {
  const { s, create, write } = fixture();
  try {
    let parent = create("Корень"),
      cancelled = create("Отменённая", { parentId: parent.id });
    const open = create("Открытый внук", { parentId: cancelled.id });
    cancelled = write("update_task", cancelled, { status: "cancelled" });
    assert.throws(
      () => write("update_task", cancelled, { status: "planned" }),
      code("INVALID_TRANSITION"),
    );
    assert.throws(
      () =>
        write("complete_task", parent, {
          result: "Проверено",
          evidenceUrl: "https://example.org/e",
        }),
      code("OPEN_CHILDREN"),
    );
    const forged = s.execute("export_data", {}, owner) as { tasks: Task[] };
    const forgedParent = forged.tasks.find((t) => t.id === parent.id)!;
    forgedParent.status = "done";
    forgedParent.result = "Проверено";
    forgedParent.evidence = [
      {
        id: randomUUID(),
        url: "https://example.org/e",
        note: "",
        createdAt: new Date().toISOString(),
      },
    ];
    const destination = new TaskService(":memory:");
    try {
      assert.throws(
        () =>
          destination.execute(
            "import_data",
            { requestId: randomUUID(), data: forged },
            owner,
          ),
        code("IMPORT_VALIDATION"),
      );
    } finally {
      destination.close();
    }
    parent = write("archive_task", parent);
    assert.equal(
      (s.execute("search_tasks", {}, owner) as { total: number }).total,
      0,
    );
    assert.equal(
      (
        s.execute("search_tasks", { archived: true }, owner) as {
          total: number;
        }
      ).total,
      3,
    );
    parent = write("restore_task", parent);
    assert.equal(
      (
        s.execute("search_tasks", { archived: true }, owner) as {
          total: number;
        }
      ).total,
      0,
    );
    assert.equal(
      (s.execute("search_tasks", {}, owner) as { total: number }).total,
      3,
    );
    const completed = write("complete_task", open, {
      result: "Проверено",
      evidenceUrl: "https://example.org/open",
    });
    assert.throws(
      () => write("update_task", completed, { criteria: ["Другое"] }),
      code("INVALID_TRANSITION"),
    );
  } finally {
    s.close();
  }
});

test("ordinary relations are symmetric, deduplicated and removal versions and audits both tasks", () => {
  const { s, create, write } = fixture();
  try {
    let a = create("A"),
      b = create("B");
    const staleB = b;
    a = write("add_relation", a, { targetId: b.id });
    b = s.execute("get_task", { id: b.id }, owner) as Task;
    assert.equal(b.version, 2);
    assert.throws(
      () => write("update_task", staleB, { title: "Устаревшая правка" }),
      code("VERSION_CONFLICT"),
    );
    b = write("add_relation", b, { targetId: a.id });
    const relationCount = s.db
      .prepare("SELECT COUNT(*) AS count FROM links WHERE kind='related'")
      .get();
    assert.equal(relationCount?.count, 1);
    assert.deepEqual((b as Task & { related: string[] }).related, [a.id]);
    const exported = s.execute("export_data", {}, owner) as {
      links: { source: string; target: string; kind: string }[];
    };
    exported.links.push(
      { source: b.id, target: a.id, kind: "related" },
      { source: a.id, target: b.id, kind: "related" },
    );
    const imported = new TaskService(":memory:");
    try {
      imported.execute(
        "import_data",
        { requestId: randomUUID(), data: exported },
        owner,
      );
      assert.equal(
        imported.db
          .prepare("SELECT COUNT(*) AS count FROM links WHERE kind='related'")
          .get()?.count,
        1,
      );
    } finally {
      imported.close();
    }
    b = write("remove_relation", b, { targetId: a.id });
    const savedA = s.execute("get_task", { id: a.id }, owner) as Task & {
      related: string[];
      history: Record<string, unknown>[];
    };
    assert.deepEqual(savedA.related, []);
    assert.deepEqual((b as Task & { related: string[] }).related, []);
    assert.equal(savedA.version, a.version + 1);
    const change = savedA.history.find((h) => h.action === "remove_relation");
    assert.deepEqual(change?.operation, {
      kind: "related",
      source: b.id,
      target: a.id,
      before: true,
      after: false,
    });
  } finally {
    s.close();
  }
});

test("shared project actors preserve authors, versions, scoped receipts and outbox on restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "vetvi-shared-"));
  const path = join(directory, "tasks.sqlite");
  const alice: Actor = { id: "manager-a", scopes: ["tasks:read", "tasks:write"] };
  const bob: Actor = { id: "manager-b", scopes: ["tasks:read", "tasks:write"] };
  const scope = { id: "shared-project", namespace: "shared-storage", creatorId: alice.id, personal: false, title: "Общий проект" };
  let service = new TaskService(path);
  try {
    service.bindProject(scope, alice);
    const createArgs = { projectId: scope.id, title: "Совместная задача", assigneeId: alice.id, collaboratorIds: [bob.id], requestId: "create" };
    const task = service.executeScoped("create_task", createArgs, alice, scope) as Task;
    assert.equal(task.ownerId, scope.namespace);
    assert.equal(task.assigneeId, alice.id);
    assert.deepEqual(task.collaboratorIds, [bob.id]);
    const args = { id: task.id, title: "Правка Б", expectedVersion: 1, requestId: "edit" };
    const edited = service.executeScoped("update_task", args, bob, scope) as Task;
    assert.equal(edited.version, 2);
    assert.deepEqual(service.executeScoped("update_task", args, bob, scope), edited);
    assert.throws(() => service.executeScoped("update_task", args, alice, scope), code("VERSION_CONFLICT"));
    assert.throws(() => service.executeScoped("update_task", { ...args, title: "Перезапись" }, bob, scope), code("IDEMPOTENCY_CONFLICT"));
    assert.throws(() => service.executeScoped("update_task", { ...args, expectedVersion: 2, requestId: "bad-collaborators", collaboratorIds: [bob.id, bob.id] }, bob, scope), code("VALIDATION"));
    assert.equal((service.db.prepare("SELECT COUNT(*) AS n FROM task_outbox").get()!).n, 2);
    assert.throws(() => service.execute("get_task", { id: task.id }, { ...alice, id: scope.namespace }), code("SHARED_SCOPE_REQUIRED"));
    assert.throws(() => service.execute("update_task", args, { ...bob, id: JSON.stringify(["project", scope.namespace, scope.id, bob.id]) }), code("SHARED_SCOPE_REQUIRED"));
    assert.throws(() => service.executeScoped("get_task", { id: task.id }, bob, { ...scope, namespace: "forged" }), code("NOT_FOUND"));
    assert.throws(() => service.bindProject({ ...scope, creatorId: bob.id }, alice), code("SCOPE_CONFLICT"));
    service.close();
    service = new TaskService(path);
    const reread = service.executeScoped("get_task", { id: task.id }, bob, scope) as Task & { history: {actor: string}[] };
    assert.equal(reread.version, 2);
    assert.deepEqual(reread.history.map((entry) => entry.actor), [bob.id, alice.id]);
    assert.deepEqual(service.executeScoped("update_task", args, bob, scope), edited);
    const personal = { ...scope, id: "personal-project", namespace: "personal-storage", personal: true };
    service.bindProject(personal, alice);
    assert.throws(() => service.executeScoped("list_projects", {}, bob, personal), code("NOT_FOUND"));
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mapped legacy projects isolate every collection and block old owner receipts", () => {
  const { s, project, create } = fixture();
  try {
    const visible = create("Доступная задача");
    const category = (s.execute("list_projects", {}, owner) as {categories: {id: string}[]}).categories[0]!;
    const otherProject = s.execute("create_project", { title: "Личный проект", categoryId: category.id, requestId: "private-project" }, owner) as Task;
    const hidden = s.execute("create_task", { title: "Скрытый текст", projectId: otherProject.id, requestId: "private-task" }, owner) as Task;
    s.execute("set_position", { id: hidden.id, expectedVersion: 1, x: 5, y: 7, requestId: "private-position" }, owner);
    const before = s.db.prepare("SELECT data FROM records WHERE id=?").get(project.id)!.data;
    const scope = { id: project.id, namespace: owner.id, creatorId: "manager-a", personal: false, title: "Ignored rename" };
    const manager: Actor = { id: scope.creatorId, scopes: ["tasks:read", "tasks:write"] };
    s.bindProject(scope, manager);
    assert.equal(s.db.prepare("SELECT data FROM records WHERE id=?").get(project.id)!.data, before);
    assert.throws(() => s.execute("create_task", { title: "Скрытый текст", projectId: otherProject.id, requestId: "private-task" }, owner), code("SHARED_SCOPE_REQUIRED"));
    assert.throws(() => s.executeScoped("get_task", { id: hidden.id }, manager, scope), code("NOT_FOUND"));
    assert.throws(() => s.executeScoped("move_task", { id: visible.id, expectedVersion: 1, projectId: otherProject.id, parentId: null, requestId: "foreign-move" }, manager, scope), code("NOT_FOUND"));
    assert.throws(() => s.executeScoped("add_dependency", { id: visible.id, expectedVersion: 1, targetId: hidden.id, requestId: "foreign-link" }, manager, scope), code("NOT_FOUND"));
    for (const tool of ["search_tasks", "list_projects", "get_changes", "export_data"]) {
      const result = s.executeScoped(tool, {}, manager, scope);
      assert(!JSON.stringify(result).includes("Скрытый текст"));
      assert(!JSON.stringify(result).includes(otherProject.id));
    }
    const data = s.executeScoped("export_data", {}, manager, scope) as { formatVersion: number; tasks: Task[]; positions: unknown[]; history: Record<string, unknown>[]; categories: unknown[]; projects: unknown[] };
    assert.equal(data.formatVersion, 1);
    assert.equal(data.tasks.length, 1);
    assert.deepEqual(data.positions, []);
    const duplicate = structuredClone(data);
    duplicate.tasks[0]!.id = randomUUID();
    duplicate.history = [];
    const imported = s.executeScoped("import_data", { data: duplicate, requestId: "append" }, manager, scope) as {imported: number};
    assert.equal(imported.imported, 1);
    assert.equal((s.executeScoped("search_tasks", {}, manager, scope) as {total: number}).total, 2);
    const bad = structuredClone(duplicate);
    bad.tasks[0]!.id = randomUUID();
    bad.tasks[0]!.projectId = otherProject.id;
    assert.throws(() => s.executeScoped("import_data", { data: bad, requestId: "bad-import" }, manager, scope), code("SCOPE_CONFLICT"));
    assert.equal((s.executeScoped("search_tasks", {}, manager, scope) as {total: number}).total, 2);
    const unbound: Actor = { id: "unbound-owner", scopes: ["tasks:write"] };
    assert.equal((s.execute("create_category", { title: "Личное", requestId: "unbound" }, unbound) as Task).ownerId, unbound.id);
  } finally {
    s.close();
  }
});

test("existing cross-project dependencies fail closed instead of hiding a completion blocker", () => {
  const { s, project, create, write } = fixture();
  try {
    let visible = create("Связанная задача");
    const categoryId = (s.execute("list_projects", {}, owner) as {categories: {id: string}[]}).categories[0]!.id;
    const foreign = s.execute("create_project", { title: "Другой проект", categoryId, requestId: "other-project" }, owner) as Task;
    const blocker = s.execute("create_task", { title: "Чужой блокер", projectId: foreign.id, requestId: "blocker" }, owner) as Task;
    visible = write("add_dependency", visible, { targetId: blocker.id });
    const scope = { id: project.id, namespace: owner.id, creatorId: "manager", personal: false, title: project.title };
    const manager: Actor = { id: scope.creatorId, scopes: ["tasks:read", "tasks:write"] };
    s.bindProject(scope, manager);
    const historyCount = s.db.prepare("SELECT COUNT(*) AS n FROM changes").get()!.n;
    assert.throws(() => s.executeScoped("update_task", { id: visible.id, expectedVersion: visible.version, title: "Недопустимая правка", requestId: "unsafe-update" }, manager, scope), code("SCOPE_CONFLICT"));
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM changes").get()!.n, historyCount);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM task_outbox").get()!.n, 0);
    assert.throws(() => s.executeScoped("complete_task", { id: visible.id, expectedVersion: visible.version, result: "Готово", requestId: "unsafe-complete" }, manager, scope), code("SCOPE_CONFLICT"));
    assert.throws(() => s.executeScoped("export_data", {}, manager, scope), code("SCOPE_CONFLICT"));
    const stored = JSON.parse(s.db.prepare("SELECT data FROM records WHERE id=?").get(visible.id)!.data as string) as Task;
    assert.equal(stored.status, visible.status);
    assert.equal(stored.version, visible.version);
    assert.equal(s.db.prepare("SELECT 1 FROM requests WHERE request_id='unsafe-complete'").get(), undefined);
  } finally {
    s.close();
  }
});


test("scoped restore never restores another project sharing a deletion batch", () => {
  const { s, project, create } = fixture();
  try {
    const visible = create("Восстановить эту задачу");
    const categoryId = (s.execute("list_projects", {}, owner) as {categories: {id: string}[]}).categories[0]!.id;
    const other = s.execute("create_project", { title: "Закрытый проект", categoryId, requestId: "restore-other" }, owner) as Task;
    const hidden = s.execute("create_task", { title: "Не восстанавливать", projectId: other.id, requestId: "restore-hidden" }, owner) as Task;
    for (const task of [visible, hidden]) {
      task.deletedAt = new Date().toISOString();
      task.deletionBatch = "same-legacy-batch";
      s.db.prepare("UPDATE records SET data=? WHERE id=?").run(JSON.stringify(task), task.id);
    }
    const scope = { id: project.id, namespace: owner.id, creatorId: "manager", personal: false, title: project.title };
    const manager: Actor = { id: scope.creatorId, scopes: ["tasks:read", "tasks:write"] };
    s.bindProject(scope, manager);
    const restored = s.executeScoped("restore_task", { id: visible.id, expectedVersion: 1, requestId: "restore-visible" }, manager, scope) as Task;
    assert.equal(restored.deletedAt, null);
    const foreign = JSON.parse(s.db.prepare("SELECT data FROM records WHERE id=?").get(hidden.id)!.data as string) as Task;
    assert.equal(foreign.deletionBatch, "same-legacy-batch");
    assert.equal(foreign.version, 1);
    const exported = s.executeScoped("export_data", {}, manager, scope);
    assert(!JSON.stringify(exported).includes("Не восстанавливать"));
  } finally {
    s.close();
  }
});

test("explicit personal transfer preserves subtree records, history, results, links and positions across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "vetvi-transfer-"));
  const path = join(directory, "tasks.sqlite");
  const alice: Actor = { id: "alice", scopes: ["tasks:read", "tasks:write"] };
  const bob: Actor = { id: "bob", scopes: ["tasks:read", "tasks:write"] };
  const personal = { id: "personal", namespace: "private-alice", creatorId: alice.id, personal: true, title: "Личное" };
  const shared = { id: "team", namespace: "team-storage", creatorId: bob.id, personal: false, title: "Совместное" };
  let service = new TaskService(path);
  try {
    service.bindProject(personal, alice);
    service.bindProject(shared, alice);
    const create = (title: string, parentId: string | null = null) => service.executeScoped("create_task", {
      projectId: personal.id, title, parentId, criteria: ["Сохранён результат"], assigneeId: alice.id,
      collaboratorIds: [bob.id], requestId: randomUUID(),
    }, alice, personal) as Task;
    const write = (tool: string, task: Task, args: Record<string, unknown> = {}) => service.executeScoped(tool, {
      id: task.id, expectedVersion: task.version, requestId: randomUUID(), ...args,
    }, alice, personal) as Task;
    let root = create("Личная справка");
    let child = create("Подготовить текст", root.id);
    let evidence = create("Проверить источники", root.id);
    child = write("add_dependency", child, { targetId: evidence.id });
    evidence = write("set_position", evidence, { x: 125, y: 75 });
    evidence = write("complete_task", evidence, { result: "Источники проверены" });
    child = write("complete_task", child, { result: "Текст подготовлен" });
    root = write("complete_task", root, { result: "Справка подготовлена", evidenceUrl: "https://example.org/synthetic.docx", evidenceNote: "Сохранённый черновик" });
    const ids = [root.id, child.id, evidence.id];
    const beforeRecords = new Map(ids.map((id) => [id, JSON.parse(service.db.prepare("SELECT data FROM records WHERE id=?").get(id)!.data as string) as Task]));
    const beforeHistory = service.db.prepare("SELECT seq,task_id,data FROM changes").all().filter((entry) => ids.includes(entry.task_id as string));
    const beforeOutbox = Number(service.db.prepare("SELECT COUNT(*) AS n FROM task_outbox").get()!.n);
    const result = service.transferTask(root.id, personal, shared, alice, root.version, "transfer-root", true);
    assert.deepEqual(new Set(result.movedTaskIds), new Set(ids));
    assert.equal(result.task.projectId, shared.id);
    assert.equal(result.task.result, root.result);
    assert.equal(result.task.status, "done");
    assert.deepEqual(result.task.evidence, root.evidence);
    for (const id of ids) {
      const moved = service.executeScoped("get_task", { id }, bob, shared) as Task & { history: Record<string, unknown>[]; position: {x:number;y:number}|null };
      const before = beforeRecords.get(id)!;
      assert.equal(moved.ownerId, shared.namespace);
      assert.equal(moved.version, before.version + 1);
      assert.equal(moved.parentId, before.parentId);
      assert.deepEqual(moved.criteria, before.criteria);
      assert.equal(moved.assigneeId, before.assigneeId);
      assert.deepEqual(moved.collaboratorIds, before.collaboratorIds);
      assert.equal(moved.history[0]!.action, "task_transferred");
      assert.equal(moved.history[0]!.actor, alice.id);
      assert.throws(() => service.executeScoped("get_task", { id }, alice, personal), code("NOT_FOUND"));
    }
    for (const entry of beforeHistory) {
      const moved = service.db.prepare("SELECT owner_id,data FROM changes WHERE seq=?").get(entry.seq!);
      assert.equal(moved!.owner_id, shared.namespace);
      assert.equal(moved!.data, entry.data);
    }
    assert.equal(service.db.prepare("SELECT owner_id FROM links WHERE source=? AND target=?").get(child.id, evidence.id)!.owner_id, shared.namespace);
    assert.deepEqual(service.db.prepare("SELECT owner_id,x,y FROM positions WHERE task_id=?").get(evidence.id), Object.assign(Object.create(null), {owner_id:shared.namespace,x:125,y:75}));
    const afterOutbox=Number(service.db.prepare("SELECT COUNT(*) AS n FROM task_outbox").get()!.n);
    assert(afterOutbox >= beforeOutbox + ids.length * 2);
    assert.equal(service.db.prepare("SELECT COUNT(*) AS n FROM task_outbox WHERE event_id LIKE '%:task_transferred' AND event_id NOT LIKE '%:dependency:%'").get()!.n,ids.length);
    const outbox = service.db.prepare("SELECT project_id FROM task_outbox WHERE event_id LIKE '%:task_transferred_out'").all();
    assert.equal(outbox.length, ids.length);
    assert(outbox.every((row) => row.project_id === personal.id));
    assert.deepEqual(service.transferTask(root.id, personal, shared, alice, root.version, "transfer-root", true), result);
    assert.equal(Number(service.db.prepare("SELECT COUNT(*) AS n FROM task_outbox").get()!.n),afterOutbox);
    assert.throws(() => service.transferTask(root.id, personal, shared, alice, root.version + 1, "transfer-root", true), code("IDEMPOTENCY_CONFLICT"));
    service.close();
    service = new TaskService(path);
    assert.deepEqual(service.transferTask(root.id, personal, { ...shared, title: "Новое название" }, alice, root.version, "transfer-root", true), result);
    const exported = service.executeScoped("export_data", {}, bob, shared) as {tasks:Task[];history:Record<string,unknown>[]};
    assert.equal(exported.tasks.length, ids.length);
    assert.equal(exported.history.filter((entry) => entry.action === "task_transferred").length, ids.length);
    assert.throws(() => service.transferTask(root.id, personal, shared, {...alice,scopes:["tasks:read"]}, root.version, "transfer-root", true), code("FORBIDDEN"));
    assert.throws(() => service.execute("get_task", {id:root.id}, {...alice,id:personal.namespace}), code("SHARED_SCOPE_REQUIRED"));
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("personal transfer rejects missing consent, stale scope/version and external dependencies without writes", () => {
  const service = new TaskService(":memory:");
  const actor: Actor = {id:"alice",scopes:["tasks:read","tasks:write"]};
  const personal = {id:"personal",namespace:"private",creatorId:actor.id,personal:true,title:"Личное"};
  const shared = {id:"team",namespace:"team",creatorId:"bob",personal:false,title:"Общий проект"};
  try {
    service.bindProject(personal,actor);
    service.bindProject(shared,actor);
    const root = service.executeScoped("create_task", {projectId:personal.id,title:"Перенос",requestId:"create-root"},actor,personal) as Task;
    const outside = service.executeScoped("create_task", {projectId:personal.id,title:"Не переносить",requestId:"create-outside"},actor,personal) as Task;
    const snapshot = () => JSON.stringify(["records","changes","links","positions","task_outbox","task_transfers","transfer_receipts"].map((table) => service.db.prepare(`SELECT * FROM ${table}`).all()));
    let before=snapshot();
    assert.throws(() => service.transferTask(root.id,personal,shared,actor,root.version,"no-consent",false),code("SHARING_CONFIRMATION_REQUIRED"));
    assert.throws(() => service.transferTask(root.id,personal,shared,actor,root.version+1,"stale",true),code("VERSION_CONFLICT"));
    assert.throws(() => service.transferTask(root.id,personal,{...shared,namespace:"forged"},actor,root.version,"forged",true),code("NOT_FOUND"));
    assert.equal(snapshot(),before);
    const blocked=service.executeScoped("add_dependency",{id:root.id,targetId:outside.id,expectedVersion:root.version,requestId:"external-dependency"},actor,personal) as Task;
    before=snapshot();
    assert.throws(() => service.transferTask(root.id,personal,shared,actor,blocked.version,"linked",true),code("SCOPE_CONFLICT"));
    assert.equal(snapshot(),before);
    const unlinked=service.executeScoped("remove_dependency",{id:root.id,targetId:outside.id,expectedVersion:blocked.version,requestId:"remove-dependency"},actor,personal) as Task;
    before=snapshot();
    assert.throws(() => service.transferTask(root.id,personal,shared,actor,unlinked.version,"historical-link",true),code("SCOPE_CONFLICT"));
    assert.equal(snapshot(),before);
    assert.equal((service.executeScoped("search_tasks",{},actor,personal) as {total:number}).total,2);
    assert.equal((service.executeScoped("search_tasks",{},actor,shared) as {total:number}).total,0);
  } finally {service.close();}
});

test("transfer does not authorize forged foreign project snapshots in retained history", () => {
  const service = new TaskService(":memory:");
  const actor: Actor={id:"alice",scopes:["tasks:read","tasks:write"]};
  const personal={id:"personal",namespace:"private",creatorId:actor.id,personal:true,title:"Личное"};
  const shared={id:"team",namespace:"team",creatorId:"bob",personal:false,title:"Совместное"};
  try {
    service.bindProject(personal,actor);service.bindProject(shared,actor);
    const root=service.executeScoped("create_task",{projectId:personal.id,title:"Задача",requestId:"create-root"},actor,personal) as Task;
    service.transferTask(root.id,personal,shared,actor,root.version,"transfer",true);
    const row=service.db.prepare("SELECT seq,data FROM changes WHERE task_id=? ORDER BY seq LIMIT 1").get(root.id)!;
    const change=JSON.parse(row.data as string);change.after.projectId="unrelated-project";
    service.db.prepare("UPDATE changes SET data=? WHERE seq=?").run(JSON.stringify(change),row.seq!);
    assert.throws(() => service.executeScoped("get_task",{id:root.id},actor,shared),code("SCOPE_CONFLICT"));
  } finally {service.close();}
});


test("legacy project sharing never shares its private category title or category history",()=>{
  const service=new TaskService(":memory:"),owner={id:"legacy",scopes:["tasks:read","tasks:write"]},manager={id:"human",scopes:["tasks:read","tasks:write"]};
  try{
    const category=service.execute("create_category",{title:"Private category metadata",requestId:"private-category"},owner) as {id:string};
    const project=service.execute("create_project",{title:"Explicit shared project",categoryId:category.id,requestId:"shared-project"},owner) as {id:string,title:string};
    const scope={id:project.id,namespace:owner.id,creatorId:manager.id,personal:false,title:project.title};
    service.bindProject(scope,manager);
    const exported=service.executeScoped("export_data",{},manager,scope) as {categories:{title:string}[],history:{taskId:string}[]};
    assert.equal(exported.categories[0]!.title,"Проекты");
    assert(!JSON.stringify(exported).includes("Private category metadata"));
    assert(!exported.history.some(change=>change.taskId===category.id));
    assert.equal(JSON.parse(service.db.prepare("SELECT data FROM records WHERE id=?").get(category.id)!.data as string).title,"Private category metadata");
  }finally{service.close();}
});
