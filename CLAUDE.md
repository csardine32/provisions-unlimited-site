# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Provisions Opportunity Hub — a Supabase-backed single-page dashboard for managing federal contracting opportunities. No build step, no framework, no bundler. Static HTML/CSS/JS deployed to Vercel. Supabase handles auth, database, realtime subscriptions, and edge functions.

## Development

```bash
# Local dev — just serve static files
python3 -m http.server 8000
# Then open http://localhost:8000/dashboard

# Deploy — push to main, Vercel auto-deploys
git push origin main
```

No tests, no linter, no package.json. Cache-bust by incrementing `?v=N` on CSS/JS tags in `dashboard.html`.

## Architecture

**Three files comprise the entire app:**
- `dashboard.html` — structure, view containers, modals, CDN script tags
- `dashboard.css` — all styles (uses CSS variables from `style.css`)
- `dashboard.js` — ~2700 lines, all logic: auth, views, CRUD, realtime, scoring

**Supporting:**
- `naics-categories.js` — static NAICS code → category mapping (loaded via script tag)
- `supabase-schema.sql` — reference schema (run in Supabase SQL Editor, not auto-applied)
- `vercel.json` — single rewrite: `/dashboard` → `/dashboard.html`
- `index.html`, `about.html`, `technology.html`, `infrastructure.html`, `partners.html` — marketing pages (separate from dashboard)

### Views

Four views switched via hash routing (`#scanner`, `#pipeline`, `#projects`, `#analyze`):

| View | Purpose | Init flag |
|------|---------|-----------|
| **Scanner** | Browse/filter/score SAM.gov opportunities | `scannerInitialized` |
| **Pipeline** | Active + submitted bids with milestones/checklists | `pipelineInitialized` |
| **Active Projects** | Awarded ("won") contracts showcase | `activeProjectsInitialized` |
| **Analyze** | Ad-hoc PDF/DOCX analysis + Intel Drop (admin only) | `adhocInitialized` |

Views lazy-init once via `navigateTo(viewName)`. Admin-only views check `isAdmin()` which validates against hardcoded `ADMIN_EMAILS` array.

### Scanner Data Flow

1. `loadFilteredOpportunities(page)` builds a Supabase query with server-side filters (NAICS category, agency, set-aside, state, city, keyword, active deadlines)
2. Returns paginated results (100 per page) with `count: 'exact'`
3. Results scored client-side via `clientScore(opp, scoringProfile)` using the user's keyword profile from `scoring_profiles` table
4. Sorted by user score (desc), then AI score (desc)
5. Rendered with score badges, feedback buttons, track/dismiss actions

Client scoring: base 50, +5 per positive keyword match, -15 per negative, clamped 0-100. Weights configurable via `score_weights` JSON in the profile.

### Supabase Tables

| Table | Purpose |
|-------|---------|
| `scanner_opportunities` | Opportunities synced from FedWatch bot (SQLite → Supabase) |
| `projects` | Pipeline bids + awarded contracts. Status: active/submitted/won/lost/no_bid/archived |
| `milestones` | Per-project timeline checkpoints (6 auto-generated on create) |
| `checklist_items` | Per-project document checklist (6 auto-generated on create) |
| `scoring_profiles` | Per-user keyword lists for client-side scoring (RLS per user) |
| `opportunity_feedback` | Thumbs up/down per user/notice_id |
| `opportunity_dismissals` | Dismissed opportunities per user |
| `adhoc_analyses` | Ad-hoc file analysis results |
| `activity_log` | Audit trail for project changes |

All tables have RLS enabled. Realtime subscriptions on all tables trigger automatic UI refreshes.

### Key Patterns

**DOM helper:** `$(id)` is shorthand for `document.getElementById(id)`.

**Auth:** Google OAuth + email/password via Supabase Auth. `onAuthStateChange()` is the sole auth handler — uses `INITIAL_SESSION` event to avoid OAuth race conditions.

**Realtime:** Single channel `dashboard-changes` subscribes to all tables in `showDashboard()`. Callbacks check init flags before re-rendering.

**Deep Dive:** Right-side panel (admin only) showing AI analysis sections: scorecard, reasons, risks, skillsets, key dates, must-check items, attachments, full description. Triggered by `openDeepDive(noticeId)`.

**Track → Pipeline:** `trackOpportunity()` promotes a scanner opportunity to a project with auto-generated milestones and checklist items from templates (`MILESTONE_TEMPLATE`, `DEFAULT_CHECKLIST`).

**Intel Drop:** File upload in project cards that sends to `process-intel` edge function. Function auto-checks milestones/checklist items, updates dates/status/priority.

**Preferences:** Computed from thumbs-up feedback history. Agencies/NAICS/set-asides appearing in 2+ liked opps become preference signals. Matching opportunities get a star badge.

## Companion Repo

The backend scanner lives at `ProVision-System-Workspace/provision-fedwatch/`. It scans SAM.gov, stores to SQLite, and syncs to the `scanner_opportunities` table that this dashboard reads. See that repo's CLAUDE.md for bot commands and scoring pipeline details.

## Gotchas

- Supabase anon key is hardcoded at top of `dashboard.js` (public/safe — RLS enforces access)
- No build step means no minification, no tree-shaking — the 2700-line JS file is served as-is
- `escapeHtml()` must wrap ALL user/AI-generated text to prevent XSS
- File analysis supports PDF (base64), DOCX (via mammoth.js), and plain text — libraries loaded via CDN script tags
- Milestone/checklist auto-generation only happens on project *creation*, not edit
- The `scanner_opportunities` table is written by the bot (service key), read by the dashboard (anon key + RLS)
