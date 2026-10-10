// Fintellect frontend. All calculations come from the shared engine in /engine (the same modules the
// server and the tests run). Business data is loaded from the API for the signed-in user only.
import { MN, ml, ms, msy, addM, monthEnd, POS_GROUP, sumObj, computeHistory, runwayAt, forecast as engineForecast, fcSummary, forecastWeekly, weeklyByCategory, fmtDayMonth,
  TXN_KINDS, applyTransactions, categorySection, txnNeedsCategory, txnIsIncome, txnHasDue, txnTotalsByMonth, parseTxnCsv,
  threeStatement, annualize, breakEvenActual, breakEvenForecast, valuation, modelDefaults } from "/engine/index.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
let DS = null, MONTHS = [], USER = null, KC = "", S = null, H = [], ASSIST = false;
const canWrite = () => !!USER && USER.capabilities.includes("write");
const forecast = (S_, H_, sc, hz, over) => engineForecast(DS, S_, H_, sc, hz, over);
const weekly = (sc, over) => forecastWeekly(DS.weekly, Object.assign({}, S.assumptions[sc], over || {}), { events: S.events, scenario: sc, drawings: S.global.drawings, baseCogsPct: DS.assumptions.expected.cogsPct, seasonality: S.global.seasonality });

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  let body = null;
  try { body = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(body?.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
  return body;
}

/* ---------- State ---------- */
const UI_KEY = "fintellect-ui-v1";
const DATA_KEYS = ["open", "cats", "data", "assumptions", "events", "global", "business", "txns", "model"];
function defaultUi() { return { month: MONTHS[MONTHS.length - 1], cmp: "prev", stTab: "pl", stTime: "month", stCmp: "prev", inMonth: MONTHS[MONTHS.length - 1], scenario: "expected", horizon: "w13", report: "pl", txKind: "sale", txMonth: "all", mTab: "pl", mView: "annual", mYear: 1 }; }
function sampleState() {
  return { business: clone(DS.business), open: clone(DS.open), cats: clone(DS.cats), data: clone(DS.data), assumptions: clone(DS.assumptions), global: clone(DS.global), events: clone(DS.events), txns: [], model: modelDefaults(DS.global.drawings), ui: defaultUi() };
}
function buildState(saved) {
  const s = sampleState();
  if (saved) for (const k of DATA_KEYS) if (saved[k]) s[k] = k === "business" ? { ...s.business, ...saved.business } : saved[k];
  try { const ui = JSON.parse(localStorage.getItem(UI_KEY + DS.business.id) || "null"); if (ui) s.ui = { ...s.ui, ...ui }; } catch (e) {}
  if (!MONTHS.includes(s.ui.month)) s.ui.month = MONTHS[MONTHS.length - 1];
  if (!MONTHS.includes(s.ui.inMonth)) s.ui.inMonth = MONTHS[MONTHS.length - 1];
  return s;
}
let lastSaved = "", saveTimer = null, saveStatus = "saved";
function dataSnapshot() { const o = {}; for (const k of DATA_KEYS) o[k] = S[k]; return JSON.stringify(o); }
function save() {
  try { localStorage.setItem(UI_KEY + DS.business.id, JSON.stringify(S.ui)); } catch (e) {}
  if (!canWrite()) return;
  const snap = dataSnapshot();
  if (snap === lastSaved) return;
  clearTimeout(saveTimer);
  saveStatus = "saving";
  saveTimer = setTimeout(async () => {
    try { await api(`/api/businesses/${DS.business.id}/state`, { method: "PUT", body: snap }); lastSaved = snap; saveStatus = "saved"; }
    catch (e) { saveStatus = "error"; toast(e.status === 403 ? "Your role can view these figures but not change them" : `Couldn't save: ${e.message}`); }
    const el = document.getElementById("saveState"); if (el) el.innerHTML = saveBadge();
  }, 600);
}
function saveBadge() {
  if (!canWrite()) return `<span class="badge neu">${ic("eye", 13, 2.2)}View only</span>`;
  return saveStatus === "error" ? `<span class="badge neg">Not saved</span>` : saveStatus === "saving" ? `<span class="badge neu">Saving…</span>` : `<span class="badge pos">${ic("check", 13, 2.2)}Saved</span>`;
}
// Statements include the transactions recorded on the Transactions page.
function recompute() { H = computeHistory(applyTransactions(S, MONTHS), MONTHS); }

/* ---------- Format ---------- */
const CUR="S$";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function money(v,d){if(v==null||!isFinite(v))return"—";const a=Math.abs(v),s=v<0?"−":"";
  if(a>=1e6)return s+CUR+(a/1e6).toFixed(d??2)+"M";
  if(a>=1e3)return s+CUR+(a/1e3).toFixed(d??1)+"K";return s+CUR+a.toFixed(0);}
const full=v=>v==null||!isFinite(v)?"—":(v<0?"(":"")+Math.round(Math.abs(v)).toLocaleString("en-US")+(v<0?")":"");
const grp=v=>Math.round(v||0).toLocaleString("en-US");
const pct=(v,d=1)=>v==null||!isFinite(v)?"—":(v*100).toFixed(d)+"%";
const sgnPct=(v,d=1)=>v==null||!isFinite(v)?"—":(v>0?"+":v<0?"−":"")+Math.abs(v*100).toFixed(d)+"%";
const chg=(a,b)=>b?((a-b)/Math.abs(b)):null;
function axisM(v){const a=Math.abs(v),s=v<0?"−":"";if(a===0)return"0";if(a>=1e6)return s+(a/1e6).toFixed(a%1e6?1:0)+"M";if(a>=1e3)return s+(a/1e3).toFixed(a%1e3?1:0)+"K";return s+a.toFixed(0);}
const fmtMonths=m=>!isFinite(m)?"—":m>=100?"99+":m.toFixed(1);
const SC={worst:{name:"Worst",color:"--neg"},expected:{name:"Expected",color:"--fc"},best:{name:"Best",color:"--pos"}};
const fmtDate=s=>{const d=new Date(s+"T00:00:00Z");return d.getUTCDate()+" "+MN[d.getUTCMonth()]+" "+d.getUTCFullYear();};

/* ---------- Icons ---------- */
const P=d=>`<path d="${d}"/>`;
const ICONS={
  dashboard:'<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  statements:P("M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z")+P("M14 2v4a2 2 0 0 0 2 2h4")+P("M16 13H8M16 17H8M10 9H8"),
  input:P("M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7")+P("M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z"),
  forecast:P("M22 7 13.5 15.5 8.5 10.5 2 17")+P("M16 7h6v6"),
  sliders:P("M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"),
  download:P("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4")+P("M7 10l5 5 5-5M12 15V3"),
  settings:'<circle cx="12" cy="12" r="3"/>'+P("M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"),
  book:P("M12 7v14")+P("M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"),
  info:'<circle cx="12" cy="12" r="10"/>'+P("M12 16v-4M12 8h.01"),
  up:P("M7 17 17 7M7 7h10v10"),down:P("m7 7 10 10M17 7v10H7"),
  alert:P("m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3")+P("M12 9v4M12 17h.01"),
  check:'<circle cx="12" cy="12" r="10"/>'+P("m9 12 2 2 4-4"),
  wallet:P("M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1")+P("M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"),
  hourglass:P("M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"),
  chart:P("M3 3v16a2 2 0 0 0 2 2h16")+P("M18 17V9M13 17V5M8 17v-3"),
  coins:'<circle cx="8" cy="8" r="6"/>'+P("M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"),
  plus:P("M5 12h14M12 5v14"),trash:P("M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"),
  left:P("m15 18-6-6 6-6"),right:P("m9 18 6-6-6-6"),menu:P("M4 6h16M4 12h16M4 18h16"),
  copy:'<rect x="9" y="9" width="13" height="13" rx="2"/>'+P("M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"),
  eye:P("M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z")+'<circle cx="12" cy="12" r="3"/>',
  clock:'<circle cx="12" cy="12" r="10"/>'+P("M12 6v6l4 2"),
  shield:P("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z")+P("M12 8v4M12 16h.01"),
  reset:P("M3 12a9 9 0 1 0 3-6.7L3 8")+P("M3 3v5h5"),
  receipt:P("M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z")+P("M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 17.5v-11"),
  model:'<rect x="3" y="3" width="18" height="18" rx="2"/>'+P("M3 9h18M3 15h18M9 3v18"),
  chat:P("M7.9 20A9 9 0 1 0 4 16.1L2 22Z")+P("M8 12h.01M12 12h.01M16 12h.01"),
  upload:P("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4")+P("M17 8l-5-5-5 5M12 3v12"),
  send:P("m22 2-7 20-4-9-9-4Z")+P("M22 2 11 13")
};
const ic=(n,s=18,sw=1.8)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]||""}</svg>`;

/* ---------- Glossary ---------- */
const G={
  revenue:["Revenue","What customers paid for what you sold in the period, excluding GST. Café sales come from the POS; catering and wholesale come from invoices, counted when issued.","Revenue = café (POS) sales + B2B invoices, net of GST"],
  cogs:["Cost of goods sold (COGS)","The direct cost of what you sold: flour, produce, coffee beans, dairy and packaging, adjusted for the change in stock on hand.","COGS = purchases − increase in inventory"],
  gross:["Gross profit","What's left of revenue after paying for the goods you sold.","Gross profit = Revenue − COGS"],
  gm:["Gross margin","Percentage of revenue remaining after the cost of goods sold. Bakeries and cafés commonly run 60–70%.","Gross margin = Gross profit ÷ Revenue × 100"],
  opex:["Operating expenses","Costs of running the business that aren't tied to each sale: staff, CPF, rent, utilities, marketing, software, repairs.",""],
  ebitda:["EBITDA","Earnings before interest, tax, depreciation and amortisation: profit from running the business before financing, tax and non-cash equipment costs. Lenders and buyers often use it to compare businesses.","EBITDA = Operating profit + Depreciation"],
  op:["Operating profit","Profit from running the business, before loan interest and tax.","Operating profit = Gross profit − Operating expenses"],
  om:["Operating margin","Operating profit as a share of revenue.","Operating margin = Operating profit ÷ Revenue × 100"],
  np:["Net profit","What the business earned after every cost, interest and tax.","Net profit = Operating profit − Interest − Taxes"],
  nm:["Net margin","How many dollars of profit you keep from every S$100 of sales.","Net margin = Net profit ÷ Revenue × 100"],
  cash:["Cash on hand","The balance of the operating bank account at month end. It matches the bank statement. Profit and cash differ: unpaid invoices, GST collected but not yet paid, and equipment purchases all move cash without matching profit.",""],
  runway:["Cash runway","Estimated number of months the business can keep operating with available cash at the current cash burn. If cash is growing, the business isn't burning cash.","Cash runway = Cash ÷ Average monthly cash burn (last 3 months)"],
  buffer:["Minimum cash buffer","The owner's policy for the lowest comfortable bank balance: about one month of payroll plus rent. Dropping below it isn't a crisis but leaves little room for surprises.","Set to S$30,000 in the dataset"],
  ocf:["Operating cash flow","Cash generated by daily operations. It starts from net profit, adds back non-cash costs like depreciation, and adjusts for money tied up in unpaid invoices and stock, and for bills, GST and CPF not yet paid.","Technical name: cash flow from operating activities"],
  icf:["Cash from investments","Cash spent on or received from long-term assets like ovens, grinders or fit-out.","Technical name: investing activities"],
  fcf:["Cash from financing","Cash from loans and the owner: loan repayments, new loans, money the owner puts in or takes out.","Technical name: financing activities"],
  cr:["Current ratio","Measures the ability to cover short-term debts with short-term assets. Above 1.5× is usually comfortable.","Current ratio = Current assets ÷ Current liabilities"],
  dr:["Debt ratio","Share of everything the business owns that is financed by debt or unpaid bills.","Debt ratio = Total liabilities ÷ Total assets"],
  ar:["Accounts receivable","Invoices issued to catering and wholesale customers that haven't been paid yet, including GST.",""],
  late:["Days late","How many days after the due date a customer actually paid. Averaged over each customer's paid invoices.","Days late = payment date − due date"],
  inv:["Inventory","Stock on hand at cost: flour, sugar, dairy, coffee beans and packaging, from the month-end stock count.",""],
  ap:["Accounts payable","Supplier bills you haven't paid yet, including GST.",""],
  oca:["Settlements in transit & prepayments","Card takings not yet settled by the bank, cash waiting for the Monday deposit, prepaid insurance, and money a supplier owes back after a double payment.",""],
  ocl:["GST, CPF & tax payable","GST collected but not yet paid to IRAS, CPF due to the CPF Board next month, corporate tax accrued, and small accruals.",""],
  dep:["Depreciation","Spreading the cost of equipment over its useful life. It reduces profit each month but no cash leaves the business.","Straight-line over each asset's useful life"],
  re:["Retained earnings","All profit the business has earned and kept since it started.",""],
  draw:["Owner drawings","Money the owner takes out of the business for personal use. Not an expense, so it reduces equity and cash but not profit.",""],
  equity:["Equity","What the business is worth to the owner on paper.","Equity = Assets − Liabilities"],
  roe:["Return on equity (ROE)","Measures how effectively the business generates profit from owner equity.","ROE = Net profit ÷ Equity"],
  bs:["Accounting equation","Everything the business owns is funded either by debt or by the owner. The balance sheet must always balance.","Assets = Liabilities + Equity"],
  gst:["GST","Singapore's 9% Goods and Services Tax. You collect it on sales, reclaim it on purchases, and pay the difference to IRAS one month after each quarter ends.",""],
  cpf:["CPF","Central Provident Fund. The employer adds 17% on top of salary (simplified) and pays it with the employee's 20% share by the 14th of the following month.",""],
  cit:["Corporate income tax","Tax on the company's yearly profit, paid once a year after assessment. This app accrues an estimate each month so profit isn't overstated.",""],
  loan:["Term loan","A 5-year equipment and fit-out loan at 4.8% fixed. Each monthly instalment pays interest plus part of the balance.",""],
  scenario:["Scenarios","One financial model run with three sets of assumptions. Worst is cautious, Expected is most realistic, Best is optimistic.",""],
  seas:["Seasonality","Some months are always busier. With seasonality on, the forecast repeats the pattern of your last 12 months: the December peak, the Chinese New Year dip in February and a softer June.",""],
  burn:["Cash burn","How much cash the business loses per month from operations, loan repayments and owner drawings. One-off purchases and new loans are left out.",""]
};
const info=(k,label)=>`<button class="info" data-term="${k}" aria-label="What is ${esc(label||G[k][0])}?">${ic("info",14,2)}</button>`;

/* ---------- Charts ---------- */
const CHARTS=[];
function niceStep(r){const p=Math.pow(10,Math.floor(Math.log10(r||1))),f=r/p;return(f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p;}
function drawChart(host,c){
  const W=Math.max(260,Math.floor(host.clientWidth)),Ht=c.h||230,pl=c.padL||46,pr=10,pt=c.split!=null?24:12,pb=26;
  const n=c.labels.length,iw=W-pl-pr,ih=Ht-pt-pb;
  const all=[];c.series.forEach(s=>s.values.forEach(v=>{if(v!=null&&isFinite(v))all.push(v);}));
  if(c.band){c.band.lo.forEach(v=>v!=null&&all.push(v));c.band.hi.forEach(v=>v!=null&&all.push(v));}
  if(c.refLine)all.push(c.refLine.v);
  let lo=c.zero===false?Math.min(...all):Math.min(0,...all),hi=Math.max(...all,1);
  if(c.zero===false){const pad=(hi-lo)*.1;lo-=pad;}
  const step=niceStep((hi-lo)/4);lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;if(hi<=lo)hi=lo+step;
  const X=i=>pl+iw*(i+.5)/n,Y=v=>pt+ih*(1-(v-lo)/(hi-lo));
  let s=`<svg width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}" role="img" aria-label="${esc(c.title||"Chart")}">`;
  if(c.split!=null){const x=pl+iw*c.split/n;s+=`<rect x="${x}" y="${pt}" width="${W-pr-x}" height="${ih}" fill="var(--fc-soft)" opacity=".45"/><line x1="${x}" x2="${x}" y1="${pt-14}" y2="${pt+ih}" stroke="var(--axis)" stroke-dasharray="3 3"/><text x="${x-8}" y="${pt-6}" text-anchor="end" class="ax">Actual</text><text x="${x+8}" y="${pt-6}" class="ax" style="fill:var(--fc)">Forecast</text>`;}
  if(lo<0)s+=`<rect x="${pl}" y="${Y(0)}" width="${iw}" height="${pt+ih-Y(0)}" fill="var(--neg-soft)" opacity=".8"/>`;
  for(let v=lo;v<=hi+step/2;v+=step){const y=Y(v),z=Math.abs(v)<step/1e3;s+=`<line x1="${pl}" x2="${W-pr}" y1="${y}" y2="${y}" stroke="var(${z?"--axis":"--grid"})"/><text x="${pl-8}" y="${y+4}" text-anchor="end" class="ax">${(c.yFmt||axisM)(z?0:v)}</text>`;}
  if(c.band){let up=[],dn=[];c.band.hi.forEach((v,i)=>{if(v!=null)up.push([X(i),Y(v)]);});c.band.lo.forEach((v,i)=>{if(v!=null)dn.push([X(i),Y(v)]);});
    if(up.length>1)s+=`<path d="M${up.map(p=>p.join(",")).join("L")}L${dn.reverse().map(p=>p.join(",")).join("L")}Z" fill="var(${c.band.color||"--fc"})" opacity=".1"/>`;}
  if(c.refLine){const y=Y(c.refLine.v);s+=`<line x1="${pl}" x2="${W-pr}" y1="${y}" y2="${y}" stroke="var(--gold)" stroke-width="1.5" stroke-dasharray="6 4"/><text x="${pl+6}" y="${y-5}" class="ax" style="fill:var(--gold);font-weight:600">${esc(c.refLine.label)}</text>`;}
  const bars=c.series.filter(x=>x.type==="bar");
  if(bars.length){const gw=Math.min(40,iw/n*.7),bw=Math.max(2,gw/bars.length-(bars.length>1?2:0));
    bars.forEach((b,bi)=>b.values.forEach((v,i)=>{if(v==null)return;const x=X(i)-gw/2+bi*(gw/bars.length),y0=Y(Math.max(lo,0)),y1=Y(v);
      const col=b.colorAt?b.colorAt(i,v):b.negColor&&v<0?b.negColor:b.color;
      s+=`<rect x="${x.toFixed(1)}" y="${Math.min(y0,y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1,Math.abs(y1-y0)).toFixed(1)}" rx="${Math.min(3,bw/3)}" fill="var(${col})"/>`;
      if(b.labels)s+=`<text x="${(x+bw/2).toFixed(1)}" y="${(Math.min(y0,y1)-6).toFixed(1)}" text-anchor="middle" class="ax strong">${esc(b.labels(v))}</text>`;}));}
  c.series.filter(x=>x.type!=="bar").forEach(l=>{
    const pts=[];l.values.forEach((v,i)=>{if(v!=null&&isFinite(v))pts.push([X(i),Y(v),i]);});
    if(!pts.length)return;const d="M"+pts.map(p=>p[0].toFixed(1)+","+p[1].toFixed(1)).join("L");
    if(l.area&&pts.length>1){const by=Y(Math.max(lo,0));s+=`<path d="${d}L${pts[pts.length-1][0]},${by}L${pts[0][0]},${by}Z" fill="var(${l.color})" opacity=".12"/>`;}
    s+=`<path d="${d}" fill="none" stroke="var(${l.color})" stroke-width="${l.width||2.25}" stroke-linejoin="round" stroke-linecap="round" ${l.dash?'stroke-dasharray="5 4"':""}/>`;
    if(l.dot!==false){const e=pts[pts.length-1];s+=`<circle cx="${e[0]}" cy="${e[1]}" r="4" fill="var(--surface)" stroke="var(${l.color})" stroke-width="2.25"/>`;}
    if(l.negDots){pts.forEach(p=>{if(l.values[p[2]]<0)s+=`<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="var(--neg)"/>`;});}
  });
  if(c.markers)c.markers.forEach(m=>{const x=X(m.i);s+=`<line x1="${x}" x2="${x}" y1="${pt}" y2="${pt+ih}" stroke="var(--gold)" stroke-dasharray="2 3" opacity=".7"/><path d="M${x-5},${pt+ih} L${x},${pt+ih-7} L${x+5},${pt+ih}Z" fill="var(--gold)"/>`;});
  const every=Math.max(1,Math.ceil(n/Math.max(1,Math.floor(iw/46))));
  c.labels.forEach((lb,i)=>{if((n-1-i)%every!==0)return;s+=`<text x="${X(i)}" y="${Ht-6}" text-anchor="middle" class="ax${i===c.hl?" strong":""}">${esc(lb)}</text>`;});
  for(let i=0;i<n;i++)s+=`<rect class="hit" data-i="${i}" x="${(pl+iw*i/n).toFixed(1)}" y="${pt}" width="${(iw/n).toFixed(1)}" height="${ih}"/>`;
  host.innerHTML=s+"</svg>";host._cfg=c;
}
function drawAll(){CHARTS.forEach(({id,cfg})=>{const el=document.getElementById(id);if(el)drawChart(el,cfg);});}
function spark(vals,color){const mn=Math.min(...vals),mx=Math.max(...vals),r=mx-mn||1;
  const pts=vals.map((v,i)=>`${(i/(vals.length-1)*100).toFixed(2)},${(27-(v-mn)/r*24).toFixed(2)}`);
  return`<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="M${pts.join("L")}L100,30L0,30Z" fill="var(${color})" opacity=".1"/><path d="M${pts.join("L")}" fill="none" stroke="var(${color})" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;}
function donut(segs,center,sub){const r=62,C=2*Math.PI*r,tot=segs.reduce((a,s)=>a+Math.max(0,s.v),0)||1;let off=0,s="";
  segs.forEach(g=>{const v=Math.max(0,g.v),len=v/tot*C,gap=segs.length>1?2:0;s+=`<circle cx="80" cy="80" r="${r}" fill="none" stroke="var(${g.c})" stroke-width="20" stroke-dasharray="${Math.max(0,len-gap)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 80 80)"><title>${esc(g.n)}: ${(v/tot*100).toFixed(1)}%</title></circle>`;off+=len;});
  return`<svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="Expense breakdown">${s}<text x="80" y="78" text-anchor="middle" style="font-size:16px;font-weight:700;fill:var(--text)">${esc(center)}</text><text x="80" y="96" text-anchor="middle" class="ax">${esc(sub)}</text></svg>`;}

/* ---------- UI helpers ---------- */
function badge(tone,text,icon){return`<span class="badge ${tone}">${icon?ic(icon,13,2.2):""}${esc(text)}</span>`;}
function delta(cur,prev,goodUp=true){
  const c=chg(cur,prev);if(c==null||!isFinite(c))return"";
  const up=c>=0,good=up===goodUp;const tone=Math.abs(c)<.005?"neu":good?"pos":"neg";
  return badge(tone,sgnPct(c),up?"up":"down");}
function status(tone){return{pos:"Healthy",warn:"Watch",neg:"Attention"}[tone];}
function selectBox(id,opts,val,label){return`<label class="select"><select id="${id}" aria-label="${esc(label)}">${opts.map(([v,t])=>`<option value="${esc(v)}"${String(v)===String(val)?" selected":""}>${esc(t)}</option>`).join("")}</select></label>`;}
function segBtns(name,opts,val){return`<div class="seg" role="group">${opts.map(([v,t,dot])=>`<button data-seg="${name}" data-v="${v}" aria-pressed="${String(v)===String(val)}">${dot?`<i class="dot" style="background:var(${dot})"></i>`:""}${esc(t)}</button>`).join("")}</div>`;}
function toast(t){const d=document.createElement("div");d.className="toast";d.textContent=t;document.body.appendChild(d);setTimeout(()=>d.remove(),2400);}
function copyText(t,label){const done=()=>toast(label+" copied");
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,()=>fallback());}else fallback();
  function fallback(){const ta=document.getElementById("csvOut");if(ta){ta.value=t;ta.hidden=false;ta.focus();ta.select();toast("Select all and copy the text below");}}
}
const alertRow=a=>`<div class="alert ${a[0]==="info"?"tinfo":a[0]}"><span class="ic">${ic(a[0]==="pos"?"check":a[0]==="info"?"info":a[3]||"alert",18)}</span><div><b>${esc(a[1])}</b><span>${esc(a[2])}</span></div></div>`;

/* ---------- Shell ---------- */
const NAV=[["OVERVIEW",[["dashboard","Dashboard","dashboard"],["assistant","Ask AI","chat"]]],["FINANCIALS",[["statements","Statements","statements"],["transactions","Transactions","receipt"],["input","Input data","input"]]],["FORECAST",[["assumptions","Assumptions","sliders"],["forecast","Forecast","forecast"],["model","Financial model","model"]]],["REPORTS",[["reports","Reports & export","download"]]]];
const PAGES={
  dashboard:["Financial health","How is my business doing right now?"],
  statements:["Financial statements","What happened? Profit & loss, cash flow and balance sheet, calculated from your records."],
  input:["Input data","Monthly figures built from POS, invoices, bills and payroll. Edit any month; everything else recalculates."],
  assumptions:["Forecast assumptions","What do you expect to change? One model, three scenarios."],
  forecast:["Forecast","What could happen to my cash over the next 1–3 years?"],
  reports:["Reports & export","Share your numbers with your accountant, bank or a lender."],
  setup:["Business setup","Business profile and the opening balance sheet."],
  glossary:["Glossary","Plain-language explanations of every metric in the app."],
  transactions:["Transactions","Record sales, invoices, expenses and bills one by one. Each one adds to that month's figures, statements and forecast."],
  model:["Financial model","Projected profit & loss, cash flow and balance sheet, break-even point and an estimate of what the business is worth."],
  assistant:["Ask AI","Ask questions about your figures, statements and forecast in plain language."],
  activity:["Activity log","Sign-ins, saved changes and refused requests for this business. Visible to the owner only."]
};
let route="dashboard";
const ROLE_NAMES={owner:"Owner",finance_admin:"Finance admin",accountant:"Accountant (read only)",agent:"AI agent (read & draft)"};
function renderSide(){
  const b=S.business,ini=b.name.split(/\s+/).filter(w=>/^[A-Za-z]/.test(w)).map(w=>w[0]).join("").slice(0,2).toUpperCase()||"—";
  const link=(id,label,icon)=>`<a class="nav" href="#${id}" data-route="${id}"${route===id?' aria-current="page"':""}>${ic(icon,19)}<span>${label}</span></a>`;
  document.getElementById("side").innerHTML=`
  <div class="brand"><span class="mark">${ic("chart",18,2).replace('stroke="currentColor"','stroke="#fff"')}</span>Fintellect</div>
  <a class="biz" href="#setup" data-route="setup" style="text-decoration:none;color:inherit"><span class="av">${esc(ini)}</span><div><b>${esc(b.name)}</b><small>${esc(b.country)} · S$ · FY ${MN[b.fyStart-1]}</small></div></a>
  ${(DS.limited?[["OVERVIEW",[["dashboard","Dashboard","dashboard"]]]]:NAV).map(([sec,items])=>`<div class="sec">${sec}</div>${items.map(i=>link(...i)).join("")}`).join("")}
  <div class="grow"></div>
  <div class="acct"><div class="who"><b>${esc(USER.name)}</b><small>${esc(ROLE_NAMES[USER.role]||USER.role)} · ${esc(DS.business.id)}</small></div><span id="saveState">${saveBadge()}</span></div>
  <div class="sample"><b>Sample dataset.</b> ${esc(DS.business.name)} is fictional. Figures come from its POS, invoices, bills, payroll and bank records up to ${fmtDate(DS.asof)}. <button class="linkbtn" data-act="resetAsk">Reset to dataset</button></div>
  ${USER.capabilities.includes("audit")?link("activity","Activity log","shield"):""}${link("glossary","Glossary","book")}${link("setup","Settings","settings")}<button class="nav" data-act="logout" style="background:none;border:0;width:100%;text-align:left">${ic("left",19)}<span>Sign out</span></button>`;
}
function topbar(ctrls){const[t,p]=PAGES[route];
  return`<header class="top"><button class="menu" data-act="menu" aria-label="Open menu">${ic("menu",20)}</button><div class="titles"><h1>${t}</h1><p>${p}</p></div>${ctrls?`<div class="ctl">${ctrls}</div>`:""}</header>`;}
const monthOpts=()=>MONTHS.slice().reverse().map(k=>[k,ml(k)]);

/* ---------- Dashboard ---------- */
const HV=()=>DS.customers.find(c=>c.id===DS.keyCustomer.id);
function vDashboard(){
  if(DS.limited)return vLimited();
  const i=MONTHS.indexOf(S.ui.month),h=H[i];
  const j=S.ui.cmp==="yoy"?i-12:i-1,p=j>=0?H[j]:null;
  const cmpLabel=p?"vs "+ml(p.k):S.ui.cmp==="yoy"?"No data a year earlier":"First month of data";
  const rw=runwayAt(H,i),buf=S.global.minBuffer;
  const last12=H.slice(Math.max(0,i-11),i+1);
  const kpi=(icon,label,term,value,deltaHtml,cap,sparkVals,col)=>`<div class="card kpi"><div class="kpi-h"><span class="chip-ic">${ic(icon,18)}</span><span class="l">${label}</span>${info(term)}</div><div class="kpi-v num">${value}</div><div class="kpi-f">${deltaHtml}<span>${cap}</span></div>${sparkVals?spark(sparkVals,col):""}</div>`;
  const runwayVal=isFinite(rw.months)?`${fmtMonths(rw.months)} <small>months</small>`:`Cash-positive`;
  const runwayTone=!isFinite(rw.months)||rw.months>=6?"pos":rw.months>=3?"warn":"neg";
  const ctrls=selectBox("dashMonth",monthOpts(),S.ui.month,"Period")+selectBox("dashCmp",[["prev","vs previous month"],["yoy","vs same month last year"]],S.ui.cmp,"Compare with");
  const ind=[
    ["Gross margin","gm",pct(h.gm),h.gm>=.6?"pos":h.gm>=.5?"warn":"neg",p?`${sgnPt(h.gm-p.gm)} vs ${ms(p.k)}`:"Revenue left after COGS"],
    ["Net margin","nm",pct(h.nm),h.nm>=.08?"pos":h.nm>=0?"warn":"neg",`Keep S$${(h.nm*100).toFixed(0)} of every S$100 sold`],
    ["Operating cash flow","ocf",money(h.cfo),h.cfo>0?"pos":"neg","Cash from daily operations"],
    ["Current ratio","cr",isFinite(h.cr)?h.cr.toFixed(2)+"×":"—",h.cr>=1.5?"pos":h.cr>=1?"warn":"neg","Short-term assets ÷ short-term debts"],
    ["Debt ratio","dr",pct(h.dr,0),h.dr<=.5?"pos":h.dr<=.7?"warn":"neg",p?(Math.abs(h.dr-p.dr)>=.03?`${h.dr>p.dr?"Up":"Down"} from ${pct(p.dr,0)} in ${ms(p.k)}`:`Steady vs ${ms(p.k)}`):"Liabilities ÷ assets"],
    ["Cash vs buffer","buffer",money(h.cash-buf),h.cash>=buf*1.5?"pos":h.cash>=buf?"warn":"neg",`Above the ${money(buf,0)} minimum`.replace("Above",h.cash>=buf?"Above":"Short of")]
  ];
  const ob=h.opexCat,staff=(ob.sal||0)+(ob.cpf||0),segs=[
    {n:"COGS",v:h.cogs,c:"--brand"},{n:"Staff & CPF",v:staff,c:"--fc"},{n:"Rent",v:ob.rent||0,c:"--gold"},{n:"Marketing",v:ob.mkt||0,c:"--exp"},{n:"Repairs",v:ob.repairs||0,c:"--warn"},
    {n:"Other",v:h.opex-staff-(ob.rent||0)-(ob.mkt||0)-(ob.repairs||0)+h.interest+h.tax,c:"--neutral"}];
  const totExp=segs.reduce((a,s)=>a+s.v,0);
  CHARTS.length=0;
  const tk=last12.map(x=>ml(x.k));
  CHARTS.push({id:"chRevExp",cfg:{title:"Revenue vs expenses",h:250,labels:last12.map(x=>ms(x.k)),hl:last12.length-1,series:[
    {name:"Revenue",type:"bar",color:"--brand",values:last12.map(x=>x.rev)},
    {name:"Expenses",type:"bar",color:"--exp",values:last12.map(x=>x.cogs+x.opex+x.interest+x.tax)},
    {name:"Net profit",color:"--text",values:last12.map(x=>x.np),width:2}],tipKeys:tk}});
  CHARTS.push({id:"chCash",cfg:{title:"Cash balance",h:230,labels:last12.map(x=>ms(x.k)),hl:last12.length-1,refLine:{v:buf,label:"Min. buffer "+money(buf,0)},series:[
    {name:"Opening cash",color:"--neutral",values:last12.map(x=>x.openCash),dash:true,dot:false,width:1.6},
    {name:"Closing cash",color:"--brand",area:true,values:last12.map(x=>x.cash)}],tipKeys:tk}});
  CHARTS.push({id:"chMargins",cfg:{title:"Margins",h:200,zero:false,yFmt:v=>(v*100).toFixed(0)+"%",labels:last12.map(x=>ms(x.k)),hl:last12.length-1,series:[
    {name:"Gross margin",color:"--brand",values:last12.map(x=>x.gm)},{name:"Operating margin",color:"--fc",values:last12.map(x=>x.om)},{name:"Net margin",color:"--exp",values:last12.map(x=>x.nm)}],fmt:v=>pct(v),tipKeys:tk}});
  const hv=HV();
  CHARTS.push({id:"chLate",cfg:{title:`${KC} days late`,h:200,labels:hv.trend.map(t=>"Q"+t[0].slice(5)+" '"+t[0].slice(2,4)),hl:hv.trend.length-1,yFmt:v=>v.toFixed(0)+"d",
    series:[{name:"Avg days late",type:"bar",colorAt:(i,v)=>v>=30?"--neg":v>=15?"--warn":"--neutral",values:hv.trend.map(t=>t[1]),labels:v=>v.toFixed(0)+"d"}],fmt:v=>v.toFixed(1)+" days"}});
  const cf=[["Operations","Daily business",h.cfo,"ocf"],["Investments","Equipment & assets",h.cfi,"icf"],["Financing","Loan & owner",h.cff,"fcf"]];
  const cfMax=Math.max(...cf.map(x=>Math.abs(x[2])),1);
  const custs=DS.customers.slice().sort((a,b)=>b.outstanding-a.outstanding),arTot=custs.reduce((a,c)=>a+c.outstanding,0),arOver=custs.reduce((a,c)=>a+c.overdue,0);
  const isLatest=i===MONTHS.length-1;
  return topbar(ctrls)+`<div class="stack">
  <section class="grid g4" aria-label="Key figures">
    ${kpi("wallet","Cash on hand","cash",money(h.cash),p?delta(h.cash,p.cash):"",cmpLabel,last12.map(x=>x.cash),"--brand")}
    ${kpi("chart","Revenue","revenue",money(h.rev),p?delta(h.rev,p.rev):"",`${pct(h.rev?h.pos/h.rev:0,0)} café · ${pct(h.rev?h.b2b/h.rev:0,0)} B2B`,last12.map(x=>x.rev),"--brand")}
    ${kpi("coins","Net profit","np",money(h.np),p?delta(h.np,p.np):"",`${pct(h.nm)} margin`,last12.map(x=>x.np),h.np>=0?"--brand":"--neg")}
    ${kpi("hourglass","Cash runway","runway",runwayVal,badge(runwayTone,isFinite(rw.months)?status(runwayTone):"Not burning cash",runwayTone==="pos"?"check":"alert"),isFinite(rw.months)?`at ${money(rw.burn)}/mo burn`:`+${money(-rw.burn)}/mo avg, last 3 months`,null)}
  </section>
  <section class="card" aria-label="Financial health indicators">
    <div class="card-h"><div class="t"><h2>Financial health indicators</h2><p>${ml(h.k)} · Indicators describe your numbers; they aren't financial advice</p></div></div>
    <div class="health">${ind.map(([l,t,v,tone,hint])=>`<div class="hi"><span class="lab">${l}${info(t)}</span><span class="val num">${v}${badge(tone,status(tone))}</span><span class="hint">${esc(hint)}</span></div>`).join("")}</div>
  </section>
  <div class="split eq">
    <section class="card"><div class="card-h"><div class="t"><h2>Revenue vs expenses</h2><p>Last 12 months · expenses include COGS, operating costs, interest and tax</p></div>
      <div class="legend"><span><i class="sw" style="background:var(--brand)"></i>Revenue</span><span><i class="sw" style="background:var(--exp)"></i>Expenses</span><span><i class="sw ln" style="background:var(--text)"></i>Net profit</span></div></div>
      <div class="chart" id="chRevExp"></div></section>
    <section class="card"><div class="card-h"><div class="t"><h2>Expense breakdown</h2><p>${ml(h.k)} · ${money(totExp)} total</p></div></div>
      <div class="donut-wrap">${donut(segs,money(totExp),"spent")}
      <div class="blist">${segs.map(g=>`<div class="brow"><i class="sw" style="background:var(${g.c})"></i><span class="nm">${g.n}</span><span class="am num">${money(g.v)}</span><span class="pc num">${(g.v/totExp*100).toFixed(0)}%</span></div>`).join("")}</div></div></section>
  </div>
  <div class="split eq">
    <section class="card"><div class="card-h"><div class="t"><h2>Cash balance${info("cash")}</h2><p>Month-end bank balance, matched to the statement · dashed gold line is the minimum buffer</p></div>
      <div class="legend"><span><i class="sw ln" style="background:var(--brand)"></i>Closing cash</span><span style="color:var(--neutral)"><i class="sw dash"></i><span style="color:var(--text-2)">Opening cash</span></span></div></div>
      <div class="chart" id="chCash"></div>
      <p class="note" style="margin:8px 0 0">The lowest daily balance in the bank statement was ${money(DS.bankLow.amount)} on ${fmtDate(DS.bankLow.date)}.</p></section>
    <section class="card"><div class="card-h"><div class="t"><h2>Financial alerts</h2><p>${p?"What changed "+cmpLabel:"This month"}</p></div></div>
      <div class="alerts">${dashAlerts(h,p,rw,isLatest).map(alertRow).join("")}</div></section>
  </div>
  <div class="split eq">
    <section class="card"><div class="card-h"><div class="t"><h2>Who owes you${info("ar")}</h2><p>Open invoices at ${fmtDate(DS.asof)} · ${money(arTot)} outstanding, ${money(arOver)} overdue</p></div></div>
      <div class="tw"><table><thead><tr><th>Customer</th><th class="n">Outstanding</th><th class="n">Overdue</th><th class="n">Days late ${info("late")}</th><th>Credit used</th></tr></thead><tbody>
      ${custs.map(c=>{const used=c.outstanding/c.limit,up=c.avgLatePrior6!=null&&c.avgLate6!=null&&c.avgLate6>c.avgLatePrior6*1.5&&c.avgLate6>5;
        return`<tr><td><span class="cn">${esc(c.name.replace(/ Pte Ltd$/,""))}</span><span class="cs">${esc(c.segment)} · ${c.terms}-day terms</span></td><td class="n">${full(c.outstanding)}</td><td class="n ${c.overdue>0?"up-bad":"muted"}">${c.overdue>0?full(c.overdue):"—"}</td>
        <td class="n">${c.avgLate6==null?"—":Math.max(0,c.avgLate6).toFixed(0)+"d"}${up?" "+badge("neg","from "+c.avgLatePrior6.toFixed(0)+"d","up"):""}</td>
        <td><div style="display:flex;align-items:center;gap:8px"><span class="meter" style="flex:1"><i style="width:${Math.min(100,used*100)}%;background:var(${used>.9?"--neg":used>.6?"--warn":"--brand"})"></i></span><span class="num" style="font-size:12px;color:var(--text-3)">${pct(used,0)}</span></div></td></tr>`;}).join("")}
      </tbody></table></div>
      <p class="note" style="margin:10px 0 0">Days late is the average for each customer's last 6 paid invoices.</p></section>
    <section class="card"><div class="card-h"><div class="t"><h2>${KC} is paying later</h2><p>Average days past due, by quarter the invoice fell due</p></div></div>
      <div class="chart" id="chLate"></div>
      <p class="note" style="margin:8px 0 0">${money(hv.outstanding)} is outstanding from ${KC}, about ${pct(DS.hvShare,0)} of B2B sales. ${money(hv.overdue)} is ${hv.oldestOverdueDays} days overdue.</p></section>
  </div>
  <div class="split eq">
    <section class="card"><div class="card-h"><div class="t"><h2>Profitability</h2><p>Gross, operating and net margin · last 12 months</p></div>
      <div class="legend"><span><i class="sw ln" style="background:var(--brand)"></i>Gross</span><span><i class="sw ln" style="background:var(--fc)"></i>Operating</span><span><i class="sw ln" style="background:var(--exp)"></i>Net</span></div></div>
      <div class="chart" id="chMargins"></div>
      <p class="note" style="margin:8px 0 0">${DS.bonusMonths.map(b=>`${ml(b.k)} includes year-end bonuses of ${money(b.amount)}.`).join(" ")}</p></section>
    <section class="card"><div class="card-h"><div class="t"><h2>Where cash came from</h2><p>${ml(h.k)} · net change ${money(h.cash-h.openCash)}</p></div></div>
      <div class="cfbars">${cf.map(([l,sub,v,t])=>{const w=Math.abs(v)/cfMax*50;return`<div class="cfrow"><span class="lab">${l} ${info(t)}<small>${sub}</small></span><span class="bar"><i style="${v>=0?`left:50%;width:${w}%`:`left:${50-w}%;width:${w}%`};background:var(${v>=0?"--pos":"--neg"})"></i><span class="mid"></span></span><span class="v num ${v>=0?"up-good":"up-bad"}">${v>=0?"+":""}${money(v)}</span></div>`;}).join("")}
      <div class="sumrow" style="margin-top:6px;border-top:1px solid var(--border);padding-top:12px"><span>Opening cash ${ml(h.k)}</span><b class="num">${money(h.openCash)}</b></div>
      <div class="sumrow"><span>Closing cash</span><b class="num">${money(h.cash)}</b></div></div></section>
  </div>
  <section class="card"><div class="card-h"><div class="t"><h2>Bookkeeping checks${""}</h2><p>Found while building these figures from your bills and payments. Worth sorting out before paying anything this week.</p></div>${badge("warn",DS.checks.length+" to review","shield")}</div>
    <div class="alerts">${DS.checks.map(c=>alertRow(["warn",{dup_bill:"Duplicate bill entered",dup_pay:"Supplier paid twice",payee:"Payee not verified"}[c.type],c.text,"shield"])).join("")}</div></section>
  </div>`;
}
const sgnPt=d=>(d>0?"+":d<0?"−":"")+Math.abs(d*100).toFixed(1)+" pts";
function dashAlerts(h,p,rw,isLatest){
  const a=[],buf=S.global.minBuffer;
  if(h.cash<buf)a.push(["neg",`Cash is below the ${money(buf,0)} buffer`,`${money(h.cash)} at the end of ${ml(h.k)}.`]);
  if(!isFinite(rw.months))a.push(["pos","Cash isn't being burned",`Cash rose by an average of ${money(-rw.burn)} a month over the last 3 months, after loan repayments and owner drawings.`]);
  else a.push([rw.months<3?"neg":rw.months<6?"warn":"pos",`Cash runway is ${fmtMonths(rw.months)} months`,`Cash is falling by about ${money(rw.burn)} a month on average.`]);
  if(isLatest){const wk=weekly("expected");
    if(wk.low.closing<buf)a.push([wk.low.closing<0?"neg":"warn",`Next 13 weeks: cash bottoms out at ${money(wk.low.closing)} in the week of ${fmtDayMonth(wk.low.start)}`,`Expected case, ${money(buf-wk.low.closing)} under your ${money(buf,0)} buffer. Open Forecast to see what drives it and the options.`]);
    const F=forecast(S,H,"expected",12),fs=fcSummary(F,buf);
    if(fs.below)a.unshift([fs.neg?"neg":"warn",fs.neg?`Expected forecast: cash goes below zero in ${ml(fs.neg.k)}`:`Expected forecast: cash drops below the buffer in ${ml(fs.below.k)}`,`The oven, Q3 GST and corporate tax all fall in Oct–Nov, then the December bonus. Lowest month-end balance ${money(fs.min.cash)} in ${ml(fs.min.k)}. See Forecast for options.`]);
    const hv=HV();a.push(["warn",`${KC} is paying later every quarter`,`Now about ${hv.avgLate6.toFixed(0)} days late on average, up from ${hv.avgLatePrior6.toFixed(0)} days in the prior 6 invoices. ${money(hv.overdue)} has been overdue for ${hv.oldestOverdueDays} days.`]);}
  if(!p)return a.slice(0,5);
  const rc=chg(h.rev,p.rev);
  if(rc!=null)a.push([rc>=0?"pos":"warn",`Revenue ${rc>=0?"increased":"decreased"} ${Math.abs(rc*100).toFixed(1)}%`,`${money(h.rev)} in ${ms(h.k)} vs ${money(p.rev)} in ${ms(p.k)}.`]);
  const names=Object.fromEntries(S.cats.opex.map(c=>[c.id,c.name]));
  const trail=id=>{const w=H.slice(Math.max(0,h.i-6),h.i);return w.length?w.reduce((s,x)=>s+(x.opexCat[id]||0),0)/w.length:0;};
  const spikes=[];for(const id in h.opexCat){const t=trail(id);if(t>0&&h.opexCat[id]>2*t&&h.opexCat[id]-t>500)spikes.push([id,h.opexCat[id],t]);}
  spikes.slice(0,2).forEach(([id,c,t])=>a.push(["warn",`${names[id]} is more than double its usual level`,`${money(c)} this month vs a 6-month average of ${money(t)}.`]));
  const cr=h.rev?h.cogs/h.rev:0,cp=p.rev?p.cogs/p.rev:0;
  if(cr-cp>.03)a.push(["warn","Cost of goods rose faster than sales",`COGS is ${pct(cr)} of revenue, up from ${pct(cp)}.`]);
  if(h.nm-p.nm<-.04&&h.rev)a.push(["warn",`Net margin fell to ${pct(h.nm)}`,`Down from ${pct(p.nm)} in ${ms(p.k)}.`]);
  if(h.cfo<0)a.push(["neg","Operations used cash this month",`Operating cash flow was ${money(h.cfo)}.`]);
  return a.slice(0,5);
}

/* ---------- Statements ---------- */
function periodIdx(end,time){
  const cm=+MONTHS[end].slice(5),fy=S.business.fyStart||1;let n=1;
  if(time==="quarter"){const off=((cm-fy)%12+12)%12;n=off%3+1;}
  else if(time==="ytd"){n=((cm-fy)%12+12)%12+1;}
  else if(time==="l12")n=12;
  const st=end-n+1;if(st<0)return null;return Array.from({length:n},(_,k)=>st+k);
}
function cmpIdx(cur,mode){if(!cur)return null;const n=cur.length,shift=mode==="yoy"?12:n;const st=cur[0]-shift;if(st<0)return null;return Array.from({length:n},(_,k)=>st+k);}
function pLabel(ix,time){if(!ix)return"—";const a=MONTHS[ix[0]],b=MONTHS[ix[ix.length-1]];
  if(ix.length===1)return ml(a);return a.slice(0,4)===b.slice(0,4)?`${ms(a)}–${ms(b)} ${b.slice(0,4)}`:`${msy(a)} – ${msy(b)}`;}
function agg(ix){if(!ix)return null;const hs=ix.map(i=>H[i]);const s=f=>hs.reduce((a,h)=>a+h[f],0);
  const cat=(f)=>{const o={};hs.forEach(h=>{for(const k in h[f])o[k]=(o[k]||0)+h[f][k];});return o;};
  const last=hs[hs.length-1];
  const r={rev:s("rev"),cogs:s("cogs"),opex:s("opex"),gross:s("gross"),op:s("op"),interest:s("interest"),tax:s("tax"),np:s("np"),dep:s("dep"),dAR:s("dAR"),dInv:s("dInv"),dOCA:s("dOCA"),dDep:s("dDep"),dAP:s("dAP"),dOCL:s("dOCL"),cfo:s("cfo"),capex:s("capex"),assetSale:s("assetSale"),cfi:s("cfi"),loanIn:s("loanIn"),loanRepay:s("loanRepay"),ownerIn:s("ownerIn"),drawings:s("drawings"),cff:s("cff"),
    revCat:cat("revCat"),cogsCat:cat("cogsCat"),opexCat:cat("opexCat"),openCash:hs[0].openCash,cash:last.cash,bs:last};
  r.gm=r.rev?r.gross/r.rev:0;r.om=r.rev?r.op/r.rev:0;r.nm=r.rev?r.np/r.rev:0;return r;}
function stmtRows(tab,c,p){
  const rows=[];const L=(label,f,o={})=>rows.push({label,cur:c?f(c):null,prev:p?f(p):null,...o});
  if(tab==="pl"){
    rows.push({grp:"Revenue",note:"Excluding GST"});S.cats.rev.forEach(k=>L(k.name,x=>x.revCat[k.id]||0,{line:1}));L("Total revenue",x=>x.rev,{sub:1,term:"revenue"});
    rows.push({grp:"Cost of goods sold"});S.cats.cogs.forEach(k=>L(k.name,x=>x.cogsCat[k.id]||0,{line:1,cost:1}));L("Total COGS",x=>x.cogs,{sub:1,cost:1,term:"cogs"});
    L("Gross profit",x=>x.gross,{sub:1,term:"gross"});L("Gross margin",x=>x.gm,{ratio:1});
    rows.push({grp:"Operating expenses"});S.cats.opex.forEach(k=>L(k.name,x=>x.opexCat[k.id]||0,{line:1,cost:1,term:k.id==="cpf"?"cpf":k.id==="dep"?"dep":null}));L("Total operating expenses",x=>x.opex,{sub:1,cost:1,term:"opex"});
    L("Operating profit",x=>x.op,{sub:1,term:"op"});L("Operating margin",x=>x.om,{ratio:1});
    rows.push({grp:"Interest & tax"});L("Loan interest",x=>x.interest,{line:1,cost:1,term:"loan"});L("Corporate income tax (accrued)",x=>x.tax,{line:1,cost:1,term:"cit"});
    L("Net profit",x=>x.np,{total:1,term:"np"});L("Net margin",x=>x.nm,{ratio:1});
  }else if(tab==="cf"){
    rows.push({grp:"Cash from daily operations",note:"Operating activities"});
    L("Net profit",x=>x.np,{line:1});L("Add back depreciation (non-cash)",x=>x.dep,{line:1,term:"dep"});
    L("Customers who haven't paid yet",x=>-x.dAR,{line:1,term:"ar"});L("Stock bought but not sold",x=>-x.dInv,{line:1,term:"inv"});L("Settlements in transit & prepayments",x=>-x.dOCA,{line:1,term:"oca"});
    L("Supplier bills not yet paid",x=>x.dAP,{line:1,term:"ap"});L("GST, CPF & tax not yet paid",x=>x.dOCL,{line:1,term:"ocl"});
    L("Net cash from operations",x=>x.cfo,{sub:1,term:"ocf"});
    rows.push({grp:"Cash from investments",note:"Investing activities"});L("Equipment purchases",x=>-x.capex,{line:1});L("Asset sales",x=>x.assetSale,{line:1});L("Net cash from investments",x=>x.cfi,{sub:1,term:"icf"});
    rows.push({grp:"Cash from financing",note:"Financing activities"});L("Loans received",x=>x.loanIn,{line:1});L("Loan repayments (principal)",x=>-x.loanRepay,{line:1,term:"loan"});L("Owner investment",x=>x.ownerIn,{line:1});L("Owner drawings",x=>-x.drawings,{line:1,term:"draw"});L("Net cash from financing",x=>x.cff,{sub:1,term:"fcf"});
    rows.push({grp:"Cash position"});L("Opening cash",x=>x.openCash,{line:1});L("Net change in cash",x=>x.cfo+x.cfi+x.cff,{line:1});L("Closing cash (matches bank)",x=>x.cash,{total:1,term:"cash"});
  }else{
    const B=f=>x=>f(x.bs);
    rows.push({grp:"Current assets"});L("Cash at bank",B(b=>b.cash),{line:1});L("Accounts receivable",B(b=>b.ar),{line:1,term:"ar"});L("Inventory",B(b=>b.inv),{line:1,term:"inv"});L("Settlements in transit & prepayments",B(b=>b.oca),{line:1,term:"oca"});L("Total current assets",B(b=>b.curAssets),{sub:1});
    rows.push({grp:"Non-current assets"});L("Rental deposit",B(b=>b.deposit),{line:1});L("Equipment & fit-out (net)",B(b=>b.equip),{line:1,term:"dep"});L("Total assets",B(b=>b.assets),{total:1});
    rows.push({grp:"Liabilities"});L("Accounts payable",B(b=>b.ap),{line:1,cost:1,term:"ap"});L("GST, CPF & tax payable",B(b=>b.ocl),{line:1,cost:1,term:"ocl"});L("Term loan, due within 12 months",B(b=>b.stDebt),{line:1,cost:1});L("Total current liabilities",B(b=>b.curLiab),{sub:1,cost:1});
    L("Term loan, due after 12 months",B(b=>b.ltDebt),{line:1,cost:1,term:"loan"});L("Total liabilities",B(b=>b.liab),{sub:1,cost:1});
    rows.push({grp:"Equity"});L("Owner capital",B(b=>b.capital),{line:1});L("Retained earnings",B(b=>b.re),{line:1,term:"re"});L("Owner drawings",B(b=>-b.drawCum),{line:1,term:"draw"});L("Total equity",B(b=>b.equity),{sub:1,term:"equity"});
    L("Total liabilities + equity",B(b=>b.liab+b.equity),{total:1,term:"bs"});
    L("Current ratio",B(b=>b.cr),{ratio:1,fmt:v=>isFinite(v)?v.toFixed(2)+"×":"—"});L("Debt ratio",B(b=>b.dr),{ratio:1});
  }
  return rows;
}
function stmtTable(tab,ci,pi,time){
  const c=agg(ci),p=agg(pi),rows=stmtRows(tab,c,p);
  const asAt=tab==="bs";
  const hc=asAt?(ci?"At "+ml(MONTHS[ci[ci.length-1]]):"—"):pLabel(ci,time),hp=asAt?(pi?"At "+ml(MONTHS[pi[pi.length-1]]):"No data"):(pi?pLabel(pi,time):"No data");
  let t=`<div class="tw"><table><thead><tr><th>S$</th><th class="n">${esc(hc)}</th><th class="n">${esc(hp)}</th><th class="n">Change</th><th class="n">%</th></tr></thead><tbody>`;
  rows.forEach(r=>{
    if(r.grp){t+=`<tr class="grp"><td colspan="5">${esc(r.grp)}${r.note?`<small>${esc(r.note)}</small>`:""}</td></tr>`;return;}
    const cls=r.total?"total":r.sub?"sub":r.ratio?"ratio":"line";
    if(r.ratio){const f=r.fmt||(v=>pct(v));const d=r.cur!=null&&r.prev!=null?r.cur-r.prev:null;
      t+=`<tr class="${cls}"><td>${esc(r.label)}</td><td class="n">${f(r.cur)}</td><td class="n">${r.prev==null?"—":f(r.prev)}</td><td class="n">${d==null?"":r.fmt?(d>=0?"+":"−")+Math.abs(d).toFixed(2)+"×":sgnPt(d)}</td><td class="n"></td></tr>`;return;}
    const d=r.prev==null?null:r.cur-r.prev,pc=r.prev==null?null:chg(r.cur,r.prev);
    const good=d==null||Math.abs(d)<1?"":((d>0)!==!!r.cost?"up-good":"up-bad");
    t+=`<tr class="${cls}"><td>${esc(r.label)}${r.term?" "+info(r.term):""}</td><td class="n">${full(r.cur)}</td><td class="n muted">${r.prev==null?"—":full(r.prev)}</td><td class="n ${good}">${d==null?"—":(d>0?"+":"")+full(d)}</td><td class="n ${good}">${pc==null||!isFinite(pc)?"—":sgnPct(pc)}</td></tr>`;
  });
  t+="</tbody></table></div>";
  if(tab==="bs"&&c){const imb=c.bs.imbalance;t+=Math.abs(imb)<1?`<div class="check ok">${ic("check",18)}<span><b>Balanced.</b> Assets ${money(c.bs.assets)} = Liabilities ${money(c.bs.liab)} + Equity ${money(c.bs.equity)}</span></div>`
    :`<div class="check bad">${ic("alert",18)}<span><b>Out of balance by S$${grp(imb)}.</b> Check the opening balance sheet in Business setup: assets must equal liabilities plus equity.</span></div>`;}
  if(tab==="cf"&&c){const b=DS.bank[MONTHS[ci[ci.length-1]]];if(b!=null)t+=Math.abs(b-c.cash)<1?`<div class="check ok">${ic("check",18)}<span><b>Closing cash matches the bank statement:</b> ${money(c.cash)}.</span></div>`:`<div class="check warn">${ic("alert",18)}<span>Closing cash differs from the bank statement (${money(b)}) by ${money(c.cash-b)} because of edits in Input data.</span></div>`;}
  return t;
}
const TABS=[["pl","Profit & loss"],["cf","Cash flow"],["bs","Balance sheet"]];
function letterhead(title,sub){const b=S.business;return`<div class="letter"><div><span class="eyebrow">${esc(title)}</span><h2>${esc(b.legal||b.name)}</h2><p>${esc(b.address)}</p></div><div class="r"><p>${esc(sub)}</p><p>UEN ${esc(b.uen)} · ${esc(b.gst)}</p><p>All amounts in Singapore dollars</p></div></div>`;}
const timeOpts=[["month","Month"],["quarter","Quarter to date"],["ytd","Year to date"],["l12","Last 12 months"]];
function vStatements(){
  const u=S.ui,end=MONTHS.indexOf(u.month),ci=periodIdx(end,u.stTime),pi=cmpIdx(ci,u.stCmp);
  const ctrls=selectBox("stMonth",monthOpts(),u.month,"Period ending")+selectBox("stTime",timeOpts,u.stTime,"Timeframe")+selectBox("stCmp",[["prev","vs previous period"],["yoy","vs same period last year"]],u.stCmp,"Compare with");
  const title=TABS.find(t=>t[0]===u.stTab)[1];
  return topbar(ctrls)+`<div class="stack"><div>${segBtns("stTab",TABS,u.stTab)}</div>
  <section class="card">${letterhead(title,u.stTab==="bs"?(ci?"At "+fmtDate(monthEnd(MONTHS[end])):""):(ci?pLabel(ci,u.stTime):""))}
  ${ci?stmtTable(u.stTab,ci,pi,u.stTime):`<p class="note">Not enough months of data for this timeframe. Data starts ${ml(MONTHS[0])}.</p>`}
  <p class="note" style="margin-top:12px">Negative amounts are shown in brackets. Green change means better for the business, orange means worse.</p></section></div>`;
}

/* ---------- Input ---------- */
const OTHER_FIELDS=[
  ["Interest & tax",[["interest","Loan interest","loan"],["tax","Corporate income tax (accrued)","cit"]]],
  ["Investments",[["capex","Equipment purchases"],["assetSale","Asset sales"]]],
  ["Loans & owner",[["loanIn","Loans received"],["loanRepay","Loan repayments (principal)","loan"],["ownerIn","Owner investment"],["drawings","Owner drawings","draw"]]],
  ["Balances at month end",[["ar","Accounts receivable","ar"],["inv","Inventory","inv"],["oca","Settlements in transit & prepayments","oca"],["deposit","Rental deposit"],["ap","Accounts payable","ap"],["ocl","GST, CPF & tax payable","ocl"]]]
];
// Amounts the recorded transactions add to month k, by section and category.
function txnAdds(k){const o={rev:{},cogs:{},opex:{}};(S.txns||[]).forEach(t=>{if(t.date.slice(0,7)!==k||!txnNeedsCategory(t.kind))return;const sec=categorySection(S.cats,t.category);if(sec)o[sec][t.category]=(o[sec][t.category]||0)+t.amount;});return o;}
function vInput(){
  const k=S.ui.inMonth,i=MONTHS.indexOf(k),d=S.data[k],pk=i>0?MONTHS[i-1]:null,pd=pk?S.data[pk]:null,tx=txnAdds(k);
  const ctrls=`<div class="mnav"><button class="icon-btn" data-act="inPrev" aria-label="Previous month"${i===0?" disabled":""}>${ic("left",18)}</button>${selectBox("inMonth",monthOpts(),k,"Month")}<button class="icon-btn" data-act="inNext" aria-label="Next month"${i===MONTHS.length-1?" disabled":""}>${ic("right",18)}</button></div>`;
  const row=(sec,c,typeTag,termKey)=>{const v=d[sec][c.id]||0,pv=pd?pd[sec][c.id]||0:null;
    return`<div class="irow"><span class="nm"><span class="t">${esc(c.name)}</span>${typeTag||""}${tx[sec]&&tx[sec][c.id]?`<a class="tag var" href="#transactions" data-route="transactions" title="Recorded on the Transactions page; added on top of this amount">+${money(tx[sec][c.id])} recorded</a>`:""}${termKey?info(termKey):""}${c.custom?`<button class="icon-btn sm" data-act="delCat" data-sec="${sec}" data-id="${c.id}" aria-label="Remove ${esc(c.name)}">${ic("trash",15)}</button>`:""}</span><span class="prev num">${pv==null?"—":money(pv)}</span><label class="inp"><span class="pre">S$</span><input class="r" inputmode="numeric" id="in-${sec}-${c.id}" data-sec="${sec}" data-id="${c.id}" value="${v<0?"-":""}${grp(Math.abs(v))}" aria-label="${esc(c.name)}"></label></div>`;};
  const typeTag=t=>t==="VARIABLE"?`<span class="tag var">Variable</span>`:t==="NONCASH"?`<span class="tag nc">Non-cash</span>`:`<span class="tag">Fixed</span>`;
  const block=(sec,title,sub,cats,tagFn)=>`<section class="card"><div class="card-h"><div class="t"><h2>${title}</h2><p>${sub}</p></div><button class="btn sm" data-act="addCat" data-sec="${sec}">${ic("plus",15)}Add category</button></div>
    <div class="ihead"><span>Category</span><span>${pk?ms(pk):""}</span><span>${ml(k)}</span></div>
    ${cats.map(c=>row(sec,c,tagFn?tagFn(c.type):"")).join("")}
    <div id="add-${sec}"></div>
    <div class="itotal"><span>Total</span><span class="num" id="tot-${sec}">${money(sumObj(cats,d[sec]))}</span></div></section>`;
  const other=OTHER_FIELDS.map(([g,fs])=>`<div class="eyebrow" style="margin:14px 0 4px">${g}</div>${fs.map(([id,n,term])=>row("other",{id,name:n},"",term)).join("")}`).join("");
  return topbar(ctrls)+`<div class="split"><div class="stack">
    ${block("rev","Revenue","Café sales from the POS and catering & wholesale invoices, excluding GST",S.cats.rev,null)}
    ${block("cogs","Cost of goods sold","Supplier bills for ingredients and packaging, adjusted for the change in stock",S.cats.cogs,null)}
    ${block("opex","Operating expenses","Fixed costs stay the same each month; variable costs follow café sales",S.cats.opex,typeTag)}
    <section class="card"><div class="card-h"><div class="t"><h2>Cash, loan & balances</h2><p>Items that move cash or sit on the balance sheet</p></div></div>${other}</section>
  </div>
  <aside class="card" style="position:sticky;top:110px" aria-live="polite"><div class="card-h"><div class="t"><h2>Calculated for ${ml(k)}</h2><p>Updates as you type</p></div></div><div id="inSummary">${inSummary(i)}</div>
    <p class="note" style="margin-top:12px">Changes save automatically and flow into statements, the dashboard and the forecast.</p></aside></div>`;
}
function inSummary(i){const h=H[i],b=DS.bank[h.k];
  return[["Revenue",money(h.rev)],["Gross profit",`${money(h.gross)} · ${pct(h.gm)}`],["Operating expenses",money(h.opex)],["Net profit",`${money(h.np)} · ${pct(h.nm)}`],["Operating cash flow",money(h.cfo)],["Closing cash",money(h.cash),1]]
    .map(([l,v,big])=>`<div class="sumrow${big?" big":""}"><span>${l}</span><b class="num">${v}</b></div>`).join("")+
    (b!=null&&Math.abs(b-h.cash)<1?`<div class="check ok">${ic("check",16)}<span>Matches the bank statement</span></div>`:b!=null?`<div class="check warn">${ic("alert",16)}<span>Bank statement shows ${money(b)}</span></div>`:"")+
    (Math.abs(h.imbalance)<1?`<div class="check ok">${ic("check",16)}<span>Balance sheet balances</span></div>`:`<div class="check bad">${ic("alert",16)}<span>Balance sheet off by ${money(h.imbalance)}</span></div>`);}

/* ---------- Assumptions ---------- */
const AROWS=()=>[["posGrowth","Café sales growth","% per month","%",0.1],["b2bGrowth","Catering & wholesale growth","% per month","%",0.1],["cogsPct","Cost of goods sold","% of revenue","%",0.5],["opexGrowth","Operating cost increase","% per year, applied each January. Rent follows the lease event.","%",0.5],["hvDelay",`${KC} pays`,"days after the due date (30-day terms)","days",5]];
const KINDS=[["capex","Equipment purchase"],["payment","Payment (tax, renewal)"],["cost","One-time expense"],["monthly","New monthly cost"],["revenue","One-time revenue"],["in","Loan (repaid over 36 mo)"],["equity","Owner or investor money"],["note","Note only"]];
const KIND_TXT=Object.fromEntries(KINDS);
const KIND_OUT={capex:1,payment:1,cost:1,monthly:1};
const PRESETS=[["New employee","monthly",3500],["Equipment purchase","capex",15000],["Bank loan","in",30000],["Owner top-up","equity",20000],["Marketing campaign","cost",5000],["Catering contract","revenue",12000],["Owner withdrawal","payment",10000]];
function vAssumptions(){
  const A=S.assumptions,L12=H.slice(-12),r12=L12.reduce((a,h)=>a+h.rev,0);
  const cagr=(a,b,n)=>a>0&&b>0?Math.pow(b/a,1/n)-1:null,f3=(f,o)=>H.slice(o,o+3).reduce((s,h)=>s+h[f],0);
  const hv=HV();
  const cur={posGrowth:"Last 12 mo: "+sgnPct(cagr(f3("pos",-15),f3("pos",-3),12),2)+"/mo",b2bGrowth:"Last 12 mo: "+sgnPct(cagr(f3("b2b",-15),f3("b2b",-3),12),2)+"/mo",cogsPct:"Last 12 mo: "+pct(L12.reduce((a,h)=>a+h.cogs,0)/r12),opexGrowth:"",hvDelay:"Last 6 invoices: "+hv.avgLate6.toFixed(0)+" days"};
  const buf=S.global.minBuffer;
  const ends={};["worst","expected","best"].forEach(sc=>{const F=forecast(S,H,sc,36);ends[sc]=[12,24,36].map(hz=>fcSummary(F.slice(0,hz),buf));});
  const evs=S.events.slice().sort((a,b)=>a.month<b.month?-1:1);
  const firstFc=addM(MONTHS[MONTHS.length-1],1);
  return topbar(`<a class="btn pri" href="#forecast" data-route="forecast">${ic("forecast",16)}View forecast</a>`)+`<div class="split"><div class="stack">
  <section class="card"><div class="card-h"><div class="t"><h2>Scenario assumptions${info("scenario")}</h2><p>Loaded from the dataset's forecast drivers · forecast starts ${ml(firstFc)} from ${money(H[H.length-1].cash)} cash</p></div></div>
  <div class="tw"><table class="atbl"><thead><tr><th>Assumption</th>${["worst","expected","best"].map(s=>`<th class="sc"><span style="display:inline-flex;align-items:center;gap:6px"><i class="dot" style="background:var(${SC[s].color})"></i>${SC[s].name}</span></th>`).join("")}</tr></thead><tbody>
  ${AROWS().map(([id,l,sub,suf,step])=>`<tr><td><b style="font-weight:600">${l}</b><small>${sub}${cur[id]?" · "+cur[id]:""}</small></td>${["worst","expected","best"].map(sc=>`<td><label class="inp"><input class="r" type="number" step="${step}" id="as-${sc}-${id}" data-sc="${sc}" data-k="${id}" value="${A[sc][id]}" aria-label="${l}, ${SC[sc].name}"><span class="suf">${suf}</span></label></td>`).join("")}</tr>`).join("")}
  </tbody></table></div>
  <div class="form" style="margin-top:18px">
    <div class="field"><label for="g-draw">Owner drawings per month ${info("draw")}</label><span class="inp"><span class="pre">S$</span><input class="r" id="g-draw" inputmode="numeric" value="${grp(S.global.drawings)}"></span></div>
    <div class="field"><label for="g-buf">Minimum cash buffer ${info("buffer")}</label><span class="inp"><span class="pre">S$</span><input class="r" id="g-buf" inputmode="numeric" value="${grp(S.global.minBuffer)}"></span></div>
    <div class="field wide"><span class="flabel">Seasonality ${info("seas")}</span>${segBtns("seas",[["on","Repeat last 12 months"],["off","Flat months"]],S.global.seasonality?"on":"off")}</div>
  </div>
  <p class="note" style="margin-top:12px">Card fees follow café sales. Loan interest and principal follow the bank's schedule, and depreciation follows each asset's life, so the old espresso machine and oven stop depreciating in May 2027. New equipment is depreciated over 5 years. GST collected is paid the month after each quarter, and corporate tax each November.</p></section>

  <section class="card"><div class="card-h"><div class="t"><h2>Future events</h2><p>Known one-offs from the dataset plus anything you add. Tick the scenarios each event belongs to.</p></div><button class="btn sm" data-act="addEvent">${ic("plus",15)}Add event</button></div>
  <div class="presets" style="margin-bottom:10px">${PRESETS.map((p,ix)=>`<button class="pill" data-act="preset" data-ix="${ix}">${ic("plus",13)}${p[0]}</button>`).join("")}</div>
  <div>${evs.length?evs.map(e=>`<div class="ev-row">
    <label class="inp nm"><input id="ev-${e.id}-name" data-ev="${e.id}" data-f="name" value="${esc(e.name)}" aria-label="Event name"></label>
    <label class="inp"><input type="month" id="ev-${e.id}-month" data-ev="${e.id}" data-f="month" value="${e.month}" min="${firstFc}" aria-label="Month"></label>
    <label class="inp"><select id="ev-${e.id}-kind" data-ev="${e.id}" data-f="kind" aria-label="Type">${KINDS.map(([v,t])=>`<option value="${v}"${v===e.kind?" selected":""}>${t}</option>`).join("")}</select></label>
    <label class="inp amt"><span class="pre">S$</span><input class="r" inputmode="numeric" id="ev-${e.id}-amount" data-ev="${e.id}" data-f="amount" value="${grp(e.amount)}" aria-label="Amount"></label>
    <span class="scn">${["worst","expected","best"].map(sc=>`<label class="${e.sc.includes(sc)?"on":""}" title="${SC[sc].name} case"><input type="checkbox" data-evsc="${e.id}" data-sc="${sc}"${e.sc.includes(sc)?" checked":""}><span>${SC[sc].name[0]}</span></label>`).join("")}</span>
    <button class="icon-btn sm" data-act="delEvent" data-id="${e.id}" aria-label="Delete ${esc(e.name)}">${ic("trash",16)}</button></div>`).join(""):`<p class="note">No events yet. Add a planned purchase, loan or hire to see how it changes your cash.</p>`}</div></section>
  </div>
  <aside class="card" style="position:sticky;top:110px"><div class="card-h"><div class="t"><h2>Cash outlook</h2><p>Live result of these assumptions</p></div></div>
  <div class="tw"><table><thead><tr><th></th><th class="n">Lowest</th><th class="n">12 mo</th><th class="n">36 mo</th></tr></thead><tbody>
  ${["worst","expected","best"].map(sc=>{const e=ends[sc];return`<tr><td><span style="display:inline-flex;align-items:center;gap:6px;font-weight:600"><i class="dot" style="background:var(${SC[sc].color})"></i>${SC[sc].name}</span></td><td class="n num ${e[0].min.cash<0?"up-bad":""}">${money(e[0].min.cash)}<br><span class="muted" style="font-size:11.5px">${msy(e[0].min.k)}</span></td><td class="n num ${e[0].end.cash<0?"up-bad":""}">${money(e[0].end.cash)}</td><td class="n num ${e[2].end.cash<0?"up-bad":""}">${money(e[2].end.cash)}</td></tr>`;}).join("")}
  </tbody></table></div>
  ${["worst","expected","best"].map(sc=>{const f=ends[sc][2];return f.neg?`<div class="check bad">${ic("alert",16)}<span>${SC[sc].name}: cash goes below zero in ${ml(f.neg.k)}</span></div>`:f.below?`<div class="check warn">${ic("alert",16)}<span>${SC[sc].name}: below the buffer from ${ml(f.below.k)}</span></div>`:"";}).join("")}
  <p class="note" style="margin-top:12px">Cash at ${fmtDate(DS.asof)}: ${money(H[H.length-1].cash)}, matching the bank statement.</p></aside></div>`;
}

/* ---------- Forecast ---------- */
const fcCtrls=(sc,hz)=>segBtns("scenario",[["worst","Worst","--neg"],["expected","Expected","--fc"],["best","Best","--pos"]],sc)+segBtns("horizon",[["w13","13 weeks"],[12,"12 months"],[24,"24 months"],[36,"36 months"]],hz);
const monthlyHz=()=>S.ui.horizon==="w13"?12:S.ui.horizon;
function vForecast(){
  if(S.ui.horizon==="w13")return vForecastWeekly();
  const sc=S.ui.scenario,hz=S.ui.horizon,buf=S.global.minBuffer;
  const all={worst:forecast(S,H,"worst",hz),expected:forecast(S,H,"expected",hz),best:forecast(S,H,"best",hz)},F=all[sc],fs=fcSummary(F,buf);
  const sum={};for(const k in all)sum[k]=fcSummary(all[k],buf);
  const onTime=fcSummary(forecast(S,H,sc,hz,{hvDelay:0}),buf);
  const L12=H.slice(-12),a12={rev:L12.reduce((a,h)=>a+h.rev,0),np:L12.reduce((a,h)=>a+h.np,0),gross:L12.reduce((a,h)=>a+h.gross,0)};
  const ctrls=fcCtrls(sc,hz);
  const lastCash=H[H.length-1].cash;
  const per=hz+" mo",yrs=hz/12;
  const kpi=(l,term,v,cap,tone)=>`<div class="card kpi"><div class="kpi-h"><span class="l">${l}</span>${info(term)}</div><div class="kpi-v num" ${tone?`style="color:var(${tone})"`:""}>${v}</div><div class="kpi-f">${cap}</div></div>`;
  const labels=[...L12.map(h=>msy(h.k)),...F.map(f=>msy(f.k))],n12=L12.length;
  const fcLine=arr=>[...Array(n12-1).fill(null),L12[n12-1].rev,...arr];
  const cashAct=[...L12.map(h=>h.cash),...F.map(()=>null)];
  const cline=s=>[...Array(n12-1).fill(null),lastCash,...all[s].map(f=>f.cash)];
  const tips=[...L12.map(h=>({k:h.k,ev:[]})),...F.map(f=>({k:f.k,ev:f.events}))];
  const markers=F.map((f,ix)=>f.events.length?{i:n12+ix}:null).filter(Boolean);
  CHARTS.length=0;
  CHARTS.push({id:"fcCash",cfg:{title:"Cash forecast",h:260,labels,split:n12,refLine:{v:buf,label:"Min. buffer "+money(buf,0)},series:[{name:"Actual cash",color:"--brand",values:cashAct,area:true,dot:false},{name:SC[sc].name+" cash",color:SC[sc].color,values:cline(sc),negDots:true},
    ...["worst","expected","best"].filter(s=>s!==sc).map(s=>({name:SC[s].name,color:SC[s].color,values:cline(s),dash:true,width:1.4,dot:false}))],tips,markers}});
  CHARTS.push({id:"fcRev",cfg:{title:"Revenue forecast",h:250,labels,split:n12,series:[{name:"Actual",color:"--brand",values:[...L12.map(h=>h.rev),...F.map(()=>null)]},{name:SC[sc].name+" forecast",color:SC[sc].color,values:fcLine(F.map(f=>f.rev))}],
    band:{lo:fcLine(all.worst.map(f=>f.rev)),hi:fcLine(all.best.map(f=>f.rev)),color:"--fc"},tips,markers}});
  CHARTS.push({id:"fcProfit",cfg:{title:"Profit forecast",h:230,labels:F.map(f=>msy(f.k)),series:[{name:"Net profit",type:"bar",color:"--brand",negColor:"--neg",values:F.map(f=>f.np)},{name:"Revenue",color:"--fc",values:F.map(f=>f.rev),dot:false},{name:"Gross profit",color:"--exp",values:F.map(f=>f.gross),dot:false}],tips:F.map(f=>({k:f.k,ev:f.events}))}});
  // alerts (AL-01/02/03 and margin/expense trends)
  const al=[];
  ["worst","expected","best"].forEach(s=>{const x=sum[s];if(x.neg)al.push([s===sc?"neg":"warn",`Cash goes below zero in ${ml(x.neg.k)} under the ${SC[s].name} case`,`Lowest month-end balance ${money(x.min.cash)} in ${ml(x.min.k)}.`]);});
  if(!fs.neg&&fs.below)al.push(["warn",`Cash drops below the ${money(buf,0)} buffer in ${ml(fs.below.k)}`,`${fs.monthsBelow} month${fs.monthsBelow>1?"s":""} below the buffer in the ${SC[sc].name} case. Lowest ${money(fs.min.cash)} in ${ml(fs.min.k)}.`]);
  if(!fs.below)al.push(["pos",`Cash stays above the buffer through ${ml(F[F.length-1].k)}`,`Lowest point ${money(fs.min.cash)} in ${ml(fs.min.k)} under the ${SC[sc].name} case.`]);
  if(S.assumptions[sc].hvDelay>5){const q=fcSummary(F.slice(0,3),buf),qo=fcSummary(forecast(S,H,sc,3,{hvDelay:0}),buf);
    al.push(["info",`If ${KC} paid on time, Oct–Dec would bottom out at ${money(qo.min.cash)}`,`Instead of ${money(q.min.cash)}. The ${SC[sc].name} case assumes they keep paying ${S.assumptions[sc].hvDelay} days late, as their last invoices did.`]);}
  if(fs.end.cash>0&&isFinite(fs.runway)&&fs.runway<3)al.push(["neg","Projected cash runway falls below 3 months",`At the end of the forecast, cash covers about ${fmtMonths(fs.runway)} months of burn.`]);
  const og=chg(F.slice(-3).reduce((a,f)=>a+f.opex,0),F.slice(0,3).reduce((a,f)=>a+f.opex,0)),rg=chg(F.slice(-3).reduce((a,f)=>a+f.rev,0),F.slice(0,3).reduce((a,f)=>a+f.rev,0));
  if(og>rg+.02)al.push(["warn","Operating expenses grow faster than revenue",`Operating costs ${sgnPct(og,0)} vs revenue ${sgnPct(rg,0)} from the start to the end of the forecast.`]);
  const firstK=F[0].k,endK=F[F.length-1].k;
  const evIn=S.events.filter(e=>e.sc.includes(sc)&&e.month>=firstK&&e.month<=endK).sort((a,b)=>a.month<b.month?-1:1);
  const evOut=S.events.filter(e=>e.sc.includes(sc)&&e.month>endK).length;
  const kindTone={capex:"--neg",payment:"--neg",cost:"--neg",in:"--pos",equity:"--pos",monthly:"--warn",revenue:"--brand",note:"--neutral"};
  const rowsC=[["Revenue",x=>money(x.rev)],["Gross margin",x=>pct(x.gm)],["Net profit",x=>money(x.np)],["Ending cash",x=>money(x.end.cash)],["Lowest cash",x=>`${money(x.min.cash)} <span class="muted" style="font-weight:400">${msy(x.min.k)}</span>`],["Months below buffer",x=>String(x.monthsBelow)],["Runway at end",x=>x.end.cash<=0?"Out of cash":isFinite(x.runway)?fmtMonths(x.runway)+" mo":"Cash-positive"]];
  // options to consider when cash dips below the buffer
  const hv=HV(),oven=S.events.filter(e=>e.kind==="capex"&&/oven/i.test(e.name)).reduce((a,e)=>a+e.amount,0);
  const fp=id=>DS.financing.find(f=>f.product_id===id)||{};
  const opts=[];
  if(S.assumptions[sc].hvDelay>5)opts.push({t:`Chase ${KC}'s overdue invoice`,m:"Collections · free",d:`Send a reminder for the ${money(hv.overdue)} that is ${hv.oldestOverdueDays} days overdue and agree a payment date for the ${money(hv.outstanding-hv.overdue)} still to fall due.`,v:`Oct–Dec low improves by ${money(fcSummary(forecast(S,H,sc,3,{hvDelay:0}),buf).min.cash-fcSummary(F.slice(0,3),buf).min.cash)}`,act:"hvOnTime"});
  if(hv.outstanding>5000){const f=fp("FP-01"),adv=hv.outstanding*(+f.advance_rate||.8);opts.push({t:f.product_type||"Invoice financing",m:`${f.provider} · ${f.pricing} · approval in ${f.approval_days} days`,d:`Borrow against ${KC}'s open invoices. About ${money(adv)} could be advanced now, costing roughly ${money(adv*.011)} for every 30 days it's outstanding.`,v:`Repaid when ${KC} pays`});}
  if(oven>0){const f=fp("FP-04"),fin=oven*(+f.advance_rate||.9);opts.push({t:(f.product_type||"Equipment hire purchase")+" for the oven",m:`${f.provider} · ${f.pricing} · approval in ${f.approval_days} days`,d:`Finance ${pct(+f.advance_rate||.9,0)} of the ${money(oven)} deck oven and pay monthly instead of up front.`,v:`Adds about ${money(fin)} of cash in ${ms(addM(MONTHS[MONTHS.length-1],2))}, repaid over 36 months`,act:"hirePurchase",amt:fin});}
  {const f=fp("FP-06");opts.push({t:"Ask suppliers for longer terms",m:`${f.provider||"Existing suppliers"} · ${f.pricing||"usually free"}`,d:`Ask ${DS.longTermSuppliers.slice(0,2).join(" and ")} for an extra 15–30 days on bills over the crunch.`,v:"Bridges a short timing gap"});}
  const showOpts=!!fs.below;
  return topbar(ctrls)+`<div class="stack">
  <section class="grid g3" aria-label="Forecast figures">
    ${kpi(`Lowest cash · ${ml(fs.min.k)}`,"buffer",money(fs.min.cash),fs.min.cash<0?"Below zero":fs.min.cash<buf?`${money(buf-fs.min.cash)} under the buffer`:"Above the buffer",fs.min.cash<0?"--neg":fs.min.cash<buf?"--warn":null)}
    ${kpi(`Ending cash · ${ml(endK)}`,"cash",money(fs.end.cash),`from ${money(lastCash)} at ${fmtDate(DS.asof)}`,fs.end.cash<0?"--neg":null)}
    ${kpi("Cash runway at end","runway",fs.end.cash<=0?"Out of cash":isFinite(fs.runway)?fmtMonths(fs.runway)+" <small>months</small>":"Cash-positive",isFinite(fs.runway)&&fs.end.cash>0?`burning ${money(fs.burn)}/mo`:fs.end.cash>0?`cash grows ${money(-fs.burn)}/mo at the end`:"cash shortfall",fs.end.cash<=0?"--neg":null)}
    ${kpi(`Forecast revenue · ${per}`,"revenue",money(fs.rev),yrs===1?"vs "+money(a12.rev)+" last 12 mo":money(fs.rev/yrs)+" per year avg")}
    ${kpi(`Forecast net profit · ${per}`,"np",money(fs.np),`${pct(fs.nm)} margin · ${yrs===1?"vs "+money(a12.np)+" last 12 mo":money(fs.np/yrs)+" per year avg"}`,fs.np<0?"--neg":null)}
    ${kpi("Forecast gross margin","gm",pct(fs.gm),"vs "+pct(a12.gross/a12.rev)+" last 12 mo")}
  </section>
  <section class="card"><div class="card-h"><div class="t"><h2>Forecast alerts</h2><p>Informational, based on your assumptions. Not financial advice.</p></div></div>
    <div class="alerts">${al.slice(0,5).map(alertRow).join("")}</div></section>
  <section class="card"><div class="card-h"><div class="t"><h2>Cash forecast</h2><p>Month-end bank balance · red area is below zero · gold markers are planned events</p></div>
    <div class="legend"><span><i class="sw ln" style="background:var(--brand)"></i>Actual</span><span><i class="sw ln" style="background:var(${SC[sc].color})"></i>${SC[sc].name}</span>${["worst","expected","best"].filter(s=>s!==sc).map(s=>`<span style="color:var(${SC[s].color})"><i class="sw dash"></i><span style="color:var(--text-2)">${SC[s].name}</span></span>`).join("")}</div></div>
    <div class="chart" id="fcCash"></div>
    <p class="note" style="margin:8px 0 0">Month-end balances. Payroll on the 28th and tax on the 30th can make the low point inside a month deeper than shown.</p></section>
  ${showOpts?`<section class="card attn"><div class="card-h"><div class="t"><h2>Options to consider</h2><p>Ways to cover the dip below the buffer, from the dataset's financing catalogue. Compare costs before deciding; this isn't financial advice.</p></div></div>
    <div class="opts">${opts.map(o=>`<div class="opt"><b>${esc(o.t)}</b><span class="meta">${esc(o.m)}</span><p>${esc(o.d)}</p><div class="row"><span class="badge info">${esc(o.v)}</span>${o.act?`<button class="btn sm" data-act="${o.act}" data-amt="${o.amt||0}">Try in ${SC[sc].name} case</button>`:""}</div></div>`).join("")}</div></section>`:""}
  <div class="split eq half">
    <section class="card"><div class="card-h"><div class="t"><h2>Revenue forecast</h2><p>Last 12 months actual, then the ${SC[sc].name.toLowerCase()} case. Shaded band spans worst to best.</p></div>
      <div class="legend"><span><i class="sw ln" style="background:var(--brand)"></i>Actual</span><span><i class="sw ln" style="background:var(${SC[sc].color})"></i>Forecast</span><span><i class="sw" style="background:var(--fc);opacity:.25"></i>Range</span></div></div>
      <div class="chart" id="fcRev"></div></section>
    <section class="card"><div class="card-h"><div class="t"><h2>Planned events</h2><p>${SC[sc].name} case · ${ml(firstK)} – ${ml(endK)}</p></div><a class="btn sm" href="#assumptions" data-route="assumptions">Edit</a></div>
      <div class="timeline">${evIn.length?evIn.map(e=>`<div class="tl"><span class="d">${e.date?fmtDate(e.date).replace(/ \d{4}$/,""):msy(e.month)}</span><span class="p" style="background:var(${kindTone[e.kind]})"></span><span class="x"><b>${esc(e.name)}</b><small>${KIND_TXT[e.kind]}${e.certainty?" · "+esc(e.certainty):""}</small></span><span class="a ${KIND_OUT[e.kind]?"up-bad":e.kind==="note"?"muted":"up-good"}">${e.kind==="note"?"—":(KIND_OUT[e.kind]?"−":"+")+money(e.amount)+(e.kind==="monthly"?"/mo":"")}</span></div>`).join(""):`<p class="note">No events in this period for the ${SC[sc].name} case.</p>`}
      ${evOut?`<p class="note" style="margin-top:8px">${evOut} more event${evOut>1?"s":""} after this period.</p>`:""}</div></section>
  </div>
  <div class="split eq even">
    <section class="card"><div class="card-h"><div class="t"><h2>Profit forecast</h2><p>${SC[sc].name} case · monthly</p></div>
      <div class="legend"><span><i class="sw ln" style="background:var(--fc)"></i>Revenue</span><span><i class="sw ln" style="background:var(--exp)"></i>Gross profit</span><span><i class="sw" style="background:var(--brand)"></i>Net profit</span></div></div>
      <div class="chart" id="fcProfit"></div></section>
    <section class="card"><div class="card-h"><div class="t"><h2>Scenario comparison</h2><p>Totals over ${hz} months</p></div></div>
      <div class="tw"><table class="sctable"><thead><tr><th></th>${["worst","expected","best"].map(s=>`<th class="n${s===sc?" sel":""}"><span style="display:inline-flex;align-items:center;gap:6px"><i class="dot" style="background:var(${SC[s].color})"></i>${SC[s].name}</span></th>`).join("")}</tr></thead>
      <tbody>${rowsC.map(([l,f])=>`<tr><td>${l}</td>${["worst","expected","best"].map(s=>`<td class="n num${s===sc?" sel":""}${(l==="Ending cash"&&sum[s].end.cash<0)||(l==="Lowest cash"&&sum[s].min.cash<0)?" up-bad":""}"><b>${f(sum[s])}</b></td>`).join("")}</tr>`).join("")}</tbody></table></div></section>
  </div>
  <section class="card"><details class="more"><summary>Monthly forecast table · ${SC[sc].name} case</summary>
    <div class="tw" style="margin-top:14px"><table><thead><tr><th>Month</th><th class="n">Revenue</th><th class="n">Net profit</th><th class="n">${KC} billed</th><th class="n">${KC} paid</th><th class="n">GST & tax paid</th><th class="n">Cash flow</th><th class="n">Ending cash</th><th>Events</th></tr></thead><tbody>
    ${F.map(f=>`<tr><td>${ml(f.k)}</td><td class="n">${full(f.rev)}</td><td class="n ${f.np<0?"up-bad":""}">${full(f.np)}</td><td class="n">${full(f.hvRev)}</td><td class="n">${full(f.hvIn)}</td><td class="n">${full(f.gstPaid+f.taxPaid+f.events.filter(e=>e.kind==="payment"&&/GST|tax/i.test(e.name)).reduce((a,e)=>a+e.amount,0))}</td><td class="n ${f.flow<0?"up-bad":""}">${full(f.flow)}</td><td class="n ${f.cash<0?"up-bad":f.cash<buf?"":""}"><b>${full(f.cash)}</b></td><td class="muted">${f.events.map(e=>esc(e.name)).join(", ")}</td></tr>`).join("")}
    </tbody></table></div><div style="margin-top:12px"><button class="btn sm" data-act="csv" data-what="forecast">${ic("copy",15)}Copy as CSV</button></div><textarea class="csvbox" id="csvOut" hidden aria-label="CSV output"></textarea></details></section>
  </div>`;
}

