#!/usr/bin/env node
/**
 * Fetch Google Reviews – run daily (cron) to save reviews to static JSON.
 * Same Place ID, different language – outputs reviews-cs.json and reviews-de.json.
 *
 * Uses Places API only (no scraping):
 * - New Places API (v1): tries first
 * - Legacy Places API: fallback if New API fails
 *
 * Output: 5 newest reviews + place photos (from API, not from reviews).
 *
 * Env vars:
 *   GOOGLE_PLACES_API_KEY  – your API key
 *   GOOGLE_PLACE_ID        – Place ID (same for both, fetched with languageCode cs/de)
 */
'use strict';

var fs = require('fs');

var API_KEY = process.env.GOOGLE_PLACES_API_KEY;
var PLACE_ID = process.env.GOOGLE_PLACE_ID;

if (!API_KEY || API_KEY === 'YOUR_API_KEY') {
  console.error('Error: Set GOOGLE_PLACES_API_KEY (e.g. in GitHub Secrets).');
  process.exit(1);
}
if (!PLACE_ID || PLACE_ID === 'YOUR_PLACE_ID') {
  console.error('Error: Set GOOGLE_PLACE_ID (e.g. in GitHub Secrets).');
  process.exit(1);
}

var LANGS = [
  { lang: 'cs', placeId: PLACE_ID },
  { lang: 'de', placeId: PLACE_ID }
];

/**
 * Fetch place details from New Places API (v1).
 * Returns per-review googleMapsURI for better photo scraping.
 */
function fetchPlaceDetailsNew(placeId, languageCode) {
  var url = 'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId) +
    '?fields=id,displayName,rating,userRatingCount,reviews,googleMapsUri,photos' +
    '&languageCode=' + encodeURIComponent(languageCode);
  return fetch(url, {
    headers: {
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,reviews,googleMapsUri,photos'
    }
  }).then(function (r) {
    return r.json().then(function (json) {
      if (json.error) {
        var msg = (json.error.message || json.error.code || 'Unknown') + '';
        return Promise.reject(new Error('New API: ' + msg));
      }
      return json;
    });
  });
}

/**
 * Fetch place details from legacy Places API with reviews_sort=newest.
 * @see https://developers.google.com/maps/documentation/places/web-service/details
 */
function fetchPlaceDetailsLegacy(placeId, languageCode) {
  var url = 'https://maps.googleapis.com/maps/api/place/details/json' +
    '?place_id=' + encodeURIComponent(placeId) +
    '&key=' + encodeURIComponent(API_KEY) +
    '&reviews_sort=newest' +
    '&language=' + encodeURIComponent(languageCode) +
    '&fields=name,rating,user_ratings_total,reviews,url,photos';
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('API error ' + r.status + ': ' + r.statusText);
    return r.json();
  }).then(function (json) {
    if (json.status !== 'OK') {
      var msg = json.status || 'UNKNOWN_ERROR';
      if (json.error_message) msg += ' – ' + json.error_message;
      throw new Error('Places API: ' + msg);
    }
    return json.result;
  });
}

/**
 * Resolve New API photo (media) to image URL.
 */
function resolvePhotoUrlNew(placeId, photo) {
  if (!photo) return Promise.resolve(null);
  var name = typeof photo === 'object' && photo ? photo.name : (typeof photo === 'string' ? photo : null);
  if (!name) return Promise.resolve(null);
  var match = name.match(/\/(?:photos|media)\/([^/]+)$/);
  var photoRef = match ? match[1] : name;
  var mediaUrl = 'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId) + '/media/' + encodeURIComponent(photoRef) + '?maxWidthPx=1200';
  return fetch(mediaUrl, {
    headers: { 'X-Goog-Api-Key': API_KEY },
    redirect: 'manual'
  }).then(function (r) { return r.headers.get('location') || null; }).catch(function () { return null; });
}

/**
 * Resolve legacy photo_reference to image URL via Place Photo API.
 */
function resolvePhotoUrlLegacy(photoReference) {
  if (!photoReference || typeof photoReference !== 'string') return Promise.resolve(null);
  var photoUrl = 'https://maps.googleapis.com/maps/api/place/photo' +
    '?maxwidth=1200&photo_reference=' + encodeURIComponent(photoReference) +
    '&key=' + encodeURIComponent(API_KEY);
  return fetch(photoUrl, { redirect: 'manual' })
    .then(function (r) { return r.headers.get('location') || null; })
    .catch(function () { return null; });
}

/**
 * Normalize New API result to our JSON schema.
 */
