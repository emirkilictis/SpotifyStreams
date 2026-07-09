const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
let loginCookie = '';

async function runTests() {
  console.log("=== RUNNING SECURITY INTEGRATION TESTS ===");
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ PASSED: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAILED: ${name}`);
      console.error(err);
      failed++;
    }
  }

  // 1. Public Request
  await test("Public requests should return 200 OK without session", async () => {
    const res = await fetch(`${BASE_URL}/api/songs?artist=31TPClRtHm23RisEBtV3X7`);
    assert.strictEqual(res.status, 200, "Should be 200 OK for public access");
  });

  // 2. Perform Login
  await test("Login with valid passcode should succeed and return cookie", async () => {
    const res = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'timberlake_fan' })
    });
    assert.strictEqual(res.status, 200, "Login should return 200 OK");
    const cookieHeader = res.headers.get('set-cookie');
    assert.ok(cookieHeader, "Should return Set-Cookie header");
    loginCookie = cookieHeader.split(';')[0]; // Extract the session cookie
  });

  // 3. Authenticated Request (JT)
  await test("Authenticated user should access Justin Timberlake stats", async () => {
    const res = await fetch(`${BASE_URL}/api/stats?artist=31TPClRtHm23RisEBtV3X7`, {
      headers: { 'Cookie': loginCookie }
    });
    assert.strictEqual(res.status, 200, "JT stats should return 200 OK");
  });

  // 4. Authenticated Request to LISA (no lock)
  await test("Authenticated user should access LISA stats without extra passcode", async () => {
    const res = await fetch(`${BASE_URL}/api/stats?artist=5L1lO4eRHmJ7a0Q6csE5cT`, {
      headers: { 'Cookie': loginCookie }
    });
    assert.strictEqual(res.status, 200, "LISA stats should return 200 OK");
  });

  // 5. Authenticated Request to JC Chasez (Locked, no header)
  await test("Authenticated request to JC Chasez stats without passcode header should return 403 Forbidden", async () => {
    const res = await fetch(`${BASE_URL}/api/stats?artist=3p3U04w2DaiBzuYMZnYr00`, {
      headers: { 'Cookie': loginCookie }
    });
    assert.strictEqual(res.status, 403, "Should return 403 Forbidden");
  });

  // 6. Authenticated Request to JC Chasez (Locked, wrong header)
  await test("Authenticated request to JC Chasez stats with incorrect passcode header should return 403 Forbidden", async () => {
    const res = await fetch(`${BASE_URL}/api/stats?artist=3p3U04w2DaiBzuYMZnYr00`, {
      headers: { 
        'Cookie': loginCookie,
        'X-JC-Passcode': 'wrong_password'
      }
    });
    assert.strictEqual(res.status, 403, "Should return 403 Forbidden");
  });

  // 7. Authenticated Request to JC Chasez (Locked, correct header)
  await test("Authenticated request to JC Chasez stats with correct passcode header should return 200 OK", async () => {
    const res = await fetch(`${BASE_URL}/api/stats?artist=3p3U04w2DaiBzuYMZnYr00`, {
      headers: { 
        'Cookie': loginCookie,
        'X-JC-Passcode': 'peakedinhighschool'
      }
    });
    assert.strictEqual(res.status, 200, "Should return 200 OK");
    const data = await res.json();
    assert.ok(data.total_streams, "Should return stream stats data");
  });

  // 8. Authenticated Request to JC Chasez album songs (Locked, no header)
  await test("Authenticated request to JC Chasez album songs without passcode header should return 403 Forbidden", async () => {
    const res = await fetch(`${BASE_URL}/api/albums/2BSWztobDwPRNdoICigWNY/songs`, {
      headers: { 'Cookie': loginCookie }
    });
    assert.strictEqual(res.status, 403, "Should return 403 Forbidden");
  });

  // 9. Authenticated Request to JC Chasez album songs (Locked, correct header)
  await test("Authenticated request to JC Chasez album songs with correct passcode header should return 200 OK", async () => {
    const res = await fetch(`${BASE_URL}/api/albums/2BSWztobDwPRNdoICigWNY/songs`, {
      headers: { 
        'Cookie': loginCookie,
        'X-JC-Passcode': 'peakedinhighschool'
      }
    });
    assert.strictEqual(res.status, 200, "Should return 200 OK");
    const data = await res.json();
    assert.ok(Array.isArray(data), "Should return an array of songs");
  });

  // 10. Passcode Verification Endpoint (Wrong)
  await test("Verification of wrong JC passcode should return 401 Unauthorized", async () => {
    const res = await fetch(`${BASE_URL}/api/verify-jc`, {
      method: 'POST',
      headers: { 
        'Cookie': loginCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ passcode: 'wrong_passcode' })
    });
    assert.strictEqual(res.status, 401, "Should return 401 Unauthorized");
  });

  // 11. Passcode Verification Endpoint (Correct)
  await test("Verification of correct JC passcode should return 200 OK with success:true", async () => {
    const res = await fetch(`${BASE_URL}/api/verify-jc`, {
      method: 'POST',
      headers: { 
        'Cookie': loginCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ passcode: 'peakedinhighschool' })
    });
    assert.strictEqual(res.status, 200, "Should return 200 OK");
    const data = await res.json();
    assert.strictEqual(data.success, true, "Response payload should have success = true");
  });

  // 12. secadmin login/auth
  await test("Auth as secadmin should return 200 and set X-Admin-Role header", async () => {
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      headers: { 'X-Admin-Passcode': 'secadmin:pineapple' }
    });
    assert.strictEqual(res.status, 200, "Should allow secadmin authentication");
    assert.strictEqual(res.headers.get('X-Admin-Role'), 'secadmin', "Should return X-Admin-Role: secadmin header");
  });

  // 13. secadmin God-mode blocked
  await test("secadmin should be blocked from God-mode overview", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/overview`, {
      headers: { 'X-Admin-Passcode': 'secadmin:pineapple' }
    });
    assert.strictEqual(res.status, 403, "Should return 403 Forbidden for overview");
  });

  // 14. secadmin JT edit blocked
  await test("secadmin should be blocked from editing Justin Timberlake roster row", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/artists`, {
      method: 'POST',
      headers: { 
        'X-Admin-Passcode': 'secadmin:pineapple',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ artist_id: '31TPClRtHm23RisEBtV3X7', name: 'Justin Timberlake Modified' })
    });
    assert.strictEqual(res.status, 403, "Should return 403 Forbidden for editing JT");
  });

  // 15. secadmin JT delete blocked
  await test("secadmin should be blocked from deleting Justin Timberlake", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/artists/31TPClRtHm23RisEBtV3X7`, {
      method: 'DELETE',
      headers: { 'X-Admin-Passcode': 'secadmin:pineapple' }
    });
    assert.strictEqual(res.status, 403, "Should return 403 Forbidden for deleting JT");
  });

  // 16. secadmin JT song actions blocked
  await test("secadmin should be blocked from modifying JT songs", async () => {
    // First, fetch a JT song ID dynamically
    const songsRes = await fetch(`${BASE_URL}/api/songs?artist=31TPClRtHm23RisEBtV3X7`);
    const songs = await songsRes.json();
    if (songs && songs.length > 0) {
      const songId = songs[0].id;
      // Try to move JT song to another artist bucket (e.g. JC Chasez '3p3U04w2DaiBzuYMZnYr00')
      const res = await fetch(`${BASE_URL}/api/admin/songs/${songId}`, {
        method: 'PATCH',
        headers: { 
          'X-Admin-Passcode': 'secadmin:pineapple',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ primary_artist: '3p3U04w2DaiBzuYMZnYr00' })
      });
      assert.strictEqual(res.status, 403, "Should return 403 Forbidden for moving JT song");

      // Try to hide JT song
      const hideRes = await fetch(`${BASE_URL}/api/admin/hidden-songs`, {
        method: 'POST',
        headers: { 
          'X-Admin-Passcode': 'secadmin:pineapple',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ song_id: songId, reason: 'test hide' })
      });
      assert.strictEqual(hideRes.status, 403, "Should return 403 Forbidden for hiding JT song");
    }
  });

  console.log(`\n=== TEST RUN SUMMARY: ${passed} PASSED, ${failed} FAILED ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
