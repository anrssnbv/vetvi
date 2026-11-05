import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index.js";
import type { Task } from "./service.js";

const prefix = "/platform/api/v1/integrations/vetvi";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
type Grant = { external_id:string; project_id:string; namespace:string; creator_id:string; personal:boolean; title:string; row_version:number };
type Person = { id:string; username:string; active:boolean; grants:Set<string> };
type Intent = { id:string; actor_id:string; project:Grant; content:Record<string,unknown>; eligible?:boolean };

async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"vetvi-bff-"));
  const key=randomBytes(32).toString("hex"),keyFile=join(directory,"client.key"),socketPath=join(directory,"sk.sock");
  writeFileSync(keyFile,`${key}\n`,{mode:0o600});
  const alice:Person={id:randomUUID(),username:"alice",active:true,grants:new Set()};
  const bob:Person={id:randomUUID(),username:"bob",active:true,grants:new Set()};
  const people=[alice,bob],sessions=new Map<string,Person>(),projects=new Map<string,Grant>();
  function project(title:string,personal=false,creator=alice) {
    const external_id=randomUUID();
    const p:Grant={external_id,project_id:randomUUID(),namespace:`project:${external_id}`,creator_id:creator.id,personal,title,row_version:1};
    projects.set(p.external_id,p);creator.grants.add(p.external_id);return p;
  }
  const shared=project("Совместный проект"),personal=project("Личный проект Алисы",true);
  bob.grants.add(shared.external_id);
  const readDenied=new Set<string>(),readOnly=new Set<string>(),seen:{path:string;method:string;headers:IncomingHttpHeaders;body:any}[]=[];
  const runs=new Map<string,{actor_id:string;project:Grant;task_id:string}>(),actions=new Map<string,Intent>();
  const artifactId=randomUUID(),artifactBytes=Buffer.from("PK\x03\x04synthetic-docx-bytes\x00\xff","binary");
  const artifactReaders=new Set([alice.id]);
  const projectReceipts=new Map<string,{hash:string;project:Grant}>();
  let loseProjectResponse=false;
  const sk=createServer(async(req,res)=>{
    try {
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const raw=Buffer.concat(chunks).toString("utf8"),body=raw?JSON.parse(raw):undefined;
      const url=new URL(req.url!,"http://sk"),path=url.pathname.slice(prefix.length);
      seen.push({path,method:req.method!,headers:{...req.headers},body});
      res.setHeader("Content-Type","application/json");
      const send=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(value));};
      if(!url.pathname.startsWith(prefix+"/") || req.headers["x-vetvi-client-key"]!==key || req.headers.cookie || req.headers.origin || req.headers.authorization)return send(401,{});
      if(path==="/sessions"&&req.method==="POST") {
        const person=people.find(p=>p.username===body?.username&&p.active);
        if(!person||body?.password!=="synthetic-password")return send(401,{});
        const handle=randomBytes(32).toString("base64url");sessions.set(handle,person);
        return send(200,{session:handle,expires_at:new Date(Date.now()+3600000).toISOString(),actor:{id:person.id,display_name:person.username,role:"manager"}});
      }
      const delegated=/^\/delegations\/(runs|actions|action-receipts)\/([^/]+)$/.exec(path);
      if(delegated) {
        if(req.headers["x-vetvi-session"])return send(401,{});
        if(delegated[1]==="runs") {
          const run=runs.get(delegated[2]!);const person=people.find(p=>p.id===run?.actor_id);
          if(!run||!person?.active||!person.grants.has(run.project.external_id))return send(404,{});
          return send(200,run);
        }
        const action=actions.get(delegated[2]!);const person=people.find(p=>p.id===action?.actor_id);
        if(!action||!person?.active||!person.grants.has(action.project.external_id)||readOnly.has(`${person.id}:${action.project.external_id}`))return send(404,{});
        if(delegated[1]==="actions"&&!action.eligible)return send(409,{});
        return send(200,action);
      }
      const person=sessions.get(String(req.headers["x-vetvi-session"]??""));
      if(!person?.active)return send(401,{});
      if(path==="/sessions/current") {
        if(req.method==="DELETE"){sessions.delete(String(req.headers["x-vetvi-session"]));res.statusCode=204;res.end();return;}
        return send(200,{actor:{id:person.id,display_name:person.username,role:"manager"},expires_at:new Date(Date.now()+3600000).toISOString(),classifications:["synthetic"],lifecycle_states:["draft"]});
      }
      if(path==="/projects"&&req.method==="GET")return send(200,{items:[...projects.values()].filter(p=>person.grants.has(p.external_id)&&(!p.personal||p.creator_id===person.id)),next_offset:null});
      if(path==="/projects"&&req.method==="POST") {
        const receiptKey=`${person.id}:${req.headers["idempotency-key"]}`,hash=JSON.stringify(body),old=projectReceipts.get(receiptKey);
        if(old){if(old.hash!==hash)return send(409,{});return send(200,{item:old.project});}
        if(projects.has(body.external_id))return send(409,{});
        const p:Grant={external_id:body.external_id,project_id:randomUUID(),namespace:`project:${body.external_id}`,creator_id:person.id,personal:body.personal,title:body.project.title,row_version:1};
        projects.set(p.external_id,p);person.grants.add(p.external_id);projectReceipts.set(receiptKey,{hash,project:p});
        if(loseProjectResponse){loseProjectResponse=false;req.socket.destroy();return;}
        return send(200,{item:p});
      }
      const projectRoute=/^\/projects\/([^/]+)\/(access|members|sources)$/.exec(path);
      if(projectRoute) {
        const p=projects.get(projectRoute[1]!);
        if(!p||!person.grants.has(p.external_id)||(p.personal&&p.creator_id!==person.id))return send(404,{});
        if(projectRoute[2]==="access")return send(200,{can_read:!readDenied.has(`${person.id}:${p.external_id}`),can_write:!readOnly.has(`${person.id}:${p.external_id}`),can_edit_project:p.creator_id===person.id,can_manage:p.creator_id===person.id&&!p.personal,can_review:false});
        if(projectRoute[2]==="members")return send(200,{project:p,items:people.filter(candidate=>candidate.grants.has(p.external_id)).map(candidate=>({id:candidate.id,display_name:candidate.username,active:candidate.active}))});
        return send(200,{items:[]});
      }
      if(path==="/task-events") {
        const p=projects.get(body.project_id);
        if(!p||!person.grants.has(p.external_id)||readDenied.has(`${person.id}:${p.external_id}`))return send(404,{});
        assert.deepEqual(Object.keys(body).sort(),["event_id","project_id","task_id","version"]);
        return send(200,{ok:true});
      }
      if(path===`/artifacts/${artifactId}`) {
        if(!artifactReaders.has(person.id))return send(404,{});
        res.setHeader("Content-Type",DOCX);res.end(artifactBytes);return;
      }
      if(path==="/conversations"&&req.method==="POST")return send(200,{id:randomUUID()});
      if(/^\/conversations\/[a-f0-9-]+\/messages$/.test(path)&&req.method==="GET")return send(200,{items:[],query:Object.fromEntries(url.searchParams),actor_id:person.id});
      return send(404,{});
    }catch(error){res.statusCode=500;res.end(JSON.stringify({code:"SYNTHETIC_SERVER_FAILURE",message:String(error)}));}
  });
  await new Promise<void>((resolve,reject)=>{sk.once("error",reject);sk.listen(socketPath,resolve);});
  const server=createServer();
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();assert(address&&typeof address!=="string");
  const origin=`http://127.0.0.1:${address.port}`;
  const {app,service}=createApp({databasePath:join(directory,"tasks.sqlite"),baseUrl:`${origin}/space/`,owner:"legacy-owner",login:"admin",password:"legacy-password-forbidden",bridge:{socketPath,keyFile,baseUrl:`${origin}/space/`}});
  server.on("request",app);
  async function browser(path:string,method="GET",body?:unknown,cookie="",extra:Record<string,string>={}) {
    return fetch(origin+path,{method,headers:{...(method==="GET"?{}:{Origin:origin}),...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{"Content-Type":"application/json"}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async function login(person:Person) {
    const response=await browser("/api/login","POST",{username:person.username,password:"synthetic-password",actor:{id:"forged",role:"admin"}});
    assert.equal(response.status,200,await response.clone().text());
    const cookie=response.headers.get("set-cookie")!.split(";")[0]!;
    assert(response.headers.get("set-cookie")!.includes("Path=/space"));
    return {cookie,response:await response.json()};
  }
  const tool=(cookie:string,name:string,args:Record<string,unknown>={})=>browser(`/api/tools/${name}`,"POST",args,cookie);
  const internal=(path:string,method="POST",body?:unknown,extra:Record<string,string>={})=>browser(path,method,body,"",{Origin:"","X-Vetvi-Client-Key":key,...extra});
  return {directory,key,origin,service,alice,bob,shared,personal,seen,sessions,runs,actions,readOnly,readDenied,artifactId,artifactBytes,artifactReaders,projects,browser,login,tool,internal,
    loseNextProjectResponse(){loseProjectResponse=true;},
    async close(){server.closeAllConnections();sk.closeAllConnections();await Promise.all([new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())),new Promise<void>((resolve,reject)=>sk.close(error=>error?reject(error):resolve()))]);service.close();rmSync(directory,{recursive:true,force:true});}};
}

test("shared HTTP uses individual SK identity, rejects legacy owner/MCP and enforces Host/Origin",async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.browser("/api/session")).status,200);
    assert.equal((await f.tool("","list_projects")).status,401);
    assert.equal((await f.browser("/api/login","POST",{username:"admin",password:"legacy-password-forbidden"})).status,401);
    const {cookie,response}=await f.login(f.alice);
    assert.equal(response.actor.id,f.alice.id);
    assert.equal(response.identity.actor.role,"manager");
    for(const handle of f.sessions.keys())assert(!JSON.stringify(response).includes(handle));
    const me=await(await f.browser("/api/session","GET",undefined,cookie,{"X-User-Id":f.bob.id,"X-Vetvi-Session":"forged"})).json();
    assert.equal(me.actor.id,f.alice.id);assert.equal(me.shared,true);
    const before=f.seen.length;
    assert.equal((await f.browser("/api/tools/list_projects","POST",{},cookie,{Origin:"http://evil.invalid"})).status,403);
    const badHost=await new Promise<number>((resolve,reject)=>{
      const outbound=request(f.origin+"/api/session",{headers:{Host:"evil.invalid",Cookie:cookie}},response=>{
        response.resume();response.on("end",()=>resolve(response.statusCode!));
      });
      outbound.on("error",reject);outbound.end();
    });
    assert.equal(badHost,403);
    assert.equal(f.seen.length,before);
    assert.equal((await f.browser("/mcp","POST",{},cookie)).status,403);
    assert(f.seen.every(entry=>!entry.headers.cookie&&!entry.headers.origin&&!entry.headers.authorization));
    assert(f.seen.every(entry=>entry.headers.host===new URL(f.origin).host));
    f.alice.active=false;
    const revoked=await(await f.browser("/api/session","GET",undefined,cookie)).json();
    assert.equal(revoked.authenticated,false);
    assert.equal((await f.tool(cookie,"list_projects")).status,401);
  }finally{await f.close();}
});

