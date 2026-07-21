// overlay.js — 오버레이 렌더러: 캡처 루프 → 화면 분류 → 인식 → HUD
const {ipcRenderer}=require("electron");
const DB=window.DB;
const E=window.Engine,A=window.Analyzer,SC=window.ScreenClassifier,SM=window.SpriteMatcher;
E.init(DB);

// ===== 실시간 채용률 (live 우선, 6시간 캐시, 실패 시 내장 폴백) =====
const liveUsage={};
const showdownId=id=>id.toLowerCase().replace(/[^a-z0-9]/g,"");
async function fetchLive(id){
  if(liveUsage[id]!==undefined)return;
  try{const c=JSON.parse(localStorage.getItem("ov_live_"+id));
    if(c&&Date.now()-c.t<6*3600e3){liveUsage[id]=c.u;return;}}catch(e){}
  liveUsage[id]=null;
  for(const fmt of["Singles","Doubles"]){
    try{
      const r=await fetch(`https://championsbattledata.com/api/battle/${fmt}/${showdownId(id)}`);
      if(!r.ok)continue;
      const j=await r.json();
      const u={ab:[],it:[],na:[],sp:[],mv:[]};
      for(const row of (j.rows||[]).sort((a,b)=>(a.rank||0)-(b.rank||0))){
        const p=row.percentage_value;if(p==null)continue;
        if(row.category==="move")u.mv.push([row.name,p]);
        else if(row.category==="held_item")u.it.push([row.name,p]);
        else if(row.category==="ability")u.ab.push([row.name,p]);
        else if(row.category==="stat_alignment")u.na.push([row.name,p]);
        else if(row.category==="stat_points")u.sp.push([{h:+row.hp_points||0,a:+row.attack_points||0,b:+row.defense_points||0,
          c:+row.sp_atk_points||0,d:+row.sp_def_points||0,s:+row.speed_points||0},p]);
      }
      if(u.mv.length||u.sp.length){
        liveUsage[id]=u;
        try{localStorage.setItem("ov_live_"+id,JSON.stringify({t:Date.now(),u}));}catch(e){}
        break;
      }
    }catch(e){}
  }
}
A.init(DB,id=>liveUsage[id]||DB.usage[id+"|singles"]||DB.usage[id+"|doubles"]||null);

// ===== 상태 =====
const $=id=>document.getElementById(id);
const state={oppTeam:[],oppCur:null,myMon:null,lastHash:null,lastScreen:"other",busy:false};
let assetList=null;
function ensureAssets(){
  if(assetList)return;
  assetList=[];
  for(const[id,b64]of Object.entries(window.SPRITE_INDEX||{})){
    const bin=atob(b64);const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    assetList.push({id,img:{data:arr,width:40,height:40}});
  }
}
const toast=t=>{const e=$("toast");e.textContent=t;e.style.display="block";
  clearTimeout(toast._t);toast._t=setTimeout(()=>e.style.display="none",4000);
  ipcRenderer.send("to-control","overlay-status",t);};

// ===== 캡처 =====
let video=$("cap"),capReady=false;
ipcRenderer.on("source-selected",async(e,{id,name})=>{
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,
      video:{mandatory:{chromeMediaSource:"desktop",chromeMediaSourceId:id,
        maxWidth:3840,maxHeight:2160}}});
    video.srcObject=stream;capReady=true;
    $("hud").classList.add("on");
    toast("캡처 시작: "+name);
  }catch(err){toast("캡처 실패: "+err.message);}
});
ipcRenderer.on("my-mon",(e,{id})=>{
  state.myMon=id;fetchLive(id).then(()=>{if(state.lastScreen==="battle")renderBattle();});
  toast("내 포켓몬: "+DB.creatures[id].ko);
});
ipcRenderer.on("force-recognize",()=>{state.lastHash=null;tick(true);});
ipcRenderer.on("interactive",(e,v)=>{document.body.style.pointerEvents=v?"auto":"none";});

