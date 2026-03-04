/**
 * SMS Bridge Server v2 - Render deployment
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const deviceState  = new Map();
const connections  = new Map();
const serverLog    = [];

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  serverLog.push(line);
  if (serverLog.length > 200) serverLog.shift();
}

function state(token) {
  if (!deviceState.has(token))
    deviceState.set(token, { conversations: [], lastSync: null, deviceName: 'Android' });
  return deviceState.get(token);
}

function conn(token) {
  if (!connections.has(token))
    connections.set(token, { androidSocket: null, browserSockets: new Set() });
  return connections.get(token);
}

function broadcast(token, msg, skip = null) {
  const c = connections.get(token);
  if (!c) return 0;
  const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
  let sent = 0;
  c.browserSockets.forEach(ws => {
    if (ws !== skip && ws.readyState === WebSocket.OPEN) { ws.send(s); sent++; }
  });
  return sent;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/debug' || req.url === '/debug/') {
    const rows = [];
    connections.forEach((c, token) => {
      const s = deviceState.get(token);
      rows.push(`<tr>
        <td>${token.substring(0,4)}****</td>
        <td style="color:${c.androidSocket?.readyState===1?'#22c55e':'#ef4444'}">${c.androidSocket?.readyState===1?'✅ Connected':'❌ Offline'}</td>
        <td>${c.browserSockets.size}</td>
        <td>${s?.conversations?.length||0}</td>
        <td>${s?.lastSync ? new Date(s.lastSync).toLocaleTimeString() : 'never'}</td>
      </tr>`);
    });
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3">
    <style>body{font-family:monospace;background:#0a0a0f;color:#e2e8f0;padding:20px}
    table{border-collapse:collapse;width:100%}th,td{border:1px solid #2a2a3a;padding:8px;text-align:left}
    th{background:#1a1a24}pre{background:#1a1a24;padding:12px;overflow:auto;font-size:12px;max-height:400px}</style></head>
    <body><h2 style="color:#4f8eff">📱 SMS Bridge — Live Debug</h2>
    <p style="color:#94a3b8">Auto-refreshes every 3s</p>
    <h3>Connected Devices</h3>
    <table><tr><th>Token</th><th>Android</th><th>Browsers</th><th>Conversations</th><th>Last Sync</th></tr>
    ${rows.length ? rows.join('') : '<tr><td colspan="5" style="color:#64748b">No connections yet</td></tr>'}
    </table>
    <h3>Server Log</h3>
    <pre>${serverLog.slice(-50).reverse().join('\n')}</pre>
    </body></html>`);
    return;
  }

  if (req.url === '/api/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    const out = [];
    connections.forEach((c, token) => {
      out.push({ token: token.substring(0,4)+'****',
        androidOnline: c.androidSocket?.readyState === WebSocket.OPEN,
        browsers: c.browserSockets.size,
        conversations: deviceState.get(token)?.conversations?.length || 0 });
    });
    res.end(JSON.stringify({ ok: true, uptime: Math.floor(process.uptime()), devices: out }));
    return;
  }

  // Serve index.html
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(fs.readFileSync(indexPath));
  } else {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end('<h2>SMS Bridge Server Running</h2><p>index.html not found</p>');
  }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let urlObj;
  try { urlObj = new URL(req.url, 'http://localhost'); }
  catch(e) { ws.close(1008, 'Bad URL'); return; }

  const clientType = urlObj.searchParams.get('type') || 'browser';
  const token      = (urlObj.searchParams.get('token') || '').trim();

  if (!token) {
    log(`⚠️  Rejected — no token (type=${clientType})`);
    ws.close(1008, 'Missing token');
    return;
  }

  const short = token.substring(0,4) + '****';
  log(`🔌 New ${clientType} connection [${short}] from ${req.socket.remoteAddress}`);

  const c = conn(token);

  if (clientType === 'android') {
    if (c.androidSocket && c.androidSocket.readyState === WebSocket.OPEN) {
      c.androidSocket.close(1000, 'Replaced');
    }
    c.androidSocket = ws;
    broadcast(token, { type: 'android_status', online: true });
    ws.send(JSON.stringify({ type: 'connected', message: 'Server ready' }));
    log(`✅ Android registered [${short}] — ${c.browserSockets.size} browser(s) waiting`);

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        log(`📨 Android [${short}] type=${msg.type}${msg.type==='sync_data'?' convos='+(msg.conversations?.length||0):''}`);
        handleAndroid(token, msg);
      } catch(e) { log(`❌ Bad JSON from Android: ${e.message}`); }
    });

    ws.on('close', code => {
      log(`📴 Android disconnected [${short}] code=${code}`);
      if (c.androidSocket === ws) c.androidSocket = null;
      broadcast(token, { type: 'android_status', online: false });
    });

    ws.on('error', e => log(`❌ Android error [${short}]: ${e.message}`));

  } else {
    c.browserSockets.add(ws);
    const s = state(token);
    const androidOnline = c.androidSocket?.readyState === WebSocket.OPEN;
    log(`🌐 Browser connected [${short}] — android=${androidOnline} convos=${s.conversations.length}`);

    ws.send(JSON.stringify({
      type: 'initial_state',
      conversations: s.conversations,
      lastSync: s.lastSync,
      deviceName: s.deviceName,
      androidOnline
    }));

    if (androidOnline) {
      log(`🔄 Requesting fresh sync from Android [${short}]`);
      c.androidSocket.send(JSON.stringify({ type: 'sync_request' }));
    }

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        log(`📨 Browser [${short}] type=${msg.type}`);
        handleBrowser(token, msg, ws);
      } catch(e) { log(`❌ Bad JSON from browser: ${e.message}`); }
    });

    ws.on('close', () => {
      c.browserSockets.delete(ws);
      log(`🌐 Browser disconnected [${short}]`);
    });

    ws.on('error', e => log(`❌ Browser error [${short}]: ${e.message}`));
  }
});

function handleAndroid(token, msg) {
  const s = state(token);
  switch (msg.type) {
    case 'register':
      s.deviceName = msg.deviceName || 'Android';
      broadcast(token, { type: 'device_info', deviceName: s.deviceName, online: true });
      break;
    case 'sync_data':
      s.conversations = msg.conversations || [];
      s.lastSync = Date.now();
      const sent = broadcast(token, { type: 'sync_data', conversations: s.conversations, lastSync: s.lastSync });
      log(`✅ Synced ${s.conversations.length} conversations → ${sent} browser(s)`);
      break;
    case 'new_message': {
      s.lastSync = Date.now();
      const idx = s.conversations.findIndex(c => c.address === msg.from);
      const newMsg = { id: Date.now().toString(), body: msg.body, date: msg.date, type: 'received', read: false };
      if (idx >= 0) {
        s.conversations[idx].messages.unshift(newMsg);
        s.conversations[idx].unreadCount = (s.conversations[idx].unreadCount || 0) + 1;
      } else {
        s.conversations.unshift({ threadId: Date.now().toString(), address: msg.from,
          contactName: msg.contactName || msg.from, messages: [newMsg], unreadCount: 1 });
      }
      const sent2 = broadcast(token, { type: 'new_message', ...msg });
      log(`📩 New SMS from ${msg.from} → ${sent2} browser(s)`);
      break;
    }
    case 'sms_sent':
      broadcast(token, { type: 'sms_sent', ...msg });
      break;
  }
}

function handleBrowser(token, msg, ws) {
  const c = conn(token);
  switch (msg.type) {
    case 'send_sms':
      if (c.androidSocket?.readyState === WebSocket.OPEN) {
        msg.messageId = msg.messageId || crypto.randomUUID();
        c.androidSocket.send(JSON.stringify(msg));
        broadcast(token, { type: 'sms_queued', ...msg }, ws);
        ws.send(JSON.stringify({ type: 'sms_queued', messageId: msg.messageId }));
        log(`📤 SMS queued to ${msg.to}`);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Android is not connected' }));
      }
      break;
    case 'sync_request':
      if (c.androidSocket?.readyState === WebSocket.OPEN) {
        c.androidSocket.send(JSON.stringify({ type: 'sync_request' }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Android is not connected' }));
      }
      break;
  }
}

server.listen(PORT, '0.0.0.0', () => {
  log(`Server started on port ${PORT}`);
  console.log(`\n📱 SMS Bridge Server v2.0 running on port ${PORT}`);
  console.log(`🔍 Debug: http://localhost:${PORT}/debug\n`);
});
