import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const worker = await fs.readFile(new URL('./worker.js', import.meta.url), 'utf8');
const backend = await fs.readFile(new URL('./finance_bot_backend_google_sheets.js', import.meta.url), 'utf8');
const storage = new Map();
const kv = { get: async k => storage.get(k) ?? null, put: async (k,v) => storage.set(k,v), delete: async k => storage.delete(k) };
const sent = []; const saved = []; let analyticsRows = [];
const context = vm.createContext({ console: {log(){},error(){}}, Response, Date,
  fetch: async (url, options) => {
    if (url.startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(options.body)); return new Response('{}'); }
    if (options?.method === 'POST') { saved.push(JSON.parse(options.body)); return new Response('ok'); }
    return Response.json(analyticsRows);
  }
});
vm.runInContext(worker.replace('export default', 'const worker ='), context);
const parse = (text,type) => context.parseMessage(text,type);
assert.equal(parse('100 / 108дол','transfer').receivedCurrency, '$');
assert.equal(parse('100дол / 9500руб','transfer').receivedAmount, 9500);
assert.equal(parse('100дол / 95','transfer').receivedCurrency, '€');
assert.equal(parse('100лир','transfer').receivedCurrency, '₺');
assert.equal(parse('100','transfer').receivedAmount, 100);
assert.equal(parse('12,50 продукты','expense').amount, 12.5);
assert.equal(parse('2500 зарплата','income').type, 'income');
assert.equal(parse('+40 одежда','refund').type, 'refund');
for (const text of ['0','-10','100 / 0','100 /','100 / 5abc','100xyz','Infinity']) assert.equal(parse(text,'transfer'),null,text);
const env = { KV: kv, SHEET_URL: 'sheet', TELEGRAM_TOKEN: 'test' };
const chat = 419181864;
const callback = data => context.handleCallback({id:'cb',data,message:{chat:{id:chat}}}, env);
await callback('type_transfer');
await callback('acc_cash');
await callback('acc_cash');
await context.handleRequest({method:'POST',json:async()=>({update_id:42,message:{chat:{id:chat},text:'100 / 108дол обмен'}})},env);
assert.equal(saved.length,1);
assert.equal(saved[0].fromAccount,'cash'); assert.equal(saved[0].toAccount,'cash');
assert.equal(saved[0].receivedAmount,108); assert.equal(saved[0].transactionId,'tg_42');
await callback('type_income');
assert.ok(sent.some(p=>p.reply_markup?.inline_keyboard?.flat().some(b=>b.text==='Возврат налогов')));
await callback('cat_Зарплата'); await callback('acc_cash');
await context.handleRequest({method:'POST',json:async()=>({update_id:43,message:{chat:{id:chat},text:'2500'}})},env);
assert.equal(saved[1].type,'income'); assert.equal(saved[1].fromAccount,''); assert.equal(saved[1].toAccount,'cash');
analyticsRows = [['Date','Type'],[new Date(),'expense',100,'€',100,'Еда'],[new Date(),'refund',40,'€',40,'Еда'],[new Date(),'transfer',1000,'€',1000,'Еда'],[new Date(),'income',200,'€',200,'Зарплата']];
assert.equal((await context.getAnalytics(env,7,'expense')).values[0],60);
assert.equal((await context.getAnalytics(env,7,'income')).values[0],200);
analyticsRows = [['Date','Type'],[new Date(),'refund',40,'€',40,'Одежда']];
assert.equal((await context.getAnalytics(env,7,'expense')).values[0],-40);

class Sheet {
 constructor(rows) { this.rows=rows; this.columns=9; }
 getName(){return 'Data2026';} getLastRow(){return this.rows.length;}
 getLastColumn(){return Math.max(...this.rows.map(r=>r.length),0);}
 getMaxColumns(){return this.columns;} insertColumnsAfter(n,count){this.columns+=count;}
 getDataRange(){return {getValues:()=>this.rows.map(r=>r.slice())};}
 getRange(row,col,height=1,width=1){return {
 getValues:()=>this.rows.slice(row-1,row-1+height).map(r=>Array.from({length:width},(_,i)=>r[col-1+i]??'')),
 setValue:v=>{this.rows[row-1]??=[];this.rows[row-1][col-1]=v;},
 setValues:values=>{values.forEach((r,i)=>{this.rows[row-1+i]??=[];r.forEach((v,j)=>this.rows[row-1+i][col-1+j]=v);});},
 setBackground:()=>{}
 };}
 appendRow(row){this.rows.push(row);} deleteRow(n){this.rows.splice(n-1,1);}
}
const base = ['Date','Type','Amount','Currency','Amount_EUR','Category','Description','Account','User'];
const oldRow = [new Date(), 'expense', 25, '€', 25, 'Еда', 'test', 'cash', 'Tsvetik'];
const sheet = new Sheet([base.slice(),oldRow.slice()]);
const output = value=>({text:value,setMimeType(){return this;}});
const backendContext=vm.createContext({Date,Number,JSON, console,
 SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheets:()=>[sheet],getSheetByName:()=>sheet})},
 LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
 ContentService:{createTextOutput:output,MimeType:{JSON:'json'}},Utilities:{getUuid:()=> 'uuid'}
});
vm.runInContext(backend,backendContext);
backendContext.migrateTransactionColumns(); backendContext.migrateTransactionColumns();
assert.equal(sheet.rows[0].length,14); assert.deepEqual(sheet.rows[1],oldRow);
assert.deepEqual(sheet.rows[0].slice(0,9),base);
assert.equal(new Set(sheet.rows[0]).size,14);
const transaction = saved[0];
assert.equal(backendContext.doPost({postData:{contents:JSON.stringify(transaction)}}).text,'ok');
assert.equal(backendContext.doPost({postData:{contents:JSON.stringify(transaction)}}).text,'ok');
assert.equal(sheet.rows.length,3);
assert.equal(sheet.rows[2][9],'cash');assert.equal(sheet.rows[2][10],'cash');assert.equal(sheet.rows[2][11],108);
const preview=JSON.parse(backendContext.doGet({parameter:{getLast:'Tsvetik'}}).text);
assert.equal(preview.transactionId,'tg_42');
assert.equal(JSON.parse(backendContext.doGet({parameter:{deleteLast:'Tsvetik',transactionId:'missing'}}).text).status,'not_found');
assert.equal(sheet.rows.length,3);
assert.equal(backendContext.doPost({postData:{contents:JSON.stringify(saved[1])}}).text,'ok');
assert.equal(sheet.rows.length,4);
assert.equal(JSON.parse(backendContext.doGet({parameter:{deleteLast:'Tsvetik',transactionId:'tg_42'}}).text).status,'deleted');
assert.equal(sheet.rows.length,3); assert.equal(sheet.rows[2][13],'tg_43');
assert.deepEqual(sheet.rows[1],oldRow);
console.log('All transaction tests passed');
