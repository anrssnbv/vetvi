import { useEffect, useState } from "react";
import "./task-assignments.css";

type Assignment = { assigneeId: string | null; collaboratorIds: string[] };
type Member = { id: string; display_name: string; active: boolean };
type Props = {
  projectId: string;
  value: Assignment;
  disabled: boolean;
  load: <T>(path: string) => Promise<T>;
  onChange: (value: Assignment) => void;
};

export function TaskAssignments({ projectId, value, disabled, load, onChange }: Props) {
  const [state, setState] = useState<{ projectId: string; members: Member[]; canAssign: boolean }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setState(undefined); setError("");
    const path = `/projects/${encodeURIComponent(projectId)}`;
    void Promise.all([
      load<{ can_write: boolean; can_edit_project: boolean }>(`${path}/access`),
      load<{ items: Member[] }>(`${path}/members`),
    ]).then(([access, members]) => {
      if (active) setState({ projectId, members: members.items, canAssign: access.can_write === true && access.can_edit_project === true });
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "Не удалось загрузить исполнителей.");
    });
    return () => { active = false; };
  }, [load, projectId]);
  const current = state?.projectId === projectId ? state : undefined;
  const members = current?.members ?? [];
  const selected = new Set(value.collaboratorIds);
  const known = new Set(members.map(member => member.id));
  const collaborators = [...members.filter(member => member.active || selected.has(member.id)),
    ...value.collaboratorIds.filter(id => !known.has(id)).map(id => ({ id, display_name: "Участник недоступен", active: false }))];
  return <section className="task-assignments" aria-label="Исполнители задачи">
    <h3>Исполнители</h3>
    {error && <p role="alert">{error}</p>}
    {!error && !current && <p role="status">Загрузка исполнителей…</p>}
    {current && <>
      <fieldset disabled={disabled || !current.canAssign}>
        <label>Ответственный
          <select value={value.assigneeId ?? ""} onChange={event => onChange({ assigneeId: event.target.value || null, collaboratorIds: value.collaboratorIds.filter(id => id !== event.target.value) })}>
            <option value="">Не назначен</option>
            {value.assigneeId && !members.some(member => member.id === value.assigneeId && member.active) && <option value={value.assigneeId} disabled>{members.find(member => member.id === value.assigneeId)?.display_name ?? "Участник недоступен"}</option>}
            {members.filter(member => member.active).map(member => <option key={member.id} value={member.id}>{member.display_name}</option>)}
          </select>
        </label>
        <div className="executor-list" role="group" aria-label="Соисполнители">
          <span>Соисполнители</span>
          {collaborators.map(member => <label className="executor-option" key={member.id}>
            <input type="checkbox" checked={selected.has(member.id)} disabled={member.id === value.assigneeId || (!member.active && !selected.has(member.id))} onChange={event => onChange({ ...value, collaboratorIds: event.target.checked ? [...value.collaboratorIds, member.id] : value.collaboratorIds.filter(id => id !== member.id) })} />
            <span>{member.display_name}{!member.active && " (нет доступа)"}</span>
          </label>)}
          {!collaborators.length && <span>Нет участников проекта.</span>}
        </div>
      </fieldset>
      {!current.canAssign && <p className="muted">Назначения меняет администратор или руководитель проекта.</p>}
    </>}
  </section>;
}
