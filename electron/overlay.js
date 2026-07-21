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
  const a=SC.analyze(f.img);   // 게임영역 크롭 → 분류 → 동적 영역 산출 → 저해상도 가드
  state.lastScreen=a.screen;
  $("mode").textContent={select:"선출",battle:"배틀",other:"대기"}[a.screen];
  $("conf").textContent=a.conf?Math.round(a.conf*100)+"%":"";
  if(a.lowRes)toast(`캡처가 작아 인식 정확도 저하 가능 (게임영역 ${a.rect.w}px) — 고해상도 캡처 권장`);
  if(a.screen==="select")await onSelect(f,a);
  else if(a.screen==="battle")await onBattle(f,a);
}
setInterval(()=>tick(false),1200);

// ===== 선출 화면: 상대 6마리 매칭 → 역할 추정 =====
// 프레임 독립: analyze()가 게임영역 기준으로 검출한 카드 지오메트리(절대 좌표)를
// matcher.extractSprite 로 소비 (matcher.js 원본 무수정).
async function onSelect(f,a){
  state.busy=true;
  try{
    ensureAssets();
    const cards=a.regions.cards;
    if(cards){
      const img={data:f.img.data,width:f.img.width,height:f.img.height};
      const geo={xL:cards.xL,xR:cards.xR};
      const ids=[];
      for(const band of cards.bands){
        const region=SM.extractSprite(img,geo,band);
        if(!region){ids.push(null);continue;}
        const edge=SM.extractSpriteEdge(img,geo,band);
        const ranked=SM.matchAll(region,edge,assetList);
        const byCorr=[...ranked].sort((x,y)=>y.corr-x.corr);
        const d=SM.decide({best:ranked[0],bestCorr:byCorr[0]});
        ids.push(d?d.id:null);
      }
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

// ===== 배틀 화면: 이름바 2D 아이콘 → 선출 6마리 템플릿 매칭 → 활성 상대 =====
// 게임 이름 폰트는 OCR 불가(ERR-001). 대신 이름바에 얹힌 2D 도감 스프라이트 아이콘을
// 선출에서 잡은 6마리와 "마스크 멀티스케일 템플릿 매칭". 후보가 6마리뿐이라 부분 가림·
// 배경 혼재에도 강하고 저렴. (실검증: 불카모스 4354 vs 2위 11829, 격차 3배)
let battleBusy=false;
// 절대 박스 {x0,y0,x1,y1} 를 이미지 객체로 크롭
function cropRegionImg(f,box){
  const W=f.img.width,H=f.img.height,d=f.img.data;
  const x0=Math.max(0,box.x0|0),y0=Math.max(0,box.y0|0),x1=Math.min(W,box.x1|0),y1=Math.min(H,box.y1|0);
  const w=Math.max(1,x1-x0),h=Math.max(1,y1-y0),out=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const si=((y0+y)*W+(x0+x))*4,di=(y*w+x)*4;
    out[di]=d[si];out[di+1]=d[si+1];out[di+2]=d[si+2];out[di+3]=255;}
  return {data:out,width:w,height:h};
}
function scaleRGBA(a,w,h){
  const out=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const sx=Math.min(a.width-1,(x*a.width/w)|0),sy=Math.min(a.height-1,(y*a.height/h)|0);
    const si=(sy*a.width+sx)*4,di=(y*w+x)*4;
    out[di]=a.data[si];out[di+1]=a.data[si+1];out[di+2]=a.data[si+2];out[di+3]=a.data[si+3];
  }
  return {data:out,width:w,height:h};
}
// 알파(>140) 마스크 템플릿을 region 위에서 스케일·위치 탐색 → 최소 MSE
function matchTemplate(region,asset,scales){
  let best=1e9;
  for(const S of scales){
    const T=scaleRGBA(asset,S,S);
    for(let oy=-Math.floor(S*0.2);oy<=region.height-S*0.4;oy+=3)
      for(let ox=-Math.floor(S*0.15);ox<=region.width-S*0.4;ox+=3){
        let sum=0,n=0;
        for(let ty=0;ty<S;ty+=2)for(let tx=0;tx<S;tx+=2){
          const ti=(ty*S+tx)*4;if(T.data[ti+3]<140)continue;
          const rx=ox+tx,ry=oy+ty;if(rx<0||ry<0||rx>=region.width||ry>=region.height)continue;
          const ri=(ry*region.width+rx)*4;
          const dr=region.data[ri]-T.data[ti],dg=region.data[ri+1]-T.data[ti+1],db=region.data[ri+2]-T.data[ti+2];
          sum+=dr*dr+dg*dg+db*db;n++;
        }
        if(n<150)continue;const sc=sum/n;if(sc<best)best=sc;
      }
  }
  return best;
}
// region 에서 teamIds 6마리 중 활성 상대 식별. 절대점수 낮고 2위와 격차 충분할 때만 채택.
// 임계(ABS_THR/MARGIN_MIN)는 합성 프레임 2개로 잡은 잠정값 — 실전 캡처로 튜닝 필요.
const ABS_THR=6500,MARGIN_MIN=0.15,TARGET_BARH=30;
function identifyOppIcon(region,barH,teamIds){
  ensureAssets();
  const cand=assetList.filter(a=>teamIds.includes(a.id));
  if(!cand.length)return null;
  // 해상도 무관 상수시간: 아이콘 영역을 고정 크기로 축소(bar 높이→TARGET) 후 매칭.
  // 720ms→~60ms(약 12배), 마진도 커짐(노이즈 감소). 4K 캡처여도 동일 비용.
  const f=Math.min(1,TARGET_BARH/Math.max(1,barH));
  if(f<1)region=scaleRGBA(region,Math.max(8,Math.round(region.width*f)),Math.max(8,Math.round(region.height*f)));
  const scales=[1.5,1.8,2.1,2.5,3.0].map(k=>Math.max(20,Math.round(TARGET_BARH*k)));
  const scored=cand.map(a=>({id:a.id,score:matchTemplate(region,a.img,scales)})).sort((x,y)=>x.score-y.score);
  const b=scored[0],s=scored[1];
  if(b.score<ABS_THR&&(!s||s.score-b.score>b.score*MARGIN_MIN))return {id:b.id,score:b.score};
  return null;
}
async function onBattle(f,a){
  if(battleBusy)return;battleBusy=true;state.busy=true;
  try{
    const R=a.regions;
    if(R.oppIcon&&state.oppTeam.length){
      const region=cropRegionImg(f,R.oppIcon);
      const barH=R.oppIcon.barH||Math.round((R.oppIcon.y1-R.oppIcon.y0)/3);
      const r=identifyOppIcon(region,barH,state.oppTeam);
      if(r&&r.id!==state.oppCur){
        state.oppCur=r.id;await fetchLive(baseOf(r.id));renderBattle();
        toast("상대: "+DB.creatures[r.id].ko);
      }
    }
  }catch(err){toast("상대 인식 오류: "+err.message);}
  battleBusy=false;state.busy=false;
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