/* ---------- Reports ---------- */
const REPORTS=[["pl","Profit & loss","Revenue, costs and profit for the selected period","statements"],["cf","Cash flow statement","Operations, investments and financing, reconciled to the bank","wallet"],["bs","Balance sheet","Assets, liabilities and equity at month end","chart"],["ar","Receivables","Open invoices and days late by customer","clock"],["weekly","13-week cash forecast","Week-by-week bank balance with every dated item","clock"],["forecast","Forecast report","Monthly projection for the selected scenario and horizon","forecast"],["data","Monthly financial data","Every monthly figure, one row per month","input"]];
function csvFor(what){
  const q=v=>typeof v==="number"?(Math.round(v*100)/100):`"${String(v).replace(/"/g,'""')}"`;
  const out=rows=>rows.map(r=>r.map(q).join(",")).join("\n");
  if(what==="weekly"){const r=weekly(S.ui.scenario);return out([["Week start","Week end","Money in","Money out","Net","Closing balance"],...r.weeks.map(w=>[w.start,w.end,w.inflow,w.outflow,w.net,w.closing]),[],["Date","Item","Category","Amount"],...r.weeks.flatMap(w=>w.items.map(it=>[it.date,it.label,it.cat,it.amount]))]);}
  if(what==="forecast"){const F=forecast(S,H,S.ui.scenario,monthlyHz());return out([["Month","Revenue","Cafe","B2B","COGS","Gross profit","Operating expenses","Interest","Tax accrued","Net profit",`${KC} billed`,`${KC} paid`,"GST paid","Tax paid","Loan principal","Owner drawings","Equipment","Other payments","Loans/equity in","Net cash flow","Ending cash","Events"],...F.map(f=>[f.k,f.rev,f.pos,f.b2b,f.cogs,f.gross,f.opex,f.interest,f.tax,f.np,f.hvRev,f.hvIn,f.gstPaid,f.taxPaid,f.principal,f.drawings,f.capex,f.payments,f.loansIn+f.equityIn,f.flow,f.cash,f.events.map(e=>e.name).join("; ")])]);}
  if(what==="ar")return out([["Customer","Segment","Terms (days)","Credit limit","Outstanding","Overdue","Avg days late (last 6)","Avg days late (prior 6)"],...DS.customers.map(c=>[c.name,c.segment,c.terms,c.limit,c.outstanding,c.overdue,c.avgLate6??"",c.avgLatePrior6??""])]);
  if(what==="data"){const cols=[...S.cats.rev.map(c=>["rev",c]),...S.cats.cogs.map(c=>["cogs",c]),...S.cats.opex.map(c=>["opex",c])];const oth=OTHER_FIELDS.flatMap(g=>g[1]);
    return out([["Month",...cols.map(([s,c])=>`${s.toUpperCase()}: ${c.name}`),...oth.map(o=>o[1]),"Closing cash"],...MONTHS.map((k,i)=>[k,...cols.map(([s,c])=>S.data[k][s][c.id]||0),...oth.map(o=>S.data[k].other[o[0]]||0),H[i].cash])]);}
  const end=MONTHS.indexOf(S.ui.month),ci=periodIdx(end,S.ui.stTime),pi=cmpIdx(ci,S.ui.stCmp),c=agg(ci),p=agg(pi);
  const rows=stmtRows(what,c,p);
  return out([[S.business.legal+" — "+REPORTS.find(r=>r[0]===what)[1]],[what==="bs"?"At "+ml(MONTHS[end]):pLabel(ci,S.ui.stTime),"SGD"],[],["Line","Current","Comparison","Change"],...rows.map(r=>r.grp?[r.grp]:r.ratio?[r.label,(r.cur*(r.fmt?1:100)).toFixed(2)+(r.fmt?"x":"%"),r.prev==null?"":(r.prev*(r.fmt?1:100)).toFixed(2)+(r.fmt?"x":"%"),""]:[r.label,r.cur,r.prev??"",r.prev==null?"":r.cur-r.prev])]);
}
function vReports(){
  const r=S.ui.report,end=MONTHS.indexOf(S.ui.month),ci=periodIdx(end,S.ui.stTime),pi=cmpIdx(ci,S.ui.stCmp);
  let preview="";
  if(["pl","cf","bs"].includes(r))preview=letterhead(REPORTS.find(x=>x[0]===r)[1],r==="bs"?"At end of "+ml(MONTHS[end]):pLabel(ci,S.ui.stTime))+(ci?stmtTable(r,ci,pi,S.ui.stTime):`<p class="note">Not enough data for this timeframe.</p>`);
  else if(r==="ar")preview=letterhead("Receivables","At "+fmtDate(DS.asof))+`<div class="tw"><table><thead><tr><th>Customer</th><th class="n">Terms</th><th class="n">Outstanding</th><th class="n">Overdue</th><th class="n">Days late, last 6</th><th class="n">Prior 6</th></tr></thead><tbody>${DS.customers.map(c=>`<tr><td>${esc(c.name)}</td><td class="n">${c.terms}d</td><td class="n">${full(c.outstanding)}</td><td class="n">${full(c.overdue)}</td><td class="n">${c.avgLate6==null?"—":c.avgLate6.toFixed(1)}</td><td class="n">${c.avgLatePrior6==null?"—":c.avgLatePrior6.toFixed(1)}</td></tr>`).join("")}</tbody></table></div>`;
  else if(r==="weekly"){const w=weekly(S.ui.scenario);preview=letterhead("13-week cash forecast",`${SC[S.ui.scenario].name} case · from ${fmtDate(DS.asof)} · opening ${money(w.startCash)}`)+weeklyTable(w,S.global.minBuffer,false);}
  else if(r==="forecast"){const F=forecast(S,H,S.ui.scenario,monthlyHz()),fs=fcSummary(F,S.global.minBuffer);
    preview=letterhead("Forecast report",`${SC[S.ui.scenario].name} case · ${ml(F[0].k)} – ${ml(F[F.length-1].k)}`)+`<div class="grid g3" style="margin:14px 0">${[["Revenue",money(fs.rev)],["Net profit",money(fs.np)],["Lowest cash",money(fs.min.cash)+" · "+msy(fs.min.k)]].map(([l,v])=>`<div><div class="eyebrow">${l}</div><div class="kpi-v num" style="font-size:22px">${v}</div></div>`).join("")}</div><div class="tw"><table><thead><tr><th>Month</th><th class="n">Revenue</th><th class="n">Net profit</th><th class="n">Ending cash</th></tr></thead><tbody>${F.map(f=>`<tr><td>${ml(f.k)}</td><td class="n">${full(f.rev)}</td><td class="n">${full(f.np)}</td><td class="n ${f.cash<0?"up-bad":""}">${full(f.cash)}</td></tr>`).join("")}</tbody></table></div>`;}
  else preview=letterhead("Monthly financial data",`${ml(MONTHS[0])} – ${ml(MONTHS[MONTHS.length-1])}`)+`<div class="tw"><table><thead><tr><th>Month</th><th class="n">Revenue</th><th class="n">COGS</th><th class="n">Op. expenses</th><th class="n">Net profit</th><th class="n">Closing cash</th></tr></thead><tbody>${H.slice().reverse().map(h=>`<tr><td>${ml(h.k)}</td><td class="n">${full(h.rev)}</td><td class="n">${full(h.cogs)}</td><td class="n">${full(h.opex)}</td><td class="n">${full(h.np)}</td><td class="n">${full(h.cash)}</td></tr>`).join("")}</tbody></table></div>`;
  const ctrls=selectBox("stMonth",monthOpts(),S.ui.month,"Period ending")+selectBox("stTime",timeOpts,S.ui.stTime,"Timeframe");
  return topbar(ctrls)+`<div class="split" style="grid-template-columns:340px minmax(0,1fr)">
  <section class="card"><div class="card-h"><div class="t"><h2>Reports</h2><p>Branded with your business profile</p></div></div>
  <div class="report-list">${REPORTS.map(([id,t,d,icn])=>`<div class="rl"><span class="ic">${ic(icn,18)}</span><div><b>${t}</b><small>${d}</small></div><div class="acts"><button class="btn sm${id===r?" pri":""}" data-act="showReport" data-id="${id}" aria-pressed="${id===r}">${ic("eye",15)}View</button><button class="btn sm ghost" data-act="csv" data-what="${id}" aria-label="Copy ${t} as CSV">${ic("copy",15)}CSV</button></div></div>`).join("")}</div>
  <textarea class="csvbox" id="csvOut" hidden aria-label="CSV output"></textarea>
  <p class="note" style="margin-top:12px">CSV copies to your clipboard; paste it into Excel or Google Sheets. Print-ready PDF export is part of the full product and isn't available in this preview.</p></section>
  <section class="card">${preview}</section></div>`;
}

