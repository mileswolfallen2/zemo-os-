const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const net = require('net');

const root = __dirname;
const configPath = path.join(root, 'config.json');
const config = { port: 8787, displayName: 'ZIMA SERVER', refreshSeconds: 3, storagePath: '/', networkInterface: 'auto', minecraft: { enabled: false }, services: [], ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
let previousCpu = os.cpus();
let previousNet = null;

function command(file, args = []) {
  return new Promise(resolve => execFile(file, args, { timeout: 1800 }, (error, stdout) => resolve(error ? '' : stdout.trim())));
}
function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function bytes(v) { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; } return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`; }
function cpuLoad(now, old) {
  let idle = 0, total = 0;
  now.forEach((cpu, i) => { const a = cpu.times, b = old[i]?.times || a; const at = Object.values(a).reduce((x,y) => x+y, 0), bt = Object.values(b).reduce((x,y) => x+y, 0); total += at - bt; idle += a.idle - b.idle; });
  return total ? pct(total - idle, total) : 0;
}
async function temperature() {
  const candidates = ['/sys/class/thermal/thermal_zone0/temp', '/sys/class/hwmon/hwmon0/temp1_input'];
  for (const p of candidates) try { const raw = Number(fs.readFileSync(p, 'utf8').trim()); if (raw) return Math.round(raw > 1000 ? raw / 1000 : raw); } catch (_) {}
  const text = await command('sensors'); const m = text.match(/(?:Package id 0|Tctl|CPU Temp).*?\+([0-9.]+)°C/i); return m ? Math.round(Number(m[1])) : null;
}
function uptime(seconds) { const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60); return `${d ? d + 'd ' : ''}${h}h ${m}m`; }
async function diskInfo() {
  const out = await command('df', ['-B1', config.storagePath || '/']); const row = out.split('\n')[1]?.trim().split(/\s+/); if (!row) return null;
  return { total: Number(row[1]), used: Number(row[2]), available: Number(row[3]), percent: Number((row[4] || '0').replace('%','')), mount: row.slice(5).join(' ') };
}
function pickInterface(nets) {
  if (config.networkInterface && config.networkInterface !== 'auto') return config.networkInterface;
  return Object.keys(nets).find(n => !n.startsWith('lo') && !n.startsWith('docker') && !n.startsWith('br-') && !n.startsWith('veth')) || Object.keys(nets)[0];
}
async function networkInfo() {
  const iface = pickInterface(os.networkInterfaces()); let rx = 0, tx = 0;
  try { const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n'); const line = lines.find(x => x.trim().startsWith(`${iface}:`)); const nums = line?.split(':')[1]?.trim().split(/\s+/).map(Number); if (nums) { rx = nums[0]; tx = nums[8]; } } catch (_) {}
  const now = { rx, tx, at: Date.now(), iface }; const elapsed = previousNet ? (now.at - previousNet.at) / 1000 : 0; const result = { iface, down: elapsed ? Math.max(0, (rx - previousNet.rx) / elapsed) : 0, up: elapsed ? Math.max(0, (tx - previousNet.tx) / elapsed) : 0 }; previousNet = now; return result;
}
async function services() {
  const docker = await command('docker', ['ps', '--format', '{{.Names}}|{{.Status}}']); const rows = docker ? docker.split('\n').map(x => x.split('|')) : [];
  return config.services.map(s => { if (!s.container) return { ...s, online: Boolean(docker), detail: docker ? 'Engine online' : 'Unavailable' }; const hit = rows.find(([name]) => name === s.container || name.includes(s.container)); return { ...s, online: Boolean(hit), detail: hit?.[1]?.replace(/^Up\s*/, 'Online ') || 'Offline' }; });
}
function mcVarInt(n) { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
function mcPacket(payload) { return Buffer.concat([mcVarInt(payload.length), payload]); }
function readMcVarInt(buf, start = 0) { let value = 0, shift = 0, at = start; while (at < buf.length && shift < 35) { const b = buf[at++]; value |= (b & 0x7f) << shift; if (!(b & 0x80)) return { value, bytes: at - start }; shift += 7; } return null; }
function minecraftStatus() {
  const mc = config.minecraft || {}; if (!mc.enabled) return Promise.resolve({ enabled: false });
  return new Promise(resolve => {
    const socket = net.createConnection({ host: mc.host, port: mc.port, timeout: 2000 }); let done = false, data = Buffer.alloc(0);
    const finish = result => { if (!done) { done = true; socket.destroy(); resolve({ enabled: true, label: mc.label || 'Minecraft', players: null, maxPlayers: null, ...result }); } };
    socket.on('connect', () => { const host = Buffer.from(mc.host); const handshake = Buffer.concat([mcVarInt(0), mcVarInt(758), mcVarInt(host.length), host, Buffer.from([(mc.port >> 8) & 255, mc.port & 255]), mcVarInt(1)]); socket.write(Buffer.concat([mcPacket(handshake), mcPacket(Buffer.from([0]))])); });
    socket.on('data', chunk => { data = Buffer.concat([data, chunk]); const size = readMcVarInt(data); if (!size || data.length < size.bytes + size.value) return; const body = data.subarray(size.bytes, size.bytes + size.value); const id = readMcVarInt(body); const length = id && readMcVarInt(body, id.bytes); if (!id || !length) return finish({ online: true }); try { const status = JSON.parse(body.subarray(id.bytes + length.bytes, id.bytes + length.bytes + length.value).toString()); finish({ online: true, players: status.players?.online ?? null, maxPlayers: status.players?.max ?? null }); } catch (_) { finish({ online: true }); } });
    socket.on('error', () => finish({ online: false })); socket.on('timeout', () => finish({ online: false }));
  });
}
async function stats() {
  const nowCpu = os.cpus(); const cpu = cpuLoad(nowCpu, previousCpu); previousCpu = nowCpu;
  const [temp, disk, network, serviceList, minecraft] = await Promise.all([temperature(), diskInfo(), networkInfo(), services(), minecraftStatus()]);
  const total = os.totalmem(), free = os.freemem();
  return { name: config.displayName, refreshedAt: new Date().toISOString(), cpu: { percent: cpu, cores: nowCpu.length, model: nowCpu[0]?.model || 'Processor', temperature: temp }, memory: { total, used: total - free, free, percent: pct(total - free, total) }, uptime: uptime(os.uptime()), storage: disk, network, services: serviceList, minecraft, refreshSeconds: config.refreshSeconds || 3 };
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
http.createServer(async (req, res) => {
  if (req.url === '/api/stats') { try { res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(await stats())); } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); } return; }
  const safe = req.url === '/' ? '/index.html' : req.url.split('?')[0]; const file = path.join(root, safe);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream'}); fs.createReadStream(file).pipe(res);
}).listen(config.port, '0.0.0.0', () => console.log(`Zima Server Display running at http://0.0.0.0:${config.port}`));
