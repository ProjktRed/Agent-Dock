import {readFile} from 'node:fs/promises';
import path from 'node:path';
export function parseImplementationPlan(text,task){
 task??={};
 const phases=[];let phase;
 for(const line of String(text).split(/\r?\n/)){
  const heading=line.match(/^##\s+Phase\s+(\d+)(?:\s*(?:—|-|:)\s*(.*))?$/i);
  if(heading){phase={number:Number(heading[1]),title:heading[2]?.trim()||`Phase ${heading[1]}`,tasks:[]};phases.push(phase);continue;}
  if(/^##\s/.test(line)){phase=null;continue;}
  const item=line.match(/^(\s*)-\s+\[([ xX])\]\s+(.+)$/);
  if(phase&&item)phase.tasks.push({title:item[3].trim(),completed:item[2].toLowerCase()==='x',depth:Math.floor(item[1].length/2)});
 }
 for(const p of phases){p.total=p.tasks.length;p.completed=p.tasks.filter(t=>t.completed).length;p.percent=p.total?Math.round(100*p.completed/p.total):null;}
 const total=phases.reduce((n,p)=>n+p.total,0),completed=phases.reduce((n,p)=>n+p.completed,0);
 const selected=task.phase!=null?Number(task.phase):Number(task.id?.match(/^P(\d+)[-]/i)?.[1]);
 const currentPhase=phases.some(p=>p.number===selected)?selected:phases.find(p=>p.completed<p.total)?.number??null;
 return{source:'IMPLEMENTATION_PLAN.md',phases,total,completed,percent:total?Math.round(100*completed/total):null,currentPhase,activeTask:task.id?{id:task.id,name:task.name??task.id}:null};
}
export async function readImplementationProgress(workspace,task){
 try{return parseImplementationPlan(await readFile(path.join(workspace,'IMPLEMENTATION_PLAN.md'),'utf8'),task);}
 catch(error){return{...parseImplementationPlan('',task),error:error.code==='ENOENT'?'Implementation plan unavailable':'Implementation plan unreadable'};}
}