function normalizePlaceNew(place, placeId) {
  var name = (place.displayName && place.displayName.text) || place.id || '';
  var rating = place.rating || 0;
  var userRatingCount = place.userRatingCount || 0;
  var url = place.googleMapsUri || 'https://www.google.com/maps/place/?q=place_id:' + placeId;
  var reviews = (place.reviews || []).map(function (r) {
    var author = r.authorAttribution || {};
    var textObj = r.text;
    var text = (typeof textObj === 'string') ? textObj : (textObj && textObj.text) || '';
    return {
      authorAttribution: {
        displayName: author.displayName || 'Anonym',
        photoURI: author.photoUri || author.profilePhotoUri || null,
        uri: author.uri || null
      },
      text: text,
      rating: r.rating || 0,
      relativePublishTimeDescription: r.relativePublishTimeDescription || r.publishTime || '',
      publishTime: r.publishTime || null,
      googleMapsURI: r.googleMapsUri || url
    };
  });
  var photos = place.photos || [];
  return {
    name: name,
    rating: rating,
    userRatingCount: userRatingCount,
    url: url,
    googleMapsURI: url,
    photos: photos,
    reviews: reviews,
    sortOrder: 'newest',
    fetchedAt: new Date().toISOString(),
    _fromNewApi: true
  };
}

/**
 * Normalize legacy API result to our JSON schema.
 */
function normalizePlaceLegacy(result, placeId) {
  var name = result.name || '';
  var rating = result.rating || 0;
  var userRatingCount = result.user_ratings_total || 0;
  var url = result.url || 'https://www.google.com/maps/place/?q=place_id:' + placeId;
  var reviews = (result.reviews || []).map(function (r) {
    var publishTime = r.time ? new Date(r.time * 1000).toISOString() : null;
    return {
      authorAttribution: {
        displayName: r.author_name || 'Anonym',
        photoURI: r.profile_photo_url || null,
        uri: r.author_url || null
      },
      text: r.text || '',
      rating: r.rating || 0,
      relativePublishTimeDescription: r.relative_time_description || '',
      publishTime: publishTime,
      googleMapsURI: url
    };
  });
  var photos = (result.photos || []).map(function (p) { return p.photo_reference; });
  return {
    name: name,
    rating: rating,
    userRatingCount: userRatingCount,
    url: url,
    googleMapsURI: url,
    photos: photos,
    reviews: reviews,
    sortOrder: 'newest',
    fetchedAt: new Date().toISOString(),
    _fromNewApi: false
  };
}

var PLACE_PHOTOS_MAX = 8;

function fetchPlacePhotosLegacy(placeId) {
  return fetchPlaceDetailsLegacy(placeId, 'en')
    .then(function (result) {
      var refs = (result.photos || []).map(function (p) { return p.photo_reference; }).slice(0, PLACE_PHOTOS_MAX);
      return Promise.all(refs.map(resolvePhotoUrlLegacy)).then(function (urls) { return urls.filter(Boolean); });
    })
    .catch(function () { return []; });
}

function fetchOne(lang, placeId) {
  return fetchPlaceDetailsNew(placeId, lang)
    .then(function (place) {
      var data = normalizePlaceNew(place, placeId);
      var photoPromises = (data.photos || []).slice(0, PLACE_PHOTOS_MAX).map(function (p) {
        return resolvePhotoUrlNew(placeId, p);
      });
      return Promise.all(photoPromises).then(function (urls) {
        data.photos = urls.filter(Boolean);
        if (data.photos.length === 0) {
          return fetchPlacePhotosLegacy(placeId).then(function (legacyUrls) {
            data.photos = legacyUrls;
            return data;
          });
        }
        return data;
      });
    })
    .catch(function (err) {
      console.warn('New API failed, falling back to Legacy:', err.message);
      return fetchPlaceDetailsLegacy(placeId, lang)
        .then(function (result) {
          var data = normalizePlaceLegacy(result, placeId);
          var photoPromises = (data.photos || []).slice(0, PLACE_PHOTOS_MAX).map(function (photoRef) {
            return resolvePhotoUrlLegacy(photoRef);
          });
          return Promise.all(photoPromises).then(function (urls) {
            data.photos = urls.filter(Boolean);
            return data;
          });
        });
    })
    .then(function (data) {
      delete data._fromNewApi;
      return { lang: lang, data: data };
    });
}

function main() {
  var promises = LANGS.map(function (l) { return fetchOne(l.lang, l.placeId); });
  Promise.all(promises)
    .then(function (results) {
      results.forEach(function (r) {
        var outFile = 'reviews-' + r.lang + '.json';
        fs.writeFileSync(outFile, JSON.stringify(r.data, null, 2), 'utf8');
        console.log('Saved', outFile, '-', r.data.reviews.length, 'reviews');
      });
    })
    .catch(function (err) {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

main();
