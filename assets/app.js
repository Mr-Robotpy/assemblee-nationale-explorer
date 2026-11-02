/* Assemblée Open Data Explorer — front statique alimenté par les JSON de ./data
 * (générés par scripts/build_data.py via GitHub Actions). Aucune donnée simulée. */
'use strict';

const DATA = 'data/';
const PAGE = { deputes: 48, lois: 30, questions: 40, scrutins: 30 };
const STEP_LABELS = ['Dépôt', 'Commission', 'Séance', 'Navette / Sénat', 'Promulgation'];
const QTYPE = { QE: 'Question écrite', QG: 'Question au Gouvernement', QOSD: 'Question orale sans débat' };
const QTYPE_BADGE = {
    QE: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
    QG: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300',
    QOSD: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
};

const state = {
    meta: null, deputes: [], groupes: [], dossiers: [], questions: [], scrutins: [],
    shown: { deputes: PAGE.deputes, lois: PAGE.lois, questions: PAGE.questions, scrutins: PAGE.scrutins },
    loiCat: '', loiStatus: '', loiStep: 0, qType: '',
    charts: {},
};
const cache = new Map();
// Listes chargées au démarrage (questions : à la demande). Une liste en échec est notée dans
// state.failed et affichée « indisponible — réessayer », jamais comme une liste vide.
const LISTS = { deputes: 'deputes.json', groupes: 'groupes.json', dossiers: 'dossiers.json', scrutins: 'scrutins.json', questions: 'questions.json', communes: 'communes.json' };
state.failed = {};

async function loadLists(keys) {
    const results = await Promise.allSettled(keys.map((k) => getJSON(LISTS[k])));
    results.forEach((r, i) => {
        const k = keys[i];
        if (r.status === 'fulfilled') { state[k] = r.value; delete state.failed[k]; if (k === 'deputes') state.deputesParCirco = null; }
        else { state[k] = []; state.failed[k] = r.reason && r.reason.message ? r.reason.message : 'erreur réseau'; }
    });
}

function unavailable(keys, label) {
    const ks = keys.filter((k) => state.failed[k]);
    return `<div class="col-span-full card text-center space-y-3 border-amber-300 dark:border-amber-700">
        <p class="text-sm font-semibold text-amber-700 dark:text-amber-300"><i class="fa-solid fa-plug-circle-xmark mr-1"></i>${esc(label)} : données indisponibles</p>
        <p class="text-xs text-slate-500">Le chargement a échoué (${esc(ks.map((k) => state.failed[k]).join(' ; '))}). Il ne s'agit pas d'une absence de résultats.</p>
        <button class="btn-secondary" data-retry="${esc(ks.join(','))}"><i class="fa-solid fa-rotate-right"></i>Réessayer</button>
    </div>`;
}
const isDown = (...keys) => keys.some((k) => state.failed[k]);
let markReady;
const dataReady = new Promise((r) => { markReady = r; });

/* ---------------------------------------------------------------- utilitaires */
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/* Correspondance de recherche commune aux listes et à la recherche globale : chaque mot de la requête
 * (sans accents ni casse) doit apparaître, dans n'importe quel ordre. Mêmes champs que les listes. */
const tokens = (q) => norm(q).split(/[\s'’,;:.!?()«»"-]+/).filter((t) => t.length > 0);
const matches = (hay, toks) => toks.every((t) => hay.includes(t));
const HAY = {
    deputes: (d) => norm(`${d.prenom} ${d.nom} ${d.departement} ${d.numDepartement} ${d.groupe} ${d.circo}e circonscription`),
    lois: (d) => norm(`${d.titre} ${d.resume} ${(d.initiateurs || []).join(' ')} ${d.procedure}`),
    questions: (x) => norm(`${x.titre} ${x.rubrique} ${x.auteur} ${x.groupe} ${x.ministere} ${x.numero}`),
    scrutins: (x) => norm(`${x.titre} ${x.numero} ${x.demandeur}`),
};
/** 1 → « 1<sup>re</sup> », 2 → « 2<sup>e</sup> » (circonscriptions). */
const ordinal = (n) => `${esc(n)}<sup>${String(n) === '1' ? 're' : 'e'}</sup>`;
const fmtNum = (n) => (n ?? 0).toLocaleString('fr-FR');
function fmtDate(d, opts = { day: 'numeric', month: 'long', year: 'numeric' }) {
    if (!d) return '—';
    const dt = new Date(d.length === 10 ? d + 'T12:00:00' : d);
    return isNaN(dt) ? d : dt.toLocaleString('fr-FR', opts);
}
const fmtShort = (d) => fmtDate(d, { day: 'numeric', month: 'short', year: 'numeric' });
const pct = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')} %`);
const PARTICIPATION_INFO = "Part des scrutins publics auxquels le député a pris part (y compris par délégation) depuis le début de son mandat. Beaucoup de scrutins se tiennent en séance avec peu de députés présents : une participation faible ne signifie pas une absence à l'Assemblée (travaux en commission, circonscription…).";
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function getJSON(path) {
    if (cache.has(path)) return cache.get(path);
    const p = fetch(DATA + path, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`${r.status} sur ${path}`);
        return r.json();
    });
    cache.set(path, p);
    p.catch(() => cache.delete(path));
    return p;
}

function initials(d) {
    return esc(((d.prenom || '')[0] || '') + ((d.nom || '')[0] || ''));
}
/* Initiales sur la couleur du groupe, sans photo : les portraits de l'Assemblée ne sont pas réutilisables sans accord
 * (mentions légales de l'AN) et les afficher depuis son site lui transmettrait l'adresse IP des visiteurs. */
function avatar(d, size = 'w-12 h-12', ring = '') {
    const color = groupColor(d.groupeUid);
    const text = /\bw-(1[6-9]|[2-9]\d)\b/.test(size) ? 'text-2xl' : 'text-sm';
    return `<span aria-hidden="true" class="inline-flex ${size} shrink-0 rounded-full items-center justify-center font-bold ${text} border-slate-200 dark:border-slate-600 ${ring}"
        style="background:${esc(color)};color:${inkOn(color)}">${initials(d)}</span>`;
}
function groupColor(uid) {
    return (state.groupes.find((g) => g.uid === uid) || {}).couleur || '#94a3b8';
}
/* Texte lisible sur une couleur de groupe : noir ou blanc selon le meilleur rapport de contraste WCAG 2.x.
 * Les couleurs officielles vont du bleu nuit (RN) au jaune (LIOT) : un texte toujours blanc était illisible sur les claires. */
const INK_DARK = '#0f172a', INK_LIGHT = '#ffffff';
function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastRatio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
function inkOn(bg) {
    const l = luminance(bg);
    if (l === null) return INK_LIGHT;
    return contrastRatio(l, luminance(INK_DARK)) >= contrastRatio(l, 1) ? INK_DARK : INK_LIGHT;
}
function groupBadge(abrev, uid) {
    if (!abrev) return '';
    const c = groupColor(uid);
    return `<span class="badge" style="background:${esc(c)};color:${inkOn(c)}">${esc(abrev)}</span>`;
}
function emptyState(msg) {
    return `<div class="col-span-full p-8 text-center text-slate-500 text-sm card">${esc(msg)}</div>`;
}
function moreButton(id, shown, total) {
    const b = $(id);
    b.classList.toggle('hidden', shown >= total);
    b.textContent = `Afficher plus (${fmtNum(Math.max(0, total - shown))} restants)`;
}

/* ---------------------------------------------------------------- routage */
const TABS = ['dashboard', 'deputes', 'lois', 'questions', 'scrutins', 'donnees', 'recherche', 'suivis', 'mentions'];
let lastTab = 'dashboard';

/* ---------------------------------------------------------------- filtres dans l'URL
 * L'URL est la source de vérité des filtres de chaque liste : #/lois?type=pjl&etape=3&q=logement.
 * Valeurs par défaut omises ; valeurs inconnues ignorées (lien ancien ou modifié à la main). */
const LIST_TABS = ['deputes', 'lois', 'questions', 'scrutins'];
const listHash = {};  // dernière URL de chaque liste : le menu et la fermeture d'une fiche y reviennent

function setSelect(sel, v) {
    const el = $(sel);
    el.value = [...el.options].some((o) => o.value === v) ? v : '';
}
const textParam = (sel) => ({ get: () => $(sel).value.trim(), set: (v) => { $(sel).value = v; } });
const enumParam = (get, set, values) => ({ get, set: (v) => set(values.includes(v) ? v : '') });

const URL_FILTERS = {
    deputes: {
        q: textParam('#deputySearch'),
        groupe: { get: () => $('#filterGroup').value, set: (v) => setSelect('#filterGroup', v) },
        commission: { get: () => $('#filterCommission').value, set: (v) => setSelect('#filterCommission', v) },
        sexe: { get: () => $('#filterSexe').value, set: (v) => setSelect('#filterSexe', v) },
        tri: { get: () => ($('#filterSort').value === 'nom' ? '' : $('#filterSort').value), set: (v) => { setSelect('#filterSort', v); if (!$('#filterSort').value) $('#filterSort').value = 'nom'; } },
    },
    lois: {
        q: textParam('#loiSearch'),
        type: enumParam(() => state.loiCat.toLowerCase(), (v) => { state.loiCat = v.toUpperCase(); }, ['pjl', 'ppl', 'autre']),
        statut: enumParam(() => ({ cours: 'en-cours', prom: 'promulguees' }[state.loiStatus] || ''),
            (v) => { state.loiStatus = { 'en-cours': 'cours', promulguees: 'prom' }[v] || ''; }, ['en-cours', 'promulguees']),
        etape: enumParam(() => (state.loiStep ? String(state.loiStep) : ''), (v) => { state.loiStep = +v || 0; }, ['1', '2', '3', '4', '5']),
    },
    questions: {
        q: textParam('#questionSearch'),
        type: enumParam(() => state.qType.toLowerCase(), (v) => { state.qType = v.toUpperCase(); }, ['qg', 'qe', 'qosd']),
        statut: enumParam(() => ({ 1: 'repondues', 0: 'sans-reponse' }[$('#qStatus').value] || ''),
            (v) => { $('#qStatus').value = { repondues: '1', 'sans-reponse': '0' }[v] ?? ''; }, ['repondues', 'sans-reponse']),
    },
    scrutins: { q: textParam('#scrutinSearch') },
};

function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    const [head, id] = path.split('/');
    return { head, id, params: new URLSearchParams(query) };
}

function syncChips() {
    document.querySelectorAll('#loiCatFilter [data-cat]').forEach((b) => b.classList.toggle('chip-active', b.dataset.cat === state.loiCat));
    document.querySelectorAll('#loiCatFilter [data-status]').forEach((b) => b.classList.toggle('chip-active', b.dataset.status === state.loiStatus));
    document.querySelectorAll('#qTypeFilter [data-type]').forEach((b) => b.classList.toggle('chip-active', b.dataset.type === state.qType));
}

function setListHash(tab, hash) {
    listHash[tab] = hash;
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach((a) => { a.href = hash; });
}

/** Applique les paramètres de l'URL aux contrôles de la liste (sans réécrire l'URL). */
function applyUrlFilters(tab, params) {
    const spec = URL_FILTERS[tab];
    if (!spec) return;
    Object.entries(spec).forEach(([k, f]) => f.set(params.get(k) || ''));
    syncChips();
    state.shown[tab] = PAGE[tab];
    setListHash(tab, location.hash || `#/${tab}`);
}

/** Reporte les filtres courants dans l'URL : push pour un choix, replace pendant la frappe. */
function writeUrl(tab, mode = 'push') {
    const params = new URLSearchParams();
    Object.entries(URL_FILTERS[tab]).forEach(([k, f]) => { const v = f.get(); if (v) params.set(k, v); });
    const qs = params.toString();
    const hash = `#/${tab}${qs ? `?${qs}` : ''}`;
    setListHash(tab, hash);
    if (hash === location.hash) return;
    // Frappe : la première lettre crée une entrée d'historique, les suivantes la mettent à jour.
    const push = mode === 'push' || typingIn !== tab;
    typingIn = mode === 'replace' ? tab : null;
    history[push ? 'pushState' : 'replaceState'](null, '', hash);
    routedHash = location.hash;
}

const RENDER = { deputes: () => renderDeputies(), lois: () => renderBills(), questions: () => renderQuestions(), scrutins: () => renderScrutins() };
let routedHash = null;
let typingIn = null;  // liste dont la recherche est en cours de frappe

function route() {
    routedHash = location.hash;
    typingIn = null;
    const { head, id, params } = parseHash();
    if (['depute', 'dossier', 'question'].includes(head) && id) {
        showTab(lastTab);
        openDetail(head, decodeURIComponent(id));
        return;
    }
    closeDetail(false);
    const tab = TABS.includes(head) ? head : 'dashboard';
    showTab(tab);
    if (tab === 'suivis') {
        listHash.suivis = location.hash;
        renderFollows();
        return;
    }
    if (tab === 'recherche') {
        listHash.recherche = location.hash;
        renderSearch(params.get('q') || '');
        return;
    }
    if (LIST_TABS.includes(tab)) {
        applyUrlFilters(tab, params);
        if (state.ready && (tab !== 'questions' || state.questions.length || isDown('questions'))) RENDER[tab]();
    }
}

// Retour / Avance du navigateur : popstate (entrées pushState) et hashchange (liens) ; un seul routage par URL.
function onNavigate() {
    if (location.hash !== routedHash) route();
}

function showTab(tab) {
    if (tab !== lastTab) window.scrollTo(0, 0);  // nouvelle page : en haut (sinon un lien du pied de page ouvre la page déjà défilée)
    lastTab = tab;
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.toggle('hidden', el.id !== `tab-${tab}`));
    document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    if (tab === 'donnees') { try { renderMeta(); } catch (e) { console.error(e); } }
    if (tab === 'questions' && state.ready) loadQuestions();
}

/* ---------------------------------------------------------------- démarrage */
async function init() {
    $('#themeToggle').addEventListener('click', () => {
        const dark = document.documentElement.classList.toggle('dark');
        try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) { /* stockage indisponible */ }
        renderCharts();
    });
    $('#detailClose').addEventListener('click', () => closeDetail(true));
    $('#detailBackdrop').addEventListener('click', (e) => { if (e.target.id === 'detailBackdrop') closeDetail(true); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(true); });
    bindSearch();
    bindAddress();
    window.addEventListener('hashchange', onNavigate);
    window.addEventListener('popstate', onNavigate);
    bindFilters();
    route();

    let meta;
    try {
        meta = await getJSON('meta.json');
    } catch (e) {
        if (/^404/.test(e.message)) {
            showGlobalError(`Les données n'ont pas encore été générées. Lancez le workflow « Mise à jour des données » dans l'onglet Actions du dépôt, ou en local : <code>python scripts/build_data.py</code>.`);
        } else {
            showGlobalError(`Données indisponibles (${esc(e.message)}) : problème de connexion ou serveur momentanément injoignable. <button class="underline font-semibold" onclick="location.reload()">Réessayer</button>`);
        }
        markReady();
        return;
    }
    state.meta = meta;
    const gen = meta.generation ? fmtDate(meta.generation, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
    if (gen) {
        $('#headerUpdated').textContent = `Données mises à jour le ${gen}`;
        $('#heroUpdated').textContent = `Open Data officiel · mis à jour le ${gen}`;
    }
    if (meta.echecs && meta.echecs.length) {
        showGlobalError(`Dernière mise à jour partielle : section(s) ${esc(meta.echecs.join(', '))} non rafraîchie(s), données précédentes affichées.`);
    }

    await loadLists(['deputes', 'groupes', 'dossiers', 'scrutins']);
    state.ready = true;
    markReady();
    renderAll();
    if (lastTab === 'questions') loadQuestions();
}

