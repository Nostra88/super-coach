
var BACKEND = 'https://supercoach-api-acyw.onrender.com';

// Panier de matchs sélectionnés — éphémère par session
window.matchPool = [];
window.selectedMatches = [];

// ── FLUX : Chargement des matchs ESPN ──
function loadFluxMatches() {
  var listEl = document.getElementById('fluxList');
  if (listEl) listEl.innerHTML = '<div class="flux-loading">'+t('fluxLoading')+'</div>';

  // Garder le pool affiché pendant le refetch (évite le flash Live vide)
  // Ne pas vider selectedMatches — l'utilisateur garde ses coches
  window.selectedMatches = window.selectedMatches || [];
  updateFluxBtn();

  // Appel centralisé au backend Render /fixtures
  // Fallback ESPN direct si le backend est hors ligne (Render cold start)
  var backendUrl = BACKEND + '/fixtures';

  fetch(backendUrl, {
    signal: (function(){ var c=new AbortController(); setTimeout(function(){ c.abort(); },10000); return c.signal; })()
  })
  .then(function(r){ return r.ok ? r.json() : Promise.reject('Backend ' + r.status); })
  .then(function(data) {
    if (!data.success || !data.matches || !data.matches.length) {
      throw new Error('empty');
    }
    console.log('[FLUX] API-Sports via Render:', data.count, 'matchs');
    window.matchPool = [];
    populateMatchPool(data.matches);
    var hasTennis = (window.matchPool||[]).some(function(m){ return m.sport==='tennis'; });
    if (!hasTennis) loadEspnTennisSupplement();
  })
  .catch(function(err) {
    console.warn('[FLUX] Backend unavailable, fallback ESPN direct:', err);
    loadFluxESPNDirect();
  });
}

// Peuple window.matchPool depuis le format normalisé /fixtures

function loadEspnTennisSupplement(){
  function toHttps(u){ return String(u||'').replace('http://','https://'); }
  var tours=['atp','wta'];
  var now=Date.now();
  Promise.all(tours.map(function(tour){
    return fetch('https://sports.core.api.espn.com/v2/sports/tennis/leagues/'+tour+'/events')
      .then(function(r){ return r.ok?r.json():null; })
      .catch(function(){ return null; });
  })).then(function(lists){
    var refs=[];
    lists.forEach(function(list){
      if(!list||!list.items) return;
      list.items.forEach(function(it){ if(it.$ref) refs.push(toHttps(it.$ref)); });
    });
    refs=refs.slice(0,6);
    return Promise.all(refs.map(function(u){
      return fetch(u).then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; });
    }));
  }).then(function(events){
    if(!events) return;
    var extra=[];
    var seen={};
    events.forEach(function(ev){
      if(!ev) return;
      var league=ev.name||ev.shortName||'US Open';
      (ev.competitions||[]).forEach(function(comp){
        var cs=comp.competitors||[];
        if(cs.length<2) return;
        if(cs.some(function(c){ return c.winner===true; })) return;
        var hn=cs[0].name||'', an=cs[1].name||'';
        if(!hn||!an) return;
        var when=new Date(comp.date||ev.date||0).getTime();
        if(!when||when<now-16*3600*1000||when>now+48*3600*1000) return;
        var key=hn+'|'+an;
        if(seen[key]) return;
        seen[key]=1;
        extra.push({
          id:'espn|'+hn+'|'+an,
          sport:'tennis',
          home:hn, away:an,
          homeLogo:'', awayLogo:'',
          competition:league+(comp.type&&comp.type.text?(' · '+comp.type.text):''),
          dateUTC:comp.date||ev.date||'',
          isLive:!!comp.liveAvailable,
          isFinished:false,
          score:'',
          statusShort:comp.liveAvailable?'LIVE':'NS'
        });
      });
    });
    if(extra.length){
      populateMatchPool(extra);
      if(typeof renderFluxList==='function') renderFluxList();
      if(typeof renderHomeContent==='function') renderHomeContent();
    }
  });
}

function populateMatchPool(matches) {
  var EXCLUDE = /reserve|b\.?team|u1[6-9]|u20|u21|u23|youth|junior|academy/i;
  var seen = {};

  matches.forEach(function(m) {
    if (!m.home || !m.away) return;
    if (m.isFinished) return;
    if (EXCLUDE.test(m.competition || '') || EXCLUDE.test(m.home) || EXCLUDE.test(m.away)) return;

    var key = m.id || (m.sport + '|' + m.home + '|' + m.away);
    if (seen[key]) return;
    seen[key] = true;

    // Heure Paris depuis UTC
    var timeStr = '';
    var dateLabel = '';
    if (m.dateUTC) {
      var d = new Date(m.dateUTC);
      timeStr = d.toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit',
        timeZone: 'Europe/Paris', hour12: false
      });
      dateLabel = d.toLocaleDateString('fr-FR', {
        day: '2-digit', month: '2-digit',
        timeZone: 'Europe/Paris'
      });
    }

    var sportColors = {
      wc:'#fde68a', foot:'#4ade80', basket:'#f97316',
      tennis:'#eab308', baseball:'#10b981', hockey:'#3b82f6',
      rugby:'#84cc16', mma:'#ef4444', other:'#8b949e'
    };

    var sportId = m.sport || m.sportId || 'other';
    var liveFlag = !!(m.isLive || m.live || m.statusShort === 'in' ||
      /^(live|inplay|in_play)$/i.test(String(m.status || m.statusShort || '')));
    window.matchPool.push({
      id:          key,
      home:        m.home,
      away:        m.away,
      competition: m.competition || String(sportId).toUpperCase(),
      country:     m.country || '',
      sportId:     sportId,
      emoji:       m.emoji || '',
      time:        timeStr,
      matchDate:   dateLabel,
      dateUTC:     m.dateUTC || m.date || '',
      isLive:      liveFlag,
      isFinished:  false,
      isFriendly:  /friendly|amical|amistoso/i.test(m.competition || ''),
      score:       m.score || '',
      minute:      m.minute || m.elapsed || '',
      homeLogo:    m.homeLogo || m.home_logo || '',
      awayLogo:    m.awayLogo || m.away_logo || '',
      sportColor:  sportColors[sportId] || '#8b949e',
    });
  });

  renderFluxList();
  if (typeof renderHomeContent === 'function') renderHomeContent(window.matchPool || []);
}

// Fallback ESPN direct (si Render cold start ou indisponible)
function loadFluxESPNDirect() {
  var urlSportMap = {
    'concacaf.gold':'foot','conmebol.america':'foot',
    'fra.1':'foot','eng.1':'foot','esp.1':'foot','ger.1':'foot','ita.1':'foot',
    'usa.1':'foot','bra.1':'foot','arg.1':'foot','mex.1':'foot',
    'tennis':'tennis','nba':'basket','wnba':'basket','mens-college-basketball':'basket',
    'mlb':'baseball','nhl':'hockey','football/nfl':'nfl','college-football':'nfl',
  };
  var allUrls = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.gold/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.america/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/tennis/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  ];
  var sportEmoji = { foot:'',basket:'',tennis:'',baseball:'',hockey:'',nfl:'',other:'' };
  var EXCLUDE = /reserve|b\.?team|u1[6-9]|u20|u21|u23|youth|junior|academy/i;

  Promise.all(allUrls.map(function(url) {
    return fetch(url, {signal:(function(){ var c=new AbortController(); setTimeout(function(){ c.abort(); },6000); return c.signal; })()})
    .then(function(r){ return r.ok ? r.json() : null; })
    .catch(function(){ return null; });
  })).then(function(results) {
    var espnMatches = [];
    results.forEach(function(data, ui) {
      if (!data || !data.events) return;
      var srcUrl = allUrls[ui] || '';
      var sportId = 'foot';
      Object.keys(urlSportMap).forEach(function(k){ if (srcUrl.includes(k)) sportId = urlSportMap[k]; });
      var leagueName = (data.leagues && data.leagues[0] && (data.leagues[0].name || data.leagues[0].shortName)) || '';

      data.events.forEach(function(ev) {
        var comp = ev.competitions && ev.competitions[0];
        if (!comp) return;
        var statusState = (comp.status && comp.status.type && comp.status.type.state) || '';
        var statusType  = (comp.status && comp.status.type && comp.status.type.name)  || '';
        if (statusState === 'post') return;
        if (/STATUS_FINAL|final|completed/i.test(statusType)) return;
        var teams = comp.competitors || [];
        if (teams.length < 2) return;
        var home = teams.find(function(t){ return t.homeAway==='home'; }) || teams[0];
        var away = teams.find(function(t){ return t.homeAway==='away'; }) || teams[1];
        function compNameOf(c){
          if (!c) return '';
          return (c.team && (c.team.displayName || c.team.name)) ||
                 (c.athlete && (c.athlete.displayName || c.athlete.fullName || c.athlete.name)) ||
                 c.displayName || c.name || '';
        }
        var homeName = compNameOf(home);
        var awayName = compNameOf(away);
        if (!homeName || !awayName || homeName.length < 2) return;
        var compName = leagueName || sportId.toUpperCase();
        if (EXCLUDE.test(compName)) return;
        var isLive = statusState === 'in';
        var homeLogo = (home.team && (home.team.logo || (home.team.logos && home.team.logos[0] && home.team.logos[0].href))) || (home.athlete && home.athlete.flag && home.athlete.flag.href) || '';
        var awayLogo = (away.team && (away.team.logo || (away.team.logos && away.team.logos[0] && away.team.logos[0].href))) || (away.athlete && away.athlete.flag && away.athlete.flag.href) || '';
        var minute = (comp.status && (comp.status.displayClock || (comp.status.type && comp.status.type.shortDetail))) || '';
        espnMatches.push({
          id:          sportId + '|' + homeName + '|' + awayName,
          sport:       sportId,
          emoji:       sportEmoji[sportId] || '',
          home:        homeName,
          away:        awayName,
          competition: compName,
          country:     '',
          dateUTC:     ev.date || '',
          isLive:      isLive,
          isFinished:  false,
          score:       isLive ? (home.score || '0') + '-' + (away.score || '0') : '',
          statusShort: statusState,
          minute:      minute,
          homeLogo:    homeLogo,
          awayLogo:    awayLogo,
        });
      });
    });
    console.log('[FLUX] ESPN fallback:', espnMatches.length, 'matchs');
    populateMatchPool(espnMatches);
  });
}



function renderFluxList() {
  var listEl = document.getElementById('fluxList');
  if (!listEl) {
    if (typeof renderHomeContent === 'function') renderHomeContent(window.matchPool || []);
    return;
  }

  // ── Filtre commutateur ON/OFF multi-sport ──
  var showAll = activeSports.indexOf('all') > -1;
  var filtered = window.matchPool.filter(function(m) {
    if (showAll) return true;
    return activeSports.indexOf(m.sportId) > -1;
  });
  filtered = filtered.filter(function(m){ return !m.isFinished; });
  window._filteredPool = filtered;

  if (!filtered.length) {
    listEl.innerHTML = '<div class="flux-empty">' + t('fluxEmpty') + '</div>';
    if (typeof renderHomeContent === 'function') renderHomeContent(window.matchPool || []);
    return;
  }

  // ── Tri chronologique strict ──
  filtered.sort(function(a, b) {
    function isDub(m){
      var s=((m.competition||'')+' '+(m.home||'')).toLowerCase();
      return /double|doubles|mixed/.test(s) || (m.home||'').indexOf('/')>=0;
    }
    if (!!a.isLive !== !!b.isLive) return a.isLive ? -1 : 1;
    var da=isDub(a), db=isDub(b);
    if (da!==db) return da?1:-1;
    var ta = a.dateUTC ? new Date(a.dateUTC).getTime() : 9e12;
    var tb = b.dateUTC ? new Date(b.dateUTC).getTime() : 9e12;
    return ta - tb;
  });

  // ── Regroupement Flashscore par compétition ──
  var groups = {}, groupOrder = [], groupLabels = {};
  filtered.forEach(function(m) {
    var label = (m.competition || m.sportId.toUpperCase()).toUpperCase()
      + (m.country ? ' · ' + m.country.toUpperCase() : '');
    var gKey = m.sportId + '|' + label;
    if (!groups[gKey]) { groups[gKey] = []; groupOrder.push(gKey); groupLabels[gKey] = label; }
    groups[gKey].push(m);
  });

  // Compétitions majeures en tête
  var PRIORITY = /world cup|copa del mundo|coupe du monde|champions league|copa america|gold cup|wimbledon|us open|nba finals|stanley cup/i;
  groupOrder.sort(function(a, b) {
    var aT = groups[a][0] ? (groups[a][0].dateUTC ? new Date(groups[a][0].dateUTC).getTime() : 9e12) : 9e12;
    var bT = groups[b][0] ? (groups[b][0].dateUTC ? new Date(groups[b][0].dateUTC).getTime() : 9e12) : 9e12;
    var aPrio = PRIORITY.test(groupLabels[a]) ? -9e12 : 0;
    var bPrio = PRIORITY.test(groupLabels[b]) ? -9e12 : 0;
    return (aT + aPrio) - (bT + bPrio);
  });

  // ── Rendu DOM ──
  listEl.innerHTML = '';

  groupOrder.forEach(function(gKey) {
    var header = document.createElement('div');
    header.className = 'flux-group-header';
    header.textContent = groupLabels[gKey];
    listEl.appendChild(header);

    var groupMatches = groups[gKey];

    groupMatches.forEach(function(m) {
      var isSelected = window.selectedMatches.indexOf(m.id) > -1;
      var isHidden = false;

      var item = document.createElement('div');
      item.className = 'flux-item' + (isSelected ? ' selected' : '') + (m.isFriendly ? ' friendly' : '');
      item.dataset.matchId = m.id;
      var _mid = m.id;
      var _touchStartX = 0, _touchStartY = 0, _wasScroll = false;
      function _onTouchStart(e) {
        var t = e.touches && e.touches[0];
        if (t) { _touchStartX = t.clientX; _touchStartY = t.clientY; }
        _wasScroll = false;
      }
      function _onTouchEnd(e) {
        var t = e.changedTouches && e.changedTouches[0];
        if (t) {
          var dx = Math.abs(t.clientX - _touchStartX);
          var dy = Math.abs(t.clientY - _touchStartY);
          // Doigt déplacé de plus de 10px = défilement, pas un tap → on ignore
          if (dx > 10 || dy > 10) { _wasScroll = true; return; }
        }
        e.preventDefault();
        toggleFluxMatch(_mid);
      }
      function _onTap(e){ if (_wasScroll) { _wasScroll = false; return; } e.preventDefault(); toggleFluxMatch(_mid); }
      item.addEventListener('click', _onTap);
      item.addEventListener('touchstart', _onTouchStart, { passive: true });
      item.addEventListener('touchend', _onTouchEnd);

      // Checkbox
      var check = document.createElement('div');
      check.className = 'flux-check';
      check.innerHTML = isSelected ? statusSVG('check') : '';
      item.appendChild(check);
      if (tennisDrawKind(m)) {
        var bd = document.createElement('span');
        bd.className = 'tdraw tdraw-' + tennisDrawKind(m);
        bd.textContent = tennisDrawKind(m);
        item.appendChild(bd);
      }

      // Corps match
      var body = document.createElement('div');
      body.className = 'flux-match-body';
      var teams = document.createElement('div');
      teams.className = 'flux-teams';
      var homeEl = document.createElement('div');
      homeEl.className = 'flux-team'; homeEl.textContent = m.home;
      teams.appendChild(homeEl);
      var sep = document.createElement('div');
      sep.className = 'flux-vs';
      sep.textContent = m.score ? m.score : '–';
      teams.appendChild(sep);
      var awayEl = document.createElement('div');
      awayEl.className = 'flux-team'; awayEl.textContent = m.away;
      teams.appendChild(awayEl);
      body.appendChild(teams);
      if (m.isFriendly) {
        var ftag = document.createElement('div');
        ftag.className = 'flux-friendly-tag';
        ftag.textContent = t('friendlyWarning') || 'Friendly';
        body.appendChild(ftag);
      }
      item.appendChild(body);

      // Droite : heure AM/PM ou 24h + date colorée
      var right = document.createElement('div');
      right.className = 'flux-right';

      var timeEl = document.createElement('div');
      timeEl.className = m.isLive ? 'flux-score' : 'flux-time';

      // ── Format heure dynamique lié au toggle AM/PM ──
      var displayTime = m.time || '--:--';
      if (!clockIs24h && displayTime !== '--:--') {
        var parts = displayTime.split(':');
        var hh = parseInt(parts[0], 10), mm = parts[1];
        var suffix = hh >= 12 ? 'PM' : 'AM';
        hh = hh % 12 || 12;
        displayTime = hh + ':' + mm + ' ' + suffix;
      }
      timeEl.textContent = displayTime;
      right.appendChild(timeEl);

      // Date courte colorée par sport
      if (m.matchDate && !m.isLive) {
        var dateEl = document.createElement('div');
        dateEl.style.cssText = 'font-size:9px;font-family:JetBrains Mono,monospace;' +
          'color:' + (m.sportColor || '#8b949e') + ';letter-spacing:0.5px;margin-top:2px;opacity:0.85;';
        dateEl.textContent = m.matchDate;
        right.appendChild(dateEl);
      }

      if (m.isLive) {
        var liveEl = document.createElement('div');
        liveEl.className = 'flux-status-live';
        liveEl.textContent = '● LIVE';
        right.appendChild(liveEl);
        // Afficher le temps de jeu si disponible
        if (m.minute) {
          var minEl = document.createElement('span');
          minEl.className = 'flux-minute';
          minEl.textContent = m.minute + '\'';
          minEl.style.cssText = 'font-size:10px;font-weight:700;color:#ef4444;font-family:monospace;margin-left:4px;';
          right.appendChild(minEl);
        }
      }

      item.appendChild(right);
      listEl.appendChild(item);
    });


  });

  renderHomeContent(window.matchPool || []);
}

// ── NOUVEAU HOME — zone vivante + à venir ──────────────────────────
// Réutilise le pool déjà chargé (aucune nouvelle source de données).
// Score d'importance simple et transparent : LIVE > compétition majeure > proximité temporelle.
var HOME_PRIORITY_RE = /world cup|copa del mundo|coupe du monde|champions league|copa america|gold cup|wimbledon|us open|nba finals|stanley cup|super bowl|europa league/i;

function guessUserRegion() {
  // Heuristique légère à partir de la langue du navigateur — pas de géolocalisation,
  // pas de nouvelle permission demandée à l'utilisateur.
  var l = (navigator.language || 'en-US').toLowerCase();
  if (l.indexOf('fr') === 0) return 'fr';
  if (l.indexOf('pt-br') === 0 || l === 'pt') return 'br';
  if (l.indexOf('es') === 0) return 'es';
  if (l.indexOf('en-us') === 0) return 'us';
  if (l.indexOf('en-gb') === 0) return 'gb';
  if (l.indexOf('de') === 0) return 'de';
  if (l.indexOf('it') === 0) return 'it';
  if (l.indexOf('ar') === 0) return 'ar';
  return null;
}
var HOME_REGION_COMPETITIONS = {
  fr: /ligue 1|coupe de france|top 14/i,
  br: /brasileirao|brasileirão|copa do brasil/i,
  us: /nfl|nba|nhl|mlb|mls/i,
  gb: /premier league|fa cup/i,
  de: /bundesliga|dfb.?pokal/i,
  it: /serie a|coppa italia/i,
  es: /la liga|copa del rey/i,
};


function tennisDrawKind(m){
  var s=((m&&m.competition||'')+' '+(m&&m.home||'')).toLowerCase();
  if(/double|doubles|mixed/.test(s) || ((m&&m.home||'').indexOf('/')>=0)) return 'D';
  if((m&&m.sportId)==='tennis' || (m&&m.sport)==='tennis' || /singles/.test(s)) return 'S';
  return '';
}
function tennisDrawBadge(m){
  var k=tennisDrawKind(m);
  if(!k) return '';
  return '<span class="tdraw tdraw-'+k+'">'+k+'</span>';
}
function computeMatchScore(m) {
  var score = 0;
  if (m.isLive) score += 1000;
  if (HOME_PRIORITY_RE.test(m.competition || '')) score += 300;
  var region = guessUserRegion();
  if (region && HOME_REGION_COMPETITIONS[region] && HOME_REGION_COMPETITIONS[region].test(m.competition || '')) score += 150;
  if (m.dateUTC) {
    var hoursUntil = (new Date(m.dateUTC).getTime() - Date.now()) / 3600000;
    if (hoursUntil >= -3 && hoursUntil <= 48) score += Math.max(0, 100 - Math.abs(hoursUntil));
  }
  if (m.isFriendly) score -= 200;
  var label = ((m.competition || '') + ' ' + (m.home || '') + ' ' + (m.away || '')).toLowerCase();
  if (/double|doubles|mixed/.test(label) || ((m.home || '').indexOf('/') >= 0)) score -= 280;
  else if (/singles/.test(label) || m.sport === 'tennis') score += 80;
  return score;
}

function formatRelativeKickoff(dateUTC) {
  if (!dateUTC) return '';
  var diffMs = new Date(dateUTC).getTime() - Date.now();
  var diffH = diffMs / 3600000;
  if (diffH < 0) return '';
  if (diffH < 1) return Math.round(diffH * 60) + 'm';
  if (diffH < 24) return Math.round(diffH) + 'h';
  return Math.round(diffH / 24) + 'd';
}


function teamMono(name) {
  if (!name) return '';
  var parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}
function scLogoErr(el) {
  if (!el) return;
  var d = document.createElement('div');
  d.className = 'team-mark team-mark-fb';
  d.textContent = el.getAttribute('data-mono') || '';
  if (el.parentNode) el.parentNode.replaceChild(d, el);
}
function teamMarkHtml(url, name) {
  var mono = esc(teamMono(name));
  if (!url) {
    return '<div class="team-mark team-mark-fb">' + mono + '</div>';
  }
  return '<img class="team-mark" src="' + esc(url) + '" alt="" data-mono="' + mono + '" onerror="scLogoErr(this)">';
}
function formatKickoffClock(dateUTC) {
  if (!dateUTC) return '';
  try {
    return new Date(dateUTC).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) { return ''; }
}
function isTonightMatch(m) {
  if (!m || m.isLive || m.isFinished) return false;
  if (!m.dateUTC) return false;
  var d = new Date(m.dateUTC);
  if (isNaN(d.getTime())) return false;
  var now = new Date();
  var hoursUntil = (d.getTime() - now.getTime()) / 3600000;
  if (hoursUntil < -0.2) return false;
  if (hoursUntil <= 24) return true;
  return d.toDateString() === now.toDateString();
}

