(() => {
  'use strict';
  window.MUSE_VIEWER = {live:true,messages:[],queue:[],connections:{},sourceSamples:{},queueCounts:[],errors:[]};
  let busy = false;
  window.museRefresh = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch('/viewer/v1/snapshot', {cache:'no-store',signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      Object.assign(window.MUSE_VIEWER, snapshot, {live:true,disconnected:false});
    } catch {
      window.MUSE_VIEWER.disconnected = true;
    } finally {
      busy = false;
      window.dispatchEvent(new Event('muse-snapshot'));
    }
  };
  document.addEventListener('DOMContentLoaded', () => {
    window.museRefresh();
    setInterval(() => { if (!document.hidden) window.museRefresh(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) window.museRefresh(); });
  });
})();
