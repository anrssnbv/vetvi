export type StorageView = "active" | "archive" | "trash";
export type ViewTask = {
  id: string;
  projectId: string;
  parentId: string | null;
  status: string;
  dueDate: string | null;
  dueAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
};

export function localDate(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

export function isOverdue(task: ViewTask, now = Date.now()): boolean {
  return !task.archivedAt && !task.deletedAt &&
    !["done", "cancelled"].includes(task.status) &&
    Boolean((task.dueDate && task.dueDate < localDate(now)) ||
      (task.dueAt && Date.parse(task.dueAt) < now));
}

export function sectionTasks<T extends ViewTask>(
  tasks: T[], storage: StorageView, due: string, now = Date.now(),
): T[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => {
    let current: T | undefined = task;
    let archived = false, deleted = false;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      archived ||= Boolean(current.archivedAt);
      deleted ||= Boolean(current.deletedAt);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (storage === "trash") return deleted;
    if (deleted || archived !== (storage === "archive")) return false;
    return storage !== "active" || due !== "overdue" || isOverdue(task, now);
  });
}

export function sectionProjects<T extends { id: string; deletedAt?: string | null }>(
  projects: T[], tasks: ViewTask[], storage: StorageView, due: string,
): T[] {
  if (storage === "active" && due !== "overdue") return projects;
  const ids = new Set(tasks.map((task) => task.projectId));
  return projects.filter((project) => ids.has(project.id) || storage === "trash" && project.deletedAt);
}

export function sidebarGroups<P extends { id: string; title: string; categoryId: string }>(
  projects: P[], categories: { id: string; title: string }[],
): { id: string; title: string; project?: P; projects: P[] }[] {
  const groups: { id: string; title: string; project?: P; projects: P[] }[] = [];
  for (const category of categories) {
    const items = projects.filter(project => project.categoryId === category.id);
    // Imported collections remain grouped; generated per-project metadata is not a UI level.
    const collection = items.filter(project => category.id !== `shared-category:${project.id}`);
    if (collection.length) groups.push({ id: category.id, title: category.title, projects: collection });
    for (const project of items.filter(project => category.id === `shared-category:${project.id}`)) {
      groups.push({ id: `project:${project.id}`, title: project.title, project, projects: [] });
    }
  }
  return groups;
}
