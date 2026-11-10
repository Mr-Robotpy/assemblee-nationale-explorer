"""Pages statiques (scripts/build_pages.py) : contenu, échappement, plan du site."""
import json
import re
import sys
import tempfile
import unittest
import xml.dom.minidom
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests" / "e2e"))
import build_pages as bp  # noqa: E402
import make_site  # noqa: E402

BASE = "https://exemple.test/site"


class _Structure(HTMLParser):
    """Relève balises, liens et scripts d'une page, pour vérifier ce qu'un navigateur en ferait."""

    def __init__(self):
        super().__init__()
        self.balises, self.liens, self.scripts, self.ressources = [], [], [], []
        self._script = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.balises.append(tag)
        if tag == "a":
            self.liens.append(a.get("href"))
        if tag == "script":
            self._script = a.get("type") or "js"
            self.scripts.append([self._script, ""])
        if tag in ("link", "script", "img") and (a.get("href") or a.get("src")):
            self.ressources.append((a.get("rel"), a.get("href") or a.get("src")))

    def handle_endtag(self, tag):
        if tag == "script":
            self._script = None

    def handle_data(self, data):
        if self._script:
            self.scripts[-1][1] += data


def structure(page: str) -> _Structure:
    s = _Structure()
    s.feed(page)
    return s


