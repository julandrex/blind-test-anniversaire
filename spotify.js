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

  let panel, getState, rpc;
  let tok = (() => { try { return JSON.parse(LS.get(K.tok)); } catch { return null; } })();
  let device = null, deviceName = "", playing = false, msg = "", lastSent = null;
  let lyricsQid = null, lyricsCur = null;
  const lyricsCache = {}, coverCache = {};

  const clientId = () => QUIZ_CONFIG.spotifyClientId || LS.get(K.client) || "";
  const send = (m) => tv && tv.postMessage(m);
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const trackId = (q) => q.spotify_url.split("/").pop().split("?")[0];
  const uriOf = (q) => "spotify:track:" + trackId(q);

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
  // Message lisible + détail brut de Spotify (utile pour diagnostiquer).
  function explain(e) {
    console.warn("Spotify", e.status, e.reason, e.message);
    const raw = ` [${e.status}${e.reason ? " " + e.reason : ""} : ${e.message}]`;
    if (e.status === 404 || e.reason === "NO_ACTIVE_DEVICE") return "Aucun appareil Spotify actif : ouvre l'appli Spotify sur l'ordinateur et lance n'importe quel titre une fois." + raw;
    if (e.reason === "PREMIUM_REQUIRED") return "Spotify indique que ce compte n'est pas Premium." + raw;
    if (e.status === 403 && /not registered|developer dashboard|user may not/i.test(e.message))
      return "Ce compte Spotify n'est pas autorisé sur ton appli développeur (ajoute-le dans User Management)." + raw;
    if (e.status === 403) return "Spotify a refusé la commande." + raw;
    if (e.status === 429) return "Spotify demande de ralentir, réessaie dans quelques secondes." + raw;
    return "Spotify :" + raw;
  }

  async function devices() {
    const d = await api("GET", "/me/player/devices");
    return (d?.devices || []).filter((x) => !x.is_restricted);
  }

  async function pickDevice() {
    const list = await devices();
    const dev = list.find((x) => x.is_active) || list.find((x) => x.type === "Computer") || list[0];
    if (dev) { device = dev.id; deviceName = dev.name; }
    return dev;
  }

  // Lance un titre : 1) sur l'appareil connu, 2) sinon on (ré)active l'appareil puis on relance.
  async function play(q, positionMs = 0) {
    if (!tok || !q) return;
    const body = { uris: [uriOf(q)], position_ms: positionMs };
    try {
      await api("PUT", "/me/player/play" + (device ? "?device_id=" + device : ""), body);
      msg = ""; playing = true;
    } catch (e) {
      try {
        if (e.status !== 404 && e.status !== 403 && e.status !== 502) throw e;
        if (!(await pickDevice())) throw Object.assign(new Error("aucun appareil"), { status: 404, reason: "NO_ACTIVE_DEVICE" });
        await api("PUT", "/me/player", { device_ids: [device], play: false });
        await sleep(600);
        await api("PUT", "/me/player/play?device_id=" + device, body);
        msg = ""; playing = true;
      } catch (e2) { msg = explain(e2); }
    }
    render();
  }

  // Pause / reprise selon l'état réel du lecteur (évite les refus « commande inutile » de Spotify).
  async function toggle() {
    try {
      const p = await api("GET", "/me/player");
      if (p?.is_playing) await api("PUT", "/me/player/pause");
      else if (p?.item) await api("PUT", "/me/player/play" + (p.device?.id ? "?device_id=" + p.device.id : ""));
      else { const s = getState(); if (s?.question) return play(s.question); }
      playing = !p?.is_playing; msg = "";
    } catch (e) { msg = explain(e); }
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

  // Une seule recherche par chanson (la promesse est mise en cache ; en cas d'échec réseau, nouvel essai après 20 s).
  function fetchLyrics(q) {
    if (!lyricsCache[q.id]) lyricsCache[q.id] = searchLyrics(q).then((res) => {
      if (!res.found) setTimeout(() => delete lyricsCache[q.id], 20000);
      return res;
    });
    return lyricsCache[q.id];
  }

  // Durée Spotify de la piste, pour choisir les paroles calées sur la bonne version (facultatif).
  async function trackDuration(q) {
    if (!tok) return null;
    try { return (await api("GET", "/tracks/" + trackId(q)))?.duration_ms / 1000 || null; } catch { return null; }
  }

  // Paroles synchronisées uniquement : d'abord la sauvegarde Supabase, sinon LRCLIB (et on sauvegarde la réponse).
  async function searchLyrics(q) {
    const res = { type: "lyrics", qid: q.id, title: q.track_title, artist: q.track_artist, lines: null, found: false };
    const saved = await rpc?.("admin_lyrics_get", { p_track_id: trackId(q) });
    if (saved) return { ...res, lines: saved, found: true };

    const params = new URLSearchParams({
      track_name: q.track_title.replace(/\s*\(.*?\)/g, ""),
      artist_name: q.track_artist.split(/\s*(?:&|,|feat\.?)\s*/i)[0],
    });
    let list = null;
    for (let i = 0; i < 3 && !list; i++) {
      try { const r = await fetch("https://lrclib.net/api/search?" + params); if (r.ok) list = await r.json(); } catch {}
      if (!list) await sleep(1500);
    }
    if (!list) return res; // service indisponible : on ne conclut rien pour cette chanson
    res.found = true;
    const synced = list.filter((x) => x.syncedLyrics);
    if (synced.length > 1) {
      const dur = await trackDuration(q);
      if (dur) synced.sort((a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur));
    }
    if (synced[0]) res.lines = parseLrc(synced[0].syncedLyrics);
    await rpc?.("admin_lyrics_put", { p_track_id: trackId(q), p_lines: res.lines });
    return res;
  }

  // Bouton « Préparer les paroles » : sauvegarde à l'avance tout un blind test.
  async function prepareLyrics(quizId, onProgress) {
    const rows = await rpc("admin_lyrics_status", { p_quiz_id: quizId });
    if (!rows) return { error: true };
    let synced = rows.filter((q) => q.lyrics === "synced").length, none = 0, failures = 0, failed = 0, done = 0;
    const todo = rows.filter((q) => q.lyrics !== "synced");
    for (const q of todo) {
      onProgress({ done, todo: todo.length, synced, total: rows.length });
      const res = await searchLyrics(q);
      done++;
      if (res.lines) synced++; else if (res.found) none++; else failed++;
      failures = res.found ? 0 : failures + 1;
      if (failures >= 3) return { outage: true, synced, none, total: rows.length };
      await sleep(400);
    }
    return { synced, none, failed, total: rows.length };
  }

  // Pochette de l'album : service public de Spotify, sans connexion (image 640 px si possible).
  function fetchCover(q) {
    if (!coverCache[q.id]) coverCache[q.id] = (async () => {
      try {
        const r = await fetch("https://open.spotify.com/oembed?url=" + encodeURIComponent("https://open.spotify.com/track/" + trackId(q)));
        if (r.ok) return (await r.json()).thumbnail_url?.replace("/ab67616d00001e02", "/ab67616d0000b273") || null;
      } catch {}
      setTimeout(() => delete coverCache[q.id], 20000);
      return null;
    })();
    return coverCache[q.id];
  }

  // ---------- Branchement sur la partie ----------
  // Appelé à chaque nouvel état reçu (rafraîchissement ou action).
  function onState(s) {
    if ((s.status === "question" || s.status === "reveal") && s.question) {
      fetchLyrics(s.question); // préchargement
      fetchCover(s.question);
      if (s.status === "reveal" && lyricsQid !== s.current_q) {
        // L'écran TV repère la question par sa position (current_q), pas par l'id de la question.
        // Titre et artiste partent tout de suite ; pochette et paroles suivent dès qu'elles arrivent.
        const pos = lyricsQid = s.current_q, q = s.question;
        lyricsCur = { type: "lyrics", qid: pos, title: q.track_title, artist: q.track_artist, lines: null, cover: null, pending: true };
        send(lyricsCur);
        const update = (patch) => { if (lyricsQid === pos) { lyricsCur = { ...lyricsCur, ...patch }; send(lyricsCur); renderStatus(); } };
        fetchCover(q).then((cover) => update({ cover }));
        fetchLyrics(q).then((l) => update({ lines: l.lines, pending: false }));
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
    panel.querySelector("#spToggle").onclick = toggle;
    // Relance la chanson en cours, ou à l'accueil la première chanson (pratique pour tester).
    panel.querySelector("#spRestart").onclick = () => { const s = getState(); const q = s?.question || s?.next_question; if (q) play(q); };
    panel.querySelector("#spOut").onclick = (e) => { e.preventDefault(); disconnect(); };
    renderStatus();
  }

  function renderStatus() {
    if (!panel || !tok) return;
    const st = panel.querySelector("#spStatus"); if (!st) return;
    const s = getState?.();
    let lyr = "";
    if (s?.status === "reveal") lyr = lyricsCur && !lyricsCur.pending ? (lyricsCur.lines ? " · 🎤 paroles sur l'écran TV" : " · pas de paroles synchronisées") : " · recherche des paroles…";
    st.textContent = (deviceName ? "Appareil : " + deviceName : "Appareil : celui où Spotify est ouvert") + lyr;
    panel.querySelector("#spToggle").textContent = playing ? "⏸ Pause" : "▶ Reprendre";
    panel.querySelector("#spMsg").textContent = msg;
  }

  async function init(el, stateGetter, rpcCall) {
    panel = el; getState = stateGetter; rpc = rpcCall;
    await handleRedirect();
    render();
    setInterval(poll, 1000);
    if (tv) tv.onmessage = (e) => {
      if (e.data?.type !== "hello") return;
      if (lyricsCur) send(lyricsCur);
      if (lastSent) send(lastSent);
    };
  }

  return { init, onState, afterAction, play, prepareLyrics };
})();
