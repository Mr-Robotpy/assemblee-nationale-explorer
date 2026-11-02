// Tests de assets/geo.js : node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.runInNewContext(readFileSync(new URL('../assets/geo.js', import.meta.url), 'utf8'), ctx);
const { inGeometry, findCirco, distanceToBoundaryM } = ctx.ANGeo;

const carre = (x0, y0, c = 0.01) => [[x0, y0], [x0 + c, y0], [x0 + c, y0 + c], [x0, y0 + c], [x0, y0]];
// Deux circonscriptions voisines (Lyon, ~800 m de côté) ; la 4e est un MultiPolygon avec un trou.
const features = [
    { properties: { circo: 2 }, geometry: { type: 'Polygon', coordinates: [carre(4.83, 45.73)] } },
    { properties: { circo: 4 }, geometry: { type: 'MultiPolygon', coordinates: [
        [carre(4.84, 45.73), carre(4.844, 45.734, 0.002)],   // anneau extérieur + trou
        [carre(4.9, 45.8)],
    ] } },
];

test('point au centre d’un polygone', () => {
    assert.equal(findCirco(features, 4.835, 45.735).circo, 2);
});

test('MultiPolygon : seconde partie', () => {
    assert.equal(findCirco(features, 4.905, 45.805).circo, 4);
});

test('point dans un trou : hors de la circonscription', () => {
    assert.equal(inGeometry([4.845, 45.735], features[1].geometry), false);
    assert.equal(findCirco(features, 4.845, 45.735), null);
});

test('point hors de tout contour', () => {
    assert.equal(findCirco(features, 2.35, 48.85), null);
});

test('candidats : on ne cherche que dans les circonscriptions de la commune', () => {
    assert.equal(findCirco(features, 4.835, 45.735, [4]), null);
    assert.equal(findCirco(features, 4.835, 45.735, [2, 4]).circo, 2);
});

test('distance à la limite, en mètres', () => {
    // à 0,0001° de longitude du bord ouest (x = 4.83) à 45,73° de latitude : ≈ 7,8 m
    const d = distanceToBoundaryM([4.8301, 45.735], features[0].geometry);
    assert.ok(d > 7 && d < 8.5, `distance inattendue : ${d}`);
    const centre = findCirco(features, 4.835, 45.735);
    assert.ok(centre.distanceM > 380 && centre.distanceM < 400, `centre : ${centre.distanceM}`); // ~ demi-côté nord-sud (≈ 553 m) ou est-ouest (≈ 389 m)
});

// Réponses réelles du géocodeur (data.geopf.fr/geocodage, novembre 2026).
const { assessGeocode } = ctx.ANGeo;

test('géocodage : score faible refusé (Wallis-et-Futuna absent de la BAN)', () => {
    const r = assessGeocode({ label: 'Matas 31550 Gaillac-Toulza', type: 'street', score: 0.37, city: 'Gaillac-Toulza', postcode: '31550' }, 'Mata-Utu');
    assert.equal(r.verdict, 'incertain');
});

test('géocodage : centre de commune insuffisant si la commune est partagée', () => {
    const p = { type: 'municipality', score: 0.94, city: 'Aurseulles', postcode: '14240' };
    assert.equal(assessGeocode(p, 'Aurseulles 14240', true).verdict, 'commune');
    assert.equal(assessGeocode(p, 'Aurseulles 14240', false).verdict, 'ok');
});

test('géocodage : adresse précise acceptée, commune reconnue malgré accents et tirets', () => {
    const r = assessGeocode({ type: 'housenumber', score: 0.97, city: 'Orée d’Anjou', postcode: '49270' }, "3 rue du Moulin, oree d'anjou", true);
    assert.deepEqual({ ...r }, { verdict: 'ok', autreCommune: false });
});

test('géocodage : ancienne commune (localité) ou code postal suffisent', () => {
    const p = { type: 'locality', score: 0.95, city: 'Porte des Pierres Dorées', locality: 'Pouilly-le-Monial', postcode: '69400' };
    assert.equal(assessGeocode(p, 'Pouilly-le-Monial', true).autreCommune, false);
    assert.equal(assessGeocode(p, 'route de Theizé 69400', true).autreCommune, false);
});

test('géocodage : commune absente de la requête signalée', () => {
    const r = assessGeocode({ type: 'housenumber', score: 0.98, city: 'Cherbourg-en-Cotentin', postcode: '50100' }, '12 rue de la paix');
    assert.deepEqual({ ...r }, { verdict: 'ok', autreCommune: true });
});

// matchAddress : réponses réelles (Lyon 7e, citycode=69387, novembre 2026).
const { matchAddress } = ctx.ANGeo;
const hn = (street, housenumber, extra = {}) => ({ type: 'housenumber', street, housenumber, name: `${housenumber} ${street}`, ...extra });

test('adresse : autre voie → confirmation (signalement « République » → « Repos »)', () => {
    assert.deepEqual({ ...matchAddress(hn('Rue du Repos', '12'), '12 rue de la République') }, { ok: false, raison: 'voie' });
    assert.equal(matchAddress(hn('Rue Victor Lagrange', '8'), '8 rue Victor Hugo').raison, 'voie');  // score 0,52 : passait le seuil
});

test('adresse : numéro introuvable → confirmation (position de la voie)', () => {
    const p = { type: 'street', street: 'Rue Garibaldi', name: 'Rue Garibaldi' };
    assert.equal(matchAddress(p, '15 rue Garibaldi').raison, 'numero');
    assert.equal(matchAddress(p, 'rue Garibaldi, Lyon 69007').ok, true);   // code postal : pas un numéro
});

test('adresse : correspondance exacte malgré accents, abréviations, bis et commune', () => {
    assert.equal(matchAddress(hn('Rue de la République', '12'), '12 r. de la republique, Lyon').ok, true);
    assert.equal(matchAddress(hn('Boulevard Voltaire', '50'), '50 bd Voltaire 75011 Paris').ok, true);
    assert.equal(matchAddress(hn("Rue de l'Université", '20'), '20 bis rue de l’Université').ok, true);
    assert.equal(matchAddress({ type: 'street', street: 'Voie la canebiere', name: 'Voie la canebiere' }, 'La Canebière, Marseille').ok, true);
});

test('adresse : localité (ancienne commune) et centre de commune', () => {
    assert.equal(matchAddress({ type: 'locality', locality: 'Pouilly-le-Monial', name: 'Pouilly-le-Monial' }, 'Pouilly-le-Monial 69400').ok, true);
    assert.equal(matchAddress({ type: 'municipality', name: 'Lyon' }, 'Lyon').ok, true);
});

test('adresse : code postal saisi différent → confirmation', () => {
    const p = hn('Rue Victor Hugo', '8', { postcode: '69002' });
    assert.equal(matchAddress(p, '8 rue Victor Hugo, 69007 Lyon').raison, 'codePostal');
    assert.equal(matchAddress(p, '8 rue Victor Hugo, 69002 Lyon').ok, true);
    assert.equal(matchAddress(p, '8 rue Victor Hugo, Lyon').ok, true);
});
