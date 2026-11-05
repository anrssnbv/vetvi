import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newRequestId } from "./request-id";
import { isOverdue as overdue, localDate as today, sectionProjects, sectionTasks, sidebarGroups, type StorageView } from "./task-view";
import { ChatWindow } from "./ChatWindow";
import { TaskAssignments } from "./TaskAssignments";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Edge,
} from "@xyflow/react";
import {
  Network,
  Search,
  Plus,
  LayoutList,
  Workflow,
  ChevronDown,
  ChevronRight,
  X,
  ArrowUpRight,
  CalendarDays,
  SlidersHorizontal,
  Check,
  Circle,
  MoreHorizontal,
  Folder,
  Archive,
  Trash2,
  Download,
  Upload,
  LogOut,
  RotateCcw,
  GitBranch,
  CheckCheck,
  Link as LinkIcon,
  Sparkles,
} from "lucide-react";

type Task = {
  id: string;
  projectId: string;
  parentId: string | null;
  assigneeId?: string | null;
  collaboratorIds?: string[];
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  dueAt: string | null;
  criteria: string[];
  waitingReason: string;
  result: string;
  version: number;
  order: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  evidence: { id: string; url: string; note: string }[];
  position?: { x: number; y: number } | null;
  dependencies?: string[];
  related?: string[];
  openChildren?: boolean;
  openDependencies?: boolean;
  progress: { done: number; total: number; percent: number };
  history?: Record<string, unknown>[];
};
type Project = { id: string; categoryId: string; title: string; version: number; deletedAt?: string | null; personal?: boolean };
type Member = { id?: string; user_id?: string; username?: string; display_name: string; active: boolean };
type Session = { authenticated: boolean; shared?: boolean; actor?: { id: string; display_name?: string; role?: string }; identity?: { actor: { id: string; display_name?: string; role?: string } } };
type Category = { id: string; title: string };
const statuses: Record<string, string> = {
  planned: "Запланировано",
  in_progress: "Выполняется",
  waiting: "Ожидает",
  review: "На проверке",
  done: "Выполнено",
  cancelled: "Отменено",
};
const priorities: Record<string, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  urgent: "Срочный",
};
const apiBase = `${import.meta.env.BASE_URL}api`;
const dateLabel = (t: Task) =>
  t.dueDate
    ? new Date(`${t.dueDate}T12:00:00Z`).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        timeZone: "Asia/Almaty",
      })
    : t.dueAt
      ? new Date(t.dueAt).toLocaleString("ru-RU", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Almaty",
        })
      : "Без срока";