function renderHomeContent(pool) {
  var featuredEl = document.getElementById('homeFeatured');
  var upcomingListEl = document.getElementById('homeUpcomingList');
  var watchEl = document.getElementById('homeWatchCard');
  var liveEmpty = document.getElementById('homeLiveEmpty');
  var tonightEmpty = document.getElementById('homeTonightEmpty');
  var watchEmpty = document.getElementById('homeWatchEmpty');
  var cta = document.getElementById('homeFeaturedCta');
  if (!featuredEl || !upcomingListEl) return;

  var list = (window.matchPool && window.matchPool.length) ? window.matchPool : (pool || []);
  var live = list.filter(function(m){ return m.isLive; }).sort(function(a,b){ return computeMatchScore(b) - computeMatchScore(a); });
  var tonight = list.filter(isTonightMatch).sort(function(a,b){
    return new Date(a.dateUTC).getTime() - new Date(b.dateUTC).getTime();
  }).slice(0, 4);
  var watchPool = list.filter(function(m){
    if (m.isLive) return false;
    var used = tonight.some(function(x){ return x.id === m.id; });
    return !used;
  }).sort(function(a,b){ return computeMatchScore(b) - computeMatchScore(a); });
  var watch = watchPool[0] || tonight[0] || null;
  var featured = live[0] || null;
  document.querySelectorAll('.logo-bolt').forEach(function(el){ el.classList.toggle('live', !!featured); });
  var liveRail = document.getElementById('liveRail');
  var tonightRail = document.getElementById('tonightRail');
  var watchRail = document.getElementById('watchRail');
  if (liveRail) liveRail.classList.toggle('is-empty-rail', !featured);
  if (tonightRail) tonightRail.classList.toggle('is-empty-rail', !tonight.length);
  if (watchRail) watchRail.classList.toggle('is-empty-rail', !watch);

  if (featured) {
    featuredEl.classList.add('is-live');
    featuredEl.classList.remove('is-empty');
    if (liveEmpty) liveEmpty.style.display = 'none';
    if (cta) cta.style.display = 'flex';
    var scores = String(featured.score || '').split('-');
    var homeScore = scores[0] !== undefined ? scores[0].trim() : '0';
    var awayScore = scores[1] !== undefined ? scores[1].trim() : '0';
    var sid = featured.sportId || featured.sport || 'other';
    document.getElementById('homeFeaturedTeams').innerHTML =
      '<div class="hero-live-top"><div class="hero-comp">' + sportSVG(sid, 14) + ' ' + esc(featured.competition || '') + '</div>' +
      '<div class="hero-live-badge"><span class="live-dot"></span>LIVE</div></div>' +
      '<div class="hero-teams">' +
        '<div class="hero-side">' + teamMarkHtml(featured.homeLogo, featured.home) + '<div class="hero-name">' + esc(featured.home && featured.home.length>12 ? teamMono(featured.home) : featured.home) + '</div></div>' +
        '<div><div class="hero-score"><span>' + esc(homeScore) + '</span><span class="hero-score-sep">-</span><span>' + esc(awayScore) + '</span></div>' +
        (featured.minute ? '<div class="hero-minute">' + esc(String(featured.minute)) + '</div>' : '') + '</div>' +
        '<div class="hero-side">' + teamMarkHtml(featured.awayLogo, featured.away) + '<div class="hero-name">' + esc(featured.away && featured.away.length>12 ? teamMono(featured.away) : featured.away) + '</div></div>' +
      '</div>';
    document.getElementById('homeFeaturedMeta').textContent = '';
    document.getElementById('homeFeaturedContext').textContent = '';
  } else {
    featuredEl.classList.remove('is-live');
    featuredEl.classList.add('is-empty');
    if (liveEmpty) liveEmpty.style.display = 'block';
    if (cta) cta.style.display = 'none';
    document.getElementById('homeFeaturedTeams').innerHTML = '';
    document.getElementById('homeFeaturedMeta').textContent = '';
    document.getElementById('homeFeaturedContext').textContent = '';
  }

  if (tonight.length) {
    if (tonightEmpty) tonightEmpty.style.display = 'none';
    upcomingListEl.innerHTML = tonight.map(function(m) {
      var sid = m.sportId || m.sport || 'other';
      return '<div class="tonight-card" onclick="scrollToExplore()">' +
        '<div class="tonight-top">' +
          '<span class="tonight-sport">' + sportSVG(sid, 16) + tennisDrawBadge(m) + '</span>' +
          '<span class="tonight-comp">' + esc(m.competition || '') + '</span>' +
          '<span class="tonight-time">' + esc(m.time || formatKickoffClock(m.dateUTC)) + '</span>' +
        '</div>' +
        '<div class="tonight-fixture">' +
          '<div class="tonight-side">' + teamMarkHtml(m.homeLogo, m.home) + '<span>' + esc(m.home) + '</span></div>' +
          '<div class="tonight-vs">-</div>' +
          '<div class="tonight-side is-away"><span>' + esc(m.away) + '</span>' + teamMarkHtml(m.awayLogo, m.away) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    upcomingListEl.innerHTML = '';
    if (tonightEmpty) tonightEmpty.style.display = 'block';
  }

  if (watchEl) {
    if (watch) {
      if (watchEmpty) watchEmpty.style.display = 'none';
      var sidw = watch.sportId || watch.sport || 'other';
      watchEl.innerHTML = '<div class="watch-card" onclick="scrollToExplore()">' +
        '<div class="watch-top"><div class="watch-comp">' + sportSVG(sidw, 14) + ' ' + esc(watch.competition || '') + '</div>' +
        '<div class="watch-time">' + esc(watch.time || formatKickoffClock(watch.dateUTC)) + '</div></div>' +
        '<div class="watch-teams">' +
          '<div class="watch-side">' + teamMarkHtml(watch.homeLogo, watch.home) + '<div class="watch-name">' + esc(watch.home) + '</div></div>' +
          '<div class="watch-vs">VS</div>' +
          '<div class="watch-side"><div class="watch-name">' + esc(watch.away) + '</div>' + teamMarkHtml(watch.awayLogo, watch.away) + '</div>' +
        '</div>' +
        '<div class="watch-cta">' + esc(t('homeReadMatch') || 'Open') + '</div>' +
      '</div>';
    } else {
      watchEl.innerHTML = '';
      if (watchEmpty) watchEmpty.style.display = 'block';
    }
  }
}

function scrollToExplore() {
  var el = document.getElementById('exploreAnchor');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}



function toggleFluxByIndex(idx) {
  var pool = window._filteredPool || [];
  if (pool[idx]) toggleFluxMatch(pool[idx].id);
}
function toggleFluxMatch(id) {
  window.selectedMatches = window.selectedMatches || [];
  var idx = window.selectedMatches.indexOf(id);
  if (idx > -1) {
    window.selectedMatches.splice(idx, 1);
  } else {
    window.selectedMatches.push(id);
  }
  // Mettre à jour visuellement UNIQUEMENT l'élément cliqué
  // sans recréer tout le DOM (évite l'invalidation des listeners)
  var items = document.querySelectorAll('.flux-item[data-match-id]');
  if (!items.length) {
    // Fallback : chercher par dataset
    items = document.querySelectorAll('.flux-item');
  }
  document.querySelectorAll('.flux-item').forEach(function(el) {
    var mid = el.dataset.matchId;
    if (!mid) return;
    var sel = window.selectedMatches.indexOf(mid) > -1;
    if (sel) { el.classList.add('selected'); } else { el.classList.remove('selected'); }
    var chk = el.querySelector('.flux-check');
    if (chk) chk.innerHTML = sel ? statusSVG('check') : '';
  });
  updateFluxBtn();
  updateCoachTip();
}

function updateFluxBtn() {
  var btn = document.getElementById('fluxAnalyzeBtn');
  var lbl = document.getElementById('fluxAnalyzeLbl');
  window.selectedMatches = window.selectedMatches || [];
  var n = window.selectedMatches.length;
  if (btn) {
    btn.disabled = false;
    // Visible uniquement sur onglet flux ET quand au moins 1 match coché
    if (activeTab === 'flux' && n > 0) {
      btn.classList.add('visible');
      btn.style.opacity = '1';
    } else {
      btn.classList.remove('visible');
    }
  }
  if (lbl) lbl.textContent = n > 0
    ? t('fluxSelectBtn') + ' ['+n+']'
    : t('fluxNoneSelected');
}

function updateCoachTip() {
  window.selectedMatches = window.selectedMatches || [];
  var n = window.selectedMatches.length;
  var tip = document.getElementById('coachTip');
  var tipBody = document.getElementById('coachTipBody');
  var tipSniper = document.getElementById('coachTipSniper');
  if (!tip) return;

  // Vérifier si des amicaux sont sélectionnés
  var hasFriendly = window.selectedMatches.some(function(id) {
    var m = window.matchPool.find(function(x){return x.id===id;});
    return m && m.isFriendly;
  });

  var msg = '';
  if (hasFriendly) msg += t('coachFriendly') + ' ';
  if (n > 5) msg += t('coachVolume');

  if (msg) {
    tip.style.display = 'block';
    var tipTitle = document.getElementById('coachTipTitle');
    if (tipTitle) tipTitle.textContent = t('coachTitle');
    if (tipBody) tipBody.textContent = msg;
    if (tipSniper) tipSniper.textContent = t('coachSniper');
  } else {
    tip.style.display = 'none';
  }
}

async function analyzeFlux() {
  var sel = window.selectedMatches || [];
  if (!sel.length) {
    showOut('<div class="err-box">' + t('errNoMatches') + '</div>');
    return;
  }

  var lines = [];
  var pool = window.matchPool || [];
  sel.forEach(function(id) {
    for (var i = 0; i < pool.length; i++) {
      if (String(pool[i].id) === String(id)) {
        var m = pool[i];
        var line = m.home + ' vs ' + m.away;
        if (m.competition) line += ' — ' + m.competition;
        if (m.time) line += ' — ' + m.time;
        lines.push(line);
        break;
      }
    }
  });

  if (!lines.length) {
    document.querySelectorAll('.flux-item.selected').forEach(function(el) {
      var teams = el.querySelectorAll('.flux-team');
      if (teams.length >= 2) {
        lines.push(teams[0].textContent.trim() + ' vs ' + teams[teams.length-1].textContent.trim());
      }
    });
  }

  if (!lines.length) {
    showOut('<div class="err-box">' + t('errNoMatches') + '</div>');
    return;
  }

  var fluxBtn = document.getElementById('fluxAnalyzeBtn');
  if (fluxBtn) fluxBtn.style.opacity = '0.5';
  showOut(thinkingHTML(false));
  startThinkingAnimation(false);

  var matchText = lines.join('\n');
  var fluxTries = 0;
  function failAnalyze(){
    showOut('<div class="zero-edge"><div class="zero-edge-icon"><svg width="34" height="34" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L15 14H1z"/><path d="M8 6.5v3.2M8 12h0"/></svg></div>' +
      '<div class="zero-edge-title">' + t('analysisFailed') + '</div>' +
      '<div class="zero-edge-sub">' + t('errParseFail') + '</div></div>' +
      '<button class="reset-btn" onclick="resetOut()">↺ ' + t('newAnalysis') + '</button>');
  }
  function acceptAnalyze(p){
    saveHist(p, 'pre', window._lastDbIds || []);
    showOut(renderResults(p));
    setTimeout(function(){
      var out = document.getElementById('output');
      if (out) out.scrollIntoView({behavior:'smooth'});
    }, 300);
  }
  function runFluxOnce(){
    fluxTries++;
    return callBackend(buildPrompt(matchText, false)).then(function(raw) {
      var p = parse(raw);
      if (p && p.matches && p.matches.length > 0) {
        p.matches = keepOnlyRequested(normM(p.matches), matchText);
        if (p.matches.length) { acceptAnalyze(p); return true; }
      } else {
        var fb = extractFallbackMatches(raw);
        if (fb && fb.matches && fb.matches.length) {
          fb.matches = keepOnlyRequested(fb.matches, matchText);
          if (fb.matches.length) { acceptAnalyze(fb); return true; }
        }
      }
      if (fluxTries < 2) return runFluxOnce();
      failAnalyze();
      return false;
    });
  }
  runFluxOnce().catch(function(e) {
    if (fluxTries < 2) {
      return runFluxOnce().catch(function(e2){
        showOut('<div class="err-box">' + esc(e2.message || e.message) + '</div>');
      });
    }
    showOut('<div class="err-box">' + esc(e.message) + '</div>');
  }).finally(function() {
    stopThinkingAnimation();
    if (fluxBtn) fluxBtn.style.opacity = '1';
  })
}

// ── SPORTS ──
function sportSVG(id, size){
  var s='stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  var icons={
    all:'<circle cx="9" cy="9" r="7" '+s+'/><path d="M2 9h14M9 2c2.2 2 3.4 4.5 3.4 7S11.2 16 9 18M9 2c-2.2 2-3.4 4.5-3.4 7S6.8 16 9 18" '+s+'/>',
    foot:'<circle cx="9" cy="9" r="7" '+s+'/><path d="M9 5.5l2.6 1.9-1 3-3.2 0-1-3z" '+s+'/><path d="M9 5.5V3M11.6 7.4l2.4-1M6.4 7.4L4 6.4M7.6 10.4l-1 2.8M10.4 10.4l1 2.8" '+s+'/>',
    basket:'<circle cx="9" cy="9" r="7" '+s+'/><path d="M2 9h14M9 2v14M4 4c2.6 2.4 2.6 7.6 0 10M14 4c-2.6 2.4-2.6 7.6 0 10" '+s+'/>',
    tennis:'<circle cx="9" cy="9" r="7" '+s+'/><path d="M3 4.5c3 1.5 3 7.5 0 9M15 4.5c-3 1.5-3 7.5 0 9" '+s+'/>',
    rugby:'<ellipse cx="9" cy="9" rx="7" ry="4.6" transform="rotate(-40 9 9)" '+s+'/><path d="M5.6 12.4l6.8-6.8M7 9h0M9 7h0M11 11h0" '+s+'/>',
    hockey:'<rect x="4" y="11" width="10" height="3.4" rx="1.4" '+s+'/><path d="M6 11V6l5-3.5" '+s+'/>',
    nfl:'<ellipse cx="9" cy="9" rx="7.2" ry="4" transform="rotate(-40 9 9)" '+s+'/><path d="M6 12l6-6M8.6 7.6l1 1M10.2 6l1 1M6.8 9.4l1 1" '+s+'/>',
    baseball:'<circle cx="9" cy="9" r="7" '+s+'/><path d="M4.3 5.5c2.4 1 2.4 6 0 7M13.7 5.5c-2.4 1-2.4 6 0 7" '+s+'/>',
    other:'<circle cx="9" cy="9" r="7" '+s+'/><circle cx="9" cy="9" r="2.6" '+s+'/>',
  };
  return '<svg width="'+(size||25)+'" height="'+(size||25)+'" viewBox="0 0 18 18">'+(icons[id]||icons.other)+'</svg>';
}
function statusSVG(kind){
  var s='stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  var icons={
    check:'<path d="M3 8l3.5 3.5L13 4" '+s+'/>',
    cross:'<path d="M4 4l8 8M12 4l-8 8" '+s+'/>',
    warning:'<path d="M8 1.5L15 14H1z" '+s+'/><path d="M8 6.5v3.2M8 12h0" '+s+'/>',
  };
  return '<svg width="12" height="12" viewBox="0 0 16 16" style="vertical-align:-1px">'+(icons[kind]||'')+'</svg>';
}
var SPORTS = [
  {id:'all',lk:'sportAll',l:'All',e:'',c:'#C8922A',b:'rgba(200,146,42,.09)'},
  {id:'foot',lk:'sportFoot',l:'Football',e:'',c:'#4ade80',b:'rgba(74,222,128,.07)'},
  {id:'basket',lk:'sportBasket',l:'Basketball',e:'',c:'#f97316',b:'rgba(249,115,22,.07)'},
  {id:'tennis',lk:'sportTennis',l:'Tennis',e:'',c:'#eab308',b:'rgba(234,179,8,.07)'},
  {id:'rugby',lk:'sportRugby',l:'Rugby',e:'',c:'#84cc16',b:'rgba(132,204,22,.07)'},
  {id:'hockey',lk:'sportHockey',l:'Hockey',e:'',c:'#3b82f6',b:'rgba(59,130,246,.07)'},
  {id:'nfl',lk:'sportNFL',l:'American Football',e:'',c:'#f97316',b:'rgba(249,115,22,.07)'},
  {id:'baseball',lk:'sportBaseball',l:'Baseball',e:'',c:'#10b981',b:'rgba(16,185,129,.07)'},
  {id:'other',lk:'sportOther',l:'Other',e:'',c:'#8b949e',b:'rgba(139,148,158,.07)'}
];

// ── STATE ──
var chips = {rot:true,inj:true,form:true,h2h:true,stake:true};
var activeTab = 'flux';
var mode = 'pre';
var activeSports = ['all'];
var lang = localStorage.getItem('sc_lang') || 'en';

