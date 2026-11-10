# Consignes pour Claude

## Commits et pull requests

- Ne jamais ajouter de lien de session (`Claude-Session: …`, `https://claude.ai/code/session_…`) dans un message de
  commit, une description de pull request ou un commentaire.
- Conserver la ligne `Co-Authored-By: Claude …` à la fin des messages de commit.
- Messages de commit et descriptions de pull request en français.

## Vérifications avant de pousser

```bash
python -m unittest discover -s tests   # pipeline et contrôles statiques du front
node --test tests/*.test.mjs           # géométrie
npm run test:e2e                       # front dans un navigateur (après npm ci)
```

## Contraintes du projet

- Aucune ressource tierce : ni CDN, ni police distante, ni image chargée depuis un autre site, ni mesure d'audience
  par script. Le seul envoi à un tiers est la recherche par adresse, déclenchée par l'utilisateur.
- `scripts/build_data.py` et `scripts/build_pages.py` n'utilisent que la bibliothèque standard de Python.
- Toute donnée insérée dans une page statique passe par `e()` (échappement) ; les liens par `lien()` (http(s) seulement).
- La page statique d'un député se limite à son mandat : ni naissance, ni profession, ni coordonnées.
- Les données générées vivent sur la branche `data`, jamais sur `main`.