/* ---------- Setup ---------- */
function vSetup(){
  const b=S.business,o=S.open;
  const f=(id,label,val,wide,type="text")=>`<div class="field${wide?" wide":""}"><label for="biz-${id}">${label}</label><span class="inp"><input id="biz-${id}" data-biz="${id}" type="${type}" value="${esc(val)}"></span></div>`;
  const of=(id,label,term)=>`<div class="field"><label for="op-${id}">${label} ${term?info(term):""}</label><span class="inp"><span class="pre">S$</span><input class="r" inputmode="numeric" id="op-${id}" data-open="${id}" value="${grp(o[id])}"></span></div>`;
  const A=o.cash+o.ar+o.inv+o.oca+o.deposit+o.equip,L=o.ap+o.ocl+o.loan,E=o.capital+o.re,diff=A-L-E;
  return topbar("")+`<div class="split"><div class="stack">
  <section class="card"><div class="card-h"><div class="t"><h2>Business profile</h2><p>Shown on statements, the dashboard and exported reports</p></div></div>
  <div class="form">${f("name","Trading name",b.name)}${f("legal","Registered name",b.legal)}${f("uen","UEN",b.uen)}${f("type","Business type",b.type)}${f("industry","Industry",b.industry)}${f("country","Country",b.country)}
    <div class="field"><label for="biz-currency">Currency</label><span class="inp"><select id="biz-currency" data-biz="currency"><option>SGD (S$)</option></select></span></div>
    <div class="field"><label for="biz-fyStart">Financial year starts</label><span class="inp"><select id="biz-fyStart" data-biz="fyStart">${MN.map((m,ix)=>`<option value="${ix+1}"${b.fyStart===ix+1?" selected":""}>${m}</option>`).join("")}</select></span></div>
    ${f("gst","GST status",b.gst)}${f("started","Business start date",b.started,false,"date")}${f("owner","Owner",b.owner)}${f("contact","Operating bank account",b.contact)}${f("address","Business address",b.address,true)}</div></section>
  <section class="card"><div class="card-h"><div class="t"><h2>Opening balance sheet</h2><p>At ${fmtDate(monthEnd(addM(MONTHS[0],-1)))}, from the dataset. Retained earnings is the balancing line.</p></div></div>
  <div class="eyebrow" style="margin-bottom:8px">Assets</div><div class="form">${of("cash","Cash at bank","cash")}${of("ar","Accounts receivable","ar")}${of("inv","Inventory","inv")}${of("oca","Settlements in transit & prepayments","oca")}${of("deposit","Rental deposit")}${of("equip","Equipment & fit-out (net)","dep")}</div>
  <div class="eyebrow" style="margin:18px 0 8px">Liabilities</div><div class="form">${of("ap","Accounts payable","ap")}${of("ocl","GST & CPF payable","ocl")}${of("loan","Term loan","loan")}</div>
  <div class="eyebrow" style="margin:18px 0 8px">Equity</div><div class="form">${of("capital","Owner capital")}${of("re","Retained earnings","re")}</div>
  <div id="openCheck">${openCheck(A,L,E,diff)}</div></section></div>
  <aside class="card" style="position:sticky;top:110px"><div class="card-h"><div class="t"><h2>Your data</h2></div></div>
  <div class="sumrow"><span>Months</span><b>${MONTHS.length} · ${msy(MONTHS[0])} – ${msy(MONTHS[MONTHS.length-1])}</b></div>
  <div class="sumrow"><span>As of</span><b>${fmtDate(DS.asof)}</b></div>
  <div class="sumrow"><span>Customers</span><b>${DS.customers.length}</b></div>
  <div class="sumrow"><span>Staff</span><b>${b.staff||"—"}</b></div>
  <div class="sumrow"><span>Forecast events</span><b>${S.events.length}</b></div>
  <p class="note" style="margin:12px 0">The server only returns data for business ${esc(DS.business.id)}, the business your account belongs to. Requests for any other business are refused and logged. Free-text notes and memos from banks, suppliers and receipts aren\'t loaded.</p>
  <div id="resetBox"><button class="btn" data-act="resetAsk">${ic("reset",16)}Reset to dataset</button></div></aside></div>`;
}
const openCheck=(A,L,E,d)=>Math.abs(d)<1?`<div class="check ok">${ic("check",18)}<span><b>Balanced.</b> Assets ${money(A)} = Liabilities ${money(L)} + Equity ${money(E)}</span></div>`:`<div class="check bad">${ic("alert",18)}<span><b>Doesn't balance by ${money(d)}.</b> Assets ${money(A)} vs liabilities + equity ${money(L+E)}. Adjust retained earnings so they match.</span></div>`;

