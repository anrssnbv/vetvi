import { useEffect, useRef } from "react";
import "./chat-window.css";

export function ChatWindow({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return <dialog className="chat-window" ref={dialog} aria-labelledby="chat-window-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="chat-window-header">
      <div>
        <h2 id="chat-window-title">SK AI Chat</h2>
        <p>Отдельный чат. Данные задачи автоматически не передаются.</p>
      </div>
      <a href="/chat/" target="_blank" rel="noopener noreferrer">В новой вкладке</a>
      <button type="button" onClick={onClose} aria-label="Закрыть чат">Закрыть</button>
    </header>
    <iframe src="/chat/" title="SK AI Chat" onLoad={(event) => {
      // Keyboard events inside an iframe do not reach the containing dialog.
      event.currentTarget.contentDocument?.addEventListener("keydown", (key) => {
        if (key.key === "Escape") { key.preventDefault(); close.current(); }
      });
    }} />
  </dialog>;
}
