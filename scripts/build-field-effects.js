// build-field-effects.js — 필드 상태(날씨·필드·룸·깔개·장막…)를 유발/무효/수혜하는 기술·특성 카탈로그 생성
//                          → ../field-effects.js 재생성
// 사용: node scripts/build-field-effects.js <번들 파일 경로 | 번들 사이트 URL>
//   번들 위치는 코드에 두지 않는다 — 인자로 넘긴다.
//
// 입력 번들은 레코드 하나에 선언적 필드(weather/terrain/pseudoweather/sidecondition/slotcondition/
//   condition.duration)와 한글명(nameko)이 **함께** 들어 있는 형식이다.
//   → 둘을 이름으로 조인하지 않으므로 매칭 실패 위험이 없다.
//
// ⚠ 이 카탈로그의 신뢰 등급은 두 가지로 나뉜다 — 섞어 쓰지 말 것:
//   [확정] 분류·소속: "순풍은 자기 진영 효과", "스텔스록은 상대 진영 깔개", "리플렉터는 물리를 막는다".
//          레코드의 선언 필드에서 직접 나오고, 포챔스가 바꿀 이유가 거의 없는 구조적 사실.
//   [추정] 수치·조건: 지속 턴수, 배율, "오로라베일은 싸라기눈에서만" 같은 발동 조건.
//          원본 레코드 스키마는 Showdown(SV) 형식이라(zmove/maxmove/contesttype 필드 존재)
//          수치가 SV 기준일 수 있다. 포챔스는 실제로 수치를 손대는 게임이다
//          (예: 피카츄 종족값 포챔스 110/75/60/70/70/110 vs 본가 35/55/40/50/50/90).
//          → 전부 est:true 로 표시한다. 실게임에서 확인되면 아래 OVERRIDE 에 박아 확정으로 승격.
//
// ⚠ 포챔스 공식 덤프에는 기술 효과 테이블이 아예 없다(학습기 목록 + 종족값/타입/특성 뿐).
//   그래서 효과·지속턴을 포챔스 실데이터로만 채우는 것은 원천적으로 불가능하다.
//   대신 **존재 여부**만은 포챔스 실데이터로 교차검증한다:
//   기술은 learnsets.js(포챔스 공식 학습기)에, 특성은 DB.abilities(포챔스 실제 보유 특성)에 있는 것만 남긴다.
//   이 필터로 SV 잔재(흙놀이·물놀이·주술·플라스마피스트, 필드 메이커 특성 등)가 자동 배제된다. ERR-008 재발 방지.
const fs=require("fs"),path=require("path"),https=require("https"),zlib=require("zlib");
const ROOT=path.join(__dirname,"..");
global.window=global;
require(path.join(ROOT,"data.js"));
require(path.join(ROOT,"learnsets.js"));
const DB=global.window.DB, LEARNSETS=global.window.LEARNSETS||{};

// 실게임 확인으로 확정된 값만 여기에 (번들 수치보다 우선). 지금은 비어 있음.
// 예) OVERRIDE.moves["Tailwind"]={turns:3}  ← 포챔스가 3턴이더라 확인되면
const OVERRIDE={moves:{},abilities:{}};

// ===== 번들 수신 (Buffer 병합 필수, brotli 해제) =====
function get(url){return new Promise((res,rej)=>{
  const req=https.get(url,{headers:{"User-Agent":"champions-calc","Accept-Language":"ko-KR","Accept-Encoding":"gzip, deflate, br"}},r=>{
    if(r.statusCode!==200){r.resume();return rej(new Error("HTTP "+r.statusCode+" "+url));}
    const enc=(r.headers["content-encoding"]||"").toLowerCase();
    let st=r;
    if(enc==="gzip")st=r.pipe(zlib.createGunzip());
    else if(enc==="deflate")st=r.pipe(zlib.createInflate());
    else if(enc==="br")st=r.pipe(zlib.createBrotliDecompress());
    const bufs=[];st.on("data",c=>bufs.push(c));
    // ⚠ 문자열 누적(d+=c)하면 멀티바이트가 청크 경계에서 깨진다 → 반드시 Buffer 병합 후 toString
    st.on("end",()=>res(Buffer.concat(bufs).toString("utf8")));
    st.on("error",rej);
  });
  req.on("error",rej);
  req.setTimeout(120000,()=>{req.destroy();rej(new Error("timeout "+url));});
});}

