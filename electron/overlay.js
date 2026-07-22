// overlay.js — 오버레이 렌더러: 캡처 루프 → 화면 분류 → 인식 → HUD
const {ipcRenderer}=require("electron");
// nodeIntegration 렌더러엔 module이 정의돼 있어 UMD 모듈들이 window에 안 붙음(module.exports로 감).
// → window 전역 대신 require로 로드 (matcher.js 등 원본 무수정). data/spriteindex는 window 직접 할당이라 그대로 사용.
const DB=window.DB;
const E=require("../engine.js"),A=require("../analyzer.js"),
      SC=require("../shared/screen-classifier.js"),SM=require("../matcher.js");
const TR=require("../shared/team-register.js"); // 팀등록 화면 → 내 팀 6마리 인식
const TD=require("../shared/team-detail.js");   // 팀등록 상세 → 세트(수치·성격·아이템·EV) 추출
E.init(DB);

// 세트 유틸 ── 화면 EV 짧은키(h/a/b/c/d/s) → engine.calcStats 긴키(hp/atk/…) 매핑 후 능력치 산출.
// 검증: calcStats(lv50·IV31)가 팀등록 화면 실수치를 완전 재현(EV=calcStats pts). 메가면 메가폼 종족값으로 계산.
const EV_LONG={h:"hp",a:"atk",b:"def",c:"spa",d:"spd",s:"spe"};
function computeStats(species,nature,evs){const pts={};for(const k in(evs||{}))pts[EV_LONG[k]]=evs[k];
  const c=DB.creatures[species];return c?E.calcStats(c,nature||"Serious",pts):null;}
function megaFormeOf(species){const c=DB.creatures[species];if(!c||!c.formes)return null;
  return c.formes.find(f=>/-Mega/.test(f)&&DB.creatures[f])||null;}

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
const state={oppTeam:[],oppCur:null,myMon:null,lastHash:null,lastScreen:"other",busy:false,oppLocked:false};
// [로컬 전용] 데이터셋 캡처는 gitignore된 capture.local.js 가 있을 때만 활성(클린 체크아웃엔 없음 → 무동작).
let CAP=null; try{CAP=require("./capture.local.js");}catch(e){}
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
// 진단 로그: control 창 "진단 로그" 패널에 시각순 누적(+ DevTools 콘솔). kind: ""|cap|ok|err
const dlog=(msg,kind)=>{try{console.log("[진단] "+msg);ipcRenderer.send("to-control","diag",{line:msg,kind});}catch(e){}};
// 팀등록은 매 틱 재처리 → 같은 HTML을 반복 write하면 스프라이트 깜빡임. 내용 바뀔 때만 갱신(화면 벗어나면 리셋).
let _teamHtml=null;
const setTeamContent=h=>{const e=$("content");if(_teamHtml!==h){_teamHtml=h;e.innerHTML=h;}};
// 세트 상세 확장 패널(옆칸 #detail) — 동일하게 내용 바뀔 때만 갱신.
let _detailHtml=null;
const setDetailContent=h=>{const e=$("detail");if(_detailHtml!==h){_detailHtml=h;e.innerHTML=h;}};
function closeDetailPanel(){teamStore.detailOpen=false;$("hud").classList.remove("detail");if(_detailHtml!==""){_detailHtml="";$("detail").innerHTML="";}}

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
// 새 매치/강제 재인식: 선출 잠금 해제 후 다시 인식
ipcRenderer.on("force-recognize",()=>{
  state.oppLocked=false;state.oppCur=null;state.lastHash=null;tick(true);
  toast("재인식 — 선출 잠금 해제");
});

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
  const staticFrame=state.lastHash&&SC.hashDiff(state.lastHash,h)<0.01;
  // 정지 화면 스킵 — 단 팀등록은 예외: 16×9 밝기 해시가 거칠어 '다른 팀'을 정지로 오판(레이아웃 동일)하므로
  // A팀→B팀 전환·오인식 재시도를 놓침. 팀등록 화면에선 정지여도 항상 재처리(등록 여부 무관, 인식될 때까지 시도).
  if(!force&&staticFrame&&state.lastScreen!=="teamregister")return;
  state.lastHash=h;
  const a=SC.analyze(f.img);   // 게임영역 크롭 → 분류 → 동적 영역 산출 → 저해상도 가드
  const prev=state.lastScreen;state.lastScreen=a.screen;
  if(prev!==a.screen)dlog(`화면 전환: ${a.screen} (rect ${a.rect.w}x${a.rect.h}${a.lowRes?" 저해상도⚠":""})`,a.screen==="teamregister"?"ok":"");
  if(a.screen!=="teamregister"){_teamHtml=null;closeDetailPanel();}   // 팀등록 벗어나면 재렌더 dedupe 리셋 + 상세 패널 닫기(다른 화면이 content를 덮으므로)
  $("mode").textContent={select:"선출",battle:"배틀",matchmaking:"매칭",other:"대기"}[a.screen];
  $("conf").textContent=a.conf?Math.round(a.conf*100)+"%":"";
  if(a.lowRes)toast(`캡처가 작아 인식 정확도 저하 가능 (게임영역 ${a.rect.w}px) — 고해상도 캡처 권장`);
  if(CAP)CAP.onScreen(a.screen); // [로컬] 데이터셋 캡처 화면상태 갱신
  if(a.screen==="matchmaking"){
    if(prev!=="matchmaking"){ // 새 매치 진입 1회 → 선출 잠금 자동 해제
      state.oppLocked=false;state.oppCur=null;state.oppTeam=[];
      $("content").innerHTML='<div class="small">매칭 중… 선출 화면을 기다립니다</div>';
      toast("새 매치 감지 — 선출 잠금 해제");
    }
  }
  else if(a.screen==="select")await onSelect(f,a);
  else if(a.screen==="battle")await onBattle(f,a);
  else if(a.screen==="teamregister")await onTeamRegister(f,a); // 팀 상세 화면 → 내 팀 등록/관리
}
setInterval(()=>tick(false),1200);

