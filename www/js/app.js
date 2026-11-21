/* Incident Watch – Citizen Reporting App
 * Plain JavaScript, runs inside Cordova. Backend: WordPress REST API (each incident = one post).
 */
(function () {
  'use strict';

  var C = window.CONFIG;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  /* ---------- storage ---------- */
  var store = {
    get: function (k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var state = {
    user: store.get('cr_user', null),   // {id, username, name, app_password}
    cats: [],                           // [{id, name}]
    filter: 0,                          // category id, 0 = all
    page: 1, done: false, loading: false,
    posts: {},                          // id -> post (cache for detail view)
    view: 'feed', stack: [],
    photos: [],                         // [{blob, url}]
    loc: null,                          // {lat, lng, acc}
    reportCat: 0, authMode: 'login', unseen: 0, pollTimer: null
  };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function decode(html) { var t = document.createElement('textarea'); t.innerHTML = html || ''; return t.value; }
  function ago(iso) {
    var s = Math.max(1, (Date.now() - new Date(iso + (/Z|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z')).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 604800) return Math.floor(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString();
  }
  function hue(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  function tag(name) { return '<span class="tag" style="background:hsl(' + hue(name) + ' 62% 38%)">' + esc(name) + '</span>'; }

  var toastT;
  function toast(msg, isErr) {
    var t = $('#toast'); t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = ''; }, 3200);
  }

  /* ---------- API ---------- */
  function url(path) {
    var base = C.SITE_URL.replace(/\/$/, '');
    if (C.PRETTY_PERMALINKS) return base + '/wp-json' + path;
    var parts = path.split('?');
    return base + '/?rest_route=' + parts[0] + (parts[1] ? '&' + parts[1] : '');
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (state.user && !opts.anon) headers.Authorization = 'Basic ' + btoa(state.user.username + ':' + state.user.app_password);
    var body = opts.body;
    if (body && !opts.raw) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    return fetch(url(path), { method: opts.method || 'GET', headers: headers, body: body })
      .catch(function () { throw new Error('No connection. Check your internet and try again.'); })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (data) {
          if (!r.ok) {
            if (r.status === 401 && state.user && path.indexOf('citizen-reporter') === -1) {
              logout(); toast('Your session expired. Log in again.', true);
            }
            throw new Error((data && data.message) || ('Request failed (' + r.status + ')'));
          }
          return data;
        });
      });
  }

  /* ---------- navigation ---------- */
  var TITLES = { feed: 'Incident Watch', report: 'Report an incident', mine: 'My incidents', detail: 'Incident', auth: 'Account' };

  function show(view, push) {
    if (push) state.stack.push(state.view); else state.stack = [];
    state.view = view;
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'v-' + view); });
    $('#title').textContent = TITLES[view];
    $('#back').hidden = !push;
    var tabView = view === 'auth' ? state.authFrom : (view === 'detail' ? null : view);
    $$('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === tabView); });
    $('main').scrollTop = 0;
  }

  function go(view) {
    if ((view === 'report' || view === 'mine') && !state.user) {
      state.authFrom = view; setAuthMode('login'); show('auth'); return;
    }
    if (view === 'feed') { show('feed'); }
    if (view === 'report') { show('report'); locate(); }
    if (view === 'mine') { show('mine'); renderWho(); loadMine(); }
  }

  function back() {
    var prev = state.stack.pop() || 'feed';
    show(prev, false);
  }

  /* ---------- categories ---------- */
  function loadCats() {
    return api('/wp/v2/categories?per_page=50&hide_empty=false&_fields=id,name,slug', { anon: true }).then(function (c) {
      state.cats = c.filter(function (x) { return x.slug !== 'uncategorized'; });
      renderChips();
    }).catch(function (e) { toast(e.message, true); });
  }

  function renderChips() {
    var html = '<button class="chip' + (state.filter === 0 ? ' on' : '') + '" data-cat="0">All</button>';
    state.cats.forEach(function (c) {
      html += '<button class="chip' + (state.filter === c.id ? ' on' : '') + '" data-cat="' + c.id + '">' + esc(decode(c.name)) + '</button>';
    });
    $('#chips').innerHTML = html;

    var pick = '';
    state.cats.forEach(function (c) {
      pick += '<button type="button" class="chip' + (state.reportCat === c.id ? ' on' : '') + '" data-pick="' + c.id + '">' + esc(decode(c.name)) + '</button>';
    });
    $('#catPick').innerHTML = pick;
  }

  /* ---------- feed ---------- */
  function mediaUrl(p) {
    var m = p._embedded && p._embedded['wp:featuredmedia'] && p._embedded['wp:featuredmedia'][0];
    if (!m || !m.source_url) return '';
    var s = m.media_details && m.media_details.sizes;
    return (s && s.medium_large && s.medium_large.source_url) || m.source_url;
  }
  function catOf(p) {
    var terms = (p._embedded && p._embedded['wp:term'] && p._embedded['wp:term'][0]) || [];
    for (var i = 0; i < terms.length; i++) if (terms[i].taxonomy === 'category') return decode(terms[i].name);
    return 'Incident';
  }
  function plainText(html) {
    var d = new DOMParser().parseFromString(html || '', 'text/html');
    return $$('p', d).map(function (p) { return p.textContent; }).join('\n').trim();
  }
  function imagesOf(html) {
    var d = new DOMParser().parseFromString(html || '', 'text/html');
    return $$('img', d).map(function (i) { return i.getAttribute('src'); }).filter(function (s) { return /^https?:/.test(s); });
  }

  function cardHTML(p) {
    state.posts[p.id] = p;
    var img = mediaUrl(p), c = catOf(p), mine = state.user && p.author === state.user.id;
    return '<button class="card" data-id="' + p.id + '">' +
      (img ? '<div class="pic" style="background-image:url(\'' + esc(img) + '\')"></div>' : '') +
      '<div class="body">' + tag(c) +
      '<h3>' + esc(decode(p.title.rendered)) + '</h3>' +
      '<p>' + esc(plainText(p.content.rendered)) + '</p>' +
      '<div class="meta"><span>' + ago(p.date_gmt || p.date) + '</span>' +
      (p.meta && p.meta.cr_address ? '<span>' + esc(p.meta.cr_address) + '</span>' : '') +
      (p.status !== 'publish' ? '<span class="status">' + esc(p.status) + '</span>' : '') +
      '</div></div></button>';
  }

  function loadFeed(reset) {
    if (state.loading) return;
    if (reset) { state.page = 1; state.done = false; $('#list').innerHTML = ''; }
    if (state.done) return;
    state.loading = true;
    var q = '/wp/v2/posts?_embed=wp:featuredmedia,wp:term&per_page=' + C.PER_PAGE + '&page=' + state.page +
      (state.filter ? '&categories=' + state.filter : '');
    return api(q).then(function (list) {
      if (state.page === 1 && !list.length) {
        $('#list').innerHTML = '<div class="empty"><b>No incidents here yet</b>Be the first to report one.</div>';
      } else {
        $('#list').insertAdjacentHTML('beforeend', list.map(cardHTML).join(''));
      }
      state.done = list.length < C.PER_PAGE;
      state.page++;
      $('#more').hidden = state.done;
    }).catch(function (e) {
      if (/rest_post_invalid_page_number/.test(e.message) || /page number/i.test(e.message)) { state.done = true; $('#more').hidden = true; }
      else toast(e.message, true);
    }).then(function () { state.loading = false; });
  }

  function loadMine() {
    $('#mylist').innerHTML = '<div class="empty">Loading&hellip;</div>';
    api('/wp/v2/posts?_embed=wp:featuredmedia,wp:term&per_page=50&author=' + state.user.id + '&status=publish,pending,draft,private')
      .then(function (list) {
        $('#mylist').innerHTML = list.length ? list.map(cardHTML).join('') :
          '<div class="empty"><b>You have not reported anything</b>Incidents you post will appear here.</div>';
      }).catch(function (e) { $('#mylist').innerHTML = ''; toast(e.message, true); });
  }

  function renderWho() {
    $('#who').innerHTML = '<div><b>' + esc(state.user.name || state.user.username) + '</b><div class="hint" style="margin:0">@' + esc(state.user.username) + '</div></div>' +
      '<button class="ghost small" id="logout">Log out</button>';
  }

  /* ---------- detail ---------- */
  function openDetail(id) {
    var p = state.posts[id]; if (!p) return;
    var c = catOf(p), imgs = imagesOf(p.content.rendered);
    var lat = parseFloat(p.meta && p.meta.cr_latitude), lng = parseFloat(p.meta && p.meta.cr_longitude);
    var hasLoc = isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0);
    var html = '<div class="detail">' + tag(c) +
      '<h2>' + esc(decode(p.title.rendered)) + '</h2>' +
      '<div class="meta"><span>' + ago(p.date_gmt || p.date) + '</span>' +
      (p.status !== 'publish' ? '<span class="status">' + esc(p.status) + '</span>' : '') + '</div>' +
      '<div class="desc">' + esc(plainText(p.content.rendered)) + '</div>';
    if (imgs.length) html += '<div class="gallery">' + imgs.map(function (s) { return '<img loading="lazy" src="' + esc(s) + '" alt="Incident photo">'; }).join('') + '</div>';
    if (hasLoc) {
      var d = 0.005;
      html += '<div class="coords">' + (p.meta.cr_address ? esc(p.meta.cr_address) + '<br>' : '') +
        'Latitude ' + lat.toFixed(5) + ', Longitude ' + lng.toFixed(5) +
        ' &nbsp;<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '#map=17/' + lat + '/' + lng + '">Open map</a></div>' +
        '<iframe class="map" title="Incident location" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=' +
        (lng - d) + ',' + (lat - d * 0.6) + ',' + (lng + d) + ',' + (lat + d * 0.6) + '&layer=mapnik&marker=' + lat + ',' + lng + '"></iframe>';
    } else {
      html += '<div class="coords">No location was attached to this report.</div>';
    }
    $('#v-detail').innerHTML = html + '</div>';
    show('detail', true);
  }

  /* ---------- location ---------- */
  function setLoc(cls, text) {
    $('#locBox').className = 'locbox ' + cls; $('#locText').textContent = text;
  }
  function locate() {
    setLoc('', 'Locating you\u2026');
    if (!navigator.geolocation) { setLoc('bad', 'Location is not available on this device.'); return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      state.loc = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      setLoc('ok', 'Lat ' + state.loc.lat.toFixed(5) + ', Lng ' + state.loc.lng.toFixed(5) + ' (\u00B1' + Math.round(state.loc.acc) + ' m)');
    }, function (e) {
      state.loc = null;
      setLoc('bad', e.code === 1 ? 'Location permission denied. Allow it in Settings, then tap Update.' : 'Could not get your location. Tap Update to retry.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  /* ---------- photos ---------- */
  function shrink(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), u = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, 1280 / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(u);
        cv.toBlob(function (b) { b ? res(b) : rej(new Error('Could not process the photo.')); }, 'image/jpeg', 0.8);
      };
      img.onerror = function () { rej(new Error('That file is not a readable image.')); };
      img.src = u;
    });
  }

  function renderThumbs() {
    $('#thumbs').innerHTML = state.photos.map(function (p, i) {
      return '<div class="thumb" style="background-image:url(' + p.url + ')"><button type="button" data-rm="' + i + '" aria-label="Remove photo">&times;</button></div>';
    }).join('');
    $('#photoCount').textContent = state.photos.length + ' of ' + C.MAX_PHOTOS;
  }

  function addFiles(files) {
    var room = C.MAX_PHOTOS - state.photos.length;
    var picked = Array.prototype.slice.call(files, 0, Math.max(0, room));
    if (files.length > room) toast('You can attach up to ' + C.MAX_PHOTOS + ' photos.', true);
    picked.reduce(function (chain, f) {
      return chain.then(function () {
        return shrink(f).then(function (b) { state.photos.push({ blob: b, url: URL.createObjectURL(b) }); renderThumbs(); });
      });
    }, Promise.resolve()).catch(function (e) { toast(e.message, true); });
  }

  /* ---------- submit incident ---------- */
  function setProgress(pct) {
    var bar = $('#progress'); bar.hidden = pct === null;
    if (pct !== null) $('div', bar).style.width = pct + '%';
  }

  function submitIncident() {
    var title = $('#rTitle').value.trim(), desc = $('#rDesc').value.trim(), addr = $('#rAddr').value.trim();
    if (!state.reportCat) return toast('Pick what happened.', true);
    if (title.length < 4) return toast('Add a short headline.', true);
    if (desc.length < 10) return toast('Describe what is happening.', true);
    if (!state.loc) return toast('Location is needed. Tap Update location.', true);

    var btn = $('#submit'); btn.disabled = true; btn.textContent = 'Posting\u2026';
    var total = state.photos.length + 1, done = 0, ids = [], urls = [];
    setProgress(0);

    state.photos.reduce(function (chain, ph, i) {
      return chain.then(function () {
        return api('/wp/v2/media', {
          method: 'POST', raw: true, body: ph.blob,
          headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="incident-' + Date.now() + '-' + i + '.jpg"' }
        }).then(function (m) { ids.push(m.id); urls.push(m.source_url); setProgress(++done / total * 100); });
      });
    }, Promise.resolve()).then(function () {
      var content = '<p>' + esc(desc).replace(/\n/g, '<br>') + '</p>' +
        urls.map(function (u) { return '<img src="' + esc(u) + '" alt="Incident photo">'; }).join('');
      var post = {
        title: title, content: content, status: 'publish', categories: [state.reportCat],
        meta: { cr_latitude: state.loc.lat, cr_longitude: state.loc.lng, cr_address: addr }
      };
      if (ids.length) post.featured_media = ids[0];
      return api('/wp/v2/posts', { method: 'POST', body: post });
    }).then(function (p) {
      setProgress(100);
      store.set('cr_last', Math.max(store.get('cr_last', 0), p.id)); // don't notify myself
      resetReport();
      toast('Incident posted. Others can see it now.');
      state.filter = 0; renderChips(); go('feed'); loadFeed(true);
    }).catch(function (e) {
      toast(e.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Post incident'; setTimeout(function () { setProgress(null); }, 600);
    });
  }

  function resetReport() {
    $('#rTitle').value = ''; $('#rDesc').value = ''; $('#rAddr').value = '';
    state.photos.forEach(function (p) { URL.revokeObjectURL(p.url); });
    state.photos = []; state.reportCat = 0; renderThumbs(); renderChips();
  }

  /* ---------- auth ---------- */
  function setAuthMode(mode) {
    state.authMode = mode;
    var reg = mode === 'register';
    $('#tabLogin').classList.toggle('on', !reg); $('#tabReg').classList.toggle('on', reg);
    $('#emailRow').hidden = !reg;
    $('#aEmail').required = reg;
    $('#authBtn').textContent = reg ? 'Create account' : 'Log in';
    $('#aPass').autocomplete = reg ? 'new-password' : 'current-password';
    $('#authLede').textContent = reg ? 'Create an account to report incidents and track your reports.' : 'Log in to report incidents and see the ones you have posted.';
  }

  function submitAuth(ev) {
    ev.preventDefault();
    var reg = state.authMode === 'register', btn = $('#authBtn');
    var payload = { username: $('#aUser').value.trim(), password: $('#aPass').value };
    if (reg) payload.email = $('#aEmail').value.trim();
    btn.disabled = true;
    api('/citizen-reporter/v1/' + (reg ? 'register' : 'login'), { method: 'POST', body: payload, anon: true })
      .then(function (u) {
        state.user = u; store.set('cr_user', u);
        $('#aPass').value = '';
        toast('Welcome, ' + (u.name || u.username) + '.');
        var dest = state.authFrom || 'mine'; state.authFrom = null;
        go(dest); loadFeed(true);
      }).catch(function (e) { toast(e.message, true); })
      .then(function () { btn.disabled = false; });
  }

  function logout() {
    state.user = null; store.del('cr_user'); $('#mylist').innerHTML = '';
    go('feed'); loadFeed(true);
  }

  /* ---------- notifications (poll for new incidents) ---------- */
  function setBadge(n) {
    state.unseen = n; var b = $('#badge'); b.hidden = n === 0; b.textContent = n > 9 ? '9+' : n;
  }

  function notify(fresh) {
    var first = decode(fresh[0].title.rendered);
    var text = fresh.length === 1 ? first : first + ' and ' + (fresh.length - 1) + ' more';
    var L = window.cordova && cordova.plugins && cordova.plugins.notification && cordova.plugins.notification.local;
    if (L) L.schedule({ id: Date.now() % 1000000, title: 'New incident reported', text: text, foreground: true });
    toast('New incident: ' + text);
    setBadge(state.unseen + fresh.length);
    if (state.view === 'feed') loadFeed(true);
  }

  function poll() {
    api('/wp/v2/posts?per_page=5&_fields=id,title,author', { anon: true }).then(function (l) {
      var last = store.get('cr_last', 0);
      var newest = l.reduce(function (m, x) { return Math.max(m, x.id); }, 0);
      if (!last) { store.set('cr_last', newest); return; }
      var fresh = l.filter(function (x) { return x.id > last && !(state.user && x.author === state.user.id); });
      if (newest > last) store.set('cr_last', newest);
      if (fresh.length) notify(fresh);
    }).catch(function () { /* stay quiet while offline */ });
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, C.POLL_SECONDS * 1000);
    poll();
    var L = window.cordova && cordova.plugins && cordova.plugins.notification && cordova.plugins.notification.local;
    if (L && L.requestPermission) L.requestPermission(function () {});
  }

  /* ---------- events ---------- */
  function bind() {
    $('.tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (b) go(b.dataset.go);
    });
    $('#back').addEventListener('click', back);
    $('#refresh').addEventListener('click', function () {
      setBadge(0);
      if (state.view === 'mine') loadMine(); else { go('feed'); loadFeed(true); }
    });
    $('#chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cat]'); if (!b) return;
      state.filter = parseInt(b.dataset.cat, 10); renderChips(); loadFeed(true);
    });
    $('#catPick').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]'); if (!b) return;
      state.reportCat = parseInt(b.dataset.pick, 10); renderChips();
    });
    ['list', 'mylist'].forEach(function (id) {
      $('#' + id).addEventListener('click', function (e) {
        var c = e.target.closest('.card'); if (c) openDetail(c.dataset.id);
      });
    });
    $('#more').addEventListener('click', function () { loadFeed(false); });
    $('#relocate').addEventListener('click', locate);
    $('#rFile').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    $('#thumbs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-rm]'); if (!b) return;
      var gone = state.photos.splice(parseInt(b.dataset.rm, 10), 1)[0]; URL.revokeObjectURL(gone.url); renderThumbs();
    });
    $('#submit').addEventListener('click', submitIncident);
    $('#authForm').addEventListener('submit', submitAuth);
    $('#tabLogin').addEventListener('click', function () { setAuthMode('login'); });
    $('#tabReg').addEventListener('click', function () { setAuthMode('register'); });
    $('#v-mine').addEventListener('click', function (e) { if (e.target.id === 'logout') logout(); });
    document.addEventListener('resume', poll, false);
    $('main').addEventListener('scroll', function () {
      var m = $('main');
      if (state.view === 'feed' && !state.done && m.scrollTop + m.clientHeight > m.scrollHeight - 300) loadFeed(false);
    });
  }

  /* ---------- boot ---------- */
  function start() {
    bind(); renderThumbs(); show('feed');
    loadCats().then(function () { return loadFeed(true); });
    startPolling();
  }

  if (window.cordova) document.addEventListener('deviceready', start, false);
  else document.addEventListener('DOMContentLoaded', start, false); // browser preview
})();
