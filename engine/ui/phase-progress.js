export function createPhaseProgress(root,document){
 const expansion=new Map();
 const make=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
 return{render(plan){
  for(const node of root.querySelectorAll('details'))expansion.set(Number(node.dataset.phase),node.open);
  if(!plan?.phases?.length){root.replaceChildren(make('p',plan?.error||'Implementation plan unavailable'));return;}
  const count=make('p',`${plan.completed} / ${plan.total} documented checklist items complete`);count.className='progress-count';
  const total=make('progress');total.setAttribute('max',plan.total||1);total.setAttribute('value',plan.completed);total.setAttribute('aria-label','Documented implementation progress');
  const phases=plan.phases.map(phase=>{
   const node=make('details');node.dataset.phase=String(phase.number);node.open=expansion.get(phase.number)??phase.number===plan.currentPhase;node.className=phase.number===plan.currentPhase?'phase current':'phase';
   const summary=make('summary',`Phase ${phase.number} · ${phase.title}  ${phase.completed} / ${phase.total}`);
   const bar=make('progress');bar.setAttribute('max',phase.total||1);bar.setAttribute('value',phase.completed);bar.setAttribute('aria-label',`Phase ${phase.number} documented progress`);
   const list=make('ul');for(const task of phase.tasks){const item=make('li',`${task.completed?'✓':'○'} ${task.title}`);item.className=task.completed?'done':'pending';item.style.paddingLeft=`${task.depth*12}px`;list.append(item);}
   node.append(summary,bar,list);return node;
  });
  const active=make('p',plan.activeTask?`Active task: ${plan.activeTask.id} — ${plan.activeTask.name}`:'No active task');active.className='plan-active-task';
  root.replaceChildren(count,total,...phases,active);
 }};
}