/* ---------- Glossary ---------- */
function vGlossary(){
  return topbar(`<label class="inp" style="width:260px"><input id="glq" placeholder="Search terms" aria-label="Search glossary"></label>`)+`<div class="gl" id="glList">${Object.entries(G).map(([k,[t,d,f]])=>`<article class="card" id="g-${k}" data-q="${esc((t+" "+d).toLowerCase())}"><h3>${esc(t)}</h3><p>${esc(d)}</p>${f?`<div class="f"><code>${esc(f)}</code></div>`:""}</article>`).join("")}</div>`;
}

/* ---------- Router & events ---------- */
const VIEWS={activity:vActivity,dashboard:vDashboard,statements:vStatements,input:vInput,assumptions:vAssumptions,forecast:vForecast,reports:vReports,setup:vSetup,glossary:vGlossary,transactions:vTransactions,model:vModel,assistant:vAssistant};
function render(keepScroll){
  const y=window.scrollY;CHARTS.length=0;hidePop();
  renderSide();document.getElementById("main").innerHTML=VIEWS[route]();
  document.getElementById("app").classList.remove("open");
  requestAnimationFrame(drawAll);
  if(route==="activity")loadActivity();
  if(!keepScroll)window.scrollTo(0,0);else window.scrollTo(0,y);
}
function go(r){if(!VIEWS[r]||(DS.limited&&!["dashboard","glossary","activity"].includes(r)))r="dashboard";route=r;try{if(location.hash.slice(1)!==r)history.replaceState(null,"","#"+r);}catch(e){}render();}
const commit=(keep=true)=>{recompute();save();render(keep);};
const parseNum=s=>{const t=String(s).trim(),neg=/^[-−(]/.test(t),n=parseInt(t.replace(/[^\d]/g,""),10);return isFinite(n)?(neg?-n:n):0;};

document.addEventListener("click",e=>{
  const rt=e.target.closest("[data-route]");if(rt){e.preventDefault();go(rt.dataset.route);return;}
  const term=e.target.closest("[data-term]");if(term){e.stopPropagation();showPop(term);return;}
  if(!e.target.closest("#pop"))hidePop();
  const sg=e.target.closest("[data-seg]");
  if(sg){const n=sg.dataset.seg,v=sg.dataset.v;
    if(n==="stTab")S.ui.stTab=v;else if(n==="scenario")S.ui.scenario=v;else if(n==="horizon")S.ui.horizon=v==="w13"?"w13":+v;else if(n==="seas"){S.global.seasonality=v==="on";}else if(n==="mTab")S.ui.mTab=v;else if(n==="mView")S.ui.mView=v;else if(n==="mYear")S.ui.mYear=+v;
    save();render(true);return;}
  const a=e.target.closest("[data-act]");if(!a)return;const act=a.dataset.act;
  if(FEATURE_ACTS[act]){FEATURE_ACTS[act](a,e);return;}
  if(act==="menu")document.getElementById("app").classList.add("open");
  if(act==="closeMenu")document.getElementById("app").classList.remove("open");
  if(act==="inPrev"||act==="inNext"){const i=MONTHS.indexOf(S.ui.inMonth)+(act==="inNext"?1:-1);if(i>=0&&i<MONTHS.length){S.ui.inMonth=MONTHS[i];save();render(true);}}
  if(act==="addCat"){const sec=a.dataset.sec,box=document.getElementById("add-"+sec);
    box.innerHTML=`<div class="irow"><label class="inp"><input id="newcat-${sec}" placeholder="New category name" aria-label="New category name"></label>${sec==="opex"?`<label class="inp"><select id="newtype-${sec}" aria-label="Cost type"><option value="FIXED">Fixed</option><option value="VARIABLE">Variable</option></select></label>`:sec==="rev"?`<label class="inp"><select id="newtype-${sec}" aria-label="Revenue stream"><option value="b2b">B2B</option><option value="pos">Café</option></select></label>`:"<span></span>"}<button class="btn sm pri" data-act="saveCat" data-sec="${sec}">Add</button></div>`;
    document.getElementById("newcat-"+sec).focus();}
  if(act==="saveCat")saveCat(a.dataset.sec);
  if(act==="delCat"){const{sec,id}=a.dataset,n=(S.txns||[]).filter(t=>t.category===id).length;
    if(n){toast(`${n} recorded ${n===1?"transaction uses":"transactions use"} this category. Delete ${n===1?"it":"them"} on the Transactions page first.`);return;}
    S.cats[sec]=S.cats[sec].filter(c=>c.id!==id);commit();toast("Category removed");}
  if(act==="addEvent"||act==="preset"){const p=act==="preset"?PRESETS[+a.dataset.ix]:["New event","payment",5000];
    S.events.push({id:"u"+Date.now().toString(36),name:p[0],month:addM(MONTHS[MONTHS.length-1],3),kind:p[1],amount:p[2],sc:["worst","expected","best"]});commit();toast("Event added to all scenarios");}
  if(act==="delEvent"){S.events=S.events.filter(x=>x.id!==a.dataset.id);commit();toast("Event deleted");}
  if(act==="hvOnTime"){const sc=S.ui.scenario;S.assumptions[sc].hvDelay=5;commit();toast(`${SC[sc].name} case: ${KC} now pays within 5 days of due date`);}
  if(act==="hirePurchase"){const sc=S.ui.scenario,m=addM(MONTHS[MONTHS.length-1],2);
    if(!S.events.some(x=>x.id==="hp-"+sc)){S.events.push({id:"hp-"+sc,name:"Oven hire purchase (90% financed)",month:m,kind:"in",amount:Math.round(+a.dataset.amt),sc:[sc]});commit();toast(`Hire purchase added to the ${SC[sc].name} case`);}else toast("Already added to this scenario");}
  if(act==="csv"){copyText(csvFor(a.dataset.what),"CSV");}
  if(act==="showReport"){S.ui.report=a.dataset.id;save();render(true);}
  if(act==="resetAsk"&&!document.getElementById("resetBox")){go("setup");return;}
  if(act==="resetAsk"){document.getElementById("resetBox").innerHTML=`<p style="margin:0 0 8px;font-size:13px">Replace all your edits with the original dataset?</p><div style="display:flex;gap:8px"><button class="btn pri sm" data-act="reset">Yes, reset</button><button class="btn sm" data-act="resetCancel">Cancel</button></div>`;}
  if(act==="resetCancel")render(true);
  if(act==="reset"){(async()=>{try{if(canWrite())await api(`/api/businesses/${DS.business.id}/state`,{method:"DELETE"});S=buildState(null);S.ui=defaultUi();lastSaved=dataSnapshot();recompute();save();render();toast(canWrite()?"Dataset restored":"View reset. Your role can't change saved figures.");}catch(e){toast(e.message);}})();}
  if(act==="logout"){api("/api/logout",{method:"POST",body:"{}"}).finally(()=>location.reload());}
});
function saveCat(sec){const inp=document.getElementById("newcat-"+sec),name=(inp.value||"").trim();if(!name){inp.focus();return;}
  const id="c_"+Date.now().toString(36);const c={id,name,custom:true};
  if(sec==="opex")c.type=document.getElementById("newtype-"+sec).value;
  if(sec==="rev")c.group=document.getElementById("newtype-"+sec).value==="pos"?POS_GROUP:"B2B invoices";
  S.cats[sec].push(c);commit();toast(`“${name}” added. Enter amounts per month.`);}

document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){hidePop();document.getElementById("app").classList.remove("open");}
  if(e.key==="Enter"&&e.target.id&&e.target.id.startsWith("newcat-"))saveCat(e.target.id.slice(7));
});
document.addEventListener("change",e=>{
  const t=e.target,id=t.id;
  if(featureChange(t))return;
  if(id==="dashMonth"||id==="stMonth"){S.ui.month=t.value;save();render(true);return;}
  if(id==="dashCmp"){S.ui.cmp=t.value;save();render(true);return;}
  if(id==="stTime"){S.ui.stTime=t.value;save();render(true);return;}
  if(id==="stCmp"){S.ui.stCmp=t.value;save();render(true);return;}
  if(id==="inMonth"){S.ui.inMonth=t.value;save();render(true);return;}
  if(t.dataset.sec&&t.dataset.id){const v=parseNum(t.value);t.value=(v<0?"-":"")+grp(Math.abs(v));return;}
  if(t.dataset.sc&&t.dataset.k){const v=parseFloat(t.value);S.assumptions[t.dataset.sc][t.dataset.k]=isFinite(v)?v:0;commit();return;}
  if(id==="g-draw"){S.global.drawings=parseNum(t.value);commit();return;}
  if(id==="g-buf"){S.global.minBuffer=parseNum(t.value);commit();return;}
  if(t.dataset.ev){const ev=S.events.find(x=>x.id===t.dataset.ev);const f=t.dataset.f;if(!ev)return;
    ev[f]=f==="amount"?Math.abs(parseNum(t.value)):t.value;if(f==="month"){if(!/^\d{4}-\d{2}$/.test(ev.month))ev.month=addM(MONTHS[MONTHS.length-1],1);delete ev.date;}commit();return;}
  if(t.dataset.evsc){const ev=S.events.find(x=>x.id===t.dataset.evsc);const s=t.dataset.sc;ev.sc=t.checked?[...new Set([...ev.sc,s])]:ev.sc.filter(x=>x!==s);commit();return;}
  if(t.dataset.biz){const k=t.dataset.biz;S.business[k]=k==="fyStart"?+t.value:t.value;save();renderSide();return;}
  if(t.dataset.open){t.value=grp(parseNum(t.value));commit();return;}
});
document.addEventListener("input",e=>{
  const t=e.target;
  if(t.dataset.sec&&t.dataset.id){const k=S.ui.inMonth,sec=t.dataset.sec;S.data[k][sec][t.dataset.id]=parseNum(t.value);recompute();save();
    const i=MONTHS.indexOf(k);document.getElementById("inSummary").innerHTML=inSummary(i);
    const tot=document.getElementById("tot-"+sec);if(tot)tot.textContent=money(sumObj(S.cats[sec],S.data[k][sec]));return;}
  if(t.dataset.open){S.open[t.dataset.open]=parseNum(t.value);save();const o=S.open,A=o.cash+o.ar+o.inv+o.oca+o.deposit+o.equip,L=o.ap+o.ocl+o.loan,E=o.capital+o.re;document.getElementById("openCheck").innerHTML=openCheck(A,L,E,A-L-E);recompute();return;}
  if(t.dataset.biz&&t.dataset.biz!=="fyStart"){S.business[t.dataset.biz]=t.value;save();renderSide();return;}
  if(t.id==="glq"){const q=t.value.toLowerCase().trim();document.querySelectorAll("#glList article").forEach(a=>a.hidden=!!q&&!a.dataset.q.includes(q));}
});

