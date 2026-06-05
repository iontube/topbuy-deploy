#!/usr/bin/env node
// Product-first static generator — topbuy.ro
// Semantic taxonomy + topical-authority internal-link graph + intent facets.
// Fast (template literals -> files). Deploy: `wrangler pages deploy dist`.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';  // streaming (sync parse hits V8 512MB single-string limit on >0.5GB feeds)
import slugify from 'slugify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.OUT_DIR || join(__dirname, 'dist');
const SITE = process.env.SITE_URL || 'https://topbuy.ro';        // this build's own origin (subdomain for shards)
const HUB = process.env.HUB_URL || SITE;                          // main hub origin (topbuy.ro); cross-domain links point here
const ROLE = process.env.ROLE || 'full';                          // 'full' (one project, demo) | 'hub' (main domain) | 'shard' (one mega on a subdomain)
const SHARD_MEGA = process.env.SHARD_MEGA || '';                  // for ROLE=shard: which mega slug this subdomain serves
const SITE_NAME = 'TopBuy.ro';
// absolute hub link (cross-domain). On hub/full builds HUB===SITE so these stay same-origin.
const hub = (path) => (HUB === SITE ? path : HUB + path);
const ACCENT = '#e8540c';
const ASSET_V = Date.now(); // cache-bust for css/logo

// a shard = one mega-category
const MEGA = { slug: process.env.MEGA_SLUG || 'electronice-it', label: process.env.MEGA_LABEL || 'Electronice & IT' };
const PRICE_LADDER = [50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];
const AFF_CODE = '2ace29e87';
const CAMPAIGN = {}; // merchantSlug -> campaign_unique (for /out Function)
const SITEMAP = [];
const addSM = (slug) => SITEMAP.push(SITE + slug);
const SEEN = new Set(); // global slug dedup across feeds
// merchants whose images block at connection level (hang the browser) → rewrite to /img proxy at build time
const PROTECTED = new Set(process.env.PROTECTED ? JSON.parse(readFileSync(process.env.PROTECTED, 'utf8')) : []);
const proxify = (url, merchant) => (PROTECTED.has(merchant) ? '/img?u=' + encodeURIComponent(url) : url);

// ---------- helpers ----------
const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\\[nrt]/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => Number(n).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' lei';
const sl = (s) => slugify(s || '', { lower: true, strict: true, locale: 'ro' });
const clampTxt = (s, n) => (s || '').length > n ? (s || '').slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : (s || '');
const NOISE = /^(produse|produs|oferte?|oferta speciala|oferte speciale|promo(tii|ții)?|reduceri|outlet|noutati|noutăți|recomandate|recomandat|all|toate|diverse|altele|various|home|new products|catalog)$/i;
const titleIfCaps = (s) => { const L = s.replace(/[^\p{L}]/gu, ''); return (L && L === L.toUpperCase() && L.length > 1) ? s.toLowerCase().replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase()) : s; };
const isCode = (s) => /\d/.test(s) && !/\s/.test(s) && s.length <= 8; // model/series codes: 111D, X20, R16, MP3
const isAttr = (s) => /^(alb|albastr|negr|neagr|negre|gri\b|rosu|roșu|rosi|roși|verde|galben|maro|bej|mov|roz|portocali|argint|aur|bleu|kaki|fumuri|crem|turcoaz|transparent|multicolor|mat\b|lucios|full.?glue|universal|silicon|piele|inox|metalic|marime|mărime|culoare)/i.test(s); // colors/materials/sizes = product attributes, not subcategories
function cleanCategory(raw) {
  let segs = clean(raw).split(/\s*[>›»|\/,]\s*/).map((x) => x.trim()).filter(Boolean);
  const seen = new Set(); segs = segs.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const meaningful = segs.filter((x) => !NOISE.test(x));
  const use = meaningful.length ? meaningful : segs;
  // pick the deepest readable segment (skip code-like / too-short tokens)
  let leaf = '';
  for (let i = use.length - 1; i >= 0; i--) { const c = use[i]; if (c.length >= 3 && !isCode(c) && !isAttr(c)) { leaf = c; break; } }
  if (!leaf) leaf = use[use.length - 1] || 'Diverse';
  return titleIfCaps(leaf).slice(0, 40);
}
const shortId = (u) => (u.match(/[?&]unique=([^&]+)/) || [])[1] || null;
const campUnique = (u) => (u.match(/[?&]campaign_unique=([^&]+)/) || [])[1] || null;
const outUrl = (p) => `/out/${p.merchantSlug}/${p.id}/`;
const today = new Date().toISOString().slice(0, 10);
const validUntil = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const PH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23f3efe6'/%3E%3Cg fill='none' stroke='%23cabfa9' stroke-width='4'%3E%3Crect x='30' y='34' width='60' height='48' rx='4'/%3E%3Ccircle cx='46' cy='50' r='6'/%3E%3Cpath d='M34 76l18-16 12 10 10-8 12 14'/%3E%3C/g%3E%3C/svg%3E";
const onerr = `onerror=\"tbImg(this)\"`;  // staged fallback: direct → /img proxy → placeholder
function discount(p) { // guarded
  if (!p.oldPrice || p.oldPrice <= p.price) return 0;
  const d = Math.round((1 - p.price / p.oldPrice) * 100);
  return d >= 1 && d <= 90 ? d : 0;
}

