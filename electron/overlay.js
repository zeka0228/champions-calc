// overlay.js — 오버레이 렌더러 **코어**: 캡처 루프 → 화면 분류 → 화면 모듈 디스패치 + 공용 유틸
//
// ▸ 파일 분리(트랙별 담당, 공유 파일 동시편집 충돌 방지):
//     overlay.js         (코어)  캡처·분류·틱·공용 유틸·클릭통과/드래그   — 공용(변경 시 양 트랙 합의)
//     overlay-battle.js  (2번)   매칭·선출·배틀 상대 식별·선공/타수 HUD
//     overlay-team.js    (1번)   내 팀 등록 HUD·세트 상세·세트 편집 UI·스캔 병합
//   HTML 로드 순서: overlay.js → overlay-battle.js → overlay-team.js (전역 스코프 공유, 코어가 먼저)
//
// ▸ 코어가 제공하는 것(두 모듈이 사용): DB/E/A/SC/SM/TR/TD/SR/SD, ipcRenderer, state, $, toast, dlog,
//   tick, grabFrame, baseOf, megaFormeOf/megaFormesOf, ensureAssets/assetList, ensureMegaIcon,
//   fetchLive/liveUsage/usageOf, CAP, TYPE_KO/TYPE_HEX/STAT_KO, registerScreen.
// ▸ 코어는 각 화면 모듈의 내부를 모른다 — registerScreen(name,{enter,handle,leave,reset})로만 연결.
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

// ===== 종족·폼 공용 유틸 =====
function baseOf(id){const c=DB.creatures[id];return c&&c.base&&DB.creatures[c.base]?c.base:id;}
function megaFormeOf(species){const c=DB.creatures[species];if(!c||!c.formes)return null;
  return c.formes.find(f=>/-Mega/.test(f)&&DB.creatures[f])||null;}
// 종족의 모든 메가폼(리자몽 X/Y 등 복수) — 배틀 아이콘 후보/사전 확보용
function megaFormesOf(species){const c=DB.creatures[species];if(!c||!c.formes)return [];
  return c.formes.filter(f=>/-Mega/.test(f)&&DB.creatures[f]);}

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
// 채용률 조회 — live(API) 우선, 내장 폴백. usage.mv/it 이름은 DB.moves/DB.items 키와 동일(pct 0~100).
// ⚠ 폼 우선: 리저널폼은 자체 픽률 키가 있다(Samurott-Hisui|singles 등, API도 폼 데이터 제공).
//   먼저 폼 id로 조회하고 없을 때만 base로 폴백 → 메가·코스메틱폼은 자체 키가 없어 base로 수렴.
//   (기존엔 baseOf로 먼저 뭉개 리저널폼 픽률이 전부 원종 값으로 나오던 버그)
function usagePick(id){return liveUsage[id]||DB.usage[id+"|singles"]||DB.usage[id+"|doubles"]||null;}
function usageOf(id){return usagePick(id)||usagePick(baseOf(id));}

// ===== 상태 =====
const $=id=>document.getElementById(id);
// oppMegaSel = 상대 메가 표시 토글(종족별): {종족: 메가폼id | "off"} — 없으면 자동(필드확인>픽률1위)
// oppMegaUsed = 이 매치에서 상대가 실제로 쓴 메가폼(경기당 1회) — 있으면 나머지 상대는 메가 배제
const state={oppTeam:[],oppMons:[],oppSig:null,oppCur:null,oppMegaSel:{},oppMegaUsed:null,myMon:null,lastHash:null,lastScreen:"other",busy:false,oppLocked:false};
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
const toast=t=>{const e=$("toast");e.textContent=t;e.style.display="block";
  clearTimeout(toast._t);toast._t=setTimeout(()=>e.style.display="none",4000);
  ipcRenderer.send("to-control","overlay-status",t);};
