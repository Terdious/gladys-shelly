# Intégration Shelly pour Gladys Assistant

Cette intégration connecte vos appareils **Shelly** à Gladys Assistant : relais,
prises connectées et compteurs d'énergie.

Elle parle **directement à vos appareils sur votre réseau local** (protocole RPC
Gen2+), et peut basculer sur le **Shelly Cloud** quand un appareil n'est pas
joignable localement. Aucun broker MQTT, aucun compte obligatoire : une
installation 100 % locale fonctionne avec un formulaire **entièrement vide**.

> **Générations supportées :** Gen2 et suivantes — Shelly **Plus**, **Pro**,
> **Mini**, **Gen3**, **Gen4**. Les appareils **Gen1** (Shelly 1, 2.5, Plug S
> « SHPLG-S », Dimmer 2…) utilisent une API totalement différente et ne sont
> **pas encore** supportés ; ils sont détectés et ignorés proprement, avec un
> message explicite dans les logs.

---

## Prérequis

- Gladys Assistant **4.83.0** ou plus récent.
- Vos Shelly sont alimentés et connectés à votre Wi-Fi (configuration faite
  depuis l'application Shelly ou l'interface web de l'appareil).
- Gladys et vos Shelly sont sur **le même réseau local** — ou vous connaissez
  les adresses IP des appareils situés sur un autre VLAN.

---

## Étape 1 — Installez l'intégration

Dans Gladys : **Intégrations → Installer une intégration → Shelly**, puis
**Installer**. Gladys télécharge l'image Docker et démarre le conteneur.

Vous n'avez **rien à configurer** pour une installation locale simple : passez
directement à l'étape 3.

---

## Étape 2 — Configurez (uniquement si nécessaire)

Ouvrez la page **Configuration** de l'intégration. Tous les champs sont
optionnels.

### Connexion locale

| Champ                                    | Quand le remplir                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adresses d'appareils supplémentaires** | Vos Shelly ne sont pas trouvés automatiquement (autre VLAN, mDNS désactivé sur l'appareil ou filtré par le routeur). Saisissez les IP séparées par des virgules. |
| **Nom d'utilisateur des appareils**      | Laissez `admin` : c'est le seul nom d'utilisateur accepté par les Gen2+.                                                                                         |
| **Mot de passe des appareils**           | Vous avez activé l'authentification sur vos Shelly. **Un seul mot de passe** est utilisé pour tous les appareils.                                                |

> ⚠️ Si vos Shelly ont des mots de passe **différents**, l'intégration ne pourra
> joindre que ceux qui partagent le mot de passe saisi. Uniformisez le mot de
> passe, ou désactivez l'authentification sur votre réseau local de confiance.

### Shelly Cloud (secours)

À remplir uniquement si vous voulez que Gladys puisse piloter un appareil
**injoignable localement** (Gladys hébergé ailleurs, appareil sur un autre
réseau, coupure Wi-Fi temporaire).

1. Ouvrez l'application **Shelly** (ou <https://control.shelly.cloud/>).
2. **Réglages → Réglages utilisateur → Clé d'autorisation cloud**.
3. Cliquez sur **Obtenir la clé** : l'application affiche la **clé
   d'autorisation** et l'**adresse du serveur** (du type
   `shelly-53-eu.shelly.cloud`).
4. Recopiez les deux valeurs dans Gladys et activez **Activer le secours par le
   Shelly Cloud**.

> 🔐 Cette clé donne le **contrôle total** sur tous les appareils de votre compte
> Shelly. Traitez-la comme un mot de passe. Elle est stockée chiffrée par Gladys
> et n'est jamais affichée en clair.

Quand les deux canaux sont configurés, Gladys affiche un interrupteur standard
**« Préférer la connexion locale »** (activé par défaut). C'est une préférence :
l'intégration l'applique quand elle le peut, et affiche la réalité appareil par
appareil grâce aux **badges de transport** (voir plus bas).

### Avancé

**Intervalle de rafraîchissement** : à quelle fréquence Gladys lit l'état de
chaque appareil. 30 secondes par défaut.

