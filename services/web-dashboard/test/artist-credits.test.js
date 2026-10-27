'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { syncArtistCredits } = require('../../spotify-scraper/artist-credits');
const id = () => randomBytes(16).toString('hex').slice(0,22);

test('artist credits ignore solo tracks, repeated credits and malformed Spotify references', async () => {
  let queries=0;
  const client={ query: async () => { queries++; throw new Error('Unexpected database query'); } };
  const artist='spotify:artist:'+id();
  const result=await syncArtistCredits(client,{id:id()},[
    {id:id(),artistUris:[artist]}, {id:id(),artistUris:[artist,artist]},
    {id:id(),artistUris:[artist,'not-an-artist']}, {id:'bad',artistUris:[artist,'spotify:artist:'+id()]},
  ]);
  assert.deepEqual(result,{linked:0,pinned:0,classifications:0}); assert.equal(queries,0);
  await assert.rejects(syncArtistCredits(client,{id:'bad'},[]),/Invalid album/);
});

test('album collection forwards only kept collaborations for verified guest membership', async () => {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const source=fs.readFileSync(path.join(__dirname,'../../spotify-scraper/scraper.js'),'utf8');
  const fn=source.slice(source.indexOf('async function processAlbum('),source.indexOf('\nasync function scrapeArtist('));
  const owner='spotify:artist:'+id(),guest='spotify:artist:'+id(),calls=[];
  const collab={id:id(),title:'La Loto - live',artistUris:[owner,guest],playCount:147377};
  const solo={id:id(),title:'Solo',artistUris:[owner],playCount:1000};
  const other={id:id(),title:'Unrelated',artistUris:[guest,'spotify:artist:'+id()],playCount:1000};
  const sandbox={BLACKLISTED_TRACK_IDS:new Set(),ARTIST_SEARCH_NAMES:{},isCoverOrTribute:()=>false,
    fetchAlbumTracks:async()=>[collab,solo,other],upsertSongsBatch:async()=>{},upsertStreamStatsBatch:async()=>2,
    syncArtistCredits:async(_,album,tracks)=>{calls.push(tracks);return {linked:1};},console};
  vm.runInNewContext(fn+'\nthis.collect=processAlbum;',sandbox);
  assert.equal(await sandbox.collect({}, {}, {id:id(),title:'Futttura Live'},owner,{tracksProcessed:0,streamsUpdated:0}),2);
  assert.equal(calls[0].length,1); assert.equal(calls[0][0].id,collab.id);
});