test("chat pages forward only named read parameters with the individual session", async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login(f.alice);
    const path = `/api/ai/conversations/${randomUUID()}/messages`;
    const response = await f.browser(`${path}?before=opaque.cursor&limit=25`, "GET", undefined, cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], query: { before: "opaque.cursor", limit: "25" }, actor_id: f.alice.id });
    assert.equal((await f.browser(`${path}?after=a&after=b`, "GET", undefined, cookie)).status, 422);
    assert.equal((await f.browser(`${path}?x-vetvi-session=forged`, "GET", undefined, cookie)).status, 422);
    assert.equal((await f.browser(path, "POST", {}, cookie)).status, 404);
    assert.equal((await f.browser(path)).status, 401);
    assert(f.seen.every(entry => !entry.headers.cookie && !entry.headers.origin && !entry.headers.authorization));
  } finally { await f.close(); }
});

test("shared HTTP isolates private tasks, preserves authors and enforces current project write capability",async()=>{
  const f=await fixture();
  try {
    const a=(await f.login(f.alice)).cookie,b=(await f.login(f.bob)).cookie;
    const visible=await(await f.tool(a,"create_task",{projectId:f.shared.external_id,title:"Общая справка",criteria:["Проверено"],assigneeId:f.alice.id,collaboratorIds:[f.bob.id],requestId:"shared-create"})).json() as Task;
    assert(visible.id);
    const hidden=await(await f.tool(a,"create_task",{projectId:f.personal.external_id,title:"Частная заметка",requestId:"private-create"})).json() as Task;
    const all=await(await f.tool(b,"search_tasks")).json();
    assert.equal(all.total,1);assert.equal(all.items[0].id,visible.id);assert(!JSON.stringify(all).includes(hidden.title));
    assert.equal((await f.tool(b,"get_task",{id:hidden.id})).status,404);
    assert.equal((await f.tool(b,"export_data",{projectId:f.personal.external_id})).status,404);
    const editedResponse=await f.tool(b,"update_task",{id:visible.id,expectedVersion:1,title:"Правка Боба",requestId:"bob-edit"});
    assert.equal(editedResponse.status,200,await editedResponse.clone().text());
    const edited=await editedResponse.json() as Task;
    assert.equal(edited.version,2);
    const detail=await(await f.tool(a,"get_task",{id:visible.id})).json();
    assert.deepEqual(detail.history.map((entry:any)=>entry.actor),[f.bob.id,f.alice.id]);
    assert.equal((await f.tool(a,"update_task",{id:visible.id,expectedVersion:1,title:"Старая правка",requestId:"stale-edit"})).status,409);
    f.readOnly.add(`${f.bob.id}:${f.shared.external_id}`);
    assert.equal((await f.tool(b,"update_task",{id:visible.id,expectedVersion:2,title:"Запрещённая правка",requestId:"readonly-edit"})).status,403);
    assert.equal((await f.tool(b,"get_task",{id:visible.id})).status,200);
    f.bob.grants.delete(f.shared.external_id);
    assert.equal((await f.tool(b,"get_task",{id:visible.id})).status,404);
    assert.equal((await(await f.tool(b,"search_tasks")).json()).total,0);
    const outbox=f.service.db.prepare("SELECT state FROM task_outbox").all();
    assert(outbox.length>=3);assert(outbox.every(row=>row.state==="sent"));
  }finally{await f.close();}
});

