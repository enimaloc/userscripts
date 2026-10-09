# userscripts

Mes userscripts pour [Tampermonkey](https://www.tampermonkey.net/) (compatibles Violentmonkey).

## Installation

1. Installer l'extension Tampermonkey dans le navigateur.
2. Cliquer sur le lien « Installer » du script voulu : Tampermonkey ouvre sa page d'installation.

Les mises à jour arrivent ensuite automatiquement : chaque script pointe vers ce dépôt (`@updateURL`), il suffit d'augmenter son `@version` à chaque modification.

## Scripts

| Script | Site | Description | |
| --- | --- | --- | --- |
| [TCC – Export de l'album en image](tcc-collection-export.user.js) | `tcc.too-pixel.com` | Exporte toutes les cartes d'un album TCC (Twitch Collectible Cards), rangées par catégorie, dans une seule image. | [Installer](https://raw.githubusercontent.com/enimaloc/userscripts/master/tcc-collection-export.user.js) |

### TCC – Export de l'album en image

Sur `https://tcc.too-pixel.com/collection/<streamer>`, un bouton « 📸 Exporter l'album » apparaît en bas à droite. Il ouvre un panneau de réglages, puis un aperçu d'où l'on peut télécharger l'image, la copier ou l'ouvrir dans un onglet.

- Cartes créateur regroupées par catégorie, cartes générées et cartes followers en option.
- Cartes manquantes affichées par leur référence, variantes glitched et quantités de doublons.
- Nombre de cartes par ligne, largeur des cartes, thème sombre ou clair, PNG ou JPEG.

La page du site n'affiche que les lignes visibles à l'écran, donc le script relit l'album par l'API de TCC avec la session en cours et le redessine en entier. Rien n'est envoyé ailleurs.

## Ajouter un script

- Un fichier `nom-du-script.user.js` à la racine.
- Dans son en-tête, `@updateURL` et `@downloadURL` vers `https://raw.githubusercontent.com/enimaloc/userscripts/master/nom-du-script.user.js`.
- Une ligne de plus dans le tableau ci-dessus.
