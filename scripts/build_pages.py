#!/usr/bin/env python3
"""Pages HTML statiques, lisibles sans JavaScript, pour les moteurs de recherche et les aperçus de partage.

L'application (index.html) n'a qu'une adresse : ses fiches vivent derrière « #/… », qu'un moteur de recherche ne
visite pas et qu'un aperçu de lien ne sait pas décrire. Ce script écrit, à partir des JSON de `data/` :

    depute/<PA…>.html     une page par député en exercice (mandat, groupe, votes et questions récents)
    dossier/<DLR…>.html   une page par dossier législatif publié (statut, parcours, documents)
    depute/index.html, dossier/index.html   listes complètes, pour que chaque page soit reliée au site
    sitemap.xml, 404.html

Chaque page renvoie à la fiche interactive (`#/depute/…`, `#/dossier/…`). Rien n'est stocké sur la branche `data` :
les pages sont dérivées des JSON à chaque déploiement.

    python scripts/build_pages.py --data data --out _site --base-url https://exemple.fr/site

Bibliothèque standard uniquement.
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import shutil
import sys
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

LOG = logging.getLogger("build_pages")

SITE = "Assemblée Open Data Explorer"
BASE_URL = "https://mr-robotpy.github.io/assemblee-nationale-explorer"
INTER_CSS = "assets/vendor/inter-5.0.18/inter.css"
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre",
        "décembre"]
ETAPES = ["Dépôt", "Commission", "Séance", "Navette / Sénat", "Promulgation"]
QTYPES = {"QE": "Question écrite", "QG": "Question au Gouvernement", "QOSD": "Question orale sans débat"}
# Même avertissement que sur la fiche interactive : un taux affiché sans lui se lit comme un taux de présence.
PARTICIPATION_INFO = ("Part des scrutins publics auxquels le député a pris part (y compris par délégation) depuis le "
                      "début de son mandat. Beaucoup de scrutins se tiennent en séance avec peu de députés présents : "
                      "une participation faible ne signifie pas une absence à l'Assemblée (travaux en commission, "
                      "circonscription…).")
# Politique de sécurité de contenu des pages statiques : aucun script en ligne (le thème vient de assets/theme.js,
# les données structurées JSON-LD ne sont pas exécutées), aucune connexion ; les badges de groupe ont un style en ligne.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'")


def e(x: Any) -> str:
    """Échappement HTML (texte et attributs) : toutes les données de l'Assemblée passent par ici."""
    return html.escape("" if x is None else str(x), quote=True)


def lien(url: Any) -> str | None:
    """N'accepte que http(s) : une adresse « javascript: » dans les données ne devient pas un lien."""
    u = str(url or "").strip()
    return u if u.startswith(("https://", "http://")) else None


def fmt_date(d: Any) -> str:
    s = str(d or "")[:10]
    try:
        a, m, j = (int(x) for x in s.split("-"))
        return f"{'1er' if j == 1 else j} {MOIS[m - 1]} {a}"
    except (ValueError, IndexError):
        return s


def ordinal(n: Any) -> str:
    return f"{n}{'re' if str(n) == '1' else 'e'}"


def pct(v: Any) -> str:
    return "—" if v is None else f"{str(v).replace('.', ',')} %"


def encre(couleur: str | None) -> str:
    """Noir ou blanc selon le meilleur contraste WCAG sur la couleur du groupe (même règle que l'application)."""
    c = str(couleur or "").lstrip("#")
    try:
        rgb = [int(c[i:i + 2], 16) / 255 for i in (0, 2, 4)] if len(c) == 6 else None
    except ValueError:
        rgb = None
    if not rgb:
        return "#ffffff"
    lin = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb]
    lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    sombre = 0.0122  # luminance de #0f172a
    return "#0f172a" if (lum + 0.05) / (sombre + 0.05) >= 1.05 / (lum + 0.05) else "#ffffff"


def couleur_sure(c: Any) -> str:
    s = str(c or "")
    return s if len(s) == 7 and s[0] == "#" and all(x in "0123456789abcdefABCDEF" for x in s[1:]) else "#94a3b8"


def resume(texte: str, limite: int = 160) -> str:
    t = " ".join(str(texte or "").split())
    return t if len(t) <= limite else t[:limite - 1].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------------------------------- gabarit
