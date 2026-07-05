/**
 * Server-rendered HTML5 player page. Independent implementation covering the
 * same capabilities as the legacy player: HLS playback, quality switching,
 * resume/progress sync, screenshot capture and the Watch Together postMessage
 * bridge. The `__wt:*` message envelope is kept compatible with the React host.
 *
 * The control panel reproduces the author's original AnixartEX design (the
 * frosted "pill" controls, custom quality dropdown, dedicated mobile UI,
 * hotkeys modal, cast button, saved-position marker, tap-seek ripple), with
 * three additions folded in: playback speed, persisted preferences and a
 * crossOrigin screenshot fix.
 */

export interface PlayerPageData {
  qualities: Array<{ label: string; url: string }>;
  defaultLabel: string;
  isHls: boolean;
  title: string;
  subtitle: string;
  progressKey: string;
  resumeTime: number;
  releaseId: string | number;
  sourceId: string | number;
  episodePosition: string | number;
  token?: string;
  gatewayKey?: string;
  malId?: number;
  design?: 'legacy' | 'modern';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildPlayerPage(data: PlayerPageData): string {
  const config = JSON.stringify({
    qualities: data.qualities,
    defaultLabel: data.defaultLabel,
    isHls: data.isHls,
    progressKey: data.progressKey,
    resumeTime: data.resumeTime,
    releaseId: data.releaseId,
    sourceId: data.sourceId,
    episodePosition: data.episodePosition,
    token: data.token || null,
    screenshotEnabled: Boolean(data.token), // gallery save is keyed by the user's token
    gatewayKey: data.gatewayKey || null,
    malId: data.malId ?? null,
    design: data.design === 'modern' ? 'modern' : 'legacy',
  });
  const safeTitle = escapeHtml(data.title);
  const safeSub = escapeHtml(data.subtitle || '');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  <meta name="referrer" content="no-referrer" />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07060b; --bg-glow: #1a1030; --accent: #c4a5fd; --accent-strong: #a78bfa;
      --accent-dim: #6d4f9e; --text: #f5f0ff; --muted: #9b92ad;
      --border: rgba(255,255,255,0.08); --panel: rgba(10,8,18,0.92); --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; background: var(--bg); overflow: hidden; }
    body { font-family: "Inter", "Segoe UI", system-ui, sans-serif; color: var(--text); }
    .stage { position: fixed; inset: 0; background: #000; cursor: none; }
    .stage.cursor-visible { cursor: default; }
    /* Hidden until the first frame decodes — avoids Android WebView's grey
       "play button" placeholder for an as-yet-empty <video>. */
    video { width: 100%; height: 100%; display: block; object-fit: contain; opacity: 0; transition: opacity 0.2s ease; }
    video.ready { opacity: 1; }
    .overlay { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 0.25s ease; z-index: 10; }
    .overlay.visible { opacity: 1; pointer-events: auto; }
    /* Modern skin doesn't use the legacy overlay for interaction — shared code (video play/pause,
       keydown, etc.) still toggles .visible on it, and its z-index (10) sits above .md-shell (6),
       so left alone it would swallow every click across the whole viewport. */
    body.modern .overlay { pointer-events: none !important; opacity: 0 !important; }
    .controls { position: absolute; bottom: 0; left: 0; right: 0; padding: 0 20px 28px; display: flex; flex-direction: column; align-items: center; }
    .progress-wrap { width: 100%; height: 16px; display: flex; align-items: center; cursor: pointer; }
    .progress-track { position: relative; width: 100%; height: 3px; border-radius: 999px; background: rgba(255,255,255,0.14); transition: height 0.15s ease; }
    .progress-wrap:hover .progress-track { height: 5px; }
    .progress-buffer, .progress-played { position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit; }
    .progress-buffer { background: rgba(255,255,255,0.16); z-index: 1; }
    .progress-played { background: linear-gradient(90deg, var(--accent-dim), var(--accent)); box-shadow: 0 0 12px rgba(196,165,253,0.35); z-index: 2; }
    .progress-saved { position: absolute; top: 50%; width: 2px; height: 8px; margin-top: -4px; background: rgba(255,255,255,0.5); border-radius: 2px; z-index: 3; transform: translateX(-50%); display: none; }
    .progress-saved.visible { display: block; }
    .progress-thumb { position: absolute; top: 50%; width: 12px; height: 12px; margin-top: -6px; background: #fff; border-radius: 50%; transform: translateX(-50%) scale(0); transition: transform 0.15s cubic-bezier(.34,1.4,.64,1); z-index: 4; box-shadow: 0 0 0 3px rgba(196,165,253,0.3), 0 2px 8px rgba(0,0,0,0.4); }
    .progress-wrap:hover .progress-thumb { transform: translateX(-50%) scale(1); }
    .pill-wrap { display: flex; flex-direction: column; align-items: stretch; background: linear-gradient(180deg, rgba(17,13,27,0.86), rgba(10,8,17,0.86)); backdrop-filter: blur(24px) saturate(1.6); -webkit-backdrop-filter: blur(24px) saturate(1.6); border: 1px solid rgba(255,255,255,0.09); border-radius: 22px; padding: 9px 15px 7px; box-shadow: 0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06); gap: 4px; transition: border-color 0.2s; }
    .pill-wrap:hover { border-color: rgba(196,165,253,0.22); }
    .ctrl-row { display: flex; align-items: center; gap: 2px; }
    .ctrl-divider { width: 1px; height: 18px; background: rgba(255,255,255,0.08); margin: 0 4px; flex-shrink: 0; }
    .btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 0; border-radius: 999px; background: transparent; color: rgba(255,255,255,0.85); cursor: pointer; transition: background 0.15s, color 0.15s, transform 0.1s; flex-shrink: 0; }
    .btn:hover { background: rgba(196,165,253,0.14); color: #fff; }
    .btn:active { transform: scale(0.92); }
    .btn svg { width: 18px; height: 18px; fill: currentColor; }
    .skip-btn { width: auto; padding: 0 11px; font-size: 0.72rem; font-weight: 600; color: var(--accent); border: 1px solid rgba(167,139,250,0.32); border-radius: 999px; height: 28px; background: rgba(167,139,250,0.06); }
    .skip-btn:hover { background: rgba(167,139,250,0.16); border-color: var(--accent); color: var(--accent); }
    .time { font-size: 0.78rem; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.7); padding: 0 6px; white-space: nowrap; }
    .time .dim { color: var(--muted); }
    .vol-wrap { display: flex; align-items: center; gap: 2px; }
    .vol-wrap input[type=range] { width: 0; opacity: 0; transition: width 0.2s, opacity 0.2s; accent-color: var(--accent); cursor: pointer; }
    .vol-wrap:hover input[type=range], .vol-wrap:focus-within input[type=range] { width: 64px; opacity: 1; }
    .quality-wrap { position: relative; }
    .quality-btn { width: auto; padding: 0 11px; font-size: 0.72rem; font-weight: 600; height: 28px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); gap: 4px; background: rgba(255,255,255,0.03); }
    .quality-btn:hover { color: var(--text); border-color: var(--accent-dim); background: rgba(255,255,255,0.06); }
    .quality-dropdown { position: absolute; bottom: calc(100% + 8px); right: 0; background: rgba(15,12,23,0.97); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 6px; display: none; flex-direction: column; gap: 2px; min-width: 90px; backdrop-filter: blur(16px) saturate(1.4); box-shadow: 0 16px 40px rgba(0,0,0,0.5); z-index: 20; }
    .quality-dropdown.open { display: flex; animation: pop-in 0.14s ease both; }
    @keyframes pop-in { from { opacity: 0; transform: translateY(4px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
    .quality-option { padding: 7px 12px; border-radius: 9px; font-size: 0.78rem; cursor: pointer; color: var(--muted); transition: background 0.12s, color 0.12s; border: 0; background: transparent; text-align: left; width: 100%; }
    .quality-option:hover { background: rgba(196,165,253,0.1); color: var(--text); }
    .quality-option.active { color: var(--accent); font-weight: 600; }
    .hk-modal { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; z-index: 50; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); }
    .hk-modal.open { display: flex; }
    .hk-box { background: rgba(14,11,22,0.98); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px 28px; min-width: 280px; }
    .hk-box h2 { font-size: 0.88rem; font-weight: 600; color: var(--accent); margin-bottom: 16px; letter-spacing: 0.04em; text-transform: uppercase; }
    .hk-row { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 0.82rem; }
    .hk-row:last-child { border-bottom: 0; }
    .hk-row .label { color: var(--muted); }
    .hk-keys { display: flex; gap: 4px; }
    kbd { display: inline-block; padding: 2px 7px; border-radius: 5px; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); color: var(--text); font-family: inherit; font-size: 0.75rem; }
    .loader { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; z-index: 5; pointer-events: none; }
    .loader.visible { display: flex; }
    .spinner { width: 40px; height: 40px; border: 2px solid rgba(255,255,255,0.08); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .big-play { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; z-index: 6; cursor: pointer; border: 0; background: transparent; }
    .big-play.visible { display: flex; }
    .big-play svg { width: 64px; height: 64px; fill: rgba(255,255,255,0.9); filter: drop-shadow(0 4px 20px rgba(0,0,0,0.6)); transition: transform 0.15s; }
    .big-play:hover svg { transform: scale(1.06); }
    .toast { position: fixed; left: 20px; bottom: 90px; display: none; gap: 10px; align-items: center; padding: 10px 14px; border-radius: 10px; background: var(--panel); border: 1px solid var(--border); font-size: 0.82rem; z-index: 15; animation: slide-up 0.25s ease; }
    @keyframes slide-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .toast.visible { display: flex; }
    .toast .t-btn { border: 0; background: var(--accent-strong); color: #130d1c; padding: 5px 11px; border-radius: 7px; font-weight: 600; font-size: 0.78rem; cursor: pointer; }
    .toast .t-skip { background: transparent; color: var(--muted); font-weight: 500; border: 0; cursor: pointer; font-size: 0.78rem; }
    .saved-badge { position: fixed; right: 20px; bottom: 90px; font-size: 0.72rem; color: var(--accent); opacity: 0; transition: opacity 0.3s; z-index: 15; pointer-events: none; }
    .saved-badge.visible { opacity: 1; }
    .error-panel { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; color: #f5b0b0; background: rgba(0,0,0,0.6); z-index: 8; font-size: 0.9rem; }
    .error-panel.visible { display: flex; }

    /* ── Floating skip button (sits bottom-right; shown only while the control
          panel is up — visibility driven by reflectSkip() in JS) ── */
    #skip-fab {
      position: fixed;
      right: calc(16px + env(safe-area-inset-right, 0px));
      bottom: calc(76px + env(safe-area-inset-bottom, 0px));
      z-index: 14; display: none; align-items: center; gap: 6px;
      height: 40px; padding: 0 18px; border-radius: 999px; cursor: pointer;
      background: linear-gradient(180deg, rgba(17,13,27,0.86), rgba(10,8,17,0.86)); backdrop-filter: blur(16px) saturate(1.5); -webkit-backdrop-filter: blur(16px) saturate(1.5);
      border: 1px solid rgba(167,139,250,0.4); color: var(--accent);
      font-size: 0.82rem; font-weight: 700; white-space: nowrap;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05); -webkit-tap-highlight-color: transparent;
      transition: background 0.15s, border-color 0.15s;
    }
    #skip-fab.show { display: inline-flex; }
    #skip-fab:hover { border-color: var(--accent); }
    #skip-fab:active { background: rgba(167,139,250,0.18); }

    /* ── Autoplay-next countdown card (Netflix-style, bottom-right) ── */
    #autonext { position: fixed; right: calc(20px + env(safe-area-inset-right,0)); bottom: calc(84px + env(safe-area-inset-bottom,0));
      z-index: 22; display: none; flex-direction: column; gap: 9px; min-width: 210px; max-width: calc(100vw - 40px);
      background: linear-gradient(180deg, rgba(18,14,28,0.94), rgba(11,9,19,0.94)); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 13px 15px;
      backdrop-filter: blur(16px) saturate(1.5); -webkit-backdrop-filter: blur(16px) saturate(1.5); box-shadow: 0 14px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05); }
    #autonext.show { display: flex; }
    #autonext .an-t { font-size: 0.76rem; color: rgba(255,255,255,0.6); }
    #autonext .an-c { font-size: 0.92rem; font-weight: 700; color: #fff; margin-top: -2px; }
    #autonext .an-c b { color: var(--accent); font-variant-numeric: tabular-nums; }
    #autonext .an-row { display: flex; gap: 8px; margin-top: 3px; }
    #autonext button { flex: 1; padding: 9px; border-radius: 9px; border: 0; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
    #an-now { background: var(--accent-strong); color: #130d1c; }
    #an-cancel { background: rgba(255,255,255,0.1); color: #fff; }

    /* ── Brightness dimmer + gesture indicator (mobile swipe) ── */
    #dimmer { position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none; z-index: 4; }
    #g-ind { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%); z-index: 23; display: none;
      align-items: center; gap: 11px; padding: 11px 16px; border-radius: 12px; background: rgba(0,0,0,0.62);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); pointer-events: none; }
    #g-ind.show { display: flex; }
    #g-ind svg { width: 22px; height: 22px; fill: #fff; }
    #g-ind .g-bar { width: 100px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.25); overflow: hidden; }
    #g-ind .g-bar > i { display: block; height: 100%; background: #fff; width: 0; }

    /* ── Top overlay: episode meta + immersive nav (back / next / together). The
          desktop control "pill" is untouched; this only lives in the top strip. ── */
    .player-title {
      position: absolute; top: 0; left: 0; right: 0; z-index: 3; pointer-events: none;
      display: flex; align-items: flex-start; gap: 10px;
      padding: calc(12px + env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) 34px calc(12px + env(safe-area-inset-left, 0px));
      background: linear-gradient(to bottom, rgba(0,0,0,0.5), transparent);
    }
    .player-title > * { pointer-events: auto; }
    .pt-back { width: 38px; height: 38px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
      background: rgba(15,12,23,0.65); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4);
      color: rgba(255,255,255,0.9); border-radius: 999px; cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s; }
    .pt-back:hover { background: rgba(196,165,253,0.16); color: #fff; border-color: rgba(196,165,253,0.3); }
    .pt-back svg { width: 20px; height: 20px; fill: currentColor; }
    .pt-meta { flex: 1; min-width: 0; padding-top: 5px; }
    .player-title .pt-name {
      font-size: 0.95rem; font-weight: 600; color: #fff; line-height: 1.25;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 4px rgba(0,0,0,0.5);
    }
    .player-title .pt-sub {
      font-size: 0.74rem; font-weight: 600; color: var(--accent); margin-top: 3px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pt-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .pt-act { height: 34px; padding: 0 13px; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      background: rgba(15,12,23,0.65); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4);
      color: rgba(255,255,255,0.85); font-size: 0.78rem; font-weight: 600; white-space: nowrap; font-family: inherit;
      transition: background 0.15s, color 0.15s, border-color 0.15s; }
    .pt-act:hover { background: rgba(196,165,253,0.16); color: #fff; border-color: rgba(196,165,253,0.3); }
    .pt-act.accent { color: var(--accent); border-color: rgba(167,139,250,0.4); }
    .pt-act[hidden] { display: none; }

    /* ── Mobile / touch ── */
    @media (hover: none), (max-width: 640px) {
      .stage { cursor: default !important; }
      .controls { padding: 0 8px calc(12px + env(safe-area-inset-bottom)); }
      .pill-wrap { width: 100%; border-radius: 16px; padding: 6px 6px 4px; gap: 2px; }
      .ctrl-row { gap: 0; justify-content: space-between; }
      .btn { width: 46px; height: 46px; }
      .btn svg { width: 23px; height: 23px; }
      .progress-wrap { height: 28px; }
      .progress-track { height: 4px; }
      .progress-thumb { width: 15px; height: 15px; margin-top: -7.5px; transform: translateX(-50%) scale(1); }
      .progress-wrap:hover .progress-track { height: 4px; }
      .vol-wrap, #btn-hk, .ctrl-divider, #btn-skip-op, #btn-skip85, #speed-wrap { display: none !important; }
      .time { font-size: 0.74rem; padding: 0 4px; }
      .quality-btn { height: 32px; font-size: 0.74rem; }
      .big-play svg { width: 76px; height: 76px; }
      .toast { left: 12px; right: 12px; bottom: 84px; font-size: 0.8rem; }
      .saved-badge { bottom: 84px; }
      .hk-box { min-width: 0; width: calc(100% - 40px); }
    }
    /* Tap-seek ripple feedback */
    .tap-fx { position: fixed; top: 50%; width: 64px; height: 64px; margin-top: -32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; color: #fff; font-size: 0.8rem; font-weight: 600;
      background: rgba(167,139,250,0.22); opacity: 0; pointer-events: none; z-index: 12; transition: opacity 0.4s; }
    .tap-fx.show { opacity: 1; }
    .tap-fx svg { width: 30px; height: 30px; fill: #fff; }

    /* ── Dedicated mobile player UI (immersive, matches the native-app design) ── */
    .m-controls { display: none; position: absolute; inset: 0; flex-direction: column; justify-content: space-between; pointer-events: none; }
    body.mobile .controls { display: none; }
    body.mobile .player-title { display: none; }
    body.mobile #big-play { display: none; }
    body.mobile .m-controls { display: flex; }
    .m-controls > * { pointer-events: auto; }
    .m-icon { width: 40px; height: 40px; border: 0; background: transparent; color: #fff; display: inline-flex; align-items: center;
      justify-content: center; position: relative; flex-shrink: 0; -webkit-tap-highlight-color: transparent; cursor: pointer; }
    .m-icon svg { width: 23px; height: 23px; fill: #fff; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.65)); }
    .m-icon:disabled { opacity: 0.32; }
    /* top row: back · title/sub · quality · HW · sparkle · settings */
    .m-top { display: flex; align-items: flex-start; gap: 4px;
      padding: calc(12px + env(safe-area-inset-top,0)) calc(18px + env(safe-area-inset-right,0)) 14px calc(18px + env(safe-area-inset-left,0));
      background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent); }
    .m-titlewrap { flex: 1; min-width: 0; padding: 9px 6px 0; }
    .m-title { font-size: 1rem; font-weight: 600; color: #fff; line-height: 1.2; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; text-shadow: 0 1px 4px rgba(0,0,0,0.6); }
    .m-sub { display: block; margin-top: 3px; color: rgba(255,255,255,0.68); font-size: 0.78rem; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .m-top-right { display: flex; align-items: center; gap: 2px; padding-top: 2px; }
    .m-tbtn { background: transparent; border: 0; color: #fff; font-size: 0.9rem; font-weight: 700; padding: 10px 6px;
      -webkit-tap-highlight-color: transparent; cursor: pointer; text-shadow: 0 1px 3px rgba(0,0,0,0.65); white-space: nowrap; }
    .m-badge { color: #fff; font-size: 0.9rem; font-weight: 700; padding: 10px 6px; opacity: 0.9; letter-spacing: 0.02em;
      text-shadow: 0 1px 3px rgba(0,0,0,0.65); }
    /* center: prev episode · play · next episode */
    /* Absolutely centered so the play/pause button lands in the true geometric
       centre of the video — i.e. inside the loading spinner (which is also
       inset:0 centred). Keeping it in the flex flow pushed it above centre
       because the bottom bar+scrubber are taller than the top bar. */
    .m-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 52px; pointer-events: none; }
    .m-center > * { pointer-events: auto; }
    /* Bar + scrubber grouped so the column pins them to the bottom edge while
       .m-center floats free at true centre. */
    .m-bottom { display: flex; flex-direction: column; }
    .m-bigplay { width: 64px; height: 64px; border-radius: 50%; background: transparent; border: 0; color: #fff;
      display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; cursor: pointer; }
    .m-bigplay svg { width: 42px; height: 42px; fill: #fff; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.6)); }
    .m-cbtn { width: 52px; height: 52px; border-radius: 50%; background: transparent; border: 0; color: #fff;
      display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; cursor: pointer; }
    .m-cbtn svg { width: 30px; height: 30px; fill: #fff; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.6)); }
    .m-cbtn:disabled { opacity: 0.3; }
    /* bottom icon row: lock · rotate · speed  ···  skip · pip · fullscreen */
    .m-bar { display: flex; align-items: center; justify-content: space-between;
      padding: 0 calc(20px + env(safe-area-inset-right,0)) 0 calc(20px + env(safe-area-inset-left,0)); }
    .m-bar-left, .m-bar-right { display: flex; align-items: center; gap: 4px; }
    .m-speed-lbl { position: absolute; right: 2px; bottom: 4px; font-size: 0.5rem; font-weight: 800; color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,0.7); }
    /* On-screen speed/quality removed — they live only in the settings sheet (⚙). */
    #m-quality-btn, #m-speed-btn { display: none !important; }
    .m-tag { position: absolute; right: -3px; bottom: 1px; font-size: 0.55rem; font-weight: 800; color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,0.85); pointer-events: none; letter-spacing: -0.02em; }
    /* scrubber row (full width) */
    .m-scrub { display: flex; align-items: center; gap: 12px;
      padding: 2px calc(18px + env(safe-area-inset-right,0)) calc(14px + env(safe-area-inset-bottom,0)) calc(18px + env(safe-area-inset-left,0));
      background: linear-gradient(to top, rgba(0,0,0,0.6), transparent); }
    .m-time { font-size: 0.82rem; color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: 0.95;
      text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
    .m-progress { flex: 1; height: 30px; }
    .m-progress .progress-track { height: 3px; background: rgba(255,255,255,0.3); }
    .m-progress .progress-buffer { background: rgba(255,255,255,0.35); }
    .m-progress .progress-played { background: #fff; }
    .m-progress .progress-thumb { transform: translateX(-50%) scale(1); width: 14px; height: 14px; margin-top: -7px;
      background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.25); }
    /* lock mode: hide everything but the unlock button */
    #m-unlock { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 56px; height: 56px; border-radius: 50%;
      background: rgba(0,0,0,0.55); border: 0; color: #fff; display: none; align-items: center; justify-content: center; z-index: 30;
      opacity: 0; transition: opacity 0.2s; -webkit-tap-highlight-color: transparent; cursor: pointer; }
    #m-unlock svg { width: 26px; height: 26px; fill: #fff; }
    body.mobile.locked .m-top, body.mobile.locked .m-center, body.mobile.locked .m-bar,
    body.mobile.locked .m-scrub, body.mobile.locked .m-sheet { display: none !important; }
    /* While locked, keep the overlay layer painted (opacity 1) but click-through,
       so the unlock button can show. It reveals on tap and auto-hides. */
    body.mobile.locked .overlay { opacity: 1; pointer-events: none; }
    body.mobile.locked #m-unlock { display: flex; pointer-events: none; }
    body.mobile.locked.unlock-peek #m-unlock { opacity: 1; pointer-events: auto; }
    /* settings bottom-sheet (quality · speed · actions) */
    .m-sheet { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(14,11,22,0.98); border-top: 1px solid var(--border);
      border-radius: 18px 18px 0 0; padding: 14px 12px calc(20px + env(safe-area-inset-bottom,0)); display: none; flex-direction: column; gap: 2px;
      z-index: 25; max-height: 78%; overflow-y: auto; }
    .m-sheet.open { display: flex; }
    .m-sheet h3 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 10px 12px 8px; }
    .m-sheet h3:first-child { padding-top: 4px; }
    .m-sheet .quality-option { padding: 13px 14px; font-size: 0.92rem; border-radius: 10px; }
    .m-sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 6px 4px; }
    .m-sheet-actions button { flex: 1 1 40%; min-width: 130px; background: rgba(255,255,255,0.06); border: 1px solid var(--border);
      color: var(--text); border-radius: 12px; padding: 13px; font-size: 0.88rem; font-weight: 600; cursor: pointer;
      -webkit-tap-highlight-color: transparent; }
    .m-sheet-actions button:active { background: rgba(255,255,255,0.12); }

    /* ── Episode rating ── */
    .rate-modal { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; z-index: 55; background: rgba(0,0,0,0.72); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
    .rate-modal.open { display: flex; }
    .rate-box { background: rgba(14,11,22,0.98); border: 1px solid var(--border); border-radius: 18px; padding: 26px 30px; display: flex; flex-direction: column; align-items: center; gap: 16px; min-width: 300px; max-width: calc(100% - 40px); box-shadow: 0 24px 60px rgba(0,0,0,0.6); }
    .rate-box h2 { font-size: 0.95rem; font-weight: 600; text-align: center; color: var(--text); }
    .rate-box .ep { font-size: 0.76rem; color: var(--muted); text-align: center; margin-top: -8px; max-width: 280px; }
    .rate-stars { display: flex; gap: 5px; }
    .rate-star { font-size: 1.9rem; line-height: 1; cursor: pointer; color: rgba(255,255,255,0.18); transition: transform 0.1s, color 0.1s; user-select: none; -webkit-tap-highlight-color: transparent; }
    .rate-star.lit { color: var(--accent); }
    .rate-star:hover, .rate-star.hover { transform: scale(1.15); }
    .rate-val { font-size: 1.4rem; font-weight: 700; color: var(--accent); min-width: 2ch; text-align: center; }
    .rate-actions { display: flex; gap: 8px; width: 100%; }
    .rate-actions button { flex: 1; padding: 10px; border-radius: 10px; border: 0; font-size: 0.84rem; font-weight: 600; cursor: pointer; }
    #rate-save { background: var(--accent-strong); color: #130d1c; }
    #rate-save:disabled { opacity: 0.5; cursor: default; }
    #rate-close { background: rgba(255,255,255,0.08); color: var(--text); }
    #rate-del { background: transparent; color: var(--muted); font-size: 0.76rem; border: 0; cursor: pointer; padding: 0; }
    .btn.rate-on { color: var(--accent); }
    .m-chip.rate-on { color: var(--accent); border-color: rgba(167,139,250,0.5); }

    /* ══════════════════════════ Modern skin (opt-in, /settings) ══════════════════════════
       A third skin alongside the desktop pill and mobile .m-controls, selected by
       CONFIG.design==='modern' (body.modern). Reuses every real function (HLS, resume,
       progress, Aniskip, screenshot, rating, Watch Together, autoplay-next) — only the
       chrome is new. Touch-only bits (lock/rotate/PiP/cast/gestures) are further gated by
       body.is-touch, mirroring the existing isTouch check already used for .m-controls. */
    body.modern .controls, body.modern .player-title, body.modern .m-controls { display: none !important; }
    .md-shell { display: none; position: absolute; inset: 0; z-index: 6; }
    body.modern .md-shell { display: block; }
    .md-shell > * { pointer-events: none; }
    .md-shell button, .md-shell input, .md-shell .md-pill, .md-shell .md-sat, .md-shell .md-vrail,
    .md-shell .md-info, .md-shell .md-tico, .md-shell .md-wtpill, .md-shell .md-dico,
    .md-shell .md-cplay, .md-shell .md-unlock { pointer-events: auto; }

    .md-top { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: flex-start;
      padding: calc(18px + env(safe-area-inset-top,0)) calc(22px + env(safe-area-inset-right,0)) 0 calc(22px + env(safe-area-inset-left,0));
      transition: opacity 0.4s; }
    .md-info { display: inline-flex; align-items: center; gap: 10px; height: 52px; padding: 0 18px 0 8px; border-radius: 26px; max-width: 58vw;
      background: rgba(10,8,16,0.55); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(16px) saturate(1.4); -webkit-backdrop-filter: blur(16px) saturate(1.4);
      cursor: pointer; transition: 0.25s; }
    .md-info:hover { background: rgba(10,8,16,0.72); border-color: rgba(196,165,253,0.3); }
    .md-info .md-back { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.07); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .md-info .md-back svg { width: 18px; height: 18px; fill: #fff; }
    .md-info .md-txt { min-width: 0; }
    .md-info h1 { font-size: 0.95rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 0; }
    .md-info .md-sub { font-size: 0.72rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-height: 0; opacity: 0; transition: 0.25s; }
    .md-info:hover .md-sub { max-height: 20px; opacity: 1; margin-top: 2px; }
    .md-toptools { display: flex; gap: 8px; }
    .md-tico { width: 44px; height: 44px; border-radius: 50%; background: rgba(10,8,16,0.55); border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(16px); display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff; transition: 0.2s; }
    .md-tico:hover { background: rgba(255,255,255,0.12); }
    .md-tico.on { background: rgba(196,165,253,0.22); border-color: rgba(196,165,253,0.5); color: var(--accent); }
    .md-tico svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.9; }
    .md-wtpill { display: inline-flex; align-items: center; gap: 7px; height: 44px; padding: 0 16px; border-radius: 22px; font-size: 0.78rem; font-weight: 600;
      background: rgba(10,8,16,0.55); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(16px); cursor: pointer; color: #fff; white-space: nowrap; transition: 0.2s; }
    .md-wtpill:hover { background: rgba(255,255,255,0.12); }
    .md-wtpill.on { background: rgba(196,165,253,0.16); border-color: rgba(196,165,253,0.4); color: var(--accent); }

    .md-vrail { position: absolute; top: 50%; transform: translateY(-50%); width: 28px; height: 130px; border-radius: 999px;
      background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); cursor: pointer; transition: 0.3s cubic-bezier(.2,.8,.2,1);
      display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .md-vrail.left { left: 16px; } .md-vrail.right { right: 16px; }
    .md-vrail:hover { width: 60px; background: rgba(10,8,16,0.68); border-color: rgba(196,165,253,0.4); }
    .md-vrail svg { width: 18px; height: 18px; fill: none; stroke: #fff; stroke-width: 2; opacity: 0.55; transition: 0.2s; flex-shrink: 0; }
    .md-vrail:hover svg { opacity: 1; width: 22px; height: 22px; }
    /* Dimmed when there's no prev/next episode — kept clickable (never pointer-events:none)
       so a click here always lands on the rail itself rather than falling through to the
       video underneath and toggling play/pause by accident. */
    .md-vrail.md-nav-off { opacity: 0.35; cursor: default; }
    .md-vrail.md-nav-off:hover { width: 28px; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.1); }
    .md-vrail.md-nav-off:hover svg { opacity: 0.55; width: 18px; height: 18px; }

    .md-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
    .md-cplay { width: 88px; height: 88px; border-radius: 50%; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18);
      backdrop-filter: blur(12px); display: flex; align-items: center; justify-content: center; cursor: pointer; position: relative; opacity: 0; transition: opacity 0.3s; }
    body.modern:not(.md-playing) .md-cplay, body.modern.md-visible .md-cplay { opacity: 1; }
    .md-cplay::before { content: ""; position: absolute; inset: -14px; border-radius: 50%; border: 1.5px solid rgba(196,165,253,0.4); animation: md-breathe 2.6s ease-in-out infinite; }
    body.modern.md-playing .md-cplay::before { display: none; }
    @keyframes md-breathe { 0%, 100% { transform: scale(0.94); opacity: 0.5; } 50% { transform: scale(1.08); opacity: 0.95; } }
    .md-cplay svg { width: 34px; height: 34px; fill: #fff; }

    .md-satellites { position: absolute; left: 50%; bottom: 128px; transform: translateX(-50%); display: flex; gap: 8px; transition: opacity 0.4s, transform 0.4s; }
    .md-sat { display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 15px; border-radius: 19px; font-size: 0.8rem; font-weight: 600;
      background: rgba(10,8,16,0.6); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(14px); cursor: pointer; color: #fff; white-space: nowrap; }
    .md-sat.rate-on { color: var(--accent); border-color: rgba(196,165,253,0.4); }

    .md-dock { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: center;
      padding: 0 22px calc(26px + env(safe-area-inset-bottom,0)); transition: padding 0.4s; }
    .md-pill { width: 100%; max-width: 680px; background: rgba(12,9,20,0.78); border: 1px solid rgba(255,255,255,0.1); border-radius: 26px;
      backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4);
      box-shadow: 0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05); padding: 14px 18px 12px; transition: 0.4s cubic-bezier(.2,.8,.2,1); }
    .md-track { position: relative; height: 22px; display: flex; align-items: center; cursor: pointer; margin-bottom: 6px; }
    .md-track .md-base { position: relative; width: 100%; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.16); }
    .md-track .md-buf, .md-track .md-played { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; }
    .md-track .md-buf { background: rgba(255,255,255,0.26); z-index: 1; }
    .md-track .md-played { background: var(--accent); z-index: 2; }
    .md-zone { position: absolute; top: 0; bottom: 0; border-radius: 3px; z-index: 1; display: none; }
    .md-zone.show { display: block; }
    .md-zone.op { background: rgba(219,119,199,0.55); } .md-zone.ed { background: rgba(14,165,183,0.5); }
    .md-track .md-marker { position: absolute; top: -3px; bottom: -3px; width: 2px; border-radius: 1px; background: rgba(255,255,255,0.55); z-index: 2; display: none; }
    .md-track .md-marker.show { display: block; }
    .md-track .md-thumb { position: absolute; top: 50%; width: 15px; height: 15px; margin-top: -7.5px; transform: translateX(-50%);
      border-radius: 50%; background: #fff; box-shadow: 0 0 0 5px rgba(196,165,253,0.3); z-index: 3; }
    .md-row { display: flex; align-items: center; gap: 2px; }
    .md-b { width: 38px; height: 38px; border-radius: 50%; border: 0; background: transparent; color: #fff; display: flex; align-items: center;
      justify-content: center; cursor: pointer; flex-shrink: 0; transition: 0.15s; position: relative; }
    .md-b:hover { background: rgba(255,255,255,0.1); }
    .md-b svg { width: 20px; height: 20px; fill: currentColor; }
    .md-time { font-size: 0.78rem; color: rgba(255,255,255,0.8); padding: 0 8px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .md-time .dim { color: var(--muted); }
    .md-gap { flex: 1; }
    .md-skip85 { width: auto; height: 30px; padding: 0 11px; border-radius: 15px; font-size: 0.72rem; font-weight: 700;
      color: var(--accent); background: rgba(196,165,253,0.1); border: 1px solid rgba(196,165,253,0.25); margin-left: 4px; }
    .md-skip85:hover { background: rgba(196,165,253,0.2); border-color: var(--accent); }
    .md-vol { display: flex; align-items: center; }
    .md-vol input { width: 0; opacity: 0; transition: 0.2s; accent-color: var(--accent); height: 3px; }
    .md-vol:hover input { width: 64px; opacity: 1; margin-left: 4px; }

    .md-dcluster { position: absolute; right: 18px; bottom: 210px; display: flex; flex-direction: column; gap: 8px; }
    .md-dico { width: 38px; height: 38px; border-radius: 50%; background: rgba(10,8,16,0.55); border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(16px); display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff; transition: 0.2s; }
    .md-dico:hover { background: rgba(255,255,255,0.12); }
    .md-dico.on { background: rgba(196,165,253,0.22); border-color: rgba(196,165,253,0.5); color: var(--accent); }
    .md-dico svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.9; }
    body.is-desktop .md-lock, body.is-desktop .md-rotate, body.is-desktop .md-cast { display: none !important; }

    /* Idle auto-hide: chrome fades, the pill collapses to a thin sliver (not gone) */
    body.modern.md-idle .md-top, body.modern.md-idle .md-vrail, body.modern.md-idle .md-satellites, body.modern.md-idle .md-dcluster { opacity: 0; pointer-events: none; }
    body.modern.md-idle .md-dock { padding-bottom: 10px; }
    body.modern.md-idle .md-pill { max-width: 100%; padding: 0; background: transparent; border: 0; box-shadow: none; backdrop-filter: none; }
    body.modern.md-idle .md-pill .md-row { display: none; }
    body.modern.md-idle .md-track { margin: 0; height: auto; }
    body.modern.md-idle .md-track .md-base { height: 3px; border-radius: 0; }
    body.modern.md-idle .md-track .md-thumb { display: none; }

    /* Lock mode */
    body.modern.locked .md-top, body.modern.locked .md-vrail, body.modern.locked .md-satellites,
    body.modern.locked .md-dock, body.modern.locked .md-dcluster { opacity: 0; pointer-events: none; transition: opacity 0.3s; }
    .md-unlock { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 60px; height: 60px; border-radius: 50%;
      background: rgba(10,8,16,0.7); border: 1px solid rgba(255,255,255,0.18); backdrop-filter: blur(12px);
      display: none; align-items: center; justify-content: center; cursor: pointer; }
    .md-unlock svg { width: 24px; height: 24px; fill: none; stroke: #fff; stroke-width: 1.9; }
    body.modern.locked.unlock-peek .md-unlock { display: flex; }

    /* Settings sheet (speed + quality), reuses the mobile sheet's list markup style */
    .md-sheet { position: absolute; right: 22px; bottom: 112px; width: 220px; background: rgba(14,11,22,0.96); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 18px; padding: 8px; z-index: 3; display: none; backdrop-filter: blur(16px); }
    .md-sheet.open { display: block; }
    .md-sheet h4 { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 8px 10px 4px; }

    /* Gesture indicator (brightness/volume swipe), touch-only */
    .md-gind { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); z-index: 4; display: flex; align-items: center; gap: 11px;
      padding: 11px 16px; border-radius: 12px; background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); opacity: 0; pointer-events: none; transition: 0.15s; }
    .md-gind.show { opacity: 1; }
    .md-gind svg { width: 20px; height: 20px; fill: #fff; }
    .md-gind .md-gbar { width: 100px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.25); overflow: hidden; }
    .md-gind .md-gbar > i { display: block; height: 100%; background: #fff; width: 0; }

    /* Autoplay-next ring countdown lives inside the existing #autonext card */
    .md-ring-wrap { display: none; }
    body.modern .md-ring-wrap { display: block; flex-shrink: 0; }
    body.modern #autonext { flex-direction: row; align-items: center; gap: 14px; }
    body.modern .an-t, body.modern .an-c { display: none; }
    .md-an-body { display: none; }
    body.modern .md-an-body { display: block; flex: 1; min-width: 0; }
    .md-an-lb { font-size: 0.76rem; color: rgba(255,255,255,0.6); }
    .md-an-lb b { color: var(--accent); font-variant-numeric: tabular-nums; }
    body.modern #autonext > .an-row { display: none; }
  </style>
</head>
<body>
  <div class="stage" id="stage"><video id="player" playsinline x-webkit-airplay="allow"></video></div>
  <div class="loader" id="loader"><div class="spinner"></div></div>
  <button class="big-play visible" id="big-play" type="button"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
  <div class="tap-fx" id="tap-back" style="left:14%"><svg viewBox="0 0 24 24"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></div>
  <div class="tap-fx" id="tap-fwd" style="right:14%"><svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg></div>
  <div class="error-panel" id="error-panel"></div>
  <div class="toast" id="resume-toast">
    <span id="resume-text"></span>
    <button class="t-btn" id="resume-btn" type="button">Продолжить</button>
    <button class="t-skip" id="resume-skip" type="button">С начала</button>
  </div>
  <div class="saved-badge" id="saved-badge">сохранено</div>
  <div class="toast" id="shot-toast"><span id="shot-toast-text"></span></div>
  <div class="hk-modal" id="hk-modal">
    <div class="hk-box">
      <h2>Горячие клавиши</h2>
      <div class="hk-row"><span class="label">Пауза / воспроизведение</span><div class="hk-keys"><kbd>Space</kbd><kbd>K</kbd></div></div>
      <div class="hk-row"><span class="label">Назад 10 сек</span><div class="hk-keys"><kbd>←</kbd><kbd>J</kbd></div></div>
      <div class="hk-row"><span class="label">Вперёд 10 сек</span><div class="hk-keys"><kbd>→</kbd><kbd>L</kbd></div></div>
      <div class="hk-row"><span class="label">Пропустить опенинг</span><div class="hk-keys"><kbd>O</kbd></div></div>
      <div class="hk-row"><span class="label">Громкость</span><div class="hk-keys"><kbd>↑</kbd><kbd>↓</kbd></div></div>
      <div class="hk-row"><span class="label">Перейти к %</span><div class="hk-keys"><kbd>0</kbd><kbd>—</kbd><kbd>9</kbd></div></div>
      <div class="hk-row"><span class="label">Полный экран</span><div class="hk-keys"><kbd>F</kbd></div></div>
      <div class="hk-row"><span class="label">Звук</span><div class="hk-keys"><kbd>M</kbd></div></div>
      <div class="hk-row"><span class="label">Закрыть это окно</span><div class="hk-keys"><kbd>?</kbd><kbd>Esc</kbd></div></div>
    </div>
  </div>
  <div class="rate-modal" id="rate-modal">
    <div class="rate-box">
      <h2>Оценить эпизод</h2>
      <div class="ep" id="rate-ep"></div>
      <div class="rate-stars" id="rate-stars">
        <span class="rate-star" data-v="1">★</span>
        <span class="rate-star" data-v="2">★</span>
        <span class="rate-star" data-v="3">★</span>
        <span class="rate-star" data-v="4">★</span>
        <span class="rate-star" data-v="5">★</span>
        <span class="rate-star" data-v="6">★</span>
        <span class="rate-star" data-v="7">★</span>
        <span class="rate-star" data-v="8">★</span>
        <span class="rate-star" data-v="9">★</span>
        <span class="rate-star" data-v="10">★</span>
      </div>
      <div class="rate-val" id="rate-val">—</div>
      <div class="rate-actions">
        <button id="rate-save" type="button" disabled>Сохранить</button>
        <button id="rate-close" type="button">Закрыть</button>
      </div>
      <button id="rate-del" type="button" style="display:none">Удалить оценку</button>
    </div>
  </div>
  <button class="skip-fab" id="skip-fab" type="button">Опенинг +1:25</button>
  <div id="dimmer"></div>
  <div id="g-ind">
    <svg id="g-icon-bright" viewBox="0 0 24 24" style="display:none"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 000-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
    <svg id="g-icon-vol" viewBox="0 0 24 24" style="display:none"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
    <span class="g-bar"><i id="g-fill"></i></span>
  </div>
  <div id="autonext">
    <span class="an-t">Следующая серия</span>
    <span class="an-c">через <b id="an-num">8</b> с…</span>
    <svg class="md-ring-wrap" viewBox="0 0 44 44" width="44" height="44">
      <circle cx="22" cy="22" r="19" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3"/>
      <circle id="an-ring" cx="22" cy="22" r="19" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"
        stroke-dasharray="119.4" stroke-dashoffset="0" transform="rotate(-90 22 22)"/>
    </svg>
    <div class="md-an-body">
      <div class="md-an-lb">Следующая серия через <b id="an-num2">8</b>с</div>
      <div class="an-row">
        <button id="an-cancel2" type="button">Отмена</button>
        <button id="an-now2" type="button">▶ Сейчас</button>
      </div>
    </div>
    <div class="an-row">
      <button id="an-cancel" type="button">Отмена</button>
      <button id="an-now" type="button">▶ Сейчас</button>
    </div>
  </div>
  <div class="overlay" id="overlay">
    <div class="player-title">
      <button class="pt-back" id="d-back" type="button" aria-label="Назад" title="Назад">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
      </button>
      <div class="pt-meta">
        <div class="pt-name">${safeTitle}</div>
        ${safeSub ? `<div class="pt-sub">${safeSub}</div>` : ''}
      </div>
      <div class="pt-actions">
        <button class="pt-act" id="d-together" type="button">👥 Вместе</button>
        <button class="pt-act" id="d-queue" type="button" hidden>☰ Очередь</button>
        <button class="pt-act accent" id="d-next" type="button" hidden>След. серия →</button>
      </div>
    </div>
    <div class="m-controls" id="m-controls">
      <div class="m-top">
        <button class="m-icon" id="m-back" type="button" aria-label="Назад">
          <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        </button>
        <div class="m-titlewrap">
          <div class="m-title">${safeTitle}</div>
          ${safeSub ? `<div class="m-sub">${safeSub}</div>` : ''}
        </div>
        <div class="m-top-right">
          <button class="m-tbtn" id="m-quality-btn" type="button" style="display:none"><span id="m-quality-text">Авто</span></button>
          <button class="m-tbtn" id="m-rate" type="button" style="display:none">★ Оценить</button>
          <button class="m-icon" id="m-shot" type="button" style="display:none" aria-label="Скриншот">
            <svg viewBox="0 0 24 24"><path d="M9 3L7.17 5H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2h-3.17L15 3H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.65 0-3 1.35-3 3s1.35 3 3 3 3-1.35 3-3-1.35-3-3-3z"/></svg>
          </button>
          <button class="m-icon" id="m-settings" type="button" aria-label="Настройки">
            <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          </button>
        </div>
      </div>
      <div class="m-center">
        <button class="m-cbtn" id="m-prev" type="button" aria-label="Предыдущая серия" disabled>
          <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
        </button>
        <button class="m-bigplay" id="m-play" type="button">
          <svg id="m-icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <svg id="m-icon-pause" viewBox="0 0 24 24" style="display:none"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
        </button>
        <button class="m-cbtn" id="m-next" type="button" aria-label="Следующая серия" disabled>
          <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6zM16 6h2v12h-2z"/></svg>
        </button>
      </div>
      <div class="m-bottom">
      <div class="m-bar">
        <div class="m-bar-left">
          <button class="m-icon" id="m-lock" type="button" aria-label="Блокировка">
            <svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
          </button>
          <button class="m-icon" id="m-rotate" type="button" aria-label="Поворот экрана">
            <svg viewBox="0 0 24 24"><path d="M7.34 6.41L.86 12.9l6.49 6.48 6.49-6.48-6.49-6.49zM3.69 12.9l3.66-3.66L11 12.9l-3.66 3.66-3.65-3.66zm15.67-6.26C17.61 4.88 15.28 4 13 3.93V.5l-4.5 4.5L13 9.5V5.94c1.77.06 3.53.76 4.88 2.11 2.73 2.73 2.73 7.17 0 9.9-1.34 1.34-3.11 2.02-4.88 2.06v2.02c2.28-.07 4.61-.95 6.36-2.7 3.52-3.51 3.52-9.21 0-12.71z"/></svg>
          </button>
          <button class="m-icon" id="m-speed-btn" type="button" aria-label="Скорость">
            <svg viewBox="0 0 24 24"><path d="M20.38 8.57l-1.23 1.85a8 8 0 01-.22 7.58H5.07A8 8 0 0115.58 6.85l1.85-1.23A10 10 0 003.35 19a2 2 0 001.72 1h13.85a2 2 0 001.74-1 10 10 0 00-.27-10.44zm-9.79 6.84a2 2 0 002.83 0l5.66-8.49-8.49 5.66a2 2 0 000 2.83z"/></svg>
            <span class="m-speed-lbl" id="m-speed-text"></span>
          </button>
        </div>
        <div class="m-bar-right">
          <button class="m-icon" id="m-skip-op" type="button" aria-label="+85 секунд">
            <svg viewBox="0 0 24 24"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>
            <span class="m-tag">+85</span>
          </button>
          <button class="m-icon" id="m-pip" type="button" aria-label="Мини-плеер">
            <svg viewBox="0 0 24 24"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.11.9 2 2 2h18c1.1 0 2-.89 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/></svg>
          </button>
          <button class="m-icon" id="m-fs" type="button" aria-label="Полный экран">
            <svg id="m-icon-fs-expand" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
            <svg id="m-icon-fs-shrink" viewBox="0 0 24 24" style="display:none"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
          </button>
        </div>
      </div>
      <div class="m-scrub">
        <span class="m-time" id="m-time-cur">0:00</span>
        <div class="progress-wrap m-progress" id="m-progress-wrap">
          <div class="progress-track" id="m-progress-track">
            <div class="progress-buffer" id="m-progress-buffer"></div>
            <div class="progress-played" id="m-progress-played"></div>
            <div class="progress-thumb"  id="m-progress-thumb"></div>
          </div>
        </div>
        <span class="m-time" id="m-time-dur">--:--</span>
      </div>
      </div>
      <button id="m-unlock" type="button" aria-label="Разблокировать">
        <svg viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z"/></svg>
      </button>
      <div class="m-sheet" id="m-sheet">
        <h3 id="m-quality-h">Качество</h3>
        <div id="m-quality-list"></div>
        <h3>Скорость</h3>
        <div id="m-speed-list"></div>
        <div class="m-sheet-actions">
          <button id="m-cast" type="button">📺 На ТВ</button>
        </div>
      </div>
    </div>
    <div class="controls">
      <div class="pill-wrap">
        <div class="progress-wrap" id="progress-wrap">
          <div class="progress-track" id="progress-track">
            <div class="progress-buffer" id="progress-buffer"></div>
            <div class="progress-played" id="progress-played"></div>
            <div class="progress-saved"  id="progress-saved"></div>
            <div class="progress-thumb"  id="progress-thumb"></div>
          </div>
        </div>
        <div class="ctrl-row">
          <button class="btn" id="btn-play" type="button">
            <svg id="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            <svg id="icon-pause" viewBox="0 0 24 24" style="display:none"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
          </button>
          <button class="btn" id="btn-back" type="button">
            <svg viewBox="0 0 24 24"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
          </button>
          <button class="btn" id="btn-fwd" type="button">
            <svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg>
          </button>
          <button class="btn skip-btn" id="btn-skip85" type="button" title="Перемотать вперёд на 85 секунд">+85</button>
          <button class="btn skip-btn" id="btn-skip-op" type="button" style="display:none">+1:25</button>
          <div class="ctrl-divider"></div>
          <span class="time"><span id="time-cur">0:00</span><span class="dim"> / </span><span id="time-dur">--:--</span></span>
          <div class="ctrl-divider"></div>
          <div class="vol-wrap">
            <button class="btn" id="btn-mute" type="button">
              <svg id="icon-vol" viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.06c1.48-.74 2.5-2.26 2.5-4.03z"/></svg>
            </button>
            <input id="volume" type="range" min="0" max="1" step="0.05" value="1" />
          </div>
          <div class="quality-wrap" id="speed-wrap">
            <button class="btn quality-btn" id="speed-btn" type="button">
              <span id="speed-label-text">1×</span>
              <svg viewBox="0 0 24 24" style="width:12px;height:12px;margin-left:2px"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
            <div class="quality-dropdown" id="speed-dropdown"></div>
          </div>
          <div class="quality-wrap" id="quality-wrap" style="display:none">
            <button class="btn quality-btn" id="quality-btn" type="button">
              <span id="quality-label-text">Авто</span>
              <svg viewBox="0 0 24 24" style="width:12px;height:12px;margin-left:2px"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
            <div class="quality-dropdown" id="quality-dropdown"></div>
          </div>
          <button class="btn" id="btn-hk" type="button" title="Горячие клавиши">
            <svg viewBox="0 0 24 24"><path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 5H5v-2h2v2zm9 0H8v-2h8v2zm0-3h-2v-2h2v2zm0-3h-2V8h2v2zm3 6h-2v-2h2v2zm0-3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>
          </button>
          <button class="btn" id="btn-shot" type="button" style="display:none" title="Скриншот в галерею">
            <svg viewBox="0 0 24 24"><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.65 0-3 1.35-3 3s1.35 3 3 3 3-1.35 3-3-1.35-3-3-3z"/></svg>
          </button>
          <button class="btn" id="btn-rate" type="button" style="display:none;font-size:18px;line-height:1" title="Оценить эпизод">★</button>
          <button class="btn" id="btn-cast" type="button" style="display:none" title="Транслировать на ТВ">
            <svg viewBox="0 0 24 24"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
          </button>
          <button class="btn" id="btn-fs" type="button">
            <svg id="icon-fs-expand" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
            <svg id="icon-fs-shrink" viewBox="0 0 24 24" style="display:none"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Modern skin: signature floating pill kept, everything around it reimagined ── -->
  <div class="md-shell" id="md-shell">
    <div class="md-top">
      <div class="md-info" id="md-back">
        <span class="md-back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></span>
        <div class="md-txt">
          <h1>${safeTitle}</h1>
          ${safeSub ? `<div class="md-sub">${safeSub}</div>` : ''}
        </div>
      </div>
      <div class="md-toptools">
        <div class="md-wtpill" id="md-wt">👥 Вместе</div>
        <div class="md-tico md-cast" id="md-cast" style="display:none" title="Трансляция на ТВ"><svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M6 21l6-4 6 4"/></svg></div>
        <div class="md-tico" id="md-settings" title="Настройки"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"/></svg></div>
      </div>
    </div>

    <button class="md-vrail left md-nav-off" id="md-prev" title="Предыдущая серия"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
    <button class="md-vrail right md-nav-off" id="md-next" title="Следующая серия"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>

    <div class="md-dcluster">
      <div class="md-dico md-lock" id="md-lock" title="Заблокировать экран"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg></div>
      <div class="md-dico md-rotate" id="md-rotate" title="Поворот экрана"><svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4M7 22l-4-4 4-4M21 6H8a5 5 0 00-5 5M3 18h13a5 5 0 005-5"/></svg></div>
      <div class="md-dico" id="md-pip" title="Мини-плеер"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none"/></svg></div>
    </div>

    <div class="md-center"><button class="md-cplay" id="md-center-play"><svg id="md-icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg id="md-icon-pause" viewBox="0 0 24 24" style="display:none"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg></button></div>

    <button class="md-unlock" id="md-unlock" aria-label="Разблокировать"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 017.6-1.8"/></svg></button>

    <div class="md-gind" id="md-gind">
      <svg id="md-gi-bright" viewBox="0 0 24 24" style="fill:#fff"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>
      <svg id="md-gi-vol" viewBox="0 0 24 24" style="display:none;fill:#fff"><path d="M3 9v6h4l5 5V4L7 9H3z"/></svg>
      <span class="md-gbar"><i id="md-gfill"></i></span>
    </div>

    <div class="md-satellites">
      <div class="md-sat" id="md-shot" style="display:none">📸 Кадр</div>
      <div class="md-sat" id="md-rate" style="display:none">★ Оценить</div>
      <div class="md-sat" id="md-skip" style="display:none;color:#130d1c;background:var(--accent);border-color:transparent"></div>
    </div>

    <div class="md-dock">
      <div class="md-pill">
        <div class="md-track" id="md-track">
          <div class="md-base">
            <div class="md-buf" id="md-buf"></div>
            <div class="md-zone op" id="md-zone-op"></div>
            <div class="md-zone ed" id="md-zone-ed"></div>
            <div class="md-marker" id="md-marker"></div>
            <div class="md-played" id="md-played"></div>
            <div class="md-thumb" id="md-thumb"></div>
          </div>
        </div>
        <div class="md-row">
          <button class="md-b" id="md-play"><svg id="md-icon-play2" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg id="md-icon-pause2" viewBox="0 0 24 24" style="display:none"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg></button>
          <div class="md-gap"></div>
          <button class="md-b" id="md-back10"><svg viewBox="0 0 24 24"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>
          <span class="md-time"><span id="md-time-cur">0:00</span><span class="dim"> / </span><span id="md-time-dur">--:--</span></span>
          <button class="md-b" id="md-fwd10"><svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg></button>
          <button class="md-b md-skip85" id="md-skip85" type="button" title="Перемотать вперёд на 85 секунд">+85</button>
          <div class="md-gap"></div>
          <div class="md-b md-vol" id="md-volbtn">
            <svg id="md-vol-on" viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.06c1.48-.74 2.5-2.26 2.5-4.03z"/></svg>
            <svg id="md-vol-off" viewBox="0 0 24 24" style="display:none"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="#fff" stroke-width="1.8"/></svg>
            <input id="md-volume" type="range" min="0" max="1" step="0.05" value="1" />
          </div>
          <button class="md-b" id="md-fs"><svg id="md-fs-exp" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg><svg id="md-fs-shr" viewBox="0 0 24 24" style="display:none"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg></button>
        </div>
      </div>
    </div>

    <div class="md-sheet" id="md-sheet">
      <h4>Скорость</h4>
      <div id="md-speed-list"></div>
      <h4>Качество</h4>
      <div id="md-quality-list"></div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
  <script>
    const CONFIG = ${config};
    function authHeaders(base){base=base||{};if(CONFIG.gatewayKey)base["X-Gateway-Key"]=CONFIG.gatewayKey;return base;}
    (function () {
      const video=document.getElementById("player"),stage=document.getElementById("stage"),overlay=document.getElementById("overlay"),loader=document.getElementById("loader"),bigPlay=document.getElementById("big-play"),errorPanel=document.getElementById("error-panel"),savedBadge=document.getElementById("saved-badge"),resumeToast=document.getElementById("resume-toast"),resumeText=document.getElementById("resume-text"),resumeBtn=document.getElementById("resume-btn"),resumeSkip=document.getElementById("resume-skip"),progressWrap=document.getElementById("progress-wrap"),progressTrack=document.getElementById("progress-track"),progressPlayed=document.getElementById("progress-played"),progressBuffer=document.getElementById("progress-buffer"),progressSaved=document.getElementById("progress-saved"),progressThumb=document.getElementById("progress-thumb"),timeCur=document.getElementById("time-cur"),timeDur=document.getElementById("time-dur"),btnPlay=document.getElementById("btn-play"),iconPlay=document.getElementById("icon-play"),iconPause=document.getElementById("icon-pause"),btnBack=document.getElementById("btn-back"),btnFwd=document.getElementById("btn-fwd"),btnSkipOp=document.getElementById("btn-skip-op"),btnMute=document.getElementById("btn-mute"),btnFs=document.getElementById("btn-fs"),iconFsExpand=document.getElementById("icon-fs-expand"),iconFsShrink=document.getElementById("icon-fs-shrink"),volume=document.getElementById("volume"),qualityWrap=document.getElementById("quality-wrap"),qualityBtn=document.getElementById("quality-btn"),qualityLabelText=document.getElementById("quality-label-text"),qualityDropdown=document.getElementById("quality-dropdown"),speedWrap=document.getElementById("speed-wrap"),speedBtn=document.getElementById("speed-btn"),speedLabelText=document.getElementById("speed-label-text"),speedDropdown=document.getElementById("speed-dropdown"),btnHk=document.getElementById("btn-hk"),hkModal=document.getElementById("hk-modal");
      // Mobile control refs
      const mPlay=document.getElementById("m-play"),mIconPlay=document.getElementById("m-icon-play"),mIconPause=document.getElementById("m-icon-pause"),mFs=document.getElementById("m-fs"),mIconFsExpand=document.getElementById("m-icon-fs-expand"),mIconFsShrink=document.getElementById("m-icon-fs-shrink"),mProgressWrap=document.getElementById("m-progress-wrap"),mProgressTrack=document.getElementById("m-progress-track"),mProgressPlayed=document.getElementById("m-progress-played"),mProgressBuffer=document.getElementById("m-progress-buffer"),mProgressThumb=document.getElementById("m-progress-thumb"),mTimeCur=document.getElementById("m-time-cur"),mTimeDur=document.getElementById("m-time-dur"),mQualityBtn=document.getElementById("m-quality-btn"),mQualityText=document.getElementById("m-quality-text"),mQualityList=document.getElementById("m-quality-list"),mSheet=document.getElementById("m-sheet"),mSpeedBtn=document.getElementById("m-speed-btn"),mSpeedText=document.getElementById("m-speed-text");
      let hls=null,currentLabel=CONFIG.defaultLabel,currentRate=1,saveTimer=null,savedBadgeTimer=null,hideTimer=null,seeking=false,resumed=false,pendingResume=CONFIG.resumeTime||0,savedMarkerPct=0,qualityOpen=false,speedOpen=false,hkOpen=false,corsFailed=false;
      let skipIntervals=[];
      let skipApplicable=false;
      const skipFab=document.getElementById("skip-fab");
      // Drives the floating skip button. With Aniskip data → precise label, applicable
      // only inside an OP/ED window (recaps auto-skip). Without data → a static
      // "+1:25" fallback that's always applicable. Visibility itself is gated on the
      // control panel (overlay) being visible — see reflectSkip().
      let skipLabel="";
      function updateSkipVisibility(){
        const t=video.currentTime||0;
        if(skipIntervals.length){
          const recap=skipIntervals.find(i=>i.type==="recap"&&t>=i.start&&t<i.end);
          if(recap){video.currentTime=recap.end;updateProgress();return;}
          const iv=skipIntervals.find(i=>i.type!=="recap"&&t>=i.start-1&&t<i.end);
          if(iv){skipApplicable=true;skipLabel=iv.type==="op"?"Пропустить опенинг":"Пропустить эндинг";skipFab.textContent=skipLabel;}
          else{skipApplicable=false;}
        }else{
          // No Aniskip timestamps — the manual jump lives on the "+85" button now.
          skipApplicable=false;
        }
        reflectSkip();
        mdRenderZones();
      }
      // Show the skip button only when it's applicable AND the control panel is up.
      function reflectSkip(){skipFab.classList.toggle("show",skipApplicable&&overlay.classList.contains("visible"));mdSkip.textContent=skipLabel;mdSkip.style.display=skipApplicable?"":"none";}
      // Paint the OP/ED zones directly on the Modern segmented track (visual only — the
      // legacy skins keep the floating skip button as their only Aniskip affordance).
      function mdRenderZones(){
        const d=video.duration;
        if(!d||isNaN(d)||!skipIntervals.length){mdZoneOp.classList.remove("show");mdZoneEd.classList.remove("show");return;}
        const op=skipIntervals.find(i=>i.type==="op"),ed=skipIntervals.find(i=>i.type==="ed");
        if(op){mdZoneOp.style.left=(op.start/d*100)+"%";mdZoneOp.style.width=((op.end-op.start)/d*100)+"%";mdZoneOp.classList.add("show");}else mdZoneOp.classList.remove("show");
        if(ed){mdZoneEd.style.left=(ed.start/d*100)+"%";mdZoneEd.style.width=((ed.end-ed.start)/d*100)+"%";mdZoneEd.classList.add("show");}else mdZoneEd.classList.remove("show");
      }
      const SPEEDS=[0.5,0.75,1,1.25,1.5,1.75,2];
      try{const cached=localStorage.getItem("miraihub:"+CONFIG.progressKey);if(cached){const p=JSON.parse(cached);if(typeof p.time==="number"&&p.time>pendingResume)pendingResume=p.time;if(p.duration>0&&p.time>0)savedMarkerPct=Math.min(100,(p.time/p.duration)*100);}}catch{}

      // ── Persisted preferences (volume, mute, speed, quality) across episodes ──
      const PREF="miraihub:prefs";
      let prefs={};try{prefs=JSON.parse(localStorage.getItem(PREF)||"{}")||{};}catch{}
      function savePrefs(){try{localStorage.setItem(PREF,JSON.stringify({volume:video.volume,muted:video.muted,rate:currentRate,quality:currentLabel}));}catch{}}
      if(typeof prefs.volume==="number"){video.volume=Math.min(1,Math.max(0,prefs.volume));volume.value=String(video.volume);}
      if(prefs.muted){video.muted=true;volume.value="0";}
      currentRate=Number(prefs.rate)||1;
      if(prefs.quality&&CONFIG.qualities.some(q=>q.label===prefs.quality))currentLabel=prefs.quality;

      function fmt(sec){const s=Math.max(0,Math.floor(sec)),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),r=s%60,mm=h>0?String(m).padStart(2,"0"):String(m);return h>0?h+":"+mm+":"+String(r).padStart(2,"0"):mm+":"+String(r).padStart(2,"0");}
      function pct(t,d){return(!d||isNaN(d))?0:Math.min(100,Math.max(0,t/d*100));}
      function sheetOpen(){return mSheet&&mSheet.classList.contains("open");}
      function showOverlay(){if(document.body.classList.contains("locked"))return;overlay.classList.add("visible");stage.classList.add("cursor-visible");reflectSkip();if(hideTimer)clearTimeout(hideTimer);if(!video.paused&&!hkOpen&&!qualityOpen&&!speedOpen&&!sheetOpen()){hideTimer=setTimeout(hideOverlay,3000);}}
      function hideOverlay(){if(seeking||hkOpen||qualityOpen||speedOpen||sheetOpen())return;overlay.classList.remove("visible");stage.classList.remove("cursor-visible");reflectSkip();}
      // While locked: reveal the unlock button on tap, auto-hide after 3s.
      let unlockTimer=null;
      function peekUnlock(){document.body.classList.add("unlock-peek");if(unlockTimer)clearTimeout(unlockTimer);unlockTimer=setTimeout(function(){document.body.classList.remove("unlock-peek");},3000);}
      function setLoader(on){loader.classList.toggle("visible",on);}
      function showError(msg){errorPanel.textContent=msg;errorPanel.classList.add("visible");setLoader(false);}
      function updatePlayUi(){const playing=!video.paused&&!video.ended;bigPlay.classList.toggle("visible",!playing);iconPlay.style.display=playing?"none":"block";iconPause.style.display=playing?"block":"none";mIconPlay.style.display=playing?"none":"block";mIconPause.style.display=playing?"block":"none";document.body.classList.toggle("md-playing",playing);mdIconPlay.style.display=playing?"none":"block";mdIconPause.style.display=playing?"block":"none";mdIconPlay2.style.display=playing?"none":"block";mdIconPause2.style.display=playing?"block":"none";}
      function togglePlay(){if(video.paused||video.ended)video.play().catch(()=>{});else video.pause();}
      function updateProgress(){const d=(!isNaN(video.duration)&&video.duration)?video.duration:0,t=video.currentTime||0,played=pct(t,d),buf=video.buffered.length?pct(video.buffered.end(video.buffered.length-1),d):0;progressPlayed.style.width=played+"%";progressBuffer.style.width=buf+"%";progressThumb.style.left=played+"%";timeCur.textContent=fmt(t);timeDur.textContent=d?fmt(d):"--:--";if(savedMarkerPct>1){progressSaved.style.left=savedMarkerPct+"%";progressSaved.classList.add("visible");}mProgressPlayed.style.width=played+"%";mProgressBuffer.style.width=buf+"%";mProgressThumb.style.left=played+"%";mTimeCur.textContent=fmt(t);mTimeDur.textContent=d?fmt(d):"--:--";mdPlayed.style.width=played+"%";mdBuf.style.width=buf+"%";mdThumb.style.left=played+"%";mdTimeCur.textContent=fmt(t);mdTimeDur.textContent=d?fmt(d):"--:--";if(savedMarkerPct>1){mdMarker.style.left=savedMarkerPct+"%";mdMarker.classList.add("show");}}
      function seekBy(delta){const d=(!isNaN(video.duration)&&video.duration)?video.duration:0;video.currentTime=Math.min(d||Infinity,Math.max(0,(video.currentTime||0)+delta));updateProgress();showOverlay();}
      function seekToRatio(r){const d=(!isNaN(video.duration)&&video.duration)?video.duration:0;if(!d)return;video.currentTime=d*Math.min(1,Math.max(0,r));updateProgress();}
      function flashSaved(){savedBadge.classList.add("visible");if(savedBadgeTimer)clearTimeout(savedBadgeTimer);savedBadgeTimer=setTimeout(()=>savedBadge.classList.remove("visible"),1800);}
      function saveProgress(force){const t=video.currentTime||0;if(t<1&&!force)return;const d=(!isNaN(video.duration)&&video.duration)?video.duration:0;if(d>0)savedMarkerPct=Math.min(100,t/d*100);const payload={releaseId:CONFIG.releaseId,sourceId:CONFIG.sourceId,episodePosition:CONFIG.episodePosition,time:t,duration:d,title:${JSON.stringify(safeTitle)}};try{localStorage.setItem("miraihub:"+CONFIG.progressKey,JSON.stringify(payload));}catch{}const send=()=>{fetch("/api/v1/player/progress",{method:"POST",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify(CONFIG.token?{...payload,token:CONFIG.token}:payload),keepalive:true}).catch(()=>{});};if(force){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}send();return;}if(saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;send();},3000);}
      function applyResume(){if(resumed||pendingResume<15)return;if(video.duration&&pendingResume>=video.duration-30){pendingResume=0;return;}resumed=true;video.currentTime=pendingResume;video.play().catch(()=>{});resumeText.textContent="Продолжено с "+fmt(pendingResume);resumeToast.classList.add("visible");setTimeout(()=>resumeToast.classList.remove("visible"),3500);}
      if(pendingResume>=15){resumeBtn.onclick=()=>{resumed=true;video.currentTime=pendingResume;resumeToast.classList.remove("visible");video.play().catch(()=>{});};resumeSkip.onclick=()=>{resumed=true;pendingResume=0;video.currentTime=0;resumeToast.classList.remove("visible");saveProgress(true);};}
      function findQuality(label){return CONFIG.qualities.find(q=>q.label===label)||CONFIG.qualities[0];}
      function destroyHls(){if(hls){hls.destroy();hls=null;}}
      function loadStream(label,autoplay){const item=findQuality(label);if(!item){showError("поток недоступен");return;}currentLabel=item.label;qualityLabelText.textContent=currentLabel;destroyHls();setLoader(true);errorPanel.classList.remove("visible");const url=item.url,isHlsStream=CONFIG.isHls||url.includes(".m3u8");const onReady=()=>{setLoader(false);updateProgress();try{video.playbackRate=currentRate;}catch{}if(autoplay)video.play().catch(()=>{});};
        // crossOrigin lets us capture screenshots without tainting the canvas; if the
        // CDN doesn't send CORS headers the media fails, so we retry once without it.
        if(corsFailed)video.removeAttribute("crossorigin");else video.crossOrigin="anonymous";
        if(!isHlsStream||video.canPlayType("application/vnd.apple.mpegurl")){
          const onErr=()=>{if(!corsFailed&&video.hasAttribute("crossorigin")){corsFailed=true;loadStream(currentLabel,true);}else showError("не удалось загрузить видео");};
          video.addEventListener("error",onErr,{once:true});
          video.addEventListener("loadedmetadata",()=>{video.removeEventListener("error",onErr);onReady();},{once:true});
          video.src=url;return;}
        if(window.Hls&&Hls.isSupported()){hls=new Hls({enableWorker:true});hls.loadSource(url);hls.attachMedia(video);hls.on(Hls.Events.MANIFEST_PARSED,onReady);hls.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal)showError("ошибка HLS: "+(d.type||"unknown"));});return;}
        showError("браузер не поддерживает HLS");}
      function selectQuality(label){const time=video.currentTime||0;loadStream(label,true);mQualityText.textContent=label;document.querySelectorAll("#quality-dropdown .quality-option, #m-quality-list .quality-option, #md-quality-list .quality-option").forEach(b=>b.classList.toggle("active",b.textContent===label));savePrefs();if(time>0)video.addEventListener("loadedmetadata",()=>{video.currentTime=time;updateProgress();},{once:true});closeQuality();mSheet.classList.remove("open");mdSheet.classList.remove("open");}
      function buildQualityDropdown(){const qh=document.getElementById("m-quality-h");if(CONFIG.qualities.length<=1){qualityWrap.style.display="none";mQualityBtn.style.display="none";if(qh)qh.style.display="none";mQualityList.style.display="none";return;}qualityWrap.style.display="";mQualityBtn.style.display="";if(qh)qh.style.display="";mQualityList.style.display="";mQualityText.textContent=currentLabel;qualityDropdown.innerHTML="";mQualityList.innerHTML="";mdQualityList.innerHTML="";for(const q of CONFIG.qualities){const mk=(host)=>{const btn=document.createElement("button");btn.className="quality-option"+(q.label===currentLabel?" active":"");btn.textContent=q.label;btn.onclick=()=>selectQuality(q.label);host.appendChild(btn);};mk(qualityDropdown);mk(mQualityList);mk(mdQualityList);}}
      function toggleQuality(){qualityOpen=!qualityOpen;qualityDropdown.classList.toggle("open",qualityOpen);if(qualityOpen){if(hideTimer)clearTimeout(hideTimer);}else showOverlay();}
      function closeQuality(){qualityOpen=false;qualityDropdown.classList.remove("open");showOverlay();}
      // ── Playback speed ──
      function setRate(r){currentRate=r;try{video.playbackRate=r;}catch{}speedLabelText.textContent=r+"×";if(mSpeedText)mSpeedText.textContent=r+"×";document.querySelectorAll("#speed-dropdown .quality-option, #md-speed-list .quality-option").forEach(b=>b.classList.toggle("active",Number(b.dataset.rate)===r));savePrefs();}
      function buildSpeedDropdown(){speedDropdown.innerHTML="";mdSpeedList.innerHTML="";for(const r of SPEEDS){const btn=document.createElement("button");btn.className="quality-option"+(r===currentRate?" active":"");btn.textContent=r+"×";btn.dataset.rate=String(r);btn.onclick=()=>{setRate(r);closeSpeed();mdSheet.classList.remove("open");};speedDropdown.appendChild(btn);const btn2=document.createElement("button");btn2.className="quality-option"+(r===currentRate?" active":"");btn2.textContent=r+"×";btn2.dataset.rate=String(r);btn2.onclick=()=>{setRate(r);mdSheet.classList.remove("open");};mdSpeedList.appendChild(btn2);}speedLabelText.textContent=currentRate+"×";if(mSpeedText)mSpeedText.textContent=currentRate+"×";}
      function toggleSpeed(){speedOpen=!speedOpen;speedDropdown.classList.toggle("open",speedOpen);if(speedOpen){if(hideTimer)clearTimeout(hideTimer);}else showOverlay();}
      function closeSpeed(){speedOpen=false;speedDropdown.classList.remove("open");showOverlay();}
      function toggleHk(){hkOpen=!hkOpen;hkModal.classList.toggle("open",hkOpen);if(hkOpen){if(hideTimer)clearTimeout(hideTimer);overlay.classList.add("visible");}else showOverlay();}
      const isTouch = matchMedia("(hover: none)").matches || ("ontouchstart" in window);

      // ── Modern skin refs (all null-safe — this const block simply doesn't run
      //    anything if design isn't modern; the elements still exist in the DOM
      //    either way since only CSS decides which skin paints). ──
      const MODERN = CONFIG.design === "modern";
      document.body.classList.toggle("modern", MODERN);
      document.body.classList.add(isTouch ? "is-touch" : "is-desktop");
      const mdTrack=document.getElementById("md-track"),mdPlayed=document.getElementById("md-played"),mdBuf=document.getElementById("md-buf"),mdThumb=document.getElementById("md-thumb"),mdMarker=document.getElementById("md-marker"),mdZoneOp=document.getElementById("md-zone-op"),mdZoneEd=document.getElementById("md-zone-ed"),mdTimeCur=document.getElementById("md-time-cur"),mdTimeDur=document.getElementById("md-time-dur"),mdIconPlay=document.getElementById("md-icon-play"),mdIconPause=document.getElementById("md-icon-pause"),mdIconPlay2=document.getElementById("md-icon-play2"),mdIconPause2=document.getElementById("md-icon-pause2"),mdCenterPlay=document.getElementById("md-center-play"),mdPlay=document.getElementById("md-play"),mdBack10=document.getElementById("md-back10"),mdFwd10=document.getElementById("md-fwd10"),mdVolBtn=document.getElementById("md-volbtn"),mdVolume=document.getElementById("md-volume"),mdVolOn=document.getElementById("md-vol-on"),mdVolOff=document.getElementById("md-vol-off"),mdFsBtn=document.getElementById("md-fs"),mdFsExp=document.getElementById("md-fs-exp"),mdFsShr=document.getElementById("md-fs-shr"),mdSkip=document.getElementById("md-skip"),mdSkip85=document.getElementById("md-skip85"),mdShell=document.getElementById("md-shell"),mdShot=document.getElementById("md-shot"),mdRateBtn=document.getElementById("md-rate"),mdSettingsBtn=document.getElementById("md-settings"),mdSheet=document.getElementById("md-sheet"),mdSpeedList=document.getElementById("md-speed-list"),mdQualityList=document.getElementById("md-quality-list"),mdWt=document.getElementById("md-wt"),mdCast=document.getElementById("md-cast"),mdPrev=document.getElementById("md-prev"),mdNext=document.getElementById("md-next"),mdBackChip=document.getElementById("md-back"),mdLock=document.getElementById("md-lock"),mdUnlock=document.getElementById("md-unlock"),mdRotate=document.getElementById("md-rotate"),mdPip=document.getElementById("md-pip"),mdGind=document.getElementById("md-gind"),mdGiBright=document.getElementById("md-gi-bright"),mdGiVol=document.getElementById("md-gi-vol"),mdGfill=document.getElementById("md-gfill"),anRing=document.getElementById("an-ring"),anNum2=document.getElementById("an-num2"),anCancel2=document.getElementById("an-cancel2"),anNow2=document.getElementById("an-now2");
      function toggleFs(){
        if(document.fullscreenElement){document.exitFullscreen().catch(()=>{});return;}
        if(document.documentElement.requestFullscreen){document.documentElement.requestFullscreen().catch(()=>{if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();});return;}
        if(video.webkitEnterFullscreen){video.webkitEnterFullscreen();}
      }
      document.addEventListener("fullscreenchange",()=>{const fs=Boolean(document.fullscreenElement);iconFsExpand.style.display=fs?"none":"block";iconFsShrink.style.display=fs?"block":"none";mIconFsExpand.style.display=fs?"none":"block";mIconFsShrink.style.display=fs?"block":"none";mdFsExp.style.display=fs?"none":"block";mdFsShr.style.display=fs?"block":"none";try{if(fs){if(screen.orientation&&screen.orientation.lock)screen.orientation.lock("landscape").catch(()=>{});}else{if(screen.orientation&&screen.orientation.unlock)screen.orientation.unlock();}}catch{}});

      // ── Progress scrubbing: mouse + touch ──
      const seekFromX=clientX=>{const r=progressTrack.getBoundingClientRect();seekToRatio((clientX-r.left)/r.width);};
      progressWrap.addEventListener("mousedown",e=>{seeking=true;seekFromX(e.clientX);saveProgress(true);});
      window.addEventListener("mousemove",e=>{if(seeking)seekFromX(e.clientX);});
      window.addEventListener("mouseup",()=>{if(seeking){saveProgress(true);seeking=false;}});
      progressWrap.addEventListener("touchstart",e=>{seeking=true;seekFromX(e.touches[0].clientX);e.preventDefault();},{passive:false});
      progressWrap.addEventListener("touchmove",e=>{if(seeking){seekFromX(e.touches[0].clientX);e.preventDefault();}},{passive:false});
      progressWrap.addEventListener("touchend",()=>{if(seeking){saveProgress(true);seeking=false;}});

      if(!isTouch){
        document.addEventListener("mousemove",showOverlay);
        document.addEventListener("mousedown",showOverlay);
      }

      // ── Tap feedback for double-tap seek ──
      const tapBack=document.getElementById("tap-back"),tapFwd=document.getElementById("tap-fwd");
      function flashTap(el){el.classList.add("show");if(el._t)clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove("show"),400);}

      // ── Surface tap handling ──
      // Desktop: click toggles play. Touch: single tap toggles controls, double-tap seeks (sides) / plays (center).
      let lastTapTime=0,tapTimer=null;
      let suppressTap=false; // set right after a vertical swipe gesture
      function surfaceTap(clientX){
        if(suppressTap)return;
        if(document.body.classList.contains("locked")){peekUnlock();return;}
        if(!isTouch){togglePlay();return;}
        const now=Date.now();
        if(now-lastTapTime<300){
          if(tapTimer){clearTimeout(tapTimer);tapTimer=null;}
          lastTapTime=0;
          const w=window.innerWidth;
          if(clientX<w*0.35){seekBy(-10);flashTap(tapBack);}
          else if(clientX>w*0.65){seekBy(10);flashTap(tapFwd);}
          else{togglePlay();}
        }else{
          lastTapTime=now;
          tapTimer=setTimeout(()=>{tapTimer=null;if(overlay.classList.contains("visible"))hideOverlay();else showOverlay();},300);
        }
      }
      btnPlay.addEventListener("click",togglePlay);
      bigPlay.addEventListener("click",togglePlay);
      stage.addEventListener("click",(e)=>{if(e.target===stage||e.target===video)surfaceTap(e.clientX);});
      document.getElementById("overlay").addEventListener("click",(e)=>{const ignore=["BUTTON","INPUT","SVG","PATH","SPAN"];if(!ignore.includes(e.target.tagName.toUpperCase())&&!e.target.closest("button")&&!e.target.closest(".pill-wrap")&&!e.target.closest(".progress-wrap"))surfaceTap(e.clientX);});
      stage.addEventListener("dblclick",()=>{if(!isTouch)toggleFs();});
      btnBack.addEventListener("click",()=>seekBy(-10));
      btnFwd.addEventListener("click",()=>seekBy(10));
      btnSkipOp.addEventListener("click",()=>{const t=video.currentTime||0;const iv=skipIntervals.find(i=>t>=i.start-1&&t<i.end);if(iv){video.currentTime=iv.end;updateProgress();}else seekBy(85);});
      document.getElementById("btn-skip85").addEventListener("click",()=>seekBy(85));
      skipFab.addEventListener("click",(e)=>{e.stopPropagation();const t=video.currentTime||0;const iv=skipIntervals.find(i=>t>=i.start-1&&t<i.end);if(iv){video.currentTime=iv.end;updateProgress();}else seekBy(85);showOverlay();});
      btnFs.addEventListener("click",toggleFs);
      btnMute.addEventListener("click",()=>{video.muted=!video.muted;});
      volume.addEventListener("input",()=>{video.volume=Number(volume.value);video.muted=video.volume===0;savePrefs();});
      video.addEventListener("volumechange",()=>{volume.value=String(video.muted?0:video.volume);mdVolume.value=String(video.muted?0:video.volume);mdVolOn.style.display=video.muted?"none":"block";mdVolOff.style.display=video.muted?"block":"none";});
      qualityBtn.addEventListener("click",e=>{e.stopPropagation();toggleQuality();});
      speedBtn.addEventListener("click",e=>{e.stopPropagation();toggleSpeed();});
      btnHk.addEventListener("click",e=>{e.stopPropagation();toggleHk();});
      hkModal.addEventListener("click",e=>{if(e.target===hkModal)toggleHk();});
      document.addEventListener("click",e=>{if(qualityOpen&&!qualityWrap.contains(e.target))closeQuality();if(speedOpen&&!speedWrap.contains(e.target))closeSpeed();});
      document.addEventListener("keydown",e=>{if(["INPUT","TEXTAREA"].includes(e.target?.tagName))return;const k=e.key.toLowerCase();if(hkOpen){if(k==="?"||k==="escape"){e.preventDefault();toggleHk();}return;}if(k===" "||k==="k"){e.preventDefault();togglePlay();}else if(k==="arrowleft"||k==="j"){e.preventDefault();seekBy(-10);}else if(k==="arrowright"||k==="l"){e.preventDefault();seekBy(10);}else if(k==="arrowup"){e.preventDefault();video.muted=false;video.volume=Math.min(1,video.volume+0.1);volume.value=String(video.volume);}else if(k==="arrowdown"){e.preventDefault();video.volume=Math.max(0,video.volume-0.1);volume.value=String(video.volume);}else if(k==="f"){e.preventDefault();toggleFs();}else if(k==="m"){e.preventDefault();video.muted=!video.muted;}else if(k==="o"){e.preventDefault();const t=video.currentTime||0;const iv=skipIntervals.find(i=>t>=i.start-1&&t<i.end)||skipIntervals.find(i=>i.start>t);if(iv){video.currentTime=iv.end;updateProgress();}else seekBy(85);}else if(k==="?"){e.preventDefault();toggleHk();}else if(k>="0"&&k<="9"){e.preventDefault();seekToRatio(Number(k)/10);}showOverlay();});
      let historyAdded=false;
      function addToHistory(){if(historyAdded||!CONFIG.token)return;historyAdded=true;fetch("/api/v1/history/add/"+CONFIG.releaseId+"/"+CONFIG.sourceId+"/"+CONFIG.episodePosition+"?token="+encodeURIComponent(CONFIG.token),{headers:authHeaders()}).catch(()=>{});}
      video.addEventListener("play",()=>{updatePlayUi();showOverlay();addToHistory();});
      video.addEventListener("pause",()=>{updatePlayUi();showOverlay();saveProgress(true);});
      video.addEventListener("waiting",()=>setLoader(true));
      video.addEventListener("playing",()=>setLoader(false));
      video.addEventListener("loadeddata",()=>video.classList.add("ready"));
      video.addEventListener("playing",()=>video.classList.add("ready"));
      video.addEventListener("loadedmetadata",()=>{updateProgress();applyResume();});
      video.addEventListener("timeupdate",()=>{updateProgress();saveProgress(false);updateSkipVisibility();});
      video.addEventListener("progress",()=>updateProgress());
      video.addEventListener("seeked",()=>{saveProgress(true);});
      window.addEventListener("beforeunload",()=>saveProgress(true));
      document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")saveProgress(true);});
      buildQualityDropdown();
      buildSpeedDropdown();
      updateSkipVisibility(); // show the +1:25 fallback immediately (covers no-malId / pre-fetch)

      // ── Aniskip: real OP/ED timestamps ──
      if(CONFIG.malId){
        const ep=Number(CONFIG.episodePosition)||1;
        fetch("https://api.aniskip.com/v2/skip-times/"+CONFIG.malId+"/"+ep+"?types[]=op&types[]=ed&types[]=recap&episodeLength=0")
          .then(r=>r.ok?r.json():null)
          .then(data=>{
            if(data&&data.found&&Array.isArray(data.results)){
              skipIntervals=data.results.map(r=>({type:r.skipType,start:r.interval.startTime,end:r.interval.endTime}));
            }
            updateSkipVisibility();
          })
          .catch(()=>{});
      }

      // ── Mobile UI wiring ──
      const isMobile = isTouch || window.innerWidth <= 640;
      if(isMobile){
        document.body.classList.add("mobile");
        mPlay.addEventListener("click",(e)=>{e.stopPropagation();togglePlay();});
        mFs.addEventListener("click",(e)=>{e.stopPropagation();toggleFs();});
        document.getElementById("m-skip-op").addEventListener("click",(e)=>{e.stopPropagation();seekBy(85);});
        // Bottom-left gauge: quick-cycle playback speed (also pickable in the settings sheet)
        mSpeedBtn.addEventListener("click",(e)=>{e.stopPropagation();const i=SPEEDS.indexOf(currentRate);setRate(SPEEDS[(i+1)%SPEEDS.length]);buildMobileSpeedList();showOverlay();});
        // "360p" chip + gear both open the settings sheet
        const openSheet=(e)=>{e.stopPropagation();mSheet.classList.toggle("open");if(mSheet.classList.contains("open")&&hideTimer)clearTimeout(hideTimer);};
        mQualityBtn.addEventListener("click",openSheet);
        document.getElementById("m-settings").addEventListener("click",openSheet);
        mSheet.addEventListener("click",(e)=>e.stopPropagation());
        // Lock / unlock controls
        document.getElementById("m-lock").addEventListener("click",(e)=>{e.stopPropagation();mSheet.classList.remove("open");document.body.classList.add("locked");overlay.classList.remove("visible");peekUnlock();});
        document.getElementById("m-unlock").addEventListener("click",(e)=>{e.stopPropagation();document.body.classList.remove("locked");document.body.classList.remove("unlock-peek");if(unlockTimer)clearTimeout(unlockTimer);showOverlay();});
        // Picture-in-picture
        document.getElementById("m-pip").addEventListener("click",(e)=>{e.stopPropagation();try{if(document.pictureInPictureElement)document.exitPictureInPicture();else if(video.requestPictureInPicture)video.requestPictureInPicture().catch(()=>{});}catch{}showOverlay();});
        // Rotate: ask the host (native locks orientation reliably), with an in-page fallback
        document.getElementById("m-rotate").addEventListener("click",(e)=>{e.stopPropagation();playerMsg("rotate");try{if(screen.orientation&&screen.orientation.lock){const t=(screen.orientation.type||"").indexOf("landscape")===0?"portrait-primary":"landscape-primary";screen.orientation.lock(t).catch(()=>{});}}catch{}showOverlay();});
        // Mobile progress scrubbing (mouse + touch)
        const mSeekX=clientX=>{const r=mProgressTrack.getBoundingClientRect();seekToRatio((clientX-r.left)/r.width);};
        mProgressWrap.addEventListener("mousedown",e=>{e.stopPropagation();seeking=true;mSeekX(e.clientX);saveProgress(true);});
        mProgressWrap.addEventListener("touchstart",e=>{seeking=true;mSeekX(e.touches[0].clientX);e.preventDefault();},{passive:false});
        mProgressWrap.addEventListener("touchmove",e=>{if(seeking){mSeekX(e.touches[0].clientX);e.preventDefault();}},{passive:false});
        mProgressWrap.addEventListener("touchend",()=>{if(seeking){saveProgress(true);seeking=false;}});
        // Close quality sheet when controls hide
        overlay.addEventListener("transitionend",()=>{if(!overlay.classList.contains("visible"))mSheet.classList.remove("open");});
        showOverlay();
      }

      // ── Immersive navigation bridge (Back / Prev / Next / Together / Queue) ──
      // The React host owns routing, episode loading and Watch-Together, so the
      // in-player buttons post intents and the host performs them. The host also
      // pushes {__wt:"meta"} so we can enable prev/next and reflect room state.
      function playerMsg(action,extra){try{parent.postMessage(Object.assign({__player:action},extra||{}),"*");}catch(e){}}
      function buildMobileSpeedList(){const list=document.getElementById("m-speed-list");if(!list)return;list.innerHTML="";for(const r of SPEEDS){const b=document.createElement("button");b.className="quality-option"+(r===currentRate?" active":"");b.textContent=r+"×";b.onclick=()=>{setRate(r);buildMobileSpeedList();mSheet.classList.remove("open");showOverlay();};list.appendChild(b);}}
      buildMobileSpeedList();
      let hasNext=false,hasPrev=false,inRoom=false;
      const mPrev=document.getElementById("m-prev"),mNext=document.getElementById("m-next"),dNext=document.getElementById("d-next"),dQueue=document.getElementById("d-queue"),mQueue=document.getElementById("m-queue"),dTogether=document.getElementById("d-together"),mTogether=document.getElementById("m-together");
      function reflectNav(){if(mPrev)mPrev.disabled=!hasPrev;if(mNext)mNext.disabled=!hasNext;if(dNext)dNext.hidden=!hasNext;if(dQueue)dQueue.hidden=!inRoom;if(mQueue)mQueue.hidden=!inRoom;const tl=inRoom?"● Комната открыта":"👥 Смотреть вместе";if(mTogether)mTogether.textContent=tl;if(dTogether)dTogether.textContent=inRoom?"● Комната":"👥 Вместе";mdPrev.classList.toggle("md-nav-off",!hasPrev);mdNext.classList.toggle("md-nav-off",!hasNext);mdWt.textContent=inRoom?"● Комната":"👥 Вместе";mdWt.classList.toggle("on",inRoom);}
      reflectNav();
      window.addEventListener("message",function(e){var d=e.data;if(!d||typeof d!=="object"||d.__wt!=="meta")return;if(typeof d.hasNext==="boolean")hasNext=d.hasNext;if(typeof d.hasPrev==="boolean")hasPrev=d.hasPrev;inRoom=!!d.roomCode;reflectNav();});
      function bindNav(id,action){const el=document.getElementById(id);if(el)el.addEventListener("click",function(ev){ev.stopPropagation();playerMsg(action);showOverlay();});}
      bindNav("d-back","back");bindNav("m-back","back");
      bindNav("d-next","next");bindNav("m-next","next");bindNav("m-prev","prev");
      bindNav("d-together","together");bindNav("m-together","together");
      bindNav("d-queue","queue");bindNav("m-queue","queue");

      // ── Autoplay next episode with a countdown (skipped in a room / on finale) ──
      (function(){
        const box=document.getElementById("autonext"),anNum=document.getElementById("an-num");
        const RING_CIRC=119.4;
        let anTimer=null,anLeft=0;
        function anStop(){box.classList.remove("show");if(anTimer){clearInterval(anTimer);anTimer=null;}}
        function anGo(){anStop();playerMsg("next");}
        video.addEventListener("ended",function(){
          if(!hasNext||inRoom)return;
          anLeft=8;anNum.textContent=anLeft;anNum2.textContent=anLeft;anRing.style.strokeDashoffset=0;box.classList.add("show");
          if(anTimer)clearInterval(anTimer);
          anTimer=setInterval(function(){anLeft--;anNum.textContent=Math.max(anLeft,0);anNum2.textContent=Math.max(anLeft,0);anRing.style.strokeDashoffset=String(RING_CIRC*(1-anLeft/8));if(anLeft<=0)anGo();},1000);
        });
        document.getElementById("an-cancel").addEventListener("click",function(e){e.stopPropagation();anStop();});
        document.getElementById("an-now").addEventListener("click",function(e){e.stopPropagation();anGo();});
        anCancel2.addEventListener("click",function(e){e.stopPropagation();anStop();});
        anNow2.addEventListener("click",function(e){e.stopPropagation();anGo();});
        video.addEventListener("play",anStop); // replay / seek-back cancels the countdown
      })();

      // ── Vertical swipe gestures: left half = brightness (dimmer), right half = volume ──
      if(isMobile){
        const dimmer=document.getElementById("dimmer"),gInd=document.getElementById("g-ind"),
          gFill=document.getElementById("g-fill"),gIB=document.getElementById("g-icon-bright"),gIV=document.getElementById("g-icon-vol");
        let gSide=null,gStartY=0,gStartVal=0,gActive=false,gDim=0,gTimer=null;
        const clampU=(v)=>Math.min(1,Math.max(0,v));
        function gShow(side,frac){gIB.style.display=side==="bright"?"":"none";gIV.style.display=side==="vol"?"":"none";gFill.style.width=Math.round(frac*100)+"%";gInd.classList.add("show");if(gTimer)clearTimeout(gTimer);gTimer=setTimeout(function(){gInd.classList.remove("show");},650);}
        stage.addEventListener("touchstart",function(e){
          if(document.body.classList.contains("locked")||e.touches.length!==1)return;
          const t=e.touches[0];gSide=t.clientX<window.innerWidth/2?"bright":"vol";gStartY=t.clientY;gActive=false;
          gStartVal=gSide==="vol"?(video.muted?0:video.volume):(1-gDim);
        },{passive:true});
        stage.addEventListener("touchmove",function(e){
          if(gSide===null||e.touches.length!==1)return;
          const dy=gStartY-e.touches[0].clientY;
          if(!gActive){if(Math.abs(dy)<16)return;gActive=true;}
          e.preventDefault();
          const frac=clampU(gStartVal+dy/(window.innerHeight*0.6));
          if(gSide==="vol"){video.volume=frac;video.muted=frac===0;}
          else{gDim=1-frac;dimmer.style.opacity=String(gDim*0.75);}
          gShow(gSide,frac);
        },{passive:false});
        stage.addEventListener("touchend",function(){
          if(gActive){suppressTap=true;setTimeout(function(){suppressTap=false;},350);if(gSide==="vol")savePrefs();}
          gSide=null;gActive=false;
        });
      }

      // ── Cast to TV (Remote Playback API + AirPlay) ──
      const btnCast=document.getElementById("btn-cast"),mCast=document.getElementById("m-cast");
      // The desktop cast button appears only when a target is available; the
      // mobile one stays in the ⚙ sheet at all times (it's a discoverable option).
      // Modern only surfaces cast on touch devices (casting is realistically phone-first) —
      // body.is-desktop hides #md-cast outright via CSS regardless of this availability flag.
      function showCast(on){btnCast.style.display=on?"":"none";mdCast.style.display=on?"flex":"none";}
      if(mCast)mCast.style.display="";
      function castPrompt(){try{if(video.webkitShowPlaybackTargetPicker){video.webkitShowPlaybackTargetPicker();return;}if(video.remote&&video.remote.prompt)video.remote.prompt().catch(()=>{});}catch{}}
      btnCast.addEventListener("click",e=>{e.stopPropagation();castPrompt();});
      if(mCast)mCast.addEventListener("click",e=>{e.stopPropagation();castPrompt();});
      mdCast.addEventListener("click",e=>{e.stopPropagation();castPrompt();});
      try{if(video.remote&&video.remote.watchAvailability)video.remote.watchAvailability(a=>showCast(a)).catch(()=>{});}catch{}
      video.addEventListener("webkitplaybacktargetavailabilitychanged",e=>{showCast(e.availability==="available");});

      // ── Screenshot → personal gallery ──
      const btnShot=document.getElementById("btn-shot"),mShot=document.getElementById("m-shot"),shotToast=document.getElementById("shot-toast"),shotToastText=document.getElementById("shot-toast-text");
      let shotToastTimer=null,shotBusy=false;
      function showShot(msg){shotToastText.textContent=msg;shotToast.classList.add("visible");if(shotToastTimer)clearTimeout(shotToastTimer);shotToastTimer=setTimeout(()=>shotToast.classList.remove("visible"),2600);}
      function captureScreenshot(){
        if(shotBusy)return;
        const w=video.videoWidth,h=video.videoHeight;
        if(!w||!h){showShot("Видео ещё не готово");return;}
        let data;
        try{
          const c=document.createElement("canvas");c.width=w;c.height=h;
          c.getContext("2d").drawImage(video,0,0,w,h);
          data=c.toDataURL("image/jpeg",0.9);
        }catch(e){showShot("Скриншот недоступен (защита потока)");return;}
        shotBusy=true;showShot("Сохраняю кадр…");
        fetch("/api/v1/player/screenshot",{method:"POST",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify({image:data,token:CONFIG.token,releaseId:CONFIG.releaseId,title:${JSON.stringify(safeTitle)},episode:CONFIG.episodePosition,time:Math.floor(video.currentTime||0)})})
          .then(r=>{showShot(r.ok?"Сохранено в галерею ✓":"Ошибка сохранения");})
          .catch(()=>showShot("Ошибка сети"))
          .finally(()=>{shotBusy=false;});
      }
      if(CONFIG.screenshotEnabled){
        btnShot.style.display="";if(mShot)mShot.style.display="";mdShot.style.display="";
        btnShot.addEventListener("click",e=>{e.stopPropagation();captureScreenshot();});
        if(mShot)mShot.addEventListener("click",e=>{e.stopPropagation();captureScreenshot();});
        mdShot.addEventListener("click",e=>{e.stopPropagation();captureScreenshot();});
        document.addEventListener("keydown",e=>{if(["INPUT","TEXTAREA"].includes(e.target?.tagName))return;if(e.key.toLowerCase()==="s"&&!e.ctrlKey&&!e.metaKey){e.preventDefault();captureScreenshot();}});
      }

      // ── Episode rating (IMDB-style 1–10) ──
      if(CONFIG.token){
        const rateModal=document.getElementById("rate-modal"),rateStarsEl=document.getElementById("rate-stars"),rateVal=document.getElementById("rate-val"),rateSave=document.getElementById("rate-save"),rateClose=document.getElementById("rate-close"),rateDel=document.getElementById("rate-del"),btnRate=document.getElementById("btn-rate"),mRate=document.getElementById("m-rate"),rateEp=document.getElementById("rate-ep");
        const rateStars=[...rateStarsEl.querySelectorAll(".rate-star")];
        let curRating=0,rateAutoShown=false;
        rateEp.textContent=${JSON.stringify(safeTitle)};
        function litStars(n){rateStars.forEach((s,i)=>s.classList.toggle("lit",i<n));}
        function setHover(n){litStars(n||curRating);}
        function setRatingVal(n){rateVal.textContent=n?n+"/10":"—";}
        function applyRating(r){curRating=r;setRatingVal(r);litStars(r);rateSave.disabled=!r;rateDel.style.display=r?"":"none";const lbl=r?"★ "+r+"/10":"★ Оценить";if(mRate)mRate.textContent=lbl;btnRate.classList.toggle("rate-on",!!r);if(mRate)mRate.classList.toggle("rate-on",!!r);mdRateBtn.textContent=lbl;mdRateBtn.classList.toggle("rate-on",!!r);}
        rateStars.forEach(s=>{const v=Number(s.dataset.v);s.addEventListener("mouseenter",()=>setHover(v));s.addEventListener("mouseleave",()=>setHover(0));s.addEventListener("touchstart",e=>{e.preventDefault();setHover(v);},{passive:false});s.addEventListener("click",()=>applyRating(v));});
        function openRate(){rateSave.textContent="Сохранить";rateSave.disabled=!curRating;rateModal.classList.add("open");litStars(curRating);setRatingVal(curRating);if(hideTimer)clearTimeout(hideTimer);overlay.classList.add("visible");}
        function closeRate(){rateModal.classList.remove("open");showOverlay();}
        rateClose.addEventListener("click",closeRate);
        rateModal.addEventListener("click",e=>{if(e.target===rateModal)closeRate();});
        btnRate.style.display="";btnRate.addEventListener("click",e=>{e.stopPropagation();openRate();});
        if(mRate){mRate.style.display="";mRate.addEventListener("click",e=>{e.stopPropagation();openRate();});}
        mdRateBtn.style.display="";mdRateBtn.addEventListener("click",e=>{e.stopPropagation();openRate();});
        rateSave.addEventListener("click",()=>{
          if(!curRating)return;rateSave.disabled=true;rateSave.textContent="Сохраняю…";
          fetch("/api/v1/player/rating",{method:"POST",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify({releaseId:CONFIG.releaseId,sourceId:CONFIG.sourceId,episode:CONFIG.episodePosition,rating:curRating,token:CONFIG.token})})
            .then(r=>{if(r.ok){rateSave.textContent="Сохранено ✓";setTimeout(closeRate,700);}else{rateSave.textContent="Ошибка";rateSave.disabled=false;}})
            .catch(()=>{rateSave.textContent="Ошибка сети";rateSave.disabled=false;});
        });
        rateDel.addEventListener("click",()=>{
          fetch("/api/v1/player/rating?releaseId="+CONFIG.releaseId+"&sourceId="+CONFIG.sourceId+"&episode="+CONFIG.episodePosition+"&token="+encodeURIComponent(CONFIG.token),{method:"DELETE",headers:authHeaders()})
            .then(()=>{applyRating(0);closeRate();}).catch(()=>{});
        });
        // Load existing rating
        fetch("/api/v1/player/rating?releaseId="+CONFIG.releaseId+"&sourceId="+CONFIG.sourceId+"&episode="+CONFIG.episodePosition+"&token="+encodeURIComponent(CONFIG.token),{headers:authHeaders()})
          .then(r=>r.ok?r.json():null).then(d=>{if(d&&d.rating)applyRating(d.rating);}).catch(()=>{});
        // Auto-prompt once when the episode finishes
        video.addEventListener("ended",()=>{if(!rateAutoShown&&!hasNext){rateAutoShown=true;setTimeout(openRate,800);}});
      }

      // ── Watch Together bridge (sync via postMessage) ──
      // Host is the TIME authority (heartbeat/seek). Pause/resume can be issued
      // by anyone (host via "state", guests via "control") and applies to all.
      (function(){
        var wtRole=null,wtLastEmit=0,wtApplyUntil=0;
        function emitState(force){ // host only: time + paused
          if(wtRole!=="host")return;
          var now=Date.now();
          if(!force&&now-wtLastEmit<900)return;
          wtLastEmit=now;
          try{parent.postMessage({__wt:"state",time:video.currentTime||0,paused:video.paused},"*");}catch(e){}
        }
        function emitControl(){ // guest only: pause/resume command
          if(wtRole!=="guest")return;
          if(Date.now()<wtApplyUntil)return; // suppress echo of a programmatic change
          try{parent.postMessage({__wt:"control",time:video.currentTime||0,paused:video.paused},"*");}catch(e){}
        }
        window.addEventListener("message",function(e){
          var d=e.data;if(!d||typeof d!=="object")return;
          if(d.__wt==="role"){wtRole=d.role;return;}
          if(d.__wt==="apply"){ // both host and guest apply incoming state
            wtApplyUntil=Date.now()+400;
            var t=Number(d.time)||0;
            if(Math.abs((video.currentTime||0)-t)>0.75){try{video.currentTime=t;}catch(e){}}
            if(d.paused&&!video.paused)video.pause();
            else if(!d.paused&&video.paused)video.play().catch(function(){});
            return;
          }
        });
        video.addEventListener("play",function(){emitState(true);emitControl();});
        video.addEventListener("pause",function(){emitState(true);emitControl();});
        video.addEventListener("seeked",function(){emitState(true);}); // host-only time authority
        video.addEventListener("ended",function(){if(wtRole==="host"){try{parent.postMessage({__wt:"ended"},"*");}catch(e){}}});
        video.addEventListener("timeupdate",function(){emitState(false);});
        setInterval(function(){emitState(true);},1500); // heartbeat (keeps guests synced while paused)
        try{parent.postMessage({__wt:"ready"},"*");}catch(e){}
      })();

      // ── Modern skin wiring: transport, track, volume, settings, nav, lock/rotate/PiP, idle-hide, gestures ──
      bindNav("md-back","back");bindNav("md-wt","together");
      // Dedicated handlers (not the generic bindNav) — the rail must ALWAYS swallow its
      // own click, even when there's no prev/next episode, so an accidental tap never
      // falls through to the video underneath and toggles play/pause instead.
      mdPrev.addEventListener("click",e=>{e.stopPropagation();if(hasPrev)playerMsg("prev");});
      mdNext.addEventListener("click",e=>{e.stopPropagation();if(hasNext)playerMsg("next");});
      mdCenterPlay.addEventListener("click",e=>{e.stopPropagation();togglePlay();mdResetIdle();});
      mdPlay.addEventListener("click",e=>{e.stopPropagation();togglePlay();});
      mdBack10.addEventListener("click",e=>{e.stopPropagation();seekBy(-10);});
      mdFwd10.addEventListener("click",e=>{e.stopPropagation();seekBy(10);});
      mdFsBtn.addEventListener("click",e=>{e.stopPropagation();toggleFs();});
      mdSkip.addEventListener("click",e=>{e.stopPropagation();const t=video.currentTime||0;const iv=skipIntervals.find(i=>t>=i.start-1&&t<i.end);if(iv){video.currentTime=iv.end;updateProgress();}else seekBy(85);});
      mdSkip85.addEventListener("click",e=>{e.stopPropagation();seekBy(85);});
      // Background tap/click (anywhere on the shell not covered by a real control) — reuses the
      // same surfaceTap used by the legacy skin: desktop click toggles play immediately, touch
      // does single-tap-to-toggle-idle / double-tap-to-seek. .md-shell sits above #stage in the
      // stacking order, so #stage's own tap handling never fires in Modern; this restores it.
      mdShell.addEventListener("click",e=>{if(e.target===mdShell)surfaceTap(e.clientX);});
      const mdSeekX=clientX=>{const r=mdTrack.getBoundingClientRect();seekToRatio((clientX-r.left)/r.width);};
      mdTrack.addEventListener("mousedown",e=>{e.stopPropagation();seeking=true;mdSeekX(e.clientX);saveProgress(true);});
      window.addEventListener("mousemove",e=>{if(seeking)mdSeekX(e.clientX);});
      mdTrack.addEventListener("touchstart",e=>{seeking=true;mdSeekX(e.touches[0].clientX);e.preventDefault();},{passive:false});
      mdTrack.addEventListener("touchmove",e=>{if(seeking){mdSeekX(e.touches[0].clientX);e.preventDefault();}},{passive:false});
      mdTrack.addEventListener("touchend",()=>{if(seeking){saveProgress(true);seeking=false;}});
      mdVolBtn.addEventListener("click",e=>{if(e.target===mdVolume)return;e.stopPropagation();video.muted=!video.muted;});
      mdVolume.addEventListener("input",()=>{video.volume=Number(mdVolume.value);video.muted=video.volume===0;savePrefs();});

      // Settings sheet — same speed+quality lists already built for desktop/mobile, just re-hosted here.
      mdSettingsBtn.addEventListener("click",e=>{e.stopPropagation();mdSheet.classList.toggle("open");if(mdSheet.classList.contains("open")&&hideTimer)clearTimeout(hideTimer);});
      mdSheet.addEventListener("click",e=>e.stopPropagation());
      document.addEventListener("click",()=>{if(mdSheet.classList.contains("open"))mdSheet.classList.remove("open");});

      // Lock / rotate / PiP — same behavior as the mobile controls, fresh bindings for the Modern cluster.
      function mdDoLock(){mdSheet.classList.remove("open");document.body.classList.add("locked");peekUnlock();}
      function mdDoUnlock(){document.body.classList.remove("locked");document.body.classList.remove("unlock-peek");if(unlockTimer)clearTimeout(unlockTimer);mdResetIdle();}
      mdLock.addEventListener("click",e=>{e.stopPropagation();mdDoLock();});
      mdUnlock.addEventListener("click",e=>{e.stopPropagation();mdDoUnlock();});
      mdRotate.addEventListener("click",e=>{e.stopPropagation();playerMsg("rotate");try{if(screen.orientation&&screen.orientation.lock){const t=(screen.orientation.type||"").indexOf("landscape")===0?"portrait-primary":"landscape-primary";screen.orientation.lock(t).catch(()=>{});}}catch{}});
      mdPip.addEventListener("click",e=>{e.stopPropagation();try{if(document.pictureInPictureElement)document.exitPictureInPicture();else if(video.requestPictureInPicture)video.requestPictureInPicture().catch(()=>{});}catch{}});

      // Idle auto-hide: chrome fades after a few seconds of inactivity while playing;
      // any interaction (or tapping the locked stage) restores it immediately.
      let mdIdleT=null;
      function mdResetIdle(){
        if(document.body.classList.contains("locked"))return;
        document.body.classList.remove("md-idle");
        if(mdIdleT)clearTimeout(mdIdleT);
        if(!video.paused)mdIdleT=setTimeout(()=>document.body.classList.add("md-idle"),3000);
      }
      if(MODERN){
        ["mousemove","mousedown","click","touchstart","keydown"].forEach(ev=>document.addEventListener(ev,mdResetIdle));
        video.addEventListener("play",mdResetIdle);
        video.addEventListener("pause",()=>{document.body.classList.remove("md-idle");if(mdIdleT)clearTimeout(mdIdleT);});
        mdResetIdle();

        // Vertical swipe gesture (touch-only): left half = brightness, right half = volume.
        if(isTouch){
          const dimmer=document.getElementById("dimmer");
          let gSide=null,gStartY=0,gStartVal=0,gActive=false,gDim=0,gTimer=null;
          const gClamp=v=>Math.min(1,Math.max(0,v));
          function gShow(side,frac){mdGiBright.style.display=side==="bright"?"block":"none";mdGiVol.style.display=side==="vol"?"block":"none";mdGfill.style.width=Math.round(frac*100)+"%";mdGind.classList.add("show");if(gTimer)clearTimeout(gTimer);gTimer=setTimeout(()=>mdGind.classList.remove("show"),650);}
          // Bound to mdShell (not #stage): .md-shell sits above #stage in the stacking order and
          // covers the full viewport, so #stage never receives touches while Modern is active.
          // The e.target check keeps this scoped to bare background touches, not real controls.
          mdShell.addEventListener("touchstart",e=>{
            if(e.target!==mdShell||document.body.classList.contains("locked")||e.touches.length!==1)return;
            const t=e.touches[0];gSide=t.clientX<window.innerWidth/2?"bright":"vol";gStartY=t.clientY;gActive=false;
            gStartVal=gSide==="vol"?(video.muted?0:video.volume):(1-gDim);
          },{passive:true});
          mdShell.addEventListener("touchmove",e=>{
            if(gSide===null||e.touches.length!==1)return;
            const dy=gStartY-e.touches[0].clientY;
            if(!gActive){if(Math.abs(dy)<16)return;gActive=true;}
            e.preventDefault();
            const frac=gClamp(gStartVal+dy/(window.innerHeight*0.6));
            if(gSide==="vol"){video.volume=frac;video.muted=frac===0;}else{gDim=1-frac;dimmer.style.opacity=String(gDim*0.75);}
            gShow(gSide,frac);
          },{passive:false});
          mdShell.addEventListener("touchend",()=>{
            if(gActive){suppressTap=true;setTimeout(()=>{suppressTap=false;},350);if(gSide==="vol")savePrefs();}
            gSide=null;gActive=false;
          });
        }
      }

      loadStream(currentLabel,pendingResume<15);
    })();
  </script>
</body>
</html>`;
}
