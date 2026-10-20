#!/usr/bin/env python3
"""Prépare des fiches de rédaction à partir des candidats du radar.

Aucun fait n'est considéré comme confirmé, aucun article n'est publié.
Ne nécessite aucune API payante.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANDIDATES = ROOT / "data" / "candidats"
DRAFTS = ROOT / "data" / "brouillons"

CATEGORY = {
    "Grandes tournées en France": ("CONCERTS", "Actualité", "250 à 500 mots"),
    "Festivals et programmations": ("FESTIVALS", "Actualité", "250 à 500 mots"),
    "Enjeux de la musique live": ("SOCIÉTÉ", "Décryptage", "550 à 1 000 mots si le sujet le mérite"),
    "Grandes annonces dans les pays voisins": ("CONCERTS / FESTIVALS", "Actualité", "250 à 500 mots"),
    "Reformations et retours sur scène": ("CONCERTS", "Actualité majeure si confirmé", "300 à 650 mots"),
    "Band reunions and major comeback tours": ("CONCERTS", "Actualité majeure si confirmé", "300 à 650 mots"),
}
VERIFY_COMMON = [
    "Trouver un communiqué, site ou réseau officiel de l'artiste, du festival ou de l'organisateur.",
    "Vérifier la date de l'annonce, les lieux, les dates de concerts et les éventuelles modifications.",
    "Distinguer les faits confirmés des projections ou de l'interprétation d'un média tiers.",
    "Vérifier que les sources utilisées sont toujours accessibles et attribuer toute information empruntée.",
]
BY_TOPIC = {
    "CONCERTS": [
        "Quels pays et villes sont réellement concernés, notamment France et pays voisins ?",
        "Quelles sont les conditions officielles de réservation ou les dates de mise en vente ?",
        "Qu'est-ce qui rend cette annonce notable pour les amateurs de musique live ?",
    ],
    "FESTIVALS": [
        "Quels artistes sont annoncés officiellement (sans confondre rumeurs et confirmations) ?",
        "Quelles sont les dates, le lieu et les modalités d'accès confirmées ?",
        "Quelle nouveauté ou évolution distingue l'édition concernée ?",
    ],
    "SOCIÉTÉ": [
        "Quels documents et chiffres primaires permettent d'établir le problème ?",
        "Qui est concerné et quels sont les différents points de vue étayés ?",
        "Quelles conséquences concrètes pour le public, les artistes et les organisateurs ?",
    ],
}


def safe(text: str) -> str:
    """Aplatir les entrées RSS pour éviter injection de Markdown/HTML exploitable."""
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text or "")
    text = re.sub(r"\s+", " ", text)
    return text.replace("<", "‹").replace(">", "›").strip()[:550]


def slug(text: str) -> str:
    norm = unicodedata.normalize("NFKD", text.casefold())
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    norm = re.sub(r"[^a-z0-9]+", "-", norm).strip("-")
    suffix = hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]
    return (norm[:52].strip("-") or "sujet") + "-" + suffix


def parse_digest(raw: str) -> list[dict]:
    """Lit le format actuellement émis par scripts/veille.py."""
    items = []
    sections = re.split(r"(?m)^## \d+\. ", raw)
    for section in sections[1:]:
        lines = section.splitlines()
        if not lines:
            continue
        item = {"titre": safe(lines[0])}
        for line in lines[1:]:
            m = re.match(r"^- \*\*(.+?) :\*\* (.+)$", line)
            if m:
                item[m.group(1)] = safe(m.group(2))
        if not item.get("Thème") or not item.get("Lien de découverte"):
            continue
        if not item["Lien de découverte"].startswith("https://"):
            continue
        items.append(item)
    return items


def draft(item: dict, created: str) -> str:
    title = item["titre"]
    theme = item["Thème"]
    category, fmt, length = CATEGORY.get(theme, ("ACTUALITÉS", "Actualité", "250 à 500 mots"))
    # La source RSS peut être classée sous le mauvais thème.
    # Le nom explicite d'un festival prime sur ce classement automatique.
    title_lc = unicodedata.normalize("NFKD", title.lower())
    title_lc = "".join(c for c in title_lc if not unicodedata.combining(c))
    if any(name in title_lc for name in (
        "festival", "hellfest", "graspop", "rock en seine", "main square",
        "dour festival", "primavera sound", "sziget", "vieilles charrues"
    )):
        category, fmt, length = "FESTIVALS", "Actualité", "250 à 500 mots"
    specific = BY_TOPIC["SOCIÉTÉ" if category == "SOCIÉTÉ" else "FESTIVALS" if category == "FESTIVALS" else "CONCERTS"]
    items = "\n".join(f"- [ ] {v}" for v in VERIFY_COMMON + specific)
    return f"""---
