// team-detail.js — 팀 상세(팀등록) 화면에서 내 포켓몬 세트(수치·성격·아이템·EV) 추출 (순수 로직, Node+브라우저 겸용)
//
// 팀등록은 두 탭으로 나뉜다:
//   · 스테이터스 탭(B) = 6능력치 최종 실수치 + 노력치(EV) + 성격(화살표). ← 이 파일 1단계 핵심.
//   · 능력탭(A)        = 특성·기술·아이템. ← 1단계는 아이템(메가스톤 여부)만. 특성/기술 텍스트는 2단계(폰트 매칭).
//
// 설계 철학(스프라이트·타입과 동일): OCR 불가(ERR-001)는 "열린 어휘"라 실패한 것 → 세트 필드는 닫힌 소집합이라
// 후보 선필터 + 로컬 렌더 템플릿 매칭으로 OCR 없이 뚫는다.
//   · 수치·EV : 숫자 0~9 연결요소(CC) 세그먼트 → 16x24 정규화 → Jaccard 템플릿 매칭. (템플릿은 실프레임 부트스트랩)
//   · 성격    : 스탯 라벨 옆 화살표 색(빨강↑=up, 파랑↓=dn) → DB.natures 역인덱스. OCR 불필요.
//   · 아이템  : 메가스톤은 종족당 1개뿐 → "메가스톤 여부"(원반+다색 스월 휴리스틱)만 판정하고 종족 메가폼으로 확정.
//
// ✅ 실프레임 검증(cardB1=아쿠스타 스탯탭): 6능력치 143·127·106·108·105·176 + EV 8·32·1·0·0·25 = 12/12 정확.
//    성격 명랑(up=spe,dn=spa) 정확. engine.calcStats(lv50·IV31)로 재현 완전 일치(EV=calcStats pts 확인).
//    좌표는 카드 box 상대 비율(프레임/해상도 독립) — team-register.detectCells 의 card box 를 소비.
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.TeamDetail=factory();
})(typeof self!=="undefined"?self:this,function(){

const NW=16,NH=24;
// 숫자 0~8 템플릿(16x24 비트팩 base64) — cardB1 실프레임 부트스트랩. 9는 이 프레임에 없어 미확보(실게임 9 프레임서 추가).
const DIGIT_B64={"0":"gAPwD/g/ODgccB9wD+AP4A/gB+AHwAfAB8AHwAfgD+AP4A/gD+AccDx4+D7wH+AP","1":"ADzg//j//////5//gP8A/AD8APwA/AD8APwA/AD8APwA/AD8ADwA/AD8APwA/AA8","2":"8B/4P/x/H3AE8ADgAOAA4ADwAHAAcAA4ADwAHAAPgAfAB+AD8AB4APwA/////xgA","3":"4Af4D/wfHDwEeAB4AHAAeAA4AB7AH8AfwD8AeADwAOAA4ADgAOAA8AR4/3//P/gH","4":"AAwAHgAeAB+AH8AfwB/gH/AccBw4HDgcHBwOHA8cHz7///////8APAAcABwAHAAI","5":"/D//P/8PDwAPAA8ADwAPAB8A/w//Hzw+AHgAcADgAOAA4ADgAPAAeA8+/x//D+AA","6":"AA6AD+AP8AB4ADwAHAAOAA4Ajgf+H/8/H3AP4A/gB8AHwAbADuAO4Bxw/H74P+AP","7":"/////////P8A8ADwAHAAOAA4ABwAHgAOAAcAB4ADgAPAAeAB4ADwAHAAOAA4ABgA","8":"4Af4H/w/PDgceB5wHnAceDw4/D/4H/gf/H8eeA/wD+AH4AfgB+AO8B54/H/4P+AH"};
const DIGITS={};
(function(){const dec=(typeof atob!=="undefined")?atob:(s=>Buffer.from(s,"base64").toString("binary"));
  for(const ch in DIGIT_B64){const bin=dec(DIGIT_B64[ch]),bm=new Uint8Array(NW*NH);
    for(let i=0;i<NW*NH;i++)if(bin.charCodeAt(i>>3)&(1<<(i&7)))bm[i]=1;DIGITS[ch]=bm;}})();

// 카드 box 상대 비율(2745x744 실프레임 기준)
const F={
  rows:[[0.253,0.390],[0.468,0.629],[0.702,0.871]],   // 3 스탯 행 y
  Lval:[0.285,0.375], Lev:[0.400,0.495],               // 좌 컬럼 값/EV x
  Rval:[0.756,0.860], Rev:[0.882,0.972],               // 우 컬럼 값/EV x
  arrowL:[0.235,0.288], arrowR:[0.705,0.758],          // 값 왼쪽 화살표 밴드 x
  itemX:[0.045,0.082], itemY:[0.47,0.66]               // 능력탭 아이템 아이콘 디스크
};
// 스탯 슬롯: [key, 컬럼, 행] — 좌 hp/atk/def, 우 spa/spd/spe
const SLOTS=[["h","L",0],["a","L",1],["b","L",2],["c","R",0],["d","R",1],["s","R",2]];

function px(img,x,y){const i=(y*img.width+x)*4;return[img.data[i],img.data[i+1],img.data[i+2]];}
const isWhite=(r,g,b)=>r>180&&g>180&&b>180;
const isBlueArrow=(r,g,b)=>b>200&&r<120&&g>130&&g<210;                 // ↓ 파랑(67,170,233)
const isRedArrow=(r,g,b)=>r>210&&g<150&&b>90&&b<190&&(r-g)>90;         // ↑ 빨강(247,105,147), 주황(b=0)과 b로 구분

// ── 숫자: 밴드 내 CC 세그먼트 → 정규화 → Jaccard 매칭 ──────────────────────
function segDigits(img,card,xb,yb){
  const CW=card.x1-card.x0,CH=card.y1-card.y0;
  const x0=card.x0+Math.round(xb[0]*CW),x1=card.x0+Math.round(xb[1]*CW);
  const y0=card.y0+Math.round(yb[0]*CH),y1=card.y0+Math.round(yb[1]*CH);
  const w=x1-x0,h=y1-y0;if(w<4||h<4)return[];
  const m=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(isWhite(...px(img,x0+x,y0+y)))m[y*w+x]=1;
  const lab=new Int32Array(w*h),comps=[],stack=[];let nl=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(m[y*w+x]&&!lab[y*w+x]){nl++;const a={minx:x,maxx:x,miny:y,maxy:y,area:0};stack.push(x,y);lab[y*w+x]=nl;
    while(stack.length){const cy=stack.pop(),cx=stack.pop();a.area++;if(cx<a.minx)a.minx=cx;if(cx>a.maxx)a.maxx=cx;if(cy<a.miny)a.miny=cy;if(cy>a.maxy)a.maxy=cy;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=cx+dx,ny=cy+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;const ni=ny*w+nx;if(m[ni]&&!lab[ni]){lab[ni]=nl;stack.push(nx,ny);}}}
    comps.push(a);}
  return comps.filter(c=>(c.maxy-c.miny+1)>h*0.35&&c.area>25&&(c.maxx-c.minx+1)>=10).sort((a,b)=>a.minx-b.minx)
    .map(c=>{const dw=c.maxx-c.minx+1,dh=c.maxy-c.miny+1,bm=new Uint8Array(NW*NH);
      for(let ny=0;ny<NH;ny++)for(let nx=0;nx<NW;nx++){const sx=x0+c.minx+Math.floor(nx*dw/NW),sy=y0+c.miny+Math.floor(ny*dh/NH);bm[ny*NW+nx]=isWhite(...px(img,sx,sy))?1:0;}
      return bm;});
}
function matchDigit(bm){let best="",bs=0.34; // 최소 Jaccard 게이트
  for(const ch in DIGITS){const t=DIGITS[ch];let inter=0,uni=0;
    for(let i=0;i<NW*NH;i++){if(bm[i]||t[i]){uni++;if(bm[i]&&t[i])inter++;}}
    const s=uni?inter/uni:0;if(s>bs){bs=s;best=ch;}}
  return best;}
function readNumber(img,card,xb,yb){const ds=segDigits(img,card,xb,yb);if(!ds.length)return null;
  let s="";for(const d of ds){const c=matchDigit(d);if(c==="")return null;s+=c;}
  return s.length?parseInt(s,10):null;}

// ── 성격: 각 스탯 화살표 밴드에서 up/dn 검출 ──────────────────────────────
function readArrow(img,card,side,rowIdx){
  const CW=card.x1-card.x0,CH=card.y1-card.y0;
  const xb=side==="L"?F.arrowL:F.arrowR;
  const x0=card.x0+Math.round(xb[0]*CW),x1=card.x0+Math.round(xb[1]*CW);
  const y0=card.y0+Math.round(F.rows[rowIdx][0]*CH),y1=card.y0+Math.round(F.rows[rowIdx][1]*CH);
  let blue=0,red=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const[r,g,b]=px(img,x,y);if(isBlueArrow(r,g,b))blue++;else if(isRedArrow(r,g,b))red++;}
  return blue>40?"dn":red>40?"up":null;
}

