const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'idms.json');
const LOGIN_EMAIL = (process.env.IDMS_EMAIL || 'physicalsecurity@gbb.com.ng').toLowerCase();
const LOGIN_PASSWORD = process.env.IDMS_PASSWORD || 'Password12';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
let writeQueue = Promise.resolve();

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ batches: [], history: [] }, null, 2));
}
function readData() {
  ensureDataFile();
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { batches: Array.isArray(d.batches) ? d.batches : [], history: Array.isArray(d.history) ? d.history : [] };
  } catch { return { batches: [], history: [] }; }
}
function writeData(data) {
  writeQueue = writeQueue.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, DATA_FILE);
  });
  return writeQueue;
}
function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) result[k] = decodeURIComponent(v.join('='));
  }
  return result;
}
function sessionUser(req) {
  const token = cookies(req).idms_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session.user;
}
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}
function requireAuth(req, res) {
  const user = sessionUser(req);
  if (!user) { send(res, 401, { error: 'Authentication required.' }); return null; }
  return user;
}
function parseJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function addHistory(data, action, details) {
  data.history.unshift({ id: 'HIST-' + crypto.randomUUID(), action, details, timestamp: new Date().toISOString(), user: LOGIN_EMAIL });
  data.history = data.history.slice(0, 300);
}
function findRecord(data, id) {
  for (const batch of data.batches) {
    const index = (batch.records || []).findIndex(r => r.id === id);
    if (index >= 0) return { batch, record: batch.records[index] };
  }
  return null;
}
function mime(file) {
  return ({ '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.json':'application/json' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, file);
  if (!full.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'POST' && p === '/api/login') {
    try {
      const body = await parseJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (email !== LOGIN_EMAIL || password !== LOGIN_PASSWORD) return send(res, 401, { error: 'Invalid email or password.' });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { user: { email: LOGIN_EMAIL }, expiresAt: Date.now() + SESSION_TTL_MS });
      return send(res, 200, { ok: true, user: { email: LOGIN_EMAIL } }, { 'Set-Cookie': `idms_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}` });
    } catch { return send(res, 400, { error: 'Invalid request.' }); }
  }
  if (req.method === 'POST' && p === '/api/logout') {
    const token = cookies(req).idms_session; if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'idms_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' });
  }
  if (req.method === 'GET' && p === '/health') { return send(res, 200, { ok: true, service: 'GBB IDMS' }); }
  if (req.method === 'GET' && p === '/api/me') {
    const user = requireAuth(req, res); if (!user) return; return send(res, 200, { user });
  }
  if (req.method === 'GET' && p === '/api/state') {
    const user = requireAuth(req, res); if (!user) return; return send(res, 200, readData());
  }

  const user = (p.startsWith('/api/') ? requireAuth(req, res) : true);
  if (!user) return;

  if (req.method === 'POST' && p === '/api/import') {
    try {
      const body = await parseJson(req);
      const fileName = String(body.fileName || '').trim();
      const records = Array.isArray(body.records) ? body.records : [];
      if (!fileName || !records.length) return send(res, 400, { error: 'A filename and at least one personnel record are required.' });
      const now = new Date().toISOString();
      const normalized = records.map(r => ({ id:'REC-'+crypto.randomUUID(), name:String(r.name||'').trim(), endDate:r.endDate||null, position:String(r.position||'').trim(), employeeId:String(r.employeeId||'').trim(), status:'Awaiting Capture', importedAt:now, capturedAt:null, pendingAt:null, collectedAt:null }));
      const data = readData();
      const batch = { id:'BATCH-'+crypto.randomUUID(), fileName, importedAt:now, records:normalized };
      data.batches.unshift(batch);
      addHistory(data, 'HR personnel file imported', `${fileName} imported with ${normalized.length} personnel record${normalized.length===1?'':'s'}.`);
      await writeData(data);
      return send(res, 201, { batch });
    } catch { return send(res, 400, { error: 'Unable to import the personnel records.' }); }
  }

  let m;
  if (req.method === 'PATCH' && (m=p.match(/^\/api\/personnel\/([^/]+)\/(capture|collect)$/))) {
    const id = decodeURIComponent(m[1]), action = m[2], data = readData(), found = findRecord(data,id);
    if (!found) return send(res,404,{error:'Personnel record not found.'});
    if (action === 'capture') {
      if (found.record.status !== 'Awaiting Capture') return send(res,409,{error:'This person is no longer awaiting capture.'});
      const now=new Date().toISOString(); found.record.status='Pending'; found.record.capturedAt=now; found.record.pendingAt=now;
      addHistory(data,'Personnel captured',`${found.record.name} was captured and moved to Pending Collection.`);
    } else {
      if (found.record.status !== 'Pending') return send(res,409,{error:'This ID card is not currently pending collection.'});
      found.record.status='Collected'; found.record.collectedAt=new Date().toISOString();
      addHistory(data,'ID card collected',`${found.record.name} collected their ID card.`);
    }
    await writeData(data); return send(res,200,{record:found.record});
  }
  if (req.method === 'DELETE' && (m=p.match(/^\/api\/batches\/([^/]+)$/))) {
    const id=decodeURIComponent(m[1]), data=readData(), batch=data.batches.find(b=>b.id===id);
    if (!batch) return send(res,404,{error:'Submission batch not found.'});
    data.batches=data.batches.filter(b=>b.id!==id); addHistory(data,'Submission batch deleted',`${batch.fileName} was deleted with ${(batch.records||[]).length} personnel record${(batch.records||[]).length===1?'':'s'}.`);
    await writeData(data); return send(res,200,{ok:true});
  }
  if (req.method === 'DELETE' && p === '/api/history') { const data=readData(); data.history=[]; await writeData(data); return send(res,200,{ok:true}); }

  if (p.startsWith('/api/')) return send(res,404,{error:'API route not found.'});
  return serveStatic(req,res,p);
}

ensureDataFile();
const server=http.createServer((req,res)=>{ handle(req,res).catch(err=>{ console.error(err); if(!res.headersSent) send(res,500,{error:'Internal server error.'}); }); });
server.listen(PORT,'0.0.0.0',()=>console.log(`GBB IDMS running on port ${PORT}`));
