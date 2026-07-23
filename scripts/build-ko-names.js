// build-ko-names.js — 기술·아이템 한글명을 포켓몬 챔피언스 한국어 데이터로 보정
//                     → ../moves-ko-fix.js, ../items-ko-fix.js 재생성
// 사용: node scripts/build-ko-names.js   (인터넷 필요)
//
// 출처: 포케모음 https://pokemoem.com (포켓몬 챔피언스 전용 한국어 사이트).
//   SPA 번들(/assets/index-*.js)에 게임 데이터가 통째로 들어있고, 각 레코드에 nameko(한글명)가 있음.
//   번들 파일명 해시는 배포마다 바뀌므로 루트 HTML에서 매번 파싱한다.
//
// ⚠ 왜 PokéAPI가 아니라 이걸 쓰는가:
//   렌더-매칭은 화면 글자와 후보 한글명의 형태를 겹쳐 비교하므로 **게임 표기와 한 글자도 다르면 안 된다**.
//   data.js 원본 한글명에는 구버전/오역이 섞여 있었고(태만함→게으름피우기, 얼다바람→얼어붙은바람,
//   찝게햄머→집게해머 등 52건), PokéAPI도 일부 항목이 이 게임 표기와 달랐다.
//   포케모음은 챔피언스 전용 한국어 소스라 이쪽을 1순위로 삼는다. 특성 187개는 원래 전부 일치(보정 0건).
//
// ⚠ 포케모음 vs PokéAPI가 갈리는 소수 항목(실사용): Brick Break(깨트리기/깨뜨리다),
//   Covet(탐내기/탐내다), Spicy Extract(하바네로액기스/하바네로엑기스).
//   **유저 확인(2026-07-24): 갈리면 포케모음이 맞다** (Brick Break=깨트리기). → 포케모음 단일 소스로 간다.
const fs=require("fs"),path=require("path"),https=require("https"),zlib=require("zlib");
const ROOT=path.join(__dirname,"..");
global.window=global;require(path.join(ROOT,"data.js"));
const DB=global.window.DB;
const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,"");

// 실게임 확인으로 확정된 표기만 여기에 (포케모음보다 우선). 지금은 비어 있음 —
// 유저 결정(2026-07-24): **소스가 갈리면 포케모음을 따른다**(Brick Break=깨트리기 확인).
const OVERRIDE={moves:{},items:{}};

function get(url){return new Promise((res,rej)=>{
  const req=https.get(url,{headers:{"User-Agent":"champions-calc","Accept-Language":"ko-KR","Accept-Encoding":"gzip, deflate, br"}},r=>{
    if(r.statusCode!==200){r.resume();return rej(new Error("HTTP "+r.statusCode+" "+url));}
    const enc=(r.headers["content-encoding"]||"").toLowerCase();
    let st=r;
    if(enc==="gzip")st=r.pipe(zlib.createGunzip());
    else if(enc==="deflate")st=r.pipe(zlib.createInflate());
    else if(enc==="br")st=r.pipe(zlib.createBrotliDecompress());
    const bufs=[];st.on("data",c=>bufs.push(c));
    // ⚠ 문자열로 이어붙이면 멀티바이트가 청크 경계에서 깨진다(비검천중파 → 비검천??파). 반드시 Buffer 병합.
    st.on("end",()=>res(Buffer.concat(bufs).toString("utf8")));
    st.on("error",rej);
  });
  req.on("error",rej);
  req.setTimeout(120000,()=>{req.destroy();rej(new Error("timeout "+url));});
});}

// 번들에서 nameko 레코드 추출 → {moves,abilities,items}
function extract(B){
  const moves={},abilities={},items={};
  const re=/nameko:"((?:[^"\\]|\\.)*)"/g;let m;
  while((m=re.exec(B))){
    const ko=m[1];if(!ko)continue;
    const start=Math.max(B.lastIndexOf('{index:"',m.index),B.lastIndexOf("{_id:",m.index));
    if(start<0||m.index-start>6000)continue;
    // ⚠ nameko에서 자르면 안 됨 — 메가스톤은 nameko가 앞쪽(name 바로 뒤)이고 분류 근거인 megastone:이
    //    그 뒤에 와서 전부 미분류로 샜다. 레코드 끝(다음 레코드 시작 또는 +6000)까지 봐야 한다.
    let end=B.indexOf('{index:"',m.index);
    const end2=B.indexOf("{_id:",m.index);
    if(end2>=0&&(end<0||end2<end))end=end2;
    if(end<0||end-start>6000)end=Math.min(B.length,start+6000);
    const rec=B.slice(start,end);
    const nm=(rec.match(/[,{]name:"((?:[^"\\]|\\.)*)"/)||[])[1];
    if(!nm)continue;
    const has=f=>new RegExp("[,{]"+f+":").test(rec);
    let b=null;
    if(has("basepower")&&has("pp"))b=moves;
    else if(has("spritenum")||has("megastone")||has("fling")||has("isberry"))b=items;
    else if(has("rating"))b=abilities;
    if(b&&!b[nm])b[nm]=ko;
  }
  return {moves,abilities,items};
}

