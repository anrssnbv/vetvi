export function taskChatUrl(project: { id: string; title: string }, task: { id: string; title: string }): string {
  const context = new URLSearchParams({
    vetvi_project_id: project.id,
    vetvi_project_name: project.title,
    vetvi_task_id: task.id,
    vetvi_task_name: task.title,
  });
  // Fragments keep task labels out of HTTP requests and access logs.
  return `/chat/#${context.toString()}`;
}
