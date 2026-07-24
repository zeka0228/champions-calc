// overlay-battle.js — 배틀 트랙(2번 클로드 담당): 매칭 감지 · 선출 인식/역할 추정 · 배틀 상대 식별/선공·타수 HUD
// overlay.js(코어)가 먼저 로드되어 제공: DB/E/A/SC/SM/SR, state, $, toast, dlog, tick,
//   baseOf, megaFormesOf, ensureAssets/assetList, ensureMegaIcon, fetchLive, CAP, registerScreen.
// overlay-team.js(1번 클로드 담당)가 제공하는 것: activeTeam(), expandTeamIds(team)  ← identifyMyMon에서만 사용.
// 이 파일은 #content 만 그림(#detail 옆칸은 팀 트랙 전용).
const BM=require("../shared/battle-mymon.js"); // 배틀 이름바 → 지금 출전한 내 포켓몬 식별

// 설정 창에서 내 포켓몬 수동 선택
ipcRenderer.on("my-mon",(e,{id})=>{
  state.myMon=id;state.myForme=null;fetchLive(id).then(()=>{if(state.lastScreen==="battle")renderBattle();});
  toast("내 포켓몬: "+DB.creatures[id].ko);
});

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

// ===== 상대 메가 판정(경기당 1회) =====
// 규칙: 상대는 한 매치에 메가진화를 한 번만 쓴다 → 필드에서 한 번 확인되면(state.oppMegaUsed)
//       그 종족만 메가로 확정하고 나머지 상대는 메가를 배제한다(스피드·데미지·역할 전부 원종 기준).
// 우선순위: 소진 배제 > 유저 토글(HUD 비메가/메가 버튼) > 필드 확인 > 픽률 1위 메가
// 반환: 표시·계산에 쓸 메가폼 id, 또는 null(메가 아님)
function oppMegaOf(base,onField){
  const megas=megaFormesOf(base);if(!megas.length)return null;
  const used=state.oppMegaUsed,usedBase=used?baseOf(used):null;
  if(usedBase&&usedBase!==base)return null;                  // 다른 상대가 이미 메가 사용 → 이 종족은 배제
  if(usedBase===base)return megas.includes(used)?used:null;  // 실제로 쓴 그 폼으로 확정(토글보다 우선)
  const pick=state.oppMegaSel[base];
  if(pick==="off")return null;                               // 유저가 껐음
  if(pick&&megas.includes(pick))return pick;                 // 유저가 특정 폼 지정(X/Y)
  return onField||oppLikelyMega(base)||null;
}
// analyzer(topSet/firstStrike/koMatrix/estimateRole)에 넘길 forme 인자.
// null을 그대로 넘기면 "override 없음"=usage 기반 메가가 그대로 먹으므로, 메가 배제는 "none" 센티널로 명시해야 한다.
const formeArg=m=>m||"none";

