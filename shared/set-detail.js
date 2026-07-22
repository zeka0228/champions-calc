// set-detail.js — 능력탭 세트 텍스트 인식(특성/기술/아이템). 순수 로직 + renderText 콜백 주입.
//
// 게임폰트 한글은 OCR 불가(ERR-001) → "렌더-매칭": 후보 이름을 캔버스에 폰트로 그려 흑백 실루엣 →
// 화면 글자 실루엣과 형태 겹침도(IoU) 비교 → 최고 채택. 후보를 DB로 좁혀(특성 2~3개, 기술 타입+학습기)
// 폰트가 정확히 같지 않아도 갈림.
//
// 캔버스는 렌더러에만 있으므로 renderText 콜백을 주입한다(Node 테스트 시 없으면 후보 narrowing까지만).
//   renderText(str) → {mask:Uint8Array(w*h, 1=잉크), width, height}  (그린 글자의 raw 이진 래스터)
//
// 데이터 계약(overlay가 team.details[i]에 채움):
//   slot.ability = {key, ko}
//   slot.moves   = [{key, ko, type}, ...]   (기술 4개)
//   slot.item    = {key, ko}
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.SetDetail=factory();
})(typeof self!=="undefined"?self:this,function(){

const NW=128,NH=24;                        // 형태 비교용 정규화 그리드
function px(img,x,y){const i=(y*img.width+x)*4;return[img.data[i],img.data[i+1],img.data[i+2]];}
const isWhite=(r,g,b)=>r>180&&g>180&&b>180;

// mask(w*h, 1=잉크) → 타이트 bbox → 높이 NH로 스케일 → NW×NH 좌측정렬 그리드. 이름 길이는 폭으로 반영됨.
function rasterize(mask,w,h){
  let minx=w,maxx=-1,miny=h,maxy=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(mask[y*w+x]){if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;}
  const grid=new Uint8Array(NW*NH);
  if(maxx<0)return {grid,w:0};
  const bw=maxx-minx+1,bh=maxy-miny+1,sw=Math.max(1,Math.min(NW,Math.round(NH*bw/bh)));
  for(let ny=0;ny<NH;ny++)for(let nx=0;nx<sw;nx++){
    const sx=minx+Math.floor(nx*bw/sw),sy=miny+Math.floor(ny*bh/NH);
    grid[ny*NW+nx]=mask[sy*w+sx]?1:0;}
  return {grid,w:sw};
}
// 형태 유사도: IoU(겹침/합집합). 길이 다르면 뒤쪽 열이 안 겹쳐 자연 감점 → 음절수 신호 포함.
function similarity(a,b){let inter=0,uni=0;
  for(let i=0;i<NW*NH;i++){if(a.grid[i]||b.grid[i]){uni++;if(a.grid[i]&&b.grid[i])inter++;}}
  return uni?inter/uni:0;}

// 이미지 영역(절대픽셀)에서 흰 글자 → mask → rasterize
function extractText(img,x0,x1,y0,y1){
  const w=x1-x0,h=y1-y0;if(w<4||h<4)return {grid:new Uint8Array(NW*NH),w:0};
  const mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(isWhite(...px(img,x0+x,y0+y)))mask[y*w+x]=1;
  return rasterize(mask,w,h);
}

// ── 좌측 텍스트 행 검출(이름/특성/아이템) — 흰 글자 행 밴드 ─────────────────────
// 좌측 x밴드(스프라이트·기술 제외): 카드폭 0.13~0.47. 아이템 아이콘은 텍스트보다 왼쪽이라 0.13부터면 텍스트만.
function leftTextRows(img,card){
  const CW=card.x1-card.x0,CH=card.y1-card.y0;
  const x0=card.x0+Math.round(CW*0.13),x1=card.x0+Math.round(CW*0.47);
  const bw=x1-x0;const wr=new Int32Array(CH);
  for(let y=0;y<CH;y++){let c=0;for(let x=x0;x<x1;x++)if(isWhite(...px(img,x,card.y0+y)))c++;wr[y]=c;}
  const thr=Math.max(3,bw*0.03),GAP=Math.max(6,Math.round(CH*0.04)),MINH=Math.round(CH*0.06);
  const bands=[];let s=-1,gap=0;
  for(let i=0;i<CH;i++){if(wr[i]>thr){if(s<0)s=i;gap=0;}else if(s>=0){if(++gap>GAP){if(i-gap-s>=MINH)bands.push([card.y0+s,card.y0+(i-gap)]);s=-1;}}}
  if(s>=0&&CH-s>=MINH)bands.push([card.y0+s,card.y0+CH-1]);
  return bands;   // 절대 y. 기대: [이름, 특성, 아이템]. 카드박스 세로 드리프트로 위/아래 잡음 행 가능.
}
// 특성 행 = 이름 아래 첫 행. 이름은 폰트가 커서 "가장 높은 행"으로 앵커(드리프트 잡음 행 배제).
function abilityRowBand(rows){
  if(rows.length<2)return null;
  let ni=0;for(let i=1;i<rows.length;i++)if((rows[i][1]-rows[i][0])>(rows[ni][1]-rows[ni][0]))ni=i;
  return rows[ni+1]||null;   // 이름 바로 아래
}

// ── 특성 ──────────────────────────────────────────────────────────────────
// 후보 = 종족 ab(중복 제거). key→DB.abilities[key].ko.
// 주의: DB.abilities[key]는 한글 문자열 직접("Natural Cure"→"자연회복"). DB.moves/items는 {ko:…} 객체. 형식 다름.
function abilityCandidates(species,DB){
  const c=DB.creatures&&DB.creatures[species];if(!c||!c.ab)return [];
  const seen=new Set(),out=[];
  for(const k of Object.values(c.ab)){if(!k||seen.has(k))continue;seen.add(k);
    const v=DB.abilities&&DB.abilities[k];const ko=(typeof v==="string")?v:((v&&v.ko)?v.ko:k);
    out.push({key:k,ko});}
  return out;
}
// 렌더-매칭: 후보 중 최고. renderText 없으면(Node) 후보 1개일 때만 확정, 아니면 null.
function matchByRender(gameRaster,candidates,renderText){
  if(!candidates.length)return null;
  if(candidates.length===1)return {...candidates[0],score:1};
  if(!renderText)return null;                 // 캔버스 없음 → 판별 불가
  let best=null,bs=-1,second=-1;
  for(const cand of candidates){
    let rr;try{rr=renderText(cand.ko);}catch(e){continue;}
    if(!rr||!rr.mask)continue;
    const cr=rasterize(rr.mask,rr.width,rr.height);
    const s=similarity(gameRaster,cr);
    if(s>bs){second=bs;bs=s;best=cand;}else if(s>second)second=s;
  }
  if(!best)return null;
  return {...best,score:bs,margin:bs-(second<0?0:second)};
}
function detectAbility(img,card,species,DB,renderText){
  const cands=abilityCandidates(species,DB);
  if(cands.length<=1)return cands[0]?{...cands[0],score:1}:null;
  const rows=leftTextRows(img,card);
  const row=abilityRowBand(rows);             // 이름(최고 행) 바로 아래
  if(!row)return null;
  const CW=card.x1-card.x0;
  const g=extractText(img,card.x0+Math.round(CW*0.13),card.x0+Math.round(CW*0.47),row[0]-1,row[1]+2);
  if(!g.w)return null;
  return matchByRender(g,cands,renderText);
}

// ── renderText 콜백 팩토리(렌더러 전용, 캔버스) ─────────────────────────────
// overlay.js: const renderText=SetDetail.makeCanvasRenderer(); SetDetail.detectAbility(...,renderText).
// 게임과 비슷한 볼드 산세리프로 흰 글자를 검은 배경에 그려 raw 이진 마스크 반환. 폰트/굵기는 실앱 튜닝 여지.
function makeCanvasRenderer(font){
  const F=font||"700 22px 'Malgun Gothic','Apple SD Gothic Neo',sans-serif";
  const cv=document.createElement("canvas"),ctx=cv.getContext("2d",{willReadFrequently:true});
  return function(str){
    ctx.font=F;const w=Math.max(4,Math.ceil(ctx.measureText(str).width)+4),h=30;
    cv.width=w;cv.height=h;ctx.font=F;
    ctx.fillStyle="#000";ctx.fillRect(0,0,w,h);
    ctx.fillStyle="#fff";ctx.textBaseline="top";ctx.fillText(str,2,3);
    const d=ctx.getImageData(0,0,w,h).data,mask=new Uint8Array(w*h);
    for(let i=0;i<w*h;i++)if(d[i*4]>140)mask[i]=1;
    return {mask,width:w,height:h};
  };
}

return {NW,NH,rasterize,similarity,extractText,leftTextRows,abilityRowBand,abilityCandidates,matchByRender,detectAbility,makeCanvasRenderer};
});
