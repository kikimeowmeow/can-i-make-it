# CatchIt 🎬

Find movies you can still make — factoring in transit time and each theater's pre-show trailer window.

## What it does

1. Detects your current location (browser geolocation)
2. Fetches nearby movie showtimes via SerpApi (Google Movies)
3. Geocodes each theater address, then calculates transit time from your location using Google Maps
4. Applies chain-specific pre-show buffers so you know the **real** movie start time:

| Chain | Pre-show buffer |
|-------|----------------|
| AMC | 25 min (advertised pre-show) |
| Regal | 20 min |
| Cinemark | 15 min |
| Alamo Drafthouse | 15 min |
| ArcLight | 15 min |
| Others | 10 min |

5. Classifies each showing as **Catchable**, **Cutting It Close**, or **Too Late**
6. Shows "Leave by HH:MM" so you know exactly when to walk out the door

Results re-render live every 30 seconds as the clock ticks, and auto-refresh from the API every 5 minutes.

## Setup

### 1. Get API keys

**SerpApi** (movie showtimes)
- Sign up at https://serpapi.com
- Free tier: 100 searches/month (plenty for personal use)
- Copy your API key from the dashboard

**Google Maps Platform** (geocoding + transit directions)
- Go to https://console.cloud.google.com
- Create a project and enable **Geocoding API** and **Directions API**
- Create an API key (restrict it to these two APIs for safety)

### 2. Configure

```bash
cd catchit
cp .env.example .env
# Edit .env and paste your keys
```

### 3. Install & run

```bash
npm install
npm start
# → http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev
```

## Notes

- The SerpApi request uses `q=movies playing today near me` with your coordinates as the `location` parameter. Google's movie results are what drives the data.
- Transit time is fetched fresh every 10 minutes per destination (cached in memory). If no transit route is found, the app defaults to a 30-minute estimate.
- Theater chain detection is based on name matching (e.g. any theater with "AMC" in the name gets the 25-minute buffer). You can tune `PRESHOW_BY_CHAIN` in `server.js`.