// ===== 매칭 화면: 새 매치 진입 1회 → 선출 잠금 자동 해제 =====
function onMatchmakingEnter(){
  state.oppLocked=false;state.oppCur=null;state.oppTeam=[];
  state.oppMegaSel={};state.oppMegaUsed=null;   // 메가 토글·소진은 매치 단위 상태
  $("content").innerHTML='<div class="small">매칭 중… 선출 화면을 기다립니다</div>';
  toast("새 매치 감지 — 선출 잠금 해제");
}
// Alt+R/재인식 버튼 → 선출 잠금 해제(코어의 force-recognize가 등록된 화면 모듈의 reset을 호출)
function resetOpp(){state.oppLocked=false;state.oppCur=null;state.oppMegaSel={};state.oppMegaUsed=null;}

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
const ROLE_CLS=r=>/물리/.test(r.role)&&/어태커/.test(r.role)?"phys":/특수 어태커|양면/.test(r.role)?"spec":/막이/.test(r.role)?"wall":"sup";
function renderSelect(){
  const el=$("content");el.innerHTML="<h3>상대 팀 역할 추정</h3>";
  const used=state.oppMegaUsed,usedBase=used?baseOf(used):null;
  if(usedBase)el.innerHTML+=`<div class="megaspent">메가 소진 — <b>${koWithMega(used)}</b>가 사용 · 나머지는 메가 배제`
    +` <button class="tbtn mini" onclick="__oppmegareset()">해제</button></div>`;
  for(const o of state.oppMons){
    const id=o.id,base=baseOf(id),c=DB.creatures[id];if(!c)continue;
    const mega=oppMegaOf(base,null);                    // 메가 1회 규칙 반영(다른 상대가 썼으면 null) + 유력 메가폼
    const sc=mega?(DB.creatures[mega]||c):c;            // 메가면 메가 스프라이트/이름
    const r=A.estimateRole(base,formeArg(mega));        // 메가 배제 시 원종 종족값 기준으로 역할 추정
    const d=document.createElement("div");d.className="roleRow";
    d.innerHTML=`<img src="../assets/sprites/${sc.sprite}.webp" onerror="this.style.visibility='hidden'">
      <div><span class="nm">${mega?sc.ko:c.ko}</span>${mega?` <span class="megab">MEGA${base===usedBase?" ✔":""}</span>`:""} <span class="rl ${ROLE_CLS(r)}">${r.role}</span>
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
        state.oppCur=r.id;
        // 상대 메가는 경기당 1회 — 필드에서 메가폼이 확인되는 즉시 기록해 남은 상대의 메가를 배제한다.
        // (메가 선택 토글은 종족별로 유지되므로 상대가 바뀌어도 초기화하지 않는다.)
        const justMega=/-Mega/.test(r.id)&&state.oppMegaUsed!==r.id;
        if(justMega){state.oppMegaUsed=r.id;dlog("상대 메가 소진: "+koWithMega(r.id)+" — 남은 상대 메가 배제","ok");}
        await fetchLive(baseOf(r.id));renderBattle();
        toast("상대: "+koWithMega(r.id)+(justMega?" — 메가 소진(남은 상대 배제)":""));
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
  const used=state.oppMegaUsed,usedBase=used?baseOf(used):null;
  const spent=!!usedBase&&usedBase!==opp;                 // 다른 상대가 메가를 써버림 → 이 상대는 메가 불가
  const confirmed=usedBase===opp;                         // 이 상대가 실제로 메가진화한 것이 확인됨
  const curMega=oppMegaOf(opp,onField);                   // 표시/계산 메가폼(소진 > 토글 > 필드 > 픽률)
  const oppKo=curMega?(DB.creatures[curMega]&&DB.creatures[curMega].ko||DB.creatures[opp].ko):(DB.creatures[opp]?DB.creatures[opp].ko:state.oppCur);
  // 내 쪽도 필드에서 메가진화가 확인되면(myForme) 그 종족값·타입 기준으로 계산.
  const myForme=(state.myForme&&DB.creatures[state.myForme])?state.myForme:null;
  const myTop=A.topSet(my,myForme);
  const myStats=E.calcStats(DB.creatures[myTop.cfg.forme||my],myTop.cfg.nature,myTop.cfg.pts);
  const fsRes=A.firstStrike(myStats.spe,opp,{forme:formeArg(curMega)}); // 메가 OFF면 "none"으로 원종 기준 계산
  const lbl={neu:"무보정",semi:"준속",mx:"최속",scarf:"스카프",est:"픽률1위"};
  const myKo=(myForme?DB.creatures[myForme].ko:DB.creatures[my].ko)+(myForme?' <span class="megab">MEGA</span>':"");
  let html=`<h3>${myKo} vs ${oppKo}${curMega?' <span class="megab">MEGA</span>':""}</h3>`;
  if(megas.length){                                       // 메가폼이 있는 상대 → 메가 켬/끔 토글(복수 메가면 X/Y까지)
    const dis=(spent||confirmed)?" disabled":"";          // 소진(불가)·필드 확인(확정)이면 잠금
    html+=`<div class="megasel"><button class="megabtn plain${curMega?"":" act"}"${dis} onclick="__oppmega('off')">비메가</button>`;
    for(const m of megas){const mk=DB.creatures[m]?DB.creatures[m].ko:m;
      html+=`<button class="megabtn${m===curMega?" act":""}"${dis} onclick="__oppmega('${m}')">${mk}${m===onField?" ●":m===defMega?" ★":""}</button>`;}
    html+=`</div>`;
    if(spent)html+=`<div class="megaspent">상대 메가 소진 — <b>${koWithMega(used)}</b>가 사용 · 이 상대는 메가 불가`
      +` <button class="tbtn mini" onclick="__oppmegareset()">해제</button></div>`;
    else if(confirmed)html+=`<div class="megaspent ok">메가진화 확인(●) — 남은 상대는 메가 배제`
      +` <button class="tbtn mini" onclick="__oppmegareset()">해제</button></div>`;
  }
  html+=`<div class="small">내 실속 ${myStats.spe} (픽률1위 세트 기준 — 추후 내 세트 연동)`
    +(curMega?" · 상대 "+(confirmed?"메가(필드 확인)":"메가 기준"):(megas.length?" · 상대 비메가 기준":""))
    +`</div><div class="spd">`;
  for(const k of["neu","semi","mx","scarf","est"]){
    const s=fsRes.scenarios[k];if(s.spe==null)continue;
    const c=s.first==="me"?"win":s.first==="opp"?"lose":"tie";
    html+=`<span class="${c}">${lbl[k]} ${s.spe}</span>`;
  }
  html+=`</div><div class="small">${fsRes.estNote}</div>`;
  const km=A.koMatrix(myTop.cfg,myTop.atkMoves,opp,null,formeArg(curMega));
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
// 메가 토글: "off"=비메가(원종 기준) / 메가폼 id=그 폼 기준(복수 메가 X/Y 즉시 비교). 종족별로 기억한다.
window.__oppmega=(m)=>{const opp=baseOf(state.oppCur||"");if(!opp)return;
  state.oppMegaSel[opp]=m;renderBattle();};
// 메가 소진 기록 해제(아이콘 오인식으로 잘못 잡혔을 때 수동 복구)
window.__oppmegareset=()=>{state.oppMegaUsed=null;
  if(state.lastScreen==="select")renderSelect();else renderBattle();
  toast("메가 소진 기록 해제");};

// 배틀: "지금 출전한 내 포켓몬"을 좌하단 이름바 아이콘으로 자동 식별.
// 상대 경로(identifyOppIcon)를 그대로 쓰던 이전 방식은 실배틀 프레임에서 사실상 동작하지 않았다:
//   ① 상대 기준 스케일(barH*1.5~3.0)이 내 아이콘 실제 크기와 겹치지 않았고
//   ② 이름바 앵커가 라임 테두리에 의존하는데 그 색이 프레임마다 바뀌어 아이콘이 잘렸다.
// → 영역은 screen-classifier 의 검증된 비율 상자, 식별은 shared/battle-mymon.js(닫힌 집합 최선 채택).
// 후보는 내 등록 팀 + 메가폼(실제 메가진화 시 아이콘이 메가로 바뀜) — 상대의 oppBattleIds 와 같은 방식.
// activeTeam/expandTeamIds = overlay-team.js(1번 트랙) 제공 — 등록된 내 팀 정보.
function myBattleIds(){
  const team=activeTeam();if(!team)return [];
  const ids=expandTeamIds(team);                                   // 6마리 + 스캔으로 확정된 메가폼
  for(const id of team.mons||[])for(const m of megaFormesOf(baseOf(id)))
    if(!ids.includes(m))ids.push(m);                               // 세트 미스캔이어도 메가 대응
  for(const id of ids)if(/-Mega/.test(id))ensureMegaIcon(id);      // 메가 아이콘 사전확보(비동기)
  return ids;
}
// 단발 오인식 차단: 같은 결과가 2틱 연속일 때만 교체(오프라인 22프레임 중 1건이 이 유형이었음).
const myHint={id:null,n:0};
function identifyMyMon(f,R){
  const ids=myBattleIds();if(!ids.length)return;
  ensureAssets();
  const cand=assetList.filter(a=>ids.includes(a.id));
  if(!cand.length)return;
  const r=BM.identify(cropRegionImg(f,R.myIcon),cand);
  if(!r){myHint.id=null;myHint.n=0;return;}                        // 이름바 없음(연출·메뉴) → 판단 보류
  if(r.id===myHint.id)myHint.n++;else{myHint.id=r.id;myHint.n=1;}
  const base=baseOf(r.id);
  if(myHint.n<2||(base===state.myMon&&(state.myForme||null)===(/-Mega/.test(r.id)?r.id:null)))return;
  state.myMon=base;                                                // 계산·표시는 종족 기준(topSet/usage)
  state.myForme=/-Mega/.test(r.id)?r.id:null;                      // 필드에서 확인된 내 메가폼(있으면)
  fetchLive(base).then(()=>{if(state.lastScreen==="battle")renderBattle();});
  toast("내 포켓몬(자동): "+koWithMega(r.id));
}

// 화면 모듈 등록 — 코어 tick이 분류 결과에 따라 호출(enter=전환 1회, handle=매 틱, reset=강제 재인식)
registerScreen("matchmaking",{enter:onMatchmakingEnter});
registerScreen("select",{handle:onSelect,reset:resetOpp});
registerScreen("battle",{handle:onBattle});
