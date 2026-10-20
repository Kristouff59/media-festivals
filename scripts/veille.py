#!/usr/bin/env python3
"""Radar éditorial BACKSTAGE : découvertes de titres RSS, jamais publication automatique.

Les flux Google Actualités sont un canal de découverte non officiel et non garanti.
Toute information publiée doit ensuite être confirmée par la source primaire.
"""
import hashlib
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlencode

import requests

ROOT = Path(__file__).resolve().parent.parent
CONF = ROOT / "config/sources.json"
STATE = ROOT / "data/news_seen.json"
CANDIDATES = ROOT / "data/candidats"
MAX_FEED_ENTRIES = 35
CLIENT = requests.Session()
CLIENT.headers.update({"User-Agent": "BACKSTAGE/0.3 (RSS editorial discovery)", "Accept": "application/rss+xml, application/xml, text/xml"})

def plain(value):
    value = unicodedata.normalize("NFKD", value.lower())
    return "".join(c for c in value if not unicodedata.combining(c))

def clean_title(title, publisher):
    title = re.sub(r"\s+", " ", title or "").strip()
    if publisher and title.endswith(" - " + publisher):
        title = title[:-(len(publisher)+3)].strip()
    return title

def key(title):
    return re.sub(r"[^a-z0-9]+", " ", plain(title)).strip()

def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:24]

def score(headline, topic):
    t = plain(headline)
    festival = any(v in t for v in ("festival", "hellfest", "rock en seine", "main square", "dour ", "primavera", "sziget", "vieilles charrues", "francofolies"))
    concert = any(v in t for v in ("concert", "tournee", "tour ", " tournée", "live ", "sur scene", "stade de france", "accor arena", "olympia", "arena ", "festiv"))
    reunion = any(v in t for v in ("reformation", "se reforme", "groupe reforme",
                                   "band reunion", "band reunites", "bands reunite",
                                   "comeback", "retour sur scene", "return to the stage"))
    if "temple reforme" in t or "eglise reformee" in t or "culte reforme" in t:
        reunion = False
    annonce = any(v in t for v in ("annonce", "devoile", "confirme", "programmation", "affiche", "dates", "billet", "billetterie", "sold out", "complet", "line-up", "lineup"))
    societe = any(v in t for v in ("prix", "tarif", "revente", "arnaque", "annul", "securit", "accessibil", "pollution", "travail", "billetterie", "ticket", "econom"))
    if not (festival or concert or reunion or (societe and topic=="societe")):
        return 0
    value = (5 if festival else 0) + (5 if concert else 0) + (14 if reunion else 0)
    if annonce: value += 3
    if societe and (concert or festival or topic=="societe"): value += 5
    if any(v in t for v in ("france", "paris", "belgique", "suisse", "luxembourg", "bruxelles", "lyon", "lille", "marseille", "bordeaux", "allemagne")): value += 3
    if topic in ("retours", "reunions-internationales") and reunion: value += 5
    # Une reformation à l'étranger mérite un signalement, mais ne doit pas
    # étouffer les grandes annonces utiles aux lecteurs français.
    if topic == "reunions-internationales" and not any(v in t for v in ("france", "paris", "belgium", "europe", "european", "uk tour")):
        value -= 7
    if topic in ("festivals", "concerts", "voisins") and (festival or concert):
        value += 4
    if topic == "societe" and societe: value += 4
    if "playlist" in t or "streaming" in t and not (concert or festival): value -= 10
    # Un festival peut aussi concerner la BD, le cinéma ou la gastronomie :
    # imposer des indices musicaux avant de proposer une telle actualité.
    musical = any(v in t for v in ("musique", "concert", "artiste", "line-up", "lineup",
                                      "rock", "jazz", "rap", "metal", "electro", "dj ", "chanson",
                                      "groupe", "chanteur", "chanteuse", "tournee"))
    if festival and not musical:
        value -= 20
    # Notre rubrique concerts ne doit pas devenir l'agenda de petits concerts locaux.
    if topic == "concerts" and not (annonce or reunion or "tournee" in t or
       any(v in t for v in ("paris", "france", "bruxelles", "belgique",
                            "stade", "arena", "zenith", "mondiale", "europeenne"))):
        value -= 10
    return value

def rss_url(q, lang):
    edition = {"hl": "fr", "gl": "FR", "ceid": "FR:fr"} if lang == "fr" else {"hl": "en", "gl": "US", "ceid": "US:en"}
    return "https://news.google.com/rss/search?" + urlencode({"q": q, **edition})

def fetch_rss(url):
    response = CLIENT.get(url, timeout=20)
    response.raise_for_status()
    if len(response.content) > 1500000:
        raise ValueError("Flux anormalement volumineux")
    root = ET.fromstring(response.content)
    if root.tag != "rss":
        raise ValueError("Format RSS inattendu")
    return root.findall("./channel/item")[:MAX_FEED_ENTRIES]

def parse_item(item, theme, now):
    publisher = (item.findtext("source") or "").strip()
    title = clean_title(item.findtext("title"), publisher)
    link = (item.findtext("link") or "").strip()
    date_text = item.findtext("pubDate")
    if not title or not link.startswith("https://") or not date_text:
        return None
    try:
        date = parsedate_to_datetime(date_text).astimezone(timezone.utc)
    except (ValueError, TypeError, IndexError):
        return None
    if date < now - timedelta(days=8) or date > now + timedelta(days=1):
        return None
    relevance = score(title, theme["id"])
    if relevance < 7:
        return None
    normalized = key(title)
    if len(normalized) < 18:
        return None
    return {
        "titre": title, "source_media": publisher or "Média non précisé",
        "lien_decouverte": link, "date_source": date.isoformat(timespec="minutes"),
        "theme": theme["nom"], "theme_id": theme["id"], "score": relevance, "normalized": normalized, "key": sha(normalized)
    }

