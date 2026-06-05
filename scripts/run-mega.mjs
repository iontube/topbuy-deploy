// Per-mega cloud job: download this mega's feeds → concat → split → build+deploy each part to its CF account.
// Runs on a GitHub Actions runner (one matrix job per mega). Env:
//   MEGA            mega slug (e.g. "auto-moto")
//   CF_ACCOUNTS     JSON array [{id,email,key}, ...] (6 accounts; index 0 holds the topbuy.ro zone)
//   CF_ZONE         zone id of topbuy.ro
//   CONC            optional concurrency (default 4)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, createWriteStream, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEN = join(ROOT, 'productsite');
const DATA = join(ROOT, 'data');
const WORK = process.env.WORK || '/tmp/tbwork';
const MEGA = process.env.MEGA;
if (!MEGA) { console.error('MEGA env required'); process.exit(1); }
const ACCOUNTS = JSON.parse(process.env.CF_ACCOUNTS);
const ZONE = process.env.CF_ZONE;
const A0 = ACCOUNTS[0];
const CONC = +(process.env.CONC || 4);

const megas = JSON.parse(readFileSync(join(DATA, 'megas.json'), 'utf8'));
const feedsByMega = JSON.parse(readFileSync(join(DATA, 'feeds-by-mega.json'), 'utf8'));
const shardAcct = JSON.parse(readFileSync(join(DATA, 'shard-accounts.json'), 'utf8'));
const LABEL = megas[MEGA];
const feeds = feedsByMega[MEGA] || [];
console.log(`=== ${MEGA} (${LABEL}) — ${feeds.length} feeds ===`);

mkdirSync(WORK, { recursive: true });
const megaCsv = join(WORK, `${MEGA}.csv`);
const partsDir = join(WORK, 'parts'); mkdirSync(partsDir, { recursive: true });

// 1) download + concat feeds (keep one header)
async function downloadConcat() {
  const ws = createWriteStream(megaCsv);
  let first = true, ok = 0, lost = 0;
  for (const url of feeds) {
    let buf = null;
    for (let attempt = 1; attempt <= 4 && !buf; attempt++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(120000 * attempt) });
        if (!r.ok) { if (r.status === 404) break; throw new Error('http ' + r.status); }
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length < 50) break; // empty feed
        buf = b;
      } catch (e) { console.log(`  retry ${attempt} (${e.message}) ${url}`); await new Promise((r) => setTimeout(r, 3000 * attempt)); }
    }
    if (!buf) { lost++; continue; }
    if (first) { ws.write(buf); first = false; }
    else { const nl = buf.indexOf(0x0a); ws.write(nl >= 0 ? buf.subarray(nl + 1) : buf); }
    ok++;
  }
  if (lost) console.log(`  WARN: ${lost} feeds lost after retries`);
  await new Promise((res) => ws.end(res));
  console.log(`  downloaded ${ok}/${feeds.length} feeds → ${(statSync(megaCsv).size / 1048576).toFixed(0)}MB`);
}

const genEnv = (extra) => ({ ...process.env, LOGOS: join(DATA, 'logos.json'), STORESAFF: join(DATA, 'stores-aff.json'), PROMOS: join(DATA, 'promos.json'), PROTECTED: join(DATA, 'protected.json'), ...extra });
function runGen(env) {
  const r = spawnSync('node', ['--max-old-space-size=6000', 'generate.mjs'], { cwd: GEN, stdio: 'inherit', env: genEnv(env) });
  if (r.status !== 0) throw new Error('generate failed');
}

// 2) split this mega into part-JSONs
function split() {
  const man = join(WORK, `_m_${MEGA}.tsv`);
  writeFileSync(man, `${MEGA}|${LABEL}|${megaCsv}\n`);
  runGen({ SPLIT_OUT: partsDir, MANIFEST: man });
}

// ---- CF API ----
async function cf(acc, path, method = 'GET', body) {
  const res = await fetch('https://api.cloudflare.com/client/v4' + path, { method, headers: { 'X-Auth-Email': acc.email, 'X-Auth-Key': acc.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
async function ensureProject(acc, name) {
  if ((await cf(acc, `/accounts/${acc.id}/pages/projects/${name}`)).success) return true;
  for (let i = 0; i < 4; i++) { if ((await cf(acc, `/accounts/${acc.id}/pages/projects`, 'POST', { name, production_branch: 'main' })).success) return true; await new Promise((r) => setTimeout(r, 2500)); }
  return false;
}
async function attachDomain(acc, name, host) {
  if ((await cf(acc, `/accounts/${acc.id}/pages/projects/${name}/domains/${host}`)).success) return true;
  return !!(await cf(acc, `/accounts/${acc.id}/pages/projects/${name}/domains`, 'POST', { name: host })).success;
}
async function ensureCNAME(sub, target) {
  const g = await cf(A0, `/zones/${ZONE}/dns_records?name=${sub}.topbuy.ro`);
  if (g.success && g.result.length) return true;
  return !!(await cf(A0, `/zones/${ZONE}/dns_records`, 'POST', { type: 'CNAME', name: sub, content: target, proxied: true, ttl: 1 })).success;
}
function buildShard(sub) {
  const dir = join(WORK, 'sh', sub);
  rmSync(dir, { recursive: true, force: true });
  runGen({ PARTS_JSON: join(partsDir, `${sub}.json`), OUT_DIR: join(dir, 'dist'), ROLE: 'shard', SITE_URL: `https://${sub}.topbuy.ro`, HUB_URL: 'https://topbuy.ro' });
  return dir;
}
function deploy(acc, name, dir) {
  rmSync(join(dir, '.wrangler'), { recursive: true, force: true });
  const r = spawnSync('npx', ['wrangler', 'pages', 'deploy', 'dist', `--project-name=${name}`, '--branch=main', '--commit-dirty=true'], { cwd: dir, stdio: 'pipe', env: { ...process.env, CI: 'true', CLOUDFLARE_API_KEY: acc.key, CLOUDFLARE_EMAIL: acc.email, CLOUDFLARE_ACCOUNT_ID: acc.id } });
  return /Deployment complete|Success/.test(((r.stdout || '') + (r.stderr || '')).toString());
}

async function processOne(sub, idx, total) {
  const acc = ACCOUNTS[shardAcct[sub] ?? 0];
  const name = `topbuy-${sub}`;
  try {
    const dir = buildShard(sub);
    if (!(await ensureProject(acc, name))) throw new Error('project');
    if (!deploy(acc, name, dir)) throw new Error('deploy');
    if (!(await attachDomain(acc, name, `${sub}.topbuy.ro`))) throw new Error('domain');
    if (!(await ensureCNAME(sub, `${name}.pages.dev`))) throw new Error('cname');
    rmSync(dir, { recursive: true, force: true });
    console.log(`[${idx}/${total}] OK ${sub} → ${acc.email.split('@')[1]}`);
    return true;
  } catch (e) { console.log(`[${idx}/${total}] FAIL ${sub}: ${e.message}`); return false; }
}

await downloadConcat();
split();
rmSync(megaCsv, { force: true }); // free disk
const subs = readdirSync(partsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();
console.log(`=== deploying ${subs.length} shards (conc ${CONC}) ===`);
let i = 0, ok = 0, fail = 0, idx = 0;
async function worker() { while (i < subs.length) { const sub = subs[i++]; (await processOne(sub, ++idx, subs.length)) ? ok++ : fail++; } }
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`=== ${MEGA} DONE: ok=${ok} fail=${fail} ===`);
if (fail) process.exit(1);
