#!/usr/bin/env python3
"""Copie les polices et bibliothèques tierces dans assets/vendor/ pour les servir depuis le site.

Aucune requête vers Google Fonts, cdnjs ou jsDelivr : l'adresse IP des visiteurs n'est transmise à aucun tiers.
Sources : paquets npm aux versions figées dans package.json (`npm ci` puis `npm run vendor`).
Les fichiers de licence sont copiés à côté de chaque ressource ; l'en-tête de licence de Font Awesome est conservé.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NM = ROOT / "node_modules"
OUT = ROOT / "assets" / "vendor"

WEIGHTS = (400, 500, 600, 700, 800)
# Plages Unicode des sous-ensembles (identiques à celles de Google Fonts) : latin-ext n'est téléchargé
# que si la page contient l'un de ses caractères (ł, ő, ș…, présents dans certains noms propres).
RANGES = {
    "latin": "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, "
             "U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    "latin-ext": "U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, "
                 "U+2113, U+2C60-2C7F, U+A720-A7FF",
}
FA_FONTS = ("fa-solid-900.woff2", "fa-regular-400.woff2", "fa-brands-400.woff2", "fa-v4compatibility.woff2")


def version(pkg: str) -> str:
    return json.loads((NM / pkg / "package.json").read_text(encoding="utf-8"))["version"]


def copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    v_inter, v_fa, v_chart = version("@fontsource/inter"), version("@fortawesome/fontawesome-free"), version("chart.js")

    inter = OUT / f"inter-{v_inter}"
    faces = []
    for subset in ("latin-ext", "latin"):
        for w in WEIGHTS:
            name = f"inter-{subset}-{w}-normal.woff2"
            copy(NM / "@fontsource/inter/files" / name, inter / "files" / name)
            faces.append(f"/* inter-{subset}-{w} */\n@font-face {{\n  font-family: 'Inter';\n  font-style: normal;\n"
                         f"  font-display: swap;\n  font-weight: {w};\n  src: url(./files/{name}) format('woff2');\n"
                         f"  unicode-range: {RANGES[subset]};\n}}")
    (inter / "inter.css").write_text(f"/* Inter {v_inter} — SIL Open Font License 1.1 (voir LICENSE) */\n"
                                     + "\n".join(faces) + "\n", encoding="utf-8")
    copy(NM / "@fontsource/inter/LICENSE", inter / "LICENSE")

    fa = OUT / f"fontawesome-{v_fa}"
    copy(NM / "@fortawesome/fontawesome-free/css/all.min.css", fa / "css" / "all.min.css")  # en-tête de licence conservé
    for f in FA_FONTS:
        copy(NM / "@fortawesome/fontawesome-free/webfonts" / f, fa / "webfonts" / f)
    copy(NM / "@fortawesome/fontawesome-free/LICENSE.txt", fa / "LICENSE.txt")

    chart = OUT / f"chart.js-{v_chart}"
    copy(NM / "chart.js/dist/chart.umd.js", chart / "chart.umd.js")
    copy(NM / "chart.js/LICENSE.md", chart / "LICENSE.md")

    (OUT / "README.md").write_text(f"""# Ressources tierces hébergées sur le site

Générées par `npm run vendor` (scripts/vendor_assets.py) à partir des paquets npm figés dans `package.json`.
Ne pas modifier à la main.

| Ressource | Version | Licence | Dossier |
|---|---|---|---|
| Inter (police) | {v_inter} | SIL Open Font License 1.1 | `inter-{v_inter}/` |
| Font Awesome Free (icônes) | {v_fa} | polices SIL OFL 1.1, icônes CC BY 4.0, code MIT | `fontawesome-{v_fa}/` |
| Chart.js | {v_chart} | MIT | `chart.js-{v_chart}/` |

Chaque dossier contient le fichier de licence d'origine. L'attribution exigée par CC BY 4.0 pour les icônes
Font Awesome est assurée par l'en-tête conservé dans `css/all.min.css`.
""", encoding="utf-8")
    print(f"assets/vendor : Inter {v_inter}, Font Awesome {v_fa}, Chart.js {v_chart}")


if __name__ == "__main__":
    main()