// ---------- load + normalize ----------
async function loadProducts(csvPath, mega) {
  const LIMIT = parseInt(process.env.LIMIT || '0', 10);
  const parser = createReadStream(csvPath).pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true, skip_records_with_error: true }));
  const out = [];
  for await (const r of parser) {
    if (LIMIT && out.length >= LIMIT) break;
    const active = String(r.product_active).trim() === '1' || String(r.product_active).toLowerCase() === 'true';
    const price = parseFloat(r.price);
    const img = (clean(r.image_urls).split(/[\s,|]+/).find((u) => /^https?:\/\//.test(u))) || '';
    const aff = clean(r.aff_code); const id = shortId(aff);
    if (!active || !(price > 0) || !img || !aff || !id) continue;
    const title = clean(r.title); if (!title) continue;
    let slug = sl(title).slice(0, 70) + '-' + id.toLowerCase(); if (SEEN.has(slug)) { let k = 2; while (SEEN.has(slug + '-' + k)) k++; slug += '-' + k; } SEEN.add(slug);
    const merchant = clean(r.campaign_name); const merchantSlug = sl(merchant); const cu = campUnique(aff);
    if (cu && !CAMPAIGN[merchantSlug]) CAMPAIGN[merchantSlug] = cu;
    const brandRaw = clean(r.brand); const brand = (brandRaw.replace(/[^a-zA-Z0-9]/g, '').length >= 2) ? brandRaw : '';
    const sub = cleanCategory(r.category);
    out.push({ id, slug, title, price, oldPrice: parseFloat(r.old_price) || null, brand, brandSlug: sl(brand),
      merchant, merchantSlug, img: proxify(img, merchant), mega, sub, subSlug: sl(sub) || 'diverse', desc: clean(r.description).slice(0, 1500) });
  }
  return out;
}

function specsTable(desc) {
  const parts = desc.split(/,(?=[^,]*:)/).map((p) => p.trim()).filter(Boolean);
  const isSpec = (p) => /^[\p{L}][\p{L}0-9 ()\/.+-]{1,28}:\s*\S/u.test(p);
  const specs = parts.filter(isSpec);
  // only render a spec table when the text is clearly structured key:value (not prose)
  if (specs.length < 4 || specs.length < parts.length * 0.7) return '';
  return `<table class="specs"><tbody>${specs.slice(0, 16).map((p) => { const i = p.indexOf(':'); return `<tr><th>${esc(p.slice(0, i).trim())}</th><td>${esc(p.slice(i + 1).trim())}</td></tr>`; }).join('')}</tbody></table>`;
}

// ---------- shared chrome ----------
let FOOTER_LINKS = ''; // computed after grouping (popular categories + top brands)
function layout({ title, desc, canonical, body, jsonld, breadcrumbHtml, noSearch, homeHeader }) {
  return `<!doctype html><html lang="ro"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#f7941d">
<link rel="stylesheet" href="/style.css?v=${ASSET_V}">
${(jsonld && jsonld.length) ? `<script type="application/ld+json">${JSON.stringify(jsonld.length === 1 ? jsonld[0] : jsonld)}</script>` : ''}
</head><body>
<header class="site"><div class="wrap">
  <a class="logo" href="${hub('/')}"><img src="/logo.png?v=${ASSET_V}" alt="TopBuy.ro"></a>
</div></header>
${breadcrumbHtml || ''}
<main class="wrap">${body}</main>
<footer class="site"><div class="wrap">
  ${FOOTER_LINKS}
  <p class="disc">TopBuy.ro selectează produse și oferte din magazinele partenere. Putem primi un comision când cumperi prin linkurile noastre — prețul tău rămâne neschimbat.</p>
  <nav class="fnav"><a href="${hub('/despre/')}">Despre</a><a href="${hub('/cum-alegem/')}">Cum alegem</a><a href="${hub('/promotii/')}">Promoții</a><a href="${hub('/magazine/')}">Magazine</a><a href="${hub('/contact/')}">Contact</a><a href="${hub('/disclaimer-afiliere/')}">Disclaimer afiliere</a><a href="${hub('/confidentialitate/')}">Confidențialitate</a><a href="${hub('/termeni/')}">Termeni</a><a href="${hub('/politica-cookies/')}">Cookies</a></nav>
  <p class="cr">© ${new Date().getFullYear()} TopBuy.ro</p>
</div></footer>
<div class="cookiebar" id="ckb"><span>Folosim cookie-uri pentru funcționare și statistici. <a href="/politica-cookies/">Detalii</a></span><button type="button" onclick="ckOk()">Accept</button></div>
<script>function tbSearch(f){var v=(f.querySelector('input').value||'').trim();if(!v)return false;location.href='/cautare/'+encodeURIComponent(v.toLowerCase().replace(/\\s+/g,'-'))+'/';return false;}
function tbImg(el){if(el.dataset.f||el.src.indexOf('/img?u=')>-1){el.onerror=null;el.src=${JSON.stringify(PH)};}else{el.dataset.f=1;el.src='/img?u='+encodeURIComponent(el.src);}}
function ckOk(){try{localStorage.setItem('ck','1')}catch(e){}var b=document.getElementById('ckb');if(b)b.style.display='none';}
(function(){try{if(localStorage.getItem('ck')){var b=document.getElementById('ckb');if(b)b.style.display='none';}}catch(e){}})();</script>
</body></html>`;
}
function bc(items) { // breadcrumb: [{name,url}]; last = current
  const href = (c) => c.name === 'Acasă' ? hub('/') : c.url;            // only "Acasă" is cross-domain (→ hub)
  const abs = (c) => c.name === 'Acasă' ? HUB + '/' : (c.url.startsWith('http') ? c.url : SITE + c.url);
  const html = `<nav class="bc"><div class="wrap">${items.map((c, i) => i < items.length - 1 ? `<a href="${href(c)}">${esc(c.name)}</a>` : `<span>${esc(c.name)}</span>`).join('<i>›</i>')}</div></nav>`;
  const schema = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: abs(c) })) };
  return { html, schema };
}
function card(p) {
  const d = discount(p);
  return `<a class="card" href="${p.sub ? `https://${p.sub}.topbuy.ro/produs/${p.slug}/` : `/produs/${p.slug}/`}">
    <div class="thumb"><img src="${esc(p.img)}" alt="${esc(p.title)}" loading="lazy" ${onerr}></div>
    <div class="ci">${p.brand ? `<span class="brand">${esc(p.brand)}</span>` : ''}<span class="ci-t">${esc(p.title)}</span>
    <div class="price">${money(p.price)}${d ? `<span class="old">${money(p.oldPrice)}</span><span class="badge">-${d}%</span>` : ''}</div></div></a>`;
}
const grid = (items) => `<div class="grid">${items.map(card).join('')}</div>`;
const sechead = (t, href) => `<div class="sechead"><h2>${esc(t)}</h2>${href ? `<a class="seeall" href="${href}">Vezi toate →</a>` : ''}</div>`;
const catCard = (m) => `<a class="catcard" href="${catLink(m.slug)}"><div class="ct"><img src="${esc(m.products[0] ? m.products[0].img : '')}" alt="${esc(m.label)}" loading="lazy" ${onerr}></div><div class="cc-b"><span class="cc-n">${esc(m.label)}</span><span class="cc-c">${(m._count != null ? m._count : m.products.length).toLocaleString('ro-RO')} produse</span></div></a>`;
// seeded shuffle (seed = build time) -> homepage shows different products after each feed update
let _seed = (ASSET_V % 2147483646) + 1;
const rnd = () => (_seed = (_seed * 16807) % 2147483647) / 2147483647;
const shuffled = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
const interleaveShuffled = (n) => { const pools = MEGAS.map((m) => shuffled(m.products)); const out = []; for (let i = 0; out.length < n; i++) { let added = false; for (const pool of pools) { if (pool[i]) { out.push(pool[i]); added = true; } } if (!added) break; } return out.slice(0, n); };
const promoCard = (p) => `<div class="promo">${p.logo ? `<div class="pm-logo"><img src="${esc(p.logo)}" alt="${esc(p.merchant)}" loading="lazy" ${onerr}></div>` : ''}<div class="pm-b"><span class="pm-store">${esc(p.merchant)}</span><span class="pm-t">${esc(p.name)}</span>${p.desc ? `<p class="pm-desc">${esc(p.desc.slice(0, 130))}</p>` : ''}${p.coupon ? `<div class="pm-coupon">Cod: <b>${esc(p.coupon)}</b></div>` : ''}<a class="cta pm-cta" href="/out/_promo/${p.id}/" target="_blank" rel="sponsored nofollow noopener">Profită de ofertă →</a>${p.end ? `<span class="pm-end">Valabil până la ${esc(p.end.slice(0, 10))}</span>` : ''}</div></div>`;
const promoGrid = (items) => `<div class="promos">${items.map(promoCard).join('')}</div>`;
const itemListSchema = (items, name) => ({ '@context': 'https://schema.org', '@type': 'CollectionPage', name, mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.slice(0, 30).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/produs/${p.slug}/`, name: p.title })) } });

// ---------- page builders ----------
function productPage(p, related, facetLinks) {
  const d = discount(p), save = d ? p.oldPrice - p.price : 0;
  const crumb = bc([{ name: 'Acasă', url: '/' }, { name: p.mega.label, url: `${cb(p.mega.slug)}/` }, { name: p.sub, url: `${cb(p.mega.slug)}/${p.subSlug}/` }, { name: p.title, url: `/produs/${p.slug}/` }]);
  const schema = [{ '@context': 'https://schema.org', '@type': 'Product', name: p.title, image: p.img, ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}), description: p.desc.slice(0, 320),
    offers: { '@type': 'Offer', price: p.price.toFixed(2), priceCurrency: 'RON', priceValidUntil: validUntil, availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition', seller: { '@type': 'Organization', name: p.merchant }, url: `${SITE}/produs/${p.slug}/` } }, crumb.schema];
  const body = `<article class="product">
    <div class="gallery"><img src="${esc(p.img)}" alt="${esc(p.title)}" ${onerr}></div>
    <div class="buy">
      ${p.brand ? (brandPages.has(p.brandSlug) ? `<a class="brand" href="/brand/${p.brandSlug}/">${esc(p.brand)}</a>` : `<span class="brand">${esc(p.brand)}</span>`) : ''}
      <h1>${esc(p.title)}</h1>
      <div class="pricebox"><span class="now">${money(p.price)}</span>${d ? `<span class="old">${money(p.oldPrice)}</span><span class="badge">-${d}%</span>` : ''}</div>
      ${d ? `<p class="save">Economisești ${money(save)}</p>` : ''}
      <p class="stock">✔ În stoc la <strong>${esc(p.merchant)}</strong></p>
      <a class="cta" href="${outUrl(p)}" target="_blank" rel="sponsored nofollow noopener"><span class="cta-t">Vezi oferta la ${esc(p.merchant)}</span><span class="cta-a" aria-hidden="true">→</span></a>
      <p class="meta">Preț actualizat: ${today} · <a href="/disclaimer-afiliere/">link afiliat</a></p>
    </div>
  </article>
  ${p.desc ? `<section class="block"><h2>Descriere & specificații</h2>${specsTable(p.desc) || `<p class="prose">${esc(p.desc.replace(/\s*\S*(?:\.\.\.|…)\s*$/, '…'))}</p>`}</section>` : ''}
  ${facetLinks ? `<section class="block links"><h2>Vezi și</h2><div class="chips">${facetLinks}</div></section>` : ''}
  ${related.length ? `<section class="block"><h2>Produse similare</h2>${grid(related)}</section>` : ''}
  <div class="buybar-space"></div>
  <div class="buybar"><div class="bb-price"><span class="bb-now">${money(p.price)}</span>${d ? `<span class="bb-old">${money(p.oldPrice)}</span>` : ''}</div>
    <a class="cta" href="${outUrl(p)}" target="_blank" rel="sponsored nofollow noopener">Vezi oferta →</a></div>`;
  const clamp = (s, n) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  const tShort = clamp(p.title, 52);
  const metaDesc = clamp(`${p.title}${p.brand ? `, ${p.brand},` : ''} la ${money(p.price)}${d ? ` (reducere ${d}%)` : ''} de la ${p.merchant}. Vezi oferta și prețul actualizat pe TopBuy.ro.`, 158);
  return layout({ title: `${tShort} | TopBuy.ro`, desc: metaDesc, canonical: `${SITE}/produs/${p.slug}/`, body, jsonld: schema, breadcrumbHtml: crumb.html });
}
function collection({ h1, slug, intro, products, crumbItems, sideLinks, pagerHtml = '', totalCount, headerHtml }) {
  const crumb = bc(crumbItems);
  const cnt = totalCount != null ? totalCount : products.length;
  const head = headerHtml || `<h1>${esc(h1)}${cnt ? ` <span class="count">${cnt} produse</span>` : ''}</h1>${intro ? `<p class="intro">${esc(intro)}</p>` : ''}`;
  const body = `<div class="listing${sideLinks ? ' has-side' : ''}"><div class="lmain">${head}${products.length ? grid(products) : ''}${pagerHtml}</div>${sideLinks ? `<aside class="side">${sideLinks}</aside>` : ''}</div>`;
  return layout({ title: `${clampTxt(h1, 58)} | TopBuy.ro`, desc: clampTxt(`${h1}: ${cnt} produse din magazinele partenere, prețuri actualizate, livrare din magazine verificate.`, 158), canonical: `${SITE}${slug}`, body, jsonld: [itemListSchema(products, h1), crumb.schema], breadcrumbHtml: crumb.html });
}
const PER_PAGE = 36;
function pager(base, cur, total) {
  if (total <= 1) return '';
  const url = (n) => n === 1 ? base : `${base}pagina/${n}/`;
  const want = new Set([1, 2, total - 1, total, cur - 1, cur, cur + 1]);
  const nums = [...want].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  let out = '<nav class="pager">', prev = 0;
  if (cur > 1) out += `<a class="pg nav" href="${url(cur - 1)}" rel="prev">‹</a>`;
  for (const n of nums) { if (n - prev > 1) out += '<span class="dots">…</span>'; out += `<a class="pg${n === cur ? ' on' : ''}" href="${url(n)}">${n}</a>`; prev = n; }
  if (cur < total) out += `<a class="pg nav" href="${url(cur + 1)}" rel="next">›</a>`;
  return out + '</nav>';
}
function writeListing({ dir, baseSlug, h1, intro, crumbItems, sideLinks, items, headerHtml }) {
  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  for (let pg = 1; pg <= pages; pg++) {
    const slice = items.slice((pg - 1) * PER_PAGE, pg * PER_PAGE);
    const path = pg === 1 ? `${dir}/index.html` : `${dir}/pagina/${pg}/index.html`;
    const slug = pg === 1 ? baseSlug : `${baseSlug}pagina/${pg}/`;
    addSM(slug);
    const crumbs = pg === 1 ? crumbItems : [...crumbItems, { name: `Pagina ${pg}`, url: slug }];
    W(path, collection({ h1: pg === 1 ? h1 : `${h1} — pagina ${pg}`, slug, intro: pg === 1 ? intro : '', headerHtml: pg === 1 ? headerHtml : '', products: slice, totalCount: items.length, crumbItems: crumbs, sideLinks, pagerHtml: pager(baseSlug, pg, pages) }));
  }
  return pages;
}

// ---------- build ----------
function W(rel, html) { const f = join(DIST, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, html); }
const CSS = readFileSync(join(__dirname, 'style.css'), 'utf8');

console.time('generate');
rmSync(DIST, { recursive: true, force: true }); mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'style.css'), CSS);

