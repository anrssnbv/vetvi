import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Request, Response, CookieOptions } from "express";
import { createBridge } from "./ai.js";
import { TaskService, ServiceError } from "./service.js";

const origin = "http://127.0.0.1:3400";
const prefix = "/platform/api/v1/integrations/vetvi";
function browser(cookie = "", body: unknown = undefined, extra: Record<string, string> = {}) {
  return { headers: { origin, cookie, ...extra }, body } as Request;
}
function response() {
  const cookies: { name: string; value: string; options: CookieOptions }[] = [];
  const cleared: { name: string; options: CookieOptions }[] = [];
  const res = {
    cookie(name: string, value: string, options: CookieOptions) { cookies.push({ name, value, options }); },
    clearCookie(name: string, options: CookieOptions) { cleared.push({ name, options }); },
  } as unknown as Response;
  return { res, cookies, cleared };
}
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vetvi-bridge-"));
  const socketPath = join(directory, "bridge.sock"), keyFile = join(directory, "client.key");
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  const sessions = new Map<string, { id: string; role: string; expires_at: string }>();
  const seen: { path: string; headers: IncomingHttpHeaders; body: any }[] = [];
  let mode = "normal";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ path: req.url!, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    if (mode === "inactive") { res.statusCode = 409; res.end(JSON.stringify({ detail: "vetvi_task_inactive" })); return; }
    if (mode === "oversize") { res.end(JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) })); return; }
    if (mode === "redirect") { res.writeHead(302, { Location: "https://example.invalid/secret" }); res.end(); return; }
    if (mode === "malformed") { res.end("invalid JSON"); return; }
    if (mode === "unavailable") { res.statusCode = 500; res.end(JSON.stringify({ detail: key })); return; }
    if (req.headers["x-vetvi-client-key"] !== key || req.headers.origin || req.headers.cookie || req.headers.authorization) {
      res.statusCode = 401; res.end("{}"); return;
    }
    if (req.url === `${prefix}/sessions` && req.method === "POST") {
      if (body.username !== "manager" || body.password !== "synthetic-password") {
        res.statusCode = 401; res.end(JSON.stringify({ detail: "synthetic-password" })); return;
      }
      const handle = randomBytes(32).toString("base64url");
      const current = { id: "human-manager", role: "manager", expires_at: new Date(Date.now() + 3600000).toISOString() };
      sessions.set(handle, current);
      res.end(JSON.stringify({ session: handle, expires_at: current.expires_at, actor: { id: current.id, role: current.role } }));
      return;
    }
    const handle = String(req.headers["x-vetvi-session"] ?? ""), current = sessions.get(handle);
    if (!current) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "DELETE") {
      sessions.delete(handle); res.statusCode = 204; res.end(); return;
    }
    res.end(JSON.stringify({ actor: { id: current.id, display_name: "Менеджер", role: current.role }, expires_at: current.expires_at }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return {
    directory, socketPath, keyFile, sessions, seen,
    config: { socketPath, keyFile, baseUrl: `${origin}/space/` },
    setMode(value: string) { mode = value; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("private bridge sessions encrypt handles, survive restart and recheck current individual identity", async () => {
  const f = await fixture();
  const databasePath = join(f.directory, "tasks.sqlite");
  let service = new TaskService(databasePath);
  let bridge = createBridge(f.config, service);
  try {
    const output = response();
    const result = await bridge.login(browser("", { username: "manager", password: "synthetic-password", actor: { id: "forged-admin", role: "admin" } }, { "x-vetvi-session": "forged", authorization: "Bearer forged" }), output.res);
    assert.equal(result.actor.id, "human-manager");
    assert.equal(result.identity.actor.role, "manager");
    assert(!JSON.stringify(result).includes("session"));
    const cookie = output.cookies[0]!;
    assert.equal(cookie.name, "bridge_session");
    assert.equal(cookie.options.path, "/space");
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.sameSite, "strict");
    assert.equal(cookie.options.secure, false);
    const cookieHeader = `${cookie.name}=${cookie.value}`;
    const handle = [...f.sessions.keys()][0]!;
    const row = service.db.prepare("SELECT * FROM bridge_sessions").get()!;
    assert(!JSON.stringify(row).includes(handle));
    assert(!JSON.stringify(row).includes(cookie.value));
    assert(!JSON.stringify(row).includes("synthetic-password"));
    assert.equal(f.seen[0]!.headers.authorization, undefined);
    assert.deepEqual(f.seen[0]!.body, { username: "manager", password: "synthetic-password" });
    const before = f.seen.length;
    assert.equal((await bridge.session(browser(cookieHeader, undefined, { "x-user-id": "forged" })))!.actor.id, "human-manager");
    assert.equal(f.seen.length, before + 1);
    f.sessions.get(handle)!.role = "admin";
    assert.equal((await bridge.session(browser(cookieHeader)))!.identity.actor.role, "admin");
    service.close();
    service = new TaskService(databasePath);
    bridge = createBridge(f.config, service);
    assert.equal((await bridge.session(browser(cookieHeader)))!.actor.id, "human-manager");
    assert.equal(await bridge.session(browser(`bridge_session=${randomBytes(32).toString("base64url")}`)), undefined);
    assert.equal(await bridge.session(browser(`${cookieHeader}; ${cookieHeader}`)), undefined);
    f.sessions.delete(handle);
    assert.equal(await bridge.session(browser(cookieHeader)), undefined);
    assert.equal(service.db.prepare("SELECT 1 FROM bridge_sessions").get(), undefined);
  } finally { service.close(); await f.close(); }
});

test("bridge logout revokes remotely, expiry and key rotation invalidate local sessions", async () => {
  const f = await fixture();
  const service = new TaskService(":memory:");
  let bridge = createBridge(f.config, service);
  async function login() {
    const out = response();
    await bridge.login(browser("", { username: "manager", password: "synthetic-password" }), out.res);
    return `bridge_session=${out.cookies[0]!.value}`;
  }
  try {
    let cookie = await login();
    const out = response();
    await bridge.logout(browser(cookie), out.res);
    assert.equal(f.sessions.size, 0);
    assert.equal(out.cleared[0]!.options.path, "/space");
    assert.equal(await bridge.session(browser(cookie)), undefined);
    cookie = await login();
    service.db.prepare("UPDATE bridge_sessions SET expires_at=?").run(Date.now() - 1);
    const seen = f.seen.length;
    assert.equal(await bridge.session(browser(cookie)), undefined);
    assert.equal(f.seen.length, seen);
    cookie = await login();
    f.setMode("unavailable");
    const failedLogout = response();
    await assert.rejects(bridge.logout(browser(cookie), failedLogout.res), code("AGENT_UNAVAILABLE"));
    assert.equal(failedLogout.cleared[0]!.name, "bridge_session");
    assert.equal(await bridge.session(browser(cookie)), undefined);
    f.setMode("normal");
    cookie = await login();
    writeFileSync(f.keyFile, randomBytes(32).toString("hex"));
    bridge = createBridge(f.config, service);
    assert.equal(await bridge.session(browser(cookie)), undefined);
    assert.equal(service.db.prepare("SELECT 1 FROM bridge_sessions").get(), undefined);
  } finally { service.close(); await f.close(); }
});

test("bridge transport rejects redirects, oversized/malformed responses, forwarding and unsafe keys", async () => {
  const f = await fixture();
  const service = new TaskService(":memory:");
  const bridge = createBridge(f.config, service);
  try {
    await assert.rejects(bridge.login(browser("", { username: "manager", password: "wrong" }), response().res), code("UNAUTHORIZED"));
    assert.equal(service.db.prepare("SELECT 1 FROM bridge_sessions").get(), undefined);
    assert.throws(() => bridge.csrf(browser("", undefined, { origin: "http://attacker.invalid" })), code("ORIGIN"));
    for (const mode of ["redirect", "oversize", "malformed", "unavailable"]) {
      f.setMode(mode);
      await assert.rejects(bridge.call("GET", "/sessions/current"), code("AGENT_UNAVAILABLE"));
    }
    await assert.rejects(bridge.call("GET", "/sessions/current", undefined, undefined, { Cookie: "forged" }), code("AGENT_UNAVAILABLE"));
    await assert.rejects(bridge.call("GET", "/../auth"), code("AGENT_UNAVAILABLE"));
    await assert.rejects(bridge.call("GET", "/%2e%2e/auth"), code("AGENT_UNAVAILABLE"));
    await assert.rejects(bridge.call("GET", "/%2f..%2fauth"), code("AGENT_UNAVAILABLE"));
    await assert.rejects(bridge.call("GET", "/sessions/current", undefined, "bad\r\nheader"), code("AGENT_UNAVAILABLE"));
    chmodSync(f.keyFile, 0o644);
    assert.throws(() => createBridge(f.config, service));
    chmodSync(f.keyFile, 0o600);
    const linked = join(f.directory, "linked.key");
    symlinkSync(f.keyFile, linked);
    assert.throws(() => createBridge({ ...f.config, keyFile: linked }, service));
    writeFileSync(f.keyFile, "short");
    assert.throws(() => createBridge(f.config, service));
  } finally { service.close(); await f.close(); }
});


test("closed-task conflicts explain the required task action", async () => {
  const f = await fixture();
  const service = new TaskService(":memory:");
  try {
    f.setMode("inactive");
    await assert.rejects(createBridge(f.config, service).call("POST", "/conversations/test/turns", {}),
      (error: unknown) => error instanceof ServiceError && error.status === 409 &&
        error.code === "TASK_INACTIVE" && error.message.includes("верните её в работу"));
  } finally { service.close(); await f.close(); }
});


test("moving the public prefix requires a fresh scoped session", async () => {
  const f = await fixture();
  const service = new TaskService(join(f.directory, "tasks.sqlite"));
  try {
    const old = createBridge({ ...f.config, baseUrl: `${origin}/vetvi/` }, service);
    const login = response();
    await old.login(browser("", { username: "manager", password: "synthetic-password" }), login.res);
    const token = `bridge_session=${login.cookies[0]!.value}`;
    const current = createBridge(f.config, service);
    assert.equal(await current.session(browser(token)), undefined);
    const fresh = response();
    await current.login(browser("", { username: "manager", password: "synthetic-password" }), fresh.res);
    assert.equal(fresh.cookies[0]!.options.path, "/space");
    assert.equal((await current.session(browser(`bridge_session=${fresh.cookies[0]!.value}`)))?.actor.id, "human-manager");
  } finally { service.close(); await f.close(); }
});
