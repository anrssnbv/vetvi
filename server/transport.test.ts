import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "./index.js";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("real HTTP MCP and UI API share result-only completion, persistence, versions and OAuth protection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vetvi-http-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  const authorization = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/jwks" ? { keys: [jwk] } : {}));
  });
  const issuer = await listen(authorization);
  let server = createServer();
  let baseUrl = await listen(server);
  const password = `test-password-${randomUUID()}`;
  const username = "local-owner";
  const config = () => ({
    login: username,
    password,
    owner: "owner",
    baseUrl,
    databasePath: join(directory, "tasks.sqlite"),
    seedDemo: true,
    oauthIssuer: issuer,
    oauthAudience: `${baseUrl}/mcp`,
    oauthJwksUrl: `${issuer}/jwks`,
  });
  let current = createApp(config());
  server.on("request", current.app);
  async function token(
    subject = "owner",
    scope = "tasks:read tasks:write",
    audience = `${baseUrl}/mcp`,
  ) {
    return new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "at+jwt" })
      .setIssuer(issuer)
      .setSubject(subject)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }
  let client: Client | undefined;
  try {
    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate")!, /resource_metadata=/);
    const metadata = await (
      await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    assert.equal(metadata.resource, `${baseUrl}/mcp`);
    assert.deepEqual(metadata.authorization_servers, [issuer]);
    assert.equal(
      (
        await fetch(`${baseUrl}/mcp`, {
          headers: { Authorization: `Bearer ${await token("intruder")}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/mcp`, {
          headers: {
            Authorization: `Bearer ${await token("owner", "tasks:read", "https://wrong.example/mcp")}`,
          },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/mcp`, {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/tools/list_projects`, {
          method: "POST",
          headers: { Origin: baseUrl, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/login`, {
          method: "POST",
          headers: {
            Origin: "https://attacker.example",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username, password }),
        })
      ).status,
      403,
    );
    let cookie = "";
    for (const credentials of [
      { username: "wrong-owner", password },
      { username, password: "wrong-password" },
      { password },
    ]) {
      const response = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
      const denied = await response.json();
      assert.equal(denied.message, "Неверный логин или пароль");
      assert(!JSON.stringify(denied).includes(password));
    }
    async function login() {
      const response = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      const header = response.headers.get("set-cookie")!;
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Strict/i);
      cookie = header.split(";")[0];
    }
    async function api(name: string, args: Record<string, unknown>) {
      const response = await fetch(`${baseUrl}/api/tools/${name}`, {
        method: "POST",
        headers: {
          Origin: baseUrl,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      });
      return { status: response.status, data: await response.json() };
    }
    await login();
    client = new Client({ name: "acceptance-test", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${await token()}` } },
      }),
    );
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "complete_task"));
    const wireResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wire-list",
        method: "tools/list",
        params: {},
      }),
    });
    const wireTools = (await wireResponse.json()).result.tools as {
      name: string;
      securitySchemes: unknown;
    }[];
    assert.deepEqual(
      wireTools.find((tool) => tool.name === "complete_task")?.securitySchemes,
      [{ type: "oauth2", scopes: ["tasks:write"] }],
    );
    assert.deepEqual(
      wireTools.find((tool) => tool.name === "get_task")?.securitySchemes,
      [{ type: "oauth2", scopes: ["tasks:read"] }],
    );
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client!.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return (result.structuredContent as { data: any }).data;
    }
    const projects = await call("list_projects");
    const args = {
      requestId: randomUUID(),
      projectId: projects.items[0].id,
      title: "MCP → UI",
    };
    let task = await call("create_task", args);
    assert.equal((await call("create_task", args)).id, task.id);
    const visible = await api("search_tasks", { projectId: task.projectId });
    assert(
      visible.data.items.some((item: { id: string }) => item.id === task.id),
    );
    task = (
      await api("update_task", {
        id: task.id,
        expectedVersion: task.version,
        requestId: randomUUID(),
        title: "Изменено в UI",
      })
    ).data;
    assert.equal(
      (await call("get_task", { id: task.id })).title,
      "Изменено в UI",
    );
    const conflict = await api("update_task", {
      id: task.id,
      expectedVersion: task.version - 1,
      requestId: randomUUID(),
      title: "Устаревшая версия",
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      (
        await api("update_task", {
          id: task.id,
          expectedVersion: task.version,
          requestId: randomUUID(),
          status: "done",
        })
      ).status,
      400,
    );
    let child = await call("create_task", {
      requestId: randomUUID(),
      projectId: task.projectId,
      parentId: task.id,
      title: "Проверка",
    });
    const premature = await client.callTool({
      name: "complete_task",
      arguments: {
        id: task.id,
        expectedVersion: task.version,
        requestId: randomUUID(),
        result: "Проверено",
        evidenceUrl: "https://example.com/proof",
      },
    });
    assert.equal(premature.isError, true);
    child = await call("complete_task", {
      id: child.id,
      expectedVersion: child.version,
      requestId: randomUUID(),
      result: "Результат проверен тестом",
    });
    assert.equal(child.status, "done");
    task = await call("complete_task", {
      id: task.id,
      expectedVersion: task.version,
      requestId: randomUUID(),
      result: "Все критерии проверены",
    });
    const doneId = task.id;
    await client.close();
    client = undefined;
    await close(server);
    current.service.close();
    server = createServer();
    baseUrl = await listen(server);
    current = createApp(config());
    server.on("request", current.app);
    await login();
    task = (await api("get_task", { id: doneId })).data;
    assert.equal(task.status, "done");
    assert(
      task.history.some(
        (event: { action: string }) => event.action === "complete_task",
      ),
    );
    task = (
      await api("reopen_task", {
        id: task.id,
        expectedVersion: task.version,
        requestId: randomUUID(),
        reason: "Дополнительная проверка",
      })
    ).data;
    assert.equal(task.status, "planned");
    const preview = (await api("preview_delete", { id: task.id })).data;
    task = (
      await api("delete_task", {
        id: task.id,
        expectedVersion: task.version,
        requestId: randomUUID(),
        subtree: true,
        previewIds: preview.ids,
      })
    ).data;
    assert(task.deletedAt);
    task = (
      await api("restore_task", {
        id: task.id,
        expectedVersion: task.version,
        requestId: randomUUID(),
      })
    ).data;
    assert.equal(task.deletedAt, null);
    assert.equal(
      (await api("get_task", { id: child.id })).data.deletedAt,
      null,
    );
    const readonly = new Client({ name: "readonly-test", version: "1.0" });
    await readonly.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${await token("owner", "tasks:read")}`,
          },
        },
      }),
    );
    const denied = await readonly.callTool({
      name: "create_task",
      arguments: {
        requestId: randomUUID(),
        projectId: task.projectId,
        title: "Запрещено",
      },
    });
    assert.equal(denied.isError, true);
    await readonly.close();
    await fetch(`${baseUrl}/api/logout`, {
      method: "POST",
      headers: { Origin: baseUrl, Cookie: cookie },
    });
    assert.equal((await api("list_projects", {})).status, 401);
  } finally {
    await client?.close();
    await close(server);
    current.service.close();
    await close(authorization);
    rmSync(directory, { recursive: true, force: true });
  }
});
