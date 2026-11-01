#!/usr/bin/env python3
"""Construit les JSON locaux du site à partir de l'Open Data de l'Assemblée nationale.

Sources (XVIIe législature, archives ZIP officielles) :
  - AMO10 : députés en exercice, mandats et organes
  - AMO20 : tous les acteurs de la législature (noms des ministres, sénateurs…)
  - Dossiers législatifs + documents
  - Scrutins publics (votes nominatifs)
  - Questions écrites, au Gouvernement, orales sans débat
  - Texte intégral des projets / propositions de loi (www.assemblee-nationale.fr/dyn/docs/<uid>.raw)

Aucune dépendance externe : bibliothèque standard uniquement.

Usage :
  python scripts/build_data.py                     # télécharge tout et écrit ./data
  python scripts/build_data.py --source-dir zips/  # utilise des ZIP locaux (mêmes noms de fichiers)
  python scripts/build_data.py --no-fulltext       # n'essaie pas de récupérer les textes intégraux

Chaque section est indépendante : si une source est indisponible, les fichiers
existants de cette section sont conservés et le script continue.
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable, Iterator

LOG = logging.getLogger("build_data")

LEGISLATURE = "17"
BASE = f"https://data.assemblee-nationale.fr/static/openData/repository/{LEGISLATURE}"
SOURCES = {
    "amo10": f"{BASE}/amo/deputes_actifs_mandats_actifs_organes/AMO10_deputes_actifs_mandats_actifs_organes.json.zip",
    "amo20": f"{BASE}/amo/deputes_senateurs_ministres_legislature/AMO20_dep_sen_min_tous_mandats_et_organes.json.zip",
    "dossiers": f"{BASE}/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip",
    "scrutins": f"{BASE}/loi/scrutins/Scrutins.json.zip",
    "questions_ecrites": f"{BASE}/questions/questions_ecrites/Questions_ecrites.json.zip",
    "questions_gouvernement": f"{BASE}/questions/questions_gouvernement/Questions_gouvernement.json.zip",
    "questions_orales": f"{BASE}/questions/questions_orales_sans_debat/Questions_orales_sans_debat.json.zip",
}
FULLTEXT_URL = "https://www.assemblee-nationale.fr/dyn/docs/{uid}.raw"
AN_SITE = "https://www.assemblee-nationale.fr"
USER_AGENT = "assemblee-nationale-explorer/1.0 (+https://github.com/mr-robotpy/assemblee-nationale-explorer)"

ORGANE_TYPES = {
    "ASSEMBLEE": "Assemblée nationale",
    "BUREAU": "Bureau de l'Assemblée",
    "COMPER": "Commission permanente",
    "CNPE": "Commission d'enquête",
    "CNPS": "Commission spéciale",
    "CMP": "Commission mixte paritaire",
    "COMNL": "Autre commission / comité",
    "CONFPT": "Conférence des présidents",
    "DELEG": "Délégation",
    "DELEGBUREAU": "Délégation du Bureau",
    "GA": "Groupe d'amitié",
    "GE": "Groupe d'études",
    "GEVI": "Groupe d'études à vocation internationale",
    "GP": "Groupe politique",
    "MISINFO": "Mission d'information",
    "OFFPAR": "Office parlementaire",
    "ORGEXTPARL": "Organisme extra-parlementaire",
    "PARPOL": "Parti politique",
    "API": "Assemblée parlementaire internationale",
    "COMSENAT": "Commission du Sénat",
    "GOUVERNEMENT": "Gouvernement",
    "MINISTERE": "Ministère",
}


# --------------------------------------------------------------------------- utilitaires

def as_list(x: Any) -> list:
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def txt(x: Any) -> str | None:
    """Valeur texte d'un champ AN (gère {"#text": ...} et null)."""
    if x is None:
        return None
    if isinstance(x, dict):
        return txt(x.get("#text"))
    s = str(x).strip()
    return s or None


def d10(s: Any) -> str | None:
    s = txt(s)
    return s[:10] if s and len(s) >= 10 else None


def get(obj: Any, *path: str) -> Any:
    for p in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(p)
    return obj


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    if path.exists() and path.read_text(encoding="utf-8") == data:
        return
    path.write_text(data, encoding="utf-8")


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)


def http_get(url: str, timeout: int = 300, retries: int = 4) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            last = e
        except Exception as e:  # réseau, timeout…
            last = e
        wait = 2 ** (attempt + 1)
        LOG.warning("Échec %s (%s), nouvel essai dans %ss", url, last, wait)
        time.sleep(wait)
    raise RuntimeError(f"Téléchargement impossible : {url}: {last}")


