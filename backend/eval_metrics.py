"""
Измерительный скрипт: считает воспроизводимые метрики на фиксированном наборе
запросов; результаты повторяются при перезапуске.

Запуск (из папки backend, при активном venv и доступе в интернет):
    python eval_metrics.py

Что считает уже сейчас:
  * силуэт кластеризации (кривая k=2..8) + авто-подбор k;
  * тайминги конвейера (загрузка из API + кластеризация);
  * hit-rate кэша (первый прогон — промах, второй — попадание);
  * полнота ГОСТ-метаданных ДО Crossref (только OpenAlex) и ПОСЛЕ обогащения —
    показывает прирост полноты от каскадного восстановления метаданных;
  * связность графа в 3 конфигурациях рёбер (только цитирование → +сопряжение →
    +семантика): доля изолированных узлов, число компонент, средняя степень —
    показывает, как многосвязность «оживляет» граф топ-выдачи.

Результаты печатаются и сохраняются в eval_results.json.
"""

import json
import os
import time

from semantic_api import fetch_papers
from ml_processor import model, choose_clusters
from graph_edges import citation_edges, coupling_edges, semantic_edges, connectivity_stats
from sklearn.metrics import silhouette_score
from sklearn.cluster import KMeans
from sklearn.preprocessing import normalize


# Фиксированный набор тестовых запросов (для воспроизводимости измерений).
# Англоязычные — модель all-MiniLM-L6-v2 оптимизирована под английский.
TEST_QUERIES = [
    "transformer models attention",
    "graph neural networks",
    "semantic search information retrieval",
    "reinforcement learning robotics",
    "convolutional neural networks image classification",
    "knowledge graph embeddings",
    "natural language processing sentiment analysis",
    "generative adversarial networks",
    "federated learning privacy",
    "recommender systems collaborative filtering",
    "time series forecasting deep learning",
    "explainable artificial intelligence",
    "self-supervised representation learning",
    "anomaly detection cybersecurity",
    "bibliometric analysis scientometrics",
]

# Поля, необходимые для библиографической ссылки по ГОСТ на статью.
def is_gost_complete(paper):
    has_author = bool(paper.get("authors"))
    has_title = bool(paper.get("title")) and paper.get("title") != "Без названия"
    has_year = bool(paper.get("year"))
    has_source = bool(paper.get("source"))
    has_locator = bool(paper.get("first_page") or paper.get("volume") or paper.get("issue"))
    return all([has_author, has_title, has_year, has_source, has_locator])


def paper_text(paper):
    return (paper.get("abstract") or paper.get("title") or "").strip()


def silhouette_curve(embeddings, k_max=8):
    """Силуэт для k=2..min(k_max, n-1) в косинусной метрике. Возвращает {k: score}."""
    n = len(embeddings)
    embeddings = normalize(embeddings)
    curve = {}
    for k in range(2, min(k_max, n - 1) + 1):
        labels = KMeans(n_clusters=k, random_state=42, n_init=10).fit_predict(embeddings)
        if len(set(labels)) < 2:
            continue
        curve[k] = round(float(silhouette_score(embeddings, labels)), 4)
    return curve


