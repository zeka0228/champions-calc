// main.js — Electron 메인 프로세스: 창 선택형 캡처 + 투명 오버레이 + 전역 핫키
const {app,BrowserWindow,ipcMain,desktopCapturer,globalShortcut,screen}=require("electron");
const path=require("path");

let overlayWin=null,controlWin=null;
let interactive=false;

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
ipcMain.on("to-control",(e,ch,payload)=>{if(controlWin)controlWin.webContents.send(ch,payload);});

// 오버레이 상호작용 토글 (패널 드래그/조작할 때만 클릭 통과 해제)
function setInteractive(v){
  interactive=v;
  if(!overlayWin)return;
  overlayWin.setIgnoreMouseEvents(!v,{forward:true});
  overlayWin.setFocusable(v);
  overlayWin.webContents.send("interactive",v);
}
ipcMain.on("set-interactive",(e,v)=>setInteractive(v));

app.whenReady().then(()=>{
  createOverlay();
  createControl();
  globalShortcut.register("Alt+O",()=>{ // 오버레이 표시/숨김
    if(!overlayWin)return;
    overlayWin.isVisible()?overlayWin.hide():overlayWin.show();
  });
  globalShortcut.register("Alt+I",()=>setInteractive(!interactive)); // 조작 모드 토글
  globalShortcut.register("Alt+R",()=>{if(overlayWin)overlayWin.webContents.send("force-recognize");}); // 강제 재인식
});
app.on("will-quit",()=>globalShortcut.unregisterAll());
app.on("window-all-closed",()=>app.quit());
