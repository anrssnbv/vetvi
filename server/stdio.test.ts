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
