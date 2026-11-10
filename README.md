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
| `data/questions.json`, `data/questions/<QANR…>.json` | **toutes** les questions (index en colonnes) + fiches des récentes (texte de la question et de la réponse) |
| `data/scrutins.json` | **tous** les scrutins (index en colonnes), détail par groupe pour les plus récents |
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
  rattachées (8 en novembre 2026) : elles ne sont pas devinées, mais listées dans `communes.json` (`nonRattachees`),
  signalées comme telles si on les cherche, et résolues par la recherche par adresse. Le taux de couverture affiché est
  arrondi par défaut ;
- les **territoires sans électeurs** (`sansElecteurs`) n'ont pas de bureau de vote, donc rien à rattacher : villages
  détruits en 1916 dans la Meuse (population 0), Terres australes et antarctiques, Clipperton (aucune circonscription).
  Ils sont exclus du taux de couverture et signalés comme tels. Seule une population explicitement nulle range une
  commune ici : si l'API ne donne pas la population, la commune reste « non rattachée ».

**Trouver son député par adresse**, quelle que soit la commune (champ distinct sur les pages Députés et Recherche) :
l'adresse est géocodée par l'API Adresse ; si la commune n'a qu'une circonscription, la table des communes répond
directement ; sinon (commune partagée ou non rattachée), la circonscription est calculée dans les contours du
département. Couverts (vérifié sur le site en novembre 2026) : métropole, Paris, Lyon et Marseille par arrondissement, DROM,
Saint-Pierre-et-Miquelon, Saint-Barthélemy, Saint-Martin, Polynésie française, Nouvelle-Calédonie. Non couverts (hors de la
Base Adresse Nationale) : Wallis-et-Futuna et Français de l'étranger — recherche par commune ou par ville (« Londres »).

Contrôle de la réponse du géocodeur (`ANGeo.assessGeocode`, testé) : en dessous d'un score de 0,5 la réponse est refusée
(« Mata-Utu » donnait une rue de Haute-Garonne) ; si seule la commune est reconnue alors qu'elle compte plusieurs
circonscriptions, le site demande la voie plutôt que de calculer sur le centre de la commune ; si la commune trouvée ne
figure pas dans la saisie (« 12 rue de la paix » → Cherbourg), le résultat est affiché avec un avertissement.

**Confirmation de l'adresse** (`ANGeo.matchAddress`, testé) : le géocodeur renvoie toujours l'adresse « la plus proche » ;
dans Lyon 7e, « 8 rue Victor Hugo » (2e arrondissement) devient « 8 Rue Victor Lagrange ». Si la voie trouvée, le code
postal ou le numéro diffèrent de la saisie (abréviations et accents ignorés), le site propose les candidats du géocodeur
et n'affiche aucun député sans un clic de confirmation ; quand tout concorde, le résultat s'affiche directement.
Dans le champ global, une saisie sans commune (« 12 rue de la paix ») demande aussi confirmation parmi les communes
possibles. Si la voie saisie n'existe pas là où elle est cherchée (« 12 rue de la République » dans Lyon 7e), elle est
cherchée dans toute la ville (second appel au même service, pour le même clic) et le site indique où elle se trouve
(« Lyon 2e Arrondissement »), au lieu de citer une autre voie de l'arrondissement.

**Préciser avec son adresse** (communes et arrondissements partagés) : l'adresse est géocodée par l'API Adresse de
l'État, servie par la Géoplateforme de l'IGN (`data.geopf.fr/geocodage` ; l'ancien hôte `api-adresse.data.gouv.fr` est
déprécié depuis le 31 janvier 2026 et coupait régulièrement) — seul envoi à un tiers, déclenché par l'utilisateur à chaque recherche et annoncé à
côté du bouton — puis la circonscription est calculée dans le navigateur (point dans polygone, `assets/geo.js`) à partir
de `data/circos/<dept>.json`. Ces fichiers sont tirés des « Contours géographiques des circonscriptions législatives »
(data.gouv, juin 2024, contours généralisés) pour les seuls départements comptant une commune partagée ou une
commune non rattachée. À moins de
100 m d'une limite, le résultat est signalé comme incertain ; la carte électorale fait foi. « Me localiser » utilise la
position de l'appareil, sans envoi.

Le format de la table est versionné (`COMMUNES_VERSION`) : un changement de format force le recalcul sans attendre
les 30 jours.

