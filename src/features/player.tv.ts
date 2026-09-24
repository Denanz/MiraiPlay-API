/**
 * TV-режим плеера (приложение для телевизоров Samsung, `?tv=1`).
 *
 * Обычные панели плеера рассчитаны на мышь и тач, поэтому на ТВ они скрыты, а
 * вместо них — своя крупная панель под пульт:
 *   панель скрыта: ←/→ — перемотка ±10 с, OK — пауза/пуск, ↑/↓ — показать панель,
 *                  «Назад» — выйти из плеера;
 *   панель видна:  ←/→ — по кнопкам, OK — нажать, ↓/«Назад» — спрятать;
 *   цифры:         0 — скриншот, 4 — прошлая серия, 5 — +85 с, 6 — следующая серия.
 * Во время опенинга/эндинга (таймкоды Aniskip) всплывает «Пропустить» с фокусом.
 *
 * Код выполняется в Chromium 63 (Tizen 5): только ES2018, без ?. и catch{}.
 * Вставляется внутрь IIFE страницы и пользуется её функциями (togglePlay, seekBy…).
 */

export const TV_CSS = `
    body.tv .overlay, body.tv .m-controls, body.tv .md-shell, body.tv #shot-fab, body.tv #skip-fab,
    body.tv #resume-toast, body.tv .big-play { display: none !important; }
    body.tv .stage { cursor: none; }
    .tv-ui { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 40; pointer-events: none; opacity: 0; transition: opacity 0.25s ease; font-family: Inter, system-ui, sans-serif; }
    .tv-ui.show { opacity: 1; }
    .tv-ui.show .tv-row, .tv-ui.show .tv-top { pointer-events: auto; }
    .tv-shade-top { position: absolute; top: 0; left: 0; right: 0; height: 260px; background: linear-gradient(180deg, rgba(0,0,0,0.8), rgba(0,0,0,0)); }
    .tv-shade-bot { position: absolute; bottom: 0; left: 0; right: 0; height: 420px; background: linear-gradient(0deg, rgba(0,0,0,0.9), rgba(0,0,0,0)); }
    .tv-top { position: absolute; top: 56px; left: 80px; right: 80px; }
    .tv-t { font-size: 44px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tv-s { margin-top: 8px; font-size: 24px; color: rgba(255,255,255,0.7); }
    .tv-bottom { position: absolute; left: 80px; right: 80px; bottom: 56px; }
    .tv-times { display: flex; justify-content: space-between; font-size: 24px; color: rgba(255,255,255,0.85); margin-bottom: 14px; font-variant-numeric: tabular-nums; }
    .tv-bar { position: relative; height: 8px; border-radius: 4px; background: rgba(255,255,255,0.22); }
    .tv-buf, .tv-played { position: absolute; top: 0; left: 0; bottom: 0; border-radius: 4px; }
    .tv-buf { background: rgba(255,255,255,0.35); }
    .tv-played { background: var(--accent); }
    .tv-knob { position: absolute; right: -11px; top: -7px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 4px rgba(196,165,253,0.45); }
    .tv-zone { position: absolute; top: 0; bottom: 0; background: rgba(255,210,120,0.55); }
    .tv-row { display: flex; align-items: center; justify-content: center; margin-top: 34px; }
    .tv-b { display: flex; align-items: center; justify-content: center; height: 72px; min-width: 72px; margin: 0 9px; padding: 0 22px;
      border: 0; border-radius: 36px; background: rgba(255,255,255,0.12); color: #fff; font: 600 22px Inter, system-ui, sans-serif;
      transition: transform 0.15s ease, background 0.15s ease, color 0.15s ease; outline: none; }
    .tv-b svg { width: 34px; height: 34px; fill: currentColor; }
    .tv-b span { margin-left: 10px; }
    .tv-b.big { height: 92px; min-width: 92px; border-radius: 46px; }
    .tv-b.big svg { width: 46px; height: 46px; }
    .tv-b:focus { background: #fff; color: #0b0812; transform: scale(1.1); }
    .tv-b.off { opacity: 0.35; }
    .tv-sep { width: 2px; height: 40px; margin: 0 14px; background: rgba(255,255,255,0.18); }
    .tv-hint { margin-top: 22px; text-align: center; font-size: 19px; color: rgba(255,255,255,0.5); }
    .tv-hint b { display: inline-block; min-width: 30px; margin: 0 6px 0 22px; padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,0.14); color: #fff; font-weight: 700; }
    .tv-skip { position: fixed; right: 80px; bottom: 300px; z-index: 45; display: none; height: 72px; padding: 0 34px; border: 2px solid rgba(255,255,255,0.7);
      border-radius: 14px; background: rgba(0,0,0,0.55); color: #fff; font: 700 26px Inter, system-ui, sans-serif; outline: none; transition: transform 0.15s ease, background 0.15s ease; }
    .tv-skip.show { display: block; }
    .tv-skip:focus { background: #fff; color: #0b0812; border-color: #fff; transform: scale(1.06); }
    .tv-osd { position: fixed; top: 50%; left: 50%; z-index: 44; margin: -60px 0 0 -110px; width: 220px; height: 120px; border-radius: 24px; background: rgba(0,0,0,0.55);
      color: #fff; font: 700 40px Inter, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s ease; pointer-events: none; }
    .tv-osd.show { opacity: 1; }
    .tv-q { position: fixed; right: 80px; bottom: 250px; z-index: 46; display: none; min-width: 280px; padding: 14px; border-radius: 20px; background: rgba(16,12,26,0.97); border: 1px solid rgba(255,255,255,0.12); }
    .tv-q.show { display: block; }
    .tv-q h4 { margin: 6px 12px 12px; font: 600 20px Inter, system-ui, sans-serif; color: rgba(255,255,255,0.6); }
    .tv-q button { display: block; width: 100%; height: 60px; margin: 4px 0; padding: 0 20px; border: 0; border-radius: 12px; background: transparent; color: #fff;
      font: 600 24px Inter, system-ui, sans-serif; text-align: left; outline: none; }
    .tv-q button.on { color: var(--accent); }
    .tv-q button:focus { background: #fff; color: #0b0812; }
`;

