// screen-classifier.js — 프레임이 어떤 게임 화면인지 빠르게 분류 (순수 로직, Node+브라우저 겸용)
// 반환: 'select' (선출 화면) | 'battle' (배틀 커맨드 화면) | 'other'
// ✅ 실프레임 검증(M1, 2026-07-21): 실제 캡처 2559x1439(16:9)에서 classify() 선출/배틀 100% 정확.
//    임계값은 비율 기반이라 해상도 무관. CROPS만 실측으로 소폭 보정(오차 클러터 제거).
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.ScreenClassifier=factory();
})(typeof self!=="undefined"?self:this,function(){

// 자홍색(상대 카드/이름판) — matcher.js isCard와 동일 계열
const isMagenta=(r,g,b)=>r>70&&r-g>45&&r-b>15&&g<120;
// 보라색(내 파티 카드/기술 버튼 계열)
const isPurple=(r,g,b)=>b>80&&b-g>30&&r>40&&r<160&&g<110;

function px(img,x,y){const i=(y*img.width+x)*4;return[img.data[i],img.data[i+1],img.data[i+2]];}

// 우측 열의 자홍 세로 밴드 개수 (matcher.detectCards 간이판)
function rightBandCount(img){
  const W=img.width,H=img.height;
  const colCnt=new Int32Array(W);
  for(let y=Math.floor(H*0.05);y<H*0.95;y+=4)
    for(let x=Math.floor(W*0.65);x<W;x+=2){
      const[r,g,b]=px(img,x,y);if(isMagenta(r,g,b))colCnt[x]++;
    }
  let xL=-1,xR=-1;const thr=(H*0.9/4)*0.25;
  for(let x=Math.floor(W*0.65);x<W;x++){if(colCnt[x]>thr){if(xL<0)xL=x;xR=x;}}
  if(xL<0)return 0;
  const probe=Math.floor(xL+(xR-xL)*0.04);
  let bands=0,s=-1;
  for(let y=0;y<H;y++){
    const[r,g,b]=px(img,probe,y);
    if(isMagenta(r,g,b)){if(s<0)s=y;}
    else{if(s>=0&&y-s>H*0.04)bands++;s=-1;}
  }
  if(s>=0&&H-s>H*0.04)bands++;
  return bands;
}

// 영역 내 색 비율
function ratio(img,x0,x1,y0,y1,pred){
  const W=img.width,H=img.height;
  let n=0,hit=0;
  for(let y=Math.floor(H*y0);y<H*y1;y+=3)
    for(let x=Math.floor(W*x0);x<W*x1;x+=3){
      const[r,g,b]=px(img,x,y);n++;if(pred(r,g,b))hit++;
    }
  return n?hit/n:0;
}

function classify(img){
  // 1) 선출: 우측 자홍 카드 밴드 4개 이상 + 좌측 보라 파티 카드 존재
  const bands=rightBandCount(img);
  if(bands>=4){
    const leftPurple=ratio(img,0.04,0.30,0.10,0.85,isPurple);
    if(leftPurple>0.03)return {screen:"select",bands,conf:Math.min(1,bands/6)};
  }
  // 2) 배틀: 우상단 상대 이름판(자홍) + 우하단 기술 버튼(보라) 조합
  const nameplate=ratio(img,0.72,0.98,0.03,0.10,isMagenta);
  const moveBtns=ratio(img,0.66,0.98,0.35,0.90,isPurple);
  if(nameplate>0.10&&moveBtns>0.05)return {screen:"battle",nameplate,moveBtns,conf:Math.min(1,nameplate*4)};
  return {screen:"other",bands,nameplate,moveBtns,conf:0};
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

// 배틀 화면 크롭 좌표 (화면 비율 기준) — OCR 대상 영역
// 실프레임(2559x1439) 측정 보정: 스프라이트 썸네일·성별 아이콘 제외, 이름 텍스트에 밀착
const CROPS={
  oppName:{x:0.790,y:0.026,w:0.158,h:0.060},  // 우상단 상대 이름 (스프라이트 우측부터, ♀ 아이콘 앞까지)
  myName:{x:0.056,y:0.846,w:0.168,h:0.052},   // 좌하단 내 이름
};

return {classify,frameHash,hashDiff,CROPS,isMagenta,isPurple};
});
