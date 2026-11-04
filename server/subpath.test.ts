import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index.js";
import { createAuth, validateUrl } from "./auth.js";

// Node fetch rewrites Host; use the HTTP client to exercise a reverse proxy's actual header.
function send(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

test("public HTTP needs an explicit UI opt-in and never relaxes OAuth URLs", () => {
  const config = {
    password: "synthetic-owner-password",
    owner: "owner",
    baseUrl: "http://92.46.191.252/vetvi/",
  };
  assert.throws(() => createAuth(config), /HTTPS required/);
  assert.doesNotThrow(() => createAuth({ ...config, allowInsecureHttp: true }));
  for (const url of [
    "http://owner:secret@example.com/",
    "http://example.com/?secret=value",
    "http://example.com/#fragment",
    "ftp://example.com/",
  ]) assert.throws(() => validateUrl(url, "UI_ORIGIN", true));
  assert.throws(
    () => createAuth({
      ...config,
      allowInsecureHttp: true,
      oauthIssuer: "https://identity.example.com/",
      oauthAudience: "http://92.46.191.252/vetvi/mcp",
      oauthJwksUrl: "https://identity.example.com/jwks",
    }),
    /OAuth MCP requires HTTPS/,
  );
  assert.throws(
    () => createAuth({
      ...config,
      baseUrl: "https://92.46.191.252/vetvi/",
      allowInsecureHttp: true,
      oauthIssuer: "http://identity.example.com/",
      oauthAudience: "https://92.46.191.252/vetvi/mcp",
      oauthJwksUrl: "https://identity.example.com/jwks",
    }),
    /HTTPS required/,
  );
});

test("a stripped proxy prefix preserves API auth, cookie scope and public metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vetvi-prefix-"));
  const origin = "http://92.46.191.252";
  const { app, service } = createApp({
    login: "admin",
    password: "synthetic-owner-password",
    owner: "owner",
    baseUrl: `${origin}/vetvi/`,
    uiOrigin: origin,
    allowInsecureHttp: true,
    databasePath: join(directory, "tasks.sqlite"),
    seedDemo: true,
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const upstream = `http://127.0.0.1:${address.port}`;
  const headers = { Host: "92.46.191.252", Origin: origin, "Content-Type": "application/json" };
  const credentials = JSON.stringify({ username: "admin", password: "synthetic-owner-password" });
  try {
    assert.equal((await send(`${upstream}/health`)).status, 403);
    assert.equal((await send(`${upstream}/health`, { headers })).status, 200);
    assert.equal((await send(`${upstream}/api/tools/list_projects`, {
      method: "POST", headers, body: "{}",
    })).status, 401);
    for (const badOrigin of ["http://attacker.example", ""]) {
      assert.equal((await send(`${upstream}/api/login`, {
        method: "POST", headers: { ...headers, Origin: badOrigin }, body: credentials,
      })).status, 403);
    }
    const login = await send(`${upstream}/api/login`, {
      method: "POST", headers, body: credentials,
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie")!;
    assert.match(setCookie, /^task_session=/);
    assert.match(setCookie, /Path=\/vetvi;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert(!setCookie.includes("Secure"));
    const cookie = setCookie.split(";")[0];
    const projects = await send(`${upstream}/api/tools/list_projects`, {
      method: "POST", headers: { ...headers, Cookie: cookie }, body: "{}",
    });
    assert.equal(projects.status, 200);
    assert.equal((await projects.json()).total, 1);
    const metadata = await (await send(`${upstream}/.well-known/oauth-protected-resource/mcp`, { headers })).json();
    assert.equal(metadata.resource, `${origin}/vetvi/mcp`);
    const mcp = await send(`${upstream}/mcp`, { method: "POST", headers, body: "{}" });
    assert.equal(mcp.status, 401);
    assert(mcp.headers.get("www-authenticate")!.includes(`${origin}/vetvi/.well-known/oauth-protected-resource/mcp`));
    const logout = await send(`${upstream}/api/logout`, {
      method: "POST", headers: { ...headers, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie")!, /Path=\/vetvi;/);
    assert.equal((await (await send(`${upstream}/api/session`, { headers: { ...headers, Cookie: cookie } })).json()).authenticated, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
