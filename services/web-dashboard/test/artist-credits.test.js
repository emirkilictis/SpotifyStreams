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
  const owner=id(),guest=id(),albumOnly=id(),inactive=id(),album=id(),head=id(),alias=id(),hidden=id();
  try {
    await client.query('BEGIN');
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
    assert.equal(result.linked,1);assert.equal(result.pinned,1);
    assert.deepEqual((await client.query('SELECT artist_id,song_id FROM extra_artist_songs WHERE song_id=ANY($1::text[])',[[head,alias,hidden]])).rows,[{artist_id:guest,song_id:head}]);
    assert.equal((await client.query('SELECT primary_artist,is_solo FROM songs WHERE id=$1',[head])).rows[0].primary_artist,'spotify:artist:'+owner);
    assert.equal((await client.query('SELECT is_solo FROM songs WHERE id=$1',[head])).rows[0].is_solo,false);
    assert.deepEqual((await client.query('SELECT * FROM stream_stats WHERE song_id=$1',[head])).rows,before);
    const again=await syncArtistCredits(client,{id:album,title:'Credit regression'},tracks);assert.equal(again.linked,0);assert.equal(again.pinned,0);
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