test("shared HTTP reconciles project creation and restricts AI facade and stored-intent callbacks",async()=>{
  const f=await fixture();
  try {
    const a=(await f.login(f.alice)).cookie,b=(await f.login(f.bob)).cookie;
    const args={title:"Проект после потерянного ответа",requestId:"create-project-lost-response",personal:true};
    f.loseNextProjectResponse();
    assert.equal((await f.tool(a,"create_project",args)).status,503);
    const result=await f.tool(a,"create_project",args);
    assert.equal(result.status,200,await result.clone().text());
    const p=await result.json();
    assert(p.id);assert.equal(p.personal,true);
    assert.equal([...f.projects.values()].filter(project=>project.title===args.title).length,1);
    assert.equal((await(await f.tool(a,"create_project",args)).json()).id,p.id);
    assert.equal((await f.tool(a,"create_project",{...args,title:"Другое тело"})).status,409);
    const task=await(await f.tool(a,"create_task",{projectId:f.personal.external_id,title:"Контекст только Алисы",requestId:"context-task"})).json() as Task;
    const runId=randomUUID();f.runs.set(runId,{actor_id:f.alice.id,project:f.personal,task_id:task.id});
    assert.equal((await f.browser("/api/internal/ai/snapshot","POST",{run_id:runId})).status,404);
    assert.equal((await f.internal("/api/internal/ai/snapshot","POST",{actor_id:f.alice.id,task_id:task.id})).status,404);
    assert.equal((await f.internal("/api/internal/ai/snapshot","POST",{run_id:randomUUID(),actor_id:f.alice.id})).status,404);
    const snapshot=await(await f.internal("/api/internal/ai/snapshot","POST",{run_id:runId,actor_id:f.bob.id,project_id:f.shared.external_id})).json();
    assert.equal(snapshot.id,task.id);assert.equal(snapshot.project_id,f.personal.external_id);assert.equal(snapshot.title,task.title);
    const before=f.seen.length;
    assert.equal((await f.browser(`/api/ai/delegations/runs/${runId}`,"GET",undefined,a)).status,404);
    assert.equal((await f.browser(`/api/ai/sessions/current`,"GET",undefined,a)).status,404);
    assert(f.seen.slice(before).every(entry=>!entry.path.startsWith("/delegations/")));
    const download=await f.browser(`/api/ai/artifacts/${f.artifactId}`,"GET",undefined,a);
    assert.equal(download.status,200);assert(download.headers.get("content-type")!.startsWith(DOCX));
    assert(download.headers.get("content-disposition")!.includes("document.docx"));
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),f.artifactBytes);
    assert.equal((await f.browser(`/api/ai/artifacts/${f.artifactId}`,"GET",undefined,b)).status,404);
    f.alice.grants.delete(f.personal.external_id);
    assert.equal((await f.internal("/api/internal/ai/snapshot","POST",{run_id:runId})).status,404);
  }finally{await f.close();}
});

