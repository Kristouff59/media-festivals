#!/usr/bin/env python3
"""Envoyer les articles BACKSTAGE prêts à lire dans la rédaction privée Supabase.

Clé secrète exclusivement dans GitHub Actions. Aucun brouillon prépublication
n'est commité sur le site public ; approbation et publication passent par RLS.
"""
import hashlib
import json
import os
import sys
from urllib.parse import urlparse

import requests

ADMIN_PATH = "/admin/"
SESSION = requests.Session()


def configured():
    return bool(os.getenv("SUPABASE_URL", "").strip() and
                os.getenv("SUPABASE_SECRET_KEY", "").strip())


def fingerprint(proposal):
    raw = json.dumps(proposal, sort_keys=True, ensure_ascii=False,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def send_notification(title, identifier):
    api = os.getenv("RESEND_API_KEY", "").strip()
    recipient = os.getenv("BACKSTAGE_ALERT_EMAIL", "").strip()
    sender = os.getenv("BACKSTAGE_FROM_EMAIL", "").strip()
    site = (os.getenv("BACKSTAGE_SITE_URL") or
            "https://kristouff59.github.io/media-festivals").rstrip("/")
    if not (api and recipient and sender):
        print("Alerte e-mail non configurée (RESEND_API_KEY, BACKSTAGE_ALERT_EMAIL, BACKSTAGE_FROM_EMAIL).")
        return
    url = site + ADMIN_PATH
    text = "BACKSTAGE : nouvel article à lire et valider.\n\n" + title + "\n\n" + url
    response = SESSION.post(
        "https://api.resend.com/emails",
        headers={"Authorization": "Bearer " + api,
                 "Content-Type": "application/json",
                 "Idempotency-Key": "backstage/draft/" + identifier},
        json={"from": sender, "to": [recipient],
              "subject": "BACKSTAGE — Article à valider : " + title[:100],
              "text": text},
        timeout=20,
    )
    if not response.ok:
        # L'article reste disponible, même si l'envoi d'e-mail échoue.
        print("ATTENTION : e-mail non envoyé (HTTP " + str(response.status_code) +
              "). Vérifier Resend et le domaine d'expédition.")
    else:
        print("Notification e-mail de relecture envoyée.")


def enqueue(proposal):
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    secret = os.getenv("SUPABASE_SECRET_KEY", "").strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc.endswith(".supabase.co"):
        raise ValueError("SUPABASE_URL attendu : https://<projet>.supabase.co")
    if len(secret) < 30:
        raise ValueError("Clé serveur Supabase absente ou mal configurée")
    data = proposal.get("article", {})
    identifier = fingerprint(proposal)
    # Une empreinte empêche l'envoi deux fois du même brouillon lors des relances.
    payload = {"fingerprint": identifier, "slug": data["slug"],
               "title": data["title"], "excerpt": data.get("excerpt", ""),
               "payload": proposal, "status": "pending"}
    headers = {"apikey": secret, "Content-Type": "application/json",
               "Prefer": "resolution=ignore-duplicates,return=representation"}
    if not secret.startswith("sb_secret_"):
        # Compatibilité avec les anciennes clés JWT service_role.
        headers["Authorization"] = "Bearer " + secret
    response = SESSION.post(
        url + "/rest/v1/editorial_drafts?on_conflict=fingerprint",
        headers=headers, json=[payload], timeout=35)
    if not response.ok:
        raise RuntimeError("Impossible de déposer l'article dans Supabase : HTTP " +
                           str(response.status_code) + " ; " +
                           response.text[:180])
    rows = response.json()
    if rows:
        print("ARTICLE À VALIDER SUR /admin/ : " + data["title"])
        send_notification(data["title"], identifier)
    else:
        print("Article déjà transmis : aucune notification en double.")


def self_test():
    p = {"article": {"title": "Un nouveau festival", "slug": "nouveau",
                     "body": ["Du nouveau"], "sources": [{"url": "https://example.org"}]},
         "previous": None, "festivals": []}
    a = fingerprint(p)
    assert a == fingerprint(json.loads(json.dumps(p)))
    p["article"]["slug"] = "nouveau-2"
    assert a != fingerprint(p)
    print("Tests du stockage éditorial privé : OK")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        raise SystemExit("Utiliser la fonction enqueue depuis scripts/relecture.py")
