// Download ALL feeds, concat per mega → /tmp/megafeeds/<mega>.csv + manifest.tsv (for full-tree generation).
import { readFileSync, writeFileSync, mkdirSync, createWriteStream, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const OUT = process.env.MEGAFEEDS || '/tmp/megafeeds';
mkdirSync(OUT, { recursive: true });
const megas = JSON.parse(readFileSync(join(DATA, 'megas.json'), 'utf8'));
const feedsByMega = JSON.parse(readFileSync(join(DATA, 'feeds-by-mega.json'), 'utf8'));
const lines = [];
for (const [mega, label] of Object.entries(megas)) {
  const feeds = feedsByMega[mega] || [];
  const out = join(OUT, `${mega}.csv`);
  const ws = createWriteStream(out);
  let first = true, ok = 0, lost = 0;
  for (const url of feeds) {
    let buf = null;
    for (let a = 1; a <= 6 && !buf; a++) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(150000 * a), headers: { 'User-Agent': 'topbuy-feed/1.0' } }); if (!r.ok) { if (r.status === 404) break; throw new Error('http ' + r.status); } const b = Buffer.from(await r.arrayBuffer()); if (b.length < 50) break; buf = b; }
      catch (e) { await new Promise((r) => setTimeout(r, 4000 * a)); }
    }
    if (!buf) { lost++; continue; }
    if (first) { ws.write(buf); first = false; } else { const nl = buf.indexOf(0x0a); ws.write(nl >= 0 ? buf.subarray(nl + 1) : buf); }
    ok++; await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((res) => ws.end(res));
  lines.push(`${mega}|${label}|${out}`);
  console.log(`${mega}: ${ok}/${feeds.length} feeds${lost ? ` (${lost} lost)` : ''} → ${(statSync(out).size / 1048576).toFixed(0)}MB`);
}
writeFileSync(join(OUT, 'manifest.tsv'), lines.join('\n'));
console.log('manifest written:', lines.length, 'megas');