const I = {
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
  play: '<svg id="tv-i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg id="tv-i-pause" viewBox="0 0 24 24" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
  hd: '<svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm2-6h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4V9zm1.5 4.5h2v-3h-2v3z"/></svg>',
  shot: '<svg viewBox="0 0 24 24"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2L7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9z"/></svg>',
};

export function tvHtml(title: string, subtitle: string): string {
  return `
  <div class="tv-ui" id="tv-ui">
    <div class="tv-shade-top"></div><div class="tv-shade-bot"></div>
    <div class="tv-top"><div class="tv-t">${title}</div>${subtitle ? `<div class="tv-s">${subtitle}</div>` : ''}</div>
    <div class="tv-bottom">
      <div class="tv-times"><span id="tv-cur">0:00</span><span id="tv-dur">0:00</span></div>
      <div class="tv-bar" id="tv-bar"><div class="tv-buf" id="tv-buf"></div><div class="tv-played" id="tv-played"><div class="tv-knob"></div></div></div>
      <div class="tv-row" id="tv-row">
        <button class="tv-b" id="tv-prev" type="button">${I.prev}</button>
        <button class="tv-b" id="tv-back" type="button">${I.back}<span>10</span></button>
        <button class="tv-b big" id="tv-play" type="button">${I.play}</button>
        <button class="tv-b" id="tv-fwd" type="button">${I.fwd}<span>10</span></button>
        <button class="tv-b" id="tv-85" type="button">+85</button>
        <button class="tv-b" id="tv-next" type="button">${I.next}</button>
        <div class="tv-sep"></div>
        <button class="tv-b" id="tv-quality" type="button">${I.hd}<span id="tv-qlabel"></span></button>
        <button class="tv-b" id="tv-shot" type="button">${I.shot}</button>
      </div>
      <div class="tv-hint"><b>4</b>прошлая серия<b>5</b>+85 с<b>6</b>следующая серия<b>0</b>скриншот</div>
    </div>
  </div>
  <button class="tv-skip" id="tv-skip" type="button"></button>
  <div class="tv-osd" id="tv-osd"></div>
  <div class="tv-q" id="tv-q"><h4>Качество</h4><div id="tv-qlist"></div></div>`;
}