test("private completion retries recover the TaskService receipt without repeating an effect",async()=>{
  const f=await fixture();
  try {
    const a=(await f.login(f.alice)).cookie;
    const task=await(await f.tool(a,"create_task",{projectId:f.shared.external_id,title:"Документ на завершение",criteria:["Принят руководителем"],requestId:"completion-task"})).json() as Task;
    const actionId=randomUUID(),artifactId=randomUUID();
    const action:Intent={id:actionId,actor_id:f.alice.id,project:f.shared,eligible:true,content:{task_id:task.id,task_version:task.version,result_id:randomUUID(),result_hash:"a".repeat(64),artifact_id:artifactId,artifact_hash:"b".repeat(64),delegated_by:f.alice.id}};
    f.actions.set(actionId,action);
    assert.equal((await f.internal(`/api/internal/ai/receipts/${actionId}`,"GET")).status,404);
    const first=await f.internal("/api/internal/ai/apply-result","POST",{action_id:actionId,actor_id:f.bob.id,result:"Непроверенный текст"});
    assert.equal(first.status,200,await first.clone().text());
    const receipt=await first.json();assert.equal(receipt.task.status,"done");assert.equal(receipt.task.version,2);
    assert(receipt.task.result.includes(String(action.content.result_hash)));
    assert(!receipt.task.result.includes("Непроверенный текст"));
    const completed=()=>f.service.db.prepare("SELECT data FROM changes WHERE task_id=?").all(task.id).map(row=>JSON.parse(row.data as string)).filter(entry=>entry.action==="complete_task");
    assert.equal(completed().length,1);
    assert.deepEqual(completed()[0].operation,{agent:"pm",delegatedBy:f.alice.id,actionId,resultId:action.content.result_id,artifactId});
    assert.deepEqual(await(await f.internal("/api/internal/ai/apply-result","POST",{action_id:actionId})).json(),receipt);
    // Simulate process death after the task transaction committed but before the bridge receipt was saved.
    f.service.db.prepare("DELETE FROM completion_receipts WHERE action_id=?").run(actionId);
    action.eligible=false;
    const allowedCalls=f.seen.filter(entry=>entry.path===`/delegations/actions/${actionId}`).length;
    assert.deepEqual(await(await f.internal(`/api/internal/ai/receipts/${actionId}`,"GET")).json(),receipt);
    assert.deepEqual(await(await f.internal("/api/internal/ai/apply-result","POST",{action_id:actionId})).json(),receipt);
    assert.equal(completed().length,1);
    assert.equal(f.seen.filter(entry=>entry.path===`/delegations/actions/${actionId}`).length,allowedCalls);
    const unchanged=JSON.parse(f.service.db.prepare("SELECT data FROM records WHERE id=?").get(task.id)!.data as string) as Task;
    assert.equal(unchanged.version,2);
    f.alice.grants.delete(f.shared.external_id);
    assert.equal((await f.internal(`/api/internal/ai/receipts/${actionId}`,"GET")).status,404);
  }finally{await f.close();}
});