const tip=document.getElementById("tip");
document.addEventListener("mousemove",e=>{
  const hit=e.target.closest&&e.target.closest(".hit");
  if(!hit){tip.hidden=true;return;}
  const host=hit.closest(".chart"),c=host&&host._cfg;if(!c){tip.hidden=true;return;}
  const i=+hit.dataset.i,fmt=c.fmt||money;
  const lab=c.tips?ml(c.tips[i].k):c.tipKeys?c.tipKeys[i]:c.labels[i];
  let h=`<b>${esc(lab)}</b>`;
  c.series.forEach(s=>{const v=s.values[i];if(v==null)return;h+=`<div class="r"><span><i style="background:var(${s.colorAt?s.colorAt(i,v):s.color})"></i>${esc(s.name)}</span><span>${fmt(v)}</span></div>`;});
  if(c.band&&c.band.lo[i]!=null&&(c.split==null||i>=c.split))h+=`<div class="r"><span>Range</span><span>${money(c.band.lo[i])} – ${money(c.band.hi[i])}</span></div>`;
  if(c.tips&&c.tips[i].ev.length)h+=`<div class="ev">${c.tips[i].ev.map(ev=>"◆ "+esc(ev.name)).join("<br>")}</div>`;
  tip.innerHTML=h;tip.hidden=false;
  const r=tip.getBoundingClientRect();let x=e.clientX+14,y=e.clientY+14;if(x+r.width>innerWidth-8)x=e.clientX-r.width-14;if(y+r.height>innerHeight-8)y=e.clientY-r.height-14;
  tip.style.left=x+"px";tip.style.top=y+"px";
});
const pop=document.getElementById("pop");
function showPop(btn){const k=btn.dataset.term,[t,d,f]=G[k];
  pop.innerHTML=`<h4>${esc(t)}</h4><p>${esc(d)}</p>${f?`<div class="f"><code>${esc(f)}</code></div>`:""}<div class="f"><a href="#glossary" data-route="glossary" style="color:var(--fc)">Open glossary</a></div>`;
  pop.hidden=false;const r=btn.getBoundingClientRect(),pr=pop.getBoundingClientRect();
  let x=Math.min(Math.max(16,r.left-20),innerWidth-pr.width-16),y=r.bottom+8;if(y+pr.height>innerHeight-8)y=r.top-pr.height-8;
  pop.style.left=x+"px";pop.style.top=y+"px";}
