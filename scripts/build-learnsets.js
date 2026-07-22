// build-learnsets.js — Pokemon Showdown 학습기 → 우리 DB 매핑 → ../learnsets.js 재생성
// 사용: node scripts/build-learnsets.js  (인터넷 필요; 또는 learnsets.json 로컬 경로를 argv[2]로)
// 원본: https://play.pokemonshowdown.com/data/learnsets.json (공개 데이터)
// 이름 정규화(소문자+영숫자)로 종족·기술 매칭, 폼 미존재 시 base 폴백. 실측: 316/316 종족 매칭.
const fs=require("fs"),path=require("path"),https=require("https");
const ROOT=path.join(__dirname,"..");
global.window=global;require(path.join(ROOT,"data.js"));
const DB=global.window.DB;
const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,"");

function getLearnsets(){
  const local=process.argv[2];
  if(local)return Promise.resolve(JSON.parse(fs.readFileSync(local,"utf8")));
  return new Promise((res,rej)=>{
    https.get("https://play.pokemonshowdown.com/data/learnsets.json",r=>{
      if(r.statusCode!==200)return rej(new Error("HTTP "+r.statusCode));
      let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});
    }).on("error",rej);
  });
}

getLearnsets().then(LS=>{
  const moveIndex={};for(const k in DB.moves)moveIndex[norm(k)]=k;
  const lsIndex={};for(const k in LS)lsIndex[norm(k)]=LS[k];
  const out={};let matched=0,noLS=0,pairs=0;
  for(const cid in DB.creatures){
    const c=DB.creatures[cid];
    let ls=lsIndex[norm(cid)];
    if((!ls||!ls.learnset)&&c.base)ls=lsIndex[norm(c.base)];
    if(!ls||!ls.learnset){noLS++;continue;}
    matched++;const moves=[];
    for(const mid in ls.learnset){const ok=moveIndex[norm(mid)];if(ok&&!moves.includes(ok)){moves.push(ok);pairs++;}}
    if(moves.length)out[cid]=moves;
  }
  const header="// learnsets.js — 종족별 학습 가능 기술(우리 DB 기술키 배열). Pokemon Showdown learnsets 매핑.\n"+
    "// 재생성: node scripts/build-learnsets.js\n";
  fs.writeFileSync(path.join(ROOT,"learnsets.js"),header+"window.LEARNSETS="+JSON.stringify(out)+";\n");
  console.log(`learnsets.js 생성: 종족 매칭 ${matched}, 미매칭 ${noLS}, (종족,기술) ${pairs}쌍`);
}).catch(e=>{console.error("실패:",e.message);process.exit(1);});