// ── LANG ──
var L = {
  en:{
    homeToday:'TODAY',homeLiveNow:'LIVE NOW',homeUpcoming:'TONIGHT',homeTonight:'TONIGHT',homeWatch:'TO WATCH',homeTagline:'SPORT, READ DIFFERENTLY',homeEmptyLive:'No live match right now.',homeEmptyTonight:'No fixtures tonight.',homeEmptyWatch:'Nothing to watch yet.',lectureBannerTitle:'SUPERCOACH READING',lectureBannerSub:'Clear reads. Key facts. Ahead of the play.',lectureDiscover:'Discover',homeExplore:'Explore matches',
    homeReadMatch:'Read the match',homeSeeAll:'See all',homeStartsIn:'Starts in',
    homeNoFeatured:'Nothing live right now — here\'s what\'s coming up',
    navHome:'Home',navMatches:'Matches',navReading:'Reading',navJournal:'Journal',navProfile:'Profile',
    readingEmptyTitle:'No reading yet',readingEmptySub:'Open a match to get SUPERCOACH\'s reading of it.', confLabel:'Confidence', homeKicker:'TODAY',secondHalf:'2nd half', homeVs:'vs', lectureSeeData:'See the data behind this', shareAnalysis:'Share', journalTitle:'Journal',roiVerified:'Verified',roiWinRate:'Win rate',roiUnitsBet:'Units',roiTapHint2:'Tap a match once it\'s over — won or lost.',roiLiveLabel:'Live',
    sportAll:'All',sportFoot:'Football',sportBasket:'Basketball',sportTennis:'Tennis',
    sportRugby:'Rugby',sportMMA:'MMA',sportBoxing:'Boxing',sportHockey:'Hockey',
    sportHandball:'Handball',sportVolley:'Volleyball',sportF1:'F1/Moto',
    sportBaseball:'Baseball',sportNFL:'American Football',sportNBA:'NBA',sportOther:'Other',sportWC:'World Cup',
    manualPlaceholder:'Paste your matches here:\n\nPSG vs Monaco — Ligue 1 — 20:45\nLakers vs Celtics — NBA — 01:30\nSinner vs Alcaraz\n\nAdd time & odds for Value Bet + Kelly',
    oddsHintFull:'→ Value Bet + Kelly',
    footerDesc:'SUPERCOACH is an AI-powered sports analysis tool for informational purposes only. Not financial advice.',
    liveContextLabel:'Additional context (recommended):',
    roiTrackerTitle:'ROI TRACKER',roiTapHint:'Tap each match after the game!',
    roiMatchesLabel:'matches',roiPreLabel:'PRE',clearHistory:'CLEAR HISTORY',
    settingsTitle:'SETTINGS',settingsSectionDisplay:'DISPLAY',settingsSectionAnalysis:'ANALYSIS',
    settingsSectionData:'DATA',settingsSectionLegal:'LEGAL',
    settingsClock24Label:'24h clock format',settingsClock24Sub:'Default: AM/PM',
    settingsDiagLabel2:'Response time bar',settingsDiagSub:'Shows fetch & AI timing',
    settingsSubBetsLabel:'Smart Sub-Bets',settingsSubBetsSub:'Secondary opportunities (≥70%)',
    settingsThresh:'Confidence threshold',settingsThreshVal:'70%',
    settingsClearLabel:'Clear ROI Tracker',settingsClearSub:'Erase all local history',
    settingsApiLabel:'API Status',settingsApiSub:'Test server connection',
    settingsLegalLabel:'Legal & Privacy',settingsGamble:'Responsible gambling 18+',
    urlLabel:'Paste a URL',urlDivider:'or paste text manually',fetchBtn:'FETCH',
    gamble:'GAMBLE RESPONSIBLY · 18+',legalLink:'Legal & Privacy',
    settingsVersion:'SUPERCOACH v9.3 · 2026',
    settingsDiagLabel:'Response time bar',settingsThreshLabel:'Confidence threshold',
    settingsClearRoi:'CLEAR',settingsCheckApi:'CHECK',
    roiEmptyTitle:'No analysis saved yet.',roiEmptySub:'Launch your first analysis to track your ROI!',
    pasteHolder:'Paste raw page content here...',
    matchNotFound:'MATCH NOT VALIDATED',matchNotFoundSub:'Match not found. Please check your input.',
    win:'Win',loss:'Loss',draw:'Draw',free:'FREE',
    preName:'PRE-MATCH',preSub:'Full analysis',liveName:'HALF-TIME',liveSub:'Real-time recalc',
    inputLabel:'Matches to analyze',inputLabelLive:'Live Half-Time Analysis',
    filterSport:'Filter by sport',tabList:'List',tabWeb:'Web page',
    paste:'PASTE FROM CLIPBOARD',oddsLbl:'ODDS',oddsHint:'→ Value Bet + Kelly',
    rot:'C1 Rotations',inj:'Injuries',form:'Form',stake:'Stakes',
    analyze:'ANALYZE',home:'Home ',away:'Away ',comp:'Competition',min:'Minute',
    htScore:'Half-time score',liveOdds:'2nd HALF ODDS',liveBtn:'ANALYZE LIVE',
    roiTitle:'My ROI',roiBtn:'ROI',
    navAnalyze:'Analyze',navRoi:'My ROI',navSettings:'Settings',
    tapDetails:'TAP FOR DETAILS',newAnalysis:'↺ New Analysis',doNotBet:'DO NOT BET',
    units:'UNIT',wins:'Wins',draws:'Draws',losses:'Losses',
    potRoi:'POTENTIAL ROI',analyzing:'ANALYZING...',
    fluxTab:'TODAY',fluxLoading:'Loading matches...',fluxEmpty:'No matches available.',
    fluxSelectBtn:'Analyze selection',fluxNoneSelected:'Select at least 1 match',
    coachTitle:'Coach advice',
    coachFriendly:'Friendly matches have no real stakes. Confidence capped.',
    coachVolume:'Over 5 picks: bookmaker margin multiplies. Edge collapses.',
    coachSniper:'Sniper mode: 3 picks max · conf ≥75% · real competitions only.',
    friendlyWarning:'Friendly',bigParlay:'Large parlay',
    glossGuide:'GUIDE',
    gT1:'C1 Rotations',gS1:'Squad depth & European schedule fatigue.',
    gT2:'Injuries',gS2:'Key absences: GK -10%, Top scorer -8%, Captain -5%.',
    gT3:'Form',gS3:'Last 5 matches. 3+ wins = +5% confidence boost.',
    gT4:'H2H',gS4:'Head-to-head on same surface & venue only.',
    gT5:'Stakes',gS5:'Relegation +15%, Title +10%, Derby = 50/50 reset.'
  ,
    'shareCopied':'Copied! Share on Telegram / WhatsApp',
    'shareLongPress':'Long press → Copy',
    'errNoMatches':'Please enter matches to analyze.',
    'errNoTeams':'Enter both team names.',
    'errParseFail':'AI response could not be parsed. Try with fewer matches.',
    'errParseFailLive':'AI response could not be parsed. Check the teams and score.',
    'analysisFailed':'INCOMPLETE ANALYSIS',
    'authSignInSub':'Sign in to save your analyses','premiumUpgrade':'Go Premium — $29/mo','premiumLoading':'Loading...','premiumLoadingApp':'App is still loading, try again in a moment.','premiumMustLogin':'Sign in first to go Premium.','premiumError':'Error','premiumErrorGeneric':'could not create payment','premiumTimeout':'request timed out, please try again.','trialStartBtn':'Start 7-day free trial','trialStarted':'Free trial started! Enjoy Premium for 7 days.','referralApplied':'Referral applied! +7 days Premium added.','referralLinkCopied':'Invite link copied — send it to a friend!','referralLabel':'Invite a friend, you both get +7 days Premium','referralCopy':'Copy my invite link',
    'authContinueEmail':'Continue with email',
    'authOr':'or',
    'authContinueGoogle':'Continue with Google',
    'authCheckEmail':'Check your email',
    'authMagicSub':'We sent a magic link to',
    'authSignOut':'Sign out',
    'authProfile':'My Profile',
    'langChangeNote':'New language applies to the next analysis','urlDetected':'URL detected - tap Analyze',
    'labTitle':'VERDICT',
    'labStrong':'SOLID PICK',
    'labNeutral':'BALANCED',
    'labRisky':'RISK ALERT',
    'labUnits':'units'},
  fr:{
    homeToday:'AUJOURD\'HUI',homeLiveNow:'EN DIRECT',homeUpcoming:'CE SOIR',homeTonight:'CE SOIR',homeWatch:'À SURVEILLER',homeTagline:'LE SPORT AUTREMENT',lectureBannerTitle:'LECTURE SUPERCOACH',lectureBannerSub:'Des lectures claires. Les faits essentiels. Avant le jeu.',lectureDiscover:'Découvrir',homeEmptyLive:'Aucun match en direct pour le moment.',homeEmptyTonight:'Aucune rencontre ce soir.',homeEmptyWatch:'Rien à surveiller pour l instant.',homeExplore:'Explorer les matchs',
    homeReadMatch:'Lire le match',homeSeeAll:'Voir tout',homeStartsIn:'Commence dans',
    homeNoFeatured:'Rien en direct pour l\'instant — voici ce qui arrive',
    navHome:'Accueil',navMatches:'Matchs',navReading:'Lecture',navJournal:'Journal',navProfile:'Profil',
    readingEmptyTitle:'Aucune lecture pour l\'instant',readingEmptySub:'Ouvre un match pour découvrir la lecture SUPERCOACH.', confLabel:'Confiance', homeKicker:'AUJOURD\'HUI', secondHalf:'2e mi-temps', homeVs:'vs', lectureSeeData:'Voir les données derrière cette lecture', shareAnalysis:'Partager', journalTitle:'Journal',roiVerified:'Vérifiés',roiWinRate:'Taux de réussite',roiUnitsBet:'Unités',roiTapHint2:'Touche un match une fois terminé — gagné ou perdu.',roiLiveLabel:'Live',
    sportAll:'Tous',sportFoot:'Football',sportBasket:'Basket',sportTennis:'Tennis',
    sportRugby:'Rugby',sportMMA:'MMA',sportBoxing:'Boxe',sportHockey:'Hockey',
    sportHandball:'Handball',sportVolley:'Volley',sportF1:'F1/Moto',
    sportBaseball:'Baseball',sportNFL:'Football Americain',sportNBA:'NBA',sportOther:'Autre',sportWC:'Coupe du Monde',
    manualPlaceholder:'Colle tes matchs ici :\n\nPSG vs Monaco — Ligue 1 — 20:45\nLakers vs Celtics — NBA — 01:30\nSinner vs Alcaraz\n\nAjoute heure & cote pour Value Bet + Kelly',
    oddsHintFull:'→ Value Bet + Kelly',
    footerDesc:'SUPERCOACH est un outil analyse sportive IA informatif uniquement. Pas de conseil financier.',
    liveContextLabel:'Contexte additionnel (recommande) :',
    roiTrackerTitle:'SUIVI ROI',roiTapHint:'Appuie sur chaque match apres la partie !',
    roiMatchesLabel:'matchs',roiPreLabel:'PRE',clearHistory:'EFFACER',
    settingsTitle:'REGLAGES',settingsSectionDisplay:'AFFICHAGE',settingsSectionAnalysis:'ANALYSE',
    settingsSectionData:'DONNEES',settingsSectionLegal:'LEGAL',
    settingsClock24Label:'Format horloge 24h',settingsClock24Sub:'Par defaut : AM/PM',
    settingsDiagLabel2:'Barre temps reponse',settingsDiagSub:'Affiche les timings',
    settingsSubBetsLabel:'Smart Sub-Bets',settingsSubBetsSub:'Opportunites secondaires (>=70%)',
    settingsThresh:'Seuil de confiance',settingsThreshVal:'70%',
    settingsClearLabel:'Vider ROI Tracker',settingsClearSub:'Efface historique local',
    settingsApiLabel:'Statut API',settingsApiSub:'Tester connexion serveur',
    settingsLegalLabel:'Mentions legales',settingsGamble:'Jeu responsable 18+',
    urlLabel:'Colle une URL',urlDivider:'ou colle le texte',fetchBtn:'FETCH',
    gamble:'JEU RESPONSABLE · 18+',legalLink:'Legal & Confidentialite',
    settingsVersion:'SUPERCOACH v9.3 · 2026',
    settingsDiagLabel:'Barre temps reponse',settingsThreshLabel:'Seuil confiance',
    settingsClearRoi:'EFFACER',settingsCheckApi:'VERIFIER',
    roiEmptyTitle:'Aucune analyse.',roiEmptySub:'Lance ta premiere analyse !',
    pasteHolder:'Colle le contenu ici...',
    matchNotFound:'MATCH NON VALIDE',matchNotFoundSub:'Match introuvable. Verifie ta saisie.',
    win:'Victoire',loss:'Defaite',draw:'Nul',free:'GRATUIT',
    preName:'AVANT-MATCH',preSub:'Analyse complete',liveName:'MI-TEMPS',liveSub:'Recalcul temps reel',
    inputLabel:'Matchs a analyser',inputLabelLive:'Analyse Live Mi-Temps',
    filterSport:'Filtrer par sport',tabList:'Liste',tabWeb:'Page web',
    paste:'COLLER',oddsLbl:'COTE',oddsHint:'→ Value + Kelly',
    rot:'Rotations C1',inj:'Blesses',form:'Forme',stake:'Enjeu',
    analyze:'ANALYSER',home:'Domicile ',away:'Exterieur ',comp:'Competition',min:'Minute',
    htScore:'Score mi-temps',liveOdds:'COTE 2E MI-TEMPS',liveBtn:'ANALYSER LIVE',
    roiTitle:'Mon ROI',roiBtn:'ROI',
    navAnalyze:'Analyser',navRoi:'Mon ROI',navSettings:'Reglages',
    tapDetails:'APPUYER POUR DETAILS',newAnalysis:'↺ Nouvelle Analyse',doNotBet:'NE PAS PARIER',
    units:'UNITE',wins:'Victoires',draws:'Nuls',losses:'Defaites',
    potRoi:'ROI POTENTIEL',analyzing:'ANALYSE...',
    fluxTab:"AUJOURD'HUI",fluxLoading:'Chargement matchs...',fluxEmpty:'Aucun match disponible.',
    fluxSelectBtn:'Analyser selection',fluxNoneSelected:'Selectionne au moins 1 match',
    coachTitle:'Conseil du Coach',
    coachFriendly:'Les matchs amicaux ont enjeu reel nul. Confiance bridee.',
    coachVolume:'Au-dela 5 picks : marge bookmaker multiplie. Edge effondre.',
    coachSniper:'Mode Sniper : 3 picks max · conf >=75% · competitions reelles.',
    friendlyWarning:'Amical',bigParlay:'Grand combine',
    glossGuide:'GUIDE',
    gT1:'Rotations C1',gS1:'Profondeur banc et fatigue europeenne.',
    gT2:'Blesses',gS2:'Absences cles : GK -10%, Buteur -8%, Capitaine -5%.',
    gT3:'Forme',gS3:'5 derniers matchs. 3 victoires = +5% confiance.',
    gT4:'H2H',gS4:'Confrontations directes meme surface et stade.',
    gT5:'Enjeu',gS5:'Relegation +15%, Titre +10%, Derby = reset 50/50.'
  ,
    'shareCopied':'Copié ! Partage sur Telegram / WhatsApp',
    'shareLongPress':'Appui long → Copier',
    'errNoMatches':'Saisis des matchs à analyser.',
    'errNoTeams':'Saisis les deux équipes.',
    'errParseFail':'Réponse IA non parseable. Essaie avec moins de matchs.',
    'errParseFailLive':'Réponse IA non parseable. Vérifie les équipes et le score.',
    'analysisFailed':'ANALYSE INCOMPLÈTE',
    'authSignInSub':'Connecte-toi pour sauvegarder tes analyses','premiumUpgrade':'Passer Premium — 29$/mois','premiumLoading':'Chargement...','premiumLoadingApp':'Connexion en cours de chargement, réessaie dans 2 secondes.','premiumMustLogin':'Connecte-toi d\'abord pour passer Premium.','premiumError':'Erreur','premiumErrorGeneric':'impossible de créer le paiement','premiumTimeout':'délai dépassé, réessaie.','trialStartBtn':'Essai gratuit 7 jours','trialStarted':'Essai gratuit activé ! Profite du Premium pendant 7 jours.','referralApplied':'Parrainage validé ! +7 jours Premium ajoutés.','referralLinkCopied':'Lien copié — envoie-le à un ami !','referralLabel':'Invite un ami, vous gagnez tous les deux +7 jours Premium','referralCopy':'Copier mon lien d\'invitation',
    'authContinueEmail':'Continuer avec email',
    'authOr':'ou',
    'authContinueGoogle':'Continuer avec Google',
    'authCheckEmail':'Vérifie ta boîte mail',
    'authMagicSub':'Lien magique envoyé à',
    'authSignOut':'Déconnexion',
    'authProfile':'Mon Profil',
    'langChangeNote':'La nouvelle langue s\u2019applique \u00e0 la prochaine analyse',
    'labTitle':'VERDICT',
    'labStrong':'PICK SOLIDE',
    'labNeutral':'EQUILIBRE',
    'labRisky':'ALERTE RISQUE',
    'labUnits':'unites'},
  es:{
    homeToday:'HOY',homeLiveNow:'EN VIVO',homeUpcoming:'ESTA NOCHE',homeTonight:'ESTA NOCHE',homeWatch:'A SEGUIR',homeTagline:'EL DEPORTE DE OTRO MODO',lectureBannerTitle:'LECTURA SUPERCOACH',lectureBannerSub:'Lecturas claras. Datos clave. Antes del partido.',lectureDiscover:'Descubrir',homeEmptyLive:'No hay partido en directo.',homeEmptyTonight:'No hay partidos esta noche.',homeEmptyWatch:'Nada que seguir por ahora.',homeExplore:'Explorar partidos',
    homeReadMatch:'Leer el partido',homeSeeAll:'Ver todo',homeStartsIn:'Empieza en',
    homeNoFeatured:'Nada en vivo ahora — esto es lo que viene',
    navHome:'Inicio',navMatches:'Partidos',navReading:'Lectura',navJournal:'Diario',navProfile:'Perfil',
    readingEmptyTitle:'Aún no hay lectura',readingEmptySub:'Abre un partido para ver la lectura de SUPERCOACH.', confLabel:'Confianza', homeKicker:'HOY',secondHalf:'2ª parte', homeVs:'vs', lectureSeeData:'Ver los datos detrás de esta lectura', shareAnalysis:'Compartir', journalTitle:'Diario',roiVerified:'Verificados',roiWinRate:'Tasa de acierto',roiUnitsBet:'Unidades',roiTapHint2:'Toca un partido cuando termine — ganado o perdido.',roiLiveLabel:'En vivo',
    sportAll:'Todos',sportFoot:'Futbol',sportBasket:'Baloncesto',sportTennis:'Tenis',
    sportRugby:'Rugby',sportMMA:'MMA',sportBoxing:'Boxeo',sportHockey:'Hockey',
    sportHandball:'Balonmano',sportVolley:'Voleibol',sportF1:'F1/Moto',
    sportBaseball:'Beisbol',sportNFL:'Futbol Americano',sportNBA:'NBA',sportOther:'Otro',sportWC:'Copa del Mundo',
    manualPlaceholder:'Pega tus partidos aqui...',oddsHintFull:'→ Value Bet + Kelly',
    footerDesc:'SUPERCOACH es herramienta IA solo informativa.',liveContextLabel:'Contexto adicional:',
    roiTrackerTitle:'SEGUIMIENTO ROI',roiTapHint:'Pulsa en cada partido despues!',
    roiMatchesLabel:'partidos',roiPreLabel:'PRE',clearHistory:'BORRAR',
    settingsTitle:'AJUSTES',settingsSectionDisplay:'VISUALIZACION',settingsSectionAnalysis:'ANALISIS',
    settingsSectionData:'DATOS',settingsSectionLegal:'LEGAL',
    settingsClock24Label:'Formato 24h',settingsClock24Sub:'Por defecto: AM/PM',
    settingsDiagLabel2:'Barra tiempos',settingsDiagSub:'Muestra tiempos',
    settingsSubBetsLabel:'Smart Sub-Bets',settingsSubBetsSub:'Oportunidades secundarias',
    settingsThresh:'Umbral confianza',settingsThreshVal:'70%',
    settingsClearLabel:'Borrar ROI',settingsClearSub:'Borrar historial',
    settingsApiLabel:'Estado API',settingsApiSub:'Probar conexion',
    settingsLegalLabel:'Legal y Privacidad',settingsGamble:'Juego responsable 18+',
    urlLabel:'Pega una URL',urlDivider:'o pega el texto',fetchBtn:'FETCH',
    gamble:'JUEGA RESPONSABLEMENTE · 18+',legalLink:'Legal y Privacidad',
    settingsVersion:'SUPERCOACH v9.3 · 2026',
    settingsDiagLabel:'Barra tiempos',settingsThreshLabel:'Umbral confianza',
    settingsClearRoi:'BORRAR',settingsCheckApi:'VERIFICAR',
    roiEmptyTitle:'Sin analisis.',roiEmptySub:'Lanza tu primer analisis!',
    pasteHolder:'Pega contenido aqui...',
    matchNotFound:'PARTIDO NO VALIDADO',matchNotFoundSub:'Partido no encontrado.',
    win:'Victoria',loss:'Derrota',draw:'Empate',free:'GRATIS',
    preName:'PRE-PARTIDO',preSub:'Analisis completo',liveName:'MEDIO TIEMPO',liveSub:'Recalculo en vivo',
    inputLabel:'Partidos a analizar',inputLabelLive:'Analisis Medio Tiempo',
    filterSport:'Filtrar por deporte',tabList:'Lista',tabWeb:'Pagina web',
    paste:'PEGAR',oddsLbl:'CUOTA',oddsHint:'→ Value Bet + Kelly',
    rot:'Rotaciones C1',inj:'Lesiones',form:'Forma',stake:'Apuestas',
    analyze:'ANALIZAR',home:'Local ',away:'Visitante ',comp:'Competicion',min:'Minuto',
    htScore:'Marcador MT',liveOdds:'CUOTA 2 TIEMPO',liveBtn:'ANALIZAR EN VIVO',
    roiTitle:'Mi ROI',roiBtn:'ROI',
    navAnalyze:'Analizar',navRoi:'Mi ROI',navSettings:'Ajustes',
    tapDetails:'TOCA PARA DETALLES',newAnalysis:'↺ Nuevo Analisis',doNotBet:'NO APOSTAR',
    units:'UNIDAD',wins:'Victorias',draws:'Empates',losses:'Derrotas',
    potRoi:'ROI POTENCIAL',analyzing:'ANALIZANDO...',
    fluxTab:'HOY',fluxLoading:'Cargando partidos...',fluxEmpty:'No hay partidos.',
    fluxSelectBtn:'Analizar seleccion',fluxNoneSelected:'Selecciona al menos 1',
    coachTitle:'Consejo Entrenador',coachFriendly:'Amistosos sin apuestas reales.',
    coachVolume:'Mas de 5 picks: el edge colapsa.',coachSniper:'Sniper: max 3 picks · conf >=75%.',
    friendlyWarning:'Amistoso',bigParlay:'Combinada grande',
    glossGuide:'GUIA',gT1:'Rotaciones C1',gS1:'Profundidad plantilla.',
    gT2:'Lesiones',gS2:'Bajas clave: portero -10%, Goleador -8%, Capitan -5%.',
    gT3:'Forma',gS3:'Ultimos 5 partidos. 3 victorias = +5%.',
    gT4:'H2H',gS4:'Historial misma superficie.',gT5:'Apuesta',gS5:'Descenso +15%, Titulo +10%.'
  ,
    'shareCopied':'Copiado. Comparte en Telegram / WhatsApp',
    'shareLongPress':'Pulsación larga → Copiar',
    'errNoMatches':'Introduce partidos para analizar.',
    'errNoTeams':'Introduce los dos equipos.',
    'errParseFail':'Respuesta IA no parseada. Prueba con menos partidos.',
    'errParseFailLive':'Respuesta IA no parseada. Verifica los equipos y el marcador.',
    'analysisFailed':'ANÁLISIS INCOMPLETO',
    'authSignInSub':'Inicia sesión para guardar tus análisis','premiumUpgrade':'Hazte Premium — 29$/mes','premiumLoading':'Cargando...','premiumLoadingApp':'La app aún está cargando, inténtalo de nuevo en un momento.','premiumMustLogin':'Inicia sesión antes de hacerte Premium.','premiumError':'Error','premiumErrorGeneric':'no se pudo crear el pago','premiumTimeout':'tiempo de espera agotado, inténtalo de nuevo.','trialStartBtn':'Prueba gratis 7 días','trialStarted':'¡Prueba gratuita activada! Disfruta Premium 7 días.','referralApplied':'¡Referido aplicado! +7 días Premium añadidos.','referralLinkCopied':'¡Enlace copiado, envíaselo a un amigo!','referralLabel':'Invita a un amigo, los dos ganan +7 días Premium','referralCopy':'Copiar mi enlace de invitación',
    'authContinueEmail':'Continuar con email',
    'authOr':'o',
    'authContinueGoogle':'Continuar con Google',
    'authCheckEmail':'Revisa tu correo',
    'authMagicSub':'Enlace mágico enviado a',
    'authSignOut':'Cerrar sesión',
    'authProfile':'Mi Perfil',
    'langChangeNote':'El nuevo idioma se aplica al próximo análisis','urlDetected':'URL detectada — toca Analizar',
    'labTitle':'VEREDICTO LAB',
    'labStrong':'PICK SOLIDO',
    'labNeutral':'EQUILIBRADO',
    'labRisky':'ALERTA RIESGO',
    'labUnits':'unidades'},
  pt:{
    homeToday:'HOJE',homeLiveNow:'AO VIVO',homeUpcoming:'ESTA NOITE',homeTonight:'ESTA NOITE',homeWatch:'A SEGUIR',homeTagline:'O DESPORTO DE OUTRA FORMA',lectureBannerTitle:'LEITURA SUPERCOACH',lectureBannerSub:'Leituras claras. Factos essenciais. Antes do jogo.',lectureDiscover:'Descobrir',homeEmptyLive:'Nenhum jogo em direto.',homeEmptyTonight:'Sem jogos esta noite.',homeEmptyWatch:'Nada a seguir por agora.',homeExplore:'Explorar jogos',
    homeReadMatch:'Ler o jogo',homeSeeAll:'Ver tudo',homeStartsIn:'Começa em',
    homeNoFeatured:'Nada ao vivo agora — aqui está o que vem a seguir',
    navHome:'Início',navMatches:'Jogos',navReading:'Leitura',navJournal:'Diário',navProfile:'Perfil',
    readingEmptyTitle:'Ainda sem leitura',readingEmptySub:'Abra um jogo para ver a leitura da SUPERCOACH.', confLabel:'Confiança', homeKicker:'HOJE',secondHalf:'2º tempo', homeVs:'vs', lectureSeeData:'Ver os dados por trás desta leitura', shareAnalysis:'Compartilhar', journalTitle:'Diário',roiVerified:'Verificados',roiWinRate:'Taxa de acerto',roiUnitsBet:'Unidades',roiTapHint2:'Toque num jogo assim que terminar — ganho ou perdido.',roiLiveLabel:'Ao vivo',
    sportAll:'Todos',sportFoot:'Futebol',sportBasket:'Basquete',sportTennis:'Tennis',
    sportRugby:'Rugby',sportMMA:'MMA',sportBoxing:'Boxe',sportHockey:'Hoquei',
    sportHandball:'Handebol',sportVolley:'Volei',sportF1:'F1/Moto',
    sportBaseball:'Beisebol',sportNFL:'Futebol Americano',sportNBA:'NBA',sportOther:'Outro',sportWC:'Copa do Mundo',
    manualPlaceholder:'Cole seus jogos aqui...',oddsHintFull:'→ Value Bet + Kelly',
    footerDesc:'SUPERCOACH e ferramenta IA apenas informativa.',liveContextLabel:'Contexto adicional:',
    roiTrackerTitle:'RASTREADOR ROI',roiTapHint:'Toque em cada jogo apos a partida!',
    roiMatchesLabel:'jogos',roiPreLabel:'PRE',clearHistory:'LIMPAR',
    settingsTitle:'CONFIGURACOES',settingsSectionDisplay:'EXIBICAO',settingsSectionAnalysis:'ANALISE',
    settingsSectionData:'DADOS',settingsSectionLegal:'LEGAL',
    settingsClock24Label:'Formato 24h',settingsClock24Sub:'Padrao: AM/PM',
    settingsDiagLabel2:'Barra tempo',settingsDiagSub:'Mostra tempos',
    settingsSubBetsLabel:'Smart Sub-Bets',settingsSubBetsSub:'Oportunidades secundarias',
    settingsThresh:'Limite confianca',settingsThreshVal:'70%',
    settingsClearLabel:'Limpar ROI',settingsClearSub:'Apagar historico',
    settingsApiLabel:'Status API',settingsApiSub:'Testar conexao',
    settingsLegalLabel:'Legal e Privacidade',settingsGamble:'Jogo responsavel 18+',
    urlLabel:'Cole uma URL',urlDivider:'ou cole o texto',fetchBtn:'FETCH',
    gamble:'JOGUE COM RESPONSABILIDADE · 18+',legalLink:'Legal e Privacidade',
    settingsVersion:'SUPERCOACH v9.3 · 2026',
    settingsDiagLabel:'Barra tempo',settingsThreshLabel:'Limite confianca',
    settingsClearRoi:'LIMPAR',settingsCheckApi:'VERIFICAR',
    roiEmptyTitle:'Nenhuma analise.',roiEmptySub:'Lance sua primeira analise!',
    pasteHolder:'Cole o conteudo aqui...',
    matchNotFound:'JOGO NAO VALIDADO',matchNotFoundSub:'Jogo nao encontrado.',
    win:'Vitoria',loss:'Derrota',draw:'Empate',free:'GRATIS',
    preName:'PRE-JOGO',preSub:'Analise completa',liveName:'INTERVALO',liveSub:'Recalculo tempo real',
    inputLabel:'Jogos para analisar',inputLabelLive:'Analise Intervalo',
    filterSport:'Filtrar por esporte',tabList:'Lista',tabWeb:'Pagina web',
    paste:'COLAR',oddsLbl:'ODD',oddsHint:'→ Value Bet + Kelly',
    rot:'Rotacoes C1',inj:'Lesoes',form:'Forma',stake:'Importancia',
    analyze:'ANALISAR',home:'Casa ',away:'Fora ',comp:'Competicao',min:'Minuto',
    htScore:'Placar intervalo',liveOdds:'ODD 2 TEMPO',liveBtn:'ANALISAR AO VIVO',
    roiTitle:'Meu ROI',roiBtn:'ROI',
    navAnalyze:'Analisar',navRoi:'Meu ROI',navSettings:'Config',
    tapDetails:'TOQUE PARA DETALHES',newAnalysis:'↺ Nova Analise',doNotBet:'NAO APOSTAR',
    units:'UNIDADE',wins:'Vitorias',draws:'Empates',losses:'Derrotas',
    potRoi:'ROI POTENCIAL',analyzing:'ANALISANDO...',
    fluxTab:'HOJE',fluxLoading:'Carregando partidas...',fluxEmpty:'Nenhuma partida.',
    fluxSelectBtn:'Analisar selecao',fluxNoneSelected:'Selecione pelo menos 1',
    coachTitle:'Conselho Treinador',coachFriendly:'Amistosos sem apostas reais.',
    coachVolume:'Mais de 5 palpites: o edge colapsa.',coachSniper:'Sniper: max 3 · conf >=75%.',
    friendlyWarning:'Amistoso',bigParlay:'Multipla grande',
    glossGuide:'GUIA',gT1:'Rotacoes C1',gS1:'Profundidade elenco.',
    gT2:'Lesoes',gS2:'Ausencias: Goleiro -10%, Artilheiro -8%, Capitao -5%.',
    gT3:'Forma',gS3:'Ultimos 5 jogos. 3 vitorias = +5%.',
    gT4:'H2H',gS4:'Confrontos mesma superficie.',gT5:'Apostas',gS5:'Rebaixamento +15%, Titulo +10%.'
  ,
    'shareCopied':'Copiado! Compartilhe no Telegram / WhatsApp',
    'shareLongPress':'Toque longo → Copiar',
    'errNoMatches':'Insere jogos para analisar.',
    'errNoTeams':'Insere os dois times.',
    'errParseFail':'Resposta IA não parseada. Tenta com menos jogos.',
    'errParseFailLive':'Resposta IA não parseada. Verifica os times e o placar.',
    'analysisFailed':'ANÁLISE INCOMPLETA',
    'authSignInSub':'Entre para salvar suas análises','premiumUpgrade':'Seja Premium — 29$/mês','premiumLoading':'Carregando...','premiumLoadingApp':'O app ainda está carregando, tente novamente em instantes.','premiumMustLogin':'Faça login antes de virar Premium.','premiumError':'Erro','premiumErrorGeneric':'não foi possível criar o pagamento','premiumTimeout':'tempo esgotado, tente novamente.','trialStartBtn':'Teste grátis 7 dias','trialStarted':'Teste grátis ativado! Aproveite o Premium por 7 dias.','referralApplied':'Indicação aplicada! +7 dias Premium adicionados.','referralLinkCopied':'Link copiado — envie para um amigo!','referralLabel':'Convide um amigo, os dois ganham +7 dias Premium','referralCopy':'Copiar meu link de convite',
    'authContinueEmail':'Continuar com email',
    'authOr':'ou',
    'authContinueGoogle':'Continuar com Google',
    'authCheckEmail':'Verifique seu email',
    'authMagicSub':'Link mágico enviado para',
    'authSignOut':'Sair',
    'authProfile':'Meu Perfil',
    'langChangeNote':'O novo idioma aplica-se à próxima análise','urlDetected':'URL detectada — toque Analisar',
    'labTitle':'VEREDICTO LAB',
    'labStrong':'PICK SOLIDO',
    'labNeutral':'EQUILIBRADO',
    'labRisky':'ALERTA RISCO',
    'labUnits':'unidades'},
  it:{
    homeToday:'OGGI',homeLiveNow:'IN DIRETTA',homeUpcoming:'STASERA',homeTonight:'STASERA',homeWatch:'DA SEGUIRE',homeTagline:'LO SPORT ALTRIMENTI',lectureBannerTitle:'LETTURA SUPERCOACH',lectureBannerSub:'Letture chiare. Fatti essenziali. Prima della partita.',lectureDiscover:'Scopri',homeEmptyLive:'Nessun match in diretta.',homeEmptyTonight:'Nessun match stasera.',homeEmptyWatch:'Niente da seguire per ora.',homeExplore:'Esplora le partite',
    homeReadMatch:'Leggi la partita',homeSeeAll:'Vedi tutto',homeStartsIn:'Inizia tra',
    homeNoFeatured:'Niente in diretta ora — ecco cosa arriva',
    navHome:'Home',navMatches:'Partite',navReading:'Lettura',navJournal:'Diario',navProfile:'Profilo',
    readingEmptyTitle:'Ancora nessuna lettura',readingEmptySub:'Apri una partita per vedere la lettura di SUPERCOACH.', confLabel:'Fiducia', homeKicker:'OGGI',secondHalf:'2° tempo', homeVs:'vs', lectureSeeData:'Vedi i dati dietro questa lettura', shareAnalysis:'Condividi', journalTitle:'Diario',roiVerified:'Verificati',roiWinRate:'Tasso di successo',roiUnitsBet:'Unità',roiTapHint2:'Tocca una partita a fine gara — vinta o persa.',roiLiveLabel:'Live',
    sportAll:'Tutti',sportFoot:'Calcio',sportBasket:'Basket',sportTennis:'Tennis',
    sportRugby:'Rugby',sportMMA:'MMA',sportBoxing:'Boxe',sportHockey:'Hockey',
    sportHandball:'Pallamano',sportVolley:'Pallavolo',sportF1:'F1/Moto',
    sportBaseball:'Baseball',sportNFL:'Football Americano',sportNBA:'NBA',sportOther:'Altro',sportWC:'Coppa del Mondo',
    manualPlaceholder:'Incolla le partite qui...',oddsHintFull:'→ Value Bet + Kelly',
    footerDesc:'SUPERCOACH e strumento IA solo informativo.',liveContextLabel:'Contesto aggiuntivo:',
    roiTrackerTitle:'TRACKER ROI',roiTapHint:'Tocca dopo il gioco!',
    roiMatchesLabel:'partite',roiPreLabel:'PRE',clearHistory:'CANCELLA',
    settingsTitle:'IMPOSTAZIONI',settingsSectionDisplay:'VISUALIZZAZIONE',settingsSectionAnalysis:'ANALISI',
    settingsSectionData:'DATI',settingsSectionLegal:'LEGALE',
    settingsClock24Label:'Formato 24h',settingsClock24Sub:'Predefinito: AM/PM',
    settingsDiagLabel2:'Barra tempi',settingsDiagSub:'Mostra tempi',
    settingsSubBetsLabel:'Smart Sub-Bets',settingsSubBetsSub:'Opportunita secondarie',
    settingsThresh:'Soglia confidenza',settingsThreshVal:'70%',
    settingsClearLabel:'Svuota ROI',settingsClearSub:'Cancella cronologia',
    settingsApiLabel:'Stato API',settingsApiSub:'Testa connessione',
    settingsLegalLabel:'Legale',settingsGamble:'Gioco responsabile 18+',
    urlLabel:'URL',urlDivider:'o incolla il testo',fetchBtn:'FETCH',
    gamble:'GIOCA RESPONSABILMENTE · 18+',legalLink:'Legal',
    settingsVersion:'SUPERCOACH v9.3 · 2026',
    settingsDiagLabel:'Barra tempi',settingsThreshLabel:'Soglia confidenza',
    settingsClearRoi:'CANCELLA',settingsCheckApi:'VERIFICA',
    roiEmptyTitle:'Nessuna analisi.',roiEmptySub:'Le analisi appariranno qui.',
    pasteHolder:'Incolla URL o contenuto...',
    matchNotFound:'PARTITA NON TROVATA',matchNotFoundSub:'Partita non trovata.',
    win:'V',loss:'S',draw:'P',free:'GRATIS',
    preName:'PRE-MATCH',preSub:'Analisi pre-partita',liveName:'LIVE',liveSub:'Analisi in tempo reale',
    inputLabel:'Inserisci le partite',inputLabelLive:'Punteggio live',
    filterSport:'Tutti gli sport',tabList:'LISTA',tabWeb:'WEB PAGE',
    paste:'INCOLLA',oddsLbl:'QUOTE',oddsHint:'→ Value + Kelly',
    rot:'Rotazioni',inj:'Infortuni',form:'Forma',stake:'Posta',
    analyze:'ANALIZZA',home:'Casa',away:'Trasferta',comp:'Comp.',min:'Min',
    htScore:'Intervallo',liveOdds:'Quote live',liveBtn:'LIVE',
    roiTitle:'Il mio ROI',roiBtn:'ROI',
    navAnalyze:'ANALIZZA',navRoi:'Il mio ROI',navSettings:'IMPOSTAZIONI',
    tapDetails:'TOCCA PER DETTAGLI',newAnalysis:'↺ Nuova analisi',doNotBet:'NON SCOMMETTERE',
    units:'UNITA',wins:'Vittorie',draws:'Pareggi',losses:'Sconfitte',
    potRoi:'ROI POTENZIALE',analyzing:'Analisi...',
    fluxTab:'OGGI',fluxLoading:'Caricamento...',fluxEmpty:'Nessuna partita.',
    fluxSelectBtn:'Analizza selezione',fluxNoneSelected:'Seleziona almeno 1',
    coachTitle:'Consiglio Coach',coachFriendly:'Amichevoli senza posta reale.',
    coachVolume:'Oltre 5 pronostici: il margine moltiplica.',coachSniper:'Sniper: max 3 · conf >=75%.',
    friendlyWarning:'Amichevole',bigParlay:'Combinata grande',
    glossGuide:'GUIDA',gT1:'Rotazioni C1',gS1:'Profondita rosa.',
    gT2:'Infortuni',gS2:'Portiere -10%, Cannoniere -8%, Capitano -5%.',
    gT3:'Forma',gS3:'Ultimi 5 match. 3 vittorie = +5%.',
    gT4:'H2H',gS4:'Scontri stessa superficie.',gT5:'Posta',gS5:'Retrocessione +15%, Titolo +10%.'
  ,
    'shareCopied':'Copiato! Condividi su Telegram / WhatsApp',
    'shareLongPress':'Tieni premuto → Copia',
    'errNoMatches':'Inserisci le partite da analizzare.',
    'errNoTeams':'Inserisci entrambe le squadre.',
    'errParseFail':'Risposta IA non elaborata. Prova con meno partite.',
    'errParseFailLive':'Risposta IA non elaborata. Verifica squadre e punteggio.',
    'analysisFailed':'ANALISI INCOMPLETA',
    'authSignInSub':'Accedi per salvare le tue analisi','premiumUpgrade':'Passa a Premium — 29$/mese','premiumLoading':'Caricamento...','premiumLoadingApp':'L\'app è ancora in caricamento, riprova tra poco.','premiumMustLogin':'Accedi prima di passare a Premium.','premiumError':'Errore','premiumErrorGeneric':'impossibile creare il pagamento','premiumTimeout':'tempo scaduto, riprova.','trialStartBtn':'Prova gratis 7 giorni','trialStarted':'Prova gratuita attivata! Goditi Premium per 7 giorni.','referralApplied':'Invito applicato! +7 giorni Premium aggiunti.','referralLinkCopied':'Link copiato — invialo a un amico!','referralLabel':'Invita un amico, guadagnate entrambi +7 giorni Premium','referralCopy':'Copia il mio link di invito',
    'authContinueEmail':'Continua con email',
    'authOr':'o',
    'authContinueGoogle':'Continua con Google',
    'authCheckEmail':'Controlla la tua email',
    'authMagicSub':'Link magico inviato a',
    'authSignOut':'Esci',
    'authProfile':'Il mio Profilo',
    'langChangeNote':'La nuova lingua si applica alla prossima analisi','urlDetected':'URL rilevato — tocca Analizza',
    'labTitle':'VERDETTO LAB',
    'labStrong':'PICK SOLIDO',
    'labNeutral':'EQUILIBRATO',
    'labRisky':'ALLERTA RISCHIO',
    'labUnits':'unita'},
  de:{
    homeToday:'HEUTE',homeLiveNow:'LIVE',homeUpcoming:'HEUTE ABEND',homeTonight:'HEUTE ABEND',homeWatch:'BEOBACHTEN',homeTagline:'SPORT ANDERS GELESEN',lectureBannerTitle:'SUPERCOACH LESUNG',lectureBannerSub:'Klare Lesarten. Wichtige Fakten. Vor dem Spiel.',lectureDiscover:'Entdecken',homeEmptyLive:'Kein Live-Spiel.',homeEmptyTonight:'Keine Spiele heute Abend.',homeEmptyWatch:'Nichts zu beobachten.',homeExplore:'Spiele entdecken',
    homeReadMatch:'Spiel lesen',homeSeeAll:'Alle anzeigen',homeStartsIn:'Beginnt in',
    homeNoFeatured:'Gerade nichts live — das kommt als Nächstes',
    navHome:'Start',navMatches:'Spiele',navReading:'Lesung',navJournal:'Journal',navProfile:'Profil',
    readingEmptyTitle:'Noch keine Lesung',readingEmptySub:'Öffne ein Spiel, um die SUPERCOACH-Lesung zu sehen.', confLabel:'Konfidenz', homeKicker:'HEUTE',secondHalf:'2. Halbzeit', homeVs:'vs', lectureSeeData:'Die Daten hinter dieser Lesung ansehen', shareAnalysis:'Teilen', journalTitle:'Journal',roiVerified:'Bestätigt',roiWinRate:'Trefferquote',roiUnitsBet:'Einheiten',roiTapHint2:'Tippe ein Spiel nach Abpfiff an — gewonnen oder verloren.',roiLiveLabel:'Live',
    sportAll:'Alle',sportFoot:'Fussball',sportBasket:'Basketball',sportTennis:'Tennis',
    sportRugby:'Rugby',sportMMA:'MMA',sportBoxing:'Boxen',sportHockey:'Eishockey',
    sportHandball:'Handball',sportVolley:'Volleyball',sportF1:'F1/Moto',
    sportBaseball:'Baseball',sportNFL:'American Football',sportNBA:'NBA',sportOther:'Andere',sportWC:'Weltmeisterschaft',
    manualPlaceholder:'Spiele hier eingeben...',oddsHintFull:'→ Value Bet + Kelly',
    footerDesc:'SUPERCOACH ist ein KI-Sportanalyse-Tool nur zu Informationszwecken.',
    liveContextLabel:'Zusatzlicher Kontext:',
    roiTrackerTitle:'ROI-TRACKER',roiTapHint:'Tippe nach jedem Spiel!',
    roiMatchesLabel:'Spiele',roiPreLabel:'PRE',clearHistory:'LOSCHEN',
    settingsTitle:'EINSTELLUNGEN',settingsSectionDisplay:'ANZEIGE',settingsSectionAnalysis:'ANALYSE',
    settingsSectionData:'DATEN',settingsSectionLegal:'LEGAL',
    settingsClock24Label:'24h-Format',settingsClock24Sub:'Standard: AM/PM',
    settingsDiagLabel2:'Zeitenleiste',settingsDiagSub:'Zeigt Fetch- und KI-Zeiten',
    settingsSubBetsLabel:'Smart Sub-Bets',settingsSubBetsSub:'Nebenwetten',
    settingsThresh:'Vertrauensschwelle',settingsThreshVal:'70%',
    settingsClearLabel:'ROI leeren',settingsClearSub:'Verlauf loschen',
    settingsApiLabel:'API-Status',settingsApiSub:'Serververbindung testen',
    settingsLegalLabel:'Legal & Datenschutz',settingsGamble:'Verantwortungsvoll spielen 18+',
    urlLabel:'URL einfugen',urlDivider:'oder Text einfugen',fetchBtn:'LADEN',
    gamble:'VERANTWORTUNGSVOLL SPIELEN · 18+',legalLink:'Legal',
    settingsVersion:'SUPERCOACH v9.3 · 2026',
    settingsDiagLabel:'Zeitenleiste',settingsThreshLabel:'Vertrauensschwelle',
    settingsClearRoi:'LOSCHEN',settingsCheckApi:'PRUFEN',
    roiEmptyTitle:'Keine Analysen.',roiEmptySub:'Deine Analysen erscheinen hier.',
    pasteHolder:'URL oder Seiteninhalt einfugen...',
    matchNotFound:'SPIEL NICHT GEFUNDEN',matchNotFoundSub:'Spiel nicht gefunden.',
    win:'S',loss:'N',draw:'U',free:'KOSTENLOS',
    preName:'PRE-MATCH',preSub:'Vor-Spiel-Analyse',liveName:'LIVE',liveSub:'Live-Analyse',
    inputLabel:'Spiele eingeben',inputLabelLive:'Live-Ergebnis',
    filterSport:'Alle Sportarten',tabList:'LISTE',tabWeb:'WEBSEITE',
    paste:'EINFUGEN',oddsLbl:'QUOTEN',oddsHint:'→ Value + Kelly',
    rot:'C1-Rotation',inj:'Verletzungen',form:'Form',stake:'Einsatz',
    analyze:'ANALYSIEREN',home:'Heim',away:'Auswarts',comp:'Wettb.',min:'Min',
    htScore:'Halbzeit',liveOdds:'Live-Quoten',liveBtn:'LIVE',
    roiTitle:'Mein ROI',roiBtn:'ROI',
    navAnalyze:'ANALYSIEREN',navRoi:'MEIN ROI',navSettings:'EINSTELLUNGEN',
    tapDetails:'TIPPE FUR DETAILS',newAnalysis:'↺ Neue Analyse',doNotBet:'NICHT WETTEN',
    units:'EINHEIT',wins:'Siege',draws:'Unentschieden',losses:'Niederlagen',
    potRoi:'POTENZIELLER ROI',analyzing:'Analyse...',
    fluxTab:'HEUTE',fluxLoading:'Spiele werden geladen...',fluxEmpty:'Keine Spiele.',
    fluxSelectBtn:'Auswahl analysieren',fluxNoneSelected:'Mindestens 1 Spiel',
    coachTitle:'Coach-Tipp',coachFriendly:'Freundschaftsspiele ohne echte Einsatze.',
    coachVolume:'Uber 5 Picks: Buchmacher-Marge multipliziert.',coachSniper:'Sniper: max 3 · Vertr. >=75%.',
    friendlyWarning:'Freundschaftsspiel',bigParlay:'Grosse Kombiwette',
    glossGuide:'ANLEITUNG',gT1:'C1-Rotationen',gS1:'Kadertiefe und Mudigkeit.',
    gT2:'Verletzungen',gS2:'TW -10%, Torjager -8%, Kapitan -5%.',
    gT3:'Form',gS3:'Letzte 5 Spiele. 3 Siege = +5%.',
    gT4:'H2H',gS4:'Direktvergleich gleiche Oberflache.',gT5:'Einsatz',gS5:'Abstieg +15%, Titel +10%.'
  ,
    'shareCopied':'Kopiert! Teile auf Telegram / WhatsApp',
    'shareLongPress':'Lang drücken → Kopieren',
    'errNoMatches':'Gib Spiele zum Analysieren ein.',
    'errNoTeams':'Gib beide Mannschaften ein.',
    'errParseFail':'KI-Antwort nicht verarbeitet. Versuche mit weniger Spielen.',
    'errParseFailLive':'KI-Antwort nicht verarbeitet. Prüfe die Mannschaften und das Ergebnis.',
    'analysisFailed':'ANALYSE UNVOLLSTÄNDIG',
    'authSignInSub':'Einloggen zum Speichern deiner Analysen','premiumUpgrade':'Premium werden — 29$/Monat','premiumLoading':'Lädt...','premiumLoadingApp':'App lädt noch, versuch es gleich nochmal.','premiumMustLogin':'Melde dich zuerst an, um Premium zu werden.','premiumError':'Fehler','premiumErrorGeneric':'Zahlung konnte nicht erstellt werden','premiumTimeout':'Zeitüberschreitung, bitte erneut versuchen.','trialStartBtn':'7 Tage kostenlos testen','trialStarted':'Testphase gestartet! Genieße 7 Tage Premium.','referralApplied':'Empfehlung angewendet! +7 Tage Premium hinzugefügt.','referralLinkCopied':'Link kopiert — schick ihn einem Freund!','referralLabel':'Lade einen Freund ein, ihr bekommt beide +7 Tage Premium','referralCopy':'Meinen Einladungslink kopieren',
    'authContinueEmail':'Mit Email fortfahren',
    'authOr':'oder',
    'authContinueGoogle':'Mit Google fortfahren',
    'authCheckEmail':'Überprüfe deine Email',
    'authMagicSub':'Magic Link gesendet an',
    'authSignOut':'Abmelden',
    'authProfile':'Mein Profil',
    'langChangeNote':'Die neue Sprache gilt für die nächste Analyse','urlDetected':'URL erkannt — tippe Analysieren',
    'labTitle':'LAB URTEIL',
    'labStrong':'STARKER PICK',
    'labNeutral':'AUSGEWOGEN',
    'labRisky':'RISIKO ALARM',
    'labUnits':'Einheiten'},
  ar:{
    homeToday:'اليوم',homeLiveNow:'مباشر',homeUpcoming:'الليلة',homeTonight:'الليلة',homeWatch:'للمتابعة',homeTagline:'الرياضة بشكل آخر',lectureBannerTitle:'قراءة سوبركوتش',lectureBannerSub:'قراءات واضحة. حقائق أساسية. قبل المباراة.',lectureDiscover:'اكتشف',homeEmptyLive:'لا توجد مباراة مباشرة.',homeEmptyTonight:'لا مباريات الليلة.',homeEmptyWatch:'لا شيء للمتابعة.',homeExplore:'استكشف المباريات',
    homeReadMatch:'اقرأ المباراة',homeSeeAll:'عرض الكل',homeStartsIn:'يبدأ خلال',
    homeNoFeatured:'لا يوجد بث مباشر الآن — إليك ما هو قادم',
    navHome:'الرئيسية',navMatches:'المباريات',navReading:'القراءة',navJournal:'السجل',navProfile:'الملف الشخصي',
    readingEmptyTitle:'لا توجد قراءة بعد',readingEmptySub:'افتح مباراة لرؤية قراءة SUPERCOACH لها.', confLabel:'الثقة', homeKicker:'اليوم',secondHalf:'الشوط الثاني', homeVs:'ضد', lectureSeeData:'رؤية البيانات الكاملة', shareAnalysis:'مشاركة', journalTitle:'السجل',roiVerified:'موثّق',roiWinRate:'نسبة الفوز',roiUnitsBet:'الوحدات',roiTapHint2:'اضغط على المباراة بعد انتهائها — فوز أو خسارة.',roiLiveLabel:'مباشر',
    sportAll:'الكل',sportFoot:'كرة القدم',sportBasket:'كرة السلة',sportTennis:'التنس',
    sportRugby:'الرغبي',sportMMA:'MMA',sportBoxing:'الملاكمة',sportHockey:'الهوكي',
    sportHandball:'كرة اليد',sportVolley:'الكرة الطائرة',sportF1:'F1',
    sportBaseball:'البيسبول',sportNFL:'كرة القدم الامريكية',sportNBA:'NBA',sportOther:'اخرى',sportWC:'كاس العالم',
    manualPlaceholder:'ادخل مبارياتك هنا...',oddsHintFull:'→ Value + Kelly',
    footerDesc:'SUPERCOACH اداة IA اعلامية فقط.',liveContextLabel:'سياق اضافي:',
    roiTrackerTitle:'متتبع العائد',roiTapHint:'اضغط على كل مباراة!',
    roiMatchesLabel:'مباريات',roiPreLabel:'قبل',clearHistory:'مسح',
    settingsTitle:'الاعدادات',settingsSectionDisplay:'العرض',settingsSectionAnalysis:'التحليل',
    settingsSectionData:'البيانات',settingsSectionLegal:'قانوني',
    settingsClock24Label:'تنسيق 24',settingsClock24Sub:'الافتراضي: AM/PM',
    settingsDiagLabel2:'شريط الوقت',settingsDiagSub:'توقيت الجلب والذكاء',
    settingsSubBetsLabel:'رهانات ذكية',settingsSubBetsSub:'فرص ثانوية',
    settingsThresh:'حد الثقة',settingsThreshVal:'70%',
    settingsClearLabel:'مسح ROI',settingsClearSub:'حذف السجل',
    settingsApiLabel:'حالة الخادم',settingsApiSub:'اختبار الاتصال',
    settingsLegalLabel:'القانوني',settingsGamble:'المقامرة المسؤولة 18+',
    urlLabel:'الصق رابط',urlDivider:'او الصق النص',fetchBtn:'جلب',
    gamble:'المقامرة المسؤولة · 18+',legalLink:'القانوني',
    settingsVersion:'SUPERCOACH v9.3 · 2026',
    settingsDiagLabel:'شريط الوقت',settingsThreshLabel:'حد الثقة',
    settingsClearRoi:'مسح',settingsCheckApi:'فحص',
    roiEmptyTitle:'لا توجد تحليلات.',roiEmptySub:'ابدا تحليلك الاول!',
    pasteHolder:'الصق المحتوى هنا...',
    matchNotFound:'المباراة غير مؤكدة',matchNotFoundSub:'لم يتم العثور على المباراة.',
    win:'فوز',loss:'خسارة',draw:'تعادل',free:'مجاني',
    preName:'قبل المباراة',preSub:'تحليل كامل',liveName:'نصف الوقت',liveSub:'اعادة حساب',
    inputLabel:'مباريات للتحليل',inputLabelLive:'تحليل نصف الوقت',
    filterSport:'تصفية',tabList:'قائمة',tabWeb:'صفحة ويب',
    paste:'لصق',oddsLbl:'الحصة',oddsHint:'→ قيمة + كيلي',
    rot:'تدوير C1',inj:'اصابات',form:'الشكل',stake:'الرهانات',
    analyze:'تحليل',home:'المضيف ',away:'الضيف ',comp:'البطولة',min:'الدقيقة',
    htScore:'نتيجة نصف الوقت',liveOdds:'حصة الشوط الثاني',liveBtn:'تحليل مباشر',
    roiTitle:'عائدي',roiBtn:'ROI',
    navAnalyze:'تحليل',navRoi:'عائدي',navSettings:'اعدادات',
    tapDetails:'اضغط للتفاصيل',newAnalysis:'↺ تحليل جديد',doNotBet:'لا تراهن',
    units:'وحدة',wins:'انتصارات',draws:'تعادلات',losses:'خسائر',
    potRoi:'العائد المحتمل',analyzing:'جار التحليل...',
    fluxTab:'اليوم',fluxLoading:'جار تحميل المباريات...',fluxEmpty:'لا توجد مباريات.',
    fluxSelectBtn:'تحليل الاختيار',fluxNoneSelected:'اختر مباراة واحدة',
    coachTitle:'نصيحة المدرب',coachFriendly:'المباريات الودية لا رهانات.',
    coachVolume:'اكثر من 5 اختيارات: الميزة تنهار.',coachSniper:'وضع القناص: 3 اختيارات كحد اقصى.',
    friendlyWarning:'مباراة ودية',bigParlay:'مجموع كبير',
    glossGuide:'دليل',gT1:'تناوب دوري الابطال',gS1:'عمق الفريق.',
    gT2:'الاصابات',gS2:'حارس -10%، هداف -8%، قائد -5%.',
    gT3:'الشكل',gS3:'5 مباريات. 3 انتصارات = +5%.',
    gT4:'المواجهات',gS4:'السجل المباشر.',gT5:'الرهان',gS5:'الهبوط +15%، اللقب +10%.'
  ,
    'shareCopied':'تم النسخ! شارك على تيليغرام',
    'shareLongPress':'اضغط طويلاً → نسخ',
    'errNoMatches':'أدخل مباريات للتحليل.',
    'errNoTeams':'أدخل اسمي الفريقين.',
    'errParseFail':'لم يتم معالجة استجابة الذكاء الاصطناعي. جرب مع مباريات أقل.',
    'errParseFailLive':'لم تتم معالجة الاستجابة. تحقق من الفرق والنتيجة.',
    'analysisFailed':'تحليل غير مكتمل',
    'authSignInSub':'سجل دخولك لحفظ تحليلاتك','premiumUpgrade':'الترقية إلى بريميوم — 29$/شهر','premiumLoading':'جارٍ التحميل...','premiumLoadingApp':'التطبيق لا يزال قيد التحميل، حاول مرة أخرى بعد قليل.','premiumMustLogin':'سجّل الدخول أولاً للترقية إلى بريميوم.','premiumError':'خطأ','premiumErrorGeneric':'تعذر إنشاء الدفع','premiumTimeout':'انتهت مهلة الطلب، حاول مرة أخرى.','trialStartBtn':'تجربة مجانية 7 أيام','trialStarted':'بدأت التجربة المجانية! استمتع ببريميوم لمدة 7 أيام.','referralApplied':'تم تطبيق الإحالة! تمت إضافة 7 أيام بريميوم.','referralLinkCopied':'تم نسخ الرابط — أرسله لصديق!','referralLabel':'ادعُ صديقًا واحصلا معًا على 7 أيام بريميوم','referralCopy':'نسخ رابط الدعوة',
    'authContinueEmail':'المتابعة بالبريد',
    'authOr':'أو',
    'authContinueGoogle':'المتابعة مع Google',
    'authCheckEmail':'تحقق من بريدك',
    'authMagicSub':'تم إرسال الرابط إلى',
    'authSignOut':'تسجيل الخروج',
    'authProfile':'ملفي',
    'langChangeNote':'اللغة الجديدة تُطبَّق على التحليل التالي','urlDetected':'تم اكتشاف الرابط — اضغط تحليل',
    'labTitle':'حكم المختبر',
    'labStrong':'اختيار قوي',
    'labNeutral':'متوازن',
    'labRisky':'تحذير خطر',
    'labUnits':'وحدات'}
};

