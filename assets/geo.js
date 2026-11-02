/* Recherche par adresse : point dans un polygone (GeoJSON, lon/lat), distance à la limite de circonscription la
 * plus proche, et contrôle de la réponse du géocodeur (assessGeocode). Script classique (pas de module) : expose window.ANGeo ; testé par
 * tests/geo.test.mjs (node --test). Aucune dépendance. */
(function (root) {
    'use strict';

    /** Lancer de rayon : le point [lon, lat] est-il dans l'anneau ? */
    function inRing(pt, ring) {
        const [x, y] = pt;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    /** Dans le polygone = dans l'anneau extérieur et dans aucun trou. */
    function inPolygon(pt, poly) {
        if (!poly.length || !inRing(pt, poly[0])) return false;
        for (let k = 1; k < poly.length; k++) if (inRing(pt, poly[k])) return false;
        return true;
    }

    function inGeometry(pt, geom) {
        if (!geom) return false;
        if (geom.type === 'Polygon') return inPolygon(pt, geom.coordinates);
        if (geom.type === 'MultiPolygon') return geom.coordinates.some((p) => inPolygon(pt, p));
        return false;
    }

    const rings = (geom) => (geom.type === 'Polygon' ? geom.coordinates : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : []);

    /** Distance en mètres du point au segment [a, b] (projection équirectangulaire locale, précise à l'échelle d'une ville). */
    function distSegmentM(pt, a, b) {
        const kx = 111320 * Math.cos((pt[1] * Math.PI) / 180), ky = 110574;
        const ax = (a[0] - pt[0]) * kx, ay = (a[1] - pt[1]) * ky, bx = (b[0] - pt[0]) * kx, by = (b[1] - pt[1]) * ky;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        return Math.hypot(ax + t * dx, ay + t * dy);
    }

    /** Distance en mètres du point au contour le plus proche de la géométrie. */
    function distanceToBoundaryM(pt, geom) {
        let best = Infinity;
        for (const ring of rings(geom)) {
            for (let i = 1; i < ring.length; i++) best = Math.min(best, distSegmentM(pt, ring[i - 1], ring[i]));
        }
        return best;
    }

    /**
     * Circonscription contenant le point parmi les features { properties: { circo }, geometry } ;
     * `candidates` (facultatif) restreint la recherche aux circonscriptions de la commune.
     * Renvoie { circo, distanceM } (distance à la limite la plus proche) ou null.
     */
    function findCirco(features, lon, lat, candidates) {
        const pt = [lon, lat];
        const list = candidates && candidates.length ? features.filter((f) => candidates.includes(f.properties.circo)) : features;
        for (const f of list) {
            if (inGeometry(pt, f.geometry)) return { circo: f.properties.circo, distanceM: distanceToBoundaryM(pt, f.geometry) };
        }
        return null;
    }

    const SCORE_MIN = 0.5;  // en deçà, le géocodeur a deviné (« Mata-Utu » → « Matas, Gaillac-Toulza » : 0,37)
    const fold = (s) => ' ' + String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

    /**
     * Peut-on se fier à la réponse du géocodeur pour la requête `query` ? `props` = properties de la feature.
     * `precise` : la commune compte plusieurs circonscriptions (ou n'est pas rattachée), le centre de la commune
     * ne suffit donc pas. Renvoie { verdict, autreCommune } :
     *  - verdict 'incertain' (score trop faible), 'commune' (seul le centre de la commune est connu alors qu'il faut
     *    une adresse) ou 'ok' ;
     *  - autreCommune : ni la commune, ni le code postal, ni la localité trouvés ne figurent dans la requête
     *    (« 12 rue de la paix » → Cherbourg) : à signaler, sans bloquer.
     */
    function assessGeocode(props, query, precise) {
        const p = props || {};
        const verdict = !(p.score >= SCORE_MIN) ? 'incertain' : precise && p.type === 'municipality' ? 'commune' : 'ok';
        const q = fold(query);
        const autreCommune = ![p.city, p.postcode, p.locality, p.oldcity, p.municipality]
            .some((v) => v && q.includes(fold(v)));
        return { verdict, autreCommune };
    }

    root.ANGeo = { inRing, inPolygon, inGeometry, distanceToBoundaryM, findCirco, assessGeocode };
})(typeof window !== 'undefined' ? window : globalThis);