statut: A_VERIFIER
publication: INTERDITE_AVANT_VALIDATION
cree_le: {created}
categorie: {category}
format: {fmt}
---

# {title}

> **Fiche de travail uniquement.** Le titre provient d'une source de découverte, pas
> d'une annonce officiellement confirmée. Ce document ne constitue PAS un article rédigé.

## L'information de départ

- **Titre à confirmer et à réécrire :** {title}
- **Thème :** {theme}
- **Signalement :** {item.get("Signalé par", "Non précisé")}
- **Date de la source :** {item.get("Date du signalement", "À confirmer")}
- **Lien de découverte (pas une validation) :** {item["Lien de découverte"]}

## Proposition de traitement

- **Rubrique :** {category}
- **Format suggéré :** {fmt}
- **Longueur indicative :** {length}; raccourcir s'il s'agit d'une simple brève.
- **Angle :** expliquer ce qui est réellement nouveau, pourquoi c'est important et
  ce qui change pour le public en France ou dans les pays voisins.

## Points à confirmer

{items}

## Plan de rédaction

### L'essentiel

[Deux ou trois phrases factuelles : qui, quoi, où, quand. Ne les écrire qu'après
confirmation auprès d'une source officielle.]

### Ce que cela change

[Contexte et intérêt particulier pour les spectateurs ; éviter les généralités,
les formules sensationnalistes ou les phrases destinées seulement à remplir.]

### Informations pratiques et suites

[Dates, villes, annonces de billetterie, évolution d'une programmation ou,
pour un décryptage, conséquences concrètes. Omettre cette section si inutile.]

## Sources et vérification

- **Source officielle primaire :** [LIEN À AJOUTER AVANT PUBLICATION]
- **Autre source indépendante (facultatif) :** [LIEN]
- **Responsable de la vérification :** [À RENSEIGNER]
- **Faits relus et validés :** [NON]
- **Date de vérification :** [À RENSEIGNER]

## Décision éditoriale

- [ ] Sujet digne de publication
- [ ] Sources primaires trouvées
- [ ] Article original rédigé et relu
- [ ] Dates / noms / tarifs revérifiés
- [ ] Publication autorisée par la rédaction

**La fusion de cette fiche dans GitHub ne publie rien sur le site.**
"""


def prepare(files: list[Path], max_per_run: int = 3) -> list[Path]:
    created = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    outputs = []
    for file in files:
        if len(outputs) >= max_per_run:
            break
        if not file.exists():
            continue
        candidates = parse_digest(file.read_text(encoding="utf-8"))
        if not candidates:
            continue
        # La date du digest est la date de sélection, pas une preuve de la date de l'événement.
        subdir = DRAFTS / file.stem.split("T")[0]
        subdir.mkdir(parents=True, exist_ok=True)
        for item in candidates:
            if len(outputs) >= max_per_run:
                break
            dest = subdir / (slug(item["titre"]) + ".md")
            if dest.exists():
                continue
            dest.write_text(draft(item, created), encoding="utf-8")
            outputs.append(dest)
    return outputs


def self_test():
    sample = """# BACKSTAGE — propositions
## 1. Groupe légendaire annonce des concerts en France
- **Thème :** Grandes tournées en France
- **Signalé par :** Média Exemple
- **Date du signalement :** 2026-10-20
- **Lien de découverte :** https://news.google.com/rss/articles/example
- **Statut :** À vérifier
"""
    parsed = parse_digest(sample)
    assert len(parsed) == 1
    article = draft(parsed[0], "2026-10-21")
    assert "[LIEN À AJOUTER" in article and "publication: INTERDITE_AVANT_VALIDATION" in article
    assert "250 à 500 mots" in article
    festival_item = dict(parsed[0], titre="Graspop Metal Meeting 2027 : un festival annonce sa tête d'affiche")
    assert "categorie: FESTIVALS" in draft(festival_item, "2026-10-21")
    assert ".." not in slug(parsed[0]["titre"])
    print("Test du préparateur éditorial : OK")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--max-per-run", type=int, default=3)
    parser.add_argument("files", nargs="*", type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not 1 <= args.max_per_run <= 5:
        parser.error("La limite doit être comprise entre 1 et 5")
    files = args.files or sorted(CANDIDATES.glob(datetime.now(timezone.utc).strftime("%Y-%m-%d") + "*.md"))
    created = prepare(files, args.max_per_run)
    print(f"Fiches de rédaction préparées : {len(created)}")
    for path in created:
        print(f"  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