// 포케모음(=포챔스)에 없는 아이템을 DB에서 제거하는 코드까지 함께 내보낸다.
// data.js 원본 무수정 원칙 유지 — 파일은 그대로 두고 로드 시점에 지운다.
function emitItems(file,varName,dbPath,map,remove,title){
  const header="// "+file+" — "+title+" 한글명 보정 + 포챔스에 없는 아이템 제거.\n"+
    "// 출처: 포케모음(pokemoem.com, 포켓몬 챔피언스 한국어 데이터).\n"+
    "// data.js 원본 무수정 원칙 → data.js 로드 후 이 파일을 로드하면 자기적용(패치 + 삭제).\n"+
    "// 재생성: node scripts/build-ko-names.js\n";
  const body="window."+varName+"="+JSON.stringify(map)+";\n"+
    "window.ITEM_NOT_IN_GAME="+JSON.stringify(remove)+";\n"+
    "(function(){if(typeof window===\"undefined\"||!window.DB)return;var T=window."+dbPath+";if(!T)return;\n"+
    "for(var _k in window."+varName+"){var _o=T[_k];if(_o===undefined)continue;\n"+
    "if(typeof _o===\"string\")T[_k]=window."+varName+"[_k];else _o.ko=window."+varName+"[_k];}\n"+
    "for(var _i=0;_i<window.ITEM_NOT_IN_GAME.length;_i++)delete T[window.ITEM_NOT_IN_GAME[_i]];})();\n";
  fs.writeFileSync(path.join(ROOT,file),header+body);
}
function emit(file,varName,dbPath,map,title){
  const header="// "+file+" — "+title+" 한글명 보정. 출처: 포케모음(pokemoem.com, 포켓몬 챔피언스 한국어 데이터).\n"+
    "// data.js 원본 무수정 원칙 → data.js 로드 후 이 파일을 로드하면 "+dbPath+"[key].ko를 패치(자기적용).\n"+
    "// 재생성: node scripts/build-ko-names.js\n";
  // DB.items 값은 문자열/객체가 섞여 있어 둘 다 처리
  const body="window."+varName+"="+JSON.stringify(map)+";\n"+
    "(function(){if(typeof window===\"undefined\"||!window.DB)return;var T=window."+dbPath+";if(!T)return;\n"+
    "for(var _k in window."+varName+"){var _o=T[_k];if(_o===undefined)continue;\n"+
    "if(typeof _o===\"string\")T[_k]=window."+varName+"[_k];else _o.ko=window."+varName+"[_k];}})();\n";
  fs.writeFileSync(path.join(ROOT,file),header+body);
}

(async()=>{
  const html=await get("https://pokemoem.com/");
  const asset=(html.match(/["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["']/)||[])[1];
  if(!asset)throw new Error("번들 경로를 HTML에서 못 찾음 — 사이트 구조 변경 확인 필요");
  console.log("번들:",asset);
  const B=await get("https://pokemoem.com"+asset);
  console.log("번들 "+B.length+"자, 치환문자(U+FFFD) "+((B.match(/�/g)||[]).length)+"개");
  const KO=extract(B);
  console.log("추출: 기술 "+Object.keys(KO.moves).length+" · 특성 "+Object.keys(KO.abilities).length+
              " · 아이템 "+Object.keys(KO.items).length);

  const build=(dbObj,src,over,label,missOut)=>{
    const idx={};for(const k in src)idx[norm(k)]=src[k];
    const fix={};let miss=0,same=0;
    for(const k in dbObj){
      const want=over[k]||idx[norm(k)];
      if(!want){miss++;if(missOut)missOut.push(k);continue;}
      const v=dbObj[k],cur=(typeof v==="string")?v:v.ko;
      if(cur===want){same++;continue;}
      fix[k]=want;
    }
    console.log(label+": 보정 "+Object.keys(fix).length+" · 일치 "+same+" · 소스없음 "+miss);
    return fix;
  };
  const itemMiss=[];
  const mFix=build(DB.moves,KO.moves,OVERRIDE.moves,"기술");
  const iFix=build(DB.items,KO.items,OVERRIDE.items,"아이템",itemMiss);
  const aFix=build(DB.abilities,KO.abilities,{},"특성(참고)");
  if(Object.keys(aFix).length)console.log("  ⚠ 특성 불일치 발견:",JSON.stringify(aFix));
  console.log("  포챔스에 없어 제거할 아이템 "+itemMiss.length+"개: "+itemMiss.join(", "));

  emit("moves-ko-fix.js","MOVE_KO_FIX","DB.moves",mFix,"DB.moves");
  emitItems("items-ko-fix.js","ITEM_KO_FIX","DB.items",iFix,itemMiss,"DB.items");
  console.log("moves-ko-fix.js · items-ko-fix.js 재생성 완료");
})().catch(e=>{console.error("실패:",e.message);process.exit(1);});
