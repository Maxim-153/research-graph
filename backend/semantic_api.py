import requests
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ModuleNotFoundError:
    pass

CACHE_DIR = os.path.join(os.path.dirname(__file__), "api_cache")
OPENALEX_MAILTO = os.getenv("OPENALEX_MAILTO")
CACHE_VERSION = "v8"
SEARCH_SORTS = {
    "relevance": "relevance_score:desc",
    "newest": "publication_date:desc,relevance_score:desc",
    "cited": "cited_by_count:desc,relevance_score:desc",
}
CROSSREF_CACHE = {}
# Crossref-обогащение идёт в нескольких потоках (см. format_results), поэтому
# общий кэш защищаем локом от гонок.
CROSSREF_LOCK = threading.Lock()

if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

def reconstruct_abstract(inverted_index):
    """
    OpenAlex отдаёт аннотацию инвертированным индексом: {"Word": [0, 5], "is": [1]}.
    Функция восстанавливает из него исходный сплошной текст.
    """
    if not inverted_index:
        return ""
    try:
        max_idx = max([max(positions) for positions in inverted_index.values()])
        abstract_words = [""] * (max_idx + 1)
        
        for word, positions in inverted_index.items():
            for pos in positions:
                abstract_words[pos] = word
                
        return " ".join(abstract_words).strip()
    except Exception as e:
        print(f"Ошибка сборки текста: {e}")
        return ""

def add_mailto(params):
    if OPENALEX_MAILTO:
        params["mailto"] = OPENALEX_MAILTO
    return params

def clean_openalex_id(value):
    return (value or "").replace("https://openalex.org/", "")

def clean_doi_value(value):
    return (value or "").replace("https://doi.org/", "").replace("http://dx.doi.org/", "").strip()

def split_pages(page_value):
    if not page_value:
        return None, None

    page_text = str(page_value).replace("–", "-").strip()
    if "-" not in page_text:
        return page_text, None

    first_page, last_page = page_text.split("-", 1)
    return first_page.strip() or None, last_page.strip() or None

def get_crossref_year(message):
    for field in ("published-print", "published-online", "issued"):
        date_parts = (message.get(field) or {}).get("date-parts") or []
        if date_parts and date_parts[0]:
            return date_parts[0][0]
    return None

def fetch_crossref_metadata(doi):
    doi_value = clean_doi_value(doi)
    if not doi_value:
        return {}

    # Чтение кэша — под локом. Сам сетевой запрос держим ВНЕ лока, иначе
    # параллельное обогащение выродится бы в последовательное (каждый DOI ждал бы
    # предыдущий). Возможный повторный фетч одного DOI безвреден: запись идемпотентна.
    with CROSSREF_LOCK:
        if doi_value in CROSSREF_CACHE:
            return CROSSREF_CACHE[doi_value]

    result = {}
    try:
        response = requests.get(
            f"https://api.crossref.org/works/{doi_value}",
            params=add_mailto({}),
            timeout=5,
        )
        if response.status_code == 200:
            message = response.json().get("message", {})
            first_page, last_page = split_pages(message.get("page"))
            authors = []
            for author in message.get("author", []):
                family = author.get("family")
                given = author.get("given")
                if family and given:
                    authors.append({"id": "", "name": f"{given} {family}"})
                elif family:
                    authors.append({"id": "", "name": family})

            metadata = {
                "title": (message.get("title") or [None])[0],
                "source": (message.get("container-title") or [None])[0],
                "volume": message.get("volume"),
                "issue": message.get("issue"),
                "first_page": first_page,
                "last_page": last_page,
                "year": get_crossref_year(message),
                "authors": authors,
                "doi": f"https://doi.org/{doi_value}",
                "landing_page_url": message.get("URL"),
            }
            result = {key: value for key, value in metadata.items() if value}
    except Exception as e:
        print(f"!!! Ошибка Crossref для DOI {doi_value}: {e}")
        result = {}

    with CROSSREF_LOCK:
        CROSSREF_CACHE[doi_value] = result
    return result

def format_work_item(item):
    biblio = item.get("biblio") or {}
    primary_location = item.get("primary_location") or {}
    host_venue = item.get("host_venue") or {}
    source_name = (
        (primary_location.get("source") or {}).get("display_name")
        or host_venue.get("display_name")
    )
    doi = item.get("doi")

    authors = [
        {
            "id": clean_openalex_id(auth.get("author", {}).get("id")),
            "name": auth.get("author", {}).get("display_name") or "Unknown"
        }
        for auth in item.get("authorships", [])
    ]

    citations = [
        {"paperId": clean_openalex_id(ref)}
        for ref in item.get("referenced_works", [])
        if ref
    ]

    metadata = {
        "paperId": clean_openalex_id(item.get("id")),
        "title": item.get("title") or "Без названия",
        "abstract": reconstruct_abstract(item.get("abstract_inverted_index")),
        "year": item.get("publication_year", 0),
        "authors": authors[:5],
        "citations": citations,
        "url": doi or primary_location.get("landing_page_url") or item.get("id"),
        "doi": doi,
        "source": source_name,
        "primary_location": item.get("primary_location"),
        "host_venue": item.get("host_venue"),
        "volume": biblio.get("volume"),
        "issue": biblio.get("issue"),
        "first_page": biblio.get("first_page"),
        "last_page": biblio.get("last_page"),
        "landing_page_url": primary_location.get("landing_page_url"),
        "citation_count": item.get("cited_by_count", 0),
        "reference_count": len(item.get("referenced_works", [])),
        "relevance_score": item.get("relevance_score", 0),
    }

    return metadata


