'use strict';
// Opt-in real PostgreSQL regression. All fixtures and route writes share one
// connection inside an outer transaction which is ALWAYS rolled back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { once } = require('node:events');

test('release settings, imports and membership preserve real PostgreSQL recordings and history', { skip: process.env.RELEASE_DB_TEST !== '1', timeout: 120000 }, async () => {
  const filename = path.join(__dirname, '../server.js'), localRequire = createRequire(filename);
  localRequire('dotenv').config({ path: path.join(__dirname,'../../../.env') });
  const { Pool } = localRequire('pg');
  const pool = new Pool({ ...localRequire('./lib/database').databaseConfig(), max: 1 });
  const db = await pool.connect();
  let server;
  const id = () => randomBytes(16).toString('hex').slice(0,22);
  const artist = id(), album = id(), source = id(), first = id(), second = id(), third = id(), alias = id();
  try {
    await db.query('BEGIN');
    await db.query('INSERT INTO tracked_artists(artist_id,name,active,sort_order) VALUES($1,$2,true,9999)',[artist,'Release regression fixture']);
    await db.query('INSERT INTO albums(id,title,release_date) VALUES($1,$2,$5),($3,$4,$5)',[album,'Fixture EP',source,'Fixture singles','2026-10-23']);
    for (const [sid,aid,featured,num,canonical] of [[first,album,true,1,null],[second,source,false,1,null],[third,source,false,2,null],[alias,album,true,2,second]]) {
      await db.query(`INSERT INTO songs(id,title,album_id,duration_ms,track_number,is_featured,primary_artist,is_solo,canonical_id)
        VALUES($1,$2,$3,200000,$4,$5,$6,true,$7)`,[sid,'Fixture '+num,aid,num,featured,'spotify:artist:'+artist,canonical]);
    }
    await db.query(`INSERT INTO stream_stats(song_id,stream_count,recorded_date,recorded_at)
      SELECT id,100000,'2026-10-24'::date,NOW() FROM songs WHERE id=ANY($1::text[])`,[[first,second,third,alias]]);
    const snapshotBefore = (await db.query('SELECT song_id,stream_count,recorded_date::text FROM stream_stats WHERE song_id=ANY($1::text[]) ORDER BY song_id',[[first,second,third,alias]])).rows;
    const env = { ...process.env, PORT: '0', ADMIN_PASSCODE: 'release-test-admin-'.repeat(4), SECADMIN_PASSCODE:'release-test-secondary-'.repeat(4), IP_HASH_SECRET:'release-test-ip-'.repeat(4), ENABLE_OG_STATS_CACHE:'false' };
    // Route transactions become savepoints, so no test route can commit fixtures.
    let serial = Promise.resolve();
    const query = (sql, params) => { const result = serial.then(() => db.query(sql,params)); serial = result.catch(() => {}); return result; };
    const connection = { release() {}, query(sql, params) {
      if (sql === 'BEGIN') return query('SAVEPOINT release_route');
      if (sql === 'COMMIT') return query('RELEASE SAVEPOINT release_route');
      if (sql === 'ROLLBACK') return query('ROLLBACK TO SAVEPOINT release_route');
      return query(sql,params);
    } };
    class TestPool { on() {} query(...args) { return connection.query(...args); } async connect() { return connection; } }
    const express = localRequire('express');
    function testExpress() { const app=express(), listen=app.listen.bind(app); app.listen=(_port,cb)=>(server=listen(0,'127.0.0.1',cb)); return app; }
    Object.assign(testExpress,express);
    const security = localRequire('./lib/security');
    const sandbox = { require: name => name==='express' ? testExpress : name==='pg' ? { Pool:TestPool }
      : name==='dotenv' ? { config() {} } : name==='./lib/push' ? { pushEnabled:false }
      : name==='./lib/security' ? { ...security, securityConfig:()=>security.securityConfig(env),proxyTrust:()=>0 }
      : name==='./lib/database' ? { databaseConfig:()=>localRequire(name).databaseConfig(env) } : localRequire(name),
      __dirname:path.dirname(filename),process:{ env,on() {},uptime:()=>0 },console,setTimeout,clearTimeout,setInterval,clearInterval,Buffer,URL,AbortController,fetch };
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),sandbox,{ filename });
    if (!server.listening) await once(server,'listening');
    const base='http://127.0.0.1:'+server.address().port;
    async function request(route, body, method) {
      const response=await fetch(base+route,{method:method || (body?'POST':'GET'),headers:{'X-Admin-Passcode':env.ADMIN_PASSCODE,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json(); assert.equal(response.status,200,JSON.stringify(data)); return data;
    }
    const list=()=>request('/api/albums?artist='+artist);
    const inspect=()=>request('/api/admin/releases/diagnose?artist='+artist+'&reference=spotify:album:'+album);
    assert.ok(!(await list()).some(x=>x.album_id===album),'automatic filter excludes a feature-only release');
    assert.equal((await inspect()).state.code,'filtered');
    const settings={artist_id:artist,visibility:'show',sort_order:3,release_type:'ep'};
    await request('/api/admin/releases/'+album+'/settings',settings);
    let row=(await list()).find(x=>x.album_id===album);
    assert.ok(row); assert.equal(row.track_count,2); assert.equal(Number(row.total_streams),200000); assert.equal(row.release_type,'ep'); assert.equal(row.sort_order,3);
    assert.equal((await inspect()).state.code,'visible');
    await request('/api/admin/releases/'+album+'/settings',{...settings,visibility:'hide'});
    assert.ok(!(await list()).some(x=>x.album_id===album)); assert.equal((await inspect()).state.code,'hidden');
    await request('/api/admin/releases/'+album+'/settings',settings);
    await request('/api/admin/releases/'+album+'/tracks',{artist_id:artist,song_url:third});
    await request('/api/admin/releases/'+album+'/tracks',{artist_id:artist,song_url:third});
    row=(await list()).find(x=>x.album_id===album); assert.equal(row.track_count,3,'idempotent added membership'); assert.equal(Number(row.total_streams),300000);
    let tracks=await request('/api/albums/'+album+'/songs'); assert.equal(tracks.length,3);
    const { applyTracks }=localRequire('./lib/playlist-import');
    const importTrack={id:second,name:'Fixture 1',albumId:album,albumName:'Fixture EP',release:'2026-10-23',coverUrl:null,
      artistUris:['spotify:artist:'+artist],playcount:100001,observed_date:'2026-10-25',duration_ms:200000,track_number:2};
    const job={artist_id:artist,source_type:'album',playlist_id:album,tracks:[importTrack]};
    assert.equal((await applyTracks(db,job,[second],'admin')).linked,1);
    assert.equal((await applyTracks(db,job,[second],'admin')).already_included,1);
    // Refresh the server's membership cache via a normal settings save.
    await request('/api/admin/releases/'+album+'/settings',settings);
    tracks=await request('/api/albums/'+album+'/songs'); assert.equal(tracks.length,3,'an alias and added canonical head count only once');
    assert.equal((await db.query('SELECT album_id FROM songs WHERE id=$1',[second])).rows[0].album_id,source,'existing song stays on original album');
    assert.deepEqual((await db.query('SELECT song_id,stream_count,recorded_date::text FROM stream_stats WHERE song_id=ANY($1::text[]) ORDER BY song_id',[[first,second,third,alias]])).rows,snapshotBefore,'imports never rewrite existing observations');
    await request('/api/admin/hidden-songs',{song_id:second,reason:'Release regression'});
    assert.equal((await list()).find(x=>x.album_id===album).track_count,2,'show override never resurrects globally hidden recordings');
    assert.ok(!(await request('/api/albums/'+album+'/songs')).some(x=>x.id===second));
    assert.equal((await request('/api/admin/releases/diagnose?artist='+artist+'&reference=spotify:track:'+alias)).state.code,'song_hidden');
    await request('/api/admin/hidden-songs/'+second,undefined,'DELETE');
    assert.equal((await list()).find(x=>x.album_id===album).track_count,3,'unhide invalidates cached album responses');
    await request('/api/admin/releases/'+album+'/tracks',{artist_id:artist,song_url:third,action:'remove'});
    assert.equal((await list()).find(x=>x.album_id===album).track_count,2);
    const merged=await request('/api/admin/releases/diagnose?artist='+artist+'&reference=spotify:track:'+alias);
    assert.equal(merged.state.code,'merged');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
    await db.query('ROLLBACK'); db.release(); await pool.end();
  }
});
