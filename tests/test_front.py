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

    def test_aucune_image_distante(self):
        """Aucune image chargée depuis un autre site (photos des députés comprises) : pas d'adresse IP transmise."""
        app = (ROOT / "assets" / "app.js").read_text(encoding="utf-8")
        self.assertNotIn("<img", app)
        self.assertEqual(re.findall(r'<img[^>]+src="https?://', INDEX), [])

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


class SecuriteContenuTest(unittest.TestCase):
    """La politique de sécurité de contenu n'autorise que les scripts du site : rien en ligne ne doit en dépendre."""

    APP = (ROOT / "assets" / "app.js").read_text(encoding="utf-8")

    def test_politique(self):
        m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', INDEX)
        self.assertTrue(m, "balise Content-Security-Policy absente")
        regles = dict(r.strip().split(" ", 1) for r in m.group(1).split(";"))
        self.assertEqual(regles["script-src"], "'self'")
        self.assertEqual(regles["object-src"], "'none'")
        # Seul tiers joignable : l'API Adresse, à la demande de l'utilisateur.
        self.assertEqual(regles["connect-src"], "'self' https://data.geopf.fr")
        self.assertIn("https://data.geopf.fr/", self.APP)
        self.assertLess(m.start(), INDEX.index("<script"))  # déclarée avant tout script

    def test_aucun_script_en_ligne(self):
        for attrs, corps in re.findall(r"<script([^>]*)>(.*?)</script>", INDEX, flags=re.S):
            self.assertIn("src=", attrs)
            self.assertEqual(corps.strip(), "")

    def test_aucun_gestionnaire_en_ligne(self):
        """« onclick="…" » serait bloqué par la politique : les clics passent par des écouteurs (data-…)."""
        motif = r"<[a-z][^<>]*\son[a-z]+\s*="
        self.assertEqual(re.findall(motif, INDEX, flags=re.I), [])
        self.assertEqual(re.findall(motif, self.APP, flags=re.I), [])

    def test_scripts_differes_dans_l_ordre(self):
        """Chart.js ne bloque plus le rendu ; l'ordre d'exécution reste Chart.js, geo.js, app.js."""
        scripts = re.findall(r"<script([^>]*)src=\"([^\"]+)\"", INDEX)
        self.assertEqual([src.rsplit("/", 1)[-1] for _, src in scripts], ["theme.js", "chart.umd.js", "geo.js", "app.js"])
        self.assertEqual(["defer" in attrs for attrs, _ in scripts], [False, True, True, True])


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

    def test_contact_non_public(self):
        """Un moyen de contact privé (courriel) figure sur la page et dans le modèle d'issue (RGPD art. 12)."""
        mails = set(re.findall(r'mailto:([^"?]+)', INDEX))
        self.assertEqual(len(mails), 1)
        tpl = (ROOT / ".github" / "ISSUE_TEMPLATE" / "donnees-personnelles.md").read_text(encoding="utf-8")
        self.assertIn(mails.pop(), tpl)


if __name__ == "__main__":
    unittest.main()