def needs_crossref_enrichment(metadata):
    """Нужно ли добивать запись из Crossref: есть DOI и не хватает выходных данных."""
    missing_biblio = any(not metadata.get(key) for key in ("source", "volume", "issue", "first_page"))
    return bool(metadata.get("doi")) and missing_biblio


def enrich_with_crossref(metadata):
    """Дополняет недостающие поля записи данными Crossref по её DOI (мутирует на месте)."""
    crossref_metadata = fetch_crossref_metadata(metadata.get("doi"))
    for key, value in crossref_metadata.items():
        if key == "authors" and not metadata.get("authors"):
            metadata["authors"] = value[:5]
        elif value and not metadata.get(key):
            metadata[key] = value
    return metadata


def format_results(results, enrich=True, max_workers=8):
    """
    Превращает «сырой» список работ OpenAlex во внутренний формат и (опционально)
    ПАРАЛЛЕЛЬНО добивает неполные записи из Crossref.

    enrich=False — без обращения к Crossref (нужно для замера полноты метаданных
    «до обогащения» в eval). Параллельность убирает главное узкое место cold-фетча:
    раньше до 30 Crossref-запросов (таймаут 5 c каждый) шли последовательно (~15 c).
    """
    formatted = [format_work_item(item) for item in results]
    if not enrich:
        return formatted

    to_enrich = [m for m in formatted if needs_crossref_enrichment(m)]
    if to_enrich:
        with ThreadPoolExecutor(max_workers=min(max_workers, len(to_enrich))) as executor:
            list(executor.map(enrich_with_crossref, to_enrich))
    return formatted

def fetch_papers(query: str, year_from: int = None, year_to: int = None, sort: str = "relevance", limit: int = 30, enrich: bool = True):
    sort_key = sort if sort in SEARCH_SORTS else "relevance"

    # Ключ кэша (имя файла) включает версию формата и параметры запроса,
    # поэтому запросы с разными датами не пересекаются. Кэш «с обогащением»
    # и «без» разделён суффиксом _raw (enrich=False — для замера полноты «до Crossref»).
    cache_suffix = "" if enrich else "_raw"
    cache_filename = f"{CACHE_VERSION}_{query.replace(' ', '_').lower()}_{year_from}_{year_to}_{sort_key}{cache_suffix}.json"
    cache_path = os.path.join(CACHE_DIR, cache_filename)
    
    # 1. Проверка кэша
    if os.path.exists(cache_path):
        print(f"--- [CACHE] Беру данные из файла: {cache_path} ---")
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Ошибка чтения кэша: {e}")

    # 2. Запрос к OpenAlex API
    url = "https://api.openalex.org/works"
    params = add_mailto({
        "per_page": limit
    })
    params["sort"] = SEARCH_SORTS[sort_key]
    
    # Фильтры OpenAlex
    filter_parts = [
        "type:article|preprint",
        f"title_and_abstract.search:{query}",
    ]
    if year_from is not None:
        filter_parts.append(f"from_publication_date:{year_from}-01-01")
    if year_to is not None:
        filter_parts.append(f"to_publication_date:{year_to}-12-31")
        
    # Если есть хотя бы один фильтр, склеиваем их через запятую и добавляем в запрос
    if filter_parts:
        params["filter"] = ",".join(filter_parts)
    
    print(f"--- [API] Ищу '{query}' с фильтрами: {params.get('filter', 'нет')}, сортировка: {sort_key} ---")
    
    try:
        response = requests.get(url, params=params, timeout=15)
        
        if response.status_code == 200:
            results = response.json().get("results", [])

            # 3. Адаптер: нормализация ответа OpenAlex во внутренний формат
            #    + параллельное обогащение из Crossref (если enrich=True)
            formatted_data = format_results(results, enrich=enrich)

            # Сохраняем в кэш
            if formatted_data:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(formatted_data, f, ensure_ascii=False, indent=2)

            return formatted_data

        else:
            print(f"!!! Ошибка OpenAlex: {response.status_code}")
            
    except Exception as e:
        print(f"!!! Ошибка сети: {e}")

    return []

# Дополнительная функция для получения цитирований конкретной статьи (по её ID)

def fetch_citations_for_paper(paper_id: str, limit: int = 15, enrich: bool = True):
    """
    Ищет статьи, которые ссылаются (цитируют) конкретную статью по её ID.
    """
    # 1. Уникальный кэш для цитирований (раздельно «с обогащением» и без)
    cache_suffix = "" if enrich else "_raw"
    cache_filename = f"{CACHE_VERSION}_citations_{paper_id}{cache_suffix}.json"
    cache_path = os.path.join(CACHE_DIR, cache_filename)

    if os.path.exists(cache_path):
        print(f"--- [CACHE] Беру цитирования из файла: {cache_path} ---")
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            pass

    # 2. Запрос к OpenAlex со специальным фильтром
    url = "https://api.openalex.org/works"
    params = add_mailto({
        "filter": f"cites:{paper_id}",  # работы, цитирующие данную публикацию
        "per_page": limit
    })
    
    print(f"--- [API] Ищу кто цитирует статью: {paper_id} ---")
    
    try:
        response = requests.get(url, params=params, timeout=15)
        
        if response.status_code == 200:
            results = response.json().get("results", [])
            # 3. Нормализация во внутренний формат + параллельное обогащение из Crossref
            formatted_data = format_results(results, enrich=enrich)

            # Сохраняем в кэш
            if formatted_data:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(formatted_data, f, ensure_ascii=False, indent=2)

            return formatted_data

        else:
            print(f"!!! Ошибка API при поиске цитирований: {response.status_code}")
            
    except Exception as e:
        print(f"!!! Ошибка сети: {e}")

    return []
