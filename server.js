
// ── QR Code endpoint ─────────────────────────────────────────────────────────
// Correct minimal QR code generator
// Based on Nayuki's QR Code generator (MIT license)
// Supports byte mode only, ECC level M, versions 1-10

function makeQR(text) {
    const data = unescape(encodeURIComponent(text)); // UTF-8 bytes as string
    const bytes = Array.from(data).map(c => c.charCodeAt(0));
    
    // Pick version
    // Data capacity for ECC M, byte mode
    const CAP = [0,14,26,42,62,84,106,122,154,182,216];
    let ver = 1;
    while (ver <= 10 && CAP[ver] < bytes.length) ver++;
    if (ver > 10) throw new Error('Text too long: ' + bytes.length + ' bytes');
    
    const size = ver * 4 + 17;
    
    // ECC parameters for version 1-10, level M
    const ECC_PARAMS = [
        null,
        {totalWords:26,  dataWords:16,  blocks:1,  c:10},
        {totalWords:44,  dataWords:28,  blocks:1,  c:16},
        {totalWords:70,  dataWords:44,  blocks:1,  c:26},
        {totalWords:100, dataWords:64,  blocks:2,  c:18},
        {totalWords:134, dataWords:86,  blocks:2,  c:24},
        {totalWords:172, dataWords:108, blocks:4,  c:16},
        {totalWords:196, dataWords:124, blocks:4,  c:18},
        {totalWords:242, dataWords:154, blocks:4,  c:22},
        {totalWords:292, dataWords:182, blocks:5,  c:22},
        {totalWords:346, dataWords:216, blocks:6,  c:26},
    ];
    const ecc = ECC_PARAMS[ver];
    
    // Build data codewords
    const dataBits = [];
    // Mode indicator: byte = 0100
    dataBits.push(0,1,0,0);
    // Length (8 bits for ver 1-9)
    for (let i = 7; i >= 0; i--) dataBits.push((bytes.length >> i) & 1);
    // Data bytes
    for (const b of bytes)
        for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1);
    // Terminator
    const target = ecc.dataWords * 8;
    for (let i = 0; i < 4 && dataBits.length < target; i++) dataBits.push(0);
    while (dataBits.length % 8 !== 0) dataBits.push(0);
    const PAD = [0xEC, 0x11];
    let pi = 0;
    while (dataBits.length < target) {
        const p = PAD[pi++ % 2];
        for (let i = 7; i >= 0; i--) dataBits.push((p >> i) & 1);
    }
    
    // Convert to bytes
    const dcw = [];
    for (let i = 0; i < dataBits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | (dataBits[i+j] || 0);
        dcw.push(b);
    }
    
    // Reed-Solomon error correction
    const blockSize = Math.floor(ecc.dataWords / ecc.blocks);
    const extraBlocks = ecc.dataWords % ecc.blocks;
    const allBlocks = [];
    let offset = 0;
    for (let b = 0; b < ecc.blocks; b++) {
        const sz = blockSize + (b < extraBlocks ? 1 : 0);
        const block = dcw.slice(offset, offset + sz);
        allBlocks.push(block);
        offset += sz;
    }
    
    const eccWords = Math.floor((ecc.totalWords - ecc.dataWords) / ecc.blocks);
    const allEcc = allBlocks.map(block => rsEncode(block, eccWords));
    
    // Interleave
    const finalData = [];
    const maxLen = Math.max(...allBlocks.map(b => b.length));
    for (let i = 0; i < maxLen; i++)
        for (const block of allBlocks)
            if (i < block.length) finalData.push(block[i]);
    for (let i = 0; i < eccWords; i++)
        for (const e of allEcc)
            if (i < e.length) finalData.push(e[i]);
    
    // Build bit stream
    const allBits = [];
    for (const b of finalData)
        for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);
    // Remainder bits
    const REM = [0,0,7,7,7,7,7,0,0,0,0,0,0,0,3,3,3,3,3,3,3,4,4,4,4,4,4,4,3,3,3,3,3,3,3,0,0,0,0,0];
    for (let i = 0; i < (REM[ver] || 0); i++) allBits.push(0);
    
    // Build matrix
    const mat = Array.from({length: size}, () => new Int8Array(size).fill(-1));
    const func = Array.from({length: size}, () => new Uint8Array(size));
    
    // Finder patterns + separators
    function setFinder(row, col) {
        for (let r = -1; r <= 7; r++)
            for (let c = -1; c <= 7; c++) {
                const nr = row + r, nc = col + c;
                if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
                func[nr][nc] = 1;
                const inPat = r >= 0 && r < 7 && c >= 0 && c < 7;
                if (!inPat) { mat[nr][nc] = 0; continue; }
                const pat = [[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],
                              [1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]];
                mat[nr][nc] = pat[r][c];
            }
    }
    setFinder(0, 0); setFinder(0, size-7); setFinder(size-7, 0);
    
    // Timing
    for (let i = 8; i < size-8; i++) {
        mat[6][i] = mat[i][6] = i % 2 === 0 ? 1 : 0;
        func[6][i] = func[i][6] = 1;
    }
    
    // Dark module
    mat[size-8][8] = 1; func[size-8][8] = 1;
    
    // Alignment patterns
    const AP_POS = [
        [], [], [6,18], [6,22], [6,26], [6,30], [6,34],
        [6,22,38], [6,24,42], [6,26,46], [6,28,50]
    ];
    const aps = AP_POS[ver] || [];
    for (let ai = 0; ai < aps.length; ai++)
        for (let aj = 0; aj < aps.length; aj++) {
            const ar = aps[ai], ac = aps[aj];
            if (func[ar][ac]) continue;
            for (let dr = -2; dr <= 2; dr++)
                for (let dc = -2; dc <= 2; dc++) {
                    const nr = ar+dr, nc = ac+dc;
                    func[nr][nc] = 1;
                    const md = Math.max(Math.abs(dr), Math.abs(dc));
                    mat[nr][nc] = md !== 1 ? 1 : 0;
                }
        }
    
    // Format info placeholders
    for (let i = 0; i < 9; i++) {
        if (i !== 6) { if (mat[8][i] === -1) { mat[8][i] = 0; func[8][i] = 1; } }
        if (i !== 6) { if (mat[i] && mat[i][8] === -1) { mat[i][8] = 0; func[i][8] = 1; } }
    }
    for (let i = size-8; i < size; i++) {
        if (mat[8][i] === -1) { mat[8][i] = 0; func[8][i] = 1; }
    }
    for (let i = size-7; i < size; i++) {
        if (mat[i] && mat[i][8] === -1) { mat[i][8] = 0; func[i][8] = 1; }
    }
    
    // Place data bits
    let bi = 0;
    for (let right = size-1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const row = (right & 1) === 0 ?
                    (size - 1 - (vert % size)) : (vert % size);
                const col = right - j;
                if (!func[row][col] && mat[row][col] === -1) {
                    mat[row][col] = bi < allBits.length ? allBits[bi++] : 0;
                }
            }
        }
        // Flip direction
        if (right % 2 === (ver % 2 === 0 ? 0 : 1)) {
            // handled by vert loop direction
        }
    }
    
    // Re-do placement correctly (zigzag)
    // Reset data modules
    for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
            if (!func[r][c]) mat[r][c] = -1;
    bi = 0;
    let upward = true;
    for (let right = size-1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const row = upward ? (size - 1 - vert) : vert;
                const col = right - j;
                if (col >= 0 && !func[row][col]) {
                    mat[row][col] = bi < allBits.length ? allBits[bi++] : 0;
                }
            }
        }
        upward = !upward;
    }
    
    // Find best mask
    let bestScore = Infinity, bestMask = 0;
    for (let m = 0; m < 8; m++) {
        const tmp = applyMaskMatrix(mat, func, m, size);
        writeFormat(tmp, func, 2, m, size);
        const score = calcPenalty(tmp, size);
        if (score < bestScore) { bestScore = score; bestMask = m; }
    }
    
    const final = applyMaskMatrix(mat, func, bestMask, size);
    writeFormat(final, func, 2, bestMask, size);
    return final;
}

