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