// ── 스탯 탭 판독: {stats,evs,up,dn,ok} ──────────────────────────────────
function readStatTab(img,card){
  const stats={},evs={},arrows={};let good=0;
  for(const[k,side,ri]of SLOTS){
    const vb=side==="L"?F.Lval:F.Rval, eb=side==="L"?F.Lev:F.Rev;
    const v=readNumber(img,card,vb,F.rows[ri]);
    const e=readNumber(img,card,eb,F.rows[ri]);
    stats[k]=v; evs[k]=(e==null?0:e); arrows[k]=readArrow(img,card,side,ri);
    if(v!=null&&v>0&&v<1000)good++;
  }
  const up=SLOTS.map(s=>s[0]).find(k=>arrows[k]==="up")||null;
  const dn=SLOTS.map(s=>s[0]).find(k=>arrows[k]==="dn")||null;
  return {stats,evs,arrows,up,dn,ok:good>=5};
}
// 스탯키(h/a/b/c/d/s) ↔ DB.natures up/dn 키(atk/def/spa/spd/spe) 매핑 후 성격 역인덱스
const NAT_KEY={a:"atk",b:"def",c:"spa",d:"spd",s:"spe"};
function resolveNature(up,dn,naturesDB){
  const U=NAT_KEY[up]||null,Dn=NAT_KEY[dn]||null;
  if(!U&&!Dn)return "Serious"; // 화살표 없음 = 무보정 성격(개체별로 다르나 대표값)
  for(const nm in naturesDB){const n=naturesDB[nm];if(n.up===U&&n.dn===Dn)return nm;}
  return null;
}