test("foreign private pending events cannot starve the current human's project outbox", async () => {
  const f = await fixture();
  try {
    const cookie = (await f.login(f.bob)).cookie;
    for (let index = 0; index < 25; index++) {
      f.service.db.prepare("INSERT INTO task_outbox(event_id,project_id,task_id,version,actor_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(`private-event-${index}`, f.personal.external_id, randomUUID(), 1, f.alice.id, "2026-11-01T00:00:00Z");
    }
    const response = await f.tool(cookie, "create_task", {
      projectId: f.shared.external_id, title: "Событие доступного проекта", requestId: "deliver-own-event",
    });
    assert.equal(response.status, 200, await response.clone().text());
    const task = await response.json() as Task;
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = f.service.db.prepare("SELECT state FROM task_outbox WHERE task_id=?").get(task.id);
      if (row?.state === "sent") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.service.db.prepare("SELECT state FROM task_outbox WHERE task_id=?").get(task.id)?.state, "sent");
    const foreign = f.service.db.prepare("SELECT state FROM task_outbox WHERE project_id=?").all(f.personal.external_id);
    assert.equal(foreign.length, 25);
    assert(foreign.every(row => row.state === "pending"));
    const events = f.seen.filter(entry => entry.path === "/task-events");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.body.project_id, f.shared.external_id);
    assert.equal(events[0]!.body.task_id, task.id);
    assert(!JSON.stringify(events).includes(f.personal.external_id));
  } finally {
    await f.close();
  }
});