test('late guest credits link canonical heads, retain history and respect hidden/album-only profiles', {skip:process.env.CREDITS_DB_TEST!=='1'},async()=>{
  require('dotenv').config({path:require('node:path').join(__dirname,'../../../.env')});
  const {Pool}=require('pg'),{databaseConfig}=require('../lib/database');
  const pool=new Pool({...databaseConfig(),max:1}),client=await pool.connect();
  const jt='31TPClRtHm23RisEBtV3X7';
  const owner=id(),guest=id(),albumOnly=id(),inactive=id(),album=id(),head=id(),alias=id(),hidden=id();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO tracked_artists(artist_id,name,album_only,active) VALUES($1,$2,false,true) ON CONFLICT DO NOTHING',[jt,'Justin Timberlake']);
    for(const [artist,only,active] of [[owner,false,true],[guest,false,true],[albumOnly,true,true],[inactive,false,false]])
      await client.query('INSERT INTO tracked_artists(artist_id,name,album_only,active) VALUES($1,$2,$3,$4)',[artist,'Credit regression',only,active]);
    await client.query('INSERT INTO albums(id,title) VALUES($1,$2)',[album,'Credit regression']);
    for(const [song,canonical] of [[head,null],[alias,head],[hidden,null]])
      await client.query('INSERT INTO songs(id,title,album_id,duration_ms,primary_artist,is_solo,canonical_id) VALUES($1,$2,$3,100000,$4,true,$5)',[song,'Live recording',album,'spotify:artist:'+owner,canonical]);
    await client.query('INSERT INTO stream_stats(song_id,stream_count,recorded_date) VALUES($1,147377,CURRENT_DATE)',[head]);
    await client.query('INSERT INTO hidden_songs(song_id,reason) VALUES($1,$2)',[hidden,'Regression hidden recording']);
    const before=(await client.query('SELECT * FROM stream_stats WHERE song_id=$1',[head])).rows;
    const tracks=[alias,hidden].map(song=>({id:song,artistUris:[owner,guest,albumOnly,inactive,'31TPClRtHm23RisEBtV3X7'].map(a=>'spotify:artist:'+a)}));
    const result=await syncArtistCredits(client,{id:album,title:'Credit regression'},tracks);
    assert.equal(result.linked,2);assert.equal(result.pinned,2);
    assert.deepEqual((await client.query('SELECT artist_id,song_id FROM extra_artist_songs WHERE song_id=ANY($1::text[])',[[head,alias,hidden]])).rows.sort((a,b)=>a.artist_id.localeCompare(b.artist_id)),[{artist_id:guest,song_id:head},{artist_id:jt,song_id:head}].sort((a,b)=>a.artist_id.localeCompare(b.artist_id)));
    assert.equal((await client.query('SELECT primary_artist,is_solo FROM songs WHERE id=$1',[head])).rows[0].primary_artist,'spotify:artist:'+owner);
    assert.equal((await client.query('SELECT is_solo FROM songs WHERE id=$1',[head])).rows[0].is_solo,false);
    assert.deepEqual((await client.query('SELECT * FROM stream_stats WHERE song_id=$1',[head])).rows,before);
    const again=await syncArtistCredits(client,{id:album,title:'Credit regression'},tracks);assert.equal(again.linked,0);assert.equal(again.pinned,0);
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});


test('JT shares linked lead recordings without inheriting the owner catalogue or lead classification', {skip:process.env.CREDITS_DB_TEST!=='1'},async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  require('dotenv').config({path:path.join(__dirname,'../../../.env')});
  const {Pool}=require('pg'),{databaseConfig}=require('../lib/database');
  const pool=new Pool({...databaseConfig(),max:1});
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const jt='31TPClRtHm23RisEBtV3X7',owner=id(),inactive=id();
  const roster=[jt,owner].map(artist_id=>({artist_id}));
  const context={allArtistsCache:[...roster,{artist_id:inactive}],activeArtistsCache:roster,releaseTracksCache:[],
    getExtraTrackIdsSql:artist=>artist===jt ? "'shared'" : "'none'"};
  vm.createContext(context);
  for(const [start,end] of [
    ['function artistBucketMatchSQL(', '// The per-song/per-artist aggregate CTEs'],
    ['function artistAlbumMatchSQL(', '// FutureSex/LoveSounds album-id family'],
  ]) vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),context);
  const values=`WITH s(id,primary_artist,is_featured) AS (VALUES
    ('shared','spotify:artist:${owner}',false),('unrelated','spotify:artist:${owner}',false),
    ('inactive','spotify:artist:${inactive}',false),('solo','spotify:artist:${jt}',false),
    ('unclaimed',NULL::text,true)), a(title) AS (VALUES('Test album'))`;
  try {
    for(const filter of [context.artistBucketMatchSQL('s','a'),context.artistAlbumMatchSQL('s')]) {
      const result=await pool.query(`${values} SELECT s.id,${context.artistFeaturedSQL('s')} AS is_featured FROM s CROSS JOIN a WHERE ${filter} ORDER BY s.id`,['spotify:artist:'+jt]);
      assert.deepEqual(result.rows,[{id:'shared',is_featured:true},{id:'solo',is_featured:false},{id:'unclaimed',is_featured:true}]);
    }
    const result=await pool.query(`${values} SELECT s.id,${context.artistFeaturedSQL('s')} AS is_featured FROM s CROSS JOIN a WHERE ${context.artistBucketMatchSQL('s','a')} ORDER BY s.id`,['spotify:artist:'+owner]);
    assert.deepEqual(result.rows,[{id:'shared',is_featured:false},{id:'unrelated',is_featured:false}]);
  } finally { await pool.end(); }
});