// ── 아이템: 메가스톤 여부(원반 + 다색 스월 휴리스틱) ───────────────────────
// 메가스톤은 어두운 원형 테두리 + 안쪽 고채도 다색(≥2 색상) 스월. 베리/단색 아이템과 구분.
// 개별 스톤 식별은 안 함(종족당 1개뿐 → 종족 메가폼으로 확정). 종족이 메가폼 없으면 호출측이 무시.
function detectMegaStone(img,card){
  const CW=card.x1-card.x0,CH=card.y1-card.y0;
  const x0=card.x0+Math.round(F.itemX[0]*CW),x1=card.x0+Math.round(F.itemX[1]*CW);
  const y0=card.y0+Math.round(F.itemY[0]*CH),y1=card.y0+Math.round(F.itemY[1]*CH);
  const hues=new Set();let sat=0,dark=0,n=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const[r,g,b]=px(img,x,y);n++;
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    if(r<90&&g<90&&b<110)dark++;                       // 어두운 테두리
    if(mx-mn>70&&mx>120){sat++;                          // 고채도 픽셀
      // 대략적 hue 버킷(6등분)
      let h;if(mx===r)h=((g-b)/(mx-mn)+6)%6;else if(mx===g)h=(b-r)/(mx-mn)+2;else h=(r-g)/(mx-mn)+4;
      hues.add(Math.round(h)%6);}
  }
  const isMega=dark>15&&sat>25&&hues.size>=2;             // 테두리 + 스월 + 다색
  return {isMega,dark,sat,hues:hues.size};
}

// ── 탭 판별: 스탯 탭이면 6수치가 잡힘 → true, 아니면 능력탭 ─────────────────
function isStatTab(img,card){return readStatTab(img,card).ok;}

return {readStatTab,resolveNature,detectMegaStone,isStatTab,readNumber,readArrow,NAT_KEY,F};
});