// 카드 1장 판정: 색 매칭만으론 46%가 혼동 위험 → 색 상위 후보군 중 "형태(gradient corr) 최고"를 채택.
// 실측: 정답 corr 0.71~0.89 vs 혼동 후보 0.2~0.4로 확연히 갈림. matcher.js 원본 무수정, overlay 판정부만 개선.
function decideCard(ranked){
  if(!ranked||!ranked.length)return null;
  const top=ranked.slice(0,6);                          // 색 상위 6후보로 압축
  const best=[...top].sort((a,b)=>b.corr-a.corr)[0];    // 그 중 형태 corr 최고
  if(best.corr>=0.45)return {id:best.id};               // 형태 일치 충분 → 채택(이로치 색변경도 형태로 잡힘)
  if(ranked[0].score<4000)return {id:ranked[0].id};     // 형태 불명확하나 색이 압도적일 때
  return null;                                           // 불확실 → 미채택(오인식보다 공백)
}

// ===== 선출 화면: 상대 6마리 매칭 → 역할 추정 =====
// 프레임 독립: analyze()가 게임영역 기준으로 검출한 카드 지오메트리(절대 좌표)를
// matcher.extractSprite 로 소비 (matcher.js 원본 무수정).
async function onSelect(f,a){
  if(state.oppLocked)return; // 한 번 인식하면 고정 — 배틀 중 교체 엔트리 등 선출-유사 화면 재인식 방지. 새 매치(Alt+R/버튼)에서만 해제
  state.busy=true;
  try{
    ensureAssets();
    const cards=a.regions.cards;
    let ids=[];
    if(cards){
      const img={data:f.img.data,width:f.img.width,height:f.img.height};
      const geo={xL:cards.xL,xR:cards.xR};
      for(const band of cards.bands){
        const region=SM.extractSprite(img,geo,band);
        if(!region){ids.push(null);continue;}
        const edge=SM.extractSpriteEdge(img,geo,band);
        const types=TR.detectSelectTypes(img,geo,band); // 선출 카드 타입 → 후보 선필터(팀등록과 동일 방식)
        const cand=TR.candByTypes(types,id=>{const c=DB.creatures[id];return c&&c.types?c.types:[];},assetList);
        const ranked=SM.matchAll(region,edge,cand);
        const d=decideCard(ranked);
        ids.push(d?d.id:null);
      }
      const good=ids.filter(Boolean);
      if(good.length>=3){
        state.oppTeam=good;
        state.oppLocked=true; // 고정: 이후 재인식 안 함 (새 매치에서 Alt+R/버튼으로 해제)
        for(const id of good)fetchLive(baseOf(id));
        renderSelect();
        toast("선출 인식(고정): "+good.map(id=>DB.creatures[id].ko).join(", "));
      }
    }
    if(CAP)CAP.select(ipcRenderer,f.cv,cards?ids:null,DB); // [로컬] 선출 프레임 데이터셋 캡처(진입당 1회)
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
    if(R.myIcon&&activeTeam())identifyMyMon(f,R); // 등록된 활성 팀 → 내 활성 포켓몬 자동 인식(신뢰 시 수동선택 대체)
    if(R.oppIcon&&state.oppTeam.length){
      const region=cropRegionImg(f,R.oppIcon);
      const barH=R.oppIcon.barH||Math.round((R.oppIcon.y1-R.oppIcon.y0)/3);
      const r=identifyOppIcon(region,barH,state.oppTeam);
      if(r&&r.id!==state.oppCur){
        if(CAP)CAP.battle(ipcRenderer,f.cv,r.id,r.score,DB); // [로컬] 배틀 프레임 캡처(식별 변경 시)
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

// ===== 내 팀 등록 (팀 상세 화면 자동 인식 → 최대 6팀 유지 · localStorage) =====
// 요구사항: 배틀 아닐 때만 인식(classify가 teamregister로 분리) · 포켓몬 리스트가 등록된 팀과 상이하면 새 팀
// · 6팀 초과 시 알림 후 삭제 · 삭제하면 바로 재인식해 등록 확인 · 거절하면 다른 팀 인식까지 대기.
const MAX_TEAMS=6;
// pinnedSig: 유저가 등록팀을 클릭해 "내 팀"으로 수동 고정한 서명(= 캡처 인식 무시 플래그). ⟳(재인식)로만 해제.
// detailOpen/detailIdx: 세트 상세 옆칸(#detail) 표시 여부와 보고 있는 포켓몬 인덱스.
const teamStore={teams:[],activeSig:null,rejectedSig:null,ui:null,lastSig:null,lastMons:null,
  pinnedSig:null,detailOpen:false,detailIdx:0};
try{const s=JSON.parse(localStorage.getItem("ov_teams"));if(Array.isArray(s))teamStore.teams=s;}catch(e){}
function saveTeams(){try{localStorage.setItem("ov_teams",JSON.stringify(teamStore.teams));}catch(e){}}
function teamName(mons){const g=mons.filter(Boolean);return g.map(id=>DB.creatures[id]?DB.creatures[id].ko:id).slice(0,3).join("·")+(g.length>3?" 외":"");}
function findTeam(sig){return teamStore.teams.find(t=>t.sig===sig)||null;}
function activeTeam(){return teamStore.teams.find(t=>t.sig===teamStore.activeSig)||null;}
// "내 팀" 패널에 실제로 표시할 팀 해석 — 수동 고정(pinnedSig)이 있으면 그 팀, 없으면 마지막 캡처 인식 결과.
function displayTeam(){
  if(teamStore.pinnedSig){const t=findTeam(teamStore.pinnedSig);if(t)return {mons:t.mons,sig:t.sig,team:t,pinned:true};}
  return {mons:teamStore.lastMons||[],sig:teamStore.lastSig,team:findTeam(teamStore.lastSig),pinned:false};
}

// 유효 인식 판별: 6마리 서로 다른 종족(팀에 중복 불가 → 중복=오인식) + 타입 대부분 잡힘.
// 오인식은 같은 종족 반복(예: 미끄래곤×3)·타입 0으로 명확히 갈림 → 재시도 트리거 기준.
function goodRecog(r){
  if(!r||!r.ok||!r.mons)return false;
  const got=r.mons.filter(Boolean);
  if(new Set(got).size!==6)return false;                 // 중복 종족 = 오인식
  const typed=(r.types||[]).filter(t=>t&&t.length).length;
  return typed>=5;                                        // 타입 6칸 중 5+ 잡힘
}
// 게임영역(rect)을 목표 폭 W로 최근접 리샘플 → {img,rect}. 창 크기 변경과 동일한 픽셀 정렬 변화 효과.
function resampleRegion(img,rect,W){
  const H=Math.round(rect.h*W/rect.w),out=new Uint8Array(W*H*4);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const sx=rect.x0+Math.min(rect.w-1,(x*rect.w/W)|0),sy=rect.y0+Math.min(rect.h-1,(y*rect.h/H)|0);
    const si=(sy*img.width+sx)*4,di=(y*W+x)*4;out[di]=img.data[si];out[di+1]=img.data[si+1];out[di+2]=img.data[si+2];out[di+3]=255;}
  return {img:{data:out,width:W,height:H},rect:{x0:0,y0:0,w:W,h:H}};
}
// 견고 인식: 원본 시도 → 실패(중복/타입)면 여러 스케일로 리샘플 재시도 → 유효결과 다수결.
// 유저 관찰(창 늘렸다 줄이면 인식됨)을 자동화. 실측: 실패 프레임이 6/8 스케일서 정답 복구·수렴.
const RETRY_SCALES=[0.86,1.12,1.30,1.48,0.72,1.62];
function recognizeRobust(img,rect){
  const base=TR.recognize(img,rect,SM,assetList,DB.creatures);
  if(goodRecog(base))return {r:base,img,rect,tag:"native"};
  const votes={};
  for(const m of RETRY_SCALES){
    const W=Math.round(rect.w*m);if(W<600||W>6000)continue;
    let rs;try{rs=resampleRegion(img,rect,W);}catch(e){continue;}
    const r=TR.recognize(rs.img,rs.rect,SM,assetList,DB.creatures);
    if(goodRecog(r)){const s=TR.signature(r.mons);const v=votes[s]||(votes[s]={n:0});v.n++;
      if(!v.r){v.r=r;v.img=rs.img;v.rect=rs.rect;}
      if(v.n>=2)break;}                                    // 2표 합의 → 조기 종료(비용 절감)
  }
  const best=Object.values(votes).sort((a,b)=>b.n-a.n)[0];
  if(best)return {r:best.r,img:best.img,rect:best.rect,tag:"재시도 다수결"+best.n+"표"};
  return {r:base,img,rect,tag:"재시도 실패"};
}

async function onTeamRegister(f,a){
  if(state.busy)return;state.busy=true;
  try{
    ensureAssets();
    $("mode").textContent="팀등록";$("conf").textContent="";
    const baseImg={data:f.img.data,width:f.img.width,height:f.img.height};
    const res=recognizeRobust(baseImg,a.rect);            // 원본→실패시 멀티스케일 재시도→다수결
    const r=res.r,img=res.img,rect=res.rect;              // 채택된(복구된) 프레임 좌표계로 이후 처리
    const _good=goodRecog(r);
    const _tab=(r&&r.cells&&r.cells.length)?(TD.isStatTab(img,r.cells[0].card)?"스탯":"능력"):"?";
    // 팀등록은 매 틱 재처리 → 결과가 바뀔 때만 로그(도배 방지)
    const _key=res.tag+"|"+(r&&r.mons?TR.signature(r.mons):"none")+"|"+_good;
    if(_key!==state._recogKey){state._recogKey=_key;
      dlog(`팀등록 인식[${res.tag}]: 유효=${_good} 탭=${_tab} — ${r&&r.mons&&_good?teamName(r.mons):(r&&r.mons?r.mons.map(id=>DB.creatures[id]?DB.creatures[id].ko:"?").join(" "):"-")}`,_good?"ok":"err");}
    // [로컬] 팀등록 풀프레임 데이터셋 캡처 — 탭별 1회(능력/스탯). 원본 캔버스(f.cv) 저장.
    if(CAP&&r&&r.cells&&r.cells.length){try{const st=CAP.teamregister(ipcRenderer,f.cv,_tab==="스탯",r.mons,DB);if(st)dlog("스샷: "+st,"cap");}catch(e){dlog("스샷 오류: "+e.message,"err");}}
    else if(!CAP)dlog("스샷: capture.local.js 없음(캡처 비활성)","err");
    if(!goodRecog(r)){ // 유효 인식 실패(오인식 팀 등록 방지) → 대기
      if(teamStore.pinnedSig)renderTeamPanel();   // 수동 고정 중이면 인식 실패해도 고정 팀 계속 표시
      else if(!teamStore.ui&&!teamStore.lastSig)setTeamContent((r&&r.upscaled)
        ? '<div class="small">캡처 해상도가 낮아 인식이 어려워요. 에뮬레이터 창을 키우거나 해상도를 높이면 정확해집니다.</div>'
        : '<div class="small">팀 화면 인식 중… 6마리가 모두 보이게 두세요</div>');
      state.busy=false;return;
    }
    const sig=TR.signature(r.mons);
    teamStore.lastSig=sig;teamStore.lastMons=r.mons;teamStore.lastTypes=r.types;
    teamStore.lastFrame={img,rect,mons:r.mons,sig};       // 채택 프레임 — 등록 즉시 세트 채우기용
    handleRecognizedTeam(sig,r.mons);
    mergeTeamDetails(sig,r.mons,img,rect); // 세트(수치·성격·아이템) 탭별 누적 (능력탭·스탯탭 각각 채움)
  }catch(err){toast("팀 인식 오류: "+err.message);}
  state.busy=false;
}
function handleRecognizedTeam(sig,mons){
  if(teamStore.pinnedSig)return renderTeamPanel(); // 수동 고정 중 — 캡처 인식으로 표시·활성팀·프롬프트 변경 안 함(세트 병합은 계속)
  const existing=findTeam(sig);
  if(existing){ // 이미 등록된 팀 → 활성화
    if(teamStore.activeSig!==sig){teamStore.activeSig=sig;toast("활성 팀: "+existing.name);dlog("등록된 팀 활성화: "+existing.name,"ok");}
    teamStore.ui=null;return renderTeamPanel();
  }
  if(sig===teamStore.rejectedSig){teamStore.ui=null;return renderTeamPanel();} // 거절한 팀 → 다른 팀까지 대기
  teamStore.ui=teamStore.teams.length<MAX_TEAMS?{mode:"confirm",sig,mons}:{mode:"full",sig,mons};
  dlog("새 팀 인식 → "+(teamStore.teams.length<MAX_TEAMS?"등록 프롬프트":"슬롯가득")+": "+teamName(mons));
  renderTeamPanel();
}
function registerTeam(sig,mons){
  if(!sig||findTeam(sig))return;
  teamStore.teams.push({sig,mons,name:teamName(mons)});
  if(teamStore.teams.length>MAX_TEAMS)teamStore.teams=teamStore.teams.slice(-MAX_TEAMS);
  teamStore.activeSig=sig;teamStore.rejectedSig=null;teamStore.ui=null;saveTeams();
  toast("팀 등록: "+teamName(mons));
  const lf=teamStore.lastFrame;                              // 등록 즉시 세트 채움(다음 인식 틱 안 기다림)
  dlog("팀 등록: "+teamName(mons)+(lf&&lf.sig===sig?" → 저장프레임으로 세트 채움":" (저장프레임 불일치 → 다음 인식틱 대기)"),"ok");
  if(lf&&lf.sig===sig){try{mergeTeamDetails(sig,lf.mons,lf.img,lf.rect);}catch(e){dlog("세트채움 오류: "+e.message,"err");}}
  renderTeamPanel();
}
function deleteTeam(idx){
  const t=teamStore.teams[idx];if(!t)return;
  teamStore.teams.splice(idx,1);
  if(teamStore.activeSig===t.sig)teamStore.activeSig=null;
  if(teamStore.pinnedSig===t.sig){teamStore.pinnedSig=null;closeDetailPanel();} // 고정 팀 삭제 → 고정·상세 해제
  saveTeams();
  toast("팀 삭제: "+t.name);
  const sig=teamStore.lastSig,mons=teamStore.lastMons; // 삭제로 자리 생김 → 방금 인식된 새 팀 바로 등록 확인
  if(sig&&!findTeam(sig)&&teamStore.teams.length<MAX_TEAMS&&sig!==teamStore.rejectedSig)teamStore.ui={mode:"confirm",sig,mons};
  renderTeamPanel();
}
// 인라인 onclick 핸들러(nodeIntegration 렌더러 = window 전역)
window.__team=(action,idx)=>{
  const ui=teamStore.ui,sig=ui?ui.sig:teamStore.lastSig,mons=ui?ui.mons:teamStore.lastMons;
  if(action==="reg")registerTeam(sig,mons);
  else if(action==="rej"){teamStore.rejectedSig=sig;teamStore.ui=null;renderTeamPanel();}
  else if(action==="del")deleteTeam(idx);
  // 등록팀 클릭 → 내 팀으로 수동 고정(캡처 인식 무시). 활성팀도 이 팀으로 전환(배틀 식별에 사용).
  else if(action==="pin"){const t=teamStore.teams[idx];if(t){teamStore.pinnedSig=t.sig;teamStore.activeSig=t.sig;teamStore.ui=null;
    toast("내 팀 고정: "+t.name);dlog("수동 팀 고정: "+t.name,"ok");renderTeamPanel();}}
  // ⟳ 재인식 — 수동 고정 해제 후 현재 화면 즉시 재처리(자동 인식 복귀).
  else if(action==="refresh"){teamStore.pinnedSig=null;teamStore.ui=null;teamStore.rejectedSig=null;
    toast("현재 화면 재인식");dlog("수동 재인식(고정 해제)","ok");tick(true);}
  // 세트 상세 옆칸 열기/닫기·포켓몬 선택(칩 클릭)·◀▶ 이동
  else if(action==="detail"){teamStore.detailOpen=true;renderTeamPanel();}
  else if(action==="mon"){teamStore.detailOpen=true;teamStore.detailIdx=idx|0;renderTeamPanel();}
  else if(action==="dprev"){teamStore.detailIdx--;renderTeamPanel();}
  else if(action==="dnext"){teamStore.detailIdx++;renderTeamPanel();}
  else if(action==="dclose"){closeDetailPanel();renderTeamPanel();}
};
const TYPE_KO={Normal:"노말",Fire:"불꽃",Water:"물",Electric:"전기",Grass:"풀",Ice:"얼음",Fighting:"격투",Poison:"독",Ground:"땅",Flying:"비행",Psychic:"에스퍼",Bug:"벌레",Rock:"바위",Ghost:"고스트",Dragon:"드래곤",Dark:"악",Steel:"강철",Fairy:"페어리"};
// 칩: 클릭 시 세트 상세 옆칸을 그 포켓몬으로 열기(요구사항 5 — 화살표 외 포켓몬 클릭 선택). 선택 중이면 강조.
// 타입은 DB 종족 기준(고정 팀도 정확).
function monChips(mons){return (mons||[]).map((id,i)=>{const c=DB.creatures[id];
  const ty=(c&&c.types)?c.types:[];
  const t=ty.length?`<span class="ttype">${ty.map(x=>TYPE_KO[x]||x).join("·")}</span>`:"";
  const sel=(teamStore.detailOpen&&teamStore.detailIdx===i)?" sel":"";
  return c?
  `<span class="tchip${sel}" onclick="__team('mon',${i})"><img src="../assets/sprites/${c.sprite}.webp" onerror="this.style.visibility='hidden'"><span>${c.ko}</span>${t}</span>`:
  `<span class="tchip${sel}" onclick="__team('mon',${i})"><span>?</span>${t}</span>`;}).join("");}
function renderTeamPanel(){
  const disp=displayTeam();                               // 표시 팀 = 고정(pinnedSig) 우선, 없으면 캡처 인식
  const live=teamStore.lastSig;                           // 프롬프트(등록/거절)는 캡처 인식 팀 기준
  let h=`<div class="thead"><h3>내 팀 (${teamStore.teams.length}/${MAX_TEAMS})</h3>`+
    `<button class="ricon" title="현재 화면 재인식 (자동 인식 복귀)" onclick="__team('refresh')">⟳</button></div>`;
  if(disp.pinned)h+=`<div class="small pinnote">📌 수동 고정 — ⟳ 눌러 자동 인식</div>`;
  h+=`<div class="tteam">${monChips(disp.mons)}</div>`;
  const _k=(disp.team?teamName(disp.team.mons):"미등록")+":"+disp.pinned;
  if(renderTeamPanel._k!==_k){renderTeamPanel._k=_k;dlog(`패널: ${disp.team?teamName(disp.team.mons):"미등록 팀"}${disp.pinned?" (고정)":""}`);}
  if(disp.team)                                            // 등록된 팀이면 세트 상세 열기 버튼
    h+=`<div class="tbtns"><button class="tbtn ok" onclick="__team('detail')">세트 상세 ▸</button></div>`;
  const ui=teamStore.ui;
  if(disp.pinned){}                                        // 고정 중엔 캡처 인식 프롬프트 억제
  else if(ui&&ui.sig===live&&ui.mode==="confirm")
    h+=`<div class="tprompt">이 팀을 새로 등록할까요?</div><div class="tbtns"><button class="tbtn ok" onclick="__team('reg')">등록</button><button class="tbtn" onclick="__team('rej')">거절</button></div>`;
  else if(ui&&ui.sig===live&&ui.mode==="full")
    h+=`<div class="twarn">⚠ 팀 슬롯이 가득 찼습니다 (6/6). 아래에서 하나를 삭제하면 이 팀을 등록합니다.</div>`;
  else if(findTeam(live))
    h+=`<div class="tprompt ok">✔ 등록된 팀${teamStore.activeSig===live?" · 활성":""}</div>`;
  else if(live)
    h+=`<div class="tbtns"><button class="tbtn ok" onclick="__team('reg')">이 팀 등록</button></div>`;
  if(teamStore.teams.length){
    h+=`<h3 style="margin-top:8px">등록된 팀 <span class="small">(클릭 = 내 팀 표시)</span></h3>`;
    teamStore.teams.forEach((t,i)=>{const act=t.sig===teamStore.activeSig,pin=t.sig===teamStore.pinnedSig;
      h+=`<div class="trow${act?" act":""}${pin?" pin":""}"><span class="tnm" title="내 팀으로 표시" onclick="__team('pin',${i})">${pin?"📌 ":""}${t.name}</span><button class="tbtn del" onclick="__team('del',${i})">삭제</button></div>`;});
  }
  setTeamContent(h);
  renderDetail(disp);                                      // 옆칸 세트 상세 갱신(닫혀 있으면 숨김)
}

// ===== 세트 상세 (수치·성격·아이템·EV) — 능력탭/스탯탭 탭별 판독 → 등록팀에 누적 =====
// 스탯탭: 6수치+EV(숫자 템플릿)+성격(화살표). 능력탭: 아이템(메가스톤 여부). 종족 순서(인식순)를 팀 저장순에 정렬 병합.
function readMonDetail(img,card,species,statTab){
  if(!species||!card)return null;
  if(statTab){const s=TD.readStatTab(img,card);if(!s.ok)return null;
    return {tab:"stat",nature:TD.resolveNature(s.up,s.dn,DB.natures),evs:s.evs,stats:s.stats};}
  const ms=TD.detectMegaStone(img,card),mega=megaFormeOf(species); // 메가스톤+종족 메가폼 있으면 메가 확정
  return {tab:"ability",mega:(ms.isMega&&mega)?mega:null,megaStone:!!ms.isMega};
}
function mergeTeamDetails(sig,mons,img,rect){
  const team=findTeam(sig);if(!team){dlog("세트병합: 미등록 팀 → 스킵");return;} // 등록된 팀에만 세트 누적
  let cells;try{cells=TR.detectCells(img,rect);}catch(e){cells=null;}
  if(!cells||cells.length<6){dlog("세트병합: detectCells 실패(카드 못 잡음)","err");return;}
  const statTab=TD.isStatTab(img,cells[0].card);                  // 탭 판별: 수치가 잡히면 스탯탭
  team.details=team.details||team.mons.map(id=>({species:id}));
  const used=new Array(team.mons.length).fill(false);let changed=false,filled=0;
  cells.forEach((cell,i)=>{
    const sp=mons[i],d=readMonDetail(img,cell.card,sp,statTab);if(!d)return;
    let j=team.mons.findIndex((m,k)=>m===sp&&!used[k]);if(j<0)j=team.mons.indexOf(sp);if(j<0)return;
    used[j]=true;filled++;const slot=team.details[j]||(team.details[j]={species:sp});slot.species=sp;
    if(d.tab==="stat"){if(slot.nature!==d.nature||JSON.stringify(slot.evs)!==JSON.stringify(d.evs))changed=true;
      slot.nature=d.nature;slot.evs=d.evs;slot.readStats=d.stats;}
    else{if(slot.mega!==d.mega)changed=true;slot.mega=d.mega;slot.megaStone=d.megaStone;}
    if(slot.mega)ensureMegaIcon(slot.mega);
  });
  dlog(`세트병합: 탭=${statTab?"스탯":"능력"} 채운칸=${filled}/6 변화=${changed?"O":"X"}`, filled>=5?"ok":"err");
  if(!changed)return;                                            // 매 틱 재판독 시 스팸 방지
  saveTeams();
  toast("세트 인식: "+(statTab?"수치·성격":"아이템")+" 반영");
  renderTeamPanel(); // 패널·옆칸 상세 즉시 갱신(표시 중인 팀이면 새 수치 반영, dedup으로 무변화 시 no-op)
}
// 메가 아이콘 확보: SPRITE_INDEX엔 메가폼이 없음 → 스프라이트 webp를 40x40으로 렌더해 배틀 매칭 후보에 추가.
const megaIconTried={};
function ensureMegaIcon(forme){
  if(!forme||megaIconTried[forme])return;ensureAssets();
  if(assetList.some(a=>a.id===forme)){megaIconTried[forme]=true;return;}
  const c=DB.creatures[forme];if(!c)return;megaIconTried[forme]=true;
  const im=new Image();
  im.onload=()=>{try{const cv=document.createElement("canvas");cv.width=40;cv.height=40;
    const ctx=cv.getContext("2d",{willReadFrequently:true});ctx.drawImage(im,0,0,40,40);
    const d=ctx.getImageData(0,0,40,40).data;
    if(!assetList.some(a=>a.id===forme))assetList.push({id:forme,img:{data:new Uint8Array(d),width:40,height:40}});}catch(e){}};
  im.src="../assets/sprites/"+c.sprite+".webp";
}
// 배틀 후보 id에 등록팀 메가폼 포함 (메가 진화 시 인식)
function expandTeamIds(team){const ids=team.mons.slice();
  if(team.details)for(const d of team.details)if(d&&d.mega&&!ids.includes(d.mega))ids.push(d.mega);
  return ids;}
// 세트 상세 옆칸(#detail) — 표시 중인 팀의 1마리를 능력치·성격·특성·기술·아이템까지 펼쳐 보여줌.
// #content(내 팀 목록)을 교체하지 않고 오른쪽 칸을 확장(요구사항 4). 포켓몬 선택은 칩 클릭 또는 ◀▶(요구사항 5).
// 메가면 메가폼 스프라이트·능력치(메가 기준). 특성·기술은 아직 미인식 → 슬롯만 준비(다른 단계에서 채워짐).
function renderDetail(disp){
  const hud=$("hud");
  if(!teamStore.detailOpen||!disp||!disp.mons||!disp.mons.length){ // 닫힘/표시할 팀 없음 → 옆칸 숨김
    hud.classList.remove("detail");if(_detailHtml!==""){_detailHtml="";$("detail").innerHTML="";}return;
  }
  const mons=disp.mons,n=mons.length;
  const idx=((teamStore.detailIdx%n)+n)%n;teamStore.detailIdx=idx;
  const team=disp.team,baseId=mons[idx],d=(team&&team.details&&team.details[idx])||{};
  const showId=d.mega||baseId,c=DB.creatures[showId]||DB.creatures[baseId];
  const natKo=d.nature?(DB.natures[d.nature]?DB.natures[d.nature].ko:d.nature):"—";
  const st=(d.nature||d.evs)?computeStats(showId,d.nature,d.evs):null;
  const ty=((c&&c.types)||[]).map(t=>TYPE_KO[t]||t).join("·");
  let h=`<div class="dv"><div class="dvhead"><button class="tbtn nav" onclick="__team('dprev')">◀</button>`+
    `<span class="dvpos">${idx+1} / ${n}</span><button class="tbtn nav" onclick="__team('dnext')">▶</button>`+
    `<button class="tbtn del" onclick="__team('dclose')">✕</button></div>`;
  h+=`<div class="dvmon"><img src="../assets/sprites/${c?c.sprite:""}.webp" onerror="this.style.visibility='hidden'">`+
    `<div><span class="nm">${c?c.ko:baseId}</span>${d.mega?' <span class="megab">MEGA</span>':""}`+
    `<div class="small">${ty||"-"}</div></div></div>`;
  h+=`<div class="dsec"><span class="dseclab">성격</span><span class="dsecval${d.nature?"":" dim"}">${natKo}</span></div>`;
  if(st){h+=`<div class="dvstats">`;
    for(const[k,lk,lab]of[["h","hp","HP"],["a","atk","공격"],["b","def","방어"],["c","spa","특공"],["d","spd","특방"],["s","spe","스피드"]]){
      const ev=(d.evs&&d.evs[k])||0;
      h+=`<div class="dvst"><span class="dvlab">${lab}</span><span class="dvnum">${st[lk]}</span><span class="dvev">${ev?"노력 "+ev:""}</span></div>`;}
    h+=`</div>`;
    if(d.mega)h+=`<div class="small ok">↑ 메가진화 기준 능력치 (비교에 사용)</div>`;
  }else h+=`<div class="small">${team?"스테이터스 탭을 띄우면 수치·성격이 채워집니다":"이 팀을 등록하면 세트가 채워집니다"}</div>`;
  h+=`<div class="dsec"><span class="dseclab">특성</span><span class="dsecval dim">인식 예정</span></div>`;
  h+=`<div class="dseclab" style="margin-top:6px">기술</div><div class="dvmoves">`;
  for(let m=0;m<4;m++)h+=`<div class="dmove dim">기술 ${m+1} · 인식 예정</div>`;
  h+=`</div>`;
  const item=d.mega?`메가스톤 → ${DB.creatures[d.mega]?DB.creatures[d.mega].ko:d.mega} 진화`:(d.megaStone?"메가스톤":"—");
  h+=`<div class="dsec"><span class="dseclab">아이템</span><span class="dsecval${(d.mega||d.megaStone)?"":" dim"}">${item}</span></div>`;
  h+=`<div class="small dim">특성 · 기술은 텍스트 인식 단계에서 채워집니다</div></div>`;
  hud.classList.add("detail");
  setDetailContent(h);
}

// 배틀: 등록된 활성 팀 6마리 중 내 활성 포켓몬을 이름바 아이콘으로 자동 식별(상대 식별과 동일 경로).
// 신뢰 임계(identifyOppIcon의 ABS_THR/MARGIN) 통과 시에만 수동 선택을 대체 → 불확실하면 수동 유지(오표시 방지).
// 내 이름바 오프셋은 실측 1프레임 기준 잠정값 → 실배틀 프레임으로 튜닝 필요(상대 아이콘과 동일 절차).
function identifyMyMon(f,R){
  const team=activeTeam();if(!team)return;
  const region=cropRegionImg(f,R.myIcon);
  const barH=R.myIcon.barH||Math.round((R.myIcon.y1-R.myIcon.y0)/3);
  const r=identifyOppIcon(region,barH,expandTeamIds(team)); // 메가폼 포함(메가 진화 시 인식)
  if(r&&r.id!==state.myMon){state.myMon=r.id;fetchLive(baseOf(r.id)).then(()=>{if(state.lastScreen==="battle")renderBattle();});toast("내 포켓몬(자동): "+DB.creatures[r.id].ko);}
}

// ===== 클릭 통과 제어 + HUD 드래그 =====
// 기본은 전체 클릭 통과(main이 setIgnoreMouseEvents(true,forward)). 커서가 HUD 위일 때만 캡처 요청 →
// 게임 영역 클릭은 항상 게임으로 통과. (기존 '조작모드'가 전체 화면 클릭을 막던 버그 해결)
(function(){
  const hud=$("hud"),bar=$("dragbar");
  let sx,sy,ox,oy,drag=false,captured=false;
  function setCapture(on){if(on===captured)return;captured=on;hud.classList.toggle("hot",on);ipcRenderer.send("hud-interactive",on);}
  bar.addEventListener("mousedown",e=>{drag=true;sx=e.screenX;sy=e.screenY;
    const r=hud.getBoundingClientRect();ox=r.left;oy=r.top;e.preventDefault();});
  window.addEventListener("mousemove",e=>{
    if(drag){hud.style.left=(ox+e.screenX-sx)+"px";hud.style.top=(oy+e.screenY-sy)+"px";return;}
    if(!hud.classList.contains("on")){setCapture(false);return;}
    const r=hud.getBoundingClientRect();
    setCapture(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom);
  });
  window.addEventListener("mouseup",()=>{drag=false;});
})();
