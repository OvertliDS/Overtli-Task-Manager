import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/storage/store.mjs";
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";
import { issueClaudeSessionCapability } from "../src/core/claude-capability.mjs";
import { CLAUDE_OTM_TOOLS, dispatchClaudeTool } from "../src/claude/mcp-server.mjs";

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
  return {root,env,ids,runId,invoke,snapshot,sessionCapability};
}
function op(name,args){return {name,arguments:args};}
test("Claude phase tool is discoverable but Codex tool registry is unchanged",()=>{
  const tool=CLAUDE_OTM_TOOLS.find(x=>x.name==="otm_phase");
  assert.ok(tool);
  assert.equal(tool.inputSchema.required.includes("sessionCapability"),true);
  assert.equal(tool.inputSchema.properties.operations.maxItems,16);
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
