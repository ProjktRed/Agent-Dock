import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SOURCE_TOO_LARGE,IDENTICAL_FAILED_EDIT,PATCH_TOO_LARGE,PATCH_STALE_READ,NATIVE_EDIT_SIZE,FILE_MISSING_REPLACEMENT,WHOLE_FILE_REWRITE,FRESH_READ_REQUIRED,ONE_EDIT_MODE,OLD_TEXT_NOT_UNIQUE,REPLACEMENT_OUTSIDE_RANGE,INSERT_LINE_OUTSIDE} from './reasons.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const key=(policy,file)=>{const p=path.resolve(policy.workspace,file);return process.platform==='win32'?p.toLowerCase():p;};
const decode=value=>{if(typeof value==='string'){try{return JSON.parse(value);}catch{}}return value;};
const normalized=value=>value.replace(/\r\n/g,'\n');
export const editFingerprint=(name,input)=>hash(JSON.stringify([name,Object.fromEntries(Object.entries(input??{}).sort(([a],[b])=>a.localeCompare(b)))]));
async function source(policy,file){
 const p=key(policy,file);const info=await stat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(!info)return null;
 if(!info.isFile()||info.size>1_000_000)throw Error(SOURCE_TOO_LARGE);
 return readFile(p,'utf8');
}

// Persist hashes/ranges of successful adapter reads, never source bodies.
export async function rememberRead(policy,tool,approvedPath,adapter){
 const ranges=adapter.readRange(tool.input,tool.output);
 for(const range of ranges){
  const {file,start,end,text:returned}=range;
  if(!file||!await approvedPath(policy,file))continue;
  const text=await source(policy,file);if(text===null)continue;
  const lines=normalized(text).split('\n');
  if(returned===null||start<1||end>lines.length||lines.slice(start-1,end).join('\n')!==returned)continue;
  const reads=policy.freshReads??={};
  reads[key(policy,file)]={sha256:hash(text),start,end};
  const keys=Object.keys(reads);for(const old of keys.slice(0,Math.max(0,keys.length-32)))delete reads[old];
 }
}

export async function checkSmallEdit(policy,action,adapter){
 const name=action.tool,input=action.input;
 if((policy.editFailures??[]).some(e=>e.stage==='native-result'&&e.fingerprint===editFingerprint(name,input)))return IDENTICAL_FAILED_EDIT;
 if(action.patch){
  if(typeof input.input!=='string'||input.input.length>4000)return PATCH_TOO_LARGE;
  const updates=adapter.patchPaths(input,{existingOnly:true});
  for(const file of updates){const text=await source(policy,file);if(text===null||policy.freshReads?.[key(policy,file)]?.sha256!==hash(text))return PATCH_STALE_READ;}
  return null;
 }
 if(typeof input.new_text!=='string'||input.new_text.length>2000||(input.old_text?.length??0)>2000)return NATIVE_EDIT_SIZE;
 const text=await source(policy,input.path);
 if(text===null)return input.old_text!=null||input.insert_line!=null?FILE_MISSING_REPLACEMENT:null;
 if(input.old_text==null&&input.insert_line==null)return WHOLE_FILE_REWRITE;
 const read=policy.freshReads?.[key(policy,input.path)];
 if(!read||read.sha256!==hash(text))return FRESH_READ_REQUIRED;
 const body=normalized(text);
 if(input.old_text!=null){
  if(input.insert_line!=null||typeof input.old_text!=='string'||!input.old_text.length)return ONE_EDIT_MODE;
  const needle=normalized(input.old_text),start=body.indexOf(needle);
  if(start<0||body.indexOf(needle,start+1)>=0)return OLD_TEXT_NOT_UNIQUE;
  const first=body.slice(0,start).split('\n').length,last=body.slice(0,start+needle.length).split('\n').length;
  if(first<read.start||last>read.end)return REPLACEMENT_OUTSIDE_RANGE;
 }else if(!Number.isInteger(input.insert_line)||input.insert_line<read.start||input.insert_line>Math.min(read.end+1,body.split('\n').length+1))return INSERT_LINE_OUTSIDE;
 return null;
}

export async function rememberEditFailure(policy,tool,error,stage='native-result'){
 const input=tool.input??{};let excerpt='';
 if(typeof input.path==='string'){
  try{const text=await source(policy,input.path);const lines=normalized(text??'').split('\n');const read=policy.freshReads?.[key(policy,input.path)];
   const start=Math.max(0,(read?.start??1)-1);excerpt=lines.slice(start,start+16).map((l,i)=>`${start+i+1} | ${l}`).join('\n').slice(0,1200);
  }catch{/* No source evidence is invented if the file is unavailable. */}
 }
 const bounded=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,typeof v==='string'?v.slice(0,2000):v]).filter(([k])=>['path','old_text','new_text','insert_line','input'].includes(k)));
 const entries=policy.editFailures??=[];
 entries.push({id:tool.id??null,tool:tool.name,stage,fingerprint:editFingerprint(tool.name,input),input:bounded,inputTruncated:Object.values(input).some(v=>typeof v==='string'&&v.length>2000),error:String(error).slice(0,1500),excerpt});
 policy.editFailures=entries.slice(-4);
}
export function nativeError(output){
 const decoded=decode(output);
 if(Array.isArray(decoded))return decoded.map(nativeError).filter(Boolean).join('; ');
 return decoded?.error??(typeof decoded==='string'?decoded:JSON.stringify(decoded));
}
