"""Construit un site complet à partir des extraits de tests/fixtures, pour les tests de navigateur.

    python tests/e2e/make_site.py <dossier>

Même chaîne que la production (build_data.py, build_pages.py, index.html, assets/), sans réseau.
"""
import json
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

# Communes et contours fictifs dans la Meuse, où siège un député des extraits (1re circonscription) :
# « Testville-sur-Meuse » tient dans la 1re, « Bourg-Partagé » est à cheval sur la 1re et la 2e (siège sans député
# dans les extraits). Les deux circonscriptions sont deux carrés accolés, séparés par le méridien LIMITE.
CANDIDATS = ["Nom candidat 1", "Prénom candidat 1", "Voix 1", "Nom candidat 2", "Prénom candidat 2", "Voix 2"]
CIRCONSCRIPTIONS = [["55", "Meuse", "5501", "ALPHA", "Anne", "10", "BETA", "Paul", "8"],
                    ["55", "Meuse", "5502", "GAMMA", "Léa", "12", "DELTA", "Marc", "9"]]
BUREAUX = [["55", "Meuse", "55900", "Testville-sur-Meuse", "0001", "ALPHA", "Anne", "5", "BETA", "Paul", "4"],
           ["55", "Meuse", "55901", "Bourg-Partagé", "0001", "ALPHA", "Anne", "5", "BETA", "Paul", "4"],
           ["55", "Meuse", "55901", "Bourg-Partagé", "0002", "GAMMA", "Léa", "6", "DELTA", "Marc", "3"]]
COMMUNES = [{"nom": "Testville-sur-Meuse", "code": "55900", "codeDepartement": "55", "codesPostaux": ["55000"], "population": 1200},
            {"nom": "Bourg-Partagé", "code": "55901", "codeDepartement": "55", "codesPostaux": ["55100"], "population": 18000}]
LIMITE, SUD, NORD = 5.40, 49.14, 49.18


def _carre(ouest: float, est: float) -> list:
    return [[[ouest, SUD], [est, SUD], [est, NORD], [ouest, NORD], [ouest, SUD]]]


CONTOURS = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"codeDepartement": "55", "codeCirconscription": "5501"},
     "geometry": {"type": "Polygon", "coordinates": _carre(LIMITE - 0.04, LIMITE)}},
    {"type": "Feature", "properties": {"codeDepartement": "55", "codeCirconscription": "5502"},
     "geometry": {"type": "Polygon", "coordinates": _carre(LIMITE, LIMITE + 0.04)}}]}


def _csv(path: Path, entete: list, lignes: list) -> None:
    path.write_text("\n".join(";".join(l) for l in [entete] + lignes) + "\n", encoding="utf-8")


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
    _csv(zips / bd.COMMUNES_FILES["circ"],
         ["Code département", "Libellé département", "Code circonscription législative"] + CANDIDATS, CIRCONSCRIPTIONS)
    _csv(zips / bd.COMMUNES_FILES["bv"],
         ["Code département", "Libellé département", "Code commune", "Libellé commune", "Code BV"] + CANDIDATS, BUREAUX)
    (zips / bd.COMMUNES_FILES["geo"]).write_text(json.dumps(COMMUNES), encoding="utf-8")
    (zips / bd.CIRCOS_FILE).write_text(json.dumps(CONTOURS), encoding="utf-8")
    logging.disable(logging.WARNING)
    # 6 députés et 2 communes dans le jeu d'essai : planchers abaissés.
    rc = bd.main(["--source-dir", str(zips), "--out", str(dest / "data"), "--no-fulltext",
                  "--min-deputes", "1", "--min-communes", "1"])
    shutil.rmtree(zips)
    shutil.copy(ROOT / "index.html", dest / "index.html")
    shutil.copytree(ROOT / "assets", dest / "assets")
    build_pages.build(dest / "data", dest, build_pages.BASE_URL)
    return rc


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
