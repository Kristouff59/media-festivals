#!/usr/bin/env python3
"""Préparer une fiche de relecture lisible dans GitHub Issues.

Le script ne publie jamais sur le site. Il crée une proposition assignée à
l'éditeur, à partir d'un article déjà validé par le moteur documentaire.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "index.html"
MARKER = "BACKSTAGE_REVIEW_V1"
REPO = os.getenv("GITHUB_REPOSITORY", "Kristouff59/media-festivals")
EDITOR = os.getenv("BACKSTAGE_EDITOR", "Kristouff59")
PATTERN = r"window\.BACKSTAGE_CONTENT = (\{.*?\});</script>"


def parse_site(source):
    match = re.search(PATTERN, source, re.S)
    if not match:
        raise ValueError("Catalogue du site introuvable")
    return json.loads(match.group(1))


def build_proposal(before, after):
    earlier = {a["slug"]: a for a in before["articles"]}
    updated = [a for a in after["articles"] if a != earlier.get(a["slug"])]
    if len(updated) != 1:
        raise ValueError("Une proposition doit contenir exactement un article")
    article = updated[0]
    if not article.get("sources") or not article.get("body"):
        raise ValueError("Article incomplet, refus de créer une relecture")
    before_fests = {f["name"].casefold(): f for f in before.get("festivals", [])}
    modified_fests = []
    for festival in after.get("festivals", []):
        old = before_fests.get(festival["name"].casefold())
        if old != festival:
            modified_fests.append({"name": festival["name"], "previous": old,
                                   "new": festival})
    if len(modified_fests) > 2:
        raise ValueError("Trop de fiches festivals modifiées dans une proposition")
    return {"article": article, "previous": earlier.get(article["slug"]),
            "festivals": modified_fests}


def render_article(proposal):
    a = proposal["article"]
    output = [
        "## " + a["title"],
        "",
        "**" + a["category"] + "** · " + a.get("format", "ACTUALITÉ"),
        "",
        "> " + a["excerpt"],
        "",
    ]
    for paragraph in a["body"]:
        output.extend([paragraph, ""])
    for section in a.get("sections", []):
        output.extend(["### " + section["title"], ""])
        for paragraph in section.get("paragraphs", []):
            output.extend([paragraph, ""])
    if proposal["festivals"]:
        output.extend(["---", "### Fiches festivals actualisées", ""])
        for row in proposal["festivals"]:
            f = row["new"]
            output.append("**" + f["name"] + "** — " + f.get("dates", "dates à confirmer"))
            for day in f.get("lineup", []):
                output.append("- " + day["day"] + " : " + ", ".join(day["artists"]))
            output.append("")
    output.extend(["---", "**Sources**", ""])
    for source in a["sources"]:
        output.append("- [" + source["label"] + "](" + source["url"] + ")")
    return "\n".join(output)


def serialize(proposal):
    raw = json.dumps(proposal, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    encoded = base64.b64encode(raw.encode("utf-8")).decode("ascii")
    checksum = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return "<!-- " + MARKER + ":" + checksum + ":" + encoded + " -->"


def issue_body(proposal):
    text = (
        "### BACKSTAGE · Article prêt à lire\n\n"
        "@"+EDITOR+" · Une nouvelle proposition est prête à lire.\n\n"
        "Tu trouveras ci-dessous **l'article intégral tel qu'il paraîtra sur le site**.\n\n"
        "**Pour le publier :** écris **PUBLIER** dans un commentaire en bas de la page.\n\n"
        "**Pour le refuser :** écris **REFUSER**.\n\n"
        "Aucune publication sans ta décision. "
        "Le texte est visible dans le dépôt GitHub public avant publication.\n\n"
        "---\n\n" + render_article(proposal)
    )
    return text + "\n\n" + serialize(proposal) + "\n"


def api(method, path, token, **kwargs):
    url = "https://api.github.com/repos/" + REPO + path
    response = requests.request(
        method, url, headers={"Authorization": "Bearer " + token,
                              "Accept": "application/vnd.github+json",
                              "X-GitHub-Api-Version": "2022-11-28"},
        timeout=35, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError("GitHub " + path + " : HTTP " + str(response.status_code) +
                           " " + response.text[:240])
    return response.json() if response.content else {}


def offer():
    token = os.getenv("GITHUB_TOKEN", "")
    if not token:
        raise ValueError("GITHUB_TOKEN nécessaire pour avertir l'éditeur")
    base = subprocess.check_output(
        ["git", "show", "HEAD:index.html"], cwd=ROOT, text=True, encoding="utf-8")
    current = SITE.read_text(encoding="utf-8")
    if base == current:
        print("Aucun nouvel article complet à soumettre.")
        return
    proposal = build_proposal(parse_site(base), parse_site(current))
    # Avec Supabase configuré, l'éditeur n'a plus jamais à ouvrir GitHub.
    # Les brouillons restent privés en base, aucun article non approuvé
    # n'est envoyé dans les Issues publiques.
    from supabase_queue import configured, enqueue
    if configured():
        try:
            enqueue(proposal)
        finally:
            SITE.write_text(base, encoding="utf-8")
        return
    # Mode de transition tant que la base Supabase privée n'est pas prête :
    # ancien système GitHub Issues conservé, sans bloquer la veille.
    # Ne pas écrire index.html sur main, et ne pas déposer d'article
    # non approuvé dans une PR.
    active = api("GET", "/issues?state=open&per_page=100", token)
    opened = [i for i in active if i.get("title", "").startswith("[À VALIDER] ")
              and "pull_request" not in i]
    if len(opened) >= 5:
        print("La boîte de validation est pleine (5 articles).")
        return
    if any(i.get("title", "") == "[À VALIDER] " + proposal["article"]["title"]
           for i in opened):
        print("Cette actualité est déjà proposée à l'éditeur.")
        return
    article = proposal["article"]
    result = api("POST", "/issues", token, json={
        "title": "[À VALIDER] " + article["title"],
        "body": issue_body(proposal),
        "assignees": [EDITOR],
    })
    print("RELECTURE PRÊTE À APPROUVER : " + result["html_url"])
    # Ne pas conserver le HTML modifié par la génération dans l'espace de travail.
    SITE.write_text(base, encoding="utf-8")


def self_test():
    sample = {
        "title": "Une grande annonce rock à Paris", "slug": "test-rock",
        "excerpt": "Un festival revient avec une nouvelle programmation très attendue par le public.",
        "category": "FESTIVALS", "format": "ACTUALITÉ",
        "body": ["Un texte de test composé de quelques phrases naturelles."],
        "sections": [{"title": "La suite", "paragraphs": ["Un nouveau paragraphe."]}],
        "sources": [{"label": "Site officiel", "url": "https://example.org"}],
    }
    after = {"articles": [sample], "festivals": []}
    before = {"articles": [], "festivals": []}
    proposal = build_proposal(before, after)
    assert proposal["article"]["slug"] == "test-rock"
    body = issue_body(proposal)
    assert "**PUBLIER**" in body and "Une grande annonce" in body
    assert MARKER in body and "### La suite" in body
    assert len(body) < 62000
    print("Tests des fiches de relecture : OK")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    elif "--offer" in sys.argv:
        offer()
    else:
        raise SystemExit("Utilisation : --self-test ou --offer")
