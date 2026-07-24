// analyzer.js — 오버레이용 분석 모듈 (순수 로직, Node+브라우저 겸용)
// 기능:
//  1) topSet(id)        : 채용률 1위 기반 추정 세트 구성
//  2) firstStrike(...)  : 선공 판정 (최속/준속/무보정/최저 + 픽률 1위 세트 시나리오)
//  3) koMatrix(...)     : 양방향 기술별 데미지 → 확1/확2/난수 추정
//  4) estimateRole(id)  : 역할 추정 (물리/특수 딜러, 막이, 서포터 등)
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory(typeof require!=="undefined"?null:root.Engine);
  else root.Analyzer=factory(root.Engine);
})(typeof self!=="undefined"?self:this,function(EngineIn){
const E=EngineIn||require("./engine.js");
let DB=null;
let usageProvider=null; // id -> usage (live 우선, 폴백 내장) — 앱에서 주입
function init(db,provider){DB=db;usageProvider=provider||(id=>DB.usage[id+"|singles"]||DB.usage[id+"|doubles"]||null);}
const usageOf=id=>usageProvider?usageProvider(id):null;
const cre=id=>DB.creatures[id];
const SPKEY={h:"hp",a:"atk",b:"def",c:"spa",d:"spd",s:"spe"};

function ptsFromSp(sp){const o={};for(const[k,v]of Object.entries(sp||{}))o[SPKEY[k]]=v;return o;}

// ===== 픽률 1위 추정 세트 =====
// 반환: {cfg(buildSide 입력), moves(4), meta:{natureKo,spread,itemKo,mega,confidence}}
function topSet(id,formeForce){
  const u=usageOf(id);
  const c=cre(id);if(!c)return null;
  let species=id,forme=null;
  const item=u&&u.it&&u.it[0]?u.it[0][0]:"";
  // 1위 아이템이 메가스톤이면 메가폼 기준 (통합 __mega 항목 포함)
  let realItem=item;
  if(item==="__mega"){
    const stone=u.it[0][2];
    realItem=stone||"";
    const mid=(stone&&DB.items[stone]&&DB.items[stone].mega)||((c.formes||[]).find(f=>f.includes("-Mega")));
    if(mid&&DB.creatures[mid])forme=mid;
  }else if(DB.items[item]&&DB.items[item].mega&&DB.creatures[DB.items[item].mega]){
    forme=DB.items[item].mega;
  }
  // 메가폼 강제(복수 메가 X/Y 비교용): usage 기반 forme를 지정 메가폼으로 override(종족값·타입만 바뀜, 세트는 usage 유지)
  // "none" = 메가 배제: usage 1위 아이템이 메가스톤이어도 원종 종족값·타입으로 계산
  //   (상대는 경기당 메가 1회 → 다른 상대가 이미 썼거나, 유저가 HUD에서 메가를 끈 경우)
  if(formeForce==="none")forme=null;
  else if(formeForce&&DB.creatures[formeForce]&&/-Mega/.test(formeForce))forme=formeForce;
  const nature=u&&u.na&&u.na[0]?u.na[0][0]:"Serious";
  const pts=u&&u.sp&&u.sp[0]?ptsFromSp(u.sp[0][0]):{};
  const ability=u&&u.ab&&u.ab[0]?u.ab[0][0]:(c.ab&&(c.ab["0"]||c.ab.H))||"";
  const moves=(u&&u.mv?u.mv.slice(0,4).map(m=>m[0]):[]);
  const atkMoves=(u&&u.mv?u.mv.filter(m=>{const mv=DB.moves[m[0]];return mv&&mv.c!=="Status";}).slice(0,4).map(m=>m[0]):[]);
  const cfg={species,forme,nature,pts,item:realItem,ability,
    boosts:{atk:0,def:0,spa:0,spd:0,spe:0},burn:false};
  return {cfg,moves,atkMoves,usage:u,
    meta:{item,realItem,mega:!!forme,
      natureKo:DB.natures[nature]?DB.natures[nature].ko:nature,
      spreadPct:u&&u.sp&&u.sp[0]?u.sp[0][1]:null,
      naturePct:u&&u.na&&u.na[0]?u.na[0][1]:null}};
}

// ===== 스피드 시나리오 =====
// 상대 종족값 기준: 최저(하강보정 0포인트)/무보정/준속(+32)/최속(1.1*(무보정+32))/최속스카프/픽률1위 세트
function speedScenarios(id,opts){
  opts=opts||{};
  const set=topSet(id,opts.forme);
  const specId=set&&set.cfg.forme?set.cfg.forme:id;
  const b=cre(specId).bs.spe;
  const lo=Math.floor((Math.floor(2*b*50/100)+5)*0.9);
  const neu=Math.floor((2*b+31)*50/100)+5;
  const semi=neu+32;
  const mx=Math.floor((neu+32)*1.1);
  const scarf=Math.floor(mx*1.5);
  let est=null,estNote="";
  if(set&&set.usage){
    const st=E.calcStats(cre(specId),set.cfg.nature,set.cfg.pts);
    est=st.spe;
    if(set.meta.item==="Choice Scarf"||set.meta.realItem==="Choice Scarf")est=Math.floor(est*1.5);
    estNote=set.meta.natureKo+" 스"+(set.cfg.pts.spe||0)
      +(set.meta.realItem&&DB.items[set.meta.realItem]?" · "+DB.items[set.meta.realItem].ko:"")
      +(set.meta.mega?" · 메가":"");
  }
  const f=v=>v==null?null:Math.floor(v*(opts.tailwind?2:1));
  return {base:b,lo:f(lo),neu:f(neu),semi:f(semi),mx:f(mx),scarf:f(scarf),est:f(est),estNote};
}

// ===== 선공 판정 =====
// mySpe: 내 실수치(랭크/스카프/순풍 반영된 값). 반환: 시나리오별 first: 'me'|'opp'|'tie'
function firstStrike(mySpe,oppId,opts){
  opts=opts||{};
  const sc=speedScenarios(oppId,{tailwind:opts.oppTailwind,forme:opts.forme});
  const judge=v=>{
    if(v==null)return null;
    if(v===mySpe)return "tie";
    const meFirst=opts.trickRoom?mySpe<v:mySpe>v;
    return meFirst?"me":"opp";
  };
  const out={mySpe,scenarios:{},estNote:sc.estNote};
  for(const k of["lo","neu","semi","mx","scarf","est"])out.scenarios[k]={spe:sc[k],first:judge(sc[k])};
  // 종합 판정: 픽률 1위 세트 기준 + 최속 기준 병기
  out.verdictEst=out.scenarios.est.first;
  out.verdictMax=out.scenarios.mx.first;
  out.verdictScarf=out.scenarios.scarf.first;
  return out;
}

// ===== 양방향 KO 추정 =====
// atkCfg가 moves로 defCfg를 칠 때: 기술별 {dmg min~max, %范围, ko텍스트}
function koLine(atkCfg,defCfg,moveId,env){
  if(env)E.setEnv(env);
  const atk=E.buildSide(atkCfg),def=E.buildSide(defCfg);
  if(!atk||!def)return null;
  const r=E.calcDamage(atk,def,moveId);
  if(!r)return null; // 변화기
  const hp=def.st.hp;
  const ko=E.koText(r,hp);
  return {move:moveId,moveKo:DB.moves[moveId]?DB.moves[moveId].ko:moveId,
    type:r.mv.t,cat:r.mv.c,min:r.min,max:r.max,hp,
    pctMin:Math.round(r.min/hp*1000)/10,pctMax:Math.round(r.max/hp*1000)/10,
    ko:ko.t,koClass:ko.c,eff:r.eff,notes:r.notes};
}
function koMatrix(myCfg,myMoves,oppId,env,formeForce){
  const oppSet=topSet(oppId,formeForce);
  if(!oppSet)return null;
  const oppCfg=oppSet.cfg;
  const mine=(myMoves||[]).map(m=>koLine(myCfg,oppCfg,m,env)).filter(Boolean);
  const theirs=(oppSet.atkMoves||[]).map(m=>koLine(oppCfg,myCfg,m,env)).filter(Boolean);
  // 위험한 순 정렬
  theirs.sort((a,b)=>b.pctMax-a.pctMax);
  mine.sort((a,b)=>b.pctMax-a.pctMax);
  return {mine,theirs,oppSet};
}

// ===== 역할 추정 =====
const RECOVERY=new Set(["Recover","Roost","Slack Off","Soft-Boiled","Moonlight","Morning Sun","Synthesis",
  "Rest","Wish","Strength Sap","Shore Up","Milk Drink","Jungle Healing","Life Dew"]);
const SETUP_PHYS=new Set(["Swords Dance","Dragon Dance","Bulk Up","Belly Drum","Shift Gear","Curse","Coil","Victory Dance","Hone Claws","Tidy Up"]);
const SETUP_SPEC=new Set(["Nasty Plot","Calm Mind","Quiver Dance","Tail Glow","Geomancy","Torch Song"]);
const SETUP_MIXED=new Set(["Shell Smash","Growth","Work Up","Clangorous Soul"]);
const SPEED_CTRL=new Set(["Tailwind","Trick Room","Icy Wind","Electroweb","Sticky Web","Thunder Wave","Glare","Agility","Rock Polish","Autotomize"]);
const HAZARD=new Set(["Stealth Rock","Spikes","Toxic Spikes"]);
const SCREEN=new Set(["Reflect","Light Screen","Aurora Veil"]);
const STATUS_INFLICT=new Set(["Will-O-Wisp","Toxic","Thunder Wave","Spore","Sleep Powder","Hypnosis","Yawn","Glare","Stun Spore","Nuzzle"]);
const PIVOT=new Set(["U-turn","Volt Switch","Flip Turn","Parting Shot","Teleport","Chilly Reception","Shed Tail","Baton Pass"]);
const DISRUPT=new Set(["Encore","Taunt","Knock Off","Trick","Switcheroo","Haze","Whirlwind","Roar","Dragon Tail","Clear Smog","Perish Song","Destiny Bond"]);
const BULK_ITEM=new Set(["Leftovers","Sitrus Berry","Assault Vest","Eviolite","Rocky Helmet"]);
const OFF_ITEM=new Set(["Choice Band","Choice Specs","Life Orb","Choice Scarf","Muscle Band","Wise Glasses","Expert Belt"]);

function estimateRole(id,formeForce){
  const u=usageOf(id);
  const set=topSet(id,formeForce);
  if(!u||!set)return {role:"정보 없음",tags:[],confidence:0};
  const specId=set.cfg.forme||id;
  const c=cre(specId);
  const tags=[];
  // --- 기술 채용률 가중 집계 ---
  let physW=0,specW=0,statusW=0,total=0;
  let recW=0,setupPhysW=0,setupSpecW=0,spdCtrlW=0,hazardW=0,screenW=0,statusInfW=0,pivotW=0,disruptW=0;
  for(const[m,pct]of(u.mv||[])){
    const mv=DB.moves[m];if(!mv)continue;
    total+=pct;
    if(mv.c==="Physical")physW+=pct;
    else if(mv.c==="Special")specW+=pct;
    else statusW+=pct;
    if(RECOVERY.has(m))recW+=pct;
    if(SETUP_PHYS.has(m))setupPhysW+=pct;
    if(SETUP_SPEC.has(m))setupSpecW+=pct;
    if(SETUP_MIXED.has(m)){setupPhysW+=pct/2;setupSpecW+=pct/2;}
    if(SPEED_CTRL.has(m))spdCtrlW+=pct;
    if(HAZARD.has(m))hazardW+=pct;
    if(SCREEN.has(m))screenW+=pct;
    if(STATUS_INFLICT.has(m))statusInfW+=pct;
    if(PIVOT.has(m))pivotW+=pct;
    if(DISRUPT.has(m))disruptW+=pct;
  }
  // --- 노력치 상위 스프레드 가중 집계 (채용률 가중 평균) ---
  let offPts=0,defPts=0,spePts=0,atkPts=0,spaPts=0,spTot=0;
  for(const[sp,pct]of(u.sp||[]).slice(0,5)){
    spTot+=pct;
    atkPts+=(sp.a||0)*pct;spaPts+=(sp.c||0)*pct;
    offPts+=((sp.a||0)+(sp.c||0))*pct;
    defPts+=((sp.h||0)+(sp.b||0)+(sp.d||0))*pct;
    spePts+=(sp.s||0)*pct;
  }
  if(spTot>0){offPts/=spTot;defPts/=spTot;spePts/=spTot;atkPts/=spTot;spaPts/=spTot;}
  // --- 성격 ---
  const nat=DB.natures[set.cfg.nature]||{};
  // --- 물리/특수 방향 ---
  let physScore=physW+atkPts*1.5+(nat.up==="atk"?25:0)+(nat.dn==="atk"?-40:0)+(c.bs.atk-c.bs.spa)*0.3;
  let specScore=specW+spaPts*1.5+(nat.up==="spa"?25:0)+(nat.dn==="spa"?-40:0)+(c.bs.spa-c.bs.atk)*0.3;
  if(set.cfg.ability==="Huge Power"||set.cfg.ability==="Pure Power")physScore+=60;
  // --- 어태커 vs 막이 ---
  const offInvest=offPts+spePts*0.7;           // 공격+스피드 투자
  const defInvest=defPts+recW*0.5+(BULK_ITEM.has(set.meta.realItem)?15:0)+statusInfW*0.2;
  const supW=spdCtrlW+hazardW+screenW+disruptW*0.6+pivotW*0.4;
  let role,axis=null;
  // 공격 투자(a/c 포인트)가 뚜렷하면 내구 투자와 무관하게 어태커 (벌크 어태커 포함)
  const attacker=Math.max(atkPts,spaPts)>=20||offInvest>defInvest*0.9;
  const bulky=defPts>=24;
  const mixed=Math.min(physScore,specScore)>Math.max(physScore,specScore)*0.6&&physW>15&&specW>15;
  if(attacker){
    axis=physScore>=specScore?"phys":"spec";
    role=mixed?"양면 어태커":(axis==="phys"?"물리 어태커":"특수 어태커");
    if(bulky)role="벌크 "+role;
  }else{
    // 막이/서포터: 어느 쪽을 받는지 — 스프레드의 b vs d
    let bPts=0,dPts=0;
    for(const[sp,pct]of(u.sp||[]).slice(0,5)){bPts+=(sp.b||0)*pct;dPts+=(sp.d||0)*pct;}
    const wallAxis=(c.bs.def+bPts/Math.max(1,spTot))>=(c.bs.spd+dPts/Math.max(1,spTot))?"물리":"특수";
    if(supW>40&&supW>recW)role="서포터";
    else role=wallAxis+"막이";
    if(physScore>specScore*1.3)axis="phys";else if(specScore>physScore*1.3)axis="spec";
  }
  // --- 태그 ---
  const it=set.meta.realItem;
  if(set.meta.mega)tags.push("메가 유력("+Math.round(u.it[0][1])+"%)");
  if(it==="Choice Scarf")tags.push("스카프 주의");
  if(it==="Choice Band")tags.push("밴드");
  if(it==="Choice Specs")tags.push("안경");
  if(it==="Focus Sash")tags.push("기합의띠");
  if(it==="Assault Vest")tags.push("돌격조끼");
  if(it==="Leftovers"||it==="Sitrus Berry")tags.push(DB.items[it]?DB.items[it].ko:it);
  if(setupPhysW+setupSpecW>25){
    const topSetup=(u.mv||[]).find(([m])=>SETUP_PHYS.has(m)||SETUP_SPEC.has(m)||SETUP_MIXED.has(m));
    tags.push("랭업형"+(topSetup?"("+(DB.moves[topSetup[0]]?DB.moves[topSetup[0]].ko:topSetup[0])+" "+Math.round(topSetup[1])+"%)":""));
  }
  if(recW>25)tags.push("회복기");
  const tw=(u.mv||[]).find(([m])=>m==="Tailwind");
  if(tw&&tw[1]>20)tags.push("순풍("+Math.round(tw[1])+"%)");
  const tr=(u.mv||[]).find(([m])=>m==="Trick Room");
  if(tr&&tr[1]>20)tags.push("트릭룸("+Math.round(tr[1])+"%)");
  if(hazardW>25)tags.push("스텔스록/깔개");
  if(screenW>25)tags.push("벽");
  if(statusInfW>30)tags.push("상태기");
  if(pivotW>30)tags.push("유턴/볼체");
  const enc=(u.mv||[]).find(([m])=>m==="Encore");
  if(enc&&enc[1]>25)tags.push("앙코르");
  // 신뢰도: 1위 스프레드/성격 점유율
  const conf=Math.round(((set.meta.spreadPct||0)+(set.meta.naturePct||0))/2);
  return {role,axis,tags,confidence:conf,
    detail:{physW:Math.round(physW),specW:Math.round(specW),statusW:Math.round(statusW),
      offPts:Math.round(offPts),defPts:Math.round(defPts),spePts:Math.round(spePts),
      physScore:Math.round(physScore),specScore:Math.round(specScore),supW:Math.round(supW),recW:Math.round(recW)},
    set};
}

return {init,topSet,speedScenarios,firstStrike,koLine,koMatrix,estimateRole,usageOf:id=>usageOf(id)};
});
