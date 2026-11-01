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
| `data/dossiers.json`, `data/dossiers/<DLR…>.json` | dossiers de loi + parcours législatif complet : dernière étape **accomplie**, prochaine étape **programmée** (agenda), statut situé (« Adopté au Sénat — examen à l'Assemblée en cours ») |
| `data/textes/<uid>.json` | texte intégral (exposé des motifs + articles), récupéré une seule fois puis mis en cache |
| `data/questions.json`, `data/questions/<QANR…>.json` | questions récentes + texte de la question et de la réponse |
| `data/scrutins.json` | derniers scrutins, résultats par groupe |
| `data/communes.json` | « trouver mon député » : commune → circonscription(s), codes postaux (voir ci-dessous) |

### Communes et circonscriptions

Les données de l'Assemblée ne relient pas communes et circonscriptions. `data/communes.json` est construit à partir
des **résultats officiels des législatives 2024 par bureau de vote** (ministère de l'Intérieur, data.gouv.fr) : ce
fichier ne porte pas le code de circonscription, mais la liste des candidats d'un bureau est celle de sa
circonscription, unique dans un département (méthode déjà employée par le projet aux-voix). Les noms actuels, codes
postaux et populations viennent de l'API Découpage administratif (geo.api.gouv.fr). Le découpage n'a pas changé depuis
2010 : la table n'est reconstruite que tous les 30 jours (`--force-communes` pour forcer). Le calcul échoue — et la
table précédente est conservée — si plus de 50 bureaux ne peuvent pas être rattachés.

Paris, Lyon et Marseille sont détaillés **par arrondissement** : le numéro de bureau de vote y commence par le numéro
d'arrondissement (« 1102 » = 11e, bureau 02), ou le bureau est directement codé par l'arrondissement (13201). Une
recherche « Paris » propose de choisir l'arrondissement ; « 75011 » mène directement au 11e. Noms et codes postaux des
arrondissements : API Découpage administratif (`type=arrondissement-municipal`), sinon déduits.

Limites, affichées dans le bloc « Votre député par commune » (« Limites de la couverture ») :
- une commune ou un arrondissement partagé entre plusieurs circonscriptions affiche tous les députés concernés ;
  la circonscription exacte figure sur la carte électorale ;
- les communes **créées ou modifiées après juin 2024** dans un département à plusieurs circonscriptions ne sont pas
  rattachées (une vingtaine) : elles ne sont pas devinées, mais listées dans `communes.json` (`nonRattachees`) et
  signalées comme telles si on les cherche. Le taux de couverture affiché est arrondi par défaut.

Le format de la table est versionné (`COMMUNES_VERSION`) : un changement de format force le recalcul sans attendre
les 30 jours.

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

## Liens partageables

Les filtres de chaque liste sont dans l'URL (valeurs par défaut omises, valeurs inconnues ignorées) ;
les boutons Précédent / Suivant du navigateur parcourent les recherches, et « Copier le lien » copie l'adresse.

| Liste | Paramètres | Exemple |
|---|---|---|
| Députés | `q`, `groupe` (uid PO…), `commission`, `sexe` (`F`/`H`), `tri` (`dept`, `participation`, `questions`) | `#/deputes?groupe=PO845401&tri=questions` |
| Lois | `q`, `type` (`pjl`, `ppl`, `autre`), `statut` (`en-cours`, `promulguees`), `etape` (1 à 5) | `#/lois?type=pjl&etape=3` |
| Questions | `q`, `type` (`qg`, `qe`, `qosd`), `statut` (`repondues`, `sans-reponse`) | `#/questions?type=qe&statut=repondues` |
| Scrutins | `q` | `#/scrutins?q=finances` |
| Recherche (tout le site) | `q` | `#/recherche?q=logement` |

La recherche (champ de l'en-tête, raccourci `/`) exige que **tous les mots** apparaissent, sans tenir compte des accents
ni des majuscules — la même règle que les listes, pour que « Voir les N résultats » ouvre une liste de N éléments.
Chaque groupe de résultats affiche son périmètre : **liste complète** (députés en exercice) ou **sélection publiée**
(lois, questions, scrutins), avec le total de la législature.

## Suivis

Bouton « Suivre » sur les fiches de dossiers et de députés ; page `#/suivis` (étoile de l'en-tête). Les suivis sont
stockés **uniquement dans le navigateur** (`localStorage`, clé `suivis.v1`), sans compte ni envoi. Pour un dossier, le
site mémorise l'état vu (dernière étape accomplie, statut, prochaine date programmée) et signale les changements après
chaque mise à jour quotidienne ; un dossier sorti de la sélection publiée reste listé, avec un lien vers le site de
l'Assemblée.

## Mise en place sur GitHub

1. **Settings → Pages → Build and deployment → Source : « GitHub Actions »**.
2. **Settings → Actions → General → Workflow permissions : « Read and write permissions »** (pour écrire la branche `data`).
3. Onglet **Actions → « Mise à jour des données et déploiement » → Run workflow** pour la première génération.

Ensuite tout est automatique : exécution quotidienne, mise à jour de la branche `data`, redéploiement.
Si le serveur de l'AN est indisponible, le site est redéployé avec les données de la veille et la section en
échec est signalée dans `meta.json` (bandeau visible sur le site).

## Ressources tierces

Polices (Inter), icônes (Font Awesome Free) et Chart.js sont **hébergés sur le site** (`assets/vendor/`), sans appel à
Google Fonts ni à un CDN : l'adresse IP des visiteurs n'est transmise à aucun tiers pour afficher la page. Ils sont
copiés depuis les paquets npm figés dans `package.json` par `npm run vendor` (licences jointes, voir
`assets/vendor/README.md`). Seules les photos des députés sont chargées depuis le site de l'Assemblée nationale.

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
