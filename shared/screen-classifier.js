// screen-classifier.js — 프레임이 어떤 게임 화면인지 분류 + OCR/매칭 영역 동적 산출 (순수 로직, Node+브라우저 겸용)
// classify: 'select'(선출) | 'battle'(배틀 커맨드) | 'other'
//
// 프레임 독립 설계(B, 2026-07-21):
//  1) detectGameRect() 로 캡처 프레임에서 게임 영역만 추출(검은 레터박스 제거) → 이후 전부 rect 기준(비율)
//  2) classify()/detectRegions() 는 고정 좌표가 아니라 색 앵커(자홍 이름바·초록테 이름바)를 "검출"해 좌표 산출
//     → 해상도·창 크기·에뮬 종류가 달라도 동일 동작 (2559x1439 / 1279x719 / 959x539 검증: 검출 비율 수렴)
//  3) 게임 영역이 너무 작으면(lowRes) OCR 전 업스케일 권장 배수 반환
// ✅ 실프레임 검증(M1): 실캡처 2559x1439(16:9)에서 classify 선출/배틀 100% 정확.
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.ScreenClassifier=factory();
})(typeof self!=="undefined"?self:this,function(){

// 자홍색(상대 카드/이름판) — matcher.js isCard와 동일 계열
const isMagenta=(r,g,b)=>r>70&&r-g>45&&r-b>15&&g<120;
// 보라색(내 파티 카드/기술 버튼 계열)
const isPurple=(r,g,b)=>b>80&&b-g>30&&r>40&&r<160&&g<110;
// 라임 초록(내 이름판 HP바 테두리)
const isLime=(r,g,b)=>g>150&&g-r>30&&g-b>60;
// 노랑(매칭 대기 스피너 = 몬스터볼 아이콘)
const isYellow=(r,g,b)=>r>170&&g>150&&b<120&&r-b>60&&g-b>40;
// 거의 검정(레터박스)
const isDark=(r,g,b)=>r<40&&g<40&&b<40;

function px(img,x,y){const i=(y*img.width+x)*4;return[img.data[i],img.data[i+1],img.data[i+2]];}
function fullRect(img){return {x0:0,y0:0,w:img.width,h:img.height};}

// ── 게임 영역 검출: 검은 레터박스/균일 테두리 제거 ────────────────────────────
// 캡처 프레임 가장자리에서 "거의 전부 검정"인 행/열을 안쪽으로 트림. 레터박스 없으면 전체 프레임 반환.
function detectGameRect(img){
  const W=img.width,H=img.height;
  const rowDark=(y)=>{let n=0,d=0;for(let x=0;x<W;x+=8){const[r,g,b]=px(img,x,y);n++;if(isDark(r,g,b))d++;}return d/n;};
  const colDark=(x)=>{let n=0,d=0;for(let y=0;y<H;y+=8){const[r,g,b]=px(img,x,y);n++;if(isDark(r,g,b))d++;}return d/n;};
  let top=0,bot=H-1,left=0,right=W-1;const T=0.92;
  while(top<bot&&rowDark(top)>T)top++;
  while(bot>top&&rowDark(bot)>T)bot--;
  while(left<right&&colDark(left)>T)left++;
  while(right>left&&colDark(right)>T)right--;
  const w=right-left+1,h=bot-top+1;
  // 안전장치: 트림 결과가 비정상적으로 작으면 전체 프레임 사용
  if(w<W*0.3||h<H*0.3)return fullRect(img);
  return {x0:left,y0:top,w,h};
}

// ── rect 기준 색 비율(fx0..fx1, fy0..fy1 은 rect 내부 비율) ──────────────────
function ratio(img,rect,fx0,fx1,fy0,fy1,pred){
  const {x0,y0,w,h}=rect;let n=0,hit=0;
  for(let y=y0+Math.floor(h*fy0);y<y0+h*fy1;y+=3)
    for(let x=x0+Math.floor(w*fx0);x<x0+w*fx1;x+=3){
      const[r,g,b]=px(img,x,y);n++;if(pred(r,g,b))hit++;
    }
  return n?hit/n:0;
}

// rect 우측의 자홍 세로 밴드 개수(선출 카드 6장 감지용)
function rightBandCount(img,rect){
  const {x0,y0,w,h}=rect;
  const colCnt=new Int32Array(w);
  for(let y=Math.floor(h*0.05);y<h*0.95;y+=4)
    for(let x=Math.floor(w*0.65);x<w;x+=2){
      const[r,g,b]=px(img,x0+x,y0+y);if(isMagenta(r,g,b))colCnt[x]++;
    }
  let xL=-1,xR=-1;const thr=(h*0.9/4)*0.25;
  for(let x=Math.floor(w*0.65);x<w;x++){if(colCnt[x]>thr){if(xL<0)xL=x;xR=x;}}
  if(xL<0)return 0;
  const probe=x0+Math.floor(xL+(xR-xL)*0.04);
  let bands=0,s=-1;
  for(let y=0;y<h;y++){
    const[r,g,b]=px(img,probe,y0+y);
    if(isMagenta(r,g,b)){if(s<0)s=y;}
    else{if(s>=0&&y-s>h*0.04)bands++;s=-1;}
  }
  if(s>=0&&h-s>h*0.04)bands++;
  return bands;
}

function classify(img,rect){
  rect=rect||fullRect(img);
  // 0) 매칭 대기/완료: 중앙을 큰 보라 모달이 덮고(매칭중·완료 공통, 가운데 글자만 다름) 노란 스피너 존재.
  //    실측: 매칭 보라0.94/노랑0.11 vs 선출 0.07/0 · 배틀 0.18/0.01 → 두 조건 동시로 오검출 방지.
  const centerPurple=ratio(img,rect,0.30,0.70,0.38,0.62,isPurple);
  if(centerPurple>0.5){
    const centerYellow=ratio(img,rect,0.44,0.56,0.30,0.50,isYellow);
    if(centerYellow>0.03)return {screen:"matchmaking",centerPurple,centerYellow,conf:Math.min(1,centerPurple)};
  }
  // 0.5) 팀등록(팀 상세 화면): 상단 라임 탭(능력/스테이터스)은 다른 화면에 없는 고유 앵커.
  //   실측: 팀등록 라임 0.08 vs 선출/배틀/매칭 0.00 → 오검출 0. 카드 상세 검출·6마리 식별은 team-register.js.
  //   배틀이 아닌 화면에서만 팀 인식(요구사항) → classify가 배틀과 자연히 분리(배틀은 자홍 이름바, 여긴 없음).
  const teamTab=ratio(img,rect,0.30,0.70,0.135,0.205,isLime);
  if(teamTab>0.03)return {screen:"teamregister",teamTab,conf:1};
  // 1) 선출: 우측 자홍 카드 밴드 4개 이상 + 좌측 보라 파티 카드 존재
  const bands=rightBandCount(img,rect);
  if(bands>=4){
    const leftPurple=ratio(img,rect,0.04,0.30,0.10,0.85,isPurple);
    if(leftPurple>0.03)return {screen:"select",bands,conf:Math.min(1,bands/6)};
  }
  // 2) 배틀: 우상단 상대 이름판(자홍) + 우하단 기술 버튼(보라) 조합
  const nameplate=ratio(img,rect,0.72,0.98,0.03,0.10,isMagenta);
  const moveBtns=ratio(img,rect,0.66,0.98,0.35,0.90,isPurple);
  if(nameplate>0.10&&moveBtns>0.05)return {screen:"battle",nameplate,moveBtns,conf:Math.min(1,nameplate*4)};
  return {screen:"other",bands,nameplate,moveBtns,conf:0};
}

// ── 동적 이름바 검출 ─────────────────────────────────────────────────────────
// 색 앵커로 이름바 경계를 찾아 반환(절대 픽셀 좌표). OCR은 한글 화이트리스트로 넘겨
// 스프라이트·성별 아이콘·HP 숫자를 필터하므로 픽셀 단위 정밀 크롭은 불필요.

// 지정 영역에서 pred 픽셀 밀도가 가장 높은 "최상단(또는 임의) 가로 밴드" 검출
function magentaBarTopRight(img,rect){
  const {x0,y0,w,h}=rect;
  const sx0=x0+Math.floor(w*0.55),sx1=x0+w;
  const sy0=y0,sy1=y0+Math.floor(h*0.25);
  const rows=new Int32Array(sy1-sy0);let maxc=0;
  for(let y=sy0;y<sy1;y++){let c=0;for(let x=sx0;x<sx1;x+=2){const[r,g,b]=px(img,x,y);if(isMagenta(r,g,b))c++;}rows[y-sy0]=c;if(c>maxc)maxc=c;}
  if(maxc<10)return null;
  const thr=maxc*0.30;
  let by0=-1,by1=-1;
  for(let i=0;i<rows.length;i++){if(rows[i]>thr){if(by0<0)by0=i;by1=i;}else if(by0>=0)break;}
  if(by0<0)return null;
  const ay0=sy0+by0,ay1=sy0+by1;
  let bx0=-1,bx1=-1;
  for(let x=sx0;x<sx1;x++){let c=0;for(let y=ay0;y<=ay1;y++){const[r,g,b]=px(img,x,y);if(isMagenta(r,g,b))c++;}if(c>0){if(bx0<0)bx0=x;bx1=x;}}
  if(bx0<0)return null;
  return {x0:bx0,y0:ay0,x1:bx1,y1:ay1};
}

// 좌하단 내 이름바 검출 — 앵커는 라임 테두리 외곽선(가로로 긴 라임 행).
// 상태 점(●)도 라임이지만 폭이 좁아 "넓은 라임 행" 임계로 배제. 바 상/하 테두리 행 사이가 이름바.
function limeBarBottomLeft(img,rect){
  const {x0,y0,w,h}=rect;
  const sx0=x0,sx1=x0+Math.floor(w*0.45);
  const sy0=y0+Math.floor(h*0.70),sy1=y0+h;
  const rows=new Int32Array(sy1-sy0);let maxc=0;
  for(let y=sy0;y<sy1;y++){let c=0;for(let x=sx0;x<sx1;x+=2){const[r,g,b]=px(img,x,y);if(isLime(r,g,b))c++;}rows[y-sy0]=c;if(c>maxc)maxc=c;}
  if(maxc<20)return null;
  // 테두리 행(넓은 라임)만: 최대의 45% 이상. 좁은 점 행은 제외.
  const thr=maxc*0.45;
  let by0=-1,by1=-1;
  for(let i=0;i<rows.length;i++)if(rows[i]>thr){if(by0<0)by0=i;by1=i;}
  if(by0<0)return null;
  const ay0=sy0+by0,ay1=sy0+by1;
  // 열 범위: 테두리 행 스팬 내 라임 좌우 경계
  let bx0=-1,bx1=-1;
  for(let x=sx0;x<sx1;x++){let c=0;for(let y=ay0;y<=ay1;y++){const[r,g,b]=px(img,x,y);if(isLime(r,g,b))c++;}if(c>0){if(bx0<0)bx0=x;bx1=x;}}
  if(bx0<0)return null;
  return {x0:bx0,y0:ay0,x1:bx1,y1:ay1};
}

// 선출 화면 상대 카드 6개 검출 (게임영역 기준). matcher.detectCards의 rect 인지 포트.
// 반환 {xL,xR,bands:[[y0,y1],...]} 은 전부 원본 절대 픽셀 → matcher.extractSprite(img,{xL,xR},band) 로 바로 사용.
function detectSelectCards(img,rect){
  rect=rect||fullRect(img);
  const {x0,y0,w,h}=rect;
  const colCnt=new Int32Array(w);
  for(let y=Math.floor(h*0.05);y<h*0.95;y+=4)
    for(let x=Math.floor(w*0.65);x<w;x+=2){
      const[r,g,b]=px(img,x0+x,y0+y);if(isMagenta(r,g,b))colCnt[x]++;
    }
  let xL=-1,xR=-1;const thr=h*0.9/4*0.25;
  for(let x=Math.floor(w*0.65);x<w;x++){if(colCnt[x]>thr){if(xL<0)xL=x;xR=x;}}
  if(xL<0)return null;
  const probe=x0+Math.floor(xL+(xR-xL)*0.04);
  const bands=[];let s=-1;
  for(let y=0;y<h;y++){
    const[r,g,b]=px(img,probe,y0+y);
    if(isMagenta(r,g,b)){if(s<0)s=y;}
    else{if(s>=0&&y-s>h*0.04)bands.push([y0+s,y0+y]);s=-1;}
  }
  if(s>=0&&h-s>h*0.04)bands.push([y0+s,y0+h]);
  if(bands.length<3)return null;
  const hs=bands.map(b=>b[1]-b[0]).sort((a,b)=>a-b);
  const med=hs[Math.floor(hs.length/2)];
  const cards=bands.filter(b=>{const hh=b[1]-b[0];return hh>med*0.7&&hh<med*1.3;});
  if(cards.length<3)return null;
  return {xL:x0+xL,xR:x0+xR,bands:cards.slice(0,6)};
}

// classify 결과에 따라 OCR/매칭 영역을 동적으로 산출. box 는 원본 프레임 절대 픽셀.
function detectRegions(img,screen,rect){
  rect=rect||fullRect(img);
  const out={};
  if(screen==="select"){
    const cards=detectSelectCards(img,rect);
    if(cards)out.cards=cards;  // matcher.extractSprite(img,{xL,xR},band) 로 소비
  }
  if(screen==="battle"){
    const opp=magentaBarTopRight(img,rect);
    if(opp){
      const bw=opp.x1-opp.x0,bh=opp.y1-opp.y0;
      out.oppName={x0:opp.x0,y0:opp.y0,x1:opp.x1-Math.floor(bw*0.06),y1:opp.y1,src:"anchor"};
      // 상대 이름바에 얹힌 2D 도감 스프라이트 아이콘 영역(바 기준 상대좌표 → 프레임 독립).
      // 이름 OCR이 게임 폰트에서 불가(ERR-001) → 이 아이콘을 선출 6마리와 템플릿 매칭해 활성 상대 식별.
      out.oppIcon={
        x0:Math.max(rect.x0,Math.round(opp.x0-bh*1.1)),
        y0:Math.max(rect.y0,Math.round(opp.y0-bh*0.5)),
        x1:Math.min(rect.x0+rect.w,Math.round(opp.x0+bh*2.7)),
        y1:Math.min(rect.y0+rect.h,Math.round(opp.y1+bh*1.5)),
        barH:bh,src:"anchor"};
    }
    const my=limeBarBottomLeft(img,rect);
    if(my){
      // 라임 테두리 박스 = 스프라이트+이름+HP바. 이름은 좌측~중앙, HP 숫자는 우측 → 우측 30% 트림,
      // 상하 테두리 라인은 살짝 안쪽으로. (남는 스프라이트·HP 숫자는 한글 화이트리스트 OCR이 필터)
      const bw=my.x1-my.x0,bh=my.y1-my.y0;
      out.myName={x0:my.x0+Math.floor(bw*0.02),y0:my.y0+Math.floor(bh*0.10),
                  x1:my.x1-Math.floor(bw*0.30),y1:my.y1-Math.floor(bh*0.10),src:"anchor"};
    }
    // 내 이름바 2D 도감 아이콘 → 등록된 내 팀과 매칭해 "지금 출전한 내 포켓몬" 자동 인식.
    // ⚠ 라임 앵커에 매달지 않는다: 실배틀 91프레임 확인 결과 바 테두리 색이 프레임마다
    //   라임(177,228,77) ↔ 연보라(177,175,220) ↔ 어두운 라임(132,152,44)으로 바뀌어(턴 하이라이트)
    //   limeBarBottomLeft가 HP바 초록을 바로 오인하거나 아예 실패했다(아이콘 잘림 → 매칭 실패).
    // UI가 게임영역에 고정 앵커라 비율이 매우 안정적(실측 2560x1392·1954x1114 두 종횡비 모두 포함).
    // 매칭은 슬라이딩(멀티스케일)이라 넉넉한 박스면 충분 → 아래 비율 상자로 고정.
    out.myIcon=cropToBox(CROPS.myIcon,rect);
  }
  return out;
}

// 비율 CROPS → 절대 픽셀 박스(동적 검출 실패 시 폴백)
function cropToBox(crop,rect){
  const {x0,y0,w,h}=rect;
  return {x0:x0+Math.floor(w*crop.x),y0:y0+Math.floor(h*crop.y),
          x1:x0+Math.floor(w*(crop.x+crop.w)),y1:y0+Math.floor(h*(crop.y+crop.h)),src:"ratio"};
}

// ── 원콜 API: 게임영역 검출 → 분류 → 영역 산출 → 저해상도 가드 ────────────────
const MIN_OCR_W=960; // 이 폭 미만이면 OCR 글자 뭉갬 → 업스케일 권장
function analyze(img){
  const rect=detectGameRect(img);
  const c=classify(img,rect);
  const regions=detectRegions(img,c.screen,rect);
  // 폴백: 동적 검출 실패 영역은 비율 CROPS로 채움
  if(c.screen==="battle"){
    if(!regions.oppName)regions.oppName=cropToBox(CROPS.oppName,rect);
    if(!regions.myName)regions.myName=cropToBox(CROPS.myName,rect);
  }
  const lowRes=rect.w<MIN_OCR_W;
  const upscale=lowRes?Math.max(2,Math.ceil(MIN_OCR_W/rect.w)):1;
  return {rect,screen:c.screen,conf:c.conf,detail:c,regions,lowRes,upscale};
}

// 프레임 변화 감지용 요약 해시 (16x9 그리드 평균 밝기)
function frameHash(img){
  const W=img.width,H=img.height,gx=16,gy=9,out=new Uint8Array(gx*gy);
  for(let j=0;j<gy;j++)for(let i=0;i<gx;i++){
    let s=0,n=0;
    for(let y=Math.floor(H*j/gy);y<Math.floor(H*(j+1)/gy);y+=8)
      for(let x=Math.floor(W*i/gx);x<Math.floor(W*(i+1)/gx);x+=8){
        const p=(y*W+x)*4;s+=img.data[p]+img.data[p+1]+img.data[p+2];n++;
      }
    out[j*gx+i]=n?Math.floor(s/n/3):0;
  }
  return out;
}
function hashDiff(a,b){
  if(!a||!b||a.length!==b.length)return 1;
  let d=0;for(let i=0;i<a.length;i++)d+=Math.abs(a[i]-b[i]);
  return d/(a.length*255);
}

// 배틀 화면 크롭 좌표(rect 내부 비율) — 동적 검출 실패 시 폴백 전용
// 실프레임(2559x1439) 측정: 스프라이트 썸네일·성별 아이콘 제외, 이름 텍스트에 밀착
const CROPS={
  oppName:{x:0.790,y:0.026,w:0.158,h:0.060},
  myName:{x:0.056,y:0.846,w:0.168,h:0.052},
  // 내 이름바 아이콘(도감 2D) 탐색 상자 — 실배틀 91프레임 검증(2560x1392·1954x1114 모두 아이콘 전체 포함)
  myIcon:{x:0.012,y:0.842,w:0.090,h:0.128},
};

return {analyze,classify,detectGameRect,detectRegions,detectSelectCards,frameHash,hashDiff,CROPS,
        isMagenta,isPurple,isLime};
});