Un intervalle plus court donne des valeurs plus fraîches, mais génère plus de
requêtes. Gladys limite les états à **300 par minute** pour une intégration :
l'intégration ne publie que les valeurs qui **ont réellement changé** (avec un
rafraîchissement forcé toutes les 30 minutes pour qu'une valeur figée ne
paraisse pas morte), donc l'intervalle court n'est pénalisant que si beaucoup de
valeurs bougent en permanence. Un Shelly Pro 3EM porte à lui seul ~25 mesures :
au-delà de 3 ou 4 compteurs d'énergie, restez à 30 secondes ou plus.

---

## Étape 3 — Découvrez vos appareils

Allez dans l'onglet **Découverte** de l'intégration et cliquez sur
**Rechercher**.

Gladys interroge trois sources et les fusionne :

1. **mDNS** — vos Shelly s'annoncent sur le réseau (service `_shelly._tcp`). Le
   cœur de Gladys écoute pour le compte de l'intégration : les conteneurs sont
   sur un réseau bridge et ne reçoivent jamais le trafic multicast.
2. **Les adresses que vous avez saisies** à l'étape 2.
3. **Les adresses des appareils déjà créés** dans Gladys — un nouveau scan ne
   perd jamais un appareil dont l'annonce mDNS a été ratée.

Chaque adresse est ensuite interrogée en **unicast** (qui, lui, traverse le
réseau bridge). Cliquez sur **Créer** pour ajouter un appareil à Gladys.

### Un Shelly = un appareil Gladys

Un Shelly Pro 4PM devient **un seul appareil Gladys** portant **quatre**
fonctionnalités On/Off, plus leurs mesures. C'est la convention Gladys, et elle
garde les identifiants stables si vous renommez un canal.

Si vous avez nommé vos canaux dans l'application Shelly (« Salle de bain »,
« WC »…), ces noms sont repris : vous obtenez « Salle de bain — On/Off » plutôt
que quatre « On/Off » identiques. **Nommez vos canaux dans l'application Shelly
avant de lancer la découverte** : c'est la façon la plus rapide d'obtenir un
résultat lisible.

---

## Appareils et mesures supportés

Les fonctionnalités sont déduites de ce que l'appareil **déclare réellement**,
jamais d'une liste de modèles codée en dur : un Shelly Pro 1 (sans mesure)
n'expose qu'un On/Off, un Pro 1PM expose aussi puissance, tension, courant et
énergie — et un Shelly sorti après cette version fonctionne s'il parle le même
vocabulaire.

| Composant Shelly      | Ce que vous obtenez dans Gladys                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `switch:N`            | On/Off (pilotable), puissance (W), tension (V), courant (A), énergie totale (kWh), température interne (°C)                             |
| `em:N` (triphasé)     | Par phase L1/L2/L3 : puissance active (W), puissance apparente (VA), tension (V), courant (A) — plus les totaux et le courant de neutre |
| `emdata:N`            | Énergie totale et énergie réinjectée, par phase et au total (kWh)                                                                       |
| `em1:N` / `em1data:N` | Équivalents monophasés (Shelly Pro EM, 1PM Mini Gen3)                                                                                   |
| `pm1:N`               | Puissance, tension, courant, énergie d'un compteur seul (PM Mini)                                                                       |
| `temperature:N`       | Température (°C)                                                                                                                        |
| `humidity:N`          | Humidité (%)                                                                                                                            |
| `devicepower:N`       | Niveau de batterie (%)                                                                                                                  |

Matériel validé par conception sur les payloads réels : **Shelly Pro 3EM**,
**Shelly Pro 4PM**, **Shelly Plus Plug S**.

> **Pas encore supportés :** volets roulants (`cover`), éclairages variables
> (`light`), entrées (`input`), appareils Gen1. Voir la
> [roadmap](./ROADMAP.md).

### Le courant de neutre

Sur un Pro 3EM, `n_current` n'est mesuré que si vous avez **câblé la pince de
neutre**. Sans elle, l'appareil renvoie `null` : la fonctionnalité n'est alors
**pas créée du tout**, plutôt que d'afficher un graphique définitivement vide.
Si vous ajoutez la pince plus tard, relancez une découverte pour faire
apparaître la mesure.

---

## Les badges de transport

Chaque appareil affiche dans Gladys un badge indiquant **par quel canal il est
réellement joint** :

