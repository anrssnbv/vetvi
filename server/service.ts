import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.js";

export const statuses = [
  "planned",
  "in_progress",
  "waiting",
  "review",
  "done",
  "cancelled",
] as const;
export type Status = (typeof statuses)[number];
export type Actor = { id: string; scopes: string[] };
export type ProjectScope = {
  id: string;
  namespace: string;
  creatorId: string;
  personal: boolean;
  title: string;
};
export type Evidence = {
  id: string;
  url: string;
  note: string;
  createdAt: string;
};
export type Task = {
  id: string;
  ownerId: string;
  projectId: string;
  parentId: string | null;
  assigneeId?: string | null;
  collaboratorIds?: string[];
  title: string;
  description: string;
  order: number;
  status: Status;
  priority: string;
  dueDate: string | null;
  dueAt: string | null;
  criteria: string[];
  evidence: Evidence[];
  result: string;
  waitingReason: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  archivedAt: string | null;
  deletedAt: string | null;
  deletionBatch: string | null;
};
type RecordBase = {
  id: string;
  ownerId: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  categoryId?: string;
  deletedAt?: string | null;
};
type Args = Record<string, unknown>;
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function fail(code: string, message: string, status = 400): never {
  throw new ServiceError(code, message, status);
}
function string(value: unknown, name: string, required = true): string {
  if (
    typeof value !== "string" ||
    (required && !value.trim()) ||
    value.length > 20000
  )
    fail("VALIDATION", `Некорректное поле: ${name}`);
  return value.trim();
}
function url(value: unknown): string {
  const result = string(value, "ссылка");
  try {
    const u = new URL(result);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
      throw Error();
  } catch {
    fail("VALIDATION", "Нужна ссылка http(s) без учётных данных");
  }
  return result;
}
function page(args: Args) {
  const limit = args.limit === undefined ? 100 : Number(args.limit),
    offset = args.offset === undefined ? 0 : Number(args.offset);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    fail("VALIDATION", "limit: 1–200; offset: целое число ≥ 0");
  return { limit, offset };
}
function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
const readTools = new Set([
  "list_projects",
  "search_tasks",
  "get_task",
  "get_subtree",
  "get_changes",
  "preview_delete",
  "export_data",
]);
const writeTools = new Set([
  "delete_project",
  "restore_project",
  "create_project",
  "create_category",
  "create_task",
  "update_task",
  "move_task",
  "add_dependency",
  "remove_dependency",
  "add_relation",
  "remove_relation",
  "add_evidence",
  "complete_task",
  "reopen_task",
  "archive_task",
  "restore_task",
  "set_position",
  "delete_task",
  "import_data",
]);