function renderAll() {
    if (lastTab === 'recherche') renderSearch(parseHash().params.get('q') || '');
    fillFilterOptions();
    const { head, params } = parseHash();
    if (LIST_TABS.includes(head)) applyUrlFilters(head, params);
    renderDashboard();
    renderDashboardFollows();
    renderFollowsBadge();
    if (lastTab === 'suivis') renderFollows();
    renderDeputies();
    renderBills();
    renderScrutins();
    if (state.questions.length || isDown('questions')) renderQuestions();
    renderMeta();
}

async function retry(keys) {
    keys = [...new Set([...keys, ...Object.keys(state.failed)])];  // un clic relance toutes les listes en échec
    keys.forEach((k) => cache.delete(LISTS[k]));
    if (keys.includes('questions')) questionsLoading = null;
    document.querySelectorAll('[data-retry]').forEach((b) => { b.disabled = true; b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>Chargement…'; });
    await loadLists(keys);
    renderAll();
}

function showGlobalError(html) {
    const el = $('#globalError');
    el.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-2"></i>${html}`;
    el.classList.remove('hidden');
}

function bindFilters() {
    // Chaque changement de filtre : URL mise à jour (replace pendant la frappe, push sinon), puis rendu.
    const resetAnd = (key, fn, mode = 'push') => () => { state.shown[key] = PAGE[key]; writeUrl(key, mode); fn(); };
    $('#deputySearch').addEventListener('input', debounce(resetAnd('deputes', renderDeputies, 'replace')));
    ['#filterGroup', '#filterCommission', '#filterSexe', '#filterSort'].forEach((s) => $(s).addEventListener('change', resetAnd('deputes', renderDeputies)));
    $('#deputiesMore').addEventListener('click', () => { state.shown.deputes += PAGE.deputes; renderDeputies(); });

    $('#loiSearch').addEventListener('input', debounce(resetAnd('lois', renderBills, 'replace')));
    $('#loiCatFilter').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.cat !== undefined) { state.loiCat = b.dataset.cat; toggleChips('#loiCatFilter [data-cat]', b); }
        if (b.dataset.status !== undefined) { state.loiStatus = b.dataset.status; toggleChips('#loiCatFilter [data-status]', b); }
        resetAnd('lois', renderBills)();
    });
    // `?.` : une ancienne page encore en cache (sans ce bloc) ne doit pas casser tout le script.
    $('#loiStepFilter')?.addEventListener('click', (e) => {
        const b = e.target.closest('[data-step]');
        if (!b) return;
        state.loiStep = state.loiStep === +b.dataset.step ? 0 : +b.dataset.step;  // re-cliquer annule le filtre
        resetAnd('lois', renderBills)();
    });
    $('#billsMore').addEventListener('click', () => { state.shown.lois += PAGE.lois; renderBills(); });

    $('#questionSearch').addEventListener('input', debounce(resetAnd('questions', renderQuestions, 'replace')));
    $('#qStatus').addEventListener('change', resetAnd('questions', renderQuestions));
    $('#qTypeFilter').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        state.qType = b.dataset.type;
        toggleChips('#qTypeFilter button', b);
        resetAnd('questions', renderQuestions)();
    });
    $('#questionsMore').addEventListener('click', () => { state.shown.questions += PAGE.questions; renderQuestions(); });

    $('#scrutinSearch').addEventListener('input', debounce(resetAnd('scrutins', renderScrutins, 'replace')));
    $('#scrutinsMore').addEventListener('click', () => { state.shown.scrutins += PAGE.scrutins; renderScrutins(); });
    $('#scrutinsList').addEventListener('click', (e) => {
        const b = e.target.closest('[data-toggle]');
        if (b) document.getElementById(b.dataset.toggle).classList.toggle('hidden');
    });

    document.addEventListener('click', async (e) => {
        const share = e.target.closest('[data-share]');
        if (share) {
            const url = location.href;
            let ok = false;
            try { await navigator.clipboard.writeText(url); ok = true; } catch (err) { /* contexte non sécurisé : on affiche le lien */ }
            const label = share.querySelector('span');
            if (ok) { label.textContent = 'Lien copié'; setTimeout(() => { label.textContent = 'Copier le lien'; }, 1800); } else { window.prompt('Lien de cette recherche :', url); }
            return;
        }
        const b = e.target.closest('[data-retry]');
        if (b && !b.disabled) retry(b.dataset.retry.split(',').filter(Boolean));
    });
    document.addEventListener('click', (e) => {
        const f = e.target.closest('[data-follow], [data-unfollow]');
        if (f) {
            const [kind, uid] = (f.dataset.follow || f.dataset.unfollow).split(':');
            if (f.dataset.unfollow) {
                delete state.follows[kind === 'dossier' ? 'dossiers' : 'deputes'][uid];
                writeFollows();
                refreshFollowViews();
            } else toggleFollow(kind, uid);
            return;
        }
        const seen = e.target.closest('[data-seen]');
        if (seen) {
            const d = state.dossiers.find((x) => x.uid === seen.dataset.seen);
            if (d) markSeen(d);
        }
    });
    // Suivis modifiés dans un autre onglet
    window.addEventListener('storage', (e) => { if (e.key === FOLLOW_KEY) { state.follows = readFollows(); refreshFollowViews(); } });
    $('#findDeputyForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = $('#findDeputyInput').value.trim();
        if (v) location.hash = `#/recherche?q=${encodeURIComponent(v)}`;
    });
    $('#apiRun').addEventListener('click', runApi);
    $('#apiEndpoint').addEventListener('change', () => { $('#apiRaw').href = DATA + $('#apiEndpoint').value; });
    $('#apiCopy').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText($('#apiOutput').textContent));
}

function toggleChips(selector, active) {
    document.querySelectorAll(selector).forEach((b) => b.classList.toggle('chip-active', b === active));
}

function fillFilterOptions() {
    const gsel = $('#filterGroup');
    const gval = gsel.value, cval = $('#filterCommission').value;
    gsel.length = 1;
    $('#filterCommission').length = 1;
    state.groupes.forEach((g) => gsel.insertAdjacentHTML('beforeend', `<option value="${esc(g.uid)}">${esc(g.libelle)} (${esc(g.abrev)}) · ${g.sieges}</option>`));
    const coms = [...new Set(state.deputes.map((d) => d.commission).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    const csel = $('#filterCommission');
    coms.forEach((c) => csel.insertAdjacentHTML('beforeend', `<option value="${esc(c)}">${esc(c.replace(/^Commission (des |de la |de l'|du )?/i, ''))}</option>`));
    if (state.dossiers.some((d) => d.categorie === 'AUTRE')) document.querySelector('[data-cat="AUTRE"]').classList.remove('hidden');
    gsel.value = gval;
    csel.value = cval;
}

/* ---------------------------------------------------------------- tableau de bord */
function renderDashboard() {
    const m = state.meta.sections || {};
    const nbDep = state.deputes.length;
    const femmes = state.deputes.filter((d) => d.sexe === 'F').length;
    const dosTotal = (m.dossiers && m.dossiers.total) || {};
    const prom = (dosTotal.PJL_promulgues || 0) + (dosTotal.PPL_promulgues || 0);
    const qTotal = Object.values((m.questions && m.questions.total) || {}).reduce((a, b) => a + b, 0);
    const qRep = Object.values((m.questions && m.questions.repondues) || {}).reduce((a, b) => a + b, 0);
    const kpi = (label, value, sub, icon, color) => `
        <div class="card flex items-center justify-between gap-3">
            <div class="min-w-0">
                <p class="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">${label}</p>
                <p class="text-2xl font-bold text-slate-900 dark:text-white mt-1">${value}</p>
                <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">${sub}</p>
            </div>
            <div class="w-11 h-11 shrink-0 rounded-xl ${color} flex items-center justify-center text-lg"><i class="fa-solid ${icon}"></i></div>
        </div>`;
    const depDown = isDown('deputes');
    $('#kpis').innerHTML = [
        kpi('Députés en exercice', depDown ? '—' : fmtNum(nbDep), depDown ? 'indisponible' : `${state.groupes.length} groupes`, 'fa-user-tie', 'bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400'),
        kpi('Femmes', !depDown && nbDep ? pct((100 * femmes / nbDep).toFixed(1)) : '—', depDown ? 'indisponible' : `${fmtNum(femmes)} députées · ${fmtNum(nbDep - femmes)} députés`, 'fa-venus-mars', 'bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400'),
        kpi('Lois promulguées', fmtNum(prom), `${fmtNum((dosTotal.PJL || 0) + (dosTotal.PPL || 0))} dossiers de loi ouverts`, 'fa-gavel', 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400'),
        kpi('Questions posées', fmtNum(qTotal), `${qTotal ? pct((100 * qRep / qTotal).toFixed(1)) : '—'} avec réponse`, 'fa-comments', 'bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400'),
    ].join('');
    $('#majorityLabel').textContent = nbDep ? `Majorité absolue : ${Math.floor(nbDep / 2) + 1} sièges` : '';

    $('#dashScrutins').innerHTML = isDown('scrutins') ? unavailable(['scrutins'], 'Scrutins')
        : state.scrutins.slice(0, 5).map(scrutinMini).join('') || '<p class="text-xs text-slate-500">Aucun scrutin.</p>';
    $('#dashDossiers').innerHTML = isDown('dossiers') ? unavailable(['dossiers'], 'Textes') : state.dossiers.slice(0, 5).map((d) => `
        <a href="#/dossier/${esc(d.uid)}" class="row-link">
            <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1 gap-2">
                <span>${esc(d.procedure || '')}</span><span>${fmtShort(d.dateMaj)}</span>
            </div>
            <p class="font-semibold text-sm text-slate-900 dark:text-white line-clamp-2">${esc(d.titre)}</p>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">${esc(d.derniereEtape || '')}</p>
        </a>`).join('') || '<p class="text-xs text-slate-500">Aucun dossier.</p>';
    renderCharts();
}

function scrutinMini(s) {
    const adopted = (s.sort || '').startsWith('adopt');
    return `<a href="#/scrutins" class="row-link">
        <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
            <span>Scrutin n°${esc(s.numero)} · ${fmtShort(s.date)}</span>
            <span class="badge ${adopted ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'}">${esc(s.sort || '')}</span>
        </div>
        <p class="font-semibold text-sm text-slate-900 dark:text-white line-clamp-2">${esc(s.titre)}</p>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">Pour ${s.pour} · Contre ${s.contre} · Abstention ${s.abstention}</p>
    </a>`;
}

function renderCharts() {
    if (typeof Chart === 'undefined' || !state.meta) return;
    const dark = document.documentElement.classList.contains('dark');
    Chart.defaults.color = dark ? '#cbd5e1' : '#475569';
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    const grid = dark ? 'rgba(148,163,184,.15)' : 'rgba(148,163,184,.3)';
    Object.values(state.charts).forEach((c) => c.destroy());

    const chartDown = isDown('deputes', 'groupes');
    ['#chartGroups', '#chartGender'].forEach((id) => {
        const box = $(id).parentElement;
        const msg = box.querySelector('.chart-down');
        if (chartDown && !msg) { box.insertAdjacentHTML('beforeend', '<p class="chart-down absolute inset-0 flex items-center justify-center text-center text-xs text-amber-700 dark:text-amber-300">Données indisponibles — bouton « Réessayer » dans l\'onglet Députés</p>'); }
        if (!chartDown && msg) msg.remove();
    });
    state.charts = {};
    const g = chartDown ? [] : state.groupes;
    state.charts.groups = new Chart($('#chartGroups'), {
        type: 'bar',
        data: { labels: g.map((x) => x.abrev), datasets: [{ label: 'Sièges', data: g.map((x) => x.sieges), backgroundColor: g.map((x) => x.couleur), borderRadius: 6 }] },
        options: {
            responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => g[it[0].dataIndex].libelle } } },
            scales: { y: { beginAtZero: true, grid: { color: grid } }, x: { grid: { display: false } } },
            onClick: (_, els) => { if (els.length) location.hash = `#/deputes?groupe=${encodeURIComponent(g[els[0].index].uid)}`; },
        },
    });
    const f = state.deputes.filter((d) => d.sexe === 'F').length;
    if (!chartDown) state.charts.gender = new Chart($('#chartGender'), {
        type: 'doughnut',
        data: { labels: ['Femmes', 'Hommes'], datasets: [{ data: [f, state.deputes.length - f], backgroundColor: ['#EC4899', '#3B82F6'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { position: 'bottom' } } },
    });
    const mins = ((state.meta.sections.questions || {}).ministeres || []).slice(0, 10);
    state.charts.min = new Chart($('#chartMinisteres'), {
        type: 'bar',
        data: { labels: mins.map((x) => x[0]), datasets: [{ label: 'Questions', data: mins.map((x) => x[1]), backgroundColor: '#f59e0b', borderRadius: 4 }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: grid } }, y: { grid: { display: false } } } },
    });
}

/* ---------------------------------------------------------------- députés */
function filteredDeputies() {
    const q = tokens($('#deputySearch').value);
    const grp = $('#filterGroup').value, com = $('#filterCommission').value, sexe = $('#filterSexe').value, sort = $('#filterSort').value;
    const list = state.deputes.filter((d) =>
        (!q.length || matches(HAY.deputes(d), q)) &&
        (!grp || d.groupeUid === grp) && (!com || d.commission === com) && (!sexe || d.sexe === sexe));
    const cmp = {
        nom: (a, b) => (a.nomTri || '').localeCompare(b.nomTri || '', 'fr'),
        dept: (a, b) => (a.numDepartement || '').localeCompare(b.numDepartement || '', 'fr', { numeric: true }) || (+a.circo - +b.circo),
        participation: (a, b) => (b.participation ?? -1) - (a.participation ?? -1),
        questions: (a, b) => (b.questions ?? 0) - (a.questions ?? 0),
    }[sort];
    return list.sort(cmp);
}

function renderDeputies() {
    const grid = $('#deputiesGrid');
    if (isDown('deputes')) { $('#deputesCount').textContent = 'Données indisponibles'; grid.innerHTML = unavailable(['deputes', 'groupes'], 'Annuaire des députés'); moreButton('#deputiesMore', 0, 0); return; }
    const list = filteredDeputies();
    $('#deputesCount').textContent = `${fmtNum(list.length)} député·e·s sur ${fmtNum(state.deputes.length)}`;
    if (!list.length) { grid.innerHTML = emptyState('Aucun député ne correspond à ces critères.'); moreButton('#deputiesMore', 0, 0); return; }
    grid.innerHTML = list.slice(0, state.shown.deputes).map((d) => `
        <a href="#/depute/${esc(d.uid)}" class="card !p-4 hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 transition flex flex-col justify-between">
            <div class="flex items-start gap-3">
                ${avatar(d)}
                <div class="min-w-0">
                    <h4 class="font-bold text-sm text-slate-900 dark:text-white truncate">${esc(d.prenom)} ${esc(d.nom)}</h4>
                    <div class="mt-1">${groupBadge(d.groupe, d.groupeUid)}</div>
                </div>
            </div>
            <div class="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700/60 text-xs text-slate-500 dark:text-slate-400 space-y-1">
                <p class="truncate"><i class="fa-solid fa-location-dot w-4"></i>${esc(d.departement)} (${esc(d.numDepartement)}) · ${ordinal(d.circo)} circ.</p>
                <p class="truncate"><i class="fa-solid fa-building-columns w-4"></i>${esc(d.commission ? d.commission.replace(/^Commission (des |de la |de l'|du )?/i, '') : '—')}</p>
            </div>
            <div class="mt-2 flex justify-between items-center text-xs font-medium">
                <span class="text-blue-600 dark:text-blue-400">${d.participation != null ? `<span title="${esc(PARTICIPATION_INFO)}">Participation ${pct(d.participation)} <i class="fa-regular fa-circle-question text-slate-400"></i></span>` : ''}</span>
                <span class="text-slate-500">${d.questions != null ? `${fmtNum(d.questions)} question(s)` : ''}</span>
            </div>
        </a>`).join('');
    moreButton('#deputiesMore', state.shown.deputes, list.length);
}

