/* Thème (clair ou sombre) appliqué avant le premier rendu, pour éviter un flash. Chargé de façon bloquante dans
 * le <head> de l'application et des pages statiques ; fichier séparé pour que la politique de sécurité de contenu
 * (script-src 'self') n'ait à autoriser aucun script en ligne. */
(function () {
    var t = null;
    try { t = localStorage.getItem('theme'); } catch (e) { /* stockage indisponible */ }
    if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
})();