def make_digest(items, day):
    lines = [
        "# BACKSTAGE — propositions du " + day,
        "",
        "**Brouillons de veille, PAS des actualités validées.** Les titres proviennent d'un flux",
        "d'agrégation. Un titre ou une source secondaire ne confirme pas une annonce.",
        "Avant toute publication, trouver l'annonce d'un artiste, festival, tourneur ou organisateur,",
        "contrôler les dates et écrire un texte original. Ne pas copier le contenu des médias.",
        ""
    ]
    for n, item in enumerate(items, 1):
        lines.extend([
            "## " + str(n) + ". " + item["titre"],
            "- **Thème :** " + item["theme"],
            "- **Priorité indicative :** " + str(item["score"]) + " (filtre automatique, pas une preuve)",
            "- **Signalé par :** " + item["source_media"],
            "- **Date du signalement :** " + item["date_source"],
            "- **Lien de découverte :** " + item["lien_decouverte"],
            "- **Statut :** À vérifier sur une source officielle avant publication",
            ""
        ])
    return "\n".join(lines)

def run():
    config = json.loads(CONF.read_text(encoding="utf-8"))
    themes = config["themes"]
    now = datetime.now(timezone.utc)
    old = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    seen = old.get("seen", {})
    found = []
    fetched = 0
    for theme in themes:
        try:
            entries = fetch_rss(rss_url(theme["requete"], theme["langue"]))
            fetched += 1
            print(theme["nom"] + " : " + str(len(entries)) + " titres consultés")
            for entry in entries:
                suggestion = parse_item(entry, theme, now)
                if suggestion:
                    found.append(suggestion)
        except (requests.RequestException, ET.ParseError, ValueError) as exc:
            print("ATTENTION — échec flux " + theme["nom"] + " : " + str(exc), file=sys.stderr)
    if not fetched:
        print("ERREUR : aucun flux joignable, rien enregistré", file=sys.stderr)
        raise SystemExit(1)

    # Un même sujet paraît parfois dans plusieurs flux ou sous des titres presque identiques.
    unique = []
    for item in sorted(found, key=lambda x: (x["score"], x["date_source"]), reverse=True):
        if item["key"] in seen:
            continue
        if any(SequenceMatcher(None, item["normalized"], prev["normalized"]).ratio() > .82 for prev in unique):
            continue
        unique.append(item)
    # Diversifier une courte revue de presse : une rubrique n'occupe pas à elle
    # seule la totalité des propositions, sauf en l'absence d'autres sujets.
    limit = int(config.get("max_articles_par_veille", 5))
    order = ("concerts", "festivals", "societe", "voisins", "retours", "reunions-internationales")
    top, used = [], set()
    for theme_id in order:
        candidate = next((x for x in unique if x["theme_id"] == theme_id and x["key"] not in used), None)
        if candidate and len(top) < limit:
            top.append(candidate)
            used.add(candidate["key"])
    for candidate in unique:
        if len(top) >= limit: break
        if candidate["key"] not in used:
            top.append(candidate)
            used.add(candidate["key"])
    if top:
        CANDIDATES.mkdir(parents=True, exist_ok=True)
        filename = CANDIDATES / (now.strftime("%Y-%m-%d") + ".md")
        # Inclure les suggestions cumulées si deux passages ont lieu le même jour.
        if filename.exists():
            filename = CANDIDATES / (now.strftime("%Y-%m-%dT%H%M") + ".md")
        filename.write_text(make_digest(top, now.strftime("%d/%m/%Y")), encoding="utf-8")
    # Conserver une mémoire des résultats éligibles pour ne pas reproposer les mêmes articles.
    for item in unique:
        seen[item["key"]] = now.isoformat(timespec="minutes")
    # Empêcher l'augmentation sans limite de l'historique.
    cutoff = now - timedelta(days=35)
    seen = {k: v for k, v in seen.items() if datetime.fromisoformat(v) >= cutoff}
    if unique:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps({"seen": seen}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("À vérifier : " + str(len(top)) + " sujet(s). Aucun article publié.")

def self_test():
    dt = datetime(2026, 10, 20, tzinfo=timezone.utc)
    root = ET.fromstring('<rss><channel><item><title>Legendary band reunion tour - News</title><link>https://news.google.com/test</link><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate><source>News</source></item></channel></rss>')
    theme = {"id": "reunions-internationales", "nom": "Reformations"}
    result = parse_item(root.find("./channel/item"), theme, dt)
    assert result and result["score"] >= 10 and "Legendary" in result["titre"]
    assert score("Album studio : nouveautés de la semaine", "concerts") == 0
    assert score("Un festival de musique annonce ses artistes et sa billetterie en France", "festivals") > 8
    assert score("Festival Quai des Bulles : tarifs et billetterie", "societe") < 7
    assert score("Concert de flutes a bec au Temple reforme", "retours") < 7
    print("Tests de sélection RSS réussis")

if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        run()
