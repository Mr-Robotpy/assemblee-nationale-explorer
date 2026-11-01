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


if __name__ == "__main__":
    unittest.main()
