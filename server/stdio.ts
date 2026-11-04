import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { TaskService } from "./service.js";
import { createMcpServer } from "./mcp.js";

// stdio is launched by a trusted local process; it never opens a network listener.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(resolve(root, ".env")))
  process.loadEnvFile(resolve(root, ".env"));
const service = new TaskService(
  resolve(root, process.env.DATABASE_PATH ?? "data/tasks.sqlite"),
);
const actor = {
  id: process.env.OWNER_SUBJECT ?? "owner",
  scopes: ["tasks:read", "tasks:write"],
};
const mcp = createMcpServer(service, actor);
await mcp.connect(new StdioServerTransport());
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await mcp.close();
  service.close();
};
mcp.server.onclose = () => {
  void close();
};
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
