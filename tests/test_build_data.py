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
        self.assertEqual(d["statut"], "Rejeté")
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
