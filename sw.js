// RINA Agent Service Worker
// Checks Dropbox for new emails in the background and sends push notifications
// even when the app tab is closed.

const CACHE_NAME = 'rina-agent-v1';
const CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

// ── Install & activate ────────────────────────────────────────────────────────
self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(clients.claim());
  // Start background sync
  scheduleCheck();
});

// ── Background periodic check ─────────────────────────────────────────────────
function scheduleCheck(){
  setTimeout(function(){
    checkForNewEmails().finally(scheduleCheck);
  }, CHECK_INTERVAL);
}

// ── Get stored config from the app ───────────────────────────────────────────
async function getConfig(){
  try {
    // Read from the app's localStorage via IDB broadcast or stored config
    const cache = await caches.open(CACHE_NAME);
    const resp  = await cache.match('rina-config');
    if(resp) return resp.json();
  } catch(e){}
  return null;
}

// ── Store config (called from main app) ──────────────────────────────────────
self.addEventListener('message', function(e){
  if(e.data && e.data.type === 'STORE_CONFIG'){
    caches.open(CACHE_NAME).then(function(cache){
      cache.put('rina-config', new Response(JSON.stringify(e.data.config)));
    });
  }
  if(e.data && e.data.type === 'STORE_SEEN_IDS'){
    caches.open(CACHE_NAME).then(function(cache){
      cache.put('rina-seen-ids', new Response(JSON.stringify(e.data.ids)));
    });
  }
});

// ── Check Dropbox for new emails ─────────────────────────────────────────────
async function checkForNewEmails(){
  try {
    const config = await getConfig();
    if(!config || !config.refreshToken) return;

    // Get fresh access token
    const tokenResp = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token' +
            '&refresh_token=' + encodeURIComponent(config.refreshToken) +
            '&client_id=' + encodeURIComponent(config.appKey) +
            '&client_secret=' + encodeURIComponent(config.appSecret)
    });
    const tokenData = await tokenResp.json();
    if(!tokenData.access_token) return;
    const token = tokenData.access_token;

    // Read emails.json
    const emailResp = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Dropbox-API-Arg': JSON.stringify({ path: '/RINA-Agent/emails.json' })
      }
    });
    if(!emailResp.ok) return;
    const emails = await emailResp.json();

    // Get already-seen IDs
    const seenCache = await caches.open(CACHE_NAME);
    const seenResp  = await seenCache.match('rina-seen-ids');
    const seenIds   = seenResp ? await seenResp.json() : [];
    const startTs   = config.startTimestamp || 0;

    // Find new emails not yet seen
    const newEmails = (emails || []).filter(function(m){
      if(seenIds.indexOf(m.id) !== -1) return false;
      if(config.suppressedSubjects){
        var norm = (m.subject||'').replace(/^(re|fw|fwd)\s*:\s*/i,'').trim().toLowerCase();
        if(config.suppressedSubjects.indexOf(norm) !== -1) return false;
      }
      // Check start timestamp
      if(m.received){
        var ts = new Date(m.received).getTime();
        if(!isNaN(ts) && ts < startTs) return false;
      }
      // Check blocked senders
      if(config.blockedSenders){
        var from = (m.from||'').toLowerCase();
        if(config.blockedSenders.some(function(b){ return from.includes(b); })) return false;
      }
      return true;
    });

    if(newEmails.length > 0){
      // Update seen IDs
      const allSeen = seenIds.concat(newEmails.map(function(m){ return m.id; }));
      await seenCache.put('rina-seen-ids', new Response(JSON.stringify(allSeen)));

      // Send notification for each new email (max 3 to avoid spam)
      const toNotify = newEmails.slice(0, 3);
      for(const email of toNotify){
        const subject = email.subject || '(no subject)';
        const from    = email.from || 'Unknown';
        await self.registration.showNotification('RINA Agent — New email', {
          body: from + ': ' + subject,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%23003087"/><text x="50%" y="68%" text-anchor="middle" font-size="18" fill="white" font-family="Georgia">RI</text></svg>',
          badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="%23003087"/></svg>',
          tag: 'rina-' + email.id,
          requireInteraction: false,
          data: { url: self.registration.scope }
        });
      }
      if(newEmails.length > 3){
        await self.registration.showNotification('RINA Agent — ' + newEmails.length + ' new emails', {
          body: 'Open the app to view and action them.',
          tag: 'rina-batch',
          data: { url: self.registration.scope }
        });
      }
    }
  } catch(e){
    console.warn('[SW] Check failed:', e.message);
  }
}

// ── Notification click → open app ────────────────────────────────────────────
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(clientList){
      for(const client of clientList){
        if(client.url === url && 'focus' in client) return client.focus();
      }
      if(clients.openWindow) return clients.openWindow(url);
    })
  );
});
