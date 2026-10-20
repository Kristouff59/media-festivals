#!/usr/bin/env python3
"""Veille quotidienne de pages officielles : uniquement des brouillons à relire."""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "config/sources.json"
STATE = ROOT / "data/source_state.json"
QUEUE = ROOT / "data/review_queue"
AGENT = "BackstageEditorialWatch/0.2 (low-volume source attribution; GitHub project)"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": AGENT, "Accept": "text/html"})


def digest(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def download(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Source HTTPS obligatoire")
    robot = RobotFileParser()
    robot.set_url(f"{parsed.scheme}://{parsed.hostname}/robots.txt")
    try:
        response = SESSION.get(robot.url, timeout=12)
        if response.ok:
            robot.parse(response.text.splitlines())
            if not robot.can_fetch(AGENT, url):
                raise ValueError("Accès automatisé interdit par robots.txt")
    except requests.RequestException:
        # Refuser par prudence si l'autorisation ne peut pas être contrôlée.
        raise ValueError("Impossible de vérifier robots.txt")
    with SESSION.get(url, timeout=20, stream=True) as response:
        response.raise_for_status()
        parts, size = [], 0
        for chunk in response.iter_content(16384):
            size += len(chunk)
            if size > 1500000:
                raise ValueError("Page trop volumineuse (>1,5 Mo)")
            parts.append(chunk)
        html = b"".join(parts).decode(response.encoding or "utf-8", errors="replace")
    return html


def meaningful_lines(html, selector):
    soup = BeautifulSoup(html, "html.parser")
    main = soup.select_one(selector) if selector else None
    main = main or soup.find("main") or soup.find("body")
    if main is None:
        raise ValueError("Pas de contenu exploitable")
    for el in main.select("script,style,noscript,nav,footer,form,svg,button"):
        el.decompose()
    lines = []
    for s in main.stripped_strings:
        value = re.sub(r"\s+", " ", s).strip()
        if 12 <= len(value) <= 220 and value not in lines:
            lines.append(value)
        if len(lines) >= 250:
            break
    if len(lines) < 3:
        raise ValueError("Contenu extrait insuffisant")
    return lines


def run():
    sources = json.loads(SOURCES.read_text(encoding="utf-8"))
    if len(sources) > 25:
        raise ValueError("25 sources maximum")
    old = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    new = dict(old)
    QUEUE.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    changed = 0
    for source in sources:
        if not source.get("actif", False):
            continue
        try:
            url = source["url"]
            lines = meaningful_lines(download(url), source.get("selector", "main"))
            hashes = [digest(line) for line in lines]
            previous = old.get(source["id"], {}).get("hashes")
            new[source["id"]] = {"hashes": hashes, "url": url}
            if previous is None:
                print(f"{source['nom']}: référence initiale (pas d'alerte)")
                continue
            added = [v for v, h in zip(lines, hashes) if h not in set(previous)]
            if not added:
                print(f"{source['nom']}: aucun nouveau texte")
                continue
            snippet = " | ".join(added)[:550]
            identifier = digest(source["id"] + snippet)[:12]
            record = {
                "statut": "A_VERIFIER_AVANT_PUBLICATION",
                "festival": source["nom"],
                "source_officielle": url,
                "detecte_le_utc": now,
                "texte_nouveau_court": snippet,
                "instruction": "Comparer avec la source officielle. Un changement de page n'est pas nécessairement une annonce."
            }
            out = QUEUE / f"{source['id']}-{identifier}.json"
            if not out.exists():
                out.write_text(json.dumps(record, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
                changed += 1
            print(f"{source['nom']}: changement potentiel détecté")
        except Exception as err:
            print(f"AVERTISSEMENT: {source.get('nom')}: {err}", file=sys.stderr)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(new, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(f"Brouillons à vérifier créés : {changed}")


if __name__ == "__main__":
    run()
