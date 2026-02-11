# FedWatch Dashboard v2.0 — Phase 2 Release Notes

## Top Opportunities Widget Enhancements

### Estimated Value Column
- Displays contract value parsed from SAM.gov award data and solicitation descriptions
- Formatted as $45.0M, $500K, etc.
- Automatically extracted on each bot run; backfilled for existing opportunities

### Score Reasons ("Why")
- Click any score badge to expand the AI's reasoning inline
- Shows up to 4 bullet points explaining why the opportunity scored high
- Synced from the bot's `ai_reasons_json` field

### Per-User Dismiss
- X button on each row hides that opportunity from your view only
- Other users still see it — dismissals are per-account
- "Show N dismissed" link at the bottom to restore hidden items

### Thumbs Up / Down Feedback
- Rate opportunities with thumbs up or down (click again to remove)
- Ratings persist across sessions, tied to your account
- After 2+ thumbs-up, the system learns your preferences (agencies, NAICS codes, set-asides) and highlights matching opportunities with a star

### Auto-Sync After Bot Run
- `run` and `backfill` commands now automatically sync top 25 to the dashboard when Supabase credentials are set
- No manual `sync-top` needed in production

### Real-Time Updates
- Dashboard subscribes to live changes on opportunities, feedback, and dismissals
- New bot results appear without refreshing; cross-tab sync for feedback/dismiss actions

## Database Changes

Run `supabase/migrations/20260210_phase2_feedback.sql` in SQL Editor:
- New table: `opportunity_feedback` (per-user ratings with RLS)
- New table: `opportunity_dismissals` (per-user hides with RLS)
- New columns on `scanner_opportunities`: `ai_reasons_json`, `estimated_value`

## Bot Changes

- `bot/normalizer.js` — extracts `award.amount` from SAM API response
- `bot/storage.js` — parses dollar amounts from description text as fallback, stores `estimated_value`
- `bot/cli.js` — auto-sync after run/backfill
- `bot/sync_opportunities.js` — syncs `ai_reasons_json` and `estimated_value` to Supabase
