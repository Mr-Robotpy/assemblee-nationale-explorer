"""Construit un site complet à partir des extraits de tests/fixtures, pour les tests de navigateur.

    python tests/e2e/make_site.py <dossier>

Même chaîne que la production (build_data.py, build_pages.py, index.html, assets/), sans réseau.
"""
import logging
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "scripts"))
import build_data as bd  # noqa: E402
import build_pages  # noqa: E402

ARCHIVES = {"amo10": "amo10", "dossiers": "dossiers", "scrutins": "scrutins",
            "questions_ecrites": "qe", "questions_gouvernement": "qg", "questions_orales": None}


def main(dest: Path) -> int:
    if dest.exists():
        shutil.rmtree(dest)
    zips = dest / ".zips"
    zips.mkdir(parents=True)
    for source, fixture in ARCHIVES.items():
        with zipfile.ZipFile(zips / bd.SOURCES[source].rsplit("/", 1)[1], "w") as z:
            # Aucun extrait de question orale : archive vide, sinon la section questions serait signalée en échec.
            for f in sorted((FIX / fixture).rglob("*.json")) if fixture else ():
                z.write(f, f"json/{f.relative_to(FIX / fixture).as_posix()}")
    logging.disable(logging.WARNING)
    # 6 députés dans les extraits : plancher abaissé. Communes et contours demandent le réseau.
    rc = bd.main(["--source-dir", str(zips), "--out", str(dest / "data"), "--no-fulltext", "--no-communes",
                  "--min-deputes", "1"])
    shutil.rmtree(zips)
    shutil.copy(ROOT / "index.html", dest / "index.html")
    shutil.copytree(ROOT / "assets", dest / "assets")
    build_pages.build(dest / "data", dest, build_pages.BASE_URL)
    return rc


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
