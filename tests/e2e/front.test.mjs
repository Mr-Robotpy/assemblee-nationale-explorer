// Tests du front dans un vrai navigateur (Chromium, Playwright), sur un site construit à partir des extraits
// de tests/fixtures par la même chaîne que la production. Lancement : `npm run test:e2e`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
// Seul tiers admis : le géocodeur de l'État, appelé à la demande de l'utilisateur. Toujours simulé dans les tests.
const GEOCODEUR = 'https://data.geopf.fr/geocodage/search';

let site, server, browser, base;

before(async () => {
    site = mkdtempSync(path.join(tmpdir(), 'an-e2e-'));
    execFileSync(process.env.PYTHON || 'python3', [path.join(ROOT, 'tests', 'e2e', 'make_site.py'), site], { stdio: 'inherit' });
    server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.join(site, rel.endsWith('/') ? rel + 'index.html' : rel);  // comme GitHub Pages
        if (!file.startsWith(site) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        createReadStream(file).pipe(res);
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok()));
    if (site) rmSync(site, { recursive: true, force: true });
});

/** Ouvre le site dans un contexte neuf (localStorage vide) et surveille erreurs et requêtes pendant tout le test. */
async function ouvrir(hash = '', { meta, geocodeur, position } = {}) {
    const context = await browser.newContext({ locale: 'fr-FR', ...(position ? { geolocation: position, permissions: ['geolocation'] } : {}) });
    const page = await context.newPage();
    const erreurs = [];
    const tiers = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    const appels = [];  // requêtes envoyées au géocodeur (paramètres)
    const bloques = [];  // refus de la politique de sécurité de contenu
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) bloques.push(m.text()); });
    page.on('request', (r) => {
        if (r.url().startsWith(GEOCODEUR)) appels.push(Object.fromEntries(new URL(r.url()).searchParams));
        else if (!r.url().startsWith(base) && !r.url().startsWith('data:')) tiers.push(r.url());
    });
    page.on('response', (r) => {
        if (r.status() >= 400 && r.url().startsWith(base)) erreurs.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    // Sans simulation demandée, tout appel au géocodeur échoue : aucun test ne sort sur le réseau.
    await page.route(GEOCODEUR + '**', async (route) => {
        const rep = geocodeur ? geocodeur(Object.fromEntries(new URL(route.request().url()).searchParams)) : 599;
        if (typeof rep === 'number') await route.fulfill({ status: rep, body: 'indisponible' });
        else await route.fulfill({ json: { type: 'FeatureCollection', features: rep }, headers: { 'access-control-allow-origin': '*' } });
    });
    if (meta) {
        await page.route('**/data/meta.json', async (route) => {
            const json = await (await route.fetch()).json();
            await route.fulfill({ json: meta(json) });
        });
    }
    await page.goto(base + hash);
    await page.locator('#headerUpdated').filter({ hasText: 'Données mises à jour' }).waitFor();
    const fin = async ({ blocagesAttendus = 0 } = {}) => {
        assert.deepEqual(erreurs, [], 'erreurs JavaScript ou fichiers manquants');
        assert.equal(bloques.length, blocagesAttendus, `politique de sécurité de contenu : ${bloques.join(' | ')}`);
        assert.deepEqual(tiers, [], 'requêtes vers un autre site');
        await context.close();
    };
    return { page, fin, appels };
}

/** Réponse du géocodeur : une adresse au numéro (par défaut) dans une commune du jeu d'essai. */
function adresse({ numero = '12', voie = 'Rue de la Paix', ville = 'Bourg-Partagé', insee = '55901', cp = '55100', lon, lat = 49.16,
    score = 0.95, type = 'housenumber' } = {}) {
    const name = type === 'municipality' ? ville : `${numero} ${voie}`;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { label: type === 'municipality' ? `${cp} ${ville}` : `${name} ${cp} ${ville}`, score, type, name, housenumber: numero,
            street: voie, postcode: cp, citycode: insee, city: ville } };
}
// Les deux circonscriptions du jeu d'essai sont séparées par le méridien 5,40° (tests/e2e/make_site.py).
const DANS_LA_1RE = 5.38, DANS_LA_2E = 5.42, PRES_DE_LA_LIMITE = 5.3996;

const attendre = (page, sel, texte) => page.locator(sel).filter({ hasText: texte }).first().waitFor();
const nombre = (page, sel) => page.locator(sel).count();
const visible = (page, sel) => page.locator(sel).evaluate((e) => !e.classList.contains('hidden'));