function hidePop(){pop.hidden=true;}
window.addEventListener("scroll",hidePop,{passive:true});
let rz;window.addEventListener("resize",()=>{clearTimeout(rz);rz=setTimeout(drawAll,120);});
window.addEventListener("hashchange",()=>{const r=location.hash.slice(1);if(r&&r!==route&&VIEWS[r])go(r);});

/* ---------- 13-week cash forecast ---------- */
function weeklyTable(r,buf,interactive=true){
  return `<div class="weeks">${r.weeks.map(w=>`<details class="wk${w.closing<0?" neg":w.closing<buf?" low":""}"${!interactive?" open":""}>
    <summary><span class="wd">${fmtDayMonth(w.start)} – ${fmtDayMonth(w.end)}</span><span class="n up-good">+${full(w.inflow)}</span><span class="n up-bad">−${full(w.outflow)}</span><span class="n">${w.net>=0?"+":"−"}${full(Math.abs(w.net))}</span><span class="n cl">${w.closing<0?"−":""}${full(Math.abs(w.closing))}</span></summary>
    <div class="its">${w.items.filter(it=>Math.abs(it.amount)>=1).map(it=>`<div class="it"><span class="muted">${fmtDayMonth(it.date)}</span><span>${esc(it.label)}<small> · ${esc(it.cat)}</small></span><span class="n ${it.amount<0?"up-bad":"up-good"}">${it.amount<0?"−":"+"}${full(Math.abs(it.amount))}</span></div>`).join("")}</div></details>`).join("")}</div>`;
}
function optionsFor(sc,improve){
  const hv=HV(),oven=S.events.filter(e=>e.kind==="capex"&&e.sc.includes(sc)).reduce((a,e)=>a+e.amount,0);
  const fp=id=>DS.financing.find(f=>f.product_id===id)||{};
  const opts=[];
  if(S.assumptions[sc].hvDelay>5)opts.push({t:`Chase ${KC}'s overdue invoice`,m:"Collections · free",d:`Send a reminder for the ${money(hv.overdue)} that is ${hv.oldestOverdueDays} days overdue and agree dates for the ${money(hv.outstanding-hv.overdue)} still to fall due.`,v:improve,act:"hvOnTime"});
  if(hv.outstanding>5000){const f=fp("FP-01"),adv=hv.outstanding*(+f.advance_rate||.8);opts.push({t:f.product_type||"Invoice financing",m:`${f.provider} · ${f.pricing} · approval in ${f.approval_days} days`,d:`Borrow against ${KC}'s open invoices. About ${money(adv)} could be advanced now, costing roughly ${money(adv*.011)} for every 30 days it's outstanding.`,v:`Repaid when ${KC} pays`});}
  if(oven>0){const f=fp("FP-04"),fin=oven*(+f.advance_rate||.9);opts.push({t:(f.product_type||"Equipment hire purchase")+" for planned equipment",m:`${f.provider} · ${f.pricing} · approval in ${f.approval_days} days`,d:`Finance ${pct(+f.advance_rate||.9,0)} of the ${money(oven)} of planned equipment and pay monthly instead of up front.`,v:`About ${money(fin)} less cash out now, repaid over 36 months`,act:"hirePurchase",amt:fin});}
  {const f=fp("FP-06");opts.push({t:"Ask suppliers for longer terms",m:`${f.provider||"Existing suppliers"} · ${f.pricing||"usually free"}`,d:`Ask ${DS.longTermSuppliers.slice(0,2).join(" and ")} for an extra 15–30 days on bills over the crunch.`,v:"Bridges a short timing gap"});}
  return opts;
}
function vForecastWeekly(){
  const sc=S.ui.scenario,buf=S.global.minBuffer;
  const all={worst:weekly("worst"),expected:weekly("expected"),best:weekly("best")},r=all[sc];
  const onTime=weekly(sc,{hvDelay:0});
  const below=r.weeks.filter(w=>w.closing<buf),neg=r.weeks.find(w=>w.closing<0);
  const last=r.weeks[r.weeks.length-1];
  const held=DS.weekly.openAP.filter(b=>b.held);
  const cats=weeklyByCategory(r);
  CHARTS.length=0;
  CHARTS.push({id:"wkChart",cfg:{title:"13-week cash forecast",h:280,labels:r.weeks.map(w=>fmtDayMonth(w.start)),hl:r.weeks.indexOf(r.low),refLine:{v:buf,label:"Min. buffer "+money(buf,0)},
    series:[{name:"Money in",type:"bar",color:"--pos",values:r.weeks.map(w=>w.inflow)},{name:"Money out",type:"bar",color:"--exp",values:r.weeks.map(w=>-w.outflow)},
      {name:SC[sc].name+" closing balance",color:SC[sc].color,values:r.weeks.map(w=>w.closing),negDots:true},
      ...["worst","expected","best"].filter(s=>s!==sc).map(s=>({name:SC[s].name,color:SC[s].color,values:all[s].weeks.map(w=>w.closing),dash:true,width:1.4,dot:false}))],
    tipKeys:r.weeks.map(w=>`Week of ${fmtDayMonth(w.start)}`)}});
  const al=[];
  ["worst","expected","best"].forEach(s=>{const x=all[s],n=x.weeks.find(w=>w.closing<0);if(n)al.push([s===sc?"neg":"warn",`${SC[s].name} case: the bank balance goes below zero in the week of ${fmtDayMonth(n.start)}`,`Lowest ${money(x.low.closing)} in the week of ${fmtDayMonth(x.low.start)}.`]);});
  if(below.length&&!neg)al.push(["warn",`Cash drops below the ${money(buf,0)} buffer in ${below.length} of 13 weeks`,`Lowest ${money(r.low.closing)} in the week of ${fmtDayMonth(r.low.start)}. That week includes ${r.low.items.filter(i=>i.amount<-5000).map(i=>i.label.replace(/ \(net pay\)$/,"")).slice(0,3).join(", ")||"several large payments"}.`]);
  if(!below.length)al.push(["pos","Cash stays above the buffer for all 13 weeks",`Lowest ${money(r.low.closing)} in the week of ${fmtDayMonth(r.low.start)}.`]);
  if(S.assumptions[sc].hvDelay>5&&onTime.low.closing-r.low.closing>1000)al.push(["info",`If ${KC} paid on time, the lowest balance would be ${money(onTime.low.closing)}`,`Instead of ${money(r.low.closing)}. This case assumes they pay ${S.assumptions[sc].hvDelay} days late, like their recent invoices.`]);
  if(held.length)al.push(["warn",`${held.length} bill${held.length>1?"s are":" is"} held and left out of the forecast`,held.map(b=>`${b.supplier} ${money(b.amount)}: ${b.held.toLowerCase()}`).join(". ")+". Paying them would lower every balance after their due date.","shield"]);
  const opts=below.length?optionsFor(sc,`Lowest balance improves by ${money(onTime.low.closing-r.low.closing)}`):[];
  const kpi=(l,term,v,cap,tone)=>`<div class="card kpi"><div class="kpi-h"><span class="l">${l}</span>${term?info(term):""}</div><div class="kpi-v num" ${tone?`style="color:var(${tone})"`:""}>${v}</div><div class="kpi-f">${cap}</div></div>`;
  return topbar(fcCtrls(sc,"w13"))+`<div class="stack">
  <section class="grid g4" aria-label="13-week figures">
    ${kpi(`Lowest balance · week of ${fmtDayMonth(r.low.start)}`,"buffer",money(r.low.closing),r.low.closing<0?"Below zero":r.low.closing<buf?`${money(buf-r.low.closing)} under the buffer`:"Above the buffer",r.low.closing<0?"--neg":r.low.closing<buf?"--warn":null)}
    ${kpi(`Balance on ${fmtDayMonth(last.end)}`,"cash",money(last.closing),`from ${money(r.startCash)} on ${fmtDayMonth(DS.asof)}`,last.closing<0?"--neg":null)}
    ${kpi("Weeks below the buffer","buffer",`${below.length} <small>of 13</small>`,neg?`below zero from ${fmtDayMonth(neg.start)}`:"never below zero",below.length?"--warn":null)}
    ${kpi(`${KC} pays`,"late",`${S.assumptions[sc].hvDelay} <small>days late</small>`,`${money(HV().outstanding)} outstanding today`)}
  </section>
  <section class="card"><div class="card-h"><div class="t"><h2>Cash alerts · next 13 weeks</h2><p>Checked against the buffer and zero, as in your alert rules. Informational, not financial advice.</p></div></div>
    <div class="alerts">${al.slice(0,5).map(alertRow).join("")}</div></section>
  <section class="card"><div class="card-h"><div class="t"><h2>Week by week</h2><p>Bars show money in and out each week · the line is the bank balance at the end of the week</p></div>
    <div class="legend"><span><i class="sw" style="background:var(--pos)"></i>In</span><span><i class="sw" style="background:var(--exp)"></i>Out</span><span><i class="sw ln" style="background:var(${SC[sc].color})"></i>${SC[sc].name} balance</span>${["worst","expected","best"].filter(s=>s!==sc).map(s=>`<span style="color:var(${SC[s].color})"><i class="sw dash"></i><span style="color:var(--text-2)">${SC[s].name}</span></span>`).join("")}</div></div>
    <div class="chart" id="wkChart"></div></section>
  ${opts.length?`<section class="card attn"><div class="card-h"><div class="t"><h2>Options to consider</h2><p>Ways to cover the dip, from the dataset's financing catalogue. Compare costs before deciding; this isn't financial advice.</p></div></div>
    <div class="opts">${opts.map(o=>`<div class="opt"><b>${esc(o.t)}</b><span class="meta">${esc(o.m)}</span><p>${esc(o.d)}</p><div class="row"><span class="badge info">${esc(o.v)}</span>${o.act?`<button class="btn sm" data-act="${o.act}" data-amt="${o.amt||0}">Try in ${SC[sc].name} case</button>`:""}</div></div>`).join("")}</div></section>`:""}
  <div class="split eq">
    <section class="card"><div class="card-h"><div class="t"><h2>Every dated item</h2><p>${SC[sc].name} case · open a week to see what moves the balance</p></div><button class="btn sm" data-act="csv" data-what="weekly">${ic("copy",15)}Copy CSV</button></div>
      <div class="whead"><span>Week</span><span class="n">In</span><span class="n">Out</span><span class="n">Net</span><span class="n">Balance</span></div>
      ${weeklyTable(r,buf)}<textarea class="csvbox" id="csvOut" hidden aria-label="CSV output"></textarea></section>
    <section class="card"><div class="card-h"><div class="t"><h2>Where the cash goes</h2><p>Totals over the 13 weeks</p></div></div>
      ${(()=>{const mx=Math.max(...cats.map(c=>Math.abs(c.amount)),1);return`<div class="cfbars">${cats.map(c=>{const w=Math.abs(c.amount)/mx*50;return`<div class="cfrow"><span class="lab">${esc(c.cat)}</span><span class="bar"><i style="${c.amount>=0?`left:50%;width:${w}%`:`left:${50-w}%;width:${w}%`};background:var(${c.amount>=0?"--pos":"--neg"})"></i><span class="mid"></span></span><span class="v num ${c.amount>=0?"up-good":"up-bad"}">${c.amount>=0?"+":""}${money(c.amount)}</span></div>`;}).join("")}</div>`;})()}
      <div class="sumrow" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px"><span>Lowest balance by scenario</span><b></b></div>
      ${["worst","expected","best"].map(s=>`<div class="sumrow"><span style="display:inline-flex;align-items:center;gap:6px"><i class="dot" style="background:var(${SC[s].color})"></i>${SC[s].name}</span><b class="num ${all[s].low.closing<0?"up-bad":""}">${money(all[s].low.closing)} · ${fmtDayMonth(all[s].low.start)}</b></div>`).join("")}
      <p class="note" style="margin:10px 0 0">Card takings settle 2 business days later net of the ${pct(DS.weekly.mdr,1)} fee, cash is banked on Mondays, and each customer pays at their recent average lateness. Bills from unverified payees are held.</p></section>
  </div></div>`;
}