// ---- roles: full (one project / demo) | hub (main domain) | shard (one mega on a subdomain) ----
const isShard = ROLE === 'shard';
const isHub = ROLE === 'hub';
const isMegaTree = !!process.env.MEGATREE;   // server: build ONLY products + /categorie/<mega>/ (one mega/process, no globals)
const SERVER = !!process.env.SERVER_GLOBAL;  // server global pass: home/branduri/magazine/legal from aggregate, /categorie/ URLs
const SUBDOM = { 'electronice-it': 'electronice', 'casa-gradina': 'casa', 'fashion': 'fashion', 'sanatate-frumusete': 'sanatate', 'copii-jucarii': 'copii', 'auto-moto': 'auto', 'sport': 'sport', 'carti-muzica-filme': 'carti', 'animale': 'animale', 'pescuit': 'pescuit' };
const subdom = (megaSlug) => SUBDOM[megaSlug] || megaSlug;     // short subdomain name per mega
const shardURL = (slug) => `https://${subdom(slug)}.topbuy.ro`; // subdomain origin for a mega (part 1)
const cb = (megaSlug) => isShard ? '' : '/categorie/' + megaSlug; // category URL base (shard drops the prefix)
const catLink = (megaSlug) => SERVER ? '/categorie/' + megaSlug + '/' : ((isHub || isShard) ? shardURL(megaSlug) + '/' : '/categorie/' + megaSlug + '/'); // server: subdirectories
const SHARD_MAX = +(process.env.SHARD_MAX || 13000);  // max products/shard; ~1.25× files (pagination+facets+brand×subcat) → ~16-17k, safe margin under CF 20k
let SHARD_PART = +(process.env.SHARD_PART || 1);      // which part of a split mega this build serves (overridden by part-JSON)
const partURL = (mega, part) => `https://${subdom(mega)}${part > 1 ? part : ''}.topbuy.ro/`; // sanatate, sanatate2, sanatate3…
// pack a mega's products into parts of ≤ SHARD_MAX, keeping each subcat together;
// a subcat larger than SHARD_MAX is split across its own dedicated parts (product-level chunks)
function assignParts(products) {
  const bySub = new Map();
  for (const p of products) (bySub.get(p.subSlug) || bySub.set(p.subSlug, []).get(p.subSlug)).push(p);
  const subs = [...bySub.values()].sort((a, b) => b.length - a.length);
  const parts = []; const newPart = () => { const x = { prods: [], c: 0 }; parts.push(x); return x; };
  for (const items of subs) {
    if (items.length > SHARD_MAX) { for (let i = 0; i < items.length; i += SHARD_MAX) { const b = newPart(); b.prods = items.slice(i, i + SHARD_MAX); b.c = b.prods.length; } continue; }
    let bin = parts.find((p) => p.c + items.length <= SHARD_MAX); if (!bin) bin = newPart();
    for (const p of items) bin.prods.push(p); bin.c += items.length;
  }
  return parts.length ? parts : [{ prods: [], c: 0 }];
}
// ---- load feeds: MANIFEST (mega|label|file per line) = global multi-category, else single shard ----
const MEGAS = [];
if (process.env.HUBMETA) { // build the HUB from aggregated per-mega metadata (sample products + real counts); no full-catalog load
  const meta = JSON.parse(readFileSync(process.env.HUBMETA, 'utf8'));
  for (const [slug, m] of Object.entries(meta)) {
    const mega = { slug, label: m.label };
    (m.sample || []).forEach((p) => { p.mega = mega; });
    MEGAS.push({ slug, label: m.label, products: m.sample || [], _count: m.count });
  }
} else if (process.env.PARTS_JSON) { // build one shard from a pre-split part-JSON (no CSV parse, no re-split)
  const j = JSON.parse(readFileSync(process.env.PARTS_JSON, 'utf8'));
  const mega = { slug: j.mega.slug, label: j.mega.label };
  j.products.forEach((p) => { p.mega = mega; });
  Object.assign(CAMPAIGN, j.campaign || {});  // restore merchant→campaign_unique for /out affiliate links
  SHARD_PART = j.part;  // this shard serves part j.part of the split mega
  MEGAS.push({ slug: mega.slug, label: mega.label, products: j.products, _json: j });
} else if (process.env.MANIFEST) {
  for (const ln of readFileSync(process.env.MANIFEST, 'utf8').trim().split('\n')) {
    const [slug, label, file] = ln.split('|'); const mega = { slug, label };
    if (isShard && slug !== SHARD_MEGA) continue;
    MEGAS.push({ slug, label, products: await loadProducts(file, mega) });
  }
} else {
  const mega = { slug: process.env.MEGA_SLUG || 'electronice-it', label: process.env.MEGA_LABEL || 'Electronice & IT' };
  MEGAS.push({ slug: mega.slug, label: mega.label, products: await loadProducts(process.env.FEED || '/tmp/proto.csv', mega) });
}
const megaBySlug = new Map(MEGAS.map((m) => [m.slug, m]));
for (const m of MEGAS) {
  // fold subcategories with too few products into "Diverse" (avoid fragmentation / thin pages)
  const _cnt = {}; m.products.forEach((p) => { _cnt[p.subSlug] = (_cnt[p.subSlug] || 0) + 1; });
  m.products.forEach((p) => { if (_cnt[p.subSlug] < 4) { p.sub = 'Diverse'; p.subSlug = 'diverse'; } });
  // pack products into parts of ≤ SHARD_MAX (oversized subcats chunked); shard build keeps only its part
  const _parts = assignParts(m.products); m.parts = _parts.length; m._parts = _parts;
  // label each part by its 2 dominant subcategories (distinct titles + sibling links)
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  m.partLabels = _parts.map((pt) => {
    const c = {}, lbl = {}; let tot = 0; pt.prods.forEach((p) => { c[p.subSlug] = (c[p.subSlug] || 0) + 1; lbl[p.subSlug] = p.sub; tot++; });
    const real = Object.keys(c).sort((a, b) => c[b] - c[a]).filter((k) => lbl[k] && lbl[k] !== 'Diverse');
    if (!real.length) return 'Diverse';
    if (c[real[0]] >= tot * 0.65) return cap(lbl[real[0]]);                          // one subcat dominates → use it alone
    if (real.length > 3 || c[real[0]] < tot * 0.4) return cap(lbl[real[0]]) + ' & altele'; // genuinely mixed
    return real.slice(0, 2).map((k) => cap(lbl[k])).join(' & ');
  });
  { const seen = {}; m.partLabels = m.partLabels.map((l) => { seen[l] = (seen[l] || 0) + 1; return seen[l] > 1 ? `${l} ${seen[l]}` : l; }); }  // keep titles distinct across chunked subcats
  if (isShard && !process.env.PARTS_JSON) m.products = (_parts[SHARD_PART - 1] || { prods: [] }).prods;
  if (m._json) { m.parts = m._json.parts; m.partLabels = m._json.partLabels; }  // part-JSON carries the true split metadata
  m.bySub = new Map(); m.byBrand = new Map();
  for (const p of m.products) { (m.bySub.get(p.subSlug) || m.bySub.set(p.subSlug, { label: p.sub, slug: p.subSlug, items: [] }).get(p.subSlug)).items.push(p);
    if (p.brand) (m.byBrand.get(p.brandSlug) || m.byBrand.set(p.brandSlug, { label: p.brand, slug: p.brandSlug, items: [] }).get(p.brandSlug)).items.push(p); }
  m.subcats = [...m.bySub.values()].sort((a, b) => b.items.length - a.items.length);
  m.bxs = new Set();
  for (const s of m.subcats) { const sb = {}; s.items.forEach((p) => { if (p.brand) (sb[p.brandSlug] = sb[p.brandSlug] || []).push(p); });
    for (const [bs, it] of Object.entries(sb)) if (it.length >= 6 && bs !== 'pagina' && bs !== 'cel-mai-bun' && !bs.startsWith('sub-')) m.bxs.add(s.slug + '/' + bs); }
}
if (process.env.SPLIT_OUT) { // parse a mega ONCE, write one JSON per part (each = a standalone shard's products + metadata)
  mkdirSync(process.env.SPLIT_OUT, { recursive: true });
  for (const m of MEGAS) {
    for (let k = 1; k <= m.parts; k++) {
      const prods = m._parts[k - 1].prods;
      const sub = subdom(m.slug) + (k > 1 ? k : '');
      const camp = {}; prods.forEach((p) => { if (CAMPAIGN[p.merchantSlug]) camp[p.merchantSlug] = CAMPAIGN[p.merchantSlug]; });
      writeFileSync(`${process.env.SPLIT_OUT}/${sub}.json`, JSON.stringify({ mega: { slug: m.slug, label: m.label }, part: k, parts: m.parts, partLabels: m.partLabels, sub, campaign: camp, products: prods }));
    }
    console.log(`split ${m.slug}: ${m.parts} parts, ${m.products.length} produse`);
  }
  process.exit(0);
}
if (process.env.PLAN) { // enumerate shards (mega × parts → subdomains) for the deploy script, then exit
  const subs = [];
  for (const m of MEGAS) for (let k = 1; k <= m.parts; k++) subs.push(partURL(m.slug, k).replace(/^https:\/\/|\/$/g, '') + `\t${m.slug}\t${k}`);
  console.log('SHARDS_TOTAL=' + subs.length);
  subs.forEach((s) => console.log(s));
  console.log('SHARDS=' + subs.map((s) => 'https://' + s.split('\t')[0]).join(','));
  process.exit(0);
}
const ALL = MEGAS.flatMap((m) => m.products);
console.log('produse valide:', ALL.length, 'in', MEGAS.length, 'categorii');
const gByBrand = new Map();
for (const p of ALL) if (p.brand) (gByBrand.get(p.brandSlug) || gByBrand.set(p.brandSlug, { label: p.brand, slug: p.brandSlug, items: [] }).get(p.brandSlug)).items.push(p);
const gBrands = [...gByBrand.values()].sort((a, b) => b.items.length - a.items.length);
// only brands with enough products get a dedicated page (noisy feeds — e.g. books — have 1000s of 1-2-product "brands" that would blow the CF 20k-file limit)
const MIN_BRAND = +(process.env.MIN_BRAND || 10);
const brandPages = new Set(gBrands.filter((b) => b.items.length >= MIN_BRAND).map((b) => b.slug));
// stores (merchants): logos + affiliate target
const LOGOS = process.env.LOGOS ? JSON.parse(readFileSync(process.env.LOGOS, 'utf8')) : {};
const SAFF = process.env.STORESAFF ? JSON.parse(readFileSync(process.env.STORESAFF, 'utf8')) : {};
const gByMerchant = new Map();
for (const p of ALL) (gByMerchant.get(p.merchantSlug) || gByMerchant.set(p.merchantSlug, { slug: p.merchantSlug, label: p.merchant, items: [] }).get(p.merchantSlug)).items.push(p);
const storeList = [...gByMerchant.values()].map((s) => { const lg = LOGOS[s.slug]; return { ...s, logo: typeof lg === 'string' ? lg : (lg && lg.u) || '', inv: !!(lg && lg.inv), aff: SAFF[s.slug] || null }; }).sort((a, b) => b.items.length - a.items.length);
const PROMOS = process.env.PROMOS ? JSON.parse(readFileSync(process.env.PROMOS, 'utf8')) : [];

