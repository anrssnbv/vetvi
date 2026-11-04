// Operator command, never an employee API. Use the exact protected SK binding receipt.
import { readFileSync, statSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { TaskService, type ProjectScope } from "./service.js";
const file=process.argv[2];
if(!file || !isAbsolute(file) || lstatSync(file).isSymbolicLink() || (statSync(file).mode&0o077) || statSync(file).size>262144)throw new Error("Нужен защищённый файл привязок");
const receipt=JSON.parse(readFileSync(file,"utf8")) as {status:string,projects:ProjectScope[]};
if(receipt.status!=="applied" || !Array.isArray(receipt.projects) || receipt.projects.length>100)throw new Error("Нужен подтверждённый результат привязки SK AI");
const service=new TaskService(process.env.DATABASE_PATH??"./data/tasks.sqlite");
try {
  // Validate the whole plan before the first binding. Never create or rename legacy records here.
  for(const scope of receipt.projects){
    const row=service.db.prepare("SELECT owner_id,kind,data FROM records WHERE id=?").get(scope.id);
    if(!row || row.owner_id!==scope.namespace || row.kind!=="project" || JSON.parse(row.data as string).title!==scope.title)throw new Error("Привязка не совпадает с существующим проектом");
    const old=service.db.prepare("SELECT * FROM shared_project_scopes WHERE project_id=?").get(scope.id);
    if(old && (old.namespace!==scope.namespace || old.creator_id!==scope.creatorId || Boolean(old.personal)!==scope.personal))throw new Error("Нельзя заменить существующую привязку");
  }
  if(process.argv.includes("--apply")){
    service.db.exec("BEGIN IMMEDIATE");
    try {
      for(const scope of receipt.projects)service.db.prepare("INSERT OR IGNORE INTO shared_project_scopes VALUES(?,?,?,?)").run(scope.id,scope.namespace,scope.creatorId,Number(scope.personal));
      service.db.exec("COMMIT");
    }catch(error){service.db.exec("ROLLBACK");throw error;}
  }
  console.log(JSON.stringify({status:process.argv.includes("--apply")?"applied":"dry_run",projects:receipt.projects.length,receipt_hash:createHash("sha256").update(readFileSync(file)).digest("hex")}));
}finally{service.close();}
