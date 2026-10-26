'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {artistLatestAggCTE,debutBaselineSQL}=require('../lib/agg-sql');

test('imported first observations never become debut gains, including after a canonical merge', {skip:process.env.RELEASE_DB_TEST!=='1'},async()=>{
  require('dotenv').config({path:require('node:path').join(__dirname,'../../../.env')});
  const {Pool}=require('pg'),{databaseConfig}=require('../lib/database');
  const pool=new Pool({...databaseConfig(),max:1}),client=await pool.connect(),id=()=>randomBytes(16).toString('hex').slice(0,22);
  const artist=id(),album=id(),imported=id(),genuine=id(),alias=id();
  try{
    await client.query('BEGIN');
    await client.query('INSERT INTO tracked_artists(artist_id,name,active) VALUES($1,$2,true)',[artist,'Import baseline regression']);
    await client.query("INSERT INTO albums(id,title,release_date) VALUES($1,$2,'2026-10-20')",[album,'Recently released']);
    for(const [song,canonical] of [[imported,null],[genuine,null],[alias,genuine]])
      await client.query('INSERT INTO songs(id,title,album_id,duration_ms,primary_artist,canonical_id) VALUES($1,$2,$3,100000,$4,$5)',[song,'Baseline regression',album,'spotify:artist:'+artist,canonical]);
    for(const [song,date,count,baseline] of [[imported,'2026-10-25',438055,true],[imported,'2026-10-26',500000,false],
      [genuine,'2026-10-20',100,false],[genuine,'2026-10-21',200,false],[alias,'2026-10-25',500,true]])
      await client.query('INSERT INTO stream_stats(song_id,recorded_date,stream_count,baseline_only) VALUES($1,$2,$3,$4)',[song,date,count,baseline]);
    const live=(await client.query(`WITH ${artistLatestAggCTE('s.id=ANY($1::text[])')}
      SELECT canonical_id,recorded_date::text,cumulative::text,daily_gain::text,is_debut_first FROM agg_gains ORDER BY canonical_id,recorded_date`,[[imported,genuine]])).rows;
    const importedRows=live.filter(r=>r.canonical_id===imported);
    assert.equal(importedRows[0].daily_gain,null); assert.equal(importedRows[0].is_debut_first,false);
    assert.equal(importedRows[1].daily_gain,'61945'); assert.equal(importedRows[1].cumulative,'500000');
    const genuineRows=live.filter(r=>r.canonical_id===genuine);
    assert.equal(genuineRows[0].is_debut_first,true,'a later imported alias does not erase an observed real debut');
    assert.equal(genuineRows[0].daily_gain,'100');
    const baselines=(await client.query(`WITH source AS (
      SELECT COALESCE(s.canonical_id,s.id) AS canonical_id,ss.recorded_date,MAX(ss.stream_count) AS stream_count
      FROM songs s JOIN stream_stats ss ON ss.song_id=s.id WHERE s.id=ANY($1::text[]) GROUP BY 1,2
    ) ${debutBaselineSQL('source')}`,[[imported,genuine,alias]])).rows;
    assert.equal(baselines.length,1); assert.equal(baselines[0].canonical_id,genuine);
    const history=(await client.query('SELECT canonical_id,recorded_date::text,cumulative::text,daily_gain::text FROM daily_streams_canonical WHERE canonical_id=ANY($1::text[]) ORDER BY canonical_id,recorded_date',[[imported,genuine]])).rows;
    const importedHistory=history.filter(r=>r.canonical_id===imported);
    assert.equal(importedHistory.length,2); assert.equal(importedHistory[0].daily_gain,null);
    assert.equal(importedHistory[1].daily_gain,'61945');
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