def evaluate_query(query):
    result = {"query": query}

    # --- Тайминг + hit-rate: cold-фетч С обогащением (реальный пользовательский путь) ---
    t0 = time.perf_counter()
    papers = fetch_papers(query, limit=30)
    t_miss = time.perf_counter() - t0

    # --- Второй прогон (попадание в кэш) ---
    t0 = time.perf_counter()
    fetch_papers(query, limit=30)
    t_hit = time.perf_counter() - t0

    result["n_papers"] = len(papers)
    result["t_fetch_miss_s"] = round(t_miss, 3)
    result["t_fetch_hit_s"] = round(t_hit, 3)
    result["cache_speedup"] = round(t_miss / t_hit, 1) if t_hit > 0 else None

    if not papers:
        result["note"] = "пустая выдача"
        return result

    # --- Полнота ГОСТ-метаданных: ДО Crossref (только OpenAlex) vs ПОСЛЕ обогащения ---
    # «raw»-выдача (enrich=False) кэшируется отдельно и не дёргает Crossref.
    papers_raw = fetch_papers(query, limit=30, enrich=False)
    if papers_raw:
        complete_before = sum(1 for p in papers_raw if is_gost_complete(p))
        result["gost_complete_before_pct"] = round(100 * complete_before / len(papers_raw), 1)
    complete_after = sum(1 for p in papers if is_gost_complete(p))
    result["gost_complete_after_pct"] = round(100 * complete_after / len(papers), 1)

    # --- Кластеризация: силуэт + авто-k. Заодно прикрепляем L2-нормализованные
    #     эмбеддинги к статьям — они нужны для семантических рёбер (связность ниже). ---
    texts, text_papers = [], []
    for p in papers:
        t = paper_text(p)
        if t:
            texts.append(t)
            text_papers.append(p)

    if len(texts) >= 3:
        t0 = time.perf_counter()
        embeddings = normalize(model.encode(texts))
        _, best_k, best_sil = choose_clusters(embeddings)
        t_cluster = time.perf_counter() - t0

        for paper, emb in zip(text_papers, embeddings):
            paper["embedding"] = emb

        result["auto_k"] = best_k
        result["silhouette_auto_k"] = round(float(best_sil), 4) if best_sil is not None else None
        result["silhouette_curve"] = silhouette_curve(embeddings)
        result["t_cluster_s"] = round(t_cluster, 3)
    elif texts:
        for paper, emb in zip(text_papers, normalize(model.encode(texts))):
            paper["embedding"] = emb
        result["note"] = "слишком мало текстов для кластеризации"
    else:
        result["note"] = "нет текстов"

    # --- Связность графа в 3 конфигурациях рёбер ---
    node_ids = [p["paperId"] for p in papers if p.get("paperId")]
    paper_ids = set(node_ids)
    cit = citation_edges(papers, paper_ids)
    cou = coupling_edges(papers)
    sem = semantic_edges(papers)
    result["connectivity"] = {
        "citation": connectivity_stats(node_ids, cit),
        "citation_coupling": connectivity_stats(node_ids, cit + cou),
        "citation_coupling_semantic": connectivity_stats(node_ids, cit + cou + sem),
    }

    return result


def main():
    print(f"Запускаю eval на {len(TEST_QUERIES)} запросах...\n")
    results = [evaluate_query(q) for q in TEST_QUERIES]

    # --- Сводка ---
    valid = [r for r in results if r.get("n_papers")]
    def avg(key):
        vals = [r[key] for r in valid if isinstance(r.get(key), (int, float))]
        return round(sum(vals) / len(vals), 3) if vals else None

    def conn_avg(config, field):
        vals = [
            r["connectivity"][config][field]
            for r in valid
            if r.get("connectivity") and config in r["connectivity"]
        ]
        return round(sum(vals) / len(vals), 3) if vals else None

    summary = {
        "queries": len(TEST_QUERIES),
        "avg_n_papers": avg("n_papers"),
        "avg_fetch_miss_s": avg("t_fetch_miss_s"),
        "avg_fetch_hit_s": avg("t_fetch_hit_s"),
        "avg_cache_speedup": avg("cache_speedup"),
        "avg_gost_complete_before_pct": avg("gost_complete_before_pct"),
        "avg_gost_complete_after_pct": avg("gost_complete_after_pct"),
        "avg_silhouette_auto_k": avg("silhouette_auto_k"),
        "avg_auto_k": avg("auto_k"),
        "avg_cluster_s": avg("t_cluster_s"),
        # Связность: доля изолированных узлов по мере добавления типов рёбер
        "avg_isolated_citation": conn_avg("citation", "isolated_frac"),
        "avg_isolated_citation_coupling": conn_avg("citation_coupling", "isolated_frac"),
        "avg_isolated_all": conn_avg("citation_coupling_semantic", "isolated_frac"),
        "avg_components_citation": conn_avg("citation", "components"),
        "avg_components_all": conn_avg("citation_coupling_semantic", "components"),
        "avg_degree_citation": conn_avg("citation", "avg_degree"),
        "avg_degree_all": conn_avg("citation_coupling_semantic", "avg_degree"),
    }

    print("\n=== СВОДКА ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")

    out_path = os.path.join(os.path.dirname(__file__), "eval_results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "per_query": results}, f, ensure_ascii=False, indent=2)
    print(f"\nПодробности сохранены в {out_path}")


if __name__ == "__main__":
    main()
