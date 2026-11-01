"""Tests hors ligne du pipeline : fixtures = extraits réels de l'Open Data AN (XVIIe législature)."""
import http.server
import json
import sys
import threading
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_data as bd  # noqa: E402

FIX = ROOT / "tests" / "fixtures"


def make_zip(src: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w") as zf:
        for f in src.rglob("*.json"):
            zf.write(f, "json/" + str(f.relative_to(src)))


class BuildDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        tmp = Path(cls.tmp.name)
        zips = tmp / "zips"
        zips.mkdir()
        name = lambda key: bd.SOURCES[key].rsplit("/", 1)[1]  # noqa: E731
        make_zip(FIX / "amo10", zips / name("amo10"))
        make_zip(FIX / "dossiers", zips / name("dossiers"))
        make_zip(FIX / "scrutins", zips / name("scrutins"))
        make_zip(FIX / "qe", zips / name("questions_ecrites"))
        make_zip(FIX / "qg", zips / name("questions_gouvernement"))
        cls.out = tmp / "data"
        rc = bd.main(["--source-dir", str(zips), "--out", str(cls.out), "--no-fulltext", "--all-procedures"])
        assert rc == 0

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def load(self, rel):
        return json.loads((self.out / rel).read_text(encoding="utf-8"))

    def test_deputes(self):
        deps = self.load("deputes.json")
        self.assertEqual(len(deps), 6)
        auzanot = next(d for d in deps if d["uid"] == "PA796118")
        self.assertEqual(auzanot["sexe"], "F")
        self.assertEqual(auzanot["departement"], "Vaucluse")
        self.assertEqual(auzanot["groupe"], "RN")
        self.assertTrue(auzanot["photo"].endswith("/796118.jpg"))
        fiche = self.load("deputes/PA796118.json")
        self.assertEqual(fiche["liens"]["an"], "https://www.assemblee-nationale.fr/dyn/deputes/PA796118")
        self.assertIn("benedicte.auzanot@assemblee-nationale.fr", fiche["contacts"]["emails"])
        self.assertTrue(fiche["organes"])

    def test_groupes(self):
        groupes = self.load("groupes.json")
        self.assertEqual(sum(g["sieges"] for g in groupes), 6)
        rn = next(g for g in groupes if g["abrev"] == "RN")
        self.assertEqual(rn["couleur"], "#313567")

    def test_scrutins_et_participation(self):
        sc = self.load("scrutins.json")
        self.assertEqual(sc[0]["numero"], 4003)
        self.assertEqual(sc[0]["sort"], "adopté")
        self.assertTrue(sc[0]["groupes"])
        fiche = self.load("deputes/PA841495.json")  # a voté "contre" dans ce scrutin
        self.assertEqual(fiche["scrutins"]["votes"], 1)
        self.assertEqual(fiche["scrutins"]["derniers"][0]["position"], "contre")

    def test_dossiers(self):
        index = self.load("dossiers.json")
        uids = {d["uid"] for d in index}
        self.assertIn("DLR5L17N50173", uids)
        d = self.load("dossiers/DLR5L17N50173.json")
        self.assertEqual(d["categorie"], "PJL")
        self.assertEqual(d["textePrincipal"], "PRJLANR5L17B0004")
        self.assertEqual(d["etape"], 4)  # passé au Sénat
        # Une réunion de 1re lecture AN datée après le rejet au Sénat n'ouvre pas une nouvelle lecture.
        self.assertEqual(d["statut"], "Rejeté au Sénat")
        self.assertTrue(any(a["scrutins"] == ["VTANR5L17V5"] for a in d["actes"]))
        self.assertTrue(any(doc["uid"] == "PRJLANR5L17B0004" and doc["titre"] for doc in d["documents"]))

    def test_questions(self):
        qs = self.load("questions.json")
        self.assertEqual({q["type"] for q in qs}, {"QE", "QG"})
        qg = self.load("questions/QANR5L17QG1.json")
        html = qg["reponse"][0]["html"]
        self.assertIn("<strong>", html)
        self.assertNotIn("script", html)
        self.assertNotIn("onerror", html)
        self.assertNotIn("<img", html)
        qe = self.load("questions/QANR5L17QE1234.json")
        self.assertFalse(qe["repondue"])
        self.assertIn("maraîchers", qe["question"][0]["html"])
        self.assertEqual(qe["liens"]["an"], "https://questions.assemblee-nationale.fr/q17/17-1234QE.htm")

    def test_meta(self):
        meta = self.load("meta.json")
        self.assertIn("generation", meta)
        self.assertEqual(meta["sections"]["deputes"]["total"], 6)


class ProjetsDeLoiTest(unittest.TestCase):
    def test_projets_de_loi_toujours_publies(self):
        """Plafond à 1 : le projet de loi est gardé même si une autre procédure est plus récente."""
        with tempfile.TemporaryDirectory() as t:
            z = Path(t) / "dossiers.zip"
            make_zip(FIX / "dossiers", z)
            index, _, _ = bd.build_dossiers(z, bd.Referentiel(), 1, {"PJL", "PPL", "AUTRE"})
            self.assertEqual([d["uid"] for d in index], ["DLR5L17N50173"])
            self.assertEqual(index[0]["initiateurs"], ["Gouvernement"])


def _acte(code, date=None, statut=None, children=None):
    a = {"codeActe": code, "libelleActe": {"nomCanonique": code}, "dateActe": date and f"{date}T00:00:00.000+02:00",
         "actesLegislatifs": {"acteLegislatif": children} if children else None}
    if statut:
        a["statutConclusion"] = {"libelle": statut}
    return a


def _dossier_zip(tmp: Path, actes: list) -> Path:
    d = {"dossierParlementaire": {"uid": "DLR5L17NTEST", "titreDossier": {"titre": "Logement"},
                                  "procedureParlementaire": {"libelle": "Projet de loi ordinaire"},
                                  "actesLegislatifs": {"acteLegislatif": actes}}}
    z = tmp / "d.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("json/dossierParlementaire/DLR5L17NTEST.json", json.dumps(d))
    return z


class EtapesProgrammeesTest(unittest.TestCase):
    """Cas réel signalé : adoption au Sénat le 08/07, nouvelle lecture AN ouverte, séance programmée le 20/11."""

    ACTES = [
        _acte("AN1", children=[_acte("AN1-DEPOT", "2026-01-10"), _acte("AN1-DEBATS-DEC", "2026-03-02", "adopté")]),
        _acte("SN1", children=[_acte("SN1-DEPOT", "2026-03-03"), _acte("SN1-DEBATS-DEC", "2026-07-08", "adopté")]),
        _acte("ANNLEC", children=[_acte("ANNLEC-DEPOT", "2026-07-10"), _acte("ANNLEC-DEBATS-SEANCE", "2026-11-20")]),
    ]

    def build(self, actes, today="2026-11-01"):
        with tempfile.TemporaryDirectory() as t:
            index, by_uid, _ = bd.build_dossiers(_dossier_zip(Path(t), actes), bd.Referentiel(), 10, {"PJL"}, today=today)
            return index[0], by_uid["DLR5L17NTEST"]

    def test_date_future_pas_derniere_activite(self):
        i, d = self.build(self.ACTES)
        self.assertEqual(i["dateMaj"], "2026-07-10")
        self.assertEqual(i["derniereEtape"], "Nouvelle lecture — Assemblée · ANNLEC-DEPOT")
        self.assertEqual(i["prochaineEtape"]["date"], "2026-11-20")
        self.assertEqual([a["prevu"] for a in d["actes"] if a["date"] == "2026-11-20"], [True])
        self.assertEqual(d["donneesDu"], "2026-11-01")

    def test_statut_contextualise(self):
        i, _ = self.build(self.ACTES)
        self.assertEqual(i["statut"], "Adopté au Sénat — examen à l'Assemblée en cours")
        self.assertEqual(i["statutDecision"], "adopté")

    def test_lecture_seulement_programmee(self):
        actes = self.ACTES[:2] + [_acte("ANNLEC", children=[_acte("ANNLEC-DEBATS-SEANCE", "2026-11-20")])]
        i, _ = self.build(actes)
        self.assertEqual(i["dateMaj"], "2026-07-08")
        self.assertEqual(i["statut"], "Adopté au Sénat — examen à l'Assemblée en cours")

    def test_etape_ne_compte_pas_le_futur(self):
        actes = [_acte("AN1", children=[_acte("AN1-DEPOT", "2026-10-01"), _acte("AN1-DEBATS-SEANCE", "2026-11-20")])]
        i, _ = self.build(actes)
        self.assertEqual(i["etape"], 1)
        self.assertEqual(i["statut"], "Déposé à l'Assemblée")

    def test_seance_du_jour_programmee_decision_du_jour_accomplie(self):
        actes = [_acte("AN1", children=[_acte("AN1-DEPOT", "2026-09-01"), _acte("AN1-DEBATS-SEANCE", "2026-11-01"),
                                        _acte("AN1-DEBATS-DEC", "2026-11-01", "adopté")])]
        _, d = self.build(actes)
        self.assertEqual({a["code"]: a["prevu"] for a in d["actes"]}["AN1-DEBATS-SEANCE"], False)
        self.assertEqual(d["statut"], "Adopté à l'Assemblée")
        actes[0]["actesLegislatifs"]["acteLegislatif"].pop()  # sans décision publiée : séance du jour = programmée
        _, d = self.build(actes)
        self.assertEqual({a["code"]: a["prevu"] for a in d["actes"]}["AN1-DEBATS-SEANCE"], True)


class StatutsDonneesReellesTest(unittest.TestCase):
    """Séquences reprises du run du 01/11/2026."""

    build = EtapesProgrammeesTest.build

    def test_rapporteur_nomme_avant_le_depot_en_navette(self):
        # DLR5L17N54608 : rapporteur AN nommé le 01/07, avant l'adoption au Sénat (08/07) et le dépôt AN (09/07)
        actes = [
            _acte("SN1", children=[_acte("SN1-DEPOT", "2026-06-25"), _acte("SN1-DEBATS-DEC", "2026-07-08", "adopté")]),
            _acte("AN1", children=[_acte("AN1-DEPOT", "2026-07-09"), _acte("AN1-COM-FOND-NOMIN", "2026-07-01"),
                                   _acte("AN1-COM-FOND-RAPPORT", "2026-09-23"), _acte("AN1-DEBATS-SEANCE", "2026-11-17")]),
        ]
        actes[0]["actesLegislatifs"]["acteLegislatif"][0]["texteAssocie"] = "PRJLSNR5S479B0801"
        actes[1]["actesLegislatifs"]["acteLegislatif"][0]["texteAssocie"] = "PRJLANR5L17B3058"
        i, d = self.build(actes)
        self.assertEqual(i["statut"], "Adopté au Sénat — examen à l'Assemblée en cours")
        self.assertEqual(i["prochaineEtape"]["date"], "2026-11-17")
        self.assertEqual(d["textePrincipal"], "PRJLANR5L17B3058")  # version AN, disponible en texte intégral

    def test_derniere_etape_dit_ce_qui_a_ete_decide(self):
        actes = [_acte("AN1", children=[_acte("AN1-DEPOT", "2026-05-01"), _acte("AN1-DEBATS-DEC", "2026-06-01", "adoptée")])]
        i, _ = self.build(actes)
        self.assertEqual(i["derniereEtape"], "1re lecture — Assemblée · AN1-DEBATS-DEC : adoptée")

    def test_simple_depot_n_est_pas_un_examen(self):
        actes = [_acte("AN1", children=[_acte("AN1-DEPOT", "2026-05-01"), _acte("AN1-COM-FOND-SAISIE", "2026-05-01")])]
        i, _ = self.build(actes)
        self.assertEqual(i["statut"], "Déposé à l'Assemblée")
        self.assertEqual(i["etape"], 1)
        actes[0]["actesLegislatifs"]["acteLegislatif"].append(_acte("AN1-COM-FOND-REUNION", "2026-06-01"))
        i, _ = self.build(actes)
        self.assertEqual(i["statut"], "En cours d'examen à l'Assemblée")
        self.assertEqual(i["etape"], 2)

    def test_accord_unique(self):
        actes = [_acte("AN1", children=[_acte("AN1-DEPOT", "2026-05-01"), _acte("AN1-DEBATS-DEC", "2026-06-01", "adoptée")])]
        i, _ = self.build(actes)
        self.assertEqual(i["statut"], "Adopté à l'Assemblée")


def _csv(path: Path, header: list, rows: list, encoding="utf-8"):
    path.write_text("\n".join(";".join(r) for r in [header] + rows) + "\n", encoding=encoding)


CAND = ["Nom candidat 1", "Prénom candidat 1", "Voix 1", "Nom candidat 2", "Prénom candidat 2", "Voix 2"]


class CommunesTest(unittest.TestCase):
    """Table commune → circonscription, au format des fichiers officiels des législatives 2024."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        # deux circonscriptions dans l'Ain, une en Corse-du-Sud, une à l'étranger, une à Saint-Pierre-et-Miquelon
        _csv(self.d / "circ.csv", ["Code département", "Libellé département", "Code circonscription législative"] + CAND, [
            ["01", "Ain", "0101", "DUPONT", "Anne", "10", "MARTIN", "Paul", "8"],
            ["01", "Ain", "0102", "DURAND", "Léa", "12", "PETIT", "Marc", "9"],
            ["2A", "Corse-du-Sud", "2A01", "ROSSI", "Jean", "5", "", "", ""],
            ["ZZ", "Français établis hors de France", "ZZ03", "SMITH", "Eve", "3", "BROWN", "Tom", "2"],
            ["975", "Saint-Pierre-et-Miquelon", "97501", "LEGASSE", "Yves", "4", "", "", ""],
        ])
        bv_head = ["Code département", "Libellé département", "Code commune", "Libellé commune", "Code BV"] + CAND
        self.bv_rows = [
            ["01", "Ain", "01001", "L'Abergement-Clémenciat", "0001", "MARTIN", "Paul", "1", "DUPONT", "Anne", "2"],  # ordre différent
            ["01", "Ain", "01053", "Bourg-en-Bresse", "0001", "DUPONT", "Anne", "1", "MARTIN", "Paul", "2"],
            ["01", "Ain", "01053", "Bourg-en-Bresse", "0002", "DURAND", "Léa", "1", "PETIT", "Marc", "2"],      # commune partagée
            ["2A", "Corse-du-Sud", "2A004", "Ajaccio", "0001", "ROSSI", "Jean", "5", "", "", ""],
            ["ZZ", "Français établis hors de France", "ZZ229", "Londres", "0001", "SMITH", "Eve", "1", "BROWN", "Tom", "1"],
            ["975", "Saint-Pierre-et-Miquelon", "97502", "Saint-Pierre", "0001", "LEGASSE", "Yves", "4", "", "", ""],
        ]
        _csv(self.d / "bv.csv", bv_head, self.bv_rows)
        self.bv_head = bv_head
        self.geo = [
            {"nom": "L'Abergement-Clémenciat", "code": "01001", "codeDepartement": "01", "codesPostaux": ["01400"], "population": 832},
            {"nom": "Bourg-en-Bresse", "code": "01053", "codeDepartement": "01", "codesPostaux": ["01000"], "population": 41365},
            {"nom": "Ajaccio", "code": "2A004", "codeDepartement": "2A", "codesPostaux": ["20000", "20090"], "population": 73000},
            {"nom": "Miquelon-Langlade", "code": "97501", "codeDepartement": "975", "codesPostaux": ["97500"], "population": 580},
            {"nom": "Commune nouvelle", "code": "01999", "codeDepartement": "01", "codesPostaux": [], "population": 10},
        ]
        self.keys = {("01", "1"), ("01", "2"), ("2A", "1"), ("099", "3"), ("975", "1")}

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, **kw):
        return bd.build_communes(self.d / "bv.csv", self.d / "circ.csv", self.geo, self.keys, min_communes=1, **kw)

    def test_correspondance(self):
        doc, stats = self.build()
        c = {l[1]: l for l in doc["c"]}
        self.assertEqual(c["01001"][4], [1])                      # candidats dans un ordre différent : même circonscription
        self.assertEqual(c["01053"][4], [1, 2])                   # commune partagée
        self.assertEqual(c["01053"][2], "01000")
        self.assertEqual(c["2A004"][3:5], ["2A", [1]])
        self.assertEqual(c["ZZ229"][3:5], ["099", [3]])           # Français de l'étranger
        self.assertEqual(c["97501"][3:5], ["975", [1]])           # absente du scrutin, département à circonscription unique
        self.assertNotIn("01999", c)                              # inconnue et département à plusieurs circonscriptions
        self.assertEqual(stats["partagees"], 1)
        self.assertEqual(stats["communesSansCorrespondance"], 1)
        self.assertEqual(stats["circonscriptionsSansDepute"], 0)

    def test_latin1(self):
        _csv(self.d / "bv.csv", self.bv_head, self.bv_rows, encoding="latin-1")
        doc, _ = self.build()
        self.assertIn("L'Abergement-Clémenciat", {l[0] for l in doc["c"]})

    def test_rapprochement_incomplet(self):
        rows = self.bv_rows + [["01", "Ain", "01002", "X", "0001", "INCONNU", "Z", "1", "", "", ""]] * 3
        _csv(self.d / "bv.csv", self.bv_head, rows)
        with self.assertRaises(RuntimeError):
            self.build(max_unmatched=2)

    def test_siege_vacant_signale(self):
        self.keys.discard(("01", "2"))
        _, stats = self.build()
        self.assertEqual(stats["circonscriptionsSansDepute"], 1)

    def test_rafraichissement_mensuel(self):
        out = self.d / "out"
        out.mkdir()
        (out / "communes.json").write_text("{}")
        meta = {"sections": {"communes": {"majLe": "2026-10-20T04:30:00Z"}}}
        self.assertIsNone(bd.update_communes(out, self.d, None, self.keys, meta, "2026-11-01T04:30:00Z"))  # 12 j : conservée
        src = self.d / "src"
        src.mkdir()
        for k, f in bd.COMMUNES_FILES.items():
            target = src / f
            if k == "geo":
                target.write_text(json.dumps(self.geo), encoding="utf-8")
            else:
                target.write_bytes((self.d / f"{k}.csv").read_bytes())
        meta["sections"]["communes"]["majLe"] = "2026-09-01T04:30:00Z"  # 61 j : reconstruite
        res = bd.update_communes(out, self.d, src, self.keys, meta, "2026-11-01T04:30:00Z", min_communes=1)
        self.assertEqual(res["communes"], 6)
        self.assertEqual(len(json.loads((out / "communes.json").read_text())["c"]), 6)


class SanitizerTest(unittest.TestCase):
    def test_strips_attributes_and_dangerous_tags(self):
        out = bd.sanitize_html('<p style="x" onclick="evil()">Bonjour <a href="javascript:x">lien</a></p><style>p{}</style><iframe src=x></iframe>')
        self.assertEqual(out, "<p>Bonjour lien</p>")

    def test_unbalanced(self):
        self.assertEqual(bd.sanitize_html("</p>texte<b>gras"), "texte<b>gras</b>")


class _FlakyHandler(http.server.BaseHTTPRequestHandler):
    """Sert PAYLOAD en coupant la connexion après CUT octets, comme le serveur de l'AN ; gère Range."""
    PAYLOAD = bytes(range(256)) * 4000  # ~1 Mo
    CUT = 300_000
    supports_range = True

    def log_message(self, *a):
        pass

    def do_GET(self):
        start = 0
        rng = self.headers.get("Range")
        if rng and self.supports_range:
            start = int(rng.split("=")[1].rstrip("-"))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(self.PAYLOAD) - 1}/{len(self.PAYLOAD)}")
        else:
            self.send_response(200)
        body = self.PAYLOAD[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body[: self.CUT])  # coupure : moins d'octets que annoncé
        self.wfile.flush()
        self.close_connection = True


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FlakyHandler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}/f.zip"
        self.tmp = tempfile.TemporaryDirectory()
        self._sleep, bd.time.sleep = bd.time.sleep, lambda s: None

    def tearDown(self):
        bd.time.sleep = self._sleep
        _FlakyHandler.supports_range = True
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def test_reprise_apres_coupures(self):
        target = Path(self.tmp.name) / "f.zip"
        bd.download_file(self.url, target)
        self.assertEqual(target.read_bytes(), _FlakyHandler.PAYLOAD)
        self.assertFalse(target.with_name("f.zip.part").exists())

    def test_echec_si_reprise_impossible(self):
        _FlakyHandler.supports_range = False
        with self.assertRaises(RuntimeError):
            bd.download_file(self.url, Path(self.tmp.name) / "f.zip", attempts=3)


