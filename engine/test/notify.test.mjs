import test from 'node:test';
import assert from 'node:assert/strict';
import {channelRequest,checkChannel,flushNotifications,notify,notifyFromEnv,sendChannel,useNotify} from '../src/notify.mjs';

const TOKEN='123456789:'+'A'.repeat(35);
const EMAIL={apiKey:'am_live_0123456789',inbox:'Bot@AgentMail.to',to:'me@example.com, you@example.org'};

test('channel settings are validated and normalized; secrets with the wrong shape are refused',()=>{
 assert.equal(checkChannel('slack','https://hooks.slack.com/services/T/B/x'),'https://hooks.slack.com/services/T/B/x');
 assert.throws(()=>checkChannel('slack','https://hooks.slack.com.evil.io/services/x'),/Slack incoming webhook/);
 assert.throws(()=>checkChannel('slack','http://localhost/services/x'),/Slack incoming webhook/);
 assert.deepEqual(checkChannel('telegram',{token:` ${TOKEN} `,chatId:'-100123'}),{token:TOKEN,chatId:'-100123'});
 assert.throws(()=>checkChannel('telegram',{token:'nope',chatId:'1'}),/bot token/);
 assert.throws(()=>checkChannel('telegram',{token:TOKEN,chatId:'@me'}),/chat ID/);
 assert.deepEqual(checkChannel('email',EMAIL),{apiKey:'am_live_0123456789',inbox:'bot@agentmail.to',to:['me@example.com','you@example.org']});
 assert.throws(()=>checkChannel('email',{...EMAIL,to:'not-an-address'}),/1–5 valid/);
 assert.throws(()=>checkChannel('email',{...EMAIL,to:'a@b.co,c@d.co,e@f.co,g@h.co,i@j.co,k@l.co'}),/1–5 valid/);
 assert.throws(()=>checkChannel('email',{...EMAIL,apiKey:''}),/API key/);
 assert.throws(()=>checkChannel('pager','x'),/Unknown/);
 assert.equal(checkChannel('telegram',null),null);
});

test('each channel gets the request shape its service expects',()=>{
 const note={project:'Demo',type:'blocked',title:'Run blocked',message:'Scope',at:'2026-10-18T00:00:00.000Z'};
 const [slackUrl,slack]=channelRequest('slack','https://hooks.slack.com/services/x',note);
 assert.equal(slackUrl,'https://hooks.slack.com/services/x');assert.deepEqual(JSON.parse(slack.body),{text:'*Run blocked · Demo*\nScope',unfurl_links:false});
 const [tgUrl,tg]=channelRequest('telegram',{token:TOKEN,chatId:'42'},note);
 assert.equal(tgUrl,`https://api.telegram.org/bot${TOKEN}/sendMessage`);assert.deepEqual(JSON.parse(tg.body),{chat_id:'42',text:'Run blocked · Demo\nScope',disable_web_page_preview:true});
 const [mailUrl,mail]=channelRequest('email',checkChannel('email',EMAIL),note);
 assert.equal(mailUrl,'https://api.agentmail.to/v0/inboxes/bot%40agentmail.to/messages/send');
 assert.equal(mail.headers.authorization,'Bearer am_live_0123456789');
 const body=JSON.parse(mail.body);
 assert.deepEqual(body.to,['me@example.com','you@example.org']);assert.equal(body.subject,'Agent Dock: Run blocked · Demo');assert.match(body.text,/^Scope\n\n— Agent Dock \(Demo\)/);
});

test('email only gets what needs you; other channels get everything; failures never throw',async t=>{
 const sent=[];t.after(()=>useNotify());
 notifyFromEnv({AGENT_DOCK_NOTIFY:JSON.stringify({project:'Demo',slack:'https://hooks.slack.com/services/x',telegram:{token:TOKEN,chatId:'42'},email:EMAIL})});
 useNotify({project:'Demo',slack:'https://hooks.slack.com/services/x',telegram:{token:TOKEN,chatId:'42'},email:EMAIL},{fetchImpl:async url=>{sent.push(String(url));return url.includes('telegram')?{ok:false,status:401}:{ok:true};}});
 const mails=()=>sent.filter(u=>u.includes('agentmail')).length;
 notify({type:'supervisor-alert',title:'Supervisor: stall',message:'quiet'});await flushNotifications();
 assert.equal(sent.length,2);assert.equal(mails(),0);
 notify({type:'supervisor-alert',title:'Supervisor: repeat failure',message:'paused',urgent:true});await flushNotifications();
 assert.equal(mails(),1);
 notify({type:'supervisor-digest',title:'Digest',message:'d'});notify({type:'user-attention',title:'Needs you',message:'m'});await flushNotifications();
 assert.equal(mails(),2);assert.equal(sent.length,10);
 await assert.rejects(sendChannel('telegram',{token:TOKEN,chatId:'42'},{title:'t',message:'m'},async()=>({ok:false,status:401})),/telegram answered HTTP 401/);
});
