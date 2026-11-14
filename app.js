'use strict';
/* Hitster – Hip-Hop & R&B
 * Skaner QR (jsQR) + pilot Spotify (Web API, Authorization Code + PKCE).
 * Muzyka gra na wybranym urządzeniu Spotify Connect (telefon, głośnik, komputer) – wymaga Premium.
 */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const SPOTIFY = {
    auth: 'https://accounts.spotify.com/authorize',
    token: 'https://accounts.spotify.com/api/token',
    api: 'https://api.spotify.com/v1',
  };
  const SCOPES = 'user-modify-playback-state user-read-playback-state';
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');

  // ---------- storage ----------
  const LS = {
    get(k, d = null) { try { const v = localStorage.getItem('hh.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hh.' + k, JSON.stringify(v)); } catch { /* tryb prywatny */ } },
    del(k) { try { localStorage.removeItem('hh.' + k); } catch { /* ignore */ } },
  };

  const state = {
    songs: new Map(),
    clientId: LS.get('clientId') || (window.HITSTER_CONFIG && window.HITSTER_CONFIG.clientId) || '',
    tokens: LS.get('tokens'),
    deviceId: LS.get('deviceId'),
    startMode: LS.get('startMode', '0'),
    resolved: LS.get('resolved', {}),   // cache: id karty -> {id, year}
    current: null,                      // {card, track}
    paused: false,
    stream: null, scanning: false, lastScan: { id: null, t: 0 },
    wakeLock: null,
  };

  // ---------- UI helpers ----------
  const views = ['setup', 'login', 'home', 'scan', 'card'];
  let currentView = null;
  function show(name) {
    currentView = name;
    for (const v of views) $('#view-' + v).hidden = (v !== name);
  }
  let toastTimer;
  function toast(msg, isError = false, ms = 3500) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, ms);
  }

  // ---------- PKCE / OAuth ----------
  function randStr(n) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.from(a, b => chars[b % chars.length]).join('');
  }
  function b64url(buf) {
    let s = ''; new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function login() {
    if (!window.crypto || !crypto.subtle) { toast('Ta przeglądarka wymaga połączenia HTTPS (lub 127.0.0.1).', true); return; }
    const verifier = randStr(96);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const st = randStr(16);
    LS.set('pkce', { verifier, state: st });
    const url = new URL(SPOTIFY.auth);
    url.search = new URLSearchParams({
      client_id: state.clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256', code_challenge: challenge, state: st, scope: SCOPES,
    }).toString();
    location.assign(url.toString());
  }
  async function tokenRequest(params) {
    const res = await fetch(SPOTIFY.token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: state.clientId, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || 'token error'), { status: res.status, data });
    return data;
  }
  function saveTokens(d) {
    state.tokens = {
      access_token: d.access_token,
      refresh_token: d.refresh_token || (state.tokens && state.tokens.refresh_token),
      expires_at: Date.now() + (d.expires_in || 3600) * 1000,
    };
    LS.set('tokens', state.tokens);
  }
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has('code') && !p.has('error')) return;
    history.replaceState(null, '', REDIRECT_URI);
    if (p.has('error')) { toast('Logowanie przerwane: ' + p.get('error'), true); return; }
    const saved = LS.get('pkce'); LS.del('pkce');
    if (!saved || saved.state !== p.get('state')) { toast('Błąd logowania (state). Spróbuj ponownie.', true); return; }
    try {
      saveTokens(await tokenRequest({
        grant_type: 'authorization_code', code: p.get('code'),
        redirect_uri: REDIRECT_URI, code_verifier: saved.verifier,
      }));
      toast('Zalogowano ✔');
    } catch (e) { toast('Nie udało się zalogować: ' + e.message, true, 6000); }
  }
  let refreshing = null;
  async function getAccessToken() {
    if (!state.tokens) throw Object.assign(new Error('not logged in'), { code: 'NO_AUTH' });
    if (Date.now() < state.tokens.expires_at - 60000) return state.tokens.access_token;
    if (!refreshing) {
      refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: state.tokens.refresh_token })
        .then(saveTokens)
        .catch(e => { if (e.status === 400 || e.status === 401) { logout(false); } throw Object.assign(e, { code: 'NO_AUTH' }); })
        .finally(() => { refreshing = null; });
    }
    await refreshing;
    return state.tokens.access_token;
  }
  function logout(notify = true) {
    state.tokens = null; LS.del('tokens'); stopScan(); route();
    if (notify) toast('Wylogowano');
  }

  // ---------- Spotify Web API ----------
  async function api(path, { method = 'GET', query, body } = {}, retry = true) {
    const token = await getAccessToken();
    const url = new URL(SPOTIFY.api + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) { state.tokens.expires_at = 0; return api(path, { method, query, body }, false); }
    if (res.status === 429 && retry) {
      await sleep(Math.min((Number(res.headers.get('Retry-After')) || 1) * 1000, 5000));
      return api(path, { method, query, body }, false);
    }
    let data = null; const txt = await res.text();
    if (txt) { try { data = JSON.parse(txt); } catch { /* brak JSON */ } }
    return { status: res.status, ok: res.ok, data, reason: data && data.error && data.error.reason, message: data && data.error && data.error.message };
  }

  // ---------- urządzenia ----------
  async function loadDevices(quiet = false) {
    const sel = $('#sel-device'); const hint = $('#device-hint');
    const r = await api('/me/player/devices').catch(e => ({ ok: false, status: 0, message: e.message }));
    if (!r.ok) { hint.textContent = 'Nie udało się pobrać urządzeń (' + (r.message || r.status) + ').'; return []; }
    const devs = (r.data && r.data.devices || []).filter(d => d.id);
    sel.innerHTML = '';
    if (!devs.length) {
      sel.innerHTML = '<option value="">(brak – otwórz aplikację Spotify i odtwórz cokolwiek)</option>';
      hint.textContent = 'Spotify nie widzi żadnego aktywnego urządzenia. Otwórz aplikację Spotify na telefonie/komputerze/głośniku, włącz jakikolwiek utwór na sekundę i odśwież (↻).';
      state.deviceId = null; return [];
    }
    for (const d of devs) {
      const o = document.createElement('option'); o.value = d.id;
      o.textContent = d.name + ' (' + d.type + ')' + (d.is_active ? ' • aktywne' : '');
      sel.appendChild(o);
    }
    let pick = devs.find(d => d.id === state.deviceId) || devs.find(d => d.is_active) || devs[0];
    sel.value = pick.id; state.deviceId = pick.id; LS.set('deviceId', pick.id);
    hint.textContent = 'Najpewniej: graj na komputerze lub głośniku (bez spoilera tytułu). Na iPhonie zostaw w Spotify coś grającego – po pauzie iOS usypia Spotify.';
    if (!quiet) toast('Znaleziono urządzeń: ' + devs.length);
    return devs;
  }

  // ---------- dopasowanie utworu ----------
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const primaryArtist = a => a.split(/\s*(?:,| & | feat\.? | ft\.? | x | and )\s*/i)[0].trim();
  const BAD = /(remix|live|karaoke|instrumental|cover|tribute|version|acoustic|sped up|slowed|lullaby|8-bit)/;

  async function resolveTrack(card) {
    if (card.spotify_id) return { id: card.spotify_id, year: null };
    if (state.resolved[card.id]) return state.resolved[card.id];
    const title = card.title.replace(/\s*\((feat|ft)[^)]*\)/i, '');
    const artist = primaryArtist(card.artist);
    const attempts = [`track:${title} artist:${artist}`, `${title} ${artist}`];
    let items = [];
    for (const q of attempts) {
      const r = await api('/search', { query: { q, type: 'track', limit: 10 } });
      if (!r.ok) {
        if (r.status === 403) throw Object.assign(new Error(r.message || 'forbidden'), { code: 'FORBIDDEN' });
        continue;
      }
      items = (r.data && r.data.tracks && r.data.tracks.items) || [];
      if (items.length) break;
    }
    if (!items.length) throw Object.assign(new Error('Nie znaleziono w Spotify'), { code: 'NOT_FOUND' });
    const nt = norm(title), na = norm(artist);
    const scored = items.map(it => {
      const t = norm(it.name); let s = 0;
      if (t === nt) s += 3; else if (t.startsWith(nt) || nt.startsWith(t)) s += 1.5;
      if ((it.artists || []).some(a => { const x = norm(a.name); return x === na || x.includes(na) || na.includes(x); })) s += 3;
      if (BAD.test(t) && !BAD.test(nt)) s -= 2.5;
      if (it.album && /compilation/i.test(it.album.album_type || '')) s -= 0.5;
      return { it, s, date: (it.album && it.album.release_date) || '9999' };
    }).sort((a, b) => b.s - a.s || (a.date < b.date ? -1 : 1));
    const best = scored[0];
    if (best.s < 3) throw Object.assign(new Error('Brak pewnego dopasowania w Spotify'), { code: 'NOT_FOUND' });
    const res = { id: best.it.id, year: Number((best.date || '').slice(0, 4)) || null };
    state.resolved[card.id] = res; LS.set('resolved', state.resolved);
    return res;
  }

  // ---------- odtwarzanie ----------
  function startOffsetMs() {
    if (state.startMode === 'random') return (20 + Math.floor(Math.random() * 50)) * 1000;
    return Number(state.startMode) * 1000 || 0;
  }
  async function startPlayback(trackId, attempt = 0) {
    const body = { uris: ['spotify:track:' + trackId] };
    const off = startOffsetMs(); if (off > 0) body.position_ms = off;
    const r = await api('/me/player/play', { method: 'PUT', query: { device_id: state.deviceId }, body });
    if (r.ok) return { ok: true };
    // 404 / NO_ACTIVE_DEVICE / 502 / 503: urządzenie jest na liście, ale Spotify nie może się do niego dostać
    // (typowo: aplikacja Spotify na iPhonie uśpiona przez iOS w tle).
    const unreachable = r.status === 404 || r.status === 502 || r.status === 503 || r.reason === 'NO_ACTIVE_DEVICE';
    if (unreachable) {
      if (attempt < 2 && state.deviceId) {
        if (attempt === 0) await api('/me/player', { method: 'PUT', body: { device_ids: [state.deviceId], play: false } });
        await sleep(attempt === 0 ? 700 : 1500);
        return startPlayback(trackId, attempt + 1);
      }
      return { ok: false, code: 'NO_DEVICE' };
    }
    if (r.reason === 'PREMIUM_REQUIRED') return { ok: false, code: 'PREMIUM' };
    if (r.status === 403) return { ok: false, code: 'FORBIDDEN', message: r.message };
    return { ok: false, code: 'OTHER', message: r.message || ('HTTP ' + r.status) };
  }

  const PALETTE = ['#E63946', '#F77F00', '#D9A400', '#2A9D8F', '#118AB2', '#7B2CBF', '#EF476F', '#06A77D', '#8338EC', '#E5007D', '#3A86FF', '#FB5607'];
  const colorFor = id => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };

  async function playCard(card) {
    state.current = { card, track: null }; state.paused = false;
    show('card');
    $('#card-hidden').hidden = false; $('#card-revealed').hidden = true;
    $('#btn-reveal').textContent = '👁 Pokaż odpowiedź';
    $('#card-status').textContent = 'Ładuję utwór…'; $('#card-sub').textContent = '';
    $('#note-anim').classList.remove('playing'); $('#btn-pause').textContent = '⏸ Pauza';
    $('#lnk-open').hidden = true;
    state.needsRetry = false; $('#card-actions').hidden = true;
    keepAwake();
    try {
      const track = await resolveTrack(card);
      state.current.track = track;
      $('#lnk-open').href = 'https://open.spotify.com/track/' + track.id; $('#lnk-open').hidden = false;
      onPlayResult(await startPlayback(track.id));
    } catch (e) {
      if (e.code === 'NO_AUTH') { toast('Zaloguj się ponownie do Spotify', true); route(); return; }
      if (e.code === 'NOT_FOUND') $('#card-status').textContent = 'Nie znaleziono tego utworu w Spotify';
      else if (e.code === 'FORBIDDEN') $('#card-status').textContent = 'Spotify odmówiło dostępu';
      else $('#card-status').textContent = 'Błąd: ' + e.message;
      $('#card-sub').textContent = e.code === 'FORBIDDEN'
        ? 'Konto musi być dodane w panelu Spotify (User Management) i właściciel aplikacji musi mieć Premium.'
        : 'Możesz zeskanować następną kartę – ta odpowiedź jest pod „Pokaż odpowiedź”.';
    }
  }
  function onPlayResult(r) {
    if (r.ok) {
      state.needsRetry = false; $('#card-actions').hidden = true;
      $('#card-status').textContent = 'Gra… Gdzie to wstawisz na osi czasu?'; $('#card-sub').textContent = '';
      $('#note-anim').classList.add('playing');
    } else explainPlaybackError(r);
  }
  let retrying = false;
  async function retryPlay() {
    if (retrying || !state.current || !state.current.track) return;
    retrying = true; state.needsRetry = false; $('#card-actions').hidden = true;
    $('#card-status').textContent = 'Próbuję ponownie…'; $('#card-sub').textContent = '';
    try {
      await loadDevices(true);
      onPlayResult(await startPlayback(state.current.track.id));
    } catch (e) {
      if (e.code === 'NO_AUTH') { toast('Zaloguj się ponownie do Spotify', true); route(); return; }
      onPlayResult({ ok: false, code: 'OTHER', message: e.message });
    } finally { retrying = false; }
  }
  function explainPlaybackError(r) {
    const s = $('#card-status'), sub = $('#card-sub');
    if (r.code === 'NO_DEVICE') {
      s.textContent = 'Spotify nie odpowiada';
      sub.textContent = 'iPhone usypia Spotify w tle. Stuknij „Obudź Spotify”, a gdy się otworzy – wróć tutaj; utwór włączy się sam. '
        + 'Najpewniej działa granie na komputerze lub głośniku.';
      state.needsRetry = true; $('#card-actions').hidden = false;
    } else if (r.code === 'PREMIUM') {
      s.textContent = 'Potrzebne Spotify Premium'; sub.textContent = 'Sterowanie odtwarzaniem działa tylko na koncie Premium. Możesz użyć linku „Otwórz utwór w aplikacji Spotify”.';
    } else if (r.code === 'FORBIDDEN') {
      s.textContent = 'Spotify odmówiło dostępu'; sub.textContent = (r.message || '') + ' Sprawdź, czy konto jest na liście użytkowników aplikacji w panelu Spotify.';
    } else {
      s.textContent = 'Nie udało się odtworzyć'; sub.textContent = r.message || '';
      state.needsRetry = true; $('#card-actions').hidden = false;
    }
  }

  async function togglePause() {
    if (!state.current || !state.current.track) return;
    const q = { device_id: state.deviceId };
    if (!state.paused) {
      const r = await api('/me/player/pause', { method: 'PUT', query: q });
      if (r.ok) { state.paused = true; $('#btn-pause').textContent = '▶ Wznów'; $('#note-anim').classList.remove('playing'); }
      else toast('Nie udało się wstrzymać', true);
    } else {
      const r = await api('/me/player/play', { method: 'PUT', query: q });
      if (r.ok) { state.paused = false; $('#btn-pause').textContent = '⏸ Pauza'; $('#note-anim').classList.add('playing'); }
      else toast('Nie udało się wznowić', true);
    }
  }
  async function restart() {
    if (!state.current || !state.current.track) return;
    const r = await api('/me/player/seek', { method: 'PUT', query: { position_ms: 0, device_id: state.deviceId } });
    if (!r.ok) { toast('Nie udało się cofnąć utworu', true); return; }
    if (state.paused) await togglePause();
  }
  function reveal() {
    if (!state.current) return;
    const { card, track } = state.current;
    const box = $('#card-revealed');
    if (!box.hidden) { box.hidden = true; $('#card-hidden').hidden = false; $('#btn-reveal').textContent = '👁 Pokaż odpowiedź'; return; }
    box.style.background = colorFor(card.id);
    $('#rv-artist').textContent = card.artist; $('#rv-year').textContent = card.year; $('#rv-title').textContent = card.title;
    const sp = track && track.year;
    $('#rv-note').textContent = (sp && Math.abs(sp - card.year) >= 1) ? `Rok wydania albumu w Spotify: ${sp}` : '';
    box.hidden = false; $('#card-hidden').hidden = true; $('#btn-reveal').textContent = '🙈 Ukryj odpowiedź';
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !state.wakeLock) { state.wakeLock = await navigator.wakeLock.request('screen'); state.wakeLock.addEventListener('release', () => { state.wakeLock = null; }); } } catch { /* ignore */ }
  }

  // ---------- skaner ----------
  function parseCardId(text) {
    const m = String(text).toUpperCase().match(/([A-Z]{2,5}-\d{2,5})/);
    return m ? m[1] : null;
  }
  async function startScan() {
    show('scan'); $('#scan-hint').textContent = 'Wyceluj w kod QR na karcie';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Brak dostępu do kamery (wymagane HTTPS). Użyj wpisywania kodu.', true, 6000); show('home'); return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
    } catch (e) {
      toast('Nie mogę włączyć kamery: ' + (e.name === 'NotAllowedError' ? 'brak zgody' : e.message), true, 6000);
      show('home'); return;
    }
    const v = $('#video'); v.srcObject = state.stream; await v.play().catch(() => {});
    state.scanning = true; scanLoop();
  }
  function stopScan() {
    state.scanning = false;
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
    const v = $('#video'); if (v) v.srcObject = null;
  }
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
  function scanLoop() {
    if (!state.scanning) return;
    const v = $('#video');
    if (v.readyState >= 2 && v.videoWidth) {
      const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      scanCanvas.width = w; scanCanvas.height = h;
      scanCtx.drawImage(v, 0, 0, w, h);
      const img = scanCtx.getImageData(0, 0, w, h);
      const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code) {
        const id = parseCardId(code.data);
        if (id) { onCardCode(id); return; }
        $('#scan-hint').textContent = 'To nie jest kod karty Hitster';
      }
    }
    setTimeout(() => requestAnimationFrame(scanLoop), 70);
  }
  function onCardCode(id) {
    const now = Date.now();
    if (state.lastScan.id === id && now - state.lastScan.t < 1500) return;
    state.lastScan = { id, t: now };
    const card = state.songs.get(id);
    if (!card) { toast('Nieznana karta: ' + id, true); if (state.scanning) { setTimeout(() => requestAnimationFrame(scanLoop), 600); } return; }
    stopScan();
    if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(60);
    playCard(card);
  }

  // ---------- routing / init ----------
  function route() {
    const ru = REDIRECT_URI;
    $('#redirect-uri-setup').textContent = ru; $('#redirect-uri-settings').textContent = ru;
    if (!state.clientId) { show('setup'); return; }
    if (!state.tokens) { show('login'); return; }
    show('home'); loadDevices(true);
  }
  function openSettings() {
    $('#set-client-id').value = state.clientId; $('#set-start').value = state.startMode;
    $('#build-info').textContent = state.songs.size + ' kart w bazie';
    $('#dlg-settings').showModal();
  }

  async function init() {
    try {
      const list = await (await fetch('songs.json', { cache: 'no-cache' })).json();
      for (const s of list) state.songs.set(s.id, s);
    } catch { toast('Nie mogę wczytać songs.json', true, 6000); }

    $('#btn-settings').onclick = openSettings;
    $('#btn-save-client').onclick = () => {
      const v = $('#in-client-id').value.trim(); if (!/^[a-f0-9]{32}$/i.test(v)) { toast('Client ID ma 32 znaki (litery a-f i cyfry)', true); return; }
      state.clientId = v; LS.set('clientId', v); route();
    };
    $('#btn-copy-redirect').onclick = async () => { try { await navigator.clipboard.writeText(REDIRECT_URI); toast('Skopiowano'); } catch { toast('Zaznacz i skopiuj ręcznie', true); } };
    $('#btn-login').onclick = login;
    $('#btn-scan').onclick = startScan;
    $('#btn-scan-cancel').onclick = () => { stopScan(); route(); };
    $('#btn-code').onclick = () => { const id = parseCardId($('#in-code').value); if (!id) { toast('Wpisz kod w formacie HR-001', true); return; } onCardCode(id); $('#in-code').value = ''; };
    $('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-code').click(); });
    $('#btn-devices').onclick = () => loadDevices(false);
    $('#sel-device').onchange = e => { state.deviceId = e.target.value || null; LS.set('deviceId', state.deviceId); };
    $('#btn-pause').onclick = togglePause;
    $('#btn-restart').onclick = restart;
    $('#btn-reveal').onclick = reveal;
    $('#btn-retry').onclick = retryPlay;
    $('#btn-next').onclick = startScan;
    $('#btn-logout').onclick = () => { $('#dlg-settings').close(); logout(); };
    $('#btn-clearcache').onclick = () => { state.resolved = {}; LS.del('resolved'); toast('Wyczyszczono cache dopasowań'); };
    $('#btn-save-settings').onclick = () => {
      const cid = $('#set-client-id').value.trim();
      if (cid && cid !== state.clientId) { state.clientId = cid; LS.set('clientId', cid); state.tokens = null; LS.del('tokens'); }
      state.startMode = $('#set-start').value; LS.set('startMode', state.startMode);
    };
    $('#dlg-settings').addEventListener('close', () => { if (currentView !== 'card' && currentView !== 'scan') route(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopScan(); return; }
      if (currentView === 'scan') startScan();
      else if (currentView === 'card') {
        if (!state.wakeLock) keepAwake();
        if (state.needsRetry) setTimeout(retryPlay, 400);   // wróciliśmy z aplikacji Spotify
      }
    });

    await handleRedirect();
    route();
    // QR w wersji z adresem (--base-url): aparat iPhone'a otwiera aplikację z ?c=HR-001
    const direct = parseCardId(new URLSearchParams(location.search).get('c') || '');
    if (direct) { history.replaceState(null, '', REDIRECT_URI); if (state.tokens && state.clientId) onCardCode(direct); }
  }
  init();

  // do testów
  window.__hh = { parseCardId, norm, primaryArtist, state };
})();