// ===== 메인 루프 (~1.2초, 변화 없으면 스킵) =====
function grabFrame(){
  if(!capReady||!video.videoWidth)return null;
  const cv=$("work");cv.width=video.videoWidth;cv.height=video.videoHeight;
  const ctx=cv.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(video,0,0);
  return {cv,img:ctx.getImageData(0,0,cv.width,cv.height)};
}
async function tick(force){
  if(state.busy||!capReady)return;
  const f=grabFrame();if(!f)return;
  const h=SC.frameHash(f.img);
  if(!force&&state.lastHash&&SC.hashDiff(state.lastHash,h)<0.01)return; // 정지 화면 스킵
  state.lastHash=h;
  const cls=SC.classify(f.img);
  $("mode").textContent={select:"선출",battle:"배틀",other:"대기"}[cls.screen];
  $("conf").textContent=cls.conf?Math.round(cls.conf*100)+"%":"";
  if(cls.screen==="select")await onSelect(f);
  else if(cls.screen==="battle")await onBattle(f);
}
setInterval(()=>tick(false),1200);

// ===== 선출 화면: 상대 6마리 매칭 → 역할 추정 =====
async function onSelect(f){
  state.busy=true;
  try{
    ensureAssets();
    const res=SM.recognizeTeam({data:f.img.data,width:f.img.width,height:f.img.height},assetList);
    if(res){
      const ids=res.map(r=>SM.decide(r)).map(d=>d?d.id:null);
      const good=ids.filter(Boolean);
      if(good.length>=3){
        state.oppTeam=good;
        for(const id of good)fetchLive(baseOf(id));
        renderSelect();
        toast("선출 인식: "+good.map(id=>DB.creatures[id].ko).join(", "));
      }
    }
  }catch(err){toast("선출 인식 오류: "+err.message);}
  state.busy=false;
}
function baseOf(id){const c=DB.creatures[id];return c&&c.base&&DB.creatures[c.base]?c.base:id;}
const ROLE_CLS=r=>/물리/.test(r.role)&&/어태커/.test(r.role)?"phys":/특수 어태커|양면/.test(r.role)?"spec":/막이/.test(r.role)?"wall":"sup";
function renderSelect(){
  const el=$("content");el.innerHTML="<h3>상대 팀 역할 추정</h3>";
  for(const id of state.oppTeam){
    const c=DB.creatures[id],r=A.estimateRole(baseOf(id));
    const d=document.createElement("div");d.className="roleRow";
    d.innerHTML=`<img src="../assets/sprites/${c.sprite}.webp" onerror="this.style.visibility='hidden'">
      <div><span class="nm">${c.ko}</span> <span class="rl ${ROLE_CLS(r)}">${r.role}</span>
      <span class="small">${r.confidence}%</span>
      <div class="tags">${r.tags.join(" · ")||"-"}</div></div>`;
    el.appendChild(d);
  }
}

