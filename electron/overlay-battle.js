// overlay-battle.js — 배틀 트랙(2번 클로드 담당): 매칭 감지 · 선출 인식/역할 추정 · 배틀 상대 식별/선공·타수 HUD
// overlay.js(코어)가 먼저 로드되어 제공: DB/E/A/SC/SM/SR, state, $, toast, dlog, tick,
//   baseOf, megaFormesOf, ensureAssets/assetList, ensureMegaIcon, fetchLive, CAP, registerScreen.
// overlay-team.js(1번 클로드 담당)가 제공하는 것: activeTeam(), expandTeamIds(team)  ← identifyMyMon에서만 사용.
// 이 파일은 #content 만 그림(#detail 옆칸은 팀 트랙 전용).

// 설정 창에서 내 포켓몬 수동 선택
ipcRenderer.on("my-mon",(e,{id})=>{
  state.myMon=id;fetchLive(id).then(()=>{if(state.lastScreen==="battle")renderBattle();});
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

// ===== 매칭 화면: 새 매치 진입 1회 → 선출 잠금 자동 해제 =====
function onMatchmakingEnter(){
  state.oppLocked=false;state.oppCur=null;state.oppTeam=[];
  $("content").innerHTML='<div class="small">매칭 중… 선출 화면을 기다립니다</div>';
  toast("새 매치 감지 — 선출 잠금 해제");
}
// Alt+R/재인식 버튼 → 선출 잠금 해제(코어의 force-recognize가 등록된 화면 모듈의 reset을 호출)
function resetOpp(){state.oppLocked=false;state.oppCur=null;}

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

// 배틀: 등록된 활성 팀 6마리 중 내 활성 포켓몬을 이름바 아이콘으로 자동 식별(상대 식별과 동일 경로).
// 신뢰 임계(identifyOppIcon의 ABS_THR/MARGIN) 통과 시에만 수동 선택을 대체 → 불확실하면 수동 유지(오표시 방지).
// 내 이름바 오프셋은 실측 1프레임 기준 잠정값 → 실배틀 프레임으로 튜닝 필요(상대 아이콘과 동일 절차).
// activeTeam/expandTeamIds = overlay-team.js(1번 트랙) 제공 — 등록된 내 팀 정보.
function identifyMyMon(f,R){
  const team=activeTeam();if(!team)return;
  const region=cropRegionImg(f,R.myIcon);
  const barH=R.myIcon.barH||Math.round((R.myIcon.y1-R.myIcon.y0)/3);
  const r=identifyOppIcon(region,barH,expandTeamIds(team)); // 메가폼 포함(메가 진화 시 인식)
  if(r&&r.id!==state.myMon){state.myMon=r.id;fetchLive(baseOf(r.id)).then(()=>{if(state.lastScreen==="battle")renderBattle();});toast("내 포켓몬(자동): "+DB.creatures[r.id].ko);}
}

// 화면 모듈 등록 — 코어 tick이 분류 결과에 따라 호출(enter=전환 1회, handle=매 틱, reset=강제 재인식)
registerScreen("matchmaking",{enter:onMatchmakingEnter});
registerScreen("select",{handle:onSelect,reset:resetOpp});
registerScreen("battle",{handle:onBattle});