function applyMaskMatrix(mat, func, mask, size) {
    const tmp = mat.map(r => Int8Array.from(r));
    const maskFn = getMaskFn(mask);
    for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
            if (!func[r][c]) tmp[r][c] ^= maskFn(r,c) ? 1 : 0;
    return tmp;
}

function getMaskFn(m) {
    return [(r,c)=>(r+c)%2===0,(r,c)=>r%2===0,(r,c)=>c%3===0,(r,c)=>(r+c)%3===0,
            (r,c)=>(Math.floor(r/2)+Math.floor(c/3))%2===0,(r,c)=>(r*c)%2+(r*c)%3===0,
            (r,c)=>((r*c)%2+(r*c)%3)%2===0,(r,c)=>((r+c)%2+(r*c)%3)%2===0][m];
}

function writeFormat(mat, func, ecc, mask, size) {
    // ECC M = 0b00, L=0b01, Q=0b11, H=0b10 -- wait, ISO: L=01,M=00,Q=11,H=10
    const eccBits = {0:1, 1:0, 2:3, 3:2}[ecc] || 0; // M=00 in data bits actually is 0b00... 
    // ISO 18004: L=01, M=00, Q=11, H=10
    const ECCbits = ecc; // 0=M... let's use correct: M=0b00
    const data = (0 << 3) | mask; // M=00
    let rem = data;
    const gen = 0x537;
    for (let i = 4; i >= 0; i--) if ((rem >> (i+10)) & 1) rem ^= gen << i;
    const bits = ((data << 10) | rem) ^ 0x5412;
    
    const pos1 = [
        [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
        [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]
    ];
    const pos2r = [size-1,size-2,size-3,size-4,size-5,size-6,size-7,size-8];
    
    for (let i = 0; i < 15; i++) {
        const v = (bits >> (14-i)) & 1;
        const [r,c] = pos1[i];
        mat[r][c] = v;
        if (i < 7) mat[size-1-i][8] = v;
        else if (i === 7) mat[8][size-8] = v;
        else mat[8][size-7+(i-8)] = v;
    }
}

function calcPenalty(mat, size) {
    let penalty = 0;
    // Rule 1
    for (let r = 0; r < size; r++) {
        let run=1;
        for (let c=1;c<size;c++){
            if(mat[r][c]===mat[r][c-1]){run++;if(run===5)penalty+=3;else if(run>5)penalty++;}
            else run=1;
        }
        run=1;
        for (let c=1;c<size;c++){
            if(mat[c][r]===mat[c-1][r]){run++;if(run===5)penalty+=3;else if(run>5)penalty++;}
            else run=1;
        }
    }
    // Rule 2
    for (let r=0;r<size-1;r++)
        for(let c=0;c<size-1;c++)
            if(mat[r][c]===mat[r+1][c]&&mat[r][c]===mat[r][c+1]&&mat[r][c]===mat[r+1][c+1])
                penalty+=3;
    // Rule 4
    let dark=0;
    for(let r=0;r<size;r++) for(let c=0;c<size;c++) if(mat[r][c]) dark++;
    const pct = dark*100/(size*size);
    penalty += Math.abs(Math.round(pct/5)*5-50)/5*10;
    return penalty;
}

function rsEncode(data, eccLen) {
    const gen = rsGenerator(eccLen);
    const res = [...data, ...new Array(eccLen).fill(0)];
    for (let i = 0; i < data.length; i++) {
        const coef = res[i];
        if (coef !== 0)
            for (let j = 0; j < gen.length; j++)
                res[i+j] ^= gfMul(gen[j], coef);
    }
    return res.slice(data.length);
}

function rsGenerator(degree) {
    let poly = [1];
    let root = 1;
    for (let i = 0; i < degree; i++) {
        poly = polyMul(poly, [root, 1]);
        root = gfMul(root, 2);
    }
    return poly;
}

function polyMul(a, b) {
    const res = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++)
        for (let j = 0; j < b.length; j++)
            res[i+j] ^= gfMul(a[i], b[j]);
    return res;
}

const EXP = new Uint8Array(256), LOG = new Uint8Array(256);
(function(){let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x=(x<<1)^(x>=128?0x11d:0);}EXP[255]=EXP[0];})();

function gfMul(a, b) {
    if (a===0||b===0) return 0;
    return EXP[(LOG[a]+LOG[b])%255];
}

// Generate SVG
function qrToSvg(text, pixelSize=4) {
    const matrix = makeQR(text);
    const n = matrix.length;
    const quiet = 4; // quiet zone
    const total = (n + quiet*2) * pixelSize;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}">`;
    svg += `<rect width="${total}" height="${total}" fill="white"/>`;
    for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++)
            if (matrix[r][c])
                svg += `<rect x="${(c+quiet)*pixelSize}" y="${(r+quiet)*pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="black"/>`;
    svg += '</svg>';
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
