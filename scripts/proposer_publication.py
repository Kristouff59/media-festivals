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
        # La recherche Web d'OpenAI n'est pas compatible avec JSON mode.
        # Demander du JSON dans le prompt et l'analyser après réponse.
        payload.pop("text",None)
        payload["tools"]=[{"type":"web_search","search_context_size":"medium"}]
        payload["tool_choice"]="required"
        payload["max_tool_calls"]=1
    response=S.post(
        API,headers={"Authorization":"Bearer "+key,
                     "Content-Type":"application/json"},
        json=payload,timeout=120
    )
    if not response.ok:
        try:
            error=response.json().get("error",{})
            message=str(error.get("message","")).replace("\n"," ")[:280]
            param=str(error.get("param") or "")[:90]
        except (ValueError,TypeError,AttributeError):
            message="Réponse d'erreur non décodable"
            param=""
        # Erreur technique globale : ne pas la confondre avec un article non confirmé.
        raise RuntimeError("Erreur API OpenAI HTTP "+str(response.status_code)+
                           " ; paramètre="+param+" ; motif="+message)
    data=response.json()
    if search and not any(x.get("type")=="web_search_call" for x in data.get("output",[])):
        raise ValueError("Recherche Web non attestée dans la réponse")
    result=json.loads(extract_response_text(data).strip().strip(chr(96)).removeprefix("json").strip())
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
    return url,page,found,""
def find_known_official(title):
    """Un festival déjà traité n'a pas à être redécouvert par recherche Web."""
    raw=SITE.read_text(encoding="utf-8")
    match=re.search(r"window\\.BACKSTAGE_CONTENT = (\\{.*?\\});</script>",raw,re.S)
    if not match:return None
    db=json.loads(match.group(1))
    term=norm(title)
    candidates=[]
    for row in db.get("festivals",[]):
        if norm(row.get("name","")) in term and official(row.get("url","")):
            candidates.append((row["name"],row["url"]))
    # Une ancienne actualité peut déjà contenir le lien officiel d'un festival
    # sans que ce dernier figure encore dans le catalogue.
    for a in db.get("articles",[]):
        if a.get("category")!="FESTIVALS":continue
        title_tokens=set(norm(a.get("title","")).split())
        shared=title_tokens.intersection(norm(title).split())
        if len(shared)<3:continue
        for source in a.get("sources",[]):
            url=source.get("url","")
            if official(url):
                candidates.append((a.get("title",""),url))
    return candidates[0] if candidates else None

def official_excerpt(raw,year):
    """Isoler la programmation de l'édition visée des archives précédentes."""
    if not year:return ""
    pattern=r"(?:programmation|line[ -]?up)\\s*"+str(year)
    match=re.search(pattern,raw,re.I)
    if not match:return ""
    tail=raw[match.start():]
    next_year=re.search(r"(?:programmation|line[ -]?up|we love green)\\s*20(?:2[0-9])",tail[40:],re.I)
    if next_year:
        tail=tail[:40+next_year.start()]
    return tail[:5500]

def fetch_verified_official(url,topic):
    if not official(url):raise ValueError("Lien officiel invalide")
    response=S.get(url,timeout=16,allow_redirects=False)
    if response.status_code!=200 or "html" not in response.headers.get("content-type",""):
        raise ValueError("Site officiel inaccessible : HTTP "+str(response.status_code))
    if len(response.content)>1100000:raise ValueError("Source trop volumineuse")
    soup=BeautifulSoup(response.text,"html.parser")
    for node in soup.select("script,style,noscript,nav,footer"):node.decompose()
    lines=[re.sub(r"\\s+"," ",v).strip() for v in soup.stripped_strings]
    clean="\\n".join(v for v in lines if v)
    normalized=norm(clean)
    if len(normalized)<250:raise ValueError("Site officiel insuffisamment documenté")
    years=re.findall(r"\\b20[2-9][0-9]\\b",topic)
    year=years[0] if years else None
    if year and year not in normalized:
        raise ValueError("L'édition "+year+" n'apparaît pas sur la source officielle")
    excerpt=official_excerpt(clean,year)
    if not excerpt:
        raise ValueError("Impossible d'isoler la programmation officielle de cette édition")
    if len(norm(excerpt))<90:raise ValueError("Programmation officielle trop courte")
    return url,normalized,[excerpt],norm(excerpt)

