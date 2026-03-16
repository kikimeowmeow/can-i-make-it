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
  const clean = timeStr.trim().replace(/\s+/g, '');
  const match = clean.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const ap = match[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const now = new Date();
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  if (t.getTime() < now.getTime() - 2 * 60 * 60 * 1000) t.setDate(t.getDate() + 1);
  return t.getTime();
}

// Fandango returns times in various formats — normalize them
function normalizeFandangoTime(raw) {
  if (!raw) return null;
  // ISO format: "2025-03-16T19:30:00"
  if (raw.includes('T')) {
    const d = new Date(raw);
    if (isNaN(d)) return null;
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'pm' : 'am';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')}${ap}`;
  }
  // Already "7:30pm" style
  return raw.toLowerCase().replace(' ', '');
}

// ─── Fandango theater page scraper ──────────────────────────────────────────
// Fetches a specific theater's page and parses embedded Next.js data
async function fetchFandango(theater) {
  if (!theater.fandango_id) return null;
  const url = `https://www.fandango.com/${theater.fandango_id}/theater-page`;
  let html;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      timeout: 15000,
    });
    html = res.data;
  } catch (e) {
    console.error(`[fandango] fetch failed for ${theater.name}:`, e.message);
    return null;
  }

  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').html();
  if (!raw) {
    console.error(`[fandango] no __NEXT_DATA__ for ${theater.name}`);
    return null;
  }

  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  const pp = data?.props?.pageProps;
  // Fandango nests showtimes in different places depending on page version
  const showings =
    pp?.movieShowtimesByDate?.[0]?.movies ||
    pp?.theater?.movieShowtimes ||
    pp?.movieShowtimes ||
    pp?.showtimes ||
    [];

  if (!showings.length) {
    console.error(`[fandango] no showings found in data for ${theater.name}`);
    return null;
  }

  return showings.map(m => ({
    title: m.movieName || m.movie?.name || m.name || 'Unknown',
    link: m.movieUrl ? `https://www.fandango.com${m.movieUrl}` : theater.link,
    times: (m.showtimes || m.performanceTimes || m.times || [])
      .map(t => {
        const raw = t.performanceDateTime || t.showtime || t.time || t;
        const display = normalizeFandangoTime(typeof raw === 'string' ? raw : String(raw));
        return { display, timestamp: parseShowtime(display) };
      })
      .filter(t => t.timestamp !== null),
  })).filter(m => m.times.length > 0);
}

// ─── Alamo Drafthouse API ────────────────────────────────────────────────────
async function fetchAlamo(theater) {
  const today = new Date().toISOString().slice(0, 10);
  const url = `https://drafthouse.com/s/mother/v1/calendar/market/${theater.alamo_market}/cinema/${theater.alamo_cinema}/date/${today}`;
  let data;
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 10000 });
    data = res.data;
  } catch (e) {
    console.error(`[alamo] fetch failed:`, e.message);
    return null;
  }

  // Alamo's API has shifted structure over versions — try common paths
  const presentations =
    data?.data?.presentations ||
    data?.Calendar?.Presentations ||
    data?.data?.Calendar?.Presentations ||
    [];

  const movies = {};
  for (const p of presentations) {
    const title = p.Film?.FilmName || p.FilmName || p.name;
    const timeStr = p.PerformanceTime || p.ShowtimePretty || p.time;
    if (!title || !timeStr) continue;
    const ts = parseShowtime(timeStr);
    if (!ts) continue;
    if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
    movies[title].times.push({ display: timeStr.toLowerCase().replace(' ', ''), timestamp: ts });
  }
  return Object.values(movies).filter(m => m.times.length > 0);
}

// ─── Metrograph (own website, not on Fandango) ───────────────────────────────
async function fetchMetrograph(theater) {
  let html;
  try {
    const res = await axios.get('https://metrograph.com/calendar/', {
      headers: { 'User-Agent': UA },
      timeout: 12000,
    });
    html = res.data;
  } catch (e) {
    console.error(`[metrograph] fetch failed:`, e.message);
    return null;
  }

  const $ = cheerio.load(html);

  // Try __NEXT_DATA__ first (Metrograph is Next.js)
  const raw = $('script#__NEXT_DATA__').html();
  if (raw) {
    try {
      const data = JSON.parse(raw);
      const films = data?.props?.pageProps?.films || data?.props?.pageProps?.events || [];
      if (films.length) {
        const movies = {};
        for (const f of films) {
          const title = f.title || f.name;
          const times = f.showtimes || f.performances || f.screenings || [];
          if (!title || !times.length) continue;
          for (const t of times) {
            const raw = t.datetime || t.time || t.starts_at;
            const display = normalizeFandangoTime(typeof raw === 'string' ? raw : '');
            const ts = parseShowtime(display);
            if (!ts) continue;
            if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
            movies[title].times.push({ display, timestamp: ts });
          }
        }
        const results = Object.values(movies).filter(m => m.times.length > 0);
        if (results.length) return results;
      }
    } catch {}
  }

  // Fallback: parse HTML directly
  const movies = {};
  $('article, .film, .event, .screening').each((_, el) => {
    const title = $(el).find('h1, h2, h3, .title').first().text().trim();
    if (!title) return;
    $(el).find('time, .showtime, .time').each((_, timeEl) => {
      const timeStr = $(timeEl).attr('datetime') || $(timeEl).text().trim();
      const display = normalizeFandangoTime(timeStr);
      const ts = parseShowtime(display || timeStr);
      if (!ts) return;
      if (!movies[title]) movies[title] = { title, link: theater.link, times: [] };
      movies[title].times.push({ display: display || timeStr, timestamp: ts });
    });
  });
  return Object.values(movies).filter(m => m.times.length > 0);
}

