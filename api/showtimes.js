const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Always build timestamps anchored to America/New_York, regardless of server timezone.
function parseShowtime(timeStr) {
  if (!timeStr) return null;
  const clean = timeStr.trim().toLowerCase().replace(/\s+/g, '');
  const match = clean.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (match[3] === 'pm' && h !== 12) h += 12;
  if (match[3] === 'am' && h === 12) h = 0;

  const now = new Date();

  // Get today's date parts in NYC and compute the UTC offset.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false,
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const nyY = +parts.year, nyM = +parts.month - 1, nyD = +parts.day;
  const nyH = +parts.hour === 24 ? 0 : +parts.hour;
  const nyMin = +parts.minute, nySec = +parts.second;

  // offsetMs = how much NYC "appears" ahead of UTC when treated naively.
  // e.g. EDT (-4h): offsetMs ≈ -14 400 000
  const offsetMs = Date.UTC(nyY, nyM, nyD, nyH, nyMin, nySec) - now.getTime();

  // UTC timestamp for today's NYC midnight, then add the showtime.
  let ts = Date.UTC(nyY, nyM, nyD) - offsetMs + (h * 3600 + m * 60) * 1000;
  if (isNaN(ts)) return null;

  // If the showtime has passed by more than 2 h, assume it's tomorrow.
  if (ts < now.getTime() - 2 * 3600000) ts += 24 * 3600000;
  return ts;
}

// Return true if a Date object falls on today in NYC.
function isNYCToday(dateObj) {
  const fmt = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  return fmt(dateObj) === fmt(new Date());
}

// Detect and strip Open Caption / OC markers from a string.
// Returns { clean: string, oc: boolean }
// Catches: "OC", "(OC)", "[OC]", "Open Caption", "Open Captions", "Open Captioned"
// anywhere in the string, with optional surrounding brackets/parens/whitespace.
function stripOC(s) {
  if (!s) return { clean: '', oc: false };
  const PAT = /\s*[\(\[]?\b(open\s+caption(?:s|ed|ing)?|O\.?C\.?)\b[\)\]]?\s*/gi;
  const oc = PAT.test(s);
  PAT.lastIndex = 0;
  const clean = s.replace(PAT, ' ').replace(/\s{2,}/g, ' ').trim();
  return { clean, oc };
}

