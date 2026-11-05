import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuth, AuthError, validateUrl, type AuthConfig } from "./auth.js";
import { installIntegration } from "./integration.js";
import type { BridgeConfig } from "./ai.js";
import { TaskService, ServiceError } from "./service.js";
import { createMcpServer, definitions } from "./mcp.js";

export type AppConfig = AuthConfig & {
  databasePath: string;
  bridge?: BridgeConfig;
  seedDemo?: boolean;
  staticDir?: string;
};
export function createApp(config: AppConfig) {
  const service = new TaskService(config.databasePath);
  if (config.seedDemo && config.bridge) throw new Error("Demo seed is not allowed with shared identity");
  if (config.seedDemo)
    service.seedDemo({
      id: config.owner,
      scopes: ["tasks:read", "tasks:write"],
    });
  const app = express();
  app.disable("x-powered-by");
  const base = validateUrl(
    config.baseUrl,
    "PUBLIC_BASE_URL",
    config.allowInsecureHttp,
  );
  const allowedOrigins = [
    base.origin,
    ...(config.uiOrigin
      ? [validateUrl(config.uiOrigin, "UI_ORIGIN", config.allowInsecureHttp).origin]
      : []),
  ];
  const allowedHosts = new Set(
    allowedOrigins.map((value) => new URL(value).host),
  );
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (base.protocol === "https:")
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    if (!allowedHosts.has(req.headers.host ?? ""))
      return res
        .status(403)
        .json({ code: "HOST", message: "Недопустимый Host" });
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin))
      return res
        .status(403)
        .json({ code: "ORIGIN", message: "Недопустимый источник запроса" });
    if (req.path.startsWith("/api") || req.path.startsWith("/mcp"))
      res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "10mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  if (config.bridge) installIntegration(app, service, config.bridge);
  else {
  const auth = createAuth(config);
  app.get(
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
    (_req, res) => res.json(auth.metadata()),
  );
  app.get("/api/session", (req, res) => {
    const actor = auth.readSession(req);
    res.json({ authenticated: !!actor, ...(actor ? { actor } : {}) });
  });
  app.post("/api/login", (req, res) =>
    res.json({ authenticated: true, actor: auth.login(req, res) }),
  );
  app.post("/api/logout", (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });
  app.post("/api/tools/:tool", (req, res) => {
    auth.csrf(req);
    const actor = auth.readSession(req);
    if (!actor)
      throw new AuthError(401, "UNAUTHORIZED", "Войдите в приложение");
    const name = String(req.params.tool);
    if (!(name in definitions))
      throw new ServiceError("UNKNOWN_TOOL", "Неизвестная операция", 404);
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      throw new ServiceError("VALIDATION", "Ожидается JSON объект");
    res.json(service.execute(name, req.body, actor));
  });
  app.all("/mcp", async (req, res, next) => {
    try {
      const actor = await auth.bearer(req);
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).end();
        return;
      }
      const mcp = createMcpServer(
        service,
        actor,
        auth.resourceMetadataUrl,
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (error instanceof AuthError)
        auth.challenge(
          res,
          error.status === 403 ? "tasks:read tasks:write" : "tasks:read",
        );
      next(error);
    }
  });
  }
  const staticDir = resolve(config.staticDir ?? "dist");
  if (existsSync(resolve(staticDir, "index.html"))) {
    app.use(express.static(staticDir));
    app.get("/{*path}", (req, res) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/mcp") ||
        req.path.startsWith("/.well-known")
      ) {
        res.status(404).json({ code: "NOT_FOUND" });
        return;
      }
      res.sendFile(resolve(staticDir, "index.html"));
    });
  }
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const known = error instanceof AuthError || error instanceof ServiceError;
      const parserError = error instanceof SyntaxError;
      res.status(known ? error.status : parserError ? 400 : 500).json({
        code: known ? error.code : parserError ? "INVALID_JSON" : "INTERNAL",
        message: known
          ? error.message
          : parserError
            ? "Некорректный JSON"
            : "Внутренняя ошибка сервера",
      });
    },
  );
  return { app, service };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT ?? 3001);
  const config: AppConfig = {
    login: process.env.OWNER_LOGIN ?? "admin",
    password: process.env.OWNER_PASSWORD ?? "",
    owner: process.env.OWNER_SUBJECT ?? "owner",
    baseUrl: process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
    uiOrigin: process.env.UI_ORIGIN ?? "http://127.0.0.1:5173",
    allowInsecureHttp: process.env.ALLOW_INSECURE_HTTP === "true",
    databasePath: process.env.DATABASE_PATH ?? "./data/tasks.sqlite",
    seedDemo: process.env.SEED_DEMO === "true",
    ...(process.env.SK_AI_SOCKET_PATH && process.env.SK_AI_CLIENT_KEY_FILE ? {bridge:{socketPath:process.env.SK_AI_SOCKET_PATH,keyFile:process.env.SK_AI_CLIENT_KEY_FILE,baseUrl:process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,uiOrigin:process.env.UI_ORIGIN}} : {}),
    oauthIssuer: process.env.OAUTH_ISSUER,
    oauthAudience: process.env.OAUTH_AUDIENCE,
    oauthJwksUrl: process.env.OAUTH_JWKS_URL,
  };
  const { app, service } = createApp(config);
  const server = app.listen(port, process.env.HOST ?? "127.0.0.1", () =>
    console.log(`Space: ${config.baseUrl}`),
  );
  const shutdown = () =>
    server.close(() => {
      service.close();
      process.exit(0);
    });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