def update_festival(db,festival,official_url,source_text,edition_text):
    """Mettre à jour un festival uniquement si son programme apparaît dans l'édition officielle."""
    if not isinstance(festival,dict) or not edition_text:return False
    name=festival.get("name")
    if not isinstance(name,str) or not 5<=len(name)<=90:return False
    if norm(name) not in source_text:return False
    try:year=int(festival.get("editionYear"))
    except (TypeError,ValueError):return False
    if not 2026<=year<=2035 or str(year) not in source_text:return False
    info=festival.get("lineup")
    if not isinstance(info,list) or not 1<=len(info)<=6:return False
    proven=[]
    for day in info:
        if not isinstance(day,dict):continue
        label=day.get("day")
        artists=day.get("artists",[])
        if not isinstance(label,str) or not isinstance(artists,list):continue
        if not norm(label) in edition_text:continue
        valid=[a for a in artists if isinstance(a,str) and 2<len(a)<90 and norm(a) in edition_text]
        if valid:proven.append({"day":label,"artists":valid[:18]})
    if sum(len(day["artists"]) for day in proven)<2:return False
    country=festival.get("country") if festival.get("country") in ("France","Belgique","Suisse","Allemagne","Luxembourg","Espagne","Pays-Bas","Royaume-Uni","Hongrie") else "France"
    city=festival.get("city") if isinstance(festival.get("city"),str) and len(festival["city"])<90 else "À confirmer"
    row={"name":name,"city":city,"country":country,"genres":"Rock / Pop / Électro",
         "url":official_url,"code":"FEST","dates":festival.get("dates",""),
         "editionYear":year,"lineupStatus":"Premiers noms officiellement confirmés",
         "lineup":proven}
    old=next((i for i,x in enumerate(db["festivals"]) if norm(x["name"])==norm(name)),None)
    if old is not None:
        current=db["festivals"][old]
        row.update({k:current[k] for k in ("city","country","genres","code") if k in current})
        db["festivals"][old]=row
    elif len(db["festivals"])<24:
        db["festivals"].insert(0,row)
    else:return False
    return True

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
    source=article.pop("_official_url")
    source_text=article.pop("_source_text")
    edition_text=article.pop("_edition_text","")
    festival=article.pop("festival",None)
    if article["category"]=="FESTIVALS":
        update_festival(d,festival,source,source_text,edition_text)
    article.update({"slug":slug,"date":datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "format":"DÉCRYPTAGE" if article["category"]=="SOCIÉTÉ" else "ACTUALITÉ",
        "readMinutes":max(2,round(count/205)),"visual":"visual-b",
        "artword":"LIVE","byline":"BACKSTAGE · La rédaction",
        "sources":[{"label":"Annonce officielle","url":source}]})
    # Une annonce initiale enrichie ne doit pas créer un deuxième article
    # sur la même première vague de programmation.
    update=None
    if article["category"]=="FESTIVALS" and isinstance(festival,dict):
        n=norm(festival.get("name",""))
        yr=str(festival.get("editionYear",""))
        if n and yr:
            for i,previous in enumerate(d["articles"]):
                t=norm(previous.get("title",""))
                if (previous.get("category")=="FESTIVALS" and yr in t and
                    all(word in t.split() for word in n.split()) and
                    any(word in t for word in ("premiers noms","programmation","affiche"))):
                    update=i
                    break
    if update is None:
        d["articles"].insert(0,article)
    else:
        article["slug"]=d["articles"][update]["slug"]
        d["articles"][update]=article
    raw=json.dumps(d,ensure_ascii=False,separators=(",",":"))
    raw=raw.replace("<","\\u003c").replace(">","\\u003e").replace("&","\\u0026")
    SITE.write_text(h[:m.start(1)]+raw+h[m.end(1):],encoding="utf-8")
    return article,count
