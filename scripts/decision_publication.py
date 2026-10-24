#!/usr/bin/env python3
"""Publier ou rejeter une proposition BACKSTAGE sur commentaire de l'éditeur.

Garde-fous : issue créée par le robot, éditeur nommé autorisé, mot exact,
empreinte du contenu, version précédente inchangée, mise à jour atomique SHA.
"""
import base64
import hashlib
import json
import os
import re
import sys

import requests
from relecture import MARKER, PATTERN, REPO, EDITOR

API = "https://api.github.com/repos/" + REPO
B = requests.Session()


def api(method, path, token, **kwargs):
    r = B.request(method, API + path, timeout=35,
                  headers={"Authorization": "Bearer " + token,
                           "Accept": "application/vnd.github+json",
                           "X-GitHub-Api-Version": "2022-11-28"}, **kwargs)
    if not r.ok:
        raise RuntimeError("GitHub HTTP " + str(r.status_code) + " (" + path +
                           ") : " + r.text[:180])
    return r.json() if r.content else {}


def decode_proposal(issue):
    if issue.get("state") != "open" or not issue.get("title", "").startswith("[À VALIDER] "):
        raise ValueError("Cette relecture n'est pas active")
    if issue.get("user", {}).get("login") not in ("github-actions[bot]",):
        raise ValueError("La proposition n'a pas été créée par le robot")
    body = issue.get("body") or ""
    match = re.search(r"<!--\s*" + MARKER +
                      r":([a-f0-9]{64}):([A-Za-z0-9+/=]+)\s*-->", body)
    if not match:
        raise ValueError("Fiche de publication non authentifiée")
    raw = base64.b64decode(match.group(2), validate=True).decode("utf-8")
    if hashlib.sha256(raw.encode("utf-8")).hexdigest() != match.group(1):
        raise ValueError("Empreinte de contenu modifiée")
    value = json.loads(raw)
    article = value.get("article")
    if not isinstance(article, dict) or not article.get("slug") or not article.get("sources"):
        raise ValueError("Article incomplet")
    if any(not str(s.get("url", "")).startswith("https://")
           for s in article.get("sources", [])):
        raise ValueError("Lien de source non sécurisé")
    if len(value.get("festivals", [])) > 2:
        raise ValueError("Modification massive de programmation refusée")
    return value


def update_catalog(current, proposal):
    """Fusionner le seul article approuvé et ses fiches festivals, sans écraser du travail."""
    m = re.search(PATTERN, current, re.S)
    if not m:
        raise ValueError("Catalogue absent")
    db = json.loads(m.group(1))
    article = proposal["article"]
    before = proposal.get("previous")
    slug = article["slug"]
    old = next((i for i, row in enumerate(db["articles"])
                if row["slug"] == slug), None)
    if before is None:
        if old is not None:
            raise ValueError("Cet article existe désormais : demande de relecture nécessaire")
        db["articles"].insert(0, article)
    else:
        if old is None or db["articles"][old] != before:
            raise ValueError("L'article a changé depuis la proposition")
        db["articles"][old] = article
    for change in proposal.get("festivals", []):
        name = change["name"]
        old_f = next((i for i, f in enumerate(db.get("festivals", []))
                      if f["name"].casefold() == name.casefold()), None)
        if change.get("previous") is None:
            if old_f is not None:
                raise ValueError("La fiche du festival existe déjà")
            db.setdefault("festivals", []).insert(0, change["new"])
        else:
            if old_f is None or db["festivals"][old_f] != change["previous"]:
                raise ValueError("La fiche festival a changé depuis la relecture")
            db["festivals"][old_f] = change["new"]
    raw = json.dumps(db, ensure_ascii=False, separators=(",", ":"))
    raw = raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return current[:m.start(1)] + raw + current[m.end(1):]