// ── Nitehawk (Prospect Park + Williamsburg) ───────────────────────────────────
// Uses the Filmbot/Nightjar REST API: /wp-json/nj/v1/showtime/listings
// Response: { movies: [{movie_id, movie_name}], showtimes: [{movie_id, datetime, purchase_url}] }
// datetime format: "YYYYMMDDHHmmss" in America/New_York time
// OC info is NOT in the API — only in the rendered HTML as class="has-open-captions"
// on <a data-showtime_id="XXXXXX"> elements. We fetch both and cross-reference by ID.
async function fetchNitehawk(theater) {
  const [apiResult, htmlResult] = await Promise.allSettled([
    axios.get(`${theater.api_base}/wp-json/nj/v1/showtime/listings`, { headers: { 'User-Agent': UA }, timeout: 12000 }),
    axios.get(theater.api_base + '/', { headers: { 'User-Agent': UA }, timeout: 12000 }),
  ]);

  // If the main API failed, fail the whole scraper
  if (apiResult.status === 'rejected') throw apiResult.reason;
  const data = apiResult.value.data;

  // OC detection is best-effort — HTML failure just means oc: false on all times
  const ocIds = new Set();
  if (htmlResult.status === 'fulfilled') {
    const $h = cheerio.load(htmlResult.value.data);
    $h('a.has-open-captions[data-showtime_id]').each((_, el) => {
      ocIds.add(String($h(el).attr('data-showtime_id')));
    });
  } else {
    console.warn(`[nitehawk] OC HTML fetch failed for ${theater.id}:`, htmlResult.reason?.message);
  }

  // Today's date in NYC as "YYYYMMDD" for filtering
  const todayNYC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(new Date()).replace(/-/g, '');

  // Build movie_id → name lookup
  const movieMap = {};
  for (const m of data.movies || []) movieMap[m.movie_id] = m.movie_name;

  const movies = {};
  for (const st of data.showtimes || []) {
    if (!st.datetime || st.datetime.slice(0, 8) !== todayNYC) continue;
    const rawTitle = movieMap[st.movie_id];
    if (!rawTitle) continue;
    const { clean: title, oc: titleOC } = stripOC(rawTitle);
    // Extract showtime ID from purchase_url: ".../purchase/22003176/"
    const idMatch = (st.purchase_url || '').match(/\/purchase\/(\d+)/);
    const oc = titleOC || (idMatch ? ocIds.has(idMatch[1]) : false);

    // datetime "20260316213000" → NYC local 21:30 → 9:30pm
    const h = parseInt(st.datetime.slice(8, 10));
    const min = parseInt(st.datetime.slice(10, 12));
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const display = `${h12}:${String(min).padStart(2, '0')}${ampm}`;
    const ts = parseShowtime(display);
    if (!ts) continue;

    if (!movies[title]) movies[title] = { title, link: st.purchase_url || theater.link, times: [] };
    if (!movies[title].times.find(t => t.timestamp === ts)) {
      movies[title].times.push({ display, timestamp: ts, oc });
    }
  }

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Film Forum ────────────────────────────────────────────────────────────────
// Tabs are rolling from today: #tabs-0 = today, #tabs-1 = tomorrow, etc.
// Times are in <span> tags inside <p> blocks, no AM/PM.
async function fetchFilmForum(theater) {
  const { data: html } = await axios.get('https://filmforum.org/', {
    headers: { 'User-Agent': UA },
    timeout: 12000,
  });
  const $ = cheerio.load(html);
  const movies = {};

  // tabs-0 is always today regardless of day of week
  const $tab = $('#tabs-0');
  if (!$tab.length) {
    console.error('[filmforum] #tabs-0 not found');
    return [];
  }

  // Film Forum bare-time inference:
  // 12:xx → 12pm (noon), 1–9:xx → PM, 10–11:xx → AM (morning matinee)
  function bareTimeTo24(h, m) {
    if (h === 12) return { h24: 12, ap: 'pm' };
    if (h >= 1 && h <= 9) return { h24: h + 12, ap: 'pm' };
    return { h24: h, ap: 'am' }; // 10 or 11
  }

  $tab.find('a[href*="/film/"]').each((_, linkEl) => {
    const { clean: title, oc: titleOC } = stripOC($(linkEl).text().trim());
    if (!title || title.length < 2) return;

    // Times are plain text in the same parent block, after the title
    const $parent = $(linkEl).closest('p, li, td, div').first();
    const fullText = $parent.text();
    const afterIdx = fullText.indexOf($(linkEl).text().trim());
    const afterText = afterIdx >= 0 ? fullText.slice(afterIdx + $(linkEl).text().trim().length) : fullText;
    const { oc: contextOC } = stripOC(afterText);
    const oc = titleOC || contextOC;

    const matches = [...afterText.matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
    for (const m of matches) {
      const h = parseInt(m[1]), min = parseInt(m[2]);
      const { ap } = bareTimeTo24(h, min);
      const display = `${h}:${String(min).padStart(2, '0')}${ap}`;
      const ts = parseShowtime(display);
      if (!ts) continue;
      if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
      if (!movies[title].times.find(x => x.timestamp === ts)) {
        movies[title].times.push({ display, timestamp: ts, oc });
      }
    }
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── IFC Center ───────────────────────────────────────────────────────────────
async function fetchIFC(theater) {
  const { data: html } = await axios.get('https://www.ifccenter.com/', {
    headers: { 'User-Agent': UA },
    timeout: 12000,
  });
  const $ = cheerio.load(html);
  const movies = {};

  // Page structure: date headers are plain <h3> siblings ("Mon Mar 16"),
  // followed by <div> siblings each containing a film <h3><a href="/films/..."> and a <ul> of showtimes.
  // The next date <h3> ends that day's section.

  // Build today's header string in IFC's format: "Mon Mar 16"
  const todayHeader = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date()).replace(',', '').trim();

  // Find the h3 whose text matches today
  const $todayH3 = $('h3').filter((_, el) =>
    $(el).text().replace(',', '').trim() === todayHeader
  ).first();

  if (!$todayH3.length) {
    console.error('[ifc] today header not found, looked for:', todayHeader);
    return [];
  }

  // nextUntil('h3') collects all direct siblings until the next date h3
  const $todaySection = $todayH3.nextUntil('h3');

  $todaySection.find('h3:has(a[href*="/films/"])').each((_, titleEl) => {
    const { clean: title, oc: titleOC } = stripOC($(titleEl).find('a').first().text().trim());
    if (!title) return;

    const $ul = $(titleEl).nextAll('ul').first();
    if (!$ul.length) return;

    $ul.find('a[href*="tickets.ifccenter.com"]').each((_, linkEl) => {
      const timeText = $(linkEl).text().trim();
      const { oc: timeOC } = stripOC(timeText);
      const oc = titleOC || timeOC;
      const match = timeText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
      if (!match) return;
      const display = match[1].toLowerCase().replace(/\s+/g, '');
      const ts = parseShowtime(display);
      if (!ts) return;
      if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
      // Deduplicate
      if (!movies[title].times.find(t => t.timestamp === ts)) {
        movies[title].times.push({ display, timestamp: ts, oc });
      }
    });
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Metrograph ───────────────────────────────────────────────────────────────
// Calendar page: each date gets its own container:
//   <div class="calendar-list-day movies-grid" id="calendar-list-day-YYYY-MM-DD">
// Film items inside: <div class="item ..."><h4><a class="title">Title</a></h4>
//                    <div class="showtimes"><a href="t.metrograph.com/...">4:00pm</a></div></div>
async function fetchMetrograph(theater) {
  const todayNYC = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(new Date()); // "2026-03-17"

  const { data: html } = await axios.get(
    `https://metrograph.com/calendar/?date=${todayNYC}`,
    { headers: { 'User-Agent': UA }, timeout: 15000 }
  );
  const $ = cheerio.load(html);
  const movies = {};

  const $todayDiv = $(`#calendar-list-day-${todayNYC}`);
  if (!$todayDiv.length) {
    console.error('[metrograph] today container not found: #calendar-list-day-' + todayNYC);
    return [];
  }

  $todayDiv.find('.item').each((_, item) => {
    const $item = $(item);
    // Use only direct text nodes of the anchor — avoids picking up nested date/venue spans
    const $a = $item.find('h4 a').first();
    const rawTitle = $a.contents().filter((_, n) => n.type === 'text').map((_, n) => n.data).get().join('').trim()
      || $a.text().split(/[\n·•|]/)[0].trim(); // fallback
    const { clean: title } = stripOC(rawTitle);
    if (!title) return;

    $item.find('div.showtimes a').each((_, linkEl) => {
      const timeText = $(linkEl).text().trim();
      const { oc } = stripOC(timeText);
      const match = timeText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
      if (!match) return;
      const display = match[1].toLowerCase().replace(/\s+/g, '');
      const ts = parseShowtime(display);
      if (!ts) return;
      if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
      if (!movies[title].times.find(t => t.timestamp === ts)) {
        movies[title].times.push({ display, timestamp: ts, oc });
      }
    });
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Alamo Drafthouse ─────────────────────────────────────────────────────────
// v2 mother API: drafthouse.com/s/mother/v2/schedule/market/nyc
// Returns { data: { presentations: [{slug, show:{title}, ...}], sessions: [{cinemaId, presentationSlug,
//   showTimeClt, formatSlug, status, ...}] } }
// showTimeClt is "2026-03-17T21:45:00" in cinema-local time. cinemaId "2101" = Brooklyn.
async function fetchAlamo(theater) {
  const { data: body } = await axios.get(
    'https://drafthouse.com/s/mother/v2/schedule/market/nyc',
    { headers: { 'User-Agent': UA }, timeout: 15000 }
  );

  const todayNYC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(new Date()); // "2026-03-17"

  const { presentations = [], sessions = [] } = body?.data ?? {};

  // Build slug → title + show URL lookup from presentations
  const presMap = {};
  for (const p of presentations) {
    const title = p.show?.title || p.slug;
    presMap[p.slug] = {
      title,
      link: `https://drafthouse.com/nyc/show/${p.slug}`,
    };
  }

  const movies = {};

  for (const session of sessions) {
    // Filter to Brooklyn (cinemaId 2101) and today only
    if (session.cinemaId !== theater.cinema_id) continue;
    if (session.status === 'PAST') continue;
    if (!(session.showTimeClt || '').startsWith(todayNYC)) continue;

    const pres = presMap[session.presentationSlug];
    if (!pres) continue;
    const { clean: title } = stripOC(pres.title);
    if (!title) continue;

    // OC: formatSlug === 'open-caption' or sessionAttributeSlugs contains it
    const oc = session.formatSlug === 'open-caption' ||
      (session.sessionAttributeSlugs || []).some(s => s.toLowerCase().includes('open-caption') || s.toLowerCase().includes('open caption'));

    const dtMatch = (session.showTimeClt || '').match(/T(\d{2}):(\d{2})/);
    if (!dtMatch) continue;
    const h = parseInt(dtMatch[1]), min = parseInt(dtMatch[2]);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const display = `${h12}:${String(min).padStart(2, '0')}${ampm}`;
    const ts = parseShowtime(display);
    if (!ts) continue;

    const ticketUrl = `https://drafthouse.com/nyc/tickets/${session.sessionId || ''}`;
    if (!movies[title]) movies[title] = { title, link: pres.link, times: [] };
    if (!movies[title].times.find(t => t.timestamp === ts)) {
      movies[title].times.push({ display, timestamp: ts, ticketUrl, oc });
    }
  }

  return Object.values(movies).filter(m => m.times.length > 0);
}

// Normalize a film title for dedup keying — strips accents and smart quotes so
// "Sirāt" == "Sirat" and "Wuthering Heights" == "Wuthering Heights".
function normalizeTitle(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u0060]/g, "'") // smart single quotes → '
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\u00AB\u00BB]/g, '"') // smart double quotes → "
    .replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^['""\u201C\u201D]+|['""\u201C\u201D]+$/g, ''); // strip surrounding quote chars
}

// ── BAM Rose Cinemas ─────────────────────────────────────────────────────────
// Two-step: 1) scrape /film for "Now Playing" film page links,
//           2) hit /api/BAMApi/GetPerformancesByProduction?ProductionPageId=XXXXX per film.
// Perf strings look like: "<a href='...'><span class='perfData'>Tue, Mar 17 at 4PM</span></a>"
async function fetchBAM(theater) {
  const { data: listHtml } = await axios.get('https://www.bam.org/film', {
    headers: { 'User-Agent': UA }, timeout: 12000,
  });
  const $list = cheerio.load(listHtml);

  // Collect detail-page paths only from cards that say "Now Playing"
  const filmPaths = new Set();
  $list('li').each((_, li) => {
    if (!$list(li).text().includes('Now Playing')) return;
    $list(li).find('a[href*="/film/"]').each((_, el) => {
      const href = ($list(el).attr('href') || '').split('?')[0].split('#')[0].replace(/\/$/, '');
      if (/\/film\/\d{4}\//.test(href)) filmPaths.add(href);
    });
  });

  if (!filmPaths.size) {
    console.error('[bam] no Now Playing film pages found');
    return [];
  }

  // "Mar 16" — matches the month+day portion of "Tue, Mar 16 at 4PM"
  const todayMonthDay = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  }).format(new Date());

  const movies = {};

  await Promise.allSettled([...filmPaths].map(async path => {
    const filmUrl = `https://www.bam.org${path}`;
    const { data: filmHtml } = await axios.get(filmUrl, {
      headers: { 'User-Agent': UA }, timeout: 12000,
    });

    // ProductionPageId lives in a JS AJAX call embedded in the page source
    const idMatch = filmHtml.match(/ProductionPageId[=&](\d+)/);
    if (!idMatch) return;

    const { data: perfs } = await axios.get(
      `https://www.bam.org/api/BAMApi/GetPerformancesByProduction?ProductionPageId=${idMatch[1]}`,
      { headers: { 'User-Agent': UA }, timeout: 12000 }
    );

    const $film = cheerio.load(filmHtml);
    const { clean: title } = stripOC($film('h1').first().text().trim() || path.split('/').pop().replace(/-/g, ' '));

    for (const perfHtml of (Array.isArray(perfs) ? perfs : [])) {
      const $p = cheerio.load(perfHtml);
      const perfText = $p('.perfData').text().trim(); // "Tue, Mar 17 at 4PM"
      if (!perfText.includes(todayMonthDay)) continue;
      const { oc } = stripOC(perfText);

      // Parse "at 4PM" or "at 7:30PM"
      const timeMatch = perfText.match(/at (\d{1,2})(?::(\d{2}))?([AP]M)/i);
      if (!timeMatch) continue;
      const h12 = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2] || '0');
      const ampm = timeMatch[3].toLowerCase();
      const display = `${h12}:${String(min).padStart(2, '0')}${ampm}`;
      const ts = parseShowtime(display);
      if (!ts) continue;

      const ticketUrl = $p('a').attr('href') || theater.link;
      // Use normalized key so "Sirāt"/"Sirat" and smart-quote variants merge into one entry
      const key = normalizeTitle(title);
      if (!movies[key]) movies[key] = { title, link: filmUrl, times: [] };
      if (!movies[key].times.find(t => t.timestamp === ts)) {
        movies[key].times.push({ display, timestamp: ts, ticketUrl, oc });
      }
    }
  }));

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Film at Lincoln Center ───────────────────────────────────────────────────
// Homepage is organized by date with <h6> headers (e.g. "TODAY", "MON", "TOMORROW", "WED")
// followed by film cards with class "details". Times in .Showtimes span, format "7:30 PM".
async function fetchFilmLinc(theater) {
  const { data: html } = await axios.get('https://www.filmlinc.org/', {
    headers: { 'User-Agent': UA },
    timeout: 15000,
  });
  const $ = cheerio.load(html);
  const movies = {};

  // Today's h6 could be "TODAY" or the abbreviated weekday (MON, TUE, etc.)
  const todayAbbr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
  }).format(new Date()).toUpperCase(); // "MON", "TUE", etc.

  const $todayH6 = $('h6').filter((_, el) => {
    const text = $(el).text().trim().toUpperCase();
    return text === 'TODAY' || text === todayAbbr;
  }).first();

  if (!$todayH6.length) {
    const found = $('h6').map((_, el) => $(el).text().trim()).get();
    console.error('[filmlinc] today header not found, looked for: TODAY or', todayAbbr, '| found:', found.join(', '));
    return [];
  }

  const $todaySection = $todayH6.nextUntil('h6');

  $todaySection.each((_, card) => {
    const $card = $(card);
    // Film title link points to /films/[slug]/
    const $titleLink = $card.find('a[href*="/films/"]').first();
    const { clean: title } = stripOC($titleLink.text().trim());
    if (!title) return;
    const filmHref = $titleLink.attr('href') || '';
    const filmUrl = filmHref.startsWith('http') ? filmHref : `https://www.filmlinc.org${filmHref}`;

    // Times are plain text (no .Showtimes class) and may appear twice (mobile+desktop).
    // Regex over card text, deduplicate by timestamp.
    const cardText = $card.text();
    const { oc } = stripOC(cardText);
    const seenTs = new Set();
    for (const m of [...cardText.matchAll(/\b(\d{1,2}:\d{2}\s*[AP]M)\b/gi)]) {
      const display = m[1].toLowerCase().replace(/\s+/g, '');
      const ts = parseShowtime(display);
      if (!ts || seenTs.has(ts)) continue;
      seenTs.add(ts);
      if (!movies[title]) movies[title] = { title, link: filmUrl, times: [] };
      movies[title].times.push({ display, timestamp: ts, oc });
    }
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Anthology Film Archives ──────────────────────────────────────────────────
// List view has h3 date headers ("Monday, March 16") followed by <li> entries:
//   <li>7:00 PM <a href="/film_screenings/...#showing-XXXXX">FILM TITLE</a></li>
async function fetchAnthology(theater) {
  const now = new Date();
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'numeric', year: 'numeric',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const nyMonth = nyParts.month.padStart(2, '0');
  const nyYear = nyParts.year;

  const { data: html } = await axios.get(
    `https://anthologyfilmarchives.org/film_screenings/calendar?view=list&month=${nyMonth}&year=${nyYear}`,
    { headers: { 'User-Agent': UA }, timeout: 12000 }
  );
  const $ = cheerio.load(html);
  const movies = {};

  // Build today's header string: "Monday, March 16"
  const todayHeader = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
  }).format(now);

  const $todayH3 = $('h3').filter((_, el) =>
    $(el).text().trim() === todayHeader
  ).first();

  if (!$todayH3.length) {
    const found = $('h3').map((_, el) => $(el).text().trim()).get().slice(0, 5);
    console.error('[anthology] today header not found, looked for:', todayHeader, '| sample:', found.join(' | '));
    return [];
  }

  const $todaySection = $todayH3.nextUntil('h3');

  $todaySection.find('a').each((_, linkEl) => {
    const href = $(linkEl).attr('href') || '';
    if (!href.includes('showing-') && !href.includes('film_screenings')) return;
    const { clean: title } = stripOC($(linkEl).text().trim());
    if (!title || title.length < 2) return;

    // Time is a plain text node in the same <li> before the link
    const liText = $(linkEl).closest('li').text().trim();
    const { oc } = stripOC(liText);
    const match = liText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
    if (!match) return;
    const display = match[1].toLowerCase().replace(/\s+/g, '');
    const ts = parseShowtime(display);
    if (!ts) return;

    const filmUrl = href.startsWith('http') ? href : `https://anthologyfilmarchives.org${href}`;
    if (!movies[title]) movies[title] = { title, link: filmUrl, times: [] };
    if (!movies[title].times.find(t => t.timestamp === ts)) {
      movies[title].times.push({ display, timestamp: ts, oc });
    }
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Screen Slate ─────────────────────────────────────────────────────────────
// Two-step undocumented API:
//   1) /api/screenings/date?_format=json&date=YYYYMMDD&field_city_target_id=10969
//      → [{ nid, field_time, field_note, field_timestamp }]
//   2) /api/screenings/id/{nid+nid+...}?_format=json
//      → [{ nid, title ("Film at Venue"), venue_title, field_url, ... }]
// Used as a supplementary source for venues not already in THEATERS.

const SS_VENUE_INFO = {
  'MoMA':                        { lat: 40.7614, lng: -73.9776, address: '11 W 53rd St, New York, NY 10019',          preshow: 5  },
  'Museum of Modern Art':        { lat: 40.7614, lng: -73.9776, address: '11 W 53rd St, New York, NY 10019',          preshow: 5  },
  'Quad Cinema':                 { lat: 40.7333, lng: -74.0002, address: '34 W 13th St, New York, NY 10011',          preshow: 10 },
  'Spectacle':                   { lat: 40.7139, lng: -73.9597, address: '124 S 3rd St, Brooklyn, NY 11249',          preshow: 5  },
  'Spectacle Theater':           { lat: 40.7139, lng: -73.9597, address: '124 S 3rd St, Brooklyn, NY 11249',          preshow: 5  },
  'Firehouse: DCTV\'s Cinema for Documentary Film': { lat: 40.7142, lng: -74.0064, address: '87 Lafayette St, New York, NY 10013', preshow: 5 },
  'Firehouse':                   { lat: 40.7142, lng: -74.0064, address: '87 Lafayette St, New York, NY 10013',        preshow: 5  },
  'Museum of the Moving Image':  { lat: 40.7565, lng: -73.9272, address: '36-01 35 Ave, Astoria, NY 11106',           preshow: 5  },
  'UnionDocs':                   { lat: 40.7262, lng: -73.9517, address: '322 Union Ave, Brooklyn, NY 11211',         preshow: 5  },
  'Syndicated':                  { lat: 40.7041, lng: -73.9372, address: '40 Bogart St, Brooklyn, NY 11206',          preshow: 10 },
  'Metrograph':                  { lat: 40.7150, lng: -73.9900, address: '7 Ludlow St, New York, NY 10002',           preshow: 5  },
  'Film Forum':                  { lat: 40.7282, lng: -74.0043, address: '209 W Houston St, New York, NY 10014',      preshow: 5  },
  'IFC Center':                  { lat: 40.7330, lng: -74.0026, address: '323 Sixth Ave, New York, NY 10014',         preshow: 10 },
  'Film at Lincoln Center':      { lat: 40.7731, lng: -73.9836, address: '165 W 65th St, New York, NY 10023',         preshow: 5  },
  'BAM':                         { lat: 40.6862, lng: -73.9778, address: '30 Lafayette Ave, Brooklyn, NY 11217',      preshow: 10 },
  'Anthology Film Archives':     { lat: 40.7242, lng: -73.9892, address: '32 Second Ave, New York, NY 10003',         preshow: 5  },
  'Nitehawk Cinema':             { lat: 40.7143, lng: -73.9614, address: '136 Metropolitan Ave, Brooklyn, NY 11249',  preshow: 10 },
};

// Venues already covered by individual scrapers — skip from Screen Slate
// Checked via startsWith so "IFC Center " or "IFC Center NYC" variants also match.
const SS_SKIP_PREFIXES = [
  'ifc center', 'film forum', 'metrograph',
  'nitehawk cinema', 'nitehawk williamsburg', 'nitehawk prospect',
  'alamo drafthouse',
  'bam', 'brooklyn academy of music',
  'film at lincoln center',
  'anthology film archives', 'anthology film archive',
  'angelika film center', 'angelika',
];
// venue_title from Screen Slate API is raw HTML, e.g. '<a href="/venues/ifc-center">IFC Center</a>'
// Strip all tags to get the plain venue name before any comparisons.
function ssVenueText(raw) {
  return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function isSSSkipVenue(venueTitle) {
  const v = ssVenueText(venueTitle).toLowerCase();
  return SS_SKIP_PREFIXES.some(p => v.startsWith(p));
}

async function fetchScreenSlate(userLat, userLng) {
  const todayNYC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const dateCompact = todayNYC.replace(/-/g, ''); // "20260317"

  // Step 1: all NYC screening stubs for today
  const { data: stubs } = await axios.get(
    `https://www.screenslate.com/api/screenings/date?_format=json&date=${dateCompact}&field_city_target_id=10969`,
    { headers: { 'User-Agent': UA }, timeout: 12000 }
  );
  if (!stubs?.length) return [];

  // Step 2: full details for all screenings
  const nids = stubs.map(s => s.nid).join('+');
  const { data: details } = await axios.get(
    `https://www.screenslate.com/api/screenings/id/${nids}?_format=json`,
    { headers: { 'User-Agent': UA }, timeout: 15000 }
  );
  if (!details?.length) return [];

  // Build nid → stub map for time lookups
  const stubMap = {};
  for (const s of stubs) stubMap[s.nid] = s;

  // Group by venue — no skip filtering here; handler decides what to do with each venue
  const venueMap = {};
  for (const d of details) {

    const stub = stubMap[d.nid];
    if (!stub?.field_timestamp) continue;

    // field_timestamp is "2026-03-17T10:35:00" — NYC local time
    // Confirm it's today and extract h/m for parseShowtime
    const isoMatch = stub.field_timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    if (!isoMatch || isoMatch[1] !== todayNYC) continue;
    const h = parseInt(isoMatch[2]), m = parseInt(isoMatch[3]);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const display = `${h12}:${String(m).padStart(2, '0')}${ampm}`;
    const ts = parseShowtime(display);
    if (!ts) continue;

    // Strip venue suffix: Screen Slate formats titles as "Film at Venue" or "Film @ Venue".
    // Use lastIndexOf so we take the last separator and handle titles that contain "at".
    const rawTitle = (d.title || '').trim();
    const atIdx  = rawTitle.lastIndexOf(' at ');
    const symIdx = rawTitle.lastIndexOf(' @ ');
    const sepIdx = Math.max(atIdx, symIdx);
    const withoutVenue = sepIdx > 0 ? rawTitle.slice(0, sepIdx).trim() : rawTitle;
    const { clean: filmTitle, oc: titleOC } = stripOC(withoutVenue);
    if (!filmTitle) continue;

    // field_note in stub may carry accessibility info like "Open Caption"
    const noteOC = stripOC(stub.field_note || '').oc;
    const oc = titleOC || noteOC;

    const filmLink = d.field_url || 'https://www.screenslate.com';
    const venueName = ssVenueText(d.venue_title);
    if (!venueMap[venueName]) venueMap[venueName] = { films: {} };
    const films = venueMap[venueName].films;
    if (!films[filmTitle]) films[filmTitle] = { title: filmTitle, link: filmLink, times: [] };
    if (!films[filmTitle].times.find(t => t.timestamp === ts)) {
      films[filmTitle].times.push({ display, timestamp: ts, oc });
    }
  }

  // Convert to theater-format objects
  return Object.entries(venueMap).map(([venueName, { films }]) => {
    const movies = Object.values(films).filter(m => m.times.length > 0);
    if (!movies.length) return null;
    const info = SS_VENUE_INFO[venueName] ?? null;
    const vLat = info?.lat ?? null;
    const vLng = info?.lng ?? null;
    return {
      name: venueName,
      address: info?.address ?? `${venueName}, New York, NY`,
      distance_miles: (vLat && vLng) ? distanceMiles(userLat, userLng, vLat, vLng) : 99,
      link: 'https://www.screenslate.com',
      chain: null,
      preshow_minutes: info?.preshow ?? 5,
      source: 'screenslate',
      movies,
    };
  }).filter(Boolean);
}

// ── Theater registry ─────────────────────────────────────────────────────────
const THEATERS = [
  {
    id: 'nitehawk-pp',
    name: 'Nitehawk Cinema Prospect Park',
    address: '188 Prospect Park SW, Brooklyn, NY 11218',
    lat: 40.6595, lng: -73.9777,
    preshow_minutes: 10, chain: null,
    link: 'https://nitehawkcinema.com/prospectpark/',
    api_base: 'https://nitehawkcinema.com/prospectpark',
    fetch: fetchNitehawk,
  },
  {
    id: 'nitehawk-wburg',
    name: 'Nitehawk Cinema Williamsburg',
    address: '136 Metropolitan Ave, Brooklyn, NY 11249',
    lat: 40.7143, lng: -73.9614,
    preshow_minutes: 10, chain: null,
    link: 'https://nitehawkcinema.com/williamsburg/',
    api_base: 'https://nitehawkcinema.com/williamsburg',
    fetch: fetchNitehawk,
  },
  {
    id: 'alamo-brooklyn',
    name: 'Alamo Drafthouse Brooklyn',
    address: '445 Albee Square W, Brooklyn, NY 11201',
    lat: 40.6920, lng: -73.9871,
    preshow_minutes: 15, chain: null,
    link: 'https://drafthouse.com/brooklyn',
    cinema_id: '2101',
    fetch: fetchAlamo,
  },
  {
    id: 'bam',
    name: 'BAM Rose Cinemas',
    address: '30 Lafayette Ave, Brooklyn, NY 11217',
    lat: 40.6862, lng: -73.9778,
    preshow_minutes: 10, chain: null,
    link: 'https://www.bam.org/film',
    fetch: fetchBAM,
  },
  {
    id: 'film-forum',
    name: 'Film Forum',
    address: '209 W Houston St, New York, NY 10014',
    lat: 40.7282, lng: -74.0043,
    preshow_minutes: 5, chain: null,
    link: 'https://filmforum.org',
    fetch: fetchFilmForum,
  },
  {
    id: 'ifc',
    name: 'IFC Center',
    address: '323 Sixth Ave, New York, NY 10014',
    lat: 40.7330, lng: -74.0026,
    preshow_minutes: 10, chain: null,
    link: 'https://www.ifccenter.com',
    fetch: fetchIFC,
  },
  {
    id: 'metrograph',
    name: 'Metrograph',
    address: '7 Ludlow St, New York, NY 10002',
    lat: 40.7150, lng: -73.9900,
    preshow_minutes: 5, chain: null,
    link: 'https://metrograph.com',
    fetch: fetchMetrograph,
  },
  {
    id: 'filmlinc',
    name: 'Film at Lincoln Center',
    address: '165 W 65th St, New York, NY 10023',
    lat: 40.7731, lng: -73.9836,
    preshow_minutes: 5, chain: null,
    link: 'https://www.filmlinc.org',
    fetch: fetchFilmLinc,
  },
  {
    id: 'anthology',
    name: 'Anthology Film Archives',
    address: '32 Second Ave, New York, NY 10003',
    lat: 40.7242, lng: -73.9892,
    preshow_minutes: 5, chain: null,
    link: 'https://anthologyfilmarchives.org',
    fetch: fetchAnthology,
  },
];

// ── Server-side showtime cache ────────────────────────────────────────────────
// Keyed by rounded lat/lng bucket so nearby users share a warm cache.
// Fresh window: serve immediately. Grace window: serve stale + revalidate in bg.
const showtimeCache = new Map();
const CACHE_TTL_MS   = 5 * 60 * 1000;  // 5 min — serve as fresh
const CACHE_GRACE_MS = 8 * 60 * 1000;  // 8 min — serve stale + kick off background scrape
const revalidating   = new Set();       // prevents duplicate bg scrapes per instance

function locationBucket(lat, lng) {
  return `${(+lat).toFixed(2)},${(+lng).toFixed(2)}`;
}

// Recompute distance_miles and re-sort for the exact requesting coordinates
// (bucket rounding means two users 1km apart may share a cache entry but need correct sort order)
function rehydrate(payload, userLat, userLng) {
  const theaters = payload.theaters.map(t => {
    if (t.lat == null || t.lng == null) return t;
    return { ...t, distance_miles: distanceMiles(userLat, userLng, t.lat, t.lng) };
  }).sort((a, b) => a.distance_miles - b.distance_miles);
  return { ...payload, theaters };
}

// ── Core scraper logic (extracted for cache reuse) ────────────────────────────
async function runScrapers(userLat, userLng) {
  const sorted = THEATERS
    .map(t => ({ ...t, distance_miles: distanceMiles(userLat, userLng, t.lat, t.lng) }))
    .sort((a, b) => a.distance_miles - b.distance_miles);

  const results = await Promise.allSettled(sorted.map(async theater => {
    const movies = await theater.fetch(theater);
    if (!movies || movies.length === 0) return null;
    return {
      name: theater.name,
      address: theater.address,
      lat: theater.lat,
      lng: theater.lng,
      distance_miles: theater.distance_miles,
      link: theater.link,
      chain: theater.chain,
      preshow_minutes: theater.preshow_minutes,
      movies,
    };
  }));

  const errors = [];
  const theaters = results
    .map((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[${sorted[i].id}] failed:`, r.reason?.message);
        errors.push(sorted[i].name);
        return null;
      }
      return r.value;
    })
    .filter(Boolean);

  // Screen Slate integration — two roles:
  //   1. TAG individual films at already-scraped venues with source:'screenslate' (curatorial badge)
  //   2. ADD entirely new venues that have no dedicated scraper
  try {
    const allSSTheaters = await fetchScreenSlate(userLat, userLng);

    // Build lookup: normalized venue name → Set of normalized film titles from SS
    const ssVenueFilms = new Map();
    for (const t of allSSTheaters) {
      const key = (t.name || '').toLowerCase().trim();
      if (!key) continue;
      if (!ssVenueFilms.has(key)) ssVenueFilms.set(key, new Set());
      for (const m of t.movies) ssVenueFilms.get(key).add(m.title.toLowerCase().trim());
    }

    // Role 1: tag scraped films that SS also covers
    const scrapedNamesList = theaters.map(t => t.name.toLowerCase().trim());
    for (const theater of theaters) {
      const tName = theater.name.toLowerCase().trim();
      const ssKey = [...ssVenueFilms.keys()].find(k => k.startsWith(tName) || tName.startsWith(k));
      if (!ssKey) continue;
      const ssTitles = ssVenueFilms.get(ssKey);
      for (const m of theater.movies) {
        if (ssTitles.has(m.title.toLowerCase().trim())) m.source = 'screenslate';
      }
    }

    // Role 2: add SS venues with no matching scraper
    const existingNames = new Set(scrapedNamesList);
    for (const t of allSSTheaters) {
      const ssName = (t.name || '').toLowerCase().trim();
      if (!ssName) continue;
      if (isSSSkipVenue(t.name)) continue;
      if (scrapedNamesList.some(n => ssName.startsWith(n) || n.startsWith(ssName))) continue;
      if (existingNames.has(ssName)) continue;
      theaters.push(t);
    }
  } catch (err) {
    console.error('[screenslate] failed:', err.message);
    errors.push('Screen Slate');
  }

  // Final dedup: within each theater merge any movies sharing a normalized title
  for (const t of theaters) {
    const merged = {};
    for (const m of t.movies) {
      const key = normalizeTitle(m.title);
      if (!merged[key]) {
        merged[key] = { ...m, times: [...m.times] };
      } else {
        for (const slot of m.times) {
          if (!merged[key].times.find(x => x.timestamp === slot.timestamp)) {
            merged[key].times.push(slot);
          }
        }
        if (m.source === 'screenslate') merged[key].source = 'screenslate';
      }
    }
    t.movies = Object.values(merged);
  }

  return { theaters, errors };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);
  const bucket  = locationBucket(userLat, userLng);
  const now     = Date.now();
  const cached  = showtimeCache.get(bucket);
  const age     = cached ? now - cached.ts : Infinity;

  // Fully fresh — serve immediately
  if (cached && age < CACHE_TTL_MS) {
    return res.json({ ...rehydrate(cached.payload, userLat, userLng), cached: true, cachedAt: cached.ts });
  }

  // Stale but within grace — respond immediately with old data, revalidate in background
  if (cached && age < CACHE_GRACE_MS && !revalidating.has(bucket)) {
    revalidating.add(bucket);
    runScrapers(userLat, userLng)
      .then(payload => showtimeCache.set(bucket, { ts: Date.now(), payload }))
      .catch(err => console.error('[cache] background revalidation failed:', err.message))
      .finally(() => revalidating.delete(bucket));
    return res.json({ ...rehydrate(cached.payload, userLat, userLng), cached: true, cachedAt: cached.ts });
  }

  // Cache miss or expired — scrape synchronously
  const payload = await runScrapers(userLat, userLng);
  showtimeCache.set(bucket, { ts: now, payload });
  res.json({ ...payload, cached: false, cachedAt: now });
};