def page(*, titre: str, description: str, canonique: str, racine: str, corps: str, version: str, fil: str = "",
         json_ld: dict | None = None, robots: str | None = None, og_type: str = "article", generation: str = "") -> str:
    v = f"?v={e(version)}" if version else ""
    ld = ""
    if json_ld:
        # « </ » neutralisé : un titre contenant « </script> » ne ferme pas la balise.
        ld = '\n<script type="application/ld+json">' + json.dumps(json_ld, ensure_ascii=False).replace("</", "<\\/") + "</script>"
    maj = f" Données mises à jour le {e(fmt_date(generation))}." if generation else ""
    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<title>{e(titre)}</title>
<meta name="description" content="{e(description)}">
{f'<meta name="robots" content="{e(robots)}">' if robots else f'<link rel="canonical" href="{e(canonique)}">'}
<meta property="og:type" content="{e(og_type)}">
<meta property="og:site_name" content="{e(SITE)}">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="{e(titre)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{e(canonique)}">
<meta name="twitter:card" content="summary">
<script src="{e(racine)}assets/theme.js{v}"></script>
<link rel="stylesheet" href="{e(racine)}{INTER_CSS}">
<link rel="stylesheet" href="{e(racine)}assets/pages.css{v}">{ld}
</head>
<body>
<header class="entete">
<a class="marque" href="{e(racine)}">{e(SITE)}</a>
<nav aria-label="Navigation principale">
<a href="{e(racine)}depute/">Députés</a>
<a href="{e(racine)}dossier/">Dossiers législatifs</a>
<a href="{e(racine)}#/questions">Questions</a>
<a href="{e(racine)}#/scrutins">Scrutins</a>
</nav>
</header>
<main>
{fil}
{corps}
</main>
<footer>
<p>Projet indépendant, non affilié à l'Assemblée nationale. Données : Assemblée nationale,
<a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence/" rel="noopener">Licence Ouverte 2.0</a>.{maj}</p>
<p><a href="{e(racine)}#/mentions">Mentions légales et confidentialité</a></p>
</footer>
</body>
</html>
"""


def fil_ariane(racine: str, *niveaux: tuple[str, str | None]) -> str:
    items = [f'<a href="{e(racine)}">Accueil</a>']
    items += [f'<a href="{e(url)}">{e(nom)}</a>' if url else f"<span>{e(nom)}</span>" for nom, url in niveaux]
    return '<nav class="fil" aria-label="Fil d\'Ariane">' + " › ".join(items) + "</nav>"


def badge_groupe(abrev: Any, couleur: Any) -> str:
    if not abrev:
        return ""
    c = couleur_sure(couleur)
    return f'<span class="badge" style="background:{c};color:{encre(c)}">{e(abrev)}</span>'


# ------------------------------------------------------------------------------------------------------- députés
def qualite(d: dict) -> str:
    return "Députée" if d.get("sexe") == "F" else "Député"


def circonscription(d: dict) -> str:
    dep = d.get("departement") or ""
    num = f" ({d['numDepartement']})" if d.get("numDepartement") else ""
    circ = f" · {ordinal(d['circo'])} circonscription" if d.get("circo") else ""
    return f"{dep}{num}{circ}"


def page_depute(d: dict, groupes: dict[str, dict], base: str, version: str, generation: str) -> str:
    """Page d'un député. Seules les données liées au mandat sont reprises : ni naissance, ni profession, ni
    coordonnées (elles restent sur la fiche interactive, qu'un moteur de recherche n'indexe pas)."""
    nom = f"{d.get('prenom') or ''} {d.get('nom') or ''}".strip()
    uid = d["uid"]
    g = groupes.get(d.get("groupeUid") or "", {})
    groupe_nom = d.get("groupeLibelle") or g.get("libelle") or d.get("groupe") or ""
    q = qualite(d)
    canonique = f"{base}/depute/{uid}.html"
    titre = " · ".join(x for x in (f"{nom}, {q.lower()} {d.get('groupe') or ''}".strip(), circonscription(d)) if x)
    description = resume(
        f"{nom}, {q.lower()} {groupe_nom} ({circonscription(d)}) : participation aux scrutins publics, votes "
        f"récents et questions posées. Données ouvertes de l'Assemblée nationale.", 220)

    infos = [("Groupe", f"{badge_groupe(d.get('groupe'), g.get('couleur'))} {e(groupe_nom)}"),
             ("Circonscription", e(circonscription(d)) + (f" · {e(d['region'])}" if d.get("region") else ""))]
    if d.get("commission"):
        infos.append(("Commission permanente", e(d["commission"])))
    debut = (d.get("mandat") or {}).get("debut")
    if debut:
        infos.append(("Mandat en cours depuis le", e(fmt_date(debut))))

    blocs = ['<dl class="infos">' + "".join(f"<div><dt>{k}</dt><dd>{v}</dd></div>" for k, v in infos) + "</dl>"]

    # Sans fiche détaillée, le résumé de l'annuaire sert de repli : « questions » y est un simple nombre.
    sc = d.get("scrutins") if isinstance(d.get("scrutins"), dict) else {}
    qs = d.get("questions") if isinstance(d.get("questions"), dict) else {}
    stats = []
    if sc:
        stats.append(("Participation aux scrutins publics", pct(sc.get("participation")),
                      f"{sc.get('votes', 0)} votes sur {sc.get('eligibles', 0)} scrutins"))
        stats.append(("Votes alignés sur son groupe", pct(sc.get("loyaute")), ""))
    if qs:
        stats.append(("Questions posées", str(qs.get("total", 0)), ""))
    if "propositionsDeLoi" in d:
        stats.append(("Propositions de loi (1er signataire)", str(d["propositionsDeLoi"]), ""))
    if stats:
        blocs.append('<h2>Activité depuis le début du mandat</h2><ul class="stats">' + "".join(
            f"<li><span>{e(k)}</span><strong>{e(v)}</strong>{f'<small>{e(n)}</small>' if n else ''}</li>"
            for k, v, n in stats) + "</ul>")
        if sc:
            blocs.append(f'<p class="note">{e(PARTICIPATION_INFO)}</p>')

    if sc.get("derniers"):
        lignes = "".join(
            f"<tr><td>{e(fmt_date(v.get('date')))}</td><td>Scrutin n°{e(v.get('numero'))} : {e(v.get('titre'))}</td>"
            f"<td>{e(v.get('position'))}</td><td>{e(v.get('sort'))}</td></tr>" for v in sc["derniers"])
        blocs.append("<h2>Derniers votes lors de scrutins publics</h2><div class=\"defile\"><table><thead><tr>"
                     "<th>Date</th><th>Scrutin</th><th>Vote</th><th>Résultat</th></tr></thead>"
                     f"<tbody>{lignes}</tbody></table></div>")

    if qs.get("dernieres"):
        items = "".join(
            f"<li><a href=\"../#/question/{e(x.get('uid'))}\">{e(x.get('titre'))}</a>"
            f"<small>{e(QTYPES.get(x.get('type'), x.get('type')))} · {e(fmt_date(x.get('date')))}"
            f"{' · ' + e(x['ministere']) if x.get('ministere') else ''}"
            f"{' · ' + e(x['statut']) if x.get('statut') else ''}</small></li>" for x in qs["dernieres"])
        blocs.append(f'<h2>Dernières questions</h2><ul class="liste">{items}</ul>')

    # Un organe absent du référentiel n'a que son identifiant pour libellé : rien à en dire au lecteur.
    organes = [o for o in d.get("organes") or [] if o.get("libelle") and o["libelle"] != o.get("uid")]
    if organes:
        items = "".join(f"<li>{e(o['libelle'])}<small>{e(o.get('typeLibelle'))}"
                        f"{' · ' + e(o['qualite']) if o.get('qualite') else ''}</small></li>" for o in organes)
        blocs.append(f'<h2>Organes et fonctions</h2><ul class="liste">{items}</ul>')

    officiels = [(lien((d.get("liens") or {}).get("an")), "Fiche sur le site de l'Assemblée nationale"),
                 (lien((d.get("liens") or {}).get("hatvp")), "Déclarations publiées par la HATVP")]
    actions = f'<a class="bouton" href="../#/depute/{e(uid)}">Ouvrir la fiche interactive</a>' + "".join(
        f'<a class="bouton secondaire" href="{e(u)}" rel="noopener">{e(t)}</a>' for u, t in officiels if u)
    corps = (f'<article><p class="sur">{e(q)} en exercice · XVII<sup>e</sup> législature</p><h1>{e(nom)}</h1>'
             f'{"".join(blocs)}<p class="actions">{actions}</p></article>')

    ld = {"@context": "https://schema.org", "@type": "Person", "name": nom, "jobTitle": q, "url": canonique,
          "worksFor": {"@type": "GovernmentOrganization", "name": "Assemblée nationale"}}
    if groupe_nom:
        ld["memberOf"] = {"@type": "Organization", "name": groupe_nom}
    if officiels[0][0]:
        ld["sameAs"] = [officiels[0][0]]
    return page(titre=f"{titre} | {SITE}", description=description, canonique=canonique, racine="../", corps=corps,
                version=version, fil=fil_ariane("../", ("Députés", "./"), (nom, None)), json_ld=ld, og_type="profile",
                generation=generation)


def liste_deputes(deputes: list[dict], groupes: dict[str, dict], base: str, version: str, generation: str) -> str:
    tri = sorted(deputes, key=lambda d: ((d.get("nomTri") or d.get("nom") or "").lower(), (d.get("prenom") or "").lower()))
    items = "".join(
        f"<li><a href=\"{e(d['uid'])}.html\">{e(d.get('nom'))} {e(d.get('prenom'))}</a> "
        f"{badge_groupe(d.get('groupe'), (groupes.get(d.get('groupeUid') or '') or {}).get('couleur'))}"
        f"<small>{e(circonscription(d))}</small></li>" for d in tri)
    corps = (f"<h1>Les {len(tri)} députés en exercice</h1>"
             "<p>Liste alphabétique des députés de la XVII<sup>e</sup> législature. Pour filtrer par groupe, commission ou "
             "département, ou pour trouver votre député par commune ou par adresse, utilisez "
             "<a href=\"../#/deputes\">l'annuaire interactif</a>.</p>"
             f'<ul class="liste colonnes">{items}</ul>')
    return page(titre=f"Les {len(tri)} députés en exercice, par ordre alphabétique | {SITE}",
                description="Tous les députés en exercice de la XVIIe législature : groupe politique, circonscription, "
                            "participation aux scrutins publics, votes et questions. Données ouvertes de l'Assemblée nationale.",
                canonique=f"{base}/depute/", racine="../", corps=corps, version=version,
                fil=fil_ariane("../", ("Députés", None)), og_type="website", generation=generation)


# ------------------------------------------------------------------------------------------------------ dossiers
def page_dossier(d: dict, base: str, version: str, generation: str) -> str:
    uid = d["uid"]
    titre = d.get("titre") or uid
    canonique = f"{base}/dossier/{uid}.html"
    initiateurs = [i for i in d.get("initiateurs") or [] if i]
    nb = d.get("nbInitiateurs") or len(initiateurs)
    autres = f" et {nb - len(initiateurs)} autres" if nb > len(initiateurs) else ""
    description = resume(" — ".join(x for x in (
        f"{d.get('procedure') or 'Dossier législatif'} : {titre}",
        f"Statut : {d['statut']}" if d.get("statut") else "",
        f"dernière étape le {fmt_date(d['dateMaj'])}" if d.get("dateMaj") else "") if x), 200)

    infos = []
    if d.get("statut"):
        infos.append(("Statut", f"<strong>{e(d['statut'])}</strong>"))
    if initiateurs:
        infos.append(("Initiative", e(", ".join(initiateurs) + autres)))
    if d.get("dateDepot"):
        infos.append(("Dépôt", e(fmt_date(d["dateDepot"]))))
    if d.get("derniereEtape"):
        infos.append(("Dernière étape accomplie", e(f"{fmt_date(d.get('dateMaj'))} — {d['derniereEtape']}")))
    proch = d.get("prochaineEtape") or {}
    if proch.get("date"):
        infos.append(("Prochaine étape programmée", e(f"{fmt_date(proch['date'])} — {proch.get('libelle') or ''}")))
    if d.get("procedureAcceleree"):
        infos.append(("Procédure", "Procédure accélérée"))

    etape = d.get("etape") or 0
    parcours = '<ol class="etapes">' + "".join(
        f'<li class="faite">{e(nom)}<span class="sr"> (franchie)</span></li>' if i < etape else f"<li>{e(nom)}</li>"
        for i, nom in enumerate(ETAPES)) + "</ol>"

    blocs = [parcours, '<dl class="infos">' + "".join(f"<div><dt>{k}</dt><dd>{v}</dd></div>" for k, v in infos) + "</dl>"]
    if d.get("resume") and " ".join(str(d["resume"]).split()).lower() != " ".join(str(titre).split()).lower():
        chapo = str(d["resume"]).strip()
        blocs.insert(0, f'<p class="chapo">{e(chapo[:1].upper() + chapo[1:])}</p>')

    dates = sorted((a for a in d.get("actes") or [] if a.get("date")), key=lambda a: a["date"])
    if dates:
        def ligne(a: dict) -> str:
            statut = f" : <strong>{e(a['statut'])}</strong>" if a.get("statut") else ""
            prevu = ' <span class="prevu">programmé</span>' if a.get("prevu") else ""
            return (f"<li><time datetime=\"{e(a['date'])}\">{e(fmt_date(a['date']))}</time>"
                    f"<span><small>{e(a.get('phase'))}</small>{e(a.get('libelle'))}{statut}{prevu}</span></li>")
        blocs.append('<h2>Parcours législatif</h2><ol class="chrono">' + "".join(ligne(a) for a in dates) + "</ol>")

    docs = [x for x in d.get("documents") or [] if x.get("titre") and lien((x.get("liens") or {}).get("html"))]
    if docs:
        items = "".join(
            f"<li><a href=\"{e(lien(x['liens']['html']))}\" rel=\"noopener\">{e(x['titre'])}</a>"
            f"<small>{e(x.get('type') or 'Document')}{' · ' + e(fmt_date(x['date'])) if x.get('date') else ''}</small></li>"
            for x in docs)
        blocs.append(f'<h2>Documents officiels</h2><ul class="liste">{items}</ul>')

    liens = d.get("liens") or {}
    officiels = [(lien(liens.get("an")), "Dossier sur le site de l'Assemblée nationale"),
                 (lien(liens.get("senat")), "Dossier sur le site du Sénat"),
                 (lien(liens.get("legifrance")), "Texte publié au Journal officiel")]
    actions = f'<a class="bouton" href="../#/dossier/{e(uid)}">Ouvrir la fiche interactive</a>' + "".join(
        f'<a class="bouton secondaire" href="{e(u)}" rel="noopener">{e(t)}</a>' for u, t in officiels if u)
    corps = (f'<article><p class="sur">{e(d.get("procedure") or "Dossier législatif")} · XVII<sup>e</sup> législature</p>'
             f'<h1>{e(titre)}</h1>{"".join(blocs)}<p class="actions">{actions}</p></article>')
    return page(titre=f"{resume(titre, 110)} — {d.get('statut') or d.get('procedure') or 'dossier législatif'} | {SITE}",
                description=description, canonique=canonique, racine="../", corps=corps, version=version,
                fil=fil_ariane("../", ("Dossiers législatifs", "./"), (resume(titre, 70), None)), generation=generation)


def liste_dossiers(index: list[dict], base: str, version: str, generation: str) -> str:
    par_annee: dict[str, list[dict]] = {}
    for d in sorted(index, key=lambda d: (d.get("dateMaj") or d.get("dateDepot") or "", d["uid"]), reverse=True):
        par_annee.setdefault((d.get("dateMaj") or d.get("dateDepot") or "")[:4] or "Sans date", []).append(d)
    sections = "".join(
        f"<h2>{e(annee)} <small>({len(ds)})</small></h2><ul class=\"liste\">" + "".join(
            f"<li><a href=\"{e(d['uid'])}.html\">{e(d.get('titre') or d['uid'])}</a>"
            f"<small>{e(d.get('procedure'))}{' · ' + e(d['statut']) if d.get('statut') else ''}</small></li>" for d in ds)
        + "</ul>" for annee, ds in par_annee.items())
    corps = (f"<h1>Les {len(index)} dossiers législatifs de la XVII<sup>e</sup> législature</h1>"
             "<p>Projets et propositions de loi, résolutions, commissions d'enquête : classés par année de dernière "
             "étape, les plus récents d'abord. Pour chercher par mot, type, statut ou étape, utilisez "
             "<a href=\"../#/lois\">la liste interactive</a>.</p>" + sections)
    return page(titre=f"Les {len(index)} dossiers législatifs de la XVIIe législature | {SITE}",
                description="Tous les projets et propositions de loi de la XVIIe législature : statut, parcours "
                            "législatif à l'Assemblée et au Sénat, documents officiels. Données ouvertes de l'Assemblée nationale.",
                canonique=f"{base}/dossier/", racine="../", corps=corps, version=version,
                fil=fil_ariane("../", ("Dossiers législatifs", None)), og_type="website", generation=generation)


# ------------------------------------------------------------------------------------------- plan du site et 404
def sitemap(urls: list[tuple[str, str | None]]) -> str:
    lignes = "".join(
        f"<url><loc>{xml_escape(u)}</loc>{f'<lastmod>{xml_escape(m[:10])}</lastmod>' if m else ''}</url>\n" for u, m in urls)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{lignes}</urlset>\n'


def page_404(base: str, version: str) -> str:
    """Servie pour toute adresse disparue (fin de mandat, dossier retiré) : chemins absolus, la page n'a pas d'adresse fixe."""
    corps = ("<h1>Page introuvable</h1><p>Cette page n'existe pas ou n'existe plus : le site ne publie que les députés "
             "en exercice, et une fiche disparaît à la fin du mandat.</p>"
             f'<p class="actions"><a class="bouton" href="{e(base)}/">Accueil</a>'
             f'<a class="bouton secondaire" href="{e(base)}/depute/">Députés</a>'
             f'<a class="bouton secondaire" href="{e(base)}/dossier/">Dossiers législatifs</a></p>')
    return page(titre=f"Page introuvable | {SITE}", description="Cette page n'existe pas ou n'existe plus.",
                canonique=f"{base}/", racine=f"{base}/", corps=corps, version=version, robots="noindex", og_type="website")


# --------------------------------------------------------------------------------------------------------- main
def build(data: Path, out: Path, base: str, version: str = "") -> dict[str, int]:
    base = base.rstrip("/")
    meta = load(data / "meta.json") if (data / "meta.json").exists() else {}
    generation = str(meta.get("generation") or "")
    groupes = {g["uid"]: g for g in load(data / "groupes.json")}
    deputes = load(data / "deputes.json")
    dossiers = load(data / "dossiers.json") if (data / "dossiers.json").exists() else []
    urls: list[tuple[str, str | None]] = [(f"{base}/", generation), (f"{base}/depute/", generation),
                                          (f"{base}/dossier/", generation)]

    # Dossiers entiers réécrits : la page d'un député sorti de l'Assemblée ne doit pas survivre à son mandat.
    for nom in ("depute", "dossier"):
        if (out / nom).exists():
            shutil.rmtree(out / nom)
        (out / nom).mkdir(parents=True)

    n_dep = 0
    for s in deputes:
        fiche = data / "deputes" / f"{s['uid']}.json"
        d = load(fiche) if fiche.exists() else s
        (out / "depute" / f"{s['uid']}.html").write_text(page_depute(d, groupes, base, version, generation), encoding="utf-8")
        urls.append((f"{base}/depute/{s['uid']}.html", generation))
        n_dep += 1
    (out / "depute" / "index.html").write_text(liste_deputes(deputes, groupes, base, version, generation), encoding="utf-8")

    publies = []
    for s in dossiers:
        fiche = data / "dossiers" / f"{s['uid']}.json"
        if not fiche.exists():  # index et fiches sont écrits ensemble : sans fiche, pas de page ni de lien mort
            continue
        d = load(fiche)
        (out / "dossier" / f"{s['uid']}.html").write_text(page_dossier(d, base, version, generation), encoding="utf-8")
        urls.append((f"{base}/dossier/{s['uid']}.html", d.get("dateMaj") or d.get("dateDepot") or generation))
        publies.append(s)
    (out / "dossier" / "index.html").write_text(liste_dossiers(publies, base, version, generation), encoding="utf-8")

    (out / "sitemap.xml").write_text(sitemap(urls), encoding="utf-8")
    (out / "404.html").write_text(page_404(base, version), encoding="utf-8")
    return {"deputes": n_dep, "dossiers": len(publies), "urls": len(urls)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data", type=Path, help="dossier des JSON générés par build_data.py")
    ap.add_argument("--out", default="_site", type=Path, help="racine du site à compléter")
    ap.add_argument("--base-url", default=BASE_URL, help="adresse publique du site (adresses canoniques, plan du site)")
    ap.add_argument("--version", default="", help="suffixe de cache de la feuille de style")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if not (args.data / "deputes.json").exists():
        LOG.error("%s introuvable : lancer d'abord scripts/build_data.py", args.data / "deputes.json")
        return 1
    # Adresse vide (configuration de Pages muette) : adresse connue du site plutôt que des liens canoniques relatifs.
    n = build(args.data, args.out, args.base_url.strip() or BASE_URL, args.version)
    LOG.info("Pages statiques : %(deputes)d députés, %(dossiers)d dossiers, %(urls)d adresses dans sitemap.xml", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
