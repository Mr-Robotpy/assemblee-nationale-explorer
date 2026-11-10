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
// Le site de test est construit sans réseau, donc sans table des communes : seule absence admise.
const ABSENCES_ADMISES = ['/data/communes.json'];

let site, server, browser, base;

before(async () => {
    site = mkdtempSync(path.join(tmpdir(), 'an-e2e-'));
    execFileSync(process.env.PYTHON || 'python3', [path.join(ROOT, 'tests', 'e2e', 'make_site.py'), site], { stdio: 'inherit' });
    server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.join(site, rel === '/' ? 'index.html' : rel);
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
async function ouvrir(hash = '', { meta } = {}) {
    const context = await browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();
    const erreurs = [];
    const tiers = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) tiers.push(r.url()); });
    page.on('response', (r) => {
        const chemin = new URL(r.url()).pathname;
        if (r.status() >= 400 && !ABSENCES_ADMISES.includes(chemin)) erreurs.push(`${r.status()} ${chemin}`);
    });
    if (meta) {
        await page.route('**/data/meta.json', async (route) => {
            const json = await (await route.fetch()).json();
            await route.fulfill({ json: meta(json) });
        });
    }
    await page.goto(base + hash);
    await page.locator('#headerUpdated').filter({ hasText: 'Données mises à jour' }).waitFor();
    const fin = async () => {
        assert.deepEqual(erreurs, [], 'erreurs JavaScript ou fichiers manquants');
        assert.deepEqual(tiers, [], 'requêtes vers un autre site');
        await context.close();
    };
    return { page, fin };
}

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
