"""Contrôles statiques du front (sans navigateur)."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = (ROOT / "index.html").read_text(encoding="utf-8")


class VendorTest(unittest.TestCase):
    def test_aucune_ressource_tierce(self):
        """Polices, icônes et scripts sont servis par le site : aucun <script>/<link> vers un autre domaine."""
        externes = re.findall(r'<(?:script|link)[^>]+(?:src|href)="(https?://[^"]+)"', INDEX)
        self.assertEqual(externes, [])

    def test_fichiers_references_presents(self):
        """Chaque fichier assets/vendor référencé existe (sinon : relancer `npm run vendor`)."""
        refs = re.findall(r'(?:src|href)="(assets/vendor/[^"?]+)"', INDEX)
        self.assertGreaterEqual(len(refs), 3)
        for ref in refs:
            self.assertTrue((ROOT / ref).is_file(), f"{ref} manquant : lancer `npm ci && npm run vendor`")

    def test_licences_presentes(self):
        for d in (ROOT / "assets" / "vendor").iterdir():
            if d.is_dir():
                self.assertTrue(any(f.name.startswith("LICENSE") for f in d.iterdir()), f"licence absente dans {d.name}")
        fa = next((ROOT / "assets" / "vendor").glob("fontawesome-*/css/all.min.css")).read_text(encoding="utf-8")[:300]
        self.assertIn("CC BY 4.0", fa)  # attribution des icônes : en-tête conservé


class MentionsTest(unittest.TestCase):
    def test_page_et_lien(self):
        self.assertIn('id="tab-mentions"', INDEX)
        self.assertIn('href="#/mentions"', INDEX)  # lien dans le pied de page
        for titre in ("Éditeur", "Hébergeur", "Vie privée des visiteurs", "Données personnelles des députés", "Vos droits"):
            self.assertIn(f"<h3>{titre}</h3>", INDEX)
        self.assertIn("'mentions'", (ROOT / "assets" / "app.js").read_text(encoding="utf-8"))  # route déclarée

    def test_modele_issue_donnees_personnelles(self):
        tpl = ROOT / ".github" / "ISSUE_TEMPLATE" / "donnees-personnelles.md"
        self.assertTrue(tpl.is_file())
        self.assertIn("publique", tpl.read_text(encoding="utf-8"))  # avertissement : les issues sont publiques
        self.assertIn("template=donnees-personnelles.md", INDEX)


if __name__ == "__main__":
    unittest.main()