let accessEpoch = 0;
function accessDenied(status: number) {
  accessEpoch++;
  window.dispatchEvent(new CustomEvent("vetvi-access-denied", { detail: status }));
}
async function requestJson<T>(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const epoch = accessEpoch;
  const response = await fetch(`${apiBase}${path}`, {
    method, credentials: "same-origin",
    headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }).catch(() => { throw new Error("Нет соединения с сервером. Результат операции неизвестен; перечитайте данные перед повтором."); });
  if ([401, 403, 404].includes(response.status)) accessDenied(response.status);
  let body: any;
  try { body = response.status === 204 ? undefined : await response.json(); }
  catch { throw new Error("Сервер вернул непонятный ответ. Повторите позже."); }
  if (!response.ok) {
    const messages: Record<number, string> = { 401: path === "/login" ? "Неверный логин или пароль." : "Сессия истекла. Войдите снова.", 403: "Доступ изменился. Обновляем доступное пространство.", 404: "Запись больше недоступна.", 409: "Данные изменились. Перечитайте их перед повтором." };
    const projectError = body?.code === "OPEN_PROJECT_TASKS" && typeof body.message === "string" ? body.message : undefined;
    throw new Error(projectError || messages[response.status] || (typeof body?.message === "string" && /[А-Яа-яЁё]/.test(body.message) ? body.message : "Не удалось выполнить запрос. Повторите позже."));
  }
  if (epoch !== accessEpoch) throw new Error("Доступ изменился. Обновите данные.");
  return body as T;
}
async function api<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  return requestJson<T>(`/tools/${tool}`, "POST", args);
}
function layoutPositions(tasks: Task[]) {
  const ids = new Set(tasks.map((t) => t.id));
  let row = 0;
  const result = new Map<string, { x: number; y: number }>();
  const walk = (t: Task, depth: number) => {
    const children = tasks
      .filter((x) => x.parentId === t.id)
      .sort((a, b) => a.order - b.order);
    const start = row;
    children.forEach((c) => walk(c, depth + 1));
    if (!children.length) row++;
    result.set(t.id, {
      x: depth * 335,
      y: children.length ? (start + row - 1) * 95 : start * 190,
    });
  };
  tasks
    .filter((t) => !t.parentId || !ids.has(t.parentId))
    .forEach((t) => walk(t, 0));
  return result;
}
type GraphData = {
  task: Task;
  progress: Task["progress"];
  children: number;
  overdue: boolean;
  collapsed: boolean;
  onAdd: (t: Task) => void;
  onCollapse: (id: string) => void;
};
type GraphNode = Node<GraphData, "task">;
function TaskNode({ data, selected }: NodeProps<GraphNode>) {
  const t = data.task;
  return (
    <div
      className={`task-node ${selected ? "selected" : ""} status-${t.status}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-top">
        <span className={`status-dot ${t.status}`} />
        <span>{statuses[t.status]}</span>
        <MoreHorizontal size={16} />
      </div>
      <div className="node-title">{t.title}</div>
      {data.children > 0 && (
        <div className="node-progress">
          <div>
            <i style={{ width: `${data.progress.percent}%` }} />
          </div>
          <span>
            {data.progress.done}/{data.progress.total}
          </span>
        </div>
      )}
      <div className="node-bottom">
        <span className={data.overdue ? "overdue" : ""}>
          <CalendarDays size={12} />
          {dateLabel(t)}
        </span>
        <span className={`priority ${t.priority}`}>
          {priorities[t.priority]}
        </span>
      </div>
      <button
        className="node-add nodrag"
        title={`Добавить подзадачу: ${t.title}`}
        onClick={(e) => {
          e.stopPropagation();
          data.onAdd(t);
        }}
      >
        <Plus size={14} />
      </button>
      {data.children > 0 && (
        <button
          className="node-collapse nodrag"
          title="Свернуть или раскрыть ветку"
          onClick={(e) => {
            e.stopPropagation();
            data.onCollapse(t.id);
          }}
        >
          {data.collapsed ? (
            <ChevronRight size={12} />
          ) : (
            <ChevronDown size={12} />
          )}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { task: TaskNode };

export default function App() {
  const running = useRef(false);
  const refreshRequest = useRef(0);
  const [shared, setShared] = useState(false), [actor, setActor] = useState<Session["actor"]>();
  const authenticatedRef = useRef(false);
  const projectIdRef = useRef("");
  const selectedRef = useRef<Task | null>(null), taskEditing = useRef(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]), [canManage, setCanManage] = useState(false), [memberVersion, setMemberVersion] = useState(0);
  const [projectDeleteAccess, setProjectDeleteAccess] = useState({ id: "", allowed: false });
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [projectConfirmation, setProjectConfirmation] = useState(""), [projectDeleteError, setProjectDeleteError] = useState("");
  const projectDeleteRequest = useRef("");
  const [memberModal, setMemberModal] = useState(false), [memberUsername, setMemberUsername] = useState(""), [memberActive, setMemberActive] = useState(true);
  const [personalProject, setPersonalProject] = useState(false);
  const [memberCandidates, setMemberCandidates] = useState<{id: string; username: string; display_name: string}[]>([]);
  const [candidateError, setCandidateError] = useState("");
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const membershipRequest = useRef<{ body: string; key: string } | null>(null);
  const [transferOpen, setTransferOpen] = useState(false), [transferTarget, setTransferTarget] = useState(""), [confirmSharing, setConfirmSharing] = useState(false);
  const transferRequest = useRef<{ body: string; key: string } | null>(null);
  const [auth, setAuth] = useState<boolean | null>(null),
    [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<Project[]>([]),
    [categories, setCategories] = useState<Category[]>([]),
    [projectId, setProjectId] = useState(""),
    [tasks, setTasks] = useState<Task[]>([]),
    [activeTasks, setActiveTasks] = useState<Task[]>([]),
    [selected, setSelected] = useState<Task | null>(null);
  useEffect(() => {
    let active = true;
    setMemberCandidates([]); setCandidateError(""); setMemberUsername(""); setMemberActive(true);
    if (!memberModal || !canManage || !projectId) return;
    setCandidatesLoading(true);
    void (async () => {
      const items: {id: string; username: string; display_name: string}[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: {items: typeof items; next_offset: number | null} = await requestJson(`/projects/${encodeURIComponent(projectId)}/member-candidates?offset=${offset}`);
        if (!active) return;
        items.push(...page.items); offset = page.next_offset;
      }
      if (active) setMemberCandidates(items);
    })().catch((failure: unknown) => {
      if (active) setCandidateError(failure instanceof Error ? failure.message : "Не удалось загрузить сотрудников.");
    }).finally(() => { if (active) setCandidatesLoading(false); });
    return () => { active = false; };
  }, [memberModal, canManage, projectId]);
  const [view, setView] = useState("graph"),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [due, setDue] = useState(""),
    [category, setCategory] = useState(""),
    [hideDone, setHideDone] = useState(false),
    [storageView, setStorageView] = useState<StorageView>("active"),
    [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set()),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [filters, setFilters] = useState(false);
  const initializedProject = useRef("");
  const [flow, setFlow] = useState<ReactFlowInstance<GraphNode> | null>(null);
  useEffect(() => {
    if (!flow) return;
    const el = document.querySelector(".canvas-area");
    if (!el) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (el.isConnected && el.clientWidth && el.clientHeight)
          void flow.fitView({ padding: 0.18, maxZoom: 1 });
      }, 60);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [flow]);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [create, setCreate] = useState<{ parentId: string | null } | null>(
      null,
    ),
    [newTitle, setNewTitle] = useState(""),
    [projectModal, setProjectModal] = useState(false),
    [newProject, setNewProject] = useState(""),
    [newCategory, setNewCategory] = useState("");
  const [completion, setCompletion] = useState(false),
    [result, setResult] = useState(""),
    [deletePreview, setDeletePreview] = useState<Task[] | null>(null),
    [importText, setImportText] = useState<string | null>(null);
  selectedRef.current = selected;
  projectIdRef.current = projectId;
  const clearPrivate = useCallback(() => {
    refreshRequest.current++;
    setCollapsedCategories(new Set());
    setProjectToDelete(null); setProjectConfirmation(""); setProjectDeleteError(""); setProjectDeleteAccess({ id: "", allowed: false });
    setProjects([]); setCategories([]); setTasks([]); setActiveTasks([]); setSelected(null); selectedRef.current = null; taskEditing.current = false;
    setProjectId(""); setAgentOpen(false); setMembers([]); setCanManage(false); setMemberVersion(0);
    setMemberModal(false); setMemberUsername(""); setTransferOpen(false); setTransferTarget(""); setConfirmSharing(false); setCreate(null); setCompletion(false); setDeletePreview(null); setImportText(null); setProjectModal(false);
    setNewTitle(""); setNewProject(""); setNewCategory(""); setResult(""); setQuery(""); setNotice("");
  }, []);
  const refresh = useCallback(async () => {
    const epoch = accessEpoch;
    const request = ++refreshRequest.current;
    const p = await api<{ items: Project[]; categories: Category[] }>(
      "list_projects",
      { limit: 100, includeDeleted: storageView === "trash" },
    );

    const readTasks = async (storage: StorageView) => {
      let offset = 0;
      const all: Task[] = [];
      while (true) {
        const page = await api<{ items: Task[]; total: number }>("search_tasks", {
          limit: 200, offset, archived: storage === "archive", deleted: storage === "trash",
        });
        all.push(...page.items);
        if (all.length >= page.total || !page.items.length) return all;
        offset += page.items.length;
      }
    };
    const [active, stored] = await Promise.all([
      readTasks("active"), storageView === "active" ? Promise.resolve(null) : readTasks(storageView),
    ]);
    if (epoch !== accessEpoch || request !== refreshRequest.current) return;
    const allowed = new Set(p.items.map((item) => item.id));
    if (projectIdRef.current && !allowed.has(projectIdRef.current)) {
      setProjectToDelete(null); setProjectConfirmation(""); setProjectDeleteError("");
      accessEpoch++; setTransferOpen(false); setConfirmSharing(false); setMemberModal(false); setMembers([]); setCanManage(false); setCreate(null); setCompletion(false); setDeletePreview(null); setImportText(null); setSelected(null); selectedRef.current = null; setAgentOpen(false);
    }
    setProjects(p.items); setCategories(p.categories);
    const all = (stored ?? active).filter((task) => allowed.has(task.projectId));
    const available = sectionProjects(p.items, sectionTasks(all, storageView, due), storageView, due);
    const nextProject = available.some(p => p.id === projectIdRef.current) ? projectIdRef.current : available[0]?.id || "";
    projectIdRef.current = nextProject; setProjectId(nextProject);
    setTasks(all); setActiveTasks(active.filter((task) => allowed.has(task.projectId)));
    const current = selectedRef.current;
    if (current && !p.items.some((item) => item.id === current.projectId)) {
      setSelected(null); selectedRef.current = null; setAgentOpen(false); setCompletion(false); setDeletePreview(null); setCreate(null); setImportText(null);
    }
  }, [storageView, due]);
  useEffect(() => {
    const denied = () => { clearPrivate(); setAuth(false); authenticatedRef.current = false; setActor(undefined); };
    window.addEventListener("vetvi-access-denied", denied);
    return () => window.removeEventListener("vetvi-access-denied", denied);
  }, [clearPrivate]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await requestJson<Session>("/session");
        if (!active) return;
        setShared(current.shared === true);
        setActor(current.identity?.actor ?? current.actor);
        authenticatedRef.current = current.authenticated; setAuth(current.authenticated);
        if (!current.authenticated) { accessEpoch++; clearPrivate(); }
        else if (current.shared) {
          await refresh();
          const currentProject = projectIdRef.current;
          if (currentProject) {
            const [access, membership] = await Promise.all([
              requestJson<{ can_manage: boolean; can_write: boolean; can_edit_project: boolean }>(`/projects/${encodeURIComponent(currentProject)}/access`),
              requestJson<{ items: Member[]; row_version: number }>(`/projects/${encodeURIComponent(currentProject)}/members`),
            ]);
            if (active && projectIdRef.current === currentProject) { setCanManage(access.can_manage === true); setMembers(membership.items); setMemberVersion(membership.row_version); setProjectDeleteAccess({ id: currentProject, allowed: access.can_write === true && access.can_edit_project === true }); }
          }
          const task = selectedRef.current;
          if (task) {
            const updated = await api<Task>("get_task", { id: task.id });
            if (active && selectedRef.current?.id === task.id && !taskEditing.current) setSelected(updated);
          }
        }
      } catch (failure) { if (active) { if (!authenticatedRef.current) setAuth(false); setError(failure instanceof Error ? failure.message : "Сервер недоступен."); } }
      if (active) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [clearPrivate, refresh]);
  useEffect(() => {
    if (auth) refresh().catch((failure) => setError(failure.message));
  }, [auth, refresh]);
  useEffect(() => {
    let active = true;
    setMembers([]); setCanManage(false); setMemberVersion(0);
    setProjectDeleteAccess({ id: "", allowed: false });
    if (auth && shared && projectId) {
      void Promise.all([
        requestJson<{can_manage: boolean; can_write: boolean; can_edit_project: boolean}>(`/projects/${encodeURIComponent(projectId)}/access`),
        requestJson<{items: Member[]; row_version: number}>(`/projects/${encodeURIComponent(projectId)}/members`),
      ]).then(([access, data]) => {
        if (active) { setCanManage(access.can_manage === true); setMembers(data.items); setMemberVersion(data.row_version); setProjectDeleteAccess({ id: projectId, allowed: access.can_write === true && access.can_edit_project === true }); }
      }).catch((failure) => { if (active) setError(failure.message); });
    }
    return () => { active = false; };
  }, [auth, shared, projectId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const mutate = async (
    tool: string,
    args: Record<string, unknown>,
    task?: Task,
  ) => {
    const value = await api<Task>(tool, {
      ...args,
      ...(task ? { id: task.id, expectedVersion: task.version } : {}),
      requestId: newRequestId(),
    });
    await refresh();
    if (task && selectedRef.current?.id === task.id) {
      const updated = await api<Task>("get_task", { id: task.id });
      if (selectedRef.current?.id === task.id) setSelected(updated);
    }
    return value;
  };
  const select = async (t: Task) => {
    setError(""); setAgentOpen(false); taskEditing.current = false;
    const epoch = accessEpoch;
    try {
      const current = await api<Task>("get_task", { id: t.id });
      if (epoch === accessEpoch && projectIdRef.current === t.projectId) setSelected(current);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openAdd = useCallback((t: Task) => {
    setCreate({ parentId: t.id });
    setNewTitle("");
  }, []);
  const onCollapse = useCallback(
    (id: string) =>
      setCollapsed((old) => {
        const next = new Set(old);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const matchingTasks = useMemo(() => sectionTasks(tasks, storageView, due), [tasks, storageView, due]);
  const listedProjects = useMemo(() => sectionProjects(projects, matchingTasks, storageView, due), [projects, matchingTasks, storageView, due]);
  const navigationGroups = useMemo(() => sidebarGroups(listedProjects, categories), [listedProjects, categories]);
  useEffect(() => {
    if (listedProjects.some(p => p.id === projectId)) return;
    const next = listedProjects[0]?.id || "";
    projectIdRef.current = next; setProjectId(next); setSelected(null); setAgentOpen(false);
  }, [listedProjects, projectId]);
  const openSection = (storage: StorageView, deadline = "") => {
    if (storage !== storageView || deadline !== due) refreshRequest.current++;
    setStorageView(storage); setDue(deadline); setStatus(""); setCategory(""); setQuery(""); setHideDone(false);
    setSelected(null); setAgentOpen(false); setFilters(false);
    setCollapsedCategories(new Set());
    setView(storage !== "active" || deadline === "overdue" ? "list" : "graph");
  };
  const openProject = (id: string) => {
    projectIdRef.current = id; setProjectId(id); setSelected(null); setAgentOpen(false);
    setView(storageView === "active" && due === "overdue" ? "list" : "graph");
  };
  const project = listedProjects.find((p) => p.id === projectId);
  const chatProject = projects.find((p) => p.id === selected?.projectId);
  const canDeleteProject = !shared || projectDeleteAccess.id === projectId && projectDeleteAccess.allowed;
  const unfinishedProjectTasks = activeTasks.filter(task => task.projectId === projectToDelete?.id && !["done", "cancelled"].includes(task.status));
  const projectDeletionReady = !!projectToDelete && projectConfirmation === projectToDelete.title &&
    unfinishedProjectTasks.length === 0 && (!shared || projectDeleteAccess.id === projectToDelete.id && projectDeleteAccess.allowed);
  const allProjectTasks = useMemo(() => tasks.filter(t => t.projectId === projectId), [tasks, projectId]);
  const projectTasks = useMemo(
    () => matchingTasks.filter((t) => t.projectId === projectId),
    [matchingTasks, projectId],
  );
  const nextTask = selected?.status === "done" && storageView === "active"
    ? tasks.filter((task) => task.projectId === selected.projectId &&
        task.id !== selected.id && !["done", "cancelled"].includes(task.status) &&
        !task.archivedAt && !task.deletedAt && task.openChildren === false &&
        task.openDependencies === false && (!task.assigneeId || task.assigneeId === actor?.id))
      .sort((first, second) => first.order - second.order)[0]
    : undefined;
  useEffect(() => {
    if (
      !projectId ||
      !projectTasks.length ||
      initializedProject.current === projectId
    )
      return;
    initializedProject.current = projectId;
    setCollapsed(
      new Set(
        projectTasks
          .filter(
            (t) => t.parentId && projectTasks.some((x) => x.parentId === t.id),
          )
          .map((t) => t.id),
      ),
    );
  }, [projectId, projectTasks]);
  const visible = useMemo(
    () =>
      projectTasks.filter((t) => {
        if (category && project?.categoryId !== category) return false;
        if (
          query &&
          !`${t.title} ${t.description}`
            .toLowerCase()
            .includes(query.toLowerCase())
        )
          return false;
        if (status && t.status !== status) return false;
        if (hideDone && ["done", "cancelled"].includes(t.status)) return false;
        if (due === "overdue" && !overdue(t)) return false;
        if (
          due === "today" &&
          t.dueDate !== today() &&
          (!t.dueAt ||
            new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Almaty",
            }).format(new Date(t.dueAt)) !== today())
        )
          return false;
        if (due === "none" && (t.dueDate || t.dueAt)) return false;
        let p = t.parentId;
        const seen = new Set<string>();
        while (p && !seen.has(p)) {
          seen.add(p);
          if (collapsed.has(p) && view === "graph" && due !== "overdue") return false;
          const parent = projectTasks.find((x) => x.id === p);
          if (
            hideDone &&
            parent &&
            ["done", "cancelled"].includes(parent.status)
          )
            return false;
          p = parent?.parentId || null;
        }
        return true;
      }),
    [
      projectTasks,
      category,
      project,
      query,
      status,
      hideDone,
      due,
      collapsed,
      view,
    ],
  );
  useEffect(() => {
    const positions = layoutPositions(visible);
    setNodes(
      visible.map((t) => ({
        id: t.id,
        type: "task",
        position: t.position || positions.get(t.id)!,
        selected: selected?.id === t.id,
        data: {
          task: t,
          progress: t.progress,
          children: allProjectTasks.filter((x) => x.parentId === t.id).length,
          overdue: storageView === "active" && overdue(t),
          collapsed: collapsed.has(t.id),
          onAdd: openAdd,
          onCollapse,
        },
      })),
    );
  }, [
    visible,
    projectTasks,
    allProjectTasks,
    storageView,
    selected?.id,
    collapsed,
    openAdd,
    onCollapse,
    setNodes,
  ]);
  useEffect(() => {
    if (!flow) return;
    const timer = setTimeout(() => {
      void flow.fitView({ padding: 0.18, maxZoom: 1 });
    }, 80);
    return () => clearTimeout(timer);
  }, [flow, visible.length]);
  const edges: Edge[] = visible
    .flatMap((t) =>
      t.parentId && visible.some((x) => x.id === t.parentId)
        ? [
            {
              id: `tree-${t.id}`,
              source: t.parentId,
              target: t.id,
              type: "smoothstep",
              style: { stroke: "#c4d1ca", strokeWidth: 1.6 },
            },
          ]
        : [],
    )
    .concat(
      visible.flatMap((t) =>
        (t.dependencies || [])
          .filter((id) => visible.some((x) => x.id === id))
          .map((id) => ({
            id: `dep-${t.id}-${id}`,
            source: id,
            target: t.id,
            type: "smoothstep",
            animated: false,
            style: {
              stroke: "#b5a1d7",
              strokeWidth: 1.6,
              strokeDasharray: "5 5",
            },
            label: "зависимость",
          })),
      ),
    );
  for (const t of visible)
    for (const id of t.related || []) {
      if (t.id < id && visible.some((x) => x.id === id))
        edges.push({
          id: `related-${t.id}-${id}`,
          source: t.id,
          target: id,
          type: "smoothstep",
          style: { stroke: "#a3b8cd", strokeDasharray: "2 5" },
          label: "связь",
        });
    }
  const doneCount = projectTasks.filter((t) => t.status === "done").length;
  if (auth === null)
    return <div className="login-screen">Загрузка пространства…</div>;
  if (!auth)
    return (
      <div className="login-screen">
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              accessEpoch++;
              clearPrivate();
              const logged = await requestJson<Session>("/login", "POST", { username, password });
              setPassword(""); setActor(logged.identity?.actor ?? logged.actor);
              const current = await requestJson<Session>("/session");
              setShared(current.shared === true);
              authenticatedRef.current = current.authenticated; setAuth(current.authenticated);
              setActor(current.identity?.actor ?? current.actor); setError("");
            });
          }}
        >
          <h1>Space</h1>
          <label>
            Логин
            <input
              autoFocus
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={200}
              required
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            Войти
          </button>
        </form>
      </div>
    );
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand workspace-brand" href={import.meta.env.BASE_URL} aria-label="Space">
          <div className="brand-icon">
            <GitBranch size={22} />
          </div>
          <span>Space</span>
        </a>
        <div className="side-label">ПРОСТРАНСТВО</div>
        <button
          className={`nav ${storageView === "active" && due !== "overdue" ? "active" : ""}`}
          onClick={() => openSection("active")}
        >
          <Network size={18} />
          Все проекты<span>{projects.length}</span>
        </button>
        <button
          className={`nav ${storageView === "active" && due === "overdue" ? "active" : ""}`}
          onClick={() => openSection("active", "overdue")}
        >
          <CalendarDays size={18} />
          Просроченные<span>{activeTasks.filter(t => overdue(t)).length}</span>
        </button>
        <div className="side-label project-label">
          {storageView === "archive" ? "ПРОЕКТЫ В АРХИВЕ" : storageView === "trash" ? "ПРОЕКТЫ В КОРЗИНЕ" : due === "overdue" ? "ПРОЕКТЫ С ПРОСРОЧКОЙ" : "МОИ ПРОЕКТЫ"}
          {storageView === "active" && due !== "overdue" && <button title="Создать проект" onClick={() => setProjectModal(true)}>
            <Plus size={15} />
          </button>}
        </div>
        <div className="project-nav">
          {navigationGroups.map((group) => (
            <div key={group.id}>
              <button
                type="button"
                className={`category-label ${group.project?.id === projectId ? "chosen" : ""}`}
                aria-expanded={!collapsedCategories.has(group.id)}
                aria-controls={`project-category-${group.id}`}
                onClick={() => {
                  if (group.project) openProject(group.project.id);
                  setCollapsedCategories(current => {
                    const next = new Set(current);
                    if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                    return next;
                  });
                }}
              >
                {collapsedCategories.has(group.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="category-dot" />
                <span className="category-title">{group.title}</span>
              </button>
              <div id={`project-category-${group.id}`} hidden={collapsedCategories.has(group.id)}>
              {group.project ? (
                matchingTasks.some(task => task.projectId === group.project?.id && !task.parentId) ?
                  matchingTasks.filter(task => task.projectId === group.project?.id && !task.parentId).map(task => (
                    <button
                      type="button"
                      key={task.id}
                      className={`project-task ${selected?.id === task.id ? "chosen" : ""}`}
                      title={task.title}
                      onClick={() => { openProject(task.projectId); void select(task); }}
                    >
                      <span className={`status-dot ${task.status}`} />
                      <span>{task.title}</span>
                    </button>
                  )) : <p className="sidebar-empty">В проекте пока нет задач</p>
              ) : group.projects.map((p) => (
                  <button
                    key={p.id}
                    className={`project-item ${projectId === p.id ? "chosen" : ""}`}
                    onClick={() => openProject(p.id)}
                  >
                    <GitBranch size={16} />
                    <span>{p.title}{p.personal ? " · Личный" : ""}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {!listedProjects.length && <p className="muted">{storageView === "archive" ? "В архиве нет задач" : storageView === "trash" ? "Корзина пуста" : due === "overdue" ? "Нет просроченных задач" : "Создайте первый проект"}</p>}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav ${storageView === "archive" ? "active" : ""}`}
            onClick={() => openSection("archive")}
          >
            <Archive size={17} />
            Архив
          </button>
          <button
            className={`nav ${storageView === "trash" ? "active" : ""}`}
            onClick={() => openSection("trash")}
          >
            <Trash2 size={17} />
            Корзина
          </button>
          <button
            className="nav"
            onClick={() =>
              run(async () => {
                try { await requestJson("/logout", "POST"); }
                finally { accessEpoch++; authenticatedRef.current = false; setAuth(false); setActor(undefined); clearPrivate(); }
              })
            }
          >
            <LogOut size={17} />
            Выйти
          </button>
        </div>
      </aside>
      <main>
        <section className="project-header">
          <div>
            <div className="eyebrow">ОТ ПЛАНА К РЕЗУЛЬТАТУ</div>
            <h1>
              {storageView === "archive"
                ? "Архив задач"
                : storageView === "trash"
                  ? "Корзина"
                  : project?.title || (due === "overdue" ? "Нет просроченных задач" : "Ваше пространство")}
              <span className="project-icon">
                <GitBranch size={23} />
              </span>
            </h1>
            <p>Большая цель становится ближе, когда виден каждый шаг.</p>
          </div>
          <div className="project-controls">
          {project && canDeleteProject && !project.deletedAt && storageView === "active" && <button className="quiet project-delete" type="button" onClick={() => {
            setProjectToDelete(project); setProjectConfirmation(""); setProjectDeleteError(""); projectDeleteRequest.current = newRequestId();
          }}><Trash2 size={15} />Удалить проект</button>}
          {project?.deletedAt && canDeleteProject && storageView === "trash" && <button className="quiet" disabled={busy} type="button" onClick={() => run(async () => {
            await api("restore_project", { id: project.id, expectedVersion: project.version, requestId: newRequestId() });
            await refresh(); setNotice("Проект восстановлен. Его задачи можно восстановить в корзине.");
          })}><RotateCcw size={15} />Восстановить проект</button>}
          {shared && projectId && <button className="quiet" type="button" onClick={() => setMemberModal(true)}>Участники проекта</button>}
          {storageView === "active" && <button
            className="primary"
            disabled={!projectId}
            onClick={() => {
              setCreate({ parentId: null });
              setNewTitle("");
            }}
          >
            <Plus size={16} />
            Новая задача
          </button>}
          </div>
        </section>
        <div className="mobile-projects">
          <select
            aria-label="Текущий проект"
            value={projectId}
            onChange={(e) => openProject(e.target.value)}
          >
            {!listedProjects.length && <option value="">Нет проектов в этом разделе</option>}
            {listedProjects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          {storageView === "active" && due !== "overdue" && <button
            className="icon-button"
            title="Создать проект"
            onClick={() => setProjectModal(true)}
          >
            <Plus size={17} />
          </button>}
        </div>
        {storageView === "active" && <section className="metrics">
          <div>
            <span className="metric-icon green">
              <Workflow size={19} />
            </span>
            <strong>{projectTasks.length}</strong>
            <span>всего задач</span>
          </div>
          <div>
            <span className="metric-icon amber">
              <Circle size={19} />
            </span>
            <strong>
              {projectTasks.filter((t) => t.status === "in_progress").length}
            </strong>
            <span>в работе</span>
          </div>
          <div>
            <span className="metric-icon lavender">
              <CheckCheck size={19} />
            </span>
            <strong>{doneCount}</strong>
            <span>выполнено</span>
          </div>
          <div className="overall">
            <div>
              <span>Задачи проекта</span>
              <strong>
                {projectTasks.length
                  ? Math.round((doneCount / projectTasks.length) * 100)
                  : 0}
                %
              </strong>
            </div>
            <div className="bar">
              <i
                style={{
                  width: `${projectTasks.length ? (doneCount / projectTasks.length) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        </section>}
        <section className="canvas-shell">
          <div className="toolbar">
            <div className="view-switch">
              <button
                className={view === "graph" ? "on" : ""}
                onClick={() => setView("graph")}
              >
                <Network size={16} />
                Граф
              </button>
              <button
                className={view === "list" ? "on" : ""}
                onClick={() => setView("list")}
              >
                <LayoutList size={16} />
                Список
              </button>
            </div>
            <div className="search">
              <Search size={15} />
              <input
                aria-label="Поиск задач"
                placeholder="Найти задачу…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button title="Очистить поиск" onClick={() => setQuery("")}>
                  <X size={13} />
                </button>
              )}
            </div>
            <button
              className={`quiet ${filters ? "on" : ""}`}
              onClick={() => setFilters(!filters)}
            >
              <SlidersHorizontal size={15} />
              Фильтры
              {(status || due || category || hideDone) && (
                <i className="filter-dot" />
              )}
            </button>
            <span className="toolbar-divider" />
            <button
              className="icon-button"
              title="Экспорт JSON"
              disabled={shared && !projectId}
              onClick={() =>
                run(async () => {
                  const data = await api("export_data", shared ? { projectId } : {});
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(data, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "vetvi-export.json";
                  a.click();
                  URL.revokeObjectURL(url);
                  setNotice("JSON экспортирован");
                })
              }
            >
              <Download size={17} />
            </button>
            <label className="icon-button" title="Импорт JSON">
              <Upload size={17} />
              <input
                hidden
                disabled={shared && !projectId}
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    f.text()
                      .then(setImportText)
                      .catch(() => setError("Не удалось прочитать файл"));
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {filters && (
            <div className="filters">
              <select
                aria-label="Фильтр статуса"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">Все статусы</option>
                {Object.entries(statuses).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                aria-label="Фильтр срока"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              >
                <option value="">Любой срок</option>
                <option value="overdue">Просроченные</option>
                <option value="today">Сегодня</option>
                <option value="none">Без срока</option>
              </select>
              {!shared && <select
                aria-label="Фильтр категории"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Все категории</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>}
              <label>
                <input
                  type="checkbox"
                  checked={hideDone}
                  onChange={(e) => setHideDone(e.target.checked)}
                />
                Скрыть завершённые ветки
              </label>
              <button
                className="text-button"
                onClick={() => {
                  setStatus("");
                  setDue("");
                  setCategory("");
                  setHideDone(false);
                  setQuery("");
                }}
              >
                Сбросить
              </button>
            </div>
          )}
          <div className="canvas-title">
            <span>
              <span className="live-dot" />{" "}
              {view === "graph" ? "Карта проекта" : "Задачи проекта"}
            </span>
            <small>
              {visible.length} задач ·{" "}
              {storageView === "active"
                ? "активное пространство"
                : storageView === "archive"
                  ? "архив"
                  : "удалённые записи"}
            </small>
            {view === "graph" && (
              <button
                className="text-button"
                onClick={() =>
                  run(async () => {
                    const positions = layoutPositions(visible);
                    for (const n of nodes) {
                      const t = tasks.find((t) => t.id === n.id)!;
                      await api("set_position", {
                        id: t.id,
                        expectedVersion: t.version,
                        requestId: newRequestId(),
                        ...positions.get(n.id),
                      });
                    }
                    await refresh();
                    if (selected)
                      setSelected(
                        await api<Task>("get_task", { id: selected.id }),
                      );
                    setNotice("Автораскладка сохранена");
                  })
                }
              >
                <Sparkles size={13} />
                Автораскладка
              </button>
            )}
          </div>
          <div className={`canvas-area ${selected ? "with-panel" : ""}`}>
            {view === "graph" ? (
              <ReactFlow
                key={projectId}
                onInit={setFlow}
                ariaLabelConfig={{
                  "controls.ariaLabel": "Управление графом",
                  "controls.zoomIn.ariaLabel": "Увеличить",
                  "controls.zoomOut.ariaLabel": "Уменьшить",
                  "controls.fitView.ariaLabel": "Показать весь граф",
                  "node.a11yDescription.default":
                    "Для выбора нажмите Enter. Для перемещения используйте клавиши со стрелками.",
                  "node.a11yDescription.keyboardDisabled":
                    "Для выбора нажмите Enter.",
                  "edge.a11yDescription.default": "Связь между задачами",
                  "handle.ariaLabel": "Точка связи",
                }}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onNodeClick={(_, n) => select(n.data.task)}
                onNodeDragStop={(_, n) =>
                  run(async () => {
                    const t = tasks.find((t) => t.id === n.id)!;
                    await mutate(
                      "set_position",
                      { x: n.position.x, y: n.position.y },
                      t,
                    );
                  })
                }
                fitView
                fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
                minZoom={0.15}
                maxZoom={1.6}
                nodesConnectable={false}
                deleteKeyCode={null}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={22} size={1} color="#d8ded9" />
                <Controls showInteractive={false} />
                <div className="graph-hint">
                  <span>
                    <span className="legend-line" />
                    Подзадача
                  </span>
                  <span>
                    <span className="legend-line dashed" />
                    Зависимость
                  </span>
                  <span>
                    <span className="legend-line related" />
                    Связь
                  </span>
                </div>
              </ReactFlow>
            ) : (
              <div className="task-list">
                <div className="list-head">
                  <span>Задача</span>
                  <span>Статус</span>
                  <span>Приоритет</span>
                  <span>Срок</span>
                </div>
                {visible.map((t) => (
                  <button
                    key={t.id}
                    className="list-row"
                    onClick={() => select(t)}
                  >
                    <span>
                      <span className={`status-dot ${t.status}`} />
                      {t.parentId && <GitBranch size={13} />} {t.title}
                    </span>
                    <span className={`status-badge ${t.status}`}>
                      {statuses[t.status]}
                    </span>
                    <span>{priorities[t.priority]}</span>
                    <span className={storageView === "active" && overdue(t) ? "overdue" : ""}>
                      {dateLabel(t)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!visible.length && (
              <div className="empty-state">
                <GitBranch size={35} />
                <h3>
                  {storageView === "archive" ? "В архиве нет задач" : storageView === "trash" ? "Корзина пуста" : due === "overdue" ? "Нет просроченных задач" : projectId
                    ? "Здесь есть место для новых идей"
                    : "Начните с проекта"}
                </h3>
                <p>
                  {storageView !== "active" || due === "overdue" ? "Вернитесь ко всем проектам, чтобы продолжить работу." : query || status || due || category
                    ? "Измените поиск или фильтры."
                    : "Добавьте цель, затем разложите её на шаги."}
                </p>
                {storageView === "active" && due !== "overdue" ? <button
                  className="primary"
                  onClick={() =>
                    projectId
                      ? setCreate({ parentId: null })
                      : setProjectModal(true)
                  }
                >
                  <Plus size={15} />
                  {projectId ? "Добавить задачу" : "Создать проект"}
                </button> : <button className="quiet" onClick={() => openSection("active")}>Все проекты</button>}
              </div>
            )}
          </div>
        </section>
      </main>
      {selected && (
        <TaskPanel
          key={`${selected.id}-${selected.version}`}
          task={selected}
          tasks={allProjectTasks}
          shared={shared}
          nextTaskTitle={nextTask?.title}
          onNext={nextTask ? () => { void select(nextTask); } : undefined}
          onDirty={(dirty) => { taskEditing.current = dirty; }}
          onAgent={() => { if (chatProject) setAgentOpen(true); else setError("Проект задачи недоступен. Обновите страницу."); }}
          onTransfer={shared && projects.some((item) => item.id === selected.projectId && item.personal) ? () => { setTransferOpen(true); setConfirmSharing(false); setTransferTarget((old) => projects.some((item) => item.id === old && item.personal === false) ? old : projects.find((item) => item.personal === false)?.id || ""); } : undefined}
          busy={busy}
          onClose={() => setSelected(null)}
          onSave={(patch) =>
            run(async () => {
              await mutate("update_task", patch, selected);
              setNotice("Изменения сохранены");
            })
          }
          onAdd={() => openAdd(selected)}
          onMove={(parentId) =>
            run(async () => {
              await mutate("move_task", { parentId }, selected);
              setNotice("Ветка перенесена вместе с подзадачами");
            })
          }
          onComplete={() => {
            setCompletion(true);
            setResult("");
          }}
          onReopen={() =>
            run(async () => {
              await mutate(
                "reopen_task",
                { reason: "Повторно открыта владельцем из интерфейса" },
                selected,
              );
              setNotice("Задача открыта повторно");
            })
          }
          onArchive={() =>
            run(async () => {
              await mutate(
                "archive_task",
                { archived: !selected.archivedAt },
                selected,
              );
              setSelected(null);
              setNotice(
                selected.archivedAt
                  ? "Задача возвращена из архива"
                  : "Задача архивирована",
              );
            })
          }
          onRestore={() =>
            run(async () => {
              await mutate("restore_task", {}, selected);
              setSelected(null);
              setNotice("Задача восстановлена");
            })
          }
          onDelete={() =>
            run(async () => {
              const p = await api<any>("preview_delete", { id: selected.id });
              setDeletePreview(Array.isArray(p) ? p : p.items || p.tasks || []);
            })
          }
          onLink={(tool, targetId) =>
            run(async () => {
              await mutate(
                tool,
                { dependencyId: targetId, targetId },
                selected,
              );
              setNotice("Связи сохранены");
            })
          }
          onEvidence={(url, note) =>
            run(async () => {
              await mutate("add_evidence", { url, note }, selected);
              setNotice("Подтверждение добавлено");
            })
          }
        />
      )}
      {error && (
        <div className="toast error" role="alert">
          <span>{error}</span>
          <button title="Закрыть ошибку" onClick={() => setError("")}>
            <X size={16} />
          </button>
          <button
            onClick={() =>
              run(async () => {
                await refresh();
                if (selected) await select(selected);
              })
            }
          >
            Обновить данные
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {agentOpen && selected && chatProject && <ChatWindow key={`${chatProject.id}:${selected.id}`} project={chatProject} task={selected} onClose={() => setAgentOpen(false)} />}
      {create && (
        <Modal
          title={create.parentId ? "Новая подзадача" : "Новая задача"}
          close={() => setCreate(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const t = await mutate("create_task", {
                  projectId,
                  parentId: create.parentId,
                  title: newTitle,
                });
                setCreate(null);
                await select(t);
                setNotice("Задача создана");
              });
            }}
          >
            <label>
              Название
              <input
                autoFocus
                required
                maxLength={500}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Какой следующий шаг?"
              />
            </label>
            <p className="muted">
              {create.parentId
                ? `Ветка: ${tasks.find((t) => t.id === create.parentId)?.title}`
                : `Проект: ${project?.title}`}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="quiet"
                onClick={() => setCreate(null)}
              >
                Отмена
              </button>
              <button className="primary" disabled={busy || !newTitle.trim()}>
                Создать задачу
              </button>
            </div>
          </form>
        </Modal>
      )}
      {transferOpen && selected && projects.some((item) => item.id === selected.projectId && item.personal) && <Modal title="Перенос в совместный проект" close={() => setTransferOpen(false)}>
        <p>Переносит задачу вместе со всеми подзадачами. Проверьте участников целевого проекта перед подтверждением.</p>
        <label>Совместный проект<select autoFocus value={transferTarget} onChange={(event) => { setTransferTarget(event.target.value); setConfirmSharing(false); }}><option value="">Выберите проект</option>{projects.filter((item) => item.personal === false).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label className="shared-checkbox"><input type="checkbox" checked={confirmSharing} onChange={(event) => setConfirmSharing(event.target.checked)} />Название, описание, результаты и история этой задачи и всех подзадач станут доступны участникам выбранного проекта.</label>
        <div className="modal-actions"><button type="button" className="quiet" onClick={() => setTransferOpen(false)}>Отмена</button><button type="button" className="primary" disabled={busy || !transferTarget || !confirmSharing} onClick={() => { void run(async () => {
          const fingerprint = JSON.stringify({ id: selected.id, targetProjectId: transferTarget, expectedVersion: selected.version });
          if (transferRequest.current?.body !== fingerprint) transferRequest.current = { body: fingerprint, key: newRequestId() };
          await requestJson(`/tasks/${encodeURIComponent(selected.id)}/transfer`, "POST", { targetProjectId: transferTarget, expectedVersion: selected.version, requestId: transferRequest.current.key, confirmSharing: true });
          transferRequest.current = null;
          await refresh(); openProject(transferTarget);
          setSelected(await api<Task>("get_task", { id: selected.id })); setTransferOpen(false); setConfirmSharing(false); setNotice("Задача и подзадачи перенесены в совместный проект.");
        }); }}>Подтвердить перенос и общий доступ</button></div>
      </Modal>}
      {memberModal && shared && projectId && <Modal title="Участники проекта" close={() => setMemberModal(false)}>
        <p>{projects.find(project => project.id === projectId)?.personal ? "Это личный проект: доступ есть только у владельца, добавление участников недоступно. Для совместной работы создайте общий проект без отметки «Личный проект» и перенесите в него задачи." : canManage ? "Выберите сотрудника по имени, выберите «Добавить в проект» и нажмите «Добавить участника». Учётные записи создаёт администратор отдельно." : "Управлять составом этого общего проекта могут администратор и создатель проекта."}</p>

        {canManage && <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          const body = { username: memberUsername.trim(), active: memberActive };
          const fingerprint = JSON.stringify({ projectId, body, memberVersion });
          if (membershipRequest.current?.body !== fingerprint) membershipRequest.current = { body: fingerprint, key: newRequestId() };
          await requestJson(`/projects/${encodeURIComponent(projectId)}/members`, "PUT", body, { "If-Match": `"${memberVersion}"`, "Idempotency-Key": membershipRequest.current.key });
          membershipRequest.current = null;
          const updated = await requestJson<{items: Member[]; row_version: number}>(`/projects/${encodeURIComponent(projectId)}/members`);
          setMembers(updated.items); setMemberVersion(updated.row_version); setMemberUsername(""); setMemberActive(true); setNotice("Состав проекта обновлён."); await refresh();
        }); }}>
          {candidateError && <p role="alert">{candidateError}</p>}
          <label>Сотрудник<select autoFocus required disabled={busy || candidatesLoading || !!candidateError} value={memberUsername} onChange={event => setMemberUsername(event.target.value)}>
            <option value="">{candidatesLoading ? "Загрузка сотрудников…" : "Выберите сотрудника"}</option>
            {memberActive ? memberCandidates.filter(candidate => !members.some(member => member.active && (member.id === candidate.id || member.username === candidate.username))).map(candidate => <option key={candidate.id} value={candidate.username}>{candidate.display_name || candidate.username}</option>) : members.filter(member => member.active && member.username).map(member => <option key={member.id || member.user_id} value={member.username}>{member.display_name}</option>)}
          </select></label>
          <label>Действие<select value={memberActive ? "add" : "remove"} onChange={(event) => { setMemberActive(event.target.value === "add"); setMemberUsername(""); }}><option value="add">Добавить в проект</option><option value="remove">Отозвать доступ</option></select></label>
          <div className="modal-actions"><button className="primary" disabled={busy || !memberUsername.trim()}>{memberActive ? "Добавить участника" : "Отозвать доступ"}</button></div>
        </form>}
        <ul className="project-members">{members.map((member) => <li key={member.id || member.user_id}><span>{member.display_name}{member.username ? ` · ${member.username}` : ""}<small>{member.active ? "Доступ открыт" : "Доступ отозван"}</small></span>{canManage && member.active && member.username && <button className="quiet" disabled={busy} onClick={() => { setMemberUsername(member.username!); setMemberActive(false); }}>Отозвать доступ</button>}</li>)}</ul>
      </Modal>}
      {projectModal && (
        <Modal title="Новый проект" close={() => setProjectModal(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                let categoryId: string | undefined;
                if (!shared) {
                  const c = categories.find(c => c.title === newCategory) ??
                    await api<Category>("create_category", { title: newCategory, requestId: newRequestId() });
                  categoryId = c.id;
                }
                const p = await api<Project>("create_project", {
                  title: newProject,
                  ...(categoryId ? { categoryId } : {}),
                  ...(shared ? { personal: personalProject } : {}),
                  requestId: newRequestId(),
                });
                await refresh();
                openProject(p.id);
                setProjectModal(false);
                setNewProject("");
                setNewCategory(""); setPersonalProject(false);
              });
            }}
          >
            <label>
              Название проекта
              <input
                autoFocus
                required
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
              />
            </label>
            {shared && <label className="shared-checkbox"><input type="checkbox" checked={personalProject} onChange={(event) => setPersonalProject(event.target.checked)} />Личный проект — доступ только у меня</label>}
            {!shared && <label>
              Категория
              <input
                required
                list="categories"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
              />
              <datalist id="categories">
                {categories.map((c) => (
                  <option key={c.id}>{c.title}</option>
                ))}
              </datalist>
            </label>}
            <div className="modal-actions">
              <button
                type="button"
                className="quiet"
                onClick={() => setProjectModal(false)}
              >
                Отмена
              </button>
              <button className="primary" disabled={busy}>
                Создать проект
              </button>
            </div>
          </form>
        </Modal>
      )}
      {completion && selected && (
        <Modal
          title="Завершить задачу"
          close={() => setCompletion(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await mutate(
                  "complete_task",
                  {
                    result,
                    reason: "Владелец подтвердил результат",
                  },
                  selected,
                );
                setCompletion(false);
                setNotice("Выполнение подтверждено");
              });
            }}
          >
            <p className="muted">
              Опишите полученный результат. Открытые подзадачи и невыполненные
              зависимости нужно закрыть перед завершением.
            </p>
            <label>
              Полученный результат
              <textarea
                required
                value={result}
                onChange={(e) => setResult(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                className="quiet"
                type="button"
                onClick={() => setCompletion(false)}
              >
                Отмена
              </button>
              <button className="primary" disabled={busy}>
                Подтвердить выполнение
              </button>
            </div>
          </form>
        </Modal>
      )}
      {projectToDelete && (
        <Modal title="Удалить проект?" close={() => { if (!busy) setProjectToDelete(null); }}>
          <form onSubmit={event => {
            event.preventDefault();
            if (!projectDeletionReady) return;
            void run(async () => {
              setProjectDeleteError("");
              try {
                await api("delete_project", { id: projectToDelete.id, expectedVersion: projectToDelete.version,
                  confirmationTitle: projectConfirmation, requestId: projectDeleteRequest.current,
                  reason: "Пользователь подтвердил завершение проекта и отсутствие дальнейшей работы" });
                setProjectToDelete(null); setProjectConfirmation("");
                await refresh(); setNotice("Проект и его задачи перемещены в корзину. История сохранена.");
              } catch (error) {
                setProjectDeleteError(error instanceof Error ? error.message : "Не удалось удалить проект.");
                await refresh();
              }
            });
          }}>
            <p>Проект «{projectToDelete.title}» и его задачи будут перемещены в корзину. Данные и история сохранятся.</p>
            <p className="muted">Удаляя проект, вы подтверждаете, что дальнейшая работа по нему не требуется. Отменённые и архивные задачи не блокируют удаление.</p>
            {unfinishedProjectTasks.length > 0 && <p role="alert" className="error">Сначала завершите активные задачи: осталось {unfinishedProjectTasks.length}.</p>}
            <label className="project-confirmation">Введите точное название: <strong>{projectToDelete.title}</strong>
              <input autoFocus required autoComplete="off" spellCheck={false} disabled={busy} aria-label="Название проекта для удаления"
                value={projectConfirmation} onChange={event => setProjectConfirmation(event.target.value)} />
            </label>
            {projectDeleteError && <p role="alert" className="error">{projectDeleteError}</p>}
            <div className="modal-actions">
              <button type="button" className="quiet" disabled={busy} onClick={() => setProjectToDelete(null)}>Отмена</button>
              <button className="danger" disabled={busy || !projectDeletionReady}>Удалить проект</button>
            </div>
          </form>
        </Modal>
      )}
      {deletePreview && selected && (
        <Modal
          title="Переместить ветку в корзину?"
          close={() => setDeletePreview(null)}
        >
          <p>
            Будут затронуты {deletePreview.length} задач. Данные и история
            сохранятся для восстановления.
          </p>
          <ul className="delete-preview">
            {deletePreview.map((t) => (
              <li key={t.id}>{t.title}</li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="quiet" onClick={() => setDeletePreview(null)}>
              Отмена
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await mutate(
                    "delete_task",
                    {
                      subtree: true,
                      previewIds: deletePreview.map((t) => t.id),
                    },
                    selected,
                  );
                  setDeletePreview(null);
                  setSelected(null);
                  setNotice(
                    "Ветка в корзине. Восстановление доступно в разделе «Корзина».",
                  );
                })
              }
            >
              Удалить всё поддерево
            </button>
          </div>
        </Modal>
      )}
      {importText !== null && (
        <Modal title="Импорт JSON" close={() => setImportText(null)}>
          <p>
            Будет проверена версия формата, структура и связи. Сначала сохраните
            резервную копию через экспорт.
          </p>
          {shared && <p>Импорт только в проект «{project?.title}». Другие проекты и изменение владельцев запрещены.</p>}
          <div className="modal-actions">
            <button className="quiet" onClick={() => setImportText(null)}>
              Отмена
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("import_data", {
                    data: JSON.parse(importText),
                    ...(shared ? { projectId } : {}),
                    requestId: newRequestId(),
                  });
                  await refresh();
                  setImportText(null);
                  setNotice("Импорт завершён");
                })
              }
            >
              Проверить и импортировать
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" title="Закрыть" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function TaskPanel({
  task: t,
  tasks,
  shared,
  onAgent,
  onDirty,
  nextTaskTitle,
  onNext,
  onTransfer,
  busy,
  onClose,
  onSave,
  onAdd,
  onMove,
  onComplete,
  onReopen,
  onArchive,
  onRestore,
  onDelete,
  onLink,
  onEvidence,
}: {
  task: Task;
  tasks: Task[];
  shared: boolean;
  onAgent: () => void;
  onDirty: (dirty: boolean) => void;
  nextTaskTitle?: string;
  onNext?: () => void;
  onTransfer?: () => void;
  busy: boolean;
  onClose: () => void;
  onSave: (v: Record<string, unknown>) => void;
  onAdd: () => void;
  onMove: (p: string | null) => void;
  onComplete: () => void;
  onReopen: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onLink: (tool: string, id: string) => void;
  onEvidence: (url: string, note: string) => void;
}) {
  const [draft, setDraft] = useState({
      ...t,
      criteriaText: t.criteria.join("\n"),
    }),
    [tab, setTab] = useState("details"),
    [target, setTarget] = useState(""),
    [linkType, setLinkType] = useState("add_dependency"),
    [url, setUrl] = useState(""),
    [note, setNote] = useState("");
  const patch = (key: string, value: unknown) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify({ ...t, criteriaText: t.criteria.join("\n") });
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  return (
    <aside className="task-panel">
      <div className="panel-head">
        <span>
          <Folder size={14} />
          Карточка задачи
        </span>
        <button
          title="Закрыть карточку"
          className="icon-button"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <div className="panel-scroll">
        <div className="panel-kicker">
          <span className={`status-badge ${t.status}`}>
            {statuses[t.status]}
          </span>
          <small>v{t.version}</small>
        </div>
        <h2>{t.title}</h2>
        <p className="task-id">ID: {t.id}</p>
        {nextTaskTitle && onNext && <section className="panel-section"><p>Следующая доступная задача: {nextTaskTitle}</p><button className="quiet wide" type="button" onClick={onNext}>Открыть следующую задачу</button><small>Откроется только карточка. Помощник не запускается автоматически.</small></section>}
        {shared && <button className="primary wide agent-open" type="button" onClick={onAgent}><Sparkles size={16} />Обсудить с агентом</button>}
        {onTransfer && <button className="quiet wide" type="button" onClick={onTransfer}>Перенести в совместный проект</button>}
        <div className="panel-tabs">
          <button
            className={tab === "details" ? "on" : ""}
            onClick={() => setTab("details")}
          >
            Детали
          </button>
          <button
            className={tab === "links" ? "on" : ""}
            onClick={() => setTab("links")}
          >
            Связи
          </button>
          <button
            className={tab === "history" ? "on" : ""}
            onClick={() => setTab("history")}
          >
            История <span>{t.history?.length || 0}</span>
          </button>
        </div>
        {tab === "details" && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSave({
                  title: draft.title,
                  description: draft.description,
                  status: draft.status === t.status ? undefined : draft.status,
                  priority: draft.priority,
                  dueDate: draft.dueDate || null,
                  dueAt: draft.dueAt || null,
                  waitingReason: draft.waitingReason,
                  criteria: draft.criteriaText
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean),
                  ...(shared && ((draft.assigneeId ?? null) !== (t.assigneeId ?? null) || JSON.stringify(draft.collaboratorIds ?? []) !== JSON.stringify(t.collaboratorIds ?? [])) ? { assigneeId: draft.assigneeId ?? null, collaboratorIds: draft.collaboratorIds ?? [] } : {}),
                  reason: "Редактирование сотрудником в интерфейсе",
                });
              }}
            >
              <label>
                Название
                <input
                  required
                  value={draft.title}
                  onChange={(e) => patch("title", e.target.value)}
                />
              </label>
              <label>
                Ход задачи
                <textarea
                  rows={3}
                  value={draft.description || ""}
                  onChange={(e) => patch("description", e.target.value)}
                  placeholder="Контекст и важные детали…"
                />
              </label>
              <div className="two-columns">
                <label>
                  Статус
                  <select
                    value={draft.status}
                    disabled={["done", "cancelled"].includes(t.status)}
                    onChange={(e) => patch("status", e.target.value)}
                  >
                    {Object.entries(statuses)
                      .filter(([v]) => v !== "done" || t.status === "done")
                      .map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Приоритет
                  <select
                    value={draft.priority}
                    onChange={(e) => patch("priority", e.target.value)}
                  >
                    {Object.entries(priorities).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {draft.status === "waiting" && (
                <label>
                  Причина ожидания
                  <input
                    required
                    value={draft.waitingReason || ""}
                    onChange={(e) => patch("waitingReason", e.target.value)}
                  />
                </label>
              )}
              {shared && <TaskAssignments projectId={t.projectId} value={{ assigneeId: draft.assigneeId ?? null, collaboratorIds: draft.collaboratorIds ?? [] }} disabled={busy || !!t.deletedAt} load={requestJson} onChange={assignment => setDraft(old => ({ ...old, ...assignment }))} />}
              <label>
                Срок без времени
                <input
                  type="date"
                  value={draft.dueDate || ""}
                  onChange={(e) => {
                    patch("dueDate", e.target.value);
                    if (e.target.value) patch("dueAt", null);
                  }}
                />
              </label>
              <label>
                Или точное время (Asia/Almaty)
                <input
                  type="datetime-local"
                  value={
                    draft.dueAt
                      ? new Date(Date.parse(draft.dueAt) + 5 * 3600000)
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                  onChange={(e) => {
                    patch(
                      "dueAt",
                      e.target.value
                        ? new Date(`${e.target.value}:00+05:00`).toISOString()
                        : null,
                    );
                    if (e.target.value) patch("dueDate", null);
                  }}
                />
              </label>
              <label>
                Критерии выполнения
                <textarea
                  rows={3}
                  value={draft.criteriaText}
                  onChange={(e) => patch("criteriaText", e.target.value)}
                  placeholder="Каждый критерий с новой строки"
                />
              </label>
              <button className="primary wide" disabled={busy || !dirty}>
                Сохранить изменения
              </button>
              {dirty && (
                <button
                  type="button"
                  className="quiet wide"
                  onClick={() =>
                    setDraft({ ...t, criteriaText: t.criteria.join("\n") })
                  }
                >
                  Отменить изменения
                </button>
              )}
            </form>
            <section className="panel-section">
              <div className="section-title">
                <h3>Подзадачи</h3>
                <button className="text-button" onClick={onAdd}>
                  <Plus size={14} />
                  Добавить
                </button>
              </div>
              {tasks
                .filter((x) => x.parentId === t.id)
                .map((x) => (
                  <div key={x.id} className="subtask-line">
                    <span className={`status-dot ${x.status}`} />
                    {x.title}
                  </div>
                ))}
              {!tasks.some((x) => x.parentId === t.id) && (
                <p className="muted">Разделите задачу на понятные шаги.</p>
              )}
              <div className="branch-progress">
                <span>Прогресс конечных подзадач</span>
                <b>{t.progress?.percent || 0}%</b>
              </div>
              <div className="bar">
                <i style={{ width: `${t.progress?.percent || 0}%` }} />
              </div>
            </section>
            {t.result && (
              <section className="panel-section">
                <h3>Полученный результат</h3>
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {t.result}
                </p>
              </section>
            )}
            <section className="panel-section">
              <h3>Подтверждения результата</h3>
              {t.evidence?.map((e) => (
                <a
                  className="evidence"
                  href={e.url}
                  key={e.id}
                  target="_blank"
                  rel="noreferrer"
                >
                  <LinkIcon size={14} />
                  {e.note || e.url}
                  <ArrowUpRight size={14} />
                </a>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onEvidence(url, note);
                }}
              >
                <input
                  aria-label="Ссылка на результат"
                  type="url"
                  required
                  placeholder="https://ссылка-на-результат"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <input
                  aria-label="Описание подтверждения"
                  placeholder="Что подтверждает ссылка"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <button className="quiet wide" disabled={busy}>
                  Добавить подтверждение
                </button>
              </form>
            </section>
            <section className="panel-section">
              <h3>Перенести ветку</h3>
              <select
                aria-label="Новый родитель"
                value={t.parentId || ""}
                onChange={(e) => onMove(e.target.value || null)}
                disabled={busy}
              >
                <option value="">Корень проекта</option>
                {tasks
                  .filter((x) => x.id !== t.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title}
                    </option>
                  ))}
              </select>
              <small className="muted">
                Подзадачи и история переместятся вместе с веткой.
              </small>
            </section>
          </>
        )}
        {tab === "links" && (
          <section className="panel-section">
            <h3>Зависимости</h3>
            <p className="muted">
              Эти задачи должны быть завершены раньше текущей.
            </p>
            {t.dependencies?.map((id) => (
              <div className="link-row" key={id}>
                {tasks.find((x) => x.id === id)?.title || id}
                <button
                  title="Удалить зависимость"
                  onClick={() => onLink("remove_dependency", id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <h3>Связанные темы</h3>
            {t.related?.map((id) => (
              <div className="link-row" key={id}>
                {tasks.find((x) => x.id === id)?.title || id}
                <button
                  title="Удалить связь"
                  onClick={() => onLink("remove_relation", id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onLink(linkType, target);
              }}
            >
              <label>
                Тип связи
                <select
                  value={linkType}
                  onChange={(e) => setLinkType(e.target.value)}
                >
                  <option value="add_dependency">Зависимость</option>
                  <option value="add_relation">Обычная связь</option>
                </select>
              </label>
              <label>
                Задача
                <select
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Выберите задачу</option>
                  {tasks
                    .filter((x) => x.id !== t.id)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title}
                      </option>
                    ))}
                </select>
              </label>
              <button className="primary wide" disabled={busy || !target}>
                Добавить связь
              </button>
            </form>
          </section>
        )}
        {tab === "history" && (
          <section className="history">
            <p className="muted">Временные отметки показаны в Asia/Almaty.</p>
            {t.history
              ?.slice()
              .reverse()
              .map((h, i) => (
                <article key={i}>
                  <span className="history-dot" />
                  <strong>
                    {String(h.action || h.operation || "Изменение")}
                  </strong>
                  <small>
                    {h.createdAt || h.at || h.timestamp
                      ? new Date(
                          String(h.createdAt || h.at || h.timestamp),
                        ).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })
                      : ""}{" "}
                    · {String(h.actorId || h.actor || "владелец")}
                  </small>
                  <p>{String(h.reason || "Запись сохранена")}</p>
                  <details>
                    <summary>Старое и новое значение</summary>
                    <pre>{JSON.stringify(h, null, 2)}</pre>
                  </details>
                </article>
              ))}
          </section>
        )}
      </div>
      <div className="panel-bottom">
        {t.deletedAt ? (
          <button className="primary wide" disabled={busy} onClick={onRestore}>
            <RotateCcw size={16} />
            Восстановить ветку
          </button>
        ) : (
          <>
            <button
              className="primary wide"
              disabled={busy}
              onClick={
                t.status === "done" || t.status === "cancelled"
                  ? onReopen
                  : onComplete
              }
            >
              {t.status === "done" || t.status === "cancelled" ? (
                <RotateCcw size={16} />
              ) : (
                <Check size={16} />
              )}
              {t.status === "done" || t.status === "cancelled"
                ? "Открыть повторно"
                : "Завершить задачу"}
            </button>
            <div>
              <button className="quiet" disabled={busy} onClick={onArchive}>
                <Archive size={15} />
                {t.archivedAt ? "Из архива" : "В архив"}
              </button>
              <button
                className="quiet danger-text"
                disabled={busy}
                onClick={onDelete}
              >
                <Trash2 size={15} />В корзину
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
