/**
 * The review map as one self-contained HTML page: the model inlined as JSON, the style and the
 * script inlined beside it, nothing fetched. It opens from disk with a double click.
 *
 * **The diagram is a layered package diagram.** Each band is a layer of `docs/PRINCIPLES.md`,
 * pages at the top and the core at the bottom, so an import that follows the rules points down.
 * Each box is a component (a folder). An arrow is drawn for the selected box's imports in both
 * directions, and always for a red one, because forty folders with every arrow drawn is a hairball
 * that hides the one arrow that matters.
 *
 * **Drill-down is the side panel.** Select a box to list its files, select a file to list its
 * functions, worst CRAP first. A band folds away by its title.
 */

import type { Model } from "./model.js";

/** The bands, top to bottom. A layer not listed here goes to the last band, so nothing is dropped. */
const BANDS: { title: string; layers: string[] }[] = [
  { title: "Pages", layers: ["page:"] },
  { title: "Shared web and the command line", layers: ["web", "cli"] },
  { title: "Tooling, review and filesystem", layers: ["tooling", "review", "node"] },
  { title: "Hardware-test sheets", layers: ["sheet"] },
  { title: "Core: platform-free", layers: ["core"] },
];

/** `</script>` inside the JSON would end the script element early. */
function scriptSafe(json: string): string {
  return json.replaceAll("<", "\\u003c");
}

export function renderPage(model: Model, title: string): string {
  const data = scriptSafe(JSON.stringify({ model, bands: BANDS, title }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<&]/g, "")}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <p id="meta"></p>
  <ul id="summary" class="chips"></ul>
  <div class="tools">
    <label><input type="checkbox" id="changedOnly"> Changed only</label>
    <label><input type="checkbox" id="allArrows"> Every arrow</label>
    <input type="search" id="find" placeholder="Find a folder or file">
  </div>
</header>
<main>
  <section id="diagram" aria-label="Components by layer"><svg id="arrows" aria-hidden="true"></svg></section>
  <aside id="detail" aria-live="polite"><p class="hint">Select a box to see its files. Red is a wrong-way import or a CRAP score over the limit. Amber is a dependency on a less stable folder.</p></aside>