test('accueil : chiffres clés, derniers scrutins, aucun bandeau', async () => {
    const { page, fin } = await ouvrir();
    await attendre(page, '#kpis', 'Députés en exercice');
    assert.match(await page.locator('#kpis').innerText(), /Députés en exercice\s+6\s+2 groupes/i)  // libellés en capitales (CSS);
    await attendre(page, '#dashScrutins', 'Scrutin n°4003');
    assert.equal(await visible(page, '#globalError'), false);
    assert.equal(await visible(page, '#tab-dashboard'), true);
    // Chart.js est chargé en différé : les trois graphiques doivent tout de même être tracés.
    await page.waitForFunction(() => ['chartGroups', 'chartGender', 'chartMinisteres'].every((id) => window.Chart && window.Chart.getChart(id)));
    await fin();
});

test('listes : députés, lois, questions et scrutins affichent tous les éléments publiés', async () => {
    const { page, fin } = await ouvrir('#/deputes');
    await attendre(page, '#deputesCount', '6 député·e·s sur 6');
    assert.equal(await nombre(page, '#deputiesGrid > a'), 6);

    await page.locator('#desktopNav [data-tab="lois"]').click();
    await attendre(page, '#loisCount', '2 dossier(s)');
    assert.equal(await nombre(page, '#billsList > a'), 2);

    // Index en colonnes (format 2), chargés à l'ouverture de l'onglet : le décodage doit restituer chaque champ.
    await page.locator('#desktopNav [data-tab="questions"]').click();
    await attendre(page, '#questionsCount', '2 question(s)');
    const qe = page.locator('#questionsContainer > a[href="#/question/QANR5L17QE1234"]');
    assert.match(await qe.innerText(), /QE\s+n°1234[\s\S]*agriculture[\s\S]*Soutien aux maraîchers/);
    assert.match(await qe.innerText(), /Maxime Amblard/);

    await page.locator('#desktopNav [data-tab="scrutins"]').click();
    await attendre(page, '#scrutinsCount', '1 scrutin(s)');
    assert.match(await page.locator('#scrutinsList').innerText(), /n°4003[\s\S]*scrutin public ordinaire[\s\S]*adopté/);
    assert.equal(new URL(page.url()).hash, '#/scrutins');
    await fin();
});

test('filtres : la saisie met à jour l\'URL, et Précédent la défait', async () => {
    const { page, fin } = await ouvrir('#/deputes');
    await attendre(page, '#deputesCount', 'sur 6');
    await page.locator('#deputySearch').fill('bernalicis');
    await attendre(page, '#deputesCount', '1 député·e·s sur 6');
    assert.equal(new URL(page.url()).hash, '#/deputes?q=bernalicis');
    assert.match(await page.locator('#deputiesGrid').innerText(), /Ugo Bernalicis/);

    await page.locator('#filterSexe').selectOption('F');
    await attendre(page, '#deputesCount', '0 député·e·s sur 6');
    assert.equal(new URL(page.url()).hash, '#/deputes?q=bernalicis&sexe=F');

    await page.goBack();
    await attendre(page, '#deputesCount', '1 député·e·s sur 6');
    assert.equal(await page.locator('#filterSexe').inputValue(), '');
    await fin();
});

test('lien partageable : les filtres de l\'URL sont appliqués à l\'ouverture', async () => {
    const { page, fin } = await ouvrir('#/deputes?sexe=F&groupe=PO845401&inconnu=1');
    await attendre(page, '#deputesCount', '3 député·e·s sur 6');
    assert.equal(await page.locator('#filterSexe').inputValue(), 'F');
    assert.equal(await page.locator('#filterGroup').inputValue(), 'PO845401');
    const noms = await page.locator('#deputiesGrid h4').allInnerTexts();
    assert.deepEqual(noms.sort(), ['Anchya Bamana', 'Bénédicte Auzanot', 'Katiana Levavasseur']);

    await page.goto(base + '#/lois?type=pjl');
    await attendre(page, '#loisCount', '1 dossier(s)');
    assert.match(await page.locator('#billsList').innerText(), /Approbation des comptes de la sécurité sociale/);
    await fin();
});

