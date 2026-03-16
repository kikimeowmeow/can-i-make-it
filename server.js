require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.static('public'));

// ─── Theater chain pre-show buffers (minutes) ────────────────────────────────
// AMC advertises a 25-min pre-show starting at listed showtime.
// Other chains have varying previews; these are reasonable estimates.
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

// Parse showtime strings like "4:30pm", "11:15am", "7:00 PM" into today's timestamp
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

  // If showtime appears to be more than 2 hours in the past, it might be tomorrow's last show
  if (showtime.getTime() < now.getTime() - 2 * 60 * 60 * 1000) {
    showtime.setDate(showtime.getDate() + 1);
  }

  return showtime.getTime();
}

// ─── In-memory caches ─────────────────────────────────────────────────────────
const geocodeCache = new Map(); // address → {lat, lng}
const transitCache = new Map(); // "lat,lng->lat,lng" → {duration_seconds, ts}
const TRANSIT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/showtimes?lat=&lng=
// Fetches nearby theater showtimes from SerpApi (Google Movies)
app.get('/api/showtimes', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });

  if (!process.env.SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY not configured in .env' });
  }

  try {
    const serpRes = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google',
        q: 'movies playing today near me',
        location: `${lat},${lng}`,
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
});

// GET /api/geocode?address=
// Converts a theater address to lat/lng via Google Geocoding API
app.get('/api/geocode', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address is required' });

  if (geocodeCache.has(address)) {
    return res.json(geocodeCache.get(address));
  }

  if (!process.env.GOOGLE_MAPS_KEY) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_KEY not configured in .env' });
  }

  try {
    const geoRes = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key: process.env.GOOGLE_MAPS_KEY },
      timeout: 8000,
    });

    const result = geoRes.data.results?.[0];
    if (!result) return res.status(404).json({ error: 'Address not found' });

    const location = result.geometry.location; // {lat, lng}
    geocodeCache.set(address, location);
    res.json(location);
  } catch (err) {
    console.error('[geocode]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transit?origin_lat=&origin_lng=&dest_lat=&dest_lng=
// Returns transit travel time in seconds via Google Directions API
app.get('/api/transit', async (req, res) => {
  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.query;
  if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
    return res.status(400).json({ error: 'origin and destination coords required' });
  }

  const cacheKey = `${origin_lat},${origin_lng}->${dest_lat},${dest_lng}`;
  const cached = transitCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TRANSIT_CACHE_TTL) {
    return res.json({ duration_seconds: cached.duration_seconds, cached: true });
  }

  if (!process.env.GOOGLE_MAPS_KEY) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_KEY not configured in .env' });
  }

  try {
    const dirRes = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: {
        origin: `${origin_lat},${origin_lng}`,
        destination: `${dest_lat},${dest_lng}`,
        mode: 'transit',
        departure_time: Math.floor(Date.now() / 1000),
        key: process.env.GOOGLE_MAPS_KEY,
      },
      timeout: 12000,
    });

    const route = dirRes.data.routes?.[0];
    if (!route) {
      // No transit route found — fall back to walking estimate
      return res.json({ duration_seconds: null, error: 'No transit route found' });
    }

    const duration_seconds = route.legs[0].duration.value;
    transitCache.set(cacheKey, { duration_seconds, ts: Date.now() });
    res.json({ duration_seconds });
  } catch (err) {
    console.error('[transit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎬 CatchIt running at http://localhost:${PORT}\n`);
  if (!process.env.SERPAPI_KEY) console.warn('  ⚠  SERPAPI_KEY not set in .env');
  if (!process.env.GOOGLE_MAPS_KEY) console.warn('  ⚠  GOOGLE_MAPS_KEY not set in .env');
});