| Badge                    | Signification                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Local**                | Nominal. Gladys parle directement à l'appareil sur votre réseau.                                                                       |
| **Cloud**                | Gladys passe par le Shelly Cloud (vous avez décoché « Préférer la connexion locale »).                                                 |
| **Cloud** + point orange | **Dégradé** : l'appareil n'était pas joignable localement, Gladys est passée par le cloud. Survolez le badge pour connaître la raison. |
| **Injoignable**          | Ni le réseau local ni le cloud n'ont répondu.                                                                                          |

Un badge **Cloud avec point orange** est le signal à surveiller : votre
installation fonctionne, mais pas dans son mode nominal. La bulle d'aide indique
la cause — appareil éteint, IP changée, ou mot de passe refusé.

---

## Mettre à jour l'intégration

Gladys signale les mises à jour disponibles dans **Intégrations**. Cliquez sur
**Mettre à jour** : le conteneur est recréé avec la nouvelle image, votre
configuration et vos appareils sont conservés.

---

## Dépannage

### Aucun appareil trouvé lors du scan

1. **Vérifiez que l'appareil répond.** Depuis un navigateur sur le même réseau,
   ouvrez `http://<ip-du-shelly>/shelly`. Vous devez voir un JSON contenant
   `"gen": 2` (ou 3, ou 4). Si vous ne voyez **pas** de champ `gen`, c'est un
   appareil Gen1 : il n'est pas encore supporté.
2. **Le mDNS ne traverse pas les VLAN ni certains points d'accès Wi-Fi.**
   Saisissez les adresses IP à la main dans **Adresses d'appareils
   supplémentaires**, puis sauvegardez : la découverte se relance
   automatiquement.
3. **Regardez les logs du conteneur** (`docker logs <conteneur>`). L'intégration
   journalise le nombre d'adresses candidates, leur origine, et la raison
   exacte pour laquelle une adresse a été écartée.

### « L'appareil a refusé le mot de passe »

Vous avez activé l'authentification sur ce Shelly, et le mot de passe saisi dans
Gladys ne correspond pas. Sur les Gen2+ le nom d'utilisateur est **toujours**
`admin` : seul le mot de passe compte. Corrigez-le et sauvegardez — la
correction est prise en compte immédiatement, sans redémarrer le conteneur.

### Un appareil bascule tout le temps en Cloud (badge orange)

Son adresse IP a probablement changé (bail DHCP). Relancez une **découverte** :
l'adresse est ré-apprise et mémorisée. Pour éviter la récidive, réservez une IP
fixe pour vos Shelly dans votre box/routeur.

### Le Shelly Cloud a refusé la clé d'autorisation

Recopiez la clé **et** l'adresse du serveur depuis l'application Shelly : les
deux vont ensemble, et l'adresse du serveur dépend de la région de votre compte.
Une clé valide sur le mauvais serveur est rejetée.

### Les valeurs ne se mettent pas à jour aussi vite que prévu

L'intégration ne publie que les valeurs **qui ont changé**. Une valeur stable
n'est republiée que toutes les 30 minutes. C'est volontaire : Gladys limite une
intégration à 300 états par minute, et un seul Pro 3EM porte ~25 mesures.

Si vous avez besoin de valeurs vraiment temps réel, c'est l'objet de l'évolution
« notifications temps réel (WebSocket) » de la [roadmap](./ROADMAP.md) : les
Shelly Gen2+ savent pousser leurs changements au lieu d'être interrogés.

### Migration depuis une intégration MQTT / Node-RED existante

Cette intégration crée ses **propres** appareils avec ses propres identifiants
(`ext:shelly:device:...`). Elle ne reprend pas l'historique d'appareils créés
via MQTT : les deux peuvent cohabiter le temps de la transition, puis vous
supprimez les anciens.

---

## Aller plus loin

- [README du projet](../README.md) — architecture et développement
- [Roadmap](./ROADMAP.md) — ce qui est fait, ce qui arrive
- [Documentation de l'API Shelly Gen2+](https://shelly-api-docs.shelly.cloud/gen2/)
- [Signaler un problème](https://github.com/Terdious/gladys-shelly/issues)