/* ---------------------------------------------------------------- lois */
function filteredBills(ignoreStep = false) {
    const q = tokens($('#loiSearch').value);
    return state.dossiers.filter((d) =>
        (ignoreStep || !state.loiStep || d.etape === state.loiStep) &&
        (!state.loiCat || d.categorie === state.loiCat) &&
        (!state.loiStatus || (state.loiStatus === 'prom' ? d.etape === 5 : d.etape < 5)) &&
        (!q.length || matches(HAY.lois(d), q)));
}

function stepper(step) {
    return `<div class="grid grid-cols-5 gap-1" title="Étape ${step}/5 : ${esc(STEP_LABELS[step - 1])}">
        ${STEP_LABELS.map((_, i) => `<div class="h-1.5 rounded-full ${i < step ? (step === 5 ? 'bg-emerald-500' : 'bg-blue-600') : 'bg-slate-200 dark:bg-slate-700'}"></div>`).join('')}
    </div>`;
}

function statusBadge(statut, etape, decision) {
    const s = norm(decision || statut);
    const cls = etape === 5 || s.startsWith('adopt') ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
        : s.startsWith('rejet') ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
            : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
    return `<span class="badge ${cls}">${esc(statut || 'En cours')}</span>`;
}

function renderBills() {
    if (isDown('dossiers')) { $('#loisCount').textContent = 'Données indisponibles'; $('#billsList').innerHTML = unavailable(['dossiers'], 'Projets et propositions de loi'); moreButton('#billsMore', 0, 0); return; }
    const list = filteredBills();
    // Effectif par étape, calculé avec les autres filtres actifs (type, statut, recherche)
    const parEtape = [0, 0, 0, 0, 0];
    filteredBills(true).forEach((d) => { if (d.etape >= 1 && d.etape <= 5) parEtape[d.etape - 1] += 1; });
    document.querySelectorAll('#loiStepFilter [data-step]').forEach((b) => {
        b.setAttribute('aria-pressed', String(+b.dataset.step === state.loiStep));
        b.querySelector('.step-count').textContent = `${fmtNum(parEtape[b.dataset.step - 1])} texte(s)`;
    });
    const etape = state.loiStep ? ` à l'étape « ${STEP_LABELS[state.loiStep - 1]} »` : '';
    $('#loisCount').textContent = `${fmtNum(list.length)} dossier(s)${etape}${dossiersComplets()
        ? ' — tous les dossiers de la législature' : ' — tous les projets de loi, et les propositions les plus récemment actives'}`;
    const el = $('#billsList');
    if (!list.length) { el.innerHTML = emptyState('Aucun texte ne correspond.'); moreButton('#billsMore', 0, 0); return; }
    el.innerHTML = list.slice(0, state.shown.lois).map((d) => `
        <a href="#/dossier/${esc(d.uid)}" class="card block hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 transition space-y-2">
            <div class="flex flex-wrap items-center gap-2 text-xs">
                <span class="badge ${d.categorie === 'PJL' ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}">${esc(d.procedure)}</span>
                ${statusBadge(d.statut, d.etape, d.statutDecision)}
                ${d.procedureAcceleree ? '<span class="badge bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">Procédure accélérée</span>' : ''}
                ${d.texteIntegral ? '<span class="badge bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"><i class="fa-solid fa-file-lines mr-1"></i>Texte intégral</span>' : ''}
                <span class="ml-auto text-slate-500" title="Dernière étape accomplie"><i class="fa-regular fa-calendar mr-1"></i>${fmtShort(d.dateMaj)}</span>
            </div>
            <h3 class="text-base font-bold text-slate-900 dark:text-white">${esc(d.titre)}</h3>
            ${d.resume && norm(d.resume) !== norm(d.titre) ? `<p class="text-xs text-slate-600 dark:text-slate-300 line-clamp-2">${esc(d.resume)}</p>` : ''}
            <p class="text-xs text-slate-500 dark:text-slate-400">${esc((d.initiateurs || []).join(', '))}${d.nbInitiateurs > 3 ? ` et ${d.nbInitiateurs - 3} autre(s)` : ''}</p>
            <div class="pt-1 space-y-1">
                <div class="flex justify-between text-xs"><span class="text-blue-600 dark:text-blue-400 truncate pr-2" title="Dernière étape accomplie">${esc(d.derniereEtape || '')}</span><span class="text-slate-500 shrink-0">${esc(STEP_LABELS[d.etape - 1])}</span></div>
                ${d.prochaineEtape ? `<p class="text-xs text-amber-700 dark:text-amber-300"><i class="fa-regular fa-calendar-check mr-1"></i>Prévu le ${fmtShort(d.prochaineEtape.date)} : ${esc(d.prochaineEtape.libelle)}</p>` : ''}
                ${stepper(d.etape)}
            </div>
        </a>`).join('');
    moreButton('#billsMore', state.shown.lois, list.length);
}

/* ---------------------------------------------------------------- questions */
// Index le plus lourd (plusieurs Mo) : chargé seulement à la première visite de l'onglet.
let questionsLoading = null;
function loadQuestions() {
    if (questionsLoading) return questionsLoading;
    $('#questionsContainer').innerHTML = Array.from({ length: 4 }, () => '<div class="skeleton h-20 w-full"></div>').join('');
    questionsLoading = loadLists(['questions']).then(() => {
        if (isDown('questions')) questionsLoading = null;
        renderQuestions();
        renderMeta();
    });
    return questionsLoading;
}

function filteredQuestions() {
    const q = tokens($('#questionSearch').value);
    const st = $('#qStatus').value;
    return state.questions.filter((x) =>
        (!state.qType || x.type === state.qType) && (st === '' || String(+x.repondue) === st) &&
        (!q.length || matches(HAY.questions(x), q)));
}

function renderQuestions() {
    if (isDown('questions')) { $('#questionsCount').textContent = 'Données indisponibles'; $('#questionsContainer').innerHTML = unavailable(['questions'], 'Questions'); moreButton('#questionsMore', 0, 0); return; }
    const list = filteredQuestions();
    const tot = (state.meta && state.meta.sections.questions && state.meta.sections.questions.total) || {};
    const total = Object.values(tot).reduce((a, b) => a + b, 0);
    $('#questionsCount').textContent = `${fmtNum(list.length)} questions affichées (les plus récentes) sur ${fmtNum(total)} posées depuis le début de la législature`;
    const el = $('#questionsContainer');
    if (!list.length) { el.innerHTML = emptyState('Aucune question ne correspond à votre recherche.'); moreButton('#questionsMore', 0, 0); return; }
    el.innerHTML = list.slice(0, state.shown.questions).map((x) => `
        <a href="#/question/${esc(x.uid)}" class="card !p-4 block hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 transition">
            <div class="flex flex-col sm:flex-row justify-between gap-3">
                <div class="space-y-1 min-w-0">
                    <div class="flex flex-wrap items-center gap-2 text-xs">
                        <span class="badge ${QTYPE_BADGE[x.type] || ''}">${esc(x.type)}</span>
                        <span class="text-slate-400 font-mono">n°${esc(x.numero)}</span>
                        <span class="text-slate-500">· ${fmtShort(x.date)}</span>
                        ${x.rubrique ? `<span class="text-slate-500">· ${esc(x.rubrique)}</span>` : ''}
                    </div>
                    <h4 class="font-bold text-sm text-slate-900 dark:text-white">${esc(x.titre || x.rubrique || 'Question')}</h4>
                    <p class="text-xs text-slate-500 dark:text-slate-400">Par <span class="font-semibold text-slate-700 dark:text-slate-300">${esc(x.auteur)}</span>${x.groupe ? ` (${esc(x.groupe)})` : ''} → <span class="font-semibold text-slate-700 dark:text-slate-300">${esc(x.ministere || '—')}</span></p>
                </div>
                <div class="shrink-0"><span class="text-xs px-2.5 py-1 rounded-full font-medium ${x.repondue ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}">${esc(x.statut)}</span></div>
            </div>
        </a>`).join('');
    moreButton('#questionsMore', state.shown.questions, list.length);
}

/* ---------------------------------------------------------------- scrutins */
function renderScrutins() {
    if (isDown('scrutins')) { $('#scrutinsCount').textContent = 'Données indisponibles'; $('#scrutinsList').innerHTML = unavailable(['scrutins'], 'Scrutins'); moreButton('#scrutinsMore', 0, 0); return; }
    const q = tokens($('#scrutinSearch').value);
    const list = state.scrutins.filter((s) => !q.length || matches(HAY.scrutins(s), q));
    const sec = (state.meta && state.meta.sections.scrutins) || {};
    $('#scrutinsCount').textContent = `${fmtNum(list.length)} scrutins affichés sur ${fmtNum(sec.total || 0)} depuis le début de la législature`;
    const el = $('#scrutinsList');
    if (!list.length) { el.innerHTML = emptyState('Aucun scrutin.'); moreButton('#scrutinsMore', 0, 0); return; }
    el.innerHTML = list.slice(0, state.shown.scrutins).map((s) => {
        const adopted = (s.sort || '').startsWith('adopt');
        const tot = Math.max(1, s.pour + s.contre + s.abstention);
        return `<div class="card !p-4 space-y-2">
            <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span class="font-mono">n°${esc(s.numero)}</span><span>· ${fmtDate(s.date)}</span><span>· ${esc(s.type || '')}</span>
                <span class="badge ml-auto ${adopted ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'}">${esc(s.sort)}</span>
            </div>
            <p class="font-semibold text-sm text-slate-900 dark:text-white">${esc(s.titre)}</p>
            <div class="flex h-2.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700" title="Pour ${s.pour} / Contre ${s.contre} / Abstention ${s.abstention}">
                <div class="bg-emerald-500" style="width:${100 * s.pour / tot}%"></div><div class="bg-rose-500" style="width:${100 * s.contre / tot}%"></div><div class="bg-slate-400" style="width:${100 * s.abstention / tot}%"></div>
            </div>
            <div class="flex flex-wrap justify-between gap-2 text-xs">
                <span><b class="text-emerald-600">Pour ${s.pour}</b> · <b class="text-rose-600">Contre ${s.contre}</b> · Abstention ${s.abstention} · Votants ${s.votants}</span>
                <span class="flex gap-3">
                    <button data-toggle="sg-${esc(s.uid)}" class="text-blue-600 dark:text-blue-400 hover:underline">Détail par groupe</button>
                    <a href="${esc(s.url)}" target="_blank" rel="noopener" class="text-blue-600 dark:text-blue-400 hover:underline">Fiche officielle ↗</a>
                </span>
            </div>
            <div id="sg-${esc(s.uid)}" class="hidden overflow-x-auto">
                <table class="w-full text-xs mt-2"><thead><tr class="text-slate-500 text-left"><th class="py-1">Groupe</th><th>Position</th><th>Pour</th><th>Contre</th><th>Abst.</th><th>Membres</th></tr></thead>
                <tbody>${s.groupes.map((g) => `<tr class="border-t border-slate-100 dark:border-slate-700"><td class="py-1">${groupBadge(g.abrev, g.uid)}</td><td>${esc(g.position)}</td><td>${g.pour}</td><td>${g.contre}</td><td>${g.abstention}</td><td>${g.membres}</td></tr>`).join('')}</tbody></table>
            </div>
        </div>`;
    }).join('');
    moreButton('#scrutinsMore', state.shown.scrutins, list.length);
}

/* ---------------------------------------------------------------- recherche transversale */
// Champ de l'en-tête + page #/recherche?q=… ; regroupe députés, lois, questions et scrutins et
// annonce pour chaque groupe son périmètre : archives complètes ou sélection publiée.
const SEARCH_PREVIEW = 5;