Volumes publiés (modifiables via variables d'environnement ou options CLI) : **tous** les dossiers de la législature
(≈ 3 400 : projets et propositions de loi, résolutions, commissions d'enquête… ; index ≈ 2,2 Mo brut, ≈ 220 Ko
compressé), **toutes** les questions (≈ 22 000), **tous** les scrutins (≈ 9 500 ; détail par groupe pour les 300 plus
récents, `MAX_SCRUTINS` ; pour les autres, lien vers la fiche officielle). Fiches détaillées des questions (texte et réponse)
pour les plus récentes : 3 000 écrites, 1 500 au Gouvernement, 800 orales (`MAX_QE`, `MAX_QG`, `MAX_QOSD`) ; pour les
autres, une fiche légère tirée de l'index renvoie à la page officielle de l'Assemblée.
Textes intégraux archivés pour tous les projets de loi et les dossiers les plus récemment actifs, 400 au total
(`MAX_TEXTES` / `--max-textes`, 60 nouveaux par passage) ; pour les autres, la fiche renvoie au texte officiel
(HTML et PDF de l'Assemblée, ou dossiers de l'Assemblée et du Sénat pour un texte déposé au Sénat). Les statistiques (participation,
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

Les dossiers sont tous publiés (index léger, ≈ 220 Ko compressés). Les questions aussi, dans un index **en colonnes**
(`compact_questions`, format 2) : auteurs, groupes, ministères, rubriques et statuts rangés une fois dans des tables et
référencés par indice, uid déduit du type et du numéro. Mesuré en novembre 2026 : 22 050 questions, 2,6 Mo brut et
≈ 690 Ko compressé, contre 7,6 Mo dans l'ancien format objet. L'index est chargé à la première ouverture de l'onglet
Questions (ou d'une recherche) ; le texte de recherche de chaque élément est calculé une fois puis mis en cache. Seules
les fiches détaillées restent plafonnées (≈ 155 Mo pour toutes). Les scrutins suivent le même principe (`compact_scrutins`,
format 2) : 9 491 scrutins en 2,2 Mo brut et ≈ 230 Ko compressé, contre 20 Mo s'ils gardaient tous leur détail par groupe
(peu de transfert grâce à la compression, mais 20 Mo de JSON à analyser sur un téléphone). L'index est chargé à la
première ouverture de l'onglet Scrutins ou d'une recherche ; l'accueil affiche les 5 derniers depuis `meta.json`. Les
compteurs et statistiques couvrent toute la législature.

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
Chaque groupe de résultats affiche son périmètre : **liste complète** (députés en exercice, et les dossiers de loi,
questions et scrutins de toute la législature) ou **sélection publiée**, avec le total de la législature. Le statut
« liste complète » est calculé (éléments publiés ≥ total de la législature) : il disparaît si un plafond
`MAX_DOSSIERS` est fixé, ou si un index de l'ancien format est conservé après l'échec d'une source.

## Pages référençables

Les fiches de l'application vivent derrière `#/…` : un moteur de recherche n'y voit qu'une seule page, et un lien
partagé n'a ni titre ni aperçu propre. À chaque déploiement, `scripts/build_pages.py` écrit donc à partir des JSON :

| Adresse | Contenu |
|---|---|
| `depute/<PA…>.html` | une page par député en exercice : groupe, circonscription, organes, participation, derniers votes et questions |
| `dossier/<DLR…>.html` | une page par dossier publié : statut, étapes, parcours daté, documents officiels |
| `depute/`, `dossier/` | listes complètes (liens du pied de page), pour que chaque page soit reliée au site |
| `sitemap.xml` | toutes ces adresses, avec la date de dernière étape des dossiers |
| `404.html` | page servie pour une adresse disparue (fin de mandat) |

Chaque page porte un titre, une description, une adresse canonique, des balises Open Graph et un bouton « Ouvrir la
fiche interactive » ; elle se lit sans JavaScript et ne charge rien d'un autre site (feuille `assets/pages.css`,
indépendante de Tailwind). Les pages ne sont pas stockées sur la branche `data` : elles sont dérivées des JSON, y
compris quand la génération a échoué et que le site est redéployé avec les données de la veille.

- **Données personnelles** : la page d'un député se limite à son mandat. Date et lieu de naissance, profession et
  coordonnées restent sur la fiche interactive, que les moteurs ne référencent pas (testé). Le taux de participation
  est toujours accompagné de son avertissement. La page disparaît à la fin du mandat.
- **Adresse du site** : lue dans la configuration de GitHub Pages (`steps.pages.outputs.base_url`), donc correcte
  aussi avec un nom de domaine personnalisé.
- **Faire connaître le plan du site** : un `robots.txt` n'est lu qu'à la racine d'un domaine ; sur
  `<compte>.github.io/<dépôt>/` il serait ignoré. Le plan du site se déclare donc dans Google Search Console et Bing
  Webmaster Tools (vérification par fichier HTML, sans script ni cookie sur le site).

En local : `python scripts/build_pages.py --data data --out .` (fichiers ignorés par git).

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

## Surveillance et garde-fous

- **Tests sur les pull requests** (`.github/workflows/ci.yml`) : tests Python et Node, compilation CSS, tests du front
  dans un navigateur, sans téléchargement ni publication.
- **Tests de navigateur** (`tests/e2e/front.test.mjs`, Playwright) : `tests/e2e/make_site.py` construit un site complet
  à partir des extraits de `tests/fixtures` avec la chaîne de production, puis Chromium vérifie les listes, les filtres
  dans l'URL, les fiches, les suivis, la recherche, les bandeaux et les pages statiques (JavaScript désactivé).
  La recherche par commune et par adresse y est testée sur deux communes fictives de la Meuse (une entière, une
  partagée entre deux circonscriptions) et un géocodeur simulé : calcul dans les contours, confirmation d'une voie
  différente de la saisie, réponse douteuse refusée, service en panne, « Me localiser ». Aucun test ne sort sur le réseau. Chaque test échoue aussi sur une erreur JavaScript,
  un fichier manquant ou une requête vers un autre site.
- **Panne signalée** : le site est toujours redéployé (données de la veille si besoin), mais le job `controle` passe au
  rouge si la génération a échoué ou si `meta.json` liste des sections en échec — GitHub envoie alors son courriel
  d'échec. Sur le site, un bandeau apparaît quand les données ont plus de 48 h.
- **Volumes** (`controle_volume`) : une archive tronquée mais valide ne remplace pas les données de la veille. Sous
  500 députés (`--min-deputes`), ou 5 % de députés en moins que la veille, rien n'est publié. Une section (scrutins,
  dossiers, chaque type de question) qui perd plus de 10 % par rapport au passage précédent n'est pas publiée : la
  section de la veille reste en place et figure dans `echecs`. La comparaison est ignorée après un changement de
  législature. Si la baisse est réelle (vérifiée à la source) : **Run workflow → « forcer_volumes »**, ou
  `--force-volumes` / `FORCE_VOLUMES=1` en local.

## Ressources tierces

Polices (Inter), icônes (Font Awesome Free) et Chart.js sont **hébergés sur le site** (`assets/vendor/`), sans appel à
Google Fonts ni à un CDN : l'adresse IP des visiteurs n'est transmise à aucun tiers pour afficher la page. Ils sont
copiés depuis les paquets npm figés dans `package.json` par `npm run vendor` (licences jointes, voir
`assets/vendor/README.md`). Les députés sont représentés par leurs **initiales** sur la couleur de leur groupe, sans
photo : les portraits de l'Assemblée ne sont pas réutilisables sans accord préalable (mentions légales de l'AN, novembre
2026) et les charger depuis son site transmettrait l'adresse IP des visiteurs. Le seul envoi à un tiers reste la recherche
par adresse, à la demande de l'utilisateur.