// footer internal-link graph (global, on every page)
FOOTER_LINKS = `<div class="fcols">
  <div><div class="fcol-h">Categorii</div>${MEGAS.map((m) => `<a href="${catLink(m.slug)}">${esc(m.label)}</a>`).join('')}</div>
  ${isHub ? '' : `<div><div class="fcol-h">Branduri de top</div>${gBrands.filter((b) => brandPages.has(b.slug)).slice(0, 10).map((b) => `<a href="/brand/${b.slug}/">${esc(b.label)}</a>`).join('')}</div>`}
  <div><div class="fcol-h">Oferte</div>${MEGAS.slice(0, 6).map((m) => `<a href="${catLink(m.slug)}">Oferte ${esc(m.label)}</a>`).join('')}</div>
</div>`;

let nProd = 0, nFacet = 0;
// product pages (global; each tagged with its mega)
if (!isHub) for (const p of ALL) {
  const m = megaBySlug.get(p.mega.slug); const B = cb(p.mega.slug);
  const sub = m.bySub.get(p.subSlug).items;
  // related = a rotating window of the SAME subcategory (O(≤12)/product — NOT a full scan; big subcats were O(n²) before)
  const related = [];
  if (sub.length > 1) { const start = sub.length > 13 ? (nProd * 13) % sub.length : 0; for (let i = 0; i < sub.length && related.length < 12; i++) { const x = sub[(start + i) % sub.length]; if (x.slug !== p.slug) related.push(x); } }
  const facetLinks = `<a class="chip" href="${B}/${p.subSlug}/">${esc(p.sub)}</a>`
    + (p.brand && brandPages.has(p.brandSlug) ? `<a class="chip" href="/brand/${p.brandSlug}/">${esc(p.brand)}</a>` : '')
    + (p.brand && m.bxs.has(p.subSlug + '/' + p.brandSlug) ? `<a class="chip" href="${B}/${p.subSlug}/${p.brandSlug}/">${esc(p.brand)} ${esc(p.sub)}</a>` : '')
    + `<a class="chip" href="${B}/${p.subSlug}/cel-mai-bun/">Oferte ${esc(p.sub)}</a>`;
  W(`produs/${p.slug}/index.html`, productPage(p, related, facetLinks)); addSM(`/produs/${p.slug}/`); nProd++;
}
// per-mega: subcategory listings + facets + brand×subcat + mega pillar
function buildMega(m) {
  const MS = m.slug, ML = m.label, B = cb(MS), sdir = isShard ? '' : `categorie/${MS}/`;
  const megaCrumb = { name: ML, url: `${B}/` };
  for (const s of m.subcats) {
    const sb = {}; s.items.forEach((p) => { if (p.brand) (sb[p.brandSlug] = sb[p.brandSlug] || { label: p.brand, slug: p.brandSlug, items: [] }).items.push(p); });
    const topSubBrands = Object.values(sb).filter((b) => m.bxs.has(s.slug + '/' + b.slug)).sort((a, b) => b.items.length - a.items.length).slice(0, 15);
    const siblings = m.subcats.filter((x) => x.slug !== s.slug).slice(0, 10);
    const priceChips = PRICE_LADDER.filter((t) => { const n = s.items.filter((p) => p.price <= t).length; return n >= 8 && n <= s.items.length - 3; });
    const subCrumb = [{ name: 'Acasă', url: '/' }, megaCrumb, { name: s.label, url: `${B}/${s.slug}/` }];
    const side = `<h2>Preț</h2><div class="chips"><a class="chip" href="${B}/${s.slug}/cel-mai-bun/">Top oferte</a>`
      + priceChips.map((t) => `<a class="chip" href="${B}/${s.slug}/sub-${t}-lei/">sub ${t} lei</a>`).join('') + '</div>'
      + (topSubBrands.length ? `<h2 class="side-h">Branduri</h2><div class="chips">${topSubBrands.map((b) => `<a class="chip" href="${B}/${s.slug}/${b.slug}/">${esc(b.label)} <em>${b.items.length}</em></a>`).join('')}</div>` : '')
      + (siblings.length ? `<h2 class="side-h">Categorii similare</h2><div class="chips">${siblings.map((x) => `<a class="chip" href="${B}/${x.slug}/">${esc(x.label)}</a>`).join('')}</div>` : '');
    writeListing({ dir: `${sdir}${s.slug}`, baseSlug: `${B}/${s.slug}/`, h1: s.label,
      intro: `${s.label}${isShard ? '' : ` (${ML})`}: ${s.items.length} produse, prețuri actualizate ${today}. Filtrează după preț sau brand pentru cea mai bună ofertă.`,
      crumbItems: subCrumb, sideLinks: side, items: s.items });
    const best = [...s.items].sort((a, b) => discount(b) - discount(a) || a.price - b.price).slice(0, 48);
    W(`${sdir}${s.slug}/cel-mai-bun/index.html`, collection({ h1: `${s.label}: cele mai bune oferte ${new Date().getFullYear()}`, slug: `${B}/${s.slug}/cel-mai-bun/`,
      intro: `Cele mai bune oferte la ${s.label}, selectate după reducere și preț, actualizate ${today}.`, products: best, totalCount: best.length,
      crumbItems: [...subCrumb, { name: 'Top oferte', url: `${B}/${s.slug}/cel-mai-bun/` }], sideLinks: side }));
    addSM(`${B}/${s.slug}/cel-mai-bun/`); nFacet++;
    for (const t of priceChips) { const items = s.items.filter((p) => p.price <= t);
      writeListing({ dir: `${sdir}${s.slug}/sub-${t}-lei`, baseSlug: `${B}/${s.slug}/sub-${t}-lei/`, h1: `${s.label} sub ${t} lei`,
        intro: `${s.label} cu preț sub ${t} lei — ${items.length} oferte, actualizate ${today}.`, items,
        crumbItems: [...subCrumb, { name: `sub ${t} lei`, url: `${B}/${s.slug}/sub-${t}-lei/` }], sideLinks: side }); nFacet++; }
    for (const b of topSubBrands) {
      writeListing({ dir: `${sdir}${s.slug}/${b.slug}`, baseSlug: `${B}/${s.slug}/${b.slug}/`, h1: `${b.label} ${s.label}`,
        intro: `${b.label} ${s.label}: ${b.items.length} modele, prețuri actualizate ${today}.`, items: b.items, sideLinks: side,
        crumbItems: [...subCrumb, { name: b.label, url: `${B}/${s.slug}/${b.slug}/` }] }); nFacet++; }
  }
  // mega landing: shard root "/" (paginated over ALL the part's products) or hub/full "/categorie/<mega>/" (overview)
  const multi = isShard && m.parts > 1;
  const landH1 = multi ? m.partLabels[SHARD_PART - 1] : ML;
  const landIntro = multi
    ? `${landH1} (${ML}) — ${m.products.length} produse, prețuri actualizate ${today}. Filtrează după preț sau brand pentru cea mai bună ofertă.`
    : `Toate produsele din ${ML} — ${m.products.length} oferte, pe subcategorii și branduri.`;
  const SIB_MAX = 24;
  const sibs = Array.from({ length: m.parts }, (_, i) => i + 1).filter((k) => k !== SHARD_PART);
  const sideLinks = `<h2>Subcategorii</h2><div class="chips">${m.subcats.map((s) => `<a class="chip" href="${B}/${s.slug}/">${esc(s.label)} <em>${s.items.length}</em></a>`).join('')}</div>`
    + (multi ? `<h2 class="side-h">Mai multe din ${esc(ML)}</h2><div class="chips">${sibs.slice(0, SIB_MAX).map((k) => `<a class="chip" href="${partURL(MS, k)}">${esc(m.partLabels[k - 1] || ML)}</a>`).join('')}${sibs.length > SIB_MAX ? `<a class="chip" href="${hub('/categorii/')}">+${sibs.length - SIB_MAX} categorii →</a>` : ''}</div>` : '');
  const landCrumb = multi
    ? [{ name: 'Acasă', url: '/' }, { name: ML, url: shardURL(MS) + '/' }, { name: landH1, url: `${B}/` }]
    : [{ name: 'Acasă', url: '/' }, { name: ML, url: `${B}/` }];
  if (isShard) {
    writeListing({ dir: '', baseSlug: '/', h1: landH1, intro: landIntro, items: m.products, sideLinks, crumbItems: landCrumb });
  } else {
    W(`categorie/${MS}/index.html`, collection({ h1: landH1, slug: `${B}/`, intro: landIntro, products: m.products.slice(0, 60), crumbItems: landCrumb, sideLinks }));
    addSM(`${B}/`);
  }
}
if (!isHub) MEGAS.forEach(buildMega);
// brand hubs (paginated) — built on EACH shard from ITS OWN brands (self-contained; not sent to hub)
if (!isHub && !isMegaTree) for (const b of gBrands) { if (b.items.length < MIN_BRAND) continue; writeListing({ dir: `brand/${b.slug}`, baseSlug: `/brand/${b.slug}/`, h1: b.label, intro: `${b.label}: ${b.items.length} produse, prețuri actualizate ${today}.`,
  items: b.items, crumbItems: isShard ? [{ name: 'Acasă', url: '/' }, { name: b.label, url: `/brand/${b.slug}/` }] : [{ name: 'Acasă', url: '/' }, { name: 'Branduri', url: '/branduri/' }, { name: b.label, url: `/brand/${b.slug}/` }] }); }
