// build-move-ko.js — DB.moves 미번역(영문 ko) 기술의 한글명을 PokéAPI에서 가져와 ../moves-ko-fix.js 재생성
// 사용: node scripts/build-move-ko.js  (인터넷 필요)
// 출처: https://pokeapi.co/api/v2/move/{id} names[language=ko] (공식 로컬라이제이션 = 게임 일치)
const fs=require("fs"),path=require("path"),https=require("https");
const ROOT=path.join(__dirname,"..");
global.window=global;require(path.join(ROOT,"data.js"));
const M=global.window.DB.moves;
const hasHangul=s=>/[가-힣]/.test(s);
const missing=Object.keys(M).filter(k=>{const ko=M[k].ko;return !ko||!hasHangul(ko);});
const apiId=k=>k.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
function get(url){return new Promise((res,rej)=>{https.get(url,{headers:{"User-Agent":"champions-calc"}},r=>{
  if(r.statusCode!==200){r.resume();return rej(new Error("HTTP "+r.statusCode));}
  let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on("error",rej);});}
(async()=>{
  const out={},fails=[];
  for(let i=0;i<missing.length;i+=5){
    await Promise.all(missing.slice(i,i+5).map(async k=>{
      const id=apiId(k);
      try{const j=await get(`https://pokeapi.co/api/v2/move/${id}`);
        const ko=(j.names||[]).find(n=>n.language.name==="ko");
        if(ko&&ko.name)out[k]=ko.name;else fails.push(k);
      }catch(e){fails.push(k);}
    }));
  }
  const header="// moves-ko-fix.js — DB.moves 미번역(영문) 기술의 한글명 보정. 출처: PokéAPI(공식 로컬라이제이션=게임 일치).\n"+
    "// data.js 원본 무수정 원칙 → data.js 로드 후 이 파일을 로드하면 DB.moves[key].ko를 패치(자기적용).\n"+
    "// 재생성: node scripts/build-move-ko.js\n";
  const body="window.MOVE_KO_FIX="+JSON.stringify(out)+";\n"+
    "if(typeof window!==\"undefined\"&&window.DB&&window.DB.moves){for(var _k in window.MOVE_KO_FIX){if(window.DB.moves[_k])window.DB.moves[_k].ko=window.MOVE_KO_FIX[_k];}}\n";
  fs.writeFileSync(path.join(ROOT,"moves-ko-fix.js"),header+body);
  console.log(`moves-ko-fix.js 생성: ${Object.keys(out).length}/${missing.length}${fails.length?" 실패: "+fails.join(", "):""}`);
})();
