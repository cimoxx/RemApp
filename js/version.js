/* Jediný zdroj verzie aplikácie. Číta ho aplikácia (nastavenia, changelog) aj service worker
 * (názov cache), takže zvýšenie verzie zároveň vynúti novú cache. Pri každej zmene:
 * 1) zvýš APP_VERSION, 2) pridaj záznam do js/changelog.js. */
self.APP_VERSION = '1.0.0';