## Mentions légales et données personnelles

Page `#/mentions` (lien dans le pied de page) : éditeur (particulier non professionnel, LCEN art. 6-III-2), hébergeur,
sources, vie privée des visiteurs (aucun cookie ni mesure d'audience ; `localStorage` local ; journaux de GitHub ;
aucune image tierce), données personnelles des députés (source, finalité, base légale, durée) et
exercice des droits par courriel (jeremygforia@gmail.com, contact non public, réponse sous un mois) ou par les issues (modèle
`.github/ISSUE_TEMPLATE/donnees-personnelles.md`, qui rappelle que les issues sont publiques et renvoie au courriel). À mettre à jour si le site ajoute un traitement (statistiques, formulaire…).

## En local

```bash
python scripts/build_data.py          # télécharge ~90 Mo d'archives et génère data/ (quelques minutes)
python -m http.server 8000            # puis http://localhost:8000
python -m unittest discover -s tests  # tests hors ligne sur des extraits réels de l'Open Data
node --test tests/*.test.mjs           # tests de géométrie (recherche par adresse)
npm ci && npx playwright install chromium && npm run test:e2e   # tests du front dans un navigateur
npm ci && npm run build:css           # uniquement si vous modifiez les classes Tailwind
```

Options utiles : `--max-qe 0` (fiches de toutes les questions écrites), `--lois-seulement` (exclut résolutions, commissions
d'enquête…, incluses par défaut), `--max-dossiers N` (plafond, 0 = tous par défaut), `--max-textes N`, `--no-fulltext`,
`--source-dir <dossier de ZIP>` (hors ligne).

## Licence

Code : MIT. Données : Assemblée nationale, [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
Projet indépendant, non affilié à l'Assemblée nationale.
