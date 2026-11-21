# Incident Watch – Citizen Reporting App

Cross-platform (Android + iOS) mobile app built with **Cordova**, using **WordPress** as the backend.
Every incident is a normal WordPress **post**; the incident type is a post **category**.

```
citizen-report/
├── config.xml                      Cordova config + plugins
├── www/                            The app (HTML/CSS/JS)
│   ├── index.html
│   ├── css/style.css
│   └── js/config.js, app.js        <- set SITE_URL in config.js
└── wordpress-plugin/citizen-reporter/citizen-reporter.php
```

## 1. Set up WordPress (10 minutes)

1. Needs WordPress 5.6+ (for Application Passwords) and **HTTPS** on the site.
2. Copy the folder `wordpress-plugin/citizen-reporter` into `wp-content/plugins/`, then activate **Citizen Reporter API** in the dashboard.
   It creates the categories (Accident, Fighting, Rioting, Fire, Robbery, Flooding, Other) and adds:
   - geolocation fields on posts (`cr_latitude`, `cr_longitude`, `cr_address`) exposed in the REST API
   - `POST /wp-json/citizen-reporter/v1/register` and `/login`
   - CORS headers so the app can call the API
3. In **Settings → Permalinks** choose anything except "Plain" (or set `PRETTY_PERMALINKS: false` in the app config).
4. Apache only: if login returns 401 on every call, add this to the top of `.htaccess` so the `Authorization` header reaches PHP:
   ```
   RewriteEngine On
   RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
   ```
5. Testing on plain `http://` only: add `define( 'CITIZEN_REPORTER_DEV', true );` to `wp-config.php`. Remove it for production.

## 2. Build the app

```bash
npm install -g cordova
cd citizen-report
# edit www/js/config.js  -> SITE_URL
cordova platform add android      # and/or: cordova platform add ios
cordova build android
cordova run android
```

**Preview in a browser first:** `cd www && python3 -m http.server 8080`, open http://localhost:8080.
Everything works except the native notification (a toast is shown instead).

## 3. How each requirement is met

| # | Requirement | Implementation |
|---|-------------|----------------|
| 1 | Add a new incident | **Report** tab → category, headline, details, location, photos → `POST /wp/v2/posts` |
| 2 | Browse all incidents | **Incidents** tab, paged list with "load more" / infinite scroll → `GET /wp/v2/posts` |
| 3 | Posted automatically | Posts are created with `status: publish`, so they appear immediately for everyone |
| 4 | Notified of new incidents | App checks for new posts every `POLL_SECONDS`, raises a native local notification (`cordova-plugin-local-notification`), a toast and a badge on the refresh button. It skips your own posts |
| 5 | Browse by category | Category chips on the feed → `GET /wp/v2/posts?categories=ID` |
| 6 | Geolocation | `cordova-plugin-geolocation` captures lat/lng; saved as post meta; shown on the detail screen with an OpenStreetMap embed and "Open map" link |
| 7 | Pictures | Up to 4 photos (camera or gallery), resized to 1280 px, uploaded to the WordPress media library; first one is the featured image, all are shown in the incident gallery |
| 8 | Login | Register / log in via the plugin endpoints. The app stores a WordPress Application Password and uses it for Basic auth. **Mine** tab → `GET /wp/v2/posts?author=ME` |

New users get the WordPress **author** role: they can publish their own posts and upload photos, and nothing else.

## 4. Notes and next steps

- **Library:** the brief mentions "App.js". I couldn't fetch that library from here, so the UI uses a tiny hand-written view router in plain JavaScript (no dependencies). If your assessor expects App.js specifically, the views are already split into `<section class="view">` blocks that map one-to-one onto App.js pages, and all data logic lives in `js/app.js` functions you can call from page controllers.
- **Push notifications while the app is closed:** polling only runs while the app is open (Android may freeze it in the background). For true push, add `cordova-plugin-firebase-messaging`, have the app subscribe to an `incidents` topic, and in WordPress hook `transition_post_status` to send an FCM message when a post is published.
- **Security hardening for production:** store the app password with a secure-storage plugin instead of `localStorage`, add rate limiting to the login/register endpoints, and consider moderation (set `status` to `pending` in `submitIncident()` and approve in the dashboard).
- Users can revoke app access anytime from **Users → Profile → Application Passwords** in WordPress.