// 진단 로그: control 창 "진단 로그" 패널에 시각순 누적(+ DevTools 콘솔). kind: ""|cap|ok|err
const dlog=(msg,kind)=>{try{console.log("[진단] "+msg);ipcRenderer.send("to-control","diag",{line:msg,kind});}catch(e){}};
// 표시용 라벨 맵(공용)
const TYPE_KO={Normal:"노말",Fire:"불꽃",Water:"물",Electric:"전기",Grass:"풀",Ice:"얼음",Fighting:"격투",Poison:"독",Ground:"땅",Flying:"비행",Psychic:"에스퍼",Bug:"벌레",Rock:"바위",Ghost:"고스트",Dragon:"드래곤",Dark:"악",Steel:"강철",Fairy:"페어리"};
const TYPE_HEX={Normal:"#9099a1",Fire:"#e8663a",Water:"#4d90d5",Electric:"#e0b528",Grass:"#5ca54a",Ice:"#6bc4c6",Fighting:"#c23a4a",Poison:"#9354a0",Ground:"#d98f45",Flying:"#8caadd",Psychic:"#e5628a",Bug:"#94b13a",Rock:"#b7a355",Ghost:"#5a6ab0",Dragon:"#5566d9",Dark:"#5a5366",Steel:"#5b95a3",Fairy:"#e08fca"};
const STAT_KO={hp:"HP",atk:"공격",def:"방어",spa:"특공",spd:"특방",spe:"스피드"};   // 긴 스탯키 → 한글

// ===== 화면 모듈 등록 =====
// 각 트랙이 자기 화면을 등록한다. 코어는 훅만 호출하고 내용은 모른다(파일 분리 계약).
//   enter(prev)  — 그 화면으로 "전환된" 틱에 1회
//   handle(f,a)  — 그 화면인 매 틱 (f=프레임, a=SC.analyze 결과)
//   leave(next)  — 그 화면에서 "벗어난" 틱에 1회
//   reset()      — Alt+R/재인식(force-recognize) 시 상태 초기화
const SCREENS={};
function registerScreen(name,hooks){SCREENS[name]=hooks||{};}

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
// 새 매치/강제 재인식: 각 화면 모듈이 자기 상태를 초기화한 뒤 즉시 재처리
ipcRenderer.on("force-recognize",()=>{
  for(const k in SCREENS){const h=SCREENS[k];if(h&&h.reset)h.reset();}
  state.lastHash=null;tick(true);
  toast("재인식 — 선출 잠금 해제");
});
// [DEV/DEBUG] 현 화면 캡처 — 지금 캡처 중인 게임 프레임을 PNG로 저장(인식 오류 프레임 수집·디버깅용).
// gitignore된 capture.local.js(데이터셋 자동 캡처)와 별개로, 설정창 버튼으로 아무 때나 1장 저장.
// ⚠ 추후 마이그레이션(M5 안드로이드) 시 재구현 대상 — Electron 데스크톱 파일 저장(main의 save-debug-capture)에 의존.
ipcRenderer.on("capture-now",()=>{
  const f=grabFrame();
  if(!f){toast("캡처할 화면이 없어요 — 먼저 설정 창에서 게임 창을 선택하세요");return;}
  try{ipcRenderer.send("save-debug-capture",{dataURL:f.cv.toDataURL("image/png"),screen:state.lastScreen});}
  catch(err){toast("현 화면 캡처 실패: "+err.message);}
});
// main → HUD 토스트(저장 결과 등, 게임 위에 표시)
ipcRenderer.on("toast",(e,t)=>toast(t));

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
  $("mode").textContent={select:"선출",battle:"배틀",matchmaking:"매칭",teamregister:"팀등록",other:"대기"}[a.screen];
  $("conf").textContent=a.conf?Math.round(a.conf*100)+"%":"";
  if(a.lowRes)toast(`캡처가 작아 인식 정확도 저하 가능 (게임영역 ${a.rect.w}px) — 고해상도 캡처 권장`);
  if(CAP)CAP.onScreen(a.screen); // [로컬] 데이터셋 캡처 화면상태 갱신
  // 화면 전환 → 이전 화면 모듈 정리(예: 팀등록 이탈 시 상세 패널 닫기·재렌더 dedupe 리셋)
  if(prev!==a.screen){const p=SCREENS[prev];if(p&&p.leave)p.leave(a.screen);}
  const cur=SCREENS[a.screen];if(!cur)return;
  if(prev!==a.screen&&cur.enter)cur.enter(prev);
  if(cur.handle)await cur.handle(f,a);
}
setInterval(()=>tick(false),1200);

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
