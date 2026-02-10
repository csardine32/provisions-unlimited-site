-- ============================================================
-- Provisions Deadline Dashboard — Supabase Schema
-- Run this in the Supabase SQL Editor for your project
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Projects — Active bids being tracked
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  agency TEXT,
  solicitation_number TEXT,
  notice_id TEXT,                          -- Links to FedWatch SQLite
  response_deadline TIMESTAMPTZ NOT NULL,
  owner TEXT DEFAULT 'Chris',              -- Chris or John
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'submitted', 'won', 'lost', 'no_bid', 'archived')),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  naics_code TEXT,
  set_aside TEXT,
  estimated_value TEXT,
  sam_link TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id)
);

-- 2. Milestones — Per-project timeline checkpoints
CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date TIMESTAMPTZ NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Checklist Items — Per-project document checklist
CREATE TABLE IF NOT EXISTS checklist_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Activity Log — Audit trail
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  performed_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Email Alerts — Dedup tracking for sent notifications
CREATE TABLE IF NOT EXISTS email_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,              -- '7day', '3day', '1day'
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  recipient TEXT,
  UNIQUE(project_id, alert_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_projects_deadline ON projects(response_deadline);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_due ON milestones(due_date);
CREATE INDEX IF NOT EXISTS idx_checklist_project ON checklist_items(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id);
CREATE INDEX IF NOT EXISTS idx_email_alerts_project ON email_alerts(project_id);

-- Updated_at trigger for projects
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Row Level Security (RLS)
-- Only authenticated users can access data
-- ============================================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_alerts ENABLE ROW LEVEL SECURITY;

-- Policies: any authenticated user can CRUD all rows
-- (Only 2 users: Chris + John — no per-user row isolation needed)
CREATE POLICY "Authenticated users full access" ON projects
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access" ON milestones
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access" ON checklist_items
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access" ON activity_log
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access" ON email_alerts
  FOR ALL USING (auth.role() = 'authenticated');

-- ============================================================
-- Realtime — Enable for live dashboard updates
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE projects;
ALTER PUBLICATION supabase_realtime ADD TABLE milestones;
ALTER PUBLICATION supabase_realtime ADD TABLE checklist_items;
