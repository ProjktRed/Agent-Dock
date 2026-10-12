import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const key=(policy,file)=>{const p=path.resolve(policy.workspace,file);return process.platform==='win32'?p.toLowerCase():p;};
const decode=value=>{if(typeof value==='string'){try{return JSON.parse(value);}catch{}}return value;};
const normalized=value=>value.replace(/\r\n/g,'\n');
export const editFingerprint=(name,input)=>hash(JSON.stringify([name,Object.fromEntries(Object.entries(input??{}).sort(([a],[b])=>a.localeCompare(b)))]));
async function source(policy,file){
 const p=key(policy,file);const info=await stat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(!info)return null;
 if(!info.isFile()||info.size>1_000_000)throw Error('Read/edit source must be a text file below 1 MB');
 return readFile(p,'utf8');
}

// Only successful, numbered content actually returned by read_files establishes freshness.
// Persist hashes/ranges, not file bodies or the conversation transcript.
export async function rememberRead(policy,tool,approvedPath){
 const results=decode(tool.output),files=tool.input?.files;
 if(!Array.isArray(results)||!Array.isArray(files))return;
 for(let i=0;i<Math.min(files.length,32);i++){
  const file=files[i]?.path,result=results[i];
  if(!file||!await approvedPath(policy,file)||result?.success!==true||typeof result.result!=='string')continue;
  const text=await source(policy,file);if(text===null)continue;
  const lines=normalized(text).split('\n');
  const returned=[...result.result.matchAll(/^\s*(\d+) \| ?(.*)$/gm)];
  if(!returned.length||returned.some((m,j)=>lines[Number(m[1])-1]!==m[2].replace(/\r$/,'')||(j&&Number(m[1])!==Number(returned[j-1][1])+1)))continue;
  const reads=policy.freshReads??={};
  reads[key(policy,file)]={sha256:hash(text),start:Number(returned[0][1]),end:Number(returned.at(-1)[1])};
  const keys=Object.keys(reads);for(const old of keys.slice(0,Math.max(0,keys.length-32)))delete reads[old];
 }
}

export async function checkSmallEdit(policy,name,input){
 if((policy.editFailures??[]).some(e=>e.stage==='native-result'&&e.fingerprint===editFingerprint(name,input)))return 'Identical failed edit already attempted. Use its saved error and reread before proposing a different small edit.';
 if(name==='apply_patch'){
  if(typeof input.input!=='string'||input.input.length>4000)return 'Patch must be at most 4000 characters. Split into small changes.';
  const updates=[...input.input.matchAll(/^\*\*\* (?:Update File|Delete File): (.+)$/gm)];
  for(const [,file] of updates){const text=await source(policy,file);if(text===null||policy.freshReads?.[key(policy,file)]?.sha256!==hash(text))return 'Read each affected file with read_files before applying a patch; current file differs from the last successful read.';}
  return null;
 }
 if(typeof input.new_text!=='string'||input.new_text.length>2000||(input.old_text?.length??0)>2000)return 'Native edit requires new_text and at most 2000 characters per old_text/new_text. Split the edit.';
 const text=await source(policy,input.path);
 if(text===null)return input.old_text!=null||input.insert_line!=null?'File does not exist; replacement/insertion is unavailable.':null;
 if(input.old_text==null&&input.insert_line==null)return 'Whole-file rewrite of an existing file is prohibited. Use a small exact replacement or verified line insertion.';
 const read=policy.freshReads?.[key(policy,input.path)];
 if(!read||read.sha256!==hash(text))return 'Fresh read required: use read_files on the intended edit range; file is unread or changed since read.';
 const body=normalized(text);
 if(input.old_text!=null){
  if(input.insert_line!=null||typeof input.old_text!=='string'||!input.old_text.length)return 'Use one edit mode with nonempty old_text for replacement.';
  const needle=normalized(input.old_text),start=body.indexOf(needle);
  if(start<0||body.indexOf(needle,start+1)>=0)return 'old_text must match exactly once in the current file. Reread a small range and use unique context; do not reconstruct escaped literals.';
  const first=body.slice(0,start).split('\n').length,last=body.slice(0,start+needle.length).split('\n').length;
  if(first<read.start||last>read.end)return 'Replacement extends outside the successfully read range. Read that range first.';
 }else if(!Number.isInteger(input.insert_line)||input.insert_line<read.start||input.insert_line>Math.min(read.end+1,body.split('\n').length+1))return 'Insertion line must be inside or immediately after the freshly read range.';
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
