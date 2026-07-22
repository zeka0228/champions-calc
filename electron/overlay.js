// overlay.js — 오버레이 렌더러: 캡처 루프 → 화면 분류 → 인식 → HUD
const {ipcRenderer}=require("electron");
// nodeIntegration 렌더러엔 module이 정의돼 있어 UMD 모듈들이 window에 안 붙음(module.exports로 감).
// → window 전역 대신 require로 로드 (matcher.js 등 원본 무수정). data/spriteindex는 window 직접 할당이라 그대로 사용.
const DB=window.DB;
const E=require("../engine.js"),A=require("../analyzer.js"),
      SC=require("../shared/screen-classifier.js"),SM=require("../matcher.js");
const TR=require("../shared/team-register.js"); // 팀등록 화면 → 내 팀 6마리 인식
const TD=require("../shared/team-detail.js");   // 팀등록 상세 → 세트(수치·성격·아이템·EV) 추출
const SR=require("../shared/select-recognize.js"); // 선출 화면 → 상대 6마리 견고 인식(팀스캔 방식)
const SD=require("../shared/set-detail.js");    // 능력탭 텍스트 인식 → 특성·기술(렌더-매칭)
E.init(DB);
// 렌더-매칭용 텍스트 렌더러(캔버스, 렌더러 전용) — 최초 1회 생성 후 재사용.
let _renderText=null;
function renderText(){return _renderText||(_renderText=SD.makeCanvasRenderer());}

// 세트 유틸 ── 화면 EV 짧은키(h/a/b/c/d/s) → engine.calcStats 긴키(hp/atk/…) 매핑 후 능력치 산출.
// 검증: calcStats(lv50·IV31)가 팀등록 화면 실수치를 완전 재현(EV=calcStats pts). 메가면 메가폼 종족값으로 계산.
const EV_LONG={h:"hp",a:"atk",b:"def",c:"spa",d:"spd",s:"spe"};
function computeStats(species,nature,evs){const pts={};for(const k in(evs||{}))pts[EV_LONG[k]]=evs[k];
  const c=DB.creatures[species];return c?E.calcStats(c,nature||"Serious",pts):null;}
function megaFormeOf(species){const c=DB.creatures[species];if(!c||!c.formes)return null;
  return c.formes.find(f=>/-Mega/.test(f)&&DB.creatures[f])||null;}
// 종족의 모든 메가폼(리자몽 X/Y 등 복수) — 배틀 아이콘 후보/사전 확보용
function megaFormesOf(species){const c=DB.creatures[species];if(!c||!c.formes)return [];
  return c.formes.filter(f=>/-Mega/.test(f)&&DB.creatures[f]);}
// 상대 "유력 메가폼": 채용률 1위 아이템이 메가스톤이면 그 메가폼(analyzer.topSet이 usage로 판정). 아니면 null.
// → 비교(스피드·데미지·역할)는 이미 topSet이 메가 종족값으로 계산하므로, 여기선 "표시 기본을 메가로" 결정하는 신호.
function oppLikelyMega(id){try{const s=A.topSet(baseOf(id));
  return (s&&s.meta&&s.meta.mega&&s.cfg.forme&&DB.creatures[s.cfg.forme])?s.cfg.forme:null;}catch(e){return null;}}
// 배틀 이름바 매칭 후보 = 선출 6마리 + 그들의 모든 메가폼(실제 메가진화 시 아이콘이 메가로 바뀌므로).
function oppBattleIds(){const ids=state.oppTeam.slice();
  for(const id of state.oppTeam)for(const m of megaFormesOf(baseOf(id)))if(!ids.includes(m))ids.push(m);
  return ids;}
// 배틀 표시명: 메가폼이면 "메가XXX", 아니면 종족 한글명
function koWithMega(id){const b=baseOf(id),bk=DB.creatures[b]?DB.creatures[b].ko:id;
  return /-Mega/.test(id)?(DB.creatures[id]&&DB.creatures[id].ko||bk):bk;}

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
const state={oppTeam:[],oppMons:[],oppSig:null,oppCur:null,oppMegaSel:null,myMon:null,lastHash:null,lastScreen:"other",busy:false,oppLocked:false};
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
function closeDetailPanel(){
  if(teamStore.editing){teamStore.editing=null;teamStore.editOptions=null;ipcRenderer.send("overlay-focus",false);} // 편집기 열려있으면 포커스 해제
  teamStore.detailOpen=false;$("hud").classList.remove("detail");if(_detailHtml!==""){_detailHtml="";$("detail").innerHTML="";}
}

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

