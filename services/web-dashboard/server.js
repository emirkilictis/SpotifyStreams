const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json());
app.use(cookieParser('spotify-streams-secret-key'));

// Auth check middleware
const requireAuth = (req, res, next) => {
  if (req.signedCookies.fan_session) {
    return next();
  }
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
};

// Public Routes
app.get('/login', (req, res) => {
  if (req.signedCookies.fan_session) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.post('/api/login', async (req, res) => {
  const { passcode } = req.body;
  if (!passcode) {
    return res.status(400).json({ success: false, message: 'Passcode is required!' });
  }
  try {
    const result = await pool.query('SELECT * FROM access_codes WHERE code = $1', [passcode]);
    if (result.rows.length > 0) {
      res.cookie('fan_session', passcode, {
        signed: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
      });
      return res.json({ success: true });
    } else {
      return res.status(401).json({ success: false, message: 'Invalid passcode!' });
    }
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error occurred.' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('fan_session');
  res.redirect('/login');
});

// Style.css must be accessible by the login page
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/style.css'));
});

// Protected API Routes
app.get('/api/songs', requireAuth, async (req, res) => {
  try {
    const query = `
      SELECT
        s.id,
        s.title,
        s.is_featured,
        s.duration_ms,
        a.title AS album_title,
        dsc.recorded_date,
        COALESCE(dsc.cumulative, 0)::bigint AS cumulative,
        COALESCE(dsc.daily_gain, 0)::bigint AS daily_gain
      FROM songs s
      LEFT JOIN albums a ON s.album_id = a.id
      LEFT JOIN (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          recorded_date,
          cumulative,
          daily_gain
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc ON s.id = dsc.canonical_id
      WHERE s.canonical_id IS NULL
      ORDER BY cumulative DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch songs error:', err);
    res.status(500).json({ error: 'Failed to load song list.' });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const query = `
      SELECT 
        COALESCE(SUM(dsc.cumulative), 0)::bigint AS total_streams,
        COALESCE(SUM(dsc.cumulative) FILTER (WHERE NOT s.is_featured), 0)::bigint AS lead_streams,
        COALESCE(SUM(dsc.cumulative) FILTER (WHERE s.is_featured), 0)::bigint AS feat_streams,
        COALESCE(SUM(dsc.daily_gain), 0)::bigint AS daily_gain,
        COUNT(*)::int AS total_songs,
        MAX(dsc.recorded_date) AS last_update
      FROM (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          cumulative,
          daily_gain,
          recorded_date
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc
      JOIN songs s ON s.id = dsc.canonical_id;
    `;
    const result = await pool.query(query);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fetch stats error:', err);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

app.get('/api/albums', requireAuth, async (req, res) => {
  try {
    const query = `
      SELECT
        a.id AS album_id,
        a.title AS album_title,
        a.release_date,
        COUNT(s.id)::int AS track_count,
        COALESCE(SUM(dsc.cumulative), 0)::bigint AS total_streams,
        COALESCE(SUM(dsc.daily_gain), 0)::bigint AS daily_gain
      FROM albums a
      JOIN songs s ON s.album_id = a.id
      LEFT JOIN (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          cumulative,
          daily_gain
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc ON s.id = dsc.canonical_id
      WHERE s.canonical_id IS NULL AND (
        a.title ILIKE 'Justified%'
        OR a.title ILIKE 'FutureSex/LoveSounds%'
        OR a.title ILIKE 'The 20/20 Experience%'
        OR a.title ILIKE 'Man of the Woods%'
        OR a.title ILIKE 'Everything I Thought It Was%'
      )
      GROUP BY a.id, a.title, a.release_date
      ORDER BY total_streams DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch albums error:', err);
    res.status(500).json({ error: 'Failed to load albums.' });
  }
});

app.get('/api/albums/:id/songs', requireAuth, async (req, res) => {
  try {
    const query = `
      SELECT
        s.id,
        s.title,
        s.is_featured,
        s.duration_ms,
        s.track_number,
        dsc.recorded_date,
        COALESCE(dsc.cumulative, 0)::bigint AS cumulative,
        COALESCE(dsc.daily_gain, 0)::bigint AS daily_gain
      FROM songs s
      LEFT JOIN (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          cumulative,
          daily_gain,
          recorded_date
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc ON s.id = dsc.canonical_id
      WHERE s.album_id = $1 AND s.canonical_id IS NULL
      ORDER BY s.track_number ASC;
    `;
    const result = await pool.query(query, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch album songs error:', err);
    res.status(500).json({ error: 'Failed to load album songs.' });
  }
});

// Protected Static Files
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// Catch-all redirect to home
app.get('*', requireAuth, (req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} portunda çalışıyor.`);
});
