import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestId } from "./request-id";
import "./agent.css";
type Kind = "assistance" | "memo" | "briefing" | "report";
type Review = {
  id: string;
  row_version: number;
  state?: string;
  can_decide?: boolean;
  eligible?: boolean;
  decision?: {
    decision?: string;
    comment?: string;
  };
};
type Result = {
  id: string;
  hash: string;
  number?: number;
  artifact_id?: string | null;
  message?: string;
  draft?: {
    ready?: boolean;
    title?: string;
    summary?: string;
    paragraphs?: {
      text: string;
    }[];
    tables?: {
      title: string;
      columns: string[];
      rows: string[][];
    }[];
    unresolved_questions?: string[];
  };
  sources?: {
    id?: string;
    title?: string;
    text?: string;
    excerpt?: string;
  }[];
  reviews?: Review[];
};
type Turn = {
  id: string;
  author_id?: string;
  author_name?: string;
  answers?: {text:string}[];
  created_at?: string;
  withheld?: boolean;
  content?: {
    message?: string;
  };
  state?: string;
  row_version?: number;
  current_input_id?: string;
  step_id?: string;
  step?: {
    id: string;
  };
  result_id?: string;
  can_control?: boolean;
  results?: Result[];
};
type Conversation = {
  id: string;
  automatic_completion?: boolean;
  can_consent?: boolean;
  can_execute?: boolean;
  turns?: Turn[];
  pm_checks?: {
    id: string;
    assessment?: {
      state?: string;
      summary?: string;
      remaining?: string[];
      questions?: string[];
    };
  }[];
};
type Props = {
  task: {
    id: string;
    projectId: string;
    version: number;
    title: string;
    status: string;
  };
  onClose: () => void;
  onTaskChanged: () => void;
};
const apiBase = `${import.meta.env.BASE_URL}api/ai`;
const states: Record<string, string> = {
  queued: "Ожидает запуска", running: "Выполняется", waiting_for_input: "Нужны данные",
  waiting_for_review: "Ожидает принятия руководителем", blocked: "Нужны уточнения", failed: "Выполнение остановлено",
  cancelled: "Отменено", completed: "Результат подготовлен", needs_revision: "Нужна доработка", ready: "Можно завершить",
  stale: "Нужна новая проверка", pending: "Ожидает рассмотрения", requested: "Ожидает рассмотрения",
  approved: "Принято руководителем", changes_requested: "Возвращено на доработку",
};
const errors: Record<number, string> = {
  401: "Сессия истекла. Войдите снова.", 403: "Доступ к помощнику или этому проекту закрыт.",
  404: "Задача или диалог сейчас недоступны.", 409: "Данные изменились. Обновите диалог перед повтором.",
  429: "Лимит запросов достигнут. Повторите позже.", 503: "Помощник пока недоступен. Обратитесь к администратору.",
};
const prompts: {
  label: string;
  kind: Kind;
}[] = [
  { label: "Помоги выполнить задачу", kind: "assistance" }, { label: "Каких данных не хватает?", kind: "assistance" }, { label: "Подготовь служебную записку", kind: "memo" },
  { label: "Подготовь справку", kind: "briefing" }, { label: "Подготовь отчёт", kind: "report" },
];
const items = <T,>(value: T[] | undefined): T[] => Array.isArray(value) ? value : [];
export function AgentPanel({ task, onClose, onTaskChanged }: Props) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const taskClosed = task.status === "done" || task.status === "cancelled";
  const canExecute = !taskClosed && conversation?.can_execute !== false;
  const [sources, setSources] = useState<{
    id: string;
    title: string;
  }[]>([]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<Kind>("assistance");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const panel = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const controllers = useRef(new Set<AbortController>()), stopped = useRef(false), running = useRef(false);
  const generation = useRef(0), openKey = useRef<{
    task: string;
    key: string;
  } | null>(null);
  const pending = useRef(new Map<string, {
    body: string;
    key: string;
  }>());
  const reload = useRef<() => Promise<void>>(async () => { });
  const report = useCallback((failure: unknown) => {
    if (failure instanceof DOMException && failure.name === "AbortError")
      return;
    const status = failure instanceof Error && "status" in failure ? Number(failure.status) : 0;
    if ([401, 403, 404].includes(status)) {
      stopped.current = true;
      for (const controller of controllers.current)
        controller.abort();
      setConversation(null);
      setSources([]);
      setSourceIds([]);
      setMessage("");
      setComment("");
    }
    setError((failure instanceof Error && "code" in failure && failure.code === "TASK_INACTIVE" ? "Задача завершена, отменена или убрана в архив. Для новых сообщений и файлов верните её в работу." : undefined) ?? errors[status] ?? "Не удалось подтвердить результат запроса. Обновите диалог. Повтор отправки использует тот же запрос, пока вы не измените текст или источники.");
  }, []);
  const api = useCallback(async <T,>(path: string, method = "GET", body?: unknown, key?: string, version?: number): Promise<T> => {
    if (stopped.current)
      throw Object.assign(new Error(), { status: 403 });
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method, credentials: "same-origin", signal: controller.signal,
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "Idempotency-Key": key } : {}), ...(version === undefined ? {} : { "If-Match": `"${version}"` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw Object.assign(new Error(), { status: response.status, code: failure.code });
      }
      return response.status === 204 ? undefined as T : await response.json() as T;
    }
    finally {
      controllers.current.delete(controller);
    }
  }, []);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab")
        return;
      const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex='0']") ?? []).filter((element) => element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("keydown", keyboard); if (previous instanceof HTMLElement && previous.isConnected)
      previous.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const currentGeneration = ++generation.current;
    stopped.current = false;
    running.current = false;
    setBusy(false);
    setConversation(null);
    setSources([]);
    setSourceIds([]);
    setMessage("");
    setComment("");
    setKind("assistance");
    setError("");
    setNotice("");
    const taskKey = `${task.id}:${task.version}`;
    if (openKey.current?.task !== taskKey)
      openKey.current = { task: taskKey, key: newRequestId() };
    const load = async (id: string) => {
      const value = await api<Conversation>(`/conversations/${encodeURIComponent(id)}`);
      if (active && currentGeneration === generation.current && !stopped.current)
        setConversation(value);
    };
    const poll = (id: string) => {
      timer = setTimeout(async () => {
        try {
          await load(id);
        }
        catch (failure) {
          if (active)
            report(failure);
        }
        if (active && !stopped.current)
          poll(id);
      }, 2000);
    };
    void (async () => {
      try {
        const opened = await api<{
          id: string;
        }>(`/tasks/${encodeURIComponent(task.id)}/conversations`, "POST", {}, openKey.current!.key);
        if (!active)
          return;
        reload.current = () => load(opened.id);
        await load(opened.id);
        if (active && !stopped.current)
          poll(opened.id);
      }
      catch (failure) {
        if (active)
          report(failure);
      }
    })();
    void api<{
      items: {
        id: string;
        title: string;
      }[];
    }>(`/projects/${encodeURIComponent(task.projectId)}/sources`).then((value) => { if (active && !stopped.current)
      setSources(items(value.items)); }).catch((failure) => { if (active)
      report(failure); });
    return () => {
      active = false;
      stopped.current = true;
      generation.current++;
      if (timer)
        clearTimeout(timer);
      for (const controller of controllers.current)
        controller.abort();
      reload.current = async () => { };
    };
  }, [api, report, task.id, task.projectId, task.version]);
  async function perform(name: string, path: string, body: unknown, version?: number, success?: (value: any) => void) {
    if (running.current || stopped.current)
      return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const epoch = generation.current;
    const fingerprint = JSON.stringify({ path, body, version });
    let request = pending.current.get(name);
    if (!request || request.body !== fingerprint) {
      request = { body: fingerprint, key: newRequestId() };
      pending.current.set(name, request);
    }
    try {
      const value = await api<any>(path, "POST", body, request.key, version);
      if (epoch !== generation.current)
        return;
      pending.current.delete(name);
      success?.(value);
      await reload.current();
    }
    catch (failure) {
      if (epoch === generation.current)
        report(failure);
    }
    finally {
      if (epoch === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const turns = items(conversation?.turns), latest = turns.at(-1);
  const latestResult = items(latest?.results).at(-1);
  const controlsReady = latest?.can_control === true && !!latest.current_input_id && typeof latest.row_version === "number";
  function control(action: "cancel" | "resume" | "retry" | "answer") {
    if (!latest || !controlsReady)
      return;
    void perform(`action:${latest.id}:${action}`, `/turns/${encodeURIComponent(latest.id)}/actions`, {
      action, ...(action === "answer" ? { message: message.trim() } : {}), input_id: latest.current_input_id,
      ...((latest.step_id || latest.step?.id) ? { step_id: latest.step_id || latest.step?.id } : {}),
      ...((latest.result_id || latestResult?.id) ? { result_id: latest.result_id || latestResult?.id } : {}),
      ...(latestResult?.hash ? { content_hash: latestResult.hash } : {}),
    }, latest.row_version, () => { setNotice("Действие сохранено."); if (action === "answer")
      setMessage(""); });
  }
  return <div className="agent-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
    onClose(); }}>
  <div className="agent-panel" role="dialog" aria-modal="true" aria-labelledby="agent-title" ref={panel}>
   <header className="agent-header">
  <div>
  <h2 id="agent-title">Помощник по задаче</h2>
  <p>{task.title}</p>
  </div>
  <button ref={close} type="button" aria-label="Закрыть помощника" onClick={onClose}>Закрыть</button>
  </header>
   <div className="agent-scroll">
    <p className="agent-note">Открытие и обновление диалога не запускают модель. Поручение отправляется только по вашей кнопке.</p>
    {error && <p role="alert" className="agent-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!conversation && !error && <p role="status">Открываем диалог…</p>}
    {conversation && <>
     <section aria-label="Обсуждение задачи" className="agent-history">
      {!turns.length && <p>Обсудите задачу или выберите документ. Помощник уточнит недостающие данные.</p>}
      {turns.map((turn) => <article key={turn.id} className="agent-turn">
       {turn.withheld ? <p>Контекст этого сообщения сейчас недоступен. Проверьте доступ и версию задачи.</p> : <>
        <div className="agent-turn-meta">
        <span>Сотрудник: {turn.author_name || "Участник"}</span>{turn.created_at && <time dateTime={turn.created_at}>{new Date(turn.created_at).toLocaleString("ru-RU")}</time>}</div>
        <p className="agent-text">{turn.content?.message}</p>
        {items(turn.answers).map((answer, index) => <p className="agent-text" key={index}>Уточнение сотрудника: {answer.text}</p>)}
        <p role="status">{states[turn.state ?? ""] ?? "Поручение сохранено"}</p>
        {items(turn.results).map((result) => <section className="agent-result" key={result.id} aria-label="Результат помощника">
         <h3>{result.draft?.title || "Результат"}{result.number ? ` · версия ${result.number}` : ""}</h3>
         {result.draft?.summary && <p className="agent-text">{result.draft.summary}</p>}
         {items(result.draft?.paragraphs).map((paragraph, index) => <p className="agent-text" key={index}>{paragraph.text}</p>)}
         {items(result.draft?.tables).map((table, index) => <div className="agent-table" key={index} tabIndex={0} role="region" aria-label={table.title}>
            <table>
            <caption>{table.title}</caption>
            <thead>
            <tr>{items(table.columns).map((column, columnIndex) => <th scope="col" key={columnIndex}>{column}</th>)}</tr>
            </thead>
            <tbody>{items(table.rows).map((row, rowIndex) => <tr key={rowIndex}>{items(row).map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
            </table>
            </div>)}
         {items(result.draft?.unresolved_questions).length > 0 && <div>
            <h4>Нужны уточнения</h4>
            <ul>{items(result.draft?.unresolved_questions).map((question, index) => <li key={index}>{question}</li>)}</ul>
            </div>}
         {items(result.sources).length > 0 && <details>
            <summary>Источники результата</summary>
            <ol>{items(result.sources).map((source, index) => <li key={source.id || index}>
              <strong>{source.title || `Источник ${index + 1}`}</strong>{(source.excerpt || source.text) && <p className="agent-text">{source.excerpt || source.text}</p>}</li>)}</ol>
            </details>}
         <p>{result.artifact_id ? "Вот ваш документ Word. Напишите, если нужно подготовить новую версию." : "Ответ подготовлен. Напишите, если нужны уточнения."}</p>
         {result.artifact_id && <div className="agent-actions">
            <a href={`${apiBase}/artifacts/${encodeURIComponent(result.artifact_id)}`} download>Скачать Word</a>
            <button type="button" disabled={busy || stopped.current || result.draft?.ready !== true} onClick={() => { void perform(`review:${result.id}`, `/results/${encodeURIComponent(result.id)}/reviews`, {}, undefined, () => setNotice("Документ направлен на принятие руководителю.")); }}>Запросить принятие руководителем</button>
            </div>}
         {items(result.reviews).map((review) => <div className="agent-review" key={review.id}>
            <p>{states[review.decision?.decision || review.state || ""] || "Рассмотрение документа"}</p>{review.decision?.comment && <p>{review.decision.comment}</p>}{(review.can_decide === true || review.eligible === true) && !["approved", "changes_requested"].includes(review.state || "") && <div className="agent-actions">
              <button type="button" disabled={busy} onClick={() => { void perform(`decision:${review.id}`, `/reviews/${encodeURIComponent(review.id)}/decisions`, { decision: "approved", comment }, review.row_version, () => setNotice("Принятие сохранено для этой версии документа.")); }}>Принято руководителем</button>
              <button type="button" disabled={busy || !comment.trim()} onClick={() => { void perform(`decision:${review.id}`, `/reviews/${encodeURIComponent(review.id)}/decisions`, { decision: "changes_requested", comment }, review.row_version, () => setNotice("Документ возвращён на доработку.")); }}>Вернуть на доработку</button>
              </div>}</div>)}
        </section>)}
       </>}
      </article>)}
     </section>
     <section className="agent-pm" aria-labelledby="agent-pm-title">
    <h3 id="agent-pm-title">Проверка готовности</h3>
    <p>PM проверит результат, оставшиеся действия и принятие точной версии Word. Сообщение «готово» не закрывает задачу.</p>
    <button type="button" disabled={busy || stopped.current} onClick={() => { void perform("pm", `/tasks/${encodeURIComponent(task.id)}/pm-checks`, {}, undefined, () => { setNotice("Проверка запрошена."); onTaskChanged(); }); }}>Проверить готовность с PM</button>
      {items(conversation.pm_checks).map((check) => <article key={check.id}>
      <h4>{states[check.assessment?.state ?? ""] || "Проверка сохранена"}</h4>
      <p>{check.assessment?.summary}</p>{items(check.assessment?.remaining).length > 0 && <>
        <p>Осталось сделать:</p>
        <ul>{items(check.assessment?.remaining).map((line, index) => <li key={index}>{line}</li>)}</ul>
        </>}{items(check.assessment?.questions).length > 0 && <>
        <p>Нужны ответы:</p>
        <ul>{items(check.assessment?.questions).map((line, index) => <li key={index}>{line}</li>)}</ul>
        </>}</article>)}
      <label className="agent-consent">
    <input type="checkbox" checked={conversation.automatic_completion === true} disabled={busy || stopped.current || conversation.can_consent === false} onChange={(event) => {
      const allowed = event.target.checked;
      void perform("consent", `/tasks/${encodeURIComponent(task.id)}/conversations`, { automatic_completion: allowed }, task.version,
        () => setNotice(allowed ? "Разрешение сохранено для текущей версии задачи." : "Разрешение на автоматическое завершение отозвано."));
    }}/>Разрешаю PM технически завершить эту версию задачи после принятия точного документа Word уполномоченным руководителем и всех проверок.</label>
     </section>
     <form className="agent-compose" onSubmit={(event) => { event.preventDefault(); if (!canExecute || !message.trim())
      return; void perform("turn", `/conversations/${encodeURIComponent(conversation.id)}/turns`, { message: message.trim(), kind, source_version_ids: sourceIds, knowledge_entry_ids: [] }, task.version, () => { setMessage(""); setNotice("Поручение сохранено. Ожидаем состояние исполнителя."); }); }}>
      <h3>Новое поручение</h3>
    {taskClosed && <p role="status">Задача {task.status === "done" ? "завершена" : "отменена"}. Для новых сообщений и файлов закройте чат и нажмите «Открыть повторно» в карточке задачи. История остаётся доступной.</p>}
    {conversation.can_execute === false && <p>Доступен просмотр и принятие документа. Запуск помощника требует права выполнения.</p>}
    <div className="agent-prompts">{prompts.map((prompt) => <button type="button" key={prompt.label} disabled={busy || !canExecute} onClick={() => { setKind(prompt.kind); setMessage(prompt.label); pending.current.delete("turn"); }}>{prompt.label}</button>)}</div>
      <label>Формат результата<select value={kind} disabled={busy || !canExecute} onChange={(event) => { setKind(event.target.value as Kind); pending.current.delete("turn"); }}>
    <option value="assistance">Помощь по задаче</option>
    <option value="memo">Служебная записка</option>
    <option value="briefing">Справка</option>
    <option value="report">Отчёт</option>
    </select>
    </label>
      <label>Источники — до 8 версий<select multiple value={sourceIds} disabled={busy || !canExecute || !sources.length} size={Math.min(5, Math.max(2, sources.length))} onChange={(event) => { const selected = Array.from(event.target.selectedOptions, (option) => option.value); if (selected.length > 8) {
      setError("Выберите не более 8 источников.");
      return;
    } setSourceIds(selected); pending.current.delete("turn"); }}>{sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}</select>
    </label>
      {!sources.length && <p className="agent-note">Доступных источников пока нет. Помощник должен запросить недостающие сведения.</p>}
      <label>Сообщение помощнику<textarea value={message} maxLength={1000} rows={5} disabled={busy || !canExecute} onChange={(event) => { setMessage(event.target.value); pending.current.delete("turn"); }} placeholder="Опишите результат, критерии и недостающие данные"/>
    </label>
      <p className="agent-note">Отправка поручения и явное продолжение могут использовать модель. Опрос состояния выполняется без нового запуска.</p>
      <div className="agent-actions">
    <button type="submit" className="agent-primary" disabled={busy || !message.trim() || stopped.current || !canExecute}>{busy ? "Сохраняем…" : "Отправить поручение"}</button>
    <button type="button" disabled={busy || stopped.current} onClick={() => { void reload.current().catch(report); }}>Обновить диалог</button>
       {latest && controlsReady && !["completed", "cancelled"].includes(latest.state || "") && <button type="button" disabled={busy} onClick={() => control("cancel")}>Остановить выполнение</button>}
       {latest?.state === "waiting_for_input" && controlsReady && <button type="button" disabled={busy || !canExecute || !message.trim()} onClick={() => control("answer")}>Ответить на уточнение</button>}
       {latest?.state === "waiting_for_review" && controlsReady && <button type="button" disabled={busy || !latestResult || !(latest.step_id || latest.step?.id)} onClick={() => control("resume")}>Продолжить после принятия</button>}
       {latest && ["failed", "blocked"].includes(latest.state || "") && controlsReady && <button type="button" disabled={busy || !canExecute} onClick={() => control("retry")}>Повторить выполнение</button>}
      </div>
      {turns.some((turn) => items(turn.results).some((result) => items(result.reviews).some((review) => review.can_decide === true || review.eligible === true))) && <label>Комментарий руководителя<textarea value={comment} maxLength={4000} rows={3} onChange={(event) => setComment(event.target.value)} disabled={busy}/>
      <span className="agent-note">Для возврата на доработку укажите замечания.</span>
      </label>}
     </form>
    </>}
   </div>
  </div>
 </div>;
}
