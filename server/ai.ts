import { request } from "node:http";
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { Request, Response } from "express";
import { ServiceError, type Actor, type TaskService } from "./service.js";

export type BridgeConfig = {
  socketPath: string;
  keyFile: string;
  basePath?: string;
  baseUrl: string;
  uiOrigin?: string;
};
type Identity = {
  actor: { id: string; display_name: string; role: "admin" | "manager" };
  expires_at: string;
};
const unavailable = () => new ServiceError("AGENT_UNAVAILABLE", "Сервис помощника временно недоступен. Повторите позже.", 503);
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function createBridge(config: BridgeConfig, service: TaskService) {
  const base = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
    !isAbsolute(config.socketPath) || !isAbsolute(config.keyFile))
    throw new Error("Некорректная конфигурация подключения помощника");
  const prefix = (config.basePath ?? "/platform/api/v1/integrations/vetvi").replace(/\/+$/, "");
  if (!prefix.startsWith("/") || /[?#\\\r\n]/.test(prefix) || prefix.split("/").some((part) => part === ".." || part === "."))
    throw new Error("Некорректный путь подключения помощника");
  const cookiePath = base.pathname.replace(/\/+$/, "") || "/";
  const cookieOptions = { httpOnly: true, secure: base.protocol === "https:", sameSite: "strict" as const, path: cookiePath };
  const origins = new Set([base.origin, ...(config.uiOrigin ? [new URL(config.uiOrigin).origin] : [])]);
  let key: string;
  const descriptor = openSync(config.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 4097)
      throw new Error("Ключ подключения должен быть обычным защищённым файлом 0600");
    key = readFileSync(descriptor, "utf8").replace(/\n+$/, "");
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(key))
      throw new Error("Некорректный ключ подключения помощника");
  } finally {
    closeSync(descriptor);
  }
  const encryptionKey = createHash("sha256").update(key).update("\0vetvi-browser-session-v1").digest();
  const aad = (hash: string) => Buffer.from(`${base.origin}\0${cookiePath}\0${hash}`);
  function encrypt(handle: string, hash: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(aad(hash));
    const ciphertext = Buffer.concat([cipher.update(handle, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  }
  function decrypt(ciphertext: string, hash: string) {
    const parts = ciphertext.split(".").map((part) => Buffer.from(part, "base64url"));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16) throw unavailable();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, parts[0]!);
    decipher.setAAD(aad(hash));
    decipher.setAuthTag(parts[1]!);
    const handle = Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString("utf8");
    if (!/^[A-Za-z0-9_-]{32,4096}$/.test(handle)) throw unavailable();
    return handle;
  }
  async function call(method: string, path: string, body?: unknown, handle?: string, headers: Record<string, string> = {}): Promise<any> {
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !path.startsWith("/") || path.startsWith("//") || /[\\#\r\n]/.test(path))
      throw unavailable();
    try {
      const decoded = decodeURIComponent(path.split("?")[0]!);
      if (/[\\#?\r\n]/.test(decoded) || decoded.includes("//") ||
        decoded.split("/").some((part) => [".", ".."].includes(part))) throw unavailable();
    } catch { throw unavailable(); }
    if (handle !== undefined && !/^[A-Za-z0-9_-]{32,4096}$/.test(handle)) throw unavailable();
    const safeHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!["idempotency-key", "if-match"].includes(name.toLowerCase()) || /[\r\n]/.test(value)) throw unavailable();
      safeHeaders[name] = value;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > 2 * 1024 * 1024) throw new ServiceError("VALIDATION", "Слишком большой запрос", 400);
    return new Promise((resolve, reject) => {
      const outbound = request({
        socketPath: config.socketPath,
        path: `${prefix}${path}`,
        method,
        headers: {
          ...safeHeaders,
          Host: base.host,
          "X-Vetvi-Client-Key": key,
          ...(handle ? { "X-Vetvi-Session": handle } : {}),
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            reject(unavailable());
            outbound.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => reject(unavailable()));
        response.on("end", () => {
          const status = response.statusCode ?? 503;
          if (status < 200 || status >= 300) {
            const errors: Record<number, [string, string]> = {
              400: ["VALIDATION", "Проверьте данные запроса."],
              401: ["UNAUTHORIZED", "Сессия истекла. Войдите снова."],
              403: ["FORBIDDEN", "Недостаточно прав для этого действия."],
              404: ["NOT_FOUND", "Запись не найдена или недоступна."],
              409: ["VERSION_CONFLICT", "Данные изменились. Обновите их перед повтором."],
              422: ["VALIDATION", "Проверьте данные запроса."],
              429: ["RATE_LIMIT", "Слишком много запросов. Повторите позже."],
            };
            let detail: unknown;
            try { detail = JSON.parse(Buffer.concat(chunks).toString("utf8")).detail; } catch { /* Keep unknown errors generic. */ }
            if (status === 409 && detail === "vetvi_task_inactive") {
              reject(new ServiceError("TASK_INACTIVE", "Задача завершена, отменена или убрана в архив. Для новых сообщений и файлов верните её в работу.", 409));
              return;
            }
            const error = errors[status];
            reject(error ? new ServiceError(error[0], error[1], status) : unavailable());
            return;
          }
          if (status === 204) { resolve(undefined); return; }
          if ((response.headers["content-type"] ?? "").startsWith("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
            resolve(Buffer.concat(chunks)); return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(unavailable()); }
        });
      });
      const timeout = setTimeout(() => { reject(unavailable()); outbound.destroy(); }, 10000);
      outbound.on("close", () => clearTimeout(timeout));
      outbound.on("error", () => reject(unavailable()));
      outbound.end(payload);
    });
  }
  function csrf(req: Request) {
    if (!origins.has(req.headers.origin ?? ""))
      throw new ServiceError("ORIGIN", "Недопустимый источник запроса", 403);
  }
  function cookieHash(req: Request) {
    const values = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith("bridge_session="));
    if (values.length !== 1) return;
    const token = values[0]!.slice("bridge_session=".length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    return tokenHash(token);
  }
  function remove(hash: string) {
    service.db.prepare("DELETE FROM bridge_sessions WHERE token_hash=?").run(hash);
  }
  function identity(data: any): Identity {
    if (!data || !data.actor || typeof data.actor.id !== "string" || !data.actor.id || data.actor.id.length > 200 ||
      !["admin", "manager"].includes(data.actor.role) || typeof data.expires_at !== "string" ||
      !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now()) throw unavailable();
    return {
      actor: { id: data.actor.id, display_name: typeof data.actor.display_name === "string" ? data.actor.display_name.slice(0, 200) : "", role: data.actor.role },
      expires_at: data.expires_at,
    };
  }
  function actor(current: Identity): Actor {
    return { id: current.actor.id, scopes: ["tasks:read", "tasks:write"] };
  }
  async function session(req: Request) {
    const hash = cookieHash(req);
    if (!hash) return;
    const row = service.db.prepare("SELECT ciphertext,expires_at FROM bridge_sessions WHERE token_hash=?").get(hash);
    if (!row) return;
    if (Number(row.expires_at) <= Date.now()) { remove(hash); return; }
    let handle: string;
    try { handle = decrypt(row.ciphertext as string, hash); }
    catch { remove(hash); return; }
    try {
      const current = identity(await call("GET", "/sessions/current", undefined, handle));
      return { handle, actor: actor(current), identity: current };
    } catch (error) {
      if (error instanceof ServiceError && [401, 403, 404].includes(error.status)) { remove(hash); return; }
      throw error;
    }
  }
  async function logout(req: Request, res: Response) {
    csrf(req);
    const hash = cookieHash(req);
    const row = hash ? service.db.prepare("SELECT ciphertext FROM bridge_sessions WHERE token_hash=?").get(hash) : undefined;
    if (hash) remove(hash);
    res.clearCookie("bridge_session", cookieOptions);
    if (!hash || !row) return;
    let handle: string;
    try { handle = decrypt(row.ciphertext as string, hash); }
    catch { return; }
    try { await call("DELETE", "/sessions/current", undefined, handle); }
    catch (error) {
      if (!(error instanceof ServiceError && [401, 403, 404].includes(error.status))) throw error;
    }
  }
  async function login(req: Request, res: Response) {
    csrf(req);
    const username = req.body?.username, password = req.body?.password;
    if (typeof username !== "string" || username.length < 3 || username.length > 64 ||
      typeof password !== "string" || !password || password.length > 128)
      throw new ServiceError("UNAUTHORIZED", "Неверный логин или пароль", 401);
    let result: any;
    try { result = await call("POST", "/sessions", { username, password }); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 401)
        throw new ServiceError("UNAUTHORIZED", "Неверный логин или пароль", 401);
      throw error;
    }
    if (!result || typeof result.session !== "string" || !/^[A-Za-z0-9_-]{32,4096}$/.test(result.session)) throw unavailable();
    const handle: string = result.session;
    try {
      const current = identity(await call("GET", "/sessions/current", undefined, handle));
      if (cookieHash(req)) await logout(req, res);
      const token = randomBytes(32).toString("base64url"), hash = tokenHash(token);
      const expiresAt = Math.min(Date.parse(current.expires_at), Date.parse(result.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw unavailable();
      service.db.prepare("DELETE FROM bridge_sessions WHERE expires_at<=?").run(Date.now());
      service.db.prepare("INSERT INTO bridge_sessions VALUES(?,?,?)").run(hash, encrypt(handle, hash), expiresAt);
      res.cookie("bridge_session", token, { ...cookieOptions, maxAge: expiresAt - Date.now() });
      return { authenticated: true as const, actor: actor(current), identity: current };
    } catch (error) {
      try { await call("DELETE", "/sessions/current", undefined, handle); } catch { /* The remote session still expires under its authoritative policy. */ }
      throw error;
    }
  }
  return { call, login, session, logout, csrf };
}