class SiteTest(unittest.TestCase):
    """Pages construites depuis les extraits, par la même chaîne que le déploiement."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.site = Path(cls.tmp.name) / "site"
        assert make_site.main(cls.site) == 0
        cls.n = bp.build(cls.site / "data", cls.site, BASE + "/", "abc123")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def lire(self, chemin: str) -> str:
        return (self.site / chemin).read_text(encoding="utf-8")

    def test_une_page_par_depute_et_par_dossier(self):
        self.assertEqual(self.n, {"deputes": 6, "dossiers": 2, "urls": 11})
        self.assertEqual(len(list((self.site / "depute").glob("PA*.html"))), 6)
        self.assertEqual(len(list((self.site / "dossier").glob("DLR*.html"))), 2)

    def test_page_depute(self):
        page = self.lire("depute/PA841495.html")
        self.assertIn("<title>Maxime Amblard, député RN · Meuse (55) · 1re circonscription | ", page)
        self.assertIn(f'<link rel="canonical" href="{BASE}/depute/PA841495.html">', page)
        self.assertIn("<h1>Maxime Amblard</h1>", page)
        self.assertIn('href="../#/depute/PA841495"', page)  # vers la fiche interactive
        self.assertIn("Commission des affaires économiques", page)
        self.assertIn("Scrutin n°4003", page)
        self.assertIn("Soutien aux maraîchers face aux aléas climatiques", page)
        self.assertIn("assets/pages.css?v=abc123", page)
        # Le taux de participation ne s'affiche jamais sans son avertissement.
        self.assertIn("une participation faible ne signifie pas une absence", page)
        self.assertIn("Députée en exercice", self.lire("depute/PA842279.html"))

    def test_page_depute_limitee_au_mandat(self):
        """Ni naissance, ni profession, ni coordonnées sur une page que les moteurs de recherche référencent."""
        fiche = json.loads(self.lire("data/deputes/PA841495.json"))
        page = self.lire("depute/PA841495.html")
        self.assertTrue(fiche["contacts"]["emails"] and fiche["naissance"]["ville"] and fiche["profession"])
        for prive in (*fiche["contacts"]["emails"], fiche["naissance"]["ville"], "1996", fiche["profession"],
                      *(r["url"] for r in fiche["contacts"]["reseaux"]), "Rue de l'Université"):
            self.assertNotIn(prive, page)
            self.assertNotIn(bp.e(prive), page)

    def test_donnees_structurees(self):
        s = structure(self.lire("depute/PA841495.html"))
        ld = [json.loads(corps) for genre, corps in s.scripts if genre == "application/ld+json"]
        self.assertEqual(len(ld), 1)
        self.assertEqual((ld[0]["@type"], ld[0]["name"], ld[0]["jobTitle"]), ("Person", "Maxime Amblard", "Député"))
        self.assertEqual(ld[0]["memberOf"]["name"], "Rassemblement National")
        self.assertEqual(set(ld[0]), {"@context", "@type", "name", "jobTitle", "url", "worksFor", "memberOf", "sameAs"})

    def test_page_dossier(self):
        page = self.lire("dossier/DLR5L17N50173.html")
        self.assertIn("<h1>Approbation des comptes de la sécurité sociale pour l&#x27;année 2023</h1>", page)
        self.assertIn(f'<link rel="canonical" href="{BASE}/dossier/DLR5L17N50173.html">', page)
        self.assertIn("<strong>Rejeté au Sénat</strong>", page)
        self.assertIn('href="../#/dossier/DLR5L17N50173"', page)
        self.assertEqual(page.count('<li class="faite">'), 4)  # étape 4 sur 5 : la promulgation n'est pas franchie
        self.assertIn('<time datetime="2024-07-19">19 juillet 2024</time>', page)
        self.assertIn("Dossier sur le site du Sénat", page)

    def test_aucune_ressource_tierce(self):
        """Comme l'application : ni script, ni feuille de style, ni image d'un autre site ; un seul script, le thème."""
        for chemin in ("depute/PA841495.html", "dossier/DLR5L17N50173.html", "depute/index.html", "dossier/index.html"):
            s = structure(self.lire(chemin))
            for rel, url in s.ressources:
                if rel != "canonical":
                    self.assertFalse(re.match(r"(https?:)?//", url), f"{chemin} charge {url}")
            self.assertEqual([c for g, c in s.scripts if g == "js"], [bp.THEME_JS])
            self.assertNotIn("img", s.balises)

    def test_listes_et_liens_internes(self):
        """Chaque page est reliée au site : listes complètes, et aucun lien interne vers un fichier absent."""
        deputes = structure(self.lire("depute/index.html"))
        self.assertEqual(sorted(h for h in deputes.liens if re.fullmatch(r"PA\d+\.html", h or "")),
                         sorted(f.name for f in (self.site / "depute").glob("PA*.html")))
        dossiers = structure(self.lire("dossier/index.html"))
        self.assertEqual(len([h for h in dossiers.liens if re.fullmatch(r"DLR\w+\.html", h or "")]), 2)
        for page in sorted(self.site.glob("d*/*.html")):
            for h in structure(page.read_text(encoding="utf-8")).liens:
                if h and not re.match(r"https?://", h):
                    cible = (page.parent / h.split("#")[0]).resolve()
                    self.assertTrue((cible / "index.html").is_file() if cible.is_dir() else cible.is_file(),
                                    f"{page.name} → {h}")
        index = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="depute/"', index)  # l'application mène aux listes : les pages ne sont pas orphelines
        self.assertIn('href="dossier/"', index)

    def test_plan_du_site(self):
        dom = xml.dom.minidom.parseString(self.lire("sitemap.xml"))
        locs = [n.firstChild.data for n in dom.getElementsByTagName("loc")]
        self.assertEqual(len(locs), len(set(locs)))
        self.assertEqual(locs[:3], [f"{BASE}/", f"{BASE}/depute/", f"{BASE}/dossier/"])
        for loc in locs[3:]:
            self.assertTrue((self.site / loc[len(BASE) + 1:]).is_file(), loc)
        mods = {u.getElementsByTagName("loc")[0].firstChild.data: u.getElementsByTagName("lastmod")[0].firstChild.data
                for u in dom.getElementsByTagName("url")}
        self.assertEqual(mods[f"{BASE}/dossier/DLR5L17N50173.html"], "2025-02-19")  # date de la dernière étape

    def test_page_404(self):
        page = self.lire("404.html")
        self.assertIn('<meta name="robots" content="noindex">', page)
        self.assertNotIn('rel="canonical"', page)
        # Chemins absolus : la page est servie à n'importe quelle profondeur.
        self.assertIn(f'href="{BASE}/assets/pages.css?v=abc123"', page)
        self.assertIn(f'href="{BASE}/depute/"', page)

    def test_fin_de_mandat_la_page_disparait(self):
        data = self.site / "data"
        avec = json.loads((data / "deputes.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            bp.build(data, out, BASE)
            self.assertTrue((out / "depute" / "PA841495.html").exists())
            sans = out / "data"
            (sans / "deputes").mkdir(parents=True)
            (sans / "deputes.json").write_text(json.dumps([d for d in avec if d["uid"] != "PA841495"]), encoding="utf-8")
            (sans / "groupes.json").write_text((data / "groupes.json").read_text(encoding="utf-8"), encoding="utf-8")
            n = bp.build(sans, out, BASE)  # ni dossiers ni meta : premier passage partiel
            self.assertEqual(n, {"deputes": 5, "dossiers": 0, "urls": 8})
            self.assertFalse((out / "depute" / "PA841495.html").exists())
            self.assertNotIn("PA841495", (out / "sitemap.xml").read_text(encoding="utf-8"))


class AdresseTest(unittest.TestCase):
    def test_adresse_vide_adresse_connue(self):
        """Le déploiement passe l'adresse lue dans GitHub Pages : vide, elle ne doit pas donner d'adresses relatives."""
        with tempfile.TemporaryDirectory() as t:
            site = Path(t) / "site"
            self.assertEqual(make_site.main(site), 0)
            self.assertEqual(bp.main(["--data", str(site / "data"), "--out", str(site), "--base-url", ""]), 0)
            self.assertIn(f"<loc>{bp.BASE_URL}/depute/PA841495.html</loc>", (site / "sitemap.xml").read_text(encoding="utf-8"))
            self.assertEqual(bp.main(["--data", str(site / "absent"), "--out", str(site)]), 1)


class EchappementTest(unittest.TestCase):
    """Les données viennent de l'extérieur : rien ne doit sortir du texte."""

    HOSTILE = '"><script>alert(1)</script><img src=x onerror=alert(2)>'

    def test_depute(self):
        d = {"uid": "PA1", "prenom": self.HOSTILE, "nom": "</title>", "groupe": self.HOSTILE, "groupeUid": "PO1",
             "groupeLibelle": "</script><script>alert(3)</script>", "departement": self.HOSTILE, "numDepartement": "1",
             "circo": "1", "commission": self.HOSTILE, "liens": {"an": "javascript:alert(4)", "hatvp": self.HOSTILE},
             "scrutins": {"votes": 1, "eligibles": 1, "participation": 1.0, "loyaute": None,
                          "derniers": [{"numero": self.HOSTILE, "date": self.HOSTILE, "titre": self.HOSTILE,
                                        "position": self.HOSTILE, "sort": self.HOSTILE}]},
             "questions": {"total": 1, "dernieres": [{"uid": self.HOSTILE, "type": self.HOSTILE, "titre": self.HOSTILE,
                                                      "date": "2025-01-01", "ministere": self.HOSTILE, "statut": self.HOSTILE}]},
             "organes": [{"libelle": self.HOSTILE, "typeLibelle": self.HOSTILE, "qualite": self.HOSTILE}]}
        page = bp.page_depute(d, {"PO1": {"couleur": 'red;background:url(//x)"'}}, BASE, self.HOSTILE, self.HOSTILE)
        self._sain(page)
        self.assertNotIn("javascript:", page)
        self.assertIn("background:#94a3b8", page)  # couleur invalide : valeur par défaut, pas d'injection de style

    def test_dossier(self):
        d = {"uid": "DLR1", "titre": self.HOSTILE, "procedure": self.HOSTILE, "statut": self.HOSTILE, "etape": 2,
             "resume": "</script>" + self.HOSTILE, "initiateurs": [self.HOSTILE], "dateDepot": self.HOSTILE,
             "dateMaj": "2025-01-01", "derniereEtape": self.HOSTILE, "prochaineEtape": {"date": "2030-01-01", "libelle": self.HOSTILE},
             "actes": [{"date": '2025-01-01"><b>', "phase": self.HOSTILE, "libelle": self.HOSTILE, "statut": self.HOSTILE, "prevu": True}],
             "documents": [{"titre": self.HOSTILE, "type": self.HOSTILE, "date": self.HOSTILE,
                            "liens": {"html": "https://exemple.test/" + self.HOSTILE}},
                           {"titre": "piège", "liens": {"html": "javascript:alert(1)"}}],
             "liens": {"an": "data:text/html,x", "senat": "http://senat.test/a", "legifrance": None}}
        page = bp.page_dossier(d, BASE, "", "")
        self._sain(page)
        self.assertNotIn("javascript:", page)
        self.assertNotIn("data:text/html", page)
        self.assertNotIn("piège", page)

    def _sain(self, page: str):
        s = structure(page)
        self.assertEqual([c for g, c in s.scripts if g == "js"], [bp.THEME_JS])
        self.assertNotIn("img", s.balises)
        self.assertNotIn("b", s.balises)
        self.assertEqual(s.balises.count("title"), 1)
        self.assertEqual(page.count("</script>"), len(s.scripts))
        self.assertFalse([h for h in s.liens if h and re.match(r"\s*(javascript|data):", h, re.I)])


class OutilsTest(unittest.TestCase):
    def test_dates_et_resumes(self):
        self.assertEqual(bp.fmt_date("2025-02-19"), "19 février 2025")
        self.assertEqual(bp.fmt_date("2026-11-01T04:23:00Z"), "1er novembre 2026")
        self.assertEqual(bp.fmt_date("inconnue"), "inconnue")
        self.assertEqual(bp.fmt_date(None), "")
        self.assertEqual(bp.resume("un deux trois quatre", 12), "un deux…")
        self.assertEqual(bp.resume("  court  texte ", 50), "court texte")

    def test_encre_lisible(self):
        self.assertEqual(bp.encre("#313567"), "#ffffff")  # bleu nuit
        self.assertEqual(bp.encre("#FFD700"), "#0f172a")  # jaune
        self.assertEqual(bp.encre("pas une couleur"), "#ffffff")

    def test_liens_http_uniquement(self):
        self.assertEqual(bp.lien(" https://a.test/x "), "https://a.test/x")
        for u in ("javascript:alert(1)", "data:text/html,x", "//a.test", "", None):
            self.assertIsNone(bp.lien(u))


if __name__ == "__main__":
    unittest.main()
