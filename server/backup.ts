import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function backupDatabase(source: string, destination: string) {
  const from = resolve(source),
    to = resolve(destination);
  if (from === to) throw new Error("Резервная копия должна иметь другой путь");
  if (!existsSync(from)) throw new Error("Исходная база не найдена");
  if (existsSync(to))
    throw new Error("Файл резервной копии уже существует; выберите новое имя");
  mkdirSync(dirname(to), { recursive: true });
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(db, to);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(to, { readOnly: true });
  try {
    const check = copy.prepare("PRAGMA integrity_check").get();
    if (check?.integrity_check !== "ok")
      throw new Error("Проверка резервной копии не пройдена");
    copy.prepare("SELECT COUNT(*) FROM records").get();
  } finally {
    copy.close();
  }
  return to;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const source = process.env.DATABASE_PATH ?? "./data/tasks.sqlite";
  const destination =
    process.argv[2] ??
    `./backups/tasks-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
  backupDatabase(source, destination)
    .then((path) => console.log(`Резервная копия проверена: ${path}`))
    .catch((error) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Ошибка резервного копирования",
      );
      process.exitCode = 1;
    });
}
