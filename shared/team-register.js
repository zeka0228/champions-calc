// team-register.js — 팀 상세(팀등록) 화면에서 내 팀 6마리 종족 인식 (순수 로직, Node+브라우저 겸용)
//
// 팀등록 화면 = 게임 "팀 상세"(능력/스테이터스 탭). 2×3 라벤더 카드 그리드, 각 카드 좌상단에
// 도감 2D 아이콘. 이 아이콘을 전체 종(SPRITE_INDEX)과 매칭해 6마리를 식별한다.
// screen-classifier.classify 가 상단 라임 탭 앵커로 'teamregister' 를 분류 → overlay 가 recognize() 호출.
//
// ✅ 실프레임 검증(2559x1439, 능력탭/스테이터스탭 2장): 6/6 정확 + 두 탭 라벨 6/6 동일(dedup 안정성).
//   설계 근거: 카드=라벤더 컬럼 투영으로 2컬럼 검출 → 탭 오염 배제한 상대임계 vspan 으로 카드 세로범위 →
//   3등분 → 각 셀 좁은 x박스에서 그래디언트 "첫 블롭"(아이콘/스탯 사이 라벤더 갭에서 멈춤)만 세그먼트해
//   높이·탭 무관하게 아이콘만 추출 → matcher.matchAll(전체 종). 임계값은 실프레임 2장 기준 잠정값.
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.TeamRegister=factory();
})(typeof self!=="undefined"?self:this,function(){

// 라벤더 카드(밝은 보라) — screen-classifier.isPurple(짙은 보라)와 별개. 팀등록 카드 전용.
const isLav=(r,g,b)=>b>110&&b-g>25&&r>70&&r<200&&g<175&&b<235;
function px(img,x,y){const i=(y*img.width+x)*4;return[img.data[i],img.data[i+1],img.data[i+2]];}

// ── 순수 이미지 유틸(matcher 무수정 원칙 → 여기서 자체 구현) ─────────────────
function crop(img,x0,y0,w,h){const out=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let sx=x0+x,sy=y0+y;
    if(sx<0)sx=0;if(sy<0)sy=0;if(sx>=img.width)sx=img.width-1;if(sy>=img.height)sy=img.height-1;
    const si=(sy*img.width+sx)*4,di=(y*w+x)*4;out[di]=img.data[si];out[di+1]=img.data[si+1];out[di+2]=img.data[si+2];out[di+3]=255;}
  return {data:out,width:w,height:h};}
function padSquare(img,fill){const s=Math.max(img.width,img.height),out=new Uint8Array(s*s*4);
  for(let i=0;i<s*s;i++){out[i*4]=fill[0];out[i*4+1]=fill[1];out[i*4+2]=fill[2];out[i*4+3]=255;}
  const ox=(s-img.width)>>1,oy=(s-img.height)>>1;
  for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){const si=(y*img.width+x)*4,di=((y+oy)*s+(x+ox))*4;
    out[di]=img.data[si];out[di+1]=img.data[si+1];out[di+2]=img.data[si+2];out[di+3]=img.data[si+3];}
  return {data:out,width:s,height:s};}
function resize(img,w,h){const out=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const sx=Math.min(img.width-1,(x*img.width/w)|0),sy=Math.min(img.height-1,(y*img.height/h)|0);
    const si=(sy*img.width+sx)*4,di=(y*w+x)*4;out[di]=img.data[si];out[di+1]=img.data[si+1];out[di+2]=img.data[si+2];out[di+3]=255;}
  return {data:out,width:w,height:h};}
function blur(img){const w=img.width,h=img.height,out=new Uint8Array(img.data);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let r=0,g=0,b=0,n=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const yy=y+dy,xx=x+dx;if(yy<0||yy>=h||xx<0||xx>=w)continue;
      const i=(yy*w+xx)*4;r+=img.data[i];g+=img.data[i+1];b+=img.data[i+2];n++;}
    const o=(y*w+x)*4;out[o]=r/n;out[o+1]=g/n;out[o+2]=b/n;}
  return {data:out,width:w,height:h};}