function t(k){return (L[lang]||L.en)[k]||L.en[k]||k;}

function applyLang(){
  document.body.style.direction = lang==='ar'?'rtl':'ltr';
  setText('homeUpcomingLbl',t('homeUpcoming'));setText('homeSeeAllLbl',t('homeSeeAll'));
  setText('homeExploreLbl',t('homeExplore'));setText('homeReadMatchLbl',t('homeReadMatch'));
  setText('homeLiveTitle',t('homeLiveNow'));
  setText('homeTonightLbl',t('homeTonight')||t('homeUpcoming'));
  setText('homeWatchLbl',t('homeWatch')||'A SURVEILLER');
  setText('homeSeeAllLive',t('homeSeeAll'));
  setText('homeSeeAllTonight',t('homeSeeAll'));
  setText('homeSeeAllWatch',t('homeSeeAll'));
  setText('homeTagline',t('homeTagline')||'LE SPORT AUTREMENT');
  setText('homeLiveEmpty',t('homeEmptyLive')||'');
  setText('homeTonightEmpty',t('homeEmptyTonight')||'');
  setText('homeWatchEmpty',t('homeEmptyWatch')||'');
  setText('lectureBannerTitle',t('lectureBannerTitle')||'LECTURE SUPERCOACH');
  setText('lectureBannerSub',t('lectureBannerSub')||'');
  setText('lectureDiscoverLbl',t('lectureDiscover')||'');

  setText('homeKicker',t('homeKicker'));
  setText('badgeFree',t('free'));
  setText('mPreTitle',t('preName'));setText('mPreSub',t('preSub'));
  setText('mLiveTitle',t('liveName'));setText('mLiveSub',t('liveSub'));
  setText('inputLabel',mode==='live'?t('inputLabelLive'):t('inputLabel'));
  setText('sportFilterLbl',t('filterSport'));
  setText('tabListLbl',t('tabList'));setText('tabWebLbl',t('tabWeb'));
  setText('pasteBtnLbl',t('paste'));
  setText('oddsLbl',t('oddsLbl'));setText('oddsHint',t('oddsHint'));
  setText('cRotLbl',t('rot'));setText('cInjLbl',t('inj'));setText('cFormLbl',t('form'));setText('cStakeLbl',t('stake'));
  setText('goBtnLbl',t('analyze'));
  setText('homeLbl',t('home'));setText('awayLbl',t('away'));
  setText('compLbl',t('comp'));setText('minLbl',t('min'));
  setText('htScoreLbl',t('htScore'));setText('liveOddsLbl',t('liveOdds'));setText('liveBtnLbl',t('liveBtn'));
  setText('roiTitle',t('roiTitle'));setText('roiBtn',t('roiBtn'));
  setText('navHomeLbl',t('navHome'));setText('navMatchesLbl',t('navMatches'));setText('navReadingLbl',t('navReading'));
  setText('navJournalLbl',t('navJournal'));setText('navProfileLbl',t('navProfile'));
  setText('premiumUpgradeLbl',t('premiumUpgrade'));
  setText('trialStartLbl',t('trialStartBtn'));
  setText('referralLbl',t('referralLabel'));
  setText('referralCopyLbl',t('referralCopy'));
  // Update lang selector
  var btn = document.getElementById('langBtn');
  var names = {en:'EN',fr:'FR',es:'ES',pt:'PT',ar:'AR',it:'IT',de:'DE'};
  if(btn) btn.textContent = names[lang]||'EN';
  document.querySelectorAll('.lang-opt').forEach(function(o){
    o.classList.toggle('active', o.getAttribute('data-l')===lang);
  });
  // Nouveaux éléments traduits
  var ph = document.getElementById('pasteHolder');
  if(ph) ph.placeholder = t('pasteHolder');
  var fsl = document.getElementById('filterSportLabel');
  if(fsl) fsl.textContent = t('filterSport');
  // URL fetch
  var el;
  el=document.getElementById('urlLabelEl'); if(el) el.textContent=t('urlLabel');
  el=document.getElementById('urlDividerEl'); if(el) el.textContent=t('urlDivider');
  el=document.getElementById('fetchBtnLbl'); if(el) el.textContent=t('fetchBtn');
  // Footer
  el=document.getElementById('gambleLbl'); if(el) el.textContent=t('gamble');
  el=document.getElementById('legalLinkLbl'); if(el) el.textContent=t('legalLink');
  el=document.getElementById('footerDescEl'); if(el) el.innerHTML=t('footerDesc');
  // Placeholders
  var pi=document.getElementById('pasteInput'); if(pi) pi.placeholder=t('pasteHolder');
  var mi=document.getElementById('manualInput'); if(mi) mi.placeholder=t('manualPlaceholder');
  var lc=document.getElementById('liveCtxInput'); if(lc) lc.placeholder=t('liveContextLabel');
  el=document.getElementById('oddsHintEl'); if(el) el.textContent=t('oddsHintFull');
  // Sports grid — rebuild avec nouvelles traductions
  buildSportGrid();
  // Settings
  el=document.getElementById('settingsTitleEl'); if(el) el.textContent=t('settingsTitle');
  el=document.getElementById('settingsSecDisplayEl'); if(el) el.textContent=t('settingsSectionDisplay');
  el=document.getElementById('settingsSecAnalysisEl'); if(el) el.textContent=t('settingsSectionAnalysis');
  el=document.getElementById('settingsSecDataEl'); if(el) el.textContent=t('settingsSectionData');
  el=document.getElementById('settingsSecLegalEl'); if(el) el.textContent=t('settingsSectionLegal');
  el=document.getElementById('settingsClock24LabelEl'); if(el) el.textContent=t('settingsClock24Label');
  el=document.getElementById('settingsClock24SubEl'); if(el) el.textContent=t('settingsClock24Sub');
  el=document.getElementById('settingsDiagLabelEl'); if(el) el.textContent=t('settingsDiagLabel2');
  el=document.getElementById('settingsDiagSubEl'); if(el) el.textContent=t('settingsDiagSub');
  el=document.getElementById('settingsSubBetsLabelEl'); if(el) el.textContent=t('settingsSubBetsLabel');
  el=document.getElementById('settingsSubBetsSubEl'); if(el) el.textContent=t('settingsSubBetsSub');
  el=document.getElementById('settingsThreshLabelEl'); if(el) el.textContent=t('settingsThresh');
  el=document.getElementById('settingsThreshValEl'); if(el) el.textContent=t('settingsThreshVal');
  el=document.getElementById('settingsClearLabelEl'); if(el) el.textContent=t('settingsClearLabel');
  el=document.getElementById('settingsClearSubEl'); if(el) el.textContent=t('settingsClearSub');
  el=document.getElementById('settingsClearRoi'); if(el) el.textContent=t('settingsClearRoi');
  el=document.getElementById('settingsApiLabelEl'); if(el) el.textContent=t('settingsApiLabel');
  el=document.getElementById('settingsApiSubEl'); if(el) el.textContent=t('settingsApiSub');
  el=document.getElementById('settingsCheckApi'); if(el) el.textContent=t('settingsCheckApi');
  el=document.getElementById('settingsLegalLabelEl'); if(el) el.textContent=t('settingsLegalLabel');
  el=document.getElementById('settingsGambleEl'); if(el) el.textContent=t('settingsGamble');
  el=document.getElementById('settingsVersionEl'); if(el) el.textContent=t('settingsVersion');
  // Coach tip title
  el=document.getElementById('coachTipTitle'); if(el) el.textContent=t('coachTitle');
  el=document.getElementById('coachTipSniper'); if(el && el.textContent) el.textContent=t('coachSniper');
  // ROI Tracker
  el=document.getElementById('roiTrackerTitle'); if(el) el.textContent=t('roiTrackerTitle');
  el=document.getElementById('roiTapHint'); if(el) el.textContent=t('roiTapHint');
  el=document.getElementById('clearHistoryBtn'); if(el) el.textContent=t('clearHistory');
  if (window.matchPool && window.matchPool.length) renderFluxList();
  // Si résultats affichés → avertir que la langue ne s'applique qu'aux nouvelles analyses
  var out = document.getElementById('output');
  if (out && out.innerHTML && out.innerHTML.length > 100) {
    var warn = document.getElementById('langChangeWarn');
    if (!warn) {
      warn = document.createElement('div');
      warn.id = 'langChangeWarn';
      warn.style.cssText = 'background:rgba(234,179,8,.15);border:1px solid rgba(234,179,8,.3);border-radius:8px;padding:8px 12px;font-size:11px;color:#eab308;margin-bottom:8px;text-align:center;';
      warn.textContent = t('langChangeNote') || 'New language applies to next analysis';
      out.insertBefore(warn, out.firstChild);
      setTimeout(function(){ if(warn.parentNode) warn.parentNode.removeChild(warn); }, 4000);
    }
  }
  // Auth modal sync langue
  el=document.getElementById('authSubTitle'); if(el) el.textContent=t('authSignInSub');
  el=document.getElementById('authSubmitLbl'); if(el) el.textContent=t('authContinueEmail');
  el=document.getElementById('authDividerTxt'); if(el) el.textContent=t('authOr');
  el=document.getElementById('authGoogleLbl'); if(el) el.textContent=t('authContinueGoogle');
  el=document.getElementById('authMagicTitle'); if(el) el.textContent=t('authCheckEmail');
  el=document.getElementById('authMagicSub'); if(el) el.textContent=t('authMagicSub');
}
function setText(id,val){var e=document.getElementById(id);if(e)e.textContent=val;}
function setLang(l,ev){
  if(ev)ev.stopPropagation();
  lang=l;
  localStorage.setItem('sc_lang',l);
  closeLangPanel();
  applyLang();
  var sb = getSB();
  if (sb && window._currentUser) {
    sb.from('profiles').update({language: l}).eq('id', window._currentUser.id)
    .then(function(res) {
      if (res.error) console.error('[setLang] Échec sauvegarde langue', res.error);
    });
  }
}
function toggleLang(ev){ev.stopPropagation();var p=document.getElementById('langPanel');p.classList.toggle('open');}
function closeLangPanel(){document.getElementById('langPanel').classList.remove('open');}
document.addEventListener('click',function(){closeLangPanel();});


