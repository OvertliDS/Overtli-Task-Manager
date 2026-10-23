import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/storage/store.mjs";
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";
import { issueClaudeSessionCapability } from "../src/core/claude-capability.mjs";
import { CLAUDE_OTM_TOOLS, dispatchClaudeTool } from "../src/claude/mcp-server.mjs";
import { toMcpResult } from "../src/mcp/result.mjs";

function context() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otm-claude-phase-"));
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive:true });
  const env = { ...process.env, OTM_STATE_DIR:path.join(root,"state"), OTM_STORAGE:"json", OTM_AUTO_SYNC_AGENTS:"0" };
  const nativeSessionId = "claude-phase-fixture-"+path.basename(root);
  const store = createStore({ env });
  const provider = createProviderAdapter({ provider:"claude", nativeSessionId, workspaceRoot, env, store });
  const reviewed = title => ({
    title, internalSteps:[{title:"Verify "+title,source:"test_fixture",atomic:true,atomicRationale:"One scoped function and focused test"}],
    metadata:{decomposition:{version:2,source:"test_fixture",needsModelReview:false}},
  });
  const started = provider.startTask({ workspaceRoot, goal:"Two independent verified implementation gates",tasks:[reviewed("First file"),reviewed("Second file")] });
  const ids = started.snapshot.tasks.map(x=>x.id);
  const runId = started.run.id;
  provider.close();
  const sessionCapability = issueClaudeSessionCapability({nativeSessionId,workspaceRoot,env});
  const invoke=operations=>dispatchClaudeTool({name:"otm_phase",arguments:{sessionCapability,operations},env,cwd:workspaceRoot});
  const snapshot=()=>{const s=createStore({env,readOnly:true});try{
    const a=createProviderAdapter({provider:"claude",nativeSessionId,workspaceRoot,env,store:s});
    try{return a.snapshot({workspaceRoot,write:false});}finally{a.close();}
  }catch(e){s.close();throw e;}};
  return {root,env,ids,runId,invoke,snapshot,sessionCapability,nativeSessionId,workspaceRoot};
}
function op(name,args){return {name,arguments:args};}
test("Claude phase tool is discoverable but Codex tool registry is unchanged",()=>{
  const tool=CLAUDE_OTM_TOOLS.find(x=>x.name==="otm_phase");
  assert.ok(tool);
  assert.equal(tool.inputSchema.required.includes("sessionCapability"),true);
  assert.equal(tool.inputSchema.properties.operations.maxItems,16);
  assert.match(tool.description,/NEVER put summary or status/i);
  assert.match(tool.description,/internalStep.*evidence/i);
});
test("prevalidation rejects invalid nested identities and schemas BEFORE any mutation",()=>{
  const ctx=context();
  try{
    const before=ctx.snapshot().snapshot.tasks.map(x=>x.status);
    assert.throws(()=>ctx.invoke([
      op("otm_start_task",{taskId:ctx.ids[0]}),
      op("otm_complete_task",{taskId:ctx.ids[0],status:"done"}),
    ]),{code:"MCP_UNKNOWN_ARGUMENT"});
    assert.deepEqual(ctx.snapshot().snapshot.tasks.map(x=>x.status),before,"failed validation must not partially mutate OTM");
    assert.throws(()=>ctx.invoke([
      op("otm_start_task",{taskId:ctx.ids[0]}),
      op("otm_complete_task",{taskId:ctx.ids[0],summary:"Invented unsupported field",evidence:{kind:"test_result",summary:"Provided evidence"}}),
    ]),error=>error.code==="MCP_UNKNOWN_ARGUMENT" && error.message.includes("summary") && error.message.includes("otm_progress"));
    assert.deepEqual(ctx.snapshot().snapshot.tasks.map(x=>x.status),before,"unsupported summary field must be rejected before changing any task");
    assert.throws(()=>ctx.invoke([
      op("otm_start_task",{taskId:ctx.ids[0],workspaceRoot:"C:/foreign"}),
    ]),{code:"CLAUDE_PHASE_SCOPE_OVERRIDE"});
    assert.throws(()=>ctx.invoke([
      op("otm_reconcile",{tasks:[]}),
    ]),{code:"MCP_INVALID_ARGUMENTS"});
  }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
});
test("one bounded Claude phase performs canonical task activation, evidence and completion",()=>{
 const ctx=context();
 try{
  const steps=[];
  for(const id of ctx.ids){
    steps.push(op("otm_start_task",{taskId:id}));
    steps.push(op("otm_progress",{taskId:id,internalStepIndex:0,internalStepStatus:"done",message:"Focused test verified"}));
    steps.push(op("otm_complete_task",{taskId:id,evidence:{kind:"test_result",summary:"Focused test passed in isolated fixture"}}));
  }
  const result=ctx.invoke(steps);
  assert.equal(result.ok,true,JSON.stringify(result).slice(0,600));
  assert.equal(result.applied.length,6);
  const tasks=ctx.snapshot().snapshot.tasks;
  assert.deepEqual(tasks.map(x=>x.status),["done","done"]);
  assert.equal(tasks.some(x=>x.status==="pending"),false);
 }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
});
test("runtime failure reports partial applied prefix and forbids blind replay",()=>{
 const ctx=context();
 try{
  const result=ctx.invoke([
    op("otm_start_task",{taskId:ctx.ids[0]}),
    op("otm_complete_task",{taskId:ctx.ids[0],evidence:{kind:"test_result",summary:"Attempt before required internal step done"}})
  ]);
  assert.equal(result.ok,false);
  assert.equal(result.partial,true);
  assert.equal(result.applied.length,1);
  assert.equal(result.failed.index,1);
  assert.match(result.retryPolicy,/Do not replay/);
  assert.equal(ctx.snapshot().snapshot.tasks[0].status,"active");
 }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
});
test("unknown nested keys report the operation index, JSON path, key and allowed keys",()=>{
 const ctx=context();
 try{
  let caught;
  try{ctx.invoke([
    op("otm_start_task",{taskId:ctx.ids[0]}),
    op("otm_progress",{taskId:ctx.ids[0],internalStepIndex:0,internalStepStatus:"done",evidence:{files:["a.mjs"],check:"node --test"}}),
  ]);}catch(error){caught=error;}
  assert.equal(caught?.code,"MCP_UNKNOWN_ARGUMENT");
  assert.match(caught.message,/operations\[1\]\.arguments\.evidence/);
  assert.match(caught.message,/unsupported property: check/);
  assert.match(caught.message,/Allowed keys at .*summary/);
  assert.deepEqual(caught.details.unknownKeys,["check"]);
  assert.ok(caught.details.allowedKeys.includes("command"));
  assert.equal(ctx.snapshot().snapshot.tasks[0].status,"active","validation failed before any mutation");
 }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
});
test("a batch may start a later gate over an untouched auto-activated gate, but not over one with progress",()=>{
 const ctx=context();
 try{
  // The first gate is only auto-active: starting the second is allowed.
  const switched=ctx.invoke([
    op("otm_start_task",{taskId:ctx.ids[1]}),
    op("otm_progress",{taskId:ctx.ids[1],internalStepIndex:0,internalStepStatus:"done",message:"Verified"}),
    op("otm_complete_task",{taskId:ctx.ids[1],evidence:{kind:"test_result",summary:"Second gate verified"}}),
  ]);
  assert.equal(switched.ok,true,JSON.stringify(switched).slice(0,600));
  const tasks=ctx.snapshot().snapshot.tasks;
  assert.equal(tasks[1].status,"done");
  assert.equal(tasks.filter(x=>x.status==="active").length,1,"only one gate is active");
 }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
 const busy=context();
 try{
  const result=busy.invoke([
    op("otm_progress",{taskId:busy.ids[0],message:"Started work",evidence:{kind:"note",summary:"Edited first file"}}),
    op("otm_start_task",{taskId:busy.ids[1]}),
  ]);
  assert.equal(result.ok,false);
  assert.equal(result.failed.code,"ACTIVE_TASK_INCOMPLETE");
  assert.ok(result.failed.message.includes(busy.ids[0]),result.failed.message);
  assert.match(result.failed.message,/otm_complete_task before the next otm_start_task/);
 }finally{fs.rmSync(busy.root,{recursive:true,force:true});}
});
test("compact snapshots expose internal step ids for pending gates",()=>{
 const ctx=context();
 try{
  const full=ctx.snapshot();
  const pendingStepId=full.snapshot.tasks[1].internalSteps[0].id;
  assert.equal(full.snapshot.tasks[1].status,"pending");
  const compact=toMcpResult({run:full.run,snapshot:full.snapshot}).structuredContent;
  const pending=JSON.stringify(compact).includes(pendingStepId);
  assert.equal(pending,true,"pending gate step id is visible without detail");
  // The id is usable directly: start + progress + complete in one batch.
  const result=ctx.invoke([
    op("otm_start_task",{taskId:ctx.ids[1]}),
    op("otm_progress",{taskId:ctx.ids[1],internalStepId:pendingStepId,internalStepStatus:"done",message:"Verified"}),
    op("otm_complete_task",{taskId:ctx.ids[1],evidence:{kind:"test_result",summary:"Verified by id"}}),
  ]);
  assert.equal(result.ok,true,JSON.stringify(result).slice(0,600));
 }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
});
test("contract review sticks for continuation prompts and finished routes, and clears on completion",()=>{
 const ctx=context();
 try{
  const reconcile=(mode,prompt)=>{
    const p=createProviderAdapter({provider:"claude",nativeSessionId:ctx.nativeSessionId,workspaceRoot:ctx.workspaceRoot,env:ctx.env,store:createStore({env:ctx.env})});
    try{return p.reconcileTask({runId:ctx.runId,workspaceRoot:ctx.workspaceRoot,mode,prompt,hookEventName:"UserPromptSubmit"});}finally{p.close();}
  };
  const review=()=>ctx.snapshot().run.metadata.contractReview.status;
  reconcile("continue","keep going with the next gate");
  assert.equal(review(),"reviewed","a continuation prompt keeps the prior review");
  reconcile("steer","also add an export button");
  assert.equal(review(),"needs_model_review","genuinely new requirement context needs review");
  // Completing a covered gate may acknowledge the review in the same call.
  const done=ctx.invoke([
    op("otm_progress",{taskId:ctx.ids[0],internalStepIndex:0,internalStepStatus:"done",message:"Verified"}),
    op("otm_complete_task",{taskId:ctx.ids[0],contractReviewed:true,evidence:{kind:"test_result",summary:"First verified"}}),
    op("otm_progress",{taskId:ctx.ids[1],internalStepIndex:0,internalStepStatus:"done",message:"Verified"}),
    op("otm_complete_task",{taskId:ctx.ids[1],evidence:{kind:"test_result",summary:"Second verified"}}),
  ]);
  assert.equal(done.ok,true,JSON.stringify(done).slice(0,600));
  assert.equal(review(),"reviewed");
  // A prompt after every gate is done does not demand a new review.
  reconcile("steer","thanks, also make sure it is pushed");
  assert.equal(review(),"reviewed");
  const audit=ctx.invoke([op("otm_audit_stop",{})]);
  assert.equal(audit.ok,true);
  assert.equal(ctx.snapshot().snapshot.stopAllowed,true);
 }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
});
test("unauthorized nested session identity, invalid batch size and invalid capability all reject",()=>{
 const ctx=context();
 try{
  assert.throws(()=>ctx.invoke([]),{code:"CLAUDE_PHASE_INVALID_SIZE"});
  assert.throws(()=>ctx.invoke(Array.from({length:17},()=>op("otm_audit_stop",{}))),{code:"MCP_INVALID_ARGUMENTS"});
  assert.throws(()=>ctx.invoke([op("otm_snapshot",{})]),{code:"MCP_INVALID_ARGUMENTS"});
  assert.throws(()=>dispatchClaudeTool({
    name:"otm_phase",arguments:{sessionCapability:"invalid",operations:[op("otm_start_task",{taskId:ctx.ids[0]})]},
    env:ctx.env,cwd:ctx.root,
  }),/sessionCapability/);
 }finally{fs.rmSync(ctx.root,{recursive:true,force:true});}
});
