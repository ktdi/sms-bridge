/**
 * QR Code generator - byte mode, ECC level M
 * Clean rewrite with verified finder patterns
 */

// GF(256) with primitive polynomial 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x; GF_LOG[x] = i;
        x = (x << 1) ^ (x & 0x80 ? 0x11D : 0);
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
    return (a && b) ? GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255] : 0;
}

function rsEncode(data, n) {
    // Build generator polynomial g(x) = product of (x - a^i) for i=0..n-1
    let g = new Uint8Array(n + 1); g[0] = 1;
    for (let i = 0; i < n; i++) {
        const newg = new Uint8Array(n + 1);
        for (let j = 0; j <= i; j++) {
            newg[j] ^= gfMul(g[j], GF_EXP[i]);
            newg[j+1] ^= g[j];
        }
        g = newg;
    }
    // Divide data polynomial by g
    const rem = new Uint8Array(n);
    for (const b of data) {
        const c = b ^ rem[0];
        for (let i = 0; i < n-1; i++) rem[i] = rem[i+1] ^ gfMul(c, g[n-1-i]);
        rem[n-1] = gfMul(c, g[0]);
    }
    return rem;
}

// Data capacity (bytes) for ECC M, byte mode, versions 1-10
const CAP_M = [0,14,26,42,62,84,106,122,154,182,216];

// [dataCodewords, eccPerBlock, numBlocks1, dataPerBlock1, numBlocks2, dataPerBlock2]
// blocks2 have +1 data codeword each
const BLOCK_CFG = [
    null,
    [16, 10, 1, 16, 0, 0],
    [28, 16, 1, 28, 0, 0],
    [44, 26, 1, 44, 0, 0],
    [64, 18, 2, 32, 0, 0],
    [86, 24, 2, 43, 0, 0],
    [108,16, 4, 27, 0, 0],
    [124,18, 4, 31, 0, 0],
    [154,22, 2, 38, 2, 39],
    [182,22, 3, 36, 2, 37],
    [216,26, 4, 43, 1, 44],
];