def handle_event():
    eventfile = os.getenv("GITHUB_EVENT_PATH", "")
    token = os.getenv("GITHUB_TOKEN", "")
    if not eventfile or not token:
        raise RuntimeError("Exécution réservée aux commentaires GitHub Actions")
    with open(eventfile, encoding="utf-8") as f:
        event = json.load(f)
    action = (event.get("comment") or {}).get("body", "").strip()
    commenter = (event.get("comment") or {}).get("user", {}).get("login")
    if commenter != EDITOR or action not in ("PUBLIER", "REFUSER"):
        print("Commande ou auteur non autorisé ; aucune action.")
        return
    issue_no = (event.get("issue") or {}).get("number")
    if not isinstance(issue_no, int) or issue_no < 1:
        raise ValueError("Numéro de proposition invalide")
    issue = api("GET", "/issues/" + str(issue_no), token)
    proposal = decode_proposal(issue)
    if action == "REFUSER":
        api("POST", "/issues/" + str(issue_no) + "/comments", token,
            json={"body": "Article refusé par la rédaction : aucune publication."})
        api("PATCH", "/issues/" + str(issue_no), token,
            json={"state": "closed", "state_reason": "not_planned"})
        print("Proposition refusée : " + str(issue_no))
        return

    content = api("GET", "/contents/index.html?ref=main", token)
    old_bytes = base64.b64decode(content["content"])
    updated = update_catalog(old_bytes.decode("utf-8"), proposal)
    # Le SHA de blob du dernier index.html est requis ; GitHub rejette les
    # modifications concurrentes au lieu d'écraser un article plus récent.
    api("PUT", "/contents/index.html", token, json={
        "message": "publication: article approuvé #" + str(issue_no),
        "content": base64.b64encode(updated.encode("utf-8")).decode("ascii"),
        "sha": content["sha"], "branch": "main"
    })
    # Les commits créés avec GITHUB_TOKEN ne relancent PAS d'eux-mêmes
    # GitHub Pages. Réclamer explicitement un build de la source configurée.
    deployed = False
    detail = ""
    try:
        api("POST", "/pages/builds", token)
        deployed = True
    except (requests.RequestException, RuntimeError) as exc:
        detail = str(exc)[:250]
        print("ATTENTION : publication commitée, reconstruction Pages non confirmée : " + detail)
    url = ("https://" + REPO.split("/")[0].lower() + ".github.io/" +
           REPO.split("/")[1] + "/#/article/" + proposal["article"]["slug"])
    message = ("✅ **Article approuvé et enregistré dans BACKSTAGE.**\n\n"
               + "[Lire l'article](" + url + ").\n\n"
               + ("Reconstruction GitHub Pages demandée." if deployed else
                  "⚠️ La reconstruction GitHub Pages n'a pas pu être demandée automatiquement. "
                  "Contrôler Settings → Pages et les Actions de déploiement."))
    api("POST", "/issues/" + str(issue_no) + "/comments", token,
        json={"body": message})
    api("PATCH", "/issues/" + str(issue_no), token,
        json={"state": "closed", "state_reason": "completed"})
    print("ARTICLE APPROUVÉ : " + url)


def self_test():
    current = ('<script>window.BACKSTAGE_CONTENT = ' +
               json.dumps({"articles": [], "festivals": []}) + ';</script>')
    proposed = {"article": {"slug": "test-rock", "title": "Le rock continue"},
                "previous": None,
                "festivals": [{"name": "Festival Rock", "previous": None,
                               "new": {"name": "Festival Rock", "lineup": []}}]}
    result = update_catalog(current, proposed)
    loaded = json.loads(re.search(PATTERN, result, re.S).group(1))
    assert len(loaded["articles"]) == 1
    assert len(loaded["festivals"]) == 1
    try:
        update_catalog(result, proposed)
    except ValueError:
        pass
    else:
        raise AssertionError("Doublon accepté")
    print("Tests de validation, dédoublonnage et publication : OK")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    elif "--decide" in sys.argv:
        handle_event()
    else:
        raise SystemExit("Utilisation : --self-test ou --decide")