// store pages (per merchant) — hub/full only
if (!isShard && !isMegaTree) for (const st of storeList) {
  const head = `<div class="storehead">${st.logo ? `<div class="sh-logo${st.inv ? ' inv' : ''}"><img src="${esc(st.logo)}" alt="${esc(st.label)}" ${onerr}></div>` : ''}<div class="sh-info"><h1>${esc(st.label)}</h1><p class="sh-meta">${st.items.length} produse din magazinul partener ${esc(st.label)}</p>${st.aff ? `<a class="cta sh-cta" href="/out/${st.slug}/_home/" target="_blank" rel="sponsored nofollow noopener">Vizitează ${esc(st.label)} →</a>` : ''}</div></div>`;
  writeListing({ dir: `magazin/${st.slug}`, baseSlug: `/magazin/${st.slug}/`, h1: st.label, headerHtml: head, items: st.items,
    crumbItems: [{ name: 'Acasă', url: '/' }, { name: 'Magazine', url: '/magazine/' }, { name: st.label, url: `/magazin/${st.slug}/` }] });
}
if (!isShard && !isMegaTree) { // ===== HUB-ONLY pages (home, categorii, branduri, magazine, promotii, legal) =====
// index hubs (rich: cards/chips + product grid, not thin)
const hubFeatured = interleaveShuffled(18);
function hubPage(h1, slug, crumbLabel, inner) {
  const crumb = bc([{ name: 'Acasă', url: '/' }, { name: crumbLabel, url: slug }]);
  return layout({ title: `${h1} | TopBuy.ro`, desc: `${h1} pe TopBuy.ro — navighează rapid prin produse și oferte din magazinele partenere.`, canonical: `${SITE}${slug}`,
    body: `<h1>${esc(h1)}</h1>${inner}`, jsonld: [crumb.schema], breadcrumbHtml: crumb.html });
}
// /categorii: carduri vizuale de categorie + produse populare
W('categorii/index.html', hubPage('Toate categoriile', '/categorii/', 'Categorii',
  `<div class="catcards" style="margin:18px 0 32px">${MEGAS.map(catCard).join('')}</div>
   <section>${sechead('Produse populare')}${grid(hubFeatured)}</section>`));
addSM('/categorii/');
// /branduri: branduri populare (cu produs reprezentativ) + toate brandurile + produse de top
const topBrandProducts = gBrands.slice(0, 18).map((b) => b.items[0]).filter(Boolean);
const BRANDS_SHOWN = 300; // TODO: paginare /branduri când catalogul e complet (mii de branduri)
if (!isHub) W('branduri/index.html', hubPage('Toate brandurile', '/branduri/', 'Branduri',
  `<section>${sechead('Produse de la branduri de top')}${grid(topBrandProducts)}</section>
   <section>${sechead('Toate brandurile')}<div class="chips">${gBrands.slice(0, BRANDS_SHOWN).map((b) => `<a class="chip" href="/brand/${b.slug}/">${esc(b.label)} <em>${b.items.length}</em></a>`).join('')}</div>${gBrands.length > BRANDS_SHOWN ? `<p class="intro" style="margin-top:14px">+${gBrands.length - BRANDS_SHOWN} branduri</p>` : ''}</section>`));
if (!isHub) addSM('/branduri/');
// /magazine: toate magazinele partenere (logo-uri -> pagina magazinului)
W('magazine/index.html', hubPage('Magazine partenere', '/magazine/', 'Magazine',
  `<div class="stores" style="margin-top:18px">${storeList.map((s) => `<a class="storelogo${s.inv ? ' inv' : ''}" href="/magazin/${s.slug}/" title="${esc(s.label)}">${s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.label)}" loading="lazy" ${onerr}>` : `<span class="sl-name">${esc(s.label)}</span>`}</a>`).join('')}</div>`));
addSM('/magazine/');
// /promotii: promoții & vouchere active din magazinele partenere
W('promotii/index.html', hubPage('Promoții și vouchere', '/promotii/', 'Promoții',
  PROMOS.length ? `<p class="intro" style="margin-top:6px">Reduceri, coduri și campanii active din magazinele partenere, actualizate periodic.</p>${promoGrid(PROMOS)}` : `<p class="intro">Momentan nu sunt promoții active.</p>`));
addSM('/promotii/');
// home (mixed across all categories — interleave one per category per round)
const featured = interleaveShuffled(30);
const homeSchema = [{ '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: SITE + '/' },
  { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: SITE + '/', ...(isHub ? {} : { potentialAction: { '@type': 'SearchAction', target: `${SITE}/cautare/?q={q}`, 'query-input': 'required name=q' } }) },
  itemListSchema(featured, 'Produse recomandate')];
const topDeals = shuffled(ALL.filter((p) => discount(p) >= 15).sort((a, b) => discount(b) - discount(a)).slice(0, 60)).slice(0, 10);
const homeBody = `<section class="hero"><h1>Descoperă mii de produse și oferte</h1><p class="sub">din magazinele tale preferate, într-un singur loc.</p>
  ${isHub ? '' : `<form class="herosearch" onsubmit="return tbSearch(this)"><input placeholder="Caută produse…" aria-label="Caută produse"><button type="submit">Caută</button></form>`}
  <div class="herobtns"><a class="hb-primary" href="/categorii/">Categorii</a><a class="hb" href="/magazine/">Magazine</a>${PROMOS.length ? `<a class="hb-promo" href="/promotii/">Promoții</a>` : ''}</div></section>
  <div class="statband"><div><b>${MEGAS.reduce((a, m) => a + (m._count != null ? m._count : m.products.length), 0).toLocaleString('ro-RO')}</b><span>produse</span></div><div><b>${storeList.length}</b><span>magazine partenere</span></div><div><b>${MEGAS.length}</b><span>categorii</span></div><div><b>Zilnic</b><span>prețuri actualizate</span></div></div>
  ${topDeals.length >= 6 ? `<section>${sechead('Cele mai mari reduceri')}${grid(topDeals)}</section>` : ''}
  ${PROMOS.length ? `<section>${sechead('Promoții & vouchere', '/promotii/')}${promoGrid(shuffled(PROMOS).slice(0, 6))}</section>` : ''}
  ${MEGAS.map((m) => m.products.length >= 6 ? `<section>${sechead(m.label, catLink(m.slug))}${grid(shuffled(m.products).slice(0, 10))}</section>` : '').join('')}
  <section>${sechead('Categorii')}<div class="catcards">${MEGAS.map(catCard).join('')}</div></section>
  ${isHub ? '' : `<section>${sechead('Branduri populare', '/branduri/')}<div class="chips">${gBrands.slice(0, 24).map((b) => `<a class="chip" href="/brand/${b.slug}/">${esc(b.label)}</a>`).join('')}</div></section>`}
  <section>${sechead('Magazine partenere', '/magazine/')}<div class="stores">${storeList.slice(0, 30).map((s) => `<a class="storelogo${s.inv ? ' inv' : ''}" href="/magazin/${s.slug}/" title="${esc(s.label)}">${s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.label)}" loading="lazy" ${onerr}>` : `<span class="sl-name">${esc(s.label)}</span>`}</a>`).join('')}</div></section>`;
W('index.html', layout({ title: 'TopBuy.ro — produse și oferte din magazinele din România', desc: 'Descoperă mii de produse și oferte din magazinele tale preferate. Reduceri actualizate zilnic.', canonical: SITE + '/', body: homeBody, jsonld: homeSchema, noSearch: true }));
addSM('/');
// legal / info pages
const LEGAL = [
  ['despre', 'Despre TopBuy.ro', 'Ce este TopBuy.ro — platformă de descoperire produse și oferte din magazine online din România.',
    `<p>TopBuy.ro este o platformă online de descoperire a produselor și ofertelor din magazine partenere din România. Adunăm într-un singur loc mii de produse din zeci de magazine, le organizăm pe categorii, subcategorii și branduri și le punem la dispoziție într-un mod ușor de explorat, astfel încât să găsești rapid exact ce cauți.</p>
     <h2>Cum funcționează</h2>
     <p>Preluăm informațiile despre produse (titlu, preț, imagine, disponibilitate, magazin) din feedurile puse la dispoziție de magazinele partenere și le actualizăm periodic. Pentru fiecare produs îți arătăm prețul și magazinul, iar atunci când dorești să cumperi, te direcționăm către site-ul magazinului respectiv, unde plasezi și finalizezi comanda în siguranță.</p>
     <h2>Ce nu suntem</h2>
     <p>TopBuy.ro <strong>nu este un magazin online</strong> și nu vinde produse în mod direct. Nu procesăm comenzi, plăți sau livrări și nu deținem stoc. Rolul nostru este de descoperire și organizare a ofertelor; tranzacția propriu-zisă are loc între tine și magazinul ales.</p>
     <h2>Misiunea noastră</h2>
     <p>Ne dorim să-ți economisim timp și să-ți ușurăm deciziile de cumpărare: în loc să cauți pe zeci de site-uri, găsești ofertele relevante grupate logic, cu prețuri actualizate și cu acces direct la magazin.</p>
     <h2>Transparență</h2>
     <p>Suntem susținuți prin programe de marketing afiliat — putem primi un comision când cumperi prin linkurile noastre, fără ca prețul tău să crească. Detalii în <a href="/disclaimer-afiliere/">Disclaimer afiliere</a>. Pentru întrebări, ne găsești la <a href="/contact/">Contact</a>.</p>`],
  ['cum-alegem', 'Cum alegem produsele', 'Metodologia după care selectăm, organizăm și actualizăm produsele afișate pe TopBuy.ro.',
    `<p>Transparența privind modul în care ajung produsele pe site este importantă pentru noi. Mai jos explicăm pe scurt cum lucrăm.</p>
     <h2>Sursa datelor</h2>
     <p>Toate produsele provin din feedurile oficiale puse la dispoziție de magazinele partenere. Nu inventăm prețuri și nu modificăm informațiile despre produse — le preluăm și le structurăm așa cum sunt furnizate de magazin.</p>
     <h2>Organizare și clasificare</h2>
     <p>Clasificăm automat fiecare produs într-o categorie și subcategorie relevantă și îl asociem brandului și magazinului corespunzător. Construim astfel pagini de categorii, branduri și magazine care îți permit să navighezi rapid.</p>
     <h2>Stoc și disponibilitate</h2>
     <p>Afișăm cu prioritate produsele marcate ca fiind <strong>în stoc</strong> la momentul actualizării feedului. Produsele scoase din stoc sau eliminate din feed sunt actualizate la următoarea sincronizare.</p>
     <h2>Reduceri și oferte</h2>
     <p>Evidențiem reducerile calculând diferența dintre prețul curent și prețul anterior comunicat în feed. Aplicăm verificări pentru a evita afișarea unor procente eronate.</p>
     <h2>Acuratețe și actualizare</h2>
     <p>Actualizăm datele periodic, însă pot exista decalaje față de site-ul magazinului. <strong>Prețul și disponibilitatea valabile sunt întotdeauna cele afișate pe site-ul magazinului în momentul comenzii.</strong></p>
     <h2>Independență editorială</h2>
     <p>Modul în care organizăm și evidențiem produsele nu este influențat de comisioanele de afiliere. Dacă observi o eroare, scrie-ne la <a class="mail" href="mailto:contact@topbuy.ro">contact@topbuy.ro</a>.</p>`],
  ['contact', 'Contact', 'Contactează echipa TopBuy.ro prin email.',
    `<p>Pentru întrebări, sugestii, sesizarea unor erori de preț sau disponibilitate ori solicitări legate de date personale, ne poți scrie oricând la:</p>
     <p><a class="mail" href="mailto:contact@topbuy.ro">contact@topbuy.ro</a></p>
     <p>Răspundem, de regulă, în 1–2 zile lucrătoare. Pentru aspecte legate de o comandă (livrare, plată, retur, garanție), te rugăm să contactezi direct magazinul de la care ai cumpărat, întrucât TopBuy.ro nu este parte în tranzacție.</p>`],
  ['disclaimer-afiliere', 'Disclaimer afiliere', 'Cum funcționează linkurile afiliate pe TopBuy.ro și ce înseamnă pentru tine.',
    `<p>Pentru a putea funcționa și a-ți oferi gratuit acest serviciu, TopBuy.ro participă în programe de <strong>marketing afiliat</strong> împreună cu magazinele partenere.</p>
     <h2>Ce înseamnă</h2>
     <p>Unele linkuri de pe site sunt linkuri afiliate. Atunci când accesezi un astfel de link și cumperi un produs din magazinul partener, este posibil să primim un comision din partea magazinului pentru recomandare.</p>
     <h2>Fără cost suplimentar pentru tine</h2>
     <p>Comisionul este suportat integral de magazin. <strong>Prețul pe care îl plătești rămâne exact același</strong>, indiferent dacă ajungi la magazin prin TopBuy.ro sau direct. Nu există costuri ascunse pentru tine.</p>
     <h2>Independență</h2>
     <p>Selecția, clasificarea și evidențierea produselor nu sunt influențate de existența sau valoarea comisionului. Scopul nostru este să-ți fie util site-ul, nu să favorizăm anumite produse.</p>
     <h2>Întrebări</h2>
     <p>Pentru orice nelămurire legată de modul în care funcționăm, ne poți contacta la <a class="mail" href="mailto:contact@topbuy.ro">contact@topbuy.ro</a>.</p>`],
  ['confidentialitate', 'Politica de confidențialitate', 'Cum colectăm, folosim și protejăm datele pe TopBuy.ro, conform GDPR.',
    `<p>Confidențialitatea ta este importantă pentru noi. Această politică explică ce date prelucrăm atunci când vizitezi TopBuy.ro și care sunt drepturile tale, în conformitate cu Regulamentul (UE) 2016/679 (GDPR) și legislația română aplicabilă.</p>
     <h2>Operatorul datelor</h2>
     <p>Operatorul site-ului TopBuy.ro este responsabil de prelucrarea datelor descrise mai jos. Ne poți contacta în orice chestiune privind datele personale la <a class="mail" href="mailto:contact@topbuy.ro">contact@topbuy.ro</a>.</p>
     <h2>Ce date prelucrăm</h2>
     <p>Prelucrăm un volum minim de date, în principal de natură tehnică: adresă IP (de regulă anonimizată), tip de browser și dispozitiv, pagini vizitate și date statistice agregate de utilizare, colectate prin cookie-uri și instrumente de analiză. Nu solicităm crearea de cont și nu colectăm date de plată, întrucât nu vindem direct.</p>
     <h2>Scopurile și temeiul legal</h2>
     <p>Folosim aceste date pentru: (a) funcționarea și securitatea site-ului — temei: interesul legitim; (b) statistici și îmbunătățirea experienței — temei: consimțământul tău (cookie-uri de statistică). Îți poți retrage oricând consimțământul.</p>
     <h2>Cookie-uri și analiză</h2>
     <p>Folosim cookie-uri esențiale și de statistică. Pentru detalii complete, vezi <a href="/politica-cookies/">Politica de cookies</a>.</p>
     <h2>Destinatari și terți</h2>
     <p>Putem folosi furnizori de servicii (de exemplu pentru găzduire și statistici de trafic) care prelucrează date în numele nostru, cu garanții adecvate. Linkurile către magazinele partenere te conduc pe site-uri terțe, care au propriile politici de confidențialitate.</p>
     <h2>Durata stocării</h2>
     <p>Păstrăm datele statistice doar atât timp cât este necesar scopurilor de mai sus, după care sunt șterse sau anonimizate.</p>
     <h2>Drepturile tale</h2>
     <p>Conform GDPR, ai dreptul de: acces la date; rectificare; ștergere („dreptul de a fi uitat"); restricționarea prelucrării; opoziție; portabilitatea datelor; retragerea consimțământului în orice moment.</p>
     <h2>Cum îți exerciți drepturile</h2>
     <p>Trimite o cerere la <a class="mail" href="mailto:contact@topbuy.ro">contact@topbuy.ro</a>. Răspundem în termenele prevăzute de lege.</p>
     <h2>Plângeri</h2>
     <p>Dacă ești nemulțumit de modul în care îți tratăm datele, ai dreptul să te adresezi Autorității Naționale de Supraveghere a Prelucrării Datelor cu Caracter Personal (ANSPDCP).</p>
     <h2>Modificări</h2>
     <p>Putem actualiza această politică periodic. Versiunea curentă este cea publicată pe această pagină.</p>`],
  ['termeni', 'Termeni și condiții', 'Termenii și condițiile de utilizare a site-ului TopBuy.ro.',
    `<p>Bine ai venit pe TopBuy.ro. Prin accesarea și utilizarea acestui site, ești de acord cu termenii de mai jos. Dacă nu ești de acord, te rugăm să nu folosești site-ul.</p>
     <h2>Rolul TopBuy.ro</h2>
     <p>TopBuy.ro este o platformă informativă de descoperire a produselor și ofertelor. Nu vindem produse, nu deținem stoc și nu suntem parte în contractul de vânzare-cumpărare dintre tine și magazinul partener.</p>
     <h2>Comenzi, plată, livrare</h2>
     <p>Comanda, plata, livrarea, returul și garanția sunt gestionate exclusiv de magazinul de la care cumperi, conform termenilor acestuia. Orice reclamație legată de o comandă se adresează direct magazinului respectiv.</p>
     <h2>Prețuri și disponibilitate</h2>
     <p>Prețurile și disponibilitatea afișate pe TopBuy.ro provin din feeduri și au caracter orientativ. Ele pot diferi de cele de pe site-ul magazinului. Informațiile valabile sunt cele afișate de magazin în momentul plasării comenzii.</p>
     <h2>Linkuri către terți</h2>
     <p>Site-ul conține linkuri către site-uri terțe (magazine partenere). Nu controlăm și nu răspundem pentru conținutul, politicile sau practicile acestora.</p>
     <h2>Proprietate intelectuală</h2>
     <p>Denumirile de mărci, logo-urile și imaginile produselor aparțin titularilor de drept. Structura, textele și elementele proprii TopBuy.ro nu pot fi reproduse fără acordul nostru.</p>
     <h2>Limitarea răspunderii</h2>
     <p>Depunem eforturi rezonabile pentru acuratețea informațiilor, dar nu garantăm că acestea sunt complete sau lipsite de erori. Nu răspundem pentru eventuale prejudicii rezultate din neconcordanțe de preț/stoc sau din interacțiunea cu magazinele partenere.</p>
     <h2>Disponibilitatea site-ului</h2>
     <p>Putem modifica, suspenda sau întrerupe oricând, total sau parțial, funcționarea site-ului, fără notificare prealabilă.</p>
     <h2>Modificarea termenilor și legea aplicabilă</h2>
     <p>Putem actualiza acești termeni periodic. Utilizarea site-ului după modificări înseamnă acceptarea lor. Acestor termeni li se aplică legea română, iar eventualele litigii se soluționează de instanțele competente din România.</p>`],
  ['politica-cookies', 'Politica de cookies', 'Ce cookie-uri folosim pe TopBuy.ro, în ce scop și cum le poți gestiona.',
    `<p>Această politică explică ce sunt cookie-urile, ce tipuri folosim pe TopBuy.ro și cum le poți controla.</p>
     <h2>Ce sunt cookie-urile</h2>
     <p>Cookie-urile sunt fișiere text de mici dimensiuni salvate de browser pe dispozitivul tău atunci când vizitezi un site. Ele ajută site-ul să funcționeze corect și permit colectarea unor statistici de utilizare.</p>
     <h2>Ce tipuri folosim</h2>
     <p><strong>Cookie-uri esențiale</strong> — strict necesare pentru funcționarea de bază a site-ului (de exemplu, reținerea faptului că ai închis bannerul de cookie-uri). Acestea nu pot fi dezactivate.</p>
     <p><strong>Cookie-uri de statistică / analiză</strong> — ne ajută să înțelegem, în mod agregat și anonim, cum este folosit site-ul (pagini vizitate, durată, dispozitiv), pentru a-l îmbunătăți.</p>
     <h2>Consimțământ</h2>
     <p>La prima vizită îți afișăm un banner prin care îți poți exprima acordul pentru cookie-urile de statistică. Îți poți retrage consimțământul oricând ștergând cookie-urile din browser.</p>
     <h2>Cum gestionezi cookie-urile</h2>
     <p>Poți bloca sau șterge cookie-urile din setările browserului (Chrome, Firefox, Safari, Edge etc.). Reține că dezactivarea anumitor cookie-uri poate afecta funcționarea site-ului.</p>
     <h2>Cookie-uri terțe</h2>
     <p>Unele instrumente de statistică pot seta cookie-uri proprii. Acestea sunt guvernate de politicile furnizorilor respectivi.</p>
     <h2>Modificări</h2>
     <p>Putem actualiza periodic această politică. Te invităm să o consulți din când în când.</p>`],
];
for (const [s, h1, desc, content] of LEGAL) {
  W(`${s}/index.html`, layout({ title: `${h1} | TopBuy.ro`, desc, canonical: `${SITE}/${s}/`,
    breadcrumbHtml: bc([{ name: 'Acasă', url: '/' }, { name: h1, url: `/${s}/` }]).html,
    body: `<div class="legal"><h1>${h1}</h1>${content}</div>`, jsonld: [bc([{ name: 'Acasă', url: '/' }, { name: h1, url: `/${s}/` }]).schema] }));
  addSM(`/${s}/`);
}
} // ===== end HUB-ONLY =====
// static assets (logo + favicons) + PWA manifest
for (const f of ['logo.png', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
  try { copyFileSync(join(__dirname, f), join(DIST, f)); } catch (e) { /* asset optional */ }
}
W('site.webmanifest', JSON.stringify({ name: SITE_NAME, short_name: 'TopBuy', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#f7941d', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }));
// search: client-side index + page (hub only)
if (!isShard && !isHub && !isMegaTree) {
W('search-index.json', JSON.stringify(ALL.map((p) => ({ t: p.title, u: `/produs/${p.slug}/`, p: p.price, o: p.oldPrice, i: p.img, b: p.brand }))));
W('cautare/index.html', layout({ title: 'Caută produse | TopBuy.ro', desc: 'Caută printre mii de produse și oferte din magazinele partenere.', canonical: `${SITE}/cautare/`, body: `
  <h1 id="rh">Caută produse</h1>
  <form class="herosearch" style="margin:16px 0 26px;max-width:660px" onsubmit="run();return false"><input id="sq" placeholder="Caută produse…" autofocus aria-label="Caută"><button type="button" onclick="run()">Caută</button></form>
  <div class="grid" id="res"></div>
  <script>
  var idx=[],input=document.getElementById('sq');
  var _p=location.pathname.replace(/^\\/+cautare\\/+/,'').replace(/\\/+$/,'');input.value=_p?decodeURIComponent(_p).replace(/-/g,' '):(new URLSearchParams(location.search).get('q')||'');
  function money(n){return Number(n).toLocaleString('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2})+' lei';}
  function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function card(p){var d=p.o&&p.o>p.p?Math.round((1-p.p/p.o)*100):0;return '<a class="card" href="'+p.u+'"><div class="thumb"><img src="'+esc(p.i)+'" alt="'+esc(p.t)+'" loading="lazy"></div><div class="ci">'+(p.b?'<span class="brand">'+esc(p.b)+'</span>':'')+'<span class="ci-t">'+esc(p.t)+'</span><div class="price">'+money(p.p)+(d?'<span class="old">'+money(p.o)+'</span><span class="badge">-'+d+'%</span>':'')+'</div></div></a>';}
  function run(){var q=input.value.trim().toLowerCase(),rh=document.getElementById('rh'),res=document.getElementById('res');if(!q){rh.textContent='Caută produse';res.innerHTML='';return;}var terms=q.split(/\\s+/);var m=idx.filter(function(p){var t=p.t.toLowerCase();return terms.every(function(w){return t.indexOf(w)>=0;});});rh.textContent=m.length?(m.length+(m.length>200?'+':'')+' rezultate pentru „'+q+'”'):'Niciun rezultat pentru „'+q+'”';res.innerHTML=m.slice(0,200).map(card).join('');history.replaceState(0,'','/cautare/'+encodeURIComponent(q.replace(/\\s+/g,'-'))+'/');}
  input.addEventListener('input',run);
  fetch('/search-index.json').then(function(r){return r.json();}).then(function(d){idx=d;run();});
  </script>`, jsonld: [] }));
addSM('/cautare/');
}
const STORES = {}; storeList.forEach((s) => { if (s.aff) STORES[s.slug] = { u: s.aff.u, c: s.aff.code }; });
const PROMOMAP = {}; PROMOS.forEach((p) => { if (p.landing && p.code) PROMOMAP[p.id] = { u: p.landing, c: p.code, e: p.end || '' }; });
// ---- server /_data maps for the Node /out + /img service ----
if (isMegaTree) {
  const mg = MEGAS[0]; mkdirSync(join(DIST, '_data'), { recursive: true });
  writeFileSync(join(DIST, '_data', `campaign-${mg.slug}.json`), JSON.stringify(CAMPAIGN));
  // meta for the global pass: count + sample (≤8/merchant, no `sub` → relative /produs/ links on the single-domain server)
  const seen = {}, sample = [];
  for (const p of mg.products) { const k = p.merchantSlug; if ((seen[k] = (seen[k] || 0)) >= 8) continue; seen[k]++; sample.push({ slug: p.slug, title: p.title, price: p.price, oldPrice: p.oldPrice, img: p.img, brand: p.brand, brandSlug: p.brandSlug, merchant: p.merchant, merchantSlug: p.merchantSlug }); }
  writeFileSync(join(DIST, '_data', `meta-${mg.slug}.json`), JSON.stringify({ slug: mg.slug, label: mg.label, count: mg.products.length, sample }));
}
else if (SERVER) { mkdirSync(join(DIST, '_data'), { recursive: true }); const allStores = {}; for (const [slug, a] of Object.entries(SAFF)) if (a && a.code) allStores[slug] = { u: a.u, c: a.code }; writeFileSync(join(DIST, '_data', 'stores.json'), JSON.stringify(allStores)); writeFileSync(join(DIST, '_data', 'promos.json'), JSON.stringify(PROMOMAP)); }
else if (!isShard && !isHub) { mkdirSync(join(DIST, '_data'), { recursive: true }); writeFileSync(join(DIST, '_data', 'campaign.json'), JSON.stringify(CAMPAIGN)); writeFileSync(join(DIST, '_data', 'stores.json'), JSON.stringify(STORES)); writeFileSync(join(DIST, '_data', 'promos.json'), JSON.stringify(PROMOMAP)); }
// ---- CF /out + /img Functions (only for CF deploys, NOT server modes) ----
if (!isMegaTree && !SERVER) {
const fnDir = join(DIST, '..', 'functions', 'out', '[merchant]'); mkdirSync(fnDir, { recursive: true });
writeFileSync(join(fnDir, '[id].js'), `const SITE=${JSON.stringify(SITE)};const AFF_CODE=${JSON.stringify(AFF_CODE)};const CAMPAIGN=${JSON.stringify(CAMPAIGN)};const STORES=${JSON.stringify(STORES)};const PROMOS=${JSON.stringify(PROMOMAP)};
export function onRequest({params}){const m=params.merchant,id=params.id;
if(m==='_promo'){const p=PROMOS[id];if(!p||(p.e&&Date.parse(p.e)<Date.now()))return Response.redirect(SITE+'/promotii/',302);return Response.redirect('https://event.2performant.com/events/click?ad_type=quicklink&aff_code='+AFF_CODE+'&unique='+p.c+'&redirect_to='+encodeURIComponent(p.u),302);}
if(id==='_home'){const s=STORES[m];if(!s)return new Response('Not found',{status:404});return Response.redirect('https://event.2performant.com/events/click?ad_type=quicklink&aff_code='+AFF_CODE+'&unique='+s.c+'&redirect_to='+encodeURIComponent(s.u),302);}
const cu=CAMPAIGN[m];if(!cu||!id)return new Response('Not found',{status:404});
return Response.redirect('https://event.2performant.com/events/click?ad_type=product_store&unique='+encodeURIComponent(id)+'&aff_code='+AFF_CODE+'&campaign_unique='+cu,302);}\n`);
// /img image proxy (only hit when a direct image fails browser-side; own-domain Referer bypasses hotlink protection; edge-cached 7d)
writeFileSync(join(DIST, '..', 'functions', 'img.js'), `export async function onRequest(context){
const url=new URL(context.request.url);let t=url.searchParams.get('u');if(!t)return new Response('',{status:400});
let d;try{d=decodeURIComponent(t)}catch(e){d=t}if(!/^https?:\\/\\//.test(d))d='https://'+d;
let o='';try{o=new URL(d).origin}catch(e){}
const c=caches.default,k=new Request(url.toString());let h=await c.match(k);if(h)return h;
let r;try{r=await fetch(d,{headers:{'Referer':o+'/','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36','Accept':'image/avif,image/webp,image/*,*/*'},cf:{cacheEverything:true,cacheTtl:604800}})}catch(e){return new Response('',{status:502})}
if(!r.ok)return new Response('',{status:502});
const resp=new Response(r.body,{headers:{'content-type':r.headers.get('content-type')||'image/jpeg','cache-control':'public, max-age=604800','access-control-allow-origin':'*'}});
context.waitUntil(c.put(k,resp.clone()));return resp;}\n`);
} // end CF Functions
// sitemap: shard/small-full = urlset; hub (or >45k) = sitemap-index (own chunks + shard sitemaps)
const allUrls = [...new Set(SITEMAP)];
const urlset = (arr) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${arr.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const idx = (locs) => `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;
const CHUNK = 45000;
const SHARDS = (process.env.SHARDS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean); // hub: subdomain origins
if (isMegaTree) {
  const mslug = MEGAS[0].slug; const parts = []; for (let i = 0; i < allUrls.length; i += CHUNK) parts.push(allUrls.slice(i, i + CHUNK));
  parts.forEach((p, i) => W(`sitemap-${mslug}-${i + 1}.xml`, urlset(p)));
} else if (SERVER) {
  /* sitemap.xml index is built on the server (globs sitemap-*.xml) after all megas land */
} else if (allUrls.length <= CHUNK && !(isHub && SHARDS.length)) {
  W('sitemap.xml', urlset(allUrls));
} else {
  const parts = []; for (let i = 0; i < allUrls.length; i += CHUNK) parts.push(allUrls.slice(i, i + CHUNK));
  const ownLocs = parts.map((p, i) => { W(`sitemap-${i + 1}.xml`, urlset(p)); return `${SITE}/sitemap-${i + 1}.xml`; });
  const shardLocs = (isHub ? SHARDS : []).map((s) => `${s}/sitemap.xml`);
  W('sitemap.xml', idx([...ownLocs, ...shardLocs]));
}
W('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
W('_redirects', `/cautare/* /cautare/ 200\n`);
console.log('sitemap URLs:', allUrls.length);

console.log('produs:', nProd, '| categorii:', MEGAS.length, '| subcat total:', MEGAS.reduce((a, m) => a + m.subcats.length, 0), '| facet/best-of:', nFacet, '| branduri:', gBrands.length, '| magazine:', Object.keys(CAMPAIGN).length);
console.timeEnd('generate');