// ===== 레코드 분할·필드 추출 =====
function split(B){
  const out=[],re=/\{(?:index:"|_id:\{)/g;let m,prev=-1;
  while((m=re.exec(B))){if(prev>=0)out.push(B.slice(prev,m.index));prev=m.index;}
  if(prev>=0)out.push(B.slice(prev));
  return out;
}
const strf=(r,f)=>{const m=r.match(new RegExp("[,{]"+f+':"((?:[^"\\\\]|\\\\.)*)"'));return m?m[1]:null;};
const has=(r,f)=>new RegExp("[,{]"+f+":").test(r);
const setField=(r,f)=>new RegExp("[,{]"+f+":(?!null)").test(r);
const duration=r=>{const m=r.match(/[,{]condition:\{([^}]*)\}/);if(!m)return null;
  const d=m[1].match(/duration:(\d+)/);return d?+d[1]:null;};

// engine.js 의 env 어휘로 정규화 (env.weather / env.terrain 에 그대로 넣을 수 있게)
// ⚠ engine.js 는 weather 를 sun/rain/sand/snow 만 안다. 포챔스엔 싸라기눈(hail)과 설경(snow)이
//   따로 있으므로 hail 을 임의로 snow 에 합치지 않고 그대로 내보낸다(엔진 미지원은 소비측이 판단).
const W={sunnyday:"sun","sunny day":"sun","harsh sunlight":"sun",raindance:"rain","rain dance":"rain",
  sandstorm:"sand",hail:"hail",snow:"snow",snowscape:"snow"};
const T={electricterrain:"electric",grassyterrain:"grassy",mistyterrain:"misty",psychicterrain:"psychic",
  "electric terrain":"electric","grassy terrain":"grassy","misty terrain":"misty","psychic terrain":"psychic"};
const normW=v=>v?(W[String(v).toLowerCase()]||null):null;
const normT=v=>v?(T[String(v).toLowerCase()]||null):null;

// ===== 기술 분류 =====
// 전부 선언 필드 기반 — 기술 이름을 손으로 나열하지 않는다.
function classifyMove(m){
  if(m.weather)return {cls:"weather",key:normW(m.weather)};
  if(m.terrain)return {cls:"terrain",key:normT(m.terrain)};
  if(m.pseudo) return /room$/.test(m.pseudo)?{cls:"room",key:m.pseudo}:{cls:"global",key:m.pseudo};
  if(m.slot)   return {cls:"slot",key:m.slot};
  if(m.side){
    if(m.target==="foeSide")return {cls:"hazard",key:m.side};        // 상대 진영에 깖 = 깔개
    if(m.duration===1)      return {cls:"guard",key:m.side};         // 1턴짜리 보호기
    const s=m.short||"";
    if(/damage.*(halved|reduced)|0\.5x damage|halves damage/i.test(s))return {cls:"screen",key:m.side};
    if(/speed is doubled/i.test(s))     return {cls:"speed",key:m.side};      // 순풍 — 선공 판정 직결
    if(/stat (drop|lower)/i.test(s))    return {cls:"wardStat",key:m.side};
    if(/status/i.test(s))               return {cls:"wardStatus",key:m.side};
    return {cls:"wardOther",key:m.side};
  }
  return null;
}
// 장막이 물리/특수 중 무엇을 막는지 (engine 의 def.screen 불리언 한계를 푸는 축 정보)
function screenAxis(short){
  const s=(short||"").toLowerCase(),p=/physical/.test(s),q=/special/.test(s);
  return (p&&q)?"both":p?"phys":q?"spec":/damage/.test(s)?"both":null;
}

// ===== 특성 분류 =====
function classifyAbility(rec,name,short){
  const s=short||"";
  if(setField(rec,"suppressweather"))return {kind:"suppress"};
  let m=s.match(/summons ([A-Z][A-Za-z' ]+?)\./);
  if(m)return {kind:"set",trigger:"switchIn",sets:normW(m[1])||normT(m[1])||m[1]};
  m=s.match(/the effect of ([A-Z][A-Za-z' ]+?) begins/);
  if(m)return {kind:"set",trigger:"onHit",sets:normW(m[1])||normT(m[1])||m[1]};
  m=s.match(/([A-Z][A-Za-z' ]+?) are set around/);
  if(m)return {kind:"set",trigger:"onHit",sets:m[1].toLowerCase().replace(/[^a-z]/g,"")};
  if(/speed is doubled/i.test(s)){
    const w=s.match(/If ([A-Z][A-Za-z' ]+?) is active/);
    return {kind:"speedx2",when:w?(normW(w[1])||normT(w[1])||w[1]):null};   // 엽록소·쓱쓱·모래헤치기·눈치우기·서핑테일
  }
  if(/ignore.*(Reflect|Light Screen|Aurora Veil)/i.test(s))return {kind:"ignoreScreen"};
  if(/(Aurora Veil|Light Screen|Reflect).*end for both sides/i.test(s))return {kind:"clearScreen"};
  return {kind:"benefit"};   // 날씨·필드에서 이득만 보는 것(계산 미반영, 참고용)
}

// 번들 확보 — 위치는 인자로 받는다(코드에 두지 않음).
//   로컬 파일 경로면 그대로 읽고, 사이트 URL이면 루트 HTML에서 번들 경로를 파싱해 받는다
//   (번들 파일명 해시가 배포마다 바뀌므로 고정 경로를 쓸 수 없다).
async function loadBundle(src){
  if(!/^https?:/i.test(src)){
    const B=fs.readFileSync(src,"utf8");
    console.log("로컬 번들 "+B.length+"자");
    return B;
  }
  const base=src.replace(/\/+$/,"");
  const html=await get(base+"/");
  const asset=(html.match(/["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["']/)||[])[1];
  if(!asset)throw new Error("번들 경로를 HTML에서 못 찾음 — 사이트 구조 변경 확인 필요");
  console.log("번들:",asset);
  return await get(base+asset);
}

(async()=>{
  const SRC=process.argv[2]||process.env.FIELD_BUNDLE;
  if(!SRC){
    console.error("사용: node scripts/build-field-effects.js <번들 파일 경로 | 번들 사이트 URL>");
    console.error("      (환경변수 FIELD_BUNDLE 로도 지정 가능)");
    process.exit(1);
  }
  const B=await loadBundle(SRC);
  console.log("번들 "+B.length+"자, 치환문자(U+FFFD) "+((B.match(/�/g)||[]).length)+"개");

  // 포챔스 공식 학습기에 실제로 등장하는 기술 = 게임에 존재 확정
  const inGame=new Set();
  for(const sp in LEARNSETS)for(const mv of LEARNSETS[sp])inGame.add(mv);
  console.log("포챔스 학습기 기술 "+inGame.size+"종 · DB.abilities "+Object.keys(DB.abilities).length+"개");

  const moves={},abilities={};
  const dropM=[],dropA=[];
  for(const rec of split(B)){
    const name=strf(rec,"name");if(!name)continue;

    if(has(rec,"basepower")&&has(rec,"pp")){                 // ---- 기술 ----
      const m={weather:strf(rec,"weather"),terrain:strf(rec,"terrain"),pseudo:strf(rec,"pseudoweather"),
        side:strf(rec,"sidecondition"),slot:strf(rec,"slotcondition"),
        target:strf(rec,"target"),duration:duration(rec),short:strf(rec,"shortdesc")};
      if(!(m.weather||m.terrain||m.pseudo||m.side||m.slot))continue;
      if(!DB.moves[name]){dropM.push(name+"(DB없음)");continue;}
      if(!inGame.has(name)){dropM.push((strf(rec,"nameko")||name)+"(학습기없음)");continue;}
      const c=classifyMove(m);if(!c)continue;
      const o={ko:strf(rec,"nameko")||DB.moves[name].ko,cls:c.cls,key:c.key,
        side:m.target==="foeSide"?"foe":m.target==="allySide"?"ally":"all",short:m.short};
      if(m.duration!=null){o.turns=m.duration;o.est=true;}    // [추정] 턴수
      if(c.cls==="screen"){o.axis=screenAxis(m.short);o.est=true;}
      Object.assign(o,OVERRIDE.moves[name]||{});
      moves[name]=o;

    }else if(has(rec,"rating")){                              // ---- 특성 ----
      const short=strf(rec,"shortdesc")||strf(rec,"desc")||"";
      // ⚠ 단어 경계 필수 — 없으면 "Misty Explosion"의 mist 가 걸려 습기(Damp)가 딸려 들어온다(실제 오탐).
      if(!/\b(rain|sunny day|harsh sunlight|sandstorm|hail|snow|terrain|tailwind|trick room|gravity|reflect|light screen|aurora veil|safeguard|mist|spikes|stealth rock|sticky web)\b/i.test(short)
         &&!setField(rec,"suppressweather"))continue;
      const c=classifyAbility(rec,name,short);
      if(DB.abilities[name]===undefined){dropA.push((strf(rec,"nameko")||name)+"("+c.kind+")");continue;}
      const o={ko:strf(rec,"nameko")||DB.abilities[name],kind:c.kind,short};
      if(c.sets)o.sets=c.sets;
      if(c.trigger)o.trigger=c.trigger;
      if(c.when)o.when=c.when;
      if(c.kind!=="benefit")o.est=true;                       // [추정] 발동 조건
      Object.assign(o,OVERRIDE.abilities[name]||{});
      abilities[name]=o;
    }
  }

  // ===== 요약 출력 =====
  const byCls={};for(const k in moves)(byCls[moves[k].cls]=byCls[moves[k].cls]||[]).push(moves[k].ko);
  const LB={weather:"날씨",terrain:"필드",room:"룸",global:"전역 기타",hazard:"깔개(상대 진영)",
    screen:"장막",speed:"속도",wardStat:"능력하락 방지",wardStatus:"상태이상 방지",wardOther:"기타 진영",
    guard:"1턴 보호",slot:"슬롯"};
  console.log("\n기술 "+Object.keys(moves).length+"건");
  for(const c in byCls)console.log("  "+(LB[c]||c).padEnd(14)+byCls[c].length+"  "+byCls[c].join(", "));
  const byKind={};for(const k in abilities)(byKind[abilities[k].kind]=byKind[abilities[k].kind]||[]).push(abilities[k].ko);
  const KB={set:"유발",suppress:"무효",speedx2:"속도2배(선공 직결)",ignoreScreen:"장막 무시",
    clearScreen:"장막 제거",benefit:"수혜(참고)"};
  console.log("\n특성 "+Object.keys(abilities).length+"건");
  for(const k in byKind)console.log("  "+(KB[k]||k).padEnd(18)+byKind[k].length+"  "+byKind[k].join(", "));
  console.log("\n포챔스에 없어 제외: 기술 "+dropM.length+" · 특성 "+dropA.length);
  console.log("  기술: "+dropM.join(", "));
  console.log("  특성: "+dropA.join(", "));

  // ===== 파일 생성 =====
  const header=
"// field-effects.js — 필드 상태(날씨·필드·룸·깔개·장막…) 유발/무효/수혜 카탈로그. **자동 생성물, 직접 수정 금지.**\n"+
"// 재생성: node scripts/build-field-effects.js\n"+
"// 입력: 레코드의 선언 필드 + 한글명(같은 레코드라 이름 매칭 없음).\n"+
"// 교차검증: 기술=포챔스 공식 학습기(learnsets.js) 존재분만 · 특성=DB.abilities 존재분만.\n"+
"//\n"+
"// ⚠ 신뢰 등급을 섞지 말 것:\n"+
"//   [확정] cls/key/side/axis — 분류와 소속. 선언 필드에서 직접 나온 구조적 사실.\n"+
"//   [추정] turns 등 est:true 가 붙은 값 — 원본 스키마가 Showdown(SV) 형식이라 수치가 SV 기준일 수 있다.\n"+
"//          실게임 확인 전까지 확정값처럼 쓰지 말 것. 확인되면 scripts/build-field-effects.js 의 OVERRIDE 에 박는다.\n"+
"//\n"+
"// cls: weather 날씨 | terrain 필드 | room 룸 | global 전역 | hazard 깔개(상대진영) | screen 장막\n"+
"//      speed 속도 | wardStat 능력하락방지 | wardStatus 상태이상방지 | guard 1턴보호 | slot 슬롯\n"+
"// key: engine.js 의 env 어휘로 정규화(weather=sun/rain/sand/hail/snow, terrain=electric/grassy/misty/psychic).\n"+
"//      ⚠ engine.js 는 hail 을 모른다(sun/rain/sand/snow 만 처리) — 소비측에서 판단할 것.\n"+
"// axis: 장막이 막는 쪽(phys 물리 / spec 특수 / both 양쪽). engine.js 의 def.screen 불리언은 이 구분이 없어\n"+
"//       특수 어태커에게 리플렉터가 걸려도 반감시킨다 — 이 값으로 바로잡을 수 있다.\n";
  const body="window.FIELD_EFFECTS={moves:"+JSON.stringify(moves)+",abilities:"+JSON.stringify(abilities)+"};\n";
  fs.writeFileSync(path.join(ROOT,"field-effects.js"),header+body);
  console.log("\nfield-effects.js 생성 완료");
})().catch(e=>{console.error("실패:",e.message);process.exit(1);});
