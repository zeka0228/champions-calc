// build-item-ko.js — DB.items 미번역(영문 ko) 아이템의 한글명을 PokéAPI에서 가져와 ../items-ko-fix.js 재생성
// 사용: node scripts/build-item-ko.js  (인터넷 필요)
// 출처: https://pokeapi.co/api/v2/item/{id} names[language=ko] (공식 로컬라이제이션 = 게임 일치)
const fs=require("fs"),path=require("path"),https=require("https");
const ROOT=path.join(__dirname,"..");
global.window=global;require(path.join(ROOT,"data.js"));
const IT=global.window.DB.items;
const hasHangul=s=>s&&/[가-힣]/.test(s);
const koOf=v=>typeof v==="string"?v:(v&&v.ko);
const missing=Object.keys(IT).filter(k=>!hasHangul(koOf(IT[k])));
const apiId=k=>k.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
function get(url){return new Promise((res,rej)=>{https.get(url,{headers:{"User-Agent":"champions-calc"}},r=>{
  if(r.statusCode!==200){r.resume();return rej(new Error("HTTP "+r.statusCode));}
  let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on("error",rej);});}
// PokéAPI가 한글 로컬라이제이션 없는 경쟁전 신아이템 수동 보충(확실한 것만; 틀린 이름은 넣지 않음).
const MANUAL={"Booster Energy":"부스트에너지","Covert Cloak":"은신망토","Loaded Dice":"로디드다이스",
  "Punching Glove":"펀치글러브","Mirror Herb":"미러허브","Clear Amulet":"클리어참",
  "Cornerstone Mask":"초석의가면","Wellspring Mask":"우물의가면","Hearthflame Mask":"화덕의가면"};

(async()=>{
  const out={},fails=[];
  for(let i=0;i<missing.length;i+=5){
    await Promise.all(missing.slice(i,i+5).map(async k=>{
      const id=apiId(k);
      try{const j=await get(`https://pokeapi.co/api/v2/item/${id}`);
        const ko=(j.names||[]).find(n=>n.language.name==="ko");
        if(ko&&ko.name)out[k]=ko.name;else fails.push(k);
      }catch(e){fails.push(k);}
    }));
  }
  for(const k in MANUAL){if(k in IT&&!out[k]){out[k]=MANUAL[k];const fi=fails.indexOf(k);if(fi>=0)fails.splice(fi,1);}}  // 수동 보충
  const header="// items-ko-fix.js — DB.items 미번역(영문) 아이템의 한글명 보정. 출처: PokéAPI(공식 로컬라이제이션=게임 일치).\n"+
    "// data.js 원본 무수정 원칙 → data.js 로드 후 이 파일을 로드하면 DB.items[key].ko를 패치(자기적용).\n"+
    "// 재생성: node scripts/build-item-ko.js\n";
  const body="window.ITEM_KO_FIX="+JSON.stringify(out)+";\n"+
    "if(typeof window!==\"undefined\"&&window.DB&&window.DB.items){for(var _k in window.ITEM_KO_FIX){var _v=window.DB.items[_k];if(_v){if(typeof _v===\"string\")window.DB.items[_k]=window.ITEM_KO_FIX[_k];else _v.ko=window.ITEM_KO_FIX[_k];}}}\n";
  fs.writeFileSync(path.join(ROOT,"items-ko-fix.js"),header+body);
  console.log(`items-ko-fix.js 생성: ${Object.keys(out).length}/${missing.length} 성공  실패 ${fails.length}`);
  if(fails.length)console.log("실패(PokéAPI 없음/챔피언스 전용):",fails.join(", "));
})();