// ══════════════════════════════════
// REAL-TIME CLOCK SYSTEM
// Injected into every prompt — no hallucination possible
// ══════════════════════════════════
function getRealTimeContext() {
  var now = new Date();

  // Exact timestamp
  var ts = now.getTime();

  // Full date components
  var year  = now.getFullYear();
  var month = now.getMonth() + 1;
  var day   = now.getDate();
  var hours = now.getHours();
  var mins  = now.getMinutes();

  // Timezone
  var tzOffset = -now.getTimezoneOffset(); // in minutes
  var tzHours  = Math.floor(Math.abs(tzOffset) / 60);
  var tzMins   = Math.abs(tzOffset) % 60;
  var tzSign   = tzOffset >= 0 ? '+' : '-';
  var tzName   = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown';
  var tzString = 'UTC' + tzSign + String(tzHours).padStart(2,'0') + ':' + String(tzMins).padStart(2,'0');

  // Human-readable
  var dateStr = String(day).padStart(2,'0') + '/' + String(month).padStart(2,'0') + '/' + year;
  var timeStr = String(hours).padStart(2,'0') + ':' + String(mins).padStart(2,'0');
  var dayName = now.toLocaleDateString('en-US', {weekday:'long'});
  var monthName = now.toLocaleDateString('en-US', {month:'long'});

  // What time is it in major sport timezones right now
  var zones = [
    {name:'Paris/CET',   offset:tzOffset, local:true},
    {name:'London/GMT',  tz:'Europe/London'},
    {name:'New York/ET', tz:'America/New_York'},
    {name:'Los Angeles', tz:'America/Los_Angeles'},
    {name:'Tokyo/JST',   tz:'Asia/Tokyo'},
    {name:'Dubai/GST',   tz:'Asia/Dubai'}
  ];
  var zoneLines = zones.map(function(z) {
    try {
      var t = z.local ? timeStr :
        now.toLocaleTimeString('en-US', {timeZone: z.tz, hour:'2-digit', minute:'2-digit', hour12:false});
      return z.name + ': ' + t;
    } catch(e) { return ''; }
  }).filter(Boolean).join(' | ');

  // Threshold: a match is "past" if it started more than 2h ago
  // a match is "upcoming" if it starts within 7 days
  var nowIso = now.toISOString();
  var in7days = new Date(ts + 7*24*60*60*1000).toISOString();

  return {
    timestamp:    ts,
    dateStr:      dateStr,
    timeStr:      timeStr,
    dayName:      dayName,
    monthName:    monthName,
    year:         year,
    tzName:       tzName,
    tzString:     tzString,
    zoneLines:    zoneLines,
    nowIso:       nowIso,
    in7days:      in7days,
    fullContext:
      '━━━ REAL-TIME CONTEXT (injected at query time) ━━━\n' +
      'Current date    : ' + dayName + ' ' + dateStr + '\n' +
      'Current time    : ' + timeStr + '\n' +
      'User timezone   : ' + tzName + ' (' + tzString + ')\n' +
      'World clocks    : ' + zoneLines + '\n' +
      'Unix timestamp  : ' + ts + '\n' +
      '\n' +
      '━━━ TEMPORAL RULES — MANDATORY ━━━\n' +
      'RULE 1: Today is ' + dateStr + ' at ' + timeStr + ' (' + tzName + '). This is FACT, not estimation.\n' +
      'RULE 2: Any match with a confirmed date BEFORE ' + dateStr + ' is PAST → EXCLUDE IT.\n' +
      'RULE 3: Any match starting more than 2 hours ago (before ' + String(hours-2<0?hours-2+24:hours-2).padStart(2,'0') + ':' + String(mins).padStart(2,'0') + ') is likely IN PROGRESS or FINISHED.\n' +
      'RULE 4: NEVER invent a date. NEVER assume a time. If date is unknown, say so explicitly.\n' +
      'RULE 5: When user provides a URL or text, extract dates from that content exactly as written.\n' +
      'RULE 6: Convert all times to user local timezone (' + tzName + ') when displaying.\n' +
      'RULE 7: If a match date cannot be verified as future, flag it with: match_date_uncertain:true\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  };
}

// ── INIT ──
window.matchPool = window.matchPool || [];
window.selectedMatches = window.selectedMatches || [];
window._filteredPool = window._filteredPool || [];
var clockIs24h = localStorage.getItem('sc_clock24') === '1'; // global scope
// ── CLOCK — fonctions globales ──────────────────────────────
function formatClock(date, use24h) {
  var h = date.getHours();
  var m = date.getMinutes();
  var mStr = String(m).padStart(2,'0');
  if(use24h) {
    return String(h).padStart(2,'0') + ':' + mStr;
  } else {
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12;
    if(h12 === 0) h12 = 12;
    return h12 + ':' + mStr + ' ' + ampm;
  }
}

function updateClock() {
  var now = new Date();
  var el  = document.getElementById('hdrClock');
  var fmt = document.getElementById('clockFmt');
  if(el) el.textContent = formatClock(now, clockIs24h);
  if(fmt) fmt.textContent = clockIs24h ? '24H' : '';
}

function toggleClockFormat() {
  clockIs24h = !clockIs24h;
  localStorage.setItem('sc_clock24', clockIs24h ? 'true' : 'false');
  var pill = document.querySelector('.live-pill');
  if(pill) {
    pill.style.background = 'rgba(239,68,68,.3)';
    setTimeout(function(){ pill.style.background = ''; }, 200);
  }
  updateClock();
}

// ══════════════════════════════════════════
// AUTH — Supabase
// ══════════════════════════════════════════
var SUPABASE_URL = 'https://exezkqkyulzeslducsxi.supabase.co';
var SUPABASE_KEY = 'sb_publishable_LFbDRqlxiZ8bSLbfgQkaRA_06wGrtL3';
var _sb = null;
window._currentUser = null;

function getSB() {
  if (!_sb && window.supabase) {
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return _sb;
}

function initAuth() {
  var sb = getSB();
  if (!sb) return;
  sb.auth.onAuthStateChange(function(event, session) {
    if (session && session.user) {
      window._currentUser = session.user;
      fetchAndApplyProfile(session.user);
    } else {
      window._currentUser = null;
      updateAuthUI(null);
    }
  });
  sb.auth.getSession().then(function(res) {
    if (res.data && res.data.session) {
      window._currentUser = res.data.session.user;
      fetchAndApplyProfile(res.data.session.user);
    }
  });
}

function fetchAndApplyProfile(user) {
  var sb = getSB();
  if (!sb) return;
  sb.from('profiles').select('*').eq('id', user.id).single()
  .then(function(res) {
    if (res.data) {
      window._userProfile = res.data;
      updateAuthUI(user, res.data);
      if (res.data.language) { lang = res.data.language; applyLang(); }
      maybeRedeemPendingReferral(user, res.data);
    } else {
      updateAuthUI(user, null);
    }
  }).catch(function(e) {
    console.error('[fetchAndApplyProfile]', e);
  });
}

function maybeRedeemPendingReferral(user, profile) {
  var code = localStorage.getItem('sc_pending_ref');
  if (!code) return;
  localStorage.removeItem('sc_pending_ref'); // une seule tentative, quoi qu'il arrive
  if (profile.referred_by) return; // déjà parrainé auparavant, ne rien tenter
  var sb = getSB();
  if (!sb) return;
  sb.auth.getSession().then(function(res) {
    var token = res.data && res.data.session ? res.data.session.access_token : null;
    if (!token) return;
    fetch(BACKEND + '/referral/redeem', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) alert('' + t('referralApplied'));
    }).catch(function(e) { console.error('[maybeRedeemPendingReferral]', e); });
  });
}

function updateAuthUI(user, profile) {
  var btn = document.getElementById('authBtn');
  var avatar = document.getElementById('authAvatar');
  var name = document.getElementById('authName');
  if (!btn) return;
  if (user) {
    btn.onclick = function(){ openSheet('profileModal'); loadProfileModal(user, profile); };
    if (avatar) avatar.innerHTML = getAvatarEmoji(profile && profile.avatar_id);
    if (name) name.textContent = (profile && profile.username) || user.email.split('@')[0];
    btn.classList.add('is-connected');
    btn.classList.remove('is-premium');
    var sb = getSB();
    if (sb) {
      sb.from('subscriptions').select('status,current_period_end').eq('user_id', user.id).single()
      .then(function(res) {
        var isActive = res.data && (res.data.status === 'active' || res.data.status === 'trialing') &&
          res.data.current_period_end && new Date(res.data.current_period_end) > new Date();
        if (isActive) btn.classList.add('is-premium');
      });
    }
  } else {
    btn.onclick = function(){ openSheet('authModal'); };
    if (avatar) avatar.innerHTML = '<svg class="hdr-user-ico" width="19" height="19" viewBox="0 0 22 22" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="7.5" r="3.5"/><path d="M4 18c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/></svg>';
    if (name) name.textContent = '';
    btn.classList.remove('is-connected', 'is-premium');
  }
}

function avatarSVG(id){
  var s='stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  var icons={
    coach_01:'<polygon points="14,2 6,15 11,15 9,22 18,10 12,10" fill="currentColor"/>',
    coach_02:'<circle cx="12" cy="12" r="8.5" '+s+'/><circle cx="12" cy="12" r="4.5" '+s+'/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    coach_03:'<path d="M7 4h10v4a5 5 0 01-10 0V4z" '+s+'/><path d="M7 5H4v2a3 3 0 003 3M17 5h3v2a3 3 0 01-3 3M12 13v4M8 21h8M9 17h6v4H9z" '+s+'/>',
    coach_04:'<path d="M4 20V11M10 20V6M16 20v-8M22 20V3" '+s+'/>',
    coach_05:'<path d="M12 2c2 3 1 5-.5 6.5C10 10 9 12 10.5 14c-2-.5-3.5-2.5-3-5C6 11 5 14 6.5 17a6.5 6.5 0 0011 0c1.8-3.2.5-6-1-8-.5 2-1.5 3-2.5 2 1-2.5 0-6.5-2-9z" fill="currentColor"/>',
  };
  return '<svg width="19" height="19" viewBox="0 0 24 24">'+(icons[id]||icons.coach_01)+'</svg>';
}
function getAvatarEmoji(id) {
  return avatarSVG(id);
}

function handleMagicLink() {
  var email = document.getElementById('authEmail').value.trim();
  if (!email || !email.includes('@')) return;
  var sb = getSB();
  if (!sb) return;
  document.getElementById('authSubmitLbl').textContent = 'Sending...';
  sb.auth.signInWithOtp({
    email: email,
    options: { emailRedirectTo: window.location.origin }
  }).then(function(res) {
    if (res.error) {
      alert('Error: ' + res.error.message);
      document.getElementById('authSubmitLbl').textContent = 'Continue with email';
      return;
    }
    document.getElementById('authFormSection').style.display = 'none';
    document.getElementById('authMagicSent').style.display = 'block';
    document.getElementById('authSentEmail').textContent = email;
  });
}

function handleGoogleAuth() {
  var sb = getSB();
  if (!sb) {
    alert('Connexion en cours de chargement, réessaie dans 2 secondes.');
    console.error('[Google OAuth] Supabase SDK pas encore prêt (window.supabase indisponible)');
    return;
  }
  sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  }).then(function(res) {
    if (res && res.error) {
      alert('Erreur connexion Google: ' + res.error.message);
      console.error('[Google OAuth]', res.error);
    }
  }).catch(function(e) {
    alert('Erreur connexion Google: ' + e.message);
    console.error('[Google OAuth]', e);
  });
}

function handleSignOut() {
  var sb = getSB();
  if (!sb) return;
  sb.auth.signOut().then(function() {
    window._currentUser = null;
    window._userProfile = null;
    closeSheet('profileModal');
    updateAuthUI(null);
  });
}

function handleCopyReferralLink() {
  var sb = getSB();
  if (!sb) { alert(t('premiumLoadingApp')); return; }
  sb.auth.getSession().then(function(res) {
    var token = res.data && res.data.session ? res.data.session.access_token : null;
    if (!token) { alert(t('premiumMustLogin')); return; }
    fetch(BACKEND + '/referral/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.code) { alert(t('premiumError') + ' : ' + (data.error || t('premiumErrorGeneric'))); return; }
      var link = 'https://supercoachlab.com/?ref=' + data.code;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function() {
          alert('' + t('referralLinkCopied'));
        }).catch(function() { prompt(t('referralLinkCopied'), link); });
      } else {
        prompt(t('referralLinkCopied'), link);
      }
    }).catch(function(e) {
      alert(t('premiumError') + ' : ' + e.message);
    });
  }).catch(function(e) {
    alert(t('premiumError') + ' : ' + e.message);
  });
}

function handleStartTrial() {
  var sb = getSB();
  if (!sb) { alert(t('premiumLoadingApp')); return; }
  sb.auth.getSession().then(function(res) {
    var token = res.data && res.data.session ? res.data.session.access_token : null;
    if (!token) { alert(t('premiumMustLogin')); return; }
    var btn = document.getElementById('trialStartBtn');
    if (btn) { btn.textContent = '⏳ ' + t('premiumLoading'); btn.disabled = true; }

    var controller = new AbortController();
    var timeoutId = setTimeout(function(){ controller.abort(); }, 15000);

    fetch(BACKEND + '/trial/start', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      signal: controller.signal
    }).then(function(r) {
      clearTimeout(timeoutId);
      return r.json().then(function(data) { return { ok: r.ok, data: data }; });
    }).then(function(result) {
      if (result.ok && result.data.success) {
        if (btn) { btn.style.display = 'none'; }
        loadProfileModal(window._currentUser, window._userProfile);
        alert('' + t('trialStarted'));
      } else {
        alert(t('premiumError') + ' : ' + (result.data.error || t('premiumErrorGeneric')));
        if (btn) { btn.innerHTML = '<span id="trialStartLbl">' + t('trialStartBtn') + '</span>'; btn.disabled = false; }
      }
    }).catch(function(e) {
      clearTimeout(timeoutId);
      var msg = e.name === 'AbortError' ? t('premiumTimeout') : e.message;
      alert(t('premiumError') + ' : ' + msg);
      if (btn) { btn.innerHTML = '<span id="trialStartLbl">' + t('trialStartBtn') + '</span>'; btn.disabled = false; }
    });
  }).catch(function(e) {
    console.error('[handleStartTrial] Erreur non gérée', e);
    alert(t('premiumError') + ' : ' + e.message);
  });
}

function handleUpgradePremium() {
  var sb = getSB();
  if (!sb) { alert(t('premiumLoadingApp')); return; }
  sb.auth.getSession().then(function(res) {
    var token = res.data && res.data.session ? res.data.session.access_token : null;
    if (!token) { alert(t('premiumMustLogin')); return; }
    var btn = document.getElementById('premiumUpgradeBtn');
    function resetBtn() {
      if (!btn) return;
      btn.innerHTML = '<span id="premiumUpgradeLbl">' + t('premiumUpgrade') + '</span>';
      btn.disabled = false;
    }
    if (btn) { btn.textContent = '⏳ ' + t('premiumLoading'); btn.disabled = true; }

    var controller = new AbortController();
    var timeoutId = setTimeout(function(){ controller.abort(); }, 20000);

    fetch(BACKEND + '/nowpayments/create-payment', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      signal: controller.signal
    }).then(function(r) {
      clearTimeout(timeoutId);
      return r.json();
    })
    .then(function(data) {
      if (data.invoice_url) {
        window.location.href = data.invoice_url;
      } else {
        alert(t('premiumError') + ' : ' + (data.error || t('premiumErrorGeneric')));
        resetBtn();
      }
    }).catch(function(e) {
      clearTimeout(timeoutId);
      var msg = e.name === 'AbortError' ? t('premiumTimeout') : e.message;
      alert(t('premiumError') + ' : ' + msg);
      resetBtn();
    });
  }).catch(function(e) {
    console.error('[handleUpgradePremium] Erreur non gérée', e);
    alert(t('premiumError') + ' : ' + e.message);
    var btn = document.getElementById('premiumUpgradeBtn');
    if (btn) {
      btn.innerHTML = '<span id="premiumUpgradeLbl">' + t('premiumUpgrade') + '</span>';
      btn.disabled = false;
    }
  });
}

function loadProfileModal(user, profile) {
  var sb = getSB();
  document.getElementById('profileAvatarDisplay').innerHTML = getAvatarEmoji(profile && profile.avatar_id);
  document.getElementById('profileNameDisplay').textContent = (profile && profile.username) || user.email.split('@')[0];
  document.getElementById('profileEmailDisplay').textContent = user.email;
  // Charger stats
  if (sb && user) {
    sb.from('stats').select('*').eq('user_id', user.id).single()
    .then(function(res) {
      if (res.data) {
        document.getElementById('profileWins').textContent = res.data.wins || 0;
        document.getElementById('profileLosses').textContent = res.data.losses || 0;
        document.getElementById('profileROI').textContent = (res.data.roi || 0) + '%';
      }
    });
    sb.from('bankroll').select('*').eq('user_id', user.id).single()
    .then(function(res) {
      if (res.data) {
        document.getElementById('profileBankroll').textContent =
          res.data.current_bankroll + ' ' + (res.data.currency || 'USD');
      }
    });
    sb.from('subscriptions').select('plan,status,current_period_end').eq('user_id', user.id).single()
    .then(function(res) {
      var btn = document.getElementById('premiumUpgradeBtn');
      var trialBtn = document.getElementById('trialStartBtn');
      var isTrialing = res.data && res.data.status === 'trialing' &&
        res.data.current_period_end && new Date(res.data.current_period_end) > new Date();
      var isActive = res.data && (res.data.status === 'active' || isTrialing) &&
        res.data.current_period_end && new Date(res.data.current_period_end) > new Date();
      var label = isTrialing ? 'TRIAL' : (isActive ? 'PREMIUM' : 'FREE');
      document.getElementById('profilePlanDisplay').textContent = label;
      if (btn) btn.style.display = isActive ? 'none' : 'block';
      if (trialBtn) {
        var canTrial = !isActive && profile && !profile.trial_used;
        trialBtn.style.display = canTrial ? 'block' : 'none';
      }
    });
  }
}

function selectAvatar(id) {
  var sb = getSB();
  if (!sb || !window._currentUser) return;
  sb.from('profiles').update({avatar_id: id}).eq('id', window._currentUser.id)
  .then(function() {
    document.getElementById('profileAvatarDisplay').innerHTML = getAvatarEmoji(id);
    document.getElementById('authAvatar').innerHTML = getAvatarEmoji(id);
    document.querySelectorAll('.avatar-opt').forEach(function(b){ b.classList.remove('selected'); });
    event.target.classList.add('selected');
  });
}

// ── WATCHER : active goBtn quand contenu détecté ──────
function updateGoBtn() {
  var extras = document.getElementById('manualAnalyzeExtras');
  if (extras) extras.style.display = (activeTab === 'flux') ? 'none' : '';
  var btn = document.getElementById('goBtn');
  if (!btn) return;
  if (activeTab === 'flux') {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = 'flex';
  var hasContent = false;
  if (activeTab === 'manual') {
    var mi = document.getElementById('manualInput');
    hasContent = mi && mi.value.trim().length > 3;
  } else if (activeTab === 'paste') {
    var pi = document.getElementById('pasteInput');
    var ui = document.getElementById('urlInput');
    hasContent = (pi && pi.value.trim().length > 3) || (ui && ui.value.trim().length > 5);
  }
  btn.classList.toggle('active', hasContent);
}

// ── /analyze-match — Moteur engine.js côté backend ──────────────
// Utilisé pour les matchs du flux TODAY (données structurées disponibles)
async function callAnalyzeMatch(matches, oddsVal) {
  if (!matches || !matches.length) return null;

  // Utiliser le premier match comme référence principale
  const m = matches[0];
  // engine.js attend les noms complets ('football','basketball'...), mais l'interface utilise
  // des identifiants courts ('foot','basket'...). Sans cette table, la météo, les règles
  // d'absences spécifiques au football et le calcul du nul au basketball ne se déclenchaient
  // jamais silencieusement (sport==='foot' !== sport==='football').
  const SPORT_ID_TO_ENGINE = {
    foot: 'football', basket: 'basketball', tennis: 'tennis', rugby: 'rugby',
    hockey: 'hockey', nfl: 'nfl', baseball: 'baseball', other: 'other',
  };
  const sport = SPORT_ID_TO_ENGINE[m.sportId] || m.sportId || 'football';

  const apiData = {
    sport: sport,
    home: m.home,
    away: m.away,
    competition: m.competition || '',
    date: m.dateUTC || new Date().toISOString(),
    isDerbyOrRivalry: false,
    isMinorLeague: false,
    homeRank: null,
    awayRank: null,
    environment: {
      travelTimeHours: 0,
      weatherCondition: 'clear',
      temperatureCelsius: 20,
      baseballWindDirection: 'none',
      homeLastMatchHoursAgo: null,
      awayLastMatchHoursAgo: null,
    },
    context: { homeCrisis: false, awayCrisis: false,
               homeNewCoachThisWeek: false, awayNewCoachThisWeek: false },
    homeAbsences: {}, awayAbsences: {},
    homeSubDepth: {}, awaySubDepth: {},
    sportSpecific: {},
    homeTitleRace: false, homeRelegation: false,
    awayTitleRace: false, awayRelegation: false,
    homeWinStreak: 0, awayWinStreak: 0,
    advancedMetrics: {},
    h2hSameVenue: false, h2hHomeWinRate: null,
    userLang: lang || 'fr',
  };

  // Si plusieurs matchs cochés, les ajouter en contexte
  if (matches.length > 1) {
    apiData._additionalMatches = matches.slice(1).map(function(x) {
      return x.home + ' vs ' + x.away + ' — ' + (x.competition || '');
    });
  }

  try {
    var ctrl = new AbortController();
    setTimeout(function(){ ctrl.abort(); }, 30000);
    var oddsOutcomeEl = document.getElementById('oddsOutcome');
    var oddsOutcome = oddsOutcomeEl ? oddsOutcomeEl.value : 'home';
    var resp = await fetch(BACKEND + '/analyze-match', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiData: apiData, odds: oddsVal || null, oddsOutcome: oddsOutcome })
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    return data.success ? data : null;
  } catch(e) {
    console.warn('[callAnalyzeMatch] error:', e.message);
    return null;
  }
}

// ── BACKTEST UI ──────────────────────────────────────────────────
var _btDryRun = true;

function setBtMode(dry) {
  _btDryRun = dry;
  var dryBtn  = document.getElementById('btDryBtn');
  var realBtn = document.getElementById('btRealBtn');
  if (dry) {
    dryBtn.classList.add('active');
    realBtn.classList.remove('active');
  } else {
    dryBtn.classList.remove('active');
    realBtn.classList.add('active');
  }
  // Stocker dans data-attribute ET variable globale
  var launchBtn = document.getElementById('btLaunchBtn');
  if (launchBtn) launchBtn.setAttribute('data-dryrun', dry ? 'yes' : 'no');
  var sport  = document.getElementById('btSportSel').value;
  var counts = {'':'20', football:'20', basketball:'10', tennis:'10', hockey:'6', baseball:'6'};
  var n = parseInt(counts[sport] || 52);
  document.getElementById('btEstTime').textContent = dry
    ? '~3 secondes (dry-run)'
    : '~' + Math.ceil(n * 5 / 60) + ' minutes (AI x' + n + ' @ 4s/appel)';
}

