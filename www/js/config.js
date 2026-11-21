// Edit this file before building.
window.CONFIG = {
  // Your WordPress site, no trailing slash. Use https:// in production.
  SITE_URL: 'https://your-site.com',

  // true  -> https://site/wp-json/...         (Settings > Permalinks set to anything except "Plain")
  // false -> https://site/?rest_route=/...    (works even with "Plain" permalinks)
  PRETTY_PERMALINKS: true,

  // How often (seconds) the app checks for new incidents while it is open.
  POLL_SECONDS: 45,

  PER_PAGE: 10,
  MAX_PHOTOS: 4
};
