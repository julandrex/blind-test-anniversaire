# Génère le SQL qui remplit un blind test "en attente" à partir d'un fichier JSON de questions.
# Usage : python build_quiz_sql.py <quiz_id> <questions.json> > quiz.sql
# JSON : liste dans l'ordre de la playlist de
#   {"kind": "artist"|"title", "title": "...", "artist": "...", "track_id": "<id piste Spotify>",
#    "answer": "...", "decoys": ["...", "...", "..."]}
import json, random, sys

quiz_id = int(sys.argv[1])
items = json.load(open(sys.argv[2], encoding="utf-8"))

def lit(s):
    return "'" + str(s).replace("'", "''") + "'"

rng = random.Random(quiz_id)
# Place de la bonne réponse : autant de fois chaque case (A/B/C/D), dans un ordre aléatoire.
slots = [i % 4 for i in range(len(items))]
rng.shuffle(slots)
rows = []
for pos, q in enumerate(items, 1):
    assert q["kind"] in ("artist", "title"), q
    assert len(q["decoys"]) == 3 and q["answer"] not in q["decoys"], q
    choices = list(q["decoys"])
    rng.shuffle(choices)
    choices.insert(slots[pos - 1], q["answer"])
    rows.append("(%d,%d,%s,array[%s],%d,%s,%s,%s)" % (
        quiz_id, pos, lit(q["kind"]), ",".join(lit(c) for c in choices), choices.index(q["answer"]),
        lit(q["title"]), lit(q["artist"]), lit("https://open.spotify.com/track/" + q["track_id"])))

print("begin;")
print("delete from public.questions where quiz_id = %d;" % quiz_id)
print("insert into public.questions (quiz_id,pos,kind,choices,correct_index,track_title,track_artist,spotify_url) values")
print(",\n".join(rows) + ";")
print("update public.quizzes set status = 'ready' where id = %d;" % quiz_id)
print("commit;")