// ===== 선출 화면: 상대 6마리 매칭 → 역할 추정 =====
// 프레임 독립: analyze()가 게임영역 기준으로 검출한 카드 지오메트리(절대 좌표)를
// matcher.extractSprite 로 소비 (matcher.js 원본 무수정).
async function onSelect(f,a){
  if(state.oppLocked)return; // 한 번 고정하면 재인식 안 함 — 배틀 중 교체 엔트리 등 선출-유사 화면 방지. 새 매치(Alt+R/버튼)에서만 해제
  state.busy=true;
  try{
    ensureAssets();
    const img={data:f.img.data,width:f.img.width,height:f.img.height};
    // 팀스캔과 동일 방식: 타입먼저→후보선필터→항상최선반환→전체후보폴백→빈카드거부→멀티스케일재시도
    const res=SR.recognize(img,a.rect,{SM,SC,TR,assets:assetList,creatures:DB.creatures});
    const mons=res.slots.map((s,i)=>res.ids[i]?{id:res.ids[i],types:s.types||[]}:null).filter(Boolean);
    const good=mons.map(o=>o.id);
    const sig=SR.signature(res.ids);
    if(good.length>=3&&sig!==state.oppSig){          // 결과가 바뀔 때만 갱신(매틱 재렌더 방지)
      state.oppSig=sig;state.oppMons=mons;state.oppTeam=good;
      for(const o of mons){
        fetchLive(baseOf(o.id)).then(()=>{if(state.lastScreen==="select")renderSelect();}); // 채용률(메가 유력 판정 포함) 로드 후 재렌더
        for(const m of megaFormesOf(baseOf(o.id)))ensureMegaIcon(m);                          // 메가폼 아이콘 사전확보(배틀 인식용)
      }
      renderSelect();
      if(good.length>=5){                            // 팀스캔처럼 거의 완전할 때만 고정(오인식 중간프레임 조기고정 방지)
        state.oppLocked=true;
        toast("선출 인식(고정): "+good.map(id=>DB.creatures[id].ko).join(", "));
        dlog("선출 고정: "+good.map(id=>DB.creatures[id]?DB.creatures[id].ko:id).join(",")+` (${good.length}/6)`,"ok");
      }else dlog(`선출 인식중: ${good.length}/6 — 5마리+ 잡히면 고정`,"");
    }
    if(CAP)CAP.select(ipcRenderer,f.cv,res.ids,DB); // [로컬] 선출 프레임 데이터셋 캡처(진입당 1회)
  }catch(err){toast("선출 인식 오류: "+err.message);}
  state.busy=false;
}
function baseOf(id){const c=DB.creatures[id];return c&&c.base&&DB.creatures[c.base]?c.base:id;}
const ROLE_CLS=r=>/물리/.test(r.role)&&/어태커/.test(r.role)?"phys":/특수 어태커|양면/.test(r.role)?"spec":/막이/.test(r.role)?"wall":"sup";
function renderSelect(){
  const el=$("content");el.innerHTML="<h3>상대 팀 역할 추정</h3>";
  for(const o of state.oppMons){
    const id=o.id,base=baseOf(id),c=DB.creatures[id];if(!c)continue;
    const mega=oppLikelyMega(id);                       // 유력 메가폼(채용률1위 메가스톤) — 있으면 메가 기준 표시
    const sc=mega?(DB.creatures[mega]||c):c;            // 메가면 메가 스프라이트/이름
    const r=A.estimateRole(base);                       // estimateRole은 topSet(usage)로 메가 종족값 자동 반영
    const d=document.createElement("div");d.className="roleRow";
    d.innerHTML=`<img src="../assets/sprites/${sc.sprite}.webp" onerror="this.style.visibility='hidden'">
      <div><span class="nm">${mega?sc.ko:c.ko}</span>${mega?' <span class="megab">MEGA</span>':""} <span class="rl ${ROLE_CLS(r)}">${r.role}</span>
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
      const r=identifyOppIcon(region,barH,oppBattleIds()); // 선출 6마리 + 메가폼(실제 메가진화 아이콘 인식)
      if(r&&r.id!==state.oppCur){
        if(CAP)CAP.battle(ipcRenderer,f.cv,r.id,r.score,DB); // [로컬] 배틀 프레임 캡처(식별 변경 시)
        if(baseOf(r.id)!==baseOf(state.oppCur||""))state.oppMegaSel=null; // 다른 상대로 바뀌면 메가 선택 초기화
        state.oppCur=r.id;await fetchLive(baseOf(r.id));renderBattle();
        toast("상대: "+koWithMega(r.id));
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
  // 상대가 메가진화(이름바 아이콘=메가) 또는 채용률상 메가 유력이면 메가 기준으로 표시/계산.
  // firstStrike/koMatrix는 forme override(curMega)로 지정 메가 종족값·타입 사용(복수 메가 X/Y 즉시 비교).
  const megas=megaFormesOf(opp);                          // 이 종족의 메가폼(0/1/2개)
  const onField=/-Mega/.test(state.oppCur)?state.oppCur:null; // 필드에서 실제 메가진화 확인된 폼
  const defMega=oppLikelyMega(opp);                       // 픽률 1위 기본 메가
  let curMega=null;                                       // 표시/계산 메가폼: 유저선택 > 필드확인 > 픽률기본
  if(megas.length)curMega=(state.oppMegaSel&&megas.includes(state.oppMegaSel))?state.oppMegaSel:(onField||defMega||null);
  const oppKo=curMega?(DB.creatures[curMega]&&DB.creatures[curMega].ko||DB.creatures[opp].ko):(DB.creatures[opp]?DB.creatures[opp].ko:state.oppCur);
  const myTop=A.topSet(my);
  const myStats=E.calcStats(DB.creatures[myTop.cfg.forme||my],myTop.cfg.nature,myTop.cfg.pts);
  const fsRes=A.firstStrike(myStats.spe,opp,{forme:curMega});
  const lbl={neu:"무보정",semi:"준속",mx:"최속",scarf:"스카프",est:"픽률1위"};
  let html=`<h3>${DB.creatures[my].ko} vs ${oppKo}${curMega?' <span class="megab">MEGA</span>':""}</h3>`;
  if(megas.length>=2){                                    // 복수 메가(리자몽·라이츄 X/Y) → 즉시 전환 비교 토글
    html+=`<div class="megasel">`;
    for(const m of megas){const mk=DB.creatures[m]?DB.creatures[m].ko:m;
      html+=`<button class="megabtn${m===curMega?" act":""}" onclick="__oppmega('${m}')">${mk}${m===defMega?" ★":""}</button>`;}
    html+=`</div>`;
  }
  html+=`<div class="small">내 실속 ${myStats.spe} (픽률1위 세트 기준 — 추후 내 세트 연동)${curMega?" · 상대 "+(onField?"메가(필드)":"메가 기준"):""}</div><div class="spd">`;
  for(const k of["neu","semi","mx","scarf","est"]){
    const s=fsRes.scenarios[k];if(s.spe==null)continue;
    const c=s.first==="me"?"win":s.first==="opp"?"lose":"tie";
    html+=`<span class="${c}">${lbl[k]} ${s.spe}</span>`;
  }
  html+=`</div><div class="small">${fsRes.estNote}</div>`;
  const km=A.koMatrix(myTop.cfg,myTop.atkMoves,opp,null,curMega);
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
// 복수 메가(X/Y) 선택 → 그 메가 종족값·타입 기준으로 스피드·데미지 재계산(즉시 비교)
window.__oppmega=(m)=>{state.oppMegaSel=m;renderBattle();};

// ===== 내 팀 등록 (팀 상세 화면 자동 인식 → 최대 6팀 유지 · localStorage) =====
// 요구사항: 배틀 아닐 때만 인식(classify가 teamregister로 분리) · 포켓몬 리스트가 등록된 팀과 상이하면 새 팀
// · 6팀 초과 시 알림 후 삭제 · 삭제하면 바로 재인식해 등록 확인 · 거절하면 다른 팀 인식까지 대기.
const MAX_TEAMS=6;
// pinnedSig: 유저가 등록팀을 클릭해 "내 팀"으로 수동 고정한 서명(= 캡처 인식 무시 플래그). ⟳(재인식)로만 해제.
// detailOpen/detailIdx: 세트 상세 옆칸(#detail) 표시 여부와 보고 있는 포켓몬 인덱스.
const teamStore={teams:[],activeSig:null,rejectedSig:null,ui:null,lastSig:null,lastMons:null,
  pinnedSig:null,detailOpen:false,detailIdx:0,
  editing:null,editOptions:null,scanConflict:null}; // editing: 편집기 상태 / scanConflict: 재스캔 충돌 프롬프트
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
window.__team=(action,idx,extra)=>{
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
  // 세트 상세 옆칸 열기/닫기·포켓몬 선택(칩 클릭)·◀▶ 이동 (편집기 열려있으면 먼저 닫음)
  else if(action==="detail"){teamStore.detailOpen=true;closeEditor(false);renderTeamPanel();}
  else if(action==="mon"){teamStore.detailOpen=true;teamStore.detailIdx=idx|0;closeEditor(false);renderTeamPanel();}
  else if(action==="dprev"){teamStore.detailIdx--;closeEditor(false);renderTeamPanel();}
  else if(action==="dnext"){teamStore.detailIdx++;closeEditor(false);renderTeamPanel();}
  else if(action==="dclose"){closeEditor(false);closeDetailPanel();renderTeamPanel();}
  // 세트 편집 — 필드 클릭으로 성격·노력치·특성·기술·아이템 수동 설정
  else if(action==="edit")openEdit(idx,extra);        // idx=필드명, extra=기술슬롯/EV키
  else if(action==="pick")pickOption(idx|0);          // 검색 목록에서 선택(idx=옵션 인덱스)
  else if(action==="clearf")clearField();             // 기술/아이템 비우기
  else if(action==="evset"){setEv(idx);openEditor();} // 노력치 값 설정(버튼)
  else if(action==="evadd"){setEv(currentEv()+(+idx));openEditor();}
  else if(action==="evmax"){const sl=editTeamSlot();if(sl){const rem=EV_MAX-(evSum(sl.evs)-(sl.evs&&sl.evs[teamStore.editing.evKey]||0));setEv(rem);}openEditor();} // 남은 만큼 최대 채움
  else if(action==="evreset")evReset();               // 노력치 전부 0
  else if(action==="ecancel")closeEditor(true);
  // 재스캔 충돌 — 수동 편집 팀의 스캔값이 다를 때
  else if(action==="scanok")applyScanConflict();
  else if(action==="scanno")dismissScanConflict();
};
const TYPE_KO={Normal:"노말",Fire:"불꽃",Water:"물",Electric:"전기",Grass:"풀",Ice:"얼음",Fighting:"격투",Poison:"독",Ground:"땅",Flying:"비행",Psychic:"에스퍼",Bug:"벌레",Rock:"바위",Ghost:"고스트",Dragon:"드래곤",Dark:"악",Steel:"강철",Fairy:"페어리"};
const TYPE_HEX={Normal:"#9099a1",Fire:"#e8663a",Water:"#4d90d5",Electric:"#e0b528",Grass:"#5ca54a",Ice:"#6bc4c6",Fighting:"#c23a4a",Poison:"#9354a0",Ground:"#d98f45",Flying:"#8caadd",Psychic:"#e5628a",Bug:"#94b13a",Rock:"#b7a355",Ghost:"#5a6ab0",Dragon:"#5566d9",Dark:"#5a5366",Steel:"#5b95a3",Fairy:"#e08fca"};
const STAT_KO={hp:"HP",atk:"공격",def:"방어",spa:"특공",spd:"특방",spe:"스피드"};   // 긴 스탯키 → 한글
const STAT_ROWS=[["h","hp","HP"],["a","atk","공격"],["b","def","방어"],["c","spa","특공"],["d","spd","특방"],["s","spe","스피드"]]; // [짧은키, 긴키, 라벨]
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
  // 재스캔 충돌 프롬프트 — 수동 편집 팀의 스캔값이 현재 등록 정보와 다를 때(요구사항 6)
  const sc=teamStore.scanConflict;
  if(sc&&findTeam(sc.sig)){
    h+=`<div class="tconf"><div class="tconf-h">⚠ 스캔 값이 현재 등록 정보와 다릅니다</div>`;
    for(const df of sc.diffs.slice(0,8))
      h+=`<div class="tconf-r"><span class="tconf-l">${df.label}</span><span class="tconf-d"><span class="cf-old">${df.from}</span> → <span class="cf-new">${df.to}</span></span></div>`;
    h+=`<div class="tbtns"><button class="tbtn ok" onclick="__team('scanok')">덮어쓰기</button><button class="tbtn" onclick="__team('scanno')">유지(거절)</button></div></div>`;
  }
  if(disp.team)                                            // 등록된 팀이면 세트 상세 열기 버튼
    h+=`<div class="tbtns"><button class="tbtn ok" onclick="__team('detail')">세트 상세 ▸${disp.team.edited?' <span class="small">✎</span>':""}</button></div>`;
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
  let ability=null,moves=null,item=null;                           // 능력탭 텍스트 인식(렌더-매칭)
  try{const rt=renderText();
    const ab=SD.detectAbility(img,card,species,DB,rt);
    if(ab&&ab.key)ability={key:ab.key,ko:ab.ko};
    const mv=SD.detectMoves(img,card,species,DB,window.LEARNSETS,rt); // 4개 {key,ko,type}(미감지=key null)
    if(mv&&mv.length)moves=mv.map(m=>(m&&m.key)?{key:m.key,ko:m.ko,type:m.type}:null);
    const provided=itemCandFor(species);                          // 채용률 held_item + 종족 메가스톤으로 후보 narrowing(매핑)
    if(provided.length){const it=SD.detectItem(img,card,DB,rt,provided);if(it&&it.key)item={key:it.key,ko:it.ko};}
  }catch(e){dlog("특성·기술·아이템 인식 오류: "+e.message,"err");}
  return {tab:"ability",mega:(ms.isMega&&mega)?mega:null,megaStone:!!ms.isMega,ability,moves,item};
}
// detectItem 후보 narrowing: 채용률(usage.it) held_item + 종족 메가스톤(usage 누락 대비). DB.items 전체(416)는 과다·부정확.
function itemCandFor(species){
  const out=[],seen=new Set();
  const add=k=>{if(!k||seen.has(k)||!DB.items[k])return;seen.add(k);const v=DB.items[k];out.push({key:k,ko:(typeof v==="string")?v:v.ko});};
  const u=usageOf(species);if(u&&u.it)for(const it of u.it)if(it[0]!=="__mega")add(it[0]);
  const c=DB.creatures[species];
  if(c&&c.formes)for(const f of c.formes)if(DB.creatures[f]&&DB.creatures[f].form==="mega")
    for(const ik in DB.items)if(DB.items[ik].mega===f)add(ik);
  return out;
}
function mergeTeamDetails(sig,mons,img,rect){
  const team=findTeam(sig);if(!team){dlog("세트병합: 미등록 팀 → 스킵");return;} // 등록된 팀에만 세트 누적
  let cells;try{cells=TR.detectCells(img,rect);}catch(e){cells=null;}
  if(!cells||cells.length<6){dlog("세트병합: detectCells 실패(카드 못 잡음)","err");return;}
  const statTab=TD.isStatTab(img,cells[0].card);                  // 탭 판별: 수치가 잡히면 스탯탭
  team.details=team.details||team.mons.map(id=>({species:id}));
  const used=new Array(team.mons.length).fill(false);let read=0;const proposals=[];
  cells.forEach((cell,i)=>{
    const sp=mons[i],d=readMonDetail(img,cell.card,sp,statTab);if(!d)return;
    let j=team.mons.findIndex((m,k)=>m===sp&&!used[k]);if(j<0)j=team.mons.indexOf(sp);if(j<0)return;
    used[j]=true;read++;const slot=team.details[j]||(team.details[j]={species:sp});slot.species=sp;
    const monKo=DB.creatures[sp]?DB.creatures[sp].ko:sp,diffs=[];let apply=null;
    if(d.tab==="stat"){
      const natChg=slot.nature!==d.nature,evChg=!evEq(slot.evs,d.evs);  // EV는 값 기반 비교(키 순서 오탐 방지)
      if(natChg)diffs.push({label:`${monKo} 성격`,from:natKoOf(slot.nature),to:natKoOf(d.nature)});
      if(evChg)diffs.push({label:`${monKo} 노력치`,from:evStr(slot.evs),to:evStr(d.evs)});
      if(natChg||evChg)apply=s=>{s.nature=d.nature;s.evs=d.evs;s.readStats=d.stats;};
      else slot.readStats=d.stats;                              // 변화 없어도 실측 수치는 갱신(무해)
    }else{
      const megChg=(slot.mega||null)!==(d.mega||null)||!!slot.megaStone!==!!d.megaStone;
      if((slot.mega||null)!==(d.mega||null))diffs.push({label:`${monKo} 메가`,from:megaLabel(slot),to:megaLabel(d)});
      const abChg=!!(d.ability&&(!slot.ability||slot.ability.key!==d.ability.key)); // 특성 인식
      if(abChg)diffs.push({label:`${monKo} 특성`,from:slot.ability?slot.ability.ko:"없음",to:d.ability.ko});
      const moveChanges=[];                                       // 기술: 감지된 슬롯만 비교(미감지 슬롯은 유지)
      if(d.moves)d.moves.forEach((mv,mi)=>{if(!mv||!mv.key)return;
        const cur=slot.moves&&slot.moves[mi];
        if(!cur||cur.key!==mv.key){moveChanges.push({idx:mi,mv});diffs.push({label:`${monKo} 기술${mi+1}`,from:cur?cur.ko:"없음",to:mv.ko});}});
      const itChg=!!(d.item&&(!slot.item||slot.item.key!==d.item.key)); // 아이템 인식(소지 아이템 텍스트)
      if(itChg)diffs.push({label:`${monKo} 아이템`,from:slot.item?slot.item.ko:"없음",to:d.item.ko});
      if(megChg||abChg||moveChanges.length||itChg)apply=s=>{
        if(megChg){s.mega=d.mega;s.megaStone=d.megaStone;if(s.mega)ensureMegaIcon(s.mega);}
        if(abChg)s.ability={key:d.ability.key,ko:d.ability.ko};
        if(moveChanges.length){s.moves=s.moves||[null,null,null,null];while(s.moves.length<4)s.moves.push(null);
          moveChanges.forEach(mc=>{s.moves[mc.idx]={key:mc.mv.key,ko:mc.mv.ko,type:mc.mv.type};});}
        if(itChg)s.item={key:d.item.key,ko:d.item.ko};
      };
    }
    if(apply)proposals.push({j,diffs,apply});
  });
  dlog(`세트병합: 탭=${statTab?"스탯":"능력"} 읽음=${read}/6 제안=${proposals.length}`, read>=5?"ok":"err");
  if(!proposals.length)return;                                   // 변화 없음 → 매 틱 스팸 방지
  const allDiffs=proposals.flatMap(p=>p.diffs);
  if(team.edited&&allDiffs.length){                              // 수동 편집 팀 + 보이는 차이 → 덮어쓰기 확인(요구사항 6)
    const key=JSON.stringify(allDiffs);
    if(team.lastRejectedScan===key)return;                       // 이미 거절한 동일 스캔 → 재프롬프트 안 함
    if(teamStore.scanConflict&&teamStore.scanConflict.sig===sig&&teamStore.scanConflict.key===key)return; // 이미 프롬프트 중
    teamStore.scanConflict={sig,key,diffs:allDiffs,proposals};
    dlog("스캔 충돌: 수동 편집 값과 상이 → 덮어쓰기 확인 프롬프트","err");
    renderTeamPanel();return;
  }
  proposals.forEach(p=>{const slot=team.details[p.j]||(team.details[p.j]={species:team.mons[p.j]});p.apply(slot);});
  saveTeams();
  toast("세트 인식: "+(statTab?"수치·성격":"특성·기술·아이템")+" 반영");
  renderTeamPanel(); // 패널·옆칸 상세 즉시 갱신(표시 중인 팀이면 새 수치 반영, dedup으로 무변화 시 no-op)
}
function natKoOf(n){return n?(DB.natures[n]?DB.natures[n].ko:n):"없음";}
function megaLabel(x){return x.mega?(DB.creatures[x.mega]?DB.creatures[x.mega].ko:x.mega):(x.megaStone?"메가스톤":"없음");}
function evStr(evs){if(!evs)return "없음";const p=[];for(const[k,,lab]of STAT_ROWS)if(evs[k])p.push(`${lab}${evs[k]}`);return p.length?p.join(" "):"0";}
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
// 등록된 팀이면 각 값을 클릭해 수동 편집 가능(성격·노력치·특성·기술·아이템). 메가면 메가폼 스프라이트·능력치.
function renderDetail(disp){
  const hud=$("hud");
  if(!teamStore.detailOpen||!disp||!disp.mons||!disp.mons.length){ // 닫힘/표시할 팀 없음 → 옆칸 숨김
    hud.classList.remove("detail");if(_detailHtml!==""){_detailHtml="";$("detail").innerHTML="";}return;
  }
  if(teamStore.editing)return; // 편집기 열림 → 옆칸 DOM 유지(주기 재렌더가 편집기를 덮어쓰지 않게)
  const mons=disp.mons,n=mons.length;
  const idx=((teamStore.detailIdx%n)+n)%n;teamStore.detailIdx=idx;
  const team=disp.team,baseId=mons[idx],d=(team&&team.details&&team.details[idx])||{};
  const showId=d.mega||baseId,c=DB.creatures[showId]||DB.creatures[baseId];
  const canEdit=!!team;                                    // 등록된 팀만 편집 가능
  const ev_=canEdit?" editable":"";                        // 편집 가능 표시 클래스
  const nv=d.nature&&DB.natures[d.nature];
  const natKo=d.nature?(nv?nv.ko:d.nature):"—";
  const natSub=nv&&nv.up?`↑${STAT_KO[nv.up]} ↓${STAT_KO[nv.dn]}`:(d.nature?"보정 없음":"");
  const st=(d.nature||d.evs)?computeStats(showId,d.nature,d.evs):null;
  const ty=((c&&c.types)||[]).map(t=>TYPE_KO[t]||t).join("·");
  let h=`<div class="dv"><div class="dvhead"><button class="tbtn nav" onclick="__team('dprev')">◀</button>`+
    `<span class="dvpos">${idx+1} / ${n}</span><button class="tbtn nav" onclick="__team('dnext')">▶</button>`+
    `<button class="tbtn del" onclick="__team('dclose')">✕</button></div>`;
  h+=`<div class="dvmon"><img src="../assets/sprites/${c?c.sprite:""}.webp" onerror="this.style.visibility='hidden'">`+
    `<div><span class="nm">${c?c.ko:baseId}</span>${d.mega?' <span class="megab">MEGA</span>':""}`+
    `<div class="small">${ty||"-"}</div></div></div>`;
  const em=canEdit?`<span class="edmark">✎</span>`:"";       // 편집 가능(클릭) 표시
  // 성격 (클릭 → 편집)
  h+=`<div class="dsec${ev_}" ${canEdit?`onclick="__team('edit','nature')"`:""}><span class="dseclab">성격</span>`+
     `<span class="dsecright"><span class="dsecval${d.nature?"":" dim"}">${natKo}${natSub?` <span class="edsub">${natSub}</span>`:""}</span>${em}</span></div>`;
  // 능력치 + 노력치 초기화 버튼(요구사항)
  if(st){const evT=evSum(d.evs);
    h+=`<div class="dsecrow"><span class="dseclab">능력치 <span class="edsub">노력합 ${evT}/66</span></span>`+
       (canEdit?`<button class="tbtn mini" onclick="__team('evreset')">노력치 초기화</button>`:"")+`</div><div class="dvstats">`;
    for(const[k,lk,lab]of STAT_ROWS){const ev=(d.evs&&d.evs[k])||0;
      h+=`<div class="dvst"><span class="dvlab">${lab}</span><span class="dvnum">${st[lk]}</span>`+
         `<span class="dvev${canEdit?" editable":""}" ${canEdit?`onclick="__team('edit','ev','${k}')"`:""}>${ev?"노력 "+ev:(canEdit?"노력 +":"")}</span></div>`;}
    h+=`</div>`;
    if(d.mega)h+=`<div class="small ok">↑ 메가진화 기준 능력치 (비교에 사용)</div>`;
  }else h+=`<div class="small">${canEdit?"스테이터스 탭을 띄우거나 아래 값을 눌러 직접 입력":"이 팀을 등록하면 세트가 채워집니다"}</div>`;
  // 특성 (클릭 → 편집)
  h+=`<div class="dsec${ev_}" ${canEdit?`onclick="__team('edit','ability')"`:""}><span class="dseclab">특성</span>`+
     `<span class="dsecright"><span class="dsecval${d.ability?"":" dim"}">${d.ability?d.ability.ko:"—"}</span>${em}</span></div>`;
  // 기술 (각 슬롯 클릭 → 편집)
  h+=`<div class="dseclab" style="margin-top:6px">기술</div><div class="dvmoves">`;
  for(let m=0;m<4;m++){const mv=d.moves&&d.moves[m];
    h+=`<div class="dmove${canEdit?" editable":""}${mv?"":" dim"}" ${canEdit?`onclick="__team('edit','move','${m}')"`:""}>`+
       (mv?`<span class="mvt" style="background:${TYPE_HEX[mv.type]||'#555'}">${TYPE_KO[mv.type]||mv.type||""}</span> ${mv.ko}`:`기술 ${m+1} ${canEdit?"추가":"· 인식 예정"}`)+em+`</div>`;}
  h+=`</div>`;
  // 아이템 (클릭 → 편집)
  const itKo=d.item?d.item.ko:(d.mega?`메가스톤 → ${DB.creatures[d.mega]?DB.creatures[d.mega].ko:d.mega}`:(d.megaStone?"메가스톤":"—"));
  h+=`<div class="dsec${ev_}" ${canEdit?`onclick="__team('edit','item')"`:""}><span class="dseclab">아이템</span>`+
     `<span class="dsecright"><span class="dsecval${(d.item||d.mega||d.megaStone)?"":" dim"}">${itKo}</span>${em}</span></div>`;
  h+=`</div>`;
  hud.classList.add("detail");
  setDetailContent(h);
}
// ===== 세트 편집기(#detail 옆칸에서 인라인) — 성격·노력치·특성·기술·아이템 수동 설정 =====
// 편집 대상 = 표시 중인 등록팀의 detailIdx 포켓몬. 편집 중엔 renderDetail이 조기 반환해 편집기 DOM 유지.
function openEdit(field,extra){
  const disp=displayTeam();if(!disp.team)return;                 // 미등록 팀은 편집 불가
  const n=disp.mons.length,idx=((teamStore.detailIdx%n)+n)%n;teamStore.detailIdx=idx;
  teamStore.detailOpen=true;teamStore.evWarn=null;
  teamStore.editing={field,sig:disp.team.sig,idx,query:"",moveIdx:field==="move"?(+extra):null,evKey:field==="ev"?extra:null};
  openEditor();
}
const EV_MAX=66,EV_KEYS=["h","a","b","c","d","s"];               // Champions 노력치 총합 상한(실측: usage sp 스프레드 합=66)
function evSum(evs){if(!evs)return 0;return EV_KEYS.reduce((t,k)=>t+(evs[k]||0),0);}
function evEq(a,b){a=a||{};b=b||{};return EV_KEYS.every(k=>(a[k]||0)===(b[k]||0));}
function editTeamSlot(){const e=teamStore.editing;if(!e)return null;const t=findTeam(e.sig);if(!t)return null;
  t.details=t.details||t.mons.map(id=>({species:id}));
  return t.details[e.idx]||(t.details[e.idx]={species:t.mons[e.idx]});}
function openEditor(){
  const e=teamStore.editing;if(!e)return;
  const team=findTeam(e.sig);if(!team){closeEditor(true);return;}
  const baseId=team.mons[e.idx],c=DB.creatures[baseId];
  const titles={nature:"성격 선택",ability:"특성 선택",move:`기술 ${(+e.moveIdx)+1} 선택`,item:"아이템 선택",ev:`${STAT_KO[EV_LONG[e.evKey]]} 노력치`};
  let h=`<div class="ed"><div class="edhead"><button class="tbtn nav" onclick="__team('ecancel')">◀</button>`+
    `<span class="edtitle">${c?c.ko:baseId} · ${titles[e.field]}</span></div>`;
  if(e.field==="ev"){
    const cur=currentEv(),slot=(team.details&&team.details[e.idx])||{},others=evSum(slot.evs)-cur,remain=Math.max(0,EV_MAX-others);
    h+=`<div class="small edbudget" id="edbudget">노력 총합 <b>${others+cur}</b> / ${EV_MAX} · 이 스탯 최대 ${remain}</div>`+
       `<div class="edev"><button class="tbtn" onclick="__team('evadd',-4)">−4</button>`+
       `<input id="evInput" type="number" min="0" max="${EV_MAX}" oninput="__evInput(this.value)">`+
       `<button class="tbtn" onclick="__team('evadd',4)">+4</button></div>`+
       `<div class="edevq"><button class="tbtn" onclick="__team('evset',0)">0</button>`+
       `<button class="tbtn" onclick="__team('evmax')">최대(${remain})</button>`+
       `<span class="small">실능력치 <b id="evStat">-</b></span></div>`+
       `<div class="evwarn" id="evWarn">${teamStore.evWarn||""}</div>`+
       `<div class="tbtns"><button class="tbtn ok" onclick="__team('ecancel')">완료</button></div>`;
    h+=`</div>`;
    $("hud").classList.add("detail");$("detail").innerHTML=h;_detailHtml=null;
    ipcRenderer.send("overlay-focus",true);
    const s=$("evStat");if(s)s.textContent=evPreview();
    const i=$("evInput");if(i){i.value=cur;i.focus();i.select();}
    return;
  }
  h+=`<input id="editSearch" placeholder="검색…" oninput="__editInput(this.value)">`;
  h+=`<div id="editList" class="edlist"></div>`;
  if(e.field==="move"||e.field==="item")h+=`<div class="tbtns"><button class="tbtn del" onclick="__team('clearf')">비우기</button></div>`;
  h+=`</div>`;
  $("hud").classList.add("detail");$("detail").innerHTML=h;_detailHtml=null; // 편집기 직접 write → 다음 일반 렌더 강제 재작성
  ipcRenderer.send("overlay-focus",true);
  const i=$("editSearch");if(i){i.value=e.query||"";i.focus();}
  if(e.field==="move"||e.field==="item"){                          // live 채용률 확보 → 도착 시 목록 재정렬
    const sp=baseOf(baseId);
    fetchLive(sp).then(()=>{if(teamStore.editing&&teamStore.editing.sig===e.sig&&teamStore.editing.field===e.field)renderEditList();});
  }
  renderEditList();
}
function renderEditList(){
  const e=teamStore.editing;if(!e)return;const team=findTeam(e.sig);if(!team)return;
  const baseId=team.mons[e.idx],q=(e.query||"").trim();
  let opts=[];
  if(e.field==="nature")opts=natureOptions(q);
  else if(e.field==="ability")opts=abilityOptions(baseId,q);
  else if(e.field==="move")opts=moveOptions(baseId,q);
  else if(e.field==="item")opts=itemOptions(baseId,q);
  teamStore.editOptions=opts;
  const el=$("editList");if(!el)return;
  el.innerHTML=opts.length?opts.slice(0,80).map((o,i)=>`<div class="edopt" onclick="__team('pick',${i})">${o.label}</div>`).join("")
    :`<div class="small dim" style="padding:8px">결과 없음</div>`;
}
window.__editInput=(val)=>{if(teamStore.editing){teamStore.editing.query=val;renderEditList();}};
// 타이핑: 저장 시도(재렌더 X, 포커스 유지). 총합 66 초과면 경고 표시 + 실패(적용 안 됨).
window.__evInput=(val)=>{const r=setEv(val);const w=$("evWarn");if(w)w.textContent=teamStore.evWarn||"";
  if(r!==null){const s=$("evStat");if(s)s.textContent=evPreview();const b=$("edbudget");
    if(b){const sl=editTeamSlot(),tot=evSum(sl&&sl.evs),cur=currentEv();b.innerHTML=`노력 총합 <b>${tot}</b> / ${EV_MAX} · 이 스탯 최대 ${Math.max(0,EV_MAX-(tot-cur))}`;}}};
// 옵션 빌더 — {key, ko, label(HTML), ...} 배열. 한글/영문키 검색.
function natureOptions(q){
  return Object.entries(DB.natures).map(([key,v])=>{
    const sub=v.up?`↑${STAT_KO[v.up]} ↓${STAT_KO[v.dn]}`:"보정 없음";
    return {key,ko:v.ko,label:`<b>${v.ko}</b> <span class="edsub">${sub}</span>`};})
    .filter(o=>!q||o.ko.includes(q)||o.key.toLowerCase().includes(q.toLowerCase()))
    .sort((a,b)=>a.ko.localeCompare(b.ko,"ko"));
}
function abilityOptions(species,q){
  const c=DB.creatures[species];if(!c||!c.ab)return [];
  return [...new Set(Object.values(c.ab))].map(key=>{
    const av=DB.abilities[key];const ko=(typeof av==="string")?av:((av&&av.ko)||key);
    return {key,ko,label:`<b>${ko}</b>`};})
    .filter(o=>!q||o.ko.includes(q)||o.key.toLowerCase().includes(q.toLowerCase()));
}
// 채용률 조회 — live(API) 우선, 내장 폴백. usage.mv/it 이름은 DB.moves/DB.items 키와 동일(pct 0~100).
function usageOf(id){id=baseOf(id);return liveUsage[id]||DB.usage[id+"|singles"]||DB.usage[id+"|doubles"]||null;}
function usageRank(list){const rank={},pct={};if(list)list.forEach(([k,p],i)=>{if(rank[k]===undefined){rank[k]=i;pct[k]=p;}});return {rank,pct};}
function moveOptions(species,q){
  const ls=(window.LEARNSETS&&window.LEARNSETS[species])||[],ql=q.toLowerCase();
  const u=usageOf(species),{rank,pct}=usageRank(u&&u.mv);            // 채용률 순위·% (요구사항)
  return ls.map(key=>{const mv=DB.moves[key];if(!mv)return null;const pc=pct[key];
    return {key,ko:mv.ko,type:mv.t,rank:rank[key]!==undefined?rank[key]:9999,
      label:`<span class="mvt" style="background:${TYPE_HEX[mv.t]||'#555'}">${TYPE_KO[mv.t]||mv.t}</span> <b>${mv.ko}</b> <span class="edsub">${pc!=null?"채용 "+Math.round(pc)+"%":(mv.c==="Status"?"변화":mv.p)}</span>`};})
    .filter(Boolean)
    .filter(o=>!q||o.ko.includes(q)||o.key.toLowerCase().includes(ql))
    .sort((a,b)=>a.rank-b.rank||a.ko.localeCompare(b.ko,"ko"));       // 채용률 높은 순, 동순위는 가나다
}
function itemOptions(species,q){
  const c=DB.creatures[species];
  const myMegas=((c&&c.formes)||[]).filter(f=>DB.creatures[f]&&DB.creatures[f].form==="mega");
  const ql=q.toLowerCase();
  const u=usageOf(species),{rank,pct}=usageRank(u&&u.it);            // 아이템 채용률 순위·%
  return Object.entries(DB.items).map(([key,v])=>{
    if(v.mega&&!myMegas.includes(v.mega))return null;                // 다른 포켓몬 전용 메가스톤 제외
    const pc=pct[key],rk=rank[key];
    return {key,ko:v.ko,mega:v.mega||null,rank:rk!==undefined?rk:9999,used:rk!==undefined,
      label:`<b>${v.ko}</b>${pc!=null?` <span class="edsub">채용 ${Math.round(pc)}%</span>`:(v.mega?' <span class="edsub">메가스톤</span>':"")}`};})
    .filter(Boolean)
    .filter(o=>!q||o.ko.includes(q)||o.key.toLowerCase().includes(ql))
    .sort((a,b)=>a.rank-b.rank||(a.mega?0:1)-(b.mega?0:1)||a.ko.localeCompare(b.ko,"ko")); // 채용률 순 → 미채용은 메가스톤 먼저 → 가나다
}
function commitEdit(mut){const slot=editTeamSlot();if(!slot)return;const team=findTeam(teamStore.editing.sig);
  mut(slot);team.edited=true;team.lastRejectedScan=null;saveTeams();}
function pickOption(i){
  const e=teamStore.editing,o=teamStore.editOptions&&teamStore.editOptions[i];if(!e||!o)return;
  if(e.field==="nature")commitEdit(s=>s.nature=o.key);
  else if(e.field==="ability")commitEdit(s=>s.ability={key:o.key,ko:o.ko});
  else if(e.field==="move")commitEdit(s=>{s.moves=s.moves||[null,null,null,null];while(s.moves.length<4)s.moves.push(null);s.moves[e.moveIdx]={key:o.key,ko:o.ko,type:o.type};});
  else if(e.field==="item")commitEdit(s=>{s.item={key:o.key,ko:o.ko};
    if(o.mega){s.mega=o.mega;s.megaStone=true;ensureMegaIcon(o.mega);}else{s.mega=null;s.megaStone=false;}});
  closeEditor(true);
}
function clearField(){
  const e=teamStore.editing;if(!e)return;
  if(e.field==="move")commitEdit(s=>{if(s.moves)s.moves[e.moveIdx]=null;});
  else if(e.field==="item")commitEdit(s=>{s.item=null;s.mega=null;s.megaStone=false;});
  closeEditor(true);
}
function currentEv(){const e=teamStore.editing;if(!e)return 0;const t=findTeam(e.sig);const d=(t&&t.details&&t.details[e.idx])||{};return (d.evs&&d.evs[e.evKey])||0;}
// 노력치 설정 — 총합 66 초과 시 경고 + 실패 처리(적용 안 함, null 반환). 성공 시 값 반환.
function setEv(val){const e=teamStore.editing;if(!e)return null;const slot=editTeamSlot();if(!slot)return null;
  slot.evs=slot.evs||{h:0,a:0,b:0,c:0,d:0,s:0};
  let v=Math.round(+val||0);if(v<0)v=0;if(v>EV_MAX)v=EV_MAX;
  const others=evSum(slot.evs)-(slot.evs[e.evKey]||0);
  if(others+v>EV_MAX){teamStore.evWarn=`⚠ 노력치 총합 ${EV_MAX} 초과 불가 — 다른 스탯 합 ${others} + ${v} = ${others+v}. 값을 다시 확인하세요.`;return null;} // 불가능한 값 → 실패
  teamStore.evWarn=null;slot.evs[e.evKey]=v;
  const team=findTeam(e.sig);team.edited=true;team.lastRejectedScan=null;saveTeams();return v;}
function evPreview(){const e=teamStore.editing;if(!e)return "-";const t=findTeam(e.sig);const d=(t&&t.details&&t.details[e.idx])||{};
  const showId=d.mega||t.mons[e.idx];const st=computeStats(showId,d.nature,d.evs);return st?st[EV_LONG[e.evKey]]:"-";}
// 노력치 초기화 — 표시 중인 팀의 현재 상세 포켓몬 EV 전부 0
function evReset(){const disp=displayTeam();if(!disp.team)return;
  const n=disp.mons.length,idx=((teamStore.detailIdx%n)+n)%n;
  disp.team.details=disp.team.details||disp.team.mons.map(id=>({species:id}));
  const slot=disp.team.details[idx]||(disp.team.details[idx]={species:disp.team.mons[idx]});
  slot.evs={h:0,a:0,b:0,c:0,d:0,s:0};disp.team.edited=true;disp.team.lastRejectedScan=null;saveTeams();
  toast("노력치 초기화");renderTeamPanel();}
function closeEditor(rerender){
  const was=!!teamStore.editing;teamStore.editing=null;teamStore.editOptions=null;teamStore.evWarn=null;
  if(was)ipcRenderer.send("overlay-focus",false);
  _detailHtml=null;                                              // 다음 일반 렌더가 편집기 DOM을 세트뷰로 교체
  if(rerender!==false)renderTeamPanel();
}
// 재스캔 충돌 해소
function applyScanConflict(){const sc=teamStore.scanConflict;if(!sc)return;const team=findTeam(sc.sig);
  if(team){team.details=team.details||team.mons.map(id=>({species:id}));
    sc.proposals.forEach(p=>{const slot=team.details[p.j]||(team.details[p.j]={species:team.mons[p.j]});p.apply(slot);});saveTeams();}
  teamStore.scanConflict=null;toast("스캔 값으로 덮어썼습니다");renderTeamPanel();}
function dismissScanConflict(){const sc=teamStore.scanConflict;if(!sc)return;const team=findTeam(sc.sig);
  if(team){team.lastRejectedScan=sc.key;saveTeams();}                 // 동일 스캔 재프롬프트 방지
  teamStore.scanConflict=null;toast("수동 값 유지");renderTeamPanel();}

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