test("nested assignment patches validate the effective fields against current project members", async () => {
  const f = await fixture();
  try {
    const cookie = (await f.login(f.alice)).cookie;
    const created = await f.tool(cookie, "create_task", {
      projectId: f.shared.external_id, title: "Назначение участников", assigneeId: f.alice.id,
      collaboratorIds: [], requestId: "assignment-create",
    });
    assert.equal(created.status, 200, await created.clone().text());
    const task = await created.json() as Task;
    const outsider = randomUUID();
    for (const patch of [{ assigneeId: outsider }, { collaboratorIds: [outsider] }]) {
      const response = await f.tool(cookie, "update_task", {
        id: task.id, expectedVersion: 1, requestId: randomUUID(),
        assigneeId: f.alice.id, collaboratorIds: [f.bob.id], patch,
      });
      assert.equal(response.status, 404);
      const unchanged = await (await f.tool(cookie, "get_task", { id: task.id })).json() as Task;
      assert.equal(unchanged.version, 1);
      assert.equal(unchanged.assigneeId, f.alice.id);
      assert.deepEqual(unchanged.collaboratorIds, []);
    }
    const valid = {
      id: task.id, expectedVersion: 1, requestId: "nested-valid-member",
      assigneeId: outsider, patch: { assigneeId: f.bob.id, collaboratorIds: [f.alice.id] },
    };
    const changed = await f.tool(cookie, "update_task", valid);
    assert.equal(changed.status, 200, await changed.clone().text());
    const updated = await changed.json() as Task;
    assert.equal(updated.version, 2);
    assert.equal(updated.assigneeId, f.bob.id);
    assert.deepEqual(updated.collaboratorIds, [f.alice.id]);
    f.bob.grants.delete(f.shared.external_id);
    assert.equal((await f.tool(cookie, "update_task", valid)).status, 404);
    assert.equal((await (await f.tool(cookie, "get_task", { id: task.id })).json() as Task).version, 2);
  } finally {
    await f.close();
  }
});


test("HTTP transfer retries use their original source and recheck both current project rights", async () => {
  const f = await fixture();
  try {
    const cookie = (await f.login(f.alice)).cookie;
    const task = await (await f.tool(cookie, "create_task", {
      projectId: f.personal.external_id, title: "Личное дерево", assigneeId: f.alice.id, requestId: "transfer-root",
    })).json() as Task;
    const child = await (await f.tool(cookie, "create_task", {
      projectId: f.personal.external_id, parentId: task.id, title: "Личный шаг", requestId: "transfer-child",
    })).json() as Task;
    const body = { targetProjectId: f.shared.external_id, expectedVersion: task.version, requestId: "transfer-lost-response", confirmSharing: true };
    const path = `/api/tasks/${task.id}/transfer`;
    const first = await f.browser(path, "POST", body, cookie);
    assert.equal(first.status, 200, await first.clone().text());
    const decision = await first.json() as { task: Task; movedTaskIds: string[] };
    assert.equal(decision.task.projectId, f.shared.external_id);
    assert.deepEqual(new Set(decision.movedTaskIds), new Set([task.id, child.id]));
    const counts = () => ({
      transfers: f.service.db.prepare("SELECT count(*) AS n FROM task_transfers").get()!.n,
      receipts: f.service.db.prepare("SELECT count(*) AS n FROM transfer_receipts").get()!.n,
      changes: f.service.db.prepare("SELECT count(*) AS n FROM changes").get()!.n,
      events: f.service.db.prepare("SELECT count(*) AS n FROM task_outbox").get()!.n,
    });
    const committed = counts();
    const retry = await f.browser(path, "POST", body, cookie);
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.deepEqual(await retry.json(), decision);
    assert.deepEqual(counts(), committed);
    assert.equal((await f.browser(path, "POST", { ...body, expectedVersion: task.version + 1 }, cookie)).status, 409);
    for (const project of [f.personal, f.shared]) {
      f.readDenied.add(`${f.alice.id}:${project.external_id}`);
      assert.equal((await f.browser(path, "POST", body, cookie)).status, 403);
      f.readDenied.delete(`${f.alice.id}:${project.external_id}`);
    }
    f.alice.grants.delete(f.personal.external_id);
    assert.equal((await f.browser(path, "POST", body, cookie)).status, 404);
    f.alice.grants.add(f.personal.external_id);
    f.readOnly.add(`${f.alice.id}:${f.personal.external_id}`);
    assert.equal((await f.browser(path, "POST", body, cookie)).status, 403);
    f.readOnly.delete(`${f.alice.id}:${f.personal.external_id}`);
    f.readOnly.add(`${f.alice.id}:${f.shared.external_id}`);
    assert.equal((await f.browser(path, "POST", body, cookie)).status, 403);
    f.readOnly.delete(`${f.alice.id}:${f.shared.external_id}`);
    f.alice.grants.delete(f.shared.external_id);
    assert.equal((await f.browser(path, "POST", body, cookie)).status, 404);
    assert.deepEqual(counts(), committed);
  } finally {
    await f.close();
  }
});