/* ---------- Activity log (owner) ---------- */
const AUDIT_TXT={login:"Signed in",login_failed:"Sign-in failed",state_saved:"Saved changes",state_reset:"Reset to dataset",access_denied:"Refused: another business",write_denied:"Refused: role can't change figures"};
function vActivity(){
  return topbar("")+`<section class="card"><div class="card-h"><div class="t"><h2>Recent activity</h2><p>Newest first. Stored on the server; nobody can edit it from the app.</p></div></div><div id="auditList"><p class="note">Loading…</p></div></section>`;
}
async function loadActivity(){
  const el=document.getElementById("auditList");if(!el)return;
  try{
    const {entries}=await api(`/api/businesses/${DS.business.id}/audit`);
    el.innerHTML=entries.length?`<div class="tw"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${entries.map(e=>`<tr><td class="muted">${esc(e.at.replace("T"," ").slice(0,16))}</td><td>${esc(e.userId||"—")}</td><td>${(e.type.includes("denied")||e.type.includes("failed"))?badge("neg",AUDIT_TXT[e.type]||e.type):esc(AUDIT_TXT[e.type]||e.type)}</td><td class="muted">${esc(e.changed?e.changed.join(", "):e.target?`asked for ${e.target}`:e.role||"")}</td></tr>`).join("")}</tbody></table></div>`:`<p class="note">No activity yet.</p>`;
  }catch(e){el.innerHTML=`<p class="note">${esc(e.message)}</p>`;}
}

/* ---------- Sign-in and boot ---------- */
async function showLogin(msg){
  let users=[];try{users=(await api("/api/users")).users;}catch(e){}
  document.getElementById("app").outerHTML=`<main class="login" id="login"><form class="card" id="loginForm" novalidate>
    <div class="brand dark"><span class="mark">${ic("chart",18,2).replace('stroke="currentColor"','stroke="#fff"')}</span>Fintellect</div>
    <h1>Sign in</h1><p class="note">Demo accounts from the sample dataset. Each one only sees its own business.</p>
    <fieldset class="users"><legend class="flabel">Account</legend>${users.map((u,i)=>`<label class="user"><input type="radio" name="uid" value="${esc(u.id)}"${i===0?" checked":""}><span><b>${esc(u.name)}</b><small>${esc(ROLE_NAMES[u.role]||u.role)} · ${esc(u.business||"")}</small></span></label>`).join("")}</fieldset>
    <div class="field"><label for="pass">Passcode</label><span class="inp"><input id="pass" type="password" autocomplete="current-password" required></span><span class="note">The demo passcode is in the README.</span></div>
    <p class="err" id="loginErr" role="alert">${msg?esc(msg):""}</p>
    <button class="btn pri" type="submit">Sign in</button></form></main>`;
  document.getElementById("loginForm").addEventListener("submit",async ev=>{
    ev.preventDefault();
    const uid=document.querySelector('input[name="uid"]:checked')?.value,pass=document.getElementById("pass").value;
    try{await api("/api/login",{method:"POST",body:JSON.stringify({userId:uid,passcode:pass})});location.reload();}
    catch(e){document.getElementById("loginErr").textContent=e.message;}
  });
}
async function boot(){
  let me;
  try{me=(await api("/api/me")).user;}catch(e){return showLogin();}
  let b;
  try{b=await api(`/api/businesses/${encodeURIComponent(me.businessId)}/bootstrap`);}catch(e){return showLogin(e.message);}
  DS=b.dataset;USER=b.user;MONTHS=DS.months;KC=DS.keyCustomer.short;ASSIST=!!b.assistant;CHAT=loadChat();
  S=buildState(b.saved);lastSaved=dataSnapshot();recompute();
  document.title=`Fintellect · ${DS.business.name}`;
  route=VIEWS[location.hash.slice(1)]?location.hash.slice(1):"dashboard";
  if(DS.limited&&!["dashboard","glossary","activity"].includes(route))route="dashboard";
  render();
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(drawAll);
}
boot();

/* ---------- Limited-data businesses ---------- */
function vLimited(){
  CHARTS.length=0;
  CHARTS.push({id:"chBank",cfg:{title:"Month-end bank balance",h:220,labels:MONTHS.map(k=>ms(k)),hl:MONTHS.length-1,series:[{name:"Bank balance",color:"--brand",area:true,values:MONTHS.map(k=>DS.bank[k])}],tipKeys:MONTHS.map(ml)}});
  const custs=DS.customers.filter(c=>c.outstanding>0);
  return topbar("")+`<div class="stack">
  <section class="card attn"><div class="card-h"><div class="t"><h2>Only bank and invoice records so far</h2><p>${esc(DS.business.legal)} has ${MONTHS.length} months of bank statement and ${DS.customers.length?"a few invoices":"no invoices"}. Add POS sales, supplier bills and payroll to see profit, statements and forecasts.</p></div></div></section>
  <section class="grid g2">
    <div class="card kpi"><div class="kpi-h"><span class="chip-ic">${ic("wallet",18)}</span><span class="l">Bank balance</span>${info("cash")}</div><div class="kpi-v num">${money(DS.bank[MONTHS[MONTHS.length-1]])}</div><div class="kpi-f">at ${fmtDate(DS.asof)}</div></div>
    <div class="card kpi"><div class="kpi-h"><span class="chip-ic">${ic("clock",18)}</span><span class="l">Owed by customers</span>${info("ar")}</div><div class="kpi-v num">${money(custs.reduce((a,c)=>a+c.outstanding,0))}</div><div class="kpi-f">${money(custs.reduce((a,c)=>a+c.overdue,0))} overdue</div></div>
  </section>
  <section class="card"><div class="card-h"><div class="t"><h2>Bank balance</h2><p>Month end, from the bank statement</p></div></div><div class="chart" id="chBank"></div></section>
  </div>`;
}

/* ---------- Transactions ---------- */
const TX_TXT=Object.fromEntries(TXN_KINDS);
const allCats=()=>[...S.cats.rev,...S.cats.cogs,...S.cats.opex];
const catName=id=>(allCats().find(c=>c.id===id)||{}).name||id||"";
// Categories a transaction type can use: revenue for income, cost of goods and cash operating costs for spending.
function txCatOpts(kind){
  if(!txnNeedsCategory(kind))return[];
  if(txnIsIncome(kind))return S.cats.rev.map(c=>[c.id,c.name]);
  return[...S.cats.cogs.filter(c=>c.id!=="stock").map(c=>[c.id,"Cost of goods · "+c.name]),...S.cats.opex.filter(c=>c.type!=="NONCASH").map(c=>[c.id,"Expense · "+c.name])];
}
const txFirst=()=>MONTHS[0]+"-01";
function txStatus(t){
  if(!txnHasDue(t.kind))return badge("neu","Paid");
  if(!t.paidOn)return badge("warn",t.kind==="invoice"?"Not paid yet":"Not paid yet");
  return badge("pos","Paid "+fmtDate(t.paidOn));
}
function vTransactions(){
  const all=(S.txns||[]).slice().sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0);
  const f=S.ui.txMonth,list=f==="all"?all:all.filter(t=>t.date.slice(0,7)===f);
  const kind=S.ui.txKind,cats=txCatOpts(kind),w=canWrite();
  const tot=txnTotalsByMonth(S.txns),months=Object.keys(tot).sort().reverse();
  const sumIn=list.filter(t=>txnIsIncome(t.kind)).reduce((a,t)=>a+t.amount,0),sumOut=list.filter(t=>["expense","bill","equipment"].includes(t.kind)).reduce((a,t)=>a+t.amount,0);
  const ctrls=selectBox("txMonth",[["all","All months"],...monthOpts()],f,"Show month")+`<button class="btn" data-act="txExport"${all.length?"":" disabled"}>${ic("download",16)}Export CSV</button>`;
  const form=w?`<section class="card"><div class="card-h"><div class="t"><h2>Add a transaction</h2><p>Amounts exclude GST. Dates from ${fmtDate(txFirst())} to ${fmtDate(DS.asof)}, the period your books cover.</p></div></div>
    <div class="form" id="txForm">
      <div class="field"><label for="txKind">Type</label><span class="inp"><select id="txKind">${TXN_KINDS.map(([v,t])=>`<option value="${v}"${v===kind?" selected":""}>${esc(t)}</option>`).join("")}</select></span></div>
      <div class="field"><label for="txDate">Date</label><span class="inp"><input id="txDate" type="date" min="${txFirst()}" max="${DS.asof}" value="${DS.asof}"></span></div>
      ${cats.length?`<div class="field"><label for="txCat">Category</label><span class="inp"><select id="txCat">${cats.map(([v,t])=>`<option value="${esc(v)}">${esc(t)}</option>`).join("")}</select></span></div>`:""}
      <div class="field"><label for="txAmt">Amount</label><span class="inp"><span class="pre">S$</span><input id="txAmt" class="r" inputmode="decimal" placeholder="0.00"></span></div>
      <div class="field${txnHasDue(kind)?"":" wide"}"><label for="txDesc">Description <span class="muted">(optional)</span></label><span class="inp"><input id="txDesc" maxlength="120" placeholder="${txnIsIncome(kind)?"e.g. Office lunch order, Tanjong Corp":"e.g. Flour delivery, Fresh Farm"}"></span></div>
      ${txnHasDue(kind)?`<div class="field"><label for="txPaid">Paid on <span class="muted">(leave empty if not paid yet)</span></label><span class="inp"><input id="txPaid" type="date" min="${txFirst()}"></span></div>`:""}
    </div>
    <p class="err" id="txErr" role="alert"></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn pri" data-act="addTxn">${ic("plus",16)}Add transaction</button></div>
    <p class="note" style="margin-top:10px">${esc(txHelp(kind))}</p></section>
  <section class="card"><div class="card-h"><div class="t"><h2>Import from a spreadsheet</h2><p>Upload a CSV file with the columns <code>date, type, category, amount, description, paid_on</code>. Use the category names shown above.</p></div><button class="btn sm" data-act="txTemplate">${ic("download",15)}Template</button></div>
    <label class="btn" style="cursor:pointer">${ic("upload",16)}Choose CSV file<input type="file" id="txFile" accept=".csv,text/csv" hidden></label>
    <div id="txImport" aria-live="polite"></div></section>`
  :`<section class="card attn"><div class="card-h"><div class="t"><h2>View only</h2><p>Your role can see recorded transactions but not add or remove them.</p></div></div></section>`;
  const rows=list.map(t=>`<tr><td class="muted" style="white-space:nowrap">${fmtDate(t.date)}</td><td>${esc(TX_TXT[t.kind])}</td><td>${esc(t.category?catName(t.category):"—")}${t.description?`<small style="display:block;color:var(--text-3)">${esc(t.description)}</small>`:""}</td><td>${txStatus(t)}</td><td class="n ${txnIsIncome(t.kind)?"up-good":""}">${t.amount.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td style="width:40px">${w?`<button class="icon-btn sm" data-act="delTxn" data-id="${esc(t.id)}" aria-label="Delete transaction">${ic("trash",15)}</button>`:""}</td></tr>`).join("");
  return topbar(ctrls)+`<div class="split"><div class="stack">${form}
  <section class="card"><div class="card-h"><div class="t"><h2>Recorded transactions</h2><p>${list.length} ${list.length===1?"transaction":"transactions"}${f==="all"?"":" in "+ml(f)} · ${money(sumIn)} income · ${money(sumOut)} spending</p></div></div>
  ${list.length?`<div class="tw"><table><thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Status</th><th class="n">S$</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`:`<p class="note">No transactions recorded${f==="all"?" yet":" in "+ml(f)}. ${w?"Add one above or import a CSV file.":""}</p>`}</section></div>
  <aside class="card" style="position:sticky;top:110px"><div class="card-h"><div class="t"><h2>Effect on your books</h2><p>Recorded transactions by month</p></div></div>
  ${months.length?months.map(k=>`<div class="sumrow"><span>${ml(k)} · ${tot[k].count}</span><b class="num">+${money(tot[k].income)} / −${money(tot[k].spend)}</b></div>`).join(""):`<p class="note">Nothing recorded yet.</p>`}
  ${bankCheck()}
  <p class="note" style="margin-top:12px">Each transaction adds to its month on top of the figures from your records, so it flows into the statements, dashboard and forecast. Only record transactions that are missing from the original records, or they'll be counted twice.</p></aside></div>`;
}
function txHelp(k){return{
  sale:"A sale paid on the day: adds to revenue and cash.",
  invoice:"Revenue counts on the invoice date. The amount sits in receivables until the paid date, when it reaches the bank.",
  expense:"A cost paid on the day: reduces profit and cash.",
  bill:"The cost counts on the bill date. The amount sits in payables until the paid date, when it leaves the bank.",
  equipment:"Equipment bought: cash goes down and the asset goes on the balance sheet. Depreciation isn't added automatically.",
  loan:"Money borrowed: cash and the loan balance go up.",repayment:"Loan principal repaid: cash and the loan balance go down. Record interest as an expense.",
  owner_in:"Money the owner puts in: cash and equity go up.",drawings:"Money the owner takes out: cash and equity go down. Not an expense."}[k]||"";}
function bankCheck(){const h=H[H.length-1],b=DS.bank[h.k];if(b==null)return"";
  return Math.abs(b-h.cash)<1?`<div class="check ok">${ic("check",16)}<span>${ml(h.k)} closing cash still matches the bank statement</span></div>`:`<div class="check warn">${ic("alert",16)}<span>${ml(h.k)} closing cash is ${money(h.cash)}; the bank statement shows ${money(b)}. Expected if these transactions aren't in the bank records yet.</span></div>`;}
function addTxn(){
  const v=id=>(document.getElementById(id)||{}).value||"",err=document.getElementById("txErr");
  const kind=v("txKind"),date=v("txDate"),amount=Math.round(parseFloat(v("txAmt").replace(/[^\d.]/g,""))*100)/100,paidOn=v("txPaid");
  const fail=m=>{err.textContent=m;};
  if(!date||date<txFirst()||date>DS.asof)return fail(`Pick a date from ${fmtDate(txFirst())} to ${fmtDate(DS.asof)}.`);
  if(!(amount>0))return fail("Enter an amount above zero.");
  if(paidOn&&paidOn<date)return fail("The paid date can't be before the transaction date.");
  const t={id:"t"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),date,kind,amount};
  if(txnNeedsCategory(kind))t.category=v("txCat");
  const d=v("txDesc").trim();if(d)t.description=d.slice(0,120);
  if(txnHasDue(kind)&&paidOn)t.paidOn=paidOn;
  S.txns=[...(S.txns||[]),t];commit();toast(`${TX_TXT[kind]} of ${money(amount)} added to ${ml(date.slice(0,7))}`);
}
function importTxns(file){
  const out=document.getElementById("txImport");
  if(file.size>1e6){out.innerHTML=`<div class="check bad">${ic("alert",16)}<span>That file is larger than 1 MB.</span></div>`;return;}
  const rd=new FileReader();
  rd.onload=()=>{
    const{rows,errors}=parseTxnCsv(rd.result,S.cats);
    const ok=rows.filter(r=>r.date>=txFirst()&&r.date<=DS.asof),late=rows.length-ok.length;
    if(late)errors.push(`${late} ${late===1?"row is":"rows are"} outside ${fmtDate(txFirst())} – ${fmtDate(DS.asof)} and ${late===1?"was":"were"} skipped`);
    if((S.txns||[]).length+ok.length>5000){out.innerHTML=`<div class="check bad">${ic("alert",16)}<span>That would go over the 5,000 transaction limit.</span></div>`;return;}
    const stamp=Date.now().toString(36);
    if(ok.length){S.txns=[...(S.txns||[]),...ok.map((r,i)=>({id:`t${stamp}${i.toString(36)}`,...r,description:r.description||undefined}))];commit();}
    const box=document.getElementById("txImport");if(!box)return;
    box.innerHTML=(ok.length?`<div class="check ok">${ic("check",16)}<span>Imported ${ok.length} ${ok.length===1?"transaction":"transactions"}.</span></div>`:"")+
      (errors.length?`<div class="check warn">${ic("alert",16)}<span>${errors.length} ${errors.length===1?"problem":"problems"}:<br>${errors.slice(0,8).map(esc).join("<br>")}${errors.length>8?`<br>…and ${errors.length-8} more`:""}</span></div>`:"");
  };
  rd.readAsText(file);
}
const csvCell=v=>{const s=String(v??"");return/[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
function download(name,text){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type:"text/csv"}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);}
function txCsv(list){return"date,type,category,amount,description,paid_on\n"+list.map(t=>[t.date,t.kind,t.category?catName(t.category):"",t.amount,t.description||"",t.paidOn||""].map(csvCell).join(",")).join("\n");}

/* ---------- Financial model ---------- */
const mBase=()=>{const L12=H.slice(-12),last=H[H.length-1];return{L12,last,ebitdaL12:L12.reduce((a,h)=>a+h.op+h.dep,0)};};
const modelRows=sc=>threeStatement(forecast(S,H,sc,36),H[H.length-1]);
function actualYear(L12){const s=f=>L12.reduce((a,h)=>a+h[f],0),last=L12[L12.length-1];
  return{rev:s("rev"),pos:s("pos"),b2b:s("b2b"),oneRev:0,cogs:s("cogs"),gross:s("gross"),opexCash:s("opex")-s("dep"),dep:s("dep"),ebitda:s("op")+s("dep"),op:s("op"),interest:s("interest"),tax:s("tax"),np:s("np"),
    cfo:s("cfo"),cfi:s("cfi"),cff:s("cff"),capex:s("capex")-s("assetSale"),loansIn:s("loanIn"),principal:s("loanRepay"),equityIn:s("ownerIn"),drawings:s("drawings"),otherPay:0,openCash:L12[0].openCash,
    cash:last.cash,ar:last.ar,inv:last.inv,oca:last.oca,deposit:last.deposit,equip:last.equip,ap:last.ap,ocl:last.ocl,loan:last.loan,equity:last.equity,curAssets:last.curAssets,assets:last.assets,liab:last.liab};}