test('fiche député : ouverture depuis la liste, statistiques, fermeture par Échap', async () => {
    const { page, fin } = await ouvrir('#/deputes?q=amblard');
    await attendre(page, '#deputesCount', '1 député·e·s sur 6');
    await page.locator('#deputiesGrid > a[href="#/depute/PA841495"]').click();
    await attendre(page, '#detailContent', 'Maxime Amblard');
    assert.equal(new URL(page.url()).hash, '#/depute/PA841495');
    const fiche = await page.locator('#detailContent').innerText();
    assert.match(fiche, /Meuse \(55\) · 1re circonscription/);
    assert.match(fiche, /Participation aux scrutins publics\s+100 %\s+1 votes \/ 1/);
    assert.match(fiche, /Questions posées\s+1/);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#detailModal').classList.contains('hidden'));
    assert.equal(new URL(page.url()).hash, '#/deputes?q=amblard');  // retour à la liste filtrée, pas à l'accueil
    await fin();
});

test('fiches dossier et question : accessibles par lien direct', async () => {
    const { page, fin } = await ouvrir('#/dossier/DLR5L17N50173');
    await attendre(page, '#detailContent', 'Approbation des comptes de la sécurité sociale pour l\'année 2023');
    const dossier = await page.locator('#detailContent').innerText();
    assert.match(dossier, /Projet de loi ordinaire/);
    assert.match(dossier, /Rejeté au Sénat/);
    assert.match(dossier, /Initiative : Gouvernement/);

    await page.goto(base + '#/question/QANR5L17QG1');
    await attendre(page, '#detailContent', 'Situation à Mayotte');
    assert.match(await page.locator('#detailContent').innerText(), /Anchya Bamana/);
    await fin();
});

test('suivis : conservés après rechargement, changement d\'un dossier signalé', async () => {
    const { page, fin } = await ouvrir('#/suivis');
    await attendre(page, '#followsContent', 'Vous ne suivez encore rien.');

    await page.goto(base + '#/dossier/DLR5L17N50173');
    const bouton = page.locator('#detailContent [data-follow="dossier:DLR5L17N50173"]');
    await bouton.click();
    await page.locator('#detailContent [data-follow="dossier:DLR5L17N50173"][aria-pressed="true"]').waitFor();
    const stocke = JSON.parse(await page.evaluate(() => localStorage.getItem('suivis.v1')));
    assert.match(JSON.stringify(stocke), /DLR5L17N50173/);

    await page.goto(base + '#/suivis');
    await page.reload();
    await attendre(page, '#followsContent', 'Approbation des comptes de la sécurité sociale');
    assert.equal(await page.locator('#followsLink').getAttribute('title'), 'Vos suivis (1)');
    assert.equal(await visible(page, '#followsBadge'), false);  // rien de nouveau depuis la consultation

    // Le dossier a changé de statut depuis la dernière visite : pastille dans l'en-tête et détail sur la page.
    await page.evaluate(() => {
        const f = JSON.parse(localStorage.getItem('suivis.v1'));
        f.dossiers.DLR5L17N50173.vu.statut = 'Adopté à l\'Assemblée';
        localStorage.setItem('suivis.v1', JSON.stringify(f));
    });
    await page.reload();
    await attendre(page, '#followsContent', 'Statut : Adopté à l\'Assemblée → Rejeté au Sénat');
    assert.equal(await visible(page, '#followsBadge'), true);
    assert.equal(await page.locator('#followsBadge').innerText(), '1');
    await fin();
});

test('recherche globale : tous les mots, sans accents ni majuscules', async () => {
    const { page, fin } = await ouvrir();
    await page.locator('#globalSearch').fill('MAYOTTE');
    await page.locator('#globalSearch').press('Enter');
    await attendre(page, '#searchSummary', '2 résultat(s)');
    assert.equal(new URL(page.url()).hash, '#/recherche?q=MAYOTTE');
    const resultats = await page.locator('#searchResults').innerText();
    assert.match(resultats, /Anchya Bamana/);
    assert.match(resultats, /Situation à Mayotte/);

    await page.goto(base + '#/recherche?q=' + encodeURIComponent('securite sociale comptes'));
    await attendre(page, '#searchSummary', '1 résultat(s)');
    assert.match(await page.locator('#searchResults').innerText(), /Approbation des comptes de la sécurité sociale/);
    await fin();
});

