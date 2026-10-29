// Pilotage de Spotify depuis la page animateur + envoi des paroles synchronisées à l'écran TV.
// - Connexion OAuth "PKCE" (aucun secret dans le code, seulement le Client ID de l'appli Spotify).
// - Lecture : Spotify Web API (compte Premium requis), sur l'appareil Spotify actif.
// - Paroles : LRCLIB (lrclib.net), synchronisées avec la position de lecture.
// - L'écran TV (même navigateur) reçoit position + paroles via BroadcastChannel.
window.BTSpotify = (() => {
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const K = { client: "blindtest_sp_client", tok: "blindtest_sp_token", ver: "blindtest_sp_verifier" };
  const SCOPES = "user-modify-playback-state user-read-playback-state";
  const REDIRECT = location.origin + location.pathname;
  const tv = "BroadcastChannel" in window ? new BroadcastChannel("blindtest-tv") : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let panel, getState;
  let tok = (() => { try { return JSON.parse(LS.get(K.tok)); } catch { return null; } })();
  let device = null, deviceName = "", playing = false, msg = "", lastSent = null;
  let lyricsQid = null, lyricsCur = null;
  const lyricsCache = {};

  const clientId = () => QUIZ_CONFIG.spotifyClientId || LS.get(K.client) || "";
  const send = (m) => tv && tv.postMessage(m);
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const uriOf = (q) => "spotify:track:" + q.spotify_url.split("/").pop().split("?")[0];

  // ---------- Connexion ----------
  async function login() {
    const ver = b64url(crypto.getRandomValues(new Uint8Array(48)));
    LS.set(K.ver, ver);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ver)));
    location.href = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      response_type: "code", client_id: clientId(), scope: SCOPES, redirect_uri: REDIRECT,
      code_challenge_method: "S256", code_challenge: challenge,
    });
  }

  async function tokenRequest(params) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId(), ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || "HTTP " + r.status);
    tok = { access: j.access_token, refresh: j.refresh_token || tok?.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
    LS.set(K.tok, JSON.stringify(tok));
  }

  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has("code") && !p.has("error")) return;
    history.replaceState(null, "", REDIRECT);
    if (p.get("error")) { msg = "Connexion Spotify annulée."; return; }
    try {
      await tokenRequest({ grant_type: "authorization_code", code: p.get("code"), redirect_uri: REDIRECT, code_verifier: LS.get(K.ver) || "" });
      msg = "";
    } catch (e) { msg = "Connexion Spotify impossible : " + e.message; }
  }

  function disconnect(why) {
    tok = null; device = null; LS.set(K.tok, null); msg = why || ""; render();
  }

  async function access() {
    if (!tok) return null;
    if (Date.now() > tok.exp) {
      try { await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh }); }
      catch { disconnect("Session Spotify expirée : reconnecte-toi."); return null; }
    }
    return tok.access;
  }

  async function api(method, path, body, retried) {
    const a = await access();
    if (!a) throw Object.assign(new Error("Spotify non connecté"), { status: 0 });
    const r = await fetch("https://api.spotify.com/v1" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: "Bearer " + a, ...(body ? { "Content-Type": "application/json" } : {}) },
    });
    if (r.status === 401 && !retried) { tok.exp = 0; return api(method, path, body, true); }
    const txt = await r.text();
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!r.ok) throw Object.assign(new Error(j?.error?.message || "HTTP " + r.status), { status: r.status, reason: j?.error?.reason });
    return j;
  }

  // ---------- Lecture ----------
  function explain(e) {
    if (e.status === 403) return "Spotify refuse la commande (un compte Premium est nécessaire).";
    if (e.status === 404 || e.reason === "NO_ACTIVE_DEVICE") return "Aucun appareil Spotify actif : ouvre l'appli Spotify sur l'ordinateur et lance n'importe quel titre une fois.";
    if (e.status === 429) return "Spotify demande de ralentir, réessaie dans quelques secondes.";
    return "Spotify : " + e.message;
  }

  async function pickDevice() {
    const d = await api("GET", "/me/player/devices");
    const dev = d.devices.find((x) => x.is_active) || d.devices.find((x) => x.type === "Computer") || d.devices[0];
    if (dev) { device = dev.id; deviceName = dev.name; }
    return dev;
  }

  async function play(q, positionMs = 0) {
    if (!tok || !q) return;
    const body = { uris: [uriOf(q)], position_ms: positionMs };
    try {
      await api("PUT", "/me/player/play" + (device ? "?device_id=" + device : ""), body);
      msg = ""; playing = true;
    } catch (e) {
      try {
        if (e.status !== 404 && e.reason !== "NO_ACTIVE_DEVICE") throw e;
        if (!(await pickDevice())) throw e;
        await api("PUT", "/me/player/play?device_id=" + device, body);
        msg = ""; playing = true;
      } catch (e2) { msg = explain(e2); }
    }
    render();
  }

  async function pause() {
    try { await api("PUT", "/me/player/pause"); playing = false; msg = ""; } catch (e) { msg = explain(e); }
    render();
  }

  async function resume() {
    try { await api("PUT", "/me/player/play" + (device ? "?device_id=" + device : "")); playing = true; msg = ""; } catch (e) { msg = explain(e); }
    render();
  }

  // Position de lecture → écran TV (karaoké)
  async function poll() {
    const s = getState?.();
    if (!tok || !s || (s.status !== "question" && s.status !== "reveal")) return;
    let p;
    try { p = await api("GET", "/me/player"); } catch { return; }
    if (!p || !p.item) return;
    playing = p.is_playing;
    if (p.device) { device = p.device.id; deviceName = p.device.name; }
    lastSent = { type: "now", qid: s.current_q, trackId: p.item.id, progress_ms: p.progress_ms, duration_ms: p.item.duration_ms, is_playing: p.is_playing, at: Date.now() };
    send(lastSent);
    renderStatus();
  }

  // ---------- Paroles ----------
  function parseLrc(lrc) {
    const out = [];
    for (const row of lrc.split(/\r?\n/)) {
      const m = row.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
      if (m) out.push({ t: +m[1] * 60 + +m[2], text: m[3].trim() });
    }
    return out.length ? out : null;
  }

  // Une seule recherche par chanson (la promesse est mise en cache ; oubliée en cas d'échec réseau).
  function fetchLyrics(q) {
    if (!lyricsCache[q.id]) lyricsCache[q.id] = searchLyrics(q).then((res) => { if (!res.found) delete lyricsCache[q.id]; return res; });
    return lyricsCache[q.id];
  }

  async function searchLyrics(q) {
    const params = new URLSearchParams({
      track_name: q.track_title.replace(/\s*\(.*?\)/g, ""),
      artist_name: q.track_artist.split(/\s*(?:&|,|feat\.?)\s*/i)[0],
    });
    let list = null;
    for (let i = 0; i < 3 && !list; i++) {
      try { const r = await fetch("https://lrclib.net/api/search?" + params); if (r.ok) list = await r.json(); } catch {}
      if (!list) await sleep(1500);
    }
    const res = { type: "lyrics", qid: q.id, title: q.track_title, artist: q.track_artist, lines: null, plain: null, found: !!list };
    if (list) {
      const dur = lastSent?.qid === q.id ? lastSent.duration_ms / 1000 : null;
      const synced = list.filter((x) => x.syncedLyrics);
      if (dur) synced.sort((a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur));
      if (synced[0]) res.lines = parseLrc(synced[0].syncedLyrics);
      if (!res.lines) res.plain = list.find((x) => x.plainLyrics)?.plainLyrics || null;
    }
    return res;
  }

  // ---------- Branchement sur la partie ----------
  // Appelé à chaque nouvel état reçu (rafraîchissement ou action).
  function onState(s) {
    if ((s.status === "question" || s.status === "reveal") && s.question) {
      fetchLyrics(s.question); // préchargement
      if (s.status === "reveal" && lyricsQid !== s.current_q) {
        lyricsQid = s.current_q;
        fetchLyrics(s.question).then((l) => { if (lyricsQid === l.qid) { lyricsCur = l; send(l); renderStatus(); } });
      }
    }
    if (s.status !== "reveal") { lyricsQid = null; lyricsCur = null; }
    renderStatus();
  }

  // Appelé après un clic de l'animateur (Démarrer / Suivante…) : on change de chanson.
  function afterAction(prev, s) {
    if (s.status === "question" && s.question && (prev?.status !== "question" || prev?.current_q !== s.current_q)) play(s.question);
  }

  // ---------- Panneau ----------
  function render() {
    if (!panel) return;
    if (!clientId()) {
      panel.innerHTML = `
        <h3>🎧 Spotify</h3>
        <p class="small muted">Pour que la chanson change toute seule, crée une appli Spotify (une seule fois) :</p>
        <ol class="small muted" style="padding-left:18px;margin:6px 0 10px">
          <li>Va sur <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener" style="color:var(--accent2)">developer.spotify.com/dashboard</a> → <b>Create app</b></li>
          <li>Redirect URI : <code style="color:var(--accent2);word-break:break-all">${esc(REDIRECT)}</code></li>
          <li>Coche <b>Web API</b>, enregistre, puis copie le <b>Client ID</b> ici :</li>
        </ol>
        <div style="display:flex;gap:8px"><input type="text" id="spClient" placeholder="Client ID" style="font-size:.95rem;padding:10px">
        <button class="btn" id="spSave">OK</button></div>
        <div class="err small">${esc(msg)}</div>`;
      panel.querySelector("#spSave").onclick = () => {
        const v = panel.querySelector("#spClient").value.trim();
        if (/^[0-9a-f]{32}$/i.test(v)) { LS.set(K.client, v); msg = ""; } else msg = "Ce Client ID ne ressemble pas à celui de Spotify (32 caractères).";
        render();
      };
      return;
    }
    if (!tok) {
      panel.innerHTML = `
        <h3>🎧 Spotify</h3>
        <button class="btn spotify block" id="spLogin">Connecter mon Spotify</button>
        <div class="err small">${esc(msg)}</div>
        <p class="hint">Compte Premium nécessaire. <a href="#" id="spForget" style="color:var(--muted)">Changer de Client ID</a></p>`;
      panel.querySelector("#spLogin").onclick = login;
      panel.querySelector("#spForget").onclick = (e) => { e.preventDefault(); LS.set(K.client, null); render(); };
      return;
    }
    panel.innerHTML = `
      <h3>🎧 Spotify <span class="small" style="color:var(--ok)">● connecté</span></h3>
      <div class="small muted" id="spStatus"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn ghost" id="spToggle" style="padding:10px 14px"></button>
        <button class="btn ghost" id="spRestart" style="padding:10px 14px" title="Relancer la chanson de la question en cours">↺ Relancer</button>
      </div>
      <div class="err small" id="spMsg"></div>
      <p class="hint">La chanson se lance toute seule à chaque nouvelle question. <a href="#" id="spOut" style="color:var(--muted)">Déconnecter</a></p>`;
    panel.querySelector("#spToggle").onclick = () => (playing ? pause() : resume());
    panel.querySelector("#spRestart").onclick = () => { const s = getState(); if (s?.question) play(s.question); };
    panel.querySelector("#spOut").onclick = (e) => { e.preventDefault(); disconnect(); };
    renderStatus();
  }

  function renderStatus() {
    if (!panel || !tok) return;
    const st = panel.querySelector("#spStatus"); if (!st) return;
    const s = getState?.();
    let lyr = "";
    if (s?.status === "reveal") lyr = lyricsCur ? (lyricsCur.lines ? " · 🎤 paroles sur l'écran TV" : " · paroles introuvables") : " · recherche des paroles…";
    st.textContent = (deviceName ? "Appareil : " + deviceName : "Appareil : celui où Spotify est ouvert") + lyr;
    panel.querySelector("#spToggle").textContent = playing ? "⏸ Pause" : "▶ Reprendre";
    panel.querySelector("#spMsg").textContent = msg;
  }

  async function init(el, stateGetter) {
    panel = el; getState = stateGetter;
    await handleRedirect();
    render();
    setInterval(poll, 1000);
    if (tv) tv.onmessage = (e) => {
      if (e.data?.type !== "hello") return;
      if (lyricsCur) send(lyricsCur);
      if (lastSent) send(lastSent);
    };
  }

  return { init, onState, afterAction, play };
})();