function launchBacktest(isDry) {
  isDry = isDry === true; // false par defaut
  var btn  = document.getElementById('btLaunchBtn');
  var prog = document.getElementById('btProgress');
  var bar  = document.getElementById('btProgressBar');
  var txt  = document.getElementById('btProgressTxt');
  var res  = document.getElementById('btResults');

  if (btn) btn.disabled = true;
  prog.style.display = 'block';
  res.style.display  = 'none';
  res.innerHTML      = '';
  bar.style.width    = '5%';
  txt.textContent    = isDry ? 'Validation...' : 'Analyse AI en cours (~5 min)...';

  var pct = 5;
  var interval = setInterval(function() {
    pct = Math.min(88, pct + (isDry ? 15 : 0.8));
    bar.style.width = pct + '%';
  }, isDry ? 200 : 3500);

  fetch(BACKEND + '/run-backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: isDry })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(interval);
    bar.style.width = '100%';
    setTimeout(function() {
      prog.style.display = 'none';
      renderBtResults(data, res);
      res.style.display = 'block';
    }, 400);
  })
  .catch(function(e) {
    clearInterval(interval);
    prog.style.display = 'none';
    res.innerHTML = '<div class="err-box">Erreur reseau: ' + esc(e.message) + '</div>';
    res.style.display = 'block';
  })
  .finally(function() { if (btn) btn.disabled = false; });
}

