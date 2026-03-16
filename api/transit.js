const axios = require('axios');

const transitCache = new Map();
const TRANSIT_CACHE_TTL = 10 * 60 * 1000;

module.exports = async (req, res) => {
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
    return res.status(500).json({ error: 'GOOGLE_MAPS_KEY not configured' });
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
      return res.json({ duration_seconds: null, error: 'No transit route found' });
    }

    const duration_seconds = route.legs[0].duration.value;
    transitCache.set(cacheKey, { duration_seconds, ts: Date.now() });
    res.json({ duration_seconds });
  } catch (err) {
    console.error('[transit]', err.message);
    res.status(500).json({ error: err.message });
  }
};
