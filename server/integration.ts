import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createBridge, type BridgeConfig } from "./ai.js";
import { TaskService, ServiceError, type Task, type ProjectScope, type Actor } from "./service.js";

type Grant = {external_id:string;project_id:string;namespace:string;creator_id:string;personal:boolean;title:string;row_version:number};
const scope = (p:Grant): ProjectScope => ({id:p.external_id, namespace:p.namespace, creatorId:p.creator_id, personal:p.personal, title:p.title});
const forbidden = () => new ServiceError("NOT_FOUND", "Запись не найдена или недоступна",404);
export function installIntegration(app:Express, service:TaskService, config:BridgeConfig) {
  const bridge = createBridge(config,service);
  const keyHash = createHash("sha256").update(readFileSync(config.keyFile,"utf8").replace(/\n+$/,"" )).digest();
  async function signed(req:Request) {
    const current = await bridge.session(req);
    if (!current) throw new ServiceError("UNAUTHORIZED","Войдите в приложение",401);
    return current;
  }
  async function grants(handle:string):Promise<Grant[]> {
    const items:Grant[]=[];
    for(let offset=0;offset<10000;offset+=100){
      const result=await bridge.call("GET",`/projects?limit=100&offset=${offset}`,undefined,handle);
      items.push(...result.items);
      if(result.next_offset == null) return items;
    }
    throw new ServiceError("LIMIT","Слишком много проектов для одного запроса",409);
  }
  function bind(p:Grant,actor:Actor) {service.bindProject(scope(p),actor);return scope(p);}
  function taskScope(id:string, allowed:Grant[]) {
    const record=service.db.prepare("SELECT data FROM records WHERE id=? AND kind='task'").get(id);
    if(!record) throw forbidden();
    const task=JSON.parse(record.data as string) as Task;
    const project=allowed.find(p=>p.external_id===task.projectId);
    if(!project) throw forbidden();
    return project;
  }
  function snapshot(id:string,p:Grant,actor:Actor) {
    const s=bind(p,actor);
    const task=service.executeScoped("get_task",{id},actor,s) as Task & {dependencies:string[];openChildren:boolean;openDependencies:boolean};
    const detail=task;
    return {id:task.id,project_id:task.projectId,version:task.version,title:task.title,description:task.description,
      criteria:task.criteria,status:task.status,archived:!!task.archivedAt,deleted:!!task.deletedAt,
      open_children:detail.openChildren,open_dependencies:detail.openDependencies,assignee_id:task.assigneeId??null,collaborator_ids:task.collaboratorIds??[]};
  }
  function internal(req:Request) {
    if(req.headers.origin || req.headers.cookie || req.headers.authorization || typeof req.headers["x-vetvi-client-key"]!=="string") throw forbidden();
    const hash=createHash("sha256").update(req.headers["x-vetvi-client-key"]).digest();
    if(!timingSafeEqual(hash,keyHash)) throw forbidden();
  }
  app.post("/api/internal/ai/snapshot",async(req,res)=>{
    internal(req);
    if(typeof req.body?.run_id!=="string") throw forbidden();
    const delegated=await bridge.call("GET",`/delegations/runs/${encodeURIComponent(req.body.run_id)}`);
    const actor={id:delegated.actor_id,scopes:["tasks:read"]};
    res.json(snapshot(delegated.task_id,delegated.project,actor));
  });
  app.get("/api/internal/ai/receipts/:id",async(req,res)=>{
    internal(req);
    const delegated=await bridge.call("GET",`/delegations/action-receipts/${encodeURIComponent(String(req.params.id))}`);
    const receipt=service.db.prepare("SELECT response FROM completion_receipts WHERE action_id=?").get(delegated.id);
    if(receipt) return res.json(JSON.parse(receipt.response as string));
    const owner=JSON.stringify(["project",delegated.project.namespace,delegated.project.external_id,delegated.actor_id]);
    const committed=service.db.prepare("SELECT result FROM requests WHERE owner_id=? AND request_id=?").get(owner,`ai:${delegated.id}`);
    if(!committed)return res.status(404).json({code:"NOT_FOUND"});
    res.json({action_id:delegated.id,task_id:delegated.content.task_id,task:JSON.parse(committed.result as string)});
  });
  app.post("/api/internal/ai/apply-result",async(req,res)=>{
    internal(req);
    const actionId=req.body?.action_id;
    if(typeof actionId!=="string") throw forbidden();
    const receipt=service.db.prepare("SELECT response FROM completion_receipts WHERE action_id=?").get(actionId);
    if(receipt){
      await bridge.call("GET",`/delegations/action-receipts/${encodeURIComponent(actionId)}`);
      return res.json(JSON.parse(receipt.response as string));
    }
    const stored=await bridge.call("GET",`/delegations/action-receipts/${encodeURIComponent(actionId)}`);
    const receiptOwner=JSON.stringify(["project",stored.project.namespace,stored.project.external_id,stored.actor_id]);
    const committed=service.db.prepare("SELECT result FROM requests WHERE owner_id=? AND request_id=?").get(receiptOwner,`ai:${actionId}`);
    if(committed){
      const response={action_id:actionId,task_id:stored.content.task_id,task:JSON.parse(committed.result as string)};
      const fingerprint=createHash("sha256").update(JSON.stringify(stored.content)).digest("hex");
      service.db.prepare("INSERT OR IGNORE INTO completion_receipts VALUES(?,?,?)").run(actionId,fingerprint,JSON.stringify(response));
      return res.json(response);
    }
    const delegated=await bridge.call("GET",`/delegations/actions/${encodeURIComponent(actionId)}`);
    const actor={id:delegated.actor_id,scopes:["tasks:read","tasks:write"]};
    const p=delegated.project as Grant,s=bind(p,actor),a=delegated.content;
    const fingerprint=createHash("sha256").update(JSON.stringify(delegated.content)).digest("hex");
    // The TaskService receipt is committed with the task; reconcile it if the process died before this receipt.
    const result=service.executeScoped("complete_task",{id:a.task_id,expectedVersion:a.task_version,requestId:`ai:${actionId}`,result:`Документ принят руководителем. Результат ${a.result_id}; SHA256 ${a.result_hash}. Файл SHA256 ${a.artifact_hash}.`,evidenceUrl:`${config.baseUrl.replace(/\/$/,"")}/api/ai/artifacts/${a.artifact_id}`,reason:`PM-агент; инициатор ${a.delegated_by}; действие ${actionId}`,historyOperation:{agent:"pm",delegatedBy:a.delegated_by,actionId,resultId:a.result_id,artifactId:a.artifact_id}},actor,s);
    const response={action_id:actionId,task_id:a.task_id,task:result};
    service.db.prepare("INSERT OR IGNORE INTO completion_receipts VALUES(?,?,?)").run(actionId,fingerprint,JSON.stringify(response));
    res.json(response);
  });
  app.get("/api/session",async(req,res)=>{
    const current=await bridge.session(req);
    res.json({authenticated:!!current,shared:true,...(current?{actor:current.identity.actor}: {})});
  });
  app.post("/api/login",async(req,res)=>res.json(await bridge.login(req,res)));
  app.post("/api/logout",async(req,res)=>{await bridge.logout(req,res);res.json({ok:true});});
  app.all("/mcp",(_req,res)=>res.status(403).json({code:"INDIVIDUAL_DELEGATION_REQUIRED",message:"Для совместных проектов требуется индивидуальная делегация. Используйте интерфейс Space."}));
  app.post("/api/tools/:tool",async(req,res)=>{
    bridge.csrf(req);
    const current=await signed(req),allowed=await grants(current.handle),tool=String(req.params.tool),args=req.body;
    void flushOutbox(current.handle,allowed);
    if(!args || typeof args!=="object" || Array.isArray(args)) throw new ServiceError("VALIDATION","Ожидается JSON объект");
    if(tool==="list_projects" || (tool==="search_tasks" && !args.projectId) || (tool==="get_changes" && !args.projectId)) {
      const all:any[]=[],categories:any[]=[];
      for(const p of allowed){
        if(tool!=="list_projects"){
          const access=await bridge.call("GET",`/projects/${p.external_id}/access`,undefined,current.handle);
          if(access.can_read!==true)continue;
        }
        const s=bind(p,current.actor);
        for(let offset=0;;offset+=200){
          const result=service.executeScoped(tool,{...args,limit:200,offset},current.actor,s) as {items:any[];total:number;categories?:any[]};
          all.push(...result.items.map(item=>tool==="list_projects"?{...item,personal:p.personal,creatorId:p.creator_id}:item));if(result.categories)categories.push(...result.categories);
          if(offset+200>=result.total)break;
          if(offset>=10000)throw new ServiceError("LIMIT","Слишком много записей",409);
        }
      }
      const offset=Number(args.offset??0),limit=Number(args.limit??100);
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw new ServiceError("VALIDATION","Некорректная страница");
      return res.json({items:all.slice(offset,offset+limit),total:all.length,limit,offset,categories:[...new Map(categories.map(c=>[c.id,c])).values()]});
    }
    if(tool==="create_category")return res.json({id:"shared",title:"Проекты"});
    if(tool==="create_project") {
      if(typeof args.requestId!=="string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(args.requestId))throw new ServiceError("VALIDATION","Нужен идентификатор запроса");
      const hash=createHash("sha256").update(JSON.stringify(args)).digest("hex");
      let intent=service.db.prepare("SELECT * FROM project_intents WHERE actor_id=? AND request_id=?").get(current.actor.id,args.requestId);
      if(intent && intent.payload_hash!==hash)throw new ServiceError("IDEMPOTENCY_CONFLICT","Запрос изменён",409);
      if(!intent){service.db.prepare("INSERT INTO project_intents VALUES(?,?,?,?)").run(current.actor.id,args.requestId,randomUUID(),hash);intent=service.db.prepare("SELECT * FROM project_intents WHERE actor_id=? AND request_id=?").get(current.actor.id,args.requestId);}
      const metadata=await bridge.call("GET","/sessions/current",undefined,current.handle);
      if(!metadata.classifications?.length || !metadata.lifecycle_states?.includes("draft"))throw new ServiceError("AGENT_UNAVAILABLE","Словарь проектов не настроен",503);
      const result=await bridge.call("POST","/projects",{external_id:intent!.external_id,personal:args.personal===true,project:{title:args.title,description:"",customer_reference:"Не указан",classification:args.classification??metadata.classifications[0],lifecycle:"draft"}},current.handle,{"Idempotency-Key":args.requestId});
      const p=result.item as Grant;bind(p,current.actor);
      const list=service.executeScoped("list_projects",{},current.actor,scope(p)) as {items:any[]};
      return res.json({...list.items[0],personal:p.personal,creatorId:p.creator_id});
    }
    const requested=args.projectId??(tool==="import_data"?args.data?.projects?.[0]?.id:undefined);
    const p=requested?allowed.find(p=>p.external_id===requested):typeof args.id==="string"?(allowed.find(p=>p.external_id===args.id)??taskScope(args.id,allowed)):undefined;
    if(!p)throw forbidden();
    const access=await bridge.call("GET",`/projects/${p.external_id}/access`,undefined,current.handle);
    if(access.can_read!==true)throw new ServiceError("FORBIDDEN","Недостаточно прав для чтения задач",403);
    if(["delete_project","restore_project"].includes(tool) && access.can_edit_project!==true)
      throw new ServiceError("FORBIDDEN","Недостаточно прав для изменения проекта",403);
    const effective=tool==="update_task"?(args.patch??args):args;
    // Imports can clear assignments by omission; treat them as assignment administration.
    const assigns=tool==="import_data" || Object.hasOwn(effective,"assigneeId") || Object.hasOwn(effective,"collaboratorIds");
    if(assigns && (access.can_write!==true || access.can_edit_project!==true))
      throw new ServiceError("FORBIDDEN","Назначать исполнителей может администратор или руководитель проекта",403);
    if(assigns){
      const members=await bridge.call("GET",`/projects/${p.external_id}/members`,undefined,current.handle);
      const ids=new Set(members.items.filter((m:any)=>m.active).map((m:any)=>m.id));
      const assignments=tool==="import_data" && Array.isArray(args.data?.tasks)?args.data.tasks:[effective];
      if(assignments.some((task:any)=>[task.assigneeId,...(Array.isArray(task.collaboratorIds)?task.collaboratorIds:[])].some(id=>id&&!ids.has(id))))throw forbidden();
    }
    const actor={...current.actor,scopes:access.can_write?["tasks:read","tasks:write"]:["tasks:read"]};
    const result=service.executeScoped(tool,args,actor,bind(p,actor));
    void flushOutbox(current.handle,allowed);
    res.json(result);
  });
  app.post("/api/tasks/:id/transfer",async(req,res)=>{
    bridge.csrf(req);
    const current=await signed(req),allowed=await grants(current.handle);
    const taskId=String(req.params.id);
    const previous=typeof req.body?.requestId==="string"
      ?service.db.prepare("SELECT from_project FROM task_transfers WHERE task_id=? AND actor_id=? AND request_id=?").get(taskId,current.actor.id,req.body.requestId)
      :undefined;
    const from=previous?allowed.find(p=>p.external_id===previous.from_project):taskScope(taskId,allowed);
    const to=allowed.find(p=>p.external_id===req.body?.targetProjectId);
    if(!from || !to)throw forbidden();
    for(const p of [from,to]){
      const access=await bridge.call("GET",`/projects/${p.external_id}/access`,undefined,current.handle);
      if(access.can_read!==true || !access.can_write)throw new ServiceError("FORBIDDEN","Недостаточно прав для переноса",403);
      bind(p,current.actor);
    }
    if(!previous){
      const members=await bridge.call("GET",`/projects/${to.external_id}/members`,undefined,current.handle);
      const memberIds=new Set(members.items.filter((m:any)=>m.active).map((m:any)=>m.id));
      const tree=service.executeScoped("preview_delete",{id:taskId},current.actor,scope(from)) as {items:Task[],total:number};
      if(tree.total>10000)throw new ServiceError("LIMIT","Слишком большое дерево задачи",409);
      if(tree.items.some(t=>[t.assigneeId,...(t.collaboratorIds??[])].some(id=>id&&!memberIds.has(id))))throw new ServiceError("FORBIDDEN","Ответственные и соисполнители должны быть участниками будущего проекта",403);
    }
    res.json(service.transferTask(taskId,scope(from),scope(to),current.actor,req.body.expectedVersion,req.body.requestId,req.body.confirmSharing));
  });
  app.get("/api/projects/:id/access",async(req,res)=>{const current=await signed(req);res.json(await bridge.call("GET",`/projects/${encodeURIComponent(String(req.params.id))}/access`,undefined,current.handle));});
  app.get("/api/projects/:id/members",async(req,res)=>{
    const current=await signed(req);
    res.json(await bridge.call("GET",`/projects/${encodeURIComponent(String(req.params.id))}/members`,undefined,current.handle));
  });
  app.get("/api/projects/:id/member-candidates",async(req,res)=>{
    const current=await signed(req);
    const query=new URLSearchParams({offset:String(req.query.offset??0),limit:"100"});
    res.json(await bridge.call("GET",`/projects/${encodeURIComponent(String(req.params.id))}/member-candidates?${query}`,undefined,current.handle));
  });
  app.put("/api/projects/:id/members",async(req,res)=>{
    bridge.csrf(req);const current=await signed(req);
    res.json(await bridge.call("PUT",`/projects/${encodeURIComponent(String(req.params.id))}/members`,req.body,current.handle,{"If-Match":String(req.headers["if-match"]??""),"Idempotency-Key":String(req.headers["idempotency-key"]??"")}));
  });
  app.all("/api/ai/{*path}",async(req:Request,res:Response)=>{
    if(req.method!=="GET")bridge.csrf(req);
    const current=await signed(req);
    let path=req.path.slice("/api/ai".length),body=req.method==="GET"?undefined:req.body;
    if(!["GET","POST"].includes(req.method))throw forbidden();
    const allowed=await grants(current.handle);
    const match=/^\/tasks\/([^/]+)\/(conversations|pm-checks|apply-result)$/.exec(path);
    if(match){
      const p=taskScope(match[1]!,allowed);
      const access=await bridge.call("GET",`/projects/${p.external_id}/access`,undefined,current.handle);
      if(access.can_read!==true)throw new ServiceError("FORBIDDEN","Недостаточно прав для чтения задач",403);
      if(match[2]==="conversations") {
        const live=snapshot(match[1]!,p,current.actor);
        if(typeof req.body?.automatic_completion==="boolean" && req.headers["if-match"]!==`"${live.version}"`)throw new ServiceError("VERSION_CONFLICT","Версия задачи изменилась. Обновите карточку перед изменением разрешения.",409);
        body={snapshot:live,...(typeof req.body?.automatic_completion==="boolean"?{automatic_completion:req.body.automatic_completion}:{})};path="/conversations";
      }
    }
    const turnMatch=/^\/conversations\/([a-f0-9-]+)\/turns$/.exec(path);
    if(turnMatch && req.method==="POST") {
      const conv=await bridge.call("GET",`/conversations/${turnMatch[1]}`,undefined,current.handle);
      const p=taskScope(conv.task_id,allowed);
      const access=await bridge.call("GET",`/projects/${p.external_id}/access`,undefined,current.handle);
      if(access.can_read!==true)throw new ServiceError("FORBIDDEN","Недостаточно прав для чтения задач",403);
      const live=snapshot(conv.task_id,p,current.actor);
      await bridge.call("POST","/conversations",{snapshot:live},current.handle,{"Idempotency-Key":`sync:${live.id}:${live.version}`});
    }
    // Only named employee operations are proxied. Service-only delegation is unreachable here.
    if(!/^\/(conversations(?:\/[a-f0-9-]+(?:\/(?:turns|messages))?)?|turns\/[a-f0-9-]+\/actions|results\/[a-f0-9-]+(?:\/reviews)?|reviews\/[a-f0-9-]+\/decisions|artifacts\/[a-f0-9-]+|projects\/[a-f0-9-]+\/sources|tasks\/[a-f0-9-]+\/(?:pm-checks|apply-result))$/.test(path))throw forbidden();
    const query=new URLSearchParams();
    const messagePage=/^\/conversations\/[a-f0-9-]+\/messages$/.test(path);
    const conversationDetail=/^\/conversations\/[a-f0-9-]+$/.test(path);
    for(const [name,value] of Object.entries(req.query)) {
      if(req.method!=="GET" || typeof value!=="string" || value.length>1024 ||
        !(messagePage?["before","after","limit"].includes(name):conversationDetail&&name==="include_turns"))
        throw new ServiceError("VALIDATION","Некорректные параметры истории",422);
      query.set(name,value);
    }
    if(messagePage && req.method!=="GET")throw forbidden();
    if(query.size)path+=`?${query.toString()}`;
    const headers:Record<string,string>={};
    if(req.headers["idempotency-key"])headers["Idempotency-Key"]=String(req.headers["idempotency-key"]);
    if(req.headers["if-match"])headers["If-Match"]=String(req.headers["if-match"]);
    const result=await bridge.call(req.method,path,body,current.handle,headers);
    if(Buffer.isBuffer(result))return res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").attachment("document.docx").send(result);
    res.status(req.method==="POST"&&path.endsWith("/turns")?202:200).json(result);
  });
  let flushing=false;
  async function flushOutbox(handle:string,allowed:Grant[]) {
    if(flushing)return;
    flushing=true;
    try {
    if(!allowed.length || allowed.length>10000)return;
    const readable:string[]=[];
    for(const project of allowed){
      const access=await bridge.call("GET",`/projects/${project.external_id}/access`,undefined,handle);
      if(access.can_read===true)readable.push(project.external_id);
    }
    if(!readable.length)return;
    // One JSON parameter filters readable projects before the bounded delivery batch.
    const rows=service.db.prepare("SELECT * FROM task_outbox WHERE state='pending' AND project_id IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 20").all(JSON.stringify(readable));
    for(const row of rows){
      try {
        await bridge.call("POST","/task-events",{event_id:row.event_id,project_id:row.project_id,task_id:row.task_id,version:Number(row.version)},handle);
        service.db.prepare("UPDATE task_outbox SET state='sent' WHERE event_id=?").run(row.event_id as string);
      } catch { return; }
    }
    }catch { /* Pending references remain durable until an authorized request retries. */ }
    finally {flushing=false;}
  }
  return bridge;
}