// ─── Theater registry ────────────────────────────────────────────────────────
const THEATERS = [
  {
    id: 'bam',
    name: 'BAM Rose Cinemas',
    address: '30 Lafayette Ave, Brooklyn, NY 11217',
    lat: 40.6862, lng: -73.9773,
    chain: null, preshow_minutes: 10,
    link: 'https://www.bam.org/films',
    fandango_id: 'bam-rose-cinemas-aabwn',
  },
  {
    id: 'alamo',
    name: 'Alamo Drafthouse Brooklyn',
    address: '445 Albee Square W, Brooklyn, NY 11201',
    lat: 40.6922, lng: -73.9862,
    chain: 'Alamo Drafthouse', preshow_minutes: 15,
    link: 'https://drafthouse.com/new-york',
    alamo_market: '0008',
    alamo_cinema: '0523',
    fetch: fetchAlamo,
  },
  {
    id: 'amc-atlantic',
    name: 'AMC Atlantic Terminal 16',
    address: '139 Flatbush Ave, Brooklyn, NY 11217',
    lat: 40.6843, lng: -73.9773,
    chain: 'AMC', preshow_minutes: 25,
    link: 'https://www.amctheatres.com/movie-theatres/new-york/amc-atlantic-terminal-16',
    fandango_id: 'amc-atlantic-terminal-16-aaefr',
  },
  {
    id: 'nitehawk',
    name: 'Nitehawk Cinema Prospect Park',
    address: '188 Prospect Park SW, Brooklyn, NY 11218',
    lat: 40.6595, lng: -73.9777,
    chain: null, preshow_minutes: 10,
    link: 'https://nitehawkcinema.com',
    fandango_id: 'nitehawk-cinema-prospect-park-aankf',
  },
  {
    id: 'ifc',
    name: 'IFC Center',
    address: '323 Sixth Ave, New York, NY 10014',
    lat: 40.7330, lng: -74.0026,
    chain: null, preshow_minutes: 10,
    link: 'https://www.ifccenter.com',
    fandango_id: 'ifc-center-aaevw',
  },
  {
    id: 'film-forum',
    name: 'Film Forum',
    address: '209 W Houston St, New York, NY 10014',
    lat: 40.7282, lng: -74.0043,
    chain: null, preshow_minutes: 5,
    link: 'https://filmforum.org',
    fandango_id: 'film-forum-aafsh',
  },
  {
    id: 'metrograph',
    name: 'Metrograph',
    address: '7 Ludlow St, New York, NY 10002',
    lat: 40.7150, lng: -73.9900,
    chain: null, preshow_minutes: 5,
    link: 'https://metrograph.com',
    fetch: fetchMetrograph,
  },
  {
    id: 'amc-empire',
    name: 'AMC Empire 25',
    address: '234 W 42nd St, New York, NY 10036',
    lat: 40.7566, lng: -73.9889,
    chain: 'AMC', preshow_minutes: 25,
    link: 'https://www.amctheatres.com/movie-theatres/new-york/amc-empire-25',
    fandango_id: 'amc-empire-25-aaefc',
  },
  {
    id: 'regal-union',
    name: 'Regal Union Square',
    address: '850 Broadway, New York, NY 10003',
    lat: 40.7357, lng: -73.9904,
    chain: 'Regal', preshow_minutes: 20,
    link: 'https://www.regmovies.com/theaters/regal-union-square/1187',
    fandango_id: 'regal-union-square-with-rpx-aahze',
  },
  {
    id: 'angelika',
    name: 'Angelika Film Center',
    address: '18 W Houston St, New York, NY 10012',
    lat: 40.7254, lng: -73.9989,
    chain: null, preshow_minutes: 10,
    link: 'https://www.angelikafilmcenter.com/nyc',
    fandango_id: 'angelika-film-center-aaevv',
  },
];

module.exports = async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  // All theaters, sorted by distance from user
  const nearby = THEATERS
    .map(t => ({ ...t, distance_miles: distanceMiles(userLat, userLng, t.lat, t.lng) }))
    .sort((a, b) => a.distance_miles - b.distance_miles);

  // Fetch all theaters in parallel
  const results = await Promise.all(nearby.map(async theater => {
    try {
      let movies;
      if (theater.fetch) {
        movies = await theater.fetch(theater);
      } else if (theater.fandango_id) {
        movies = await fetchFandango(theater);
      }
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
    } catch (e) {
      console.error(`[showtimes] ${theater.name} failed:`, e.message);
      return null;
    }
  }));

  const theaters = results.filter(Boolean);
  if (theaters.length === 0) {
    return res.json({ theaters: [], note: 'No showtimes available. Check server logs for details.' });
  }
  res.json({ theaters });
};
