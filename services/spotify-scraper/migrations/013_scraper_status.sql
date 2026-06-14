-- Migration 013: Add scraper_status table to track active scraper runs and prevent inconsistent playcount display on the dashboard
CREATE TABLE IF NOT EXISTS scraper_status (
  id INT PRIMARY KEY DEFAULT 1,
  status VARCHAR(50) NOT NULL, -- 'idle', 'scraping', 'deduping'
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO scraper_status (id, status) VALUES (1, 'idle') ON CONFLICT (id) DO NOTHING;