def prepare(key,item):
    curated=find_known_official(item["titre"])
    if curated:
        try:
            url,page,quotes,edition_text=fetch_verified_official(curated[1],item["titre"])
            print("Annonce retrouvée sur une source officielle déjà connue :",url)
        except ValueError as exc:
            print("Le site déjà connu ne confirme pas suffisamment l'annonce :",str(exc))
            curated=None
    if not curated:
        research=call(key,"""Tu es documentaliste d'un média de musique live en France.
Piste RSS non vérifiée : """+item["titre"]+"""
Cherche sur le Web la source PRIMAIRE de l'artiste, du festival, du tourneur,
du producteur ou d'une institution. Ne prends pas une dépêche pour une preuve
officielle. Réponds uniquement par un objet JSON :
{"confirmable":true,"url":"https://url-officielle","evidence":[
{"quote":"extrait exact de la source"},
{"quote":"autre extrait exact présent sur cette page"},
{"quote":"troisième extrait exact présent sur cette page"}]}.
Si aucune source primaire : {"confirmable":false,"url":"","evidence":[]}.
Ne fabrique aucune citation.""" ,True)
        if research.get("confirmable") is not True:
            raise ValueError("Annonce non confirmée")
        url,page,quotes,edition_text=proof(research)
        # Même avec une citation d'une source primaire, ne jamais inventer
        # une programmation de festival : isoler la partie édition concernée.
        if "festival" in norm(item["titre"]) or "we love green" in norm(item["titre"]):
            try:
                response=S.get(url,timeout=15)
                soup=BeautifulSoup(response.text,"html.parser")
                for node in soup.select("script,style,noscript,nav,footer"):node.decompose()
                clean="\\n".join(soup.stripped_strings)
                yearmatch=re.search(r"20[2-9][0-9]",item["titre"])
                edition_text=norm(official_excerpt(clean,yearmatch.group() if yearmatch else None))
            except requests.RequestException:
                edition_text=""
    fact_list="\\n".join(quotes)[:4800]
    prompt="""Tu es un journaliste passionné de musique live. BACKSTAGE privilégie
rock et scènes alternatives, sans exclure pop, électro ou rap. Ton humain,
sensible, précis, avec du rythme et une curiosité pour l'accès à la culture.
Pas de discours politique partisan. Jamais de reportage de terrain inventé,
de citation fabriquée, de style administratif ou de communiqué recopié.

Annonce de départ : """+item["titre"]+"""
SOURCE OFFICIELLE CONFIRMÉE : """+url+"""
EXTRAITS DU SITE OFFICIEL (SEULS FAITS ADMISSIBLES) :
"""+fact_list+"""
Rédige en français de manière originale, 160–230 mots pour une brève et
250–480 mots pour une vraie annonce de programmation. Le texte doit avoir
du relief sans ajouter des faits absents des extraits.

Retourne UNIQUEMENT un JSON :
{"title":"...","excerpt":"...","category":"FESTIVALS ou CONCERTS ou SOCIÉTÉ",
"body":["introduction","paragraphe"],"sections":[{"title":"Intertitre",
"paragraphs":["paragraphe","paragraphe"]}],
"festival":{"name":"Nom officiel","city":"Ville","country":"France",
"editionYear":2027,"dates":"Dates annoncées","lineup":[
{"day":"Jour de la semaine et date","artists":["Nom confirmé"]}]}}.

"festival" est facultatif. Inclus-le seulement s'il s'agit réellement d'un
festival ET si ses artistes sont explicitement annoncés dans les extraits
de l'édition indiquée. Ne renseigne aucun artiste d'une autre année.
N'ajoute pas de villes, tarifs ou dates que la source ne confirme pas."""
    article=call(key,prompt)
    article["_official_url"]=url
    article["_source_text"]=page
    article["_edition_text"]=edition_text
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
        raw="Introduction Programmation 2027 Vendredi 4 Angèle Lola Young Samedi 5 Fontaines D.C. Angine de Poitrine We Love Green 2026"
        part=official_excerpt(raw,"2027")
        assert "Angèle" in part and "Fontaines D.C." in part and "2026" not in part
        sample={"festivals":[]}
        fest={"name":"We Love Green","city":"Paris","country":"France","editionYear":2027,
              "dates":"4–6 juin 2027",
              "lineup":[{"day":"Vendredi 4","artists":["Angèle","Lola Young"]},
                        {"day":"Samedi 5","artists":["Fontaines D.C.","Angine de Poitrine"]}]}
        assert update_festival(sample,fest,"https://www.welovegreen.fr/",norm(raw),norm(part))
        assert len(sample["festivals"])==1
        assert update_festival(sample,fest,"https://www.welovegreen.fr/",norm(raw),norm(part))
        assert len(sample["festivals"])==1
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
