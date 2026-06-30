#!/usr/bin/env node
// Dashboard wipe TEST — back up the 8 reporting source tables, then optionally wipe / restore.
// FULLY REVERSIBLE: backup writes every row to JSON; restore rebuilds via json_populate_recordset
// (preserves ids + all columns). Wipe refuses unless a fresh backup exists.
//   node scripts/n8n/wipe_test_dashboard.js backup    # snapshot all rows → workflow-logs/backups/wipe_test/
//   node scripts/n8n/wipe_test_dashboard.js wipe       # DELETE all rows (children→parents)  [needs backup]
//   node scripts/n8n/wipe_test_dashboard.js restore     # re-insert from the latest backup (parents→children)
//   node scripts/n8n/wipe_test_dashboard.js status      # row counts now
(() => { const fs = require('fs'), path = require('path'); let d = __dirname; for (let i = 0; i < 7; i++) { const p = path.join(d, 'config', 'secrets', '.env'); if (fs.existsSync(p)) { require('dotenv').config({ path: p }); return; } d = path.dirname(d); } })();
const fs = require('fs'), path = require('path');
const REF = 'braxlluhffpmdvtxstjx', PAT = process.env.SUPABASE_PERSONAL_ACCESS_TOKEN, P = 'stabletrack_content_pipeline';
const BKDIR = path.join(__dirname, '..', '..', 'workflow-logs', 'backups', 'wipe_test');
// delete order = children before parents (FK: blog_topics/social_posts → strategy_report); restore = reverse.
const TABLES = ['strategy_blog_topics', 'strategy_social_posts', 'strategy_report', 'marketing_intel_signals', 'marketing_intel_report', 'performance_signals', 'performance_metrics', 'performance_social_stats'];
const mode = process.argv[2];

const sql = async (q) => { const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }); const b = await r.text(); if (r.status >= 400) throw new Error(`SQL ${r.status}: ${b.slice(0, 400)}`); try { return JSON.parse(b); } catch { return b; } };
const counts = async () => { const u = TABLES.map(t => `select '${t}' tbl, count(*) n from ${P}.${t}`).join(' union all '); return sql(u + ' order by tbl;'); };

(async () => {
  if (!PAT) { console.error('❌ SUPABASE_PERSONAL_ACCESS_TOKEN missing'); process.exit(1); }

  if (mode === 'status') { console.table(await counts()); return; }

  if (mode === 'backup') {
    fs.mkdirSync(BKDIR, { recursive: true });
    const manifest = {};
    for (const t of TABLES) {
      const rows = await sql(`select coalesce(json_agg(x),'[]'::json) j from ${P}.${t} x;`);
      const data = rows[0].j;
      fs.writeFileSync(path.join(BKDIR, `${t}.json`), JSON.stringify(data));
      manifest[t] = data.length;
      console.log(`  💾 ${t}: ${data.length} rows`);
    }
    fs.writeFileSync(path.join(BKDIR, '_manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`✅ backup → ${BKDIR}`);
    return;
  }

  if (mode === 'wipe') {
    if (!fs.existsSync(path.join(BKDIR, '_manifest.json'))) { console.error('❌ no backup found — run `backup` first'); process.exit(1); }
    let q = 'begin;\n';
    for (const t of TABLES) q += `delete from ${P}.${t};\n`;  // already child→parent order
    q += `notify pgrst, 'reload schema';\ncommit;`;
    await sql(q);
    console.log('🧹 wiped all 8 source tables (in one transaction). Dashboard views should now be empty.');
    console.table(await counts());
    return;
  }

  if (mode === 'restore') {
    const man = path.join(BKDIR, '_manifest.json');
    if (!fs.existsSync(man)) { console.error('❌ no backup found'); process.exit(1); }
    const order = [...TABLES].reverse(); // parents → children
    // which tables have a GENERATED-identity id? those need OVERRIDING SYSTEM VALUE to keep original ids
    const idcols = await sql(`select table_name, identity_generation from information_schema.columns where table_schema='${P}' and column_name='id' and is_identity='YES';`);
    const needsOverride = new Set((idcols || []).map(r => r.table_name));
    let q = 'begin;\n';
    for (const t of order) {
      const data = JSON.parse(fs.readFileSync(path.join(BKDIR, `${t}.json`), 'utf8'));
      if (!data.length) continue;
      const j = JSON.stringify(data).replace(/\$json\$/g, '');
      const ov = needsOverride.has(t) ? ' overriding system value' : '';
      q += `insert into ${P}.${t}${ov} select * from json_populate_recordset(null::${P}.${t}, $json$${j}$json$);\n`;
    }
    q += `notify pgrst, 'reload schema';\ncommit;`;
    await sql(q);
    console.log('♻️  restored all rows from backup.');
    console.table(await counts());
    return;
  }

  console.log('usage: node scripts/n8n/wipe_test_dashboard.js [backup|wipe|restore|status]');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
