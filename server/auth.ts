import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type Actor = { id: string; scopes: string[] };
export type AuthConfig = {
  login?: string;
  password: string;
  owner: string;
  baseUrl: string;
  uiOrigin?: string;
  allowInsecureHttp?: boolean;
  oauthIssuer?: string;
  oauthAudience?: string;
  oauthJwksUrl?: string;
};
export class AuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const isLoopback = (url: URL) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
export function validateUrl(
  value: string,
  label: string,
  allowInsecureHttp = false,
): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (isLoopback(url) || allowInsecureHttp)))
  ) {
    throw new Error(
      `${label}: HTTPS required except on loopback; credentials/query/fragment forbidden`,
    );
  }
  return url;
}
export function createAuth(config: AuthConfig) {
  const ownerLogin = config.login ?? "admin";
  if (!ownerLogin.trim() || ownerLogin.length > 200)
    throw new Error("OWNER_LOGIN must contain 1 to 200 characters");
  if (config.password.length < 12)
    throw new Error("OWNER_PASSWORD must contain at least 12 characters");
  const base = validateUrl(
    config.baseUrl,
    "PUBLIC_BASE_URL",
    config.allowInsecureHttp,
  );
  const uiOrigin = config.uiOrigin
    ? validateUrl(config.uiOrigin, "UI_ORIGIN", config.allowInsecureHttp).origin
    : base.origin;
  const cookiePath = base.pathname.replace(/\/+$/, "") || "/";
  const publicBase = `${base.origin}${cookiePath === "/" ? "" : cookiePath}`;
  const resource = `${publicBase}/mcp`;
  const resourceMetadataUrl = `${publicBase}/.well-known/oauth-protected-resource/mcp`;
  const salt = randomBytes(32);
  const passwordHash = scryptSync(config.password, salt, 64);
  const loginHash = createHash("sha256").update(ownerLogin).digest();
  const secure = base.protocol === "https:";
  const sessions = new Map<string, { expires: number }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const cookieName = secure
    ? cookiePath === "/"
      ? "__Host-task_session"
      : "__Secure-task_session"
    : "task_session";
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const owner: Actor = {
    id: config.owner,
    scopes: ["tasks:read", "tasks:write"],
  };
  const oauthValues = [
    config.oauthIssuer,
    config.oauthAudience,
    config.oauthJwksUrl,
  ];
  if (oauthValues.some(Boolean) && !oauthValues.every(Boolean))
    throw new Error(
      "Configure all OAUTH_ISSUER, OAUTH_AUDIENCE and OAUTH_JWKS_URL",
    );
  if (config.oauthIssuer && !secure && !isLoopback(base))
    throw new Error("OAuth MCP requires HTTPS on public origins");
  if (config.oauthAudience && config.oauthAudience !== resource)
    throw new Error("OAUTH_AUDIENCE must equal the public MCP URL");
  const issuer = config.oauthIssuer
    ? validateUrl(config.oauthIssuer, "OAUTH_ISSUER")
    : undefined;
  const jwks = config.oauthJwksUrl
    ? createRemoteJWKSet(validateUrl(config.oauthJwksUrl, "OAUTH_JWKS_URL"), {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
      })
    : undefined;
  function csrf(req: Request) {
    if (![base.origin, uiOrigin].includes(req.headers.origin ?? ""))
      throw new AuthError(403, "ORIGIN", "Недопустимый источник запроса");
  }
  function readSession(req: Request): Actor | undefined {
    const raw = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!raw) return;
    const key = hash(raw);
    const session = sessions.get(key);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(key);
      return;
    }
    return owner;
  }
  function login(req: Request, res: Response) {
    csrf(req);
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const ip = req.socket.remoteAddress ?? "unknown";
    const attempt = attempts.get(ip) ?? { count: 0, until: now + 15 * 60000 };
    if (attempt.count >= 8)
      throw new AuthError(
        429,
        "RATE_LIMIT",
        "Слишком много попыток. Повторите через 15 минут",
      );
    attempt.count += 1;
    attempts.set(ip, attempt);
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";
    const username =
      typeof req.body?.username === "string" ? req.body.username : "";
    const validPassword =
      password.length <= 1024 &&
      timingSafeEqual(scryptSync(password, salt, 64), passwordHash);
    const validLogin =
      username.length <= 200 &&
      timingSafeEqual(createHash("sha256").update(username).digest(), loginHash);
    if (!validPassword || !validLogin)
      throw new AuthError(401, "UNAUTHORIZED", "Неверный логин или пароль");
    attempts.delete(ip);
    for (const [key, session] of sessions)
      if (session.expires <= now) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    sessions.set(hash(token), { expires: now + 12 * 3600000 });
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: cookiePath,
      maxAge: 12 * 3600000,
    });
    return owner;
  }
  function logout(req: Request, res: Response) {
    csrf(req);
    const raw = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (raw) sessions.delete(hash(raw));
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: cookiePath,
    });
  }
  async function bearer(req: Request): Promise<Actor> {
    if (!jwks || !issuer)
      throw new AuthError(
        401,
        "OAUTH_NOT_CONFIGURED",
        "OAuth пока не настроен",
      );
    const token = /^Bearer ([^\s]+)$/i.exec(
      req.headers.authorization ?? "",
    )?.[1];
    if (!token)
      throw new AuthError(401, "UNAUTHORIZED", "Требуется OAuth access token");
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.oauthIssuer,
        audience: config.oauthAudience,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (payload.sub !== config.owner)
        throw new AuthError(
          403,
          "FORBIDDEN",
          "Владелец токена не имеет доступа",
        );
      const scopes =
        typeof payload.scope === "string"
          ? payload.scope
              .split(" ")
              .filter((v) => ["tasks:read", "tasks:write"].includes(v))
          : [];
      if (!scopes.includes("tasks:read"))
        throw new AuthError(403, "INSUFFICIENT_SCOPE", "Требуется tasks:read");
      return { id: payload.sub, scopes };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        401,
        "INVALID_TOKEN",
        "Токен недействителен или истёк",
      );
    }
  }
  function challenge(res: Response, scope = "tasks:read") {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scope}"`,
    );
  }
  return {
    resource,
    resourceMetadataUrl,
    csrf,
    readSession,
    login,
    logout,
    bearer,
    challenge,
    metadata: () => ({
      resource,
      authorization_servers: issuer ? [config.oauthIssuer] : [],
      scopes_supported: ["tasks:read", "tasks:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Space",
    }),
  };
}