export class TaskService {
  readonly db: DatabaseSync;
  private scope?: ProjectScope;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000");
    migrate(this.db);
  }
  close() {
    this.db.close();
  }
  bindProject(scope: ProjectScope, actor: Actor) {
    for (const value of [scope.id, scope.namespace, scope.creatorId, scope.title, actor.id])
      string(value, "область проекта");
    if (typeof scope.personal !== "boolean")
      fail("VALIDATION", "Некорректная область проекта");
    if (scope.personal && scope.creatorId !== actor.id)
      fail("NOT_FOUND", "Запись не найдена или недоступна", 404);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(
        "SELECT namespace,creator_id,personal FROM shared_project_scopes WHERE project_id=?",
      ).get(scope.id);
      if (existing && (existing.namespace !== scope.namespace ||
        existing.creator_id !== scope.creatorId || Boolean(existing.personal) !== scope.personal))
        fail("SCOPE_CONFLICT", "Привязка проекта не совпадает", 409);
      const record = this.db.prepare("SELECT owner_id,kind,data FROM records WHERE id=?").get(scope.id);
      if (record && (record.owner_id !== scope.namespace || record.kind !== "project"))
        fail("SCOPE_CONFLICT", "Проект уже принадлежит другой области", 409);
      this.db.prepare("INSERT OR IGNORE INTO shared_project_scopes VALUES(?,?,?,?)")
        .run(scope.id, scope.namespace, scope.creatorId, Number(scope.personal));
      if (!record) {
        const now = new Date().toISOString();
        const categoryId = `shared-category:${scope.id}`;
        if (this.db.prepare("SELECT 1 FROM records WHERE id=?").get(categoryId))
          fail("SCOPE_CONFLICT", "Категория проекта уже существует", 409);
        this.put(scope.namespace, "category", {
          id: categoryId, ownerId: scope.namespace, title: "Проекты", version: 1,
          createdAt: now, updatedAt: now,
        } as RecordBase);
        this.put(scope.namespace, "project", {
          id: scope.id, ownerId: scope.namespace, categoryId, title: scope.title,
          version: 1, createdAt: now, updatedAt: now,
        } as RecordBase);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  executeScoped(tool: string, args: Args, actor: Actor, scope: ProjectScope): unknown {
    if (!actor?.id || !Array.isArray(actor.scopes))
      fail("UNAUTHORIZED", "Требуется авторизация", 401);
    const binding = this.db.prepare(
      "SELECT namespace,creator_id,personal FROM shared_project_scopes WHERE project_id=?",
    ).get(scope.id);
    if (!binding || binding.namespace !== scope.namespace || binding.creator_id !== scope.creatorId ||
      Boolean(binding.personal) !== scope.personal || (scope.personal && actor.id !== scope.creatorId))
      fail("NOT_FOUND", "Запись не найдена или недоступна", 404);
    if (this.scope) fail("SCOPE_CONFLICT", "Вложенная операция недоступна", 409);
    this.scope = scope;
    try {
      if (["create_project", "create_category"].includes(tool))
        fail("SCOPE_CONFLICT", "Создайте проект через управление проектами", 409);
      return this.execute(tool, args, actor);
    } finally {
      this.scope = undefined;
    }
  }
  transferTask(
    taskId: string,
    from: ProjectScope,
    to: ProjectScope,
    actor: Actor,
    expectedVersion: number,
    requestId: string,
    confirmSharing: boolean,
  ): { task: Task; movedTaskIds: string[] } {
    if (!actor?.id || !Array.isArray(actor.scopes))
      fail("UNAUTHORIZED", "Требуется авторизация", 401);
    if (!actor.scopes.some((value) => ["*", "tasks:write", "write"].includes(value)))
      fail("FORBIDDEN", "Недостаточно прав", 403);
    taskId = string(taskId, "id");
    requestId = string(requestId, "requestId");
    if (requestId.length > 128 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      fail("VALIDATION", "Некорректная версия или идентификатор запроса");
    if (this.scope || from.id === to.id || !from.personal || to.personal || from.creatorId !== actor.id)
      fail("SCOPE_CONFLICT", "Перенос разрешён только из своего личного проекта в совместный", 409);
    if (confirmSharing !== true)
      fail("SHARING_CONFIRMATION_REQUIRED", "Подтвердите доступ участников нового проекта ко всему поддереву и его истории", 409);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      taskId, expectedVersion, confirmSharing,
      from: [from.id, from.namespace, from.creatorId, from.personal],
      to: [to.id, to.namespace, to.creatorId, to.personal],
    })).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const project of [from, to]) {
        const binding = this.db.prepare(
          "SELECT namespace,creator_id,personal FROM shared_project_scopes WHERE project_id=?",
        ).get(project.id);
        if (!binding || binding.namespace !== project.namespace || binding.creator_id !== project.creatorId ||
          Boolean(binding.personal) !== project.personal)
          fail("NOT_FOUND", "Запись не найдена или недоступна", 404);
        this.scope = project;
        if (this.get<RecordBase>(project.namespace, project.id, "project").deletedAt)
          fail("DELETED_PROJECT", "Сначала восстановите проект", 409);
      }
      this.scope = to;
      const receipt = this.db.prepare(
        "SELECT fingerprint,response FROM transfer_receipts WHERE actor_id=? AND request_id=?",
      ).get(actor.id, requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          fail("IDEMPOTENCY_CONFLICT", "requestId уже использован для другого переноса", 409);
        const response = JSON.parse(receipt.response as string) as { task: Task; movedTaskIds: string[] };
        for (const id of response.movedTaskIds) this.get<Task>(to.namespace, id);
        this.db.exec("COMMIT");
        return response;
      }
      this.scope = from;
      const root = this.get<Task>(from.namespace, taskId);
      if (root.version !== expectedVersion)
        fail("VERSION_CONFLICT", "Задача изменена. Обновите её перед переносом", 409);
      if (root.parentId || root.deletedAt || root.archivedAt)
        fail("SCOPE_CONFLICT", "Перед переносом отделите корневую задачу от родителя и восстановите её", 409);
      const ids = this.descendants(from.namespace, taskId), moved = new Set(ids);
      const tasks = ids.map((id) => this.get<Task>(from.namespace, id));
      for (const task of tasks) this.validateTask(task);
      const allTasks = this.db.prepare("SELECT data FROM records WHERE kind='task'").all()
        .map((row) => JSON.parse(row.data as string) as Task);
      if (allTasks.some((task) => task.parentId && moved.has(task.parentId) && !moved.has(task.id)))
        fail("SCOPE_CONFLICT", "Дерево содержит связь с другой областью. Требуется проверка переноса", 409);
      const links = this.db.prepare("SELECT owner_id,source,target,kind FROM links").all();
      for (const link of links) {
        const source = moved.has(link.source as string), target = moved.has(link.target as string);
        if ((source !== target) || (source && link.owner_id !== from.namespace))
          fail("SCOPE_CONFLICT", "Сначала устраните связи поддерева с другими задачами", 409);
      }
      // Preserve history bytes; a trusted per-task trail authorizes its former project metadata.
      for (const task of tasks) {
        const entries = this.db.prepare("SELECT data FROM changes WHERE task_id=?").all(task.id);
        for (const entry of entries) {
          const change = JSON.parse(entry.data as string);
          if (change.taskId !== task.id)
            fail("SCOPE_CONFLICT", "История задачи требует проверки перед переносом", 409);
          for (const snapshot of [change.before, change.after]) {
            if (snapshot && typeof snapshot === "object" &&
              ((snapshot.id && snapshot.id !== task.id) ||
                (snapshot.projectId && snapshot.projectId !== from.id) ||
                (snapshot.parentId && !moved.has(snapshot.parentId))))
              fail("SCOPE_CONFLICT", "История содержит другую задачу или проект. Требуется проверка переноса", 409);
          }
          if (change.operation && [change.operation.source, change.operation.target].some((id) => id && !moved.has(id)))
            fail("SCOPE_CONFLICT", "История связей содержит другую задачу. Требуется проверка переноса", 409);
        }
      }
      const now = new Date().toISOString();
      for (const before of tasks) {
        const next = { ...before, projectId: to.id, ownerId: to.namespace, version: before.version + 1, updatedAt: now };
        this.db.prepare("INSERT INTO task_transfers VALUES(?,?,?,?,?,?,?)")
          .run(before.id, from.id, to.id, from.namespace, to.namespace, actor.id, requestId);
        this.db.prepare("UPDATE records SET owner_id=?,data=? WHERE id=? AND owner_id=? AND kind='task'")
          .run(to.namespace, JSON.stringify(next), before.id, from.namespace);
        this.db.prepare("UPDATE changes SET owner_id=? WHERE task_id=? AND owner_id=?")
          .run(to.namespace, before.id, from.namespace);
        this.db.prepare("UPDATE positions SET owner_id=? WHERE task_id=? AND owner_id=?")
          .run(to.namespace, before.id, from.namespace);
        this.scope = to;
        this.log(actor, "task_transferred", before, next, "Владелец явно предоставил доступ участникам совместного проекта",
          { sharingConfirmed: true }, { fromProjectId: from.id, toProjectId: to.id });
        this.db.prepare("INSERT OR IGNORE INTO task_outbox(event_id,project_id,task_id,version,actor_id,created_at) VALUES(?,?,?,?,?,?)")
          .run(`${before.id}:${next.version}:task_transferred_out`, from.id, before.id, next.version, actor.id, now);
      }
      for (const link of links.filter((link) => moved.has(link.source as string)))
        this.db.prepare("UPDATE links SET owner_id=? WHERE owner_id=? AND source=? AND target=? AND kind=?")
          .run(to.namespace, from.namespace, link.source!, link.target!, link.kind!);
      this.scope = to;
      const response = { task: this.detail(to.namespace, this.get<Task>(to.namespace, taskId)), movedTaskIds: ids };
      this.db.prepare("INSERT INTO transfer_receipts VALUES(?,?,?,?)")
        .run(actor.id, requestId, fingerprint, JSON.stringify(response));
      this.db.exec("COMMIT");
      return response;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.scope = undefined;
    }
  }
  private namespace(actor: Actor) {
    return this.scope?.namespace ?? actor.id;
  }
  private scopedRecord(owner: string, kind: string, record: Record<string, unknown>) {
    if (!this.scope) return true;
    if (owner !== this.scope.namespace) return false;
    if (kind === "project") return record.id === this.scope.id;
    if (kind === "task") return record.projectId === this.scope.id;
    const project = this.db.prepare("SELECT data FROM records WHERE id=? AND owner_id=? AND kind='project'")
      .get(this.scope.id, owner);
    return !!project && record.id === JSON.parse(project.data as string).categoryId;
  }
  private history(owner: string) {
    const allowed = new Set([
      ...this.rows<{id: string}>(owner, "task"),
      ...this.rows<{id: string}>(owner, "project"),
      ...(this.scope ? [] : this.rows<{id: string}>(owner, "category")),
    ].map((record) => record.id));
    return this.db.prepare("SELECT seq,task_id,data FROM changes WHERE owner_id=? ORDER BY seq")
      .all(owner).filter((row) => !this.scope || allowed.has(row.task_id as string)).map((row) => {
        const change = JSON.parse(row.data as string);
        if (this.scope) {
          for (const snapshot of [change.before, change.after]) {
            if (snapshot && typeof snapshot === "object" &&
              ((snapshot.projectId && snapshot.projectId !== this.scope.id &&
                !this.db.prepare("SELECT 1 FROM task_transfers WHERE task_id=? AND from_project=? AND to_project=? AND to_namespace=? AND from_namespace=?")
                  .get(change.taskId, snapshot.projectId, this.scope.id, owner, snapshot.ownerId ?? owner)) ||
                (snapshot.id && snapshot.id !== change.taskId)))
              fail("SCOPE_CONFLICT", "История содержит переход между проектами; требуется проверка переноса", 409);
          }
          const operation = change.operation;
          if (operation && [operation.source, operation.target].some((id) => id && !allowed.has(id)))
            fail("SCOPE_CONFLICT", "История содержит связь с другим проектом", 409);
        }
        return { ...change, seq: row.seq };
      });
  }
  private rows<T>(owner: string, kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM records WHERE owner_id=? AND kind=?")
      .all(owner, kind)
      .map((r) => JSON.parse(r.data as string) as T)
      .filter((record) => this.scopedRecord(owner, kind, record as Record<string, unknown>))
      .map(record => this.scope && kind === "category" ? {...record,title:this.scope.personal ? "Личные задачи" : "Проекты"} : record);
  }
  private get<T extends { id: string }>(
    owner: string,
    id: unknown,
    kind = "task",
  ): T {
    const row = this.db
      .prepare("SELECT data FROM records WHERE id=? AND owner_id=? AND kind=?")
      .get(string(id, "id"), owner, kind);
    if (!row) fail("NOT_FOUND", "Запись не найдена или недоступна", 404);
    const record = JSON.parse(row.data as string) as T;
    if (!this.scopedRecord(owner, kind, record))
      fail("NOT_FOUND", "Запись не найдена или недоступна", 404);
    return this.scope && kind === "category" ? {...record,title:this.scope.personal ? "Личные задачи" : "Проекты"} : record;
  }
  private put(owner: string, kind: string, value: { id: string }) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE records.owner_id=excluded.owner_id AND records.kind=excluded.kind",
      )
      .run(value.id, owner, kind, JSON.stringify(value));
  }
  private links(owner: string, kind: string) {
    const links = this.db
      .prepare("SELECT source,target FROM links WHERE owner_id=? AND kind=?")
      .all(owner, kind) as { source: string; target: string }[];
    if (!this.scope) return links;
    const ids = new Set(this.rows<Task>(owner, "task").map((task) => task.id));
    if (links.some((link) => ids.has(link.source) !== ids.has(link.target)))
      fail("SCOPE_CONFLICT", "Связь между проектами требует отдельного переноса", 409);
    return links.filter((link) => ids.has(link.source) && ids.has(link.target));
  }
  private descendants(owner: string, id: string) {
    const tasks = this.rows<Task>(owner, "task"),
      found = [id],
      seen = new Set(found);
    for (let i = 0; i < found.length; i++)
      for (const t of tasks)
        if (t.parentId === found[i] && !seen.has(t.id)) {
          seen.add(t.id);
          found.push(t.id);
        }
    return found;
  }
  private log(
    actor: Actor,
    tool: string,
    before: unknown,
    after: { id: string },
    reason: unknown,
    confirmation?: unknown,
    operation?: unknown,
  ) {
    const change = {
      id: randomUUID(),
      taskId: after.id,
      actor: actor.id,
      at: new Date().toISOString(),
      action: tool,
      before,
      after,
      reason: typeof reason === "string" ? reason : "",
      confirmation: confirmation ?? null,
      operation: operation ?? null,
    };
    this.db
      .prepare("INSERT INTO changes(owner_id,task_id,data) VALUES(?,?,?)")
      .run(this.namespace(actor), after.id, JSON.stringify(change));
    if (this.scope && "projectId" in after && "version" in after) {
      this.db.prepare(
        "INSERT OR IGNORE INTO task_outbox(event_id,project_id,task_id,version,actor_id,created_at) VALUES(?,?,?,?,?,?)",
      ).run(`${after.id}:${after.version}:${tool}`, this.scope.id, after.id,
        Number(after.version), actor.id, change.at);
      const tasks=this.rows<Task>(this.scope.namespace,"task");
      const impacted=new Set<string>();
      for(const parent of [(after as Task).parentId,(before as Task|null)?.parentId]){
        let id=parent;
        while(id&&!impacted.has(id)){impacted.add(id);id=tasks.find(task=>task.id===id)?.parentId??null;}
      }
      for(const link of this.links(this.scope.namespace,"dependency"))if(link.target===after.id)impacted.add(link.source);
      for(const id of impacted){
        const task=tasks.find(task=>task.id===id);
        if(task)this.db.prepare("INSERT OR IGNORE INTO task_outbox(event_id,project_id,task_id,version,actor_id,created_at) VALUES(?,?,?,?,?,?)")
          .run(`${id}:${task.version}:dependency:${after.id}:${after.version}:${tool}`,this.scope.id,id,task.version,actor.id,change.at);
      }
    }
  }
  private save(
    actor: Actor,
    tool: string,
    before: Task,
    next: Task,
    args: Args,
  ) {
    next.version = before.version + 1;
    next.updatedAt = new Date().toISOString();
    this.put(this.namespace(actor), "task", next);
    this.log(
      actor,
      tool,
      before,
      next,
      args.reason ?? args.result,
      tool === "complete_task"
        ? { result: next.result, evidence: next.evidence }
        : undefined,
      args.historyOperation,
    );
    return this.detail(this.namespace(actor), next);
  }
  private archivedBranches(tasks: Task[]) {
    const ids = new Set(tasks.filter(task => task.archivedAt).map(task => task.id));
    const queue = [...ids];
    for (let i = 0; i < queue.length; i++) {
      for (const task of tasks) {
        if (task.parentId === queue[i] && !ids.has(task.id)) {
          ids.add(task.id);
          queue.push(task.id);
        }
      }
    }
    return ids;
  }
  private detail(owner: string, task: Task) {
    const tasks = this.rows<Task>(owner, "task");
    const active = (t: Task) =>
      !t.deletedAt && !t.archivedAt && t.status !== "cancelled";
    const leaves: Task[] = [];
    const queue = [task];
    while (queue.length) {
      const t = queue.pop()!;
      if (!active(t)) continue;
      const children = tasks.filter((c) => c.parentId === t.id);
      if (!children.length) leaves.push(t);
      else queue.push(...children);
    }
    const done = leaves.filter((t) => t.status === "done").length;
    const childIds = new Set(this.descendants(owner, task.id).slice(1));
    const openChildren = tasks.some((t) => childIds.has(t.id) && !t.deletedAt && !["done", "cancelled"].includes(t.status));
    const openDependencies = this.links(owner, "dependency").filter((link) => link.source === task.id)
      .some((link) => { const dependency = this.get<Task>(owner, link.target); return dependency.status !== "done" || !!dependency.deletedAt; });
    const dependencies = this.links(owner, "dependency")
      .filter((l) => l.source === task.id)
      .map((l) => l.target);
    const related = [
      ...new Set(
        this.links(owner, "related")
          .filter((l) => l.source === task.id || l.target === task.id)
          .map((l) => (l.source === task.id ? l.target : l.source)),
      ),
    ];
    const position =
      this.db
        .prepare("SELECT x,y FROM positions WHERE owner_id=? AND task_id=?")
        .get(owner, task.id) ?? null;
    return {
      ...task,
      openChildren,
      openDependencies,
      dependencies,
      related,
      position,
      progress: {
        done,
        total: leaves.length,
        percent: leaves.length ? Math.round((done / leaves.length) * 100) : 0,
      },
    };
  }
  private validateTask(task: Task) {
    string(task.title, "название");
    if (!statuses.includes(task.status))
      fail("VALIDATION", "Неизвестный статус");
    if (!["low", "normal", "high", "urgent"].includes(task.priority))
      fail("VALIDATION", "Неизвестный приоритет");
    if (
      !Array.isArray(task.criteria) ||
      task.criteria.length > 100 ||
      task.criteria.some(
        (c) => typeof c !== "string" || !c.trim() || c.length > 2000,
      )
    )
      fail("VALIDATION", "Критерии должны быть непустыми строками");
    if (
      task.dueDate !== null &&
      (typeof task.dueDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) ||
        Number.isNaN(Date.parse(task.dueDate)) ||
        new Date(task.dueDate).toISOString().slice(0, 10) !== task.dueDate)
    )
      fail("VALIDATION", "Некорректная дата");
    if (
      task.dueAt !== null &&
      (typeof task.dueAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          task.dueAt,
        ) ||
        Number.isNaN(Date.parse(task.dueAt)) ||
        new Date(task.dueAt.slice(0, 10)).toISOString().slice(0, 10) !==
          task.dueAt.slice(0, 10))
    )
      fail(
        "VALIDATION",
        "Время должно содержать корректную дату и часовой пояс",
      );
    if (task.dueDate && task.dueAt)
      fail("VALIDATION", "Выберите дату или точное время");
    if (task.dueAt) task.dueAt = new Date(task.dueAt).toISOString();
    for (const key of ["description", "waitingReason", "result"] as const)
      string(task[key], key, false);
    if (task.status === "waiting" && !task.waitingReason.trim())
      fail("VALIDATION", "Укажите причину ожидания");
    if (!Number.isFinite(task.order))
      fail("VALIDATION", "Некорректный порядок");
    if (task.parentId !== null && typeof task.parentId !== "string")
      fail("VALIDATION", "Некорректный родитель");
    if (
      !Array.isArray(task.evidence) ||
      task.evidence.some(
        (e) =>
          !e ||
          typeof e.id !== "string" ||
          !e.id.trim() ||
          typeof e.note !== "string" ||
          e.note.length > 20000 ||
          typeof e.createdAt !== "string" ||
          !validTimestamp(e.createdAt),
      )
    )
      fail("VALIDATION", "Некорректные подтверждения");
    if (new Set(task.evidence.map((e) => e.id)).size !== task.evidence.length)
      fail("VALIDATION", "Повторяются ID подтверждений");
    task.evidence.forEach((e) => url(e.url));
    if (task.assigneeId !== undefined && task.assigneeId !== null &&
      (typeof task.assigneeId !== "string" || !task.assigneeId.trim() || task.assigneeId.length > 200))
      fail("VALIDATION", "Некорректный ответственный");
    if (task.collaboratorIds !== undefined && (!Array.isArray(task.collaboratorIds) ||
      task.collaboratorIds.length > 100 || task.collaboratorIds.some((id) =>
        typeof id !== "string" || !id.trim() || id.length > 200) ||
      new Set(task.collaboratorIds).size !== task.collaboratorIds.length))
      fail("VALIDATION", "Некорректные соисполнители");
    for (const key of ["archivedAt", "deletedAt"] as const)
      if (
        task[key] !== null &&
        (typeof task[key] !== "string" || !validTimestamp(task[key]))
      )
        fail("VALIDATION", `Некорректное поле ${key}`);
    if (task.deletionBatch !== null && typeof task.deletionBatch !== "string")
      fail("VALIDATION", "Некорректная группа удаления");
    if (Boolean(task.deletedAt) !== Boolean(task.deletionBatch))
      fail("VALIDATION", "Удаление требует группы восстановления");
  }
  execute(tool: string, args: Args, actor: Actor): unknown {
    if (!actor?.id || !Array.isArray(actor.scopes))
      fail("UNAUTHORIZED", "Требуется авторизация", 401);
    // Reserve scoped receipt keys and close legacy access after any namespace binding.
    if (!this.scope && (actor.id.startsWith('["project",') ||
      this.db.prepare("SELECT 1 FROM shared_project_scopes WHERE namespace=?").get(actor.id)))
      fail("SHARED_SCOPE_REQUIRED", "Для проекта требуется индивидуальный доступ", 403);
    if (!readTools.has(tool) && !writeTools.has(tool))
      fail("UNKNOWN_TOOL", "Неизвестная операция", 404);
    const write = writeTools.has(tool),
      scopes = actor.scopes;
    if (
      !scopes.includes("*") &&
      !(write
        ? scopes.includes("tasks:write") || scopes.includes("write")
        : scopes.includes("tasks:read") ||
          scopes.includes("read") ||
          scopes.includes("tasks:write") ||
          scopes.includes("write"))
    )
      fail("FORBIDDEN", "Недостаточно прав", 403);
    if (!write) return this.read(tool, args, actor);
    const requestId = string(args.requestId, "requestId");
    const receiptOwner = this.scope
      ? JSON.stringify(["project", this.scope.namespace, this.scope.id, actor.id])
      : actor.id;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ tool, args }))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.scope) {
        if (args.projectId !== undefined) this.get(this.scope.namespace, args.projectId, "project");
        if (args.id !== undefined)
          this.get(this.scope.namespace, args.id, ["delete_project", "restore_project"].includes(tool) ? "project" : "task");
        for (const id of [args.parentId, args.targetId, args.dependencyId])
          if (id !== undefined && id !== null) this.get(this.scope.namespace, id);
      }
      const previous = this.db
        .prepare(
          "SELECT fingerprint,result FROM requests WHERE owner_id=? AND request_id=?",
        )
        .get(receiptOwner, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "requestId уже использован для другого запроса",
            409,
          );
        const result = JSON.parse(previous.result as string);
        if (this.scope && result && typeof result === "object" && result.projectId)
          this.get(this.scope.namespace, result.id);
        this.db.exec("COMMIT");
        return result;
      }
      const result = this.write(tool, args, actor);
      this.db
        .prepare("INSERT INTO requests VALUES(?,?,?,?)")
        .run(receiptOwner, requestId, fingerprint, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private read(tool: string, args: Args, actor: Actor): unknown {
    const owner = this.namespace(actor);
    if (tool === "list_projects") {
      const p = page(args),
        items = this.rows<RecordBase>(owner, "project").filter(
          (p) => args.includeDeleted === true || !p.deletedAt,
        );
      return {
        items: items.slice(p.offset, p.offset + p.limit),
        total: items.length,
        ...p,
        categories: this.rows(owner, "category"),
      };
    }
    if (tool === "get_task") {
      const t = this.get<Task>(owner, args.id);
      return {
        ...this.detail(owner, t),
        history: this.history(owner).filter((change) => change.taskId === t.id).reverse().slice(0, 100),
      };
    }
    if (tool === "get_changes") {
      const p = page(args),
        since = Number(args.since ?? 0);
      if (!Number.isInteger(since) || since < 0)
        fail("VALIDATION", "Некорректный курсор");
      const all = this.history(owner).filter((change) => Number(change.seq) > since);
      const items = all.slice(p.offset, p.offset + p.limit);
      return {
        items,
        total: all.length,
        ...p,
        nextCursor: items.at(-1)?.seq ?? since,
      };
    }
    if (tool === "preview_delete") {
      const task = this.get<Task>(owner, args.id);
      const ids = this.descendants(owner, task.id);
      return {
        ids,
        items: ids.map((id) => this.get<Task>(owner, id)),
        total: ids.length,
      };
    }
    if (tool === "export_data")
      return {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        categories: this.rows(owner, "category"),
        projects: this.rows(owner, "project"),
        tasks: this.rows(owner, "task"),
        links: ["dependency", "related"].flatMap((kind) =>
          this.links(owner, kind).map((link) => ({ ...link, kind }))),
        positions: this.db
          .prepare(
            "SELECT task_id AS taskId,x,y FROM positions WHERE owner_id=?",
          )
          .all(owner).filter((position) => !this.scope || this.rows<Task>(owner, "task").some((task) => task.id === position.taskId)),
        history: this.history(owner).map(({ seq: _seq, ...change }) => change),
      };
    let tasks = this.rows<Task>(owner, "task");
    const p = page(args);
    if (tool === "get_subtree") {
      const root = this.get<Task>(owner, args.id),
        depth = Number(args.depth ?? 5);
      if (!Number.isInteger(depth) || depth < 0 || depth > 20)
        fail("VALIDATION", "Глубина: 0–20");
      const ids = new Set([root.id]);
      let frontier = [root.id];
      for (let i = 0; i < depth; i++) {
        frontier = tasks
          .filter((t) => t.parentId && frontier.includes(t.parentId))
          .map((t) => t.id);
        frontier.forEach((id) => ids.add(id));
      }
      tasks = tasks.filter((t) => ids.has(t.id) && !t.deletedAt);
      return {
        root: this.detail(owner, root),
        items: tasks
          .slice(p.offset, p.offset + p.limit)
          .map((t) => this.detail(owner, t)),
        total: tasks.length,
        ...p,
        depth,
      };
    }
    if (args.projectId) this.get(owner, args.projectId, "project");
    if (args.categoryId) this.get(owner, args.categoryId, "category");
    const projects = this.rows<RecordBase>(owner, "project");
    const archivedBranchIds = this.archivedBranches(tasks);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Almaty",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    tasks = tasks.filter(
      (t) =>
        (args.deleted === true ? !!t.deletedAt : !t.deletedAt) &&
        (args.deleted === true ||
          (args.archived === true
            ? archivedBranchIds.has(t.id)
            : !archivedBranchIds.has(t.id))) &&
        (!args.projectId || t.projectId === args.projectId) &&
        (!args.categoryId ||
          projects.find((p) => p.id === t.projectId)?.categoryId ===
            args.categoryId) &&
        (!args.status || t.status === args.status) &&
        (!args.query ||
          `${t.title} ${t.description}`
            .toLocaleLowerCase()
            .includes(String(args.query).toLocaleLowerCase())) &&
        (args.due !== "overdue" ||
          (!["done", "cancelled"].includes(t.status) &&
            ((t.dueDate && t.dueDate < today) ||
              (t.dueAt && Date.parse(t.dueAt) < Date.now())))) &&
        (args.due !== "today" ||
          t.dueDate === today ||
          (t.dueAt &&
            new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Almaty",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date(t.dueAt)) === today)) &&
        (!args.hideCompleted || !["done", "cancelled"].includes(t.status)),
    );
    tasks.sort(
      (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt),
    );
    return {
      items: tasks
        .slice(p.offset, p.offset + p.limit)
        .map((t) => this.detail(owner, t)),
      total: tasks.length,
      ...p,
    };
  }
  private write(tool: string, args: Args, actor: Actor): unknown {
    const owner = this.namespace(actor),
      now = new Date().toISOString();
    if (tool === "import_data") return this.importData(args, actor);
    if (tool === "delete_project" || tool === "restore_project") {
      const before = this.get<RecordBase>(owner, args.id, "project");
      if (args.expectedVersion !== before.version)
        fail(
          "VERSION_CONFLICT",
          `Проект изменён. Текущая версия: ${before.version}`,
          409,
        );
      if (tool === "delete_project") {
        if (before.deletedAt) fail("DELETED_PROJECT", "Проект уже в корзине", 409);
        if (args.confirmationTitle !== before.title)
          fail("PROJECT_CONFIRMATION", "Для удаления введите точное название проекта");
        const tasks = this.rows<Task>(owner, "task").filter(task => task.projectId === before.id);
        const archived = this.archivedBranches(tasks);
        const open = tasks.filter(task => !task.deletedAt && !archived.has(task.id) &&
          !["done", "cancelled"].includes(task.status));
        if (open.length)
          fail("OPEN_PROJECT_TASKS", `Нельзя удалить проект: незавершённых задач — ${open.length}`, 409);
        const batch = randomUUID();
        for (const task of tasks.filter(task => !task.deletedAt)) {
          this.save(actor, "delete_task", task, { ...task, deletedAt: now, deletionBatch: batch }, {
            reason: args.reason ?? "Удалён завершённый проект; дальнейшая работа не планируется",
            historyOperation: { projectId: before.id, projectDeletion: true },
          });
        }
      }
      const next = {
        ...before,
        deletedAt: tool === "delete_project" ? now : null,
        updatedAt: now,
        version: before.version + 1,
      };
      this.put(owner, "project", next);
      this.log(actor, tool, before, next, args.reason);
      return next;
    }
    if (tool === "create_category" || tool === "create_project") {
      const kind = tool === "create_category" ? "category" : "project";
      const record: RecordBase = {
        id: randomUUID(),
        ownerId: owner,
        title: string(args.title, "название"),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (kind === "project") {
        this.get(owner, args.categoryId, "category");
        record.categoryId = String(args.categoryId);
      }
      this.put(owner, kind, record);
      this.log(actor, tool, null, record, args.reason);
      return record;
    }
    if (tool === "create_task") {
      if (this.get<RecordBase>(owner, args.projectId, "project").deletedAt)
        fail("DELETED_PROJECT", "Сначала восстановите проект", 409);
      const parent = args.parentId
        ? this.get<Task>(owner, args.parentId)
        : null;
      if (
        parent &&
        (parent.projectId !== args.projectId ||
          parent.deletedAt ||
          parent.archivedAt ||
          ["done", "cancelled"].includes(parent.status))
      )
        fail(
          "INVALID_PARENT",
          "Родитель должен быть активной задачей того же проекта",
        );
      if (args.status === "done")
        fail(
          "INVALID_TRANSITION",
          "Завершение доступно только через complete_task",
        );
      const task: Task = {
        id: randomUUID(),
        ownerId: owner,
        projectId: String(args.projectId),
        parentId: parent?.id ?? null,
        ...(args.assigneeId !== undefined ? { assigneeId: args.assigneeId as string | null } : {}),
        ...(args.collaboratorIds !== undefined ? { collaboratorIds: args.collaboratorIds as string[] } : {}),
        title: string(args.title, "название"),
        description:
          args.description === undefined
            ? ""
            : string(args.description, "описание", false),
        order: Number(args.order ?? this.rows<Task>(owner, "task").length),
        status: (args.status ?? "planned") as Status,
        priority: String(args.priority ?? "normal"),
        dueDate: (args.dueDate ?? null) as string | null,
        dueAt: (args.dueAt ?? null) as string | null,
        criteria: (args.criteria ?? []) as string[],
        evidence: [],
        result: "",
        waitingReason: String(args.waitingReason ?? ""),
        createdAt: now,
        updatedAt: now,
        version: 1,
        archivedAt: null,
        deletedAt: null,
        deletionBatch: null,
      };
      this.validateTask(task);
      this.put(owner, "task", task);
      this.log(actor, tool, null, task, args.reason);
      return this.detail(owner, task);
    }
    const before = this.get<Task>(owner, args.id);
    if (args.expectedVersion !== before.version)
      fail(
        "VERSION_CONFLICT",
        `Задача изменена. Текущая версия: ${before.version}`,
        409,
      );
    const next = structuredClone(before);
    if (before.deletedAt && tool !== "restore_task")
      fail("DELETED", "Сначала восстановите задачу", 409);
    if (tool === "update_task") {
      const patch = (args.patch ?? args) as Args;
      const allowed = [
        "title",
        "description",
        "order",
        "status",
        "priority",
        "dueDate",
        "dueAt",
        "criteria",
        "waitingReason",
        "assigneeId",
        "collaboratorIds",
      ];
      for (const key of Object.keys(patch))
        if (
          !allowed.includes(key) &&
          !["id", "requestId", "expectedVersion", "reason"].includes(key)
        )
          fail("VALIDATION", `Поле нельзя изменить: ${key}`);
      if (
        patch.status === "done" ||
        (["done", "cancelled"].includes(before.status) &&
          patch.status !== undefined &&
          patch.status !== before.status)
      )
        fail("INVALID_TRANSITION", "Используйте complete_task или reopen_task");
      if (
        before.status === "done" &&
        patch.criteria !== undefined &&
        JSON.stringify(patch.criteria) !== JSON.stringify(before.criteria)
      )
        fail(
          "INVALID_TRANSITION",
          "Сначала откройте задачу повторно для изменения критериев",
        );
      for (const key of allowed)
        if (patch[key] !== undefined)
          (next as unknown as Args)[key] = patch[key];
    } else if (tool === "move_task") {
      const ids = this.descendants(owner, next.id);
      const parent = args.parentId
        ? this.get<Task>(owner, args.parentId)
        : null;
      if (
        parent &&
        (ids.includes(parent.id) ||
          parent.deletedAt ||
          parent.archivedAt ||
          ["done", "cancelled"].includes(parent.status))
      )
        fail("TREE_CYCLE", "Недопустимый родитель или цикл дерева");
      const projectId = String(
        args.projectId ?? parent?.projectId ?? next.projectId,
      );
      if (this.get<RecordBase>(owner, projectId, "project").deletedAt)
        fail("DELETED_PROJECT", "Сначала восстановите проект", 409);
      if (parent && parent.projectId !== projectId)
        fail("INVALID_PARENT", "Разные проекты");
      next.parentId = parent?.id ?? null;
      next.projectId = projectId;
      if (args.order !== undefined) next.order = Number(args.order);
      for (const id of ids.slice(1)) {
        const child = this.get<Task>(owner, id);
        if (child.projectId !== projectId)
          this.save(actor, tool, child, { ...child, projectId }, args);
      }
    } else if (
      [
        "add_dependency",
        "remove_dependency",
        "add_relation",
        "remove_relation",
      ].includes(tool)
    ) {
      const target = this.get<Task>(owner, args.targetId ?? args.dependencyId);
      const kind = tool.includes("dependency") ? "dependency" : "related";
      if (target.id === next.id || target.deletedAt)
        fail("INVALID_LINK", "Недопустимая связь");
      const adding = tool.startsWith("add");
      const exists = this.links(owner, kind).some(
        (l) =>
          (l.source === next.id && l.target === target.id) ||
          (kind === "related" &&
            l.source === target.id &&
            l.target === next.id),
      );
      args = {
        ...args,
        historyOperation: {
          kind,
          source: next.id,
          target: target.id,
          before: exists,
          after: adding,
        },
      };
      if (adding && kind === "dependency") {
        if (next.status === "done")
          fail("INVALID_TRANSITION", "Сначала откройте задачу повторно");
        const links = this.links(owner, kind),
          seen = new Set<string>(),
          queue = [target.id];
        while (queue.length) {
          const id = queue.shift()!;
          if (id === next.id)
            fail("DEPENDENCY_CYCLE", "Зависимость создаёт цикл");
          if (seen.has(id)) continue;
          seen.add(id);
          queue.push(
            ...links.filter((l) => l.source === id).map((l) => l.target),
          );
        }
      }
      if (kind === "related") {
        const [sourceId, targetId] = [next.id, target.id].sort();
        if (adding && !exists)
          this.db
            .prepare("INSERT INTO links VALUES(?,?,?,?)")
            .run(owner, sourceId, targetId, kind);
        if (!adding)
          this.db
            .prepare(
              "DELETE FROM links WHERE owner_id=? AND kind=? AND ((source=? AND target=?) OR (source=? AND target=?))",
            )
            .run(owner, kind, next.id, target.id, target.id, next.id);
        if (exists !== adding)
          this.save(actor, tool, target, { ...target }, args);
      } else if (adding)
        this.db
          .prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)")
          .run(owner, next.id, target.id, kind);
      else
        this.db
          .prepare(
            "DELETE FROM links WHERE owner_id=? AND source=? AND target=? AND kind=?",
          )
          .run(owner, next.id, target.id, kind);
    } else if (tool === "add_evidence") {
      next.evidence.push({
        id: randomUUID(),
        url: url(args.url),
        note: string(args.note ?? "", "подтверждение", false),
        createdAt: now,
      });
    } else if (tool === "complete_task") {
      if (before.status === "done" || before.status === "cancelled")
        fail("INVALID_TRANSITION", "Задача уже закрыта");
      next.result = string(args.result, "описание результата");
      if (args.evidenceUrl)
        next.evidence.push({
          id: randomUUID(),
          url: url(args.evidenceUrl),
          note: string(args.evidenceNote ?? "", "подтверждение", false),
          createdAt: now,
        });
      const descendantIds = new Set(this.descendants(owner, next.id).slice(1));
      const children = this.rows<Task>(owner, "task").filter(
        (t) => descendantIds.has(t.id) && !t.deletedAt,
      );
      if (children.some((t) => !["done", "cancelled"].includes(t.status)))
        fail("OPEN_CHILDREN", "Остались открытые подзадачи", 409);
      const deps = this.links(owner, "dependency")
        .filter((l) => l.source === next.id)
        .map((l) => this.get<Task>(owner, l.target));
      if (deps.some((t) => t.status !== "done" || t.deletedAt))
        fail("OPEN_DEPENDENCIES", "Не выполнены зависимости", 409);
      next.status = "done";
    } else if (tool === "reopen_task") {
      string(args.reason, "причина повторного открытия");
      if (!["done", "cancelled"].includes(next.status))
        fail("INVALID_TRANSITION", "Задача не закрыта");
      next.status = "planned";
      next.result = "";
      // Reopening invalidates completion of dependent and ancestor tasks.
      const queue = [next.id],
        affected = new Set([next.id]),
        all = this.rows<Task>(owner, "task"),
        links = this.links(owner, "dependency");
      while (queue.length) {
        const id = queue.shift()!;
        const current = all.find((t) => t.id === id);
        const candidates = [
          ...(current?.parentId ? [current.parentId] : []),
          ...links.filter((l) => l.target === id).map((l) => l.source),
        ];
        for (const candidate of candidates) {
          if (affected.has(candidate)) continue;
          affected.add(candidate);
          queue.push(candidate);
          const task = all.find((t) => t.id === candidate);
          if (task?.status === "done")
            this.save(
              actor,
              "completion_invalidated",
              task,
              { ...task, status: "review" },
              args,
            );
        }
      }
    } else if (tool === "archive_task") {
      next.archivedAt = args.archived === false ? null : now;
    } else if (tool === "set_position") {
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y))
        fail("VALIDATION", "Координаты должны быть числами");
      args = {
        ...args,
        historyOperation: {
          before:
            this.db
              .prepare(
                "SELECT x,y FROM positions WHERE owner_id=? AND task_id=?",
              )
              .get(owner, next.id) ?? null,
          after: { x: args.x, y: args.y },
        },
      };
      this.db
        .prepare(
          "INSERT INTO positions VALUES(?,?,?,?) ON CONFLICT(owner_id,task_id) DO UPDATE SET x=excluded.x,y=excluded.y",
        )
        .run(owner, next.id, args.x as number, args.y as number);
    } else if (tool === "delete_task") {
      const ids = this.descendants(owner, next.id).sort();
      const preview = args.previewIds;
      if (
        args.subtree !== true ||
        !Array.isArray(preview) ||
        JSON.stringify([...preview].sort()) !== JSON.stringify(ids)
      )
        fail(
          "DELETE_CONFIRMATION",
          "Подтвердите актуальный список задач поддерева",
          409,
        );
      const batch = randomUUID();
      next.deletedAt = now;
      next.deletionBatch = batch;
      for (const id of ids.filter((id) => id !== next.id)) {
        const child = this.get<Task>(owner, id);
        if (!child.deletedAt)
          this.save(
            actor,
            tool,
            child,
            { ...child, deletedAt: now, deletionBatch: batch },
            args,
          );
      }
    } else if (tool === "restore_task") {
      if (next.deletedAt) {
        if (next.parentId && this.get<Task>(owner, next.parentId).deletedAt)
          fail(
            "DELETED_PARENT",
            "Сначала восстановите родительскую задачу",
            409,
          );
        for (const child of this.rows<Task>(owner, "task").filter(
          (t) => t.id !== next.id && t.deletionBatch === next.deletionBatch,
        ))
          this.save(
            actor,
            tool,
            child,
            { ...child, deletedAt: null, deletionBatch: null },
            args,
          );
        next.deletedAt = null;
        next.deletionBatch = null;
      }
      next.archivedAt = null;
      const project = this.get<RecordBase>(owner, next.projectId, "project");
      if (project.deletedAt) {
        const restored = {
          ...project,
          deletedAt: null,
          updatedAt: now,
          version: project.version + 1,
        };
        this.put(owner, "project", restored);
        this.log(
          actor,
          "restore_project",
          project,
          restored,
          args.reason ?? "Восстановлена задача проекта",
        );
      }
    }
    this.validateTask(next);
    return this.save(actor, tool, before, next, args);
  }
  private importData(args: Args, actor: Actor) {
    const data = structuredClone(args.data) as Args;
    if (!data || data.formatVersion !== 1)
      fail("IMPORT_VERSION", "Поддерживается formatVersion: 1");
    for (const name of [
      "categories",
      "projects",
      "tasks",
      "links",
      "positions",
      "history",
    ])
      if (!Array.isArray(data[name]))
        fail("IMPORT_VALIDATION", `Нужен массив ${name}`);
    for (const name of [
      "categories",
      "projects",
      "tasks",
      "links",
      "positions",
      "history",
    ])
      if (
        (data[name] as unknown[]).some(
          (value) =>
            !value || typeof value !== "object" || Array.isArray(value),
        )
      )
        fail("IMPORT_VALIDATION", `Некорректная запись в ${name}`);
    const categories = data.categories as RecordBase[],
      projects = data.projects as RecordBase[],
      tasks = data.tasks as Task[];
    if (categories.length + projects.length + tasks.length > 10000)
      fail("IMPORT_VALIDATION", "Импорт превышает 10000 записей");
    if (this.scope) {
      const project = this.get<RecordBase>(this.scope.namespace, this.scope.id, "project");
      const category = this.get<RecordBase>(this.scope.namespace, project.categoryId, "category");
      const sameMetadata = (actual: RecordBase, expected: RecordBase) =>
        JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort());
      if (projects.length !== 1 || categories.length !== 1 ||
        !sameMetadata(projects[0]!, project) || !sameMetadata(categories[0]!, category) ||
        tasks.some((task) => task.projectId !== this.scope!.id || task.ownerId !== this.scope!.namespace))
        fail("SCOPE_CONFLICT", "Импорт разрешён только в текущий проект без изменения его владельца", 409);
    }
    const all = [...categories, ...projects, ...tasks],
      ids = new Set<string>();
    for (const record of all) {
      string(record.id, "id");
      string(record.title, "название");
      if (
        ids.has(record.id) ||
        (this.db.prepare("SELECT 1 FROM records WHERE id=?").get(record.id) &&
          !(this.scope && (categories.includes(record) || projects.includes(record))))
      )
        fail("IMPORT_CONFLICT", "ID уже существует", 409);
      ids.add(record.id);
      record.ownerId = this.namespace(actor);
      if (
        !Number.isSafeInteger(record.version) ||
        record.version < 1 ||
        !validTimestamp(record.createdAt) ||
        !validTimestamp(record.updatedAt)
      )
        fail("IMPORT_VALIDATION", "Некорректная версия или дата");
    }
    for (const project of projects) {
      if (
        project.deletedAt !== undefined &&
        project.deletedAt !== null &&
        !validTimestamp(project.deletedAt)
      )
        fail("IMPORT_VALIDATION", "Некорректная дата удаления проекта");
      if (!categories.some((c) => c.id === project.categoryId))
        fail("IMPORT_VALIDATION", "Нет категории проекта");
    }
    for (const task of tasks) {
      this.validateTask(task);
      if (!projects.some((p) => p.id === task.projectId))
        fail("IMPORT_VALIDATION", "Нет проекта задачи");
      if (
        !task.deletedAt &&
        projects.some((p) => p.id === task.projectId && p.deletedAt)
      )
        fail("IMPORT_VALIDATION", "Активная задача в удалённом проекте");
      if (
        task.parentId &&
        !tasks.some(
          (t) => t.id === task.parentId && t.projectId === task.projectId,
        )
      )
        fail("IMPORT_VALIDATION", "Некорректный родитель");
      const seen = new Set([task.id]);
      let parent = task.parentId;
      while (parent) {
        if (seen.has(parent)) fail("TREE_CYCLE", "Цикл дерева");
        seen.add(parent);
        parent = tasks.find((t) => t.id === parent)?.parentId ?? null;
      }
      if (task.status === "done" && !task.result.trim())
        fail("IMPORT_VALIDATION", "Завершённая задача без описания результата");
    }
    const links = data.links as {
      source: string;
      target: string;
      kind: string;
    }[];
    for (const link of links) {
      if (
        !tasks.some((t) => t.id === link.source) ||
        !tasks.some((t) => t.id === link.target) ||
        link.source === link.target ||
        !["dependency", "related"].includes(link.kind)
      )
        fail("IMPORT_VALIDATION", "Некорректная связь");
      if (link.kind === "dependency") {
        const queue = [link.target],
          seen = new Set<string>();
        while (queue.length) {
          const id = queue.shift()!;
          if (id === link.source) fail("DEPENDENCY_CYCLE", "Цикл зависимостей");
          if (seen.has(id)) continue;
          seen.add(id);
          queue.push(
            ...links
              .filter((l) => l.kind === "dependency" && l.source === id)
              .map((l) => l.target),
          );
        }
      }
    }
    for (const task of tasks.filter((t) => t.status === "done")) {
      const descendants = new Set<string>(),
        queue = [task.id];
      for (let i = 0; i < queue.length; i++)
        for (const child of tasks)
          if (child.parentId === queue[i] && !descendants.has(child.id)) {
            descendants.add(child.id);
            queue.push(child.id);
          }
      if (
        tasks.some(
          (t) =>
            descendants.has(t.id) &&
            !t.deletedAt &&
            !["done", "cancelled"].includes(t.status),
        ) ||
        links.some(
          (l) =>
            l.kind === "dependency" &&
            l.source === task.id &&
            (tasks.find((t) => t.id === l.target)?.status !== "done" ||
              tasks.find((t) => t.id === l.target)?.deletedAt),
        )
      )
        fail(
          "IMPORT_VALIDATION",
          "Некорректно завершённый родитель или зависимость",
        );
    }
    for (const [kind, records] of [
      ["category", categories],
      ["project", projects],
      ["task", tasks],
    ] as const)
      for (const record of records)
        if (!this.scope || kind === "task") this.put(this.namespace(actor), kind, record);
    for (const link of links) {
      const [source, target] =
        link.kind === "related"
          ? [link.source, link.target].sort()
          : [link.source, link.target];
      this.db
        .prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)")
        .run(this.namespace(actor), source, target, link.kind);
    }
    for (const p of data.positions as {
      taskId: string;
      x: number;
      y: number;
    }[]) {
      if (
        !tasks.some((t) => t.id === p.taskId) ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y)
      )
        fail("IMPORT_VALIDATION", "Некорректная позиция");
      this.db
        .prepare("INSERT INTO positions VALUES(?,?,?,?)")
        .run(this.namespace(actor), p.taskId, p.x, p.y);
    }
    for (const history of data.history as Args[]) {
      if (this.scope) {
        for (const snapshot of [history.before, history.after])
          if (snapshot && typeof snapshot === "object" &&
            (("projectId" in snapshot && snapshot.projectId !== this.scope.id) ||
              ("id" in snapshot && snapshot.id !== history.taskId)))
            fail("SCOPE_CONFLICT", "История импорта относится к другому проекту", 409);
        const operation = history.operation as Args | undefined;
        if (operation && [operation.source, operation.target].some((id) => id && !ids.has(String(id))))
          fail("SCOPE_CONFLICT", "История импорта содержит чужую связь", 409);
      }
      if (
        !ids.has(String(history.taskId)) ||
        typeof history.actor !== "string" ||
        typeof history.action !== "string" ||
        typeof history.id !== "string" ||
        !validTimestamp(history.at)
      )
        fail("IMPORT_VALIDATION", "Некорректная запись истории");
      this.db
        .prepare("INSERT INTO changes(owner_id,task_id,data) VALUES(?,?,?)")
        .run(
          this.namespace(actor),
          String(history.taskId),
          JSON.stringify({
            ...history,
            originalActor: history.actor,
            actor: `import:${actor.id}`,
            importedAt: new Date().toISOString(),
            importedBy: actor.id,
          }),
        );
    }
    for (const task of tasks)
      this.log(actor, "import_data", null, task, args.reason);
    return {
      imported: tasks.length,
      categories: categories.length,
      projects: projects.length,
    };
  }
  seedDemo(actor: Actor) {
    if (this.rows(actor.id, "project").length) return;
    const run = (tool: string, args: Args) =>
      this.execute(tool, { ...args, requestId: randomUUID() }, actor) as Task;
    const category = run("create_category", { title: "Работа" });
    const project = run("create_project", {
      title: "Регламент взаимодействия с VDC",
      categoryId: category.id,
    });
    const root = run("create_task", {
      projectId: project.id,
      title: "Регламент взаимодействия с VDC",
      description:
        "Синтетический демонстрационный проект. Статусы не отражают реальную работу.",
      criteria: ["Автоматизация проверена", "Документ согласован отдельно"],
    });
    const automation = run("create_task", {
      projectId: project.id,
      parentId: root.id,
      title: "Настроить автоматизацию",
      status: "in_progress",
      criteria: ["Все сценарии автоматизации проверены"],
    });
    for (const title of [
      "Описать процесс",
      "Определить события и действия",
      "Реализовать",
      "Проверить",
    ])
      run("create_task", {
        projectId: project.id,
        parentId: automation.id,
        title,
        criteria: ["Результат подготовлен и проверен"],
      });
    const approval = run("create_task", {
      projectId: project.id,
      parentId: root.id,
      title: "Согласовать документ",
      criteria: ["Получено отдельное подтверждение согласования"],
    });
    for (const title of [
      "Подготовить редакцию",
      "Собрать замечания",
      "Внести правки",
      "Получить согласование",
    ])
      run("create_task", {
        projectId: project.id,
        parentId: approval.id,
        title,
        criteria: ["Есть подтверждение результата"],
      });
  }
}
