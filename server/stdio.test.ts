import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TaskService } from "./service.js";

test("local stdio MCP needs no OAuth and shares persisted UI records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vetvi-stdio-"));
  const databasePath = join(directory, "tasks.sqlite");
  const service = new TaskService(databasePath);
  const actor = {
    id: "stdio-test-owner",
    scopes: ["tasks:read", "tasks:write"],
  };
  service.seedDemo(actor);
  const projects = service.execute("list_projects", {}, actor) as {
    items: { id: string }[];
  };
  const client = new Client({ name: "local-stdio-test", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("server/stdio.ts")],
    cwd: resolve("."),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      DATABASE_PATH: databasePath,
      OWNER_SUBJECT: actor.id,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert(listed.tools.some((t) => t.name === "complete_task"));
    assert.deepEqual(listed.tools[0]._meta?.securitySchemes, [
      { type: "noauth" },
    ]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response.content));
      return (response.structuredContent as { data: any }).data;
    };
    let task = await call("create_task", {
      projectId: projects.items[0].id,
      title: "Создана локальным MCP",
      requestId: randomUUID(),
    });
    assert.equal(
      (service.execute("get_task", { id: task.id }, actor) as { title: string })
        .title,
      task.title,
    );
    task = service.execute(
      "update_task",
      {
        id: task.id,
        expectedVersion: task.version,
        title: "Изменена интерфейсом",
        requestId: randomUUID(),
      },
      actor,
    );
    assert.equal(
      (await call("get_task", { id: task.id })).title,
      "Изменена интерфейсом",
    );
    service.db.exec("BEGIN IMMEDIATE");
    const pending = call("update_task", {
      id: task.id,
      expectedVersion: task.version,
      requestId: randomUUID(),
      description: "Сохранено после параллельной транзакции UI",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    service.db.exec("COMMIT");
    assert.equal(
      (await pending).description,
      "Сохранено после параллельной транзакции UI",
    );
  } finally {
    await client.close();
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdio MCP enforces the archived-branch and delete_task contracts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vetvi-stdio-rules-"));
  const databasePath = join(directory, "tasks.sqlite");
  const service = new TaskService(databasePath);
  const actor = { id: "stdio-rules-owner", scopes: ["tasks:read", "tasks:write"] };
  service.seedDemo(actor);
  const projectId = (
    service.execute("list_projects", {}, actor) as { items: { id: string }[] }
  ).items[0]!.id;
  const client = new Client({ name: "local-stdio-rules", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("server/stdio.ts")],
    cwd: resolve("."),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      DATABASE_PATH: databasePath,
      OWNER_SUBJECT: actor.id,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response.content));
      return (response.structuredContent as { data: any }).data;
    };
    const failure = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert(response.isError, JSON.stringify(response.content));
      return JSON.parse(
        (response.content as { text: string }[])[0]!.text,
      ) as { code: string };
    };
    const root = await call("create_task", {
      projectId,
      title: "Корень",
      requestId: randomUUID(),
    });
    const visible = await call("create_task", {
      projectId,
      parentId: root.id,
      title: "Видимая подзадача",
      requestId: randomUUID(),
    });
    const branch = await call("create_task", {
      projectId,
      parentId: root.id,
      title: "Архивная ветка",
      requestId: randomUUID(),
    });
    const inner = await call("create_task", {
      projectId,
      parentId: branch.id,
      title: "Незавершённый потомок",
      requestId: randomUUID(),
    });
    await call("complete_task", {
      id: visible.id,
      expectedVersion: visible.version,
      result: "Подзадача выполнена",
      requestId: randomUUID(),
    });
    await call("archive_task", {
      id: branch.id,
      expectedVersion: branch.version,
      requestId: randomUUID(),
    });
    assert.equal(
      (
        await failure("create_task", {
          projectId,
          parentId: inner.id,
          title: "Новая задача",
          requestId: randomUUID(),
        })
      ).code,
      "ARCHIVED_PARENT",
    );
    const detail = await call("get_task", { id: root.id });
    assert.equal(detail.openChildren, false);
    assert.equal(detail.progress.percent, 100);
    const done = await call("complete_task", {
      id: root.id,
      expectedVersion: root.version,
      result: "Ветка закрыта",
      requestId: randomUUID(),
    });
    assert.equal(done.status, "done");

    // Distinct refusals must stay distinguishable for the MCP caller.
    const parentA = await call("create_task", {
      projectId,
      title: "Родитель A",
      requestId: randomUUID(),
    });
    const childB = await call("create_task", {
      projectId,
      parentId: parentA.id,
      title: "Подзадача B",
      requestId: randomUUID(),
    });
    const cycle = await failure("add_dependency", {
      id: childB.id,
      expectedVersion: childB.version,
      targetId: parentA.id,
      requestId: randomUUID(),
    });
    assert.equal(cycle.code, "DEPENDENCY_CYCLE");
    const stale = await failure("update_task", {
      id: parentA.id,
      expectedVersion: parentA.version + 5,
      title: "Устаревшая правка",
      requestId: randomUUID(),
    });
    assert.equal(stale.code, "VERSION_CONFLICT");
    assert.equal(
      new Set(["ARCHIVED_PARENT", cycle.code, stale.code]).size,
      3,
      "archived parent, cycle and stale version need separate codes",
    );
    assert.equal(
      (await call("get_task", { id: parentA.id })).title,
      "Родитель A",
    );

    const preview = await call("preview_delete", { id: inner.id });
    assert.deepEqual(preview.ids, [inner.id]);
    assert.equal(
      (
        await failure("delete_task", {
          id: inner.id,
          expectedVersion: inner.version,
          subtree: false,
          previewIds: [],
          requestId: randomUUID(),
        })
      ).code,
      "DELETE_CONFIRMATION",
    );
    const removed = await call("delete_task", {
      id: inner.id,
      expectedVersion: inner.version,
      subtree: false,
      previewIds: preview.ids,
      requestId: randomUUID(),
    });
    assert.ok(removed.deletedAt);
    const branchPreview = await call("preview_delete", { id: branch.id });
    assert.equal(branchPreview.ids.length, 2);
    assert.equal(
      (
        await failure("delete_task", {
          id: branch.id,
          expectedVersion: (
            await call("get_task", { id: branch.id })
          ).version,
          subtree: false,
          previewIds: branchPreview.ids,
          requestId: randomUUID(),
        })
      ).code,
      "DELETE_CONFIRMATION",
    );
  } finally {
    await client.close();
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