class SourceIndisponibleTest(unittest.TestCase):
    """Une archive de questions manquante ne doit effacer ni les questions ni les stats de la veille."""

    def test_questions_de_la_veille_conservees(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            zips = tmp / "zips"
            zips.mkdir()
            name = lambda key: bd.SOURCES[key].rsplit("/", 1)[1]  # noqa: E731
            for key, fix in (("amo10", "amo10"), ("dossiers", "dossiers"), ("scrutins", "scrutins"),
                             ("questions_ecrites", "qe"), ("questions_gouvernement", "qg")):
                make_zip(FIX / fix, zips / name(key))
            out = tmp / "data"
            self.assertEqual(bd.main(["--source-dir", str(zips), "--out", str(out), "--no-fulltext"]), 0)
            avant = json.loads((out / "questions.json").read_text(encoding="utf-8"))
            (zips / name("questions_ecrites")).unlink()
            bd.main(["--source-dir", str(zips), "--out", str(out), "--no-fulltext"])
            self.assertEqual(json.loads((out / "questions.json").read_text(encoding="utf-8")), avant)
            self.assertTrue((out / "questions" / "QANR5L17QE1234.json").exists())
            fiche = json.loads((out / "deputes" / "PA841495.json").read_text(encoding="utf-8"))
            self.assertEqual(fiche["questions"]["total"], 1)
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertIn("questions", meta["echecs"])


if __name__ == "__main__":
    unittest.main()