test('bandeau : données de plus de 48 h et mise à jour partielle', async () => {
    const ilYA = (jours) => new Date(Date.now() - jours * 86400000).toISOString().slice(0, 19) + 'Z';
    let { page, fin } = await ouvrir('', { meta: (m) => ({ ...m, generation: ilYA(1) }) });
    await attendre(page, '#kpis', 'Députés en exercice');
    assert.equal(await visible(page, '#globalError'), false);
    await fin();

    ({ page, fin } = await ouvrir('', { meta: (m) => ({ ...m, generation: ilYA(5.2), echecs: ['scrutins'] }) }));
    await attendre(page, '#globalError', 'depuis 5 jours');
    assert.match(await page.locator('#globalError').innerText(), /section\(s\) scrutins non rafraîchie\(s\)/);
    await fin();
});

test('député par commune : nom ou code postal, commune entière ou partagée', async () => {
    const { page, fin, appels } = await ouvrir('#/recherche?q=Testville');
    await attendre(page, '#searchResults', 'Votre député par commune');
    const bloc = page.locator('#searchResults .card', { hasText: 'Votre député par commune' });
    assert.match(await bloc.innerText(), /Testville-sur-Meuse\s*· Meuse \(55\) · 55000/);
    assert.match(await bloc.innerText(), /Maxime Amblard[\s\S]*1re circonscription/);
    assert.equal(await bloc.locator('[data-addr-open]').count(), 0);  // une seule circonscription : rien à préciser

    await page.goto(base + '#/recherche?q=55100');
    await attendre(page, '#searchResults', 'Bourg-Partagé');
    const partage = await page.locator('#searchResults .card', { hasText: 'Votre député par commune' }).innerText();
    assert.match(partage, /Commune partagée entre 2 circonscriptions/);
    assert.match(partage, /Maxime Amblard/);
    assert.match(partage, /2e circonscription : siège vacant ou député introuvable/);
    assert.deepEqual(appels, []);  // la recherche par commune n'envoie rien au géocodeur
    await fin();
});

