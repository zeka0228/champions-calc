// build-learnsets.js — 포켓몬 챔피언스 실제 학습기 → 우리 DB 매핑 → ../learnsets.js 재생성
// 사용: node scripts/build-learnsets.js  (인터넷 필요; 또는 /api 덤프 로컬 경로를 argv[2]로)
// 원본: https://championsbattledata.com/api  (pokemon[].learnableMoveNames = 포챔스 실제 학습 가능 기술)
// ⚠ 이전 버전은 Pokemon Showdown(SV 기준) learnsets를 썼으나 포챔스는 기술 배분이 달라
//    실제 기술 누락(아쿠스타 아이스스피너 등) + 없는 기술 오염이 심해 렌더매칭이 오답을 냄 → 소스 교체.
// 폼 해석: showdownId/slug/name 직접 → pokemonPages의 battleName(권위) → DB의 c.base → baseName(대표 폼) 순.
// ⚠ 메가는 원종의 메가가 아닐 수 있음 — 메가라이츄=알로라라이츄, 메가야도란=가라르야도란(셸암즈).
//    c.base로 폴백하면 원종 학습기가 붙어 오답 → 페이지 battleName을 먼저 본다.
const fs=require("fs"),path=require("path"),https=require("https");
const ROOT=path.join(__dirname,"..");
global.window=global;require(path.join(ROOT,"data.js"));
const DB=global.window.DB;
const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,"");

function getDump(){
  const local=process.argv[2];
  if(local)return Promise.resolve(JSON.parse(fs.readFileSync(local,"utf8")));
  return new Promise((res,rej)=>{
    https.get("https://championsbattledata.com/api",{headers:{"User-Agent":"champions-calc"}},r=>{
      if(r.statusCode!==200){r.resume();return rej(new Error("HTTP "+r.statusCode));}
      let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});
    }).on("error",rej);
  });
}

getDump().then(API=>{
  const moveIndex={};for(const k in DB.moves)moveIndex[norm(k)]=k;
  // 포챔스 엔트리 색인: 식별자 여러 형태 + 대표 폼(baseName→isForm=false 슬러그)
  const byKey={};
  for(const p of API.pokemon||[])
    for(const k of [p.showdownId,p.slug,p.name,p.battleName,p.showdownName])
      if(k&&!byKey[norm(k)])byKey[norm(k)]=p;
  const baseSlug={},pageBy={};
  for(const pg of API.pokemonPages||[]){
    if(!pg)continue;
    for(const k of [pg.slug,pg.name])if(k&&!pageBy[norm(k)])pageBy[norm(k)]=pg;
    if(!pg.isForm&&pg.baseName&&!baseSlug[norm(pg.baseName)])baseSlug[norm(pg.baseName)]=norm(pg.slug);
  }
  // DB 메가 키(form=mega/mega_x/mega_y) → 포챔스 페이지 슬러그(mega-<원종>[-x|-y])
  const megaPage=(cid,c)=>{
    if(!c||!c.form||!/^mega/.test(c.form)||!c.base)return null;
    const sfx=c.form==="mega_x"?"x":c.form==="mega_y"?"y":"";
    return pageBy["mega"+norm(c.base)+sfx]||null;
  };
  const resolve=cid=>{
    const c=DB.creatures[cid];
    const pg=megaPage(cid,c)||pageBy[norm(cid)];
    return byKey[norm(cid)]
      ||(pg&&pg.battleName&&byKey[norm(pg.battleName)])   // 페이지가 지정한 실제 배틀 개체(폼 정확)
      ||(c&&c.base&&byKey[norm(c.base)])
      ||byKey[baseSlug[norm(cid)]]
      ||(c&&c.base&&byKey[baseSlug[norm(c.base)]])
      ||null;
  };

  const out={};let matched=0,noLS=0,pairs=0;const fails=[],unmapped=new Set();
  for(const cid in DB.creatures){
    const p=resolve(cid);
    if(!p||!p.learnableMoveNames||!p.learnableMoveNames.length){noLS++;fails.push(cid);continue;}
    matched++;const moves=[];
    for(const mn of p.learnableMoveNames){
      const ok=moveIndex[norm(mn)];
      if(!ok){unmapped.add(mn);continue;}
      if(!moves.includes(ok)){moves.push(ok);pairs++;}
    }
    if(moves.length)out[cid]=moves;
  }
  const header="// learnsets.js — 종족별 학습 가능 기술(우리 DB 기술키 배열). 포켓몬 챔피언스 실제 학습기.\n"+
    "// 출처: championsbattledata.com /api → pokemon[].learnableMoveNames (Showdown 아님 — 포챔스는 기술 배분이 다름)\n"+
    "// 재생성: node scripts/build-learnsets.js\n";
  fs.writeFileSync(path.join(ROOT,"learnsets.js"),header+"window.LEARNSETS="+JSON.stringify(out)+";\n");
  console.log(`learnsets.js 생성: 종족 매칭 ${matched}, 미매칭 ${noLS}, (종족,기술) ${pairs}쌍`);
  if(fails.length)console.log("미매칭 종족:",fails.join(", "));
  if(unmapped.size)console.log("DB.moves 미매핑 기술명:",[...unmapped].join(", "));
}).catch(e=>{console.error("실패:",e.message);process.exit(1);});