function modelLines(tab){
  const L=(label,f,o={})=>({label,f,...o});
  if(tab==="pl")return[L("Café sales",c=>c.pos),L("Catering & wholesale",c=>c.b2b),L("One-off revenue",c=>c.oneRev),L("Revenue",c=>c.rev,{sub:1,term:"revenue"}),
    L("Cost of goods sold",c=>-c.cogs,{term:"cogs"}),L("Gross profit",c=>c.gross,{sub:1,term:"gross"}),L("Gross margin",c=>c.rev?c.gross/c.rev:null,{ratio:1}),
    L("Operating expenses (excl. depreciation)",c=>-c.opexCash,{term:"opex"}),L("EBITDA",c=>c.ebitda,{sub:1,term:"ebitda"}),L("Depreciation",c=>-c.dep,{term:"dep"}),L("Operating profit",c=>c.op,{sub:1,term:"op"}),
    L("Loan interest",c=>-c.interest),L("Corporate tax",c=>-c.tax,{term:"cit"}),L("Net profit",c=>c.np,{total:1,term:"np"}),L("Net margin",c=>c.rev?c.np/c.rev:null,{ratio:1})];
  if(tab==="cf")return[{grp:"Operating activities"},L("Net profit",c=>c.np),L("Add back depreciation",c=>c.dep),L("Working capital & taxes payable",c=>c.cfo-c.np-c.dep),L("Cash from operations",c=>c.cfo,{sub:1,term:"ocf"}),
    {grp:"Investing activities"},L("Equipment",c=>-c.capex),L("Cash from investments",c=>c.cfi,{sub:1,term:"icf"}),
    {grp:"Financing activities"},L("Loans received",c=>c.loansIn),L("Loan repayments",c=>-c.principal),L("Owner money in",c=>c.equityIn),L("Owner drawings",c=>-c.drawings,{term:"draw"}),L("Other planned payments",c=>-c.otherPay),L("Cash from financing",c=>c.cff,{sub:1,term:"fcf"}),
    L("Net change in cash",c=>c.cash-c.openCash,{sub:1}),L("Opening cash",c=>c.openCash),L("Closing cash",c=>c.cash,{total:1,term:"cash"})];
  return[{grp:"Assets"},L("Cash",c=>c.cash,{term:"cash"}),L("Accounts receivable",c=>c.ar,{term:"ar"}),L("Inventory",c=>c.inv,{term:"inv"}),L("Settlements in transit & prepayments",c=>c.oca,{term:"oca"}),L("Current assets",c=>c.curAssets,{sub:1}),
    L("Rental deposit",c=>c.deposit),L("Equipment, net",c=>c.equip),L("Total assets",c=>c.assets,{total:1}),
    {grp:"Liabilities & equity"},L("Accounts payable",c=>c.ap,{term:"ap"}),L("GST, CPF & tax payable",c=>c.ocl,{term:"ocl"}),L("Loans",c=>c.loan,{term:"loan"}),L("Total liabilities",c=>c.liab,{sub:1}),
    L("Equity",c=>c.equity,{term:"equity"}),L("Total liabilities & equity",c=>c.liab+c.equity,{total:1,term:"bs"})];
}
function modelTable(tab,cols){
  let t=`<div class="tw"><table class="mtbl"><thead><tr><th>S$</th>${cols.map(c=>`<th class="n">${c.head}</th>`).join("")}</tr></thead><tbody>`;
  modelLines(tab).forEach(r=>{
    if(r.grp){t+=`<tr class="grp"><td colspan="${cols.length+1}">${esc(r.grp)}</td></tr>`;return;}
    const cls=r.total?"total":r.sub?"sub":r.ratio?"ratio":"line";
    t+=`<tr class="${cls}"><td>${esc(r.label)}${r.term&&G[r.term]?" "+info(r.term):""}</td>${cols.map(c=>{const v=r.f(c.d);return`<td class="n${c.act?" muted":""}">${r.ratio?pct(v):full(v)}</td>`;}).join("")}</tr>`;
  });
  return t+"</tbody></table></div>";
}
function vModel(){
  const sc=S.ui.scenario,tab=S.ui.mTab,view=S.ui.mView,yr=S.ui.mYear||1;
  const{L12,last,ebitdaL12}=mBase(),M=modelRows(sc),Y=annualize(M),A=actualYear(L12);
  const val=valuation(M,S.model,{cash:last.cash,loan:last.loan,ebitdaL12});
  const yLabel=(y,i)=>`Year ${i+1}<small style="display:block;font-weight:500;color:var(--text-3)">${ms(y.from)} – ${msy(y.to)}</small>`;
  const ctrls=segBtns("scenario",[["worst","Worst","--neg"],["expected","Expected","--fc"],["best","Best","--pos"]],sc)+`<button class="btn" data-act="modelCsv">${ic("copy",16)}Copy CSV</button>`;
  const kpis=[["Year 1 revenue",money(Y[0].rev),`${sgnPct(chg(Y[0].rev,A.rev))} vs last 12 months`],["Year 1 net profit",money(Y[0].np),`${pct(Y[0].rev?Y[0].np/Y[0].rev:0)} net margin`],
    ["Cash at end of year 3",money(Y[2].cash),Y.some(y=>y.cash<0)||M.some(r=>r.cash<0)?`Goes below zero in ${ml((M.find(r=>r.cash<0)||{}).k||Y[2].to)}`:`Lowest ${money(Math.min(...M.map(r=>r.cash)))}`],
    ["Business value (DCF)",val.valid&&val.equity>0?money(val.equity):"Not meaningful",val.valid&&val.equity>0?`Multiple method: ${money(Math.max(0,val.equityMult))}`:"Cash flows are too low or negative"]];
  let body;
  if(tab==="be")body=vBreakEven(M,L12);
  else if(tab==="val")body=vValuation(M,val,last,ebitdaL12);
  else{
    const cols=view==="annual"?[{head:`Last 12 mo<small style="display:block;font-weight:500;color:var(--text-3)">Actual</small>`,d:A,act:1},...Y.map((y,i)=>({head:yLabel(y,i),d:y}))]
      :M.slice((yr-1)*12,yr*12).map(r=>({head:ms(r.k)+`<small style="display:block;font-weight:500;color:var(--text-3)">${r.k.slice(0,4)}</small>`,d:r}));
    const maxErr=Math.max(...M.map(r=>Math.abs(r.check)));
    body=`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">${segBtns("mView",[["annual","By year"],["monthly","By month"]],view)}${view==="monthly"?segBtns("mYear",Y.map((y,i)=>[i+1,"Year "+(i+1)]),yr):""}</div>`+modelTable(tab,cols)+
      (tab==="bs"?`<div class="check ${maxErr<1?"ok":"bad"}">${ic(maxErr<1?"check":"alert",16)}<span>${maxErr<1?"Balances in every forecast month: assets = liabilities + equity":"Out of balance by "+money(maxErr)}</span></div>`:"")+
      `<p class="note" style="margin-top:10px">${esc(MODEL_NOTES[tab])}</p>`;
  }
  return topbar(ctrls)+`<div class="stack">
  <section class="grid g4">${kpis.map(([l,v,f])=>`<div class="card kpi"><div class="kpi-h"><span class="l">${l}</span></div><div class="kpi-v num" style="font-size:26px">${v}</div><div class="kpi-f">${esc(f)}</div></div>`).join("")}</section>
  <section class="card"><div class="card-h"><div class="t"><h2>${{pl:"Profit & loss",cf:"Cash flow",bs:"Balance sheet",be:"Break-even & unit economics",val:"Valuation"}[tab]}</h2><p>${SC[sc].name} case · forecast from ${ml(M[0].k)} to ${ml(M[M.length-1].k)}, using your assumptions and planned events</p></div></div>
  <div style="margin-bottom:14px">${segBtns("mTab",[["pl","Profit & loss"],["cf","Cash flow"],["bs","Balance sheet"],["be","Break-even"],["val","Valuation"]],tab)}</div>${body}</section></div>`;
}
const MODEL_NOTES={
  pl:"Revenue, costs and growth come from the Assumptions page. Fixed costs rise each January by the scenario's cost increase; card fees follow café sales.",
  cf:"Working capital covers customer invoices not yet paid and GST, CPF and tax owed but not yet paid. Other planned payments are payment events that aren't GST or tax, such as an owner withdrawal.",
  bs:"Starts from your last actual balance sheet. Stock, prepayments, the rental deposit and supplier payables stay at their last actual level; the other lines move with the forecast's cash flows."};
function vBreakEven(M,L12){
  const varIds=S.cats.opex.filter(c=>c.type==="VARIABLE").map(c=>c.id),a=breakEvenActual(L12,varIds),f=breakEvenForecast(M.slice(0,12));
  const row=(l,fa,ff,fmt=money,term)=>`<tr class="line"><td>${l}${term?" "+info(term):""}</td><td class="n">${fmt(fa)}</td><td class="n">${fmt(ff)}</td></tr>`;
  const sumL=f=>L12.reduce((x,h)=>x+h[f],0),cat=id=>L12.reduce((x,h)=>x+(h.opexCat[id]||0),0),rev=sumL("rev"),staff=DS.business.staff||0;
  CHARTS.push({id:"chBE",cfg:{title:"Monthly revenue against break-even",h:220,labels:M.slice(0,12).map(r=>ms(r.k)),tipKeys:M.slice(0,12).map(r=>ml(r.k)),refLine:{v:f.beM,label:"Break-even "+money(f.beM)},
    series:[{name:"Revenue",type:"bar",values:M.slice(0,12).map(r=>r.rev),colorAt:(i,v)=>v>=f.beM?"--pos":"--neg"}]}});
  const units=[["Average café sales per day",money(sumL("pos")/365)],["Average catering & wholesale per month",money(sumL("b2b")/12)],["Gross margin",pct(rev?sumL("gross")/rev:0)],
    ["Contribution per S$100 of sales",money(a.cmr*100,2)],["Staff costs (salaries + CPF)",pct(rev?(cat("sal")+cat("cpf"))/rev:0)+" of revenue"],["Rent",pct(rev?cat("rent")/rev:0)+" of revenue"],
    ...(staff?[["Revenue per employee per year",money(rev/staff)]]:[])];
  return`<div class="split eq" style="gap:18px"><div><div class="tw"><table><thead><tr><th>Per month, average</th><th class="n">Last 12 mo<small style="display:block;font-weight:500;color:var(--text-3)">Actual</small></th><th class="n">Year 1<small style="display:block;font-weight:500;color:var(--text-3)">${SC[S.ui.scenario].name}</small></th></tr></thead><tbody>
    ${row("Revenue",a.revM,f.revM)}${row("Variable costs",a.variableM,f.variableM)}${row("Contribution margin",a.cmr,f.cmr,v=>pct(v))}${row("Fixed costs",a.fixedM,f.fixedM)}
    <tr class="sub"><td>Break-even revenue</td><td class="n">${money(a.beM)}</td><td class="n">${money(f.beM)}</td></tr>${row("Break-even sales per day",a.beDay,f.beDay)}${row("Margin of safety",a.safety,f.safety,v=>pct(v))}
    <tr class="total"><td>Profit before tax</td><td class="n">${full(a.profitM)}</td><td class="n">${full(f.profitM)}</td></tr></tbody></table></div>
    <p class="note" style="margin-top:10px">Variable costs move with sales: cost of goods and card fees. Fixed costs don't: staff, rent, utilities, depreciation and loan interest. Break-even is the monthly revenue where profit before tax is zero. Margin of safety is how far revenue can fall before the business makes a loss.</p></div>
    <div><h3 style="font-size:14px;margin:0 0 8px">Unit economics · last 12 months</h3>${units.map(([l,v])=>`<div class="sumrow"><span>${l}</span><b class="num">${v}</b></div>`).join("")}
    <h3 style="font-size:14px;margin:18px 0 8px">Year 1 revenue against break-even</h3><div class="chart" id="chBE"></div></div></div>`;
}
function vValuation(M,v,last,ebitdaL12){
  const m=S.model,w=canWrite();
  const inp=(k,l,suf,step,pre)=>`<div class="field"><label for="mv-${k}">${l}</label><span class="inp">${pre?`<span class="pre">${pre}</span>`:""}<input class="r" type="number" id="mv-${k}" data-model="${k}" step="${step}" value="${m[k]}"><span class="suf">${suf}</span></span></div>`;
  const bySc=["worst","expected","best"].map(sc=>[sc,sc===S.ui.scenario?v:valuation(modelRows(sc),m,{cash:last.cash,loan:last.loan,ebitdaL12})]);
  const eqTxt=x=>x.valid&&x.equity>0?money(x.equity):"Not meaningful";
  const line=(l,val,cls="line")=>`<tr class="${cls}"><td>${l}</td><td class="n">${full(val)}</td></tr>`;
  return`<div class="split eq" style="gap:18px"><div>
    <div class="form" style="margin-bottom:6px">${inp("discount","Discount rate","% a year",0.5)}${inp("growth","Long-term growth","% a year",0.5)}${inp("multiple","EBITDA multiple","×",0.5)}${inp("ownerPay","Market salary for the owner","/ month",100,"S$")}</div>
    <p class="note">${w?"":"Changes here aren't saved for your role. "}The owner is paid through drawings, so a market salary is deducted first, as a buyer would have to pay someone to run the business. Small private businesses are usually valued with a discount rate of 15–25% and at 2–4× EBITDA.</p>
    <h3 style="font-size:14px;margin:16px 0 8px">Value in each scenario</h3>
    <div class="tw"><table><thead><tr><th></th><th class="n">Discounted cash flow</th><th class="n">EBITDA multiple</th></tr></thead><tbody>${bySc.map(([sc,x])=>`<tr class="line"><td><span style="display:inline-flex;align-items:center;gap:6px;font-weight:600"><i class="dot" style="background:var(${SC[sc].color})"></i>${SC[sc].name}</span></td><td class="n">${eqTxt(x)}</td><td class="n">${money(Math.max(0,x.equityMult))}</td></tr>`).join("")}</tbody></table></div>
    ${v.valid&&v.tvShare>.75?`<div class="check warn">${ic("alert",16)}<span>${pct(v.tvShare,0)} of the DCF value comes after year 3, so it depends heavily on the growth assumptions holding.</span></div>`:""}
    <p class="note" style="margin-top:10px">An estimate for planning and conversations with lenders or buyers, not a formal valuation.</p></div>
  <div><h3 style="font-size:14px;margin:0 0 8px">Discounted cash flow · ${SC[S.ui.scenario].name}</h3><div class="tw"><table><tbody>
    ${line("Free cash flow, 36 months, after owner salary",M.reduce((a,r)=>a+r.fcf,0)-m.ownerPay*M.length)}${line("Present value of that cash flow",v.pvFcf)}
    ${line(`Value after year 3 (${m.growth}% growth a year)`,v.tv)}${line("Present value of that",v.pvTv)}${line("Enterprise value",v.ev,"sub")}
    ${line("Add cash",last.cash)}${line("Less loans",-last.loan)}${line("Equity value",v.equity,"total")}</tbody></table></div>
    <h3 style="font-size:14px;margin:18px 0 8px">EBITDA multiple</h3><div class="tw"><table><tbody>
    ${line("EBITDA, last 12 months",ebitdaL12)}${line("Less owner salary",-m.ownerPay*12)}${line("Adjusted EBITDA",v.ebitdaAdj,"sub")}${line(`× ${m.multiple} = enterprise value`,v.evMult)}
    ${line("Add cash, less loans",-v.netDebt)}${line("Equity value",v.equityMult,"total")}</tbody></table></div></div></div>`;
}
function modelCsv(){
  const sc=S.ui.scenario,M=modelRows(sc),Y=annualize(M),A=actualYear(H.slice(-12)),cols=[A,...Y];
  const out=[["S$","Last 12 months (actual)",...Y.map((y,i)=>`Year ${i+1} (${y.from} to ${y.to})`)].map(csvCell).join(",")];
  [["Profit & loss","pl"],["Cash flow","cf"],["Balance sheet","bs"]].forEach(([t,tab])=>{out.push(csvCell(t));modelLines(tab).forEach(r=>{if(r.grp){out.push(csvCell(r.grp));return;}out.push([r.label,...cols.map(c=>{const v=r.f(c);return v==null?"":r.ratio?(v*100).toFixed(1)+"%":Math.round(v);})].map(csvCell).join(","));});});
  return`Financial model, ${SC[sc].name} case, ${DS.business.legal}\n`+out.join("\n");
}

/* ---------- AI assistant ---------- */
let CHAT=[],chatBusy=false,chatDraft="";
const chatKey=()=>`fintellect-chat-${DS.business.id}-${USER.id}`;
function loadChat(){try{const c=JSON.parse(sessionStorage.getItem(chatKey())||"[]");return Array.isArray(c)?c.slice(-40):[];}catch(e){return[];}}
function saveChat(){try{sessionStorage.setItem(chatKey(),JSON.stringify(CHAT.slice(-40)));}catch(e){}}
const SUGGEST=()=>[`Why is cash expected to drop in November?`,`How much does ${KC} owe us, and how late do they pay?`,`What were our biggest expenses last quarter?`,`What monthly revenue do we need to break even?`,`Compare the worst and best case for the next 12 months`,`How did September compare with August?`];
// Minimal, safe Markdown: everything is escaped first, then a few patterns become tags.
const MD_BLOCK=/^\s*(\|.*\|\s*$|[-*•]\s+|\d+[.)]\s+|#{1,4}\s+)/;
function mdLite(src){
  const inline=s=>esc(s).replace(/\*\*(.+?)\*\*/g,"<b>$1</b>").replace(/`([^`]+)`/g,"<code>$1</code>");
  const lines=String(src).split("\n"),out=[];let i=0;
  while(i<lines.length){const l=lines[i];
    if(/^\s*\|.*\|\s*$/.test(l)){const rows=[];while(i<lines.length&&/^\s*\|.*\|\s*$/.test(lines[i]))rows.push(lines[i++]);
      const cells=r=>r.trim().replace(/^\||\|$/g,"").split("|").map(c=>c.trim());const body=rows.filter(r=>!/^\s*\|[\s:|-]+\|\s*$/.test(r));if(!body.length)continue;
      out.push(`<div class="tw"><table><thead><tr>${cells(body[0]).map(c=>`<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.slice(1).map(r=>`<tr>${cells(r).map(c=>`<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);continue;}
    if(/^\s*[-*•]\s+/.test(l)){const it=[];while(i<lines.length&&/^\s*[-*•]\s+/.test(lines[i]))it.push(lines[i++].replace(/^\s*[-*•]\s+/,""));out.push(`<ul>${it.map(x=>`<li>${inline(x)}</li>`).join("")}</ul>`);continue;}
    if(/^\s*\d+[.)]\s+/.test(l)){const it=[];while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i]))it.push(lines[i++].replace(/^\s*\d+[.)]\s+/,""));out.push(`<ol>${it.map(x=>`<li>${inline(x)}</li>`).join("")}</ol>`);continue;}
    if(/^#{1,4}\s+/.test(l)){out.push(`<h4>${inline(l.replace(/^#{1,4}\s+/,""))}</h4>`);i++;continue;}
    if(!l.trim()){i++;continue;}
    // A paragraph runs until a blank line or a line that starts another block; it always takes at least one line.
    const p=[lines[i++]];while(i<lines.length&&lines[i].trim()&&!MD_BLOCK.test(lines[i]))p.push(lines[i++]);out.push(`<p>${p.map(inline).join("<br>")}</p>`);}
  return out.join("");
}
function vAssistant(){
  if(!ASSIST)return topbar("")+`<section class="card attn"><div class="card-h"><div class="t"><h2>The AI assistant isn't set up yet</h2><p>It uses Claude, Anthropic's AI model, and needs an API key on the server.</p></div></div>
    <ol class="note" style="margin:0;padding-left:18px;line-height:1.7"><li>Create an API key at console.anthropic.com.</li><li>Add it to the server's environment as <code>ANTHROPIC_API_KEY</code> (in Vercel: Settings → Environment Variables).</li><li>Redeploy, then come back to this page.</li></ol></section>`;
  const msgs=CHAT.map(m=>`<div class="msg ${m.role==="user"?"me":"ai"}${m.error?" err":""}">${m.role==="user"?`<p>${esc(m.content).replace(/\n/g,"<br>")}</p>`:mdLite(m.content)}</div>`).join("");
  return topbar(CHAT.length?`<button class="btn" data-act="askClear">${ic("reset",16)}New chat</button>`:"")+`<section class="card chat">
    <div class="msgs" id="chatMsgs" aria-live="polite">${CHAT.length?msgs:`<div class="chat-empty"><span class="chip-ic">${ic("chat",20)}</span><h2>Ask about ${esc(DS.business.name)}'s finances</h2><p class="note">Answers use your statements, forecast and recorded transactions, up to ${fmtDate(DS.asof)}.</p>
      <div class="presets" style="justify-content:center;margin-top:14px">${SUGGEST().map((q,i)=>`<button class="pill" data-act="askSuggest" data-ix="${i}">${esc(q)}</button>`).join("")}</div></div>`}
      ${chatBusy?`<div class="msg ai busy"><p>Looking at your numbers…</p></div>`:""}</div>
    <form class="ask" id="askForm"><label class="inp"><textarea id="askInput" rows="2" maxlength="2000" placeholder="Ask a question, e.g. what drove the drop in profit in June?" aria-label="Your question"${chatBusy?" disabled":""}>${esc(chatDraft)}</textarea></label>
      <button class="btn pri" type="submit"${chatBusy?" disabled":""} aria-label="Send">${ic("send",16)}Ask</button></form>
    <p class="note" style="margin:8px 2px 0">Powered by Claude. It reads your business's figures but can't change them. Check important numbers in the statements; this isn't financial advice.</p></section>`;
}
function scrollChat(){const el=document.getElementById("chatMsgs");if(el)el.scrollTop=el.scrollHeight;const inp=document.getElementById("askInput");if(inp&&!chatBusy)inp.focus();}
async function askAI(q){
  q=String(q||"").trim();if(!q||chatBusy)return;
  CHAT.push({role:"user",content:q});chatDraft="";chatBusy=true;saveChat();render(true);scrollChat();
  try{
    const history=CHAT.filter(m=>!m.error).map(({role,content})=>({role,content}));
    const r=await api(`/api/businesses/${DS.business.id}/assistant`,{method:"POST",body:JSON.stringify({messages:history})});
    CHAT.push({role:"assistant",content:r.answer});
  }catch(e){CHAT.push({role:"assistant",content:e.message,error:true});}
  chatBusy=false;saveChat();if(route==="assistant"){render(true);scrollChat();}
}

/* ---------- Feature events ---------- */
const FEATURE_ACTS={
  addTxn:()=>addTxn(),
  delTxn:a=>{S.txns=(S.txns||[]).filter(t=>t.id!==a.dataset.id);commit();toast("Transaction deleted");},
  txTemplate:()=>download("transactions-template.csv",`date,type,category,amount,description,paid_on\n${DS.asof},sale,${csvCell(S.cats.rev[0]?.name||"")},250.00,Example walk-in order,\n${DS.asof},invoice,${csvCell((S.cats.rev.find(c=>c.group!==POS_GROUP)||S.cats.rev[0])?.name||"")},1200.00,Example catering invoice,\n${DS.asof},bill,${csvCell(S.cats.cogs[0]?.name||"")},480.00,Example supplier bill,${DS.asof}\n`),
  txExport:()=>download(`transactions-${DS.business.id}.csv`,txCsv((S.txns||[]).slice().sort((a,b)=>a.date<b.date?-1:1))),
  modelCsv:()=>copyText(modelCsv(),"Financial model"),
  askSuggest:a=>askAI(SUGGEST()[+a.dataset.ix]),
  askClear:()=>{CHAT=[];saveChat();render(true);},
};
function featureChange(t){
  if(t.id==="txKind"){S.ui.txKind=t.value;save();render(true);return true;}
  if(t.id==="txMonth"){S.ui.txMonth=t.value;save();render(true);return true;}
  if(t.id==="txFile"&&t.files&&t.files[0]){importTxns(t.files[0]);t.value="";return true;}
  if(t.dataset.model){const v=parseFloat(t.value),k=t.dataset.model,m={...S.model,[k]:isFinite(v)?v:0};
    const lim={discount:[0,100],growth:[-20,20],multiple:[0,50],ownerPay:[0,1e7]}[k];m[k]=Math.min(lim[1],Math.max(lim[0],m[k]));
    if(m.growth>=m.discount){toast("Long-term growth must be below the discount rate");render(true);return true;}
    S.model=m;commit();return true;}
  return false;
}
document.addEventListener("submit",e=>{if(e.target.id==="askForm"){e.preventDefault();askAI(document.getElementById("askInput").value);}});
document.addEventListener("keydown",e=>{if(e.target.id==="askInput"&&e.key==="Enter"&&!e.shiftKey){e.preventDefault();askAI(e.target.value);}});
document.addEventListener("input",e=>{if(e.target.id==="askInput")chatDraft=e.target.value;});