export const TV_JS = `
      // ── TV-режим: управление пультом (см. src/features/player.tv.ts) ──
      (function(){
        document.body.classList.add("tv");
        var ui=document.getElementById("tv-ui"),row=document.getElementById("tv-row"),skipBtn=document.getElementById("tv-skip"),
            osd=document.getElementById("tv-osd"),qBox=document.getElementById("tv-q"),qList=document.getElementById("tv-qlist"),
            tCur=document.getElementById("tv-cur"),tDur=document.getElementById("tv-dur"),tPlayed=document.getElementById("tv-played"),
            tBuf=document.getElementById("tv-buf"),tBar=document.getElementById("tv-bar"),
            bPrev=document.getElementById("tv-prev"),bNext=document.getElementById("tv-next"),bShot=document.getElementById("tv-shot"),
            iPlay=document.getElementById("tv-i-play"),iPause=document.getElementById("tv-i-pause"),qLabel=document.getElementById("tv-qlabel");
        var hideT=null,osdT=null,skipShown=false,skipDismissedAt=-1;
        var K={LEFT:37,UP:38,RIGHT:39,DOWN:40,OK:13,BACK:10009,PLAYPAUSE:10252,PLAY:415,PAUSE:19,STOP:413,REW:412,FF:417,CHUP:427,CHDOWN:428};

        function buttons(){return Array.prototype.filter.call(row.querySelectorAll(".tv-b"),function(b){return b.style.display!=="none";});}
        function uiShown(){return ui.classList.contains("show");}
        function armHide(){if(hideT)clearTimeout(hideT);hideT=setTimeout(function(){if(!video.paused&&!qBox.classList.contains("show"))hideUi();},5000);}
        function showUi(focusEl){ui.classList.add("show");render();var el=focusEl||document.getElementById("tv-play");if(el&&document.activeElement!==el)el.focus();armHide();}
        function hideUi(){ui.classList.remove("show");closeQ();if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();if(skipShown)skipBtn.focus();}
        function flash(text){osd.textContent=text;osd.classList.add("show");if(osdT)clearTimeout(osdT);osdT=setTimeout(function(){osd.classList.remove("show");},900);}
        function pctOf(t,d){return d?Math.max(0,Math.min(100,t/d*100)):0;}
        function render(){
          var d=(!isNaN(video.duration)&&video.duration)?video.duration:0,t=video.currentTime||0;
          tCur.textContent=fmt(t);tDur.textContent=d?fmt(d):"0:00";tPlayed.style.width=pctOf(t,d)+"%";
          var b=0;try{if(video.buffered.length)b=video.buffered.end(video.buffered.length-1);}catch(e){}
          tBuf.style.width=pctOf(b,d)+"%";
          iPlay.style.display=video.paused?"block":"none";iPause.style.display=video.paused?"none":"block";
          bPrev.classList.toggle("off",!hasPrev);bNext.classList.toggle("off",!hasNext);
          bShot.style.display=CONFIG.screenshotEnabled?"":"none";
          qLabel.textContent=currentLabel||"";
          document.getElementById("tv-quality").style.display=CONFIG.qualities.length>1?"":"none";
          renderZones(d);
        }
        var zonesFor=-1;
        function renderZones(d){
          if(!d||zonesFor===skipIntervals.length)return;zonesFor=skipIntervals.length;
          Array.prototype.forEach.call(tBar.querySelectorAll(".tv-zone"),function(z){z.parentNode.removeChild(z);});
          skipIntervals.forEach(function(iv){if(iv.type==="recap")return;var z=document.createElement("div");z.className="tv-zone";z.style.left=pctOf(iv.start,d)+"%";z.style.width=pctOf(iv.end-iv.start,d)+"%";tBar.insertBefore(z,tPlayed);});
        }

        // «Пропустить опенинг/эндинг» — как у Netflix: всплывает с фокусом на время интервала.
        function currentSkip(){var t=video.currentTime||0;for(var i=0;i<skipIntervals.length;i++){var iv=skipIntervals[i];if(iv.type!=="recap"&&t>=iv.start-1&&t<iv.end-2)return iv;}return null;}
        function checkSkip(){
          var iv=currentSkip();
          var want=!!iv&&skipDismissedAt!==iv.start;
          if(want&&!skipShown){skipShown=true;skipBtn.textContent=iv.type==="op"?"Пропустить опенинг":"Пропустить эндинг";skipBtn.classList.add("show");if(!uiShown())skipBtn.focus();}
          else if(!want&&skipShown){skipShown=false;skipBtn.classList.remove("show");if(document.activeElement===skipBtn)skipBtn.blur();}
        }
        function doSkip(){var iv=currentSkip();if(iv){video.currentTime=iv.end;flash("⏭");}skipShown=false;skipBtn.classList.remove("show");skipBtn.blur();}
        skipBtn.addEventListener("click",doSkip);

        function prevEp(){if(hasPrev){flash("⏮");playerMsg("prev");}else flash("Это первая серия");}
        function nextEp(){if(hasNext){flash("⏭");playerMsg("next");}else flash("Это последняя серия");}
        function plus85(){seekBy(85);flash("+85 с");}
        function shot(){if(!CONFIG.screenshotEnabled){flash("Скриншоты — после входа");return;}if(typeof captureScreenshot==="function")captureScreenshot();flash("📸");}
        function playPause(){togglePlay();setTimeout(render,50);flash(video.paused?"▶":"⏸");}

        function openQ(){
          qList.innerHTML="";
          CONFIG.qualities.forEach(function(q){var b=document.createElement("button");b.type="button";b.textContent=q.label;if(q.label===currentLabel)b.className="on";
            b.addEventListener("click",function(){selectQuality(q.label);closeQ();showUi(document.getElementById("tv-quality"));});qList.appendChild(b);});
          qBox.classList.add("show");var on=qList.querySelector(".on")||qList.querySelector("button");if(on)on.focus();
          if(hideT)clearTimeout(hideT);
        }
        function closeQ(){qBox.classList.remove("show");}

        document.getElementById("tv-play").addEventListener("click",playPause);
        document.getElementById("tv-back").addEventListener("click",function(){seekBy(-10);render();});
        document.getElementById("tv-fwd").addEventListener("click",function(){seekBy(10);render();});
        document.getElementById("tv-85").addEventListener("click",function(){plus85();render();});
        bPrev.addEventListener("click",prevEp);
        bNext.addEventListener("click",nextEp);
        document.getElementById("tv-quality").addEventListener("click",openQ);
        bShot.addEventListener("click",shot);

        video.addEventListener("timeupdate",function(){checkSkip();if(uiShown())render();});
        video.addEventListener("play",function(){render();armHide();});
        video.addEventListener("pause",function(){render();showUi(uiShown()?document.activeElement:null);});

        function moveInRow(dir){
          var list=buttons(),i=list.indexOf(document.activeElement);
          if(i<0){(list[0]).focus();return;}
          var n=list[Math.max(0,Math.min(list.length-1,i+dir))];if(n)n.focus();
        }
        function moveInQ(dir){
          var list=Array.prototype.slice.call(qList.querySelectorAll("button")),i=list.indexOf(document.activeElement);
          var n=list[Math.max(0,Math.min(list.length-1,i+dir))];if(n)n.focus();
        }

        window.addEventListener("keydown",function(e){
          var c=e.keyCode,handled=true;
          // Цифры — всегда свои (обычный плеер прыгал бы по ним на 10%…90%).
          if(c>=48&&c<=57){
            if(c===48)shot();else if(c===52)prevEp();else if(c===53)plus85();else if(c===54)nextEp();
            if(uiShown()){render();armHide();}
          }
          else if(c===K.PLAYPAUSE)playPause();
          else if(c===K.PLAY){if(video.paused)playPause();}
          else if(c===K.PAUSE){if(!video.paused)playPause();}
          else if(c===K.STOP)playerMsg("back");
          else if(c===K.REW){seekBy(-10);flash("−10 с");}
          else if(c===K.FF){seekBy(10);flash("+10 с");}
          else if(c===K.CHUP)nextEp();
          else if(c===K.CHDOWN)prevEp();
          else if(qBox.classList.contains("show")){
            if(c===K.UP)moveInQ(-1);else if(c===K.DOWN)moveInQ(1);
            else if(c===K.OK){if(document.activeElement&&document.activeElement.click)document.activeElement.click();}
            else if(c===K.BACK||c===K.LEFT){closeQ();showUi(document.getElementById("tv-quality"));}
            else handled=false;
          }
          else if(document.activeElement===skipBtn&&!uiShown()){
            if(c===K.OK)doSkip();
            else if(c===K.BACK){skipDismissedAt=(currentSkip()||{start:-1}).start;skipShown=false;skipBtn.classList.remove("show");skipBtn.blur();}
            else if(c===K.LEFT){seekBy(-10);flash("−10 с");}
            else if(c===K.RIGHT){seekBy(10);flash("+10 с");}
            else if(c===K.UP||c===K.DOWN)showUi();
            else handled=false;
          }
          else if(uiShown()){
            if(c===K.LEFT)moveInRow(-1);else if(c===K.RIGHT)moveInRow(1);
            else if(c===K.OK){if(document.activeElement&&document.activeElement.click)document.activeElement.click();}
            else if(c===K.UP){if(skipShown)skipBtn.focus();}
            else if(c===K.DOWN||c===K.BACK)hideUi();
            else handled=false;
            if(handled&&uiShown())armHide();
          }
          else{
            if(c===K.LEFT){seekBy(-10);flash("−10 с");}
            else if(c===K.RIGHT){seekBy(10);flash("+10 с");}
            else if(c===K.OK){playPause();showUi();}
            else if(c===K.UP||c===K.DOWN)showUi();
            else if(c===K.BACK)playerMsg("back");
            else handled=false;
          }
          if(handled){e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();}
        },true);

        render();
        showUi();
      })();
`;
