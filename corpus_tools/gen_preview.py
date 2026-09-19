# -*- coding: utf-8 -*-
"""生成真题库前端设计预览（单文件 HTML，内嵌真实解析数据）。

只读：读取 corpus/exams.jsonl + data/answers_source/answers_merged.json，产出
根目录 exam-preview.html，供用户审阅渲染与答题逻辑。
"""
import json, os, sys, re
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXAMS = os.path.join(ROOT, "corpus", "exams.jsonl")
ANS = os.path.join(ROOT, "data", "answers_source", "answers_merged.json")
OUT = os.path.join(ROOT, "exam-preview.html")

SHOW_YEARS = [2024, 2019, 2016, 2007, 1999]

recs = [json.loads(l) for l in open(EXAMS, encoding="utf-8") if l.strip()]
recs = [r for r in recs if r["meta"]["year"] in SHOW_YEARS]
recs.sort(key=lambda r: -r["meta"]["year"])

try:
    ans_all = json.load(open(ANS, encoding="utf-8"))
except Exception:
    ans_all = {}


def pack(r):
    y = r["meta"]["year"]
    ans = ans_all.get(str(y), {})
    if isinstance(ans, dict) and "objective" in ans:
        ans = ans["objective"]
    ans = {str(k): v for k, v in (ans or {}).items() if str(k).isdigit()}
    return {"id": r["id"], "year": y, "title": r["title"], "items": r["items"],
            "meta": r["meta"], "source": r["source"], "answers": ans}


data = [pack(r) for r in recs]
payload = json.dumps(data, ensure_ascii=False)

HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>真题库 · 前端设计预览</title>
<style>
:root{
  --bg:#f5f7fa; --card:#fff; --border:#e3e8ef; --text:#1f2937; --text-sub:#6b7280;
  --primary:#3b82f6; --primary-soft:#eff6ff; --warn:#ef4444; --ok:#10b981;
  --radius:14px; --shadow:0 1px 2px rgba(15,23,42,.04),0 10px 28px -14px rgba(15,23,42,.14);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:var(--primary)}
.wrap{max-width:1080px;margin:0 auto;padding:28px 18px 80px}
.hero{background:linear-gradient(135deg,#1e293b 20%,#2563eb 100%);color:#fff;
  border-radius:18px;padding:26px 28px;box-shadow:var(--shadow)}
.hero h1{margin:0 0 6px;font-size:23px;letter-spacing:.3px}
.hero p{margin:0;opacity:.85;font-size:13.5px}
.hero .tags{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
.hero .tags span{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);
  padding:3px 11px;border-radius:999px;font-size:12px}
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:18px;margin-top:18px}
.panel h2{margin:0 0 4px;font-size:16px}
.sub{color:var(--text-sub);font-size:12.5px;margin:0 0 12px}
.yearbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.ychip{border:1px solid var(--border);background:#fff;border-radius:999px;padding:6px 14px;
  cursor:pointer;font-size:13px;color:var(--text);transition:.15s}
