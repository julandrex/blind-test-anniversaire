# Préparer un blind test « en attente » (procédure pour Claude)

Déclencheur : l'utilisateur dit « prépare les blind tests en attente » (ou colle un lien de playlist).
Le travail ne touche pas à la partie en cours : on ne modifie que `quizzes` et `questions` du blind test en attente.

## 1. Trouver les blind tests en attente
Supabase, projet `blind-test-anniversaire` (id `eebmedpowzrpccbfijje`) :
```sql
select id, name, playlist_url from public.quizzes where status = 'pending' order by created_at;
```
Si l'utilisateur colle un lien directement dans la conversation, l'ajouter d'abord :
`insert into public.quizzes (name, playlist_url) values ('<nom>', 'https://open.spotify.com/playlist/<id>') returning id;`

## 2. Lire la playlist
Scraper `https://open.spotify.com/playlist/<id>` (markdown, attendre ~3 s) : on obtient, dans l'ordre,
titre, artiste(s) et lien `open.spotify.com/track/<id>` de chaque piste.
Une playlist très longue peut ne pas être entièrement chargée : vérifier le nombre de titres annoncé (« N songs ») et le dire à l'utilisateur s'il en manque.
Si le blind test n'a pas encore de vrai nom (« Nouvelle playlist »), reprendre le titre de la playlist.

## 3. Écrire les questions (même style que le premier blind test)
- Une question par piste, **dans l'ordre de la playlist**.
- Environ 60 % « Qui chante ? » (`artist`) et 40 % « Quel est le titre ? » (`title`), en alternant sans schéma prévisible.
- Niveau moyen à difficile : 3 leurres plausibles **de la même époque et du même style**
  (ex. Claude François → Mike Brant, Joe Dassin, Frédéric François).
  Pour les titres : de préférence d'autres chansons connues du même artiste.
- `title` = titre propre (sans « Radio Edit », « feat. … », « Remastered ») ; `artist` = artistes tels qu'affichés.
- Featuring : la bonne réponse est l'artiste principal, les leurres sont des artistes seuls (ou des duos du même format).

Écrire le JSON (format en tête de `build_quiz_sql.py`), puis :
```
python build_quiz_sql.py <quiz_id> questions_<quiz_id>.json > quiz_<quiz_id>.sql
```
et exécuter le SQL avec `execute_sql`. Le blind test passe en « ✅ prêt » dans la page animateur.

## 4. Vérifier
```sql
select count(*), min(pos), max(pos) from public.questions where quiz_id = <id>;
```
Aucun republish du site n'est nécessaire : tout est dans la base.
