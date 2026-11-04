// Synthetic browser/MCP acceptance fixture. Never use this local issuer in production.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "./index.js";

assert(existsSync(resolve("dist/index.html")), "Build UI first: npm run build");
const baseUrl = "http://127.0.0.1:3002";
const dataDirectory = resolve("data");
mkdirSync(dataDirectory, { recursive: true });
const password = randomBytes(32).toString("base64url");
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "browser-fixture",
  alg: "RS256",
  use: "sig",
};
const issuerServer = createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((done) => issuerServer.listen(0, "127.0.0.1", done));
const address = issuerServer.address();
assert(address && typeof address !== "string");
const issuer = `http://127.0.0.1:${address.port}`;
const config = {
  password,
  owner: "browser-qa-owner",
  baseUrl,
  uiOrigin: baseUrl,
  databasePath: resolve(dataDirectory, "browser-qa.sqlite"),
  seedDemo: true,
  oauthIssuer: issuer,
  oauthAudience: `${baseUrl}/mcp`,
  oauthJwksUrl: `${issuer}/jwks`,
};
let application = createApp(config);
let server: Server;
let client: Client;
async function start() {
  server = application.app.listen(3002, "127.0.0.1");
  await new Promise<void>((done, reject) => {
    server.once("listening", done);
    server.once("error", reject);
  });
  const accessToken = await new SignJWT({ scope: "tasks:read tasks:write" })
    .setProtectedHeader({ alg: "RS256", kid: "browser-fixture", typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(`${baseUrl}/mcp`)
    .setSubject(config.owner)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  client = new Client({ name: "browser-acceptance-fixture", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const separator = cookie.indexOf("=");
  writeFileSync(
    resolve(dataDirectory, "browser-qa-session.json"),
    JSON.stringify({
      cookies: [
        {
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          domain: "127.0.0.1",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 12 * 3600,
          httpOnly: true,
          secure: false,
          sameSite: "Strict",
        },
      ],
      origins: [],
    }),
    { mode: 0o600 },
  );
}
async function stopServer() {
  await client.close();
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  application.service.close();
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result.content));
  return (result.structuredContent as { data: any }).data;
}
await start();
const projects = await call("list_projects");
let task = await call("create_task", {
  projectId: projects.items[0].id,
  title: "Сквозная проверка MCP",
  criteria: ["Проверен сохранённый результат"],
  requestId: randomUUID(),
});
const taskId = task.id;
console.log(JSON.stringify({ ready: true, taskId, url: baseUrl }));
const commands = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});
try {
  for await (const line of commands) {
    try {
      const command = JSON.parse(line) as { action: string };
      if (command.action === "stop") break;
      if (command.action === "inspect") {
        task = await call("get_task", { id: taskId });
        console.log(
          JSON.stringify({
            action: "inspect",
            id: task.id,
            title: task.title,
            version: task.version,
            status: task.status,
          }),
        );
      } else if (command.action === "finish") {
        task = await call("get_task", { id: taskId });
        assert.notEqual(
          task.title,
          "Сквозная проверка MCP",
          "Change title through actual UI before finish",
        );
        assert(
          task.history.some(
            (event: { action: string }) => event.action === "update_task",
          ),
          "UI edit must be in persisted history",
        );
        let child = await call("create_task", {
          projectId: task.projectId,
          parentId: task.id,
          title: "Синтетическая проверка сохранности",
          criteria: ["Изменение интерфейса прочитано через MCP"],
          requestId: randomUUID(),
        });
        child = await call("complete_task", {
          id: child.id,
          expectedVersion: child.version,
          requestId: randomUUID(),
          result: "Синтетический сценарий прочитал сохранённое изменение UI",
          evidenceUrl: "https://example.org/synthetic-browser-qa/child",
        });
        assert.equal(child.status, "done");
        task = await call("complete_task", {
          id: task.id,
          expectedVersion: task.version,
          requestId: randomUUID(),
          result:
            "Изменение UI прочитано через реальный HTTP MCP; дочерняя задача проверена",
          evidenceUrl: "https://example.org/synthetic-browser-qa/root",
        });
        assert.equal(task.status, "done");
        await stopServer();
        application = createApp(config);
        await start();
        task = await call("get_task", { id: taskId });
        assert.equal(task.status, "done");
        assert(
          task.history.some(
            (event: { action: string }) => event.action === "complete_task",
          ),
        );
        assert.equal((await call("get_task", { id: child.id })).status, "done");
        task = await call("reopen_task", {
          id: task.id,
          expectedVersion: task.version,
          requestId: randomUUID(),
          reason: "Проверка повторного открытия после перезапуска",
        });
        assert.equal(task.status, "planned");
        console.log(
          JSON.stringify({
            action: "finish",
            result: "PASS",
            taskId,
            title: task.title,
            version: task.version,
            status: task.status,
            childId: child.id,
            persistedAfterRestart: true,
            historyPreserved: true,
          }),
        );
      } else console.log(JSON.stringify({ error: "Unknown action" }));
    } catch (error) {
      console.log(
        JSON.stringify({
          result: "FAIL",
          message: error instanceof Error ? error.message : "Fixture failure",
        }),
      );
    }
  }
} finally {
  commands.close();
  process.stdin.pause();
  await stopServer();
  issuerServer.closeAllConnections();
  await new Promise<void>((done) => issuerServer.close(() => done()));
}
