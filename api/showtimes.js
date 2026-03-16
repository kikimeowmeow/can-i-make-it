const axios = require('axios');

const PRESHOW_BY_CHAIN = {
  AMC: 25,
  REGAL: 20,
  CINEMARK: 15,
  ALAMO: 15,
  ARCLIGHT: 15,
  LANDMARK: 10,
  ANGELIKA: 10,
  IFC: 10,
  NITEHAWK: 10,
};

function getChainKey(theaterName) {
  const upper = theaterName.toUpperCase();
  for (const chain of Object.keys(PRESHOW_BY_CHAIN)) {
    if (upper.includes(chain)) return chain;
  }
  return null;
}

function getPreshowMinutes(theaterName) {
  const chain = getChainKey(theaterName);
  return chain ? PRESHOW_BY_CHAIN[chain] : 10;
}

function getFriendlyChainName(theaterName) {
  const upper = theaterName.toUpperCase();
  if (upper.includes('AMC')) return 'AMC';
  if (upper.includes('REGAL')) return 'Regal';
  if (upper.includes('CINEMARK')) return 'Cinemark';
  if (upper.includes('ALAMO')) return 'Alamo Drafthouse';
  if (upper.includes('ARCLIGHT')) return 'ArcLight';
  if (upper.includes('LANDMARK')) return 'Landmark';
  if (upper.includes('ANGELIKA')) return 'Angelika';
  if (upper.includes('NITEHAWK')) return 'Nitehawk';
  if (upper.includes('IFC')) return 'IFC Center';
  return null;
}

function parseShowtime(timeStr) {
  if (!timeStr) return null;
  const clean = timeStr.trim().replace(/\s+/g, '');
  const match = clean.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3].toLowerCase();

  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  const now = new Date();
  const showtime = new Date(now);
  showtime.setHours(hours, minutes, 0, 0);

  if (showtime.getTime() < now.getTime() - 2 * 60 * 60 * 1000) {
    showtime.setDate(showtime.getDate() + 1);
  }

  return showtime.getTime();
}

// Reverse geocode lat/lng → "City, State, Country" for SerpApi location param
async function reverseGeocode(lat, lng) {
  if (!process.env.GOOGLE_MAPS_KEY) return null;
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: process.env.GOOGLE_MAPS_KEY },
      timeout: 6000,
    });
    const result = r.data.results?.[0];
    if (!result) return null;
    // Extract city, state, country from address components
    const comps = result.address_components;
    const get = (type) => comps.find((c) => c.types.includes(type))?.long_name;
    const city    = get('locality') || get('sublocality') || get('neighborhood');
    const state   = get('administrative_area_level_1');
    const country = get('country');
    return [city, state, country].filter(Boolean).join(', ');
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });

  if (!process.env.SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY not configured' });
  }

  try {
    // Reverse geocode to get a city name SerpApi can use
    const location = await reverseGeocode(lat, lng);

    const serpRes = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google',
        q: 'movies playing today near me',
        ll: `@${lat},${lng},14z`,
        ...(location && { location }),
        hl: 'en',
        gl: 'us',
        api_key: process.env.SERPAPI_KEY,
      },
      timeout: 15000,
    });

    const rawShowtimes = serpRes.data.showtimes || [];

    if (rawShowtimes.length === 0) {
      return res.json({ theaters: [], note: 'No showtimes returned by SerpApi for this location' });
    }

    const theaters = rawShowtimes.map((t) => ({
      name: t.name || 'Unknown Theater',
      address: t.vicinity || t.address || '',
      link: t.link || null,
      chain: getFriendlyChainName(t.name || ''),
      preshow_minutes: getPreshowMinutes(t.name || ''),
      movies: (t.showing || []).map((m) => ({
        title: m.name || 'Unknown',
        link: m.link || null,
        times: (m.times || [])
          .map((slot) => ({
            display: slot.time,
            timestamp: parseShowtime(slot.time),
          }))
          .filter((slot) => slot.timestamp !== null),
      })).filter((m) => m.times.length > 0),
    })).filter((t) => t.movies.length > 0);

    res.json({ theaters });
  } catch (err) {
    console.error('[showtimes]', err.message);
    const status = err.response?.status || 500;
    const detail = err.response?.data?.error || err.message;
    res.status(status).json({ error: `SerpApi error: ${detail}` });
  }
};