function renderBtResults(data, container) {
  if (!data.success) {
    container.innerHTML = '<div class="err-box">' + esc(data.error || 'Erreur inconnue') + '</div>';
    return;
  }
  var s = data.summary;
  var verdictClass = s.edge === null ? 'neutral' :
                     s.edge > 2     ? 'win' :
                     s.edge >= 0    ? 'neutral' :
                     s.edge > -5    ? 'warn' : 'fail';

  var html = '<div class="bt-verdict ' + verdictClass + '">' + (s.verdict || '') + '</div>';

  // Stats globales
  html += '<div class="bt-stat-grid">';
  html += btStat(s.gemini.accuracy !== null ? s.gemini.accuracy + '%' : 'N/A', 'AI Accuracy', s.gemini.accuracy >= s.bookmaker.accuracy ? 'pos' : 'neg');
  html += btStat(s.bookmaker.accuracy + '%', 'Baseline Bookmakers', '');
  html += btStat(s.edge !== null ? (s.edge > 0 ? '+' : '') + s.edge + '%' : 'N/A', 'Edge vs Baseline', s.edge > 0 ? 'pos' : 'neg');
  html += btStat((s.gemini.coverage || 0) + '%', 'AI Coverage', s.gemini.coverage >= 80 ? 'pos' : 'neg');
  html += '</div>';

  // Par sport
  html += '<table class="bt-sport-table"><thead><tr>';
  html += '<th>Sport</th><th>Matchs</th><th>AI</th><th>Baseline</th><th>Edge</th>';
  html += '</tr></thead><tbody>';
  Object.entries(data.bySport || {}).forEach(function(entry) {
    var sport = entry[0], v = entry[1];
    var edgeVal = v.edge !== null ? v.edge : null;
    var edgeTxt = edgeVal !== null ? (edgeVal > 0 ? '+' : '') + edgeVal + '%' : '—';
    var edgeCls = edgeVal > 0 ? 'edge-pos' : edgeVal < 0 ? 'edge-neg' : '';
    html += '<tr>';
    html += '<td>' + sport + '</td>';
    html += '<td>' + v.total + '</td>';
    html += '<td>' + (v.geminiAcc !== null ? v.geminiAcc + '%' : '—') + '</td>';
    html += '<td>' + v.bookAcc + '%</td>';
    html += '<td class="' + edgeCls + '">' + edgeTxt + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  html += '<div style="font-size:10px;color:var(--t2);text-align:center;margin-top:8px;">' + (data.timestamp || '') + '</div>';

  // Diagnostic brut
  if (data.diagnostic) {
    html += '<div style="margin-top:10px;padding:8px;background:var(--s2);border-radius:8px;font-size:10px;color:var(--t2);font-family:monospace;">';
    html += 'dryRun=' + data.summary.dryRun + ' | ';
    html += 'answered=' + (data.gemini ? data.gemini.answered : '?') + ' | ';
    html += 'errors=' + data.diagnostic.geminiErrors + ' | ';
    html += 'nullPreds=' + data.diagnostic.geminiNullPreds;
    if (data.diagnostic.sampleErrors && data.diagnostic.sampleErrors.length) {
      html += '<br>Err: ' + data.diagnostic.sampleErrors[0].error;
    }
    if (data.diagnostic.sampleResults && data.diagnostic.sampleResults.length) {
      html += '<br>Sample: ' + JSON.stringify(data.diagnostic.sampleResults[0]);
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

function btStat(val, lbl, cls) {
  return '<div class="bt-stat"><div class="bt-stat-val ' + cls + '">' + val + '</div><div class="bt-stat-lbl">' + lbl + '</div></div>';
}

function renderLabBlock(matches) {
  if (!matches || !matches.length) return '';
  var rows = matches.map(function(m) {
    var conf = m.confidence || 0;
    var units = m.units || m.mise_unites || 0;
    var result = (m.result || '').toUpperCase();
    var home = m.home || '';
    var away = m.away || '';
    var pick = result === 'WIN_HOME' ? home : result === 'WIN_AWAY' ? away : result === 'DRAW' ? 'DRAW' : home;
    var cls = conf >= 75 ? 'green' : conf >= 65 ? 'orange' : 'red';
    var badge = conf >= 75 ? t('labStrong') : conf >= 65 ? t('labNeutral') : t('labRisky');
    var smart = '';
    if (m.sub_bets && m.sub_bets.length) {
      var first = m.sub_bets[0];
      smart = typeof first === 'object' ? (first.label || first.market || '') : String(first);
    }
    return '<div class="lab-row tone-' + cls + '">' +
      '<div class="lab-badge">' + esc(badge) + '</div>' +
      '<div class="lab-stats"><strong>' + esc(pick) + '</strong> · ' + units + ' ' + t('labUnits') + (smart ? '<br><span class="lab-smart">' + esc(smart) + '</span>' : '') + '</div>' +
      '<div class="lab-conf">' + conf + '%</div>' +
    '</div>';
  }).join('');
  return '<div class="lab-block"><div class="lab-header">' + esc(t('labTitle')) + '</div>' + rows + '</div>';
}

window.onload = function(){
  initAuth();
  var refParam = new URLSearchParams(window.location.search).get('ref');
  if (refParam) localStorage.setItem('sc_pending_ref', refParam.toUpperCase());
  // S'assurer que les modals sont fermés au chargement
  var sm = document.getElementById('settingsModa');
  if(sm) sm.classList.remove('open');
  var _mi=document.getElementById('manualInput');
  if(_mi) _mi.addEventListener('input',function(){
    var v=this.value.trim();
    var cb=document.getElementById('clearBtn');
    if(cb)cb.style.display=v.length>0?'block':'none';
    // Auto-détection URL → basculer vers WEB PAGE
    if(v.startsWith('http://') || v.startsWith('https://')){
      var urlInput=document.getElementById('urlInput');
      if(urlInput){ urlInput.value=v; }
      this.value='';
      if(cb)cb.style.display='none';
      // Switcher vers l'onglet WEB PAGE
      switchTab('paste');
      var st=document.getElementById('urlStatus');
      if(st){ st.className='url-status ok'; st.textContent='URL detected — tap FETCH to load'; }
    }
  });
  // Listener sur le champ unique urlInput
  var _ui=document.getElementById('urlInput');
  if(_ui) _ui.addEventListener('input',function(){
    var v=this.value.trim();
    var fetchBtn=document.getElementById('urlFetchBtn');
    var clearBtn=document.getElementById('clearBtnPaste');
    var st=document.getElementById('urlStatus');
    if(v.length>0){
      if(clearBtn) clearBtn.style.display='block';
    } else {
      if(clearBtn) clearBtn.style.display='none';
      if(fetchBtn) fetchBtn.style.display='none';
      if(st) st.textContent='';
      return;
    }
    var isUrl=v.startsWith('http://') || v.startsWith('https://');
    if(isUrl){
      if(fetchBtn) fetchBtn.style.display='none'; // FETCH intégré dans ANALYSER v9.0
      if(st){ st.className='url-status ok'; st.textContent=t('urlDetected');}
    } else {
      if(fetchBtn) fetchBtn.style.display='none';
      if(st) st.textContent='';
    }
  });
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(s){s.unregister();});});
  }
  try { buildSportGrid(); } catch(e){ console.error('buildSportGrid:', e); }
  // Init backtest mode — 'yes' = dry-run par defaut
  var btLaunch = document.getElementById('btLaunchBtn');
  if (btLaunch) btLaunch.setAttribute('data-dryrun', 'yes');
  try { applyLang(); } catch(e){ console.error('applyLang:', e); }
  try { updateGoBtn(); } catch(e){}
  setTimeout(function(){
    try { loadFluxMatches(); } catch(e){ console.error('loadFluxMatches:', e); }
  }, 200);
  try { updateClock(); } catch(e){}
  setInterval(function(){ try { updateClock(); } catch(e){} }, 10000);
};

// ── SPORT GRID ──
function buildSportGrid(){
  var g = document.getElementById('sportGrid');
  if (!g) return;
  g.innerHTML = '';
  SPORTS.forEach(function(s){
    var on = activeSports.indexOf(s.id) > -1 || 
             (activeSports.indexOf('all') > -1 && s.id === 'all');
    var el = document.createElement('div');
    el.className = 'sc' + (on ? ' sc-on' : '');
    el.id = 'sc-'+s.id;
    el.style.color         = on ? s.c : 'var(--text3)';
    el.style.borderBottomColor = on ? s.c : 'transparent';
    el.style.fontWeight    = on ? '600' : '500';
    var ico = document.createElement('span');
    ico.className = 'sc-ico';
    ico.innerHTML = sportSVG(s.id);
    el.appendChild(ico);
    var lbl = document.createElement('span');
    lbl.textContent = s.lk ? t(s.lk) : s.l;
    el.appendChild(lbl);
    el.addEventListener('touchend', (function(id){return function(e){e.preventDefault();toggleSport(id);};})(s.id));
    el.addEventListener('click',    (function(id){return function(){toggleSport(id);};})(s.id));
    g.appendChild(el);
  });
}

function toggleSport(id){
  if (id==='all') {
    activeSports = ['all'];
  } else {
    // Retirer 'all' si présent
    activeSports = activeSports.filter(function(s){ return s!=='all'; });
    var si = activeSports.indexOf(id);
    if (si > -1) {
      activeSports.splice(si, 1);
      if (!activeSports.length) activeSports = ['all'];
    } else {
      activeSports.push(id);
    }
  }
  buildSportGrid();
  // NE PAS vider selectedMatches
  if (activeTab==='flux') renderFluxList();
}

function setMode(m){
  mode=m;
  document.getElementById('mPre').classList.toggle('active',m==='pre');
  document.getElementById('mLive').classList.toggle('active',m==='live');
  document.getElementById('preMode').style.display=m==='pre'?'block':'none';
  document.getElementById('liveMode').style.display=m==='live'?'block':'none';
  setText('inputLabel',m==='live'?t('inputLabelLive'):t('inputLabel'));
}
function switchTab(tab){
  activeTab=tab;
  document.getElementById('tabManual').classList.toggle('on',tab==='manual');
  document.getElementById('tabPaste').classList.toggle('on',tab==='paste');
  document.getElementById('tabFlux').classList.toggle('on',tab==='flux');
  document.getElementById('panelManual').classList.toggle('on',tab==='manual');
  document.getElementById('panelPaste').classList.toggle('on',tab==='paste');
  document.getElementById('panelFlux').classList.toggle('on',tab==='flux');
  if(tab==='flux'){
    if(!window.matchPool.length) loadFluxMatches();
  }
  // Bouton analyser flux visible seulement sur TODAY
  updateFluxBtn();
  updateGoBtn();
}
function toggleChip(k){
  chips[k]=!chips[k];
  document.getElementById('c-'+k).classList.toggle('on',chips[k]);
}
function navTo(p){
  ['home','matches','reading'].forEach(function(x){
    var el = document.getElementById('nav'+x.charAt(0).toUpperCase()+x.slice(1));
    if (el) el.classList.toggle('on', x===p);
  });
  if (p === 'home') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (p === 'matches') {
    scrollToExplore();
  } else if (p === 'reading') {
    renderLectureView();
  }
}

// ── LECTURE — surface éditoriale, construite uniquement sur du texte réel déjà généré ──
function renderLectureView() {
  var out = document.getElementById('output');
  if (!lastResults || !lastResults.matches || !lastResults.matches.length) {
    out.innerHTML = '<div class="zero-edge"><div class="zero-edge-icon"><svg width="26" height="38" viewBox="0 0 26 38"><polygon points="17,0 6,20 12,20 8,38 20,16 13,16" fill="currentColor"/></svg></div>' +
      '<div class="zero-edge-title">' + t('readingEmptyTitle') + '</div>' +
      '<div class="zero-edge-sub">' + t('readingEmptySub') + '</div></div>';
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  var M = lastResults.matches;
  var summary = lastResults.summary;

  var entries = M.filter(function(m){ return m.justification; }).map(function(m) {
    var type = getType(m.result);
    var verdict = getVerdict(m.result, m.home, m.away);
    return '<div class="lecture-entry">' +
      '<div class="lecture-entry-hdr">' +
        '<span class="lecture-teams">' + esc(m.home) + ' – ' + esc(m.away) + '</span>' +
        (m.competition ? '<span class="lecture-comp">' + esc(m.competition) + '</span>' : '') +
      '</div>' +
      '<div class="lecture-verdict ' + type + '">' + verdict + '</div>' +
      '<div class="lecture-text">' + esc(m.justification) + '</div>' +
    '</div>';
  }).join('');

  if (!entries) {
    // Les matchs existent mais aucun n'a de vraie justification exploitable — état honnête, pas de contenu fabriqué.
    out.innerHTML = '<div class="zero-edge"><div class="zero-edge-icon"><svg width="26" height="38" viewBox="0 0 26 38"><polygon points="17,0 6,20 12,20 8,38 20,16 13,16" fill="currentColor"/></svg></div>' +
      '<div class="zero-edge-title">' + t('readingEmptyTitle') + '</div>' +
      '<div class="zero-edge-sub">' + t('readingEmptySub') + '</div></div>';
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  out.innerHTML = '<div class="lecture-view">' +
    '<div class="lecture-hdr">' +
      '<div class="lecture-kicker">' + t('navReading') + '</div>' +
      (summary ? '<div class="lecture-summary">' + esc(summary) + '</div>' : '') +
    '</div>' +
    entries +
    '<div class="lecture-see-data" onclick="scrollToFullResults()">' + t('lectureSeeData') + '</div>' +
  '</div>';
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function scrollToFullResults() {
  // Réutilise les vraies cartes déjà rendues par renderResults (profondeur : chiffres/Value/Kelly)
  var cards = document.querySelector('.results .mcard');
  if (cards) cards.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── PASTE ──
function pasteClip(){
  if(navigator.clipboard&&navigator.clipboard.readText){
    navigator.clipboard.readText().then(function(t){
      if(t&&t.length>5){document.getElementById('pasteInput').value=t;showMsg(t.length.toLocaleString()+' chars','ok');}
      else showMsg('Clipboard empty','warn');
    }).catch(function(){showMsg('Use Ctrl+V','warn');});
  }else showMsg('Use Ctrl+V','warn');
}
function showMsg(m,type){var e=document.getElementById('pmsg');e.textContent=m;e.className='pmsg '+type;e.style.display='block';setTimeout(function(){e.style.display='none';},4000);}

// ── BACKEND ──
function callBackend(prompt){
  return fetch(BACKEND+'/analyze',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({prompt:prompt})}).then(function(r){
    if(!r.ok)return r.json().catch(function(){return{};}).then(function(e){throw new Error(e.error||'Server error '+r.status);});
    return r.json();
  }).then(function(d){
    if(!d.result)throw new Error('Empty response');
    window._lastDbIds = d.db_ids || [];  // Stocker les IDs Neon;
    // Stocker le meta pour les timings
    window._lastMeta = d.meta || null;
    window._lastMarket = d.market || null;
    window._lastDataRichness = d.dataRichness || null;
    return d.result;
  });
}

// ── PROMPT ──
function parseRawText(raw) {
  // Parser copier-coller : extrait les matchs depuis texte brut
  var lines = raw.split(/\n/).map(function(l){ return l.trim(); }).filter(Boolean);
  var matches = [];
  var vsPattern = /^(.{2,35})\s+(?:vs?\.?|contre|–|-)\s+(.{2,35})$/i;
  var timePattern = /\b(\d{1,2}[h:]\d{2}|\d{1,2}\s*[AaPp][Mm])\b/;
  lines.forEach(function(line) {
    var clean = line.replace(/[\u2013\u2014]/g, '-').replace(/\s+/g,' ');
    var m = clean.match(vsPattern);
    if (m) {
      var time = '';
      var nextIdx = lines.indexOf(line) + 1;
      if (nextIdx < lines.length) {
        var tm = lines[nextIdx].match(timePattern);
        if (tm) time = tm[0];
      }
      matches.push(m[1].trim() + ' vs ' + m[2].trim() + (time ? ' - ' + time : ''));
    }
  });
  // Si aucun match "vs" détecté mais contenu présent → retourner tel quel
  // Gemini va interpréter comme recherche libre
  if (!matches.length && raw.trim().length > 0) {
    return raw.trim();
  }
  return matches.length ? matches.join('\n') : raw;
}

function buildPrompt(content,isPage){
  content = parseRawText(content);
  var odds = document.getElementById('oddsInput').value.trim();
  var sf = activeSports.indexOf('all')>-1 ? 'All sports' :
    activeSports.map(function(id){
      var s=SPORTS.filter(function(s){return s.id===id;})[0];
      return s?(s.lk?t(s.lk):s.l):id;
    }).join(', ');
  var chips_str = [
    chips.rot?'Rotations C1/C3':'',chips.inj?'Injuries':'',
    chips.form?'Form L5':'',chips.h2h?'H2H':'',chips.stake?'Stakes':'',
  ].filter(Boolean).join(', ');
  var uLang = lang==='fr'?'French':lang==='es'?'Spanish':lang==='pt'?'Portuguese':lang==='ar'?'Arabic':lang==='it'?'Italian':lang==='de'?'German':'English';

  return [
    'SUPERCOACH v9.3 | Language:'+uLang+' | Sports:'+sf+(odds?' | Odds:'+odds:''),
    'MANDATORY: Write ALL analysis text (justification, summary, sub_bets, all_output) EXCLUSIVELY in '+uLang+'. No English unless uLang is English.',
    'SUB_BETS RULES: Always return 2-3 picks. Each pick = {icon, label, type}.',
    'Available types and icons by sport:',
    'FOOTBALL: scorer (buteur par nom), goals (Over/Under X.5), btts, handicap (Asian Handicap ou DNB), winner, double_chance (1N/N2/12), exact_score, ht_ft (mi-temps/fin), comeback',
    'BASKETBALL: goals (Over/Under pts), handicap (spread), winner, player_prop (points joueur), ot (overtime)',
    'TENNIS: winner, goals (Over/Under jeux), handicap (jeux/sets), player_prop (aces), btts (les 2 sets)',
    'HOCKEY: winner, goals (Over/Under buts), btts, puck_line (+/-1.5), so (shootout)',
    'BASEBALL: goals (Over/Under runs), run_line (+/-1.5), player_prop (bases totales), winner',
    'MMA/BOXE: winner, method (KO/TKO/Decision), round (round exact), distance',
    'If confidence>=80%: scorer pick with attacker name for football, player_prop for others.',
    'If confidence>=70%: goals pick (Over/Under) + handicap or double_chance.',
    'If confidence 60-70%: safer bets = btts, double_chance, dnb.',
    'ALWAYS pick variables relevant to the sport. NEVER suggest football picks for tennis.',
    'You are a deterministic sports analytics engine. Current year: 2026.',
    chips_str?'Active: '+chips_str:'',
    '',
    'PIPELINE — apply per match in strict order:',
    '1. BASE SCORE: Raw strength 0-100 each team. Initial%=HomeScore/(Home+Away)*100',
    '2. PILIER 1 HOME: +5% home baseline. Away travel>4h: +2% extra.',
    '3. PILIER 2 INJURIES: GK out -10%, Top scorer out -8%, Captain out -5%. Stack all.',
    '4. PILIER 3 MOTIVATION: Relegation +15%, Title +10%. Derby=reset 50/50 THEN injuries.',
    '5. FORM+H2H: 3+ wins row +5%. H2H same surface only.',
    '',
    'BANKROLL: VE%=(Conf/100-1/odds)*100. Units=(VE/(odds-1))*10 capped 0-5.',
    'Recommend ONLY conf>=70% AND value_edge>0.',
    '',
    'SPORTS: Football(draw OK), MLB/NPB/KBO(pitcher ERA #1,NRFI), Basketball(B2B-15%),',
    'Tennis(H2H same surface MANDATORY), NHL, Rugby, MMA. Any league worldwide.',
    '',
    'CRITICAL:',
    '- CRITICAL: Analyze ONLY the EXACT matches listed in INPUT below. Do NOT invent, add or substitute any match.',
    '- Use the EXACT team names from INPUT. Never replace with other teams or competitions.',
    '- Analyze ALL matches in input. Do NOT stop at 3.',
    '- MAX 2 bullet points per justification.',
    '- MANDATORY: Every single word of justification, summary, sub_bets, coach_tip MUST be in '+uLang+'. Zero English words if language is not English.',
    '- Unknown league/team: use your knowledge, do not return NOT_FOUND.',
    '- Only date_confirmed:false if match is truly impossible.',
    '',
    '{"matches":[{"rank":1,"sport":"Football","sport_id":"foot","home":"A","away":"B",',
    '"competition":"League","match_date":"DD/MM/YYYY","match_time":"HH:MM","date_confirmed":true,',
    '"result":"WIN_HOME","confidence":75,"odds_given":1.85,"value_edge_pct":2.1,',
    '"value":"light","value_text":"75% vs 74.1% implied","units":1,',
    '"rotation_alert":false,"rotation_text":"",',
    '"justification":"• step1: 55%+5%=60%. • Pilier3: relegation +15% → 75%.",',
    '"sub_bets":[{"icon":"","label":"Buteur: M.Salah","type":"scorer"},{"icon":"","label":"Over 2.5 buts","type":"goals"},{"icon":"","label":"Les 2 equipes marquent","type":"btts"}]}],',
    '"summary":"Global strategy in '+uLang+'","roi_potential":"Est. ROI: +X%"}',
    'sport_id: foot|basket|tennis|rugby|mma|boxing|hockey|handball|volley|f1|baseball|nfl|other',
    '',
    'INPUT (analyze ONLY what is listed here, nothing else):',
    content,
    '',
    'IMPORTANT: If INPUT contains only one team name or partial info, ask yourself what upcoming match involves this team and analyze THAT specific match. Do NOT invent random Premier League or Ligue 1 matches. Use only real scheduled matches for 2026.'
  ].filter(Boolean).join('\n');
}

function buildLivePrompt(){
  var h    = document.getElementById('homeTeam').value || '?';
  var a    = document.getElementById('awayTeam').value || '?';
  var sh   = document.getElementById('scoreH').value || '0';
  var sa   = document.getElementById('scoreA').value || '0';
  var comp = document.getElementById('liveComp').value || '';
  var min  = document.getElementById('liveMin').value || '45';
  var ctx  = document.getElementById('liveCtx').value || '';
  var odds = document.getElementById('liveOdds').value || '';

  return (
    'You are SUPERCOACH, elite sports analyst.\n'+
    '━━━ LIVE MATCH — HALF TIME ━━━\n'+
    'Match: '+h+' vs '+a+(comp?' | '+comp:'')+' | Minute: '+min+'\n'+
    'Half-time score: '+h+' '+sh+' — '+sa+' '+a+'\n'+
    (odds?'2nd half odds for '+h+': '+odds+'\n':'')+
    (ctx?'\nAdditional context:\n'+ctx+'\n':'')+
    '\n'+
    '━━━ YOUR MISSION ━━━\n'+
    'Use your complete knowledge of this match, these teams, and this competition.\n'+
    'Combine your knowledge with the half-time score and context provided.\n'+
    'Identify the best 2nd half betting opportunities.\n\n'+
    'Half-time analysis rules:\n'+
    '• Current score is the dominant factor — adjust from your pre-match knowledge\n'+
    '• 2-goal lead = dominant team confidence +15%\n'+
    '• Red card = affected team -20%\n'+
    '• 0-0 at HT = draw probability increases +10%\n'+
    '• Comeback specialists: factor team identity\n\n'+
    'RESPONSE: Pure JSON only. Zero backticks.\n'+
    '{"live":{\n'+
    '  "match":"'+h+' vs '+a+'",\n'+
    '  "score_ht":"'+sh+'-'+sa+'",\n'+
    '  "minute":"'+min+'",\n'+
    '  "final_prediction":"WIN_HOME",\n'+
    '  "confidence_updated":72,\n'+
    '  "confidence_initial":58,\n'+
    '  "delta":"+14%",\n'+
    '  "key_events":"Key factors from HT score + context",\n'+
    '  "bets":[{"market":"Market name","rec":"strong","confidence":72,"units":3,"reason":"Specific reason"}],\n'+
    '  "summary":"One sentence insight."\n'+
    '}}'
  );
}
// ── PARSER ──
function tryP(s){try{return JSON.parse(s);}catch(e){return null;}}
function fixT(s){
  var f=s.replace(/,\s*$/,'');
  var q=(f.match(/"/g)||[]).length;if(q%2!==0)f+='"';
  var ob=(f.match(/\{/g)||[]).length-(f.match(/\}/g)||[]).length;
  var oa=(f.match(/\[/g)||[]).length-(f.match(/\]/g)||[]).length;
  for(var i=0;i<ob;i++)f+='}';for(var i=0;i<oa;i++)f+=']';
  return tryP(f);
}

function normTeamKey(s){
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}
function teamMentioned(team, hay){
  var n=normTeamKey(team);
  if(!n || n.length<3) return false;
  if(hay.indexOf(n)>=0) return true;
  var parts=n.split(' ').filter(function(w){ return w.length>=4; });
  if(!parts.length){
    var toks=n.split(' ').filter(Boolean);
    return toks.length>0 && toks.every(function(w){ return hay.indexOf(w)>=0; });
  }
  return parts.every(function(w){ return hay.indexOf(w)>=0; });
}
function keepOnlyRequested(matches, inputText){
  if(!matches || !matches.length) return [];
  var hay=normTeamKey(inputText||'');
  if(!hay) return matches;
  return matches.filter(function(m){
    return teamMentioned(m.home, hay) && teamMentioned(m.away, hay);
  });
}

function parse(raw){
  if(!raw||!raw.trim())return null;

  function normalizeGeminiFormat(r){
    // Format standard : {matches:[...]}
    if(r&&Array.isArray(r.matches)&&r.matches.length>0) return r;
    // Format live
    if(r&&r.live) return r;
    // Format tableau direct [{rank:1,...}]
    if(Array.isArray(r)&&r.length>0&&r[0].rank!==undefined)
      return {matches:r,summary:'',roi_potential:''};
    // Format Gemini alternatif : {analysis:{upcoming_events:[...]}}
    if(r&&r.analysis&&Array.isArray(r.analysis.upcoming_events)){
      var evts = r.analysis.upcoming_events;
      var matches = evts.map(function(e,i){
        var teams = (e.matchup||'').split(' vs ');
        var pred = e.prediction||{};
        var bet = e.betting_opportunity||{};
        var conf = Math.round((pred.confidence_score||0.7)*100);
        var odds = bet.odds||1.85;
        var ve = bet.value_edge_pct ? Math.round(bet.value_edge_pct*100*100)/100 :
          Math.round((conf/100 - 1/odds)*100*100)/100;
        var winner = pred.winner||teams[0]||'';
        var result = winner===teams[0]?'WIN_HOME':winner===teams[1]?'WIN_AWAY':'DRAW';
        return {
          rank:i+1, sport:'Baseball', sport_id:'baseball',
          home:teams[0]||'', away:teams[1]||'',
          competition:e.league||'', match_date:'',
          match_time:e.start_time?(new Date(e.start_time)).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):'',
          date_confirmed:true, result:result,
          confidence:conf, odds_given:odds,
          value_edge_pct:ve>0?ve:0,
          value:ve>2?'strong':ve>0?'light':'no_value',
          value_text:'Conf '+conf+'% → edge '+(ve>0?'+':'')+ve+'%',
          units:Math.min(5,Math.max(1,Math.round(ve>0?(ve/(odds-1)*10):1))),
          rotation_alert:false, rotation_text:'',
          justification:pred.rationale||'',
          sub_bets:['NRFI','Over 8.5 runs']
        };
      });
      return {
        matches:matches,
        summary:(r.analysis.date||'')+' — '+matches.length+' matchs analysés',
        roi_potential:'Est. ROI: voir détails'
      };
    }
    // Format tableau d'events directs
    if(Array.isArray(r)&&r.length>0&&r[0].matchup){
      return normalizeGeminiFormat({analysis:{upcoming_events:r,date:'',time:''}});
    }
    // Format JSON sans matches (analyse générale, tournoi sans matchs spécifiques)
    if(r && (r.analysis_id || r.analysis || r.prediction)){
      var msg = r.prediction || r.analysis || r.details || '';
      if(typeof msg === 'object') msg = JSON.stringify(msg).slice(0,200);
      return {
        matches:[],
        summary: msg.length > 10
          ? 'Aucun match spécifique trouvé dans cette page. ' + msg.slice(0,150) + '...'
          : 'Aucun match trouvé — essaie une URL avec les matchs du jour.',
        roi_potential:''
      };
    }
    return null;
  }

  function tryP(s){
    try{
      var r=JSON.parse(s);
      return normalizeGeminiFormat(r);
    }catch(e){return null;}
  }

  function fixT(s){
    var f=s.replace(/,\s*$/,'');
    var q=(f.match(/"/g)||[]).length; if(q%2!==0)f+='"';
    var stack=[]; var inStr=false, esc=false;
    for(var i=0;i<f.length;i++){
      var ch=f[i];
      if(esc){esc=false;continue;}
      if(ch==='\\'){esc=true;continue;}
      if(ch==='"'){inStr=!inStr;continue;}
      if(inStr)continue;
      if(ch==='{'||ch==='[')stack.push(ch==='{'?'}':']');
      else if(ch==='}'||ch===']')stack.pop();
    }
    while(stack.length)f+=stack.pop();
    return tryP(f);
  }

  // Nettoyage — backticks markdown
  var c=raw
    .replace(/```json[\s\S]*?```/gi,function(m){return m.replace(/```json\s*/gi,'').replace(/```\s*$/,'');})
    .replace(/```json/gi,'').replace(/```/g,'')
    .replace(/\}\s*\}\s*$/,'}')
    .trim();

  // Trouver le début du JSON — { ou [ (Gemini peut retourner les deux)
  var i1=c.indexOf('{'); var i2=c.indexOf('[');
  var st=-1;
  if(i1===-1&&i2>-1)st=i2;
  else if(i2===-1&&i1>-1)st=i1;
  else if(i1>-1&&i2>-1)st=Math.min(i1,i2);
  if(st>0)c=c.slice(st);
  c=c.trim();

  // Tentative 1 — parse direct
  var p=tryP(c); if(p)return p;
  // Tentative 2 — extraire bloc JSON depuis {
  var m=c.match(/\{[\s\S]*\}/);
  if(m){p=tryP(m[0]);if(p)return p;}
  // Tentative 3 — extraire tableau depuis [
  var m2=c.match(/\[[\s\S]*\]/);
  if(m2){p=tryP(m2[0]);if(p)return p;}
  // Tentative 4 — réparer virgules
  if(m){p=tryP(m[0].replace(/,\s*([}\]])/g,'$1'));if(p)return p;}
  // Tentative 5 — réparer JSON tronqué (bloc complet)
  if(m){p=fixT(m[0]);if(p)return p;}
  // Tentative 5b — buffer entier même sans } final
  p=fixT(c); if(p)return p;
  // Tentative 6 — extraire matches directement
  var ms=c.match(/"matches"\s*:\s*(\[[\s\S]*)/);
  if(ms){
    p=fixT('{"matches":'+ms[1]);
    if(p&&p.matches&&p.matches.length>0)return p;
    var inner=ms[1];
    var lastGood=inner.lastIndexOf('}');
    if(lastGood>0){
      p=fixT('{"matches":['+inner.slice(0,lastGood+1)+']}');
      if(p&&p.matches&&p.matches.length>0)return p;
    }
  }
  // Tentative 7 — tableau tronqué
  if(m2){p=fixT(m2[0]);if(p)return p;}
  return null;
}


function normM(arr){
  return arr.map(function(m,i){return{
    rank:m.rank||i+1,sport:m.sport||'Sport',
    sport_id:(function(id){
      var alias={'nhl':'hockey','ice hockey':'hockey','nba':'basket',
                 'basketball':'basket','soccer':'foot','ufc':'mma',
                 'formula 1':'f1','formula1':'f1','american football':'nfl'};
      return alias[(id||'').toLowerCase()]||id||'other';
    })(m.sport_id),
    home:m.home||'?',away:m.away||'?',competition:m.competition||'',
    match_date:m.match_date||null,match_time:m.match_time||null,
    result:['WIN_HOME','WIN_AWAY','DRAW'].indexOf(m.result)>-1?m.result:'WIN_HOME',
    confidence:Math.min(Math.max(Number(m.confidence)||65,50),99),
    value_edge_pct:m.value_edge_pct!==undefined&&m.value_edge_pct!==null?Number(m.value_edge_pct):null,
    value:(function(v){
      // Normaliser TOUTES les valeurs possibles vers nos classes CSS
      var s = (v||'').toLowerCase().trim();
      var map = {
        'strong':'strong','very strong':'strong','moderate':'strong','good':'strong',
        'light':'light','slight':'light','small':'light','low':'light','value':'light',
        'neutral':'neutral','fair':'neutral','average':'neutral','medium':'neutral',
        'none':'none','no value':'none','no edge':'none','n/a':'none',
        'avoid':'avoid','bad':'avoid','negative':'avoid','no':'avoid'
      };
      return map[s] || (s==='' ? null : 'none');
    })(m.value),
    value_text:m.value_text||'',
    units:Math.min(Math.max(Number(m.units)||2,0),5),
    rotation_alert:!!m.rotation_alert,rotation_text:m.rotation_text||'',
    justification:m.justification||'',
    sub_bets:Array.isArray(m.sub_bets)?m.sub_bets.slice(0,3):[],
    date_uncertain:!!m.match_date_uncertain
  };});
}

// ── ANALYZE ──
// ── FALLBACK : extraction dégradée si parse() échoue ──
function extractFallbackMatches(raw) {
  if (!raw || raw.length < 10) return null;
  var lines = raw.split('\n').filter(function(l){ return l.trim().length > 3; });
  var matches = [];
  lines.forEach(function(line) {
    var vsMatch = line.match(/([\w\s\-\.àáâãäåèéêëìíîïòóôõöùúûü]{3,30})\s+(?:vs\.?|-)\s+([\w\s\-\.àáâãäåèéêëìíîïòóôõöùúûü]{3,30})/i);
    var confMatch = line.match(/(\d{2,3})\s*%/);
    var resultMatch = line.match(/WIN_HOME|WIN_AWAY|DRAW/);
    if (vsMatch && vsMatch[1].trim().length > 2) {
      matches.push({
        rank: matches.length + 1, sport: 'Sport', sport_id: 'other',
        home: vsMatch[1].trim(), away: vsMatch[2].trim(),
        competition: '', match_date: null, match_time: null,
        result: resultMatch ? resultMatch[0] : 'WIN_HOME',
        confidence: confMatch ? parseInt(confMatch[1]) : 70,
        value_edge_pct: 0, value: 'neutral', value_text: '',
        units: 2, rotation_alert: false, rotation_text: '',
        justification: '', sub_bets: [], date_uncertain: true
      });
    }
  });
  if (matches.length === 0) return null;
  return { matches: matches, summary: '', roi_potential: '' };
}

function analyze(){
  var content='';
  // Priorité 1 : contenu injecté par analyzeFlux (évite pb Safari mobile)
  if (window._fluxContent) {
    content = window._fluxContent;
  } else {
    var isPage=activeTab==='paste';
    if(isPage){
      var pasteVal=document.getElementById('pasteInput').value.trim();
      var urlVal=document.getElementById('urlInput').value.trim();
      content = pasteVal || urlVal;
    } else {
      content=document.getElementById('manualInput').value.trim();
    }
  }
  if(!content){showOut('<div class="err-box">'+t('errNoMatches')+'</div>');return;}
  var btn=document.getElementById('goBtn');
  if(btn){btn.disabled=true;btn.innerHTML='<div class="spinner"></div> '+t('analyzing');}
  showOut(thinkingHTML(false));
  startThinkingAnimation(false);
  // Si l'utilisateur a collé une URL → envoyer l'URL brute au serveur
  var isUrl = /^https?:\/\//i.test(content);
  // En mode URL : ajouter la langue pour que Gemini réponde correctement
  var promptToSend = isUrl
    ? 'LANGUAGE:' + (lang==='fr'?'French':lang==='es'?'Spanish':lang==='pt'?'Portuguese':lang==='ar'?'Arabic':lang==='it'?'Italian':lang==='de'?'German':'English') + '\n' + content
    : buildPrompt(content, isPage);
  callBackend(promptToSend).then(function(raw){
    var p=parse(raw);
    if(p&&p.matches){
      p.matches=normM(p.matches);
      // Rattacher le consensus marché (calculé par le backend sur le match principal)
      if(p.matches.length>0){
        p.matches[0]._market = window._lastMarket || null;
        p.matches[0]._dataRichness = window._lastDataRichness || null;
      }
      // Filtre sport supprimé — detectIntention() côté serveur gère le sport
      if(p.matches.length===0){
        // Cas 1 : Gemini a retourné un message (match non trouvé, validation échouée)
        if(p.summary && p.summary.length > 5){
          var isUrlMode = /^https?:\/\//i.test(content);
          var hint = isUrlMode
            ? '<br><br>Cette page ne contient pas de matchs analysables. Essaie une URL avec le programme du jour ou colle directement la liste des matchs.'
            : '';
          showOut(
            '<div class="zero-edge">'+
            '<div class="zero-edge-icon"><svg width="34" height="34" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L15 14H1z"/><path d="M8 6.5v3.2M8 12h0"/></svg></div>'+
            '<div class="zero-edge-title">'+t('matchNotFound')+'</div>'+
            '<div class="zero-edge-sub">'+esc(p.summary)+hint+'</div>'+
            '<button class="new-btn" onclick="resetOut()">↺ '+t('newAnalysis')+'</button>'+
            '</div>'
          );
        } else {
          showOut(
            '<div class="zero-edge">'+
            '<div class="zero-edge-icon"><svg width="34" height="34" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L15 14H1z"/><path d="M8 6.5v3.2M8 12h0"/></svg></div>'+
            '<div class="zero-edge-title">'+t('matchNotFound')+'</div>'+
            '<div class="zero-edge-sub">'+t('matchNotFoundSub')+'</div>'+
            '<button class="new-btn" onclick="resetOut()">↺ '+t('newAnalysis')+'</button>'+
            '</div>'
          );
        }
        return;
      }
      saveHist(p,'pre',window._lastDbIds||[]);
      // Afficher les timings en mode debug (visible temporairement)
      var timingBar = '';
      if(window._lastMeta && window._lastMeta.timing){
        var tm = window._lastMeta.timing;
        timingBar = '<div style="background:rgba(200,146,42,.06);border:1px solid rgba(200,146,42,.15);' +
          'border-radius:8px;padding:8px 12px;margin-bottom:8px;font-family:JetBrains Mono,monospace;' +
          'font-size:10px;color:var(--text3);display:flex;gap:12px;flex-wrap:wrap">' +
          '<span>⏱ Total: <b style="color:var(--gold)">' + tm.total_ms + 'ms</b></span>' +
          '<span>Fetch: <b>' + tm.fetch_ms + 'ms</b></span>' +
          '<span>AI: <b>' + tm.gemini_ms + 'ms</b></span>' +
          '<span>Tokens: <b>~' + tm.prompt_tokens_est + '</b></span>' +
          '<span>' + (window._lastMeta.model||'?') + '</span>' +
          '</div>';
      }
      showOut(timingBar + renderResults(p));
    }
    else {
      var fallback = extractFallbackMatches(raw);
      if (fallback) {
        showOut(renderResults(fallback));
      } else {
        showOut(
          '<div class="zero-edge">' +
          '<div class="zero-edge-icon"><svg width="34" height="34" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L15 14H1z"/><path d="M8 6.5v3.2M8 12h0"/></svg></div>' +
          '<div class="zero-edge-title">'+t('analysisFailed')+'</div>' +
          '<div class="zero-edge-sub">'+t('errParseFail')+'</div>' +
          '</div>' +
          '<button class="reset-btn" onclick="resetOut()">↺ ' + t('newAnalysis') + '</button>'
        );
      }
    }
  }).catch(function(e){showOut('<div class="err-box">'+esc(e.message)+'</div>');})
  .finally(function(){if(btn){btn.disabled=false;btn.innerHTML=t('analyze');}stopThinkingAnimation();});
}

function analyzeLive(){
  var h=document.getElementById('homeTeam').value.trim();
  var a=document.getElementById('awayTeam').value.trim();
  if(!h||!a){showOut('<div class="err-box">'+t('errNoTeams')+'</div>');return;}
  var btn=document.getElementById('liveBtn');
  if(btn){btn.disabled=true;btn.innerHTML='<div class="live-dot"></div> '+t('analyzing');}
  showOut(thinkingHTML(true));
  startThinkingAnimation(true);
  callBackend(buildLivePrompt()).then(function(raw){
    var p=parse(raw);
    if(p&&p.live){saveHist({matches:[]},'live');showOut(renderLive(p.live,h,a,document.getElementById('scoreH').value||'0',document.getElementById('scoreA').value||'0',document.getElementById('liveMin').value||'45'));}
    else {
      showOut(
        '<div class="zero-edge">' +
        '<div class="zero-edge-icon"><svg width="34" height="34" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L15 14H1z"/><path d="M8 6.5v3.2M8 12h0"/></svg></div>' +
        '<div class="zero-edge-title">'+t('analysisFailed')+'</div>' +
        '<div class="zero-edge-sub">'+t('errParseFailLive')+'</div>' +
        '</div>' +
        '<button class="reset-btn" onclick="resetOut()">↺ ' + t('newAnalysis') + '</button>'
      );
    }
  }).catch(function(e){showOut('<div class="err-box">'+esc(e.message)+'</div>');})
  .finally(function(){if(btn){btn.disabled=false;btn.innerHTML='<div class="live-dot"></div> '+t('liveBtn');}stopThinkingAnimation();});
}

// ── RENDER ──
function showOut(h){document.getElementById('output').innerHTML=h;}
function resetOut(){document.getElementById('output').innerHTML='';window.scrollTo({top:0,behavior:'smooth'});}

// Messages dynamiques selon le temps écoulé
var PRE_MESSAGES = [
  [0,  'Scanning live data sources...'],
  [4,  'ESPN · NHL · Euroleague connected'],
  [8,  'AI — deep analysis mode'],
  [12, 'Analyzing form, H2H, injuries...'],
  [16, 'Calculating Value Bet & Kelly...'],
  [20, 'Cross-referencing stakes & context...'],
  [25, 'Deep tactical analysis in progress...'],
  [30, 'Identifying high-confidence edges...'],
  [35, 'Validating statistical models...'],
  [40, 'Finalizing recommendations...'],
  [45, 'Almost ready — quality check...'],
  [50, 'Precision analysis — worth the wait'],
];
var LIVE_MESSAGES = [
  [0,  'HT score registered'],
  [4,  'Live context analysis...'],
  [8,  'Recalculating probabilities...'],
  [12, '2nd half opportunities...'],
  [16, 'Kelly + Value calculation...'],
  [20, 'Finalizing live picks...'],
];
var _thinkingTimer = null;
var _thinkingStart = 0;

function thinkingHTML(live){
  var steps = live
    ? [['','Live score'],['','Confidence'],['','Events'],['','2nd half bets'],['','Kelly']]
    : [[chips.rot,'','C1 Rotations'],[chips.inj,'','Injuries'],
       [chips.form,'','Recent form'],[chips.h2h,'','H2H'],
       [chips.stake,'','Stakes'],[true,'','Value + Kelly']]
       .filter(function(s){return s[0];}).map(function(s){return[s[1],s[2]];});

  return '<div class="thinking" id="thinkingBox">'+
    '<div class="thinking-ring-wrap"><div class="t-ring"></div><div class="t-ring2"></div><div class="t-bolt"></div></div>'+
    '<div class="thinking-title">'+(live?'LIVE ANALYSIS':'ANALYZING')+'</div>'+
    '<div class="thinking-sub">SUPERCOACH · DEEP MODE</div>'+
    '<div class="thinking-timer" id="thinkingTimer">0<span>s</span></div>'+
    '<div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:2%"></div></div>'+
    '<div class="thinking-msg" id="thinkingMsg">'+(live?LIVE_MESSAGES[0][1]:PRE_MESSAGES[0][1])+'</div>'+
    '<div class="steps" id="thinkingSteps">'+
    steps.map(function(s,i){return '<div class="step" id="step-'+i+'">'+s[0]+' '+s[1]+'</div>';}).join('')+
    '</div></div>';
}

function startThinkingAnimation(live){
  _thinkingStart = Date.now();
  var msgs = live ? LIVE_MESSAGES : PRE_MESSAGES;
  var totalSteps = live ? 5 : 6;
  var msgIdx = 0;

  if(_thinkingTimer) clearInterval(_thinkingTimer);

  _thinkingTimer = setInterval(function(){
    var elapsed = Math.floor((Date.now() - _thinkingStart) / 1000);

    // Timer
    var timerEl = document.getElementById('thinkingTimer');
    if(timerEl) timerEl.innerHTML = elapsed + '<span>s</span>';

    // Progress bar — croît lentement, jamais à 100% avant la vraie fin
    // Avec thinking mode (~45s), progression adaptée
    var progress = Math.min(90, elapsed * 1.8);
    var fill = document.getElementById('progressFill');
    if(fill) fill.style.width = progress + '%';

    // Message dynamique
    for(var i = msgs.length-1; i >= 0; i--){
      if(elapsed >= msgs[i][0]){ msgIdx = i; break; }
    }
    var msgEl = document.getElementById('thinkingMsg');
    if(msgEl && msgEl.textContent !== msgs[msgIdx][1]){
      msgEl.style.opacity = '0';
      setTimeout(function(m){ return function(){
        var el = document.getElementById('thinkingMsg');
        if(el){ el.textContent = m; el.style.opacity = '1'; }
      };}(msgs[msgIdx][1]), 200);
    }

    // Étapes — allumer progressivement
    var stepToLight = Math.min(totalSteps-1, Math.floor(elapsed / 8));
    for(var j = 0; j < totalSteps; j++){
      var stepEl = document.getElementById('step-'+j);
      if(!stepEl) continue;
      if(j < stepToLight){ stepEl.className = 'step done'; }
      else if(j === stepToLight){ stepEl.className = 'step on'; }
      else { stepEl.className = 'step'; }
    }

  }, 500);
}

function stopThinkingAnimation(){
  if(_thinkingTimer){ clearInterval(_thinkingTimer); _thinkingTimer = null; }
  // Compléter la barre à 100%
  var fill = document.getElementById('progressFill');
  if(fill) fill.style.width = '100%';
}

function getType(r){return r==='WIN_HOME'||r==='WIN_AWAY'?'win':r==='DRAW'?'draw':'loss';}
function getVerdict(r,h,a){
  var hn=(h||'').split(' ').slice(0,2).join(' ');var an=(a||'').split(' ').slice(0,2).join(' ');
  if(r==='WIN_HOME')return statusSVG('check')+' '+hn;if(r==='WIN_AWAY')return statusSVG('check')+' '+an;return 'Draw';
}
function getSport(id){
  // Alias — normaliser les variantes de sport_id
  var alias = {
    'nhl':'hockey','ice hockey':'hockey','ice-hockey':'hockey',
    'nba':'basket','basketball':'basket',
    'nfl':'nfl','american football':'nfl',
    'soccer':'foot','football américain':'nfl',
    'ufc':'mma','boxing':'boxing','box':'boxing',
    'formula 1':'f1','formula1':'f1','motogp':'f1',
    'volleyball':'volley','handball':'handball'
  };
  var normalized = alias[(id||'').toLowerCase()] || id;
  var found = SPORTS.filter(function(s){return s.id===normalized;})[0];
  if(found) return found;
  // Fallback universel pour tout sport inconnu
  var icons = {
    nfl:'',nba:'',nhl:'',mlb:'',
    esports:'',cricket:'',golf:'',cycling:'',
    swimming:'',athletics:'',rugby:''
  };
  return {
    id:normalized,
    l:(id||'').toUpperCase(),
    e:icons[normalized]||icons[id]||'',
    c:'#8b949e',
    b:'rgba(139,148,158,.07)'
  };
}
function renderUnits(n){
  if(n===0)return '<div class="u-zero">'+t('doNotBet')+'</div>';
  var d='';for(var i=1;i<=5;i++)d+='<div class="udot '+(i<=n?'on':'off')+'"></div>';
  return '<div class="unit-dots">'+d+'</div><div class="ulbl">'+n+'/5 '+t('units').toUpperCase()+(n>1?'S':'')+'</div>';
}
function subBetIconSVG(type){
  var s='stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  var icons={
    scorer:'<circle cx="7" cy="7" r="5.5" '+s+'/><path d="M7 3l1.8 1.4-.7 2.1-2.2 0-.7-2.1z" '+s+'/>',
    goals:'<path d="M2 10h10M4 10V6.5L7 4l3 2.5V10" '+s+'/>',
    btts:'<circle cx="4.5" cy="7" r="3" '+s+'/><circle cx="9.5" cy="7" r="3" '+s+'/>',
    handicap:'<path d="M7 2v10M3 4h8M3 4l-1.5 4h3zM11 4l-1.5 4h3z" '+s+'/>',
    double_chance:'<rect x="2" y="2" width="7" height="9" rx="1" '+s+'/><rect x="5" y="4" width="7" height="9" rx="1" '+s+' fill="var(--s1)"/>',
    exact_score:'<rect x="1.5" y="4" width="4.5" height="6" rx="1" '+s+'/><rect x="8" y="4" width="4.5" height="6" rx="1" '+s+'/>',
    ht_ft:'<circle cx="7" cy="7" r="5.5" '+s+'/><path d="M7 3.5V7l2.4 1.4" '+s+'/>',
    method:'<path d="M2 9l3-3 2 2 5-5" '+s+'/><path d="M9 3h3v3" '+s+'/>',
    player_prop:'<circle cx="7" cy="4.5" r="2.2" '+s+'/><path d="M2.5 12c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" '+s+'/>',
    dnb:'<circle cx="7" cy="7" r="5.5" '+s+'/><path d="M4.3 4.3l5.4 5.4" '+s+'/>',
    comeback:'<path d="M3 8a4.5 4.5 0 108-3M3 8V4M3 8h4" '+s+'/>',
    winner:'<path d="M4 3h6v2.5a3 3 0 01-3 3 3 3 0 01-3-3V3z" '+s+'/><path d="M2 4h2M10 4h2M7 8.5V11M4.5 11h5" '+s+'/>',
  };
  return '<svg width="14" height="14" viewBox="0 0 14 14">'+(icons[type]||icons.winner)+'</svg>';
}
function renderSubBets(bets){
  if(!bets||bets.length===0) return '';
  var html='<div class="sub-bets"><div class="sub-bets-label">SMART PICKS</div>';
  bets.forEach(function(b){
    var label='', type='';
    if(typeof b === 'object' && b !== null){
      label = b.label || '';
      type  = b.type  || 'winner';
      // Le champ icon renvoyé par Gemini n'est JAMAIS affiché — l'app choisit
      // elle-même le pictogramme à partir du type sémantique, pas du texte généré.
    } else {
      // Ancien format string
      label = b;
      var bl = b.toLowerCase();
      if(bl.indexOf('buteur')>-1||bl.indexOf('scorer')>-1||bl.indexOf('anytime')>-1) { type='scorer'; }
      else if(bl.indexOf('over')>-1||bl.indexOf('under')>-1||bl.indexOf('buts')>-1||bl.indexOf('goals')>-1||bl.indexOf('points')>-1||bl.indexOf('runs')>-1||bl.indexOf('jeux')>-1) { type='goals'; }
      else if(bl.indexOf('both')>-1||bl.indexOf('btts')>-1||bl.indexOf('2 equipes')>-1||bl.indexOf('marquent')>-1) { type='btts'; }
      else if(bl.indexOf('handicap')>-1||bl.indexOf('asian')>-1||bl.indexOf('puck line')>-1||bl.indexOf('run line')>-1||bl.indexOf('spread')>-1) { type='handicap'; }
      else if(bl.indexOf('double chance')>-1||bl.indexOf('double_chance')>-1) { type='double_chance'; }
      else if(bl.indexOf('score exact')>-1||bl.indexOf('exact score')>-1) { type='exact_score'; }
      else if(bl.indexOf('mi-temps')>-1||bl.indexOf('ht/ft')>-1||bl.indexOf('half')>-1) { type='ht_ft'; }
      else if(bl.indexOf('ko')>-1||bl.indexOf('tko')>-1||bl.indexOf('decision')>-1||bl.indexOf('method')>-1) { type='method'; }
      else if(bl.indexOf('prop')>-1||bl.indexOf('bases')>-1||bl.indexOf('aces')>-1||bl.indexOf('joueur')>-1) { type='player_prop'; }
      else if(bl.indexOf('dnb')>-1||bl.indexOf('draw no bet')>-1||bl.indexOf('remboursement')>-1) { type='dnb'; }
      else if(bl.indexOf('comeback')>-1||bl.indexOf('retournement')>-1) { type='comeback'; }
      else { type='winner'; }
    }
    html += '<div class="sub-bet '+type+'">';
    html += '<span class="sub-bet-icon">'+subBetIconSVG(type)+'</span>';
    html += '<span class="sub-bet-label">'+esc(label)+'</span>';
    html += '</div>';
  });
  html+='</div>';
  return html;
}

function renderVB(m){
  // ── Calculs Kelly ──
  var conf   = (m.confidence||70)/100;
  var odds   = parseFloat(m.odds_given)||1.85;
  var ve     = m.value_edge_pct!=null ? parseFloat(m.value_edge_pct) :
               Math.round((conf - 1/odds)*100*100)/100;
  var kelly  = odds>1 ? Math.round((conf - (1-conf)/(odds-1))*10000)/100 : 0;
  var stake  = Math.min(10, Math.max(0, Math.round(kelly/4*10)/10)); // Kelly /4, cap 10%
  var veStr  = (ve>0?'+':'')+ve.toFixed(1)+'%';
  var veCls  = ve>=3?'strong':ve>=1?'light':'neutral';
  var veIco  = ve>=3?'':ve>=1?'':'';

  // ── Parser justification en piliers ──
  var just = m.justification||'';
  // Détecter les bullets (• ou - au début)
  var bullets = just.split(/\n|•|·/).map(function(s){return s.trim();}).filter(Boolean);

  // Mapper piliers depuis le texte de justification
  var pillars = {
    rot:   {ico:'', lbl:'C1 ROTATIONS', text:''},
    inj:   {ico:'', lbl:'INJURIES',     text:''},
    form:  {ico:'', lbl:'FORM',         text:''},
    h2h:   {ico:'', lbl:'H2H',          text:''},
    stake: {ico:'', lbl:'STAKES',       text:''},
  };
  bullets.forEach(function(b){
    var bl = b.toLowerCase();
    if(/rotat|c1|c3|european|squad|bench/.test(bl))       pillars.rot.text   = b;
    else if(/injur|absent|miss|bless|without|sans/.test(bl)) pillars.inj.text = b;
    else if(/form|streak|win|loss|momentum|serie/.test(bl))  pillars.form.text= b;
    else if(/h2h|head|historic|historique|face/.test(bl))    pillars.h2h.text = b;
    else if(/stake|relegat|title|maintien|enjeu|qualif/.test(bl)) pillars.stake.text=b;
  });
  // Texte restant non mappé → affecter au premier pilier vide
  var unmapped = bullets.filter(function(b){
    return !Object.values(pillars).some(function(p){return p.text===b;});
  });
  var emptyPillars = Object.keys(pillars).filter(function(k){return !pillars[k].text;});
  unmapped.forEach(function(b,i){
    if(emptyPillars[i]) pillars[emptyPillars[i]].text = b;
  });

  // ── Construire les lignes piliers ──
  var pillarRows = Object.values(pillars).filter(function(p){return p.text;}).map(function(p){
    return '<div class="ds-pillar"><span class="ds-pico">'+p.ico+'</span>'+
           '<div><span class="ds-plbl">'+p.lbl+'</span>'+
           '<span class="ds-ptxt">'+esc(p.text)+'</span></div></div>';
  }).join('');

  // ── Bloc DeepSeek ──
  return '<div class="ds-block">'+
    // Header value
    '<div class="ds-header '+veCls+'">'+
      '<span class="ds-vico">'+veIco+'</span>'+
      '<div class="ds-vtext">'+
        '<span class="ds-vedge">EDGE '+veStr+'</span>'+
        '<span class="ds-vprob">Prob. réelle : <b>'+Math.round(conf*100)+'%</b></span>'+
      '</div>'+
      '<div class="ds-kelly">'+
        '<span class="ds-klbl">KELLY</span>'+
        '<span class="ds-kval">'+stake+'%</span>'+
        '<span class="ds-kcap">capital</span>'+
      '</div>'+
    '</div>'+
    // Piliers
    (pillarRows ? '<div class="ds-pillars">'+pillarRows+'</div>' : '')+
  '</div>';
}

function renderMarketBadge(market, confidence) {
  if (!market) return '';
  var homeProb = market.homeProb || 0;
  var awayProb = market.awayProb || 0;
  var edge = confidence ? (confidence - homeProb) : null;
  var edgeStr = edge !== null
    ? ' <span style="color:' + (edge >= 0 ? '#00E676' : '#FF2D55') + ';font-weight:700">' +
      (edge >= 0 ? '+' : '') + Math.round(edge) + '% SUPERCOACH vs MARKET</span>'
    : '';
  var syncStr = '';
  if (market.syncedAt) {
    var mins = Math.round((Date.now() - new Date(market.syncedAt).getTime()) / 60000);
    syncStr = ' · <span style="color:#64748b;font-size:9px">synced ' + mins + 'min ago</span>';
  }
  return '<div style="background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.25);' +
    'border-radius:8px;padding:10px 14px;margin:8px 0;font-family:JetBrains Mono,monospace;font-size:11px">' +
    '<div style="color:#8b5cf6;font-weight:700;font-size:9px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">' +
    esc(market.source) + syncStr + '</div>' +
    '<div style="display:flex;gap:16px;align-items:center">' +
    '<div style="text-align:center"><div style="font-size:16px;font-weight:700;color:#e2e8f0">' + homeProb + '%</div>' +
    '<div style="font-size:9px;color:#64748b;text-transform:uppercase">Market YES</div></div>' +
    '<div style="text-align:center"><div style="font-size:16px;font-weight:700;color:#e2e8f0">' + awayProb + '%</div>' +
    '<div style="font-size:9px;color:#64748b;text-transform:uppercase">Market NO</div></div>' +
    (edgeStr ? '<div style="font-size:11px">' + edgeStr + '</div>' : '') +
    '</div>' +
    (market.volume > 0 ? '<div style="color:#64748b;font-size:9px;margin-top:4px">Vol: $' + Math.round(market.volume).toLocaleString() + '</div>' : '') +
    '</div>';
}

function renderDataRichness(stars) {
  if (!stars) return '';
  var s = '';
  for (var i = 1; i <= 5; i++) {
    s += '<span style="color:' + (i <= stars ? '#FFB800' : '#1e2530') + '"></span>';
  }
  return '<div style="font-family:JetBrains Mono,monospace;font-size:9px;color:#64748b;margin:4px 0">DATA ' + s + '</div>';
}

function renderResults(data){
  var M=data.matches||[];

  // RÈGLE 1 — Si aucun match avec confidence ≥ 70%, afficher Zero Edge
  var highConf = M.filter(function(m){return m.confidence>=70;});
  if(M.length>0 && highConf.length===0){
    return '<div class="zero-edge">'+
      '<div class="zero-edge-icon"><svg width="34" height="34" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L15 14H1z"/><path d="M8 6.5v3.2M8 12h0"/></svg></div>'+
      '<div class="zero-edge-title">ZERO EDGE DETECTED</div>'+
      '<div class="zero-edge-sub">'+
        'No match meets the minimum threshold of <b>70% confidence</b>.<br><br>'+
        'Not betting is a strategic decision.<br>'+
        'SUPERCOACH protects your bankroll.'+
      '</div>'+
      '</div>'+
      '<button class="reset-btn" onclick="resetOut()">'+t('newAnalysis')+'</button>';
  }

  // Garder tous les matchs >= 70% de confiance
  // Le badge Value n'apparaît que si edge détecté (géré par renderVB)
  M = highConf.map(function(m,i){
    return Object.assign({},m,{rank:i+1});
  });

  var wins=M.filter(function(m){return getType(m.result)==='win';}).length;
  var draws=M.filter(function(m){return m.result==='DRAW';}).length;
  var losses=M.filter(function(m){return getType(m.result)==='loss';}).length;
  var roi=data.roi_potential?'<div class="roi-strip"><span style="font-size:15px"></span><div class="roi-strip-text"><b>'+t('potRoi')+'</b> · '+esc(data.roi_potential)+'</div></div>':'';
  var stats='<div class="stats-row">'+
    '<div class="stat-box" style="border-top:2px solid #4ade80"><div class="stat-num" style="color:#4ade80">'+wins+'</div><div class="stat-lbl">'+t('wins')+'</div></div>'+
    '<div class="stat-box" style="border-top:2px solid #6e7681"><div class="stat-num" style="color:#8b949e">'+draws+'</div><div class="stat-lbl">'+t('draws')+'</div></div>'+
    '<div class="stat-box" style="border-top:2px solid #ef4444"><div class="stat-num" style="color:#ef4444">'+losses+'</div><div class="stat-lbl">'+t('losses')+'</div></div></div>';
  var cards=M.map(function(m,i){
    var type=getType(m.result);var sp=getSport(m.sport_id);
    var dh='';
    if (m.live && m.minute) {
      // Match live — afficher timer + variantes
      dh = renderLiveTimer(m.minute, m.score_home, m.score_away, m.sport_id||'foot');
    } else if ((m.match_date&&m.match_date!=='?')||(m.match_time&&m.match_time!=='')) {
      dh = '<span class="mc-date">'+(m.match_date||'')+(m.match_time?' · '+m.match_time:'')+(m.date_uncertain?' ':'')+'</span>';
    }
    // Ligne de Lecture courte pour la surface — première phrase de la vraie justification
    // produite par le moteur, jamais inventée. Pas de %, pas de jargon.
    var justRaw = (m.justification||'').split(/\n|•|·/).map(function(s){return s.trim();}).filter(Boolean)[0] || '';
    var readingLine = justRaw ? '<div class="mc-reading">'+esc(justRaw)+'</div>' : '';
    return '<div class="mcard '+type+'" style="animation-delay:'+(i*55)+'ms" onclick="this.classList.toggle(\'expanded\')">'+
      '<div class="mc-sum"><div class="mc-top">'+
      '<div class="mc-sport" style="background:'+sp.b+';border:1px solid '+sp.c+'22;color:'+sp.c+'">'+sportSVG(sp.id,17)+'</div>'+
      '<div class="mc-info">'+
      '<div class="mc-teams">'+esc(m.home)+'<span class="mc-vs">—</span>'+esc(m.away)+(m.rotation_alert?'<span class="rot-tag">ROT</span>':'')+'</div>'+
      '<div class="mc-meta">'+(m.competition?'<span class="mc-comp">'+esc(m.competition)+'</span>':'')+
      '<span class="mc-verdict '+type+'">'+getVerdict(m.result,m.home,m.away)+'</span>'+dh+'</div>'+
      readingLine+
      '</div></div></div>'+
      '<div class="mc-hint"><span>'+t('tapDetails')+'</span><span class="hint-arr">▼</span></div>'+
      '<div class="mc-det"><div class="mc-det-inner">'+
      '<div class="mc-conf-row"><div class="mc-conf-num '+type+'">'+m.confidence+'<span style="font-size:12px">%</span></div><div class="mc-conf-lbl">'+t('confLabel')+'</div></div>'+
      '<div class="mc-bar"><div class="mc-bar-bg"><div class="mc-bar-fill '+type+'" style="width:'+m.confidence+'%"></div></div></div>'+
      '<div class="mc-units">'+renderUnits(m.units)+'</div>'+
      renderSubBets(m.sub_bets)+
      renderVB(m)+renderMarketBadge(m._market||null, m.confidence)+renderDataRichness(m._dataRichness||null)+
      (m.rotation_alert&&m.rotation_text?'<div class="mc-rot-alert">'+esc(m.rotation_text)+'</div>':'')+
      '</div></div></div>';
  }).join('');
  var synth = renderLabBlock(M);
  lastResults = {matches: M, summary: data.summary||''};
  return '<div class="results"><div class="res-hdr"><h2>'+M.length+' Match'+(M.length>1?'es':'')+'</h2></div>'+roi+stats+cards+synth+
    '<button class="share-btn" onclick="shareResults()">'+t('shareAnalysis')+'</button>'+
    '<button class="reset-btn" onclick="resetOut()">'+t('newAnalysis')+'</button></div>';
}

function renderLive(la,h,a,sh,sa,min){
  var delta=la.delta||'';var dc=delta.charAt(0)==='+?'?'#4ade80':'#ef4444';
  var bets=(la.bets||[]).map(function(b){
    var rl=b.rec==='strong'?'Strong signal':b.rec==='light'?'Worth watching':b.rec==='avoid'?'Avoid':'Neutral';
    var rc=b.rec==='strong'?'strong':b.rec==='light'?'light':b.rec==='avoid'?'avoid':'neutral';
    return '<div class="lpc" onclick="this.classList.toggle(\'expanded\')">'+
      '<div class="lpc-top"><div class="lpc-marche">'+esc(b.market||'2nd Half Market')+'</div></div>'+
      '<div class="lpc-reading">'+esc(b.reason||'')+'</div>'+
      '<div class="lpc-det"><div class="lpc-det-inner">'+
      '<div class="lpc-conf-row"><div class="lpc-cnum">'+(b.confidence||65)+'%</div><div class="lpc-clbl">'+t('confLabel')+'</div></div>'+
      '<div class="lpc-bar"><div class="lpc-bar-bg"><div class="lpc-bar-fill" style="width:'+(b.confidence||65)+'%"></div></div></div>'+
      '<div class="mc-units">'+renderUnits(b.units||1)+'</div>'+
      '<div class="vbadge '+rc+'">'+rl+'</div></div></div></div>';
  }).join('');
  return '<div class="results"><div class="res-hdr"><h2>'+esc(h)+' — '+esc(a)+'</h2><div class="res-meta">HT · '+min+'\'</div></div>'+
    '<div class="live-banner"><div class="lrb-row">'+
    '<div class="lrb-team">'+esc(h)+'</div><div class="lrb-score">'+sh+'</div>'+
    '<div class="lrb-sep">—</div><div class="lrb-score">'+sa+'</div>'+
    '<div class="lrb-team">'+esc(a)+'</div><span class="lrb-time">HT '+min+'\'</span></div>'+
    '<div class="lrb-impact">'+esc(la.key_events||'')+'</div>'+
    '<div class="lrb-conf" onclick="this.classList.toggle(\'open\')"><div class="lrb-clbl">'+t('confLabel')+'</div>'+
    '<div class="lrb-cnum">'+(la.confidence_updated||'?')+'%</div>'+
    '<span class="lrb-delta" style="color:'+dc+'">('+delta+')</span></div></div>'+
    (bets?'<div class="live-paris-title"><div class="live-dot"></div> '+t('secondHalf')+'</div>'+bets:'')+
    (la.summary?'<div class="synthesis">'+esc(la.summary)+'</div>':'')+
    '<button class="reset-btn" onclick="resetOut()">'+t('newAnalysis')+'</button></div>';
}

// ── HISTORY & ROI ──
function saveHist(data,m,dbIds){
  var h=JSON.parse(localStorage.getItem('sc_hist')||'[]');
  h.unshift({id:Date.now(),date:new Date().toLocaleString('en-US'),mode:m,
    matches:(data.matches||[]).map(function(x,i){
      return {
        home:x.home,away:x.away,result:x.result,
        confidence:x.confidence,units:x.units,
        value:x.value,sport_id:x.sport_id,
        verified:null,
        db_id:(dbIds&&dbIds[i])||null  // ID Neon pour sync backend
      };
    })});
  localStorage.setItem('sc_hist',JSON.stringify(h.slice(0,50)));
}

function openROI(){
  var hist=JSON.parse(localStorage.getItem('sc_hist')||'[]');
  var body=document.getElementById('roiBody');
  if(!hist.length){
    body.innerHTML='<div class="roi-empty">'+t('roiEmptyTitle')+'<br><br>'+t('roiEmptySub')+'</div>';
    openSheet('roiModal');return;
  }
  var tv=0,tok=0,tu=0;
  hist.forEach(function(h){h.matches.forEach(function(m){if(m.verified!==null){tv++;tu+=m.units;if(m.verified)tok++;}});});
  var wr=tv>0?(tok/tv*100).toFixed(0):null;
  var roi=tu>0?((tok/tv*tu-tu)/tu*100).toFixed(1):null;
  var rc=Number(roi)>=0?'#4ade80':'#ef4444';
  var roiBlock=tv>0?
    '<div class="roi-overview"><div class="roi-ov-title">'+t('journalTitle')+'</div><div class="roi-grid">'+
    '<div class="roi-stat"><div class="roi-stat-num" style="color:#4ade80">'+tv+'</div><div class="roi-stat-lbl">'+t('roiVerified')+'</div></div>'+
    '<div class="roi-stat"><div class="roi-stat-num" style="color:'+rc+'">'+roi+'%</div><div class="roi-stat-lbl">ROI</div></div>'+
    '<div class="roi-stat"><div class="roi-stat-num" style="color:var(--gold2)">'+wr+'%</div><div class="roi-stat-lbl">'+t('roiWinRate')+'</div></div>'+
    '<div class="roi-stat"><div class="roi-stat-num" style="color:var(--text3)">'+tu+'u</div><div class="roi-stat-lbl">'+t('roiUnitsBet')+'</div></div>'+
    '</div><div class="roi-hint">'+t('roiTapHint2')+'</div></div>':
    '<div class="roi-overview"><div class="roi-ov-title">'+t('journalTitle')+'</div><div class="roi-hint">'+t('roiTapHint2')+'</div></div>';
  var items=hist.map(function(h,hi){
    var ms=h.matches.map(function(m,mi){
      var type=getType(m.result);var sp=getSport(m.sport_id);
      var cls='hm '+type+(m.verified===true?' ok':m.verified===false?' ko':'');
      return '<span class="'+cls+'" onclick="toggleVerify('+hi+','+mi+')"><span class="hm-ico">'+sportSVG(sp.id,11)+'</span> '+(m.home||'').split(' ')[0]+' '+(m.verified===true?statusSVG('check'):m.verified===false?statusSVG('cross'):'')+'</span>';
    }).join('');
    return '<div class="hist-entry"><div class="hist-hdr">'+
      '<span class="hist-date">'+h.date+'</span>'+
      '<div class="hist-info"><span class="hist-mode '+(h.mode||'pre')+'">'+(h.mode==='live'?t('roiLiveLabel'):t('roiPreLabel'))+'</span>'+
      '<span class="hist-cnt">'+h.matches.length+' '+t('roiMatchesLabel')+'</span></div></div>'+
      (ms?'<div class="hist-matches">'+ms+'</div>':'')+
    '</div>';
  }).join('');
  body.innerHTML=roiBlock+items+'<button class="hist-clear" onclick="clearHist()">'+t('clearHistory')+'</button>';
  openSheet('roiModal');
}

function toggleVerify(hi,mi){
  var h=JSON.parse(localStorage.getItem('sc_hist')||'[]');
  if(!h[hi])return;
  var match=h[hi].matches[mi];
  var cur=match.verified;
  var next=cur===null?true:cur===true?false:null;
  match.verified=next;
  localStorage.setItem('sc_hist',JSON.stringify(h));

  // Sync avec Neon si db_id disponible
  if(match.db_id && next !== null){
    fetch(BACKEND+'/outcome',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        id: match.db_id,
        result: match.result || '',
        correct: next === true
      })
    }).then(function(){
      console.log('[DB] Résultat syncé:', match.db_id, next===true?'✓':'✗');
    }).catch(function(e){
      console.log('[DB] Sync échouée (mode offline):', e.message);
    });
  }

  openROI();
}
function clearHist(){if(confirm(t('clearHistory')+'?')){localStorage.removeItem('sc_hist');openROI();}}

