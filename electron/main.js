// main.js — Electron 메인 프로세스: 창 선택형 캡처 + 투명 오버레이 + 전역 핫키
const {app,BrowserWindow,ipcMain,desktopCapturer,globalShortcut,screen}=require("electron");
const path=require("path");
const fs=require("fs");
// [진단] overlay가 to-control "diag"로 보내는 로그를 파일로도 남김(바탕화면/포챔스_diag.log) — 원격 진단용.
let DIAG_LOG=null;

// [로컬 전용] 데이터셋 캡처는 gitignore된 electron/capture.local.js 가 있을 때만 활성(클린 체크아웃엔 없음 → 무동작).
let CAP=null; try{CAP=require("./capture.local.js");}catch(e){}

let overlayWin=null,controlWin=null;
if(CAP)CAP.initMain(ipcMain,()=>controlWin); // save-capture 핸들러 등록(파일 있을 때만)

// 주요 에뮬레이터 자동 감지 (창 제목) — 그 외는 목록에서 수동 선택
const EMU_PATTERNS=[/bluestacks/i,/ldplayer/i,/nox/i,/mumu/i,/memu/i,/google play games/i,/녹스/,/미뮤/];

function createOverlay(){
  const {workArea}=screen.getPrimaryDisplay();
  overlayWin=new BrowserWindow({
    x:workArea.x,y:workArea.y,width:workArea.width,height:workArea.height,
    transparent:true,frame:false,resizable:false,movable:false,
    skipTaskbar:true,focusable:false,hasShadow:false,
    webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false},
  });
  overlayWin.setAlwaysOnTop(true,"screen-saver");
  overlayWin.setIgnoreMouseEvents(true,{forward:true});
  overlayWin.loadFile(path.join(__dirname,"overlay.html"));
}

function createControl(){
  controlWin=new BrowserWindow({
    width:560,height:640,title:"포챔스 오버레이 — 설정",
    webPreferences:{nodeIntegration:true,contextIsolation:false},
  });
  controlWin.loadFile(path.join(__dirname,"control.html"));
  controlWin.on("closed",()=>{controlWin=null;});
}

// 캡처 가능한 창 목록 (에뮬레이터 우선 정렬)
ipcMain.handle("list-sources",async()=>{
  const sources=await desktopCapturer.getSources({types:["window"],thumbnailSize:{width:320,height:180}});
  return sources
    .filter(s=>s.name&&s.name.trim())
    .map(s=>({id:s.id,name:s.name,thumb:s.thumbnail.toDataURL(),
      emu:EMU_PATTERNS.some(p=>p.test(s.name))}))
    .sort((a,b)=>(b.emu?1:0)-(a.emu?1:0));
});

// 컨트롤 → 오버레이 메시지 중계 (캡처 대상 선택, 내 포켓몬 설정 등)
ipcMain.on("to-overlay",(e,ch,payload)=>{if(overlayWin)overlayWin.webContents.send(ch,payload);});
ipcMain.on("to-control",(e,ch,payload)=>{
  if(controlWin)controlWin.webContents.send(ch,payload);
  if(ch==="diag"&&DIAG_LOG){try{const l=(payload&&payload.line)!=null?payload.line:String(payload);
    fs.appendFileSync(DIAG_LOG,`[${new Date().toISOString()}] ${l}\n`);}catch(err){}}
});

// 클릭 통과 제어: 렌더러가 커서가 HUD 위일 때만 캡처 요청 → 게임 영역 클릭은 항상 통과.
// (기존 '조작모드'는 전체 화면 클릭을 캡처해 게임을 막던 문제 → hover 기반으로 교체)
ipcMain.on("hud-interactive",(e,v)=>{
  if(overlayWin)overlayWin.setIgnoreMouseEvents(!v,{forward:true});
});
// 세트 편집(성격·특성·기술·아이템·노력치) 시 검색 입력에 키보드 포커스가 필요 → 편집 중에만 창을 포커스 가능하게.
// 평소엔 focusable:false 유지(게임 포커스를 뺏지 않음). 편집 종료 시 다시 false로.
ipcMain.on("overlay-focus",(e,v)=>{
  if(!overlayWin)return;
  overlayWin.setFocusable(!!v);
  if(v)overlayWin.focus();
});

app.whenReady().then(()=>{
  try{DIAG_LOG=path.join(app.getPath("desktop"),"포챔스_diag.log");   // 세션마다 새로 시작
    fs.writeFileSync(DIAG_LOG,`=== 세션 시작 ${new Date().toISOString()} ===\n`);}catch(e){DIAG_LOG=null;}
  createOverlay();
  createControl();
  globalShortcut.register("Alt+O",()=>{ // 오버레이 표시/숨김
    if(!overlayWin)return;
    overlayWin.isVisible()?overlayWin.hide():overlayWin.show();
  });
  globalShortcut.register("Alt+R",()=>{if(overlayWin)overlayWin.webContents.send("force-recognize");}); // 상대 재인식(새 매치)
});
app.on("will-quit",()=>globalShortcut.unregisterAll());
app.on("window-all-closed",()=>app.quit());
