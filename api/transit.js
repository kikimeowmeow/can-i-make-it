const axios = require('axios');

const transitCache = new Map();
const TRANSIT_CACHE_TTL = 10 * 60 * 1000;

async function getDirections(origin, destination, mode, key) {
  const res = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    params: {
      origin,
      destination,
      mode,
      departure_time: Math.floor(Date.now() / 1000),
      key,
    },
    timeout: 12000,
  });
  return res.data.routes?.[0] || null;
}

module.exports = async (req, res) => {
  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.query;
  if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
    return res.status(400).json({ error: 'origin and destination coords required' });
  }

  const cacheKey = `${origin_lat},${origin_lng}->${dest_lat},${dest_lng}`;
  const cached = transitCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TRANSIT_CACHE_TTL) {
    return res.json({ duration_seconds: cached.duration_seconds, mode: cached.mode, cached: true });
  }

  if (!process.env.GOOGLE_MAPS_KEY) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_KEY not configured' });
  }

  const origin = `${origin_lat},${origin_lng}`;
  const destination = `${dest_lat},${dest_lng}`;
  const key = process.env.GOOGLE_MAPS_KEY;

  try {
    // Try transit first, fall back to driving
    let route = await getDirections(origin, destination, 'transit', key);
    let mode = 'transit';

    if (!route) {
      route = await getDirections(origin, destination, 'driving', key);
      mode = 'driving';
    }

    if (!route) {
      return res.json({ duration_seconds: null, error: 'No route found' });
    }

    const duration_seconds = route.legs[0].duration.value;
    transitCache.set(cacheKey, { duration_seconds, mode, ts: Date.now() });
    res.json({ duration_seconds, mode });
  } catch (err) {
    console.error('[transit]', err.message);
    res.status(500).json({ error: err.message });
  }
};