test('préciser avec son adresse : la circonscription est calculée dans le navigateur', async () => {
    const { page, fin, appels } = await ouvrir('#/recherche?q=Bourg-Partagé', { geocodeur: () => [adresse({ lon: DANS_LA_1RE })] });
    await attendre(page, '#searchResults', 'Commune partagée');
    await page.locator('[data-addr-open]').click();
    assert.match(await page.locator('[data-addr-form]').innerText(), /envoyée à l'API Adresse de l'État/);  // annoncé avant l'envoi
    assert.deepEqual(appels, []);  // ouvrir le formulaire n'envoie rien
    await page.locator('[data-addr-form] input').fill('12 rue de la Paix');
    await page.locator('[data-addr-form] button', { hasText: 'Chercher' }).click();
    await attendre(page, '[data-addr-result]', '1re circonscription');
    const resultat = await page.locator('[data-addr-result]').innerText();
    assert.match(resultat, /Adresse reconnue : 12 Rue de la Paix 55100 Bourg-Partagé/);
    assert.match(resultat, /1re circonscription — Maxime Amblard/);
    assert.doesNotMatch(resultat, /d'une limite/);
    assert.equal(appels.length, 1);
    assert.equal(appels[0].q, '12 rue de la Paix');
    assert.equal(appels[0].citycode, '55901');  // recherche restreinte à la commune choisie
    assert.equal(new URL(page.url()).hash, '#/recherche?q=Bourg-Partag%C3%A9');  // l'adresse ne va pas dans l'URL
    assert.doesNotMatch(JSON.stringify(await page.evaluate(() => ({ ...localStorage }))), /Paix/);  // ni dans le stockage
    await fin();
});

test('préciser avec son adresse : autre circonscription, et avertissement près d\'une limite', async () => {
    let lon = DANS_LA_2E;
    const { page, fin } = await ouvrir('#/recherche?q=55100', { geocodeur: () => [adresse({ lon })] });
    await attendre(page, '#searchResults', 'Commune partagée');
    await page.locator('[data-addr-open]').click();
    const chercher = async () => {
        await page.locator('[data-addr-form] input').fill('12 rue de la Paix');
        await page.locator('[data-addr-form] button', { hasText: 'Chercher' }).click();
    };
    await chercher();
    await attendre(page, '[data-addr-result]', '2e circonscription');
    assert.doesNotMatch(await page.locator('[data-addr-result]').innerText(), /Maxime Amblard/);

    lon = PRES_DE_LA_LIMITE;  // à une trentaine de mètres de la 2e
    await chercher();
    await attendre(page, '[data-addr-result]', 'd\'une limite de circonscription');
    assert.match(await page.locator('[data-addr-result]').innerText(), /1re circonscription — Maxime Amblard/);
    await fin();
});

test('adresse : aucun député affiché sans confirmation quand la voie trouvée n\'est pas celle saisie', async () => {
    // Le géocodeur renvoie toujours « la plus proche » : « rue Victor Hugo » devient « Rue Victor Lagrange ».
    const { page, fin } = await ouvrir('#/recherche?q=55100', {
        geocodeur: () => [adresse({ numero: '8', voie: 'Rue Victor Lagrange', lon: DANS_LA_1RE })] });
    await attendre(page, '#searchResults', 'Commune partagée');
    await page.locator('[data-addr-open]').click();
    await page.locator('[data-addr-form] input').fill('8 rue Victor Hugo');
    await page.locator('[data-addr-form] button', { hasText: 'Chercher' }).click();
    await attendre(page, '[data-addr-result]', 'Confirmez votre adresse');
    assert.doesNotMatch(await page.locator('[data-addr-result]').innerText(), /circonscription —/);
    await page.locator('[data-addr-result] [data-pick]').click();
    await attendre(page, '[data-addr-result]', '1re circonscription — Maxime Amblard');
    await fin();
});

test('adresse : réponse douteuse refusée, commune seule insuffisante, service en panne signalé', async () => {
    let reponse = [adresse({ lon: DANS_LA_1RE, score: 0.3 })];
    const { page, fin } = await ouvrir('#/recherche?q=55100', { geocodeur: () => reponse });
    await attendre(page, '#searchResults', 'Commune partagée');
    await page.locator('[data-addr-open]').click();
    const chercher = async (saisie) => {
        await page.locator('[data-addr-form] input').fill(saisie);
        await page.locator('[data-addr-form] button', { hasText: 'Chercher' }).click();
    };
    await chercher('12 rue de la Paix');
    await attendre(page, '[data-addr-result]', 'Aucune adresse « 12 rue de la Paix » trouvée à Bourg-Partagé');

    reponse = [adresse({ type: 'municipality', lon: DANS_LA_1RE })];  // seul le centre de la commune est reconnu
    await chercher('Bourg-Partagé');
    await attendre(page, '[data-addr-result]', 'Seule la commune a été reconnue');

    reponse = 503;
    await chercher('12 rue de la Paix');
    await attendre(page, '[data-addr-result]', 'Service de localisation indisponible');
    assert.doesNotMatch(await page.locator('[data-addr-result]').innerText(), /circonscription —/);
    await fin();
});

test('trouver mon député par adresse : commune entière sans calcul, commune partagée par les contours', async () => {
    let reponse = [adresse({ numero: '5', voie: 'Rue du Test', ville: 'Testville-sur-Meuse', insee: '55900', cp: '55000', lon: 5.0 })];
    const { page, fin, appels } = await ouvrir('#/deputes', { geocodeur: () => reponse });
    const form = page.locator('#tab-deputes [data-gaddr-form]');
    const chercher = async (saisie) => {
        await form.locator('input').fill(saisie);
        await form.locator('button', { hasText: 'Chercher par adresse' }).click();
    };
    await chercher('5 rue du Test, Testville-sur-Meuse');
    await attendre(page, '#tab-deputes [data-gaddr-result]', 'Maxime Amblard');
    let resultat = await form.locator('[data-gaddr-result]').innerText();
    assert.match(resultat, /Adresse reconnue : 5 Rue du Test 55000 Testville-sur-Meuse/);
    assert.match(resultat, /commune entièrement comprise dans cette circonscription/);
    assert.equal(appels[0].q, '5 rue du Test, Testville-sur-Meuse');
    assert.equal(appels[0].citycode, undefined);

    reponse = [adresse({ lon: DANS_LA_2E })];
    await chercher('12 rue de la Paix, Bourg-Partagé');
    await attendre(page, '#tab-deputes [data-gaddr-result]', '2e circonscription (55) : siège vacant');
    resultat = await form.locator('[data-gaddr-result]').innerText();
    assert.match(resultat, /calcul à partir des contours de circonscription de 2024/);

    reponse = [];
    await chercher('99 rue Inexistante, Nulle-Part');
    await attendre(page, '#tab-deputes [data-gaddr-result]', 'Adresse introuvable');
    await fin();
});

test('me localiser : position de l\'appareil, aucun envoi', async () => {
    const { page, fin, appels } = await ouvrir('#/recherche?q=55100', { position: { longitude: DANS_LA_1RE, latitude: 49.16 } });
    await attendre(page, '#searchResults', 'Commune partagée');
    await page.locator('[data-addr-open]').click();
    await page.locator('[data-geoloc]').click();
    await attendre(page, '[data-addr-result]', '1re circonscription — Maxime Amblard');
    assert.deepEqual(appels, []);
    await fin();
});

test('pages statiques : lisibles sans JavaScript, reliées à l\'application', async () => {
    // Sans JavaScript, comme un robot d'indexation : le contenu doit être dans le HTML.
    const sansJs = await browser.newContext({ javaScriptEnabled: false, locale: 'fr-FR' });
    const robot = await sansJs.newPage();
    const tiers = [];
    robot.on('request', (r) => { if (!r.url().startsWith(base)) tiers.push(r.url()); });
    const reponse = await robot.goto(base + 'depute/PA841495.html');
    assert.equal(reponse.status(), 200);
    assert.match(await robot.title(), /^Maxime Amblard, député RN · Meuse \(55\) · 1re circonscription/);
    assert.equal(await robot.locator('h1').innerText(), 'Maxime Amblard');
    assert.match(await robot.locator('main').innerText(), /Participation aux scrutins publics\s+100,0 %/);
    assert.match(await robot.locator('link[rel="canonical"]').getAttribute('href'), /\/depute\/PA841495\.html$/);
    await robot.goto(base + 'depute/');
    assert.equal(await robot.locator('main li a').count(), 6);
    await robot.goto(base + 'dossier/');
    await robot.locator('main li a', { hasText: 'Approbation des comptes' }).click();
    assert.equal(await robot.locator('h1').innerText(), 'Approbation des comptes de la sécurité sociale pour l\'année 2023');
    assert.deepEqual(tiers, []);
    await sansJs.close();

    // Avec JavaScript : la page statique mène à la fiche interactive, et l'application aux listes statiques.
    const { page, fin } = await ouvrir();
    await page.goto(base + 'dossier/DLR5L17N50173.html');
    await page.getByRole('link', { name: 'Ouvrir la fiche interactive' }).click();
    await attendre(page, '#detailContent', 'Approbation des comptes de la sécurité sociale');
    assert.equal(new URL(page.url()).hash, '#/dossier/DLR5L17N50173');
    await page.goto(base);
    await page.locator('footer a[href="depute/"]').click();
    await page.locator('h1', { hasText: 'Les 6 députés en exercice' }).waitFor();
    await page.locator('main li a', { hasText: 'Bernalicis' }).click();
    await page.locator('h1', { hasText: 'Ugo Bernalicis' }).waitFor();
    await fin();
});

test('politique de sécurité de contenu : un script injecté dans la page ne s\'exécute pas', async () => {
    const { page, fin } = await ouvrir();
    await attendre(page, '#kpis', 'Députés en exercice');
    // Ce qu'obtiendrait une donnée hostile passée à travers l'échappement : un gestionnaire en ligne dans le HTML.
    const execute = await page.evaluate(() => {
        const hote = document.createElement('div');
        hote.innerHTML = '<button onclick="window.__injecte = true">piège</button>';
        document.body.appendChild(hote);
        hote.firstChild.click();
        return window.__injecte === true;
    });
    assert.equal(execute, false);
    await page.goto(base + 'depute/PA841495.html');
    assert.equal(await page.evaluate(() => {
        const hote = document.createElement('div');
        hote.innerHTML = '<button onclick="window.__injecte = true">piège</button>';
        document.body.appendChild(hote);
        hote.firstChild.click();
        return window.__injecte === true;
    }), false);
    await fin({ blocagesAttendus: 2 });
});

test('thème sombre : repris par les pages statiques', async () => {
    const { page, fin } = await ouvrir();
    await page.goto(base + 'depute/PA841495.html');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), false);
    await page.goto(base);
    await page.locator('#headerUpdated').filter({ hasText: 'Données mises à jour' }).waitFor();
    await page.locator('#themeToggle').click();
    await page.goto(base + 'depute/PA841495.html');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
    await fin();
});

test('thème sombre : appliqué au clic et conservé après rechargement', async () => {
    const { page, fin } = await ouvrir();
    const sombre = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    assert.equal(await sombre(), false);
    await page.locator('#themeToggle').click();
    assert.equal(await sombre(), true);
    await page.reload();
    await page.locator('#headerUpdated').filter({ hasText: 'Données mises à jour' }).waitFor();
    assert.equal(await sombre(), true);
    await fin();
});
