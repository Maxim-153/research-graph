import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ModuleNotFoundError:
    pass

from semantic_api import fetch_papers, fetch_citations_for_paper
from ml_processor import process_clusters, rerank_by_query
from graph_edges import build_all_edges


def node_data(paper):
    """Данные узла React Flow из обработанной статьи (без служебных полей вроде эмбеддинга)."""
    return {
        "label": paper.get("title"),
        "abstract": paper.get("abstract", ""),
        "group": paper.get("group", 0),
        "year": paper.get("year", 0),
        "authors": paper.get("authors", []),
        "group_name": paper.get("group_name"),
        "url": paper.get("url"),
        "doi": paper.get("doi"),
        "source": paper.get("source"),
        "primary_location": paper.get("primary_location"),
        "host_venue": paper.get("host_venue"),
        "volume": paper.get("volume"),
        "issue": paper.get("issue"),
        "first_page": paper.get("first_page"),
        "last_page": paper.get("last_page"),
        "landing_page_url": paper.get("landing_page_url"),
        "citation_count": paper.get("citation_count", 0),
        "reference_count": paper.get("reference_count", 0),
        "relevance_score": paper.get("relevance_score", 0),
        "semantic_score": paper.get("semantic_score", 0),
    }


def format_edges(raw_edges, extra=None):
    """Превращает рёбра из graph_edges.build_all_edges в формат React Flow."""
    formatted = []
    for edge in raw_edges:
        edge_data = {"kinds": edge["kinds"], "kind": edge["kinds"][0], "weights": edge["weights"]}
        if extra:
            edge_data.update(extra)
        formatted.append({
            "id": f"e-{edge['source']}-{edge['target']}",
            "source": edge["source"],
            "target": edge["target"],
            "data": edge_data,
        })
    return formatted


def get_cors_origins():
    raw_origins = os.getenv("CORS_ORIGINS")
    if not raw_origins:
        return ["http://localhost:5173", "http://127.0.0.1:5173"]
    return [origin.strip() for origin in raw_origins.split(",") if origin.strip()]

app = FastAPI()

# CORS: доступ клиентского приложения к API
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/search")
async def search(query: str, year_from: int = None, year_to: int = None, sort: str = "relevance"):
    try:
        # 1. Сбор данных (фильтрация по годам выполняется на стороне OpenAlex)
        raw_papers = fetch_papers(query, year_from, year_to, sort)

        if not raw_papers:
            return {"nodes": [], "edges": []}

        # Семантическое ре-ранжирование выдачи по близости к запросу.
        # Применяем только для режима релевантности; явные сортировки
        # ("новые"/"цитируемые") сохраняем как есть.
        if sort in (None, "relevance"):
            raw_papers = rerank_by_query(query, raw_papers)

        # 2. ML-обработка: Векторизация и кластеризация
        # На выходе получаем статьи, где у каждой есть поле 'group'
        processed_papers = process_clusters(raw_papers)

        # 3. Форматирование под React Flow
        paper_ids = {paper.get("paperId") for paper in processed_papers if paper.get("paperId")}

        nodes = [
            {"id": paper["paperId"], "data": node_data(paper)}
            for paper in processed_papers
            if paper.get("paperId")
        ]

        # Многосвязный граф: цитирование + библиографическое сопряжение +
        # семантическая kNN-близость. Объединение и формулы — в graph_edges.py.
        edges = format_edges(build_all_edges(processed_papers, paper_ids))

        return {"nodes": nodes, "edges": edges}

    except Exception as e:
        # Любая ошибка возвращается клиенту; сервер продолжает обслуживать запросы
        return {"error": str(e), "status": "failed"}

@app.get("/api/expand")
async def expand_graph(paper_id: str):
    try:
        # 1. Получаем работы, цитирующие выбранную публикацию (до 15)
        raw_papers = fetch_citations_for_paper(paper_id)

        # Цитирующих работ не найдено
        if not raw_papers:
            return {"nodes": [], "edges": []}

        # 2. Семантическая обработка догруженных работ (кластеризация и именование групп)
        processed_papers = process_clusters(raw_papers)

        # 3. Формирование узлов и рёбер
        expanded_ids = {paper.get("paperId") for paper in processed_papers if paper.get("paperId")}

        nodes = [
            {"id": paper["paperId"], "position": {"x": 0, "y": 0}, "data": node_data(paper)}
            for paper in processed_papers
            if paper.get("paperId")
        ]

        # Якорные рёбра цитирования от каждой догруженной работы к исходной:
        # присоединяют фрагмент к существующему графу.
        anchor_edges = [
            {
                "id": f"e-{pid}-{paper_id}",
                "source": pid,
                "target": paper_id,
                "data": {"kinds": ["citation"], "kind": "citation", "weights": {"citation": 1}},
            }
            for pid in expanded_ids
        ]

        # Внутри загруженного набора достраиваем многосвязный граф (цитирование +
        # сопряжение + семантика).
        inner_edges = format_edges(build_all_edges(processed_papers, expanded_ids))

        return {"nodes": nodes, "edges": anchor_edges + inner_edges}

    except Exception as e:
        print(f"Критическая ошибка при расширении графа: {e}")
        return {"error": str(e), "status": "failed"}