test("project visibility alone never grants task text, counts, history or export", async () => {
  const f = await fixture();
  try {
    const alice = (await f.login(f.alice)).cookie, bob = (await f.login(f.bob)).cookie;
    const task = await (await f.tool(alice, "create_task", {
      projectId: f.shared.external_id, title: "Содержимое только для читателя задач", requestId: "task-read-capability",
    })).json() as Task;
    assert.equal((await f.tool(bob, "get_task", { id: task.id })).status, 200);
    f.readDenied.add(`${f.bob.id}:${f.shared.external_id}`);
    const projects = await (await f.tool(bob, "list_projects")).json();
    assert.equal(projects.items[0].title, f.shared.title);
    assert(!JSON.stringify(projects).includes(task.title));
    for (const tool of ["search_tasks", "get_changes"]) {
      const response = await f.tool(bob, tool);
      assert.equal(response.status, 200);
      const empty = await response.json();
      assert.deepEqual(empty.items, []);
      assert.equal(empty.total, 0);
      assert(!JSON.stringify(empty).includes(task.title));
    }
    for (const [tool, args] of [
      ["get_task", { id: task.id }], ["get_subtree", { id: task.id }],
      ["preview_delete", { id: task.id }], ["search_tasks", { projectId: f.shared.external_id }],
      ["get_changes", { projectId: f.shared.external_id }], ["export_data", { projectId: f.shared.external_id }],
    ] as const) {
      const denied = await f.tool(bob, tool, args);
      assert.equal(denied.status, 403);
      assert(!(await denied.text()).includes(task.title));
    }
    assert.equal((await f.browser(`/api/ai/tasks/${task.id}/conversations`, "POST", {}, bob)).status, 403);
    f.readDenied.delete(`${f.bob.id}:${f.shared.external_id}`);
    const restored = await (await f.tool(bob, "search_tasks")).json();
    assert.equal(restored.total, 1);
    assert.equal(restored.items[0].title, task.title);
  } finally {
    await f.close();
  }
});

test("project trash and restore require project editing authority rather than task write", async () => {
  const f = await fixture();
  try {
    const alice = (await f.login(f.alice)).cookie, bob = (await f.login(f.bob)).cookie;
    await f.tool(alice, "list_projects");
    const remove = { id: f.shared.external_id, expectedVersion: 1, requestId: "project-trash-capability", confirmationTitle: f.shared.title };
    const task = await (await f.tool(alice, "create_task", { projectId: f.shared.external_id, title: "Закончить перед удалением", requestId: "before-project-trash" })).json();
    assert.equal((await f.tool(bob, "delete_project", remove)).status, 403);
    assert.equal((await f.tool(alice, "delete_project", { ...remove, confirmationTitle: "Не то название" })).status, 400);
    assert.equal((await f.tool(alice, "delete_project", remove)).status, 409);
    await f.tool(alice, "complete_task", { id: task.id, expectedVersion: 1, requestId: "finish-before-trash", result: "Дальнейшая работа не требуется" });
    f.readOnly.add(`${f.alice.id}:${f.shared.external_id}`);
    assert.equal((await f.tool(alice, "delete_project", remove)).status, 403);
    f.readOnly.delete(`${f.alice.id}:${f.shared.external_id}`);
    const removed = await f.tool(alice, "delete_project", remove);
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.equal((await removed.json()).version, 2);
    assert((await (await f.tool(alice, "get_task", { id: task.id })).json()).deletedAt);
    const restore = { id: f.shared.external_id, expectedVersion: 2, requestId: "project-restore-capability" };
    assert.equal((await f.tool(bob, "restore_project", restore)).status, 403);
    assert.equal((await f.tool(alice, "restore_project", restore)).status, 200);
    const access = await (await f.browser(`/api/projects/${f.personal.external_id}/access`, "GET", undefined, alice)).json();
    assert.equal(access.can_manage, false);
    assert.equal(access.can_edit_project, true);
    assert.equal((await f.tool(alice, "delete_project", { id: f.personal.external_id, expectedVersion: 1, requestId: "personal-trash", confirmationTitle: f.personal.title })).status, 200);
  } finally {
    await f.close();
  }
});