function bindSearch() {
    const go = (q, mode) => {
        const hash = q.trim() ? `#/recherche?q=${encodeURIComponent(q.trim())}` : '#/recherche';
        if (hash === location.hash) return;
        // Frappe : la première lettre crée une entrée d'historique, les suivantes la remplacent.
        history[mode === 'push' || lastTab !== 'recherche' ? 'pushState' : 'replaceState'](null, '', hash);
        route();
    };
    ['#globalSearch', '#searchPageInput'].forEach((sel) => {
        const input = $(sel);
        input.addEventListener('input', debounce(() => go(input.value, 'replace'), 250));
        input.form.addEventListener('submit', (e) => { e.preventDefault(); go(input.value, 'push'); input.blur(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') input.blur(); });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || !$('#detailModal').classList.contains('hidden')) return;
        e.preventDefault();
        const header = $('#globalSearch');
        if (header.offsetParent) header.focus(); else location.hash = '#/recherche';
    });
}

const sumTotals = (obj) => Object.entries(obj || {}).filter(([k]) => !k.endsWith('_promulgues')).reduce((a, [, v]) => a + v, 0);
/** Tous les dossiers de la législature sont publiés (défaut du pipeline ; un plafond MAX_DOSSIERS le désactive). */
const dossiersComplets = () => {
    const sec = (state.meta && state.meta.sections && state.meta.sections.dossiers) || {};
    return state.dossiers.length > 0 && state.dossiers.length >= sumTotals(sec.total);
};

function searchGroups() {
    const sec = (state.meta && state.meta.sections) || {};
    return [
        {
            key: 'deputes', title: 'Députés', icon: 'fa-users', items: state.deputes, primary: (d) => `${d.prenom} ${d.nom}`,
            complete: true, empty: 'Aucun député en exercice ne correspond.',
            scope: () => `parmi les ${fmtNum(state.deputes.length)} députés en exercice (liste complète)`,
            render: (d) => `<a href="#/depute/${esc(d.uid)}" class="row-link !p-2.5 flex items-center gap-3">${avatar(d, 'w-9 h-9')}
                <span class="min-w-0"><span class="block font-semibold text-sm text-slate-900 dark:text-white truncate">${esc(d.prenom)} ${esc(d.nom)} ${groupBadge(d.groupe, d.groupeUid)}</span>
                <span class="block text-xs text-slate-500 truncate">${esc(d.departement)} (${esc(d.numDepartement)}) · ${ordinal(d.circo)} circonscription</span></span></a>`,
        },
        {
            key: 'lois', title: 'Lois', icon: 'fa-file-contract', items: state.dossiers, primary: (d) => d.titre,
            complete: dossiersComplets(), empty: 'Aucun dossier de la législature ne correspond.',
            scope: () => (dossiersComplets()
                ? `parmi les ${fmtNum(state.dossiers.length)} dossiers de la législature (liste complète)`
                : `parmi les ${fmtNum(state.dossiers.length)} dossiers publiés, sur ${fmtNum(sumTotals(sec.dossiers && sec.dossiers.total))} dans la législature`),
            render: (d) => `<a href="#/dossier/${esc(d.uid)}" class="row-link !p-2.5">
                <span class="flex flex-wrap items-center gap-2 text-xs text-slate-500">${statusBadge(d.statut, d.etape, d.statutDecision)}<span>${fmtShort(d.dateMaj)}</span></span>
                <span class="block font-semibold text-sm text-slate-900 dark:text-white mt-1 line-clamp-2">${esc(d.titre)}</span></a>`,
        },
        {
            key: 'questions', title: 'Questions', icon: 'fa-comments', items: state.questions, primary: (x) => `${x.titre} ${x.rubrique}`,
            complete: false, scope: () => `parmi les ${fmtNum(state.questions.length)} questions les plus récentes, sur ${fmtNum(sumTotals(sec.questions && sec.questions.total))} posées`,
            render: (x) => `<a href="#/question/${esc(x.uid)}" class="row-link !p-2.5">
                <span class="flex flex-wrap items-center gap-2 text-xs text-slate-500"><span class="badge ${QTYPE_BADGE[x.type] || ''}">${esc(x.type)}</span>${fmtShort(x.date)} · ${esc(x.auteur)} → ${esc(x.ministere || '—')}</span>
                <span class="block font-semibold text-sm text-slate-900 dark:text-white mt-1 line-clamp-2">${esc(x.titre || x.rubrique || 'Question')}</span></a>`,
        },
        {
            key: 'scrutins', title: 'Scrutins', icon: 'fa-check-to-slot', items: state.scrutins, primary: (x) => x.titre,
            complete: false, scope: () => `parmi les ${fmtNum(state.scrutins.length)} derniers scrutins, sur ${fmtNum((sec.scrutins && sec.scrutins.total) || 0)}`,
            render: (x) => `<a href="#/scrutins?q=${esc(x.numero)}" class="row-link !p-2.5">
                <span class="flex flex-wrap items-center gap-2 text-xs text-slate-500">n°${esc(x.numero)} · ${fmtShort(x.date)} · ${esc(x.sort || '')}</span>
                <span class="block font-semibold text-sm text-slate-900 dark:text-white mt-1 line-clamp-2">${esc(x.titre)}</span></a>`,
        },
    ];
}

function renderSearch(q) {
    ['#globalSearch', '#searchPageInput'].forEach((sel) => { if (document.activeElement !== $(sel)) $(sel).value = q; });
    const toks = tokens(q);
    const box = $('#searchResults');
    if (!toks.length || toks.join('').length < 2) {
        $('#searchSummary').textContent = '';
        box.innerHTML = `<div class="col-span-full card text-sm text-slate-500">Tapez au moins deux caractères : votre commune ou code postal (« Bourg-en-Bresse », « 33000 »), un nom (« Panot »), un département (« Gironde », « 33 »), un sujet (« logement », « eau potable »), un ministère…</div>`;
        // Arrivée sur la page de recherche vide (loupe mobile, lien) : curseur dans le champ.
        if (!/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) $('#searchPageInput').focus();
        return;
    }
    if (!state.ready) { box.innerHTML = '<div class="skeleton h-40 col-span-full"></div>'; return; }
    const stillHere = () => lastTab === 'recherche' && (parseHash().params.get('q') || '') === q;
    if (!state.questions.length && !isDown('questions')) loadQuestions().then(() => { if (stillHere()) renderSearch(q); });
    if (!communeRows() && !isDown('communes')) loadCommunes().then(() => { if (stillHere()) renderSearch(q); });
    const communes = renderCommunes(q, toks);
    let total = communes.count;
    box.innerHTML = communes.html + searchGroups().map((g) => {
        const head = `<div class="flex items-center justify-between gap-2"><h3 class="card-title"><i class="fa-solid ${g.icon} text-blue-600"></i>${g.title}</h3>
            <span class="badge ${g.complete ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}"
                title="${g.complete ? 'Tous les éléments sont couverts' : 'Seule une partie des archives est publiée sur ce site'}">${g.complete ? 'Données complètes' : 'Sélection publiée'}</span></div>`;
        if (isDown(g.key)) return `<div class="card space-y-3">${head}${unavailable([g.key], g.title)}</div>`;
        if (g.key === 'questions' && !state.questions.length) return `<div class="card space-y-3">${head}<div class="skeleton h-24"></div></div>`;
        const hits = g.items.map((it, i) => ({ it, i, hay: HAY[g.key](it) })).filter((h) => matches(h.hay, toks));
        // Pertinence : mots trouvés dans le nom / titre d'abord, puis ordre de la liste (le plus récent).
        hits.forEach((h) => { const p = norm(g.primary(h.it)); h.score = toks.filter((t) => p.includes(t)).length; });
        hits.sort((a, b) => b.score - a.score || a.i - b.i);
        total += hits.length;
        const scope = `<p class="text-xs text-slate-500">${fmtNum(hits.length)} résultat(s) ${g.scope()}.</p>`;
        const empty = g.complete
            ? `<p class="text-sm text-slate-500">${esc(g.empty)}</p>`
            : `<p class="text-sm text-slate-500">Aucun résultat dans la sélection publiée. Ce n'est pas une absence dans les archives :
                <a class="text-blue-600 dark:text-blue-400 hover:underline" href="https://data.assemblee-nationale.fr/" target="_blank" rel="noopener">archives complètes ↗</a></p>`;
        return `<div class="card space-y-3">${head}${scope}
            ${hits.length ? `<div class="space-y-2">${hits.slice(0, SEARCH_PREVIEW).map((h) => g.render(h.it)).join('')}</div>` : empty}
            ${hits.length > SEARCH_PREVIEW ? `<a href="#/${g.key}?q=${encodeURIComponent(q.trim())}" class="text-sm text-blue-600 dark:text-blue-400 hover:underline">Voir les ${fmtNum(hits.length)} résultats dans « ${g.title} » →</a>` : ''}
        </div>`;
    }).join('');
    $('#searchSummary').textContent = `${fmtNum(total)} résultat(s) pour « ${q.trim()} »`;
}

/* ---------------------------------------------------------------- « trouver mon député » par commune
 * data/communes.json : [nom, code INSEE, codes postaux, département, [circonscriptions], population], construit à partir
 * des résultats des législatives 2024 par bureau de vote (voir scripts/build_data.py). Chargé à la première recherche. */
let communesLoading = null;
let communesNorm = null;
const COMMUNE_PREVIEW = 3;
const communeRows = () => (state.communes && Array.isArray(state.communes.c) ? state.communes.c : null);

function loadCommunes() {
    if (communesLoading) return communesLoading;
    communesLoading = loadLists(['communes']).then(() => {
        if (isDown('communes')) { communesLoading = null; return; }
        communesNorm = communeRows().map((r) => norm(`${r[0]} ${r[3]}`));
    });
    return communesLoading;
}

function deputeParCirco(dept, circ) {
    if (!state.deputesParCirco || state.deputesParCirco.size === 0) {
        state.deputesParCirco = new Map(state.deputes.map((d) => [`${d.numDepartement}|${d.circo}`, d]));
    }
    return state.deputesParCirco.get(`${dept}|${circ}`);
}

/* ---------------------------------------------------------------- « préciser avec mon adresse »
 * Communes et arrondissements partagés : l'adresse est géocodée par l'API Adresse de l'État, servie par la
 * Géoplateforme de l'IGN (data.geopf.fr ; l'ancien hôte api-adresse.data.gouv.fr est déprécié depuis le 31 janvier 2026)
 * (seul envoi à un tiers,
 * annoncé à côté du bouton et sur la page de confidentialité, à chaque recherche), puis la circonscription est trouvée
 * dans le navigateur (data/circos/<dept>.json, assets/geo.js). « Me localiser » : position de l'appareil, aucun envoi.
 * L'adresse n'est ni stockée ni mise dans l'URL. */
const API_ADRESSE = 'https://data.geopf.fr/geocodage/search';
const LIMITE_PROCHE_M = 100;  // en deçà, le résultat est signalé comme incertain (contours généralisés à ~20 m)

function addressBlock(r) {
    const [nom, insee, cps, dept, circs] = r;
    // Ville entière (Lyon pour « Lyon 7e Arrondissement ») : pour retrouver une voie saisie dans le mauvais arrondissement.
    const ville = (r[6] && ((communeRows() || []).find((x) => x[1] === r[6]) || [])[0]) || nom;
    return `<div data-addr data-insee="${esc(insee)}" data-dept="${esc(dept)}" data-circs="${esc(circs.join(','))}"
            data-cp="${esc((cps || '').split(' ')[0] || '')}" data-nom="${esc(nom)}" data-ville="${esc(ville)}">
        <button type="button" data-addr-open class="btn-secondary !text-xs"><i class="fa-solid fa-location-crosshairs"></i>Préciser avec mon adresse</button>
    </div>`;
}

function addressForm(box) {
    const nom = box.dataset.nom;
    box.innerHTML = `<form data-addr-form class="space-y-2 p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
        <label class="block text-xs font-medium text-slate-700 dark:text-slate-200" for="addr-${esc(box.dataset.insee)}">Votre adresse à ${esc(nom)}</label>
        <div class="flex gap-2">
            <input id="addr-${esc(box.dataset.insee)}" name="adresse" required minlength="3" autocomplete="street-address"
                placeholder="ex. 12 rue de la République" class="input !text-sm">
            <button class="btn-primary whitespace-nowrap">Chercher</button>
        </div>
        <p class="text-[11px] text-slate-500 dark:text-slate-400"><i class="fa-solid fa-shield-halved mr-1"></i>En cliquant sur « Chercher », l'adresse saisie est
            envoyée à l'<strong>API Adresse de l'État</strong> (Géoplateforme de l'IGN, data.geopf.fr) pour être localisée. Ce site ne la conserve pas et ne la transmet
            à personne d'autre. <a class="underline" href="#/mentions">Confidentialité</a></p>
        <button type="button" data-geoloc class="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            <i class="fa-solid fa-location-arrow mr-1"></i>Ou me localiser (calcul sur votre appareil, rien n'est envoyé)</button>
        <div data-addr-result aria-live="polite" class="text-sm"></div>
    </form>`;
    box.querySelector('input').focus();
}

/** Appel à l'API Adresse (seul envoi à un tiers, toujours déclenché par un clic de l'utilisateur). */
async function apiAdresse(params) {
    const p = new URLSearchParams({ limit: '3', autocomplete: '0', ...params });
    const res = await fetch(`${API_ADRESSE}?${p}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`API Adresse : ${res.status}`);
    return (await res.json()).features || [];
}

async function geocode(q, box) {
    const ask = (extra) => apiAdresse({ q, ...extra });
    let f = await ask({ citycode: box.dataset.insee });
    if (!f.length && box.dataset.cp) f = await ask({ postcode: box.dataset.cp });
    return f;
}

/* Voie introuvable là où elle a été cherchée (« 12 rue de la République » dans Lyon 7e : elle est dans le 2e) :
 * on la cherche dans toute la ville `ville` (même service, même clic de l'utilisateur) et, si elle y est, on dit où,
 * au lieu de citer une autre voie (« 12 Rue du Repos »), ce qui laissait croire à une adresse réécrite.
 * `ici` : nom du lieu cherché ; `exclu` : son code INSEE. Renvoie true si l'adresse a été trouvée (et proposée). */
async function voieAilleurs(q, ville, ici, exclu, out) {
    const saisie = q.replace(/\b\d{5}\b/g, ' ').replace(/\b\d{1,2}\s*(?:e|er|eme|ème)?\s+arr(?:ondissement|\.)?\b/gi, ' ');
    const qv = `${saisie} ${ville}`;
    let trouve = null;
    try {
        trouve = (await apiAdresse({ q: qv })).find((f) => f.properties.citycode !== exclu
            && window.ANGeo.assessGeocode(f.properties, qv, false).verdict === 'ok'
            && window.ANGeo.matchAddress(f.properties, saisie).ok) || null;
    } catch (e) { /* service indisponible : l'appelant affiche son message */ }
    if (!trouve) return false;
    const pr = trouve.properties;
    out.innerHTML = `<div class="mt-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-2">
        <p class="text-xs text-amber-800 dark:text-amber-200"><i class="fa-solid fa-circle-info mr-1"></i>La voie saisie n'existe pas à
            ${esc(ici)}. Cette adresse se trouve à <strong>${esc(pr.district || pr.city || '')}</strong> :</p>
        <button type="button" data-pick class="btn-secondary !text-xs !justify-start text-left"><i class="fa-solid fa-location-dot"></i>${esc(pr.label)} — voir son député</button>
    </div>`;
    const b = out.querySelector('[data-pick]');
    b.addEventListener('click', () => showAddress(trouve, qv, out));
    b.focus();
    return true;
}

/** Aucun candidat sûr ne porte la voie saisie (les autres écarts — numéro, code postal — se confirment). */
const voieAbsente = (feats, q) => !feats.some((f) => window.ANGeo.assessGeocode(f.properties, q, false).verdict === 'ok'
    && window.ANGeo.matchAddress(f.properties, q).raison !== 'voie');

/* Confirmation de l'adresse trouvée. Le géocodeur renvoie toujours « la plus proche » : dans Lyon 7e,
 * « 12 rue de la République » (2e arrondissement) devient « 12 Rue du Repos ». Si la voie ou le numéro trouvés
 * diffèrent de la saisie (ANGeo.matchAddress), les candidats sont proposés et rien n'est affiché sans un clic ;
 * sinon le résultat s'affiche directement, adresse reconnue en tête. Candidats sous le seuil de score : refusés. */
function chooseAddress(out, q, feats, pick, refuse, verifierCommune = false) {
    const sure = feats.filter((f) => window.ANGeo.assessGeocode(f.properties, q, false).verdict === 'ok');
    if (!sure.length) return refuse(feats[0] || null);
    // verifierCommune (formulaire global) : la commune trouvée doit figurer dans la saisie (« 12 rue de la paix » → Cherbourg).
    const m = sure.map((f) => {
        const r = window.ANGeo.matchAddress(f.properties, q);
        return { f, m: r.ok && verifierCommune && window.ANGeo.assessGeocode(f.properties, q, false).autreCommune ? { ok: false, raison: 'commune' } : r };
    });
    if (m[0].m.ok) return pick(sure[0], false);
    const cands = [...m.filter((x) => x.m.ok), ...m.filter((x) => !x.m.ok)].map((x) => x.f);  // les concordantes d'abord
    out.innerHTML = `<div class="mt-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-2">
        <p class="text-xs text-amber-800 dark:text-amber-200"><i class="fa-solid fa-circle-question mr-1"></i>${m[0].m.raison === 'numero'
            ? 'Ce numéro n\'a pas été trouvé : la position serait celle de la voie, pas de votre numéro.'
            : m[0].m.raison === 'codePostal' ? 'L\'adresse trouvée n\'a pas le code postal saisi.'
            : m[0].m.raison === 'commune' ? 'Votre saisie ne précise pas la commune : plusieurs adresses sont possibles.'
            : 'L\'adresse trouvée ne correspond pas exactement à votre saisie.'} Confirmez votre adresse avant d'afficher le député :</p>
        <div class="flex flex-col gap-1.5">${cands.map((f, i) => `<button type="button" data-pick="${i}"
            class="btn-secondary !text-xs !justify-start text-left"><i class="fa-solid fa-location-dot"></i>${esc(f.properties.label)}</button>`).join('')}</div>
        <p class="text-[11px] text-slate-500">Aucune ne correspond ? Corrigez l'adresse (numéro, voie, commune) et relancez la recherche.</p>
    </div>`;
    out.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pick(cands[Number(b.dataset.pick)], true)));
    out.querySelector('[data-pick]').focus();
}

async function locate(box, lon, lat, label) {
    const out = box.querySelector('[data-addr-result]');
    const circs = box.dataset.circs.split(',').map(Number);
    let fc;
    try { fc = await getJSON(`circos/${box.dataset.dept}.json`); } catch (e) {
        out.innerHTML = `<p class="text-rose-600 text-xs">Contours des circonscriptions indisponibles (${esc(e.message)}). La carte électorale indique votre circonscription.</p>`;
        return;
    }
    const hit = window.ANGeo.findCirco(fc.features || [], lon, lat, circs);
    const card = box.closest('.p-3');
    card.querySelectorAll('[data-circ]').forEach((el) => el.classList.remove('ring-2', 'ring-emerald-500'));
    if (!hit) {
        out.innerHTML = `<p class="text-xs text-amber-700 dark:text-amber-300 mt-2">${label
            ? `« ${esc(label)} » n'est dans aucune des circonscriptions de ${esc(box.dataset.nom)}. Vérifiez l'adresse, ou consultez votre carte électorale.`
            : `Vous ne semblez pas vous trouver à ${esc(box.dataset.nom)} : « Me localiser » ne sert que sur place. Saisissez plutôt votre adresse.`}</p>`;
        return;
    }
    const target = card.querySelector(`[data-circ="${hit.circo}"]`);
    if (target) target.classList.add('ring-2', 'ring-emerald-500');
    const d = deputeParCirco(box.dataset.dept, String(hit.circo));
    const proche = hit.distanceM < LIMITE_PROCHE_M;
    out.innerHTML = `<div class="mt-2 p-2 rounded-lg ${proche ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-emerald-50 dark:bg-emerald-900/20'} space-y-1">
        ${label ? `<p class="text-xs text-slate-500">Adresse reconnue : <strong class="text-slate-700 dark:text-slate-200">${esc(label)}</strong></p>` : ''}
        <p><i class="fa-solid fa-check text-emerald-600 mr-1"></i>${ordinal(hit.circo)} circonscription${d ? ` — <a class="font-semibold underline" href="#/depute/${esc(d.uid)}">${esc(d.prenom)} ${esc(d.nom)}</a>` : ''}</p>
        ${proche ? `<p class="text-xs text-amber-800 dark:text-amber-200"><i class="fa-solid fa-triangle-exclamation mr-1"></i>À environ ${Math.round(hit.distanceM)} m d'une limite
            de circonscription : les contours utilisés sont approximatifs. Vérifiez sur votre carte électorale.</p>` : ''}
        <p class="text-[11px] text-slate-500">Résultat indicatif, calculé à partir des contours publiés en 2024 ; la carte électorale fait foi.</p>
    </div>`;
}

/* « Trouver mon député par adresse » (page Députés et page de recherche) : n'importe quelle adresse en France.
 * Commune à circonscription unique : réponse par la table des communes ; commune partagée ou non rattachée :
 * calcul dans les contours du département. Même consentement que « Préciser avec mon adresse ». */
function globalAddressForm(i) {
    return `<form data-gaddr-form class="space-y-2 p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
        <label for="gaddr-${i}" class="block text-sm font-semibold text-slate-800 dark:text-slate-100"><i class="fa-solid fa-house mr-1 text-blue-600"></i>Trouver mon député par adresse</label>
        <div class="flex flex-col sm:flex-row gap-2">
            <input id="gaddr-${i}" name="adresse" required minlength="5" autocomplete="street-address"
                placeholder="Adresse complète (ex. 12 rue de la République, Lyon)" class="input !text-sm">
            <button class="btn-primary whitespace-nowrap">Chercher par adresse</button>
        </div>
        <p class="text-[11px] text-slate-500 dark:text-slate-400"><i class="fa-solid fa-shield-halved mr-1"></i>En cliquant sur « Chercher par adresse », l'adresse
            saisie est envoyée à l'<strong>API Adresse de l'État</strong> (Géoplateforme de l'IGN, data.geopf.fr) pour être localisée ; la circonscription est ensuite trouvée
            sur votre appareil. Ce site ne conserve pas l'adresse. Sans envoi : utilisez la recherche par commune ou code postal. <a class="underline" href="#/mentions">Confidentialité</a></p>
        <div data-gaddr-result aria-live="polite" class="text-sm"></div>
    </form>`;
}

const deptFromInsee = (code) => (/^97/.test(code) ? code.slice(0, 3) : code.slice(0, 2));

const adresseIncertaine = (label) => `<p class="text-xs text-amber-700 dark:text-amber-300">Adresse non reconnue${label
    ? ` (le service ne propose qu'une autre adresse, « ${esc(label)} », écartée)` : ''}. Vérifiez le numéro, la voie et la commune, ou utilisez la recherche par commune.
    Wallis-et-Futuna et les adresses à l'étranger ne sont pas couverts par la recherche par adresse.</p>`;

async function resolveAddress(q, out) {
    out.innerHTML = '<p class="text-xs text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Recherche de l\'adresse…</p>';
    let feats;
    try {
        feats = await apiAdresse({ q });
    } catch (err) {
        out.innerHTML = `<p class="text-xs text-rose-600">Service de localisation indisponible (${esc(err.message)}). Utilisez la recherche par commune ou code postal.</p>`;
        return;
    }
    if (!feats.length) {
        out.innerHTML = '<p class="text-xs text-amber-700 dark:text-amber-300">Adresse introuvable. Indiquez le numéro, la voie et la commune, ou utilisez la recherche par commune.</p>';
        return;
    }
    await loadCommunes();
    if (voieAbsente(feats, q)) {
        const pr = feats[0].properties;
        if (pr.city && await voieAilleurs(q, pr.city, pr.district || pr.city, pr.citycode, out)) return;
    }
    chooseAddress(out, q, feats, (f, confirme) => showAddress(f, confirme ? `${q} ${f.properties.city || ''}` : q, out),
        (f) => { out.innerHTML = adresseIncertaine(f && f.properties.label); }, true);
}

/** Député de l'adresse confirmée `f` (feature du géocodeur) ; `q` = saisie. */
async function showAddress(f, q, out) {
    const { label, citycode, city } = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    const rows = communeRows() || [];
    const row = rows.find((r) => r[1] === citycode);
    const orphan = !row && ((state.communes && state.communes.nonRattachees) || []).find((r) => r[1] === citycode);
    const sansElec = !row && ((state.communes && state.communes.sansElecteurs) || []).find((r) => r[1] === citycode);
    if (sansElec) {
        out.innerHTML = `<p class="text-xs text-amber-700 dark:text-amber-300">« ${esc(label || q)} » : ${esc(sansElec[0])} est un territoire sans électeurs
            (village détruit en 1916 ou territoire inhabité), sans bureau de vote ni député à afficher.</p>`;
        return;
    }
    const dept = row ? row[3] : orphan ? orphan[3] : deptFromInsee(String(citycode || ''));
    const { verdict, autreCommune } = window.ANGeo.assessGeocode(f.properties, q, !(row && row[4].length === 1));
    if (verdict !== 'ok') {
        out.innerHTML = `<p class="text-xs text-amber-700 dark:text-amber-300">${verdict === 'commune'
            ? `Seule la commune a été reconnue (${esc(city || label)}). ${row
                ? `Elle compte plusieurs circonscriptions : indiquez le numéro et le nom de la voie,
                   ou <a class="underline" href="#/recherche?q=${encodeURIComponent(citycode || city || '')}">voyez les députés de la commune</a>.`
                : 'Sa circonscription n\'est connue qu\'à l\'adresse (commune créée ou modifiée depuis 2024) : indiquez le numéro et le nom de la voie.'}`
            : ''}</p>`;
        if (verdict === 'incertain') out.innerHTML = adresseIncertaine(label);
        return;
    }
    let circ = null, dist = null, source = '';
    if (row && row[4].length === 1) {
        circ = row[4][0];
        source = 'commune entièrement comprise dans cette circonscription';
    } else {
        try {
            const fc = await getJSON(`circos/${dept}.json`);
            const hit = window.ANGeo.findCirco(fc.features || [], lon, lat, row ? row[4] : undefined);
            if (hit) { circ = hit.circo; dist = hit.distanceM; source = 'calcul à partir des contours de circonscription de 2024'; }
        } catch (e) { /* contours absents : message ci-dessous */ }
    }
    const reconnue = `<p class="text-xs text-slate-500">Adresse reconnue : <strong class="text-slate-700 dark:text-slate-200">${esc(label || q)}</strong></p>`
        + (autreCommune ? `<p class="text-xs text-amber-800 dark:text-amber-200"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Ce n'est pas la commune
            voulue ? Ajoutez la commune ou le code postal à votre saisie.</p>` : '');
    if (circ === null) {
        out.innerHTML = `<div class="mt-2 space-y-1">${reconnue}<p class="text-xs text-amber-700 dark:text-amber-300">Circonscription non déterminée pour cette adresse${city ? ` (${esc(city)})` : ''}.
            <a class="underline" href="#/recherche?q=${encodeURIComponent(citycode || city || '')}">Voir la commune</a> ou consultez votre carte électorale.</p></div>`;
        return;
    }
    const d = deputeParCirco(dept, String(circ));
    const proche = dist !== null && dist < LIMITE_PROCHE_M;
    out.innerHTML = `<div class="mt-2 p-3 rounded-lg ${proche ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-emerald-50 dark:bg-emerald-900/20'} space-y-2">
        ${reconnue}
        ${d ? `<a href="#/depute/${esc(d.uid)}" class="row-link !p-2 flex items-center gap-3 bg-white dark:bg-slate-800">${avatar(d, 'w-10 h-10')}
            <span class="min-w-0"><span class="block font-semibold text-slate-900 dark:text-white">${esc(d.prenom)} ${esc(d.nom)} ${groupBadge(d.groupe, d.groupeUid)}</span>
            <span class="block text-xs text-slate-500">${esc(d.departement)} · ${ordinal(circ)} circonscription</span></span></a>`
        : `<p>${ordinal(circ)} circonscription (${esc(dept)}) : siège vacant ou député introuvable dans les données.</p>`}
        ${proche ? `<p class="text-xs text-amber-800 dark:text-amber-200"><i class="fa-solid fa-triangle-exclamation mr-1"></i>À environ ${Math.round(dist)} m d'une limite
            de circonscription : les contours utilisés sont approximatifs. Vérifiez sur votre carte électorale.</p>` : ''}
        <p class="text-[11px] text-slate-500">Résultat indicatif (${esc(source)}) ; la carte électorale fait foi.</p>
    </div>`;
}

function bindAddress() {
    document.querySelectorAll('[data-global-addr]').forEach((el, i) => { el.innerHTML = globalAddressForm(i); });
    document.addEventListener('click', (e) => {
        const open = e.target.closest('[data-addr-open]');
        if (open) { addressForm(open.closest('[data-addr]')); return; }
        const geo = e.target.closest('[data-geoloc]');
        if (!geo) return;
        const box = geo.closest('[data-addr]');
        const out = box.querySelector('[data-addr-result]');
        if (!navigator.geolocation) { out.innerHTML = '<p class="text-xs text-rose-600">Géolocalisation non disponible dans ce navigateur.</p>'; return; }
        out.innerHTML = '<p class="text-xs text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Localisation…</p>';
        navigator.geolocation.getCurrentPosition(
            (pos) => locate(box, pos.coords.longitude, pos.coords.latitude, null),
            (err) => { out.innerHTML = `<p class="text-xs text-rose-600">Position indisponible (${esc(err.message || 'refusée')}).</p>`; },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });  // position fraîche, jamais une position en cache
    });
    document.addEventListener('submit', async (e) => {
        const gform = e.target.closest('[data-gaddr-form]');
        if (gform) {
            e.preventDefault();
            await resolveAddress(gform.adresse.value.trim(), gform.querySelector('[data-gaddr-result]'));
            return;
        }
        const form = e.target.closest('[data-addr-form]');
        if (!form) return;
        e.preventDefault();
        const box = form.closest('[data-addr]');
        const out = box.querySelector('[data-addr-result]');
        const q = form.adresse.value.trim();
        out.innerHTML = '<p class="text-xs text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Recherche de l\'adresse…</p>';
        try {
            const feats = await geocode(q, box);
            const ailleurs = () => voieAilleurs(q, box.dataset.ville || box.dataset.nom, box.dataset.nom, box.dataset.insee, out);
            const refuse = async () => {
                if (await ailleurs()) return;
                out.innerHTML = `<p class="text-xs text-amber-700 dark:text-amber-300">Aucune adresse « ${esc(q)} » trouvée à ${esc(box.dataset.nom)}.
                    Vérifiez le numéro et l'orthographe de la voie ; si vous n'êtes pas sûr de la commune ou de l'arrondissement, utilisez
                    « Trouver mon député par adresse » (pages Députés et Recherche).</p>`;
            };
            const pick = (f) => {
                if (window.ANGeo.assessGeocode(f.properties, q, true).verdict === 'commune') {
                    out.innerHTML = `<p class="text-xs text-amber-700 dark:text-amber-300">Seule la commune a été reconnue : indiquez le numéro et le nom de la voie à ${esc(box.dataset.nom)}.</p>`;
                    return;
                }
                const [lon, lat] = f.geometry.coordinates;
                return locate(box, lon, lat, f.properties.label);
            };
            if (!feats.length) { await refuse(); return; }
            // Aucun candidat de la commune ne correspond à la voie saisie (« 8 rue Victor Hugo » dans Lyon 7e → « Victor
            // Lagrange ») : la voie est peut-être ailleurs dans la ville ; sinon, confirmation parmi les candidats.
            if (voieAbsente(feats, q) && await ailleurs()) return;
            chooseAddress(out, q, feats, pick, refuse);
        } catch (err) {
            out.innerHTML = `<p class="text-xs text-rose-600">Service de localisation indisponible (${esc(err.message)}). Réessayez plus tard, ou consultez votre carte électorale.</p>`;
        }
    });
}

/** Couverture de la table : { total, ok, non } (communes actuelles hors arrondissements), ou null si inconnue. */
function communeCoverage() {
    const c = state.communes && state.communes.couverture;
    if (c) return { total: c.communes, ok: c.rattachees, non: c.nonRattachees };
    const m = state.meta && state.meta.sections.communes;  // table d'un format antérieur : seulement le nombre
    const rows = communeRows();
    if (!m || !rows) return null;
    const non = m.communesSansCorrespondance || 0;
    return { total: rows.length + non, ok: rows.length, non };
}

/** Limites de la recherche par commune, visibles (pas seulement en infobulle) et dépliables. */
function communeLimits(cov) {
    const list = (state.communes && state.communes.nonRattachees) || [];
    const vacants = (state.meta && state.meta.sections.communes && state.meta.sections.communes.circonscriptionsSansDepute) || 0;
    const items = [];
    if (cov && cov.non) {
        items.push(`<li><strong>${fmtNum(cov.non)} commune(s) sur ${fmtNum(cov.total)} sans circonscription connue</strong> : créées ou modifiées après les
            législatives de juin 2024 (source du rattachement), dans un département à plusieurs circonscriptions. Elles ne sont pas devinées.
            ${list.length ? `<span class="block mt-1 text-slate-500">${list.map((r) => `${esc(r[0])} (${esc(r[3])})`).join(' · ')}</span>` : ''}</li>`);
    }
    const sansElec = (state.communes && state.communes.sansElecteurs) || [];
    if (sansElec.length) {
        items.push(`<li><strong>${fmtNum(sansElec.length)} territoire(s) sans électeurs</strong>, hors du calcul de couverture : villages détruits
            en 1916 (Meuse), Terres australes et antarctiques, Clipperton. Sans électeurs, ils n'ont pas de bureau de vote.
            <span class="block mt-1 text-slate-500">${sansElec.map((r) => `${esc(r[0])} (${esc(r[3])})`).join(' · ')}</span></li>`);
    }
    items.push('<li><strong>Communes et arrondissements partagés</strong> entre plusieurs circonscriptions : tous les députés concernés sont affichés ; la bonne circonscription figure sur la carte électorale.</li>');
    if (vacants) items.push(`<li><strong>${fmtNum(vacants)} circonscription(s) sans député en exercice</strong> (siège vacant) : signalées dans les résultats.</li>`);
    items.push('<li>Rattachement calculé à partir des résultats officiels des législatives 2024 par bureau de vote (ministère de l\'Intérieur) ; noms et codes postaux : API Découpage administratif.</li>');
    return `<details class="text-xs text-slate-600 dark:text-slate-300 border-t border-slate-200 dark:border-slate-700 pt-2">
        <summary class="cursor-pointer font-medium text-slate-700 dark:text-slate-200">Limites de la couverture${cov && cov.non ? ` · ${fmtNum(cov.non)} commune(s) non rattachée(s)` : ''}</summary>
        <ul class="list-disc pl-5 mt-2 space-y-1">${items.join('')}</ul></details>`;
}

function renderCommunes(q, toks) {
    const code = q.trim().replace(/\s+/g, '').toUpperCase();
    const isCode = /^(\d{5}|2[AB]\d{3})$/.test(code);
    const rows = communeRows();
    const cov = communeCoverage();
    const badge = !cov ? ''
        // Arrondi par défaut : jamais « 100 % » tant qu'une commune manque.
        : cov.non ? `<span class="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Couverture ${pct((Math.floor(1000 * cov.ok / cov.total) / 10).toFixed(1))} des communes</span>`
            : '<span class="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Toutes les communes couvertes</span>';
    const wrap = (inner) => `<div class="col-span-full card space-y-3 border-blue-200 dark:border-blue-900">
        <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="card-title"><i class="fa-solid fa-location-dot text-blue-600"></i>Votre député par commune</h3>${badge}</div>
        ${inner}${rows ? communeLimits(cov) : ''}</div>`;
    if (!rows) {
        if (!isCode) return { html: '', count: 0 };  // texte libre : on n'affiche rien tant que la table n'est pas là
        return { html: wrap(isDown('communes') ? unavailable(['communes'], 'Communes') : '<div class="skeleton h-16"></div>'), count: 0 };
    }
    let hits;
    if (isCode) {
        hits = rows.filter((r) => r[1] === code || r[2].split(' ').includes(code));
    } else {
        if (toks.join('').length < 3) return { html: '', count: 0 };
        const exact = norm(q.trim());
        hits = rows.map((r, i) => ({ r, n: communesNorm[i] })).filter((h) => matches(h.n, toks))
            .map((h) => ({ r: h.r, rank: norm(h.r[0]) === exact ? 0 : norm(h.r[0]).startsWith(exact) ? 1 : 2 }))
            .sort((a, b) => a.rank - b.rank || b.r[5] - a.r[5]).map((h) => h.r);
    }
    // Paris, Lyon, Marseille : la ville (toutes ses circonscriptions) s'efface derrière ses arrondissements quand
    // l'un d'eux correspond (code postal 75011) ; affichée seule, elle propose de choisir l'arrondissement.
    const hitCodes = new Set(hits.map((r) => r[1]));
    if (isCode) {
        const villes = new Set(hits.filter((r) => r[6]).map((r) => r[6]));  // « 75011 » : l'arrondissement, pas la ville
        hits = hits.filter((r) => !villes.has(r[1]));
    } else {
        hits = hits.filter((r) => !(r[6] && hitCodes.has(r[6])));          // « Paris » : la ville, qui propose ses arrondissements
    }
    const parentsAffiches = new Set(hits.filter((r) => rows.some((x) => x[6] === r[1])).map((r) => r[1]));
    // Communes actuelles connues mais sans circonscription (créées ou modifiées après juin 2024) : le dire.
    const matchOrphan = (r) => (isCode
        ? r[1] === code || r[2].split(' ').includes(code)
        : toks.join('').length >= 3 && matches(norm(`${r[0]} ${r[3]}`), toks));
    const sansElecSet = new Set();
    const orphans = [
        ...(state.communes.nonRattachees || []).filter(matchOrphan),
        ...(state.communes.sansElecteurs || []).filter(matchOrphan).map((r) => (sansElecSet.add(r), r)),
    ];
    const orphanHtml = orphans.slice(0, COMMUNE_PREVIEW).map((r) => `<div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-1 text-sm">
        <p><span class="font-bold text-slate-900 dark:text-white">${esc(r[0])}</span> <span class="text-slate-500">· département ${esc(r[3])}${r[2] ? ` · ${esc(r[2])}` : ''}</span></p>
        <p class="text-xs text-amber-800 dark:text-amber-200">${sansElecSet.has(r)
            ? 'Territoire sans électeurs (village détruit en 1916 ou territoire inhabité) : aucun bureau de vote, donc pas de député à afficher.'
            : `Circonscription inconnue de ce site : la commune a été créée ou modifiée après les législatives de juin 2024,
        dans un département qui compte plusieurs circonscriptions. Utilisez « Trouver mon député par adresse », ou votre carte électorale.
        <a class="text-blue-600 dark:text-blue-400 hover:underline" href="#/deputes?q=${encodeURIComponent(r[3])}">Voir les députés du département →</a>`}</p></div>`).join('');
    if (!hits.length) {
        if (orphanHtml) return { html: wrap(orphanHtml), count: orphans.length };
        return isCode ? { html: wrap(`<p class="text-sm text-slate-500">Aucune commune pour le code « ${esc(code)} ».</p>`), count: 0 } : { html: '', count: 0 };
    }
    const villeCard = (r) => {
        const arr = rows.filter((x) => x[6] === r[1]).sort((a, b) => a[1].localeCompare(b[1]));
        const label = (x) => { const n = Number(x[1]) - Number(arr[0][1]) + 1; return n === 1 ? '1<sup>er</sup>' : `${n}<sup>e</sup>`; };
        return `<div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-700/40 border border-slate-200/60 dark:border-slate-700 space-y-2">
            <p class="text-sm"><span class="font-bold text-slate-900 dark:text-white">${esc(r[0])}</span>
                <span class="text-slate-500">· ${r[4].length} circonscriptions</span></p>
            <p class="text-xs text-slate-600 dark:text-slate-300">Choisissez votre arrondissement (ou tapez votre code postal) :</p>
            <div class="flex flex-wrap gap-1.5">${arr.map((x) => `<a href="#/recherche?q=${encodeURIComponent(x[1])}" class="chip !px-2.5 !py-1 text-xs"
                title="${esc(x[0])} · ${esc(x[2])}">${label(x)}</a>`).join('')}</div>
        </div>`;
    };
    const card = (r) => {
        if (parentsAffiches.has(r[1])) return villeCard(r);
        const [nom, , cps, dept, circs] = r;
        const deps = circs.map((c) => ({ c, d: deputeParCirco(dept, String(c)) }));
        const deptNom = (deps.find((x) => x.d) || {}).d?.departement || dept;
        return `<div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-700/40 border border-slate-200/60 dark:border-slate-700 space-y-2">
            <p class="text-sm"><span class="font-bold text-slate-900 dark:text-white">${esc(nom)}</span>
                <span class="text-slate-500">· ${esc(deptNom)} (${esc(dept)})${cps ? ` · ${esc(cps)}` : ''}</span></p>
            ${circs.length > 1 ? `<p class="text-xs text-amber-700 dark:text-amber-300"><i class="fa-solid fa-circle-info mr-1"></i>${r[6] ? 'Arrondissement partagé' : 'Commune partagée'} entre ${circs.length} circonscriptions : la vôtre figure sur votre carte électorale.</p>` : ''}
            <div class="grid sm:grid-cols-2 gap-2" data-circ-list>${deps.map(({ c, d }) => (d
        ? `<a href="#/depute/${esc(d.uid)}" data-circ="${esc(c)}" class="row-link !p-2 flex items-center gap-3 bg-white dark:bg-slate-800">${avatar(d, 'w-9 h-9')}
                <span class="min-w-0"><span class="block font-semibold text-sm text-slate-900 dark:text-white truncate">${esc(d.prenom)} ${esc(d.nom)} ${groupBadge(d.groupe, d.groupeUid)}</span>
                <span class="block text-xs text-slate-500">${ordinal(c)} circonscription</span></span></a>`
        : `<p data-circ="${esc(c)}" class="text-xs text-slate-500 p-2">${ordinal(c)} circonscription : siège vacant ou député introuvable dans les données.</p>`)).join('')}</div>
            ${circs.length > 1 ? addressBlock(r) : ''}
        </div>`;
    };
    const more = hits.length > COMMUNE_PREVIEW
        ? `<p class="text-xs text-slate-500">${fmtNum(hits.length)} communes correspondent : précisez avec le code postal ou le département (ex. « Saint-Denis 93 »).</p>` : '';
    const scope = `<p class="text-xs text-slate-500">${fmtNum(hits.length)} commune(s) parmi ${fmtNum(rows.length)} — circonscriptions des législatives de 2024, découpage en vigueur.</p>`;
    // Une commune non rattachée peut partager un code postal ou un nom avec des communes rattachées : l'afficher aussi.
    return { html: wrap(scope + hits.slice(0, COMMUNE_PREVIEW).map(card).join('') + more + orphanHtml), count: hits.length + orphans.length };
}

/* ---------------------------------------------------------------- suivis (localStorage)
 * Dossiers et députés suivis, gardés dans ce navigateur uniquement. Pour un dossier, on mémorise l'état « vu »
 * (dernière étape accomplie, statut, étape, prochaine date) et on signale ce qui a changé depuis. */
const FOLLOW_KEY = 'suivis.v1';
let storageOk = true;

function readFollows() {
    try {
        const f = JSON.parse(localStorage.getItem(FOLLOW_KEY) || '{}');
        return { dossiers: f.dossiers || {}, deputes: f.deputes || {} };
    } catch (e) { storageOk = false; return { dossiers: {}, deputes: {} }; }
}
function writeFollows() {
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(state.follows)); storageOk = true; } catch (e) { storageOk = false; }
}
state.follows = readFollows();

const snapshot = (d) => ({ dateMaj: d.dateMaj || null, statut: d.statut || null, etape: d.etape || null,
    prochaine: (d.prochaineEtape && d.prochaineEtape.date) || null, derniereEtape: d.derniereEtape || null });

/** Changements d'un dossier suivi depuis la dernière consultation ; null s'il n'est plus publié. */
function dossierChanges(uid) {
    const f = state.follows.dossiers[uid];
    const cur = state.dossiers.find((d) => d.uid === uid);
    if (!cur) return null;
    const a = f.vu || {}, b = snapshot(cur), out = [];
    if (a.statut !== b.statut) out.push(`Statut : ${a.statut || '—'} → ${b.statut || '—'}`);
    if (a.dateMaj !== b.dateMaj) out.push(`Nouvelle étape le ${fmtShort(b.dateMaj)} : ${b.derniereEtape || ''}`);
    if (a.prochaine !== b.prochaine) out.push(b.prochaine ? `Prochaine étape prévue le ${fmtShort(b.prochaine)}` : 'Plus d\'étape programmée');
    return out;
}

function followStats() {
    const ids = Object.keys(state.follows.dossiers);
    const changed = state.ready ? ids.filter((u) => { const c = dossierChanges(u); return c && c.length; }) : [];
    const gone = state.ready && !isDown('dossiers') ? ids.filter((u) => dossierChanges(u) === null) : [];
    return { total: ids.length + Object.keys(state.follows.deputes).length, changed, gone };
}

function followButton(kind, uid) {
    const on = kind === 'dossier' ? !!state.follows.dossiers[uid] : !!state.follows.deputes[uid];
    const label = kind === 'dossier' ? (on ? 'Dossier suivi' : 'Suivre ce dossier') : (on ? 'Député suivi' : 'Suivre ce député');
    return `<button data-follow="${kind}:${esc(uid)}" aria-pressed="${on}" class="${on ? 'btn-primary !bg-amber-500 hover:!bg-amber-600' : 'btn-secondary'}"
        title="${on ? 'Cliquer pour ne plus suivre' : 'Enregistré dans ce navigateur uniquement'}"><i class="fa-${on ? 'solid' : 'regular'} fa-star"></i>${label}</button>`;
}

function toggleFollow(kind, uid) {
    const d = state.detail && state.detail.data && state.detail.data.uid === uid ? state.detail.data : null;
    if (kind === 'dossier') {
        if (state.follows.dossiers[uid]) delete state.follows.dossiers[uid];
        else {
            const src = d || state.dossiers.find((x) => x.uid === uid) || {};
            state.follows.dossiers[uid] = { titre: src.titre, url: src.liens && src.liens.an, ajoute: new Date().toISOString().slice(0, 10), vu: snapshot(src) };
        }
    } else if (state.follows.deputes[uid]) delete state.follows.deputes[uid];
    else {
        const src = d || state.deputes.find((x) => x.uid === uid) || {};
        state.follows.deputes[uid] = { nom: `${src.prenom || ''} ${src.nom || ''}`.trim(), ajoute: new Date().toISOString().slice(0, 10) };
    }
    writeFollows();
    if (!storageOk) showGlobalError('Votre navigateur refuse le stockage local (navigation privée ?) : les suivis ne seront pas conservés.');
    document.querySelectorAll(`[data-follow="${kind}:${CSS.escape(uid)}"]`).forEach((b) => { b.outerHTML = followButton(kind, uid); });
    refreshFollowViews();
}

function markSeen(d) {
    const f = state.follows.dossiers[d.uid];
    if (!f) return;
    f.vu = snapshot(d);
    f.titre = d.titre || f.titre;
    if (d.liens && d.liens.an) f.url = d.liens.an;
    writeFollows();
    refreshFollowViews();
}

function refreshFollowViews() {
    renderFollowsBadge();
    if (state.meta) renderDashboardFollows();
    if (lastTab === 'suivis') renderFollows();
}

function renderFollowsBadge() {
    const s = followStats();
    const n = s.changed.length + s.gone.length;
    const badge = $('#followsBadge');
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.toggle('hidden', !n);
    $('#followsLink').title = n ? `Vos suivis — ${n} changement(s)` : `Vos suivis (${s.total})`;
}

function renderDashboardFollows() {
    const s = followStats();
    const n = s.changed.length + s.gone.length;
    $('#dashFollows').innerHTML = n ? `<a href="#/suivis" class="card !p-4 flex items-center gap-3 border-amber-300 dark:border-amber-700 hover:shadow-md">
        <i class="fa-solid fa-star text-amber-500 text-xl"></i>
        <span class="text-sm">Vos suivis : ${[
        s.changed.length ? `<strong>${fmtNum(s.changed.length)} dossier(s) ont changé</strong> depuis votre dernière visite` : '',
        s.gone.length ? `<strong>${fmtNum(s.gone.length)}</strong> ne sont plus dans la sélection publiée` : '',
    ].filter(Boolean).join(' · ')}.</span>
        <span class="ml-auto text-sm text-blue-600 dark:text-blue-400">Voir →</span></a>` : '';
}

function renderFollows() {
    const box = $('#followsContent');
    const deps = Object.entries(state.follows.deputes);
    const dos = Object.entries(state.follows.dossiers);
    if (!deps.length && !dos.length) {
        box.innerHTML = `<div class="card text-sm text-slate-500 space-y-2"><p>Vous ne suivez encore rien.</p>
            <p>Ouvrez la fiche d'un député ou d'un dossier de loi et cliquez sur <strong>« Suivre »</strong>. Pour un dossier, le site vous signalera ici
            une nouvelle étape, un changement de statut ou une date programmée.</p>
            <p><a class="text-blue-600 dark:text-blue-400 hover:underline" href="#/deputes">Trouver mon député</a> · <a class="text-blue-600 dark:text-blue-400 hover:underline" href="#/lois">Parcourir les lois</a></p></div>`;
        return;
    }
    if (!state.ready) { box.innerHTML = '<div class="skeleton h-32"></div>'; return; }
    const depHtml = deps.map(([uid, f]) => {
        const d = state.deputes.find((x) => x.uid === uid);
        if (!d) return `<div class="row-link !p-2.5 text-sm"><strong>${esc(f.nom || uid)}</strong> <span class="text-slate-500">— n'est plus député en exercice (ou données indisponibles).</span>
            <button data-unfollow="depute:${esc(uid)}" class="ml-2 text-xs text-rose-600 hover:underline">Retirer</button></div>`;
        return `<div class="flex items-center gap-2"><a href="#/depute/${esc(uid)}" class="row-link !p-2.5 flex-1 flex items-center gap-3">${avatar(d, 'w-9 h-9')}
            <span class="min-w-0"><span class="block font-semibold text-sm text-slate-900 dark:text-white truncate">${esc(d.prenom)} ${esc(d.nom)} ${groupBadge(d.groupe, d.groupeUid)}</span>
            <span class="block text-xs text-slate-500">${esc(d.departement)} · ${ordinal(d.circo)} circonscription${d.participation != null ? ` · participation ${pct(d.participation)}` : ''}</span></span></a>
            <button data-unfollow="depute:${esc(uid)}" class="text-xs text-slate-500 hover:text-rose-600 p-2" title="Ne plus suivre" aria-label="Ne plus suivre"><i class="fa-solid fa-xmark"></i></button></div>`;
    }).join('');
    const rows = dos.map(([uid, f]) => ({ uid, f, ch: isDown('dossiers') ? [] : dossierChanges(uid), d: state.dossiers.find((x) => x.uid === uid) }))
        .sort((a, b) => (b.ch === null) - (a.ch === null) || (b.ch ? b.ch.length : 0) - (a.ch ? a.ch.length : 0));
    const dosHtml = rows.map(({ uid, f, ch, d }) => {
        const remove = `<button data-unfollow="dossier:${esc(uid)}" class="text-xs text-slate-500 hover:text-rose-600 p-2" title="Ne plus suivre" aria-label="Ne plus suivre"><i class="fa-solid fa-xmark"></i></button>`;
        if (ch === null) {
            return `<div class="card !p-3 flex items-start gap-2 border-slate-300"><div class="flex-1 text-sm"><p class="font-semibold">${esc(f.titre || uid)}</p>
                <p class="text-xs text-slate-500 mt-1">N'est plus dans la sélection publiée sur ce site (dossiers les plus récemment actifs).
                ${f.url ? `<a class="text-blue-600 dark:text-blue-400 hover:underline" href="${esc(f.url)}" target="_blank" rel="noopener">Suivre sur le site de l'Assemblée ↗</a>` : ''}</p></div>${remove}</div>`;
        }
        return `<div class="card !p-3 flex items-start gap-2 ${ch.length ? 'border-amber-300 dark:border-amber-700' : ''}">
            <a href="#/dossier/${esc(uid)}" class="flex-1 min-w-0 space-y-1">
                <span class="flex flex-wrap items-center gap-2 text-xs">${ch.length ? '<span class="badge bg-amber-500 text-white">Nouveau</span>' : ''}${statusBadge(d.statut, d.etape, d.statutDecision)}<span class="text-slate-500">${fmtShort(d.dateMaj)}</span></span>
                <span class="block font-semibold text-sm text-slate-900 dark:text-white">${esc(d.titre)}</span>
                ${ch.length ? `<ul class="text-xs text-amber-800 dark:text-amber-300 list-disc pl-4">${ch.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
        : `<span class="block text-xs text-slate-500">Rien de nouveau depuis le ${fmtShort(f.vu && f.vu.dateMaj)}${d.prochaineEtape ? ` · prévu le ${fmtShort(d.prochaineEtape.date)}` : ''}</span>`}
            </a>
            <span class="flex flex-col items-end gap-1">${remove}${ch.length ? `<button data-seen="${esc(uid)}" class="text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap">Marquer comme vu</button>` : ''}</span></div>`;
    }).join('');
    box.innerHTML = `
        <div class="space-y-2"><h3 class="section-title !mt-0">Dossiers suivis (${dos.length})</h3>
            ${isDown('dossiers') ? unavailable(['dossiers'], 'Dossiers') : dosHtml || '<p class="text-sm text-slate-500">Aucun dossier suivi.</p>'}</div>
        <div class="space-y-2"><h3 class="section-title">Députés suivis (${deps.length})</h3>
            ${isDown('deputes') ? unavailable(['deputes'], 'Députés') : depHtml || '<p class="text-sm text-slate-500">Aucun député suivi.</p>'}</div>`;
}

/* ---------------------------------------------------------------- détail (modale) */
let detailToken = 0;
async function openDetail(kind, id) {
    const token = ++detailToken;
    const modal = $('#detailModal');
    const content = $('#detailContent');
    content.innerHTML = `<div class="space-y-3"><div class="skeleton h-8 w-2/3"></div><div class="skeleton h-4 w-1/2"></div><div class="skeleton h-40 w-full"></div></div>`;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    try {
        const file = { depute: `deputes/${id}.json`, dossier: `dossiers/${id}.json`, question: `questions/${id}.json` }[kind];
        // Couleurs des groupes et liens vers les députés : attendre les listes (2 s max).
        const [data] = await Promise.all([getJSON(file), Promise.race([dataReady, new Promise((r) => setTimeout(r, 2000))])]);
        if (token !== detailToken) return;
        state.detail = { kind, data };
        if (kind === 'dossier') markSeen(data);  // ouvrir un dossier suivi = nouveautés vues (après calcul du bandeau)
        content.innerHTML = { depute: renderDeputeDetail, dossier: renderDossierDetail, question: renderQuestionDetail }[kind](data);
        $('#detailBackdrop').scrollTop = 0;
        if (kind === 'dossier') bindFullText(data);
    } catch (e) {
        if (token !== detailToken) return;
        content.innerHTML = `<p class="text-sm text-rose-600">Impossible de charger cette fiche (${esc(e.message)}). Elle est peut-être sortie de la fenêtre des données publiées.</p>`;
    }
}

function closeDetail(updateHash) {
    const modal = $('#detailModal');
    if (modal.classList.contains('hidden')) return;
    detailToken++;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (updateHash) {
        history.pushState(null, '', listHash[lastTab] || `#/${lastTab === 'dashboard' ? '' : lastTab}`);
        routedHash = location.hash;
    }
}

const linkBtn = (href, label, icon = 'fa-arrow-up-right-from-square') => href ? `<a href="${esc(href)}" target="_blank" rel="noopener" class="btn-secondary"><i class="fa-solid ${icon}"></i>${label}</a>` : '';

function renderDeputeDetail(d) {
    const sc = d.scrutins || {};
    const q = d.questions || {};
    const c = d.contacts || {};
    const age = d.naissance && d.naissance.date ? Math.floor((Date.now() - new Date(d.naissance.date)) / 31557600000) : null;
    return `
    <div class="flex items-start gap-4 pr-8">
        ${avatar(d, 'w-20 h-20', 'border-2')}
        <div class="min-w-0">
            <h3 class="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">${esc(d.civ)} ${esc(d.prenom)} ${esc(d.nom)}</h3>
            <p class="text-sm text-slate-600 dark:text-slate-300 mt-1">${groupBadge(d.groupe, d.groupeUid)} ${esc(d.groupeLibelle || '')}${d.groupeQualite && !/^membre$/i.test(d.groupeQualite) ? ` · ${esc(d.groupeQualite)}` : ''}</p>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">${esc(d.departement)} (${esc(d.numDepartement)}) · ${ordinal(d.circo)} circonscription · ${esc(d.region || '')}</p>
        </div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 text-xs">
        <div class="stat" title="${esc(PARTICIPATION_INFO)}"><span class="stat-label">Participation aux scrutins publics <i class="fa-regular fa-circle-question"></i></span><span class="stat-value text-lg">${pct(sc.participation)}</span><span class="block text-slate-500">${fmtNum(sc.votes)} votes / ${fmtNum(sc.eligibles)}</span></div>
        <div class="stat"><span class="stat-label">Votes alignés sur son groupe</span><span class="stat-value text-lg text-emerald-600 dark:text-emerald-400">${pct(sc.loyaute)}</span></div>
        <div class="stat"><span class="stat-label">Questions posées</span><span class="stat-value text-lg">${fmtNum(q.total)}</span></div>
        <div class="stat"><span class="stat-label">Propositions de loi (1er signataire)</span><span class="stat-value text-lg">${d.propositionsDeLoi != null ? fmtNum(d.propositionsDeLoi) : '—'}</span></div>
    </div>
    <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-2"><i class="fa-solid fa-circle-info mr-1"></i>${esc(PARTICIPATION_INFO)}</p>
    <div class="grid sm:grid-cols-2 gap-3 mt-3 text-xs">
        <div class="stat"><span class="stat-label">Mandat</span><span class="stat-value">Depuis le ${fmtDate(d.mandat.debut)}</span><span class="block text-slate-500">${esc(d.mandat.cause || '')}${d.mandat.premiereElection ? ' · premier mandat' : ''}${d.mandat.placeHemicycle ? ` · place n°${esc(d.mandat.placeHemicycle)}` : ''}</span></div>
        <div class="stat"><span class="stat-label">État civil</span><span class="stat-value">${d.naissance.date ? `Né${d.sexe === 'F' ? 'e' : ''} le ${fmtDate(d.naissance.date)}${age ? ` (${age} ans)` : ''}` : '—'}</span><span class="block text-slate-500">${esc([d.naissance.ville, d.naissance.departement].filter(Boolean).join(', '))}${d.profession ? ` · ${esc(d.profession)}` : ''}</span></div>
        ${d.parti ? `<div class="stat"><span class="stat-label">Parti de rattachement</span><span class="stat-value">${esc(d.parti)}</span></div>` : ''}
        ${d.commission ? `<div class="stat"><span class="stat-label">Commission permanente</span><span class="stat-value">${esc(d.commission)}</span></div>` : ''}
    </div>

    ${sc.derniers && sc.derniers.length ? `<h4 class="section-title">Derniers votes</h4>
    <div class="overflow-x-auto"><table class="w-full text-xs"><tbody>${sc.derniers.map((v) => `
        <tr class="border-t border-slate-100 dark:border-slate-700"><td class="py-1.5 pr-2 whitespace-nowrap text-slate-500">${fmtShort(v.date)}</td>
        <td class="py-1.5 pr-2">${esc(v.titre)}</td>
        <td class="py-1.5 whitespace-nowrap font-semibold ${v.position === 'pour' ? 'text-emerald-600' : v.position === 'contre' ? 'text-rose-600' : 'text-slate-500'}">${esc(v.position)}</td></tr>`).join('')}</tbody></table></div>` : ''}

    ${q.dernieres && q.dernieres.length ? `<h4 class="section-title">Dernières questions</h4>
    <div class="space-y-2">${q.dernieres.map((x) => `<a href="#/question/${esc(x.uid)}" class="row-link !p-2.5 text-xs">
        <span class="badge ${QTYPE_BADGE[x.type] || ''}">${esc(x.type)}</span> <span class="text-slate-500">${fmtShort(x.date)} → ${esc(x.ministere || '')}</span>
        <span class="block font-semibold text-slate-800 dark:text-slate-100 mt-1">${esc(x.titre || '')}</span></a>`).join('')}</div>` : ''}

    ${d.organes && d.organes.length ? `<h4 class="section-title">Fonctions et organes (${d.organes.length})</h4>
    <ul class="text-xs space-y-1">${d.organes.map((o) => `<li class="flex gap-2"><span class="text-slate-500 w-40 shrink-0">${esc(o.typeLibelle)}</span><span><b class="text-slate-800 dark:text-slate-100">${esc(o.libelle)}</b>${o.qualite ? ` — ${esc(o.qualite)}` : ''}</span></li>`).join('')}</ul>` : ''}

    <h4 class="section-title">Contact</h4>
    <div class="text-xs space-y-1">
        ${(c.emails || []).map((e) => `<p><i class="fa-solid fa-envelope w-4 text-slate-400"></i><a class="text-blue-600 dark:text-blue-400 hover:underline" href="mailto:${esc(e)}">${esc(e)}</a></p>`).join('')}
        ${(c.sites || []).map((s) => `<p><i class="fa-solid fa-globe w-4 text-slate-400"></i><a class="text-blue-600 dark:text-blue-400 hover:underline" href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a></p>`).join('')}
        ${(c.reseaux || []).map((s) => `<p><i class="fa-solid fa-hashtag w-4 text-slate-400"></i><a class="text-blue-600 dark:text-blue-400 hover:underline" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></p>`).join('')}
        ${(c.adresses || []).map((a) => `<p><i class="fa-solid fa-location-dot w-4 text-slate-400"></i><span class="text-slate-500">${esc(a.label)} :</span> ${esc(a.adresse)}</p>`).join('')}
    </div>

    <div class="mt-6 pt-4 border-t border-slate-200 dark:border-slate-700 flex flex-wrap gap-2 justify-end">
        ${followButton('depute', d.uid)}
        ${linkBtn(`${DATA}deputes/${d.uid}.json`, 'Fiche JSON complète', 'fa-code')}
        ${linkBtn(d.liens.hatvp, 'Déclarations HATVP')}
        ${d.liens.an ? `<a href="${esc(d.liens.an)}" target="_blank" rel="noopener" class="btn-primary"><i class="fa-solid fa-landmark"></i>Fiche officielle AN</a>` : ''}
    </div>`;
}

function renderDossierDetail(d) {
    const phases = [];
    for (const a of d.actes || []) {
        let p = phases[phases.length - 1];
        if (!p || p.name !== a.phase) { p = { name: a.phase, actes: [] }; phases.push(p); }
        p.actes.push(a);
    }
    const docTitle = Object.fromEntries((d.documents || []).map((x) => [x.uid, x]));
    const principal = docTitle[d.textePrincipal];
    return `
    <div class="pr-8 space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="badge bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">${esc(d.procedure)}</span>
            ${statusBadge(d.statut, d.etape, d.statutDecision)}
            ${d.procedureAcceleree ? '<span class="badge bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">Procédure accélérée</span>' : ''}
            <span class="font-mono text-slate-400">${esc(d.uid)}</span>
        </div>
        <h3 class="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">${esc(d.titre)}</h3>
        ${d.resume && norm(d.resume) !== norm(d.titre) ? `<p class="text-sm text-slate-600 dark:text-slate-300">${esc(d.resume.charAt(0).toUpperCase() + d.resume.slice(1))}</p>` : ''}
        <p class="text-xs text-slate-500 dark:text-slate-400"><b>Initiative :</b> ${esc((d.initiateurs || []).join(', ') || '—')}${d.nbInitiateurs > (d.initiateurs || []).length ? ` et ${d.nbInitiateurs - d.initiateurs.length} autre(s)` : ''}</p>
    </div>
    <div class="grid grid-cols-5 gap-1 mt-4 text-center text-[10px] sm:text-xs">
        ${STEP_LABELS.map((l, i) => `<div class="p-1.5 rounded ${i < d.etape ? (d.etape === 5 ? 'bg-emerald-500 text-white' : 'bg-blue-600 text-white') : 'bg-slate-100 dark:bg-slate-700 text-slate-500'}">${esc(l)}</div>`).join('')}
    </div>
    <div class="grid sm:grid-cols-3 gap-3 mt-4 text-xs">
        <div class="stat"><span class="stat-label">Dernière étape accomplie</span><span class="stat-value">${fmtDate(d.dateMaj)}</span><span class="block text-slate-500">${esc(d.derniereEtape || '—')}</span></div>
        <div class="stat ${d.prochaineEtape ? 'ring-1 ring-amber-300 dark:ring-amber-700' : ''}"><span class="stat-label">Prochaine étape prévue</span>${d.prochaineEtape
        ? `<span class="stat-value">${fmtDate(d.prochaineEtape.date)}</span><span class="block text-slate-500">${esc(d.prochaineEtape.libelle)}</span>`
        : '<span class="stat-value">Aucune inscrite à l\'agenda</span>'}</div>
        <div class="stat"><span class="stat-label">Dépôt · données</span><span class="stat-value">${fmtDate(d.dateDepot)}</span><span class="block text-slate-500">Données de l'AN récupérées le ${fmtDate(d.donneesDu)}</span></div>
    </div>

    <h4 class="section-title">Texte ${principal ? `— ${esc(principal.type || '')}` : ''}</h4>
    <div id="fullTextBox" class="text-sm">
        ${d.texteIntegral
        ? `<button id="fullTextBtn" class="btn-primary"><i class="fa-solid fa-file-lines"></i>Lire le texte intégral (exposé des motifs et articles)</button>`
        : `<p class="text-xs text-slate-500">Texte intégral non archivé sur ce site : seuls le sont les projets de loi et les dossiers les plus récemment
            actifs (ajoutés au fil des mises à jour). ${principal && principal.liens && principal.liens.pdf
                ? 'Version officielle sur le site de l\'Assemblée :' : 'Le texte est accessible depuis le dossier officiel :'}</p>`}
        ${principal && principal.liens && principal.liens.pdf
        ? `<div class="flex flex-wrap gap-2 mt-2">${linkBtn(principal.liens.html, 'Texte (HTML officiel)')}${linkBtn(principal.liens.pdf, 'PDF officiel', 'fa-file-pdf')}</div>`
        // Texte sans version AN (déposé au Sénat) : renvoi aux dossiers officiels, pas seulement en bas de fiche.
        : !d.texteIntegral && d.liens ? `<div class="flex flex-wrap gap-2 mt-2">${linkBtn(d.liens.an, 'Dossier à l\'Assemblée')}${linkBtn(d.liens.senat, 'Dossier au Sénat')}</div>` : ''}
    </div>

    <h4 class="section-title">Parcours législatif</h4>
    <ol class="space-y-4">${phases.map((p) => `
        <li>
            <p class="text-xs font-bold text-blue-700 dark:text-blue-300 mb-1">${esc(p.name)}</p>
            <ul class="border-l-2 border-slate-200 dark:border-slate-700 pl-4 space-y-2">${p.actes.map((a) => `
                <li class="relative text-xs">
                    <span class="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full ${a.prevu ? 'bg-white dark:bg-slate-800 border-2 border-amber-500' : a.statut ? 'bg-emerald-500' : 'bg-blue-500'}"></span>
                    <span class="text-slate-500">${a.date ? fmtShort(a.date) : '—'}</span>
                    <span class="font-semibold ${a.prevu ? 'text-slate-500 dark:text-slate-400 italic' : 'text-slate-800 dark:text-slate-100'}"> ${esc(a.libelle)}</span>
                    ${a.prevu ? '<span class="badge ml-1 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">Programmé</span>' : ''}
                    ${a.statut ? `<span class="ml-1">${statusBadge(a.statut)}</span>` : ''}
                    ${a.organe ? `<span class="block text-slate-500">${esc(a.organe)}</span>` : ''}
                    ${a.rapporteurs && a.rapporteurs.length ? `<span class="block text-slate-500">Rapporteur(s) : ${esc(a.rapporteurs.join(', '))}</span>` : ''}
                    ${(a.textes || []).map((t) => docTitle[t] ? `<span class="block text-slate-500"><i class="fa-regular fa-file mr-1"></i>${esc(docTitle[t].type || '')} ${docTitle[t].liens && docTitle[t].liens.pdf ? `<a class="text-blue-600 dark:text-blue-400 hover:underline" href="${esc(docTitle[t].liens.pdf)}" target="_blank" rel="noopener">${esc(t)}</a>` : esc(t)}</span>` : '').join('')}
                    ${a.scrutins && a.scrutins.length ? `<span class="block text-slate-500"><i class="fa-solid fa-check-to-slot mr-1"></i>${a.scrutins.map((v) => `<a class="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener" href="https://www.assemblee-nationale.fr/dyn/17/scrutins/${esc(v.replace(/^.*V/, ''))}">scrutin n°${esc(v.replace(/^.*V/, ''))}</a>`).join(', ')}</span>` : ''}
                    ${a.infoJO ? `<a class="block text-blue-600 dark:text-blue-400 hover:underline" href="${esc(a.infoJO)}" target="_blank" rel="noopener">Journal officiel ↗</a>` : ''}
                </li>`).join('')}
            </ul>
        </li>`).join('')}
    </ol>

    ${d.documents && d.documents.length ? `<h4 class="section-title">Documents (${d.documents.length})</h4>
    <ul class="text-xs space-y-1.5">${d.documents.map((x) => `<li class="flex flex-wrap gap-x-2">
        <span class="text-slate-500 w-24 shrink-0">${fmtShort(x.date)}</span>
        <span class="font-semibold text-slate-800 dark:text-slate-100">${esc(x.type || x.uid)}</span>
        <span class="text-slate-500">${esc(x.titre || '')}</span>
        ${x.liens && x.liens.pdf ? `<a class="text-blue-600 dark:text-blue-400 hover:underline" href="${esc(x.liens.pdf)}" target="_blank" rel="noopener">PDF</a>` : ''}
    </li>`).join('')}</ul>` : ''}

    <div class="mt-6 pt-4 border-t border-slate-200 dark:border-slate-700 flex flex-wrap gap-2 justify-end">
        ${followButton('dossier', d.uid)}
        ${linkBtn(`${DATA}dossiers/${d.uid}.json`, 'JSON du dossier', 'fa-code')}
        ${linkBtn(d.liens.senat, 'Dossier au Sénat')}
        ${linkBtn(d.liens.legifrance, 'Légifrance')}
        ${d.liens.an ? `<a href="${esc(d.liens.an)}" target="_blank" rel="noopener" class="btn-primary"><i class="fa-solid fa-landmark"></i>Dossier officiel AN</a>` : ''}
    </div>`;
}

function bindFullText(d) {
    const btn = $('#fullTextBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>Chargement…';
        try {
            const t = await getJSON(`textes/${d.textePrincipal}.json`);
            btn.outerHTML = `<div class="prose-an max-h-[70vh] overflow-y-auto custom-scrollbar p-4 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40">${t.html}</div>
                <p class="text-[11px] text-slate-500 mt-1">Source : Assemblée nationale (${esc(t.uid)}), récupéré le ${fmtDate(t.recupereLe)}${t.tronque ? ' — texte tronqué, voir la version officielle' : ''}.</p>`;
        } catch (e) {
            btn.outerHTML = `<p class="text-xs text-rose-600">Texte indisponible (${esc(e.message)}).</p>`;
        }
    });
}

function renderQuestionDetail(x) {
    const block = (title, items, color) => items && items.length ? `
        <h4 class="section-title">${title}</h4>
        ${items.map((t) => `<div class="border-l-4 ${color} pl-4">
            <p class="text-[11px] text-slate-500 mb-1">Publiée au JO le ${fmtDate(t.date)}${t.page ? `, page ${esc(t.page)}` : ''}${t.legifrance ? ` · <a class="text-blue-600 hover:underline" href="${esc(t.legifrance)}" target="_blank" rel="noopener">Légifrance</a>` : ''}</p>
            <div class="prose-an">${t.html || '<em>Texte non publié dans les données ouvertes.</em>'}</div></div>`).join('')}` : '';
    const dep = state.deputes.find((d) => d.uid === x.auteurUid);
    return `
    <div class="pr-8 space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="badge ${QTYPE_BADGE[x.type] || ''}">${esc(QTYPE[x.type] || x.type)}</span>
            <span class="font-mono text-slate-400">n°${esc(x.numero)}</span>
            <span class="text-xs px-2 py-0.5 rounded-full font-medium ${x.repondue ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}">${esc(x.statut)}</span>
        </div>
        <h3 class="text-xl font-bold text-slate-900 dark:text-white">${esc(x.titre || x.rubrique || 'Question')}</h3>
        ${x.rubrique ? `<p class="text-xs text-slate-500">Rubrique : ${esc(x.rubrique)}</p>` : ''}
    </div>
    <div class="grid sm:grid-cols-3 gap-3 mt-4 text-xs">
        <a ${dep ? `href="#/depute/${esc(dep.uid)}"` : ''} class="stat flex items-center gap-2 ${dep ? 'hover:ring-1 hover:ring-blue-400' : ''}">
            ${dep ? avatar(dep, 'w-9 h-9') : ''}
            <span><span class="stat-label">Auteur</span><span class="stat-value">${esc(x.auteur)}</span> ${x.groupe ? `<span class="text-slate-500">(${esc(x.groupe)})</span>` : ''}</span>
        </a>
        <div class="stat"><span class="stat-label">Ministère interrogé</span><span class="stat-value">${esc(x.ministereInterroge || x.ministere || '—')}</span>
            ${x.ministereAttributaire && x.ministereAttributaire !== x.ministereInterroge ? `<span class="block text-slate-500">Attribuée à : ${esc(x.ministereAttributaire)}</span>` : ''}</div>
        <div class="stat"><span class="stat-label">Dates</span><span class="stat-value">${fmtDate(x.date)}</span>
            <span class="block text-slate-500">${x.dateReponse ? `Réponse le ${fmtDate(x.dateReponse)}` : 'Pas encore de réponse'}${x.renouvellements ? ` · renouvelée ${x.renouvellements} fois` : ''}${x.signalement ? ` · signalée le ${fmtShort(x.signalement)}` : ''}</span></div>
    </div>
    ${block('Question', x.question, 'border-amber-400')}
    ${block(x.type === 'QG' ? 'Échange en séance (compte rendu)' : 'Réponse du Gouvernement', x.reponse, 'border-emerald-400')}
    ${!x.question.length && !x.reponse.length ? '<p class="text-sm text-slate-500 mt-4">Le texte de cette question n\'est pas encore publié dans les données ouvertes.</p>' : ''}
    <div class="mt-6 pt-4 border-t border-slate-200 dark:border-slate-700 flex flex-wrap gap-2 justify-end">
        ${linkBtn(`${DATA}questions/${x.uid}.json`, 'JSON de la question', 'fa-code')}
        ${x.liens && x.liens.an ? `<a href="${esc(x.liens.an)}" target="_blank" rel="noopener" class="btn-primary"><i class="fa-solid fa-landmark"></i>Page officielle</a>` : ''}
    </div>`;
}

/* ---------------------------------------------------------------- données / API */
function renderMeta() {
    const m = state.meta;
    const sel = $('#apiEndpoint');
    if (!sel.options.length) {
        const first = (arr, key = 'uid') => (arr && arr[0] ? arr[0][key] : null);
        const opts = [
            ['meta.json', 'Métadonnées de génération'],
            ['deputes.json', 'Liste des députés'],
            ['groupes.json', 'Groupes politiques'],
            ['dossiers.json', 'Index des dossiers de loi'],
            ['questions.json', 'Index des questions'],
            ['scrutins.json', 'Derniers scrutins'],
        ];
        if (first(state.deputes)) opts.push([`deputes/${first(state.deputes)}.json`, 'Fiche député (exemple)']);
        if (first(state.dossiers)) opts.push([`dossiers/${first(state.dossiers)}.json`, 'Dossier législatif (exemple)']);
        if (first(state.questions)) opts.push([`questions/${first(state.questions)}.json`, 'Question (exemple)']);
        sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">/data/${esc(v)} — ${esc(l)}</option>`).join('');
        $('#apiRaw').href = DATA + sel.value;
    }
    if (!m) return;
    const s = m.sections || {};
    const row = (k, v) => `<div class="stat"><span class="stat-label">${k}</span><span class="stat-value">${v}</span></div>`;
    $('#metaInfo').innerHTML = [
        row('Dernière génération', fmtDate(m.generation, { dateStyle: 'long', timeStyle: 'short' })),
        row('Législature', esc(m.legislature)),
        row('Députés', fmtNum(s.deputes && s.deputes.total)),
        row('Dossiers affichés', `${fmtNum(s.dossiers && s.dossiers.affiches)} · ${fmtNum(s.dossiers && s.dossiers.textesRecuperes)} textes intégraux récupérés au dernier passage`),
        row('Questions affichées', fmtNum(s.questions && s.questions.affiches)),
        row('Scrutins', `${fmtNum(s.scrutins && s.scrutins.affiches)} affichés / ${fmtNum(s.scrutins && s.scrutins.total)}`),
        `<div class="stat md:col-span-2"><span class="stat-label">Sources officielles</span>${Object.entries(m.sources || {}).map(([k, u]) =>
            `<a class="block truncate text-blue-600 dark:text-blue-400 hover:underline font-mono" href="${esc(u)}">${esc(k)} — ${esc(u.split('/').pop())}</a>`).join('')}
            ${(m.sourcesIndisponibles || []).length ? `<p class="text-amber-600 mt-1">Indisponibles au dernier passage : ${esc(m.sourcesIndisponibles.join(', '))}</p>` : ''}</div>`,
    ].join('');
}

async function runApi() {
    const path = $('#apiEndpoint').value;
    const out = $('#apiOutput');
    $('#apiStatus').textContent = `GET /data/${path} …`;
    const t0 = performance.now();
    try {
        const r = await fetch(DATA + path, { cache: 'no-cache' });
        const text = await r.text();
        const ms = Math.round(performance.now() - t0);
        let pretty = text;
        try {
            const j = JSON.parse(text);
            const shown = Array.isArray(j) && j.length > 20 ? j.slice(0, 20) : j;
            pretty = JSON.stringify(shown, null, 2) + (shown !== j ? `\n\n// … ${j.length - 20} éléments supplémentaires (voir le JSON brut)` : '');
        } catch (e) { /* pas du JSON */ }
        $('#apiStatus').textContent = `HTTP ${r.status} · ${(text.length / 1024).toFixed(1)} Ko · ${ms} ms`;
        out.textContent = pretty;
    } catch (e) {
        $('#apiStatus').textContent = 'Erreur réseau';
        out.textContent = String(e);
    }
}

init();
