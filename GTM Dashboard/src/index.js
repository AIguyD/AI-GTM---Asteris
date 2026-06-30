// Content Pipeline Dashboard worker.
// Serves a PASSWORD-PROTECTED dashboard (branded login page + signed cookie session) +
// an /api/chat endpoint that answers over the live `reporting` views via Claude.
// Credentials are Worker secrets DASH_USER / DASH_PASS (never hardcoded). CLAUDE/Supabase keys likewise.
// ALL reporting views — ordered richest/most-asked first so the most useful data survives truncation.
const VIEWS = ['weekly_reports', 'strategy_current_brief', 'strategy_content_slate', 'marketing_intel_latest', 'pipeline_action_items', 'performance_metrics_latest', 'performance_keywords_movers', 'performance_competitors_latest', 'performance_social_scorecard', 'performance_social_trend', 'performance_signals_open', 'marketing_intel_signals_open', 'strategy_pipeline_status', 'performance_report_latest', 'pipeline_data_catalog'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST,OPTIONS' };
const COOKIE = 'dash_auth';
const enc = new TextEncoder();

// --- signed-cookie session (HMAC over the username, signed with the password) ---
async function sign(val, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(val));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}
async function makeToken(user, secret) { return user + '.' + await sign(user, secret); }
async function validToken(token, user, secret) {
  if (!token || !user || !secret) return false;
  const i = token.lastIndexOf('.'); if (i < 1) return false;
  if (token.slice(0, i) !== user) return false;
  return token.slice(i + 1) === await sign(user, secret);
}
function getCookie(request, name) { const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m && m[1]; }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const USER = (env.DASH_USER || '').trim(), PASS = (env.DASH_PASS || '').trim();

    // brand images are public so the login page can show the logo (not sensitive)
    if (path === '/logo.png' || path === '/icon.png' || path === '/favicon.ico') return env.ASSETS.fetch(request);

    // ---- login ----
    if (path === '/login') {
      if (request.method === 'POST') {
        const form = await request.formData();
        const u = (form.get('username') || '').toString().trim(), p = (form.get('password') || '').toString();
        if (USER && PASS && u === USER && p === PASS) {
          const token = await makeToken(u, PASS);
          return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` } });
        }
        return new Response(loginHTML(true), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(loginHTML(false), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/logout') {
      return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } });
    }

    const authed = await validToken(getCookie(request, COOKIE), USER, PASS);

    // ---- chat API (requires auth) ----
    if (path === '/api/chat') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (!authed) return new Response(JSON.stringify({ answer: 'Error: not signed in.' }), { status: 401, headers: { 'content-type': 'application/json', ...CORS } });
      try {
        const CK = (env.CLAUDE_API_KEY || '').trim(), AK = (env.SUPABASE_ANON_KEY || '').trim(), SBU = (env.SUPABASE_URL || '').trim();
        if (!CK) return new Response(JSON.stringify({ answer: 'Error: CLAUDE_API_KEY secret missing on the worker.' }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
        if (!AK || !SBU) return new Response(JSON.stringify({ answer: 'Error: SUPABASE vars missing on the worker.' }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
        const { question, history } = await request.json();
        const data = {};
        await Promise.all(VIEWS.map(async v => {
          try { const r = await fetch(`${SBU}/rest/v1/${v}?limit=200`, { headers: { apikey: AK, Authorization: `Bearer ${AK}`, 'Accept-Profile': 'reporting' } }); data[v] = r.ok ? await r.json() : []; } catch (e) { data[v] = []; }
        }));
        const context = JSON.stringify(data).slice(0, 200000);
        const system = `You are the analyst for StableTrack's GTM pipeline. Answer ONLY from the JSON below — the live "reporting" views covering the whole pipeline:
- weekly_reports: per-week Performance reports (headline, top_wins, top_concerns, action_items, report_metrics, full report_md)
- strategy_current_brief + strategy_content_slate: the active fortnightly strategy brief (thesis/positioning/audience/tone) + its commissioned blog topics & social posts
- marketing_intel_latest + marketing_intel_signals_open: latest market-intel report (headline, industry themes, customer language, competitor moves, content topics, upcoming events) + open intel signals
- performance_metrics_latest / performance_keywords_movers / performance_competitors_latest / performance_report_latest: SEO/traffic metrics with WoW, tracked-keyword movers, competitor Top-N, latest perf report
- performance_social_scorecard + performance_social_trend: per-channel social stats + weekly trend
- performance_signals_open + pipeline_action_items: open signals and the unified prioritized action list
- strategy_pipeline_status + pipeline_data_catalog: content pipeline counts + a catalog of every data table
Be concise, cite real numbers, and if the data doesn't contain the answer, say so. Reporting data JSON: ${context}`;
        const msgs = [...(Array.isArray(history) ? history.slice(-6) : []), { role: 'user', content: String(question || '').slice(0, 2000) }];
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': CK, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system, messages: msgs }),
        });
        const j = await resp.json();
        const answer = (j.content && j.content[0] && j.content[0].text) || ('Error: ' + JSON.stringify(j).slice(0, 300));
        return new Response(JSON.stringify({ answer }), { headers: { 'content-type': 'application/json', ...CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ answer: 'Error: ' + e.message }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
      }
    }

    // ---- weekly GTM scorecard: live Apollo + HubSpot, computed server-side, cached ----
    // Keys (APOLLO_API_KEY / HUBSPOT_PRIVATE_APP_TOKEN) are Worker secrets, NEVER sent to the browser.
    // The endpoint requires the dashboard session cookie. Result cached ~30min per ISO week; ?refresh=1 bypasses.
    if (path === '/api/gtm-weekly') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (!authed) return new Response(JSON.stringify({ error: 'not signed in' }), { status: 401, headers: { 'content-type': 'application/json', ...CORS } });
      // window = previous complete Mon..Sun (UTC); pipeline snapshot = now
      const now = new Date();
      const dow = (now.getUTCDay() + 6) % 7; // 0=Mon
      const thisMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
      const wkStart = new Date(thisMon.getTime() - 7 * 864e5), wkEnd = thisMon; // [wkStart, wkEnd)
      const weekKey = wkStart.toISOString().slice(0, 10);
      const cache = caches.default;
      const cacheKey = new Request('https://gtm-weekly.cache/v2-' + weekKey); // bump version to bust stale payloads on deploy
      if (url.searchParams.get('refresh') !== '1') { const hit = await cache.match(cacheKey); if (hit) { const b = await hit.text(); return new Response(b, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } }); } }
      try {
        const APO = (env.APOLLO_API_KEY || '').trim(), HS = (env.HUBSPOT_PRIVATE_APP_TOKEN || '').trim();
        const out = {
          window: { start: weekKey, end: new Date(wkEnd.getTime() - 864e5).toISOString().slice(0, 10) },
          generated_at: now.toISOString(), notes: [],
        };

        // ----- Apollo: emails sent / replies / bounces (status=completed in window) + active sequences -----
        if (APO) {
          const sentByCampaign = {}; let sent = 0, replied = 0, bounced = 0, spam = 0, oldest = null, page = 1;
          while (page <= 60) {
            const r = await fetch('https://api.apollo.io/v1/emailer_messages/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': APO }, body: JSON.stringify({ per_page: 100, page }) });
            if (!r.ok) break;
            const j = await r.json(); const msgs = j.emailer_messages || [];
            if (!msgs.length) break;
            for (const m of msgs) {
              if (!m.completed_at) continue;
              const ts = new Date(m.completed_at);
              if (!oldest || ts < oldest) oldest = ts;
              if (m.status === 'completed' && ts >= wkStart && ts < wkEnd) {
                sent++; const c = m.campaign_name || m.emailer_campaign_id || '?'; sentByCampaign[c] = (sentByCampaign[c] || 0) + 1;
                if (m.replied) replied++; if (m.bounce) bounced++; if (m.spam_blocked) spam++;
              }
            }
            if (oldest && oldest < wkStart) break;
            page++;
          }
          let seqs = [];
          try { const r = await fetch('https://api.apollo.io/v1/emailer_campaigns/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': APO }, body: JSON.stringify({ per_page: 100 }) }); const j = await r.json(); seqs = (j.emailer_campaigns || []).filter(s => s.active); } catch (e) {}
          // blend open/click rates (Apollo exposes only lifetime per-seq rates) weighted by this week's send mix
          let wOpen = 0, wClick = 0, wDen = 0;
          for (const s of seqs) { const n = sentByCampaign[s.name] || 0; if (n > 0) { if (s.open_rate != null) wOpen += s.open_rate * n; if (s.click_rate != null) wClick += s.click_rate * n; wDen += n; } }
          out.apollo = {
            emails_sent: sent, replies: replied, reply_rate: sent ? +(100 * replied / sent).toFixed(1) : 0,
            bounced, spam_blocked: spam,
            open_rate_pct: wDen ? +(100 * wOpen / wDen).toFixed(1) : null,
            click_rate_pct: wDen ? +(100 * wClick / wDen).toFixed(1) : null,
            active_sequences: seqs.map(s => ({ name: s.name, open_rate_pct: s.open_rate != null ? +(100 * s.open_rate).toFixed(1) : null, click_rate_pct: s.click_rate != null ? +(100 * s.click_rate).toFixed(1) : null })),
            by_campaign: sentByCampaign,
          };
          out.notes.push('Open/click are Apollo lifetime per-sequence rates blended by this week’s send mix — Apollo’s API exposes no per-week opens/clicks.');
        } else { out.apollo = { error: 'APOLLO_API_KEY secret missing on the worker.' }; }

        // ----- HubSpot: trials by start/end date + sequence stage; signups in window -----
        if (HS) {
          const props = ['trial_start_date', 'trial_end_date', 'trial_sequence_stage', 'stabletrack_signup_source', 'email'];
          let all = [], after, guard = 0;
          do {
            const body = { filterGroups: [{ filters: [{ propertyName: 'trial_start_date', operator: 'HAS_PROPERTY' }] }], properties: props, limit: 100 };
            if (after) body.after = after;
            const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers: { Authorization: 'Bearer ' + HS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) { out.notes.push('HubSpot trial search HTTP ' + r.status); break; }
            const j = await r.json(); all.push(...(j.results || [])); after = j.paging && j.paging.next && j.paging.next.after; guard++;
          } while (after && guard < 25);
          const order = ['Day 2', 'Day 4', 'Day 7', 'Day 10', 'Day 14', 'Day 18', 'Day 21', 'Day 26', 'Day 29'];
          const byStage = {}; let active = 0, expired = 0, noStage = 0, signupTotal = 0; const signups = {}; const signupRows = [];
          const nowMs = now.getTime(), wkS = wkStart.getTime(), wkE = wkEnd.getTime();
          for (const c of all) {
            const p = c.properties; const s = p.trial_start_date ? Date.parse(p.trial_start_date) : null, e = p.trial_end_date ? Date.parse(p.trial_end_date) : null;
            if (s != null && s >= wkS && s < wkE) { signupTotal++; const src = p.stabletrack_signup_source || '(unknown)'; signups[src] = (signups[src] || 0) + 1; signupRows.push({ email: p.email || '', source: src, stage: p.trial_sequence_stage || '' }); }
            const isActive = e != null ? (s != null && s <= nowMs && e >= nowMs) : (s != null && s <= nowMs);
            if (isActive) { active++; const stg = p.trial_sequence_stage || '(no stage)'; byStage[stg] = (byStage[stg] || 0) + 1; if (!p.trial_sequence_stage) noStage++; }
            else if (e != null && e < nowMs) expired++;
          }
          // order by_stage for stable display
          const orderedStage = {}; for (const k of order) if (byStage[k] != null) orderedStage[k] = byStage[k];
          for (const k of Object.keys(byStage)) if (!(k in orderedStage)) orderedStage[k] = byStage[k];
          out.trials = { total_active: active, expired, by_stage: orderedStage, no_stage: noStage, signups_last_week: signupTotal, signups_by_source: signups, signups_detail: signupRows, contacts_with_trial: all.length };
          out.notes.push('Trials from HubSpot trial_start_date/trial_end_date/trial_sequence_stage. The Amplitude→HubSpot sync is currently OFF, so new product trials can be undercounted and some past-end trials linger as active (no stage).');
        } else { out.trials = { error: 'HUBSPOT_PRIVATE_APP_TOKEN secret missing on the worker.' }; }

        // ----- HubSpot: deal pipeline (by stage / owner / lead type), opportunities, demos, inbound, leads -----
        if (HS) {
          const HH = { Authorization: 'Bearer ' + HS, 'Content-Type': 'application/json' };
          const PIPE = '1764642288'; // Asteris Sales Pipeline
          const wkS = wkStart.getTime(), wkE = wkEnd.getTime();
          let stageMap = {}, ownerMap = {};
          try { const pl = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals/' + PIPE, { headers: HH }).then(r => r.json()); (pl.stages || []).forEach(s => stageMap[s.id] = { label: s.label, closed: !!(s.metadata && (s.metadata.isClosed === 'true' || s.metadata.isClosed === true)) }); } catch (e) {}
          try { const ow = await fetch('https://api.hubapi.com/crm/v3/owners?limit=100', { headers: HH }).then(r => r.json()); (ow.results || []).forEach(o => ownerMap[o.id] = ((o.firstName || '') + ' ' + (o.lastName || '')).trim() || o.email || o.id); } catch (e) {}
          // all deals in the pipeline
          let deals = [], after, guard = 0;
          do {
            const body = { filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: PIPE }] }], properties: ['dealname', 'dealstage', 'hubspot_owner_id', 'contact_source', 'amount', 'createdate', 'closedate'], limit: 100 };
            if (after) body.after = after;
            const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', { method: 'POST', headers: HH, body: JSON.stringify(body) });
            if (!r.ok) { out.notes.push('HubSpot deals search HTTP ' + r.status); break; }
            const j = await r.json(); deals.push(...(j.results || [])); after = j.paging && j.paging.next && j.paging.next.after; guard++;
          } while (after && guard < 20);
          const byStage = {}, byOwnerStage = {}, byLeadType = {}, byOwnerLeadType = {}, opportunities = [];
          let openTotal = 0, closedWon = 0, closedLost = 0;
          const OPP = ['Proposal', 'Negotiation', 'Warm Trial - Hot'];
          for (const d of deals) {
            const p = d.properties; const st = stageMap[p.dealstage]; const stLabel = st ? st.label : (p.dealstage || '?');
            const owner = ownerMap[p.hubspot_owner_id] || '(unassigned)'; const lt = p.contact_source || '(unknown)';
            if (st && st.closed) {
              const cm = p.closedate ? Date.parse(p.closedate) : null;
              if (cm != null && cm >= wkS && cm < wkE) { if (/won/i.test(stLabel)) closedWon++; else if (/lost/i.test(stLabel)) closedLost++; }
            } else {
              openTotal++;
              byStage[stLabel] = (byStage[stLabel] || 0) + 1;
              (byOwnerStage[owner] = byOwnerStage[owner] || {})[stLabel] = (byOwnerStage[owner][stLabel] || 0) + 1;
              byLeadType[lt] = (byLeadType[lt] || 0) + 1;
              (byOwnerLeadType[owner] = byOwnerLeadType[owner] || {})[lt] = (byOwnerLeadType[owner][lt] || 0) + 1;
              if (OPP.includes(stLabel)) opportunities.push({ name: p.dealname || '(unnamed)', stage: stLabel, owner, amount: p.amount || null });
            }
          }
          out.deals = { pipeline: 'Asteris Sales Pipeline', open_total: openTotal, by_stage: byStage, by_owner_stage: byOwnerStage, by_lead_type: byLeadType, by_owner_lead_type: byOwnerLeadType, opportunities, closed_won_this_week: closedWon, closed_lost_this_week: closedLost };

          // Demos = Calendly scheduled events in the window (HubSpot meetings are stale; Calendly is the live source).
          try {
            const CAL = (env.CALENDLY_API_KEY || '').trim();
            const ORG = 'https://api.calendly.com/organizations/a17c8a98-162e-42d9-b00a-c14e08b89ae7';
            if (CAL) {
              const cu = 'https://api.calendly.com/scheduled_events?organization=' + encodeURIComponent(ORG) + '&min_start_time=' + encodeURIComponent(wkStart.toISOString()) + '&max_start_time=' + encodeURIComponent(wkEnd.toISOString()) + '&count=100&status=active';
              const cr = await fetch(cu, { headers: { Authorization: 'Bearer ' + CAL } });
              if (cr.ok) {
                const cj = await cr.json(); const evs = cj.collection || []; const byType = {}; const stList = [];
                for (const e of evs) {
                  const nm = e.name || 'Event';
                  const type = /stabletrack/i.test(nm) ? 'StableTrack demo' : /keystone/i.test(nm) ? 'Keystone (PACS / demo / install)' : /information call/i.test(nm) ? 'Information call' : 'Other';
                  byType[type] = (byType[type] || 0) + 1;
                  if (type === 'StableTrack demo') stList.push({ title: nm, when: e.start_time });
                }
                out.demos = { stabletrack: stList.length, by_type: byType, total_events: evs.length, list: stList, source: 'Calendly' };
              } else out.demos = { error: 'Calendly HTTP ' + cr.status };
            } else out.demos = { error: 'CALENDLY_API_KEY secret missing on the worker.' };
          } catch (e) { out.demos = { error: e.message }; }

          // Contacts created in the window → lead type breakdown, inbound, MQL+ ("leads")
          try {
            const cr = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers: HH, body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'createdate', operator: 'BETWEEN', value: String(wkS), highValue: String(wkE) }] }], properties: ['email', 'contact_source', 'lifecyclestage'], limit: 100 }) });
            if (cr.ok) {
              const cj = await cr.json(); const cs = cj.results || []; const bySource = {}; let inbound = 0, mql = 0;
              for (const c of cs) { const p = c.properties; const src = p.contact_source || '(unknown)'; bySource[src] = (bySource[src] || 0) + 1; if (src === 'Inbound demo request') inbound++; if (/marketingqualifiedlead|salesqualifiedlead/.test(p.lifecyclestage || '')) mql++; }
              out.contacts_created = { total: cs.length, by_lead_type: bySource, inbound_demo_requests: inbound, leads_mql_or_higher: mql };
            } else out.contacts_created = { error: 'contacts HTTP ' + cr.status };
          } catch (e) { out.contacts_created = { error: e.message }; }
        }

        // ----- Amplitude: product engagement (active users + avg session), live via Dashboard REST API -----
        {
          const AK = (env.AMPLITUDE_API_KEY || '').trim(), SK = (env.AMPLITUDE_SECRET_KEY || '').trim();
          if (AK && SK) {
            try {
              const auth = 'Basic ' + btoa(AK + ':' + SK);
              const ymd = d => '' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
              const S = ymd(wkStart), E = ymd(new Date(wkEnd.getTime() - 864e5)), d30 = ymd(new Date(now.getTime() - 29 * 864e5)), T = ymd(now);
              const aGet = async p => { const r = await fetch('https://amplitude.com' + p, { headers: { Authorization: auth } }); return r.ok ? r.json() : null; };
              const firstVal = j => { try { return j.data.series[0][0]; } catch (e) { return null; } };
              const wk = await aGet(`/api/2/users?start=${S}&end=${E}&m=active&i=7`);
              const m30 = await aGet(`/api/2/users?start=${d30}&end=${T}&m=active&i=30`);
              const nu = await aGet(`/api/2/users?start=${d30}&end=${T}&m=new&i=30`);
              const sess = await aGet(`/api/2/sessions/average?start=${S}&end=${E}`);
              let avgMin = null; try { const v = sess.data.seriesCollapsed[0][0].value; avgMin = v != null ? +(v / 60).toFixed(1) : null; } catch (e) {}
              out.product = { active_users_week: firstVal(wk), active_users_30d: firstVal(m30), new_users_30d: firstVal(nu), avg_session_min: avgMin, source: 'Amplitude' };
            } catch (e) { out.product = { error: e.message }; }
          } else { out.product = { error: 'AMPLITUDE keys missing on the worker.' }; }
        }

        // ----- data points still without an automated source (filled manually each week) -----
        out.manual = {
          seo_visibility_pct: null,             // SEMrush Position-Tracking (API units exhausted)
          chatgpt_gemini_brand_visibility_pct: null, backlinks_new: null,  // SEMrush AEO / backlinks — manual
          blog_posts_published: null,           // Notion content DB — to wire
        };
        out.notes.push('Product engagement is live from Amplitude. Remaining "manual" fields (SEMrush visibility/AEO, backlinks, Notion blog count) have no live API source yet — fill weekly or wire later.');

        const payload = JSON.stringify(out);
        // store with max-age for the server-side (Cache API) 30-min cache, but tell the BROWSER not to cache
        // (otherwise a stale client copy hides newly-added fields like deals/demos until it expires).
        await cache.put(cacheKey, new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=1800', ...CORS } }));
        return new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
      }
    }

    // ---- publish / change a blog draft's status (requires auth) ----
    // Writes use the service-role key held ONLY as a Worker secret (never sent to the browser);
    // the whole dashboard is login-gated, so only signed-in users can reach this.
    if (path === '/api/publish') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (!authed) return new Response(JSON.stringify({ ok: false, error: 'not signed in' }), { status: 401, headers: { 'content-type': 'application/json', ...CORS } });
      try {
        const SK = (env.SUPABASE_SERVICE_KEY || '').trim(), SBU = (env.SUPABASE_URL || '').trim();
        if (!SK) return new Response(JSON.stringify({ ok: false, error: 'SUPABASE_SERVICE_KEY secret missing on the worker.' }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
        const { id, status } = await request.json();
        const ALLOWED = ['Draft', 'Needs Revision', 'Published', 'Archived'];
        if (!id || !ALLOWED.includes(status)) return new Response(JSON.stringify({ ok: false, error: 'bad request' }), { status: 400, headers: { 'content-type': 'application/json', ...CORS } });
        const r = await fetch(`${SBU}/rest/v1/strategy_blog_drafts?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', 'Content-Profile': 'content_pipeline', Prefer: 'return=minimal' },
          body: JSON.stringify({ status }),
        });
        if (!r.ok) { const t = await r.text(); return new Response(JSON.stringify({ ok: false, error: t.slice(0, 200) }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } }); }
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
      }
    }

    // ---- everything else (the dashboard) requires a valid session ----
    if (!authed) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return env.ASSETS.fetch(request);
  },
};

// Branded StableTrack login page.
function loginHTML(err) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · StableTrack GTM</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FDFBF7;color:#3E2723;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .box{width:340px;max-width:calc(100vw - 36px);padding:30px 28px;background:#fff;border:1px solid #e8ddd0;border-radius:16px;box-shadow:0 10px 34px rgba(62,39,35,.12);text-align:center}
  img{height:34px;width:auto;margin-bottom:6px}
  .sub{font-family:Georgia,'Source Serif 4',serif;color:#C6761E;font-weight:600;font-size:15px;margin-bottom:20px}
  label{display:block;text-align:left;font-size:12px;font-weight:600;color:#5D4037;margin:12px 0 4px}
  input{width:100%;box-sizing:border-box;background:#fff;border:1px solid #e8ddd0;border-radius:9px;padding:10px 12px;font-size:14px;color:#3E2723}
  input:focus{outline:none;border-color:#C6761E;box-shadow:0 0 0 3px rgba(198,118,30,.14)}
  button{width:100%;margin-top:18px;background:#C6761E;color:#fff;border:0;border-radius:9px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#b16715}
  .err{background:#fdecea;border:1px solid #f5c6c0;color:#C0392B;font-size:13px;border-radius:8px;padding:8px 10px;margin-bottom:6px}
</style>
<form class="box" method="POST" action="/login">
  <img src="/logo.png" alt="StableTrack">
  <div class="sub">GTM</div>
  ${err ? '<div class="err">Incorrect username or password.</div>' : ''}
  <label>Username</label><input name="username" autocomplete="username" autofocus>
  <label>Password</label><input name="password" type="password" autocomplete="current-password">
  <button type="submit">Sign in</button>
</form>`;
}