test("metadata-only project events cannot starve a readable project or require task write", async () => {
  const f = await fixture();
  try {
    const metadata: Grant = {
      external_id: randomUUID(), project_id: randomUUID(), namespace: "metadata-only-storage",
      creator_id: f.alice.id, personal: false, title: "Проект без права чтения задач", row_version: 1,
    };
    f.projects.set(metadata.external_id, metadata);
    f.bob.grants.add(metadata.external_id);
    f.readDenied.add(`${f.bob.id}:${metadata.external_id}`);
    f.readOnly.add(`${f.bob.id}:${f.shared.external_id}`);
    for (let index = 0; index < 25; index++) {
      f.service.db.prepare("INSERT INTO task_outbox(event_id,project_id,task_id,version,actor_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(`metadata-only-${index}`, metadata.external_id, randomUUID(), 1, f.alice.id, "2026-11-01T00:00:00Z");
    }
    const readableEvent = "readable-event", readableTask = randomUUID();
    f.service.db.prepare("INSERT INTO task_outbox(event_id,project_id,task_id,version,actor_id,created_at) VALUES(?,?,?,?,?,?)")
      .run(readableEvent, f.shared.external_id, readableTask, 1, f.alice.id, "2026-11-02T00:00:00Z");
    const cookie = (await f.login(f.bob)).cookie;
    assert.equal((await f.tool(cookie, "list_projects")).status, 200);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (f.service.db.prepare("SELECT state FROM task_outbox WHERE event_id=?").get(readableEvent)?.state === "sent") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.service.db.prepare("SELECT state FROM task_outbox WHERE event_id=?").get(readableEvent)?.state, "sent");
    const blocked = f.service.db.prepare("SELECT state FROM task_outbox WHERE project_id=?").all(metadata.external_id);
    assert.equal(blocked.length, 25);
    assert(blocked.every(row => row.state === "pending"));
    const delivered = f.seen.filter(entry => entry.path === "/task-events");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.body.event_id, readableEvent);
    assert.equal(delivered[0]!.body.task_id, readableTask);
    assert(!JSON.stringify(delivered).includes(metadata.external_id));
  } finally {
    await f.close();
  }
});


test("only project management can change executors, including clearing and imports", async () => {
  const f = await fixture();
  try {
    const manager = (await f.login(f.alice)).cookie;
    const employee = (await f.login(f.bob)).cookie;
    const task = await (await f.tool(manager, "create_task", {
      projectId: f.shared.external_id, title: "Shared progress", assigneeId: f.alice.id,
      collaboratorIds: [f.bob.id], requestId: "executor-create",
    })).json() as Task;
    for (const fields of [{assigneeId: null}, {collaboratorIds: []}, {patch: {assigneeId: f.bob.id}}]) {
      const denied = await f.tool(employee, "update_task", {id: task.id, expectedVersion: 1, requestId: randomUUID(), ...fields});
      assert.equal(denied.status, 403);
    }
    assert.equal((await f.tool(employee, "create_task", {projectId: f.shared.external_id, title: "No self assignment", assigneeId: f.bob.id, requestId: "executor-self"})).status, 403);
    assert.equal((await f.tool(employee, "import_data", {projectId: f.shared.external_id, data: {tasks: []}, requestId: "executor-import"})).status, 403);
    const changed = await f.tool(employee, "update_task", {id: task.id, expectedVersion: 1, description: "Visible task progress", requestId: "progress-write"});
    assert.equal(changed.status, 200);
    const read = await (await f.tool(manager, "get_task", {id: task.id})).json() as Task;
    assert.equal(read.description, "Visible task progress");
    assert.equal(read.assigneeId, f.alice.id);
    assert.deepEqual(read.collaboratorIds, [f.bob.id]);
    const child = await (await f.tool(manager, "create_task", {projectId: f.shared.external_id, parentId: task.id, title: "Child", assigneeId: f.bob.id, requestId: "executor-child"})).json() as Task;
    assert.equal(child.assigneeId, f.bob.id);
    const cleared = await f.tool(manager, "update_task", {id: child.id, expectedVersion: child.version, patch: {assigneeId: null, collaboratorIds: []}, requestId: "executor-clear"});
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json() as Task).assigneeId, null);
    f.readOnly.add(`${f.alice.id}:${f.shared.external_id}`);
    assert.equal((await f.tool(manager, "update_task", {id: task.id, expectedVersion: read.version, assigneeId: f.bob.id, requestId: "executor-revoked"})).status, 403);
  } finally { await f.close(); }
});