.ychip:hover{border-color:var(--primary);color:var(--primary)}
.ychip.active{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.card{border:1px solid var(--border);border-radius:12px;padding:13px 14px;background:#fff;cursor:pointer;transition:.15s}
.card:hover{box-shadow:var(--shadow);border-color:#c7d6f7;transform:translateY(-1px)}
.card.active{border-color:var(--primary);box-shadow:0 0 0 2px var(--primary-soft)}
.card .t{font-weight:600;font-size:14px;margin-bottom:3px}
.card .m{color:var(--text-sub);font-size:12px}
.badge{display:inline-block;background:var(--primary-soft);color:#1d4ed8;border-radius:6px;
  font-size:11px;padding:1px 7px;margin-right:5px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{font-size:11.5px;background:#f1f5f9;border:1px solid #e2e8f0;color:#475569;
  border-radius:999px;padding:2px 9px}
.secblock{margin-top:20px}
.sectitle{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;
  padding:8px 0;border-bottom:2px solid var(--primary-soft);margin-bottom:12px}
.secstats{font-size:12px;color:var(--text-sub);font-weight:400}
.passage{font-size:14.5px;line-height:2.0;text-indent:2em}
.passage p{margin:0 0 12px}
.blank{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:22px;
  padding:0 6px;margin:0 3px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:6px;
  color:#b45309;font-size:12px;font-weight:700;vertical-align:middle}
.blank.select{border-style:solid;background:#fff;padding:0}
.blank select{border:0;background:transparent;font-size:12.5px;color:#334155;max-width:150px;outline:none}
.underline{background:linear-gradient(transparent 62%, #fde68a 62%);padding:0 1px;
  text-decoration:underline;text-decoration-color:#f59e0b;text-underline-offset:3px}
.underline .num{display:inline-block;background:#f59e0b;color:#fff;border-radius:5px;
  font-size:11px;padding:0 5px;margin-right:3px;vertical-align:1px}
.q{border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-top:10px;background:#fff}
.qhead{font-size:12.5px;color:var(--text-sub);margin-bottom:6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.qhead .qn{font-weight:700;color:var(--primary)}
.qtext{font-size:14px;margin-bottom:8px}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px}
.opt{display:flex;gap:7px;align-items:flex-start;font-size:13.5px;cursor:pointer;
  border-radius:8px;padding:5px 8px;transition:.12s}
.opt:hover{background:#f8fafc}
.opt input{margin-top:4px;accent-color:var(--primary)}
.opt b{color:var(--primary)}
.opt.right{background:#ecfdf5}
.opt.wrong{background:#fef2f2}
.pool{border:1px dashed #cbd5e1;border-radius:10px;padding:12px;background:#f8fafc;margin-top:10px}
.pool .lbl{font-size:12px;color:var(--text-sub);margin-bottom:8px}
.pool .opt{margin-bottom:2px}
.skel{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px;margin-top:8px}
.skel .node{border:1px solid var(--border);border-radius:8px;padding:4px 10px;background:#fff}
.skel .node.given{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;font-weight:600}
.skel .node input{width:52px;border:0;border-bottom:2px solid var(--primary);
  text-align:center;font-size:14px;text-transform:uppercase;outline:none;background:transparent}
.skel .arrow{color:#94a3b8}
.ul-list{margin-top:12px}
.ul-row{padding:8px 0;border-top:1px dashed var(--border)}
.ul-row .n{font-weight:700;color:#b45309;margin-right:6px}
textarea{width:100%;border:1px solid var(--border);border-radius:10px;padding:10px;
  font:14px/1.6 inherit;resize:vertical;outline:none}
textarea:focus{border-color:var(--primary)}
.wrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:12.5px;color:var(--text-sub)}
.wordcount.ok{color:var(--ok);font-weight:600}.wordcount.warn{color:#d97706;font-weight:600}
.btn{border:1px solid var(--border);background:#fff;border-radius:10px;padding:8px 16px;
  cursor:pointer;font-size:13.5px;transition:.15s;min-height:44px}
.btn:hover{border-color:var(--primary);color:var(--primary)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:600}
.btn.primary:hover{background:#2563eb;color:#fff}
.rowbar{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
.result{margin-top:12px;font-size:13.5px;padding:10px 12px;border-radius:10px;display:none}
.result.show{display:block}
.result.ok{background:#ecfdf5;color:#047857;border:1px solid #a7f3d0}
.result.info{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
.note{background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:13px 15px;
  font-size:13px;color:#92400e;margin-top:14px}
.note b{color:#b45309}
.diag{font-size:13px;color:var(--text-sub)}
.diag li{margin:2px 0}
.hidden{display:none}
@media(max-width:640px){.opts{grid-template-columns:1fr}.wrap{padding:16px 10px 60px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>📕 真题库 · 前端渲染设计预览</h1>
    <p>按「真实考题 + 答题逻辑」重建 · 数据来自 28 套整卷 docx 重新解析（v2.6.1 重建版）</p>
    <div class="tags">
      <span>完形填空 10/20 题</span><span>阅读 Part A 4 篇 ×5</span><span>Part B 四型自适应</span>
      <span>翻译划线句</span><span>写作 Part A/B</span><span>原文锚点 〖N〗</span>
    </div>
  </div>

  <div class="panel">
    <h2>1 · 真题列表（按年份）</h2>
    <p class="sub">点击任一试卷查看卷面还原与做题形态。示例覆盖：新题型四型 / 旧制卷型 / 翻译划线 / 写作双篇。</p>
    <div class="yearbar" id="yearbar"></div>
    <div class="grid" id="cards" style="margin-top:14px"></div>
  </div>

  <div class="panel">
    <h2>2 · 卷面还原与答题形态</h2>
    <p class="sub" id="metaLine">请选择上方试卷</p>
    <div id="detail"></div>
    <div class="rowbar" id="actions" style="display:none">
      <button class="btn primary" id="submitBtn">✅ 提交答案</button>
      <button class="btn" id="resetBtn">↺ 重做</button>
      <span class="diag" id="scoreLine"></span>
    </div>
    <div class="result" id="resultBox"></div>
  </div>

  <div class="panel">
    <h2>3 · 本次重建修复的问题（对照旧版）</h2>
    <div class="diag">
      <ul>
        <li>旧版：完形/翻译原文 <b>0 个 〖N〗 锚点</b> → 新版：完形 20 空、翻译划线句全部落锚点。</li>
        <li>旧版：<b>没有 <code>type:"writing"</code> 条目</b>，作文被塞进 question（前端写作模块读不到）→ 新版：Part A/B 独立写作条目，10+20 分。</li>
        <li>旧版：翻译题被切成 <b>跨句长段</b>（如 2024 Q46 混入后续正文）→ 新版：按 Word 原生下划线精确拆句。</li>
        <li>旧版：Part B 选项池分数按 5 题均摊（<b>每题 2 分×6 项</b>）→ 新版：选项池不计分，41-45 每题 2 分。</li>
        <li>旧版：全卷加总 <b>仅 72 分</b>（写作缺失）→ 新版：<b>100 分</b>（1999-2000 旧制 65，2001 75，2002+ 80）。</li>
      </ul>
    </div>
  </div>
</div>

<script>
const DATA = __DATA__;
const KB_SECTION = {use_of_english:'🔲 考研-完形填空', reading:'📖 考研-阅读理解',
  part_b:'🧩 考研-新题型', translation:'🖊 考研-翻译', writing:'📝 考研-写作'};
const ORDER = ['use_of_english','reading','part_b','translation','writing'];
let cur = null;

/* ---------------- 文本渲染 ---------------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function kbText(text){                       /* 〖N〗…〖/N〗 划线；独立 〖N〗 挖空 */
  let s = esc(text||'');
  s = s.replace(/〖(\d+)〗([\s\S]*?)〖\/\1〗/g,(m,n,inner)=>
    `<span class="underline"><span class="num">${n}</span>${inner.trim()}</span>`);
  s = s.replace(/〖(\d+)〗/g,(m,n)=>`<span class="blank">${n}</span>`);
  return s.split(/\n+/).filter(p=>p.trim()).map(p=>`<p>${p}</p>`).join('');
}
function para(text){return kbText(text);}

/* ---------------- 列表 ---------------- */
function renderYears(){
  const bar = document.getElementById('yearbar');
  bar.innerHTML = DATA.map(r=>`<button class="ychip" data-y="${r.year}">${r.year} 年</button>`).join('');
  bar.onclick = e=>{const b=e.target.closest('.ychip'); if(b) selectYear(+b.dataset.y);};
}
function renderCards(){
  document.getElementById('cards').innerHTML = DATA.map(r=>{
    const secs = {};
    for(const it of r.items){ const k=it.section||'misc'; secs[k]=(secs[k]||0)+1; }
    const chips = ORDER.filter(s=>secs[s]).map(s=>`<span class="chip">${KB_SECTION[s].replace(/^\S+\s/,'')} ${secs[s]}</span>`).join('');
    return `<div class="card" data-y="${r.year}">
      <div class="t">${r.title}</div>
      <div class="m">${r.meta.questions} 题 · 客观+写作合计 100 分制</div>
      <div class="chips">${chips}</div></div>`;
  }).join('');
  document.getElementById('cards').onclick = e=>{
    const c=e.target.closest('.card'); if(c) selectYear(+c.dataset.y);
  };
}

/* ---------------- 详情 ---------------- */
function selectYear(y){
  cur = DATA.find(r=>r.year===y); if(!cur) return;
  document.querySelectorAll('.ychip,.card').forEach(el=>
    el.classList.toggle('active', +el.dataset.y===y));
  document.getElementById('actions').style.display='flex';
  document.getElementById('resultBox').className='result';
  document.getElementById('scoreLine').textContent='';
  document.getElementById('metaLine').innerHTML =
    `${esc(cur.title)} · ${cur.meta.questions} 题 · 解析器 <code>${esc(cur.source.parser)}</code> · 来源 <code>${esc(cur.source.file)}</code>`;
  renderDetail();
  document.getElementById('detail').scrollIntoView({behavior:'smooth',block:'start'});
}

function groups(){                       /* 按 section 分块，保持库内顺序 */
  const out=[]; const idx=ORDER.concat(['misc']);
  for(const s of idx){
    const items=cur.items.filter(it=>(it.section||'misc')===s);
    if(items.length) out.push({sec:s,items});
  }
  return out;
}

function analyze(sec,items){
  const qs=items.filter(i=>i.type==='question');
  if(sec==='use_of_english'){
    const b=new Set(); items.filter(i=>i.type==='passage').forEach(p=>
      (p.text.match(/〖(\d+)〗/g)||[]).forEach(x=>b.add(x)));
    return `挖空 ${b.size} 处 · 题目 ${qs.length} 题 · 每题 ${qs[0]?.score||'—'} 分`;
  }
  if(sec==='reading'){
    const pids=new Set(items.filter(i=>i.type==='passage').map(i=>i.passage_id));
    return `${pids.size} 篇文章 · ${qs.length} 题 · 每篇 ${pids.size?qs.length/pids.size:'—'} 题`;
  }
  if(sec==='part_b'){
    const p=items.find(i=>i.type==='passage');
    const pool=items.find(i=>i.type==='question'&&i.number==null);
    let variant='句段回填';
    if(p && /→/.test(p.text)) variant='段落排序';
    else if(pool && Object.values(pool.options||{}).every(v=>/^[^a-z]{0,40}$/.test(v))) variant='小标题匹配';
    if(p && /statements|comments|summariz/i.test(p.text)) variant='评论配对';
    return `题型：${variant} · 选项池 ${pool?Object.keys(pool.options).length:0} 项 · 待选 ${qs.filter(q=>q.number!=null).length} 空`;
  }
  if(sec==='translation') return `划线句 ${qs.length} 句 · 每题 ${qs[0]?.score||2} 分`;
  if(sec==='writing'){
    const w=items.filter(i=>i.type==='writing');
    return `${w.length} 道写作题 · 合计 ${w.reduce((a,b)=>a+(b.score||0),0)} 分`;
  }
  return `${items.length} 个条目`;
}

function renderDetail(){
  let html='';
  for(const g of groups()){
    html += `<div class="secblock"><div class="sectitle">${KB_SECTION[g.sec]||g.sec}
      <span class="secstats">${esc(analyze(g.sec,g.items))}</span></div>
      ${renderSection(g.sec,g.items)}</div>`;
  }
  document.getElementById('detail').innerHTML = html;
  document.querySelectorAll('#detail textarea.wc').forEach(t=>{
    const upd=()=>{const w=(t.value.trim().match(/[A-Za-z][A-Za-z'-]*/g)||[]).length;
      const el=t.parentElement.querySelector('.wordcount');
      if(el){el.textContent=w+' 词'; el.className='wordcount '+(w? (w<100?'warn':'ok'):'');}};
    t.addEventListener('input',upd); upd();
  });
}

function optsHtml(q,disable){
  const o=q.options||{}; const ks=Object.keys(o);
  if(!ks.length) return '';
  return `<div class="opts">${ks.map(k=>
    `<label class="opt"><input type="radio" name="q${q.number}" value="${esc(k)}" ${disable?'disabled':''}><span><b>${esc(k)}.</b> ${esc(o[k])}</span></label>`).join('')}</div>`;
}

function renderSection(sec,items){
  const qs=items.filter(i=>i.type==='question');
  if(sec==='use_of_english'){
    const p=items.find(i=>i.type==='passage');
    const qBy={}; qs.forEach(q=>{if(q.number!=null)qBy[q.number]=q;});
    let art = kbText(p?p.text:'').replace(/<span class="blank">(\d+)<\/span>/g,(m,n)=>{
      const q=qBy[+n]; const opts=q&&q.options?Object.entries(q.options).map(([k,v])=>
        `<option value="${esc(k)}">${esc(k)}. ${esc(String(v).slice(0,38))}</option>`).join(''):'';
      return `<span class="blank select"><b>${n}</b><select data-num="${n}"><option value="">—</option>${opts}</select></span>`;
    });
    let h=`<div class="passage">${art}</div>`;
    h+=`<div class="secstats" style="margin-top:12px">题目（作答即在原文中选词，与考场一致）</div>`;
    h+=qs.map(q=>`<div class="q" data-q="${q.number}"><div class="qhead"><span class="qn">第 ${q.number} 题</span>
      <span>${esc(q.qtype)} · ${q.score} 分</span></div>${optsHtml(q)}</div>`).join('');
    return h;
  }
  if(sec==='reading'){
    let h='';
    for(let pid=1;pid<=6;pid++){
      const p=items.find(i=>i.type==='passage'&&i.passage_id===pid);
      const qq=qs.filter(q=>q.passage_id===pid);
      if(!p&&!qq.length) continue;
      h+=`<div class="passage" style="margin-top:8px"><p style="text-indent:0;font-size:12.5px;color:#6b7280">Text ${pid}</p>${para(p?p.text:'')}</div>`;
      h+=qq.map(q=>`<div class="q" data-q="${q.number}"><div class="qhead"><span class="qn">第 ${q.number} 题</span>
        <span>${q.score} 分</span></div><div class="qtext">${esc(q.text)}</div>${optsHtml(q)}</div>`).join('');
    }
    return h;
  }
  if(sec==='part_b'){
    const p=items.find(i=>i.type==='passage');
    const pool=items.find(i=>i.type==='question'&&i.number==null);
    const blanks=qs.filter(q=>q.number!=null);
    let h='';
    if(p && /→/.test(p.text)){                 /* 段落排序：答题骨架 */
      h+=`<div class="skel">`+p.text.split(/→/).map(seg=>{
        seg=seg.trim();
        const m=seg.match(/^〖(\d+)〗$/);
        if(m) return `<span class="node"><input maxlength="1" data-num="${m[1]}" placeholder="?"></span><span class="arrow">→</span>`;
        return `<span class="node given">${esc(seg)}</span><span class="arrow">→</span>`;
      }).join('').replace(/<span class="arrow">→<\/span>$/,'')+`</div>`;
      h+=`<div class="pool"><div class="lbl">选项池 A–H（选后填入上方空位）</div>
        ${Object.entries(pool?.options||{}).map(([k,v])=>`<label class="opt"><b>${esc(k)}.</b> ${esc(v)}</label>`).join('')}</div>`;
    } else if(pool){
      h+=`<div class="passage">${kbText(p?p.text:'')}</div>`;
      h+=`<div class="pool"><div class="lbl">选项池（含干扰项）</div>
        ${Object.entries(pool.options||{}).map(([k,v])=>`<label class="opt"><b>${esc(k)}.</b> ${esc(v)}</label>`).join('')}</div>`;
      h+=`<div class="secstats" style="margin-top:10px">待选 ${blanks.length} 空</div>`;
      h+=blanks.map(q=>`<div class="q" data-q="${q.number}"><div class="qhead"><span class="qn">第 ${q.number} 空</span>
        <span>从选项池中选出填入</span></div>
        <select class="u" data-num="${q.number}" style="min-height:40px;border:1px solid var(--border);border-radius:8px;padding:4px 8px">
        <option value="">—</option>${Object.keys(pool.options||{}).map(k=>`<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select></div>`).join('');
    }
    return h;
  }
  if(sec==='translation'){
    const p=items.find(i=>i.type==='passage');
    let h=`<div class="passage">${kbText(p?p.text:'')}</div>`;
    h+=`<div class="ul-list">`+qs.map(q=>`<div class="ul-row"><span class="n">第 ${q.number} 题</span>
      <span class="underline" style="text-decoration:none">${esc(q.text)}</span>
      <textarea class="u-trans" data-num="${q.number}" rows="3" placeholder="写下你的译文…"></textarea></div>`).join('')+`</div>`;
    return h;
  }
  if(sec==='writing'){
    return items.filter(i=>i.type==='writing').map(w=>{
      const wc = w.part==='A'?'100~120':(w.part==='B'?'160~200':'150+');
      return `<div class="q"><div class="qhead"><span class="qn">✍️ 作文${w.part?' Part '+w.part:''}</span>
        <span>第 ${w.number} 题 · ${w.score} 分 · 建议 ${wc} 词</span></div>
        <div class="qtext" style="white-space:pre-wrap">${esc(w.text)}</div>
        <textarea class="wc" rows="7" placeholder="在此写作（或先纸笔再对照）…"></textarea>
        <div class="wrow"><span class="wordcount">0 词</span><span>· 考场建议 ${wc} 词</span></div></div>`;
    }).join('');
  }
  return items.map(i=>`<div class="passage">${kbText(i.text)}</div>`).join('');
}

/* ---------------- 判分（仅演示，答案来自本地公开源） ---------------- */
function submit(){
  if(!cur) return;
  const A=cur.answers||{};
  let total=0, right=0, detail=[];
  document.querySelectorAll('#detail .opt').forEach(o=>o.classList.remove('right','wrong'));
  document.querySelectorAll('#detail input[type=radio]:checked').forEach(inp=>{
    const num=inp.name.replace('q','');
    const correct=(A[num]||'').toUpperCase();
    if(!correct) return;
    total++;
    const lab=inp.closest('.opt');
    if(inp.value.toUpperCase()===correct){right++; lab.classList.add('right');}
    else{lab.classList.add('wrong');
      const sib=[...inp.closest('.opts').querySelectorAll('.opt')].find(x=>x.textContent.trim().startsWith(correct+'.'));
      if(sib) sib.classList.add('right');}
  });
  document.querySelectorAll('#detail select.u').forEach(s=>{
    const num=s.dataset.num, correct=(A[num]||'').toUpperCase();
    if(!correct||!s.value) return;
    total++; if(s.value.toUpperCase()===correct) right++;
  });
  const box=document.getElementById('resultBox');
  if(!total){box.className='result show info';
    box.textContent='该年份暂未录入标准答案（data/answers.json 留空，答案走人工权威录入通道，绝不由 AI 生成）。';}
  else{box.className='result show ok';
    box.textContent=`客观题判分：${right} / ${total} 正确（答案来自本地公开源，仅演示判分链路；实际以录入答案为准）。`;}
  document.getElementById('scoreLine').textContent= total? `本次作答 ${right}/${total}`:'';
}
function reset(){
  document.querySelectorAll('#detail input[type=radio]').forEach(i=>i.checked=false);
  document.querySelectorAll('#detail select').forEach(s=>s.value='');
  document.querySelectorAll('#detail textarea').forEach(t=>t.value='');
  document.querySelectorAll('#detail .opt').forEach(o=>o.classList.remove('right','wrong'));
  document.getElementById('resultBox').className='result';
  document.getElementById('scoreLine').textContent='';
}
document.getElementById('submitBtn').onclick=submit;
document.getElementById('resetBtn').onclick=reset;
renderYears(); renderCards(); selectYear(DATA[0].year);
</script>
</body>
</html>
"""

open(OUT, "w", encoding="utf-8").write(HTML.replace("__DATA__", payload))
print("written:", OUT, os.path.getsize(OUT), "bytes; records:", len(data))
