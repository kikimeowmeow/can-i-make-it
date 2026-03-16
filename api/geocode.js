const axios = require('axios');

const geocodeCache = new Map();

module.exports = async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address is required' });

  if (geocodeCache.has(address)) {
    return res.json(geocodeCache.get(address));
  }

  if (!process.env.GOOGLE_MAPS_KEY) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_KEY not configured' });
  }

  try {
    const geoRes = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key: process.env.GOOGLE_MAPS_KEY },
      timeout: 8000,
    });

    const result = geoRes.data.results?.[0];
    if (!result) return res.status(404).json({ error: 'Address not found' });

    const location = result.geometry.location;
    geocodeCache.set(address, location);
    res.json(location);
  } catch (err) {
    console.error('[geocode]', err.message);
    res.status(500).json({ error: err.message });
  }
};
