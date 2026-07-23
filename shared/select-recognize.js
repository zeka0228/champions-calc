// select-recognize.js — 선출(상대 팀) 화면 6마리 견고 인식 (순수 로직, Node+브라우저 겸용)
//
// 팀등록(team-register.recognize)과 "동일한 방식"으로 정확도를 끌어올린다(유저 요청 2026-07-23):
//   ① 타입 먼저 추론 → 그 타입 후보로 선필터 (team-register.detectSelectTypes/candByTypes 재사용)
//   ② 후보 안에서 항상 최선 반환 (팀스캔 decideCell 철학 — 불확실해도 색/형태 최고를 채택)
//   ③ 타입필터가 정답을 배제한 듯하면(최선 score가 형편없음) 전체 후보로 재매칭 (폴백)
//   ④ 빈 카드(아직 선출 안 됨)만 거부 (extractSprite 실패 or score·corr 둘 다 나쁨)
//   ⑤ 채택 실패 슬롯은 멀티스케일 리샘플 재시도 (팀스캔 recognizeRobust와 동일 — 창 크기 변화 효과)
//
// matcher(SM) 원본 무수정: extractSprite/extractSpriteEdge/matchAll 를 그대로 사용.
// 카드 지오메트리는 screen-classifier.detectSelectCards(img,rect) 로 산출(프레임 독립).
// ✅ 오프라인 검증(실선출 15프레임): fill 77.8%→88.9%, 라벨일치 83.3%→86.7% (팀식 이식 효과).
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.SelectRecognize=factory();
})(typeof self!=="undefined"?self:this,function(){

  // 팀등록 recognizeRobust 와 동일 스케일 세트(창 늘렸다 줄이면 인식되던 현상 자동화)
  const RETRY_SCALES=[0.86,1.12,1.30,1.48,0.72,1.62];
  const SCORE_FALLBACK=8000;             // 타입필터 최선 score가 이보다 나쁘면 → 전체후보 재매칭(정답 배제 의심)
  const ACCEPT_CORR=0.30, ACCEPT_SCORE=6000; // 채택 게이트: corr 높거나 색 score 낮을 때만(빈카드/노이즈 거부)
  const CORR_TAKE=0.45;                  // 이 이상이면 corr(형태) 우선, 아니면 색 score1

  function resampleRegion(img,rect,W){
    const H=Math.round(rect.h*W/rect.w),out=new Uint8Array(W*H*4);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const sx=rect.x0+Math.min(rect.w-1,(x*rect.w/W)|0),sy=rect.y0+Math.min(rect.h-1,(y*rect.h/H)|0);
      const si=(sy*img.width+sx)*4,di=(y*W+x)*4;
      out[di]=img.data[si];out[di+1]=img.data[si+1];out[di+2]=img.data[si+2];out[di+3]=255;
    }
    return {data:out,width:W,height:H};
  }

  // ranked(색 오름차순) → {id,corr,score}. corr 충분하면 형태 우선, 아니면 색 최상위.
  function pickBest(ranked){
    if(!ranked||!ranked.length)return {id:null,corr:-1,score:1e9};
    const bc=ranked.slice(0,6).sort((a,b)=>b.corr-a.corr)[0], b0=ranked[0];
    const chosen=(bc.corr>=CORR_TAKE)?bc:b0;
    return {id:chosen.id,corr:bc.corr,score:b0.score};
  }
  // 카드 1장: 타입필터 후보에서 최선 + (score 나쁘면) 전체후보 폴백
  function decideOne(SM,region,edge,cand,assets){
    let best=pickBest(SM.matchAll(region,edge,cand));
    if(best.score>SCORE_FALLBACK&&cand.length<assets.length){
      const bAll=pickBest(SM.matchAll(region,edge,assets));
      if(bAll.score<best.score){best=bAll;best.fellback=true;}
    }
    return best;
  }
  const accept=c=>!!(c&&c.id&&(c.corr>=ACCEPT_CORR||c.score<ACCEPT_SCORE));

  // 한 이미지(원본 or 리샘플) → 카드별 판정 결과 배열
  function scanOnce(img,rect,deps){
    const {SM,SC,TR,assets,creatures}=deps;
    const cards=SC.detectSelectCards(img,rect);
    if(!cards)return null;
    const geo={xL:cards.xL,xR:cards.xR};
    const typeOf=id=>{const c=creatures&&creatures[id];return c&&c.types?c.types:[];};
    const slots=cards.bands.map(band=>{
      const region=SM.extractSprite(img,geo,band);
      if(!region)return {id:null,corr:-1,score:1e9,types:[]};
      const edge=SM.extractSpriteEdge(img,geo,band);
      const types=creatures?TR.detectSelectTypes(img,geo,band):[];
      const cand=creatures?TR.candByTypes(types,typeOf,assets):assets;
      const c=decideOne(SM,region,edge,cand,assets);
      c.types=types;c.candN=cand.length;
      return c;
    });
    return {slots,bands:cards.bands,geo};
  }

  // 고수준: 이미지+rect → {ids, types, slots, ok}. deps={SM,SC,TR,assets,creatures}.
  // ids[i] = 채택된 종족 id 또는 null(빈카드/불확실). ok = 5마리 이상 채택(거의 완전한 선출).
  function recognize(img,rect,deps){
    const base=scanOnce(img,rect,deps);
    if(!base)return {ids:[null,null,null,null,null,null],types:[],slots:[],ok:false};
    const slots=base.slots.map(s=>({...s}));
    if(slots.some(s=>!accept(s))){                    // 채택 실패 슬롯만 스케일 재시도
      for(const m of RETRY_SCALES){
        const W=Math.round(rect.w*m);if(W<600||W>6000)continue;
        let rs;try{rs=resampleRegion(img,rect,W);}catch(e){continue;}
        const r=scanOnce(rs,{x0:0,y0:0,w:rs.width,h:rs.height},deps);
        if(!r)continue;
        for(let i=0;i<slots.length&&i<r.slots.length;i++){
          if(accept(slots[i]))continue;
          const c=r.slots[i];                          // 더 나은 결과(형태↑ 또는 색↓)면 교체
          if(c&&c.id&&(c.corr>(slots[i].corr||-1)||c.score<(slots[i].score||1e9)))slots[i]={...c,scale:m};
        }
        if(slots.every(accept))break;                  // 전 슬롯 채택 → 조기 종료
      }
    }
    const ids=slots.map(s=>accept(s)?s.id:null);
    const types=slots.map(s=>s.types||[]);
    return {ids,types,slots,ok:ids.filter(Boolean).length>=5};
  }

  // 선출 서명(순서 유지, null=_) — 변화 감지용
  function signature(ids){return (ids||[]).map(id=>id||"_").join(",");}

  return {recognize,scanOnce,accept,signature,RETRY_SCALES};
});
