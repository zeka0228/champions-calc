// engine.js — app.js에서 추출한 순수 계산 엔진 (DOM/상태 독립, Node+브라우저 겸용)
// 원본: app.js — 추후 app.js가 이 모듈을 사용하도록 리팩터링 예정
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.Engine=factory();
})(typeof self!=="undefined"?self:this,function(){
let DB=null, env={weather:"",terrain:"",crit:false};
function init(db,e){DB=db;if(e)env=e;}
function setEnv(e){Object.assign(env,e);}
const STATS = ["hp","atk","def","spa","spd","spe"];
const STAT_KO = {hp:"HP",atk:"공격",def:"방어",spa:"특수공격",spd:"특수방어",spe:"스피드"};
const STAT_KO_S = {hp:"HP",atk:"공",def:"방",spa:"특공",spd:"특방",spe:"스"};
const STAT_KO_M = {hp:"HP",atk:"공격",def:"방어",spa:"특공",spd:"특방",spe:"스피드"};
const SPKEY = {h:"hp",a:"atk",b:"def",c:"spa",d:"spd",s:"spe"};
const CHART = {
Normal:{Rock:.5,Ghost:0,Steel:.5},
Fire:{Fire:.5,Water:.5,Grass:2,Ice:2,Bug:2,Rock:.5,Dragon:.5,Steel:2},
Water:{Fire:2,Water:.5,Grass:.5,Ground:2,Rock:2,Dragon:.5},
Electric:{Water:2,Electric:.5,Grass:.5,Ground:0,Flying:2,Dragon:.5},
Grass:{Fire:.5,Water:2,Grass:.5,Poison:.5,Ground:2,Flying:.5,Bug:.5,Rock:2,Dragon:.5,Steel:.5},
Ice:{Fire:.5,Water:.5,Grass:2,Ice:.5,Ground:2,Flying:2,Dragon:2,Steel:.5},
Fighting:{Normal:2,Ice:2,Poison:.5,Flying:.5,Psychic:.5,Bug:.5,Rock:2,Ghost:0,Dark:2,Steel:2,Fairy:.5},
Poison:{Grass:2,Poison:.5,Ground:.5,Rock:.5,Ghost:.5,Steel:0,Fairy:2},
Ground:{Fire:2,Electric:2,Grass:.5,Poison:2,Flying:0,Bug:.5,Rock:2,Steel:2},
Flying:{Electric:.5,Grass:2,Fighting:2,Bug:2,Rock:.5,Steel:.5},
Psychic:{Fighting:2,Poison:2,Psychic:.5,Dark:0,Steel:.5},
Bug:{Fire:.5,Grass:2,Fighting:.5,Poison:.5,Flying:.5,Psychic:2,Ghost:.5,Dark:2,Steel:.5,Fairy:.5},
Rock:{Fire:2,Ice:2,Fighting:.5,Ground:.5,Flying:2,Bug:2,Steel:.5},
Ghost:{Normal:0,Psychic:2,Ghost:2,Dark:.5},
Dragon:{Dragon:2,Steel:.5,Fairy:0},
Dark:{Fighting:.5,Psychic:2,Ghost:2,Dark:.5,Fairy:.5},
Steel:{Fire:.5,Water:.5,Electric:.5,Ice:2,Rock:2,Steel:.5,Fairy:2},
Fairy:{Fire:.5,Fighting:2,Poison:.5,Dragon:2,Dark:2,Steel:.5}};

const TYPE_ITEM = {"Charcoal":"Fire","Mystic Water":"Water","Magnet":"Electric","Miracle Seed":"Grass",
"Never-Melt Ice":"Ice","Black Belt":"Fighting","Poison Barb":"Poison","Soft Sand":"Ground","Sharp Beak":"Flying",
"Twisted Spoon":"Psychic","Silver Powder":"Bug","Hard Stone":"Rock","Spell Tag":"Ghost","Dragon Fang":"Dragon",
"Black Glasses":"Dark","Metal Coat":"Steel","Silk Scarf":"Normal","Fairy Feather":"Fairy"};

// 반감열매: 해당 타입의 효과굉장 데미지 0.5배 (시몬열매는 노말 무조건)
const RESIST_BERRY = {"Occa Berry":"Fire","Passho Berry":"Water","Wacan Berry":"Electric","Rindo Berry":"Grass",
"Yache Berry":"Ice","Chople Berry":"Fighting","Kebia Berry":"Poison","Shuca Berry":"Ground","Coba Berry":"Flying",
"Payapa Berry":"Psychic","Tanga Berry":"Bug","Charti Berry":"Rock","Kasib Berry":"Ghost","Haban Berry":"Dragon",
"Colbur Berry":"Dark","Babiri Berry":"Steel","Chilan Berry":"Normal","Roseli Berry":"Fairy"};

const MULTI_HIT = {"Icicle Spear":1,"Rock Blast":1,"Bullet Seed":1,"Pin Missile":1,"Scale Shot":1,"Water Shuriken":1,
"Bone Rush":1,"Tail Slap":1,"Arm Thrust":1,"Fury Swipes":1,"Double Hit":2,"Dual Wingbeat":2,"Dragon Darts":2,
"Twineedle":2,"Bonemerang":2,"Double Kick":2,"Dual Chop":2,"Gear Grind":2,"Tachyon Cutter":2,"Twin Beam":2,
"Triple Dive":3,"Surging Strikes":3,"Population Bomb":10};
// 위력이 타수마다 오르는 연속기: 타별 개별 표기
const ASCEND_HIT = {"Triple Axel":[20,40,60],"Triple Kick":[10,20,30]};
const cre=id=>DB.creatures[id];
function effSpecies(side){
  if(!side||!side.species)return null;
  if(side.forme&&DB.creatures[side.forme])return side.forme;
  return side.species;
}
function calcStats(c,natureId,pts){
  const nat=DB.natures[natureId]||{};
  const out={};
  for(const s of STATS){
    const base=c.bs[s];
    if(s==="hp"){out[s]=Math.floor((2*base+31)*50/100)+60+(pts[s]||0);continue;}
    let v=Math.floor((2*base+31)*50/100)+5+(pts[s]||0);
    if(nat.up===s)v=Math.floor(v*1.1);
    else if(nat.dn===s)v=Math.floor(v*0.9);
    out[s]=v;
  }
  return out;
}
const boostMul=s=>s>=0?(2+s)/2:2/(2-s);
function typeEff(t,defTypes){let e=1;for(const d of defTypes){const r=(CHART[t]||{})[d];if(r!==undefined)e*=r;}return e;}
const pm=(v,m)=>Math.floor(v*m);
function grounded(side){
  return !side.types.includes("Flying")&&side.ability!=="Levitate"&&side.item!=="Air Balloon";
}
function calcDamage(atk,def,moveId){
  const mv=DB.moves[moveId];if(!mv)return null;
  const ov=DB.overrides[moveId]||{};
  const notes=[];
  if(ov.fixedDamage){
    if(typeEff(mv.t,def.types)===0)return {min:0,max:0,eff:0,mv,notes};
    return {min:ov.fixedDamage,max:ov.fixedDamage,eff:1,mv,notes:["고정 데미지"]};
  }
  if(mv.c==="Status"||(!mv.p&&!ov.weightTargetPower&&!ov.weightRatioPower&&!ov.extraAtkSpe&&!ov.extraDefSpe))return null;

  const moldBreaker=["Mold Breaker","Teravolt","Turboblaze"].includes(atk.ability);
  const dAb=moldBreaker?"":def.ability;

  let eff=typeEff(mv.t,def.types);
  const IMMUNE={Ground:["Levitate","Earth Eater"],Water:["Water Absorb","Storm Drain","Dry Skin"],
    Electric:["Volt Absorb","Lightning Rod","Motor Drive"],Fire:["Flash Fire","Well-Baked Body"],Grass:["Sap Sipper"]};
  if((IMMUNE[mv.t]||[]).includes(dAb))return {min:0,max:0,eff:0,mv,notes:["특성 "+(DB.abilities[dAb]||dAb)+" 무효"]};
  if(mv.t==="Ground"&&def.item==="Air Balloon")return {min:0,max:0,eff:0,mv,notes:["풍선 무효"]};
  if(dAb==="Wonder Guard"&&eff<2)return {min:0,max:0,eff:0,mv,notes:["불가사의부적"]};
  if(eff===0)return {min:0,max:0,eff:0,mv,notes};

  let P=mv.p;
  if(ov.weightTargetPower){const w=def.c.w||50;P=w>=200?120:w>=100?100:w>=50?80:w>=25?60:w>=10?40:20;}
  if(ov.weightRatioPower){const r=(atk.c.w||50)/(def.c.w||50);P=r>=5?120:r>=4?100:r>=3?80:r>=2?60:40;}
  if(ov.extraAtkHp){notes.push("HP 비례기(만피 가정)");if(moveId==="Flail"||moveId==="Reversal"){P=20;}}
  if(ov.extraAtkSpe){const r=atk.st.spe*boostMul(atk.boosts.spe)/(def.st.spe*boostMul(def.boosts.spe));P=r>=4?150:r>=3?120:r>=2?80:r>=1?60:40;}
  if(ov.extraDefSpe){P=Math.min(150,Math.floor(25*(def.st.spe*boostMul(def.boosts.spe))/(atk.st.spe*boostMul(atk.boosts.spe)))+1);}
  if(moveId==="Facade"&&atk.burn){P*=2;notes.push("페이스 위력 2배");}
  if(moveId==="Acrobatics"&&!atk.item)P*=2;
  let pMod=1;
  if(TYPE_ITEM[atk.item]===mv.t)pMod*=1.2;
  if(atk.item==="Muscle Band"&&mv.c==="Physical")pMod*=1.1;
  if(atk.item==="Wise Glasses"&&mv.c==="Special")pMod*=1.1;
  if(atk.ability==="Technician"&&P<=60)pMod*=1.5;
  if(atk.ability==="Tough Claws"&&mv.ct)pMod*=1.3;
  if(atk.ability==="Iron Fist"&&mv.pu)pMod*=1.2;
  if(atk.ability==="Sharpness"&&mv.sl)pMod*=1.5;
  if(atk.ability==="Punk Rock"&&mv.sd)pMod*=1.3;
  if(atk.ability==="Sheer Force"&&mv.se)pMod*=1.3;
  if(atk.ability==="Water Bubble"&&mv.t==="Water")pMod*=2;
  if((atk.ability==="Steelworker"||atk.ability==="Steely Spirit")&&mv.t==="Steel")pMod*=1.5;
  if(atk.ability==="Dragon's Maw"&&mv.t==="Dragon")pMod*=1.5;
  if(atk.ability==="Transistor"&&mv.t==="Electric")pMod*=1.3;
  if(atk.ability==="Rocky Payload"&&mv.t==="Rock")pMod*=1.5;
  if(dAb==="Heatproof"&&mv.t==="Fire")pMod*=0.5;
  if(dAb==="Purifying Salt"&&mv.t==="Ghost")pMod*=0.5;
  if(dAb==="Dry Skin"&&mv.t==="Fire")pMod*=1.25;
  P=Math.max(1,pm(P,pMod));

  let aKey=mv.c==="Physical"?"atk":"spa";
  let dKey=mv.c==="Physical"?"def":"spd";
  if(ov.atkPtKey)aKey=ov.atkPtKey;
  if(ov.defPtKey)dKey=ov.defPtKey;
  const aSrc=ov.atkRowFromDefender?def:atk;
  let A=aSrc.st[aKey];
  A=pm(A,env.crit&&aSrc.boosts[aKey]<0?1:boostMul(aSrc.boosts[aKey]));
  let D=def.st[dKey];
  D=pm(D,env.crit&&def.boosts[dKey]>0?1:boostMul(def.boosts[dKey]));

  if((atk.ability==="Huge Power"||atk.ability==="Pure Power")&&aKey==="atk")A=pm(A,2);
  if(atk.ability==="Hustle"&&aKey==="atk")A=pm(A,1.5);
  if(atk.ability==="Guts"&&atk.burn&&aKey==="atk")A=pm(A,1.5);
  if(atk.ability==="Solar Power"&&env.weather==="sun"&&aKey==="spa")A=pm(A,1.5);
  if(atk.item==="Choice Band"&&aKey==="atk")A=pm(A,1.5);
  if(atk.item==="Choice Specs"&&aKey==="spa")A=pm(A,1.5);
  if(atk.item==="Light Ball"&&atk.c.base==="Pikachu")A=pm(A,2);
  if(dAb==="Fur Coat"&&dKey==="def")D=pm(D,2);
  if(dAb==="Ice Scales"&&mv.c==="Special")D=pm(D,2);
  if(def.item==="Assault Vest"&&dKey==="spd")D=pm(D,1.5);
  if(def.item==="Eviolite"&&def.c.nfe)D=pm(D,1.5);
  if(env.weather==="sand"&&def.types.includes("Rock")&&dKey==="spd")D=pm(D,1.5);
  if(env.weather==="snow"&&def.types.includes("Ice")&&dKey==="def")D=pm(D,1.5);

  let base=Math.floor(Math.floor(Math.floor(2*50/5+2)*P*A/D)/50)+2;

  let mod=1;
  if(env.weather==="sun"){if(mv.t==="Fire")mod*=1.5;if(mv.t==="Water")mod*=0.5;}
  if(env.weather==="rain"){if(mv.t==="Water")mod*=1.5;if(mv.t==="Fire")mod*=0.5;}
  if(env.terrain==="electric"&&mv.t==="Electric"&&grounded(atk))mod*=1.3;
  if(env.terrain==="grassy"&&mv.t==="Grass"&&grounded(atk))mod*=1.3;
  if(env.terrain==="psychic"&&mv.t==="Psychic"&&grounded(atk))mod*=1.3;
  if(env.terrain==="misty"&&mv.t==="Dragon"&&grounded(def)){mod*=0.5;notes.push("미스트필드");}
  if(env.terrain==="grassy"&&["Earthquake","Bulldoze","Magnitude"].includes(moveId)){mod*=0.5;notes.push("그래스필드 반감");}
  if(def.screen&&!env.crit)mod*=0.5;
  if(env.crit)mod*=1.5;
  // 변환자재/리베로: 모든 기술이 자속
  const protean=atk.ability==="Protean"||atk.ability==="Libero";
  const stab=(protean||atk.types.includes(mv.t))?(atk.ability==="Adaptability"?2:1.5):1;
  if(protean&&!atk.types.includes(mv.t))notes.push("변환자재 자속");
  const burnMod=(atk.burn&&mv.c==="Physical"&&atk.ability!=="Guts"&&moveId!=="Facade")?0.5:1;
  let post=1;
  if(atk.ability==="Tinted Lens"&&eff<1)post*=2;
  if(atk.ability==="Neuroforce"&&eff>1)post*=1.25;
  if((dAb==="Filter"||dAb==="Solid Rock"||dAb==="Prism Armor")&&eff>1)post*=0.75;
  if(dAb==="Multiscale"||dAb==="Shadow Shield"){post*=0.5;notes.push("멀티스케일(만피 가정)");}
  if(dAb==="Thick Fat"&&(mv.t==="Fire"||mv.t==="Ice"))post*=0.5;
  if(dAb==="Fluffy"){if(mv.ct)post*=0.5;if(mv.t==="Fire")post*=2;}
  if(atk.item==="Life Orb")post*=1.3;
  if(atk.item==="Expert Belt"&&eff>1)post*=1.2;
  // 반감열매: 계산에는 미적용, 경고만 표시 (1회용이라 발동 여부 불확실)
  const rbType=RESIST_BERRY[def.item];
  if(rbType===mv.t&&(eff>1||rbType==="Normal"))
    notes.push("⚠ "+(DB.items[def.item]?DB.items[def.item].ko:def.item)+" 발동 시 반감");
  // 변환자재/리베로: 현재 속성 미지정 시에만 경고 (지정 시 해당 타입으로 계산됨)
  if((dAb==="Protean"||dAb==="Libero")&&!(def.cfg&&def.cfg.curType))
    notes.push("⚠ 변환자재: '현재 속성'을 지정하면 정확히 계산돼요");
  else if((dAb==="Protean"||dAb==="Libero")&&def.cfg&&def.cfg.curType)
    notes.push("현재 속성 "+(DB.typesKo[def.cfg.curType]||def.cfg.curType)+" 기준");

  const dmg=r=>Math.max(1,Math.floor(Math.floor(Math.floor(Math.floor(Math.floor(pm(base,mod)*r/100)*stab)*eff)*burnMod)*post));
  let min,max,perRoll,hitParts=null;
  const asc=ASCEND_HIT[moveId];
  if(asc){ // 트리플악셀류: 타별 위력(20/40/60 등)으로 개별 계산
    const per=asc.map(hp2=>{
      const b2=Math.floor(Math.floor(Math.floor(2*50/5+2)*Math.max(1,pm(hp2,pMod))*A/D)/50)+2;
      const d2=r=>Math.max(1,Math.floor(Math.floor(Math.floor(Math.floor(Math.floor(pm(b2,mod)*r/100)*stab)*eff)*burnMod)*post));
      return {min:d2(85),max:d2(100),d2};
    });
    min=per.reduce((a,x)=>a+x.min,0);max=per.reduce((a,x)=>a+x.max,0);
    perRoll=Array.from({length:16},(_,i)=>per.reduce((a,x)=>a+x.d2(85+i),0));
    hitParts=per.map(x=>({min:x.min,max:x.max}));
    let cum=0;
    notes.push(per.map((x,i)=>{cum+=x.max;return `${i+1}타 ${x.min}~${x.max}(누적~${cum})`;}).join(" · "));
    if(mv.ac)notes.push("각 타 명중 "+mv.ac+"%");
  }else{
    min=dmg(85);max=dmg(100);
    perRoll=Array.from({length:16},(_,i)=>dmg(85+i));
    const hits=MULTI_HIT[moveId];
    if(hits!==undefined){
      if(hits===1)notes.push("연속기 2~5회 (1회당 표시)");
      else{
        hitParts=Array.from({length:hits},()=>({min,max}));
        notes.push(hits+"회 합산 · 1회당 "+min+"~"+max);
        min*=hits;max*=hits;
      }
    }
  }
  // 기합의띠: 만피 확정 1타여도 1회 버팀
  if(def.item==="Focus Sash"&&min>=def.st.hp)notes.push("기합의띠: 만피 시 1회 버팀");
  return {min,max,eff,mv,notes,perRoll,hitParts};
}
function koText(res,hp){
  if(!res||res.max===0)return {t:"무효",c:"ko3"};
  const nMax=Math.ceil(hp/res.max),nMin=Math.ceil(hp/res.min);
  if(nMax===1&&nMin===1)return {t:"확정 1타",c:"ko1"};
  if(nMax===1){let cnt=0;if(res.perRoll)for(const d of res.perRoll)if(d>=hp)cnt++;
    return {t:"난수 1타"+(cnt?` (${(cnt/16*100).toFixed(0)}%)`:""),c:"ko2"};}
  if(nMax===nMin)return {t:`확정 ${nMax}타`,c:nMax===2?"ko2":"ko3"};
  return {t:`난수 ${nMax}타`,c:nMax===2?"ko2":"ko3"};
}
const isProtean=ab=>ab==="Protean"||ab==="Libero";
function buildSide(cfg){
  const spec=effSpecies(cfg);if(!spec)return null;
  const c=cre(spec);
  // 변환자재/리베로 + 현재 속성 지정 시: 해당 단일 타입으로 수비 상성 계산
  const types=(isProtean(cfg.ability)&&cfg.curType)?[cfg.curType]:c.types;
  return {c,types,st:calcStats(c,cfg.nature,cfg.pts),ability:cfg.ability,
    item:cfg.item,boosts:cfg.boosts,burn:cfg.burn,screen:false,cfg};
}

return {init,setEnv,get env(){return env;},STATS,SPKEY,CHART,typeEff,calcStats,boostMul,pm,grounded,calcDamage,koText,buildSide,cre,effSpecies,isProtean,MULTI_HIT,ASCEND_HIT};
});
