# topbuy-deploy

Cloud build+deploy of topbuy.ro product shards (Cloudflare Pages, 6 accounts) via GitHub Actions.

- `productsite/generate.mjs` — static generator (product pages, shards, /out + /img Functions).
- `scripts/run-mega.mjs` — per-mega job: download feeds → split → build+deploy each part to its CF account + custom domain + CNAME.
- `data/` — feed URLs per mega, shard→account map, merchant logos/affiliate, protected (proxied-image) merchants.
- `.github/workflows/deploy.yml` — matrix over megas, daily cron (incremental redeploy) + manual.

Secrets required: `CF_ACCOUNTS` (JSON `[{id,email,key},...]`, index 0 = account holding the topbuy.ro zone), `CF_ZONE` (zone id).
Deploys are incremental: wrangler only uploads changed files per project.
