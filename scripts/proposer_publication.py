#!/usr/bin/env python3
"""Recherche, recoupement par citations officielles et projet d'article à approuver."""
import os,sys,re,json,hashlib,unicodedata
from pathlib import Path
from urllib.parse import urlparse
from datetime import datetime,timezone
import requests
from bs4 import BeautifulSoup
from preparer_articles import parse_digest

ROOT=Path(__file__).resolve().parent.parent
SITE=ROOT/"index.html"
API="https://api.openai.com/v1/responses"
MODEL="gpt-5.4-mini"
S=requests.Session()
S.headers.update({"User-Agent":"BACKSTAGE-verification/1.0"})
BLACKLIST=("news.google.com","google.com","lemonde.fr","infoconcert.com","ouest-france.fr","wikipedia.org","ticketmaster.fr","fnacspectacles.com","localhost","example.com")
def norm(x):
    t=unicodedata.normalize("NFKD",str(x).casefold())
    return re.sub(r"[^a-z0-9]+"," ","".join(c for c in t if not unicodedata.combining(c))).strip()
def official(url):
    try:
        p=urlparse(url);host=(p.hostname or "").lower()
        return p.scheme=="https" and "." in host and not host.startswith(("127.","10.","192.168.","169.254.","172.16.")) and not any(host==b or host.endswith("."+b) for b in BLACKLIST)
    except (TypeError,ValueError):return False
def extract_response_text(data):
    # Responses API: on ignore les appels d'outils, on lit seulement le message final.
    if data.get("status") not in ("completed", None):
        raise ValueError("Réponse OpenAI incomplète")
    parts=[]
    for output in data.get("output",[]):
        if output.get("type")!="message":
            continue
        for part in output.get("content",[]):
            if part.get("type")=="output_text":
                parts.append(part.get("text",""))
    text="".join(parts).strip()
    if not text:
        raise ValueError("Réponse éditoriale vide")
    return text

def call(key,prompt,search=False):
    # Un appel de recherche maximum, pour borner la dépense.
    payload={
        "model":MODEL,
        "input":prompt,
        "store":False,
        "max_output_tokens":3800 if search else 4900,
        "reasoning":{"effort":"low"},
        "text":{"format":{"type":"json_object"}}
    }
    if search:
        payload["tools"]=[{"type":"web_search","search_context_size":"medium"}]
        payload["tool_choice"]="required"
        payload["max_tool_calls"]=1
    response=S.post(
        API,headers={"Authorization":"Bearer "+key,
                     "Content-Type":"application/json"},
        json=payload,timeout=120
    )
    if not response.ok:
        raise ValueError("API OpenAI : HTTP "+str(response.status_code)+
                         " (contrôler le crédit, le quota et le modèle)")
    data=response.json()
    if search and not any(x.get("type")=="web_search_call" for x in data.get("output",[])):
        raise ValueError("Recherche Web non attestée dans la réponse")
    result=json.loads(extract_response_text(data))
    if not isinstance(result,dict):
        raise ValueError("Objet JSON attendu")
    return result

def proof(item):
    url=item.get("url")
    if not official(url):raise ValueError("Pas de source officielle acceptable")
    r=S.get(url,timeout=15,allow_redirects=False)
    if r.status_code!=200 or "html" not in r.headers.get("content-type",""):
        raise ValueError("Source officielle non directement accessible")
    if len(r.content)>1100000:raise ValueError("Page trop volumineuse")
    soup=BeautifulSoup(r.text,"html.parser")
    for el in soup.select("script,style,nav,footer,noscript"):el.decompose()
    page=norm(" ".join(soup.stripped_strings))
    if len(page)<250:raise ValueError("Source trop courte")
    found=[]
    for e in item.get("evidence",[]):
        q=norm(e.get("quote",""))
        if len(q)>=28 and q in page:found.append(q)
    if len(found)<3:raise ValueError("Trois citations exactes introuvables sur la source officielle")
    return url,page,found
def write_site(article):
    h=SITE.read_text(encoding="utf-8")
    m=re.search(r"window\.BACKSTAGE_CONTENT = (\{.*?\});</script>",h,re.S)
    if not m:raise ValueError("Catalogue du site absent")
    d=json.loads(m.group(1));title=article.get("title","")
    prose=article.get("body",[])+[p for part in article.get("sections",[]) for p in part.get("paragraphs",[])]
    if not isinstance(title,str) or not 20<len(title)<140:raise ValueError("Titre invalide")
    if len(prose)<3 or not all(isinstance(p,str) and 50<len(p)<1700 for p in prose):raise ValueError("Paragraphes invalides")
    count=len(" ".join(prose).split())
    if count<130 or count>850:raise ValueError("Longueur éditoriale inadaptée")
    if not isinstance(article.get("excerpt"),str) or not 65<len(article["excerpt"])<350:raise ValueError("Chapô invalide")
    if article.get("category") not in ("FESTIVALS","CONCERTS","SOCIÉTÉ"):raise ValueError("Rubrique invalide")
    if article["category"]=="SOCIÉTÉ" and count<400:raise ValueError("Décryptage trop court")
    for val in re.findall(r"\b\d{4}\b",norm(" ".join(prose)+title)):
        if val not in article["_source_text"]:raise ValueError("Année non corroborée : "+val)
    slug=norm(title).replace(" ","-")[:62]+"-"+hashlib.sha256(title.encode()).hexdigest()[:7]
    if any(x.get("slug")==slug for x in d["articles"]):raise ValueError("Doublon")
    source=article.pop("_official_url");article.pop("_source_text")
    article.update({"slug":slug,"date":datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "format":"DÉCRYPTAGE" if article["category"]=="SOCIÉTÉ" else "ACTUALITÉ",
        "readMinutes":max(2,round(count/205)),"visual":"visual-b",
        "artword":"LIVE","byline":"BACKSTAGE · La rédaction",
        "sources":[{"label":"Annonce officielle","url":source}]})
    d["articles"].insert(0,article)
    raw=json.dumps(d,ensure_ascii=False,separators=(",",":"))
    raw=raw.replace("<","\\u003c").replace(">","\\u003e").replace("&","\\u0026")
    SITE.write_text(h[:m.start(1)]+raw+h[m.end(1):],encoding="utf-8")
    return article,count