function makeQR(text) {
    const bytes = toUTF8(text);
    let ver = 1;
    while (ver <= 10 && CAP_M[ver] < bytes.length) ver++;
    if (ver > 10) throw new Error('Text too long (' + bytes.length + ' bytes)');

    const [dataCW, eccCW, nb1, db1, nb2, db2] = BLOCK_CFG[ver];
    const size = ver * 4 + 17;

    // --- Data bits ---
    const bits = [];
    const pushBits = (v, n) => { for (let i=n-1;i>=0;i--) bits.push((v>>i)&1); };
    pushBits(0b0100, 4);
    pushBits(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) pushBits(b, 8);
    for (let i=0; i<4 && bits.length < dataCW*8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const pads = [0xEC,0x11]; let pi=0;
    while (bits.length < dataCW*8) pushBits(pads[pi++%2], 8);

    const dBytes = bitsToBytes(bits, dataCW);

    // --- Split blocks & compute ECC ---
    const blocks=[], eccs=[];
    let off=0;
    for (let i=0;i<nb1;i++) { const b=dBytes.slice(off,off+db1); blocks.push(b); eccs.push(rsEncode(b,eccCW)); off+=db1; }
    for (let i=0;i<nb2;i++) { const b=dBytes.slice(off,off+db2); blocks.push(b); eccs.push(rsEncode(b,eccCW)); off+=db2; }

    // --- Interleave ---
    const cws=[];
    const maxD = Math.max(db1, db2||0);
    for (let i=0;i<maxD;i++) for (const b of blocks) if(i<b.length) cws.push(b[i]);
    for (let i=0;i<eccCW;i++) for (const e of eccs) cws.push(e[i]);

    // Remainder bits
    const REM=[0,0,7,7,7,7,7,0,0,0,0];
    const cwBits=[];
    for (const cw of cws) pushBits2(cwBits, cw, 8);
    for (let i=0;i<REM[ver];i++) cwBits.push(0);

    // --- Build matrix ---
    const mat = Array.from({length:size},()=>new Int8Array(size).fill(-1));

    // Finder patterns (using explicit lookup table)
    const FP = [[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],
                [1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]];
    const setFP = (row, col) => {
        for (let r=0;r<7;r++) for (let c=0;c<7;c++) mat[row+r][col+c]=FP[r][c];
        // Separator (ring of 0s around finder)
        for (let i=-1;i<=7;i++) {
            const rr=row+i, cc=col+i;
            if(rr>=0&&rr<size) { if(col-1>=0) mat[rr][col-1]=0; if(col+7<size) mat[rr][col+7]=0; }
            if(cc>=0&&cc<size) { if(row-1>=0) mat[row-1][cc]=0; if(row+7<size) mat[row+7][cc]=0; }
        }
    };
    setFP(0,0); setFP(0,size-7); setFP(size-7,0);

    // Timing patterns
    for(let i=8;i<size-8;i++){
        mat[6][i]= i%2===0?1:0;
        mat[i][6]= i%2===0?1:0;
    }

    // Dark module
    mat[size-8][8]=1;

    // Alignment patterns
    const AP=[,[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
    if(AP[ver]) {
        const pos=AP[ver];
        for(const r of pos) for(const c of pos) {
            if(mat[r][c]!==-1) continue;
            for(let dr=-2;dr<=2;dr++) for(let dc=-2;dc<=2;dc++) {
                const isEdge=Math.abs(dr)===2||Math.abs(dc)===2;
                const isCtr=dr===0&&dc===0;
                mat[r+dr][c+dc]=isEdge||isCtr?1:0;
            }
        }
    }

    // Reserve format info modules (so placeData skips them)
    const reserveFormat = (r,c) => { if(mat[r][c]===-1) mat[r][c]=0; };
    for(let i=0;i<=8;i++) { reserveFormat(8,i); reserveFormat(i,8); }
    reserveFormat(8,7); // already done
    for(let i=0;i<8;i++) { reserveFormat(8,size-1-i); reserveFormat(size-1-i,8); }

    // Place data
    placeDataBits(mat, cwBits, size);

    // Choose best mask
    const fmtBits = getFormatBitsM();
    let bestMask=0, bestPen=Infinity;
    for(let m=0;m<8;m++) {
        const tmp=mat.map(r=>new Int8Array(r));
        maskMatrix(tmp,m,size);
        applyFormatInfo(tmp,fmtBits[m],size);
        const pen=penalty(tmp,size);
        if(pen<bestPen){bestPen=pen;bestMask=m;}
    }
    maskMatrix(mat,bestMask,size);
    applyFormatInfo(mat,fmtBits[bestMask],size);
    return mat;
}

function toUTF8(s) {
    const b=[];
    for(let i=0;i<s.length;i++){
        const c=s.charCodeAt(i);
        if(c<0x80) b.push(c);
        else if(c<0x800){b.push(0xC0|(c>>6));b.push(0x80|(c&0x3F));}
        else{b.push(0xE0|(c>>12));b.push(0x80|((c>>6)&0x3F));b.push(0x80|(c&0x3F));}
    }
    return b;
}

function bitsToBytes(bits, n) {
    const out=new Uint8Array(n);
    for(let i=0;i<n;i++) for(let b=0;b<8;b++) out[i]=(out[i]<<1)|bits[i*8+b];
    return out;
}

function pushBits2(arr,v,n){for(let i=n-1;i>=0;i--)arr.push((v>>i)&1);}

function placeDataBits(mat, bits, size) {
    let idx=0;
    for(let right=size-1;right>=1;right-=2){
        if(right===6) right=5;
        for(let vert=0;vert<size;vert++){
            for(let j=0;j<2;j++){
                const col=right-j;
                const row=((right+1)&2)===0?size-1-vert:vert;
                if(mat[row][col]===-1){
                    mat[row][col]=idx<bits.length?bits[idx++]:0;
                }
            }
        }
    }
}

const MASK_FNS=[
    (r,c)=>(r+c)%2===0,
    (r,c)=>r%2===0,
    (r,c)=>c%3===0,
    (r,c)=>(r+c)%3===0,
    (r,c)=>(Math.floor(r/2)+Math.floor(c/3))%2===0,
    (r,c)=>(r*c)%2+(r*c)%3===0,
    (r,c)=>((r*c)%2+(r*c)%3)%2===0,
    (r,c)=>((r+c)%2+(r*c)%3)%2===0,
];

function isData(r,c,size){
    if(r===6||c===6) return false;
    if(r<9&&c<9) return false;
    if(r<9&&c>=size-8) return false;
    if(r>=size-8&&c<9) return false;
    if(r===8||c===8) return false;
    return true;
}

function maskMatrix(mat,m,size){
    const fn=MASK_FNS[m];
    for(let r=0;r<size;r++)
        for(let c=0;c<size;c++)
            if(isData(r,c,size)&&fn(r,c)) mat[r][c]^=1;
}

// Format info for ECC level M (bits: 00) xor'd with mask pattern 101010000010010
function getFormatBitsM(){
    const out=[];
    for(let mask=0;mask<8;mask++){
        const data=(0b00<<3)|mask; // ECC M=00, 3 mask bits
        let rem=data<<10;
        for(let i=14;i>=10;i--) if((rem>>i)&1) rem^=0x537<<(i-10);
        out.push(((data<<10)|(rem&0x3FF))^0x5412);
    }
    return out;
}

function applyFormatInfo(mat,fmt,size){
    const bits=[];
    for(let i=14;i>=0;i--) bits.push((fmt>>i)&1);
    // Top-left positions
    const p=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    for(let i=0;i<15;i++) mat[p[i][0]][p[i][1]]=bits[i];
    // Bottom-left and top-right
    for(let i=0;i<7;i++) mat[size-1-i][8]=bits[i];
    mat[size-8][8]=1; // dark module
    for(let i=7;i<15;i++) mat[8][size-15+i]=bits[i];
}

function penalty(mat,size){
    let p=0;
    for(let r=0;r<size;r++){let n=1;for(let c=1;c<size;c++){if(mat[r][c]===mat[r][c-1]){n++;if(n===5)p+=3;else if(n>5)p++;}else n=1;}}
    for(let c=0;c<size;c++){let n=1;for(let r=1;r<size;r++){if(mat[r][c]===mat[r-1][c]){n++;if(n===5)p+=3;else if(n>5)p++;}else n=1;}}
    for(let r=0;r<size-1;r++) for(let c=0;c<size-1;c++) if(mat[r][c]===mat[r+1][c]&&mat[r][c]===mat[r][c+1]&&mat[r][c]===mat[r+1][c+1]) p+=3;
    return p;
}

function qrToSvg(text, px=6) {
    const mat=makeQR(text);
    const n=mat.length, q=4, total=(n+q*2)*px;
    let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}">`;
    svg+=`<rect width="${total}" height="${total}" fill="white"/>`;
    for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(mat[r][c]===1)
        svg+=`<rect x="${(c+q)*px}" y="${(r+q)*px}" width="${px}" height="${px}" fill="black"/>`;
    svg+='</svg>';
    return svg;
}




/**
 * SMS Bridge Server v2 - with full debug logging
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ── In-memory state ──────────────────────────────────────────────────────────
const deviceState  = new Map(); // token → { conversations, lastSync, deviceName }
const connections  = new Map(); // token → { androidSocket, browserSockets: Set }
const serverLog    = [];        // recent log lines for /debug page

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
  if (!c) return;
  const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
  let sent = 0;
  c.browserSockets.forEach(ws => {
    if (ws !== skip && ws.readyState === WebSocket.OPEN) { ws.send(s); sent++; }
  });
  return sent;
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Debug page — visit http://localhost:3000/debug to see live status
  if (req.url.startsWith('/qr')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const token = (params.get('token') || '').trim();
    if (!token) { res.writeHead(400); res.end('Missing token'); return; }

    const fwdHost = req.headers['x-forwarded-host'] || '';
    const fwdProto = req.headers['x-forwarded-proto'] || '';
    const host = (fwdHost || req.headers.host || '').split(',')[0].trim();
    const isLocalhost = host.startsWith('localhost') || host.startsWith('127.');
    const isHttps = fwdProto === 'https' || (!isLocalhost && !host.includes(':'));
    const wsUrl = (!isLocalhost && host)
      ? (isHttps ? 'wss' : 'ws') + '://' + host
      : 'ws://localhost:' + PORT;

    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      const qrText = JSON.stringify({ url: wsUrl, token });
      const svg = qrToSvg(qrText, 6);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      res.end(svg);
    } catch(e) {
      res.writeHead(500, {'Content-Type':'text/plain'}); res.end('QR error: ' + e.message);
    }
    return;
  }

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

  // Serve web client
  const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(baseDir, urlPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css'};
    res.writeHead(200, {'Content-Type': mime[ext]||'text/plain'});
    res.end(fs.readFileSync(filePath));
  } else {
    // Serve embedded HTML fallback
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(EMBEDDED_HTML);
  }
});

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let urlObj;
  try { urlObj = new URL(req.url, 'http://localhost'); }
  catch(e) { ws.close(1008, 'Bad URL'); return; }

  const clientType = urlObj.searchParams.get('type') || 'browser';
  const token      = (urlObj.searchParams.get('token') || '').trim();

  if (!token) {
    log(`⚠️  Connection rejected — no token provided (type=${clientType})`);
    ws.close(1008, 'Missing token');
    return;
  }

  const shortToken = token.substring(0, 4) + '****';
  log(`🔌 New ${clientType} connection [${shortToken}] from ${req.socket.remoteAddress}`);

  const c = conn(token);

  if (clientType === 'android') {
    // Close old Android socket if reconnecting
    if (c.androidSocket && c.androidSocket.readyState === WebSocket.OPEN) {
      log(`♻️  Replacing existing Android socket [${shortToken}]`);
      c.androidSocket.close(1000, 'Replaced by new connection');
    }
    c.androidSocket = ws;
    broadcast(token, { type: 'android_status', online: true });
    ws.send(JSON.stringify({ type: 'connected', message: 'Server ready — send sync_data' }));
    log(`✅ Android registered [${shortToken}] — ${c.browserSockets.size} browser(s) waiting`);

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        log(`📨 Android→Server [${shortToken}] type=${msg.type}${msg.type==='sync_data'?' convos='+( msg.conversations?.length||0):''}`);
        handleAndroid(token, msg);
      } catch(e) { log(`❌ Bad JSON from Android: ${e.message}`); }
    });

    ws.on('close', (code, reason) => {
      log(`📴 Android disconnected [${shortToken}] code=${code}`);
      if (c.androidSocket === ws) c.androidSocket = null;
      broadcast(token, { type: 'android_status', online: false });
    });

    ws.on('error', e => log(`❌ Android socket error [${shortToken}]: ${e.message}`));

  } else {
    // Browser
    c.browserSockets.add(ws);
    const s = state(token);
    const androidOnline = c.androidSocket?.readyState === WebSocket.OPEN;
    log(`🌐 Browser connected [${shortToken}] — android=${androidOnline} convos=${s.conversations.length}`);

    // Send current state immediately
    ws.send(JSON.stringify({
      type: 'initial_state',
      conversations: s.conversations,
      lastSync: s.lastSync,
      deviceName: s.deviceName,
      androidOnline
    }));

    // If Android is connected, ask it to sync fresh data
    if (androidOnline) {
      log(`🔄 Requesting fresh sync from Android [${shortToken}]`);
      c.androidSocket.send(JSON.stringify({ type: 'sync_request' }));
    }

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        log(`📨 Browser→Server [${shortToken}] type=${msg.type}`);
        handleBrowser(token, msg, ws);
      } catch(e) { log(`❌ Bad JSON from browser: ${e.message}`); }
    });

    ws.on('close', () => {
      c.browserSockets.delete(ws);
      log(`🌐 Browser disconnected [${shortToken}] — ${c.browserSockets.size} remaining`);
    });

    ws.on('error', e => log(`❌ Browser socket error [${shortToken}]: ${e.message}`));
  }
});

function handleAndroid(token, msg) {
  const s = state(token);
  switch (msg.type) {
    case 'register':
      s.deviceName = msg.deviceName || 'Android';
      log(`📱 Device registered: ${s.deviceName}`);
      broadcast(token, { type: 'device_info', deviceName: s.deviceName, online: true });
      break;

    case 'sync_data': {
      s.conversations = msg.conversations || [];
      s.lastSync = Date.now();
      const sent = broadcast(token, { type: 'sync_data', conversations: s.conversations, lastSync: s.lastSync });
      log(`✅ Sync: ${s.conversations.length} conversations → broadcast to ${sent} browser(s)`);
      break;
    }

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
      const sent = broadcast(token, { type: 'new_message', ...msg });
      log(`📩 New SMS from ${msg.from} → ${sent} browser(s)`);
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
        log(`📤 Send SMS to ${msg.to} queued`);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Android is not connected' }));
        log(`⚠️  Send SMS failed — Android offline`);
      }
      break;

    case 'sync_request':
      if (c.androidSocket?.readyState === WebSocket.OPEN) {
        c.androidSocket.send(JSON.stringify({ type: 'sync_request' }));
        log(`🔄 Manual sync requested`);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Android is not connected' }));
      }
      break;
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
function getLocalIP() {
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets))
      for (const net of nets[name])
        if (net.family === 'IPv4' && !net.internal) return net.address;
  } catch {}
  return 'YOUR_PC_IP';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  log(`Server started on port ${PORT}`);
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         📱 SMS Bridge Server  v2.0               ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Web UI:      http://localhost:${PORT}               ║`);
  console.log(`║  Network:     http://${ip}:${PORT}         ║`);
  console.log(`║  Android URL: ws://${ip}:${PORT}          ║`);
  console.log(`║  Debug page:  http://localhost:${PORT}/debug         ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Ctrl+C to stop                                  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  try { require('child_process').exec(`${process.platform==='win32'?'start':process.platform==='darwin'?'open':'xdg-open'} http://localhost:${PORT}`); } catch {}
});