// ===== 배틀 화면: 상대 이름 OCR → 선공/타수 =====
let worker=null,ocrBusy=false;
async function ensureWorker(){
  if(worker)return worker;
  worker=await Tesseract.createWorker("kor");
  return worker;
}
function cropCanvas(f,c){
  const cv=document.createElement("canvas");
  const W=f.img.width,H=f.img.height;
  cv.width=Math.floor(W*c.w);cv.height=Math.floor(H*c.h);
  cv.getContext("2d").drawImage(f.cv,Math.floor(W*c.x),Math.floor(H*c.y),cv.width,cv.height,0,0,cv.width,cv.height);
  return cv;
}
const norm=s=>(s||"").replace(/[^가-힣A-Za-z0-9]/g,"");
function lev(a,b){
  const m=a.length,n=b.length,d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);
  for(let j=1;j<=n;j++)d[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[m][n];
}
function matchName(txt){
  const t=norm(txt);if(!t)return null;
  // 1순위: 선출에서 잡아둔 6마리 중 최근접
  const pool=state.oppTeam.length?state.oppTeam.map(id=>[id,DB.creatures[id].ko]):Object.entries(DB.creatures).filter(([,c])=>c.form==="base").map(([id,c])=>[id,c.ko]);
  let best=null,bd=1e9;
  for(const[id,ko]of pool){const d=lev(t,norm(ko));if(d<bd){bd=d;best=id;}}
  return bd<=Math.max(1,Math.floor(norm(best?DB.creatures[best].ko:"").length*0.4))?best:null;
}
async function onBattle(f){
  if(ocrBusy)return;ocrBusy=true;state.busy=true;
  try{
    const w=await ensureWorker();
    const {data}=await w.recognize(cropCanvas(f,SC.CROPS.oppName));
    const id=matchName(data.text);
    if(id&&id!==state.oppCur){
      state.oppCur=id;
      await fetchLive(baseOf(id));
      renderBattle();
      toast("상대: "+DB.creatures[id].ko);
    }
  }catch(err){toast("OCR 오류: "+err.message);}
  ocrBusy=false;state.busy=false;
}
function renderBattle(){
  const el=$("content");
  if(!state.oppCur){el.innerHTML='<div class="small">상대 인식 대기 중…</div>';return;}
  if(!state.myMon){el.innerHTML='<div class="small">설정 창에서 내 포켓몬을 선택하세요</div>';return;}
  const opp=baseOf(state.oppCur),my=state.myMon;
  const myTop=A.topSet(my);
  const myStats=E.calcStats(DB.creatures[myTop.cfg.forme||my],myTop.cfg.nature,myTop.cfg.pts);
  const fsRes=A.firstStrike(myStats.spe,opp);
  const lbl={neu:"무보정",semi:"준속",mx:"최속",scarf:"스카프",est:"픽률1위"};
  let html=`<h3>${DB.creatures[my].ko} vs ${DB.creatures[state.oppCur].ko}</h3>
    <div class="small">내 실속 ${myStats.spe} (픽률1위 세트 기준 — 추후 내 세트 연동)</div><div class="spd">`;
  for(const k of["neu","semi","mx","scarf","est"]){
    const s=fsRes.scenarios[k];if(s.spe==null)continue;
    const c=s.first==="me"?"win":s.first==="opp"?"lose":"tie";
    html+=`<span class="${c}">${lbl[k]} ${s.spe}</span>`;
  }
  html+=`</div><div class="small">${fsRes.estNote}</div>`;
  const km=A.koMatrix(myTop.cfg,myTop.atkMoves,opp);
  if(km){
    html+=`<h3 style="margin-top:8px">상대 → 나 (위험한 순)</h3>`;
    for(const l of km.theirs.slice(0,4))
      html+=`<div class="dmgRow"><span>${l.moveKo}</span><span class="${l.koClass}">${l.pctMin}~${l.pctMax}% · ${l.ko}</span></div>`;
    html+=`<h3 style="margin-top:8px">나 → 상대</h3>`;
    for(const l of km.mine.slice(0,4))
      html+=`<div class="dmgRow"><span>${l.moveKo}</span><span class="${l.koClass}">${l.pctMin}~${l.pctMax}% · ${l.ko}</span></div>`;
  }
  el.innerHTML=html;
}

// ===== HUD 드래그 (조작 모드에서만) =====
(function(){
  const hud=$("hud"),bar=$("dragbar");let sx,sy,ox,oy,drag=false;
  bar.addEventListener("mousedown",e=>{drag=true;sx=e.screenX;sy=e.screenY;
    const r=hud.getBoundingClientRect();ox=r.left;oy=r.top;});
  window.addEventListener("mousemove",e=>{if(!drag)return;
    hud.style.left=(ox+e.screenX-sx)+"px";hud.style.top=(oy+e.screenY-sy)+"px";});
  window.addEventListener("mouseup",()=>drag=false);
})();
document.body.style.pointerEvents="none"; // 기본: 클릭 통과