</main>
<script type="application/json" id="data">${data}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d232b;--dim:#5d6875;--line:#d4d9e0;--box:#fff;--red:#c62828;--red-wash:#fdecec;--amber:#b26a00;--amber-wash:#fff4e0;--accent:#1f6f8b;--changed:#2e7d32;--arrow:#8a96a3}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14181d;--panel:#1b2027;--ink:#e3e8ee;--dim:#97a3b0;--line:#323a45;--box:#212831;--red:#ff6b6b;--red-wash:#3a1f22;--amber:#f0a83a;--amber-wash:#3a2e1a;--accent:#5fb3cf;--changed:#6fcf75;--arrow:#6c7886}}
:root[data-theme="dark"]{--bg:#14181d;--panel:#1b2027;--ink:#e3e8ee;--dim:#97a3b0;--line:#323a45;--box:#212831;--red:#ff6b6b;--red-wash:#3a1f22;--amber:#f0a83a;--amber-wash:#3a2e1a;--accent:#5fb3cf;--changed:#6fcf75;--arrow:#6c7886}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:16px 20px 8px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{margin:0;font-size:1.25rem}
#meta{margin:2px 0 8px;color:var(--dim);font-size:.85rem}
.chips{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.chips li{padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-size:.8rem;font-variant-numeric:tabular-nums}
.chips .red{border-color:var(--red);color:var(--red);background:var(--red-wash)}
.chips .amber{border-color:var(--amber);color:var(--amber);background:var(--amber-wash)}
.tools{display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:.85rem}
.tools input[type=search]{min-width:14rem;padding:4px 8px;border:1px solid var(--line);border-radius:4px;background:var(--box);color:var(--ink)}
main{display:grid;grid-template-columns:minmax(0,1fr) minmax(18rem,26rem);gap:0;min-height:calc(100vh - 140px)}
@media (max-width:900px){main{grid-template-columns:1fr}}
#diagram{position:relative;padding:12px 20px 40px}
#arrows{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.band{margin:0 0 18px;position:relative;z-index:1}
.band>button{all:unset;cursor:pointer;display:block;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:0 0 6px}
.band>button:focus-visible{outline:2px solid var(--accent)}
.band.folded .boxes{display:none}
.boxes{display:flex;flex-wrap:wrap;gap:10px}
.box{all:unset;cursor:pointer;background:var(--box);border:1px solid var(--line);border-radius:6px;padding:6px 9px;min-width:8.5rem;max-width:15rem}
.box:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.box .name{display:block;font-weight:600;font-size:.82rem;word-break:break-all}
.box .facts{display:block;color:var(--dim);font-size:.72rem;font-variant-numeric:tabular-nums}
.box.red{border-color:var(--red);box-shadow:inset 3px 0 0 var(--red)}
.box.amber:not(.red){border-color:var(--amber);box-shadow:inset 3px 0 0 var(--amber)}
.box.changed .name::after{content:" ●";color:var(--changed)}
.box.sel{outline:2px solid var(--accent);outline-offset:2px}
.box.dim{opacity:.28}
.box.moved{border-style:dashed}
#detail{border-left:1px solid var(--line);background:var(--panel);padding:14px 16px;overflow:auto;max-height:calc(100vh - 140px);position:sticky;top:0}
#detail h2{margin:0 0 4px;font-size:1rem;word-break:break-all}
#detail .sub{color:var(--dim);font-size:.8rem;margin:0 0 10px}
#detail ul{list-style:none;margin:0;padding:0}
.file{border-top:1px solid var(--line);padding:6px 0}
.file>button{all:unset;cursor:pointer;display:flex;justify-content:space-between;gap:8px;width:100%;font-size:.82rem}
.file>button:focus-visible{outline:2px solid var(--accent)}
.file .path{word-break:break-all}
.file .badge{font-size:.72rem;color:var(--dim);white-space:nowrap;font-variant-numeric:tabular-nums}
.file.red .path{color:var(--red)}
.problem{color:var(--red);font-size:.78rem;margin:4px 0 0}
table{width:100%;border-collapse:collapse;margin:6px 0 2px;font-size:.76rem;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:2px 4px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500}
td.num,th.num{text-align:right}
tr.red td{color:var(--red)}
.hint{color:var(--dim);font-size:.85rem}
.edges li{font-size:.76rem;word-break:break-all;margin:2px 0}
.edges .red{color:var(--red)}.edges .amber{color:var(--amber)}
`;

const SCRIPT = `
"use strict";
const {model,bands,title}=JSON.parse(document.getElementById("data").textContent);
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const short=(id)=>id.replace(/^packages\\/core\\/src\\/?/,"core/").replace(/^web\\/src$/,"web (shared)").replace(/^web\\/src\\//,"web/");
const pct=(v)=>v===null?"not run":Math.round(v*100)+"%";
const byId=new Map(model.components.map((c)=>[c.id,c]));
const files=new Map(model.files.map((f)=>[f.path,f]));
let selected=null;

$("title").textContent=title;
$("meta").textContent=(model.coverage?"Coverage from this run. ":"Tests not run: no CRAP scores. ")+"CRAP limit "+model.crapLimit+"."+(model.moves.length?" What-if: "+model.moves.map(([a,b])=>a+" → "+b).join(", ")+".":"");
const s=model.summary;
$("summary").innerHTML=[
  ["red",s.red+" red folder"+(s.red===1?"":"s")],
  ["red",s.redFunctions+" function"+(s.redFunctions===1?"":"s")+" over the CRAP limit"],
  ["red",s.wrongImports+" wrong-way import"+(s.wrongImports===1?"":"s")],
  ["amber",s.amber+" amber folder"+(s.amber===1?"":"s")],
  ["",s.changedFiles+" changed file"+(s.changedFiles===1?"":"s")],
].map(([k,t])=>'<li class="'+(k&&parseInt(t)>0?k:"")+'">'+esc(t)+"</li>").join("");

function bandOf(layer){
  const i=bands.findIndex((b)=>b.layers.some((l)=>l.endsWith(":")?layer.startsWith(l):layer===l));
  return i<0?bands.length-1:i;
}
const diagram=$("diagram");
bands.forEach((band,i)=>{
  const comps=model.components.filter((c)=>bandOf(c.layer)===i);
  if(!comps.length)return;
  const el=document.createElement("div");el.className="band";el.dataset.band=i;
  el.innerHTML='<button type="button" aria-expanded="true">'+esc(band.title)+" · "+comps.length+'</button><div class="boxes"></div>';
  el.firstChild.addEventListener("click",()=>{el.classList.toggle("folded");el.firstChild.setAttribute("aria-expanded",String(!el.classList.contains("folded")));draw()});
  const holder=el.querySelector(".boxes");
  for(const c of comps){
    const b=document.createElement("button");b.type="button";b.className="box";b.dataset.id=c.id;
    if(c.red)b.classList.add("red");if(c.amber)b.classList.add("amber");if(c.changed)b.classList.add("changed");
    if(c.files.some((p)=>files.get(p).was))b.classList.add("moved");
    b.innerHTML='<span class="name">'+esc(short(c.id))+'</span><span class="facts">'+c.files.length+" file"+(c.files.length===1?"":"s")+" · I "+c.instability.toFixed(2)+" · "+c.churn+" commit"+(c.churn===1?"":"s")+"</span>";
    b.title=c.id;
    b.addEventListener("click",()=>select(c.id));
    holder.appendChild(b);
  }
  diagram.appendChild(el);
});

function visibleIds(){
  const only=$("changedOnly").checked,q=$("find").value.trim().toLowerCase();
  const ids=new Set();
  for(const c of model.components){
    let keep=true;
    if(only){
      const near=model.edges.some((e)=>(e.from===c.id&&byId.get(e.to)?.changed)||(e.to===c.id&&byId.get(e.from)?.changed));
      keep=c.changed||near;
    }
    if(keep&&q)keep=c.id.toLowerCase().includes(q)||c.files.some((p)=>p.toLowerCase().includes(q));
    if(keep)ids.add(c.id);
  }
  return ids;
}

function boxRect(id){
  const el=diagram.querySelector('.box[data-id="'+CSS.escape(id)+'"]');
  if(!el||el.offsetParent===null)return null;
  const r=el.getBoundingClientRect(),o=diagram.getBoundingClientRect();
  return {x:r.left-o.left,y:r.top-o.top,w:r.width,h:r.height};
}

function draw(){
  const show=visibleIds();
  diagram.querySelectorAll(".box").forEach((b)=>{b.classList.toggle("dim",!show.has(b.dataset.id));b.classList.toggle("sel",b.dataset.id===selected)});
  const all=$("allArrows").checked;
  const edges=model.edges.filter((e)=>e.wrong||all||e.from===selected||e.to===selected);
  const svg=$("arrows");
  svg.setAttribute("width",diagram.scrollWidth);svg.setAttribute("height",diagram.scrollHeight);
  let out='<defs>'+["arrow","red","amber"].map((k)=>'<marker id="m-'+k+'" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="var(--'+k+')"/></marker>').join("")+"</defs>";
  for(const e of edges){
    if(!show.has(e.from)&&!show.has(e.to))continue;
    const a=boxRect(e.from),b=boxRect(e.to);if(!a||!b)continue;
    const down=b.y>a.y+a.h/2, up=b.y+b.h<a.y+a.h/2;
    const x1=a.x+a.w/2,x2=b.x+b.w/2;
    const y1=down?a.y+a.h:up?a.y:a.y+a.h/2, y2=down?b.y:up?b.y+b.h:b.y+b.h/2;
    const bend=Math.max(30,Math.abs(y2-y1)/2)*(down?1:up?-1:0)||40;
    const kind=e.wrong?"red":e.unstable?"amber":"arrow";
    const faint=!(e.wrong||e.from===selected||e.to===selected);
    out+='<path d="M'+x1+","+y1+" C"+x1+","+(y1+bend)+" "+x2+","+(y2-bend)+" "+x2+","+y2+'" fill="none" stroke="var(--'+kind+')" stroke-width="'+(e.wrong?2.2:1.4)+'" opacity="'+(faint?.35:.95)+'" marker-end="url(#m-'+kind+')"/>';
  }
  svg.innerHTML=out;
}

function fileRow(f){
  const worst=f.functions.reduce((m,fn)=>fn.crap!==null&&fn.crap>m?fn.crap:m,0);
  const red=f.problems.length||f.functions.some((fn)=>fn.red);
  const li=document.createElement("li");li.className="file"+(red?" red":"");
  const name=f.path.slice(f.component.length+1)+(f.was?" (moved from "+f.was+")":"");
  li.innerHTML='<button type="button" aria-expanded="false"><span class="path">'+esc(name)+(f.changed?" ●":"")+'</span><span class="badge">'+(f.ran===false?"not run":f.ran===null?"":"worst CRAP "+worst.toFixed(0))+" · "+f.churn+" commit"+(f.churn===1?"":"s")+"</span></button>"+f.problems.map((p)=>'<p class="problem">'+esc(p)+"</p>").join("");
  const btn=li.firstChild;let open=false,table=null;
  btn.addEventListener("click",()=>{
    open=!open;btn.setAttribute("aria-expanded",String(open));
    if(open){
      const fns=[...f.functions].sort((x,y)=>(y.crap??-1)-(x.crap??-1)||y.complexity-x.complexity);
      table=document.createElement("table");
      table.innerHTML='<thead><tr><th>Function</th><th class="num">Line</th><th class="num">Cx</th><th class="num">Cov</th><th class="num">CRAP</th></tr></thead><tbody>'+fns.map((fn)=>'<tr class="'+(fn.red?"red":"")+'"><td>'+esc(fn.name)+'</td><td class="num">'+fn.line+'</td><td class="num">'+fn.complexity+'</td><td class="num">'+pct(fn.coverage)+'</td><td class="num">'+(fn.crap===null?"–":fn.crap.toFixed(0))+"</td></tr>").join("")+"</tbody>";
      li.appendChild(table);
    }else if(table){table.remove();table=null}
  });
  return li;
}

function select(id){
  selected=selected===id?null:id;
  const d=$("detail");
  if(!selected){history.replaceState(null,"",location.pathname);d.innerHTML='<p class="hint">Select a box to see its files.</p>';draw();return}
  const c=byId.get(id);
  d.innerHTML="<h2>"+esc(c.id)+'</h2><p class="sub">Layer '+esc(c.layer)+" · used by "+c.ca+" · uses "+c.ce+" · instability "+c.instability.toFixed(2)+" · "+c.churn+" commits in the window</p>";
  history.replaceState(null,"","#"+encodeURIComponent(id).replaceAll("%2F","/"));
  const out=model.edges.filter((e)=>e.from===id),into=model.edges.filter((e)=>e.to===id);
  const edgeList=(list,dir)=>list.length?'<p class="sub">'+dir+'</p><ul class="edges">'+list.map((e)=>'<li class="'+(e.wrong?"red":e.unstable?"amber":"")+'">'+esc(short(dir==="Imports"?e.to:e.from))+" · "+e.imports.length+(e.wrong?" · wrong way":e.unstable?" · less stable target":"")+"</li>").join("")+"</ul>":"";
  const ul=document.createElement("ul");
  c.files.map((p)=>files.get(p)).sort((a,b)=>(b.functions.some((f)=>f.red)?1:0)-(a.functions.some((f)=>f.red)?1:0)).forEach((f)=>ul.appendChild(fileRow(f)));
  d.appendChild(ul);
  d.insertAdjacentHTML("beforeend",edgeList(out,"Imports")+edgeList(into,"Imported by"));
  draw();
}

$("changedOnly").addEventListener("change",draw);
$("allArrows").addEventListener("change",draw);
$("find").addEventListener("input",draw);
addEventListener("resize",draw);
// A folder named after # opens selected: index.html#packages/core/src/project
const start=decodeURIComponent(location.hash.slice(1));
if(byId.has(start))select(start);else requestAnimationFrame(draw);
`;
