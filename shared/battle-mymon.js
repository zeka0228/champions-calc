// battle-mymon.js — 배틀 중 "지금 출전한 내 포켓몬" 자동 인식 (순수 로직, Node+브라우저 겸용)
//
// 입력: screen-classifier 의 regions.myIcon 영역 픽셀 + 등록 팀 후보 에셋(40x40 도감 아이콘)
// 출력: 후보 중 최선 1마리 (닫힌 집합 = 내 등록 팀이므로 절대 임계 대신 "바 존재 게이트 + 최선 채택")
//
// 실배틀 91프레임(2560x1392·1954x1114) 오프라인 검증 결과 이 모듈이 해결한 것:
//   ① 이름바 앵커 붕괴 — 바 테두리 색이 라임↔연보라↔어두운라임으로 바뀌어(턴 하이라이트)
//      라임 기반 앵커가 HP바 초록을 바로 오인하거나 실패 → 아이콘이 잘려 매칭 자체가 불가능했다.
//      → screen-classifier 가 검증된 비율 상자(CROPS.myIcon)를 주고, 여기선 슬라이딩으로 찾는다.
//   ② 스케일 불일치 — 기존 경로는 상대 이름바 기준 스케일(barH*1.5~3.0)을 그대로 써서
//      내 아이콘 실제 크기(영역 높이의 약 0.5~0.8배)와 아예 겹치지 않았다. → ICON_SCALES 로 교정.
//   ③ 배틀 아닌 화면(대화·메뉴·연출)에서의 오인식 — 아이콘 받침(연보라 원형판) 밀도로 게이트.
//      실측 분리: 바 있는 프레임 0.133~0.289 / 바 없는 프레임 0.000~0.002 (임계 0.06).
// 정확도(라벨 22프레임, 메가 아이콘 없이 기본 스프라이트만): 20/22. 바 없는 6프레임 전부 거부.
// 단발 오인식은 오버레이의 2틱 연속 일치(히스테리시스)로 걸러진다.
(function(root,factory){
  if(typeof module!=="undefined"&&module.exports)module.exports=factory();
  else root.BattleMyMon=factory();
})(typeof self!=="undefined"?self:this,function(){

  const TARGET_H=64;                                   // 영역 높이 정규화(해상도 무관 상수시간)
  const ICON_SCALES=[0.50,0.58,0.66,0.74,0.82];        // 아이콘 변 = 영역 높이의 이 비율(실측 범위)
  const PLATE_MIN=0.06;                                // 아이콘 받침 밀도 게이트(있음 0.133+ / 없음 0.002-)
  const CORR_TAKE=0.45;                                // 형태(그라디언트 NCC) 우선 채택 임계 — 선출 경로와 동일

  // ── 아이콘 받침(연보라 원형판) 밀도: 이름바가 화면에 있는지 판정 ──────────────
  function plateRatio(region){
    const t=region.width*region.height;if(!t)return 0;
    let n=0;
    for(let i=0;i<t;i++){
      const r=region.data[i*4],g=region.data[i*4+1],b=region.data[i*4+2];
      if(b>195&&b-r>55&&b-g>60&&r>90)n++;
    }
    return n/t;
  }
  function hasMyBar(region){return plateRatio(region)>=PLATE_MIN;}

  function scaleRGBA(a,w,h){
    const out=new Uint8Array(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const sx=Math.min(a.width-1,(x*a.width/w)|0),sy=Math.min(a.height-1,(y*a.height/h)|0);
      const si=(sy*a.width+sx)*4,di=(y*w+x)*4;
      out[di]=a.data[si];out[di+1]=a.data[si+1];out[di+2]=a.data[si+2];out[di+3]=a.data[si+3];
    }
    return {data:out,width:w,height:h};
  }
  // 채널별 그라디언트 최댓값(색 변화에 불변) — matcher.gradOf 와 동일 정의
  function gradOf(img){
    const w=img.width,h=img.height,d=img.data,G=new Float32Array(w*h);
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x;let m=0;
      for(let c=0;c<3;c++){
        const g=Math.abs(d[(i+1)*4+c]-d[(i-1)*4+c])+Math.abs(d[(i+w)*4+c]-d[(i-w)*4+c]);
        if(g>m)m=g;
      }
      G[i]=m;
    }
    return G;
  }
  function corr40(patchG,asset,assetG){
    let n=0,sr=0,sa=0,srr=0,saa=0,sra=0;
    for(let y=1;y<39;y++)for(let x=1;x<39;x++){
      const ai=y*40+x;if(asset.data[ai*4+3]<140)continue;
      const gr=patchG[ai],ga=assetG[ai];
      n++;sr+=gr;sa+=ga;srr+=gr*gr;saa+=ga*ga;sra+=gr*ga;
    }
    if(n<200)return -1;
    const den=Math.sqrt((n*srr-sr*sr)*(n*saa-sa*sa));
    return den>1e-6?(n*sra-sr*sa)/den:-1;
  }
  // 슬라이딩 멀티스케일 매칭 → 최소 MSE 위치 + 그 위치의 형태 corr
  function matchOne(region,asset,scales){
    let best={score:1e9,ox:0,oy:0,S:scales[0]};
    for(const S of scales){
      const T=scaleRGBA(asset,S,S);
      for(let oy=-Math.floor(S*0.2);oy<=region.height-S*0.4;oy+=3)
        for(let ox=-Math.floor(S*0.15);ox<=region.width-S*0.4;ox+=3){
          let sum=0,n=0;
          for(let ty=0;ty<S;ty+=2)for(let tx=0;tx<S;tx+=2){
            const ti=(ty*S+tx)*4;if(T.data[ti+3]<140)continue;
            const rx=ox+tx,ry=oy+ty;if(rx<0||ry<0||rx>=region.width||ry>=region.height)continue;
            const ri=(ry*region.width+rx)*4;
            const dr=region.data[ri]-T.data[ti],dg=region.data[ri+1]-T.data[ti+1],db=region.data[ri+2]-T.data[ti+2];
            sum+=dr*dr+dg*dg+db*db;n++;
          }
          if(n<150)continue;
          const sc=sum/n;if(sc<best.score)best={score:sc,ox,oy,S};
        }
    }
    const {ox,oy,S}=best,patch=new Uint8Array(40*40*4);
    for(let y=0;y<40;y++)for(let x=0;x<40;x++){
      const rx=ox+Math.round(x*S/40),ry=oy+Math.round(y*S/40),di=(y*40+x)*4;
      if(rx<0||ry<0||rx>=region.width||ry>=region.height){patch[di+3]=255;continue;}
      const si=(ry*region.width+rx)*4;
      patch[di]=region.data[si];patch[di+1]=region.data[si+1];patch[di+2]=region.data[si+2];patch[di+3]=255;
    }
    if(!asset._g)asset._g=gradOf(asset);
    return {score:best.score,corr:corr40(gradOf({data:patch,width:40,height:40}),asset,asset._g)};
  }

  // region: {data,width,height} = regions.myIcon 크롭 / assets: [{id,img:{data,width:40,height:40}}]
  // 반환 {id,score,corr,second,margin} | null(이름바 없음 = 배틀 연출·메뉴 등)
  function identify(region,assets){
    if(!region||!assets||!assets.length)return null;
    if(!hasMyBar(region))return null;
    const f=TARGET_H/Math.max(1,region.height);
    const R=f<1?scaleRGBA(region,Math.max(8,Math.round(region.width*f)),TARGET_H):region;
    const scales=ICON_SCALES.map(k=>Math.max(12,Math.round(R.height*k)));
    const scored=assets.map(a=>({id:a.id,...matchOne(R,a.img,scales)})).sort((x,y)=>x.score-y.score);
    // 색 상위 4 중 형태 corr 이 충분히 높으면 형태 우선(선출 인식과 동일 정책), 아니면 색 1위.
    const byCorr=scored.slice(0,4).sort((x,y)=>y.corr-x.corr)[0];
    const pick=(byCorr&&byCorr.corr>=CORR_TAKE)?byCorr:scored[0];
    const other=scored.find(s=>s.id!==pick.id);
    return {id:pick.id,score:pick.score,corr:pick.corr,
            second:other?other.id:null,
            margin:other?(other.score-pick.score)/Math.max(1,pick.score):1};
  }

  return {identify,hasMyBar,plateRatio,PLATE_MIN,ICON_SCALES,CORR_TAKE,TARGET_H};
});