def prepare(key,item):
    research=call(key,"""Tu es documentaliste d'un média de musique live en France.
Piste RSS non vérifiée : """+item["titre"]+"""
Cherche sur le Web la source PRIMAIRE de l'artiste, du festival, du tourneur,
du producteur ou d'une institution. NE JAMAIS utiliser un article de presse
comme source officielle. Réponds UNIQUEMENT avec cet objet JSON :
{"confirmable":true,"url":"https://url-officielle","evidence":[
{"quote":"extrait EXACT de 30 à 130 caractères figurant réellement sur cette page"},
{"quote":"second extrait EXACT de cette même page"},
{"quote":"troisième extrait EXACT de cette même page"}]}.
Si ce n'est pas vérifiable : {"confirmable":false,"url":"","evidence":[]}.
Pas de phrases imaginées. Recherche uniquement des faits réels et récents.""",True)
    if research.get("confirmable") is not True:raise ValueError("Annonce non confirmée")
    url,page,quotes=proof(research)
    prompt="""Tu es un journaliste musical vivant, passionné de concerts, à dominante rock
mais ouvert à tous genres. Ton : humain, incisif, chaleureux, curieux, des rythmes
de phrases variés, parfois un peu d'ironie. Sensibilité sociale (accès aux concerts,
prix, travailleurs, environnement), sans partisanerie ni propagande.
Ne jamais paraître froid ou recopier un communiqué. Pas de formules bateau,
pas de références aux sources répétées à chaque paragraphe.
NE JAMAIS prétendre être allé sur place, avoir rencontré un artiste, ni inventer
des citations. AUCUNE information factuelle au-delà des extraits OFFICIELS.
Le ton peut être imagé sans inventer d'ambiance vécue.
Piste : """+item["titre"]+"""
Lien officiel : """+url+"""
PREUVES TEXTUELLES vérifiées : """+"\n".join(quotes)+"""
Rédige en français une brève vivante de 140 à 220 mots si les faits sont rares,
ou un article de 250 à 450 mots si les preuves permettent un vrai contexte.
Le lecteur doit comprendre l'annonce et pourquoi elle compte.
Réponds UNIQUEMENT en JSON :
{"title":"titre", "excerpt":"chapô", "category":"CONCERTS ou FESTIVALS ou SOCIÉTÉ",
"body":["introduction","paragraphe"],"sections":[
{"title":"intertitre","paragraphs":["paragraphe","paragraphe"]}]}.
N'ajoute ni noms, ni villes, ni dates, ni chiffres non présents dans les preuves.
Pas de publicité ni appel à l'action."""
    article=call(key,prompt)
    article["_official_url"]=url;article["_source_text"]=page
    return write_site(article)
def pending():
    token=os.getenv("GITHUB_TOKEN")
    if not token:return False
    repo=os.getenv("GITHUB_REPOSITORY","Kristouff59/media-festivals")
    r=S.get("https://api.github.com/repos/"+repo+"/pulls",
        params={"state":"open","per_page":100},
        headers={"Authorization":"Bearer "+token},timeout=15)
    r.raise_for_status()
    return any(x.get("head",{}).get("ref")=="bot/article-a-publier" for x in r.json())
def main():
    if "--self-test" in sys.argv:
        assert official("https://hellfest.fr/news")
        assert not official("https://news.google.com/rss/")
        assert norm("Écoute de Rock !")=="ecoute de rock"
        assert json.loads(extract_response_text({
            "status":"completed","output":[
                {"type":"web_search_call","id":"call_1"},
                {"type":"message","content":[{"type":"output_text","text":'{"test":true}'}]}
            ]}))["test"] is True
        print("Tests préparateur publication : OK");return
    key=os.getenv("OPENAI_API_KEY","").strip()
    if not key:
        print("Pas de secret OPENAI_API_KEY : rédaction complète désactivée, sans frais.")
        return
    if pending():
        print("Une proposition à publier est déjà en attente.");return
    today=datetime.now(timezone.utc).strftime("%Y-%m-%d")
    files=sorted((ROOT/"data"/"candidats").glob(today+"*.md"),reverse=True)
    items=[]
    for file in files:items.extend(parse_digest(file.read_text(encoding="utf-8")))
    for item in items[:2]:
        try:
            article,count=prepare(key,item)
            audit=ROOT/"redaction"/"validations"/(today+"-"+article["slug"]+".md")
            audit.parent.mkdir(parents=True,exist_ok=True)
            audit.write_text("# Proposition prête à valider\n\nArticle : "+article["title"]+
                "\n\nSource primaire consultée : "+article["sources"][0]["url"]+
                "\n\nContrôle automatique des extraits : OK\nLongueur : "+str(count)+
                " mots\n\nUne fusion de la Pull Request publie l'article. Vérification "
                "automatique non infaillible.\n",encoding="utf-8")
            print("PROPOSITION D'ARTICLE : "+article["title"]);return
        except (ValueError,TypeError,KeyError,requests.RequestException) as err:
            print("Écarté faute de preuve suffisante : "+item["titre"]+" / "+str(err))
    print("Aucun sujet n'a passé les contrôles. Rien à publier.")
if __name__=="__main__":main()
