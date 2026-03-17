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

function parseShowtime(timeStr) {
  if (!timeStr) return null;
  const clean = timeStr.trim().toLowerCase().replace(/\s+/g, '');
  const match = clean.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (match[3] === 'pm' && h !== 12) h += 12;
  if (match[3] === 'am' && h === 12) h = 0;
  const t = new Date();
  t.setHours(h, m, 0, 0);
  if (t.getTime() < Date.now() - 2 * 3600000) t.setDate(t.getDate() + 1);
  return t.getTime();
}

// ── Nitehawk (Prospect Park + Williamsburg — same site structure) ─────────────
async function fetchNitehawk(theater) {
  const { data: html } = await axios.get(theater.scrape_url, {
    headers: { 'User-Agent': UA },
    timeout: 12000,
  });
  const $ = cheerio.load(html);
  const movies = {};

  // Each film is an <li> with an <h3> child for the title.
  // Showtimes are nested <li> elements within that same <li>.
  $('li').each((_, el) => {
    const $el = $(el);
    const title = $el.children('h3').first().text().trim();
    if (!title) return;
    $el.find('li').each((_, timeEl) => {
      const text = $(timeEl).text().trim();
      const match = text.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
      if (!match) return;
      const display = match[1].toLowerCase().replace(/\s+/g, '');
      const ts = parseShowtime(display);
      if (!ts) return;
      if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
      movies[title].times.push({ display, timestamp: ts });
    });
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Film Forum (JSON-LD ScreeningEvent data) ─────────────────────────────────
async function fetchFilmForum(theater) {
  const { data: html } = await axios.get('https://filmforum.org/', {
    headers: { 'User-Agent': UA },
    timeout: 12000,
  });
  const $ = cheerio.load(html);
  const today = new Date();
  const movies = {};

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        if (item['@type'] !== 'ScreeningEvent') continue;
        const title = item.name || item.workPresented?.name;
        if (!title) continue;
        const d = new Date(item.startDate);
        if (isNaN(d)) continue;
        // Only today's screenings
        if (d.getDate() !== today.getDate() ||
            d.getMonth() !== today.getMonth() ||
            d.getFullYear() !== today.getFullYear()) continue;
        let h = d.getHours();
        const m = d.getMinutes();
        const ap = h >= 12 ? 'pm' : 'am';
        if (h > 12) h -= 12;
        if (h === 0) h = 12;
        const display = `${h}:${String(m).padStart(2, '0')}${ap}`;
        const ts = parseShowtime(display);
        if (!ts) continue;
        if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
        movies[title].times.push({ display, timestamp: ts });
      }
    } catch {}
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── IFC Center (WordPress site, ticket links contain times) ──────────────────
async function fetchIFC(theater) {
  const { data: html } = await axios.get('https://www.ifccenter.com/', {
    headers: { 'User-Agent': UA },
    timeout: 12000,
  });
  const $ = cheerio.load(html);
  const movies = {};

  // IFC: ticket links href="https://tickets.ifccenter.com/..."
  // text of each link is the showtime. The nearest h3/h4 is the film title.
  $('a[href*="tickets.ifccenter.com"]').each((_, linkEl) => {
    const timeText = $(linkEl).text().trim();
    const match = timeText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
    if (!match) return;

    // Walk up DOM to find the enclosing film block, then grab its heading
    const $block = $(linkEl).closest('.wp-block-group, article, section, .film-block');
    let title = $block.find('h3, h4').first().text().trim();

    // Fallback: look for any preceding h3/h4 sibling in the parent
    if (!title) {
      title = $(linkEl).parentsUntil('body').find('h3, h4').first().text().trim();
    }
    if (!title) return;

    const display = match[1].toLowerCase().replace(/\s+/g, '');
    const ts = parseShowtime(display);
    if (!ts) return;
    if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
    movies[title].times.push({ display, timestamp: ts });
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Metrograph ───────────────────────────────────────────────────────────────
async function fetchMetrograph(theater) {
  const { data: html } = await axios.get('https://metrograph.com/calendar/', {
    headers: { 'User-Agent': UA },
    timeout: 12000,
  });
  const $ = cheerio.load(html);
  const movies = {};

  // Metrograph: h4 is the film title; nearby links to t.metrograph.com are ticketed showtimes.
  // Walk each ticket link, walk up to find its parent block, get the h4.
  $('a[href*="t.metrograph.com"]').each((_, linkEl) => {
    const timeText = $(linkEl).text().trim();
    const match = timeText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
    if (!match) return;

    const $parent = $(linkEl).closest('article, section, .film, .event, div[class]');
    let title = $parent.find('h4').first().text().trim();
    if (!title) {
      title = $(linkEl).closest('*').prevAll('h4').first().text().trim();
    }
    if (!title) return;

    const display = match[1].toLowerCase().replace(/\s+/g, '');
    const ts = parseShowtime(display);
    if (!ts) return;
    if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
    movies[title].times.push({ display, timestamp: ts });
  });

  return Object.values(movies).filter(m => m.times.length > 0);
}

// ── Anthology Film Archives ──────────────────────────────────────────────────
async function fetchAnthology(theater) {
  const today = new Date();
  const y = today.getFullYear();
  const mo = String(today.getMonth() + 1).padStart(2, '0');
  const { data: html } = await axios.get(
    `https://anthologyfilmarchives.org/film_screenings/calendar?month=${y}-${mo}`,
    { headers: { 'User-Agent': UA }, timeout: 12000 }
  );
  const $ = cheerio.load(html);
  const movies = {};
  const todayDay = today.getDate();

  // Calendar table: each td/cell represents one day.
  // Find today's cell by looking for a date number matching today.
  $('td').each((_, cell) => {
    const dayNum = parseInt($(cell).find('.day-number, strong, .date').first().text().trim());
    if (dayNum !== todayDay) return;

    // Film links use href containing "showing-"
    $(cell).find('a[href*="showing-"]').each((_, linkEl) => {
      const title = $(linkEl).text().trim();
      if (!title) return;
      // The time appears as a text node before or near the link
      const liText = $(linkEl).closest('li').text().trim();
      const match = liText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
      if (!match) return;
      const display = match[1].toLowerCase().replace(/\s+/g, '');
      const ts = parseShowtime(display);
      if (!ts) return;
      if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
      movies[title].times.push({ display, timestamp: ts });
    });
  });

  return Object.values(movies).filter(m => m.times.length > 0);
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
    scrape_url: 'https://nitehawkcinema.com/prospectpark/',
    fetch: fetchNitehawk,
  },
  {
    id: 'nitehawk-wburg',
    name: 'Nitehawk Cinema Williamsburg',
    address: '136 Metropolitan Ave, Brooklyn, NY 11249',
    lat: 40.7143, lng: -73.9614,
    preshow_minutes: 10, chain: null,
    link: 'https://nitehawkcinema.com/williamsburg/',
    scrape_url: 'https://nitehawkcinema.com/williamsburg/',
    fetch: fetchNitehawk,
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
    id: 'anthology',
    name: 'Anthology Film Archives',
    address: '32 Second Ave, New York, NY 10003',
    lat: 40.7242, lng: -73.9892,
    preshow_minutes: 5, chain: null,
    link: 'https://anthologyfilmarchives.org',
    fetch: fetchAnthology,
  },
];

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  const sorted = THEATERS
    .map(t => ({ ...t, distance_miles: distanceMiles(userLat, userLng, t.lat, t.lng) }))
    .sort((a, b) => a.distance_miles - b.distance_miles);

  const results = await Promise.allSettled(sorted.map(async theater => {
    const movies = await theater.fetch(theater);
    if (!movies || movies.length === 0) return null;
    return {
      name: theater.name,
      address: theater.address,
      distance_miles: theater.distance_miles,
      link: theater.link,
      chain: theater.chain,
      preshow_minutes: theater.preshow_minutes,
      movies,
    };
  }));

  const theaters = results
    .map((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[${sorted[i].id}] failed:`, r.reason?.message);
        return null;
      }
      return r.value;
    })
    .filter(Boolean);

  res.json({ theaters });
};