function grad(img,gx,gy){let g=0;
  for(let c=0;c<3;c++){const a=px(img,gx+1,gy)[c]-px(img,gx-1,gy)[c];const b=px(img,gx,gy+1)[c]-px(img,gx,gy-1)[c];
    const m=Math.abs(a)+Math.abs(b);if(m>g)g=m;}
  return g;}

// ── 2×3 카드 그리드 검출 (게임영역 rect 기준, 프레임 독립) ────────────────────
// 라벤더 컬럼 투영 → 좌/우 두 컬럼(상단바/탭 제외 y0.25~0.78)
function detectColumns(img,rect){const{x0,y0,w,h}=rect;const cnt=new Int32Array(w);
  for(let y=Math.floor(h*0.25);y<h*0.78;y+=4)for(let x=0;x<w;x++){const[r,g,b]=px(img,x0+x,y0+y);if(isLav(r,g,b))cnt[x]++;}
  let mx=0;for(let x=0;x<w;x++)if(cnt[x]>mx)mx=cnt[x];const thr=mx*0.35;
  const runs=[];let s=-1;
  for(let x=0;x<w;x++){if(cnt[x]>thr){if(s<0)s=x;}else{if(s>=0&&x-s>w*0.1)runs.push([s,x]);s=-1;}}
  if(s>=0&&w-s>w*0.1)runs.push([s,w]);
  return runs.map(r=>[x0+r[0],x0+r[1]]);}
// 카드 세로범위: 탭 아래(0.25h)부터 상대임계(0.55*max). 비활성 탭(라벤더) 오염 배제 → A/B 안정.
function cardVspan(img,rect,col){const{h}=rect;const[cL,cR]=col;
  const y0s=Math.floor(rect.y0+h*0.25),y1s=Math.floor(rect.y0+h*0.84);
  const dens=new Float64Array(y1s-y0s);let mx=0;
  for(let y=y0s;y<y1s;y++){let c=0,n=0;for(let x=cL;x<cR;x+=3){const[r,g,b]=px(img,x,y);n++;if(isLav(r,g,b))c++;}
    const d=n?c/n:0;dens[y-y0s]=d;if(d>mx)mx=d;}
  const thr=mx*0.55;let top=-1,bot=-1;
  for(let i=0;i<dens.length;i++)if(dens[i]>thr){if(top<0)top=y0s+i;bot=y0s+i;}
  return{top,bot};}

// 셀(카드) 좌상단 아이콘 박스 6개를 화면 읽기순서(행우선: 좌,우,좌,우,좌,우)로 반환. 절대 픽셀.
function detectCells(img,rect){
  const cols=detectColumns(img,rect);
  if(cols.length<2)return null;
  cols.sort((a,b)=>a[0]-b[0]);              // 좌→우
  const spans=cols.slice(0,2).map(c=>cardVspan(img,rect,c));
  if(spans.some(s=>s.top<0||s.bot-s.top<30))return null;
  const cells=[];
  for(let r=0;r<3;r++)for(let ci=0;ci<2;ci++){
    const col=cols[ci],{top,bot}=spans[ci],rh=(bot-top)/3,cW=col[1]-col[0];
    const rowTop=Math.round(top+r*rh);
    cells.push({box:{
      x0:col[0]+Math.round(cW*0.005),y0:rowTop+Math.round(rh*0.00),
      x1:col[0]+Math.round(cW*0.11), y1:rowTop+Math.round(rh*0.42)},col:ci,row:r});
  }
  return cells;
}

