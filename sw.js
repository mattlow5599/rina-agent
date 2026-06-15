// RINA Agent Service Worker v3
// Uses IndexedDB for reliable storage and Periodic Background Sync for Android

const DB_NAME = 'rina-sw-db';
const DB_VERSION = 1;

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
function openDB(){
  return new Promise(function(resolve, reject){
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e){
      var db = e.target.result;
      if(!db.objectStoreNames.contains('config')){
        db.createObjectStore('config');
      }
    };
    req.onsuccess = function(e){ resolve(e.target.result); };
    req.onerror   = function(e){ reject(e.target.error); };
  });
}

function dbGet(key){
  return openDB().then(function(db){
    return new Promise(function(resolve, reject){
      var tx  = db.transaction('config','readonly');
      var req = tx.objectStore('config').get(key);
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror   = function(){ reject(req.error); };
    });
  });
}

function dbSet(key, value){
  return openDB().then(function(db){
    return new Promise(function(resolve, reject){
      var tx  = db.transaction('config','readwrite');
      var req = tx.objectStore('config').put(value, key);
      req.onsuccess = function(){ resolve(); };
      req.onerror   = function(){ reject(req.error); };
    });
  });
}

// ── Install & activate ────────────────────────────────────────────────────────
self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    clients.claim().then(function(){
      // Register periodic background sync if available
      return registerPeriodicSync();
    })
  );
});

async function registerPeriodicSync(){
  try {
    if('periodicSync' in self.registration){
      await self.registration.periodicSync.register('check-emails', {
        minInterval: 5 * 60 * 1000 // 5 minutes
      });
      console.log('[SW] Periodic sync registered');
    }
  } catch(e){
    console.log('[SW] Periodic sync not available:', e.message);
  }
}

// ── Message handler — store config from main app ──────────────────────────────
self.addEventListener('message', function(e){
  if(!e.data) return;
  if(e.data.type === 'STORE_CONFIG'){
    dbSet('config', e.data.config).then(function(){
      console.log('[SW] Config stored');
    });
  }
  if(e.data.type === 'STORE_SEEN_IDS'){
    dbSet('seenIds', e.data.ids);
  }
  // Manual check triggered from app
  if(e.data.type === 'CHECK_NOW'){
    checkForNewEmails();
  }
});

// ── Periodic background sync ──────────────────────────────────────────────────
self.addEventListener('periodicsync', function(e){
  if(e.tag === 'check-emails'){
    e.waitUntil(checkForNewEmails());
  }
});

// ── Also check when SW wakes for any reason ───────────────────────────────────
self.addEventListener('fetch', function(e){
  // Don't intercept fetches, just use as wake opportunity
});

// ── Core check function ───────────────────────────────────────────────────────
async function checkForNewEmails(){
  try {
    const config = await dbGet('config');
    if(!config || !config.refreshToken){
      console.log('[SW] No config — skipping check');
      return;
    }

    // Get Dropbox access token
    const tokenResp = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token' +
            '&refresh_token=' + encodeURIComponent(config.refreshToken) +
            '&client_id=' + encodeURIComponent(config.appKey) +
            '&client_secret=' + encodeURIComponent(config.appSecret)
    });
    const tokenData = await tokenResp.json();
    if(!tokenData.access_token){
      console.warn('[SW] Token refresh failed');
      return;
    }

    // Download emails.json
    const emailResp = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + tokenData.access_token,
        'Dropbox-API-Arg': JSON.stringify({ path: '/RINA-Agent/emails.json' })
      }
    });
    if(!emailResp.ok){ console.warn('[SW] emails.json download failed:', emailResp.status); return; }
    const emails = await emailResp.json();

    const seenIds  = (await dbGet('seenIds')) || [];
    const startTs  = config.startTimestamp || 0;

    const newEmails = (emails || []).filter(function(m){
      if(seenIds.indexOf(m.id) !== -1) return false;
      // Check start timestamp
      if(m.received){
        var ts = new Date(m.received).getTime();
        if(!isNaN(ts) && ts < startTs) return false;
      }
      // Check suppressed subjects
      if(config.suppressedSubjects && config.suppressedSubjects.length){
        var norm = (m.subject||'').replace(/^(re|fw|fwd)\s*:\s*/i,'').trim().toLowerCase();
        if(config.suppressedSubjects.indexOf(norm) !== -1) return false;
      }
      // Check blocked senders
      if(config.blockedSenders && config.blockedSenders.length){
        var from = (m.from||'').toLowerCase();
        if(config.blockedSenders.some(function(b){ return from.includes(b.toLowerCase()); })) return false;
      }
      return true;
    });

    console.log('[SW] New emails found:', newEmails.length);

    if(newEmails.length > 0){
      // Update seen IDs
      await dbSet('seenIds', seenIds.concat(newEmails.map(function(m){ return m.id; })));

      // Separate MPA (high priority) from others
      var mpaEmails = newEmails.filter(function(m){ return (m.from||'').toLowerCase().indexOf('@mpa.gov.sg') !== -1; });
      var otherEmails = newEmails.filter(function(m){ return (m.from||'').toLowerCase().indexOf('@mpa.gov.sg') === -1; });

      // MPA — individual high-priority notifications
      for(const m of mpaEmails){
        await self.registration.showNotification('\u2691 MPA — Action required', {
          body:               (m.subject || '(no subject)'),
          tag:                'rina-mpa-' + (m.id || Date.now()),
          requireInteraction: true,
          vibrate:            [300, 100, 300, 100, 300],
          data:               { url: self.registration.scope }
        });
      }

      // Others
      if(otherEmails.length === 1){
        var m = otherEmails[0];
        await self.registration.showNotification('RINA Agent — New email', {
          body:               (m.from || 'Unknown') + '\n' + (m.subject || '(no subject)'),
          tag:                'rina-' + (m.id || Date.now()),
          requireInteraction: false,
          vibrate:            [200, 100, 200],
          data:               { url: self.registration.scope }
        });
      } else if(otherEmails.length > 1){
        await self.registration.showNotification('RINA Agent — ' + otherEmails.length + ' new emails', {
          body:               'Tap to open and review.',
          tag:                'rina-batch',
          requireInteraction: false,
          vibrate:            [200, 100, 200],
          data:               { url: self.registration.scope }
        });
      }
    }
  } catch(err){
    console.warn('[SW] checkForNewEmails error:', err.message);
  }
}

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
      for(var i=0; i<list.length; i++){
        if('focus' in list[i]) return list[i].focus();
      }
      if(clients.openWindow) return clients.openWindow(url);
    })
  );
});
