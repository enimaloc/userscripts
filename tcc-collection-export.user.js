// ==UserScript==
// @name         TCC – Export de l'album en image
// @namespace    tcc-collection-export
// @version      1.0.0
// @description  Ajoute un bouton sur la page collection de TCC (Twitch Collectible Cards) pour exporter toutes les cartes de l'album, rangées par catégorie, dans une seule image.
// @match        https://tcc.too-pixel.com/*
// @icon         https://tcc.too-pixel.com/favicon.ico
// @homepageURL  https://github.com/enimaloc/userscripts
// @supportURL   https://github.com/enimaloc/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/enimaloc/userscripts/master/tcc-collection-export.user.js
// @downloadURL  https://raw.githubusercontent.com/enimaloc/userscripts/master/tcc-collection-export.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      tcc-api.too-pixel.com
// @connect      tcc.too-pixel.com
// @connect      static-cdn.jtvnw.net
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Pourquoi passer par l'API plutôt que par une capture de la page :
 * la page collection utilise un défilement virtuel (seules les lignes visibles
 * existent dans le DOM), donc une capture du DOM ne contiendrait jamais tout
 * l'album. Le script relit les mêmes données que la page (mêmes appels API,
 * même jeton de session) et redessine l'album complet dans un canvas.
 *
 * Le @match couvre tout le site car c'est une application monopage : on peut
 * arriver sur /collection/... sans rechargement. Le bouton n'apparaît que sur
 * /collection/<streamer> et /collectionAs/<viewer>/<streamer>.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- constantes

  const API = 'https://tcc-api.too-pixel.com/api';
  const SITE = 'https://tcc.too-pixel.com';

  // Dimensions de référence d'une carte sur le site (750 × 1050, marge 25).
  const CARD_W = 750;
  const CARD_H = 1050;
  const CARD_PAD = 25;
  const RECT_PAD = 20;

  const TITLE_FONT = '"Chinese Rocks RG", Impact, "Arial Narrow", sans-serif';
  const SUB_FONT = '"Kids Magazine", "Trebuchet MS", sans-serif';

  const RARITY_COLORS = { 1: '#9E9E9E', 2: '#4CAF50', 3: '#2196F3', 4: '#9C27B0', 5: '#FF9800' };

  const THEMES = {
    dark: {
      base: [71, 42, 79], // violet sombre de la capture de référence
      header: [48, 28, 54],
      locked: 'rgba(108, 67, 0, 0.43)',
    },
    light: {
      base: [219, 209, 216], // crème du site posé sur son dégradé bleu-violet
      header: [58, 52, 78],
      locked: 'rgba(255, 220, 162, 0.43)',
    },
  };

  const TYPE_LABELS = { creator: 'Cartes créateur', generated: 'Cartes générées', follower: 'Cartes followers' };

  const DEFAULTS = {
    creators: true,
    generated: false,
    followers: false,
    columns: 25,
    cardWidth: 120,
    theme: 'dark',
    format: 'png',
    showMissing: true,
    glitched: true,
    counts: true,
    header: true,
  };

  // Limites de sécurité des canvas (Chrome : 16 384 px de côté).
  const MAX_SIDE = 16000;
  const MAX_AREA = 100e6;
  const IMAGE_CONCURRENCY = 6;

  // ------------------------------------------------------------------ réglages

  const SETTINGS_KEY = 'tcc-export-settings';

  function loadSettings() {
    let saved = null;
    try {
      const raw = typeof GM_getValue === 'function' ? GM_getValue(SETTINGS_KEY, null) : localStorage.getItem(SETTINGS_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch (e) { /* réglages illisibles : on repart des valeurs par défaut */ }
    return Object.assign({}, DEFAULTS, saved || {});
  }

  function saveSettings(settings) {
    try {
      const raw = JSON.stringify(settings);
      if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_KEY, raw);
      else localStorage.setItem(SETTINGS_KEY, raw);
    } catch (e) { /* tant pis, ce n'est que du confort */ }
  }

  // -------------------------------------------------------------------- réseau

  const gmXhr =
    typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest.bind(GM) : null);

  class HttpError extends Error {
    constructor(status, url) {
      super('HTTP ' + status + ' sur ' + url);
      this.status = status;
    }
  }

  /** GET via le gestionnaire de scripts (pas de contrainte CORS), sinon via fetch. */
  function request(url, { responseType = 'json', headers = {}, timeout = 45000 } = {}) {
    if (!gmXhr) {
      return fetch(url, { headers }).then((r) => {
        if (!r.ok) throw new HttpError(r.status, url);
        return responseType === 'blob' ? r.blob() : r.json();
      });
    }
    return new Promise((resolve, reject) => {
      gmXhr({
        method: 'GET',
        url,
        headers,
        timeout,
        responseType: responseType === 'blob' ? 'blob' : 'text',
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) return reject(new HttpError(r.status, url));
          if (responseType === 'blob') return resolve(r.response);
          try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('Réponse illisible pour ' + url)); }
        },
        onerror: () => reject(new Error('Requête impossible : ' + url)),
        ontimeout: () => reject(new Error('Délai dépassé : ' + url)),
      });
    });
  }

  function getToken() {
    const m = document.cookie.match(/(?:^|;\s*)jwt_token=([^;]*)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  function decodeJwt(token) {
    try {
      let b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const bin = atob(b64);
      const json = decodeURIComponent(Array.from(bin, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function api(path) {
    const token = getToken();
    return request(API + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  }

  // --------------------------------------------------------------------- route

  function parseRoute() {
    const path = location.pathname;
    let m = path.match(/^\/collectionAs\/([^/]+)\/([^/]+)\/?$/);
    if (m) return { user: decodeURIComponent(m[1]), streamer: decodeURIComponent(m[2]) };
    m = path.match(/^\/collection\/([^/]+)\/?$/);
    if (m) return { user: null, streamer: decodeURIComponent(m[1]) };
    return null;
  }

  // ------------------------------------------------------------------- données

  async function loadAlbumData(route, opts) {
    if (!getToken()) throw new Error('Session introuvable : connecte-toi sur TCC puis réessaie.');

    let user = route.user;
    if (!user) {
      const payload = decodeJwt(getToken());
      user = payload && payload.twitch_user_login;
      if (!user) user = (await api('/users/currentUser')).twitch_user_login;
    }

    const s = encodeURIComponent(route.streamer);
    const appConfig = await api('/' + s + '/app-config');

    const wantCreators = opts.creators && appConfig.album_display_creator !== false;
    const wantGenerated = opts.generated && appConfig.album_display_generated !== false;
    const wantFollowers = opts.followers && appConfig.album_display_followers !== false;

    const [creators, generated, followers, collection] = await Promise.all([
      wantCreators ? api('/' + s + '/creator-cards/processed/categorised') : null,
      wantGenerated ? api('/' + s + '/cards/processed') : null,
      wantFollowers ? api('/' + s + '/followerCards/processed') : null,
      api('/' + s + '/cardCollection/' + encodeURIComponent(user)),
    ]);

    return { user, streamer: route.streamer, appConfig, creators, generated, followers, collection: collection || {} };
  }

  function refNumber(reference) {
    const parts = String(reference || '').split('-');
    return parts[1] ? parseInt(parts[1], 10) || 0 : 0;
  }

  const specialKey = (special) => (special ? String(special) : '');

  /**
   * Transforme les données de l'API en sections prêtes à dessiner, avec les
   * mêmes règles que la page : tri par référence, variante « glitched » insérée
   * juste après la carte normale quand elle est possédée.
   */
  function buildSections(data, opts) {
    const owned = new Map();
    for (const c of data.collection.cards || []) {
      const key = c.type + '|' + c.card_id + '|' + specialKey(c.special);
      owned.set(key, (owned.get(key) || 0) + 1);
    }
    const kindOf = { generated: 'Card', creator: 'CreatorCard', follower: 'FollowerCard' };
    const favorites = new Set((data.collection.favorites || []).map((f) => f.kind + '|' + f.item + '|' + specialKey(f.special)));

    const stats = { total: 0, owned: 0 };

    function expand(cards, type) {
      const sorted = (cards || []).slice().sort((a, b) => refNumber(a.reference) - refNumber(b.reference));
      const items = [];
      let sectionOwned = 0;
      for (const bean of sorted) {
        const cardType = bean.type || type;
        const count = owned.get(cardType + '|' + bean.card_id + '|') || 0;
        stats.total++;
        if (count > 0) { stats.owned++; sectionOwned++; }
        if (count > 0 || opts.showMissing) {
          items.push({
            bean, type: cardType, special: '', locked: count === 0, count,
            favorite: favorites.has(kindOf[cardType] + '|' + bean.card_id + '|'),
          });
        }
        const glitchedCount = owned.get(cardType + '|' + bean.card_id + '|glitched') || 0;
        if (opts.glitched && glitchedCount > 0) {
          items.push({
            bean, type: cardType, special: 'glitched', locked: false, count: glitchedCount,
            favorite: favorites.has(kindOf[cardType] + '|' + bean.card_id + '|glitched'),
          });
        }
      }
      return { items, owned: sectionOwned, total: sorted.length };
    }

    const sections = [];
    const typesShown = [data.creators, data.generated, data.followers].filter(Boolean).length;

    if (data.creators) {
      const entries = Object.entries(data.creators);
      const categories = data.appConfig.categories || [];
      for (const [categoryId, cards] of entries) {
        const category = categories.find((c) => c._id === categoryId);
        let title;
        if (categoryId === 'null') title = entries.length === 1 ? (typesShown > 1 ? TYPE_LABELS.creator : null) : 'Sans catégorie';
        else title = (category && category.category_name) || categoryId;
        sections.push(Object.assign(expand(cards, 'creator'), { title, color: (category && category.color) || null }));
      }
    }
    if (data.generated) {
      sections.push(Object.assign(expand(data.generated, 'generated'), { title: typesShown > 1 ? TYPE_LABELS.generated : null, color: null }));
    }
    if (data.followers) {
      sections.push(Object.assign(expand(data.followers, 'follower'), { title: typesShown > 1 ? TYPE_LABELS.follower : null, color: null }));
    }

    return { sections: sections.filter((s) => s.items.length > 0), stats };
  }

  // -------------------------------------------------------------------- images

  function imageUrlFor(item) {
    const bean = item.bean;
    if (item.locked) return null;
    if (item.type === 'follower') return bean.img_url ? bean.img_url.replace('300x300', '600x600') : null;
    if (usesAltImage(item)) return bean.special_img_url;
    return bean.img_url || null;
  }

  const usesAltImage = (item) => item.type === 'creator' && item.special === 'glitched' && !!item.bean.special_img_url;

  function imageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
      img.src = url;
    });
  }

  /**
   * Charge une image sous forme de blob (donc « même origine ») pour que le
   * canvas reste exportable même si le serveur d'images n'envoie pas d'en-têtes CORS.
   */
  async function loadImage(url) {
    const abs = new URL(url, SITE + '/').href;
    let blob;
    if (/^(data|blob):/.test(abs)) {
      blob = await (await fetch(abs)).blob();
    } else {
      try {
        blob = await request(abs, { responseType: 'blob' });
      } catch (e) {
        blob = await (await fetch(abs, { mode: 'cors' })).blob();
      }
    }
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob); } catch (e) { /* format non géré : on tente <img> */ }
    }
    return imageFromBlob(blob);
  }

  function releaseImage(img) {
    if (img && typeof img.close === 'function') img.close();
  }

  // ------------------------------------------------------------------ couleurs

  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  /** Couleur CSS quelconque (avec alpha éventuel) posée sur un fond opaque → [r, g, b]. */
  function compositeOver(cssColor, base) {
    probeCtx.globalCompositeOperation = 'source-over';
    probeCtx.fillStyle = rgb(base);
    probeCtx.fillRect(0, 0, 1, 1);
    if (cssColor) {
      const sentinel = '#010203';
      probeCtx.fillStyle = sentinel;
      probeCtx.fillStyle = cssColor; // une valeur CSS invalide est ignorée par le canvas
      if (probeCtx.fillStyle !== sentinel) probeCtx.fillRect(0, 0, 1, 1);
    }
    const d = probeCtx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  const rgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';

  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb([h, s, l]) {
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
  }

  /** Garde la teinte d'une couleur de catégorie mais la ramène dans des tons sombres. */
  function darken(color) {
    const [h, s, l] = rgbToHsl(color);
    const l2 = l > 0.3 ? 0.26 - 0.14 * ((l - 0.3) / 0.7) : Math.max(l, 0.1);
    return hslToRgb([h, Math.min(s, 0.75) * 0.9, l2]);
  }

  function luminance([r, g, b]) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  const textColorOn = (bg) => (luminance(bg) > 0.3 ? 'rgba(0, 0, 0, 0.87)' : '#e8e6e3');

  // -------------------------------------------------------------- dessin carte

  function wrapText(g, text, maxWidth) {
    const words = String(text == null ? '' : text).trim().split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (!current || g.measureText(candidate).width <= maxWidth) current = candidate;
      else { lines.push(current); current = word; }
    }
    lines.push(current);
    return lines;
  }

  /** Équivalent de object-fit: cover. */
  function drawCover(g, img, dx, dy, dw, dh) {
    const iw = img.width, ih = img.height;
    if (!iw || !ih) return;
    const scale = Math.max(dw / iw, dh / ih);
    const sw = dw / scale, sh = dh / scale;
    g.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, dx, dy, dw, dh);
  }

  function roundedRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawStar(g, cx, cy, radius) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? radius : radius * 0.45;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      g.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    g.closePath();
    g.fillStyle = '#ffeb3b';
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.lineWidth = 5;
    g.stroke();
    g.fill();
  }

  function followTimeText(followDate) {
    const d = new Date(followDate);
    if (isNaN(d)) return '';
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
    if (now.getDate() < d.getDate()) months--;
    const pad = (n) => String(n).padStart(2, '0');
    return 'Follow : ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' (' + Math.max(0, months) + ' mois)';
  }

  /**
   * Dessine une carte dans le repère de référence 750 × 1050 (le contexte est
   * déjà mis à l'échelle), en reprenant la mise en page des composants du site.
   */
  function drawCard(g, item, img, env) {
    const bean = item.bean;
    g.clearRect(0, 0, CARD_W, CARD_H);

    if (item.locked) {
      g.fillStyle = env.theme.locked;
      g.fillRect(0, 0, CARD_W, CARD_H);
      g.fillStyle = env.sectionText;
      g.font = '128px ' + TITLE_FONT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(bean.reference || '?'), CARD_W / 2, CARD_H / 2, CARD_W - 40);
      return;
    }

    if (item.type === 'follower') {
      if (bean.is_sub && env.subBack) drawCover(g, env.subBack, 0, 0, CARD_W, CARD_H);
      else {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, CARD_W, CARD_H);
        if (bean.background_color && !bean.is_sub) {
          g.fillStyle = bean.background_color;
          g.fillRect(0, 0, CARD_W, CARD_H);
        }
      }
      const size = CARD_W - 2 * CARD_PAD;
      if (img) drawCover(g, img, CARD_PAD, CARD_PAD, size, size);
      else { g.fillStyle = '#555'; g.fillRect(CARD_PAD, CARD_PAD, size, size); }

      const rectTop = size + 2 * CARD_PAD;
      const rectHeight = CARD_H - rectTop - CARD_PAD - 15;
      g.fillStyle = 'rgba(0, 0, 0, 0.5)';
      g.fillRect(CARD_PAD, rectTop, size, rectHeight);

      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '60px ' + TITLE_FONT;
      g.fillText(String(bean.name || ''), CARD_W / 2, rectTop + 15 + 30, size - 2 * RECT_PAD);
      g.font = '50px ' + TITLE_FONT;
      g.fillText(followTimeText(bean.follow_date), CARD_W / 2, rectTop + 120 + 25, size - 2 * RECT_PAD);
      g.font = '20px ' + SUB_FONT;
      g.textAlign = 'right';
      g.textBaseline = 'bottom';
      g.fillText(String(bean.reference || ''), CARD_W - CARD_PAD - (CARD_PAD + 5), rectTop + rectHeight - RECT_PAD);
    } else {
      if (img) drawCover(g, img, 0, 0, CARD_W, CARD_H);
      else { g.fillStyle = '#555'; g.fillRect(0, 0, CARD_W, CARD_H); }

      g.font = '50px ' + TITLE_FONT;
      const lines = wrapText(g, bean.name, CARD_W - 2 * CARD_PAD - 2 * RECT_PAD);
      const nameHeight = lines.length * 50;
      const rectHeight = nameHeight + 2 * RECT_PAD + 14;
      const rectTop = CARD_H - CARD_PAD - rectHeight;
      g.fillStyle = 'rgba(0, 0, 0, 0.5)';
      g.fillRect(CARD_PAD, rectTop, CARD_W - 2 * CARD_PAD, rectHeight);

      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      lines.forEach((line, i) => g.fillText(line, CARD_W / 2, rectTop + 5 + 25 + i * 50, CARD_W - 2 * CARD_PAD - 10));

      g.font = '14px ' + SUB_FONT;
      g.textBaseline = 'bottom';
      const subY = rectTop + rectHeight - RECT_PAD;
      const createdBy = ((bean.lang === 'en' ? 'Created by' : 'Créée par') + ' ' + (bean.created_by || '')).toLocaleUpperCase();
      g.textAlign = 'left';
      g.fillText(createdBy, CARD_PAD + CARD_PAD - 5, subY);
      g.textAlign = 'right';
      g.fillText(String(bean.reference || ''), CARD_W - CARD_PAD - (CARD_PAD + 5), subY);

      if (env.rarityBadges && item.type === 'creator' && bean.rarity > 1) {
        g.fillStyle = RARITY_COLORS[bean.rarity] || RARITY_COLORS[1];
        roundedRect(g, CARD_W - 26, CARD_H - 26, 22, 22, 11);
        g.fill();
      }
    }

    if (item.favorite) drawStar(g, CARD_W * 0.85 + 34, CARD_H * 0.03 + 34, 40);
  }

  function hashString(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function seededRandom(seed) {
    let a = seed;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Version figée de l'effet « glitch » du site : tranches décalées avec rotation de teinte. */
  function drawGlitchSlices(ctx, cardCanvas, x, y, w, h, seed) {
    const random = seededRandom(hashString(seed));
    const canFilter = typeof ctx.filter === 'string';
    for (let i = 0; i < 8; i++) {
      const sliceHeight = Math.max(1, Math.round(h * (0.05 + random() * 0.05)));
      const sliceY = Math.floor(random() * (h - sliceHeight));
      const shift = Math.round((random() * 2 - 1) * w * 0.05);
      if (canFilter) ctx.filter = 'hue-rotate(' + Math.round(random() * 360) + 'deg)';
      ctx.drawImage(cardCanvas, 0, sliceY, w, sliceHeight, x + shift, y + sliceY, w, sliceHeight);
    }
    if (canFilter) ctx.filter = 'none';
  }

  // -------------------------------------------------------------- dessin album

  function computeLayout(sections, opts, cardWidth) {
    const longest = Math.max.apply(null, sections.map((s) => s.items.length));
    const cols = Math.max(1, Math.min(opts.columns, longest));
    const cw = cardWidth;
    const ch = Math.round((cw * CARD_H) / CARD_W);
    const gap = Math.max(4, Math.round(cw * 0.12));
    const label = opts.counts ? Math.round(cw * 0.2) : 0;
    const titleFont = Math.max(14, Math.round(cw * 0.22));
    const titleHeight = Math.round(titleFont * 1.6);
    const headerHeight = opts.header ? Math.max(44, Math.round(cw * 0.5)) : 0;
    const width = Math.max(gap * 2 + cols * cw + (cols - 1) * gap, opts.header ? 520 : 0);

    let y = headerHeight;
    const boxes = sections.map((section) => {
      const rows = Math.ceil(section.items.length / cols);
      const top = y;
      const cardsTop = top + gap + (section.title ? titleHeight : 0);
      y = cardsTop + rows * (ch + label + gap);
      return { top, cardsTop, height: y - top };
    });
    return { cols, cw, ch, gap, label, titleFont, titleHeight, headerHeight, width, height: y, boxes };
  }

  function fitLayout(sections, opts) {
    let cardWidth = opts.cardWidth;
    let layout = computeLayout(sections, opts, cardWidth);
    while ((layout.width > MAX_SIDE || layout.height > MAX_SIDE || layout.width * layout.height > MAX_AREA) && cardWidth > 24) {
      cardWidth = Math.max(24, Math.floor(cardWidth * 0.9));
      layout = computeLayout(sections, opts, cardWidth);
    }
    layout.shrunk = cardWidth !== opts.cardWidth;
    return layout;
  }

  async function runPool(items, size, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    });
    await Promise.all(runners);
  }

  async function renderAlbum(data, opts, onProgress, isCancelled) {
    const { sections, stats } = buildSections(data, opts);
    if (!sections.length) throw new Error('Aucune carte à exporter avec ces réglages.');

    if (document.fonts && document.fonts.load) {
      await Promise.all([
        document.fonts.load('50px "Chinese Rocks RG"'),
        document.fonts.load('14px "Kids Magazine"'),
      ]).catch(() => {});
    }

    const theme = THEMES[opts.theme] || THEMES.dark;
    const L = fitLayout(sections, opts);

    const canvas = document.createElement('canvas');
    canvas.width = L.width;
    canvas.height = L.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image trop grande pour ce navigateur : réduis la largeur des cartes.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Fond général.
    ctx.fillStyle = rgb(theme.base);
    ctx.fillRect(0, 0, L.width, L.height);
    if (opts.theme === 'light') {
      const gradient = ctx.createLinearGradient(0, 0, L.width, 0);
      gradient.addColorStop(0, '#8782e2');
      gradient.addColorStop(0.5, '#afafff');
      gradient.addColorStop(1, '#007dff');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, L.width, L.height);
      ctx.fillStyle = 'rgba(255, 236, 184, 0.55)';
      ctx.fillRect(0, 0, L.width, L.height);
    }

    // En-tête.
    if (opts.header) {
      ctx.fillStyle = rgb(theme.header);
      ctx.fillRect(0, 0, L.width, L.headerHeight);
      const size = Math.round(L.headerHeight * 0.46);
      ctx.fillStyle = '#f2efe9';
      ctx.textBaseline = 'middle';
      ctx.font = size + 'px ' + TITLE_FONT;
      ctx.textAlign = 'left';
      const percent = stats.total ? Math.round((stats.owned / stats.total) * 100) : 0;
      const right = stats.owned + ' / ' + stats.total + ' cartes (' + percent + ' %)  ·  ' + new Date().toLocaleDateString('fr-FR');
      ctx.textAlign = 'right';
      ctx.fillText(right, L.width - L.gap, L.headerHeight / 2);
      const rightWidth = ctx.measureText(right).width;
      ctx.textAlign = 'left';
      ctx.fillText('Album de ' + data.user + ' — chaîne de ' + data.streamer, L.gap, L.headerHeight / 2, L.width - rightWidth - L.gap * 4);
    }

    // Bandeaux de catégorie.
    const sectionText = sections.map((section, i) => {
      const box = L.boxes[i];
      let background = theme.base;
      if (section.color) {
        background = compositeOver(section.color, THEMES.light.base);
        if (opts.theme === 'dark') {
          background = darken(background);
          ctx.fillStyle = rgb(background);
        } else {
          ctx.fillStyle = section.color;
        }
        ctx.fillRect(0, box.top, L.width, box.height);
      }
      const color = textColorOn(background);
      if (section.title) {
        ctx.fillStyle = color;
        ctx.font = L.titleFont + 'px ' + TITLE_FONT;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        const titleY = box.top + L.gap * 0.6 + L.titleHeight / 2;
        ctx.fillText(section.title, L.width / 2, titleY, L.width * 0.7);
        const titleWidth = Math.min(ctx.measureText(section.title).width, L.width * 0.7);
        ctx.globalAlpha = 0.6;
        ctx.font = Math.round(L.titleFont * 0.6) + 'px ' + TITLE_FONT;
        ctx.textAlign = 'left';
        ctx.fillText(section.owned + ' / ' + section.total, L.width / 2 + titleWidth / 2 + L.titleFont * 0.6, titleY);
        ctx.globalAlpha = 1;
      }
      return color;
    });

    // Canvas de travail réutilisé pour chaque carte.
    const cardCanvas = document.createElement('canvas');
    cardCanvas.width = L.cw;
    cardCanvas.height = L.ch;
    const g = cardCanvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    const env = { theme, sectionText: '#fff', subBack: null, rarityBadges: data.appConfig.display_rarity_badges !== false };

    // Placements regroupés par image pour ne télécharger chaque fichier qu'une fois.
    const direct = [];
    const byUrl = new Map();
    let needsSubBack = false;
    sections.forEach((section, si) => {
      section.items.forEach((item, index) => {
        const placement = {
          item,
          text: sectionText[si],
          x: L.gap + (index % L.cols) * (L.cw + L.gap),
          y: L.boxes[si].cardsTop + Math.floor(index / L.cols) * (L.ch + L.label + L.gap),
        };
        if (item.type === 'follower' && item.bean.is_sub && !item.locked) needsSubBack = true;
        const url = imageUrlFor(item);
        if (!url) direct.push(placement);
        else if (byUrl.has(url)) byUrl.get(url).push(placement);
        else byUrl.set(url, [placement]);
      });
    });

    if (needsSubBack) {
      env.subBack = await loadImage(SITE + '/assets/images/sub-card-back.png').catch(() => null);
    }

    function paint(placement, img) {
      const { item, x, y } = placement;
      env.sectionText = placement.text;
      g.setTransform(L.cw / CARD_W, 0, 0, L.ch / CARD_H, 0, 0);
      drawCard(g, item, img, env);
      ctx.drawImage(cardCanvas, x, y);
      if (item.special === 'glitched' && !usesAltImage(item)) {
        drawGlitchSlices(ctx, cardCanvas, x, y, L.cw, L.ch, item.bean.card_id + '|' + item.bean.reference);
      }
      if (opts.counts && item.count > 1) {
        ctx.fillStyle = placement.text;
        ctx.font = Math.round(L.label * 0.78) + 'px ' + TITLE_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('X ' + item.count, x + L.cw / 2, y + L.ch + L.label * 0.55);
      }
    }

    const total = direct.length + Array.from(byUrl.values()).reduce((n, list) => n + list.length, 0);
    let done = 0;
    let failed = 0;

    for (const placement of direct) { paint(placement, null); done++; }
    onProgress(done, total);

    await runPool(Array.from(byUrl.entries()), IMAGE_CONCURRENCY, async ([url, placements]) => {
      if (isCancelled()) return;
      let img = null;
      try { img = await loadImage(url); } catch (e) { failed += placements.length; }
      if (isCancelled()) { releaseImage(img); return; }
      for (const placement of placements) paint(placement, img);
      releaseImage(img);
      done += placements.length;
      onProgress(done, total);
    });
    releaseImage(env.subBack);
    if (isCancelled()) return null;

    const mime = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
    if (!blob) throw new Error("Le navigateur n'a pas pu encoder l'image (trop grande ?). Réduis la largeur des cartes.");

    return { canvas, blob, mime, width: L.width, height: L.height, cardWidth: L.cw, shrunk: L.shrunk, failed, stats, cards: total };
  }

  // ----------------------------------------------------------------- interface

  function h(tag, props, children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else if (value !== false && value != null) el.setAttribute(key, value);
    }
    for (const child of [].concat(children || [])) el.append(child);
    return el;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Roboto, "Helvetica Neue", Arial, sans-serif; }
    .fab {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      padding: 10px 16px; border: 2px solid #1d1326; border-radius: 999px;
      background: #472a4f; color: #fff; font-size: 14px; font-weight: 500; cursor: pointer;
      box-shadow: 0 3px 10px rgba(0, 0, 0, .35);
    }
    .fab:hover { background: #5b3766; }
    .panel {
      position: fixed; right: 18px; bottom: 70px; z-index: 2147483001; width: 320px; max-width: calc(100vw - 36px);
      max-height: calc(100vh - 90px); overflow: auto;
      background: #241829; color: #eee6ee; border: 1px solid #5b3766; border-radius: 12px; padding: 16px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .5); font-size: 13px;
    }
    .panel h3 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
    .group { margin: 0 0 12px; padding: 0; border: 0; }
    .group legend { padding: 0; margin-bottom: 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #b9a6bf; }
    label.check { display: flex; align-items: center; gap: 8px; padding: 3px 0; cursor: pointer; }
    label.field { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 3px 0; }
    input[type=number], select {
      width: 120px; padding: 5px 8px; border-radius: 6px; border: 1px solid #5b3766; background: #18101c; color: inherit; font-size: 13px;
    }
    input[type=checkbox] { accent-color: #b07cc6; width: 15px; height: 15px; margin: 0; }
    .status { min-height: 18px; margin: 8px 0 6px; color: #d9c7df; }
    .status.error { color: #ff9a8a; }
    progress { width: 100%; height: 8px; accent-color: #b07cc6; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    button.btn {
      flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #5b3766; background: #33213a; color: #fff;
      font-size: 13px; cursor: pointer;
    }
    button.btn.primary { background: #8a4fa3; border-color: #8a4fa3; font-weight: 600; }
    button.btn:hover:not(:disabled) { filter: brightness(1.15); }
    button.btn:disabled { opacity: .5; cursor: default; }
    .overlay {
      position: fixed; inset: 0; z-index: 2147483002; background: rgba(10, 6, 12, .88);
      display: flex; flex-direction: column; align-items: center; padding: 18px; gap: 12px;
    }
    .overlay .shot { flex: 1; min-height: 0; width: 100%; overflow: auto; display: flex; justify-content: center; align-items: flex-start; }
    .overlay img { max-width: 100%; height: auto; border-radius: 6px; box-shadow: 0 4px 24px rgba(0, 0, 0, .6); cursor: zoom-in; }
    .overlay img.zoomed { max-width: none; cursor: zoom-out; }
    .overlay .bar {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px;
      color: #eee6ee; font-size: 13px;
    }
    .overlay .bar .info { margin-right: 8px; }
    .overlay .bar button.btn { flex: none; }
    [hidden] { display: none !important; }
  `;

  function createUi() {
    const host = h('div', { id: 'tcc-export-host' });
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', { text: CSS }));

    let settings = loadSettings();
    let running = false;
    let cancelled = false;
    let result = null;
    let previewUrl = null;

    const inputs = {};
    const check = (key, label) => {
      inputs[key] = h('input', { type: 'checkbox' });
      inputs[key].checked = !!settings[key];
      return h('label', { class: 'check' }, [inputs[key], label]);
    };
    const number = (key, label, min, max, step) => {
      inputs[key] = h('input', { type: 'number', min, max, step });
      inputs[key].value = settings[key];
      return h('label', { class: 'field' }, [label, inputs[key]]);
    };
    const select = (key, label, options) => {
      inputs[key] = h('select', {}, options.map(([value, text]) => h('option', { value, text })));
      inputs[key].value = settings[key];
      return h('label', { class: 'field' }, [label, inputs[key]]);
    };

    const status = h('div', { class: 'status' });
    const progress = h('progress', { max: 1, value: 0, hidden: true });
    const goButton = h('button', { class: 'btn primary', text: "Générer l'image", onclick: () => generate() });
    const closeButton = h('button', { class: 'btn', text: 'Fermer', onclick: () => closePanel() });

    const panel = h('div', { class: 'panel', hidden: true }, [
      h('h3', { text: "Exporter l'album en image" }),
      h('fieldset', { class: 'group' }, [
        h('legend', { text: 'Cartes à inclure' }),
        check('creators', 'Cartes créateur (par catégorie)'),
        check('generated', 'Cartes générées'),
        check('followers', 'Cartes followers'),
      ]),
      h('fieldset', { class: 'group' }, [
        h('legend', { text: 'Mise en page' }),
        number('columns', 'Cartes par ligne', 2, 80, 1),
        number('cardWidth', "Largeur d'une carte (px)", 30, 750, 10),
        select('theme', 'Thème', [['dark', 'Sombre'], ['light', 'Clair (couleurs du site)']]),
        select('format', 'Format', [['png', 'PNG'], ['jpeg', 'JPEG (plus léger)']]),
      ]),
      h('fieldset', { class: 'group' }, [
        h('legend', { text: 'Détails' }),
        check('showMissing', 'Afficher les cartes manquantes'),
        check('glitched', 'Afficher les variantes glitched'),
        check('counts', 'Afficher les quantités (doublons)'),
        check('header', 'En-tête (pseudo et progression)'),
      ]),
      status,
      progress,
      h('div', { class: 'actions' }, [goButton, closeButton]),
    ]);

    const fab = h('button', { class: 'fab', text: "📸 Exporter l'album", hidden: true, onclick: () => togglePanel() });

    // Aperçu du résultat.
    const previewImage = h('img', { alt: "Aperçu de l'album exporté", onclick: () => previewImage.classList.toggle('zoomed') });
    const previewInfo = h('span', { class: 'info' });
    const copyButton = h('button', { class: 'btn', text: 'Copier', onclick: () => copyResult() });
    const overlay = h('div', { class: 'overlay', hidden: true }, [
      h('div', { class: 'bar' }, [
        previewInfo,
        h('button', { class: 'btn primary', text: 'Télécharger', onclick: () => downloadResult() }),
        copyButton,
        h('button', { class: 'btn', text: 'Ouvrir dans un onglet', onclick: () => previewUrl && window.open(previewUrl, '_blank') }),
        h('button', { class: 'btn', text: 'Fermer', onclick: () => closePreview() }),
      ]),
      h('div', { class: 'shot' }, previewImage),
    ]);

    root.append(fab, panel, overlay);

    function readSettings() {
      const clamp = (value, min, max, fallback) => {
        const n = parseInt(value, 10);
        return isNaN(n) ? fallback : Math.max(min, Math.min(max, n));
      };
      settings = {
        creators: inputs.creators.checked,
        generated: inputs.generated.checked,
        followers: inputs.followers.checked,
        columns: clamp(inputs.columns.value, 2, 80, DEFAULTS.columns),
        cardWidth: clamp(inputs.cardWidth.value, 30, 750, DEFAULTS.cardWidth),
        theme: inputs.theme.value,
        format: inputs.format.value,
        showMissing: inputs.showMissing.checked,
        glitched: inputs.glitched.checked,
        counts: inputs.counts.checked,
        header: inputs.header.checked,
      };
      saveSettings(settings);
      return settings;
    }

    function setStatus(text, isError) {
      status.textContent = text || '';
      status.classList.toggle('error', !!isError);
    }

    function togglePanel() {
      if (panel.hidden) { panel.hidden = false; setStatus(''); } else closePanel();
    }

    function closePanel() {
      if (running) cancelled = true;
      panel.hidden = true;
    }

    function fileName() {
      const date = new Date().toISOString().slice(0, 10);
      const clean = (s) => String(s).replace(/[^a-z0-9_-]+/gi, '_');
      return 'tcc-album-' + clean(result.streamer) + '-' + clean(result.user) + '-' + date + (result.mime === 'image/jpeg' ? '.jpg' : '.png');
    }

    function downloadResult() {
      if (!result) return;
      const link = h('a', { href: previewUrl, download: fileName() });
      root.append(link);
      link.click();
      link.remove();
    }

    async function copyResult() {
      if (!result) return;
      try {
        // Le presse-papiers n'accepte que le PNG.
        const png = result.mime === 'image/png' ? result.blob : await new Promise((resolve) => result.canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        copyButton.textContent = 'Copié ✓';
      } catch (e) {
        copyButton.textContent = 'Copie impossible';
      }
      setTimeout(() => { copyButton.textContent = 'Copier'; }, 2500);
    }

    function closePreview() {
      overlay.hidden = true;
      previewImage.removeAttribute('src');
      previewImage.classList.remove('zoomed');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      result = null;
    }

    function showPreview() {
      previewUrl = URL.createObjectURL(result.blob);
      previewImage.src = previewUrl;
      const megabytes = (result.blob.size / 1048576).toFixed(1).replace('.', ',');
      let info = result.width + ' × ' + result.height + ' px · ' + megabytes + ' Mo · ' + result.cards + ' cartes';
      if (result.shrunk) info += ' · cartes réduites à ' + result.cardWidth + ' px pour tenir dans une image';
      if (result.failed) info += ' · ' + result.failed + ' image(s) non chargée(s)';
      previewInfo.textContent = info;
      overlay.hidden = false;
    }

    async function generate() {
      if (running) return;
      const route = parseRoute();
      if (!route) return setStatus("Ouvre d'abord la page collection d'un streamer.", true);
      const opts = readSettings();
      if (!opts.creators && !opts.generated && !opts.followers) return setStatus('Coche au moins un type de cartes.', true);

      running = true;
      cancelled = false;
      goButton.disabled = true;
      closeButton.textContent = 'Annuler';
      progress.hidden = false;
      progress.removeAttribute('value');
      setStatus("Lecture de l'album…");

      try {
        const data = await loadAlbumData(route, opts);
        if (cancelled) return;
        const rendered = await renderAlbum(data, opts, (done, total) => {
          progress.max = total;
          progress.value = done;
          setStatus('Dessin des cartes : ' + done + ' / ' + total);
        }, () => cancelled);
        if (!rendered || cancelled) return;
        if (result) closePreview();
        result = Object.assign(rendered, { user: data.user, streamer: data.streamer });
        setStatus('Image prête.');
        panel.hidden = true;
        showPreview();
      } catch (error) {
        console.error('[TCC export]', error);
        const message = error && error.status === 401
          ? 'Session expirée : reconnecte-toi sur TCC puis réessaie.'
          : (error && error.message) || 'Erreur inattendue.';
        setStatus(message, true);
      } finally {
        running = false;
        goButton.disabled = false;
        closeButton.textContent = 'Fermer';
        progress.hidden = true;
      }
    }

    function syncRoute() {
      const onCollection = !!parseRoute();
      fab.hidden = !onCollection;
      if (!onCollection && !running) panel.hidden = true;
    }

    document.body.append(host);
    syncRoute();
    setInterval(syncRoute, 600);

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand("Exporter l'album en image", () => {
        if (!parseRoute()) return alert("Ouvre d'abord la page collection d'un streamer sur TCC.");
        panel.hidden = false;
        setStatus('');
      });
    }
  }

  createUi();
})();