// 셀 박스에서 아이콘만 추출 → 40x40 {region(색), edge(그래디언트용)}.
// 좁은 x박스 → 이름 텍스트 배제. 위에서부터 첫 그래디언트 블롭만: 아이콘↔스탯 사이 라벤더 갭에서 멈춰
// 아이콘 높이·탭(능력/스탯) 무관. bg=라벤더 패딩(색 매칭), 회색 패딩(윤곽 corr).
function extractIcon(img,box){
  const{x0,y0,x1,y1}=box,w=x1-x0,h=y1-y0;if(w<12||h<12)return null;
  const gthr=35;
  const rowc=new Int32Array(h);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){if(grad(img,x0+x,y0+y)>gthr)rowc[y]++;}
  let mxr=0;for(let y=0;y<h;y++)if(rowc[y]>mxr)mxr=rowc[y];if(mxr<4)return null;
  const onThr=Math.max(2,mxr*0.12),gap=Math.max(9,Math.round(h*0.11));
  let yTop=-1;for(let y=0;y<h;y++)if(rowc[y]>=onThr){yTop=y;break;}
  if(yTop<0)return null;
  let yBot=h-1,run=0;
  for(let y=yTop;y<h;y++){if(rowc[y]<onThr){if(++run>=gap){yBot=y-run;break;}}else run=0;}
  if(yBot<=yTop)yBot=h-1;
  const colc=new Int32Array(w);
  for(let x=1;x<w-1;x++)for(let y=yTop;y<=yBot;y++){if(grad(img,x0+x,y0+y)>gthr)colc[x]++;}
  let xL=-1,xR=-1;const cThr=Math.max(2,mxr*0.10);
  for(let x=0;x<w;x++)if(colc[x]>=cThr){if(xL<0)xL=x;xR=x;}
  if(xL<0)return null;
  const iw=xR-xL+1,ih=yBot-yTop+1;if(iw<12||ih<12)return null;
  let br=0,bg=0,bb=0,bn=0;
  for(let y=0;y<3;y++)for(let x=0;x<3;x++){const p=px(img,x0+x,y0+y);if(isLav(p[0],p[1],p[2])){br+=p[0];bg+=p[1];bb+=p[2];bn++;}}
  const bgc=bn>3?[br/bn,bg/bn,bb/bn]:[150,143,209];
  const c=crop(img,x0+xL,y0+yTop,iw,ih);
  return {region:blur(resize(padSquare(c,bgc),40,40)),edge:blur(resize(padSquare(c,[128,128,128]),40,40)),iw,ih};
}

// 셀 1장 판정: 색 상위 6후보 중 형태(corr) 최고 우선. 팀 dedup은 "일관된 라벨"이 중요하므로
// 불확실해도 색 top1로 채택(결정적 → 프레임 간 동일). 추출 실패만 null.
function decideCell(ranked){
  if(!ranked||!ranked.length)return null;
  const best=ranked.slice(0,6).sort((a,b)=>b.corr-a.corr)[0];
  if(best&&best.corr>=0.45)return best.id;
  return ranked[0].id;
}

// 고수준: 이미지+rect → 내 팀 6마리 종족 id 배열(읽기순서). matcher=SpriteMatcher, assets=[{id,img}].
// 6셀 모두 식별되면 {mons:[6], cells} 반환, 아니면 {mons, ok:false}.
function recognize(img,rect,matcher,assets){
  const cells=detectCells(img,rect);
  if(!cells)return null;
  const mons=[],scores=[];
  for(const cell of cells){
    const ex=extractIcon(img,cell.box);
    if(!ex){mons.push(null);scores.push(null);continue;}
    const ranked=matcher.matchAll(ex.region,ex.edge,assets);
    mons.push(decideCell(ranked));
    scores.push(ranked[0]?Math.round(ranked[0].score):null);
  }
  const ok=mons.filter(Boolean).length>=6;
  return {mons,scores,cells,ok};
}

// 팀 서명(순서 무관 종족 집합) — dedup 키
function signature(mons){return mons.filter(Boolean).slice().sort().join(",");}

return {isLav,detectColumns,cardVspan,detectCells,extractIcon,decideCell,recognize,signature};
});
