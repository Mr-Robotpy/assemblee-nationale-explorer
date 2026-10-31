# Assemblée Open Data Explorer

Explorateur citoyen des données ouvertes de l'Assemblée nationale (XVIIe législature) : députés, projets et
propositions de loi (avec texte intégral), questions écrites et au Gouvernement (avec réponses), scrutins publics.

Site 100 % statique hébergé sur GitHub Pages. Les données sont reconstruites **chaque jour** par GitHub Actions à
partir des archives officielles de [data.assemblee-nationale.fr](https://data.assemblee-nationale.fr), puis
publiées en JSON sur la branche [`data`](../../tree/data) et servies sous `/data/` par GitHub Pages.

## Architecture

```
Open Data AN (ZIP JSON) ──► scripts/build_data.py ──► data/*.json ──► index.html + assets/app.js
        ▲                        (Python, stdlib)     (branche data)       (GitHub Pages)
        └──────────── GitHub Actions, tous les jours à 04:23 UTC ────────────┘
```

| Fichier | Contenu |
|---|---|
| `data/meta.json` | date de génération, sources, compteurs, sections en échec |
| `data/deputes.json`, `data/deputes/<PA…>.json` | annuaire + fiche complète (organes, contacts, participation, derniers votes, questions) |
| `data/groupes.json` | groupes politiques (couleurs officielles, sièges, parité) |
| `data/dossiers.json`, `data/dossiers/<DLR…>.json` | dossiers de loi les plus récemment actifs + parcours législatif complet |
| `data/textes/<uid>.json` | texte intégral (exposé des motifs + articles), récupéré une seule fois puis mis en cache |
| `data/questions.json`, `data/questions/<QANR…>.json` | questions récentes + texte de la question et de la réponse |
| `data/scrutins.json` | derniers scrutins, résultats par groupe |

Volumes publiés (modifiables via variables d'environnement ou options CLI) : 400 dossiers (dont **tous** les
projets de loi, complétés par les propositions les plus récemment actives), 300 scrutins,
3 000 questions écrites, 1 500 questions au Gouvernement, 800 questions orales. Les statistiques (participation,
nombre de questions…) sont calculées sur **toute** la législature.

### Pourquoi une branche `data` séparée ?

- `main` ne contient que le code : pas de commit automatique quotidien, pas de conflit avec vos propres pushes,
  compatible avec une protection de branche sur `main`.
- La branche `data` est réécrite en un seul commit à chaque passage : sa taille reste constante.
- À chaque passage, les données précédentes sont restaurées avant la génération : si une source de l'AN est
  indisponible, sa section garde les données de la veille, et les textes intégraux déjà récupérés ne sont
  pas retéléchargés.
- Les JSON restent consultables dans le dépôt (branche `data`) et sur le site (`/data/…`).

### Pourquoi plafonner le volume ?

L'index des questions est chargé à la première ouverture de l'onglet Questions ; avec toutes les questions écrites
de la législature (plus de 20 000), il pèserait plusieurs Mo (estimation) et rendrait l'onglet lent sur mobile. Les plafonds
ne concernent que l'affichage : les compteurs et statistiques couvrent toute la législature.

## Mise en place sur GitHub

1. **Settings → Pages → Build and deployment → Source : « GitHub Actions »**.
2. **Settings → Actions → General → Workflow permissions : « Read and write permissions »** (pour écrire la branche `data`).
3. Onglet **Actions → « Mise à jour des données et déploiement » → Run workflow** pour la première génération.

Ensuite tout est automatique : exécution quotidienne, mise à jour de la branche `data`, redéploiement.
Si le serveur de l'AN est indisponible, le site est redéployé avec les données de la veille et la section en
échec est signalée dans `meta.json` (bandeau visible sur le site).

## En local

```bash
python scripts/build_data.py          # télécharge ~90 Mo d'archives et génère data/ (quelques minutes)
python -m http.server 8000            # puis http://localhost:8000
python -m unittest discover -s tests  # tests hors ligne sur des extraits réels de l'Open Data
npm ci && npm run build:css           # uniquement si vous modifiez les classes Tailwind
```

Options utiles : `--max-qe 0` (toutes les questions écrites), `--all-procedures` (inclut résolutions,
commissions d'enquête…), `--no-fulltext`, `--source-dir <dossier de ZIP>` (hors ligne).

## Licence

Code : MIT. Données : Assemblée nationale, [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
Projet indépendant, non affilié à l'Assemblée nationale.
