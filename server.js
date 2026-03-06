// QR Code generator - byte mode, ECC level M
// (All QR generation functions - unchanged from your original)

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
    let g = new Uint8Array(n + 1); g[0] = 1;
    for (let i = 0; i < n; i++) {
        const newg = new Uint8Array(n + 1);
        for (let j = 0; j <= i; j++) {
            newg[j] ^= gfMul(g[j], GF_EXP[i]);
            newg[j+1] ^= g[j];
        }
        g = newg;
    }
    const result = new Uint8Array([...data, ...new Uint8Array(n)]);
    for (let i = 0; i < data.length; i++) {
        const c = result[i];
        if (c !== 0) for (let j = 0; j < g.length; j++) result[i+j] ^= gfMul(g[j], c);
    }
    return result.slice(data.length);
}

const CAP_M = [0,14,26,42,62,84,106,122,154,182,216];

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

    const blocks=[], eccs=[];
    let off=0;
    for (let i=0;i<nb1;i++) { const b=dBytes.slice(off,off+db1); blocks.push(b); eccs.push(rsEncode(b,eccCW)); off+=db1; }
    for (let i=0;i<nb2;i++) { const b=dBytes.slice(off,off+db2); blocks.push(b); eccs.push(rsEncode(b,eccCW)); off+=db2; }

    const cws=[];
    const maxD = Math.max(db1, db2||0);
    for (let i=0;i<maxD;i++) for (const b of blocks) if(i<b.length) cws.push(b[i]);
    for (let i=0;i<eccCW;i++) for (const e of eccs) cws.push(e[i]);

    const REM=[0,0,7,7,7,7,7,0,0,0,0];
    const cwBits=[];
    for (const cw of cws) pushBits2(cwBits, cw, 8);
    for (let i=0;i<REM[ver];i++) cwBits.push(0);

    const mat = Array.from({length:size},()=>new Int8Array(size).fill(-1));

    const FP = [[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],
                [1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]];
    const setFP = (row, col) => {
        for (let r=0;r<7;r++) for (let c=0;c<7;c++) mat[row+r][col+c]=FP[r][c];
        for (let i=-1;i<=7;i++) {
            const rr=row+i, cc=col+i;
            if(rr>=0&&rr<size) { if(col-1>=0) mat[rr][col-1]=0; if(col+7<size) mat[rr][col+7]=0; }
            if(cc>=0&&cc<size) { if(row-1>=0) mat[row-1][cc]=0; if(row+7<size) mat[row+7][cc]=0; }
        }
    };
    setFP(0,0); setFP(0,size-7); setFP(size-7,0);

    for(let i=8;i<size-8;i++){
        mat[6][i]= i%2===0?1:0;
        mat[i][6]= i%2===0?1:0;
    }

    mat[size-8][8]=1;

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

    const reserveFormat = (r,c) => { if(mat[r][c]===-1) mat[r][c]=0; };
    for(let i=0;i<=8;i++) { reserveFormat(8,i); reserveFormat(i,8); }
    reserveFormat(8,7);
    for(let i=0;i<8;i++) { reserveFormat(8,size-1-i); reserveFormat(size-1-i,8); }

    placeDataBits(mat, cwBits, size);

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
    if(r<8&&c<8) return false;
    if(r<8&&c>=size-8) return false;
    if(r>=size-8&&c<8) return false;
    if(c===8&&r<9) return false;
    if(c===8&&r>=size-8) return false;
    if(r===8&&c<9) return false;
    if(r===8&&c>=size-8) return false;
    if(r===7&&c<=7) return false;
    if(c===7&&r<=7) return false;
    if(r===7&&c>=size-8) return false;
    if(c===size-8&&r<=7) return false;
    if(r===size-8&&c<=7) return false;
    if(c===7&&r>=size-8) return false;
    return true;
}

function maskMatrix(mat,m,size){
    const fn=MASK_FNS[m];
    for(let r=0;r<size;r++)
        for(let c=0;c<size;c++)
            if(isData(r,c,size)&&fn(r,c)) mat[r][c]^=1;
}

function getFormatBitsM(){
    const out=[];
    for(let mask=0;mask<8;mask++){
        const data=(0b00<<3)|mask;
        let rem=data<<10;
        for(let i=14;i>=10;i--) if((rem>>i)&1) rem^=0x537<<(i-10);
        out.push(((data<<10)|(rem&0x3FF))^0x5412);
    }
    return out;
}

function applyFormatInfo(mat,fmt,size){
    const bits=[];
    for(let i=14;i>=0;i--) bits.push((fmt>>i)&1);
    const p=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    for(let i=0;i<15;i++) mat[p[i][0]][p[i][1]]=bits[i];
    for(let i=0;i<7;i++) mat[size-1-i][8]=bits[i];
    mat[size-8][8]=1;
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
    svg+=`</svg>`;
    return svg;
}

// ── HTTP + WS Server ────────────────────────────────────────────────────────

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const connections = new Map();
const deviceState = new Map();
const serverLog = [];

function log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${msg}`);
    serverLog.push(`[${ts}] ${msg}`);
    if (serverLog.length > 100) serverLog.shift();
}

function conn(token) {
    if (!connections.has(token)) connections.set(token, { browserSockets: new Set() });
    return connections.get(token);
}

function state(token) {
    if (!deviceState.has(token)) deviceState.set(token, { conversations: [] });
    return deviceState.get(token);
}

function broadcast(token, msg, excludeWs = null) {
    const c = conn(token);
    let count = 0;
    c.browserSockets.forEach(ws => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
            count++;
        }
    });
    return count;
}

const EMBEDDED_HTML = `<!DOCTYPE html><html><body><h1>SMS Bridge</h1><p>Use the web UI at /</p></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/debug') {
    // ... debug page code (unchanged) ...
    let rows = [];
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
    // ... status JSON (unchanged) ...
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

  // QR code endpoint
  if (req.url.startsWith('/qr')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const token = urlObj.searchParams.get('token')?.trim();

    if (!token || token.length < 8) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing or invalid token');
      return;
    }

    const pairingUrl = `wss://${req.headers.host}/?type=android&token=${encodeURIComponent(token)}`;

    try {
      const svg = qrToSvg(pairingUrl, 5);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    } catch (err) {
      log(`QR generation error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('QR generation failed');
    }
    return;
  }

  // Static files
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
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(EMBEDDED_HTML);
  }
});

const wss = new WebSocket.Server({ server });

// ... rest of WebSocket logic (on connection, handleAndroid, handleBrowser, etc.) unchanged ...

// (Paste the remaining wss.on('connection'), handleAndroid, handleBrowser, getLocalIP, server.listen code from your original here)

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