// ── MODALS ──
function openSheet(id){document.getElementById(id).classList.add('open');}
function closeSheet(id){document.getElementById(id).classList.remove('open');}
document.addEventListener('click',function(ev){
  document.querySelectorAll('.overlay.open').forEach(function(o){
    if(ev.target===o)o.classList.remove('open');
  });
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape')document.querySelectorAll('.overlay.open').forEach(function(o){o.classList.remove('open');});
  if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){if(mode==='live')analyzeLive();else analyze();}
});

// ── UTILS ──
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ══════════════════════════════════
// RÈGLE 7 — PARTAGE SOCIAL
// ══════════════════════════════════
var lastResults = null;

function shareResults() {
  if (!lastResults || !lastResults.matches || !lastResults.matches.length) return;
  var M = lastResults.matches;
  var summary = lastResults.summary;
  var now = new Date();
  var timeStr = now.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:true});
  var dateStr = now.toLocaleDateString('en-GB', {day:'2-digit', month:'2-digit', year:'numeric'});

  var lines = [];
  lines.push('SUPERCOACH ANALYSIS');
  lines.push('' + dateStr + ' · ' + timeStr);
  lines.push('─────────────────────');

  var ranked = M.filter(function(m){return m.units > 0;})
               .sort(function(a,b){return b.confidence-a.confidence;})
               .slice(0,5);

  ranked.forEach(function(m) {
    var verdict = m.result==='WIN_HOME' ? m.home : m.result==='WIN_AWAY' ? m.away : 'DRAW';
    lines.push(m.home + ' vs ' + m.away);
    lines.push(verdict + ' · ' + m.confidence + '% · ' + m.units + '/5 units');
    if (m.sub_bets && m.sub_bets.length > 0) {
      lines.push('  ' + m.sub_bets.join('  '));
    }
    lines.push('');
  });

  lines.push('─────────────────────');
  if (summary) lines.push('' + summary);
  lines.push('');
  lines.push('Powered by SUPERCOACH');
  lines.push('Analysis only · Gamble responsibly 18+');

  var text = lines.join('\n');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showToast(t('shareCopied'));
    }).catch(function() {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try {
    document.execCommand('copy');
    showToast(t('shareCopied'));
  } catch(e) {
    showToast(t('shareLongPress'));
  }
  document.body.removeChild(ta);
}

function showToast(msg) {
  var el = document.getElementById('shareToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function(){ el.classList.remove('show'); }, 3000);
}


function clearInput(){
  var ta=document.getElementById('manualInput');
  if(ta){ta.value='';ta.focus();}
  var cb=document.getElementById('clearBtn');
  if(cb)cb.style.display='none';
}
function clearPasteInput(){
  var ta=document.getElementById('pasteInput');
  if(ta){ta.value='';ta.focus();}
  var cb=document.getElementById('clearBtnPaste');
  if(cb)cb.style.display='none';
  var st=document.getElementById('urlStatus');
  if(st)st.textContent='';
  var ui=document.getElementById('urlInput');
  if(ui)ui.value='';
}

async function fetchUrl(){
  var urlInput=document.getElementById('urlInput');
  var status=document.getElementById('urlStatus');
  var btn=document.getElementById('urlFetchBtn');
  var textarea=document.getElementById('pasteInput');
  var url=(urlInput?urlInput.value:'').trim();
  if(!url){if(status){status.className='url-status err';status.textContent='Colle une URL';}return;}
  if(!url.startsWith('http'))url='https://'+url;
  if(btn){btn.disabled=true;btn.textContent='⏳';}
  if(status){status.className='url-status loading';status.textContent='Chargement...';}
  try{
    var resp=await fetch(BACKEND+'/scrape',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url})});
    var data=await resp.json();
    if(data.success){
      if(textarea)textarea.value=data.content;
      if(status){status.className='url-status ok';status.textContent=''+data.hostname+' — '+data.chars+' chars';}
    }else if(data.blocked){
      if(status){status.className='url-status err';status.textContent=''+data.message;}
    }else{
      if(status){status.className='url-status err';status.textContent=''+(data.message||'Erreur');}
    }
  }catch(err){
    if(status){status.className='url-status err';status.textContent=''+err.message;}
  }finally{
    if(btn){btn.disabled=false;btn.textContent='FETCH';}
  }
}

function openSettings(){
  openSheet('settingsModa');
  applyLang();
  var t24=document.getElementById('toggle24h');
  if(t24) t24.checked = clockIs24h;
  var tDiag=document.getElementById('toggleDiag');
  if(tDiag) tDiag.checked = localStorage.getItem('sc_diag')!=='0';
  var tSub=document.getElementById('toggleSubBets');
  if(tSub) tSub.checked = localStorage.getItem('sc_subbets')!=='0';
}
function closeSettings(){
  closeSheet('settingsModa');
}
function toggleClock24(v){
  clockIs24h=v;
  localStorage.setItem('sc_clock24',v?'1':'0');
  updateClock();
}
function toggleDiagnostic(v){
  localStorage.setItem('sc_diag',v?'1':'0');
}
function toggleSubBetsSetting(v){
  localStorage.setItem('sc_subbets',v?'1':'0');
}
function clearROIHistory(){
  if(confirm('Effacer l\'historique ROI ?')){
    localStorage.removeItem('sc_hist');
    closeSettings();
  }
}
function checkHealth(){
  var el=document.getElementById('settingsBackendUrl');
  if(el)el.textContent='Vérification...';
  fetch(BACKEND+'/health').then(function(r){return r.json();}).then(function(d){
    var models=Object.entries(d.models||{}).map(function(e){return e[0].replace('gemini-','')+'→'+e[1];}).join(' | ');
    if(el)el.textContent=models||'OK';
  }).catch(function(){
    if(el)el.textContent='Serveur inaccessible';
  });
}
function openLegal(){
  openSheet('legalModal');
}
window.onerror=function(msg,src,line){console.error('ERR:',msg,line);};

function bootUI(){
  if (window._scBooted) return;
  window._scBooted = true;
  try { if (typeof buildSportGrid==="function") buildSportGrid(); } catch(e) {}
  try { if (typeof applyLang==="function") applyLang(); } catch(e) {}
  try { if (typeof loadFluxMatches==="function") loadFluxMatches(); } catch(e) {}
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootUI);
else setTimeout(bootUI, 0);