def download_file(url: str, target: Path, attempts: int = 10, timeout: int = 120) -> None:
    """Télécharge un gros fichier par blocs, en reprenant là où la connexion a coupé (en-tête Range).

    Le serveur de l'AN coupe régulièrement les transferts de plusieurs dizaines de Mo :
    un simple ré-essai complet échoue de la même façon, la reprise partielle non.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    part.unlink(missing_ok=True)
    total: int | None = None
    last: Exception | None = None
    for attempt in range(attempts):
        done = part.stat().st_size if part.exists() else 0
        if total is not None and done >= total:
            break
        headers = {"User-Agent": USER_AGENT}
        if done:
            headers["Range"] = f"bytes={done}-"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if done and r.status != 206:  # reprise non supportée : on repart de zéro
                    LOG.warning("Reprise refusée par le serveur pour %s, téléchargement complet", url)
                    done = 0
                    part.unlink(missing_ok=True)
                if r.status == 206:
                    m = re.search(r"/(\d+)$", r.headers.get("Content-Range", ""))
                    total = int(m.group(1)) if m else total
                elif r.headers.get("Content-Length"):
                    total = int(r.headers["Content-Length"])
                with open(part, "ab") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
            size = part.stat().st_size
            if total is None or size >= total:
                part.replace(target)
                return
            last = RuntimeError(f"{size}/{total} octets reçus")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            if e.code == 416:  # plage invalide : fichier changé côté serveur, on recommence
                part.unlink(missing_ok=True)
                total = None
            last = e
        except Exception as e:  # coupure réseau, timeout, IncompleteRead…
            last = e
        got = part.stat().st_size if part.exists() else 0
        wait = min(2 ** (attempt + 1), 30)
        LOG.warning("Transfert interrompu %s (%s) — %.1f/%s Mo reçus, reprise dans %ss", url.rsplit("/", 1)[1], last,
                    got / 1e6, f"{total / 1e6:.1f}" if total else "?", wait)
        time.sleep(wait)
    if part.exists() and total is not None and part.stat().st_size >= total:
        part.replace(target)
        return
    raise RuntimeError(f"Téléchargement impossible : {url}: {last}")


def iter_zip_json(path: Path) -> Iterator[tuple[str, Any]]:
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if not name.endswith(".json"):
                continue
            with zf.open(name) as f:
                try:
                    yield name, json.load(f)
                except json.JSONDecodeError:
                    LOG.warning("JSON invalide ignoré : %s", name)


def unwrap(obj: Any, key: str) -> Any:
    if isinstance(obj, dict) and key in obj and isinstance(obj[key], dict):
        return obj[key]
    return obj


# --------------------------------------------------------------------------- HTML

class _Sanitizer(HTMLParser):
    """Ne garde qu'une liste blanche de balises, sans aucun attribut."""

    ALLOWED = {"p", "br", "strong", "b", "i", "em", "u", "ul", "ol", "li", "h2", "h3", "h4", "h5",
               "blockquote", "table", "thead", "tbody", "tr", "td", "th", "sup", "sub", "div"}
    RENAME = {"h1": "h2", "h6": "h5"}
    SKIP = {"script", "style", "head", "title", "noscript", "iframe", "object", "svg", "math"}
    VOID = {"br"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = self.RENAME.get(tag, tag)
        if tag in self.SKIP:
            self.skip += 1
            return
        if self.skip or tag not in self.ALLOWED:
            return
        self.out.append(f"<{tag}>")
        if tag not in self.VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag == "br" and not self.skip:
            self.out.append("<br>")

    def handle_endtag(self, tag):
        tag = self.RENAME.get(tag, tag)
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag not in self.stack:
            return
        while self.stack:
            t = self.stack.pop()
            self.out.append(f"</{t}>")
            if t == tag:
                break

    def handle_data(self, data):
        if not self.skip:
            self.out.append(html.escape(data, quote=False))

    def result(self) -> str:
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        s = "".join(self.out)
        s = re.sub(r"<(p|div|strong|b|i|em|u|li)>\s*</\1>", "", s)
        s = re.sub(r"(\s*<br>\s*){3,}", "<br><br>", s)
        s = re.sub(r"[ \t\r\f\v]+", " ", s)
        return s.strip()


def sanitize_html(raw: str | None) -> str | None:
    if not raw:
        return None
    p = _Sanitizer()
    p.feed(raw)
    p.close()
    return p.result() or None


def html_to_text(raw: str | None) -> str:
    if not raw:
        return ""
    s = re.sub(r"<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


# --------------------------------------------------------------------------- acteurs / organes

class Referentiel:
    """Noms des acteurs et libellés des organes, toutes sources confondues."""

    def __init__(self) -> None:
        self.acteurs: dict[str, dict] = {}   # uid -> acteur brut (AMO10)
        self.names: dict[str, str] = {}      # uid -> "Prénom Nom"
        self.organes: dict[str, dict] = {}   # uid -> organe brut

    def load_amo(self, path: Path, keep_acteurs: bool) -> None:
        for name, obj in iter_zip_json(path):
            if "acteur" in obj or "etatCivil" in obj:
                a = unwrap(obj, "acteur")
                uid = txt(a.get("uid"))
                ident = get(a, "etatCivil", "ident") or {}
                if uid:
                    self.names[uid] = f"{txt(ident.get('prenom')) or ''} {txt(ident.get('nom')) or ''}".strip()
                    if keep_acteurs:
                        self.acteurs[uid] = a
            elif "organe" in obj or "codeType" in obj:
                o = unwrap(obj, "organe")
                uid = txt(o.get("uid"))
                if uid:
                    self.organes.setdefault(uid, o)

    def name(self, uid: str | None) -> str | None:
        return self.names.get(uid) if uid else None

    def organe_label(self, uid: str | None, short: bool = False) -> str | None:
        o = self.organes.get(uid or "")
        if not o:
            return None
        if short:
            return txt(o.get("libelleAbrev")) or txt(o.get("libelleAbrege")) or txt(o.get("libelle"))
        return txt(o.get("libelle"))


def photo_url(uid: str) -> str:
    return f"{AN_SITE}/dyn/static/tribun/{LEGISLATURE}/photos/carre/{uid.removeprefix('PA')}.jpg"


def _contacts(acteur: dict) -> dict:
    emails, sites, socials, postal = [], [], [], []
    for a in as_list(get(acteur, "adresses", "adresse")):
        kind = a.get("@xsi:type", "")
        label = txt(a.get("typeLibelle")) or ""
        val = txt(a.get("valElec"))
        if kind.startswith("AdresseMail") and val:
            emails.append(val)
        elif kind.startswith("AdresseSiteWeb") and val:
            low = label.lower()
            if any(k in low for k in ("twitter", "facebook", "instagram", "linkedin", "bluesky", "mastodon", "tiktok", "youtube")):
                url = val
                if not url.startswith("http"):
                    handle = url.lstrip("@")
                    base = {"twitter": "https://x.com/", "facebook": "https://www.facebook.com/",
                            "instagram": "https://www.instagram.com/", "linkedin": "https://www.linkedin.com/in/"}
                    url = next((b + handle for k, b in base.items() if k in low), None)
                if url:
                    socials.append({"label": label, "url": url})
            else:
                sites.append(val if val.startswith("http") else f"https://{val}")
        elif kind.startswith("AdressePostale"):
            parts = [txt(a.get(k)) for k in ("intitule", "numeroRue", "nomRue", "complementAdresse", "codePostal", "ville")]
            line = " ".join(p for p in parts if p)
            if line:
                postal.append({"label": label, "adresse": line.replace(", ", " ").replace(",", "")})
    return {"emails": emails, "sites": sites, "reseaux": socials, "adresses": postal}


def build_deputes(ref: Referentiel) -> tuple[list[dict], dict[str, dict], list[dict]]:
    """Retourne (liste résumée, fiches détaillées, groupes)."""
    summaries: list[dict] = []
    details: dict[str, dict] = {}

    for uid, a in ref.acteurs.items():
        mandats = as_list(get(a, "mandats", "mandat"))
        current = [m for m in mandats if not txt(m.get("dateFin"))]
        an = next((m for m in current if m.get("typeOrgane") == "ASSEMBLEE" and txt(m.get("legislature")) == LEGISLATURE), None)
        if not an:
            continue
        ident = get(a, "etatCivil", "ident") or {}
        naissance = get(a, "etatCivil", "infoNaissance") or {}
        lieu = get(an, "election", "lieu") or {}

        def organes_of(m: dict) -> list[str]:
            return [r for r in as_list(get(m, "organes", "organeRef")) if r]

        gp_m = next((m for m in current if m.get("typeOrgane") == "GP"), None)
        gp_ref = organes_of(gp_m)[0] if gp_m and organes_of(gp_m) else None
        gp = ref.organes.get(gp_ref or "", {})
        parti_m = next((m for m in current if m.get("typeOrgane") == "PARPOL"), None)
        com_m = next((m for m in current if m.get("typeOrgane") == "COMPER"), None)
        com_ref = organes_of(com_m)[0] if com_m and organes_of(com_m) else None

        organes = []
        for m in current:
            t = m.get("typeOrgane")
            if t in ("ASSEMBLEE", "GP", "PARPOL"):
                continue
            for oref in organes_of(m):
                organes.append({
                    "uid": oref,
                    "type": t,
                    "typeLibelle": ORGANE_TYPES.get(t, t),
                    "libelle": ref.organe_label(oref) or oref,
                    "qualite": txt(get(m, "infosQualite", "libQualiteSex")) or txt(get(m, "infosQualite", "codeQualite")),
                    "depuis": d10(m.get("dateDebut")),
                })
        organes.sort(key=lambda o: (list(ORGANE_TYPES).index(o["type"]) if o["type"] in ORGANE_TYPES else 99, o["libelle"]))

        civ = txt(ident.get("civ")) or ""
        num_dep = txt(lieu.get("numDepartement"))
        num_circo = txt(lieu.get("numCirco"))
        summary = {
            "uid": uid,
            "civ": civ,
            "prenom": txt(ident.get("prenom")),
            "nom": txt(ident.get("nom")),
            "nomTri": txt(ident.get("alpha")) or txt(ident.get("nom")),
            "sexe": "F" if civ.startswith("Mme") else "H",
            "groupe": txt(gp.get("libelleAbrev")) or txt(gp.get("libelleAbrege")),
            "groupeUid": gp_ref,
            "departement": txt(lieu.get("departement")),
            "numDepartement": num_dep,
            "circo": num_circo,
            "region": txt(lieu.get("region")),
            "commission": ref.organe_label(com_ref, short=False),
            "commissionAbrev": ref.organe_label(com_ref, short=True),
            "photo": photo_url(uid),
        }
        detail = {
            **summary,
            "naissance": {
                "date": d10(naissance.get("dateNais")),
                "ville": txt(naissance.get("villeNais")),
                "departement": txt(naissance.get("depNais")),
                "pays": txt(naissance.get("paysNais")),
            },
            "profession": txt(get(a, "profession", "libelleCourant")),
            "groupeLibelle": txt(gp.get("libelle")),
            "groupeQualite": txt(get(gp_m, "infosQualite", "codeQualite")) if gp_m else None,
            "parti": ref.organe_label((organes_of(parti_m) or [None])[0]) if parti_m else None,
            "mandat": {
                "uid": txt(an.get("uid")),
                "debut": d10(an.get("dateDebut")),
                "cause": txt(get(an, "election", "causeMandat")),
                "premiereElection": txt(get(an, "mandature", "premiereElection")) == "1",
                "placeHemicycle": txt(get(an, "mandature", "placeHemicycle")),
            },
            "organes": organes,
            "contacts": _contacts(a),
            "liens": {
                "an": f"{AN_SITE}/dyn/deputes/{uid}",
                "hatvp": txt(a.get("uri_hatvp")),
            },
        }
        summaries.append(summary)
        details[uid] = detail

    summaries.sort(key=lambda d: (d["nomTri"] or "").lower())

    by_group: dict[str, list[dict]] = defaultdict(list)
    for d in summaries:
        by_group[d["groupeUid"] or "NI"].append(d)
    groupes = []
    for guid, members in by_group.items():
        o = ref.organes.get(guid, {})
        groupes.append({
            "uid": guid,
            "abrev": txt(o.get("libelleAbrev")) or ("NI" if guid == "NI" else guid),
            "libelle": txt(o.get("libelle")) or "Non inscrits",
            "couleur": txt(o.get("couleurAssociee")) or "#94a3b8",
            "sieges": len(members),
            "femmes": sum(1 for m in members if m["sexe"] == "F"),
            "preseance": int(txt(o.get("preseance")) or 99),
        })
    groupes.sort(key=lambda g: -g["sieges"])
    return summaries, details, groupes


# --------------------------------------------------------------------------- scrutins

def build_scrutins(path: Path, ref: Referentiel, details: dict[str, dict], max_recent: int, recent_votes_per_depute: int) -> tuple[list[dict], dict]:
    scrutins = [unwrap(obj, "scrutin") for _, obj in iter_zip_json(path)]
    scrutins = [s for s in scrutins if isinstance(s, dict) and s.get("uid")]
    scrutins.sort(key=lambda s: int(txt(s.get("numero")) or 0), reverse=True)

    stats = {uid: {"votes": 0, "eligibles": 0, "alignes": 0, "positions": 0} for uid in details}
    recent: dict[str, list] = defaultdict(list)
    debut = {uid: d["mandat"]["debut"] or "0000" for uid, d in details.items()}
    out = []

    for idx, s in enumerate(scrutins):
        date = d10(s.get("dateScrutin"))
        numero = int(txt(s.get("numero")) or 0)
        for uid in details:
            if date and date >= debut[uid]:
                stats[uid]["eligibles"] += 1
        groupes_out = []
        for g in as_list(get(s, "ventilationVotes", "organe", "groupes", "groupe")):
            vote = g.get("vote") or {}
            maj = txt(vote.get("positionMajoritaire"))
            dv = vote.get("decompteVoix") or {}
            nomin = vote.get("decompteNominatif") or {}
            for key, pos in (("pours", "pour"), ("contres", "contre"), ("abstentions", "abstention")):
                for v in as_list(get(nomin, key, "votant")):
                    aref = txt(v.get("acteurRef"))
                    if aref not in stats:
                        continue
                    st = stats[aref]
                    st["votes"] += 1
                    if maj in ("pour", "contre", "abstention"):
                        st["positions"] += 1
                        st["alignes"] += int(maj == pos)
                    if idx < max_recent and len(recent[aref]) < recent_votes_per_depute:
                        recent[aref].append({"uid": s["uid"], "numero": numero, "date": date,
                                             "titre": txt(s.get("titre")), "position": pos,
                                             "sort": txt(get(s, "sort", "code"))})
            if idx < max_recent:
                o = ref.organes.get(txt(g.get("organeRef")) or "", {})
                groupes_out.append({
                    "uid": txt(g.get("organeRef")),
                    "abrev": txt(o.get("libelleAbrev")) or txt(g.get("organeRef")),
                    "couleur": txt(o.get("couleurAssociee")),
                    "membres": int(txt(g.get("nombreMembresGroupe")) or 0),
                    "position": maj,
                    "pour": int(txt(dv.get("pour")) or 0),
                    "contre": int(txt(dv.get("contre")) or 0),
                    "abstention": int(txt(dv.get("abstentions")) or 0),
                    "nonVotant": int(txt(dv.get("nonVotants")) or 0),
                })
        if idx < max_recent:
            dec = get(s, "syntheseVote", "decompte") or {}
            out.append({
                "uid": s["uid"],
                "numero": numero,
                "date": date,
                "titre": txt(s.get("titre")) or txt(get(s, "objet", "libelle")),
                "type": txt(get(s, "typeVote", "libelleTypeVote")),
                "sort": txt(get(s, "sort", "code")),
                "demandeur": txt(get(s, "demandeur", "texte")),
                "votants": int(txt(get(s, "syntheseVote", "nombreVotants")) or 0),
                "exprimes": int(txt(get(s, "syntheseVote", "suffragesExprimes")) or 0),
                "requis": int(txt(get(s, "syntheseVote", "nbrSuffragesRequis")) or 0),
                "pour": int(txt(dec.get("pour")) or 0),
                "contre": int(txt(dec.get("contre")) or 0),
                "abstention": int(txt(dec.get("abstentions")) or 0),
                "groupes": sorted(groupes_out, key=lambda g: -g["membres"]),
                "url": f"{AN_SITE}/dyn/{LEGISLATURE}/scrutins/{numero}",
            })

    for uid, st in stats.items():
        details[uid]["scrutins"] = {
            "votes": st["votes"],
            "eligibles": st["eligibles"],
            "participation": round(100 * st["votes"] / st["eligibles"], 1) if st["eligibles"] else None,
            "loyaute": round(100 * st["alignes"] / st["positions"], 1) if st["positions"] else None,
            "derniers": recent.get(uid, []),
        }
    return out, {"total": len(scrutins), "dernier": d10(scrutins[0].get("dateScrutin")) if scrutins else None}


# --------------------------------------------------------------------------- dossiers législatifs

PHASES = {
    "AN1": "1re lecture — Assemblée", "SN1": "1re lecture — Sénat",
    "AN2": "2e lecture — Assemblée", "SN2": "2e lecture — Sénat",
    "AN3": "3e lecture — Assemblée", "SN3": "3e lecture — Sénat",
    "ANNLEC": "Nouvelle lecture — Assemblée", "SNNLEC": "Nouvelle lecture — Sénat",
    "ANLDEF": "Lecture définitive — Assemblée", "ANLUNI": "Lecture unique — Assemblée",
    "SNLUNI": "Lecture unique — Sénat",
    "CMP": "Commission mixte paritaire", "CC": "Conseil constitutionnel", "PROM": "Promulgation",
    "EU": "Union européenne", "AN20": "Assemblée", "AN21": "Assemblée",
}


def _category(proc: str | None) -> str:
    p = (proc or "").lower()
    if p.startswith("projet de loi"):
        return "PJL"
    if p.startswith("proposition de loi"):
        return "PPL"
    return "AUTRE"


def _step(codes: set[str]) -> int:
    if any(c.startswith("PROM") for c in codes):
        return 5
    if any(c.startswith(("SN", "CMP", "AN2", "ANNLEC", "ANLDEF", "CC")) for c in codes):
        return 4
    if any("-DEBATS" in c for c in codes):
        return 3
    if any("-COM" in c for c in codes):
        return 2
    return 1


CHAMBRES = {"AN": "à l'Assemblée", "SN": "au Sénat", "CMP": "en commission mixte paritaire",
            "CC": "au Conseil constitutionnel"}


def _chambre(code: str) -> str | None:
    for prefix in ("CMP", "CC", "AN", "SN"):  # CMP/CC avant AN/SN (préfixes plus longs d'abord)
        if code.startswith(prefix):
            return prefix
    return None


def _statut_contextualise(decision: dict | None, realises: list[dict], prochaine: dict | None,
                          debut_phase: dict[str, str] | None = None) -> str:
    """« Adopté au Sénat — examen à l'Assemblée en cours » plutôt qu'un « Adopté » sans contexte."""
    courant = realises[-1] if realises else None
    if decision is None:
        lieu = CHAMBRES.get(_chambre(courant["code"]) if courant else "", "")
        return f"En cours d'examen {lieu}".strip() if courant and len(realises) > 1 else "Déposé"
    statut = decision["statut"].strip()
    statut = statut[0].upper() + statut[1:]
    ch = _chambre(decision["code"])
    label = f"{statut} {CHAMBRES[ch]}" if ch in CHAMBRES else statut
    # L'examen continue-t-il ? Seulement si une NOUVELLE lecture s'est ouverte après la décision
    # (une réunion tardive rattachée à une lecture antérieure ne compte pas).
    debut_phase = debut_phase or {}

    def nouvelle_lecture(a: dict | None) -> bool:
        return bool(a) and a["phase"] != decision["phase"] and debut_phase.get(a["phase"], "") >= decision["date"]

    suite = courant if nouvelle_lecture(courant) else (prochaine if nouvelle_lecture(prochaine) else None)
    if suite and _chambre(suite["code"]) in ("AN", "SN"):
        label += f" — examen {CHAMBRES[_chambre(suite['code'])]} en cours"
    return label


def _doc_links(uid: str) -> dict:
    if "ANR5" not in uid:
        return {}
    return {
        "pdf": f"{AN_SITE}/dyn/opendata/{uid}.pdf",
        "html": f"{AN_SITE}/dyn/opendata/{uid}.html",
    }


def _flatten_actes(node: Any, phase: str | None, ref: Referentiel, acc: list[dict]) -> None:
    for a in as_list(get(node, "acteLegislatif") if isinstance(node, dict) else node):
        if not isinstance(a, dict):
            continue
        code = txt(a.get("codeActe")) or ""
        this_phase = phase or PHASES.get(code, code)
        children = a.get("actesLegislatifs")
        textes = []
        for key in ("texteAssocie", "texteAdopte"):
            if txt(a.get(key)):
                textes.append(txt(a.get(key)))
        for t in as_list(get(a, "textesAssocies", "texteAssocie")):
            if isinstance(t, dict) and txt(t.get("refTexteAssocie")):
                textes.append(txt(t.get("refTexteAssocie")))
        rapporteurs = [ref.name(txt(r.get("acteurRef")))
                       for r in as_list(get(a, "rapporteurs", "rapporteur")) if isinstance(r, dict)]
        votes = [txt(v) for v in as_list(get(a, "voteRefs", "voteRef")) if txt(v)]
        date = txt(a.get("dateActe"))
        if date or not children:
            acc.append({
                "code": code,
                "phase": this_phase,
                "libelle": txt(get(a, "libelleActe", "nomCanonique")) or code,
                "date": d10(date),
                "organe": ref.organe_label(txt(a.get("organeRef"))),
                "statut": txt(get(a, "statutConclusion", "libelle")) or txt(get(a, "decision", "libelle")),
                "textes": textes,
                "rapporteurs": [r for r in rapporteurs if r],
                "scrutins": votes,
                "infoJO": txt(get(a, "infoJO", "urlLegifrance")) or txt(get(a, "infoJORect", "urlLegifrance")),
            })
        if children:
            _flatten_actes(children, this_phase, ref, acc)


def build_dossiers(path: Path, ref: Referentiel, max_dossiers: int, categories: set[str],
                   today: str | None = None) -> tuple[list[dict], dict[str, dict], dict]:
    """`today` (AAAA-MM-JJ, défaut : date UTC du jour) sépare les actes accomplis des actes programmés :
    l'agenda publié par l'AN contient des séances futures, qui ne sont pas une « dernière activité »."""
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    dossiers: list[dict] = []
    documents: dict[str, dict] = {}
    for name, obj in iter_zip_json(path):
        if "dossierParlementaire" in obj:
            dossiers.append(obj["dossierParlementaire"])
        elif "document" in obj:
            d = obj["document"]
            uid = txt(d.get("uid"))
            if not uid:
                continue
            auteurs = []
            for au in as_list(get(d, "auteurs", "auteur")):
                aref = txt(get(au, "acteur", "acteurRef"))
                oref = txt(get(au, "organe", "organeRef"))
                if aref:
                    auteurs.append(ref.name(aref) or aref)
                elif oref:
                    auteurs.append(ref.organe_label(oref) or oref)
            documents[uid] = {
                "uid": uid,
                "titre": txt(get(d, "titres", "titrePrincipalCourt")) or txt(get(d, "titres", "titrePrincipal")),
                "titreLong": txt(get(d, "titres", "titrePrincipal")),
                "type": txt(get(d, "classification", "type", "libelle")) or txt(d.get("denominationStructurelle")),
                "typeCode": txt(get(d, "classification", "type", "code")),
                "date": d10(get(d, "cycleDeVie", "chrono", "dateDepot")) or d10(get(d, "cycleDeVie", "chrono", "dateCreation")),
                "auteurs": auteurs[:12],
                "auteursRefs": [txt(get(au, "acteur", "acteurRef")) for au in as_list(get(d, "auteurs", "auteur")) if txt(get(au, "acteur", "acteurRef"))],
                "dossierRef": txt(d.get("dossierRef")),
                "numNotice": txt(get(d, "notice", "numNotice")),
            }

    built = []
    stats = Counter()
    for d in dossiers:
        uid = txt(d.get("uid"))
        if not uid:
            continue
        proc = txt(get(d, "procedureParlementaire", "libelle"))
        cat = _category(proc)
        stats[cat] += 1
        actes: list[dict] = []
        _flatten_actes(d.get("actesLegislatifs"), None, ref, actes)
        # Accompli : date passée. Date du jour : accompli seulement si la décision de cette lecture est déjà
        # publiée (sinon la séance n'a peut-être pas encore eu lieu à l'heure de la génération). Futur : programmé.
        decide_ce_jour = {a["phase"] for a in actes if a["date"] == today and a["statut"]}
        for a in actes:
            a["prevu"] = bool(a["date"]) and (a["date"] > today or (a["date"] == today and a["phase"] not in decide_ce_jour))
        dated = sorted((a for a in actes if a["date"]), key=lambda a: a["date"])
        realises = [a for a in dated if not a["prevu"]]
        prevus = [a for a in dated if a["prevu"]]
        phases_ouvertes = {a["phase"] for a in realises}
        # actes non datés (nominations…) : comptés seulement si leur lecture a déjà commencé
        codes = {a["code"] for a in realises} | {a["code"] for a in actes if not a["date"] and a["phase"] in phases_ouvertes}
        if any(c.startswith("PROM") for c in codes):
            stats[f"{cat}_promulgues"] += 1
        if cat not in categories:
            continue
        initiateurs = [ref.name(txt(x.get("acteurRef"))) or txt(x.get("acteurRef"))
                       for x in as_list(get(d, "initiateur", "acteurs", "acteur")) if isinstance(x, dict)]
        initiateurs += [ref.organe_label(txt(x.get("organeRef"))) or txt(x.get("organeRef"))
                        for x in as_list(get(d, "initiateur", "organes", "organe")) if isinstance(x, dict)]
        initiateurs = [i for i in initiateurs if i and not re.fullmatch(r"P[AO]\d+", i)]
        if not initiateurs and cat == "PJL":
            initiateurs = ["Gouvernement"]
        texte_ids: list[str] = []
        for a in actes:
            for t in a["textes"]:
                if t not in texte_ids:
                    texte_ids.append(t)
        for doc in documents.values():
            if doc["dossierRef"] == uid and doc["uid"] not in texte_ids:
                texte_ids.append(doc["uid"])
        docs = []
        for t in texte_ids:
            meta = documents.get(t, {"uid": t, "titre": None, "type": None, "date": None, "auteurs": []})
            docs.append({k: meta.get(k) for k in ("uid", "titre", "type", "date", "auteurs")} | {"liens": _doc_links(t)})
        depot = next((a for a in actes if a["code"].endswith("-DEPOT") and a["textes"]), None)
        texte_principal = depot["textes"][0] if depot else (texte_ids[0] if texte_ids else None)
        last = realises[-1] if realises else None
        prochaine = prevus[0] if prevus else None
        promulgue = next((a for a in realises if a["code"].startswith("PROM")), None)
        decision = next((a for a in reversed(realises) if a["statut"]), None)
        debut_phase: dict[str, str] = {}
        for a in dated:
            debut_phase.setdefault(a["phase"], a["date"])
        principal_meta = documents.get(texte_principal or "", {})
        titre_chemin = txt(get(d, "titreDossier", "titreChemin"))
        built.append({
            "uid": uid,
            "titre": txt(get(d, "titreDossier", "titre")),
            "procedure": proc,
            "categorie": cat,
            "initiateurs": initiateurs[:15],
            "nbInitiateurs": len(initiateurs),
            "dateDepot": dated[0]["date"] if dated else None,
            "dateMaj": last["date"] if last else None,
            "etape": _step(codes),
            "derniereEtape": (f"{last['phase']} · {last['libelle']}" if last else None),
            "prochaineEtape": ({"date": prochaine["date"], "libelle": f"{prochaine['phase']} · {prochaine['libelle']}"}
                               if prochaine else None),
            "statut": ("Promulguée" if promulgue else _statut_contextualise(decision, realises, prochaine, debut_phase)),
            "statutDecision": (decision["statut"] if decision and not promulgue else None),
            "donneesDu": today,
            "procedureAcceleree": any(c.endswith("-PROCACC") for c in codes),
            "textePrincipal": texte_principal,
            "resume": principal_meta.get("titreLong"),
            "actes": actes,
            "documents": docs,
            "liens": {
                "an": f"{AN_SITE}/dyn/{LEGISLATURE}/dossiers/{titre_chemin}" if titre_chemin else None,
                "senat": txt(get(d, "titreDossier", "senatChemin")),
                "legifrance": next((a["infoJO"] for a in actes if a["infoJO"]), None),
            },
        })

    built.sort(key=lambda x: (x["dateMaj"] or "", x["uid"]), reverse=True)
    # Tous les projets de loi (Gouvernement, peu nombreux) sont publiés ; les propositions et autres
    # procédures complètent, des plus récemment actives aux plus anciennes, jusqu'au plafond.
    projets = [b for b in built if b["categorie"] == "PJL"]
    autres = [b for b in built if b["categorie"] != "PJL"][:max(0, max_dossiers - len(projets))]
    keep = {b["uid"] for b in projets + autres}
    built = [b for b in built if b["uid"] in keep]
    index = [{k: b[k] for k in ("uid", "titre", "procedure", "categorie", "initiateurs", "nbInitiateurs", "dateDepot",
                                 "dateMaj", "etape", "derniereEtape", "prochaineEtape", "statut", "statutDecision",
                                 "procedureAcceleree", "resume")}
             for b in built]
    for i in index:
        i["initiateurs"] = i["initiateurs"][:3]
    by_uid = {b["uid"]: b for b in built}
    # propositions de loi déposées par député (tous dossiers, pas seulement ceux affichés)
    ppl_par_depute = Counter()
    for doc in documents.values():
        if doc.get("typeCode") == "PION":
            for aref in doc["auteursRefs"][:1]:
                ppl_par_depute[aref] += 1
    meta = {"total": dict(stats), "pplParDepute": dict(ppl_par_depute)}
    return index, by_uid, meta


def fetch_fulltexts(dossiers: dict[str, dict], textes_dir: Path, max_new: int, delay: float) -> int:
    """Récupère (une seule fois) le texte intégral du texte principal des dossiers affichés."""
    textes_dir.mkdir(parents=True, exist_ok=True)
    ordered = sorted(dossiers.values(), key=lambda d: d.get("dateMaj") or "", reverse=True)
    wanted = [d["textePrincipal"] for d in ordered if d.get("textePrincipal") and "ANR5" in d["textePrincipal"]]
    wanted_set = set(wanted)
    for f in textes_dir.glob("*.json"):  # nettoyage des textes qui ne sont plus référencés
        if f.stem not in wanted_set:
            f.unlink()
    fetched = 0
    for uid in dict.fromkeys(wanted):
        target = textes_dir / f"{uid}.json"
        if target.exists():
            continue
        if fetched >= max_new:
            break
        try:
            raw = http_get(FULLTEXT_URL.format(uid=uid), timeout=60, retries=2).decode("utf-8", errors="replace")
        except Exception as e:
            LOG.info("Texte intégral indisponible pour %s : %s", uid, e)
            continue
        body = re.search(r"<body[^>]*>(.*)</body>", raw, re.S | re.I)
        clean = sanitize_html(body.group(1) if body else raw)
        fetched += 1
        if not clean or len(html_to_text(clean)) < 200:
            continue
        truncated = len(clean) > 600_000
        write_json(target, {"uid": uid, "source": FULLTEXT_URL.format(uid=uid),
                            "recupereLe": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                            "tronque": truncated, "html": clean[:600_000]})
        time.sleep(delay)
    for d in dossiers.values():
        d["texteIntegral"] = (textes_dir / f"{d['textePrincipal']}.json").exists() if d.get("textePrincipal") else False
    return fetched


# --------------------------------------------------------------------------- questions

QTYPES = {"QE": "Question écrite", "QG": "Question au Gouvernement", "QOSD": "Question orale sans débat"}


def _texts(node: Any, key: str) -> list[dict]:
    out = []
    for t in as_list(get(node, key)):
        if not isinstance(t, dict):
            continue
        out.append({
            "date": d10(get(t, "infoJO", "dateJO")),
            "page": txt(get(t, "infoJO", "pageJO")),
            "legifrance": txt(get(t, "infoJO", "urlLegifrance")),
            "html": sanitize_html(txt(t.get("texte"))),
        })
    return out


def build_questions(paths: dict[str, Path], ref: Referentiel, max_per_type: dict[str, int]) -> tuple[list[dict], dict[str, dict], dict]:
    index, details = [], {}
    stats = {"total": Counter(), "repondues": Counter(), "ministeres": Counter(), "parDepute": Counter(), "rubriques": Counter()}
    for qtype_key, path in paths.items():
        rows = []
        for _, obj in iter_zip_json(path):
            q = unwrap(obj, "question")
            uid = txt(q.get("uid")) if isinstance(q, dict) else None
            if not uid:
                continue
            qtype = txt(q.get("type")) or qtype_key
            questions = _texts(q.get("textesQuestion"), "texteQuestion")
            reponses = _texts(q.get("textesReponse"), "texteReponse")
            cloture = q.get("cloture") or {}
            min_attribs = as_list(get(q, "minAttribs", "minAttrib"))
            min_attrib = get(min_attribs[-1], "denomination") if min_attribs else None
            aref = txt(get(q, "auteur", "identite", "acteurRef"))
            date = (questions[0]["date"] if questions else None) or d10(get(min_attribs[0], "infoJO", "dateJO") if min_attribs else None) \
                or d10(cloture.get("dateCloture")) or (reponses[0]["date"] if reponses else None)
            num = txt(get(q, "identifiant", "numero"))
            repondue = bool(reponses) or txt(cloture.get("codeCloture")) == "REP_PUB"
            ministere = txt(get(min_attrib, "abrege")) or txt(get(q, "minInt", "abrege"))
            stats["total"][qtype] += 1
            stats["repondues"][qtype] += int(repondue)
            if ministere:
                stats["ministeres"][ministere] += 1
            if aref:
                stats["parDepute"][aref] += 1
            rubrique = txt(get(q, "indexationAN", "rubrique"))
            if rubrique:
                stats["rubriques"][rubrique] += 1
            summary = {
                "uid": uid,
                "type": qtype,
                "numero": num,
                "date": date,
                "rubrique": rubrique,
                "titre": "; ".join(filter(None, map(txt, as_list(get(q, "indexationAN", "analyses", "analyse"))))) or None,
                "auteur": ref.name(aref) or aref,
                "auteurUid": aref,
                "groupe": txt(get(q, "auteur", "groupe", "abrege")),
                "ministere": ministere,
                "statut": "Répondue" if repondue else (txt(cloture.get("libelleCloture")) or "En attente de réponse"),
                "repondue": repondue,
                "dateReponse": reponses[0]["date"] if reponses else None,
            }
            rows.append((summary, {
                **summary,
                "ministereInterroge": txt(get(q, "minInt", "developpe")),
                "ministereAttributaire": txt(get(min_attrib, "developpe")),
                "question": questions,
                "reponse": reponses,
                "cloture": {"code": txt(cloture.get("codeCloture")), "libelle": txt(cloture.get("libelleCloture")),
                            "date": d10(cloture.get("dateCloture"))} if cloture else None,
                "signalement": d10(get(q, "signalement", "dateDepotSignal")),
                "renouvellements": len(as_list(get(q, "renouvellements", "renouvellement"))),
                "liens": {"an": f"https://questions.assemblee-nationale.fr/q{LEGISLATURE}/{LEGISLATURE}-{num}{qtype}.htm" if num else None},
            }))
        rows.sort(key=lambda r: (r[0]["date"] or "", int(r[0]["numero"] or 0)), reverse=True)
        limit = max_per_type.get(qtype_key, 0)
        for s, d in rows[:limit] if limit else rows:
            index.append(s)
            details[s["uid"]] = d
    index.sort(key=lambda s: (s["date"] or "", s["uid"]), reverse=True)
    meta = {
        "total": dict(stats["total"]),
        "repondues": dict(stats["repondues"]),
        "ministeres": stats["ministeres"].most_common(12),
        "rubriques": stats["rubriques"].most_common(12),
        "parDepute": dict(stats["parDepute"]),
    }
    return index, details, meta


# --------------------------------------------------------------------------- orchestration

def fetch_sources(names: Iterable[str], cache: Path, source_dir: Path | None) -> dict[str, Path]:
    cache.mkdir(parents=True, exist_ok=True)
    out = {}
    for name in names:
        url = SOURCES[name]
        filename = url.rsplit("/", 1)[1]
        if source_dir:
            p = source_dir / filename
            if p.exists():
                out[name] = p
            else:
                LOG.warning("Source locale absente : %s", p)
            continue
        target = cache / filename
        try:
            LOG.info("Téléchargement %s", url)
            download_file(url, target)
            with zipfile.ZipFile(target) as zf:
                bad = zf.testzip()
            if bad:
                raise RuntimeError(f"archive corrompue ({bad})")
            out[name] = target
        except Exception as e:
            LOG.error("Source %s indisponible : %s", name, e)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data", type=Path)
    ap.add_argument("--cache", default=".cache", type=Path)
    ap.add_argument("--source-dir", type=Path, help="dossier contenant les ZIP officiels (pas de téléchargement)")
    ap.add_argument("--max-dossiers", type=int, default=int(os.environ.get("MAX_DOSSIERS", 400)))
    ap.add_argument("--max-scrutins", type=int, default=int(os.environ.get("MAX_SCRUTINS", 300)))
    ap.add_argument("--max-qe", type=int, default=int(os.environ.get("MAX_QE", 3000)), help="questions écrites (0 = toutes)")
    ap.add_argument("--max-qg", type=int, default=int(os.environ.get("MAX_QG", 1500)), help="questions au Gouvernement (0 = toutes)")
    ap.add_argument("--max-qosd", type=int, default=int(os.environ.get("MAX_QOSD", 800)), help="questions orales (0 = toutes)")
    ap.add_argument("--fulltext-per-run", type=int, default=int(os.environ.get("FULLTEXT_PER_RUN", 60)))
    ap.add_argument("--no-fulltext", action="store_true")
    ap.add_argument("--all-procedures", action="store_true", help="inclure résolutions, commissions d'enquête…")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    meta_path = out / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    meta.setdefault("sections", {})
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    src = fetch_sources(SOURCES, args.cache, args.source_dir)
    failures = []

    ref = Referentiel()
    if "amo20" in src:
        ref.load_amo(src["amo20"], keep_acteurs=False)
    if "amo10" not in src:
        LOG.error("AMO10 indisponible : impossible de reconstruire les députés, données existantes conservées.")
        failures.append("deputes")
        write_json(meta_path, meta)
        return 1
    ref.load_amo(src["amo10"], keep_acteurs=True)
    summaries, details, groupes = build_deputes(ref)
    LOG.info("%d députés, %d groupes", len(summaries), len(groupes))

    # --- scrutins
    if "scrutins" in src:
        try:
            scrutins, sc_meta = build_scrutins(src["scrutins"], ref, details, args.max_scrutins, 15)
            write_json(out / "scrutins.json", scrutins)
            meta["sections"]["scrutins"] = {"majLe": now, **sc_meta, "affiches": len(scrutins)}
            LOG.info("Scrutins : %d publiés sur %d", len(scrutins), sc_meta["total"])
        except Exception:
            LOG.exception("Échec section scrutins")
            failures.append("scrutins")

    # --- dossiers
    dossiers_meta = {}
    if "dossiers" in src:
        try:
            cats = {"PJL", "PPL", "AUTRE"} if args.all_procedures else {"PJL", "PPL"}
            index, by_uid, dossiers_meta = build_dossiers(src["dossiers"], ref, args.max_dossiers, cats)
            n_txt = 0
            if not args.no_fulltext and not args.source_dir:
                n_txt = fetch_fulltexts(by_uid, out / "textes", args.fulltext_per_run, delay=1.0)
            else:
                for d in by_uid.values():
                    d["texteIntegral"] = bool(d.get("textePrincipal")) and (out / "textes" / f"{d['textePrincipal']}.json").exists()
            for i in index:
                i["texteIntegral"] = by_uid[i["uid"]]["texteIntegral"]
            reset_dir(out / "dossiers")
            for uid, d in by_uid.items():
                write_json(out / "dossiers" / f"{uid}.json", d)
            write_json(out / "dossiers.json", index)
            LOG.info("Dossiers : %d publiés, %d textes intégraux récupérés", len(index), n_txt)
            meta["sections"]["dossiers"] = {"majLe": now, "affiches": len(index), "total": dossiers_meta["total"],
                                            "textesRecuperes": n_txt}
        except Exception:
            LOG.exception("Échec section dossiers")
            failures.append("dossiers")

    # --- questions
    qsources = (("QE", "questions_ecrites"), ("QG", "questions_gouvernement"), ("QOSD", "questions_orales"))
    qpaths = {k: src[n] for k, n in qsources if n in src}
    q_missing = [n for _, n in qsources if n not in src]
    if q_missing:
        failures.append("questions")
        if (out / "questions.json").exists():
            # Reconstruire avec une source en moins effacerait les questions de la veille : on garde tout.
            LOG.error("Questions : %s indisponible(s), section de la veille conservée", ", ".join(q_missing))
            qpaths = {}
        else:
            LOG.error("Questions : %s indisponible(s), publication partielle (premier passage)", ", ".join(q_missing))
    if qpaths:
        try:
            q_index, q_details, q_meta = build_questions(qpaths, ref, {"QE": args.max_qe, "QG": args.max_qg, "QOSD": args.max_qosd})
            reset_dir(out / "questions")
            for uid, q in q_details.items():
                write_json(out / "questions" / f"{uid}.json", q)
            write_json(out / "questions.json", q_index)
            meta["sections"]["questions"] = {"majLe": now, "affiches": len(q_index), "total": q_meta["total"],
                                             "repondues": q_meta["repondues"], "ministeres": q_meta["ministeres"],
                                             "rubriques": q_meta["rubriques"]}
            recent_by_dep: dict[str, list] = defaultdict(list)
            for q in q_index:
                if q["auteurUid"] in details and len(recent_by_dep[q["auteurUid"]]) < 10:
                    recent_by_dep[q["auteurUid"]].append({k: q[k] for k in ("uid", "type", "date", "titre", "ministere", "statut")})
            for uid, d in details.items():
                d["questions"] = {"total": q_meta["parDepute"].get(uid, 0), "dernieres": recent_by_dep.get(uid, [])}
        except Exception:
            LOG.exception("Échec section questions")
            failures.append("questions")
        else:
            LOG.info("Questions : %d publiées sur %d", len(q_index), sum(q_meta["total"].values()))

    # --- députés (écrits en dernier : enrichis par les autres sections)
    # Une section en échec ne doit pas effacer les statistiques de la veille dans les fiches.
    for s in summaries:
        d = details[s["uid"]]
        if dossiers_meta:
            d["propositionsDeLoi"] = dossiers_meta["pplParDepute"].get(s["uid"], 0)
        missing = [k for k in ("scrutins", "questions", "propositionsDeLoi") if k not in d]
        prev_file = out / "deputes" / f"{s['uid']}.json"
        if missing and prev_file.exists():
            prev = json.loads(prev_file.read_text(encoding="utf-8"))
            for k in missing:
                if k in prev:
                    d[k] = prev[k]
        if "questions" in d:
            s["questions"] = d["questions"]["total"]
        if "scrutins" in d:
            s["participation"] = d["scrutins"]["participation"]
    reset_dir(out / "deputes")
    for uid, d in details.items():
        write_json(out / "deputes" / f"{uid}.json", d)
    write_json(out / "deputes.json", summaries)
    write_json(out / "groupes.json", groupes)
    meta["sections"]["deputes"] = {"majLe": now, "total": len(summaries), "femmes": sum(1 for s in summaries if s["sexe"] == "F")}

    meta.update({
        "generation": now,
        "legislature": LEGISLATURE,
        "sources": SOURCES,
        "sourcesIndisponibles": sorted(set(SOURCES) - set(src)),
        "echecs": failures,
        "licence": "Licence Ouverte / Open Licence 2.0 — Assemblée nationale",
    })
    write_json(meta_path, meta)
    LOG.info("Terminé. Échecs : %s", failures or "aucun")
    return 0


if __name__ == "__main__":
    sys.exit(main())
